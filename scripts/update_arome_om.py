#!/usr/bin/env python3
"""Construit les cartes et prévisions AROME Outre-Mer 0,025° (2,5 km).

La chaîne lit directement les paquets GRIB2 ouverts de Météo-France publiés
sur data.gouv.fr, pour l'un des cinq domaines Outre-Mer (Antilles, Guyane,
Réunion-Mayotte, Nouvelle-Calédonie, Polynésie) sélectionné via --domain. Les
fichiers du domaine sont découpés selon le regroupement administratif défini
dans config/domains.json (par département, ou zone unique) pour le module
WordPress, tandis que les cartes restent calculées depuis la grille native
du domaine et non depuis les seules coordonnées des communes.

Contrairement à AROME France, la géométrie de grille (Ni/Nj/premier point/pas)
n'est pas connue à l'avance pour les cinq domaines Outre-Mer : elle est donc
découverte depuis le premier message GRIB du run puis validée pour cohérence
sur tous les messages suivants (voir GridGeometry / discover_grid_geometry).
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import shutil
import tempfile
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import requests
from eccodes import (
    codes_get,
    codes_get_double_array,
    codes_get_double_elements,
    codes_grib_new_from_file,
    codes_release,
)
from scipy.ndimage import map_coordinates

from arome_om_maps import AromeMapRenderer


LOGGER = logging.getLogger("arome.outremer")
PIPELINE_VERSION = "1.0.0"
USER_AGENT = "alertes-meteo.com/arome-outremer/1.0"

# Paquets disponibles pour les domaines Outre-Mer (HP1 semble bien publié,
# contrairement à AROME France) — cf. plan de session pour la source.
RESOURCE_GROUPS = "HP1|HP2|HP3|SP1|SP2|SP3|IP1|IP2|IP3|IP4|IP5"

MAP_TARGET_WIDTH = 1400

# Format compact partagé avec le JavaScript. Les diagnostics explicitement
# dérivés sont conservés car ils servent aux tableaux orages et neige — ce
# calcul est climato-agnostique, seuls quelques diagnostics neige/gel n'auront
# quasiment jamais de valeur en zone tropicale.
VALUE_COLUMNS = (
    "temperature_c",
    "humidity_pct",
    "precipitation_mm",
    "cloud_cover_pct",
    "wind_speed_kmh",
    "wind_direction_deg",
    "wind_gust_kmh",
    "pressure_hpa",
    "visibility_km",
    "condition_code",
    "pressure_surface_hpa",
    "dewpoint_c",
    "precipitation_total_mm",
    "cloud_low_pct",
    "cloud_mid_pct",
    "cloud_high_pct",
    "cape_jkg",
    "reflectivity_dbz",
    "graupel_mm",
    "thunder_risk_code",
    "lcl_m",
    "lightning_score",
    "hail_risk_code",
    "convective_precipitation_mm",
    "storm_type_code",
    "snow_risk_code",
    "snowfall_mm",
    "snow_fresh_cm",
    "snow_depth_cm",
    "snow_water_equivalent_mm",
    "snow_stick_risk_code",
    "snow_phase_code",
    "snowfall_total_mm",
)

INTEGER_COLUMNS = {
    "humidity_pct",
    "cloud_cover_pct",
    "wind_speed_kmh",
    "wind_direction_deg",
    "wind_gust_kmh",
    "pressure_hpa",
    "condition_code",
    "pressure_surface_hpa",
    "cloud_low_pct",
    "cloud_mid_pct",
    "cloud_high_pct",
    "cape_jkg",
    "reflectivity_dbz",
    "thunder_risk_code",
    "lcl_m",
    "lightning_score",
    "hail_risk_code",
    "storm_type_code",
    "snow_risk_code",
    "snow_stick_risk_code",
    "snow_phase_code",
}

MAP_FIELDS = {
    "temperature_c",
    "wind_chill_c",
    "wet_bulb_c",
    "dewpoint_c",
    "humidex",
    "humidity_pct",
    "precipitation_mm",
    "precipitation_total_mm",
    "snow_mm",
    "snow_water_equivalent_mm",
    "snow_depth_cm",
    "graupel_mm",
    "snow_graupel_total_mm",
    "wind_speed_kmh",
    "wind_gust_kmh",
    "pressure_hpa",
    "surface_pressure_hpa",
    "cloud_cover_pct",
    "cloud_low_pct",
    "cloud_mid_pct",
    "cloud_high_pct",
    "cape_jkg",
    "reflectivity_dbz",
    "hail_risk_code",
    "storm_type_code",
    "altitude_m",
}

CONDITION_CODES = {
    0: "unknown",
    1: "clear",
    2: "partly_cloudy",
    3: "cloudy",
    4: "overcast",
    5: "rain",
    6: "heavy_rain",
    7: "snow",
    8: "fog",
    9: "windy",
}


@dataclass(frozen=True)
class Domain:
    """Un des cinq domaines AROME Outre-Mer, tel que décrit dans domains.json."""

    id: str
    label: str
    meteofrance_code: str
    dataset_slug: str
    resource_prefix: str
    forecast_hours_max: int
    run_hours_utc: tuple[int, ...]
    bounds: dict[str, float]
    catalog_file: str
    admin_grouping: str
    admin_codes: tuple[str, ...]
    constant_resource_title: str | None = None


@dataclass(frozen=True)
class Resource:
    group: str
    lead: int
    run_text: str | None
    title: str
    url: str | None
    size: int | None
    local_path: Path | None = None


class IncompleteRunError(RuntimeError):
    """Le catalogue distant ne contient pas encore un run AROME cohérent."""


@dataclass(frozen=True)
class GridGeometry:
    """Géométrie de grille découverte depuis le premier message GRIB du run.

    Les cinq domaines Outre-Mer n'ont pas de Ni/Nj/premier point/pas
    documentés et vérifiés comme la grille EURW1S100 d'AROME France : on les
    lit donc directement dans le GRIB2 plutôt que de les coder en dur.
    """

    ni: int
    nj: int
    lat_first: float
    lon_first: float
    lat_step: float
    lon_step: float


@dataclass
class DepartmentData:
    code: str
    global_point_ids: np.ndarray
    points: list[list[Any]]
    communes: list[list[Any]]


@dataclass
class RawCatalog:
    """Catalogue communal chargé depuis le disque, avant projection sur la grille."""

    version: str
    communes: list[Any]
    commune_count: int


@dataclass
class NationalCatalog:
    version: str
    model_indexes: list[int]
    point_latitudes: np.ndarray
    point_longitudes: np.ndarray
    point_departments: list[str]
    departments: dict[str, DepartmentData]
    commune_count: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--domain",
        required=True,
        help="Identifiant du domaine Outre-Mer (antilles, guyane, reunion, "
        "ncaledonie, polynesie, …), tel que défini dans --domains-config",
    )
    parser.add_argument(
        "--domains-config",
        default="config/domains.json",
        help="Fichier décrivant les domaines Outre-Mer disponibles",
    )
    parser.add_argument(
        "--catalog",
        default=None,
        help=(
            "Catalogue communal du domaine (par défaut : catalog_file du "
            "domaine dans domains.json)"
        ),
    )
    parser.add_argument(
        "--output-dir",
        default="build/arome-outremer",
        help="Dossier de publication à produire (typiquement build/<domaine>)",
    )
    parser.add_argument(
        "--forecast-hours",
        type=int,
        default=None,
        help="Dernière échéance (par défaut : forecast_hours_max du domaine)",
    )
    parser.add_argument(
        "--resource-directory",
        help="Dossier local de GRIB2 SP1/SP2/SP3/… pour les tests hors ligne",
    )
    parser.add_argument(
        "--current-metadata-url",
        default=None,
        help=(
            "index.json actuellement publié pour ce domaine, pour éviter un "
            "run identique (aucune valeur par défaut : à fournir explicitement)"
        ),
    )
    parser.add_argument(
        "--catalog-attempts",
        type=int,
        default=4,
        help=(
            "Nombre de lectures du catalogue data.gouv.fr lorsqu'un run est "
            "en cours de remplacement (défaut : 4)"
        ),
    )
    parser.add_argument(
        "--catalog-retry-seconds",
        type=int,
        default=60,
        help="Attente entre deux lectures du catalogue incomplet (défaut : 60 s)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force la reconstruction même si ce run est déjà publié",
    )
    return parser.parse_args()


def load_domains(path: Path) -> dict[str, Domain]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"Fichier de configuration des domaines introuvable : {path}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Fichier de configuration des domaines invalide (JSON) : {path}"
        ) from exc

    domains: dict[str, Domain] = {}
    for entry in payload.get("domains") or []:
        try:
            domain = Domain(
                id=str(entry["id"]),
                label=str(entry.get("label", entry["id"])),
                meteofrance_code=str(entry.get("meteofrance_code", "")),
                dataset_slug=str(entry["dataset_slug"]),
                resource_prefix=str(entry["resource_prefix"]),
                forecast_hours_max=int(entry.get("forecast_hours_max", 42)),
                run_hours_utc=tuple(int(hour) for hour in entry.get("run_hours_utc") or []),
                bounds={key: float(value) for key, value in entry["bounds"].items()},
                catalog_file=str(entry.get("catalog_file", "")),
                admin_grouping=str(entry.get("admin_grouping", "single_zone")),
                admin_codes=tuple(str(code) for code in entry.get("admin_codes") or []),
                constant_resource_title=(
                    str(entry["constant_resource_title"])
                    if entry.get("constant_resource_title")
                    else None
                ),
            )
        except KeyError as exc:
            raise RuntimeError(
                f"Entrée de domaine incomplète dans {path} : champ manquant {exc}"
            ) from exc
        domains[domain.id] = domain
    return domains


def select_domain(domains: dict[str, Domain], domain_id: str) -> Domain:
    domain = domains.get(domain_id)
    if domain is None:
        raise RuntimeError(
            f"Domaine inconnu : {domain_id!r} (disponibles : {sorted(domains) or 'aucun'})"
        )
    return domain


def dataset_api_url(domain: Domain) -> str:
    return f"https://www.data.gouv.fr/api/1/datasets/{domain.dataset_slug}/"


def dataset_page_url(domain: Domain) -> str:
    return f"https://www.data.gouv.fr/datasets/{domain.dataset_slug}"


def resource_pattern(domain: Domain) -> re.Pattern[str]:
    prefix = re.escape(domain.resource_prefix)
    return re.compile(
        rf"^{prefix}__0025__(?P<group>{RESOURCE_GROUPS})__"
        rf"(?P<lead>\d{{3}})H__(?P<run>.+)\.grib2$",
        re.IGNORECASE,
    )


def local_resource_pattern(domain: Domain) -> re.Pattern[str]:
    return re.compile(
        rf"(?P<group>{RESOURCE_GROUPS})[^0-9]*(?P<lead>\d{{3}})H",
        re.IGNORECASE,
    )


def iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_run_text(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def safe_get(gid: int, key: str, default: Any = None) -> Any:
    try:
        return codes_get(gid, key)
    except Exception:
        return default


def grib_datetime(gid: int, date_key: str, time_key: str) -> datetime | None:
    date_value = safe_get(gid, date_key)
    time_value = safe_get(gid, time_key)
    if date_value is None or time_value is None:
        return None
    try:
        return datetime.strptime(
            f"{int(date_value):08d}{int(time_value):04d}", "%Y%m%d%H%M"
        ).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def normalize_longitude(value: float) -> float:
    return (value + 180.0) % 360.0 - 180.0


def read_grid_geometry(path: Path) -> GridGeometry:
    """Lit Ni/Nj/premier point/pas depuis le premier message GRIB de `path`.

    ASSOMPTION NON VÉRIFIÉE : le pas est lu depuis
    `iDirectionIncrementInDegrees`/`jDirectionIncrementInDegrees` quand ces
    clés existent, sinon dérivé de `(dernier point - premier point) / (N-1)`.
    Cette dérivation n'a pas pu être validée contre un GRIB2 Outre-Mer réel
    dans cet environnement (pas de téléchargement possible ici) — à
    revalider dès le premier run réel d'un domaine pilote.
    """

    with path.open("rb") as handle:
        gid = codes_grib_new_from_file(handle)
        if gid is None:
            raise RuntimeError(f"GRIB2 vide, géométrie de grille indisponible : {path}")
        try:
            ni = int(safe_get(gid, "Ni", 0))
            nj = int(safe_get(gid, "Nj", 0))
            lat_first = float(safe_get(gid, "latitudeOfFirstGridPointInDegrees", 0.0))
            lon_first = normalize_longitude(
                float(safe_get(gid, "longitudeOfFirstGridPointInDegrees", 0.0))
            )
            lat_step = safe_get(gid, "jDirectionIncrementInDegrees")
            lon_step = safe_get(gid, "iDirectionIncrementInDegrees")
            if lat_step is None and nj > 1:
                lat_last = safe_get(gid, "latitudeOfLastGridPointInDegrees")
                if lat_last is not None:
                    lat_step = abs(lat_first - float(lat_last)) / (nj - 1)
            if lon_step is None and ni > 1:
                lon_last = safe_get(gid, "longitudeOfLastGridPointInDegrees")
                if lon_last is not None:
                    lon_last_normalized = normalize_longitude(float(lon_last))
                    span = lon_last_normalized - lon_first
                    if span < 0:
                        span += 360.0
                    lon_step = span / (ni - 1)
            if not ni or not nj or lat_step is None or lon_step is None:
                raise RuntimeError(
                    "Géométrie de grille GRIB2 incomplète "
                    f"(Ni={ni}, Nj={nj}, pas lat={lat_step}, pas lon={lon_step})"
                )
            return GridGeometry(
                ni=ni,
                nj=nj,
                lat_first=lat_first,
                lon_first=lon_first,
                lat_step=float(lat_step),
                lon_step=float(lon_step),
            )
        finally:
            codes_release(gid)


def grid_index(geometry: GridGeometry, latitude: float, longitude: float) -> tuple[int, float, float]:
    row = int(round((geometry.lat_first - latitude) / geometry.lat_step))
    column = int(round((longitude - geometry.lon_first) / geometry.lon_step))
    row = max(0, min(geometry.nj - 1, row))
    column = max(0, min(geometry.ni - 1, column))
    index = row * geometry.ni + column
    model_latitude = geometry.lat_first - row * geometry.lat_step
    model_longitude = geometry.lon_first + column * geometry.lon_step
    return index, model_latitude, model_longitude


def load_catalog(path: Path) -> RawCatalog:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    raw_communes = payload.get("communes") or []
    if not raw_communes:
        raise RuntimeError(f"Catalogue communal vide ou introuvable : {path}")
    for commune in raw_communes:
        if not isinstance(commune, list) or len(commune) < 7:
            raise RuntimeError("Entrée communale invalide dans le catalogue")
    return RawCatalog(
        version=str(payload.get("catalog_version", "1")),
        communes=raw_communes,
        commune_count=len(raw_communes),
    )


def build_catalog(raw: RawCatalog, geometry: GridGeometry, domain: Domain) -> NationalCatalog:
    """Projette le catalogue communal brut sur la grille du domaine puis le
    regroupe selon `domain.admin_grouping` ("department" ou "single_zone")."""

    mapped: list[tuple[list[Any], int, float, float]] = []
    point_coordinates: dict[int, tuple[float, float]] = {}
    for commune in raw.communes:
        latitude = float(commune[5])
        longitude = float(commune[6])
        model_index, model_latitude, model_longitude = grid_index(geometry, latitude, longitude)
        mapped.append((commune, model_index, model_latitude, model_longitude))
        point_coordinates[model_index] = (model_latitude, model_longitude)

    model_indexes = sorted(point_coordinates)
    global_identifier = {
        model_index: position for position, model_index in enumerate(model_indexes)
    }
    point_latitudes = np.asarray(
        [point_coordinates[index][0] for index in model_indexes], dtype=np.float64
    )
    point_longitudes = np.asarray(
        [point_coordinates[index][1] for index in model_indexes], dtype=np.float64
    )

    if domain.admin_grouping == "single_zone":
        group_key = lambda commune: domain.id  # noqa: E731
    elif domain.admin_grouping == "department":
        group_key = lambda commune: str(commune[2]).upper()  # noqa: E731
    else:
        raise RuntimeError(
            f"admin_grouping inconnu pour le domaine {domain.id!r} : "
            f"{domain.admin_grouping!r}"
        )

    group_votes: dict[int, Counter[str]] = defaultdict(Counter)
    by_group: dict[str, list[tuple[list[Any], int]]] = defaultdict(list)
    for commune, model_index, _latitude, _longitude in mapped:
        group = group_key(commune)
        global_id = global_identifier[model_index]
        group_votes[global_id][group] += 1
        by_group[group].append((commune, global_id))

    point_groups = [
        group_votes[position].most_common(1)[0][0] if group_votes[position] else ""
        for position in range(len(model_indexes))
    ]

    groups: dict[str, DepartmentData] = {}
    for group_code, entries in sorted(by_group.items()):
        global_ids = sorted({global_id for _commune, global_id in entries})
        local_identifier = {
            global_id: position for position, global_id in enumerate(global_ids)
        }
        compact_communes = [
            [
                str(commune[0]),
                str(commune[1]),
                list(commune[3]),
                int(commune[4]),
                float(commune[5]),
                float(commune[6]),
                local_identifier[global_id],
            ]
            for commune, global_id in entries
        ]
        compact_points = [
            [
                model_indexes[global_id],
                round(float(point_latitudes[global_id]), 5),
                round(float(point_longitudes[global_id]), 5),
            ]
            for global_id in global_ids
        ]
        groups[group_code] = DepartmentData(
            code=group_code,
            global_point_ids=np.asarray(global_ids, dtype=np.int64),
            points=compact_points,
            communes=compact_communes,
        )

    if domain.admin_grouping == "department":
        expected = set(domain.admin_codes)
        got = set(groups)
        if expected and got != expected:
            raise RuntimeError(
                f"Groupement administratif inattendu pour {domain.id} : "
                f"attendu {sorted(expected)}, obtenu {sorted(got)}"
            )

    LOGGER.info(
        "Catalogue %s : %s communes, %s points modèle, %s groupe(s) (%s)",
        domain.id,
        len(raw.communes),
        len(model_indexes),
        len(groups),
        domain.admin_grouping,
    )
    return NationalCatalog(
        version=f"{raw.version}-arome-om-{domain.id}",
        model_indexes=model_indexes,
        point_latitudes=point_latitudes,
        point_longitudes=point_longitudes,
        point_departments=point_groups,
        departments=groups,
        commune_count=raw.commune_count,
    )


def api_resources(
    session: requests.Session, domain: Domain, pattern: re.Pattern[str]
) -> list[Resource]:
    response = session.get(
        dataset_api_url(domain),
        params={"_": int(time.time())},
        headers={"Cache-Control": "no-cache"},
        timeout=(15, 90),
    )
    response.raise_for_status()
    payload = response.json()
    resources: list[Resource] = []
    for item in payload.get("resources") or []:
        title = str(item.get("title") or "")
        match = pattern.match(title)
        if not match:
            continue
        resources.append(
            Resource(
                group=match.group("group").upper(),
                lead=int(match.group("lead")),
                run_text=match.group("run"),
                title=title,
                url=str(item.get("url") or ""),
                size=int(item.get("filesize") or 0) or None,
            )
        )
    if not resources:
        raise RuntimeError(
            f"Aucune ressource AROME Outre-Mer trouvée sur data.gouv.fr pour "
            f"{domain.id} ({domain.dataset_slug})"
        )
    return resources


def find_constant_resource(session: requests.Session, domain: Domain) -> Resource | None:
    """Cherche la ressource « Champs CONSTANT » (relief statique) du domaine.

    Contrairement aux paquets SP1/SP2/SP3/…, ce fichier ne suit pas le
    format `{prefix}__0025__{group}__{lead}H__{run}.grib2` : son titre est
    fixe (p. ex. « Champs CONSTANT GUYANE0025 ») et il ne porte ni run ni
    échéance. On le retrouve donc par titre plutôt que par le RESOURCE_RE
    utilisé pour les paquets horaires.
    """

    response = session.get(
        dataset_api_url(domain),
        params={"_": int(time.time())},
        headers={"Cache-Control": "no-cache"},
        timeout=(15, 90),
    )
    response.raise_for_status()
    payload = response.json()
    expected_title = domain.constant_resource_title
    fallback = re.compile(r"^Champs\s+CONSTANT\b", re.IGNORECASE)
    best: Resource | None = None
    for item in payload.get("resources") or []:
        title = str(item.get("title") or "")
        if expected_title is not None:
            matches = title.strip() == expected_title.strip()
        else:
            matches = bool(fallback.match(title.strip()))
        if not matches:
            continue
        best = Resource(
            group="CONSTANT",
            lead=0,
            run_text=None,
            title=title,
            url=str(item.get("url") or ""),
            size=int(item.get("filesize") or 0) or None,
        )
        break
    return best


def load_constant_altitude(
    session: requests.Session,
    domain: Domain,
    grid: NationalGrid,
    map_sampler: MapSampler,
    downloads: Path,
) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Repli d'altitude via le fichier « champs constants » du domaine.

    Certains domaines Outre-Mer (Antilles, Guyane, Nouvelle-Calédonie,
    Polynésie) ne publient pas le message GRIB `h` dans leur paquet SP3
    +00 h, contrairement à la Réunion-Mayotte et à AROME France. Le champ
    d'altitude (même shortName eccodes `h`, confirmé par inspection directe
    des cinq fichiers constants) est en revanche toujours présent dans le
    fichier de champs constants du domaine, publié séparément et sans
    dépendance à un run particulier.
    """

    resource = find_constant_resource(session, domain)
    if resource is None or not resource.url:
        LOGGER.warning(
            "Aucun fichier de champs constants trouvé pour %s (titre attendu : %s)",
            domain.id,
            domain.constant_resource_title or "Champs CONSTANT …",
        )
        return None, None
    destination = downloads / "constant-fields.grib2"
    LOGGER.info(
        "Repli altitude : téléchargement du fichier de champs constants %s",
        resource.title,
    )
    download_resource(session, resource, destination)
    try:
        step = parse_grib_files(
            [destination], grid, map_sampler, lead_hour=0, lenient=True
        )
    finally:
        destination.unlink(missing_ok=True)
    return step["values"].get("altitude_m"), step["map_values"].get("altitude_m")


def resolve_domain_altitude(
    session: requests.Session,
    domain: Domain,
    resources: dict[tuple[str, int], Resource],
    geometry: GridGeometry,
    catalog: NationalCatalog,
    downloads: Path,
) -> tuple[np.ndarray, np.ndarray]:
    """Détermine l'altitude du domaine une seule fois, avant la boucle
    principale par échéance.

    L'altitude ne varie pas selon l'échéance : il est donc à la fois plus
    sûr et plus correct de la découvrir une seule fois en amont — avec un
    `NationalGrid`/`MapSampler` dédiés et jetables, jamais partagés avec le
    parse principal de chaque échéance — plutôt qu'en cours de boucle. Un
    précédent repli en cours de boucle réutilisait le `grid`/`map_sampler`
    de l'échéance en cours pour relire un second fichier GRIB2, ce qui
    provoquait une régression (`Température à 2 m absente`) sur toutes les
    échéances suivantes.
    """

    probe_grid = NationalGrid(catalog, geometry)
    map_width, map_height = compute_canvas_size(domain.bounds)
    probe_sampler = MapSampler(map_width, map_height, domain.bounds, geometry)

    point_altitude: np.ndarray | None = None
    map_altitude: np.ndarray | None = None
    sp3_resource = resources.get(("SP3", 0))
    if sp3_resource is not None:
        probe_path = downloads / "altitude-probe-sp3.grib2"
        LOGGER.info("Sondage altitude : lecture de %s", sp3_resource.title)
        download_resource(session, sp3_resource, probe_path)
        try:
            step = parse_grib_files(
                [probe_path], probe_grid, probe_sampler, lead_hour=0, lenient=True
            )
        finally:
            probe_path.unlink(missing_ok=True)
        point_altitude = step["values"].get("altitude_m")
        map_altitude = step["map_values"].get("altitude_m")

    if point_altitude is None or map_altitude is None:
        LOGGER.warning(
            "Altitude absente du fichier SP3 +00 h pour %s : repli sur le "
            "fichier de champs constants",
            domain.id,
        )
        point_altitude, map_altitude = load_constant_altitude(
            session, domain, probe_grid, probe_sampler, downloads
        )

    if point_altitude is None or map_altitude is None:
        raise RuntimeError(
            "Altitude absente du fichier SP3 +00 h et introuvable dans le "
            f"fichier de champs constants pour {domain.id}"
        )
    return point_altitude, map_altitude


def local_resources(
    directory: Path, pattern: re.Pattern[str], fallback_pattern: re.Pattern[str]
) -> list[Resource]:
    resources: list[Resource] = []
    for path in sorted(directory.glob("*.grib2")):
        match = pattern.match(path.name) or fallback_pattern.search(path.name)
        if not match:
            continue
        groups = match.groupdict()
        resources.append(
            Resource(
                group=groups["group"].upper(),
                lead=int(groups["lead"]),
                run_text=groups.get("run"),
                title=path.name,
                url=None,
                size=path.stat().st_size,
                local_path=path.resolve(),
            )
        )
    if not resources:
        raise RuntimeError(f"Aucun GRIB2 AROME Outre-Mer reconnu dans {directory}")
    return resources


def choose_resources(
    resources: Iterable[Resource], forecast_hours: int
) -> tuple[dict[tuple[str, int], Resource], datetime | None]:
    resources = list(resources)
    grouped: dict[str, dict[tuple[str, int], Resource]] = defaultdict(dict)
    for resource in resources:
        grouped[resource.run_text or "local"][resource.group, resource.lead] = resource

    required = {
        (group, lead)
        for group in ("SP1", "SP2")
        for lead in range(forecast_hours + 1)
    }
    required.add(("SP3", 0))
    candidates: list[tuple[datetime, str, dict[tuple[str, int], Resource]]] = []
    for run_text, selection in grouped.items():
        if not required.issubset(selection):
            continue
        parsed = parse_run_text(None if run_text == "local" else run_text)
        candidates.append((parsed or datetime.min.replace(tzinfo=timezone.utc), run_text, selection))
    if not candidates:
        inventories: list[str] = []
        for run_text in sorted(grouped):
            counts = Counter(group for group, _lead in grouped[run_text])
            inventories.append(
                f"{run_text}: "
                + ", ".join(
                    f"{group}={counts.get(group, 0)}"
                    for group in ("SP1", "SP2", "SP3", "HP1")
                )
            )
        raise IncompleteRunError(
            "Catalogue AROME Outre-Mer en cours de synchronisation : aucun run "
            f"unique ne contient SP1/SP2 de +00 h à +{forecast_hours:02d} h et "
            f"SP3 +00 h (par run : {'; '.join(inventories) or 'aucune ressource'})"
        )
    _date, run_text, selection = max(candidates, key=lambda item: item[0])
    return selection, parse_run_text(None if run_text == "local" else run_text)


def wait_for_complete_remote_run(
    session: requests.Session,
    domain: Domain,
    pattern: re.Pattern[str],
    forecast_hours: int,
    attempts: int,
    retry_seconds: int,
) -> tuple[dict[tuple[str, int], Resource], datetime | None] | None:
    """Attend la fin du remplacement SP1/SP2/SP3 effectué par data.gouv.fr.

    Météo-France remplace parfois les familles l'une après l'autre. Dans
    cette courte fenêtre, chaque famille compte bien tous ses fichiers, mais
    leurs horodatages de run diffèrent et elles ne doivent surtout pas être
    mélangées.
    """

    last_error: IncompleteRunError | None = None
    for attempt in range(1, attempts + 1):
        discovered = api_resources(session, domain, pattern)
        try:
            return choose_resources(discovered, forecast_hours)
        except IncompleteRunError as exc:
            last_error = exc
            if attempt < attempts:
                LOGGER.warning(
                    "%s. Nouvelle vérification dans %s s (%s/%s).",
                    exc,
                    retry_seconds,
                    attempt,
                    attempts,
                )
                if retry_seconds:
                    time.sleep(retry_seconds)

    LOGGER.warning(
        "%s. Aucune donnée ne sera écrasée ; le prochain passage du workflow "
        "réessaiera automatiquement. Aucune clé API Météo-France n'est requise.",
        last_error,
    )
    return None


def already_published(url: str, run_time: datetime | None) -> bool:
    if not url or run_time is None:
        return False
    try:
        response = requests.get(
            url,
            timeout=(10, 30),
            headers={"User-Agent": USER_AGENT},
        )
        if response.status_code != 200:
            return False
        payload = response.json()
        model = payload.get("model") or {}
        return (
            payload.get("status") == "ok"
            and model.get("run_time") == iso_utc(run_time)
            and model.get("pipeline_version") == PIPELINE_VERSION
        )
    except (requests.RequestException, ValueError, TypeError):
        return False


def download_resource(
    session: requests.Session, resource: Resource, destination: Path
) -> None:
    if resource.local_path is not None:
        shutil.copy2(resource.local_path, destination)
        return
    if not resource.url:
        raise RuntimeError(f"Adresse de téléchargement absente : {resource.title}")
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            with session.get(
                resource.url,
                stream=True,
                timeout=(20, 180),
                headers={"User-Agent": USER_AGENT},
            ) as response:
                response.raise_for_status()
                with destination.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=2 * 1024 * 1024):
                        if chunk:
                            handle.write(chunk)
            if resource.size and destination.stat().st_size != resource.size:
                raise RuntimeError(
                    f"Taille inattendue pour {resource.title} : "
                    f"{destination.stat().st_size} au lieu de {resource.size}"
                )
            return
        except (requests.RequestException, OSError, RuntimeError) as error:
            last_error = error
            destination.unlink(missing_ok=True)
            if attempt < 3:
                LOGGER.warning(
                    "Téléchargement à retenter (%s/3) : %s", attempt, resource.title
                )
                time.sleep(2**attempt)
    raise RuntimeError(f"Téléchargement impossible : {resource.title}") from last_error


def mask_missing(values: np.ndarray, missing_value: Any) -> np.ndarray:
    result = np.asarray(values, dtype=np.float64)
    invalid = ~np.isfinite(result) | (np.abs(result) > 1.0e20)
    try:
        missing = float(missing_value)
    except (TypeError, ValueError):
        missing = math.nan
    if math.isfinite(missing):
        invalid |= np.isclose(result, missing, rtol=0.0, atol=1.0e-9)
    result[invalid] = np.nan
    return result


def message_field(gid: int) -> str | None:
    short_name = str(safe_get(gid, "shortName", ""))
    direct = {
        "2t": "temperature_k",
        "2r": "humidity_pct",
        "10u": "wind_u_ms",
        "10v": "wind_v_ms",
        "max_10efg": "gust_u_ms",
        "max_10nfg": "gust_v_ms",
        "CAPE_INS": "cape_jkg",
        "tgrp": "graupel_total_mm",
        "sp": "surface_pressure_pa",
        "lcc": "cloud_low_pct",
        "mcc": "cloud_mid_pct",
        "hcc": "cloud_high_pct",
        "tirf": "precipitation_total_mm",
        "tsnowp": "snow_total_mm",
        "h": "altitude_m",
    }
    if short_name in direct:
        return direct[short_name]
    if (
        int(safe_get(gid, "discipline", -1)) == 0
        and int(safe_get(gid, "parameterCategory", -1)) == 16
        and int(safe_get(gid, "parameterNumber", -1)) == 193
    ):
        return "reflectivity_dbz"
    return None


class NationalGrid:
    def __init__(self, catalog: NationalCatalog, geometry: GridGeometry) -> None:
        self.catalog = catalog
        self.geometry = geometry
        self.validated = False

    def validate(self, gid: int) -> None:
        if self.validated:
            return
        ni = int(safe_get(gid, "Ni", 0))
        nj = int(safe_get(gid, "Nj", 0))
        lat_first = float(safe_get(gid, "latitudeOfFirstGridPointInDegrees", 0))
        lon_first = normalize_longitude(
            float(safe_get(gid, "longitudeOfFirstGridPointInDegrees", 0))
        )
        if (
            ni != self.geometry.ni
            or nj != self.geometry.nj
            or not math.isclose(lat_first, self.geometry.lat_first, abs_tol=1.0e-6)
            or not math.isclose(lon_first, self.geometry.lon_first, abs_tol=1.0e-6)
        ):
            raise RuntimeError(
                "La grille reçue ne correspond pas à la géométrie détectée en "
                f"début de run ({ni} × {nj}, premier point {lat_first}/{lon_first}) "
                f"attendu ({self.geometry.ni} × {self.geometry.nj}, "
                f"{self.geometry.lat_first}/{self.geometry.lon_first})"
            )
        if max(self.catalog.model_indexes) >= ni * nj:
            raise RuntimeError("Un indice communal dépasse la grille du domaine")
        self.validated = True

    def extract(self, gid: int) -> np.ndarray:
        self.validate(gid)
        values = codes_get_double_elements(gid, "values", self.catalog.model_indexes)
        return mask_missing(values, safe_get(gid, "missingValue"))


def mercator(latitude: np.ndarray) -> np.ndarray:
    radians = np.radians(np.clip(latitude, -85.0, 85.0))
    return np.log(np.tan(np.pi / 4.0 + radians / 2.0))


def inverse_mercator(value: np.ndarray) -> np.ndarray:
    return np.degrees(2.0 * np.arctan(np.exp(value)) - np.pi / 2.0)


def compute_canvas_size(bounds: dict[str, float], target_width: int = MAP_TARGET_WIDTH) -> tuple[int, int]:
    """Dérive une taille de canevas depuis les bornes du domaine.

    En projection Web Mercator, l'axe X est linéaire en longitude et l'axe Y
    linéaire en mercator(latitude) — les deux exprimés en radians. Le rapport
    largeur/hauteur qui préserve l'aspect de la projection est donc
    directement `radians(lon_span) / (mercator(nord) - mercator(sud))`,
    généralisation du rapport MAP_WIDTH/MAP_HEIGHT ↔ DEFAULT_BOUNDS utilisé
    par le pipeline AROME France.
    """

    south = float(bounds["south"])
    north = float(bounds["north"])
    west = float(bounds["west"])
    east = float(bounds["east"])
    longitude_span = math.radians(abs(east - west))
    mercator_span = abs(float(mercator(np.asarray(north))) - float(mercator(np.asarray(south))))
    if longitude_span <= 0 or mercator_span <= 0:
        raise RuntimeError(f"Bornes cartographiques invalides pour ce domaine : {bounds}")
    height = max(200, int(round(target_width * mercator_span / longitude_span)))
    return int(target_width), height


class MapSampler:
    """Rééchantillonne la grille régulière du domaine sur la carte Web Mercator."""

    def __init__(
        self, width: int, height: int, bounds: dict[str, float], geometry: GridGeometry
    ) -> None:
        self.width = int(width)
        self.height = int(height)
        self.geometry = geometry
        target_latitudes = inverse_mercator(
            np.linspace(
                mercator(np.asarray(float(bounds["north"]))),
                mercator(np.asarray(float(bounds["south"]))),
                self.height,
            )
        )
        target_longitudes = np.linspace(
            float(bounds["west"]), float(bounds["east"]), self.width
        )
        rows = (geometry.lat_first - target_latitudes) / geometry.lat_step
        columns = (target_longitudes - geometry.lon_first) / geometry.lon_step
        self.row_grid = np.broadcast_to(rows[:, None], (self.height, self.width))
        self.column_grid = np.broadcast_to(
            columns[None, :], (self.height, self.width)
        )
        self.coverage = (
            (self.row_grid >= 0)
            & (self.row_grid <= geometry.nj - 1)
            & (self.column_grid >= 0)
            & (self.column_grid <= geometry.ni - 1)
        )

    def extract(self, gid: int, validator: NationalGrid) -> np.ndarray:
        validator.validate(gid)
        values = mask_missing(
            codes_get_double_array(gid, "values"),
            safe_get(gid, "missingValue"),
        ).reshape(self.geometry.nj, self.geometry.ni)
        sampled = map_coordinates(
            values,
            [self.row_grid, self.column_grid],
            order=1,
            mode="constant",
            cval=np.nan,
            prefilter=False,
        ).astype(np.float32, copy=False)
        sampled[~self.coverage] = np.nan
        return sampled


def discover_grid_geometry(
    session: requests.Session,
    resources: dict[tuple[str, int], Resource],
    downloads: Path,
) -> GridGeometry:
    probe_resource = resources.get(("SP1", 0)) or next(iter(resources.values()))
    probe_path = downloads / "geometry-probe.grib2"
    LOGGER.info("Téléchargement de sondage pour la géométrie de grille : %s", probe_resource.title)
    download_resource(session, probe_resource, probe_path)
    try:
        geometry = read_grid_geometry(probe_path)
    finally:
        probe_path.unlink(missing_ok=True)
    LOGGER.info(
        "Géométrie détectée : %s × %s, premier point %.4f/%.4f, pas %.5f/%.5f",
        geometry.ni,
        geometry.nj,
        geometry.lat_first,
        geometry.lon_first,
        geometry.lat_step,
        geometry.lon_step,
    )
    return geometry


def parse_grib_files(
    paths: Iterable[Path],
    grid: NationalGrid,
    map_sampler: MapSampler,
    lead_hour: int,
    lenient: bool = False,
) -> dict[str, Any]:
    """Décode un ensemble de fichiers GRIB2 partageant la même grille.

    `lenient` désactive les contrôles de cohérence propres à une échéance de
    prévision complète (température à 2 m présente, date de validité
    connue). C'est le mode utilisé pour lire le fichier de champs constants
    (relief statique, sans horodatage de run ni la plupart des paramètres de
    prévision) lors du repli d'altitude — voir `load_constant_altitude`.
    """

    point_values: dict[str, np.ndarray] = {}
    map_values: dict[str, np.ndarray] = {}
    run_time: datetime | None = None
    valid_time: datetime | None = None
    observed_lead: int | None = None

    for path in paths:
        with path.open("rb") as handle:
            while True:
                gid = codes_grib_new_from_file(handle)
                if gid is None:
                    break
                try:
                    field = message_field(gid)
                    if field is None:
                        continue
                    run_time = run_time or grib_datetime(gid, "dataDate", "dataTime")
                    valid_time = valid_time or grib_datetime(
                        gid, "validityDate", "validityTime"
                    )
                    end_step = safe_get(gid, "endStep")
                    if end_step is not None:
                        observed_lead = int(end_step)
                    point_values[field] = grid.extract(gid)
                    map_values[field] = map_sampler.extract(gid, grid)
                finally:
                    codes_release(gid)

    if not lenient:
        if "temperature_k" not in point_values:
            raise RuntimeError(f"Température à 2 m absente de l'échéance +{lead_hour:02d} h")
        if observed_lead is not None and observed_lead != lead_hour:
            raise RuntimeError(
                f"Échéance GRIB incohérente : +{observed_lead} h au lieu de +{lead_hour} h"
            )
        if valid_time is None and run_time is not None:
            valid_time = run_time + timedelta(hours=lead_hour)
        if valid_time is None:
            raise RuntimeError(f"Date de validité absente à +{lead_hour:02d} h")
    return {
        "lead_hour": lead_hour,
        "run_time": run_time,
        "valid_time": valid_time,
        "values": point_values,
        "map_values": map_values,
    }


def array_like(
    raw: dict[str, np.ndarray], name: str, shape: tuple[int, ...]
) -> np.ndarray:
    values = raw.get(name)
    if values is None:
        return np.full(shape, np.nan, dtype=np.float64)
    result = np.asarray(values, dtype=np.float64)
    if result.shape != shape:
        raise RuntimeError(f"Forme inattendue pour le champ {name} : {result.shape}")
    return result


def accumulation(
    raw: dict[str, np.ndarray],
    name: str,
    shape: tuple[int, ...],
    previous: np.ndarray | None,
    lead_hour: int,
) -> tuple[np.ndarray, np.ndarray]:
    total = array_like(raw, name, shape)
    if not np.any(np.isfinite(total)) and lead_hour == 0:
        total = np.zeros(shape, dtype=np.float64)
    total = np.where(np.isfinite(total), np.maximum(total, 0.0), np.nan)
    if previous is None:
        hourly = total.copy()
    else:
        hourly = np.maximum(total - previous, 0.0)
        hourly[~np.isfinite(total)] = np.nan
    return hourly, total.copy()


def rounded(values: np.ndarray, decimals: int) -> np.ndarray:
    return np.round(values, decimals)


def transform_step(
    raw: dict[str, np.ndarray],
    altitude: np.ndarray,
    previous: dict[str, np.ndarray],
    lead_hour: int,
) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    shape = altitude.shape
    temperature = array_like(raw, "temperature_k", shape) - 273.15
    humidity = np.clip(array_like(raw, "humidity_pct", shape), 0, 100)
    u_wind = array_like(raw, "wind_u_ms", shape)
    v_wind = array_like(raw, "wind_v_ms", shape)
    gust_u = array_like(raw, "gust_u_ms", shape)
    gust_v = array_like(raw, "gust_v_ms", shape)
    surface_pressure = array_like(raw, "surface_pressure_pa", shape) / 100.0
    cape = np.maximum(array_like(raw, "cape_jkg", shape), 0.0)
    reflectivity = np.clip(array_like(raw, "reflectivity_dbz", shape), 0, 80)
    cloud_low = np.clip(array_like(raw, "cloud_low_pct", shape), 0, 100)
    cloud_mid = np.clip(array_like(raw, "cloud_mid_pct", shape), 0, 100)
    cloud_high = np.clip(array_like(raw, "cloud_high_pct", shape), 0, 100)

    precipitation, rain_total = accumulation(
        raw,
        "precipitation_total_mm",
        shape,
        previous.get("rain_total"),
        lead_hour,
    )
    snow, snow_total = accumulation(
        raw, "snow_total_mm", shape, previous.get("snow_total"), lead_hour
    )
    graupel, graupel_total = accumulation(
        raw, "graupel_total_mm", shape, previous.get("graupel_total"), lead_hour
    )

    wind_speed = np.hypot(u_wind, v_wind) * 3.6
    wind_direction = np.degrees(np.arctan2(-u_wind, -v_wind)) % 360.0
    gust_speed = np.hypot(gust_u, gust_v) * 3.6

    relative = np.clip(humidity / 100.0, 0.01, 1.0)
    gamma = np.log(relative) + 17.625 * temperature / (243.04 + temperature)
    dewpoint = 243.04 * gamma / (17.625 - gamma)
    dewpoint[~np.isfinite(temperature) | ~np.isfinite(humidity)] = np.nan
    lcl = np.clip(125.0 * (temperature - dewpoint), 0, 5000)

    dewpoint_kelvin = np.clip(dewpoint + 273.15, 173.15, 333.15)
    vapour_pressure = 6.11 * np.exp(
        5417.7530 * (1.0 / 273.16 - 1.0 / dewpoint_kelvin)
    )
    humidex = temperature + 0.5555 * (vapour_pressure - 10.0)

    # Approximation de Stull (2011) pour la température du thermomètre mouillé,
    # valable pour une humidité relative de 5 à 99 % (erreur type < 1 °C).
    relative_pct = relative * 100.0
    wet_bulb = (
        temperature * np.arctan(0.151977 * np.sqrt(relative_pct + 8.313659))
        + np.arctan(temperature + relative_pct)
        - np.arctan(relative_pct - 1.676331)
        + 0.00391838 * np.power(relative_pct, 1.5) * np.arctan(0.023101 * relative_pct)
        - 4.686035
    )
    wet_bulb[~np.isfinite(temperature) | ~np.isfinite(humidity)] = np.nan

    wind_chill = temperature.copy()
    chill_valid = (
        np.isfinite(temperature)
        & np.isfinite(wind_speed)
        & (temperature <= 10)
        & (wind_speed >= 4.8)
    )
    wind_factor = np.power(np.maximum(wind_speed, 0), 0.16)
    wind_chill[chill_valid] = (
        13.12
        + 0.6215 * temperature[chill_valid]
        - 11.37 * wind_factor[chill_valid]
        + 0.3965 * temperature[chill_valid] * wind_factor[chill_valid]
    )

    cloud = 100.0 * (
        1.0
        - (1.0 - cloud_low / 100.0)
        * (1.0 - cloud_mid / 100.0)
        * (1.0 - cloud_high / 100.0)
    )
    cloud[
        ~np.isfinite(cloud_low)
        | ~np.isfinite(cloud_mid)
        | ~np.isfinite(cloud_high)
    ] = np.nan

    temperature_kelvin = np.maximum(temperature + 273.15, 180.0)
    pressure = surface_pressure * np.exp(
        9.80665 * np.maximum(altitude, -500.0)
        / (287.05 * (temperature_kelvin + 0.00325 * np.maximum(altitude, 0.0)))
    )
    pressure[~np.isfinite(surface_pressure) | ~np.isfinite(temperature)] = np.nan
    pressure = np.clip(pressure, 850, 1085)

    condition = np.zeros(shape, dtype=np.int16)
    condition[np.isfinite(cloud) & (cloud <= 20)] = 1
    condition[np.isfinite(cloud) & (cloud > 20) & (cloud <= 55)] = 2
    condition[np.isfinite(cloud) & (cloud > 55) & (cloud <= 85)] = 3
    condition[np.isfinite(cloud) & (cloud > 85)] = 4
    condition[np.isfinite(gust_speed) & (gust_speed >= 70)] = 9
    condition[np.isfinite(precipitation) & (precipitation >= 0.1)] = 5
    condition[np.isfinite(precipitation) & (precipitation >= 5)] = 6
    condition[np.isfinite(snow) & (snow >= 0.1)] = 7

    thunder = np.zeros(shape, dtype=np.int16)
    thunder[(cape >= 100) | (reflectivity >= 30)] = 1
    thunder[(cape >= 500) | (reflectivity >= 40)] = 2
    thunder[(cape >= 1200) | (reflectivity >= 50)] = 3
    thunder[(cape >= 2200) & (reflectivity >= 52)] = 4
    thunder[(reflectivity >= 58) | ((cape >= 1800) & (gust_speed >= 90))] = 4
    thunder[~np.isfinite(cape) & ~np.isfinite(reflectivity)] = 0

    lightning = np.clip(
        np.nan_to_num(cape, nan=0.0) / 30.0
        + np.maximum(np.nan_to_num(reflectivity, nan=0.0) - 25.0, 0) * 1.8,
        0,
        100,
    )
    hail = np.zeros(shape, dtype=np.int16)
    hail[(cape >= 500) & (reflectivity >= 42)] = 1
    hail[(cape >= 1200) & (reflectivity >= 50)] = 2
    hail[((cape >= 2200) & (reflectivity >= 55)) | (graupel >= 2)] = 3
    convective_fraction = np.clip(
        np.nan_to_num(cape, nan=0.0) / 1200.0, 0, 1
    ) * np.clip(
        (np.nan_to_num(reflectivity, nan=0.0) - 20.0) / 25.0, 0, 1
    )
    convective_precipitation = precipitation * convective_fraction
    storm_type = np.zeros(shape, dtype=np.int16)
    storm_type[thunder == 1] = 1
    storm_type[thunder == 2] = 2
    storm_type[(thunder >= 3) & (reflectivity >= 50)] = 3
    storm_type[(thunder >= 4) & (cape >= 2000)] = 4

    snow_graupel_total = np.nan_to_num(snow_total, nan=0.0) + np.nan_to_num(
        graupel_total, nan=0.0
    )
    snow_graupel_total[~np.isfinite(snow_total) & ~np.isfinite(graupel_total)] = np.nan

    snow_ratio = np.select(
        [temperature <= -10, temperature <= -5, temperature <= 0, temperature <= 1.5],
        [15.0, 12.0, 10.0, 6.0],
        default=2.0,
    )
    snow_fresh = np.maximum(snow, 0.0) * snow_ratio / 10.0
    previous_fresh = previous.get("fresh_snow")
    if previous_fresh is None:
        snow_depth = snow_fresh.copy()
    else:
        snow_depth = np.nan_to_num(previous_fresh, nan=0.0) + np.nan_to_num(
            snow_fresh, nan=0.0
        )
        snow_depth[~np.isfinite(snow_fresh) & ~np.isfinite(previous_fresh)] = np.nan

    snow_phase = np.zeros(shape, dtype=np.int16)
    snow_phase[np.isfinite(precipitation) & (precipitation >= 0.1)] = 1
    snow_phase[(snow >= 0.03) & (temperature > 0.5)] = 2
    snow_phase[(snow >= 0.03) & (temperature <= 0.5)] = 3
    snow_stick = np.zeros(shape, dtype=np.int16)
    snow_stick[(snow_fresh >= 0.05) & (temperature <= 2.0)] = 1
    snow_stick[(snow_fresh >= 0.2) & (temperature <= 1.0)] = 2
    snow_stick[(snow_fresh >= 0.5) & (temperature <= 0.0)] = 3
    snow_risk = np.zeros(shape, dtype=np.int16)
    snow_risk[(snow >= 0.03) | ((precipitation >= 0.2) & (temperature <= 1.5))] = 1
    snow_risk[(snow_fresh >= 0.3) | ((precipitation >= 1) & (temperature <= 0.5))] = 2
    snow_risk[(snow_fresh >= 1.0) | ((precipitation >= 3) & (temperature <= 0))] = 3
    snow_risk[(snow_fresh >= 3.0) | ((precipitation >= 8) & (temperature <= -1))] = 4

    result = {
        "temperature_c": rounded(temperature, 1),
        "wind_chill_c": rounded(wind_chill, 1),
        "wet_bulb_c": rounded(wet_bulb, 1),
        "dewpoint_c": rounded(dewpoint, 1),
        "humidex": rounded(humidex, 1),
        "humidity_pct": rounded(humidity, 0),
        "precipitation_mm": rounded(precipitation, 1),
        "precipitation_total_mm": rounded(rain_total, 1),
        "cloud_cover_pct": rounded(cloud, 0),
        "cloud_low_pct": rounded(cloud_low, 0),
        "cloud_mid_pct": rounded(cloud_mid, 0),
        "cloud_high_pct": rounded(cloud_high, 0),
        "wind_speed_kmh": rounded(wind_speed, 0),
        "wind_direction_deg": rounded(wind_direction, 0),
        "wind_gust_kmh": rounded(gust_speed, 0),
        "pressure_hpa": rounded(pressure, 0),
        "pressure_surface_hpa": rounded(surface_pressure, 0),
        "surface_pressure_hpa": rounded(surface_pressure, 0),
        "visibility_km": np.full(shape, np.nan),
        "condition_code": condition,
        "cape_jkg": rounded(cape, 0),
        "reflectivity_dbz": rounded(reflectivity, 0),
        "graupel_mm": rounded(graupel, 2),
        "thunder_risk_code": thunder,
        "lcl_m": rounded(lcl, 0),
        "lightning_score": rounded(lightning, 0),
        "hail_risk_code": hail,
        "convective_precipitation_mm": rounded(convective_precipitation, 1),
        "storm_type_code": storm_type,
        "snow_risk_code": snow_risk,
        "snowfall_mm": rounded(snow, 2),
        "snow_mm": rounded(snow, 2),
        "snow_fresh_cm": rounded(snow_fresh, 1),
        "snow_depth_cm": rounded(snow_depth, 1),
        "snow_water_equivalent_mm": rounded(snow_total, 1),
        "snow_stick_risk_code": snow_stick,
        "snow_phase_code": snow_phase,
        "snowfall_total_mm": rounded(snow_total, 1),
        "graupel_total_mm": rounded(graupel_total, 1),
        "snow_graupel_total_mm": rounded(snow_graupel_total, 1),
        "altitude_m": rounded(altitude, 0),
    }
    state = {
        "rain_total": rain_total,
        "snow_total": snow_total,
        "graupel_total": graupel_total,
        "fresh_snow": snow_depth,
    }
    return result, state


def json_number(value: Any, integer: bool = False) -> int | float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(round(number)) if integer else number


def compact_rows(
    transformed: dict[str, np.ndarray], point_ids: np.ndarray
) -> list[list[int | float | None]]:
    selected = {
        column: np.asarray(transformed[column])[point_ids] for column in VALUE_COLUMNS
    }
    return [
        [
            json_number(selected[column][position], column in INTEGER_COLUMNS)
            for column in VALUE_COLUMNS
        ]
        for position in range(len(point_ids))
    ]


def write_map_places(catalog: NationalCatalog, destination: Path) -> int:
    places = [
        [
            str(commune[1]),
            int(commune[3]),
            round(float(commune[4]), 5),
            round(float(commune[5]), 5),
            str(commune[0]),
            department.code,
        ]
        for department in catalog.departments.values()
        for commune in department.communes
        if int(commune[3]) > 0
    ]
    places.sort(key=lambda place: (-place[1], place[0]))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        json.dump(
            {
                "schema_version": 2,
                "columns": [
                    "name",
                    "population",
                    "latitude",
                    "longitude",
                    "code_insee",
                    "department",
                ],
                "count": len(places),
                "places": places,
            },
            handle,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        handle.write("\n")
    return len(places)


def _write_admin_group(
    destination: Path,
    code: str,
    group: DepartmentData,
    forecast_lines_path: Path,
    generated_at: str,
) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as output:
        output.write("{")
        output.write('"schema_version":3,"status":"ok","generated_at":')
        json.dump(generated_at, output)
        output.write(',"department":')
        json.dump(code, output)
        output.write(',"columns":')
        json.dump(
            {
                "points": ["model_index", "latitude", "longitude", "altitude_m"],
                "communes": [
                    "code_insee",
                    "name",
                    "postal_codes",
                    "population",
                    "latitude",
                    "longitude",
                    "point_id",
                ],
                "values": list(VALUE_COLUMNS),
            },
            output,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        output.write(',"points":')
        json.dump(group.points, output, ensure_ascii=False, separators=(",", ":"))
        output.write(',"communes":')
        json.dump(group.communes, output, ensure_ascii=False, separators=(",", ":"))
        output.write(',"forecast":[')
        first = True
        with forecast_lines_path.open("r", encoding="utf-8") as lines:
            for line in lines:
                if not line.strip():
                    continue
                if not first:
                    output.write(",")
                output.write(line.strip())
                first = False
        output.write("]}\n")
    return destination.stat().st_size


def write_departments(
    result_directory: Path,
    forecast_directory: Path,
    catalog: NationalCatalog,
    generated_at: str,
    domain: Domain,
) -> tuple[dict[str, Any], int]:
    index: dict[str, Any] = {}
    total_size = 0
    if domain.admin_grouping == "single_zone":
        for code, group in catalog.departments.items():
            destination = result_directory / "zone.json"
            size = _write_admin_group(
                destination, code, group, forecast_directory / f"{code}.ndjson", generated_at
            )
            total_size += size
            index[code] = {
                "file": "zone.json",
                "communes": len(group.communes),
                "points": len(group.points),
                "size_bytes": size,
            }
    else:
        destination_directory = result_directory / "departements"
        for code, group in catalog.departments.items():
            destination = destination_directory / f"{code}.json"
            size = _write_admin_group(
                destination, code, group, forecast_directory / f"{code}.ndjson", generated_at
            )
            total_size += size
            index[code] = {
                "file": f"departements/{code}.json",
                "communes": len(group.communes),
                "points": len(group.points),
                "size_bytes": size,
            }
    return index, total_size


def build_product(
    resources: dict[tuple[str, int], Resource],
    raw_catalog: RawCatalog,
    domain: Domain,
    forecast_hours: int,
    session: requests.Session,
    working_directory: Path,
    run_hint: datetime | None,
) -> Path:
    result_directory = working_directory / "result"
    forecast_directory = working_directory / "forecast-lines"
    downloads = working_directory / "downloads"
    result_directory.mkdir(parents=True)
    forecast_directory.mkdir(parents=True)
    downloads.mkdir(parents=True)

    geometry = discover_grid_geometry(session, resources, downloads)
    catalog = build_catalog(raw_catalog, geometry, domain)

    line_handles = {
        code: (forecast_directory / f"{code}.ndjson").open("w", encoding="utf-8")
        for code in catalog.departments
    }
    grid = NationalGrid(catalog, geometry)
    map_width, map_height = compute_canvas_size(domain.bounds)
    map_sampler = MapSampler(map_width, map_height, domain.bounds, geometry)
    map_renderer = AromeMapRenderer(
        np.empty(0),
        np.empty(0),
        result_directory / "maps",
        width=map_width,
        height=map_height,
        bounds=domain.bounds,
        boundary_latitudes=catalog.point_latitudes,
        boundary_longitudes=catalog.point_longitudes,
        boundary_codes=(
            catalog.point_departments if domain.admin_grouping == "department" else None
        ),
        boundary_directory=(
            Path(__file__).resolve().parents[1] / "config" / "natural-earth"
        ),
        pregridded=True,
    )

    point_altitude, map_altitude = resolve_domain_altitude(
        session, domain, resources, geometry, catalog, downloads
    )
    for department in catalog.departments.values():
        for position, global_id in enumerate(department.global_point_ids):
            department.points[position].append(
                json_number(point_altitude[int(global_id)], integer=True)
            )

    point_state: dict[str, np.ndarray] = {}
    map_state: dict[str, np.ndarray] = {}
    model_run = run_hint
    source_bytes = 0

    try:
        for lead in range(forecast_hours + 1):
            current_paths: list[Path] = []
            current_resources = [resources["SP1", lead], resources["SP2", lead]]
            if lead == 0:
                current_resources.append(resources["SP3", 0])
            try:
                for resource in current_resources:
                    destination = downloads / f"{resource.group}-{lead:03d}H.grib2"
                    LOGGER.info(
                        "Téléchargement +%03d h %s (%.1f Mo)",
                        lead,
                        resource.group,
                        (resource.size or 0) / 1e6,
                    )
                    download_resource(session, resource, destination)
                    source_bytes += destination.stat().st_size
                    current_paths.append(destination)
                LOGGER.info(
                    "Décodage et cartes AROME %s (%s) %s/%s : +%03d h",
                    domain.id,
                    domain.meteofrance_code,
                    lead + 1,
                    forecast_hours + 1,
                    lead,
                )
                step = parse_grib_files(current_paths, grid, map_sampler, lead)
                model_run = model_run or step["run_time"]
                transformed, point_state = transform_step(
                    step["values"], point_altitude, point_state, lead
                )
                map_transformed, map_state = transform_step(
                    step["map_values"], map_altitude, map_state, lead
                )
                map_fields = {
                    key: values
                    for key, values in map_transformed.items()
                    if key in MAP_FIELDS
                }
                map_renderer.render_step(
                    lead_hour=lead,
                    valid_time=step["valid_time"],
                    fields=map_fields,
                )
                iso_time = iso_utc(step["valid_time"])
                for code, department in catalog.departments.items():
                    line = [
                        iso_time,
                        compact_rows(transformed, department.global_point_ids),
                    ]
                    json.dump(
                        line,
                        line_handles[code],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    line_handles[code].write("\n")
            finally:
                for path in current_paths:
                    path.unlink(missing_ok=True)
    finally:
        for handle in line_handles.values():
            handle.close()

    generated_at = iso_utc(datetime.now(timezone.utc))
    assert generated_at is not None
    run_time = iso_utc(model_run)
    places_path = result_directory / "maps" / "communes.json"
    places_count = write_map_places(catalog, places_path)
    map_manifest = map_renderer.write_manifest(
        generated_at=generated_at,
        run_time=run_time,
        places_path="maps/communes.json",
    )
    department_index, total_size = write_departments(
        result_directory,
        forecast_directory,
        catalog,
        generated_at,
        domain,
    )

    model = {
        "name": f"AROME Outre-Mer {domain.label} 0,025°",
        "provider": "Météo-France",
        "dataset": domain.dataset_slug,
        "domain": domain.meteofrance_code,
        "resolution_degrees": 0.025,
        "resolution_km": 2.5,
        "forecast_hours_requested": forecast_hours,
        "run_time": run_time,
        "pipeline_version": PIPELINE_VERSION,
        "catalog_version": catalog.version,
        "storm_diagnostics": True,
        "snow_diagnostics": True,
        "source_url": dataset_page_url(domain),
        "source_size_bytes": source_bytes,
        "license": "Licence Ouverte 2.0",
    }
    index = {
        "schema_version": 3,
        "status": "ok",
        "generated_at": generated_at,
        "model": model,
        "coverage": {
            "label": domain.label,
            "communes": catalog.commune_count,
            "departments": len(catalog.departments),
            "admin_grouping": domain.admin_grouping,
        },
        "condition_codes": CONDITION_CODES,
        "diagnostics": {
            "direct": [
                "MUCAPE",
                "réflectivité maximale",
                "pluie cumulée",
                "neige cumulée",
                "graupel cumulé",
                "pression de surface",
                "nuages bas/moyens/élevés",
            ],
            "derived": [
                "pression ramenée au niveau de la mer",
                "point de rosée",
                "LCL",
                "risque orage",
                "risque grêle",
                "phase et tenue de la neige",
            ],
        },
        "search": {
            "provider": "Catalogue communal publié par le pipeline",
            "endpoint": "maps/communes.json",
        },
        "maps": {
            "status": "ok",
            "module_version": map_manifest["module_version"],
            "manifest": "maps/index.json",
            "layers": len(map_manifest["layers"]),
            "steps": len(map_manifest["steps"]),
            "places": places_count,
        },
        "departments": department_index,
        "total_department_bytes": total_size,
    }
    with (result_directory / "index.json").open("w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    LOGGER.info(
        "Produit AROME Outre-Mer %s prêt : %.1f Mo de tableaux, %s couches, %s échéances",
        domain.id,
        total_size / 1e6,
        len(map_manifest["layers"]),
        len(map_manifest["steps"]),
    )
    return result_directory


def safe_output_directory(path: Path) -> Path:
    resolved = path.resolve()
    forbidden = {Path("/").resolve(), Path.cwd().resolve(), Path.home().resolve()}
    if resolved in forbidden or len(resolved.parts) < 3:
        raise RuntimeError(f"Dossier de sortie dangereux : {resolved}")
    return resolved


def publish_result(source: Path, destination: Path) -> None:
    target = safe_output_directory(destination)
    temporary = target.with_name(target.name + ".new")
    if temporary.exists():
        shutil.rmtree(temporary)
    shutil.copytree(source, temporary)
    if target.exists():
        shutil.rmtree(target)
    temporary.replace(target)


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s | %(levelname)s | %(message)s",
    )

    domains = load_domains(Path(args.domains_config))
    domain = select_domain(domains, args.domain)

    forecast_hours = (
        args.forecast_hours if args.forecast_hours is not None else domain.forecast_hours_max
    )
    if not 1 <= forecast_hours <= domain.forecast_hours_max:
        raise ValueError(
            f"forecast-hours doit être compris entre 1 et {domain.forecast_hours_max} "
            f"pour le domaine {domain.id}"
        )
    if not 1 <= args.catalog_attempts <= 20:
        raise ValueError("catalog-attempts doit être compris entre 1 et 20")
    if not 0 <= args.catalog_retry_seconds <= 600:
        raise ValueError("catalog-retry-seconds doit être compris entre 0 et 600")

    catalog_path = Path(args.catalog) if args.catalog else Path(domain.catalog_file)
    raw_catalog = load_catalog(catalog_path)

    pattern = resource_pattern(domain)
    fallback_pattern = local_resource_pattern(domain)

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    if args.resource_directory:
        discovered = local_resources(Path(args.resource_directory), pattern, fallback_pattern)
        resources, run_hint = choose_resources(discovered, forecast_hours)
    else:
        selection = wait_for_complete_remote_run(
            session,
            domain,
            pattern,
            forecast_hours,
            args.catalog_attempts,
            args.catalog_retry_seconds,
        )
        if selection is None:
            return 0
        resources, run_hint = selection
    LOGGER.info(
        "Run AROME Outre-Mer sélectionné (%s) : %s", domain.id, iso_utc(run_hint) or "GRIB local"
    )
    if (
        not args.force
        and not args.resource_directory
        and args.current_metadata_url
        and already_published(args.current_metadata_url, run_hint)
    ):
        LOGGER.info("Ce run est déjà publié pour %s ; aucune reconstruction nécessaire", domain.id)
        return 0

    with tempfile.TemporaryDirectory(prefix=f"arome-om-{domain.id}-build-") as temporary:
        result = build_product(
            resources,
            raw_catalog,
            domain,
            forecast_hours,
            session,
            Path(temporary),
            run_hint,
        )
        publish_result(result, Path(args.output_dir))
    LOGGER.info("Fichiers %s prêts dans %s", domain.id, args.output_dir)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        LOGGER.exception("Échec de la mise à jour AROME Outre-Mer")
        raise SystemExit(1)

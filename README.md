# AROME Outre-Mer Météo-France — cartes et prévisions WordPress

Ce dépôt construit une chaîne directe **Météo-France AROME Outre-Mer 0,025° → GitHub → WordPress/Avada** pour les 5 domaines Outre-Mer : **Antilles, Guyane, Réunion-Mayotte (domaine « Indien »), Nouvelle-Calédonie et Polynésie française**. Il publie cartes interactives et prévisions horaires par commune sur une branche `data`, sans Open-Meteo ni autre intermédiaire météorologique.

## Ce que produit le workflow

- AROME Outre-Mer 0,025° (≈2,5 km), échéances horaires jusqu'à +48 h, 5 domaines indépendants ;
- mêmes familles de couches que le module AROME France 0,01° (température, point de rosée, refroidissement éolien, humidex, pluie horaire/cumulée, neige/graupel, vent, rafales, pression, nébulosité, MUCAPE, réflectivité, altitude) ;
- recherche de commune/lieu par territoire (catalogue publié par le pipeline, pas d'appel à une API externe côté navigateur) ;
- un seul shortcode WordPress avec sélecteur de territoire.

## Installation du dépôt GitHub

1. Créez un dépôt GitHub (ex. `arome-outremer`), copiez tout le contenu de ce dossier à sa racine.
2. **Settings → Actions → General → Workflow permissions** : Read and write permissions.
3. **Actions → Mise à jour AROME Outre-Mer → Run workflow**.
4. Vérifiez à la fin la présence de la branche `data`, avec `index.json` (manifeste des 5 territoires) et un sous-dossier par domaine (`antilles/`, `guyane/`, `reunion/`, `ncaledonie/`, `polynesie/`).

Le workflow tourne toutes les heures ; chaque domaine est traité indépendamment (matrice GitHub Actions) et seuls les domaines ayant un nouveau run complet sont republiés — les autres conservent leur dernière publication (pas de perte de données en cas de paquet manquant sur un seul territoire).

Commande équivalente en local, par domaine :

```bash
python -m pip install -r requirements.txt
python scripts/update_arome_om.py --domain antilles --domains-config config/domains.json --output-dir build/antilles
```

## Installation du module WordPress/Avada

1. **Extensions → Ajouter → Téléverser** le ZIP `arome-outremer-v1.0.0.zip` ;
2. **Réglages → AROME Outre-Mer**, adaptez l'URL de la branche `data` ;
3. dans Avada Builder, ajoutez un bloc Code/Texte contenant :

```text
[arome_outremer]
```

Exemples :

```text
[arome_outremer territoire="reunion" heures="48"]
[arome_outremer territoire="polynesie" selecteur="non"]
```

## Structure publiée

```text
data/
├── index.json                 (manifeste des 5 territoires)
├── antilles/
│   ├── index.json
│   ├── departements/          (971, 972, 977, 978)
│   └── maps/
├── guyane/
│   ├── index.json
│   ├── zone.json
│   └── maps/
├── reunion/    (zone.json)
├── ncaledonie/ (zone.json)
└── polynesie/  (zone.json)
```

## Source et licence des données

Paquets [AROME Outre-Mer 0,025° de Météo-France](https://www.data.gouv.fr/organizations/meteo-france/datasets), publiés sous Licence Ouverte 2.0 — un dataset data.gouv.fr distinct par domaine. Communes Antilles/Guyane/Réunion-Mayotte via l'API officielle de découpage administratif française ; Nouvelle-Calédonie/Polynésie via Wikidata (codes INSEE 98xxx/987xx).

Site : [www.alertes-meteo.com](https://www.alertes-meteo.com/) — module v1.0.0.

## Points à revalider lors des premiers runs réels

- Géométrie de grille par domaine : auto-détectée depuis le premier message GRIB de chaque run (pas de constantes codées en dur), à confirmer sur un run réel.
- Fréquence de run par domaine : `[0,6,12,18]` UTC retenu par prudence pour les 5 domaines (une seule observation disponible pour la Polynésie au moment de la construction, à revalider).
- Champs réellement présents dans les paquets SP1/SP2/SP3 Outre-Mer (peuvent différer légèrement de la France).

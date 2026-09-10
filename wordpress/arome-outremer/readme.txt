=== AROME Outre-Mer Météo-France — Tableaux et cartes ===
Contributors: alertesmeteohub
Tags: meteo, weather, arome, outre-mer, antilles, guyane, reunion, mayotte, nouvelle-caledonie, polynesie
Requires at least: 5.8
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Cartes interactives et prévisions horaires AROME Météo-France (résolution 0,025°, ~2,5 km) pour les 5 territoires d'Outre-Mer.

== Description ==

Ce module affiche, via un shortcode unique, les prévisions du modèle AROME Outre-Mer de Météo-France
pour les 5 domaines publiés par Météo-France :

* **Antilles** (Guadeloupe, Martinique)
* **Guyane**
* **Réunion-Mayotte**
* **Nouvelle-Calédonie**
* **Polynésie française**

Un sélecteur de territoire permet de basculer d'un domaine à l'autre sans recharger la page : le tableau de
prévisions et la carte interactive se resynchronisent automatiquement sur les données du nouveau territoire.

Fonctionnalités :

* Recherche de commune (ou géolocalisation) dans le territoire actif, à partir du catalogue de lieux publié
  par le pipeline — donc disponible uniformément sur les 5 territoires, y compris la Nouvelle-Calédonie et la
  Polynésie française, non couvertes par l'API géographique officielle française.
* Cartes météo interactives (rendu WebGL) : température, ressenti, précipitations, vent, rafales, pression,
  nébulosité, humidité, indices orageux (MUCAPE, réflectivité), altitude.
* Onglets « Cartes météo », « Prévisions générales », « Prévisions orages » et « Risque de neige ».
* Échéances horaires jusqu'à H+42 (portée maximale des paquets Outre-Mer, contre 48 h pour la France
  métropolitaine).
* Diagrammes (températures, pression, précipitations, vent/rafales).
* Footer avec horodatage de mise à jour et version du module.

== Installation ==

1. Installer et activer le plugin.
2. Vérifier dans **Réglages > AROME Outre-Mer** l'adresse de la source de données (branche `data` du dépôt
   `arome-outremer`, préconfigurée).
3. Insérer le shortcode `[arome_outremer]` dans une page ou un article.

Exemples :

`[arome_outremer]`
Territoire par défaut (Antilles), sélecteur de territoire et recherche de commune actifs, 42 h d'échéance.

`[arome_outremer territoire="reunion" heures="42"]`
Ouvre directement sur le territoire Réunion-Mayotte.

`[arome_outremer territoire="polynesie" selecteur="non"]`
Une seule ville par défaut pour la Polynésie française, sans recherche de commune (le sélecteur de territoire
reste disponible).

Attributs disponibles :

* `territoire` — `antilles` (défaut), `guyane`, `reunion`, `ncaledonie` ou `polynesie`.
* `ville` — nom de la commune affichée par défaut.
* `code` — code commune (INSEE ou équivalent) affiché par défaut.
* `heures` — nombre d'échéances horaires affichées (1 à 42).
* `titre` — préfixe de titre du tableau de prévisions.
* `selecteur` — `oui` (défaut) ou `non` pour masquer la recherche de commune.

== Changelog ==

= 1.0.0 =
Version initiale : couverture des 5 territoires d'Outre-Mer (Antilles, Guyane, Réunion-Mayotte,
Nouvelle-Calédonie, Polynésie française) avec sélecteur de territoire, cartes interactives, tableaux de
prévisions générales/orages/neige et recherche de commune basée sur le catalogue de lieux publié par le
pipeline (couverture uniforme des 5 territoires).

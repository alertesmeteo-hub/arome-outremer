<?php
/**
 * Plugin Name: AROME Outre-Mer Météo-France — Tableaux et cartes
 * Plugin URI: https://github.com/alertesmeteo-hub/arome-outremer
 * Description: Module unique de cartes interactives et de prévisions AROME de Météo-France pour les 5 territoires d'Outre-Mer : Antilles, Guyane, Réunion-Mayotte, Nouvelle-Calédonie et Polynésie française.
 * Version: 1.0.0
 * Author: Alertes Météo Hub
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 */

if (!defined('ABSPATH')) {
    exit;
}

define('AOM_VERSION', '1.0.0');
define('AOM_RELEASE_DATE', '10/09/2026');
define('AOM_OPTION_BASE_URL', 'aom_outremer_data_base_url');
define(
    'AOM_DEFAULT_BASE_URL',
    'https://raw.githubusercontent.com/alertesmeteo-hub/arome-outremer/data'
);

add_action('wp_enqueue_scripts', 'aom_register_assets');
add_action('admin_init', 'aom_register_settings');
add_action('admin_menu', 'aom_add_settings_page');
add_shortcode('arome_outremer', 'aom_render_shortcode');
add_filter('plugin_action_links_' . plugin_basename(__FILE__), 'aom_plugin_action_links');

/**
 * Les 5 domaines AROME Outre-Mer (0,025°, ~2,5 km). La branche « data » du
 * dépôt est organisée en `data/<territoire>/...` : chaque territoire a donc
 * sa propre base URL, dérivée de l'adresse générale du dépôt.
 */
function aom_territories() {
    $base = aom_base_url();
    return array(
        'antilles' => array(
            'id' => 'antilles',
            'label' => 'Antilles (Guadeloupe, Martinique)',
            'base_url' => $base . '/antilles',
            'default_code' => '97105',
            'default_department' => '971',
            'default_name' => 'Pointe-à-Pitre',
        ),
        'guyane' => array(
            'id' => 'guyane',
            'label' => 'Guyane',
            'base_url' => $base . '/guyane',
            'default_code' => '97302',
            'default_department' => '973',
            'default_name' => 'Cayenne',
        ),
        'reunion' => array(
            'id' => 'reunion',
            'label' => 'Réunion, Mayotte',
            'base_url' => $base . '/reunion',
            'default_code' => '97411',
            'default_department' => '974',
            'default_name' => 'Saint-Denis',
        ),
        'ncaledonie' => array(
            'id' => 'ncaledonie',
            'label' => 'Nouvelle-Calédonie',
            'base_url' => $base . '/ncaledonie',
            'default_code' => '98818',
            'default_department' => '988',
            'default_name' => 'Nouméa',
        ),
        'polynesie' => array(
            'id' => 'polynesie',
            'label' => 'Polynésie française',
            'base_url' => $base . '/polynesie',
            'default_code' => '98735',
            'default_department' => '987',
            'default_name' => 'Papeete',
        ),
    );
}

function aom_territory_id($value) {
    $id = strtolower(trim(sanitize_key((string) $value)));
    $allowed = array('antilles', 'guyane', 'reunion', 'ncaledonie', 'polynesie');
    return in_array($id, $allowed, true) ? $id : 'antilles';
}

function aom_plugin_action_links($links) {
    $settings_link = sprintf(
        '<a href="%s">%s</a>',
        esc_url(admin_url('options-general.php?page=arome-outremer')),
        esc_html__('Réglages', 'arome-outremer')
    );
    array_unshift($links, $settings_link);

    $help_link = sprintf(
        '<a href="%s">%s</a>',
        esc_url(admin_url('options-general.php?page=arome-outremer')),
        esc_html__('Shortcodes / Aide', 'arome-outremer')
    );
    array_unshift($links, $help_link);

    return $links;
}

function aom_register_assets() {
    wp_register_style(
        'aom-table',
        plugin_dir_url(__FILE__) . 'assets/aom-meteo.css',
        array(),
        AOM_VERSION
    );
    wp_register_script(
        'aom-table',
        plugin_dir_url(__FILE__) . 'assets/aom-meteo.js',
        array(),
        AOM_VERSION,
        true
    );
    wp_register_style(
        'aom-map',
        plugin_dir_url(__FILE__) . 'assets/aom-map.css',
        array('aom-table'),
        AOM_VERSION
    );
    wp_register_script(
        'aom-map',
        plugin_dir_url(__FILE__) . 'assets/aom-map.js',
        array(),
        AOM_VERSION,
        true
    );
}

function aom_register_settings() {
    register_setting(
        'aom_settings',
        AOM_OPTION_BASE_URL,
        array(
            'type' => 'string',
            'sanitize_callback' => 'esc_url_raw',
            'default' => AOM_DEFAULT_BASE_URL,
        )
    );

    add_settings_section(
        'aom_main_section',
        'Source des données Outre-Mer',
        '__return_false',
        'arome-outremer'
    );

    add_settings_field(
        'aom_data_base_url_field',
        'Adresse du dossier de données',
        'aom_render_url_field',
        'arome-outremer',
        'aom_main_section'
    );
}

function aom_render_url_field() {
    $value = get_option(AOM_OPTION_BASE_URL, AOM_DEFAULT_BASE_URL);
    printf(
        '<input type="url" class="regular-text code" name="%1$s" value="%2$s" autocomplete="off">',
        esc_attr(AOM_OPTION_BASE_URL),
        esc_attr($value)
    );
    echo '<p class="description">Conservez l’adresse proposée : elle pointe vers la branche « data » du dépôt, commune aux 5 territoires (chaque territoire lit son propre sous-dossier).</p>';
}

function aom_add_settings_page() {
    add_options_page(
        'Tableau AROME Outre-Mer',
        'AROME Outre-Mer',
        'manage_options',
        'arome-outremer',
        'aom_render_settings_page'
    );
}

function aom_render_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }
    ?>
    <div class="wrap">
        <h1>AROME Outre-Mer Météo-France</h1>
        <form action="options.php" method="post">
            <?php
            settings_fields('aom_settings');
            do_settings_sections('arome-outremer');
            submit_button();
            ?>
        </form>
        <p><strong>Version du module : <?php echo esc_html(AOM_VERSION); ?> (<?php echo esc_html(AOM_RELEASE_DATE); ?>)</strong></p>
        <h2>Shortcode unique</h2>
        <p><code>[arome_outremer]</code> : cartes interactives et prévisions AROME pour les 5 territoires d'Outre-Mer, avec sélecteur de territoire.</p>
        <p><code>[arome_outremer territoire="reunion" heures="42"]</code></p>
        <p><code>[arome_outremer territoire="polynesie" selecteur="non"]</code> : une seule ville, sans recherche de commune.</p>
        <p>Le visiteur peut ensuite changer de territoire, rechercher n’importe quelle commune du territoire actif ou se géolocaliser.</p>
    </div>
    <?php
}

function aom_base_url() {
    $url = get_option(AOM_OPTION_BASE_URL, AOM_DEFAULT_BASE_URL);
    return untrailingslashit(apply_filters('aom_outremer_data_base_url', $url));
}

function aom_commune_code($value) {
    $code = strtoupper(trim((string) $value));
    return preg_match('/^[0-9A-Z]{5}$/', $code) ? $code : '';
}

function aom_department_code($value) {
    $code = strtoupper(trim((string) $value));
    return preg_match('/^[0-9A-Z]{2,3}$/', $code) ? $code : '';
}

function aom_unique_identifier() {
    if (function_exists('wp_unique_id')) {
        return wp_unique_id('aom-city-');
    }
    return 'aom-city-' . wp_rand(1000, 999999);
}

function aom_map_variable($value) {
    $variable = strtolower(trim(sanitize_key((string) $value)));
    $allowed = array(
        'temperature',
        'temperature_ressentie',
        'thermometre_mouille',
        'point_rosee',
        'humidex',
        'pluie_1h',
        'pluie_cumul',
        'vent',
        'rafales',
        'pression',
        'pression_surface',
        'nebulosite',
        'nuages_bas',
        'nuages_moyens',
        'nuages_eleves',
        'humidite',
        'mucape',
        'reflectivite',
        'altitude',
    );
    return in_array($variable, $allowed, true) ? $variable : 'temperature';
}

function aom_render_map_shortcode($atts, $territory) {
    $atts = shortcode_atts(
        array(
            'variable' => 'temperature',
            'hauteur' => '700',
            'titre' => 'Cartes AROME Outre-Mer',
            'animation' => 'oui',
        ),
        $atts,
        'arome_outremer'
    );

    $variable = aom_map_variable($atts['variable']);
    $height = max(440, min(900, absint($atts['hauteur'])));
    $title = trim(sanitize_text_field($atts['titre']));
    if ($title === '') {
        $title = 'Cartes AROME Outre-Mer';
    }
    $animation_value = strtolower(trim(sanitize_text_field($atts['animation'])));
    $animation = !in_array($animation_value, array('non', '0', 'false', 'off'), true);
    $map_id = function_exists('wp_unique_id')
        ? wp_unique_id('aom-map-')
        : 'aom-map-' . wp_rand(1000, 999999);

    wp_enqueue_style('aom-map');
    wp_enqueue_script('aom-map');

    ob_start();
    ?>
    <section
        id="<?php echo esc_attr($map_id); ?>"
        class="aom-card aomm-card"
        data-aomm-app
        data-base-url="<?php echo esc_url($territory['base_url']); ?>"
        data-variable="<?php echo esc_attr($variable); ?>"
        data-timezone="<?php echo esc_attr(wp_timezone_string()); ?>"
        data-animation="<?php echo $animation ? '1' : '0'; ?>"
        data-module-version="<?php echo esc_attr(AOM_VERSION); ?>"
        style="--aomm-height: <?php echo esc_attr($height); ?>px"
    >
        <header class="aom-header aomm-header">
            <div>
                <p class="aom-kicker">MODÈLE HAUTE RÉSOLUTION OUTRE-MER • ÉCHÉANCES HORAIRES</p>
                <h2><?php echo esc_html($title); ?></h2>
                <p class="aom-meta" data-aomm-run>Chargement du dernier run AROME…</p>
            </div>
            <div class="aom-badge">AROME<br><strong>2,5 km</strong></div>
        </header>

        <div class="aomm-toolbar">
            <div class="aomm-field aomm-layer-picker">
                <span>Paramètre</span>
                <button
                    type="button"
                    class="aomm-layer-trigger"
                    data-aomm-menu-toggle
                    aria-expanded="false"
                    aria-controls="<?php echo esc_attr($map_id . '-layers'); ?>"
                >
                    <span data-aomm-current-layer>Température à 2 m</span>
                    <span class="aomm-layer-chevron" aria-hidden="true">⌄</span>
                </button>
            </div>
            <div class="aomm-tools" aria-label="Outils de la carte">
                <button
                    type="button"
                    class="aomm-tool-toggle"
                    data-aomm-tool="zoom"
                    aria-pressed="false"
                    title="Afficher les outils de capture et d’épinglage"
                >🔍 Zoom interactif</button>
                <button
                    type="button"
                    class="aomm-tool-toggle"
                    data-aomm-tool="diagram"
                    aria-pressed="false"
                    title="Cliquer sur la carte pour afficher le diagramme d’un point"
                >📈 Diagramme</button>
            </div>
            <div class="aomm-time-controls" aria-label="Navigation dans les échéances">
                <button type="button" data-aomm-previous title="Échéance précédente" aria-label="Échéance précédente">◀</button>
                <button type="button" data-aomm-play title="Lancer l’animation" aria-label="Lancer l’animation">▶</button>
                <button type="button" data-aomm-next title="Échéance suivante" aria-label="Échéance suivante">▶</button>
            </div>
            <div class="aomm-validity">
                <span>Prévision valable</span>
                <strong data-aomm-validity>—</strong>
                <small data-aomm-lead>—</small>
            </div>
        </div>

        <p class="aomm-tool-hint" data-aomm-tool-hint hidden></p>

        <div
            id="<?php echo esc_attr($map_id . '-layers'); ?>"
            class="aomm-layer-menu"
            data-aomm-layer-menu
            hidden
        >
            <div class="aomm-layer-menu-head">
                <div>
                    <strong>Choisir une carte AROME</strong>
                    <small>Uniquement les paramètres disponibles dans la production Météo-France Outre-Mer</small>
                </div>
                <button type="button" data-aomm-menu-close aria-label="Réduire le menu">×</button>
            </div>
            <div class="aomm-layer-grid" data-aomm-layer-grid></div>
        </div>

        <div class="aomm-period-selector" data-aomm-period hidden>
            <div class="aomm-period-head">
                <div>
                    <strong data-aomm-period-title>Période personnalisée</strong>
                    <small>Déplacez les deux curseurs pour choisir précisément le début et la fin.</small>
                </div>
                <span data-aomm-period-summary>—</span>
            </div>
            <div class="aomm-dual-range" data-aomm-dual-range>
                <div class="aomm-dual-range-track" aria-hidden="true"></div>
                <input data-aomm-period-start type="range" min="0" max="1" value="0" step="1" aria-label="Début de la période">
                <input data-aomm-period-end type="range" min="0" max="1" value="1" step="1" aria-label="Fin de la période">
            </div>
            <div class="aomm-period-values">
                <span><small>Du</small><strong data-aomm-period-start-label>—</strong></span>
                <span><small>Au</small><strong data-aomm-period-end-label>—</strong></span>
            </div>
        </div>

        <p class="aom-stale" data-aomm-stale role="status" hidden>
            Attention : la dernière production disponible a plus de 8 heures.
        </p>

        <div class="aomm-viewport" data-aomm-viewport role="img" aria-label="Carte météo AROME Outre-Mer interactive">
            <div class="aomm-scene" data-aomm-scene>
                <canvas class="aomm-weather-canvas" data-aomm-weather aria-hidden="true"></canvas>
                <canvas class="aomm-vector-canvas" data-aomm-vectors aria-hidden="true"></canvas>
            </div>
            <canvas class="aomm-label-canvas" data-aomm-labels aria-hidden="true"></canvas>
            <div class="aomm-probe" data-aomm-probe hidden>
                <strong data-aomm-probe-value>—</strong>
                <span data-aomm-probe-label>Valeur AROME</span>
            </div>
            <div class="aomm-map-titlebar">
                <strong data-aomm-map-title>Carte AROME</strong>
                <span data-aomm-map-run>Run AROME —</span>
            </div>
            <div class="aomm-map-date" data-aomm-map-date>Échéance —</div>
            <div class="aomm-map-buttons" aria-label="Commandes de zoom">
                <span class="aomm-zoom-level" data-aomm-zoom-level>100 %</span>
                <button type="button" data-aomm-zoom-in title="Agrandir" aria-label="Agrandir">+</button>
                <button type="button" data-aomm-zoom-out title="Réduire" aria-label="Réduire">−</button>
                <button type="button" data-aomm-reset title="Recentrer" aria-label="Recentrer">⌂</button>
                <button type="button" data-aomm-fullscreen title="Plein écran" aria-label="Plein écran">⛶</button>
            </div>
            <div class="aomm-advanced-tools" data-aomm-advanced-tools hidden aria-label="Outils avancés">
                <button type="button" data-aomm-capture title="Capturer l’image affichée" aria-label="Capturer l’image affichée">📷 Capture PNG</button>
                <button type="button" data-aomm-pin title="Épingler la valeur au clic" aria-label="Épingler la valeur au clic" aria-pressed="false">📌 Figer la valeur</button>
            </div>
            <div class="aomm-diagram-popup" data-aomm-diagram-popup hidden>
                <header>
                    <strong data-aomm-diagram-title>—</strong>
                    <button type="button" data-aomm-diagram-close aria-label="Fermer le diagramme">×</button>
                </header>
                <div class="aomm-diagram-body" data-aomm-diagram-body>
                    <p class="aomm-diagram-status" data-aomm-diagram-status>Chargement…</p>
                </div>
            </div>
            <div class="aomm-legend" data-aomm-legend aria-label="Légende de la carte"></div>
            <a class="aomm-map-brand" href="https://www.alertes-meteo.com/" target="_blank" rel="noopener noreferrer">
                www.alertes-meteo.com • Module v<?php echo esc_html(AOM_VERSION); ?> (<?php echo esc_html(AOM_RELEASE_DATE); ?>)
            </a>
            <div class="aomm-loading" data-aomm-loading role="status">Chargement de la carte…</div>
            <div class="aomm-error" data-aomm-error role="alert" hidden></div>
        </div>

        <div class="aomm-timeline" data-aomm-timeline>
            <input data-aomm-slider type="range" min="0" max="0" value="0" step="1" aria-label="Échéance de prévision">
            <div class="aomm-timeline-labels"><span>Run</span><span>Échéance maximale (H+42)</span></div>
        </div>

        <footer class="aom-footer">
            <span data-aomm-generated>Mise à jour en cours de lecture…</span>
            <span>
                Données météo directes :
                <a href="https://www.data.gouv.fr/datasets/paquets-arome-outre-mer-antilles-resolution-0-025deg" target="_blank" rel="noopener noreferrer">AROME Outre-Mer 0,025° — Météo-France</a>
                • <a href="https://www.alertes-meteo.com/" target="_blank" rel="noopener noreferrer">www.alertes-meteo.com</a>
                • Module cartes v<?php echo esc_html(AOM_VERSION); ?> (<?php echo esc_html(AOM_RELEASE_DATE); ?>)
            </span>
        </footer>

        <noscript>
            <p class="aom-message aom-error">JavaScript doit être activé pour afficher les cartes.</p>
        </noscript>
    </section>
    <?php
    return ob_get_clean();
}

function aom_render_shortcode($atts) {
    $atts = shortcode_atts(
        array(
            'territoire' => 'antilles',
            'ville' => '',
            'code' => '',
            'heures' => '42',
            'titre' => '',
            'selecteur' => 'oui',
        ),
        $atts,
        'arome_outremer'
    );

    $territories = aom_territories();
    $territory_id = aom_territory_id($atts['territoire']);
    $territory = $territories[$territory_id];

    $hours = max(1, min(42, absint($atts['heures'])));

    $city_code = aom_commune_code($atts['code']);
    if ($city_code === '') {
        $city_code = $territory['default_code'];
    }
    $city_name = sanitize_text_field($atts['ville']);
    if ($city_name === '') {
        $city_name = $territory['default_name'];
    }
    $department = $territory['default_department'];

    $title_prefix = trim(sanitize_text_field($atts['titre']));
    if ($title_prefix === '') {
        $title_prefix = 'Prévisions AROME';
    }
    $selector_value = strtolower(trim(sanitize_text_field($atts['selecteur'])));
    $show_selector = !in_array($selector_value, array('non', '0', 'false', 'off'), true);

    $input_id = aom_unique_identifier();
    $results_id = $input_id . '-results';
    $status_id = $input_id . '-status';
    $territory_select_id = $input_id . '-territoire';

    $territories_payload = array();
    foreach ($territories as $entry) {
        $territories_payload[] = array(
            'id' => $entry['id'],
            'label' => $entry['label'],
            'base_url' => $entry['base_url'],
            'default_code' => $entry['default_code'],
            'default_department' => $entry['default_department'],
            'default_name' => $entry['default_name'],
        );
    }

    wp_enqueue_style('aom-table');
    wp_enqueue_script('aom-table');
    wp_enqueue_style('aom-map');
    wp_enqueue_script('aom-map');

    ob_start();
    ?>
    <section
        class="aom-card aom-outremer"
        data-aom-app
        data-base-url="<?php echo esc_url($territory['base_url']); ?>"
        data-territory="<?php echo esc_attr($territory_id); ?>"
        data-territories="<?php echo esc_attr(wp_json_encode($territories_payload)); ?>"
        data-default-code="<?php echo esc_attr($city_code); ?>"
        data-default-department="<?php echo esc_attr($department); ?>"
        data-default-name="<?php echo esc_attr($city_name); ?>"
        data-hours="<?php echo esc_attr($hours); ?>"
        data-timezone="<?php echo esc_attr(wp_timezone_string()); ?>"
        data-title-prefix="<?php echo esc_attr($title_prefix); ?>"
        data-selector="<?php echo $show_selector ? '1' : '0'; ?>"
    >
        <header class="aom-header">
            <div>
                <p class="aom-kicker">MODÈLE HAUTE RÉSOLUTION • OUTRE-MER</p>
                <h2 data-aom-title><?php echo esc_html($title_prefix . ' — ' . $city_name); ?></h2>
                <p class="aom-city-altitude" data-aom-altitude>Altitude de <?php echo esc_html($city_name); ?> : chargement…</p>
                <p class="aom-meta" data-aom-meta>Chargement du dernier run AROME…</p>
            </div>
            <div class="aom-badge">AROME<br><strong>2,5 km</strong></div>
        </header>

        <div class="aom-territory-bar">
            <label for="<?php echo esc_attr($territory_select_id); ?>">Territoire</label>
            <select id="<?php echo esc_attr($territory_select_id); ?>" class="aom-territory-select" data-aom-territory-select></select>
        </div>

        <div class="aom-toolbar" <?php if (!$show_selector) : ?>hidden<?php endif; ?>>
            <div class="aom-search">
                <label for="<?php echo esc_attr($input_id); ?>">Choisissez votre commune</label>
                <div class="aom-search-control">
                    <span class="aom-search-icon" aria-hidden="true">⌕</span>
                    <input
                        id="<?php echo esc_attr($input_id); ?>"
                        class="aom-city-input"
                        type="search"
                        value="<?php echo esc_attr($city_name); ?>"
                        placeholder="Nom de commune"
                        autocomplete="off"
                        spellcheck="false"
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded="false"
                        aria-controls="<?php echo esc_attr($results_id); ?>"
                        aria-describedby="<?php echo esc_attr($status_id); ?>"
                    >
                </div>
                <button type="button" class="aom-locate-button" data-aom-locate>📍 Détecter ma ville</button>
                <div
                    id="<?php echo esc_attr($results_id); ?>"
                    class="aom-search-results"
                    role="listbox"
                    hidden
                ></div>
                <p
                    id="<?php echo esc_attr($status_id); ?>"
                    class="aom-search-status"
                    role="status"
                    aria-live="polite"
                >Saisissez au moins deux lettres.</p>
            </div>
            <div class="aom-coverage">
                <strong>5 territoires</strong>
                <span>Antilles • Guyane • Réunion-Mayotte • Nouvelle-Calédonie • Polynésie</span>
            </div>
        </div>

        <p class="aom-stale" data-aom-stale role="status" hidden>
            Attention : la dernière mise à jour disponible a plus de 8 heures.
        </p>

        <div class="aom-tabs" role="tablist" aria-label="Type de prévision AROME">
            <button
                type="button"
                class="aom-tab aom-tab-map is-active"
                role="tab"
                aria-selected="true"
                data-aom-tab="map"
            >🗺️ Cartes météo</button>
            <button
                type="button"
                class="aom-tab"
                role="tab"
                aria-selected="false"
                data-aom-tab="general"
            >🌤️ Prévisions générales</button>
            <button
                type="button"
                class="aom-tab aom-tab-storm"
                role="tab"
                aria-selected="false"
                data-aom-tab="storms"
            >⛈️ Prévisions orages</button>
            <button
                type="button"
                class="aom-tab aom-tab-snow"
                role="tab"
                aria-selected="false"
                data-aom-tab="snow"
            >❄️ Risque de neige</button>
        </div>

        <div class="aom-panel aom-map-panel" data-aom-panel="map">
            <?php
            echo aom_render_map_shortcode(
                array(
                    'variable' => 'temperature',
                    'hauteur' => '760',
                    'titre' => 'Cartes AROME Outre-Mer — résolution 2,5 km',
                    'animation' => 'oui',
                ),
                $territory
            );
            ?>
        </div>

        <div class="aom-panel" data-aom-panel="general" hidden>
            <div class="aom-table-wrap aom-general-wrap" role="region" aria-label="Prévisions horaires générales" tabindex="0">
                <table class="aom-table">
                    <thead>
                        <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Heure</th>
                            <th scope="col">Temps</th>
                            <th scope="col">T°</th>
                            <th scope="col">Hum.</th>
                            <th scope="col">Pluie</th>
                            <th scope="col">Nuages</th>
                            <th scope="col">Vent</th>
                            <th scope="col">Rafales</th>
                            <th scope="col">Pression</th>
                        </tr>
                    </thead>
                    <tbody data-aom-body-general>
                        <tr>
                            <td colspan="10" class="aom-loading">Chargement des prévisions…</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <section class="aom-charts" data-aom-charts aria-label="Diagrammes AROME">
                <article class="aom-chart-card">
                    <h3 data-aom-chart-title-temperature>Diagramme températures (°C)</h3>
                    <div class="aom-chart" data-aom-chart-temperature></div>
                </article>
                <article class="aom-chart-card">
                    <h3 data-aom-chart-title-pressure>Diagramme pression ramenée au niveau de la mer (hPa)</h3>
                    <div class="aom-chart" data-aom-chart-pressure></div>
                </article>
                <article class="aom-chart-card">
                    <h3 data-aom-chart-title-rain>Diagramme précipitations (mm)</h3>
                    <p class="aom-chart-total" data-aom-rain-total>Précipitations cumulées : —</p>
                    <div class="aom-chart" data-aom-chart-rain></div>
                </article>
                <article class="aom-chart-card">
                    <h3 data-aom-chart-title-wind>Diagramme rafales et vent moyen</h3>
                    <div class="aom-chart" data-aom-chart-wind></div>
                </article>
            </section>
        </div>

        <div class="aom-panel" data-aom-panel="storms" hidden>
            <p class="aom-storm-summary" data-aom-storm-summary>
                Diagnostic convectif AROME 0,025° : chargement…
            </p>
            <div class="aom-top-scroll" data-aom-top-scroll="storms" aria-label="Navigation horizontale du tableau orages" hidden><div></div></div>
            <div class="aom-table-wrap aom-storm-wrap" data-aom-scroll-wrap="storms" role="region" aria-label="Prévisions horaires d'orages" tabindex="0">
                <table class="aom-table aom-storm-table">
                    <thead>
                        <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Heure</th>
                            <th scope="col">Risque orage</th>
                            <th scope="col">MUCAPE</th>
                            <th scope="col">LCL estimé</th>
                            <th scope="col">Foudre</th>
                            <th scope="col">Grêle</th>
                            <th scope="col">Pluie conv.</th>
                            <th scope="col">Graupel</th>
                            <th scope="col">Pluie 1 h</th>
                            <th scope="col">Rafales</th>
                            <th scope="col">Type</th>
                            <th scope="col">Détails</th>
                        </tr>
                    </thead>
                    <tbody data-aom-body-storms>
                        <tr>
                            <td colspan="13" class="aom-loading">Chargement du diagnostic orageux…</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="aom-storm-note">
                <strong>Lecture expert :</strong> la MUCAPE et la réflectivité maximale sont des sorties directes AROME. Le risque, la foudre, la grêle et le type d’orage sont des diagnostics dérivés clairement signalés ; aucune valeur indisponible n’est inventée.
            </p>
        </div>

        <div class="aom-panel" data-aom-panel="snow" hidden>
            <p class="aom-snow-summary" data-aom-snow-summary>
                Diagnostic neige AROME 0,025° : chargement… (peu ou pas de valeurs attendues sous les tropiques)
            </p>
            <div class="aom-top-scroll" data-aom-top-scroll="snow" aria-label="Navigation horizontale du tableau neige" hidden><div></div></div>
            <div class="aom-table-wrap aom-snow-wrap" data-aom-scroll-wrap="snow" role="region" aria-label="Risque horaire de neige" tabindex="0">
                <table class="aom-table aom-snow-table">
                    <thead>
                        <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Heure</th>
                            <th scope="col">Risque neige</th>
                            <th scope="col">Phase</th>
                            <th scope="col">Neige 1 h</th>
                            <th scope="col">Neige 3 h</th>
                            <th scope="col">Neige 6 h</th>
                            <th scope="col">Tenue</th>
                            <th scope="col">Pres. hPa</th>
                            <th scope="col">Hum.</th>
                            <th scope="col">Vent moy. / raf.</th>
                            <th scope="col">Cumul neige fraîche</th>
                            <th scope="col">Détails</th>
                        </tr>
                    </thead>
                    <tbody data-aom-body-snow>
                        <tr>
                            <td colspan="13" class="aom-loading">Chargement du risque de neige…</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="aom-snow-note">
                <strong>Lecture neige :</strong> conservée pour cohérence avec les autres modules AROME ; en zone tropicale/équatoriale, seuls les sommets de Nouvelle-Calédonie ou des épisodes très exceptionnels peuvent produire des valeurs non nulles.
            </p>
        </div>

        <footer class="aom-footer">
            <span data-aom-generated>Mise à jour en cours de lecture…</span>
            <span>
                Données météo directes :
                <a href="https://www.data.gouv.fr/datasets/paquets-arome-outre-mer-antilles-resolution-0-025deg" target="_blank" rel="noopener noreferrer">AROME Outre-Mer 0,025° — Météo-France</a>
                • Recherche des communes : catalogue publié par le pipeline (couvre les 5 territoires, y compris Nouvelle-Calédonie et Polynésie)
                • <a href="https://www.alertes-meteo.com/" target="_blank" rel="noopener noreferrer">www.alertes-meteo.com</a>
            </span>
            <span class="aom-plugin-version">Module AROME Outre-Mer v<?php echo esc_html(AOM_VERSION); ?> (<?php echo esc_html(AOM_RELEASE_DATE); ?>)</span>
        </footer>

        <noscript>
            <p class="aom-message aom-error">JavaScript doit être activé pour rechercher une commune.</p>
        </noscript>
    </section>
    <?php
    return ob_get_clean();
}

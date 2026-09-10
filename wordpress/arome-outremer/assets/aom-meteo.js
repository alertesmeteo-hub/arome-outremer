(function () {
    'use strict';

    // Contrairement au module France, la recherche de commune ne s'appuie pas
    // sur geo.api.gouv.fr (qui ne couvre pas la Nouvelle-Calédonie/Polynésie) :
    // elle réutilise le catalogue de lieux déjà publié par le pipeline pour la
    // carte (maps/communes.json), identique pour les 5 territoires.
    var DIRECTIONS = [
        'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
        'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'
    ];
    var CONDITIONS = {
        0: { label: 'Indéterminé', icon: '•' },
        1: { label: 'Dégagé', icon: '☀️' },
        2: { label: 'Peu nuageux', icon: '🌤️' },
        3: { label: 'Nuageux', icon: '⛅' },
        4: { label: 'Couvert', icon: '☁️' },
        5: { label: 'Pluie', icon: '🌦️' },
        6: { label: 'Forte pluie', icon: '🌧️' },
        7: { label: 'Neige', icon: '❄️' },
        8: { label: 'Brouillard', icon: '🌫️' },
        9: { label: 'Très venteux', icon: '💨' }
    };

    var THUNDER_RISKS = {
        0: { label: 'Minimal', icon: '⚪' },
        1: { label: 'Faible', icon: '🟢' },
        2: { label: 'Modéré', icon: '🟡' },
        3: { label: 'Fort', icon: '🟠' },
        4: { label: 'Sévère', icon: '🔴' }
    };
    var HAZARD_RISKS = {
        0: 'Faible',
        1: 'Faible',
        2: 'Modéré',
        3: 'Fort'
    };
    var STORM_TYPES = {
        0: 'Pas d’orage organisé',
        1: 'Cellules isolées',
        2: 'Multicellulaire',
        3: 'Ligne / MCS',
        4: 'Convection très intense'
    };
    var SNOW_RISKS = {
        0: { label: 'Aucun', icon: '⚪' },
        1: { label: 'Faible', icon: '🟢' },
        2: { label: 'Modéré', icon: '🟡' },
        3: { label: 'Fort', icon: '🟠' },
        4: { label: 'Très fort', icon: '🔴' }
    };
    var SNOW_STICK = { 0: 'Aucune', 1: 'Faible', 2: 'Possible', 3: 'Probable' };
    var SNOW_PHASE = { 0: '—', 1: 'Pluie', 2: 'Pluie/neige', 3: 'Neige' };
    var LEGACY_COLUMNS = [
        'temperature_c', 'humidity_pct', 'precipitation_mm', 'cloud_cover_pct',
        'wind_speed_kmh', 'wind_direction_deg', 'wind_gust_kmh', 'pressure_hpa',
        'visibility_km', 'condition_code'
    ];


    function whenReady(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback);
        } else {
            callback();
        }
    }

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function haversineKm(lat1, lon1, lat2, lon2) {
        var toRad = Math.PI / 180;
        var dLat = (lat2 - lat1) * toRad;
        var dLon = (lon2 - lon1) * toRad;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * 6371 * Math.asin(Math.sqrt(a));
    }

    function normalizeSearchText(value) {
        var text = String(value || '').toLowerCase();
        if (typeof text.normalize === 'function') {
            text = text.normalize('NFD').replace(new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g'), '');
        }
        return text;
    }

    function formatNumber(value, decimals) {
        if (!finite(value)) {
            return '—';
        }
        return value.toLocaleString('fr-FR', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    function roundUpFive(value) {
        if (!finite(value)) {
            return null;
        }
        return Math.ceil(Math.max(0, Number(value)) / 5) * 5;
    }

    function dateFormatter(timezone, options) {
        try {
            return new Intl.DateTimeFormat('fr-FR', Object.assign(
                { timeZone: timezone },
                options
            ));
        } catch (error) {
            return new Intl.DateTimeFormat('fr-FR', options);
        }
    }

    function windDirection(degrees) {
        if (!finite(degrees)) {
            return '';
        }
        return DIRECTIONS[Math.round(degrees / 22.5) % 16];
    }

    function temperatureClass(value) {
        if (!finite(value)) { return ''; }
        if (value >= 35) { return 'aom-temp-extreme'; }
        if (value >= 30) { return 'aom-temp-hot'; }
        if (value >= 22) { return 'aom-temp-warm'; }
        if (value >= 12) { return 'aom-temp-mild'; }
        if (value >= 4) { return 'aom-temp-cool'; }
        return 'aom-temp-cold';
    }

    function gustClass(value) {
        if (!finite(value)) { return ''; }
        if (value >= 80) { return 'aom-gust-danger'; }
        if (value >= 60) { return 'aom-gust-strong'; }
        if (value >= 40) { return 'aom-gust-moderate'; }
        return '';
    }

    function windForceClass(value) {
        if (!finite(value)) { return 'aom-wind-calm'; }
        if (value >= 80) { return 'aom-wind-violent'; }
        if (value >= 60) { return 'aom-wind-strong'; }
        if (value >= 40) { return 'aom-wind-fresh'; }
        if (value >= 20) { return 'aom-wind-moderate'; }
        return 'aom-wind-light';
    }

    function rainClass(value) {
        if (!finite(value) || value < 0.1) { return ''; }
        if (value >= 15) { return 'aom-rain aom-rain-intense'; }
        if (value >= 5) { return 'aom-rain aom-rain-strong'; }
        if (value >= 2) { return 'aom-rain aom-rain-moderate'; }
        if (value >= 0.5) { return 'aom-rain aom-rain-light'; }
        return 'aom-rain aom-rain-trace';
    }

    function svgElement(name, attributes, text) {
        var node = document.createElementNS('http://www.w3.org/2000/svg', name);
        Object.keys(attributes || {}).forEach(function (key) {
            node.setAttribute(key, String(attributes[key]));
        });
        if (typeof text === 'string') {
            node.textContent = text;
        }
        return node;
    }

    function finiteValues(values) {
        return values.filter(function (value) { return finite(value); });
    }

    function niceNumber(value, roundValue) {
        if (!finite(value) || value <= 0) { return 1; }
        var exponent = Math.floor(Math.log10(value));
        var fraction = value / Math.pow(10, exponent);
        var niceFraction;
        if (roundValue) {
            if (fraction < 1.5) { niceFraction = 1; }
            else if (fraction < 3) { niceFraction = 2; }
            else if (fraction < 7) { niceFraction = 5; }
            else { niceFraction = 10; }
        } else {
            if (fraction <= 1) { niceFraction = 1; }
            else if (fraction <= 2) { niceFraction = 2; }
            else if (fraction <= 5) { niceFraction = 5; }
            else { niceFraction = 10; }
        }
        return niceFraction * Math.pow(10, exponent);
    }

    function chartScale(values, forceZero, targetTicks, paddingSteps) {
        var clean = finiteValues(values);
        if (!clean.length) { return null; }
        var minimum = Math.min.apply(null, clean);
        var maximum = Math.max.apply(null, clean);
        if (forceZero) { minimum = Math.min(0, minimum); }
        if (minimum === maximum) {
            minimum -= 1;
            maximum += 1;
        }
        var rawRange = Math.max(0.0001, maximum - minimum);
        var step = niceNumber(rawRange / Math.max(2, (targetTicks || 5) - 1), true);
        var niceMin = forceZero && minimum >= 0 ? 0 : Math.floor(minimum / step) * step;
        var niceMax = Math.ceil(maximum / step) * step;
        var pad = Math.max(0, parseInt(paddingSteps || 0, 10) || 0);
        if (pad > 0) {
            if (!(forceZero && minimum >= 0)) {
                niceMin -= step * pad;
            }
            niceMax += step * pad;
        }
        if (niceMin === niceMax) { niceMax = niceMin + step; }
        return { min: niceMin, max: niceMax, step: step };
    }

    function chartZeroScale(values, targetTicks) {
        var clean = finiteValues(values).filter(function (value) { return value >= 0; });
        var maximum = clean.length ? Math.max.apply(null, clean) : 0;
        if (!finite(maximum) || maximum <= 0) {
            return { min: 0, max: 1, step: 0.2 };
        }
        var desiredIntervals = Math.max(3, (targetTicks || 5) - 1);
        var step = niceNumber(maximum / desiredIntervals, true);
        // Évite les graduations peu naturelles comme 3,5 / 7 / 10,5 / 14 mm.
        if (maximum >= 10 && step < 5) { step = 5; }
        else if (maximum >= 5 && step < 2) { step = 2; }
        else if (maximum >= 2 && step < 1) { step = 1; }
        else if (maximum >= 1 && step < 0.5) { step = 0.5; }
        var niceMax = Math.ceil(maximum / step) * step;
        // Toujours laisser un peu d'air au-dessus si le maximum tombe exactement sur la borne.
        if (Math.abs(niceMax - maximum) < 1e-9) { niceMax += step; }
        return { min: 0, max: niceMax, step: step };
    }

    function smoothPath(points) {
        if (!points.length) { return ''; }
        if (points.length === 1) {
            return 'M ' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2);
        }
        var path = 'M ' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2);
        for (var i = 0; i < points.length - 1; i += 1) {
            var current = points[i];
            var next = points[i + 1];
            var middleX = (current.x + next.x) / 2;
            path += ' C ' + middleX.toFixed(2) + ' ' + current.y.toFixed(2)
                + ' ' + middleX.toFixed(2) + ' ' + next.y.toFixed(2)
                + ' ' + next.x.toFixed(2) + ' ' + next.y.toFixed(2);
        }
        return path;
    }

    function chartPointX(index, count, margin, innerWidth) {
        if (count <= 1) { return margin.left + innerWidth / 2; }
        return margin.left + innerWidth * index / (count - 1);
    }

    function chartDayBands(svg, count, margin, innerWidth, innerHeight, meta) {
        if (!meta || !Array.isArray(meta.dayKeys) || !meta.dayKeys.length) { return; }
        var start = 0;
        while (start < count) {
            var key = meta.dayKeys[start];
            var end = start;
            while (end + 1 < count && meta.dayKeys[end + 1] === key) { end += 1; }
            var startX = start === 0
                ? margin.left
                : (chartPointX(start - 1, count, margin, innerWidth) + chartPointX(start, count, margin, innerWidth)) / 2;
            var endX = end === count - 1
                ? margin.left + innerWidth
                : (chartPointX(end, count, margin, innerWidth) + chartPointX(end + 1, count, margin, innerWidth)) / 2;
            var token = (meta.dayTokens && meta.dayTokens[start]) || 'other';
            svg.appendChild(svgElement('rect', {
                x: startX,
                y: margin.top,
                width: Math.max(0, endX - startX),
                height: innerHeight,
                class: 'aom-chart-day-band aom-dayband-' + token
            }));

            // Bandeau supérieur beaucoup plus visible pour identifier la journée.
            svg.appendChild(svgElement('rect', {
                x: startX,
                y: margin.top,
                width: Math.max(0, endX - startX),
                height: 46,
                class: 'aom-chart-day-strip aom-daystrip-' + token
            }));

            // Séparation verticale nette entre deux journées.
            if (start > 0) {
                svg.appendChild(svgElement('line', {
                    x1: startX,
                    y1: margin.top,
                    x2: startX,
                    y2: margin.top + innerHeight,
                    class: 'aom-chart-day-separator aom-dayseparator-' + token
                }));
            }

            if (endX - startX > 72) {
                var dayLabel = meta.dayLabels && meta.dayLabels[start] ? meta.dayLabels[start] : key;
                svg.appendChild(svgElement('text', {
                    x: (startX + endX) / 2,
                    y: margin.top + 31,
                    'text-anchor': 'middle',
                    class: 'aom-chart-day-label aom-daylabel-' + token
                }, dayLabel));
            }
            start = end + 1;
        }
    }

    function chartTickIndexes(count, maximumTicks) {
        if (count <= 0) { return []; }
        if (count <= maximumTicks) {
            return Array.from({ length: count }, function (_, index) { return index; });
        }
        var result = [];
        var step = (count - 1) / (maximumTicks - 1);
        for (var i = 0; i < maximumTicks; i += 1) {
            result.push(Math.round(i * step));
        }
        return result.filter(function (value, index, array) {
            return index === 0 || value !== array[index - 1];
        });
    }

    function appendChartMetrics(container, metrics) {
        var valid = (metrics || []).filter(function (metric) { return metric && metric.value !== '—'; });
        if (!valid.length) { return; }
        var block = document.createElement('div');
        block.className = 'aom-chart-metrics';
        valid.forEach(function (metric) {
            var item = document.createElement('span');
            item.className = 'aom-chart-metric';
            item.appendChild(textSpan(metric.label, 'aom-chart-metric-label'));
            item.appendChild(textSpan(metric.value, 'aom-chart-metric-value'));
            block.appendChild(item);
        });
        container.appendChild(block);
    }

    function appendChartViewport(container, svg) {
        var viewport = document.createElement('div');
        viewport.className = 'aom-chart-viewport';
        var tooltip = document.createElement('div');
        tooltip.className = 'aom-chart-tooltip';
        tooltip.hidden = true;
        tooltip.setAttribute('role', 'status');
        tooltip.setAttribute('aria-live', 'polite');

        function tooltipTarget(node) {
            if (!node || typeof node.closest !== 'function') { return null; }
            return node.closest('[data-aom-tooltip]');
        }

        function placeTooltip(clientX, clientY) {
            var rect = viewport.getBoundingClientRect();
            var x = clientX - rect.left + viewport.scrollLeft + 16;
            var y = clientY - rect.top + viewport.scrollTop - 12;
            tooltip.style.left = Math.max(8, x) + 'px';
            tooltip.style.top = Math.max(8, y) + 'px';
        }

        viewport.addEventListener('pointerover', function (event) {
            var target = tooltipTarget(event.target);
            if (!target) { return; }
            tooltip.textContent = target.getAttribute('data-aom-tooltip') || '';
            tooltip.hidden = false;
            placeTooltip(event.clientX, event.clientY);
        });
        viewport.addEventListener('pointermove', function (event) {
            if (tooltip.hidden) { return; }
            var target = tooltipTarget(event.target);
            if (!target) { return; }
            tooltip.textContent = target.getAttribute('data-aom-tooltip') || '';
            placeTooltip(event.clientX, event.clientY);
        });
        viewport.addEventListener('pointerout', function (event) {
            var from = tooltipTarget(event.target);
            var to = tooltipTarget(event.relatedTarget);
            if (from && from !== to) { tooltip.hidden = true; }
        });
        viewport.addEventListener('focusin', function (event) {
            var target = tooltipTarget(event.target);
            if (!target) { return; }
            tooltip.textContent = target.getAttribute('data-aom-tooltip') || '';
            tooltip.hidden = false;
            var targetRect = target.getBoundingClientRect();
            placeTooltip(targetRect.left + targetRect.width / 2, targetRect.top);
        });
        viewport.addEventListener('focusout', function () {
            tooltip.hidden = true;
        });

        viewport.appendChild(svg);
        viewport.appendChild(tooltip);
        container.appendChild(viewport);
    }

    function seriesStats(values) {
        var clean = finiteValues(values);
        if (!clean.length) { return null; }
        return {
            min: Math.min.apply(null, clean),
            max: Math.max.apply(null, clean),
            first: clean[0],
            last: clean[clean.length - 1]
        };
    }

    function drawExtremaLabels(svg, points, values, formatter, className) {
        var clean = values.map(function (value, index) {
            return finite(value) ? { value: value, index: index } : null;
        }).filter(Boolean);
        if (!clean.length) { return; }
        var minItem = clean.reduce(function (a, b) { return b.value < a.value ? b : a; });
        var maxItem = clean.reduce(function (a, b) { return b.value > a.value ? b : a; });
        var indexes = minItem.index === maxItem.index ? [maxItem.index] : [minItem.index, maxItem.index];
        indexes.forEach(function (index) {
            var point = points[index];
            if (!point) { return; }
            var y = point.y < 54 ? point.y + 22 : point.y - 10;
            svg.appendChild(svgElement('text', {
                x: point.x,
                y: y,
                'text-anchor': 'middle',
                class: 'aom-chart-value-label ' + className
            }, formatter(values[index])));
        });
    }

    function renderLineChart(container, labels, series, options) {
        if (!container) { return; }
        options = options || {};
        container.replaceChildren();
        var all = [];
        series.forEach(function (item) { all = all.concat(item.values); });
        var scale = chartScale(all, Boolean(options.forceZero), options.targetTicks || 5, options.paddingSteps || 0);
        if (!scale) {
            container.appendChild(textSpan('Données indisponibles pour ce diagramme.', 'aom-chart-empty'));
            return;
        }

        var stats = seriesStats(series[0].values);
        if (options.metricMode === 'temperature' && stats) {
            appendChartMetrics(container, [
                { label: 'Mini', value: formatNumber(stats.min, 0) + ' °C' },
                { label: 'Maxi', value: formatNumber(stats.max, 0) + ' °C' },
                { label: 'Amplitude', value: formatNumber(stats.max - stats.min, 0) + ' °C' }
            ]);
        } else if (options.metricMode === 'pressure' && stats) {
            appendChartMetrics(container, [
                { label: 'Mini', value: formatNumber(stats.min, 0) + ' hPa' },
                { label: 'Maxi', value: formatNumber(stats.max, 0) + ' hPa' },
                { label: 'Évolution', value: (stats.last >= stats.first ? '+' : '') + formatNumber(stats.last - stats.first, 0) + ' hPa' }
            ]);
        } else if (options.metricMode === 'wind') {
            var windStats = seriesStats(series[0].values);
            var gustStats = seriesStats(series[1] ? series[1].values : []);
            appendChartMetrics(container, [
                { label: 'Vent max.', value: windStats ? formatNumber(windStats.max, 0) + ' km/h' : '—' },
                { label: 'Rafale max.', value: gustStats ? formatNumber(gustStats.max, 0) + ' km/h' : '—' }
            ]);
        }

        var width = 1280;
        var height = 460;
        var margin = { left: 68, right: 32, top: 58, bottom: 64 };
        var innerWidth = width - margin.left - margin.right;
        var innerHeight = height - margin.top - margin.bottom;
        var svg = svgElement('svg', {
            viewBox: '0 0 ' + width + ' ' + height,
            role: 'img',
            'aria-label': options.ariaLabel || 'Diagramme',
            preserveAspectRatio: 'xMidYMid meet'
        });
        svg.classList.add('aom-chart-svg');
        chartDayBands(svg, labels.length, margin, innerWidth, innerHeight, options.meta);

        var tickValue = Math.ceil((scale.max - scale.min) / scale.step);
        for (var g = 0; g <= tickValue; g += 1) {
            var value = scale.min + g * scale.step;
            var gy = margin.top + innerHeight * (scale.max - value) / (scale.max - scale.min);
            svg.appendChild(svgElement('line', {
                x1: margin.left,
                x2: width - margin.right,
                y1: gy,
                y2: gy,
                class: 'aom-chart-grid'
            }));
            svg.appendChild(svgElement('text', {
                x: margin.left - 9,
                y: gy + 4,
                'text-anchor': 'end',
                class: 'aom-chart-axis'
            }, formatNumber(value, options.decimals || 0)));
        }

        var n = labels.length;
        chartTickIndexes(n, 8).forEach(function (index) {
            var x = chartPointX(index, n, margin, innerWidth);
            var axisLabel = options.meta && options.meta.hourLabels
                ? options.meta.hourLabels[index]
                : labels[index];
            svg.appendChild(svgElement('line', {
                x1: x,
                x2: x,
                y1: margin.top,
                y2: margin.top + innerHeight,
                class: 'aom-chart-grid aom-chart-grid-vertical'
            }));
            svg.appendChild(svgElement('text', {
                x: x,
                y: height - 18,
                'text-anchor': index === 0 ? 'start' : (index === n - 1 ? 'end' : 'middle'),
                class: 'aom-chart-axis aom-chart-xaxis'
            }, axisLabel));
        });

        var seriesPoints = [];
        series.forEach(function (item, seriesIndex) {
            var points = [];
            item.values.forEach(function (value, index) {
                if (!finite(value)) { points[index] = null; return; }
                points[index] = {
                    x: chartPointX(index, n, margin, innerWidth),
                    y: margin.top + innerHeight * (scale.max - value) / (scale.max - scale.min),
                    value: value,
                    index: index
                };
            });
            seriesPoints.push(points);

            var segments = [];
            var current = [];
            points.forEach(function (point) {
                if (!point) {
                    if (current.length) { segments.push(current); current = []; }
                    return;
                }
                current.push(point);
            });
            if (current.length) { segments.push(current); }

            if (series.length === 1 && options.fillArea) {
                segments.forEach(function (segment) {
                    if (!segment.length) { return; }
                    var d = smoothPath(segment)
                        + ' L ' + segment[segment.length - 1].x.toFixed(2) + ' ' + (margin.top + innerHeight).toFixed(2)
                        + ' L ' + segment[0].x.toFixed(2) + ' ' + (margin.top + innerHeight).toFixed(2)
                        + ' Z';
                    svg.appendChild(svgElement('path', {
                        d: d,
                        class: 'aom-chart-area ' + item.className
                    }));
                });
            }

            segments.forEach(function (segment) {
                svg.appendChild(svgElement('path', {
                    d: smoothPath(segment),
                    class: 'aom-chart-line ' + item.className,
                    fill: 'none'
                }));
            });

            points.forEach(function (point, index) {
                if (!point) { return; }
                var tooltipLabel = labels[index] + ' — ' + item.label + ' : '
                    + formatNumber(point.value, options.decimals || 0)
                    + (options.unit ? ' ' + options.unit : '');
                var attrs = {
                    cx: point.x,
                    cy: point.y,
                    r: options.showPoints === false ? 10 : 5.4,
                    class: (options.showPoints === false ? 'aom-chart-hitpoint ' : 'aom-chart-point ') + item.className,
                    tabindex: 0,
                    'aria-label': tooltipLabel,
                    'data-aom-tooltip': tooltipLabel
                };
                if (options.showPoints === false) {
                    attrs.fill = 'transparent';
                    attrs.stroke = 'none';
                    attrs.opacity = '0';
                }
                var circle = svgElement('circle', attrs);
                svg.appendChild(circle);
            });

            if (series.length === 1 && options.showExtrema === true) {
                drawExtremaLabels(
                    svg,
                    points,
                    item.values,
                    function (value) {
                        return formatNumber(value, options.decimals || 0) + (options.unit ? ' ' + options.unit : '');
                    },
                    item.className
                );
            }
        });

        if (options.bandBetween && seriesPoints.length >= 2) {
            var upper = seriesPoints[1];
            var lower = seriesPoints[0];
            var upperPoints = [];
            var lowerPoints = [];
            for (var i = 0; i < n; i += 1) {
                if (upper[i] && lower[i]) {
                    upperPoints.push(upper[i]);
                    lowerPoints.push(lower[i]);
                }
            }
            if (upperPoints.length > 1 && upperPoints.length === lowerPoints.length) {
                var area = smoothPath(upperPoints);
                var reversed = lowerPoints.slice().reverse();
                area += ' L ' + reversed[0].x.toFixed(2) + ' ' + reversed[0].y.toFixed(2);
                for (var j = 1; j < reversed.length; j += 1) {
                    area += ' L ' + reversed[j].x.toFixed(2) + ' ' + reversed[j].y.toFixed(2);
                }
                area += ' Z';
                var envelope = svgElement('path', {
                    d: area,
                    class: 'aom-chart-wind-envelope'
                });
                var firstLine = svg.querySelector('.aom-chart-line');
                if (firstLine) { svg.insertBefore(envelope, firstLine); }
                else { svg.appendChild(envelope); }
            }
        }

        if (series.length > 1) {
            var legend = svgElement('g', { class: 'aom-chart-legend' });
            series.forEach(function (item, index) {
                var x = margin.left + index * 165;
                legend.appendChild(svgElement('line', {
                    x1: x,
                    x2: x + 28,
                    y1: 17,
                    y2: 17,
                    class: 'aom-chart-line ' + item.className
                }));
                legend.appendChild(svgElement('text', {
                    x: x + 36,
                    y: 21,
                    class: 'aom-chart-axis aom-chart-legend-text'
                }, item.label));
            });
            svg.appendChild(legend);
        }
        appendChartViewport(container, svg);
    }

    function rainVisualClass(value) {
        if (!finite(value) || value < 0.1) { return 'aom-chart-rain-zero'; }
        if (value >= 15) { return 'aom-chart-rain-intense'; }
        if (value >= 5) { return 'aom-chart-rain-strong'; }
        if (value >= 2) { return 'aom-chart-rain-moderate'; }
        if (value >= 0.5) { return 'aom-chart-rain-light'; }
        return 'aom-chart-rain-trace';
    }

    function renderRainChart(container, labels, rainValues, cumulativeValues, options) {
        if (!container) { return; }
        options = options || {};
        container.replaceChildren();
        var rainClean = finiteValues(rainValues);
        var cumulativeClean = finiteValues(cumulativeValues);
        if (!rainClean.length && !cumulativeClean.length) {
            container.appendChild(textSpan('Données indisponibles pour ce diagramme.', 'aom-chart-empty'));
            return;
        }

        var total = cumulativeClean.length ? cumulativeClean[cumulativeClean.length - 1] : 0;
        var rainMaxValue = rainClean.length ? Math.max.apply(null, rainClean) : 0;
        appendChartMetrics(container, [
            { label: 'Cumul', value: formatNumber(total, 1) + ' mm' },
            { label: 'Max. horaire', value: formatNumber(rainMaxValue, 1) + ' mm' }
        ]);

        var width = 1280;
        var height = 460;
        var margin = { left: 68, right: 78, top: 58, bottom: 64 };
        var innerWidth = width - margin.left - margin.right;
        var innerHeight = height - margin.top - margin.bottom;
        var combinedScaleValues = [0].concat(rainClean.length ? rainClean : [0], cumulativeClean.length ? cumulativeClean : [0]);
        var rainScale = chartZeroScale(combinedScaleValues, 6);
        var cumScale = rainScale;
        var svg = svgElement('svg', {
            viewBox: '0 0 ' + width + ' ' + height,
            role: 'img',
            'aria-label': 'Diagramme des précipitations et du cumul',
            preserveAspectRatio: 'xMidYMid meet'
        });
        svg.classList.add('aom-chart-svg');
        chartDayBands(svg, labels.length, margin, innerWidth, innerHeight, options.meta);

        var rainTickCount = Math.round((rainScale.max - rainScale.min) / rainScale.step);
        for (var g = 0; g <= rainTickCount; g += 1) {
            var rainAxis = rainScale.min + g * rainScale.step;
            var y = margin.top + innerHeight * (rainScale.max - rainAxis) / Math.max(0.001, rainScale.max - rainScale.min);
            svg.appendChild(svgElement('line', {
                x1: margin.left,
                x2: width - margin.right,
                y1: y,
                y2: y,
                class: 'aom-chart-grid'
            }));
            svg.appendChild(svgElement('text', {
                x: margin.left - 9,
                y: y + 5,
                'text-anchor': 'end',
                class: 'aom-chart-axis'
            }, formatNumber(rainAxis, rainScale.step < 1 ? 1 : 0)));
        }

        var cumTickCount = Math.round((cumScale.max - cumScale.min) / cumScale.step);
        for (var cg = 0; cg <= cumTickCount; cg += 1) {
            var cumAxis = cumScale.min + cg * cumScale.step;
            var cy = margin.top + innerHeight * (cumScale.max - cumAxis) / Math.max(0.001, cumScale.max - cumScale.min);
            svg.appendChild(svgElement('text', {
                x: width - margin.right + 9,
                y: cy + 5,
                'text-anchor': 'start',
                class: 'aom-chart-axis aom-chart-axis-cumulative'
            }, formatNumber(cumAxis, cumScale.step < 1 ? 1 : 0)));
        }


        var n = labels.length;
        var slot = n ? innerWidth / n : innerWidth;
        rainValues.forEach(function (value, index) {
            if (!finite(value) || value <= 0) { return; }
            var barHeight = innerHeight * (Math.min(value, rainScale.max) - rainScale.min) / Math.max(0.001, rainScale.max - rainScale.min);
            var x = margin.left + index * slot + slot * 0.16;
            var y = margin.top + innerHeight - barHeight;
            var rainTooltip = labels[index] + ' — pluie horaire : ' + formatNumber(value, 1) + ' mm';
            var bar = svgElement('rect', {
                x: x,
                y: y,
                width: Math.max(3, slot * 0.68),
                height: barHeight,
                rx: Math.min(6, slot * 0.18),
                class: 'aom-chart-rain-bar ' + rainVisualClass(value),
                tabindex: 0,
                'aria-label': rainTooltip,
                'data-aom-tooltip': rainTooltip
            });
            svg.appendChild(bar);
        });

        var cumulativePoints = [];
        cumulativeValues.forEach(function (value, index) {
            if (!finite(value)) { cumulativePoints[index] = null; return; }
            cumulativePoints[index] = {
                x: chartPointX(index, n, margin, innerWidth),
                y: margin.top + innerHeight * (cumScale.max - value) / Math.max(0.001, cumScale.max - cumScale.min),
                value: value
            };
        });
        var cleanPoints = cumulativePoints.filter(Boolean);
        if (cleanPoints.length) {
            svg.appendChild(svgElement('path', {
                d: smoothPath(cleanPoints),
                class: 'aom-chart-line aom-series-rain-cumulative',
                fill: 'none'
            }));
            cumulativePoints.forEach(function (point, index) {
                if (!point) { return; }
                var cumulativeTooltip = labels[index] + ' — cumul : ' + formatNumber(point.value, 1) + ' mm';
                var hitPoint = svgElement('circle', {
                    cx: point.x,
                    cy: point.y,
                    r: 11,
                    class: 'aom-chart-hitpoint aom-series-rain-cumulative',
                    tabindex: 0,
                    'aria-label': cumulativeTooltip,
                    'data-aom-tooltip': cumulativeTooltip,
                    fill: 'transparent',
                    stroke: 'none',
                    opacity: '0'
                });
                svg.appendChild(hitPoint);
            });
        }

        chartTickIndexes(n, 8).forEach(function (index) {
            var x = chartPointX(index, n, margin, innerWidth);
            var axisLabel = options.meta && options.meta.hourLabels
                ? options.meta.hourLabels[index]
                : labels[index];
            svg.appendChild(svgElement('text', {
                x: x,
                y: height - 18,
                'text-anchor': index === 0 ? 'start' : (index === n - 1 ? 'end' : 'middle'),
                class: 'aom-chart-axis aom-chart-xaxis'
            }, axisLabel));
        });

        var legend = svgElement('g', { class: 'aom-chart-legend' });
        legend.appendChild(svgElement('rect', {
            x: margin.left,
            y: 10,
            width: 20,
            height: 11,
            rx: 4,
            class: 'aom-chart-rain-bar aom-chart-rain-light'
        }));
        legend.appendChild(svgElement('text', {
            x: margin.left + 28,
            y: 21,
            class: 'aom-chart-axis aom-chart-legend-text'
        }, 'Pluie horaire'));
        legend.appendChild(svgElement('line', {
            x1: margin.left + 142,
            x2: margin.left + 172,
            y1: 17,
            y2: 17,
            class: 'aom-chart-line aom-series-rain-cumulative'
        }));
        legend.appendChild(svgElement('text', {
            x: margin.left + 180,
            y: 21,
            class: 'aom-chart-axis aom-chart-legend-text'
        }, 'Cumul'));
        svg.appendChild(legend);
        appendChartViewport(container, svg);
    }

    function createCell(tag, label, className) {
        var cell = document.createElement(tag);
        if (label) {
            cell.setAttribute('data-label', label);
        }
        if (className) {
            cell.className = className;
        }
        return cell;
    }

    function textSpan(text, className) {
        var span = document.createElement('span');
        span.textContent = text;
        if (className) {
            span.className = className;
        }
        return span;
    }

    function fetchJson(url, options) {
        return fetch(url, options || {}).then(function (response) {
            if (!response.ok) {
                throw new Error('Réponse HTTP ' + response.status);
            }
            return response.json();
        });
    }

    function initApp(app) {
        var baseUrl = (app.dataset.baseUrl || '').replace(/\/+$/, '');
        var defaultCode = app.dataset.defaultCode || '97105';
        var defaultDepartment = app.dataset.defaultDepartment || '971';
        var defaultName = app.dataset.defaultName || 'Pointe-à-Pitre';
        var hours = Math.max(1, Math.min(42, parseInt(app.dataset.hours || '42', 10)));
        var timezone = app.dataset.timezone || 'Europe/Paris';
        var titlePrefix = app.dataset.titlePrefix || 'Prévisions AROME';
        var territories = [];
        try {
            territories = JSON.parse(app.dataset.territories || '[]');
        } catch (error) {
            territories = [];
        }
        var currentTerritory = app.dataset.territory || (territories[0] && territories[0].id) || '';

        var territorySelects = Array.prototype.slice.call(app.querySelectorAll('[data-aom-territory-select]'));
        var input = app.querySelector('.aom-city-input');
        var locateButton = app.querySelector('[data-aom-locate]');
        var results = app.querySelector('.aom-search-results');
        var status = app.querySelector('.aom-search-status');
        var generalBody = app.querySelector('[data-aom-body-general]');
        var stormBody = app.querySelector('[data-aom-body-storms]');
        var stormSummary = app.querySelector('[data-aom-storm-summary]');
        var snowBody = app.querySelector('[data-aom-body-snow]');
        var snowSummary = app.querySelector('[data-aom-snow-summary]');
        var tabs = Array.prototype.slice.call(app.querySelectorAll('[data-aom-tab]'));
        var panels = Array.prototype.slice.call(app.querySelectorAll('[data-aom-panel]'));
        var title = app.querySelector('[data-aom-title]');
        var altitudeLine = app.querySelector('[data-aom-altitude]');
        var meta = app.querySelector('[data-aom-meta]');
        var generated = app.querySelector('[data-aom-generated]');
        var stale = app.querySelector('[data-aom-stale]');
        var stormTopScroll = app.querySelector('[data-aom-top-scroll="storms"]');
        var stormScrollWrap = app.querySelector('[data-aom-scroll-wrap="storms"]');
        var stormTable = app.querySelector('.aom-storm-table');
        var snowTopScroll = app.querySelector('[data-aom-top-scroll="snow"]');
        var snowScrollWrap = app.querySelector('[data-aom-scroll-wrap="snow"]');
        var snowTable = app.querySelector('.aom-snow-table');
        var chartTemperature = app.querySelector('[data-aom-chart-temperature]');
        var chartPressure = app.querySelector('[data-aom-chart-pressure]');
        var chartRain = app.querySelector('[data-aom-chart-rain]');
        var chartWind = app.querySelector('[data-aom-chart-wind]');
        var chartTitleTemperature = app.querySelector('[data-aom-chart-title-temperature]');
        var chartTitlePressure = app.querySelector('[data-aom-chart-title-pressure]');
        var chartTitleRain = app.querySelector('[data-aom-chart-title-rain]');
        var chartTitleWind = app.querySelector('[data-aom-chart-title-wind]');
        var rainTotal = app.querySelector('[data-aom-rain-total]');

        var indexData = null;
        var placesData = null;
        var departmentCache = new Map();
        var debounceTimer = null;
        var searchController = null;
        var resultButtons = [];
        var activeResult = -1;
        var selectedMapFocus = null;

        var weekdayFormat = dateFormatter(timezone, { weekday: 'short' });
        var shortDateFormat = dateFormatter(timezone, { day: '2-digit', month: '2-digit' });
        var dayKeyFormat = dateFormatter(timezone, { year: 'numeric', month: '2-digit', day: '2-digit' });
        var hourFormat = dateFormatter(timezone, {
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });
        var fullFormat = dateFormatter(timezone, {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });

        function localDayKey(date) {
            return dayKeyFormat.format(date);
        }

        function weekdayToken(date) {
            var label = weekdayFormat.format(date).toLocaleLowerCase('fr-FR');
            if (label.indexOf('lun') === 0) { return 'mon'; }
            if (label.indexOf('mar') === 0) { return 'tue'; }
            if (label.indexOf('mer') === 0) { return 'wed'; }
            if (label.indexOf('jeu') === 0) { return 'thu'; }
            if (label.indexOf('ven') === 0) { return 'fri'; }
            if (label.indexOf('sam') === 0) { return 'sat'; }
            if (label.indexOf('dim') === 0) { return 'sun'; }
            return 'other';
        }

        function makeDayCell(date, rowSpan) {
            var cell = createCell('th', 'Date', 'aom-day-cell aom-day-' + weekdayToken(date));
            cell.scope = 'rowgroup';
            cell.rowSpan = rowSpan;
            cell.appendChild(textSpan(weekdayFormat.format(date), 'aom-day-weekday'));
            cell.appendChild(textSpan(shortDateFormat.format(date), 'aom-day-date'));
            return cell;
        }

        function syncTopScroll(topScroll, scrollWrap, table) {
            if (!topScroll || !scrollWrap || !table) { return; }
            var inner = topScroll.firstElementChild;
            if (!inner) { return; }
            inner.style.width = table.scrollWidth + 'px';
            topScroll.hidden = table.scrollWidth <= scrollWrap.clientWidth + 2;
        }

        function updateStormTopScroll() {
            syncTopScroll(stormTopScroll, stormScrollWrap, stormTable);
        }

        function updateSnowTopScroll() {
            syncTopScroll(snowTopScroll, snowScrollWrap, snowTable);
        }

        function bindTopScroll(topScroll, scrollWrap, updater) {
            if (!topScroll || !scrollWrap) { return; }
            topScroll.addEventListener('scroll', function () {
                scrollWrap.scrollLeft = topScroll.scrollLeft;
            });
            scrollWrap.addEventListener('scroll', function () {
                topScroll.scrollLeft = scrollWrap.scrollLeft;
            });
            window.addEventListener('resize', updater);
        }

        bindTopScroll(stormTopScroll, stormScrollWrap, updateStormTopScroll);
        bindTopScroll(snowTopScroll, snowScrollWrap, updateSnowTopScroll);

        function setStatus(message, error) {
            status.textContent = message;
            status.classList.toggle('aom-search-error', Boolean(error));
        }

        function setActiveView(view) {
            tabs.forEach(function (button) {
                var active = button.dataset.aomTab === view;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            panels.forEach(function (panel) {
                panel.hidden = panel.dataset.aomPanel !== view;
            });
            app.dataset.activeView = view;
            if (view === 'storms') { window.requestAnimationFrame(updateStormTopScroll); }
            if (view === 'snow') { window.requestAnimationFrame(updateSnowTopScroll); }
            if (view === 'map' && selectedMapFocus) {
                window.requestAnimationFrame(function () {
                    var mapApp = app.querySelector('[data-aomm-app]');
                    if (mapApp) {
                        mapApp.dispatchEvent(new CustomEvent('aomm:territory-changed', {
                            detail: selectedMapFocus
                        }));
                    }
                });
            }
        }

        tabs.forEach(function (button) {
            button.addEventListener('click', function () {
                setActiveView(button.dataset.aomTab || 'general');
            });
        });
        app.dataset.activeView = 'map';

        function putMessage(body, message, error, colspan) {
            if (!body) { return; }
            body.replaceChildren();
            var row = document.createElement('tr');
            var cell = createCell('td', '', error ? 'aom-loading aom-load-error' : 'aom-loading');
            cell.colSpan = colspan;
            cell.textContent = message;
            row.appendChild(cell);
            body.appendChild(row);
        }

        function showTableMessage(message, error) {
            putMessage(generalBody, message, error, 10);
            putMessage(stormBody, message, error, 13);
            putMessage(snowBody, message, error, 13);
            if (stormSummary) {
                stormSummary.textContent = message;
                stormSummary.classList.toggle('aom-storm-summary-warning', Boolean(error));
            }
            if (snowSummary) {
                snowSummary.textContent = message;
                snowSummary.classList.toggle('aom-snow-summary-warning', Boolean(error));
            }
        }

        function closeResults() {
            results.hidden = true;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
            resultButtons = [];
            activeResult = -1;
        }

        function setActiveResult(position) {
            if (!resultButtons.length) {
                return;
            }
            activeResult = Math.max(0, Math.min(resultButtons.length - 1, position));
            resultButtons.forEach(function (button, index) {
                var active = index === activeResult;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            var selected = resultButtons[activeResult];
            input.setAttribute('aria-activedescendant', selected.id);
            selected.scrollIntoView({ block: 'nearest' });
        }

        function loadIndex() {
            return fetchJson(baseUrl + '/index.json', { cache: 'no-cache' })
                .then(function (payload) {
                    if (!payload || payload.status !== 'ok' || !payload.departments) {
                        throw new Error('Index national AROME invalide');
                    }
                    indexData = payload;
                    var run = payload.model && payload.model.run_time
                        ? fullFormat.format(new Date(payload.model.run_time)).replace(':', 'h')
                        : 'indéterminé';
                    var resolution = payload.model && payload.model.resolution_km
                        ? formatNumber(payload.model.resolution_km, 1) + ' km'
                        : '—';
                    meta.textContent = 'Run du ' + run + ' • résolution ' + resolution +
                        ((payload.model && payload.model.storm_diagnostics) ? ' • diagnostics orages + neige AROME' : '');

                    if (payload.generated_at) {
                        generated.textContent = 'Mise à jour du tableau : ' +
                            fullFormat.format(new Date(payload.generated_at)).replace(':', 'h');
                        stale.hidden = (Date.now() - new Date(payload.generated_at).getTime()) <= 8 * 3600000;
                    }
                    return payload;
                });
        }

        function loadDepartment(code) {
            var normalized = String(code || '').toUpperCase();
            if (departmentCache.has(normalized)) {
                return departmentCache.get(normalized);
            }
            if (!indexData || !indexData.departments[normalized]) {
                return Promise.reject(new Error('Département hors couverture AROME'));
            }
            var relativeFile = indexData.departments[normalized].file;
            var promise = fetchJson(baseUrl + '/' + relativeFile, { cache: 'default' })
                .then(function (payload) {
                    if (!payload || payload.status !== 'ok' || !Array.isArray(payload.communes)) {
                        throw new Error('Fichier départemental invalide');
                    }
                    return payload;
                })
                .catch(function (error) {
                    departmentCache.delete(normalized);
                    throw error;
                });
            departmentCache.set(normalized, promise);
            return promise;
        }

        // Catalogue des lieux publié par le pipeline pour la carte
        // (maps/communes.json), réutilisé ici pour la recherche de commune :
        // même source pour les 5 territoires, y compris Nouvelle-Calédonie et
        // Polynésie (non couvertes par geo.api.gouv.fr).
        function loadPlaces() {
            return fetchJson(baseUrl + '/maps/communes.json', { cache: 'default' })
                .then(function (payload) {
                    var rows = payload && Array.isArray(payload.places) ? payload.places : [];
                    var columns = payload && Array.isArray(payload.columns) ? payload.columns : [
                        'name', 'population', 'latitude', 'longitude', 'code_insee', 'department'
                    ];
                    var index = {};
                    columns.forEach(function (name, position) { index[name] = position; });
                    placesData = rows.map(function (row) {
                        return {
                            nom: row[index.name],
                            population: Number(row[index.population]) || 0,
                            lat: Number(row[index.latitude]),
                            lon: Number(row[index.longitude]),
                            code: String(row[index.code_insee]),
                            codeDepartement: String(row[index.department]),
                            codesPostaux: []
                        };
                    });
                    placesData.sort(function (a, b) { return b.population - a.population; });
                    return placesData;
                })
                .catch(function () {
                    placesData = [];
                    return placesData;
                });
        }

        function renderForecast(departmentData, commune) {
            var pointId = Number(commune[6]);
            var lowerTime = Date.now() - 3600000;
            var rawForecasts = (departmentData.forecast || []).filter(function (step) {
                return Array.isArray(step) && new Date(step[0]).getTime() >= lowerTime;
            }).slice(0, hours);

            var columns = departmentData.columns && Array.isArray(departmentData.columns.values)
                ? departmentData.columns.values
                : LEGACY_COLUMNS;
            var columnIndex = {};
            columns.forEach(function (name, index) { columnIndex[name] = index; });
            function value(values, name, fallback) {
                var index = Object.prototype.hasOwnProperty.call(columnIndex, name)
                    ? columnIndex[name]
                    : fallback;
                return typeof index === 'number' ? values[index] : null;
            }
            function appendNumber(row, label, number, decimals, suffix, className) {
                var cell = createCell('td', label, className || '');
                cell.textContent = formatNumber(number, decimals) + (finite(number) ? (suffix || '') : '');
                row.appendChild(cell);
                return cell;
            }
            function appendHazard(row, label, code) {
                var numeric = finite(code) ? Number(code) : null;
                var cell = createCell('td', label, numeric === null ? '' : 'aom-hazard aom-hazard-' + numeric);
                cell.textContent = numeric === null ? '—' : (HAZARD_RISKS[numeric] || '—');
                row.appendChild(cell);
            }

            var forecasts = rawForecasts.filter(function (step) {
                return step[1] && Array.isArray(step[1][pointId]);
            });
            if (!forecasts.length) {
                showTableMessage('Aucune échéance AROME disponible pour cette commune.', true);
                return;
            }

            var dayCounts = {};
            forecasts.forEach(function (step) {
                var key = localDayKey(new Date(step[0]));
                dayCounts[key] = (dayCounts[key] || 0) + 1;
            });

            generalBody.replaceChildren();
            stormBody.replaceChildren();
            snowBody.replaceChildren();
            var previousGeneralDay = '';
            var previousStormDay = '';
            var previousSnowDay = '';
            var maxThunderRisk = null;
            var maxSnowRisk = null;
            var hasStormColumns = Object.prototype.hasOwnProperty.call(columnIndex, 'thunder_risk_code');
            var hasSnowColumns = Object.prototype.hasOwnProperty.call(columnIndex, 'snow_risk_code')
                && Object.prototype.hasOwnProperty.call(columnIndex, 'snowfall_mm')
                && Object.prototype.hasOwnProperty.call(columnIndex, 'snow_depth_cm');
            var chartLabels = [];
            var chartHourLabels = [];
            var chartDayKeys = [];
            var chartDayTokens = [];
            var chartDayLabels = [];
            var chartTemps = [];
            var chartPressures = [];
            var chartRainValues = [];
            var chartRainCumulative = [];
            var chartWindValues = [];
            var chartGustValues = [];
            var cumulativeRain = 0;

            forecasts.forEach(function (step, currentIndex) {
                var date = new Date(step[0]);
                var values = step[1][pointId];
                var dayKey = localDayKey(date);
                var temp = value(values, 'temperature_c', 0);
                var rain = value(values, 'precipitation_mm', 2);
                var wind = value(values, 'wind_speed_kmh', 4);
                var gust = value(values, 'wind_gust_kmh', 6);
                var windDisplay = roundUpFive(wind);
                var gustDisplay = roundUpFive(gust);

                chartLabels.push(shortDateFormat.format(date) + ' ' + hourFormat.format(date).replace(':', 'h'));
                chartHourLabels.push(hourFormat.format(date).replace(':', 'h'));
                chartDayKeys.push(dayKey);
                chartDayTokens.push(weekdayToken(date));
                chartDayLabels.push(weekdayFormat.format(date) + ' ' + shortDateFormat.format(date));
                chartTemps.push(temp);
                chartPressures.push(value(values, 'pressure_hpa', 7));
                chartRainValues.push(rain);
                cumulativeRain += finite(rain) ? Math.max(0, Number(rain)) : 0;
                chartRainCumulative.push(cumulativeRain);
                chartWindValues.push(windDisplay);
                chartGustValues.push(gustDisplay);

                // Tableau 1 — prévisions générales.
                var row = document.createElement('tr');
                if (dayKey !== previousGeneralDay) {
                    row.classList.add('aom-new-day');
                    row.appendChild(makeDayCell(date, dayCounts[dayKey]));
                    previousGeneralDay = dayKey;
                }

                var hourCell = createCell('td', 'Heure', 'aom-hour aom-hour-' + weekdayToken(date));
                hourCell.textContent = hourFormat.format(date);
                row.appendChild(hourCell);

                var conditionCode = value(values, 'condition_code', 9);
                var condition = CONDITIONS[Number(conditionCode)] || CONDITIONS[0];
                var conditionCell = createCell('td', 'Temps', 'aom-condition');
                conditionCell.appendChild(textSpan(condition.icon, 'aom-icon'));
                conditionCell.appendChild(textSpan(condition.label));
                row.appendChild(conditionCell);

                var temperatureCell = createCell('td', 'Température', 'aom-temperature ' + temperatureClass(temp));
                temperatureCell.textContent = formatNumber(temp, 0) + (finite(temp) ? ' °C' : '');
                row.appendChild(temperatureCell);

                appendNumber(row, 'Humidité', value(values, 'humidity_pct', 1), 0, ' %');
                appendNumber(row, 'Pluie', rain, 1, ' mm', rainClass(rain));
                appendNumber(row, 'Nuages', value(values, 'cloud_cover_pct', 3), 0, ' %');

                var windCell = createCell('td', 'Vent', 'aom-wind-cell ' + windForceClass(windDisplay));
                var windStrong = document.createElement('strong');
                windStrong.textContent = formatNumber(windDisplay, 0) + (finite(windDisplay) ? ' km/h' : '');
                windCell.appendChild(windStrong);
                var directionDegrees = value(values, 'wind_direction_deg', 5);
                var direction = windDirection(directionDegrees);
                if (direction) {
                    var directionBadge = document.createElement('span');
                    directionBadge.className = 'aom-direction ' + windForceClass(windDisplay);
                    directionBadge.title = 'Vent de ' + direction + ' • ' + formatNumber(directionDegrees, 0) + '°';
                    var arrow = textSpan('➜', 'aom-wind-arrow');
                    arrow.style.transform = 'rotate(' + ((Number(directionDegrees) + 180) % 360) + 'deg)';
                    directionBadge.appendChild(arrow);
                    directionBadge.appendChild(textSpan(direction, 'aom-wind-label'));
                    windCell.appendChild(directionBadge);
                }
                row.appendChild(windCell);

                var gustCell = createCell('td', 'Rafales', gustClass(gustDisplay));
                var gustStrong = document.createElement('strong');
                gustStrong.textContent = formatNumber(gustDisplay, 0) + (finite(gustDisplay) ? ' km/h' : '');
                gustCell.appendChild(gustStrong);
                row.appendChild(gustCell);
                appendNumber(row, 'Pression', value(values, 'pressure_hpa', 7), 0, ' hPa');
                generalBody.appendChild(row);

                // Tableau 2 — diagnostic orageux.
                var stormRow = document.createElement('tr');
                if (dayKey !== previousStormDay) {
                    stormRow.classList.add('aom-new-day');
                    stormRow.appendChild(makeDayCell(date, dayCounts[dayKey]));
                    previousStormDay = dayKey;
                }
                var stormHour = createCell('td', 'Heure', 'aom-hour aom-hour-' + weekdayToken(date));
                stormHour.textContent = hourFormat.format(date);
                stormRow.appendChild(stormHour);

                var thunderCode = value(values, 'thunder_risk_code');
                if (finite(thunderCode)) {
                    maxThunderRisk = maxThunderRisk === null ? Number(thunderCode) : Math.max(maxThunderRisk, Number(thunderCode));
                }
                var thunder = finite(thunderCode) ? THUNDER_RISKS[Number(thunderCode)] : null;
                var thunderCell = createCell('td', 'Risque orage', thunder ? 'aom-thunder-risk aom-thunder-' + Number(thunderCode) : '');
                if (thunder) {
                    thunderCell.appendChild(textSpan(thunder.icon + ' ', 'aom-risk-icon'));
                    thunderCell.appendChild(textSpan(thunder.label, 'aom-risk-label'));
                } else {
                    thunderCell.textContent = '—';
                }
                stormRow.appendChild(thunderCell);

                var cape = value(values, 'cape_jkg');
                var capeCell = createCell('td', 'CAPE', finite(cape) && cape >= 1500 ? 'aom-cape-high' : (finite(cape) && cape >= 500 ? 'aom-cape-mid' : ''));
                capeCell.textContent = finite(cape) && Number(cape) >= 25 ? formatNumber(cape, 0) + ' J/kg' : '—';
                capeCell.title = 'MUCAPE instantanée directement produite par AROME ; les valeurs quasi nulles ne sont pas affichées.';
                stormRow.appendChild(capeCell);
                appendNumber(stormRow, 'LCL', value(values, 'lcl_m'), 0, ' m');

                var lightning = value(values, 'lightning_score');
                appendNumber(stormRow, 'Foudre', lightning, 0, '/100', finite(lightning) && lightning >= 60 ? 'aom-lightning-high' : '');
                appendHazard(stormRow, 'Grêle', value(values, 'hail_risk_code'));
                appendNumber(stormRow, 'Pluie conv.', value(values, 'convective_precipitation_mm'), 1, ' mm');
                appendNumber(stormRow, 'Graupel', value(values, 'graupel_mm'), 2, ' mm');
                appendNumber(stormRow, 'Pluie 1 h', rain, 1, ' mm', rainClass(rain));
                appendNumber(stormRow, 'Rafales', gustDisplay, 0, ' km/h', gustClass(gustDisplay));
                var stormTypeCode = value(values, 'storm_type_code');
                var stormTypeCell = createCell('td', 'Type d’orage', 'aom-storm-type');
                stormTypeCell.textContent = finite(stormTypeCode) ? (STORM_TYPES[Number(stormTypeCode)] || 'Indéterminé') : '—';
                stormRow.appendChild(stormTypeCell);

                var detailsCell = createCell('td', 'Détails', 'aom-details-cell');
                var detailsButton = document.createElement('button');
                detailsButton.type = 'button';
                detailsButton.className = 'aom-details-button';
                detailsButton.textContent = 'Afficher';
                detailsButton.setAttribute('aria-expanded', 'false');
                detailsCell.appendChild(detailsButton);

                var advanced = document.createElement('div');
                advanced.className = 'aom-advanced-list aom-details-inline';
                advanced.hidden = true;
                [
                    ['MUCAPE directe', value(values, 'cape_jkg'), 0, ' J/kg'],
                    ['Réflectivité maximale', value(values, 'reflectivity_dbz'), 0, ' dBZ'],
                    ['LCL estimé', value(values, 'lcl_m'), 0, ' m'],
                    ['Pluie cumulée depuis le run', value(values, 'precipitation_total_mm'), 1, ' mm'],
                    ['Nuages bas', value(values, 'cloud_low_pct'), 0, ' %'],
                    ['Nuages moyens', value(values, 'cloud_mid_pct'), 0, ' %'],
                    ['Nuages élevés', value(values, 'cloud_high_pct'), 0, ' %']
                ].forEach(function (item) {
                    var box = document.createElement('div');
                    box.className = 'aom-advanced-item';
                    box.appendChild(textSpan(item[0], 'aom-advanced-label'));
                    box.appendChild(textSpan(finite(item[1]) ? formatNumber(item[1], item[2]) + item[3] : '—', 'aom-advanced-value'));
                    advanced.appendChild(box);
                });
                detailsCell.appendChild(advanced);
                stormRow.appendChild(detailsCell);
                stormBody.appendChild(stormRow);

                detailsButton.addEventListener('click', function () {
                    var open = advanced.hidden;
                    advanced.hidden = !open;
                    detailsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
                    detailsButton.textContent = open ? 'Masquer' : 'Afficher';
                    window.requestAnimationFrame(updateStormTopScroll);
                });

                // Tableau 3 — risque de neige.
                var snowRow = document.createElement('tr');
                if (dayKey !== previousSnowDay) {
                    snowRow.classList.add('aom-new-day');
                    snowRow.appendChild(makeDayCell(date, dayCounts[dayKey]));
                    previousSnowDay = dayKey;
                }
                var snowHour = createCell('td', 'Heure', 'aom-hour aom-hour-' + weekdayToken(date));
                snowHour.textContent = hourFormat.format(date);
                snowRow.appendChild(snowHour);

                var snowRiskCode = value(values, 'snow_risk_code');
                if (finite(snowRiskCode)) {
                    maxSnowRisk = maxSnowRisk === null ? Number(snowRiskCode) : Math.max(maxSnowRisk, Number(snowRiskCode));
                }
                var snowRisk = finite(snowRiskCode) ? SNOW_RISKS[Number(snowRiskCode)] : null;
                var snowRiskCell = createCell('td', 'Risque neige', snowRisk ? 'aom-snow-risk aom-snow-' + Number(snowRiskCode) : '');
                if (snowRisk) {
                    snowRiskCell.appendChild(textSpan(snowRisk.icon + ' ', 'aom-risk-icon'));
                    snowRiskCell.appendChild(textSpan(snowRisk.label, 'aom-risk-label'));
                } else { snowRiskCell.textContent = '—'; }
                snowRow.appendChild(snowRiskCell);

                var phaseCode = value(values, 'snow_phase_code');
                var phaseCell = createCell('td', 'Phase');
                phaseCell.textContent = finite(phaseCode) ? (SNOW_PHASE[Number(phaseCode)] || '—') : '—';
                snowRow.appendChild(phaseCell);
                appendNumber(snowRow, 'Neige 1 h', value(values, 'snow_fresh_cm'), 1, ' cm');

                function forwardSnowSum(startIndex, windowHours) {
                    var total = 0;
                    var found = false;
                    for (var offset = 0; offset < windowHours && startIndex + offset < forecasts.length; offset += 1) {
                        var future = forecasts[startIndex + offset];
                        var futureValues = future[1] && future[1][pointId];
                        if (!Array.isArray(futureValues)) { continue; }
                        var snowValue = value(futureValues, 'snow_fresh_cm');
                        if (finite(snowValue)) { total += Number(snowValue); found = true; }
                    }
                    return found ? total : null;
                }
                appendNumber(snowRow, 'Neige 3 h', forwardSnowSum(currentIndex, 3), 1, ' cm');
                appendNumber(snowRow, 'Neige 6 h', forwardSnowSum(currentIndex, 6), 1, ' cm');

                var stickCode = value(values, 'snow_stick_risk_code');
                var stickCell = createCell('td', 'Tenue', finite(stickCode) ? 'aom-stick aom-stick-' + Number(stickCode) : '');
                stickCell.textContent = finite(stickCode) ? (SNOW_STICK[Number(stickCode)] || '—') : '—';
                snowRow.appendChild(stickCell);

                appendNumber(snowRow, 'Pression', value(values, 'pressure_hpa', 7), 0, ' hPa');
                appendNumber(snowRow, 'Humidité', value(values, 'humidity_pct', 1), 0, ' %');

                var snowWindCell = createCell('td', 'Vent moyen / rafales', 'aom-snow-wind ' + windForceClass(gustDisplay));
                var snowWindValues = document.createElement('strong');
                snowWindValues.textContent = (finite(windDisplay) ? formatNumber(windDisplay, 0) : '—') + ' / ' + (finite(gustDisplay) ? formatNumber(gustDisplay, 0) : '—') + ' km/h';
                snowWindCell.appendChild(snowWindValues);
                var snowDirectionDegrees = value(values, 'wind_direction_deg', 5);
                var snowDirection = windDirection(snowDirectionDegrees);
                if (snowDirection) {
                    var snowDirectionBadge = document.createElement('span');
                    snowDirectionBadge.className = 'aom-direction ' + windForceClass(gustDisplay);
                    snowDirectionBadge.title = 'Vent de ' + snowDirection + ' • ' + formatNumber(snowDirectionDegrees, 0) + '°';
                    var snowArrow = textSpan('➜', 'aom-wind-arrow');
                    snowArrow.style.transform = 'rotate(' + ((Number(snowDirectionDegrees) + 180) % 360) + 'deg)';
                    snowDirectionBadge.appendChild(snowArrow);
                    snowDirectionBadge.appendChild(textSpan(snowDirection, 'aom-wind-label'));
                    snowWindCell.appendChild(snowDirectionBadge);
                }
                snowRow.appendChild(snowWindCell);
                appendNumber(snowRow, 'Cumul neige fraîche', value(values, 'snow_depth_cm'), 1, ' cm');

                var snowDetailsCell = createCell('td', 'Détails', 'aom-details-cell aom-snow-details-cell');
                var snowDetailsButton = document.createElement('button');
                snowDetailsButton.type = 'button';
                snowDetailsButton.className = 'aom-details-button';
                snowDetailsButton.textContent = 'Afficher';
                snowDetailsButton.setAttribute('aria-expanded', 'false');
                snowDetailsCell.appendChild(snowDetailsButton);

                var snowAdvanced = document.createElement('div');
                snowAdvanced.className = 'aom-snow-profile aom-details-inline';
                snowAdvanced.hidden = true;

                function appendProfileSection(titleText, items) {
                    var section = document.createElement('section');
                    section.className = 'aom-profile-section';
                    section.appendChild(textSpan(titleText, 'aom-profile-title'));
                    var list = document.createElement('div');
                    list.className = 'aom-profile-list';
                    items.forEach(function (item) {
                        var profileItem = document.createElement('div');
                        profileItem.className = 'aom-profile-item';
                        profileItem.appendChild(textSpan(item[0], 'aom-profile-label'));
                        profileItem.appendChild(textSpan(finite(item[1]) ? formatNumber(item[1], item[2]) + item[3] : '—', 'aom-profile-value'));
                        list.appendChild(profileItem);
                    });
                    section.appendChild(list);
                    snowAdvanced.appendChild(section);
                }

                appendProfileSection('Sorties et diagnostics AROME', [
                    ['Température à 2 m', temp, 0, ' °C'],
                    ['Point de rosée', value(values, 'dewpoint_c'), 1, ' °C'],
                    ['Neige cumulée depuis le run', value(values, 'snowfall_total_mm'), 1, ' mm'],
                    ['Précipitations cumulées', value(values, 'precipitation_total_mm'), 1, ' mm'],
                    ['Réflectivité maximale', value(values, 'reflectivity_dbz'), 0, ' dBZ'],
                    ['Pression au sol', value(values, 'pressure_surface_hpa'), 0, ' hPa'],
                    ['Pression mer estimée', value(values, 'pressure_hpa'), 0, ' hPa']
                ]);

                snowDetailsCell.appendChild(snowAdvanced);
                snowRow.appendChild(snowDetailsCell);
                snowBody.appendChild(snowRow);

                snowDetailsButton.addEventListener('click', function () {
                    var open = snowAdvanced.hidden;
                    snowAdvanced.hidden = !open;
                    snowDetailsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
                    snowDetailsButton.textContent = open ? 'Masquer' : 'Afficher';
                    window.requestAnimationFrame(updateSnowTopScroll);
                });
            });

            if (stormSummary) {
                stormSummary.classList.toggle('aom-storm-summary-warning', !hasStormColumns);
                if (!hasStormColumns) {
                    stormSummary.textContent = 'Le run publié utilise encore l’ancien format : relancez le workflow GitHub après avoir remplacé les scripts pour activer le tableau Orages.';
                } else if (maxThunderRisk === null) {
                    stormSummary.textContent = 'Diagnostics orageux présents, mais aucune valeur exploitable sur les échéances affichées.';
                } else {
                    var maxRisk = THUNDER_RISKS[maxThunderRisk] || THUNDER_RISKS[0];
                    stormSummary.textContent = 'Risque orageux maximal sur les ' + forecasts.length + ' prochaines échéances : ' + maxRisk.icon + ' ' + maxRisk.label + ' • MUCAPE et réflectivité AROME 0,01°.';
                }
            }
            if (snowSummary) {
                snowSummary.classList.toggle('aom-snow-summary-warning', !hasSnowColumns);
                if (!hasSnowColumns) {
                    snowSummary.textContent = 'Le run publié utilise encore l’ancien format : relancez le workflow GitHub pour activer le tableau Neige.';
                } else if (maxSnowRisk === null) {
                    snowSummary.textContent = 'Diagnostic neige présent, mais aucune valeur exploitable sur les échéances affichées.';
                } else {
                    var maxSnow = SNOW_RISKS[maxSnowRisk] || SNOW_RISKS[0];
                    snowSummary.textContent = 'Risque de neige maximal sur les ' + forecasts.length + ' prochaines échéances : ' + maxSnow.icon + ' ' + maxSnow.label + ' • cumul neige AROME 0,01°.';
                }
            }

            var cityName = commune[1];
            var point = Array.isArray(departmentData.points) ? departmentData.points[pointId] : null;
            var altitude = point && finite(point[3]) ? Number(point[3]) : null;
            var postal = Array.isArray(commune[2]) && commune[2].length ? commune[2][0] : '';
            title.textContent = titlePrefix + ' — ' + cityName;
            if (altitudeLine) {
                altitudeLine.textContent = finite(altitude)
                    ? 'Altitude de ' + cityName + ' : ≈ ' + formatNumber(altitude, 0) + ' m (point de grille AROME)'
                    : 'Altitude de ' + cityName + ' : — (relancez le workflow GitHub AROME v1.0.0)';
                altitudeLine.classList.toggle('aom-altitude-missing', !finite(altitude));
            }
            selectedMapFocus = {
                latitude: Number(commune[4]),
                longitude: Number(commune[5]),
                scale: 32
            };
            var mapApp = app.querySelector('[data-aomm-app]');
            if (mapApp) {
                window.requestAnimationFrame(function () {
                    mapApp.dispatchEvent(new CustomEvent('aomm:territory-changed', {
                        detail: selectedMapFocus
                    }));
                });
            }
            input.value = cityName;
            app.dataset.cityCode = commune[0];
            app.dataset.cityDepartment = departmentData.department;
            setStatus('Prévisions affichées pour ' + cityName + (postal ? ' (' + postal + ')' : '') + '.', false);

            if (chartTitleTemperature) { chartTitleTemperature.textContent = 'Diagramme températures (°C) pour la ville de ' + cityName; }
            if (chartTitlePressure) { chartTitlePressure.textContent = 'Diagramme pression ramenée au niveau de la mer (hPa) pour la ville de ' + cityName; }
            if (chartTitleRain) { chartTitleRain.textContent = 'Diagramme précipitations (mm) pour la ville de ' + cityName; }
            if (chartTitleWind) { chartTitleWind.textContent = 'Diagramme rafales et vent moyen pour la ville de ' + cityName; }
            if (rainTotal) { rainTotal.textContent = 'Précipitations cumulées : ' + formatNumber(cumulativeRain, 1) + ' mm'; }
            var chartMeta = {
                dayKeys: chartDayKeys,
                dayTokens: chartDayTokens,
                dayLabels: chartDayLabels,
                hourLabels: chartHourLabels
            };
            renderLineChart(chartTemperature, chartLabels, [{ label: 'Température', values: chartTemps, className: 'aom-series-temperature' }], {
                decimals: 0,
                unit: '°C',
                fillArea: false,
                metricMode: 'temperature',
                meta: chartMeta,
                showExtrema: false,
                showPoints: false,
                targetTicks: 6,
                paddingSteps: 1,
                ariaLabel: 'Températures prévues pour ' + cityName
            });
            renderLineChart(chartPressure, chartLabels, [{ label: 'Pression', values: chartPressures, className: 'aom-series-pressure' }], {
                decimals: 0,
                unit: 'hPa',
                fillArea: false,
                metricMode: 'pressure',
                meta: chartMeta,
                showExtrema: false,
                showPoints: false,
                targetTicks: 6,
                paddingSteps: 1,
                ariaLabel: 'Pression au niveau de la mer prévue pour ' + cityName
            });
            renderRainChart(chartRain, chartLabels, chartRainValues, chartRainCumulative, { meta: chartMeta, targetTicks: 6 });
            renderLineChart(chartWind, chartLabels, [
                { label: 'Vent moyen', values: chartWindValues, className: 'aom-series-wind' },
                { label: 'Rafales', values: chartGustValues, className: 'aom-series-gust' }
            ], {
                decimals: 0,
                unit: 'km/h',
                forceZero: true,
                bandBetween: false,
                metricMode: 'wind',
                meta: chartMeta,
                showExtrema: false,
                showPoints: false,
                targetTicks: 6,
                paddingSteps: 1,
                ariaLabel: 'Vent moyen et rafales prévus pour ' + cityName
            });
            window.requestAnimationFrame(updateStormTopScroll);
            window.requestAnimationFrame(updateSnowTopScroll);
        }

        function selectCommune(candidate) {
            closeResults();
            input.value = candidate.nom;
            setStatus('Chargement des prévisions pour ' + candidate.nom + '…', false);
            showTableMessage('Chargement des prévisions…', false);
            loadDepartment(candidate.codeDepartement)
                .then(function (departmentData) {
                    var commune = departmentData.communes.find(function (item) {
                        return item[0] === candidate.code;
                    });
                    if (!commune) {
                        throw new Error('Commune absente du catalogue AROME');
                    }
                    renderForecast(departmentData, commune);
                })
                .catch(function (error) {
                    showTableMessage('Prévisions indisponibles : ' + error.message, true);
                    setStatus(error.message, true);
                });
        }

        function displaySearchResults(candidates) {
            results.replaceChildren();
            resultButtons = [];
            activeResult = -1;
            if (!candidates.length) {
                closeResults();
                setStatus('Aucune commune métropolitaine trouvée.', true);
                return;
            }

            candidates.forEach(function (candidate, position) {
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'aom-search-result';
                button.id = input.id + '-option-' + position;
                button.setAttribute('role', 'option');
                button.setAttribute('aria-selected', 'false');

                var name = textSpan(candidate.nom, 'aom-result-name');
                var postals = Array.isArray(candidate.codesPostaux)
                    ? candidate.codesPostaux.join(', ')
                    : '';
                var details = textSpan(
                    (postals ? postals + ' • ' : '') +
                    'département ' + candidate.codeDepartement,
                    'aom-result-details'
                );
                button.appendChild(name);
                button.appendChild(details);
                button.addEventListener('click', function () {
                    selectCommune(candidate);
                });
                results.appendChild(button);
                resultButtons.push(button);
            });
            results.hidden = false;
            input.setAttribute('aria-expanded', 'true');
            setStatus(candidates.length + ' commune(s) proposée(s).', false);
        }

        function searchCommunes(query) {
            if (!placesData) {
                return;
            }
            setStatus('Recherche des communes…', false);
            var needle = normalizeSearchText(query);
            var candidates = placesData.filter(function (candidate) {
                return normalizeSearchText(candidate.nom).indexOf(needle) !== -1 ||
                    candidate.code.indexOf(query) === 0;
            });
            displaySearchResults(candidates.slice(0, 12));
        }

        function detectCurrentCommune() {
            if (!locateButton) { return; }
            if (!navigator.geolocation) {
                setStatus('La géolocalisation n’est pas disponible dans ce navigateur.', true);
                return;
            }
            if (!placesData || !placesData.length) {
                setStatus('Catalogue des communes indisponible pour l’instant.', true);
                return;
            }
            locateButton.disabled = true;
            locateButton.classList.add('is-loading');
            locateButton.textContent = '📍 Localisation…';
            setStatus('Recherche de votre position…', false);

            navigator.geolocation.getCurrentPosition(function (position) {
                var lat = position.coords.latitude;
                var lon = position.coords.longitude;
                var nearest = null;
                var nearestDistance = Infinity;
                placesData.forEach(function (candidate) {
                    if (!finite(candidate.lat) || !finite(candidate.lon)) { return; }
                    var distance = haversineKm(lat, lon, candidate.lat, candidate.lon);
                    if (distance < nearestDistance) {
                        nearestDistance = distance;
                        nearest = candidate;
                    }
                });
                if (!nearest) {
                    setStatus('Votre position ne correspond à aucune commune couverte.', true);
                } else {
                    selectCommune(nearest);
                    setStatus('Ville détectée : ' + nearest.nom + ' (à ' +
                        formatNumber(nearestDistance, 0) + ' km).', false);
                }
                locateButton.disabled = false;
                locateButton.classList.remove('is-loading');
                locateButton.textContent = '📍 Détecter ma ville';
            }, function (error) {
                var message = 'Localisation refusée ou indisponible.';
                if (error && error.code === 1) { message = 'Autorisation de localisation refusée.'; }
                else if (error && error.code === 2) { message = 'Position actuellement indisponible.'; }
                else if (error && error.code === 3) { message = 'La localisation a pris trop de temps.'; }
                setStatus(message, true);
                locateButton.disabled = false;
                locateButton.classList.remove('is-loading');
                locateButton.textContent = '📍 Détecter ma ville';
            }, {
                enableHighAccuracy: false,
                timeout: 12000,
                maximumAge: 300000
            });
        }

        if (locateButton) {
            locateButton.addEventListener('click', detectCurrentCommune);
        }

        input.addEventListener('input', function () {
            window.clearTimeout(debounceTimer);
            var query = input.value.trim();
            if (query.length < 2) {
                closeResults();
                setStatus('Saisissez au moins deux lettres ou un code postal.', false);
                return;
            }
            if (/^\d+$/.test(query) && query.length < 5) {
                closeResults();
                setStatus('Saisissez les cinq chiffres du code postal.', false);
                return;
            }
            debounceTimer = window.setTimeout(function () {
                searchCommunes(query);
            }, 280);
        });

        input.addEventListener('keydown', function (event) {
            if (results.hidden || !resultButtons.length) {
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveResult(activeResult + 1);
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveResult(activeResult <= 0 ? 0 : activeResult - 1);
            } else if (event.key === 'Enter' && activeResult >= 0) {
                event.preventDefault();
                resultButtons[activeResult].click();
            } else if (event.key === 'Escape') {
                closeResults();
            }
        });

        document.addEventListener('click', function (event) {
            if (!app.contains(event.target)) {
                closeResults();
            }
        });

        function bootstrap() {
            if (!baseUrl) {
                showTableMessage('Adresse des données AROME non configurée.', true);
                return;
            }
            departmentCache.clear();
            placesData = null;
            Promise.all([loadIndex(), loadPlaces()])
                .then(function () {
                    return loadDepartment(defaultDepartment);
                })
                .then(function (departmentData) {
                    var commune = departmentData.communes.find(function (item) {
                        return item[0] === defaultCode;
                    });
                    if (!commune) {
                        throw new Error('Commune initiale absente du catalogue');
                    }
                    renderForecast(departmentData, commune);
                })
                .catch(function (error) {
                    showTableMessage(
                        'Les données du territoire ne sont pas encore disponibles : ' + error.message,
                        true
                    );
                    setStatus('Données du territoire indisponibles.', true);
                });
        }

        function findTerritory(id) {
            for (var i = 0; i < territories.length; i += 1) {
                if (territories[i].id === id) { return territories[i]; }
            }
            return null;
        }

        function applyTerritoryOptions(select) {
            select.replaceChildren();
            territories.forEach(function (territory) {
                var option = document.createElement('option');
                option.value = territory.id;
                option.textContent = territory.label;
                if (territory.id === currentTerritory) { option.selected = true; }
                select.appendChild(option);
            });
        }

        function switchTerritory(territoryId, focusPlace) {
            var territory = findTerritory(territoryId);
            if (!territory) { return; }
            currentTerritory = territory.id;
            baseUrl = (territory.base_url || '').replace(/\/+$/, '');
            app.dataset.baseUrl = baseUrl;
            app.dataset.territory = territory.id;
            defaultDepartment = territory.default_department || defaultDepartment;
            defaultCode = territory.default_code || defaultCode;
            defaultName = territory.default_name || defaultName;
            territorySelects.forEach(function (select) {
                if (select.value !== territory.id) { select.value = territory.id; }
            });
            closeResults();
            input.value = focusPlace ? focusPlace.nom : defaultName;
            bootstrap();
            document.dispatchEvent(new CustomEvent('aomm:territory-changed', {
                detail: { groupRoot: app, territory: territory.id, baseUrl: baseUrl }
            }));
        }

        territorySelects.forEach(function (select) {
            applyTerritoryOptions(select);
            select.addEventListener('change', function () {
                switchTerritory(select.value, null);
            });
        });

        bootstrap();
    }

    whenReady(function () {
        document.querySelectorAll('[data-aom-app]').forEach(initApp);
    });
}());

// Augmented Steam Extension for Efxlve Launcher
// Open-source 3rd-party community extension (GPL-3.0, Copyright (c) IsThereAnyDeal / Augmented Steam contributors)
// Source: https://github.com/IsThereAnyDeal/AugmentedSteam

(function () {
    'use strict';

    if (window.__EFXLVE_AUGMENTED_STEAM_LOADED) return;
    window.__EFXLVE_AUGMENTED_STEAM_LOADED = true;

    var AUGMENTED_STEAM_MESSAGES = {
        en: {
            hltb_title: 'HowLongToBeat',
            hltb_main: 'Main Story',
            hltb_extra: 'Main + Extra',
            hltb_complete: 'Completionist',
            itad_best: 'Current Best',
            itad_lowest: 'Historical Low',
            itad_at: 'at',
            view_on_itad: 'View on IsThereAnyDeal',
            view_on_hltb: 'View on HowLongToBeat',
            opencritic_rating: 'OpenCritic:',
            metauser_rating: 'Metacritic Users:',
            wsgf_rating: 'WSGF UltraWide:',
            drm_badge: '3rd-Party DRM'
        },
        tr: {
            hltb_title: 'HowLongToBeat',
            hltb_main: 'Ana Hikaye',
            hltb_extra: 'Ana + Ekstra',
            hltb_complete: 'Tam Bitirme',
            itad_best: 'En İyi Fiyat',
            itad_lowest: 'En Düşük Fiyat',
            itad_at: 'mağazasında',
            view_on_itad: "IsThereAnyDeal'da görüntüle",
            view_on_hltb: "HowLongToBeat'te görüntüle",
            opencritic_rating: 'OpenCritic:',
            metauser_rating: 'Metacritic Kullanıcı:',
            wsgf_rating: 'WSGF UltraGeniş:',
            drm_badge: '3. Parti DRM'
        }
    };

    function getUILang() {
        var htmlLang = (document.documentElement.lang || 'en').toLowerCase().split('-')[0];
        return AUGMENTED_STEAM_MESSAGES[htmlLang] ? htmlLang : 'en';
    }

    function _as_t(key) {
        var lang = getUILang();
        if (AUGMENTED_STEAM_MESSAGES[lang] && AUGMENTED_STEAM_MESSAGES[lang][key]) {
            return AUGMENTED_STEAM_MESSAGES[lang][key];
        }
        return AUGMENTED_STEAM_MESSAGES.en[key] || key;
    }

    function isAsOptionEnabled(key, defaultValue) {
        if (window.__EFXLVE_STEAM_OPTIONS && window.__EFXLVE_STEAM_OPTIONS.augmentedSteam && typeof window.__EFXLVE_STEAM_OPTIONS.augmentedSteam[key] !== 'undefined') {
            return window.__EFXLVE_STEAM_OPTIONS.augmentedSteam[key] !== false;
        }
        var val = localStorage.getItem('as_opt_' + key);
        if (val === null) return defaultValue !== undefined ? defaultValue : true;
        return val !== 'false';
    }

    function getCurrentAppId() {
        var match = window.location.pathname.match(/\/app\/(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    }

    function formatHltb(minutes) {
        if (!minutes || minutes <= 0) return '—';
        var hrs = Math.round(minutes / 60);
        var lang = getUILang();
        var unit = lang === 'tr' ? ' sa' : (hrs === 1 ? ' hr' : ' hrs');
        return hrs + unit;
    }

    function formatAsPrice(p) {
        if (!p) return '—';
        if (p.amount !== undefined) {
            var curr = p.currency || 'USD';
            var sym = curr === 'USD' ? '$' : (curr === 'EUR' ? '€' : curr + ' ');
            return sym + Number(p.amount).toFixed(2);
        }
        return '—';
    }

    function injectAugmentedSteamStyles() {
        if (document.getElementById('augmentedsteam-extension-styles')) return;
        var style = document.createElement('style');
        style.id = 'augmentedsteam-extension-styles';
        style.textContent = `
            .es_hltb_block {
                background: #1b2838;
                border-radius: 4px;
                margin-bottom: 12px;
                font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
            }
            .es_hltb_block .block_content_inner {
                padding: 8px 10px;
            }
            .es_hltb_header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 6px;
                padding-bottom: 4px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            }
            .es_hltb_title {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                color: #67c1f5;
                text-decoration: none;
            }
            .es_hltb_title:hover {
                color: #ffffff;
            }
            .es_hltb_grid {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 6px;
                text-align: center;
            }
            .es_hltb_col {
                display: flex;
                flex-direction: column;
                gap: 2px;
                background: rgba(0, 0, 0, 0.25);
                padding: 6px 4px;
                border-radius: 3px;
                border: 1px solid rgba(255, 255, 255, 0.04);
            }
            .es_hltb_label {
                font-size: 10px;
                color: #8f98a0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .es_hltb_val {
                font-size: 12px;
                font-weight: 700;
                color: #ffffff;
                font-variant-numeric: tabular-nums;
            }
            .es_itad_prices {
                background: rgba(0, 0, 0, 0.25);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 4px;
                padding: 10px 14px;
                margin-bottom: 12px;
                font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
                font-size: 12px;
            }
            .es_itad_header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 8px;
                padding-bottom: 5px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            }
            .es_itad_logo_link {
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                text-decoration: none;
                display: inline-flex;
                align-items: center;
                gap: 5px;
                color: #f39c12;
            }
            .es_itad_logo_link:hover {
                color: #f1c40f;
            }
            .es_itad_body {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .es_itad_row {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
            }
            .es_itad_badge {
                font-size: 10.5px;
                font-weight: 600;
                padding: 1px 7px;
                border-radius: 3px;
                text-transform: uppercase;
                letter-spacing: 0.3px;
            }
            .es_itad_badge.best {
                background: rgba(76, 175, 80, 0.2);
                color: #81c784;
                border: 1px solid rgba(76, 175, 80, 0.4);
            }
            .es_itad_badge.lowest {
                background: rgba(33, 150, 243, 0.2);
                color: #64b5f6;
                border: 1px solid rgba(33, 150, 243, 0.4);
            }
            .es_shop_link {
                color: #67c1f5;
                text-decoration: none;
            }
            .es_shop_link:hover {
                text-decoration: underline;
            }
            .es_cut {
                color: #a4d007;
                background: rgba(164, 208, 7, 0.15);
                padding: 1px 5px;
                border-radius: 3px;
                font-weight: bold;
                font-size: 11px;
                margin-left: 4px;
            }
            .es_review_row .es_score_badge {
                padding: 2px 6px;
                border-radius: 3px;
                font-weight: bold;
                font-size: 11px;
                display: inline-block;
            }
            .es_score_opencritic {
                background: rgba(97, 189, 109, 0.2);
                color: #61bd6d;
                border: 1px solid rgba(97, 189, 109, 0.4);
            }
            .es_score_metauser {
                background: rgba(102, 204, 51, 0.2);
                color: #66cc33;
                border: 1px solid rgba(102, 204, 51, 0.4);
            }
            .es_drm_alert {
                border-left: 3px solid #f44336 !important;
                background: rgba(244, 67, 54, 0.12) !important;
                padding: 8px 12px !important;
                border-radius: 4px !important;
                margin: 8px 0 !important;
            }
            .es_drm_alert b, .es_drm_alert strong {
                color: #ff5252 !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function requestSteamData(appId) {
        if (!appId || appId <= 0) return;
        if (window.__efxlveSteamCache && window.__efxlveSteamCache[appId]) {
            applyData(window.__efxlveSteamCache[appId]);
            return;
        }
        if (window.__efxlveSteamData && (window.__efxlveSteamData.appId == appId || String(window.__efxlveSteamData.appId) == String(appId))) {
            applyData(window.__efxlveSteamData);
            return;
        }
    }

    function injectHltb(appId, hltb) {
        if (!isAsOptionEnabled('as-hltb', true)) return;
        if (!hltb || (!hltb.story && !hltb.extras && !hltb.complete)) return;
        if (document.querySelector('.es_hltb_block')) return;

        var container = document.querySelector('.game_meta_data, .rightcol.game_meta_data, .glance_ctn_responsive_right, .rightcol');
        if (!container) return;

        var block = document.createElement('div');
        block.className = 'block responsive_apppage_details_left es_hltb_block';
        var inner = document.createElement('div');
        inner.className = 'block_content_inner';

        var header = document.createElement('div');
        header.className = 'es_hltb_header';
        var link = document.createElement('a');
        link.className = 'es_hltb_title';
        link.href = hltb.url || ('https://howlongtobeat.com/?q=' + encodeURIComponent(document.title.replace(/ on Steam$/, '')));
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.innerHTML = '<span>⏳ ' + _as_t('hltb_title') + '</span>';
        header.appendChild(link);

        var grid = document.createElement('div');
        grid.className = 'es_hltb_grid';

        var col1 = document.createElement('div');
        col1.className = 'es_hltb_col';
        col1.innerHTML = '<span class="es_hltb_label">' + _as_t('hltb_main') + '</span><span class="es_hltb_val">' + formatHltb(hltb.story) + '</span>';

        var col2 = document.createElement('div');
        col2.className = 'es_hltb_col';
        col2.innerHTML = '<span class="es_hltb_label">' + _as_t('hltb_extra') + '</span><span class="es_hltb_val">' + formatHltb(hltb.extras) + '</span>';

        var col3 = document.createElement('div');
        col3.className = 'es_hltb_col';
        col3.innerHTML = '<span class="es_hltb_label">' + _as_t('hltb_complete') + '</span><span class="es_hltb_val">' + formatHltb(hltb.complete) + '</span>';

        grid.append(col1, col2, col3);
        inner.append(header, grid);
        block.appendChild(inner);

        var sdbStats = container.querySelector('.steamdb_stats');
        if (sdbStats && sdbStats.nextSibling) {
            container.insertBefore(block, sdbStats.nextSibling);
        } else {
            container.insertBefore(block, container.firstChild);
        }
    }

    function injectOpenCritic(appId, reviews) {
        if (!isAsOptionEnabled('as-opencritic', true)) return;
        if (!reviews || !reviews.opencritic || !reviews.opencritic.score) return;
        if (document.querySelector('.es_review_row.es_opencritic')) return;

        var desktopReviews = document.querySelector('#userReviews, .user_reviews, .glance_ctn_responsive_left');
        if (!desktopReviews) return;

        var row = document.createElement('a');
        row.className = 'user_reviews_summary_row es_review_row es_opencritic';
        row.href = reviews.opencritic.url;
        row.target = '_blank';
        row.rel = 'noopener noreferrer';

        var sub = document.createElement('div');
        sub.className = 'subtitle column';
        sub.textContent = _as_t('opencritic_rating');

        var summary = document.createElement('div');
        summary.className = 'summary column';
        var badge = document.createElement('span');
        badge.className = 'game_review_summary es_score_badge es_score_opencritic';
        badge.textContent = reviews.opencritic.score + '% (' + (reviews.opencritic.verdict || 'Reviewed') + ')';
        summary.appendChild(badge);

        row.append(sub, summary);
        var wrap = document.createElement('div');
        wrap.className = 'user_reviews_summary_bar';
        wrap.appendChild(row);
        desktopReviews.appendChild(wrap);
    }

    function injectMetaUser(appId, reviews) {
        if (!isAsOptionEnabled('as-metauser', true)) return;
        if (!reviews || !reviews.metauser || !reviews.metauser.score) return;
        if (document.querySelector('.es_review_row.es_metauser')) return;

        var desktopReviews = document.querySelector('#userReviews, .user_reviews, .glance_ctn_responsive_left');
        if (!desktopReviews) return;

        var row = document.createElement('a');
        row.className = 'user_reviews_summary_row es_review_row es_metauser';
        row.href = reviews.metauser.url;
        row.target = '_blank';
        row.rel = 'noopener noreferrer';

        var sub = document.createElement('div');
        sub.className = 'subtitle column';
        sub.textContent = _as_t('metauser_rating');

        var summary = document.createElement('div');
        summary.className = 'summary column';
        var badge = document.createElement('span');
        badge.className = 'game_review_summary es_score_badge es_score_metauser';
        var scoreVal = reviews.metauser.score;
        badge.textContent = (scoreVal > 10 ? (scoreVal / 10).toFixed(1) : scoreVal) + ' / 10 (' + (reviews.metauser.verdict || 'User Score') + ')';
        summary.appendChild(badge);

        row.append(sub, summary);
        var wrap = document.createElement('div');
        wrap.className = 'user_reviews_summary_bar';
        wrap.appendChild(row);
        desktopReviews.appendChild(wrap);
    }

    function injectWsgf(appId, wsgf) {
        if (!isAsOptionEnabled('as-wsgf', true)) return;
        if (!wsgf || !wsgf.ultrawide) return;
        if (document.querySelector('.es_wsgf_row')) return;

        var desktopReviews = document.querySelector('#userReviews, .user_reviews, .glance_ctn_responsive_left');
        if (!desktopReviews) return;

        var row = document.createElement('a');
        row.className = 'user_reviews_summary_row es_review_row es_wsgf_row';
        row.href = wsgf.url || 'https://www.wsgf.org/';
        row.target = '_blank';
        row.rel = 'noopener noreferrer';

        var sub = document.createElement('div');
        sub.className = 'subtitle column';
        sub.textContent = _as_t('wsgf_rating');
        var summary = document.createElement('div');
        summary.className = 'summary column';
        var badge = document.createElement('span');
        badge.className = 'game_review_summary es_score_badge';
        badge.textContent = 'Grade ' + wsgf.ultrawide + (wsgf.ultrawide === 'A' ? ' (Supported)' : '');
        summary.appendChild(badge);

        row.append(sub, summary);
        var wrap = document.createElement('div');
        wrap.className = 'user_reviews_summary_bar';
        wrap.appendChild(row);
        desktopReviews.appendChild(wrap);
    }

    function injectItadPrices(appId, pData) {
        if (!isAsOptionEnabled('as-itad-prices', true)) return;
        if (!pData || (!pData.current && !pData.lowest)) return;
        if (document.querySelector('.es_itad_prices')) return;

        var purchaseArea = document.querySelector('#game_area_purchase, .game_area_purchase_margin, .game_area_purchase');
        if (!purchaseArea || !purchaseArea.parentNode) return;

        var current = pData.current;
        var lowest = pData.lowest;
        var urls = pData.urls || {};

        var box = document.createElement('div');
        box.className = 'es_itad_prices';

        var header = document.createElement('div');
        header.className = 'es_itad_header';
        var logoLink = document.createElement('a');
        logoLink.className = 'es_itad_logo_link';
        logoLink.href = urls.info || urls.history || 'https://isthereanydeal.com';
        logoLink.target = '_blank';
        logoLink.rel = 'noopener noreferrer';
        logoLink.innerHTML = '<span>IsThereAnyDeal</span>';
        header.appendChild(logoLink);

        var body = document.createElement('div');
        body.className = 'es_itad_body';

        if (current && current.price) {
            var rowCurrent = document.createElement('div');
            rowCurrent.className = 'es_itad_row';
            var cutHtml = current.cut ? '<span class="es_cut">-' + current.cut + '%</span>' : '';
            var shopName = current.shop ? current.shop.name : 'Store';
            var shopUrl = current.url || urls.info || '#';
            rowCurrent.innerHTML = '<span class="es_itad_badge best">' + _as_t('itad_best') + '</span> <a href="' + shopUrl + '" target="_blank" rel="noopener noreferrer" class="es_shop_link"><b>' + shopName + '</b></a> <span>— <b>' + formatAsPrice(current.price) + '</b></span>' + cutHtml;
            body.appendChild(rowCurrent);
        }

        if (lowest && lowest.price) {
            var rowLowest = document.createElement('div');
            rowLowest.className = 'es_itad_row';
            var lCutHtml = lowest.cut ? '<span class="es_cut">-' + lowest.cut + '%</span>' : '';
            var lShopName = lowest.shop ? lowest.shop.name : 'Store';
            var historyUrl = urls.history || urls.info || '#';
            rowLowest.innerHTML = '<span class="es_itad_badge lowest">' + _as_t('itad_lowest') + '</span> <a href="' + historyUrl + '" target="_blank" rel="noopener noreferrer" class="es_shop_link"><b>' + lShopName + '</b></a> <span>— <b>' + formatAsPrice(lowest.price) + '</b></span>' + lCutHtml;
            body.appendChild(rowLowest);
        }

        box.append(header, body);

        var sdbPrices = document.querySelector('.steamdb_prices');
        if (sdbPrices && sdbPrices.nextSibling) {
            sdbPrices.parentNode.insertBefore(box, sdbPrices.nextSibling);
        } else {
            purchaseArea.parentNode.insertBefore(box, purchaseArea);
        }
    }

    function highlightDrmNotices() {
        if (!isAsOptionEnabled('as-drm-warnings', true)) return;
        var notices = document.querySelectorAll('.drm_notice, .game_area_details_specs');
        for (var i = 0; i < notices.length; i++) {
            var el = notices[i];
            var txt = el.textContent || '';
            if (/denuvo|ea online|ubisoft connect|rockstar games launcher/i.test(txt)) {
                el.classList.add('es_drm_alert');
            }
        }
    }

    function applyData(data) {
        if (!data) return;
        var appId = data.appId;
        if (data.hltb) injectHltb(appId, data.hltb);
        if (data.reviews) {
            injectOpenCritic(appId, data.reviews);
            injectMetaUser(appId, data.reviews);
        }
        if (data.wsgf) injectWsgf(appId, data.wsgf);
        if (data.prices) injectItadPrices(appId, data.prices);
    }

    var origReceive = window.__efxlveReceiveSteamData;
    window.__efxlveReceiveSteamData = function (data) {
        if (typeof origReceive === 'function') origReceive(data);
        if (!window.__efxlveSteamCache) window.__efxlveSteamCache = {};
        if (data && data.appId) {
            window.__efxlveSteamCache[data.appId] = data;
            applyData(data);
        }
    };

    window.efxlveAugmentedSteamApplyData = applyData;

    function run() {
        injectAugmentedSteamStyles();
        highlightDrmNotices();
        var appId = getCurrentAppId();
        if (appId <= 0) return;
        requestSteamData(appId);
    }

    window.efxlveAugmentedSteamRun = run;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }

    var runTimer = null;
    function debouncedRun() {
        if (runTimer) clearTimeout(runTimer);
        runTimer = setTimeout(run, 120);
    }
    var obs = new MutationObserver(debouncedRun);
    // Document-start has no root element yet; observe the document so the
    // observer registration cannot throw and abort the rest of the injection.
    obs.observe(document, { childList: true, subtree: true });
    window.addEventListener('popstate', run);
})();

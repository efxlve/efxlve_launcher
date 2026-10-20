// SteamDB Browser Extension for Efxlve Launcher
// Open-source 3rd-party community extension (BSD-3-Clause, Copyright (c) 2013-present SteamDB)
// Source: https://github.com/SteamDatabase/BrowserExtension

(function () {
    'use strict';

    if (window.__EFXLVE_STEAMDB_LOADED) return;
    window.__EFXLVE_STEAMDB_LOADED = true;

    var STEAMDB_WHITE_SVG = 'data:image/svg+xml;base64,PHN2ZyB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyIgeG1sbnM6c3ZnPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB2ZXJzaW9uPSIxLjEiIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij4KCTxwYXRoIGQ9Ik0gNjMuOSAwIEMgMzAuNSAwIDMuMSAxMS45IDAuMSAyNy4xIGwgMzUuNiA2LjcgYyAyLjkgLTAuOSA2LjIgLTEuMyA5LjYgLTEuMyBsIDE2LjcgLTEwIGMgLTAuMiAtMi41IDEuMyAtNS4xIDQuNyAtNy4yIDQuOCAtMy4xIDEyLjMgLTQuOCAxOS45IC00LjggNS4yIC0wLjEgMTAuNSAwLjcgMTUgMi4yIDExLjIgMy44IDEzLjcgMTEuMSA1LjcgMTYuMyAtNS4xIDMuMyAtMTMuMyA1IC0yMS40IDQuOCBsIC0yMiA3LjkgYyAtMC4yIDEuNiAtMS4zIDMuMSAtMy40IDQuNSAtNS45IDMuOCAtMTcuNCA0LjcgLTI1LjYgMS45IC0zLjYgLTEuMiAtNiAtMyAtNyAtNC44IEwgMi41IDM4LjQgQyA0LjggNDIgOC41IDQ1LjMgMTMuMyA0OC4yIDUgNTMgMCA1OSAwIDY1LjUgMCA3MS45IDQuOCA3Ny44IDEyLjkgODIuNiA0LjggODcuMyAwIDkzLjIgMCA5OS42IDAgMTE1LjMgMjguNiAxMjggNjQgMTI4IDk5LjMgMTI4IDEyOCAxMTUuMyAxMjggOTkuNiAxMjggOTMuMiAxMjMuMiA4Ny4zIDExNS4xIDgyLjYgMTIzLjIgNzcuOCAxMjggNzEuOSAxMjggNjUuNSAxMjggNTkgMTIzIDUyLjkgMTE0LjYgNDguMSAxMjIuOSA0MyAxMjcuOSAzNi43IDEyNy45IDI5LjkgMTI3LjkgMTMuNCA5OS4yIDAgNjMuOSAwIFogbSAyMi44IDE0LjIgYyAtNS4yIDAuMSAtMTAuMiAxLjIgLTEzLjQgMy4zIC01LjUgMy42IC0zLjggOC41IDMuOCAxMS4xIDcuNiAyLjYgMTguMSAxLjggMjMuNiAtMS44IDUuNSAtMy42IDMuOCAtOC41IC0zLjggLTExIC0zLjEgLTEgLTYuNyAtMS41IC0xMC4yIC0xLjUgeiBtIDAuMyAxLjcgYyA3LjQgMCAxMy4zIDIuOCAxMy4zIDYuMiAwIDMuNCAtNS45IDYuMiAtMTMuMyA2LjIgLTcuNCAwIC0xMy4zIC0yLjggLTEzLjMgLTYuMiAtMCAtMy40IDUuOSAtNi4yIDEzLjMgLTYuMiB6IG0gLTQxLjcgMTguNSAwIDAgYyAtMS42IDAuMSAtMy4xIDAuMiAtNC42IDAuNCBsIDkuMSAxLjcgYSAxMC44IDUgMCAxIDEgLTguMSA5LjMgbCAtOC45IC0xLjcgYyAxIDAuOSAyLjQgMS43IDQuMyAyLjQgNi40IDIuMiAxNS40IDEuNSAyMCAtMS41IDQuNiAtMyAzLjIgLTcuMiAtMy4yIC05LjMgLTIuNiAtMC45IC01LjcgLTEuMyAtOC42IC0xLjMgeiBtIDYzLjcgMTYuNiAwIDkuMyBjIDAgMTEgLTIwLjIgMTkuOSAtNDUgMTkuOSAtMjQuOSAwIC00NSAtOC45IC00NSAtMTkuOSBsIDAgLTkuMiBjIDExLjUgNS4zIDI3LjQgOC42IDQ0LjkgOC42IDE3LjYgMCAzMy42IC0zLjMgNDUuMiAtOC43IHogbSAwIDM0LjYgMCA4LjggYyAwIDExIC0yMC4yIDE5LjkgLTQ1IDE5LjkgLTI0LjkgMCAtNDUgLTguOSAtNDUgLTE5LjkgbCAwIC04LjggYyAxMS42IDUuMSAyNy40IDguMiA0NSA4LjIgMTcuNiAwIDMzLjUgLTMuMSA0NSAtOC4yIHoiIHN0eWxlPSJmaWxsOiNGRkY7Ii8+Cjwvc3ZnPgo=';
    var PCGW_SVG = 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB2ZXJzaW9uPSIxLjEiIGlkPSJMYXllcl8xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB4PSIwcHgiIHk9IjBweCIgd2lkdGg9IjE2cHgiIGhlaWdodD0iMTZweCIgdmlld0JveD0iMCAwIDE2IDE2IiBlbmFibGUtYmFja2dyb3VuZD0ibmV3IDAgMCAxNiAxNiIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSI+Cjxwb2x5Z29uIG9wYWNpdHk9IjAuNzUiIGZpbGw9IiNGRkZGRkYiIGVuYWJsZS1iYWNrZ3JvdW5kPSJuZXcgICAgIiBwb2ludHM9IjcuNSwxNS4xMzQgMS41LDEzLjIzIDEuNSwyLjY4MiA3LjUsMC42MzQgIi8+CjxwYXRoIG9wYWNpdHk9IjAuNSIgZmlsbD0iI0ZGRkZGRiIgZW5hYmxlLWJhY2tncm91bmQ9Im5ldyAgICAiIGQ9Ik0xMi44ODEsMS4zMDVMOC4zNDQsMC42MzR2MTQuNWw0LjU4NC0wLjU5NkwxMi44ODEsMS4zMDV6ICAgTTEwLjM0NCwxMy43ODdsLTEsMC4xMTVWOC41aDFWMTMuNzg3eiBNMTIuMzQ0LDYuOTQ3bC0xLjAyMS0wLjA3NWMtMC4xNTEsMC4yMjItMC40MjksMC4zNzctMC43MiwwLjM3NyAgYy0wLjM0MiwwLTAuNDM4LTAuMjAzLTAuNTc0LTAuNDkyTDkuMzQ0LDYuNjg4VjUuODVsMC43NDcsMC4wNzVjMC4xNTEtMC4yMjIsMC4yOTItMC4zNzcsMC41ODMtMC4zNzcgIGMwLjM0MiwwLDAuNjQ0LDAuMjAzLDAuNzc5LDAuNDkybDAuODkxLDAuMDY5VjYuOTQ3eiBNMTIuMzQ0LDQuMjgxbC0zLTAuMjZWMy4xODRsMywwLjI2VjQuMjgxeiIvPgo8L3N2Zz4=';
    var STEAMDB_MESSAGES = {
        en: {
            view_on_steamdb: "View on SteamDB",
            view_on_pcgamingwiki: "View on PCGamingWiki",
            app_steamdb_rating_tooltip: "$positive$ of the $total$ reviews are positive (all purchase types)",
            app_steamdb_rating: "SteamDB Rating:",
            app_lowest_price: "SteamDB lowest recorded price is <b>$price$</b>",
            app_lowest_date: "Price seen on $date$ ($relative$)",
            app_lowest_price_discount: "SteamDB lowest recorded price is <b>$price$</b> at <b>-$discount$%</b>",
            app_stats_online_now: "Online now:",
            app_stats_peak_today: "24-hour peak:",
            app_stats_alL_time_peak: "All-time peak:",
            app_stats_followers: "Followers:",
            app_stats_online: "Online Stats",
            app_depots_update: "Last Update:"
        },
        tr: {
            view_on_steamdb: "SteamDB'de görüntüle",
            view_on_pcgamingwiki: "PCGamingWiki'de görüntüle",
            app_steamdb_rating_tooltip: "$total$ incelemenin $positive$ adedi olumludur (tüm satın alma türleri dâhil)",
            app_steamdb_rating: "SteamDB Puanı:",
            app_lowest_price: "SteamDB verilerine göre en düşük fiyatı <b>$price$</b>",
            app_lowest_date: "$date$ ($relative$) tarihinde görülen fiyat",
            app_lowest_price_discount: "SteamDB verilerine göre en düşük fiyatı <b>-$discount$%</b> indirimle <b>$price$</b>",
            app_stats_online_now: "Şimdi çevrim içi:",
            app_stats_peak_today: "Son 24 saat:",
            app_stats_alL_time_peak: "En fazla:",
            app_stats_followers: "Takipçi:",
            app_stats_online: "Çevrim İçi İstatistik",
            app_depots_update: "Son Güncelleme:"
        }
    };

    function getUILang() {
        var htmlLang = (document.documentElement.lang || 'en').toLowerCase().split('-')[0];
        return STEAMDB_MESSAGES[htmlLang] ? htmlLang : 'en';
    }

    function _t(key, args) {
        var lang = getUILang();
        var str = (STEAMDB_MESSAGES[lang] && STEAMDB_MESSAGES[lang][key]) || STEAMDB_MESSAGES.en[key] || key;
        if (args && args.length > 0) {
            for (var i = 0; i < args.length; i++) {
                str = str.replace(new RegExp('\\$' + (i + 1) + '\\$|\\$[a-z_]+\\$', 'i'), args[i]);
            }
        }
        return str;
    }

    function formatNumber(num) {
        if (!num || isNaN(num)) return '0';
        return Number(num).toLocaleString(getUILang());
    }

    function formatRelativeDate(timestampInSeconds) {
        var diff = Math.floor(Date.now() / 1000) - timestampInSeconds;
        var rtf = new Intl.RelativeTimeFormat(getUILang(), { numeric: 'auto' });
        if (diff < 86400) return [Math.floor(diff / 3600), rtf.format(-Math.max(1, Math.floor(diff / 3600)), 'hour')];
        if (diff < 86400 * 30) return [Math.floor(diff / 86400), rtf.format(-Math.floor(diff / 86400), 'day')];
        if (diff < 86400 * 365) return [Math.floor(diff / (86400 * 30)), rtf.format(-Math.floor(diff / (86400 * 30)), 'month')];
        return [Math.floor(diff / (86400 * 365)), rtf.format(-Math.floor(diff / (86400 * 365)), 'year')];
    }

    function getCurrentAppId() {
        var match = window.location.pathname.match(/\/app\/(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    }

    function isOptionEnabled(key, defaultValue) {
        if (window.__EFXLVE_STEAM_OPTIONS && window.__EFXLVE_STEAM_OPTIONS.steamdb && typeof window.__EFXLVE_STEAM_OPTIONS.steamdb[key] !== 'undefined') {
            return window.__EFXLVE_STEAM_OPTIONS.steamdb[key] !== false;
        }
        var val = localStorage.getItem('steamdb_opt_' + key);
        if (val === null) return defaultValue !== undefined ? defaultValue : true;
        return val !== 'false';
    }

    function injectSteamDbStyles() {
        if (document.getElementById('steamdb-extension-styles')) return;
        var style = document.createElement('style');
        style.id = 'steamdb-extension-styles';
        style.textContent = `
            .btn_steamdb {
                border-radius: 2px;
                display: inline-block;
                line-height: 24px;
                padding: 0 8px;
                color: #67c1f5 !important;
                background: rgba(103, 193, 245, 0.2);
                margin-right: 2px;
                text-decoration: none !important;
                font-size: 11px;
                font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
            }
            .btn_steamdb:hover {
                color: #fff !important;
                background: rgba(103, 193, 245, 0.4);
            }
            .steamdb_prices {
                display: flex;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 4px;
                padding: 10px 14px;
                margin-bottom: 12px;
                text-decoration: none !important;
                border: 1px solid rgba(255, 255, 255, 0.08);
                transition: background 0.15s ease;
            }
            .steamdb_prices:hover {
                background: rgba(0, 0, 0, 0.35);
            }
            .steamdb_prices_top {
                font-size: 13px;
                color: #c6d4df;
            }
            .steamdb_prices_top b {
                color: #a4d007;
            }
            .steamdb_prices_bottom {
                font-size: 11px;
                color: #8f98a0;
                margin-top: 3px;
            }
            .steamdb_stats {
                background: #1b2838;
                border-radius: 4px;
                margin-bottom: 12px;
                font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
            }
            .steamdb_stats .block_content_inner {
                padding: 8px 10px;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .steamdb_stats_grid {
                display: grid;
                grid-template-columns: auto auto;
                column-gap: 12px;
                row-gap: 3px;
                font-size: 11px;
            }
            .steamdb_stats_name {
                color: #8f98a0;
            }
            .steamdb_stats_number {
                color: #67c1f5;
                font-weight: bold;
                text-align: right;
                font-variant-numeric: tabular-nums;
            }
            .steamdb_rating {
                font-weight: bold;
            }
            .steamdb_rating_good { color: #a4d007 !important; }
            .steamdb_rating_average { color: #e5c324 !important; }
            .steamdb_rating_poor { color: #c0392b !important; }
            .steamdb_rating_white { color: #c6d4df !important; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    var requestedAppIds = {};
    function requestSteamData(appId) {
        if (!appId || appId <= 0) return;
        if (window.__efxlveSteamCache && window.__efxlveSteamCache[appId]) {
            applyData(window.__efxlveSteamCache[appId]);
            return;
        }
        if (requestedAppIds[appId]) return;
        requestedAppIds[appId] = true;
        try {
            location.assign('https://efxlve.local/steam-data?appid=' + encodeURIComponent(appId));
        } catch (_) {}
    }

    function injectHeaderButtons(appId) {
        if (!isOptionEnabled('button-app', true) && !isOptionEnabled('button-pcgw', true)) return;
        var container = document.querySelector('.apphub_OtherSiteInfo');
        if (!container) {
            var headerTop = document.querySelector('.apphub_HeaderStandardTop');
            if (headerTop) {
                container = document.createElement('div');
                container.className = 'apphub_OtherSiteInfo';
                headerTop.prepend(container);
            } else {
                var titleArea = document.querySelector('.game_title_area, #appHubAppName');
                if (titleArea) {
                    container = document.createElement('div');
                    container.className = 'apphub_OtherSiteInfo';
                    container.style.cssText = 'display:inline-flex;gap:6px;margin-top:6px;';
                    titleArea.appendChild(container);
                }
            }
        }
        if (!container) return;

        if (isOptionEnabled('button-app', true) && !container.querySelector('.btn_steamdb_site')) {
            var btnDb = document.createElement('a');
            btnDb.className = 'btn_steamdb btn_steamdb_site';
            btnDb.href = 'https://steamdb.info/app/' + appId + '/';
            btnDb.target = '_blank';
            btnDb.rel = 'noopener noreferrer';
            var span = document.createElement('span');
            span.textContent = 'SteamDB';
            var img = document.createElement('img');
            img.src = STEAMDB_WHITE_SVG;
            img.style.cssText = 'vertical-align:middle;margin-right:4px;width:14px;height:14px;';
            span.prepend(img);
            btnDb.appendChild(span);
            container.insertBefore(btnDb, container.firstChild);
        }

        if (isOptionEnabled('button-pcgw', true) && !container.querySelector('.btn_pcgw_site')) {
            var btnPcgw = document.createElement('a');
            btnPcgw.className = 'btn_steamdb btn_pcgw_site';
            btnPcgw.href = 'https://pcgamingwiki.com/api/appid.php?appid=' + appId;
            btnPcgw.target = '_blank';
            btnPcgw.rel = 'noopener noreferrer';
            var spanPcgw = document.createElement('span');
            spanPcgw.textContent = 'PCGW';
            var imgPcgw = document.createElement('img');
            imgPcgw.src = PCGW_SVG;
            imgPcgw.style.cssText = 'vertical-align:middle;margin-right:4px;width:14px;height:14px;';
            spanPcgw.prepend(imgPcgw);
            btnPcgw.appendChild(spanPcgw);
            container.insertBefore(btnPcgw, container.children[1] || null);
        }
    }

    function injectOnlineStatsWidget(appId) {
        if (!isOptionEnabled('online-stats', true)) return;
        var container = document.querySelector('.game_meta_data, .rightcol.game_meta_data, .glance_ctn_responsive_right, .rightcol');
        if (!container || container.querySelector('.steamdb_stats')) return;

        var blockInner = document.createElement('div');
        blockInner.className = 'block_content_inner';
        var block = document.createElement('div');
        block.className = 'block responsive_apppage_details_left steamdb_stats';
        block.appendChild(blockInner);

        var link = document.createElement('a');
        link.className = 'steamdb_stats_logo';
        link.dataset.tooltipText = _t('view_on_steamdb');
        link.href = 'https://steamdb.info/app/' + appId + '/charts/';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        var img = document.createElement('img');
        img.src = STEAMDB_WHITE_SVG;
        img.style.cssText = 'width:54px;height:54px;';
        link.appendChild(img);

        var grid = document.createElement('div');
        grid.className = 'steamdb_stats_grid';
        grid.dir = 'ltr';
        blockInner.append(grid, link);

        var onlineNow = document.createElement('span');
        onlineNow.className = 'steamdb_stats_number steamdb_stat_online';
        onlineNow.textContent = '...';
        var l1 = document.createElement('span');
        l1.className = 'steamdb_stats_name';
        l1.textContent = _t('app_stats_online_now');
        grid.append(l1, onlineNow);

        var peakToday = document.createElement('span');
        peakToday.className = 'steamdb_stats_number steamdb_stat_peak_today';
        peakToday.textContent = '...';
        var l2 = document.createElement('span');
        l2.className = 'steamdb_stats_name';
        l2.textContent = _t('app_stats_peak_today');
        grid.append(l2, peakToday);

        var peakAll = document.createElement('span');
        peakAll.className = 'steamdb_stats_number steamdb_stat_peak_all';
        peakAll.textContent = '...';
        var l3 = document.createElement('span');
        l3.className = 'steamdb_stats_name';
        l3.textContent = _t('app_stats_alL_time_peak');
        grid.append(l3, peakAll);

        var followers = document.createElement('span');
        followers.className = 'steamdb_stats_number steamdb_stat_followers';
        followers.textContent = '...';
        var l4 = document.createElement('span');
        l4.className = 'steamdb_stats_name';
        l4.textContent = _t('app_stats_followers');
        grid.append(l4, followers);

        container.insertBefore(block, container.firstChild);
        var responsiveHeader = document.createElement('div');
        responsiveHeader.className = 'responsive_block_header responsive_apppage_details_left steamdb_stats_header';
        responsiveHeader.textContent = _t('app_stats_online');
        container.insertBefore(responsiveHeader, block);

        requestSteamData(appId);
    }

    function injectLowestPrice(appId) {
        if (!isOptionEnabled('steamdb-lowest-price', true)) return;
        var container = document.getElementById('game_area_purchase') || document.querySelector('.game_area_purchase');
        if (!container || container.querySelector('.steamdb_prices')) return;

        var el = document.createElement('a');
        el.className = 'steamdb_prices';
        el.href = 'https://steamdb.info/app/' + appId + '/';
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
        el.dir = 'ltr';

        var img = document.createElement('img');
        img.src = STEAMDB_WHITE_SVG;
        img.style.cssText = 'width:32px;height:32px;align-self:center;opacity:0.6;margin-right:10px;';
        el.appendChild(img);

        var top = document.createElement('div');
        top.className = 'steamdb_prices_top';
        top.innerHTML = _t('app_lowest_price', ['...']);

        var bottom = document.createElement('div');
        bottom.className = 'steamdb_prices_bottom';
        bottom.textContent = '...';

        var textCol = document.createElement('div');
        textCol.appendChild(top);
        textCol.appendChild(bottom);
        el.appendChild(textCol);

        container.insertAdjacentElement('afterbegin', el);
        requestSteamData(appId);
    }

    function injectSteamDbRating(appId) {
        if (!isOptionEnabled('steamdb-rating', true)) return;
        var desktopReviews = document.querySelector('#userReviews, .user_reviews');
        if (!desktopReviews || desktopReviews.querySelector('.steamdb_rating')) return;

        var positive = 0;
        var total = 0;
        var reviewSummary = document.querySelector('[data-featuretarget="appreviews"]');
        if (reviewSummary) {
            var raw = reviewSummary.getAttribute('data-tooltip-html') || '';
            var m = raw.match(/([\d,\.]+)\s*%\s*.*?\s*([\d,\.]+)/);
            if (m) {
                var pct = parseFloat(m[1].replace(/,/g, ''));
                total = parseInt(m[2].replace(/[,\.]/g, ''), 10);
                positive = Math.round(total * (pct / 100));
            }
        }
        if (total <= 0) {
            var summaryRow = document.querySelector('.user_reviews_summary_row[data-tooltip-html], .user_reviews_summary_row');
            if (summaryRow) {
                var tooltip = summaryRow.getAttribute('data-tooltip-html') || summaryRow.textContent || '';
                var pctMatch = tooltip.match(/(\d+)%/);
                var countMatch = tooltip.match(/([\d,\.]+)\s*(?:user reviews|kullanıcı)/i) || tooltip.match(/\(([\d,\.]+)\)/);
                if (pctMatch) {
                    var pP = parseInt(pctMatch[1], 10);
                    var cC = countMatch ? parseInt(countMatch[1].replace(/[,\.]/g, ''), 10) : 1000;
                    positive = Math.round(cC * (pP / 100));
                    total = cC;
                }
            }
        }
        if (total <= 0) return;

        var average = positive / total;
        var score = average - (average - 0.5) * Math.pow(2, -Math.log10(total + 1));
        var ratingClass = 'poor';
        if (total < 500) ratingClass = 'white';
        else if (score > 0.74) ratingClass = 'good';
        else if (score > 0.49) ratingClass = 'average';

        var row = document.createElement('a');
        row.className = 'user_reviews_summary_row';
        row.href = 'https://steamdb.info/app/' + appId + '/charts/#reviews';
        row.target = '_blank';
        row.rel = 'noopener noreferrer';
        row.dataset.tooltipText = _t('app_steamdb_rating_tooltip', [formatNumber(positive), formatNumber(total)]);

        var sub = document.createElement('div');
        sub.className = 'subtitle column';
        sub.textContent = _t('app_steamdb_rating');
        row.append(sub);

        var sum = document.createElement('div');
        sum.className = 'summary column';
        row.append(sum);

        var link = document.createElement('span');
        link.className = 'steamdb_rating steamdb_rating_' + ratingClass;
        link.textContent = (score * 100).toFixed(2) + '% ';
        sum.append(link);

        var count = document.createElement('span');
        count.className = 'responsive_hidden';
        count.textContent = ' (' + formatNumber(total) + ')';
        sum.append(count);

        var wrap = document.createElement('div');
        wrap.append(row);
        desktopReviews.append(wrap);
    }

    function injectLastDepotsUpdate(appId) {
        if (!isOptionEnabled('steamdb-last-update', true)) return;
        if (document.querySelector('.steamdb_last_update')) return;

        var releaseDate = document.querySelector('.release_date');
        var glanceLeft = document.querySelector('.glance_ctn_responsive_left .dev_row');
        if (!releaseDate && !glanceLeft) return;

        var depotsUpdate = document.createElement('div');
        depotsUpdate.className = 'dev_row steamdb_last_update';
        var subtitle = document.createElement('div');
        subtitle.className = 'subtitle column';
        subtitle.textContent = _t('app_depots_update');
        var historyLink = document.createElement('a');
        historyLink.className = 'date';
        historyLink.textContent = 'SteamDB Patchnotes';
        historyLink.href = 'https://steamdb.info/app/' + appId + '/patchnotes/';
        historyLink.target = '_blank';
        historyLink.rel = 'noopener noreferrer';
        depotsUpdate.appendChild(subtitle);
        depotsUpdate.appendChild(historyLink);

        if (releaseDate && releaseDate.parentNode) {
            releaseDate.parentNode.insertBefore(depotsUpdate, releaseDate.nextSibling);
        } else if (glanceLeft && glanceLeft.parentNode) {
            glanceLeft.parentNode.insertBefore(depotsUpdate, glanceLeft);
        }
    }

    function injectDevPubLinks() {
        if (!isOptionEnabled('steamdb-dev-pub-links', true)) return;
        var devRows = document.querySelectorAll('.dev_row .summary a');
        for (var i = 0; i < devRows.length; i++) {
            var a = devRows[i];
            if (a.getAttribute('data-steamdb-linked') === '1') continue;
            a.setAttribute('data-steamdb-linked', '1');
            var name = a.textContent.trim();
            if (!name) continue;
            var dbLink = document.createElement('a');
            dbLink.className = 'steamdb_dev_link';
            dbLink.href = 'https://steamdb.info/developer/' + encodeURIComponent(name) + '/';
            dbLink.target = '_blank';
            dbLink.rel = 'noopener noreferrer';
            dbLink.title = 'SteamDB: ' + name;
            dbLink.style.cssText = 'margin-left:5px;display:inline-block;vertical-align:middle;opacity:0.6;';
            var iconImg = document.createElement('img');
            iconImg.src = STEAMDB_WHITE_SVG;
            iconImg.style.cssText = 'width:12px;height:12px;display:inline-block;vertical-align:baseline;';
            dbLink.appendChild(iconImg);
            a.parentNode.insertBefore(dbLink, a.nextSibling);
        }
    }

    function applyData(data) {
        if (!data) return;
        if (data.players) {
            var onEl = document.querySelector('.steamdb_stat_online');
            if (onEl && data.players.current) onEl.textContent = formatNumber(data.players.current);
            var tdEl = document.querySelector('.steamdb_stat_peak_today');
            if (tdEl && data.players.peak_today) tdEl.textContent = formatNumber(data.players.peak_today);
            var pkEl = document.querySelector('.steamdb_stat_peak_all');
            if (pkEl && data.players.peak_all) pkEl.textContent = formatNumber(data.players.peak_all);
            var flEl = document.querySelector('.steamdb_stat_followers');
            if (flEl && data.players.followers) flEl.textContent = formatNumber(data.players.followers);
        }

        if (data.prices) {
            var el = document.querySelector('.steamdb_prices');
            if (el) {
                var pData = data.prices.lowest || data.prices.current;
                if (pData && pData.price) {
                    var top = el.querySelector('.steamdb_prices_top');
                    var bottom = el.querySelector('.steamdb_prices_bottom');
                    var pStr = '$' + Number(pData.price.amount || 0).toFixed(2);
                    var shopName = pData.shop ? pData.shop.name : 'Store';
                    var cut = pData.cut || 0;
                    if (top) {
                        if (cut > 0) {
                            top.innerHTML = _t('app_lowest_price_discount', [pStr, cut.toString()]) + ' <span style="opacity:0.85;font-size:0.9em;">(' + shopName + ')</span>';
                        } else {
                            top.innerHTML = _t('app_lowest_price', [pStr]) + ' <span style="opacity:0.85;font-size:0.9em;">(' + shopName + ')</span>';
                        }
                    }
                    if (bottom) {
                        if (pData.timestamp) {
                            try {
                                var d = new Date(pData.timestamp);
                                var df = new Intl.DateTimeFormat(getUILang(), { dateStyle: 'medium' });
                                var rel = formatRelativeDate(Math.floor(d.getTime() / 1000));
                                bottom.textContent = _t('app_lowest_date', [df.format(d), rel[1]]);
                            } catch (_) {
                                bottom.textContent = shopName;
                            }
                        } else {
                            bottom.textContent = shopName;
                        }
                    }
                }
            }
        }
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

    function run() {
        injectSteamDbStyles();
        var appId = getCurrentAppId();
        if (appId <= 0) return;
        injectHeaderButtons(appId);
        injectLowestPrice(appId);
        injectOnlineStatsWidget(appId);
        injectSteamDbRating(appId);
        injectLastDepotsUpdate(appId);
        injectDevPubLinks();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }

    var obs = new MutationObserver(function () {
        run();
    });
    obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();

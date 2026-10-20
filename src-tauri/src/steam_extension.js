// Efxlve Steam Store Extension
// Provides Turkish Lira (TRY) currency conversion and SteamDB/community statistics.

(function () {
    'use strict';

    var cachedPlayerCount = null;

    window.efxlveSetPlayerCount = function (count) {
        cachedPlayerCount = count;
        var countEl = document.getElementById('efxlve-steam-player-count');
        if (!countEl) return;
        var num = typeof count === 'number' ? count : parseInt(count, 10);
        if (!isNaN(num)) {
            var isTr = (document.documentElement.lang || '').toLowerCase().indexOf('tr') !== -1 || (navigator.language || '').toLowerCase().indexOf('tr') !== -1;
            countEl.textContent = num.toLocaleString(isTr ? 'tr-TR' : 'en-US');
        } else {
            countEl.textContent = String(count || '0');
        }
    };

    function parseUsd(text) {
        if (!text) return null;
        var m = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/) || text.match(/([\d,]+(?:\.\d{2})?)\s*USD/i);
        if (!m) return null;
        var rawNum = m[1].replace(/,/g, '');
        var val = parseFloat(rawNum);
        return (!isNaN(val) && val > 0) ? val : null;
    }

    function createBadge(tryFormatted, rate) {
        var badge = document.createElement('span');
        badge.className = 'efxlve-steam-try-badge';
        badge.textContent = ' (~₺' + tryFormatted + ')';
        badge.title = '1 USD ≈ ' + rate + ' ₺ (TCMB / Serbest Piyasa Kuru)';
        badge.style.cssText = 'color:#66c0f4 !important;font-size:0.86em !important;font-weight:600 !important;margin-left:4px !important;font-variant-numeric:tabular-nums !important;display:inline-block !important;pointer-events:none !important;letter-spacing:normal !important;line-height:normal !important;vertical-align:baseline !important;';
        return badge;
    }

    function convertPrices() {
        if (window.__EFXLVE_STEAM_CURRENCY === false) {
            var existing = document.querySelectorAll('.efxlve-steam-try-badge');
            for (var e = 0; e < existing.length; e++) existing[e].remove();
            var converted = document.querySelectorAll('[data-efxlve-converted]');
            for (var c = 0; c < converted.length; c++) converted[c].removeAttribute('data-efxlve-converted');
            return;
        }

        var rate = Number(window.__EFXLVE_STEAM_RATE) || 34.5;
        if (rate <= 0) return;

        var selectors = [
            '.game_purchase_price',
            '.discount_original_price',
            '.discount_final_price',
            '.discount_prices > div',
            '.search_price',
            '.match_subtitle',
            '[class*="StoreOriginalPrice"]',
            '[class*="StoreSalePriceBox"]',
            '[class*="DiscountFinalPrice"]',
            '[class*="DiscountOriginalPrice"]',
            '[class*="PriceDisplay"]',
            '[class*="salepreviewwidgets_StoreOriginalPrice"]',
            '[class*="salepreviewwidgets_StoreSalePriceBox"]',
            '.game_area_dlc_price',
            'strike'
        ];

        var elements = document.querySelectorAll(selectors.join(','));
        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            if (el.getAttribute('data-efxlve-converted') === '1') continue;
            if (el.classList.contains('efxlve-steam-try-badge')) continue;

            if (el.classList.contains('search_price')) {
                var strike = el.querySelector('strike');
                if (strike && strike.getAttribute('data-efxlve-converted') !== '1') {
                    var strikeUsd = parseUsd(strike.textContent);
                    if (strikeUsd) {
                        var tryStr = Math.round(strikeUsd * rate).toLocaleString('tr-TR');
                        strike.appendChild(createBadge(tryStr, rate));
                        strike.setAttribute('data-efxlve-converted', '1');
                    }
                }
                if (!el.querySelector('.efxlve-steam-try-badge:not(strike .efxlve-steam-try-badge)')) {
                    for (var j = 0; j < el.childNodes.length; j++) {
                        var node = el.childNodes[j];
                        if (node.nodeType === 3) {
                            var usdVal = parseUsd(node.textContent);
                            if (usdVal) {
                                var tryFinal = Math.round(usdVal * rate).toLocaleString('tr-TR');
                                var b = createBadge(tryFinal, rate);
                                if (node.nextSibling) {
                                    el.insertBefore(b, node.nextSibling);
                                } else {
                                    el.appendChild(b);
                                }
                                break;
                            }
                        }
                    }
                }
                el.setAttribute('data-efxlve-converted', '1');
                continue;
            }

            if (el.querySelector('.discount_original_price, .discount_final_price, [class*="StoreOriginalPrice"], [class*="DiscountFinalPrice"], [class*="StoreSalePriceBox"]')) {
                continue;
            }

            if (el.querySelector('.efxlve-steam-try-badge')) {
                el.setAttribute('data-efxlve-converted', '1');
                continue;
            }

            var usd = parseUsd(el.textContent);
            if (!usd) continue;

            var formatted = Math.round(usd * rate).toLocaleString('tr-TR');
            el.appendChild(createBadge(formatted, rate));
            el.setAttribute('data-efxlve-converted', '1');
        }
    }

    function getSteamAppId() {
        var m = window.location.pathname.match(/\/app\/(\d+)/i) || window.location.href.match(/\/app\/(\d+)/i);
        if (m) return m[1];
        var og = document.querySelector('meta[property="og:url"]');
        if (og) {
            var m2 = (og.getAttribute('content') || '').match(/\/app\/(\d+)/i);
            if (m2) return m2[1];
        }
        var appTag = document.querySelector('[data-appid]');
        if (appTag) {
            var id = appTag.getAttribute('data-appid');
            if (id && /^\d+$/.test(id)) return id;
        }
        return null;
    }

    function findSteamDbInsertionPoint() {
        // Priority 1: Above the purchase block (standard wide area visible on all games)
        var purchase = document.getElementById('game_area_purchase') || document.querySelector('.game_area_purchase');
        if (purchase && purchase.parentNode) {
            return { parent: purchase.parentNode, before: purchase };
        }

        // Priority 2: Below the media highlights carousel
        var highlights = document.getElementById('game_highlights');
        if (highlights && highlights.parentNode) {
            return { parent: highlights.parentNode, before: highlights.nextSibling };
        }

        // Priority 3: Inside metadata column
        var meta = document.querySelector('.rightcol.game_meta_data');
        if (meta) {
            return { parent: meta, before: meta.firstChild };
        }

        // Priority 4: Main page content
        var page = document.querySelector('.page_content');
        if (page) {
            return { parent: page, before: page.firstChild };
        }

        return null;
    }

    function injectSteamDbCard() {
        if (window.__EFXLVE_STEAMDB === false) {
            var existingCard = document.getElementById('efxlve-steamdb-card');
            if (existingCard) existingCard.remove();
            return;
        }

        var appId = getSteamAppId();
        if (!appId) return;

        var existing = document.getElementById('efxlve-steamdb-card');
        if (existing) {
            if (existing.getAttribute('data-appid') === appId && existing.parentNode) {
                return;
            }
            existing.remove();
        }

        var target = findSteamDbInsertionPoint();
        if (!target || !target.parent) return;

        var isTr = (document.documentElement.lang || '').toLowerCase().indexOf('tr') !== -1 || (navigator.language || '').toLowerCase().indexOf('tr') !== -1;
        var titleText = isTr ? 'SteamDB & Topluluk İstatistikleri' : 'SteamDB & Community Statistics';
        var playersLabel = isTr ? 'oyuncu şu an oyunda' : 'players in-game';
        var loadingText = isTr ? 'Yükleniyor...' : 'Loading...';

        var card = document.createElement('div');
        card.id = 'efxlve-steamdb-card';
        card.setAttribute('data-appid', appId);
        card.style.cssText = [
            'background: linear-gradient(135deg, rgba(22, 34, 52, 0.96), rgba(15, 22, 34, 0.98)) !important;',
            'border: 1px solid rgba(102, 192, 244, 0.35) !important;',
            'border-radius: 8px !important;',
            'padding: 12px 16px !important;',
            'margin: 16px 0 18px 0 !important;',
            'box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5) !important;',
            'font-family: "Motiva Sans", "Segoe UI", sans-serif !important;',
            'color: #c6d4df !important;',
            'box-sizing: border-box !important;',
            'display: block !important;',
            'clear: both !important;',
            'position: relative !important;',
            'z-index: 10 !important;'
        ].join('');

        var html = [
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.08);">',
            '  <div style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#66c0f4;letter-spacing:0.3px;">',
            '    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#66c0f4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">',
            '      <circle cx="12" cy="12" r="10"></circle>',
            '      <line x1="2" y1="12" x2="22" y2="12"></line>',
            '      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',
            '    </svg>',
            '    <span>' + titleText + '</span>',
            '  </div>',
            '  <span style="font-family:monospace;font-size:11px;background:rgba(255,255,255,0.09);padding:2px 8px;border-radius:4px;color:#8f98a0;font-variant-numeric:tabular-nums;">AppID: ' + appId + '</span>',
            '</div>',
            '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">',
            '  <div style="display:flex;align-items:center;gap:10px;">',
            '    <span style="display:inline-block;width:9px;height:9px;background:#a4d007;border-radius:50%;box-shadow:0 0 8px #a4d007;"></span>',
            '    <div>',
            '      <span id="efxlve-steam-player-count" style="font-size:17px;font-weight:700;color:#ffffff;font-variant-numeric:tabular-nums;line-height:1.1;">' + loadingText + '</span>',
            '      <span style="color:#8f98a0;font-size:12px;margin-left:6px;">' + playersLabel + '</span>',
            '    </div>',
            '  </div>',
            '  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">',
            '    <a href="https://steamdb.info/app/' + appId + '/" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:5px;background:rgba(102,192,244,0.14);border:1px solid rgba(102,192,244,0.3);border-radius:5px;padding:6px 12px;color:#66c0f4;text-decoration:none;font-size:12px;font-weight:600;transition:all 0.15s ease;">',
            '      <span>SteamDB</span>',
            '      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
            '    </a>',
            '    <a href="https://protondb.com/app/' + appId + '" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:5px;background:rgba(102,192,244,0.14);border:1px solid rgba(102,192,244,0.3);border-radius:5px;padding:6px 12px;color:#66c0f4;text-decoration:none;font-size:12px;font-weight:600;transition:all 0.15s ease;">',
            '      <span>ProtonDB</span>',
            '      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
            '    </a>',
            '    <a href="https://www.pcgamingwiki.com/api/appid.php?appid=' + appId + '" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:5px;background:rgba(102,192,244,0.14);border:1px solid rgba(102,192,244,0.3);border-radius:5px;padding:6px 12px;color:#66c0f4;text-decoration:none;font-size:12px;font-weight:600;transition:all 0.15s ease;">',
            '      <span>PCGW</span>',
            '      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
            '    </a>',
            '  </div>',
            '</div>'
        ].join('\n');

        card.innerHTML = html;

        if (target.before) {
            target.parent.insertBefore(card, target.before);
        } else {
            target.parent.appendChild(card);
        }

        // If we already have the count from Rust on_page_load
        if (cachedPlayerCount !== null) {
            window.efxlveSetPlayerCount(cachedPlayerCount);
        }

        // Also attempt direct fetch as fallback
        fetch('https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=' + appId)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.response && typeof data.response.player_count === 'number') {
                    window.efxlveSetPlayerCount(data.response.player_count);
                }
            })
            .catch(function () {
                // If direct fetch is blocked by CORS, Rust on_page_load will provide the value
            });
    }

    var scanTimeout = null;
    function scan() {
        if (scanTimeout) clearTimeout(scanTimeout);
        scanTimeout = setTimeout(function () {
            try {
                convertPrices();
            } catch (e) {
                console.error('[Efxlve Steam Currency error]', e);
            }
            try {
                injectSteamDbCard();
            } catch (e2) {
                console.error('[Efxlve SteamDB error]', e2);
            }
        }, 100);
    }

    window.efxlveSteamScan = scan;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scan);
    } else {
        scan();
    }

    // Hook history pushState / replaceState to catch client-side URL changes
    try {
        var origPush = history.pushState;
        history.pushState = function () {
            origPush.apply(this, arguments);
            scan();
        };
        var origReplace = history.replaceState;
        history.replaceState = function () {
            origReplace.apply(this, arguments);
            scan();
        };
        window.addEventListener('popstate', scan);
    } catch (_) {}

    var observer = new MutationObserver(function (mutations) {
        var needsScan = false;
        for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.addedNodes && m.addedNodes.length > 0) {
                for (var j = 0; j < m.addedNodes.length; j++) {
                    var n = m.addedNodes[j];
                    if (n.nodeType === 1 && !n.classList.contains('efxlve-steam-try-badge') && n.id !== 'efxlve-steamdb-card') {
                        needsScan = true;
                        break;
                    }
                }
            }
            if (needsScan) break;
        }
        if (needsScan) scan();
    });

    observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
    });
})();

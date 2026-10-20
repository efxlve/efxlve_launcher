// Efxlve Steam Store Extension
// Provides Turkish Lira (TRY) currency conversion and SteamDB/community statistics.

(function () {
    'use strict';

    if (window.__EFXLVE_STEAM_EXT_LOADED) {
        if (typeof window.efxlveSteamScan === 'function') {
            window.efxlveSteamScan();
        }
        return;
    }
    window.__EFXLVE_STEAM_EXT_LOADED = true;

    function parseUsd(text) {
        if (!text) return null;
        // Matches "$19.99", "$ 19.99", "$1,299.00", "19.99 USD", "$19.99 USD"
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

            // Handle search rows with strike and final price
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
                        if (node.nodeType === 3 /* TEXT_NODE */) {
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

            // Skip container elements that have price children
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

    function injectSteamDbCard() {
        if (window.__EFXLVE_STEAMDB === false) {
            var existingCard = document.getElementById('efxlve-steamdb-card');
            if (existingCard) existingCard.remove();
            return;
        }

        var m = window.location.pathname.match(/\/app\/(\d+)/);
        if (!m) return;
        var appId = m[1];

        var existing = document.getElementById('efxlve-steamdb-card');
        if (existing) {
            if (existing.getAttribute('data-appid') === appId) return;
            existing.remove();
        }

        var glanceCtn = document.querySelector('.glance_ctn');
        var rightCol = document.querySelector('#game_highlights .rightcol');
        var purchaseArea = document.getElementById('game_area_purchase');

        var container = null;
        var insertBeforeNode = null;

        if (glanceCtn) {
            container = glanceCtn;
            insertBeforeNode = null;
        } else if (rightCol) {
            container = rightCol;
            insertBeforeNode = rightCol.firstChild;
        } else if (purchaseArea && purchaseArea.parentNode) {
            container = purchaseArea.parentNode;
            insertBeforeNode = purchaseArea;
        }

        if (!container) return;

        var isTr = (document.documentElement.lang || '').toLowerCase().indexOf('tr') !== -1 || (navigator.language || '').toLowerCase().indexOf('tr') !== -1;
        var titleText = isTr ? 'SteamDB & Topluluk' : 'SteamDB & Community';
        var playersLabel = isTr ? 'oyuncu şu an oyunda' : 'players in-game';
        var loadingText = isTr ? 'Yükleniyor...' : 'Loading...';

        var card = document.createElement('div');
        card.id = 'efxlve-steamdb-card';
        card.setAttribute('data-appid', appId);
        card.style.cssText = [
            'background: linear-gradient(135deg, rgba(22, 32, 48, 0.95), rgba(15, 22, 34, 0.98)) !important;',
            'border: 1px solid rgba(102, 192, 244, 0.28) !important;',
            'border-radius: 6px !important;',
            'padding: 10px 12px !important;',
            'margin: 12px 0 8px 0 !important;',
            'box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45) !important;',
            'font-family: "Motiva Sans", "Segoe UI", sans-serif !important;',
            'color: #c6d4df !important;',
            'box-sizing: border-box !important;',
            'display: block !important;',
            'clear: both !important;'
        ].join('');

        var html = [
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.08);">',
            '  <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#66c0f4;letter-spacing:0.3px;">',
            '    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#66c0f4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
            '      <circle cx="12" cy="12" r="10"></circle>',
            '      <line x1="2" y1="12" x2="22" y2="12"></line>',
            '      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',
            '    </svg>',
            '    <span>' + titleText + '</span>',
            '  </div>',
            '  <span style="font-family:monospace;font-size:11px;background:rgba(255,255,255,0.08);padding:1px 6px;border-radius:3px;color:#8f98a0;font-variant-numeric:tabular-nums;">AppID: ' + appId + '</span>',
            '</div>',
            '<div style="display:flex;align-items:center;margin-bottom:10px;font-size:12px;">',
            '  <span style="display:inline-block;width:7px;height:7px;background:#a4d007;border-radius:50%;margin-right:7px;box-shadow:0 0 6px #a4d007;"></span>',
            '  <span id="efxlve-steam-player-count" style="font-weight:700;color:#a4d007;margin-right:5px;font-variant-numeric:tabular-nums;">' + loadingText + '</span>',
            '  <span style="color:#8f98a0;">' + playersLabel + '</span>',
            '</div>',
            '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">',
            '  <a href="https://steamdb.info/app/' + appId + '/" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:center;gap:4px;background:rgba(102,192,244,0.12);border:1px solid rgba(102,192,244,0.25);border-radius:4px;padding:5px 4px;color:#66c0f4;text-decoration:none;font-size:11px;font-weight:600;">',
            '    <span>SteamDB</span>',
            '    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
            '  </a>',
            '  <a href="https://protondb.com/app/' + appId + '" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:center;gap:4px;background:rgba(102,192,244,0.12);border:1px solid rgba(102,192,244,0.25);border-radius:4px;padding:5px 4px;color:#66c0f4;text-decoration:none;font-size:11px;font-weight:600;">',
            '    <span>ProtonDB</span>',
            '    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
            '  </a>',
            '  <a href="https://www.pcgamingwiki.com/api/appid.php?appid=' + appId + '" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:center;gap:4px;background:rgba(102,192,244,0.12);border:1px solid rgba(102,192,244,0.25);border-radius:4px;padding:5px 4px;color:#66c0f4;text-decoration:none;font-size:11px;font-weight:600;">',
            '    <span>PCGW</span>',
            '    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
            '  </a>',
            '</div>'
        ].join('\n');

        card.innerHTML = html;

        if (insertBeforeNode) {
            container.insertBefore(card, insertBeforeNode);
        } else {
            container.appendChild(card);
        }

        fetch('https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=' + appId)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var countEl = document.getElementById('efxlve-steam-player-count');
                if (!countEl) return;
                if (data && data.response && typeof data.response.player_count === 'number') {
                    countEl.textContent = data.response.player_count.toLocaleString(isTr ? 'tr-TR' : 'en-US');
                } else {
                    countEl.textContent = '0';
                }
            })
            .catch(function () {
                var countEl = document.getElementById('efxlve-steam-player-count');
                if (countEl) countEl.textContent = '—';
            });
    }

    var scanTimeout = null;
    function scan() {
        if (scanTimeout) clearTimeout(scanTimeout);
        scanTimeout = setTimeout(function () {
            convertPrices();
            injectSteamDbCard();
        }, 120);
    }

    window.efxlveSteamScan = scan;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scan);
    } else {
        scan();
    }

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

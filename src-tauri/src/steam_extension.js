// Efxlve Steam Store Native Features
// Turkish Lira (TRY) Currency Converter

(function () {
    'use strict';

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

    var scanTimeout = null;
    function scan() {
        if (scanTimeout) clearTimeout(scanTimeout);
        scanTimeout = setTimeout(function () {
            try {
                convertPrices();
            } catch (_) {}
        }, 120);
    }

    window.efxlveSteamScan = scan;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scan);
    } else {
        scan();
    }

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

    var observer = new MutationObserver(function () {
        scan();
    });

    // At document-start `document.documentElement` and `document.body` are both
    // null. Observing the document itself is valid and still catches the root
    // element being inserted, so the script never throws before the store
    // extension scripts that follow it get to run.
    observer.observe(document, {
        childList: true,
        subtree: true
    });
})();

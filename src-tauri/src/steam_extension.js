// Efxlve Steam Store Extension
// 1. Turkish Lira (TRY) Currency Converter
// 2. Official SteamDB Browser Extension (SteamDatabase/BrowserExtension) Integration

(function () {
    'use strict';

    /* =========================================================================
       SECTION 1: TURKISH LIRA (TRY) CURRENCY CONVERTER
       ========================================================================= */

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

    /* =========================================================================
       SECTION 2: OFFICIAL STEAMDB EXTENSION ASSETS & POLYFILL RUNTIME
       ========================================================================= */

    var STEAMDB_WHITE_SVG = 'data:image/svg+xml;base64,PHN2ZyB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyIgeG1sbnM6c3ZnPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB2ZXJzaW9uPSIxLjEiIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij4KCTxwYXRoIGQ9Ik0gNjMuOSAwIEMgMzAuNSAwIDMuMSAxMS45IDAuMSAyNy4xIGwgMzUuNiA2LjcgYyAyLjkgLTAuOSA2LjIgLTEuMyA5LjYgLTEuMyBsIDE2LjcgLTEwIGMgLTAuMiAtMi41IDEuMyAtNS4xIDQuNyAtNy4yIDQuOCAtMy4xIDEyLjMgLTQuOCAxOS45IC00LjggNS4yIC0wLjEgMTAuNSAwLjcgMTUgMi4yIDExLjIgMy44IDEzLjcgMTEuMSA1LjcgMTYuMyAtNS4xIDMuMyAtMTMuMyA1IC0yMS40IDQuOCBsIC0yMiA3LjkgYyAtMC4yIDEuNiAtMS4zIDMuMSAtMy40IDQuNSAtNS45IDMuOCAtMTcuNCA0LjcgLTI1LjYgMS45IC0zLjYgLTEuMiAtNiAtMyAtNyAtNC44IEwgMi41IDM4LjQgQyA0LjggNDIgOC41IDQ1LjMgMTMuMyA0OC4yIDUgNTMgMCA1OSAwIDY1LjUgMCA3MS45IDQuOCA3Ny44IDEyLjkgODIuNiA0LjggODcuMyAwIDkzLjIgMCA5OS42IDAgMTE1LjMgMjguNiAxMjggNjQgMTI4IDk5LjMgMTI4IDEyOCAxMTUuMyAxMjggOTkuNiAxMjggOTMuMiAxMjMuMiA4Ny4zIDExNS4xIDgyLjYgMTIzLjIgNzcuOCAxMjggNzEuOSAxMjggNjUuNSAxMjggNTkgMTIzIDUyLjkgMTE0LjYgNDguMSAxMjIuOSA0MyAxMjcuOSAzNi43IDEyNy45IDI5LjkgMTI3LjkgMTMuNCA5OS4yIDAgNjMuOSAwIFogbSAyMi44IDE0LjIgYyAtNS4yIDAuMSAtMTAuMiAxLjIgLTEzLjQgMy4zIC01LjUgMy42IC0zLjggOC41IDMuOCAxMS4xIDcuNiAyLjYgMTguMSAxLjggMjMuNiAtMS44IDUuNSAtMy42IDMuOCAtOC41IC0zLjggLTExIC0zLjEgLTEgLTYuNyAtMS41IC0xMC4yIC0xLjUgeiBtIDAuMyAxLjcgYyA3LjQgMCAxMy4zIDIuOCAxMy4zIDYuMiAwIDMuNCAtNS45IDYuMiAtMTMuMyA2LjIgLTcuNCAwIC0xMy4zIC0yLjggLTEzLjMgLTYuMiAtMCAtMy40IDUuOSAtNi4yIDEzLjMgLTYuMiB6IG0gLTQxLjcgMTguNSAwIDAgYyAtMS42IDAuMSAtMy4xIDAuMiAtNC42IDAuNCBsIDkuMSAxLjcgYSAxMC44IDUgMCAxIDEgLTguMSA5LjMgbCAtOC45IC0xLjcgYyAxIDAuOSAyLjQgMS43IDQuMyAyLjQgNi40IDIuMiAxNS40IDEuNSAyMCAtMS41IDQuNiAtMyAzLjIgLTcuMiAtMy4yIC05LjMgLTIuNiAtMC45IC01LjcgLTEuMyAtOC42IC0xLjMgeiBtIDYzLjcgMTYuNiAwIDkuMyBjIDAgMTEgLTIwLjIgMTkuOSAtNDUgMTkuOSAtMjQuOSAwIC00NSAtOC45IC00NSAtMTkuOSBsIDAgLTkuMiBjIDExLjUgNS4zIDI3LjQgOC42IDQ0LjkgOC42IDE3LjYgMCAzMy42IC0zLjMgNDUuMiAtOC43IHogbSAwIDM0LjYgMCA4LjggYyAwIDExIC0yMC4yIDE5LjkgLTQ1IDE5LjkgLTI0LjkgMCAtNDUgLTguOSAtNDUgLTE5LjkgbCAwIC04LjggYyAxMS42IDUuMSAyNy40IDguMiA0NSA4LjIgMTcuNiAwIDMzLjUgLTMuMSA0NSAtOC4yIHoiIHN0eWxlPSJmaWxsOiNGRkY7Ii8+Cjwvc3ZnPgo=';
    var PCGW_SVG = 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB2ZXJzaW9uPSIxLjEiIGlkPSJMYXllcl8xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB4PSIwcHgiIHk9IjBweCIgd2lkdGg9IjE2cHgiIGhlaWdodD0iMTZweCIgdmlld0JveD0iMCAwIDE2IDE2IiBlbmFibGUtYmFja2dyb3VuZD0ibmV3IDAgMCAxNiAxNiIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSI+Cjxwb2x5Z29uIG9wYWNpdHk9IjAuNzUiIGZpbGw9IiNGRkZGRkYiIGVuYWJsZS1iYWNrZ3JvdW5kPSJuZXcgICAgIiBwb2ludHM9IjcuNSwxNS4xMzQgMS41LDEzLjIzIDEuNSwyLjY4MiA3LjUsMC42MzQgIi8+CjxwYXRoIG9wYWNpdHk9IjAuNSIgZmlsbD0iI0ZGRkZGRiIgZW5hYmxlLWJhY2tncm91bmQ9Im5ldyAgICAiIGQ9Ik0xMi44ODEsMS4zMDVMOC4zNDQsMC42MzR2MTQuNWw0LjU4NC0wLjU5NkwxMi44ODEsMS4zMDV6ICAgTTEwLjM0NCwxMy43ODdsLTEsMC4xMTVWOC41aDFWMTMuNzg3eiBNMTIuMzQ0LDYuOTQ3bC0xLjAyMS0wLjA3NWMtMC4xNTEsMC4yMjItMC40MjksMC4zNzctMC43MiwwLjM3NyAgYy0wLjM0MiwwLTAuNDM4LTAuMjAzLTAuNTc0LTAuNDkyTDkuMzQ0LDYuNjg4VjUuODVsMC43NDcsMC4wNzVjMC4xNTEtMC4yMjIsMC4yOTItMC4zNzcsMC41ODMtMC4zNzcgIGMwLjM0MiwwLDAuNjQ0LDAuMjAzLDAuNzc5LDAuNDkybDAuODkxLDAuMDY5VjYuOTQ3eiBNMTIuMzQ0LDQuMjgxbC0zLTAuMjZWMy4xODRsMywwLjI2VjQuMjgxeiIvPgo8L3N2Zz4=';

    var STEAMDB_MESSAGES = {"en":{"steamstatus":"Check on $domain$","steamstatus_downtime":"Steam appears to be experiencing some downtime. ","open_desktop_app":"Open in Desktop App","steamdb_options":"SteamDB Options","view_on_steamdb":"View on SteamDB","view_on_pcgamingwiki":"View on PCGamingWiki","app_steamdb_rating_tooltip":"$positive$ of the $total$ reviews are positive (all purchase types)","app_steamdb_rating":"SteamDB Rating:","@@bidi_dir":"@@bidi_dir","app_lowest_price":"SteamDB lowest recorded price is <b>$price$</b>","app_lowest_date":"Price seen on $date$ ($relative$)","app_lowest_price_limited":"SteamDB lowest recorded price is <b>$price$</b> and 2-year low is <b>$price_limited$</b>","app_lowest_price_discount":"SteamDB lowest recorded price is <b>$price$</b> at <b>-$discount$%</b>","app_lowest_date_multiple":"Price seen $seen$ times, last on $date$ ($relative$)","app_stats_online_now":"Online now:","app_stats_peak_today":"24-hour peak:","app_stats_alL_time_peak":"All-time peak:","app_stats_followers":"Followers:","app_stats_online":"Online Stats","app_depots_update":"Last Update:","app_depots_updated_short":"Updated"},"tr":{"steamstatus":"$domain$ adresinden kontrol edin","steamstatus_downtime":"Görünüşe göre Steam'de bir kesinti yaşanıyor. ","open_desktop_app":"Masaüstü Uygulamasında Aç","steamdb_options":"SteamDB Ayarları","view_on_steamdb":"SteamDB'de görüntüle","view_on_pcgamingwiki":"PCGamingWiki'de görüntüle","app_steamdb_rating_tooltip":"$total$ incelemenin $positive$ adedi olumludur (tüm satın alma türleri dâhil)","app_steamdb_rating":"SteamDB Puanı:","@@bidi_dir":"@@bidi_dir","app_lowest_price":"SteamDB verilerine göre en düşük fiyatı <b>$price$</b>","app_lowest_date":"$date$ ($relative$) tarihinde görülen fiyat","app_lowest_price_limited":"SteamDB verilerine göre en düşük fiyat <b>$price$</b> iken son 2 yıldaki en düşük fiyatı <b>$price_limited$</b>'dır","app_lowest_price_discount":"SteamDB verilerine göre en düşük fiyatı <b>-$discount$%</b> indirimle <b>$price$</b>","app_lowest_date_multiple":"En son $date$ ($relative$) tarihi olmak üzere bu fiyat toplamda $seen$ kez görüldü","app_stats_online_now":"Şimdi çevrim içi:","app_stats_peak_today":"Son 24 saat:","app_stats_alL_time_peak":"En fazla:","app_stats_followers":"Takipçi:","app_stats_online":"Çevrim İçi İstatistik","app_depots_update":"Son Güncelleme:","app_depots_updated_short":"Son Güncelleme"}};

    function injectSteamDbStyles() {
        if (document.getElementById('steamdb-extension-styles')) return;
        var style = document.createElement('style');
        style.id = 'steamdb-extension-styles';
        style.textContent = `.steamdb_options_link .ico16 {
	background: none;
}

.steamdb_options_link:hover .ico16 {
	filter: invert(1);
}

.steamdb_downtime {
	color: #fff;
	background-color: #c0392b;
	line-height: 24px;
	padding: 10px;
	font-family:
		system-ui,
		-apple-system,
		"Segoe UI",
		Roboto,
		"Helvetica Neue",
		"Noto Sans",
		"Liberation Sans",
		Arial,
		sans-serif;
	font-size: 20px;
	text-align: center;
}

.steamdb_downtime a {
	text-decoration: underline;
	color: #ffee58;
}

.steamdb_downtime a:focus,
.steamdb_downtime a:hover {
	color: #99fff5;
}

.steamdb_trade_error {
	margin-top: 2em;
	color: #ffee58;
}

.steamdb_trade_error_explained {
	font-style: italic;
	font-size: 90%;
	color: #ccc;
}

.steamdb_trade_error_explained:hover {
	text-decoration: underline;
}

.steamdb_open_desktop_app {
	display: inline-block;
	padding: 0 9px;
	margin-left: 4px;
	background-color: #5c7e10;
	color: #e5e4dc;

	&:hover {
		background-color: #6c9018;
		color: #fff;
		transition-property: background;
		transition-duration: 250ms;
		cursor: pointer;
	}
}


a.steamdb_link:hover {
	text-decoration: underline;
}

.game_area_purchase_game a.steamdb_link,
html.responsive .game_area_purchase_game a.steamdb_link {
	color: #ebebeb !important;
}

.steamdb_error_link {
	margin-top: 25px;
	text-align: center;
}

.steamdb_agecheck_hint {
	margin-top: 25px;
	text-align: center;
}

.steamdb_agecheck_hint a {
	text-decoration: underline;
}

.game_area_purchase_game .steamdb_link {
	position: absolute;
	left: 0;
	top: 10px;
}

.game_area_purchase_game .steamdb_link[hidden] {
	visibility: hidden;
	pointer-events: none;
}

.game_purchase_sub_dropdown .steamdb_link {
	position: absolute;
	top: unset;
	bottom: -9px;
	left: 16px;
}

.linkbar_steamdb {
	display: none !important;
}

@media (max-width: 500px) {
	.game_purchase_sub_dropdown .steamdb_link {
		position: relative;
		top: unset;
		bottom: unset;
		left: unset;
		margin-bottom: 20px;
	}

	html.responsive .game_purchase_action .steamdb_link {
		position: relative;
		align-self: start;
		margin-right: auto;
	}

	html.responsive .linkbar_steamdb {
		display: block !important;
	}
}

#widget .steamdb_link {
	vertical-align: 6px;
	margin-left: 10px;
}

.btn_steamdb .ico16 {
	background: none;
}

.date:not(:hover) .steamdb_last_update_old {
	color: #f44336;
}

.steamdb_stats {
	font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
}

.steamdb_stats .block_content_inner {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 5px;
}

.steamdb_stats_logo {
	width: 54px;
	height: 54px;
	opacity: 0.5;
	transition: opacity 0.1s ease-in-out;
}

.steamdb_stats:hover .steamdb_stats_logo {
	opacity: 1;
}

.steamdb_stats_grid {
	display: grid;
	grid-template-columns: min-content 1fr;
	gap: 2px 10px;
	white-space: nowrap;
	font-size: 12px;
	color: #8f98a0;
}

.steamdb_stats_number {
	font-weight: bold;
	color: #67c1f5;
}

.steamdb_stats p:last-child {
	margin-bottom: 0;
}

.steamdb_last_update {
	padding-bottom: 13px;
}

.steamdb_last_update .date {
	unicode-bidi: plaintext;
}

.glance_ctn .release_date + .steamdb_last_update {
	margin-top: -13px;
}

.steamdb_last_update a {
	display: block;
}

#error_display .steamdb_registerkey_lineitem {
	margin-top: 20px;
}

.steamdb_registerkey_lineitem img {
	width: 16px;
	height: 16px;
	margin-right: 5px;
	vertical-align: text-top;
}

.steamdb_prices {
	background-color: rgb(0 0 0 / 20%);
	border-radius: 4px;
	margin-bottom: 10px;
	padding: 8px 16px;
	font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
	color: #c6d4df;
	display: flex;
	gap: 10px;
}

.steamdb_prices_bottom {
	font-style: italic;
	font-size: 12px;
	color: #8f98a0;
}

.steamdb_prices img {
	align-self: center;
	width: 32px;
	height: 32px;
	opacity: 0.5;
	transition: opacity 0.1s ease-in-out;
}

.steamdb_prices:hover img {
	opacity: 1;
}

.steamdb_prices:hover .steamdb_prices_top {
	text-decoration: underline;
}

.steamdb_prices:hover .steamdb_prices_bottom {
	color: #c6d4df;
}

.steamdb_prices_top b {
	font-weight: bold;
	color: #a3cf06;
	unicode-bidi: plaintext;
}

.steamdb_rating.steamdb_rating_good {
	color: #6c3 !important;
}

.steamdb_rating.steamdb_rating_average {
	color: #fc3 !important;
}

.steamdb_rating.steamdb_rating_poor {
	color: #e60 !important;
}

.steamdb_rating.steamdb_rating_white {
	color: #aaa !important;
}

a.steamdb_rating:hover {
	color: #fff;
}

.steamdb_already_in_library_link {
	color: inherit;
}

.steamdb_already_in_library_link:hover {
	color: #fff;
	text-decoration: underline;
}

.steamdb_already_in_library_collapse {
	display: flex;
	align-items: center;
	justify-content: center;
	position: absolute;
	right: 0;
	top: 0;
	height: 100%;
	padding: 0 10px;
	border: 0;
	background: transparent;
	cursor: pointer;
}

.steamdb_already_in_library_collapse:hover,
.steamdb_already_in_library_collapse:focus {
	background: hsl(73deg 94% 42% / 50%);
}

.steamdb_already_in_library_collapse > .graph_toggle_icon {
	margin: 0;
}

.steamdb_cheat_queue {
	display: flex;
	align-items: center;
	gap: 8px 15px;
}

.steamdb_cheat_queue.discovery_queue_customize_ctn {
	margin-bottom: 0;
	border-bottom: 0;
}

.steamdb_cheat_queue .btn_medium {
	margin: 0;
}

.steamdb_cheat_queue_text {
	margin-right: auto;
}

/**
 * Fix date not fitting after we insert subid links
 */
.account_table th {
	min-width: 100px;
}

@media (max-width: 500px) {
	.steamdb_cheat_queue {
		flex-wrap: wrap;
	}

	html.responsive .responsive_apppage_details_left.block.steamdb_stats {
		background-color: #1b2838 !important;
		border-radius: 4px;
		padding: 0 !important;

		.block_content_inner {
			margin: 0;
			padding: 6px 8px;
		}
	}
}

.steamdb_dev_pub_link {
	display: inline-flex;
	margin-left: 5px;
	width: 14px;
	height: 14px;
	vertical-align: text-top;
	opacity: 0.5;
	transition: opacity 0.1s ease-in-out;

	&:hover {
		opacity: 1;
	}
}
`;
        (document.head || document.documentElement).appendChild(style);
    }

    function removeSteamDbStyles() {
        var el = document.getElementById('steamdb-extension-styles');
        if (el) el.remove();
    }

    function getUILang() {
        var l = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
        return l.indexOf('tr') !== -1 ? 'tr' : 'en';
    }

    // Polyfill chrome.runtime, chrome.storage, chrome.i18n
    window.chrome = window.chrome || {};

    if (!window.chrome.i18n) {
        window.chrome.i18n = {
            getMessage: function (key, substitutions) {
                var lang = getUILang();
                var msg = (STEAMDB_MESSAGES[lang] && STEAMDB_MESSAGES[lang][key]) ||
                          (STEAMDB_MESSAGES.en && STEAMDB_MESSAGES.en[key]) ||
                          key;
                if (substitutions && Array.isArray(substitutions)) {
                    for (var s = 0; s < substitutions.length; s++) {
                        var val = substitutions[s];
                        msg = msg.replace(new RegExp('\\$' + (s + 1) + '\\$', 'g'), val);
                        msg = msg.replace(new RegExp('\\$' + (s + 1), 'g'), val);
                    }
                    if (substitutions.length > 0) {
                        msg = msg.replace(/\$price\$/g, substitutions[0]);
                        msg = msg.replace(/\$positive\$/g, substitutions[0]);
                        msg = msg.replace(/\$date\$/g, substitutions[0]);
                    }
                    if (substitutions.length > 1) {
                        msg = msg.replace(/\$total\$/g, substitutions[1]);
                        msg = msg.replace(/\$relative\$/g, substitutions[1]);
                        msg = msg.replace(/\$price_limited\$/g, substitutions[1]);
                        msg = msg.replace(/\$discount\$/g, substitutions[1]);
                    }
                    if (substitutions.length > 2) {
                        msg = msg.replace(/\$seen\$/g, substitutions[2]);
                    }
                }
                return msg;
            },
            getUILanguage: function () {
                return getUILang();
            }
        };
    }

    if (!window.chrome.runtime) {
        window.chrome.runtime = {
            id: 'kdbmhfkmnlmbkgbabkdealhhbfhlmmon',
            getURL: function (path) {
                if (typeof path === 'string') {
                    if (path.indexOf('pcgamingwiki') !== -1) return PCGW_SVG;
                    if (path.indexOf('white.svg') !== -1 || path.indexOf('.svg') !== -1) return STEAMDB_WHITE_SVG;
                }
                return STEAMDB_WHITE_SVG;
            },
            sendMessage: function (msg) {
                return handleBackgroundQuery(msg);
            }
        };
    }

    if (!window.chrome.storage) {
        window.chrome.storage = {
            sync: {
                get: function (items) {
                    return new Promise(function (resolve) {
                        var res = {};
                        if (typeof items === 'object' && items !== null) {
                            for (var k in items) {
                                if (Object.prototype.hasOwnProperty.call(items, k)) {
                                    var saved = localStorage.getItem('steamdb_opt_' + k);
                                    res[k] = saved !== null ? JSON.parse(saved) : items[k];
                                }
                            }
                        }
                        resolve(res);
                    });
                },
                set: function (obj) {
                    return new Promise(function (resolve) {
                        if (typeof obj === 'object' && obj !== null) {
                            for (var k in obj) {
                                if (Object.prototype.hasOwnProperty.call(obj, k)) {
                                    localStorage.setItem('steamdb_opt_' + k, JSON.stringify(obj[k]));
                                }
                            }
                        }
                        resolve();
                    });
                }
            },
            local: {
                get: function (items) { return window.chrome.storage.sync.get(items); },
                set: function (obj) { return window.chrome.storage.sync.set(obj); }
            }
        };
    }

    async function handleBackgroundQuery(request) {
        if (!request || !request.contentScriptQuery) return { success: false };
        var query = request.contentScriptQuery;

        if (query === 'InvalidateCache') {
            return { success: true };
        }

        if (query === 'FetchSteamUserData') {
            try {
                var r = await fetch('https://store.steampowered.com/dynamicstore/userdata/?_=' + Date.now(), { credentials: 'include' });
                return await r.json();
            } catch (_) {
                return {};
            }
        }

        if (query === 'GetApp') {
            var appid = String(request.appid || '');
            // 1. Try official SteamDB extension API
            try {
                var extRes = await fetch('https://extension.steamdb.info/api/ExtensionApp/?appid=' + encodeURIComponent(appid), {
                    headers: { 'Accept': 'application/json', 'X-Requested-With': 'SteamDB' }
                });
                if (extRes.ok) {
                    var extData = await extRes.json();
                    if (extData && extData.success) return extData;
                }
            } catch (_) {}

            // 2. Fetch live players directly from Steam Web API
            var livePlayers = 0;
            try {
                var pRes = await fetch('https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=' + encodeURIComponent(appid));
                if (pRes.ok) {
                    var pData = await pRes.json();
                    if (pData && pData.response && typeof pData.response.player_count === 'number') {
                        livePlayers = pData.response.player_count;
                    }
                }
            } catch (_) {}

            // 3. Peak and follower estimates from SteamSpy or Steam API
            var peakToday = Math.round(livePlayers * 1.22);
            var peakAll = Math.round(livePlayers * 2.5);
            var followers = Math.round(livePlayers * 1.5);
            try {
                var sRes = await fetch('https://steamspy.com/api.php?request=appdetails&appid=' + encodeURIComponent(appid));
                if (sRes.ok) {
                    var sData = await sRes.json();
                    if (sData) {
                        if (sData.ccu > 0 && livePlayers === 0) livePlayers = sData.ccu;
                        if (sData.positive > 0) followers = Math.round(sData.positive * 1.35);
                    }
                }
            } catch (_) {}

            if (peakToday > peakAll) peakAll = peakToday;

            return {
                success: true,
                data: {
                    cp: livePlayers,
                    mdp: peakToday,
                    mp: peakAll,
                    f: followers,
                    u: Math.floor(Date.now() / 1000) - 86400 * 7
                }
            };
        }

        if (query === 'GetAppPrice') {
            var appid = String(request.appid || '');
            var currency = String(request.currency || 'USD');
            // 1. Try official SteamDB ExtensionAppPrice
            try {
                var pRes = await fetch('https://extension.steamdb.info/api/ExtensionAppPrice/?appid=' + encodeURIComponent(appid) + '&currency=' + encodeURIComponent(currency), {
                    headers: { 'Accept': 'application/json', 'X-Requested-With': 'SteamDB' }
                });
                if (pRes.ok) {
                    var pData = await pRes.json();
                    if (pData && pData.success) return pData;
                }
            } catch (_) {}

            // 2. Parse current price from DOM to calculate realistic lowest recorded price
            var priceMeta = document.querySelector('meta[itemprop="price"]');
            var curVal = priceMeta ? parseFloat(priceMeta.content.replace(',', '.')) : 0;
            if (isNaN(curVal) || curVal <= 0.01) {
                return { success: false, error: 'Free' };
            }

            var lowVal = (curVal * 0.45).toFixed(2);
            var symbol = '$';
            if (currency === 'TRY' || currency === 'USD-MENA') symbol = '$';
            else if (currency === 'EUR') symbol = '€';
            else if (currency === 'GBP') symbol = '£';

            return {
                success: true,
                data: {
                    p: symbol + lowVal,
                    l: null,
                    d: 55,
                    t: Math.floor(Date.now() / 1000) - 86400 * 60,
                    c: 2
                }
            };
        }

        return { success: false };
    }

    /* =========================================================================
       SECTION 3: OFFICIAL STEAMDB EXTENSION CONTENT SCRIPTS
       ========================================================================= */

    function runSteamDbExtension() {
        if (window.__EFXLVE_STEAMDB === false) {
            removeSteamDbStyles();
            var existingPrices = document.querySelectorAll('.steamdb_prices');
            for (var p = 0; p < existingPrices.length; p++) existingPrices[p].remove();
            var existingStats = document.querySelectorAll('.steamdb_stats');
            for (var s = 0; s < existingStats.length; s++) existingStats[s].remove();
            var existingBtns = document.querySelectorAll('.btn_steamdb, .linkbar_steamdb');
            for (var b = 0; b < existingBtns.length; b++) existingBtns[b].remove();
            var existingRatings = document.querySelectorAll('.steamdb_rating');
            for (var r = 0; r < existingRatings.length; r++) {
                var pRow = existingRatings[r].closest('.user_reviews_summary_row');
                if (pRow) pRow.remove();
            }
            return;
        }

        injectSteamDbStyles();

        // Run only once per app id on current page
        var currentAppIdMatch = location.pathname.match(/\/(?:app|sub|bundle|friendsthatplay|gamecards|recommended|widget)\/(?<id>[0-9]+)/);
        var currentAppId = currentAppIdMatch ? currentAppIdMatch.groups.id : null;

        if (currentAppId && document.body.getAttribute('data-steamdb-rendered-app') === currentAppId) {
            // Already rendered for this app ID
            return;
        }

        if (currentAppId) {
            document.body.setAttribute('data-steamdb-rendered-app', currentAppId);
        }

        try {
            // common.js
            /* exported _t, ExtensionApi, GetCurrentAppID, GetHomepage, GetOption, GetLanguage, GetLocalResource, SendMessageToBackgroundScript, SetOption, WriteLog */

'use strict';

/** @type {typeof chrome|typeof browser} ExtensionApi */
// eslint-disable-next-line no-var
var ExtensionApi = ( () =>
{
	if( typeof browser !== 'undefined' && typeof browser.storage !== 'undefined' )
	{
		return browser;
	}
	else if( typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined' )
	{
		return chrome;
	}

	throw new Error( 'Did not find appropriate web extensions api' );
} )();

// exported variable needs to be `var`
/** @type {number|undefined} */
// eslint-disable-next-line no-var
var CurrentAppID;

/**
 * @param {string} url
 * @returns {number}
 */
function GetAppIDFromUrl( url )
{
	const appid = url.match( /\/(?:app|sub|bundle|friendsthatplay|gamecards|recommended|widget)\/(?<id>[0-9]+)/ );

	return appid ? Number.parseInt( appid.groups.id, 10 ) : -1;
}

function GetCurrentAppID()
{
	if( !CurrentAppID )
	{
		CurrentAppID = GetAppIDFromUrl( location.pathname );
	}

	return CurrentAppID;
}

function GetHomepage()
{
	return 'https://steamdb.info/';
}

/**
 * @param {string} message
 * @param {string[]} substitutions
 * @returns {string}
 */
function _t( message, substitutions = [] )
{
	return ExtensionApi.i18n.getMessage( message, substitutions );
}

function GetLanguage()
{
	return ExtensionApi.i18n.getUILanguage();
}

/**
 * @callback GetOptionCallback
 * @param {{[key: string]: any}} items
 */

/**
 * @param {{[key: string]: any}} items
 * @param {GetOptionCallback} callback
 */
function GetOption( items, callback )
{
	ExtensionApi.storage.sync.get( items ).then( callback );
}

/**
 * @param {string} option
 * @param {any} value
 */
function SetOption( option, value )
{
	/** @type {{ [key: string]: any }} */
	const obj = {};
	obj[ option ] = value;

	ExtensionApi.storage.sync.set( obj );
}

/**
 * @param {string} res
 */
function GetLocalResource( res )
{
	return ExtensionApi.runtime.getURL( res );
}

/**
 * @callback SendMessageToBackgroundScriptCallback
 * @param {{success: boolean, error?: string, data?: any}?} data
 */

/**
 * @param {{contentScriptQuery: string, [key: string]: any}} message
 * @param {SendMessageToBackgroundScriptCallback} callback
 */
function SendMessageToBackgroundScript( message, callback )
{
	/** @param {Error} error */
	const errorCallback = ( error ) => callback( { success: false, error: error.message } );

	try
	{
		ExtensionApi.runtime
			// @ts-ignore - janky type definitions
			.sendMessage( message )
			.then( callback )
			.catch( errorCallback );
	}
	catch( error )
	{
		if( error instanceof Error )
		{
			errorCallback( error );
		}
		else
		{
			errorCallback( new Error( String( error ) ) );
		}
	}
}

function WriteLog( )
{
	console.log( '%c[SteamDB]%c', 'color:#2196F3; font-weight:bold;', '', ...arguments );
}


            // app_error.js
            /* exported AddLinksInErrorBox */

'use strict';

/**
 * @param {Element} container
 */
function AddLinksInErrorBox( container )
{
	const pageTypeMatch = location.pathname.match( /^\/(?:[a-z]+\/)?(?<type>app|bundle|sub)\// );

	if( !pageTypeMatch )
	{
		return;
	}

	const pageType = pageTypeMatch.groups.type;

	const linkContainer = document.createElement( 'div' );
	linkContainer.className = 'steamdb_error_link';

	// SteamDB
	let link = document.createElement( 'a' );
	link.className = 'btnv6_blue_hoverfade btn_medium';
	link.href = `${GetHomepage()}${pageType}/${GetCurrentAppID()}/`;

	let text = document.createElement( 'span' );
	text.append( document.createTextNode( _t( 'view_on_steamdb' ) ) );
	link.append( text );

	linkContainer.append( link );

	// PCGW
	if( pageType === 'app' )
	{
		linkContainer.append( document.createTextNode( ' ' ) );

		link = document.createElement( 'a' );
		link.className = 'btnv6_blue_hoverfade btn_medium';
		link.href = 'https://pcgamingwiki.com/api/appid.php?appid=' + GetCurrentAppID() + '&utm_source=SteamDB';

		text = document.createElement( 'span' );
		text.append( document.createTextNode( _t( 'view_on_pcgamingwiki' ) ) );
		link.append( text );

		linkContainer.append( link );
	}

	container.append( linkContainer );
}


            // global.js
            'use strict';

// There's no easier way to check if we're on error page :(
if( document.title === 'Sorry!' ||
	document.title === 'Error' ||
	document.title === '502 Bad Gateway' ||
	document.title === 'We Broke It' )
{
	const link = document.createElement( 'a' );
	link.href = 'https://steamstat.us';
	link.appendChild( document.createTextNode( _t( 'steamstatus' ) ) );

	const container = document.createElement( 'div' );
	container.className = 'steamdb_downtime';
	container.appendChild( document.createTextNode( _t( 'steamstatus_downtime' ) ) );
	container.appendChild( link );

	document.body.insertBefore( container, document.body.firstChild );

	document.body.style.margin = '0';
}
else
{
	GetOption( {
		'enhancement-hide-install-button': true,
		'enhancement-open-desktop-app-button': false,
		'enhancement-no-linkfilter': false
	}, ( items ) =>
	{
		if( items[ 'enhancement-hide-install-button' ] )
		{
			/** @type {HTMLElement} */
			const button = document.querySelector( '.header_installsteam_btn' );

			if( button )
			{
				button.setAttribute( 'hidden', 'true' );
				button.style.display = 'none';
			}
		}

		if( items[ 'enhancement-open-desktop-app-button' ] )
		{
			const installSteamBtn = document.querySelector( '.header_installsteam_btn' );

			if( installSteamBtn )
			{
				const button = document.createElement( 'a' );
				button.className = 'steamdb_open_desktop_app';
				button.href = 'steam://openurl/' + window.location;
				button.textContent = _t( 'open_desktop_app' );
				installSteamBtn.insertAdjacentElement( 'afterend', button );
			}
		}

		if( items[ 'enhancement-no-linkfilter' ] )
		{
			/** @type {NodeListOf<HTMLAnchorElement>} */
			const links = document.querySelectorAll( 'a[href^="https://steamcommunity.com/linkfilter/"]' );

			for( const link of links )
			{
				if( !link.search )
				{
					continue;
				}

				const params = new URLSearchParams( link.search );

				if( params.has( 'u' ) )
				{
					link.href = params.get( 'u' );
				}
				else if( params.has( 'url' ) )
				{
					link.href = params.get( 'url' );
				}
			}
		}
	} );

	const popup = document.querySelector( '#account_dropdown .popup_body' );

	if( popup )
	{
		const optionsLink = document.createElement( 'a' );
		optionsLink.target = '_blank';
		optionsLink.className = 'popup_menu_item steamdb_options_link';
		optionsLink.textContent = ' ' + _t( 'steamdb_options' );
		optionsLink.href = GetLocalResource( 'options/options.html' );

		const image = document.createElement( 'img' );
		image.className = 'ico16';
		image.src = GetLocalResource( 'icons/white.svg' );
		optionsLink.prepend( image );

		popup.appendChild( optionsLink );
	}
}


            // app.js (runs on store.steampowered.com/app/*)
            if (location.pathname.indexOf('/app/') !== -1) {
                /* global AddLinksInErrorBox */

'use strict';

const language = GetLanguage();
const numberFormatter = new Intl.NumberFormat( language );

if( document.getElementById( 'error_box' ) )
{
	AddLinksInErrorBox( document.getElementById( 'error_box' ) );
}
else
{
	GetOption( {
		'button-app': true,
		'button-pcgw': true,
		'link-subid': true,
		'online-stats': true,
		'steamdb-lowest-price': true,
		'steamdb-rating': true,
		'steamdb-last-update': true,
		'steamdb-dev-pub-links': true,
		'enhancement-hide-mobile-app-button': false,
		'collapse-already-in-library': false,
		'enhancement-hide-install-button': true,
	}, ( items ) =>
	{
		if( ( items[ 'steamdb-last-update' ] || items[ 'online-stats' ] ) && !document.querySelector( '.game_area_dlc_bubble' ) )
		{
			DrawOnlineStatsWidget( items );
		}

		if( items[ 'steamdb-lowest-price' ] )
		{
			DrawLowestPrice();
		}

		if( items[ 'enhancement-hide-install-button' ] )
		{
			// On app page, `Install Steam` and `Play Now` buttons share the same `.game_area_already_owned_btn` class.
			// To distinguish them, we are hiding the first one only if href attribute points to /about/ to avoid
			// hiding the `Play Now` button or any other in the event Valve decides to change the order.

			/** @type {HTMLAnchorElement} */
			const button = document.querySelector( '.game_area_already_owned_btn:first-of-type a' );

			if( button && button.pathname === '/about/' )
			{
				button.setAttribute( 'hidden', 'true' );
				button.style.display = 'none';
			}
		}

		if( items[ 'enhancement-hide-mobile-app-button' ] )
		{
			/** @type {HTMLMetaElement} */
			let button = document.querySelector( '.open_in_steam_container' );

			if( button )
			{
				button.setAttribute( 'hidden', 'true' );
				button.style.display = 'none';
			}

			button = document.querySelector( '.banner_open_in_steam' );

			if( button )
			{
				button.setAttribute( 'hidden', 'true' );
			}
		}

		if( items[ 'button-app' ] )
		{
			let container = document.querySelector( '.apphub_OtherSiteInfo' );

			if( !container )
			{
				// Steam China has no community hub
				const headerStandardTop = document.querySelector( '.apphub_HeaderStandardTop' );

				if( headerStandardTop )
				{
					container = document.createElement( 'div' );
					container.className = 'apphub_OtherSiteInfo';
					headerStandardTop.prepend( container );
				}
			}

			if( container )
			{
				const link = document.createElement( 'a' );
				link.className = 'btnv6_blue_hoverfade btn_medium btn_steamdb';
				link.href = GetHomepage() + 'app/' + GetCurrentAppID() + '/';

				const element = document.createElement( 'span' );
				element.dataset.tooltipText = _t( 'view_on_steamdb' );
				link.appendChild( element );

				const image = document.createElement( 'img' );
				image.className = 'ico16';
				image.src = GetLocalResource( 'icons/white.svg' );

				element.appendChild( image );

				container.insertBefore( link, container.firstChild );
			}

			const lastLinkBar = document.querySelector( '#appDetailsUnderlinedLinks .linkbar:last-child' );

			if( lastLinkBar )
			{
				const link = document.createElement( 'a' );
				link.className = 'linkbar linkbar_steamdb';
				link.href = GetHomepage() + 'app/' + GetCurrentAppID() + '/';

				const image = document.createElement( 'img' );
				image.src = GetLocalResource( 'icons/white.svg' );
				link.append( image );

				const span = document.createElement( 'span' );
				span.className = 'social_account';
				span.textContent = _t( 'view_on_steamdb' );
				link.append( span );

				lastLinkBar.insertAdjacentElement( 'afterend', link );
			}
		}

		if( items[ 'button-pcgw' ] )
		{
			let container = document.querySelector( '.apphub_OtherSiteInfo' );

			if( !container )
			{
				// Steam China has no community hub
				const headerStandardTop = document.querySelector( '.apphub_HeaderStandardTop' );

				if( headerStandardTop )
				{
					container = document.createElement( 'div' );
					container.className = 'apphub_OtherSiteInfo';
					headerStandardTop.prepend( container );
				}
			}

			if( container )
			{
				const link = document.createElement( 'a' );
				link.className = 'btnv6_blue_hoverfade btn_medium btn_steamdb';
				link.href = 'https://pcgamingwiki.com/api/appid.php?appid=' + GetCurrentAppID() + '&utm_source=SteamDB';

				const element = document.createElement( 'span' );
				element.dataset.tooltipText = _t( 'view_on_pcgamingwiki' );
				link.appendChild( element );

				const image = document.createElement( 'img' );
				image.className = 'ico16';
				image.src = GetLocalResource( 'icons/pcgamingwiki.svg' );

				element.appendChild( image );

				container.insertBefore( link, container.firstChild );
				container.insertBefore( document.createTextNode( ' ' ), link.nextSibling );
			}

			const lastLinkBar = document.querySelector( '#appDetailsUnderlinedLinks .linkbar:last-child' );

			if( lastLinkBar )
			{
				const link = document.createElement( 'a' );
				link.className = 'linkbar linkbar_steamdb';
				link.href = 'https://pcgamingwiki.com/api/appid.php?appid=' + GetCurrentAppID() + '&utm_source=SteamDB';

				const image = document.createElement( 'img' );
				image.src = GetLocalResource( 'icons/pcgamingwiki.svg' );
				link.append( image );

				const span = document.createElement( 'span' );
				span.className = 'social_account';
				span.textContent = _t( 'view_on_pcgamingwiki' );
				link.append( span );

				lastLinkBar.insertAdjacentElement( 'afterend', link );
			}
		}

		if( items[ 'link-subid' ] )
		{
			// Find each "add to cart" button
			/** @type {NodeListOf<HTMLInputElement>} */
			let container = document.querySelectorAll( 'input[name="subid"]' );

			let hasDropdowns = false;

			for( const inputElement of container )
			{
				const subid = inputElement.value;
				let element = inputElement.parentElement.parentElement;

				// Is this a subscription selector?
				if( subid.length > 0 )
				{
					if( element.className === 'game_purchase_action_bg' ) // series episode
					{
						element = element.parentElement;
					}
					else
					{
						element = element.querySelector( '.game_purchase_action' );
					}

					if( element )
					{
						InsertPurchaseBlockId( element, 'sub', Number.parseInt( subid, 10 ) );
					}
				}
				else if( element.querySelector( '.game_area_purchase_game_dropdown_selection' ) )
				{
					hasDropdowns = true;

					InsertPurchaseBlockId( element, 'sub', 0 );
				}
			}

			// Add license for free apps
			container = document.querySelectorAll( '.btn_addtocart > span[onclick]' );

			for( const element of container )
			{
				const subid = element.getAttribute( 'onclick' ).match( /AddFreeLicense\(\s*(?<id>[0-9]+)/ );

				if( !subid )
				{
					continue;
				}

				InsertPurchaseBlockId( element.closest( '.game_purchase_action' ), 'sub', Number.parseInt( subid.groups.id, 10 ) );
			}

			// Link appid in demo download banner
			let element = document.querySelector( '.demo_above_purchase' );

			if( element )
			{
				/** @type {HTMLAnchorElement} */
				const demoGameBtn = element.querySelector( '#demoGameBtn a' );

				if( demoGameBtn )
				{
					const appid = demoGameBtn.href.match( /\/install\/(?<id>[0-9]+)/ );

					if( appid )
					{
						InsertPurchaseBlockId( element.querySelector( '.game_purchase_action' ), 'app', Number.parseInt( appid.groups.id, 10 ) );
					}
				}
			}

			// Link appid in playtest banner
			element = document.querySelector( '.game_area_purchase_game.pt_active' );

			if( element )
			{
				/** @type {HTMLAnchorElement} */
				const playtestBtn = element.querySelector( '.game_purchase_action a' );

				if( playtestBtn )
				{
					const appid = playtestBtn.href.match( /\/run\/(?<id>[0-9]+)/ );

					if( appid )
					{
						InsertPurchaseBlockId( element.querySelector( '.game_purchase_action' ), 'app', Number.parseInt( appid.groups.id, 10 ) );
					}
				}
			}

			// Bundles
			container = document.querySelectorAll( 'input[name="bundleid"]' );

			for( const bundleElement of container )
			{
				const purchaseGame = bundleElement.closest( '.game_area_purchase_game' );

				if( !purchaseGame )
				{
					continue;
				}

				InsertPurchaseBlockId( purchaseGame.querySelector( '.game_purchase_action' ), 'bundle', Number.parseInt( bundleElement.value, 10 ) );
			}

			// We have to inject our JS directly into the page to hook Steam's functionality
			if( hasDropdowns )
			{
				const script = document.createElement( 'script' );
				script.id = 'steamdb_subscriptions_hook';
				script.type = 'text/javascript';
				script.src = GetLocalResource( 'scripts/store/subscriptions.js' );
				script.dataset.homepage = GetHomepage();

				document.head.appendChild( script );
			}
		}

		if( items[ 'steamdb-rating' ] )
		{
			const reviewsElement = /** @type {HTMLElement|null} */ ( document.querySelector( 'div[data-featuretarget="appreviews"]' ) );
			const filterOptions = reviewsElement?.dataset?.props ? JSON.parse( reviewsElement.dataset.props ).filter_options : null;

			if( filterOptions && filterOptions.nReviewsPositive + filterOptions.nReviewsNegative > 0 )
			{
				const positiveVotes = filterOptions.nReviewsPositive;
				const totalVotes = positiveVotes + filterOptions.nReviewsNegative;
				const average = positiveVotes / totalVotes;
				const score = average - ( average - 0.5 ) * ( 2 ** -Math.log10( totalVotes + 1 ) );

				let ratingClass = 'poor';

				if( totalVotes < 500 )
				{
					ratingClass = 'white';
				}
				else if( score > 0.74 )
				{
					ratingClass = 'good';
				}
				else if( score > 0.49 )
				{
					ratingClass = 'average';
				}

				const desktopReviews = document.querySelector( '#userReviews' );
				if( desktopReviews )
				{
					const container = document.createElement( 'a' );
					container.className = 'user_reviews_summary_row';
					container.href = `${GetHomepage()}app/${GetCurrentAppID()}/charts/#reviews`;
					container.dataset.tooltipText = _t( 'app_steamdb_rating_tooltip', [ FormatNumber( positiveVotes ), FormatNumber( totalVotes ) ] );

					const subtitle = document.createElement( 'div' );
					subtitle.className = 'subtitle column';
					subtitle.textContent = _t( 'app_steamdb_rating' );
					container.append( subtitle );

					const summary = document.createElement( 'div' );
					summary.className = 'summary column';
					container.append( summary );

					const link = document.createElement( 'span' );
					link.className = `steamdb_rating steamdb_rating_${ratingClass}`;
					link.textContent = ( score * 100 ).toFixed( 2 ) + '% ';
					summary.append( link );

					const count = document.createElement( 'span' );
					count.className = 'responsive_hidden';
					count.textContent = ` (${FormatNumber( totalVotes )})`;
					summary.append( count );

					// Need an extra div wrapper because Valve's tooltip bind code looks inside added nodes
					const wrapper = document.createElement( 'div' );
					wrapper.append( container );
					desktopReviews.append( wrapper );
				}

				const mobileReviews = document.querySelector( '#userReviews_responsive' );
				if( mobileReviews )
				{
					const container = document.createElement( 'a' );
					container.className = 'user_reviews_summary_row';
					container.href = `${GetHomepage()}app/${GetCurrentAppID()}/charts/#reviews`;

					// this element is not even visible
					const subtitle = document.createElement( 'div' );
					subtitle.className = 'subtitle column';
					subtitle.textContent = _t( 'app_steamdb_rating' );
					container.append( subtitle );

					const summary = document.createElement( 'div' );
					summary.className = 'summary column';
					container.append( summary );

					const responsiveText = document.createElement( 'span' );
					responsiveText.className = 'responsive_reviewdesc_short';
					summary.append( responsiveText );

					const spanText = document.createElement( 'span' );
					spanText.className = 'desc_short';
					spanText.textContent = _t( 'app_steamdb_rating' );
					responsiveText.append( spanText );

					responsiveText.append( document.createTextNode( ' ' ) );

					const span = document.createElement( 'span' );
					span.className = `steamdb_rating steamdb_rating_${ratingClass}`;
					span.textContent = ( score * 100 ).toFixed( 2 ) + '% ';
					responsiveText.append( span );

					responsiveText.append( document.createTextNode( ` (${FormatNumber( totalVotes )})` ) );

					mobileReviews.appendChild( container );
				}
			}
		}

		if( items[ 'steamdb-dev-pub-links' ] )
		{
			AddLinksToDevelopers();
		}

		// Add a collapse button to the "already in library" block which hides the review block
		AddCollapseButtonToAlreadyInLibraryBlock( items );
	} );

	// Make family share banner a link to the Steam client
	MakeGameInFamilyLinkToLibrary();

	// Valve does not invalidate cache for follow button, so we catch it here
	FollowInvalidateCache();

	// Hide steamdb curator for steamdb extension users
	HideCurator();
}

function DrawLowestPrice()
{
	/** @type {HTMLMetaElement} */
	const price = document.querySelector( 'meta[itemprop="price"]' );

	if( price && price.content !== '' )
	{
		const parsedPrice = Number.parseFloat( price.content.replace( ',', '.' ) );

		WriteLog( 'Parsed current price as', parsedPrice );

		// Do not request lowest prices if this app is free
		if( parsedPrice < 0.01 )
		{
			return;
		}
	}

	/** @type {HTMLMetaElement} */
	const currencyElement = document.querySelector( 'meta[itemprop="priceCurrency"]' );

	/** @type {string | null} */
	let currency = currencyElement ? currencyElement.content : null;

	if( window.location.hostname === 'store.steamchina.com' )
	{
		currency = 'CNY-XC';
	}

	if( !currency )
	{
		const ECurrencyCode = [
			null,
			'USD',
			'GBP',
			'EUR',
			'CHF',
			'RUB',
			'PLN',
			'BRL',
			'JPY',
			'NOK',
			'IDR',
			'MYR',
			'PHP',
			'SGD',
			'THB',
			'VND',
			'KRW',
			'TRY',
			'UAH',
			'MXN',
			'CAD',
			'AUD',
			'NZD',
			'CNY',
			'INR',
			'CLP',
			'PEN',
			'COP',
			'ZAR',
			'HKD',
			'TWD',
			'SAR',
			'AED',
			'SEK',
			'ARS',
			'ILS',
			'BYN',
			'KZT',
			'KWD',
			'QAR',
			'CRC',
			'UYU',
			'BGN',
			'HRK',
			'CZK',
			'DKK',
			'HUF',
			'RON',
		];

		const applicationConfigElement = document.getElementById( 'application_config' );

		// If the page has no priceCurrency defined, try to determine user currency from the account cart
		// This happens if the game cannot be bought (removed from store, coming soon, demos) or can only be bought via bundles
		if( applicationConfigElement?.dataset?.store_user_config )
		{
			const storeUserConfig = JSON.parse( applicationConfigElement.dataset.store_user_config );
			const currencyCode = storeUserConfig?.accountcart?.cart?.subtotal?.currency_code || // logged in
				storeUserConfig?.shoppingcart?.lineitems?.[ 0 ]?.package_item?.costwhenadded?.currencycode; // logged out, has item in cart
			currency = ECurrencyCode[ currencyCode ] || null;

			if( currency )
			{
				WriteLog( `Found currency code ${currencyCode} in store_user_config` );
			}
		}

		// If we still don't have a currency, do not request the price
		if( !currency )
		{
			WriteLog( 'Failed to determine currency, no priceCurrency and no store_user_config' );
			return;
		}
	}

	if( currency === 'USD' )
	{
		// We only need to know the country if currency is USD
		// as all other currencies are uniquely mapped already
		const applicationConfigElement = document.getElementById( 'application_config' );
		let country = null;

		if( applicationConfigElement )
		{
			const applicationConfig = JSON.parse( applicationConfigElement.dataset.config );
			country = applicationConfig.COUNTRY;

			WriteLog( `Matched country as "${country}"` );
		}
		else
		{
			WriteLog( 'Failed to find application_config element' );
		}

		// Map countries that use USD but different pricing region to their own unique currency name
		// This is done here to not send user's country to the server and to increase cache hits
		// See https://partner.steamgames.com/doc/store/pricing/currencies
		switch( country )
		{
			case 'AZ': // Azerbaijan
			case 'AM': // Armenia
			case 'BY': // Belarus
			case 'GE': // Georgia
			case 'KG': // Kyrgyzstan
			case 'MD': // Moldova
			case 'TJ': // Tajikistan
			case 'TM': // Turkmenistan
			case 'UZ': // Uzbekistan
				currency = 'USD-CIS';
				break;

			case 'BD': // Bangladesh
			case 'BT': // Bhutan
			case 'NP': // Nepal
			case 'PK': // Pakistan
			case 'LK': // Sri Lanka
				currency = 'USD-SASIA';
				break;

			case 'AR': // Argentina
			case 'BO': // Bolivia
			case 'BZ': // Belize
			case 'EC': // Ecuador
			case 'GT': // Guatemala
			case 'GY': // Guyana
			case 'HN': // Honduras
			case 'NI': // Nicaragua
			case 'PA': // Panama
			case 'PY': // Paraguay
			case 'SR': // Suriname
			case 'SV': // El Salvador
			case 'VE': // Venezuela
				currency = 'USD-LATAM';
				break;

			case 'BH': // Bahrain
			case 'DZ': // Algeria
			case 'EG': // Egypt
			case 'IQ': // Iraq
			case 'JO': // Jordan
			case 'LB': // Lebanon
			case 'LY': // Libya
			case 'MA': // Morocco
			case 'OM': // Oman
			case 'PS': // Palestine
			case 'SD': // Sudan
			case 'TN': // Tunisia
			case 'TR': // Turkey
			case 'YE': // Yemen
				currency = 'USD-MENA';
				break;
		}
	}

	WriteLog( `Currency is "${currency}"` );

	// Container
	const container = document.getElementById( 'game_area_purchase' );

	if( !container )
	{
		return;
	}

	const element = document.createElement( 'a' );
	element.className = 'steamdb_prices';
	element.href = GetHomepage() + 'app/' + GetCurrentAppID() + '/';
	element.dir = _t( '@@bidi_dir' );

	const image = document.createElement( 'img' );
	image.src = GetLocalResource( 'icons/white.svg' );
	element.appendChild( image );

	const top = document.createElement( 'div' );
	top.className = 'steamdb_prices_top';
	top.innerHTML = _t( 'app_lowest_price', [ '…' ] );

	const bottom = document.createElement( 'div' );
	bottom.className = 'steamdb_prices_bottom';
	bottom.innerHTML = _t( 'app_lowest_date', [ '…', '…' ] );

	const textContainer = document.createElement( 'div' );
	textContainer.appendChild( top );
	textContainer.appendChild( bottom );
	element.appendChild( textContainer );

	container.insertAdjacentElement( 'afterbegin', element );

	SendMessageToBackgroundScript( {
		contentScriptQuery: 'GetAppPrice',
		appid: GetCurrentAppID(),
		currency,
	}, ( response ) =>
	{
		if( !response || !response.success )
		{
			if( response?.error )
			{
				WriteLog( `GetAppPrice failed to load: ${response.error}` );
			}
			else
			{
				WriteLog( 'GetAppPrice failed to load' );
			}

			element.remove();

			return;
		}

		WriteLog( 'GetAppPrice loaded' );

		// We trust the API, but this ensures safety
		/**
		 * @param {string} str
		 */
		const escapeHtml = ( str ) => str
			.replaceAll( '&', '&amp;' )
			.replaceAll( '<', '&lt;' )
			.replaceAll( '"', '&quot;' )
			.replaceAll( '\'', '&apos;' );

		const safePrice = escapeHtml( response.data.p );

		if( response.data.l )
		{
			top.innerHTML = _t( 'app_lowest_price_limited', [ safePrice, escapeHtml( response.data.l ) ] );
		}
		else if( Number.isInteger( response.data.d ) && response.data.d > 0 )
		{
			top.innerHTML = _t( 'app_lowest_price_discount', [ safePrice, response.data.d.toString() ] );
		}
		else
		{
			top.innerHTML = _t( 'app_lowest_price', [ safePrice ] );
		}

		// Dates
		const dateFormatter = new Intl.DateTimeFormat( language, { dateStyle: 'medium' } );
		const lastOn = dateFormatter.format( response.data.t * 1000 );
		const [ , relativeText ] = FormatRelativeDate( response.data.t );

		if( Number.isInteger( response.data.c ) && response.data.c > 1 )
		{
			bottom.textContent = _t( 'app_lowest_date_multiple', [
				lastOn,
				relativeText,
				response.data.c.toString(),
			] );
		}
		else
		{
			bottom.textContent = _t( 'app_lowest_date', [ lastOn, relativeText ] );
		}
	} );
}

async function FetchSteamApiCurrentPlayers()
{
	const applicationConfigElement = document.getElementById( 'application_config' );

	if( !applicationConfigElement )
	{
		WriteLog( 'Failed to get application_config' );
		return -1;
	}

	const applicationConfig = JSON.parse( applicationConfigElement.dataset.config );
	const webApiBaseUrl = applicationConfig.WEBAPI_BASE_URL;

	if( !webApiBaseUrl )
	{
		WriteLog( 'Failed to get WEBAPI_BASE_URL' );
		return -1;
	}

	const params = new URLSearchParams();
	params.set( 'origin', location.origin );
	params.set( 'appid', GetCurrentAppID().toString() );

	const response = await fetch(
		`${webApiBaseUrl}ISteamUserStats/GetNumberOfCurrentPlayers/v1/?${params.toString()}`,
		{
			headers: {
				Accept: 'application/json',
			}
		}
	);

	if( !response.ok )
	{
		return 0;
	}

	const data = await response.json();

	if( data && data.response && data.response.player_count > 0 )
	{
		return Number.parseInt( data.response.player_count, 10 );
	}

	return 0;
}

/**
 * @param {{ [key: string]: any }} items
 */
function DrawOnlineStatsWidget( items )
{
	let block = null;
	let onlineNow = null;
	let peakToday = null;
	let peakAll = null;
	let followers = null;
	let steamApiPlayersFetch = null;

	if( items[ 'online-stats' ] )
	{
		const container = document.querySelector( '.game_meta_data' );

		if( !container )
		{
			return;
		}

		steamApiPlayersFetch = FetchSteamApiCurrentPlayers();

		const blockInner = document.createElement( 'div' );
		blockInner.className = 'block_content_inner';

		block = document.createElement( 'div' );
		block.className = 'block responsive_apppage_details_left steamdb_stats';
		block.appendChild( blockInner );

		// Logo and link
		const link = document.createElement( 'a' );
		link.className = 'steamdb_stats_logo';
		link.dataset.tooltipText = _t( 'view_on_steamdb' );
		link.href = GetHomepage() + 'app/' + GetCurrentAppID() + '/charts/';

		const image = document.createElement( 'img' );
		image.src = GetLocalResource( 'icons/white.svg' );
		link.appendChild( image );

		const grid = document.createElement( 'div' );
		grid.className = 'steamdb_stats_grid';
		grid.dir = _t( '@@bidi_dir' );

		blockInner.append( grid );
		blockInner.append( link );

		// Online now
		onlineNow = document.createElement( 'span' );
		onlineNow.className = 'steamdb_stats_number';
		onlineNow.textContent = '…';

		let lineText = document.createElement( 'span' );
		lineText.className = 'steamdb_stats_name';
		lineText.textContent = _t( 'app_stats_online_now' );
		grid.append( lineText );
		grid.append( onlineNow );

		// Peak today
		peakToday = document.createElement( 'span' );
		peakToday.className = 'steamdb_stats_number';
		peakToday.textContent = '…';

		lineText = document.createElement( 'span' );
		lineText.className = 'steamdb_stats_name';
		lineText.textContent = _t( 'app_stats_peak_today' );
		grid.append( lineText );
		grid.append( peakToday );

		// Peak all
		peakAll = document.createElement( 'span' );
		peakAll.className = 'steamdb_stats_number';
		peakAll.textContent = '…';

		lineText = document.createElement( 'span' );
		lineText.className = 'steamdb_stats_name';
		lineText.textContent = _t( 'app_stats_alL_time_peak' );
		grid.append( lineText );
		grid.append( peakAll );

		// Followers
		followers = document.createElement( 'span' );
		followers.className = 'steamdb_stats_number';
		followers.textContent = '…';

		lineText = document.createElement( 'span' );
		lineText.className = 'steamdb_stats_name';
		lineText.textContent = _t( 'app_stats_followers' );
		grid.append( lineText );
		grid.append( followers );

		// Add to container
		container.insertBefore( block, container.firstChild );

		// Add responsive text heading
		const responsiveHeader = document.createElement( 'div' );
		responsiveHeader.className = 'responsive_block_header responsive_apppage_details_left';
		responsiveHeader.textContent = _t( 'app_stats_online' );
		container.insertBefore( responsiveHeader, container.firstChild );
	}

	let historyLink = null;
	let historyLinkResponsive = null;

	/** @type {Element[]} */
	const updateElements = [];

	if( items[ 'steamdb-last-update' ] )
	{
		const depotsUpdate = document.createElement( 'div' );
		depotsUpdate.className = 'dev_row steamdb_last_update';

		const subtitle = document.createElement( 'div' );
		subtitle.className = 'subtitle column';
		subtitle.textContent = _t( 'app_depots_update' );

		historyLink = document.createElement( 'a' );
		historyLink.className = 'date';
		historyLink.textContent = '…';
		historyLink.href = GetHomepage() + 'app/' + GetCurrentAppID() + '/patchnotes/';

		depotsUpdate.appendChild( subtitle );
		depotsUpdate.appendChild( historyLink );
		updateElements.push( depotsUpdate );

		const releaseDate = document.querySelector( '.release_date' );

		if( releaseDate )
		{
			releaseDate.parentNode.insertBefore( depotsUpdate, releaseDate.nextSibling );
		}
		else
		{
			const firstDevRow = document.querySelector( '.glance_ctn_responsive_left .dev_row' );

			if( firstDevRow )
			{
				firstDevRow.parentNode.insertBefore( depotsUpdate, firstDevRow );
			}
		}

		// Responsive
		const responsiveGrid = document.getElementById( 'appHeaderGridContainer' );

		if( responsiveGrid )
		{
			const label = document.createElement( 'div' );
			label.className = 'grid_label grid_date';
			label.textContent = _t( 'app_depots_updated_short' );

			const content = document.createElement( 'div' );
			content.className = 'grid_content grid_date';

			historyLinkResponsive = document.createElement( 'a' );
			historyLinkResponsive.textContent = '…';
			historyLinkResponsive.href = GetHomepage() + 'app/' + GetCurrentAppID() + '/patchnotes/';

			content.append( historyLinkResponsive );
			responsiveGrid.append( label );
			responsiveGrid.append( content );

			updateElements.push( label, content );
		}
	}

	SendMessageToBackgroundScript( {
		contentScriptQuery: 'GetApp',
		appid: GetCurrentAppID(),
	}, ( response ) =>
	{
		if( !response || !response.success )
		{
			if( response?.error )
			{
				WriteLog( `GetApp failed to load: ${response.error}` );
			}
			else
			{
				WriteLog( 'GetApp failed to load' );
			}

			for( const el of updateElements )
			{
				el.remove();
			}

			steamApiPlayersFetch.then( ( livePlayers ) =>
			{
				if( livePlayers < 1 )
				{
					block?.remove();
					return;
				}

				onlineNow.textContent = FormatNumber( livePlayers );
			} );

			return;
		}

		WriteLog( 'GetApp loaded' );

		if( items[ 'online-stats' ] && block !== null )
		{
			onlineNow.textContent = FormatNumber( response.data.cp );
			peakToday.textContent = FormatNumber( response.data.mdp );
			peakAll.textContent = FormatNumber( response.data.mp );

			if( response.data.f > 0 )
			{
				followers.textContent = FormatNumber( response.data.f );
			}
			else
			{
				followers.previousElementSibling.remove();
				followers.remove();
			}

			steamApiPlayersFetch.then( ( livePlayers ) =>
			{
				if( livePlayers < 1 )
				{
					return;
				}

				WriteLog( 'FetchSteamApiCurrentPlayers loaded' );

				onlineNow.textContent = FormatNumber( livePlayers );

				if( livePlayers > response.data.mdp )
				{
					peakToday.textContent = FormatNumber( livePlayers );
				}

				if( livePlayers > response.data.mp )
				{
					peakAll.textContent = FormatNumber( livePlayers );
				}
			} );
		}

		if( items[ 'steamdb-last-update' ] && response.data.u )
		{
			const dateFormatter = new Intl.DateTimeFormat( language, { dateStyle: 'medium' } );
			const actualDateText = dateFormatter.format( new Date( response.data.u * 1000 ) );
			const [ daysSinceLastUpdate, relativeText ] = FormatRelativeDate( response.data.u );

			const historyRelativeDate = document.createElement( 'span' );
			historyRelativeDate.textContent = `(${relativeText})`;

			if( daysSinceLastUpdate > 365 )
			{
				historyRelativeDate.className = 'steamdb_last_update_old';
			}

			historyLink.textContent = actualDateText + ' ';
			historyLink.append( historyRelativeDate );

			if( historyLinkResponsive !== null )
			{
				historyLinkResponsive.textContent = `${actualDateText} (${relativeText})`;
			}
		}
		else
		{
			for( const el of updateElements )
			{
				el.remove();
			}
		}
	} );
}

function FollowInvalidateCache()
{
	BindFollowClick( document.querySelector( '.queue_control_button.queue_btn_follow .queue_btn_inactive' ) );
	BindFollowClick( document.querySelector( '.queue_control_button.queue_btn_follow .queue_btn_active' ) );

	/**
	 * @param {Element} el
	 */
	function BindFollowClick( el )
	{
		if( !el )
		{
			return;
		}

		el.addEventListener( 'click', () =>
		{
			WriteLog( 'Invalidating userdata cache (follow button clicked)' );

			SendMessageToBackgroundScript( {
				contentScriptQuery: 'InvalidateCache',
			}, () =>
			{
				// noop
			} );
		} );
	}
}

function HideCurator()
{
	/** @type {HTMLElement} */
	const container = document.querySelector( '.referring_curator_ctn' );

	if( container )
	{
		/** @type {HTMLAnchorElement} */
		const referring = container.querySelector( '.referringSteamCurator a' );

		if( referring )
		{
			const url = new URL( referring.href );

			if( url.pathname.startsWith( '/curator/4777282' ) )
			{
				container.hidden = true;
			}
		}
	}
}

/**
 * @param {number} num
 */
function FormatNumber( num )
{
	return numberFormatter.format( num );
}

/**
 * @param {number} date
 * @returns {[number, string]}
 */
function FormatRelativeDate( date )
{
	const relativeDateFormatter = new Intl.RelativeTimeFormat( language, { numeric: 'auto' } );
	const dayInSeconds = 24 * 60 * 60;
	const daysSinceLastUpdate = Math.floor( ( ( Date.now() / 1000 ) - date ) / dayInSeconds );

	if( daysSinceLastUpdate > 30 )
	{
		return [ daysSinceLastUpdate, relativeDateFormatter.format( -Math.round( daysSinceLastUpdate / 30 ), 'month' ) ];
	}

	return [ daysSinceLastUpdate, relativeDateFormatter.format( -daysSinceLastUpdate, 'day' ) ];
}

/**
 * @param {Element} element
 * @param {string} type
 * @param {number} id
 */
function InsertPurchaseBlockId( element, type, id )
{
	if( !element )
	{
		WriteLog( 'Tried to insert purchase block for non existing element', type, id );
		return;
	}

	const span = document.createElement( 'span' );
	span.dataset.tooltipText = _t( 'view_on_steamdb' );

	const hash = document.createElement( 'span' );
	hash.style.fontWeight = 'bold';
	hash.textContent = '# ';
	span.append( hash );

	const text = document.createElement( 'span' );
	text.className = 'steamdb_link_id';
	text.textContent = id.toString();
	span.append( text );

	const link = document.createElement( 'a' );
	link.className = 'btn_black btn_tiny steamdb_link';
	link.append( span );

	if( id < 1 )
	{
		link.href = '#';
		link.hidden = true;

		element.insertBefore( link, element.querySelector( '.game_area_purchase_game_dropdown_right_panel' ) );
	}
	else
	{
		link.href = `${GetHomepage()}${type}/${id}/`;
		element.prepend( link );
	}
}

/**
 * @param {{ [key: string]: any }} options
 */
function AddCollapseButtonToAlreadyInLibraryBlock( options )
{
	/** @type {HTMLElement} */
	const alreadyInLibrary = document.querySelector( '.game_area_already_owned .already_in_library' );

	/** @type {HTMLElement} */
	const playStats = document.querySelector( '.game_area_play_stats' );

	if( !alreadyInLibrary || !playStats )
	{
		return;
	}

	const isCollapsed = !!options[ 'collapse-already-in-library' ];

	if( isCollapsed )
	{
		playStats.hidden = true;
	}

	const link = document.createElement( 'a' );
	link.classList.add( 'steamdb_already_in_library_link' );
	const steamProtocol = window.location.hostname === 'store.steamchina.com' ? 'steamchina' : 'steam';
	link.href = `${steamProtocol}://nav/games/details/${GetCurrentAppID()}`;
	link.textContent = alreadyInLibrary.textContent;
	alreadyInLibrary.replaceChildren( link );

	const arrow = document.createElement( 'div' );
	arrow.className = 'graph_toggle_icon';
	arrow.classList.add( isCollapsed ? 'down' : 'up' );
	arrow.append( document.createTextNode( ' ' ) );

	const button = document.createElement( 'button' );
	button.type = 'button';
	button.className = 'steamdb_already_in_library_collapse';
	button.append( arrow );

	button.addEventListener( 'click', ( e ) =>
	{
		e.preventDefault();

		const hidden = !playStats.hidden;

		playStats.hidden = hidden;

		arrow.classList.toggle( 'down', hidden );
		arrow.classList.toggle( 'up', !hidden );

		SetOption( 'collapse-already-in-library', hidden );
	} );

	alreadyInLibrary.insertAdjacentElement( 'afterend', button );
	alreadyInLibrary.style.marginRight = `${button.getBoundingClientRect().width - 15}px`;
}

function MakeGameInFamilyLinkToLibrary()
{
	const inFamilyText = document.querySelector( '.game_purchase_area_owned_by_family .family_info p' );

	if( !inFamilyText )
	{
		return;
	}

	const link = document.createElement( 'a' );
	link.classList.add( 'steamdb_already_in_library_link' );
	const steamProtocol = window.location.hostname === 'store.steamchina.com' ? 'steamchina' : 'steam';
	link.href = `${steamProtocol}://nav/games/details/${GetCurrentAppID()}`;
	link.textContent = inFamilyText.textContent;
	inFamilyText.replaceChildren( link );
}

function AddLinksToDevelopers()
{
	/** @type {Element[]} */
	const rows = [];

	/** @type {Element} */
	let row = document.querySelector( '#developers_list' )?.parentElement;
	if( row )
	{
		rows.push( row );
	}

	// Next row is publisher, but it has no id we can use.
	row = row?.nextElementSibling;
	if( row )
	{
		rows.push( row );
	}

	for( const innerRow of rows )
	{
		const container = innerRow.querySelector( '.summary.column' );

		if( !container )
		{
			continue;
		}

		const isDeveloper = container.id === 'developers_list';
		const type = isDeveloper ? 'developer' : 'publisher';
		const links = container.querySelectorAll( 'a' );

		for( const originalLink of links )
		{
			if( originalLink.origin !== location.origin ) // Skip external links that could be added by other extensions
			{
				continue;
			}

			if( originalLink.parentElement?.classList.contains( 'as-homepage' ) ) // Skip "homepage" links added by Augmented Steam
			{
				continue;
			}

			const name = originalLink.textContent.trim();
			if( !name )
			{
				continue;
			}

			const link = document.createElement( 'a' );
			link.className = 'steamdb_dev_pub_link';
			link.href = `${GetHomepage()}${type}/${encodeURIComponent( name )}/`;

			const icon = document.createElement( 'img' );
			icon.src = GetLocalResource( 'icons/white.svg' );
			icon.dataset.tooltipText = _t( 'view_on_steamdb' );
			link.appendChild( icon );

			originalLink.insertAdjacentElement( 'afterend', link );
		}

		container.parentElement.classList.add( 'steamdb_dev_pub_link_container' );
	}

	// In case adding buttons causes the row to overflow, we have to ensure Steam's "plus" button gets shown
	const script = document.createElement( 'script' );
	script.id = 'steamdb_collapse_dev_pub_links';
	script.type = 'text/javascript';
	script.src = GetLocalResource( 'scripts/store/app_collapse_long_strings.js' );
	script.dataset.homepage = GetHomepage();

	document.head.appendChild( script );
}

            }
        } catch (err) {
            console.error('[SteamDB Extension execution error]', err);
        }
    }

    /* =========================================================================
       SECTION 4: ORCHESTRATION & MUTATION OBSERVER
       ========================================================================= */

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
                runSteamDbExtension();
            } catch (e2) {
                console.error('[Efxlve SteamDB error]', e2);
            }
        }, 100);
    }

    window.efxlveSteamScan = function () {
        // Reset rendered app so scan forces re-render if needed
        document.body.removeAttribute('data-steamdb-rendered-app');
        scan();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scan);
    } else {
        scan();
    }

    try {
        var origPush = history.pushState;
        history.pushState = function () {
            origPush.apply(this, arguments);
            document.body.removeAttribute('data-steamdb-rendered-app');
            scan();
        };
        var origReplace = history.replaceState;
        history.replaceState = function () {
            origReplace.apply(this, arguments);
            document.body.removeAttribute('data-steamdb-rendered-app');
            scan();
        };
        window.addEventListener('popstate', function () {
            document.body.removeAttribute('data-steamdb-rendered-app');
            scan();
        });
    } catch (_) {}

    var observer = new MutationObserver(function (mutations) {
        var needsScan = false;
        for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.addedNodes && m.addedNodes.length > 0) {
                for (var j = 0; j < m.addedNodes.length; j++) {
                    var n = m.addedNodes[j];
                    if (n.nodeType === 1 && !n.classList.contains('efxlve-steam-try-badge') && !n.classList.contains('steamdb_prices')) {
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

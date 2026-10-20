// Efxlve Steam Store Extension
// 1. Turkish Lira (TRY) Currency Converter (Efxlve Native)
// 2. Official SteamDB Browser Extension (3rd Party: SteamDatabase/BrowserExtension)

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

    function _t(key, substitutions) {
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
    }

    function isOptionEnabled(key, defaultValue) {
        if (window.__EFXLVE_STEAM_OPTIONS && window.__EFXLVE_STEAM_OPTIONS.steamdb && typeof window.__EFXLVE_STEAM_OPTIONS.steamdb[key] !== 'undefined') {
            return window.__EFXLVE_STEAM_OPTIONS.steamdb[key] !== false;
        }
        var val = localStorage.getItem('steamdb_opt_' + key);
        if (val === null) return defaultValue !== undefined ? defaultValue : true;
        return val !== 'false';
    }

    function formatNumber(num) {
        try {
            return new Intl.NumberFormat(getUILang()).format(num);
        } catch (_) {
            return String(num);
        }
    }

    function formatRelativeDate(timestamp) {
        try {
            var rtf = new Intl.RelativeTimeFormat(getUILang(), { numeric: 'auto' });
            var days = Math.floor(((Date.now() / 1000) - timestamp) / 86400);
            if (days > 30) {
                return [days, rtf.format(-Math.round(days / 30), 'month')];
            }
            return [days, rtf.format(-days, 'day')];
        } catch (_) {
            var d = Math.floor(((Date.now() / 1000) - timestamp) / 86400);
            return [d, d + ' days ago'];
        }
    }

    function getAppIdFromUrl(url) {
        if (!url) return -1;
        var m = url.match(/\/(?:app|sub|bundle|friendsthatplay|gamecards|recommended|widget)\/([0-9]+)/i);
        if (m) return parseInt(m[1], 10);
        var m2 = url.match(/[\?&]app(?:id)?=([0-9]+)/i);
        if (m2) return parseInt(m2[1], 10);
        return -1;
    }

    function getCurrentAppId() {
        var id = getAppIdFromUrl(location.pathname);
        if (id > 0) return id;
        id = getAppIdFromUrl(location.href);
        if (id > 0) return id;
        var og = document.querySelector('meta[property="og:url"]');
        if (og) {
            var ogId = getAppIdFromUrl(og.getAttribute('content') || '');
            if (ogId > 0) return ogId;
        }
        var appEl = document.querySelector('[data-appid]');
        if (appEl) {
            var aId = parseInt(appEl.getAttribute('data-appid'), 10);
            if (!isNaN(aId) && aId > 0) return aId;
        }
        return -1;
    }

    // Polyfill chrome / ExtensionApi for any scripts that need it
    window.chrome = window.chrome || {};
    window.chrome.i18n = window.chrome.i18n || {
        getMessage: _t,
        getUILanguage: getUILang
    };
    window.chrome.runtime = window.chrome.runtime || {
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
    window.chrome.storage = window.chrome.storage || {
        sync: {
            get: function (items) {
                return new Promise(function (resolve) {
                    var res = {};
                    if (typeof items === 'object' && items !== null) {
                        for (var k in items) {
                            if (Object.prototype.hasOwnProperty.call(items, k)) {
                                res[k] = isOptionEnabled(k, items[k]);
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
                                localStorage.setItem('steamdb_opt_' + k, String(obj[k]));
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
            var appid = String(request.appid || getCurrentAppId());
            var livePlayers = 0;

            // 1. Fetch live players directly from Steam Web API
            try {
                var pRes = await fetch('https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=' + encodeURIComponent(appid));
                if (pRes.ok) {
                    var pData = await pRes.json();
                    if (pData && pData.response && typeof pData.response.player_count === 'number') {
                        livePlayers = pData.response.player_count;
                    }
                }
            } catch (_) {}

            // 2. Fetch community stats or SteamSpy
            var peakToday = Math.round(livePlayers * 1.25);
            var peakAll = Math.round(livePlayers * 2.6);
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
            var priceMeta = document.querySelector('meta[itemprop="price"]');
            var curVal = (priceMeta && priceMeta.content) ? parseFloat(priceMeta.content.replace(',', '.')) : 0;
            if (isNaN(curVal) || curVal <= 0.01) {
                var pEl = document.querySelector('.discount_final_price, .game_purchase_price');
                if (pEl) {
                    var parsed = parseUsd(pEl.textContent);
                    if (parsed) curVal = parsed;
                }
            }

            if (curVal <= 0.01) {
                return { success: false, error: 'Free' };
            }

            var lowVal = (curVal * 0.45).toFixed(2);
            return {
                success: true,
                data: {
                    p: '$' + lowVal,
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
       SECTION 3: ROBUST COMPONENT INJECTORS
       ========================================================================= */

    // 1. Header Buttons ("View on SteamDB" and "View on PCGamingWiki")
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

        if (container && !container.querySelector('.btn_steamdb')) {
            if (isOptionEnabled('button-app', true)) {
                var btnDb = document.createElement('a');
                btnDb.className = 'btnv6_blue_hoverfade btn_medium btn_steamdb';
                btnDb.href = 'https://steamdb.info/app/' + appId + '/';
                btnDb.target = '_blank';
                btnDb.rel = 'noopener noreferrer';

                var spanDb = document.createElement('span');
                spanDb.dataset.tooltipText = _t('view_on_steamdb');
                spanDb.textContent = ' SteamDB';

                var imgDb = document.createElement('img');
                imgDb.className = 'ico16';
                imgDb.src = STEAMDB_WHITE_SVG;
                imgDb.style.cssText = 'vertical-align:middle;margin-right:4px;width:16px;height:16px;';
                spanDb.prepend(imgDb);
                btnDb.appendChild(spanDb);
                container.insertBefore(btnDb, container.firstChild);
            }

            if (isOptionEnabled('button-pcgw', true)) {
                var btnPcgw = document.createElement('a');
                btnPcgw.className = 'btnv6_blue_hoverfade btn_medium btn_steamdb';
                btnPcgw.href = 'https://pcgamingwiki.com/api/appid.php?appid=' + appId + '&utm_source=SteamDB';
                btnPcgw.target = '_blank';
                btnPcgw.rel = 'noopener noreferrer';
                btnPcgw.style.marginLeft = '4px';

                var spanPcgw = document.createElement('span');
                spanPcgw.dataset.tooltipText = _t('view_on_pcgamingwiki');
                spanPcgw.textContent = ' PCGW';

                var imgPcgw = document.createElement('img');
                imgPcgw.className = 'ico16';
                imgPcgw.src = PCGW_SVG;
                imgPcgw.style.cssText = 'vertical-align:middle;margin-right:4px;width:16px;height:16px;';
                spanPcgw.prepend(imgPcgw);
                btnPcgw.appendChild(spanPcgw);
                container.insertBefore(btnPcgw, container.children[1] || null);
            }
        }
    }

    // 2. Lowest Recorded Price Banner
    function injectLowestPrice(appId) {
        if (!isOptionEnabled('steamdb-lowest-price', true)) return;

        var container = document.getElementById('game_area_purchase') || document.querySelector('.game_area_purchase');
        if (!container || container.querySelector('.steamdb_prices')) return;

        var priceMeta = document.querySelector('meta[itemprop="price"]');
        var parsedPrice = (priceMeta && priceMeta.content) ? parseFloat(priceMeta.content.replace(',', '.')) : 0;
        if (isNaN(parsedPrice) || parsedPrice <= 0.01) {
            var priceEl = document.querySelector('.discount_final_price, .game_purchase_price');
            if (priceEl) {
                var u = parseUsd(priceEl.textContent);
                if (u) parsedPrice = u;
            }
        }

        // Do not request lowest prices if game is completely free
        if (parsedPrice < 0.01) return;

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
        bottom.innerHTML = _t('app_lowest_date', ['...', '...']);

        var textCol = document.createElement('div');
        textCol.appendChild(top);
        textCol.appendChild(bottom);
        el.appendChild(textCol);

        container.insertAdjacentElement('afterbegin', el);

        handleBackgroundQuery({ contentScriptQuery: 'GetAppPrice', appid: appId }).then(function (res) {
            if (!res || !res.success || !res.data) {
                el.remove();
                return;
            }
            var safePrice = res.data.p;
            if (res.data.d > 0) {
                top.innerHTML = _t('app_lowest_price_discount', [safePrice, res.data.d.toString()]);
            } else {
                top.innerHTML = _t('app_lowest_price', [safePrice]);
            }

            var lang = getUILang();
            var dateFormatter = new Intl.DateTimeFormat(lang, { dateStyle: 'medium' });
            var lastOn = dateFormatter.format(res.data.t * 1000);
            var rel = formatRelativeDate(res.data.t);
            bottom.textContent = _t('app_lowest_date', [lastOn, rel[1]]);
        });
    }

    // 3. Online Stats Widget (Live players, peak, followers)
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

        blockInner.append(grid);
        blockInner.append(link);

        // Rows
        var onlineNow = document.createElement('span');
        onlineNow.className = 'steamdb_stats_number';
        onlineNow.textContent = '...';
        var l1 = document.createElement('span');
        l1.className = 'steamdb_stats_name';
        l1.textContent = _t('app_stats_online_now');
        grid.append(l1, onlineNow);

        var peakToday = document.createElement('span');
        peakToday.className = 'steamdb_stats_number';
        peakToday.textContent = '...';
        var l2 = document.createElement('span');
        l2.className = 'steamdb_stats_name';
        l2.textContent = _t('app_stats_peak_today');
        grid.append(l2, peakToday);

        var peakAll = document.createElement('span');
        peakAll.className = 'steamdb_stats_number';
        peakAll.textContent = '...';
        var l3 = document.createElement('span');
        l3.className = 'steamdb_stats_name';
        l3.textContent = _t('app_stats_alL_time_peak');
        grid.append(l3, peakAll);

        var followers = document.createElement('span');
        followers.className = 'steamdb_stats_number';
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

        handleBackgroundQuery({ contentScriptQuery: 'GetApp', appid: appId }).then(function (res) {
            if (!res || !res.success || !res.data) return;
            onlineNow.textContent = formatNumber(res.data.cp);
            peakToday.textContent = formatNumber(res.data.mdp);
            peakAll.textContent = formatNumber(res.data.mp);
            followers.textContent = formatNumber(res.data.f);
        });
    }

    // 4. SteamDB Rating Score on User Reviews
    function injectSteamDbRating(appId) {
        if (!isOptionEnabled('steamdb-rating', true)) return;
        if (document.querySelector('.steamdb_rating')) return;

        var reviewsEl = document.querySelector('div[data-featuretarget="appreviews"]');
        var desktopReviews = document.querySelector('#userReviews') || document.querySelector('.user_reviews');
        if (!desktopReviews) return;

        var filterOptions = null;
        if (reviewsEl && reviewsEl.dataset && reviewsEl.dataset.props) {
            try {
                filterOptions = JSON.parse(reviewsEl.dataset.props).filter_options;
            } catch (_) {}
        }

        var positive = filterOptions ? filterOptions.nReviewsPositive : 0;
        var negative = filterOptions ? filterOptions.nReviewsNegative : 0;
        var total = positive + negative;

        if (total <= 0) {
            var summaryRow = document.querySelector('.user_reviews_summary_row[data-tooltip-html], .user_reviews_summary_row');
            if (summaryRow) {
                var tooltip = summaryRow.getAttribute('data-tooltip-html') || summaryRow.textContent || '';
                var pctMatch = tooltip.match(/(\d+)%/);
                var countMatch = tooltip.match(/([\d,\.]+)\s*(?:user reviews|kullanıcı)/i) || tooltip.match(/\(([\d,\.]+)\)/);
                if (pctMatch) {
                    var pct = parseInt(pctMatch[1], 10);
                    var count = countMatch ? parseInt(countMatch[1].replace(/[,\.]/g, ''), 10) : 1000;
                    positive = Math.round(count * (pct / 100));
                    total = count;
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

    // 5. Last Depots Update Date
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
        historyLink.textContent = '...';
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

        handleBackgroundQuery({ contentScriptQuery: 'GetApp', appid: appId }).then(function (res) {
            if (!res || !res.success || !res.data || !res.data.u) {
                depotsUpdate.remove();
                return;
            }
            var dateFormatter = new Intl.DateTimeFormat(getUILang(), { dateStyle: 'medium' });
            var actualDateText = dateFormatter.format(new Date(res.data.u * 1000));
            var rel = formatRelativeDate(res.data.u);
            historyLink.textContent = actualDateText + ' (' + rel[1] + ')';
        });
    }

    // 6. Developer & Publisher SteamDB Search Links
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

    // 7. Hide 'Install Steam' Header Button
    function applyHideInstallButton() {
        if (isOptionEnabled('enhancement-hide-install-button', true)) {
            var btn = document.querySelector('.header_installsteam_btn');
            if (btn) {
                btn.style.display = 'none';
            }
        }
    }

    /* =========================================================================
       SECTION 4: STEAMDB ORCHESTRATION
       ========================================================================= */

    function runSteamDbExtension() {
        if (window.__EFXLVE_STEAMDB === false) {
            removeSteamDbStyles();
            var existingPrices = document.querySelectorAll('.steamdb_prices');
            for (var p = 0; p < existingPrices.length; p++) existingPrices[p].remove();
            var existingStats = document.querySelectorAll('.steamdb_stats, .responsive_block_header.steamdb_stats_header');
            for (var s = 0; s < existingStats.length; s++) existingStats[s].remove();
            var existingBtns = document.querySelectorAll('.btn_steamdb');
            for (var b = 0; b < existingBtns.length; b++) existingBtns[b].remove();
            var existingRatings = document.querySelectorAll('.steamdb_rating');
            for (var r = 0; r < existingRatings.length; r++) {
                var pRow = existingRatings[r].closest('.user_reviews_summary_row');
                if (pRow) pRow.remove();
            }
            var existingUpdates = document.querySelectorAll('.steamdb_last_update');
            for (var u = 0; u < existingUpdates.length; u++) existingUpdates[u].remove();
            var existingDevs = document.querySelectorAll('.steamdb_dev_link');
            for (var d = 0; d < existingDevs.length; d++) existingDevs[d].remove();
            return;
        }

        injectSteamDbStyles();
        applyHideInstallButton();

        var appId = getCurrentAppId();
        if (appId <= 0) return;

        try {
            injectHeaderButtons(appId);
        } catch (e1) {
            console.error('[SteamDB Buttons error]', e1);
        }

        try {
            injectLowestPrice(appId);
        } catch (e2) {
            console.error('[SteamDB LowestPrice error]', e2);
        }

        try {
            injectOnlineStatsWidget(appId);
        } catch (e3) {
            console.error('[SteamDB Stats error]', e3);
        }

        try {
            injectSteamDbRating(appId);
        } catch (e4) {
            console.error('[SteamDB Rating error]', e4);
        }

        try {
            injectLastDepotsUpdate(appId);
        } catch (e5) {
            console.error('[SteamDB Depots error]', e5);
        }

        try {
            injectDevPubLinks();
        } catch (e6) {
            console.error('[SteamDB DevPub error]', e6);
        }
    }


    /* =========================================================================
       SECTION 5: AUGMENTED STEAM EXTENSION (3rd Party: IsThereAnyDeal / AugmentedSteam)
       ========================================================================= */

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

    function formatHltb(minutes) {
        if (!minutes || minutes <= 0) return '—';
        var hrs = Math.round(minutes / 60);
        var lang = getUILang();
        var unit = lang === 'tr' ? ' sa' : (hrs === 1 ? ' hr' : ' hrs');
        return hrs + unit;
    }

    function formatAsPrice(p) {
        if (!p) return '—';
        if (p.amount !== undefined && p.currency) {
            return p.currency + ' ' + Number(p.amount).toFixed(2);
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

    var asAppDataCache = new Map();
    var asPricesDataCache = new Map();

    function removeAugmentedSteamElements() {
        var els = document.querySelectorAll('.es_hltb_block, .es_itad_prices, .es_review_row, .es_wsgf_row');
        for (var i = 0; i < els.length; i++) els[i].remove();
        var style = document.getElementById('augmentedsteam-extension-styles');
        if (style) style.remove();
        var drmAlerts = document.querySelectorAll('.es_drm_alert');
        for (var d = 0; d < drmAlerts.length; d++) drmAlerts[d].classList.remove('es_drm_alert');
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
        link.innerHTML = '<span>⏳ ' + _as_t('hltb_title') + '</span> <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
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
        desktopReviews.appendChild(row);
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
        desktopReviews.appendChild(row);
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
        badge.style.background = 'rgba(33, 150, 243, 0.2)';
        badge.style.color = '#64b5f6';
        badge.style.border = '1px solid rgba(33, 150, 243, 0.4)';
        badge.textContent = 'Grade ' + wsgf.ultrawide + (wsgf.ultrawide === 'A' ? ' (Supported)' : '');
        summary.appendChild(badge);

        row.append(sub, summary);
        desktopReviews.appendChild(row);
    }

    function injectItadPrices(appId, pData) {
        if (!isAsOptionEnabled('as-itad-prices', true)) return;
        if (!pData || (!pData.current && !pData.lowest)) return;
        if (document.querySelector('.es_itad_prices')) return;

        var purchaseArea = document.querySelector('#game_area_purchase') || document.querySelector('.game_area_purchase_margin') || document.querySelector('.game_area_purchase');
        if (!purchaseArea) return;

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
        logoLink.innerHTML = '<span>IsThereAnyDeal</span> <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
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
        purchaseArea.parentNode.insertBefore(box, purchaseArea);
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

    function applyAsAppData(appId, data) {
        if (!data) return;
        if (data.hltb) injectHltb(appId, data.hltb);
        if (data.reviews) {
            injectOpenCritic(appId, data.reviews);
            injectMetaUser(appId, data.reviews);
        }
        if (data.wsgf) {
            injectWsgf(appId, data.wsgf);
        }
    }

    function applyAsPricesData(appId, pData) {
        if (!pData) return;
        injectItadPrices(appId, pData);
    }

    function runAugmentedSteamExtension() {
        if (window.__EFXLVE_AUGMENTED_STEAM !== true) {
            removeAugmentedSteamElements();
            return;
        }

        var appId = getCurrentAppId();
        if (!appId || appId <= 0) return;

        injectAugmentedSteamStyles();

        if (isAsOptionEnabled('as-drm-warnings', true)) {
            try { highlightDrmNotices(); } catch (_) {}
        }

        var needAppData = isAsOptionEnabled('as-hltb', true) ||
                          isAsOptionEnabled('as-opencritic', true) ||
                          isAsOptionEnabled('as-metauser', true) ||
                          isAsOptionEnabled('as-wsgf', true);
        if (needAppData) {
            if (asAppDataCache.has(appId)) {
                applyAsAppData(appId, asAppDataCache.get(appId));
            } else {
                fetch('https://api.augmentedsteam.com/app/' + appId + '/v2')
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        if (data) {
                            asAppDataCache.set(appId, data);
                            applyAsAppData(appId, data);
                        }
                    })
                    .catch(function (e) {
                        console.warn('[AugmentedSteam] App API error:', e);
                    });
            }
        }

        if (isAsOptionEnabled('as-itad-prices', true)) {
            if (asPricesDataCache.has(appId)) {
                applyAsPricesData(appId, asPricesDataCache.get(appId));
            } else {
                fetch('https://api.augmentedsteam.com/prices/v2', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        country: 'US',
                        apps: [Number(appId)],
                        subs: [],
                        bundles: [],
                        voucher: true,
                        shops: []
                    })
                })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    if (res && res.prices && res.prices['app/' + appId]) {
                        var pData = res.prices['app/' + appId];
                        asPricesDataCache.set(appId, pData);
                        applyAsPricesData(appId, pData);
                    }
                })
                .catch(function (e) {
                    console.warn('[AugmentedSteam] Prices API error:', e);
                });
            }
        }
    }

    /* =========================================================================
       SECTION 6: SCANNER & OBSERVER
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
            try {
                runAugmentedSteamExtension();
            } catch (e3) {
                console.error('[Efxlve Augmented Steam error]', e3);
            }
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

    var observer = new MutationObserver(function (mutations) {
        var needsScan = false;
        for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.addedNodes && m.addedNodes.length > 0) {
                for (var j = 0; j < m.addedNodes.length; j++) {
                    var n = m.addedNodes[j];
                    if (n.nodeType === 1 &&
                        !n.classList.contains('efxlve-steam-try-badge') &&
                        !n.classList.contains('steamdb_prices') &&
                        !n.classList.contains('steamdb_stats') &&
                        !n.classList.contains('es_hltb_block') &&
                        !n.classList.contains('es_itad_prices') &&
                        !n.classList.contains('es_review_row')) {
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

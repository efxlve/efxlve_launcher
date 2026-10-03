/* Store page script injected into the embedded webview.
   Loaded by store_host.rs via include_str. Not a separate bundle.
   Owns library badges and the owned-game call to action.
*/
(function() {
    'use strict';
    document.addEventListener('contextmenu', function(e) { e.preventDefault(); }, true);

    // 1. Text normalization (perfectly cleans Turkish 'İ', 'ı', accents and whitespace)
    function normalizeText(str) {
        return (str || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .trim();
    }

    // SVG icons (ABSOLUTELY NO EMOJI - fully clean inline SVG, flex-aligned without shifting)
    // Library icon: identical to the library icon in the title bar (LayoutGrid / 4 squares)
    var SVG_GRID = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>';
    var SVG_GAMEPAD = SVG_GRID;
    var SVG_PLAY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>';
    var SVG_STAR = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor"/></svg>';
    var SVG_LAUNCH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    var SVG_SHIELD_GRID = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto;"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>';
    var SVG_SHIELD_GAMEPAD = SVG_SHIELD_GRID;
    var SVG_SHIELD_PLAY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto;"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>';

    // 2. Anti-flash, price-area label, PDP button and download-button hiding CSS
    var CSS_TEXT = `
        html, body {
            background-color: #07080d !important;
            color-scheme: dark !important;
        }

        /* Anti-FOUC overlay: holds the page in obsidian until the first paint is ready,
           then fades out smoothly. White flashes/flicker are prevented. */
        #efxlve-store-veil {
            position: fixed !important;
            inset: 0 !important;
            z-index: 2147483647 !important;
            background: #07080d !important;
            pointer-events: none !important;
            opacity: 1 !important;
            transition: opacity 0.22s ease !important;
        }
        #efxlve-store-veil.gone { opacity: 0 !important; }

        /* Fully disable badges on top of images (the user does not want them on images) */
        .efxlve-store-badge {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }

        /* Epic Games Launcher indirme butonunu kesin gizle */
        header a[href*="download" i],
        nav a[href*="download" i],
        a[href*="/download" i],
        a[href*="launcher" i][href*="download" i],
        [data-testid*="download" i],
        [data-component*="Download" i],
        [aria-label*="indir" i],
        [aria-label*="download" i],
        [title*="indir" i],
        [title*="download" i],
        .epic-nav-download,
        #eg-download-btn,
        [class*="downloadButton" i],
        [class*="download-btn" i],
        [class*="downloadLink" i],
        [class*="download_btn" i] {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
            width: 0 !important;
            height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
        }

        /* Library indicator in the price area (NOT on top of the game image!) */
        .efxlve-price-tag {
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            font-size: 12.5px !important;
            font-weight: 700 !important;
            line-height: 1 !important;
            letter-spacing: 0.015em !important;
            white-space: nowrap !important;
            padding: 4px 10px 4px 8px !important;
            border-radius: 6px !important;
            backdrop-filter: blur(8px) !important;
            box-sizing: border-box !important;
            transition: all 0.15s ease !important;
        }
        .efxlve-price-tag.owned {
            background: rgba(0, 116, 228, 0.16) !important;
            border: 1px solid rgba(38, 187, 255, 0.45) !important;
            color: #26bbff !important;
            box-shadow: none !important;
        }
        .efxlve-price-tag.installed {
            background: rgba(99, 102, 241, 0.14) !important;
            border: 1px solid rgba(99, 102, 241, 0.35) !important;
            color: #a5b4fc !important;
            box-shadow: 0 2px 10px rgba(99, 102, 241, 0.18) !important;
        }
        .efxlve-price-tag.wishlist {
            background: rgba(251, 191, 36, 0.12) !important;
            border: 1px solid rgba(251, 191, 36, 0.3) !important;
            color: #fde68a !important;
            box-shadow: 0 2px 10px rgba(251, 191, 36, 0.16) !important;
        }

        /* Detail page Efxlve card */
        .efxlve-pdp-card {
            position: relative !important;
            margin: 14px 0 18px 0 !important;
            padding: 14px 16px !important;
            border-radius: 12px !important;
            background: linear-gradient(145deg, rgba(22, 17, 34, 0.96), rgba(12, 11, 22, 0.98)) !important;
            border: 1px solid rgba(168, 85, 247, 0.35) !important;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
            overflow: hidden !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            backdrop-filter: blur(12px) !important;
        }
        .efxlve-pdp-card.installed {
            border-color: rgba(99, 102, 241, 0.45) !important;
            background: linear-gradient(145deg, rgba(17, 19, 36, 0.96), rgba(11, 12, 24, 0.98)) !important;
        }
        .efxlve-pdp-card-glow {
            position: absolute !important;
            top: -30px !important;
            right: -30px !important;
            width: 110px !important;
            height: 110px !important;
            border-radius: 50% !important;
            background: radial-gradient(circle, rgba(168, 85, 247, 0.28), transparent 70%) !important;
            pointer-events: none !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-card-glow {
            background: radial-gradient(circle, rgba(99, 102, 241, 0.28), transparent 70%) !important;
        }
        .efxlve-pdp-header {
            display: flex !important;
            align-items: center !important;
            gap: 12px !important;
            margin-bottom: 12px !important;
        }
        .efxlve-pdp-icon-shield {
            width: 36px !important;
            height: 36px !important;
            border-radius: 10px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            background: rgba(168, 85, 247, 0.14) !important;
            border: 1px solid rgba(168, 85, 247, 0.35) !important;
            color: #c084fc !important;
            flex-shrink: 0 !important;
            box-shadow: 0 2px 10px rgba(168, 85, 247, 0.18) !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-icon-shield {
            background: rgba(99, 102, 241, 0.14) !important;
            border-color: rgba(99, 102, 241, 0.35) !important;
            color: #a5b4fc !important;
            box-shadow: 0 2px 10px rgba(99, 102, 241, 0.18) !important;
        }
        .efxlve-pdp-titles {
            display: flex !important;
            flex-direction: column !important;
            gap: 3px !important;
        }
        .efxlve-pdp-tag {
            display: inline-flex !important;
            align-items: center !important;
            gap: 5px !important;
            font-size: 10px !important;
            font-weight: 800 !important;
            letter-spacing: 0.08em !important;
            color: #c084fc !important;
            text-transform: uppercase !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-tag {
            color: #a5b4fc !important;
        }
        .efxlve-pdp-dot {
            width: 6px !important;
            height: 6px !important;
            border-radius: 50% !important;
            background: #a855f7 !important;
            box-shadow: 0 0 6px #a855f7 !important;
            display: inline-block !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-dot {
            background: #6366f1 !important;
            box-shadow: 0 0 6px #6366f1 !important;
        }
        .efxlve-pdp-headline {
            font-size: 13.5px !important;
            font-weight: 700 !important;
            color: #f8fafc !important;
            line-height: 1.25 !important;
        }
        .efxlve-pdp-cta-button {
            width: 100% !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 8px !important;
            padding: 10px 16px !important;
            border-radius: 8px !important;
            font-size: 13px !important;
            font-weight: 700 !important;
            letter-spacing: 0.02em !important;
            cursor: pointer !important;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
            border: 1px solid rgba(255, 255, 255, 0.16) !important;
            background: linear-gradient(135deg, #7c3aed, #a855f7) !important;
            color: #ffffff !important;
            box-shadow: 0 4px 16px rgba(124, 58, 237, 0.38) !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-cta-button {
            background: linear-gradient(135deg, #4f46e5, #6366f1) !important;
            box-shadow: 0 4px 16px rgba(99, 102, 241, 0.38) !important;
        }
        .efxlve-pdp-cta-button:hover {
            transform: translateY(-1.5px) !important;
            filter: brightness(1.1) !important;
            box-shadow: 0 6px 22px rgba(124, 58, 237, 0.55) !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-cta-button:hover {
            box-shadow: 0 6px 22px rgba(99, 102, 241, 0.55) !important;
        }
        .efxlve-pdp-cta-button:active {
            transform: translateY(0) !important;
            filter: brightness(0.95) !important;
        }
        .efxlve-pdp-btn-chevron {
            margin-left: auto !important;
            opacity: 0.8 !important;
            transition: transform 0.15s ease !important;
        }
        .efxlve-pdp-cta-button:hover .efxlve-pdp-btn-chevron {
            transform: translateX(2px) !important;
            opacity: 1 !important;
        }
    `;

    function injectStyle(targetRoot) {
        try {
            var root = targetRoot || document.head || document.documentElement;
            if (!root) return false;
            if (root.querySelector && root.querySelector('#efxlve-store-style')) return true;
            var s = document.createElement('style');
            s.id = 'efxlve-store-style';
            s.textContent = CSS_TEXT;
            root.appendChild(s);
            return true;
        } catch(e) {
            return false;
        }
    }
    injectStyle();

    // 2b. Install the anti-FOUC overlay as early as possible, remove it smoothly on first paint.
    function installVeil() {
        try {
            if (document.getElementById('efxlve-store-veil')) return;
            var veil = document.createElement('div');
            veil.id = 'efxlve-store-veil';
            (document.body || document.documentElement).appendChild(veil);
            var revealed = false;
            function reveal() {
                if (revealed) return;
                revealed = true;
                var el = document.getElementById('efxlve-store-veil');
                if (!el) return;
                el.classList.add('gone');
                setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
            }
            if (document.readyState === 'complete') {
                requestAnimationFrame(reveal);
            } else {
                window.addEventListener('load', function() { requestAnimationFrame(reveal); }, { once: true });
            }
            // Safety net: even on a very slow network the overlay never stays permanently.
            setTimeout(reveal, 2500);
        } catch(e) {}
    }
    installVeil();

    // 3. Function that definitively hides the "Download" button at the top right
    function hideDownloadButton() {
        try {
            function scanTree(root) {
                if (!root) return;
                var sel = [
                    'header a[href*="download" i]',
                    'nav a[href*="download" i]',
                    'a[href*="/download" i]',
                    'a[href*="launcher" i][href*="download" i]',
                    '[data-testid*="download" i]',
                    '[data-component*="Download" i]',
                    '[aria-label*="indir" i]',
                    '[aria-label*="download" i]',
                    '[title*="indir" i]',
                    '[title*="download" i]',
                    '.epic-nav-download',
                    '#eg-download-btn',
                    '[class*="downloadButton" i]',
                    '[class*="download-btn" i]',
                    '[class*="downloadLink" i]',
                    '[class*="download_btn" i]'
                ].join(',');
                var elements = root.querySelectorAll(sel);
                for (var i = 0; i < elements.length; i++) {
                    var el = elements[i];
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('visibility', 'hidden', 'important');
                    el.style.setProperty('pointer-events', 'none', 'important');
                    if (el.parentElement && (el.parentElement.tagName === 'LI' || el.parentElement.tagName === 'DIV')) {
                        el.parentElement.style.setProperty('display', 'none', 'important');
                    }
                }

                var candidates = root.querySelectorAll('header a, header button, nav a, nav button');
                for (var j = 0; j < candidates.length; j++) {
                    var c = candidates[j];
                    var norm = normalizeText(c.textContent);
                    var href = (c.getAttribute('href') || '').toLowerCase();
                    var isDl = (
                        norm === 'indir' ||
                        norm === 'download' ||
                        norm === 'get epic games' ||
                        norm === 'telecharger' ||
                        norm === 'herunterladen' ||
                        norm === 'descargar' ||
                        norm === 'scarica' ||
                        norm === 'baixe o epic games' ||
                        norm.indexOf('epic games\'i indir') !== -1 ||
                        norm.indexOf('epic games\'i indirin') !== -1 ||
                        norm.indexOf('epic games indir') !== -1 ||
                        href.indexOf('download') !== -1 ||
                        href.indexOf('installer') !== -1
                    );
                    if (isDl) {
                        c.style.setProperty('display', 'none', 'important');
                        c.style.setProperty('visibility', 'hidden', 'important');
                        c.style.setProperty('pointer-events', 'none', 'important');
                        if (c.parentElement && (c.parentElement.tagName === 'LI' || c.parentElement.tagName === 'DIV')) {
                            c.parentElement.style.setProperty('display', 'none', 'important');
                        }
                    }
                }

            }

            scanTree(document);
        } catch(e) {}
    }

    var dlCheckCount = 0;
    var dlCheckTimer = setInterval(function() {
        hideDownloadButton();
        dlCheckCount++;
        if (dlCheckCount > 6) clearInterval(dlCheckTimer);
    }, 500);

    // 4. Multi-language dictionary (ABSOLUTELY NO EMOJI)
    function getI18n() {
        var lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
        var dict;
        if (lang.indexOf('tr') === 0) {
            dict = {
                owned: 'Kütüphanede',
                installed: 'Yüklü',
                wishlist: 'İstek Listesinde',
                pdpOwned: 'Bu oyun Efxlve kütüphanenizde var',
                pdpInstalled: 'Bu oyun sisteminizde kurulu',
                ctaOpen: 'Kütüphanede Aç',
                ctaLaunch: 'Kütüphaneden Başlat'
            };
        } else if (lang.indexOf('de') === 0) {
            dict = {
                owned: 'In Bibliothek',
                installed: 'Installiert',
                wishlist: 'Wunschliste',
                pdpOwned: 'Dieses Spiel ist in deiner Efxlve-Bibliothek',
                pdpInstalled: 'Dieses Spiel ist installiert',
                ctaOpen: 'In Bibliothek öffnen',
                ctaLaunch: 'Aus Bibliothek starten'
            };
        } else {
            dict = {
                owned: 'In Library',
                installed: 'Installed',
                wishlist: 'In Wishlist',
                pdpOwned: 'You already own this game in your Efxlve Library',
                pdpInstalled: 'This game is installed on this PC',
                ctaOpen: 'Open in Library',
                ctaLaunch: 'Launch from Library'
            };
        }
        if (window.__EFXLVE_OWNED_LABEL) dict.owned = window.__EFXLVE_OWNED_LABEL;
        return dict;
    }

    // Function that strips editions and suffixes (GTA V Premium Edition -> GTA 5, Watch Dogs 2 Standard Edition -> Watch Dogs 2)
    function stripEdition(title) {
        if (!title) return '';
        var s = normalizeText(title);
        // Remove edition / version phrases after a colon or dash
        s = s.replace(/\benhanced edition\b/gi, '');
        s = s.replace(/[:\-â€“â€”]\s*(standard|deluxe|gold|premium|definitive|ultimate|special|complete|anniversary|director'?s cut|remastered|goty|game of the year).*/i, '');
        
        // Remove edition words
        s = s.replace(/\b(standard|deluxe|gold|premium|definitive|ultimate|special|complete|anniversary|goty|game of the year)\s*(edition|surum|sürüm)?\b/gi, '');
        s = s.replace(/\b(director'?s cut|remastered|base game|ana oyun|temel oyun|edition|sürüm|surum)\b/gi, '');

        // Common game abbreviations (GTA V / GTA 5)
        s = s.replace(/\bgrand theft auto\b/gi, 'gta');
        s = s.replace(/\bgta\s*v\b/gi, 'gta 5');

        return s.replace(/[^a-z0-9]+/g, ' ').trim();
    }

    // Function that strips edition suffixes from URL slugs
    function stripSlugEdition(slug) {
        if (!slug) return '';
        var s = slug.toLowerCase();
        s = s.replace(/-(standard|deluxe|gold|premium|definitive|ultimate|special|complete|anniversary|collectors|goty|game-of-the-year)(-(edition|surum|paketi))?$/i, '');
        s = s.replace(/-enhanced-edition$/i, '');
        s = s.replace(/-(directors-cut|director-s-cut|remastered|remaster)$/i, '');
        s = s.replace(/-(edition|bundle|base-game)$/i, '');
        return s;
    }

    // 5. Slug and title map
    var slugMap = {};
    var strippedSlugMap = {};
    var titleMap = {};
    var strippedTitleMap = {};
    var ownedGamesList = [];
    if (window.__EFXLVE_GAMES && Array.isArray(window.__EFXLVE_GAMES)) {
        ownedGamesList = window.__EFXLVE_GAMES;
        for (var i = 0; i < window.__EFXLVE_GAMES.length; i++) {
            var item = window.__EFXLVE_GAMES[i];
            if (item) {
                if (item.s) {
                    slugMap[item.s] = item;
                    var strippedS = stripSlugEdition(item.s);
                    if (strippedS) strippedSlugMap[strippedS] = item;
                }
                if (item.t) {
                    var normT = normalizeText(item.t);
                    titleMap[normT] = item;
                    var cleanT = normT.replace(/[^a-z0-9]+/g, '');
                    if (cleanT) titleMap[cleanT] = item;
                    var tSlug = normT.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                    if (tSlug) slugMap[tSlug] = item;

                    var st = stripEdition(item.t);
                    if (st) strippedTitleMap[st] = item;
                }
            }
        }
    }

    // Safe and exact game matching (prevents collisions between sequels/spinoffs)
    function matchGame(card, href) {
        var slug = '';
        if (href) {
            var m = href.match(/\/p\/([a-z0-9-]+)/i) || href.match(/\/bundles\/([a-z0-9-]+)/i);
            if (m && m[1]) slug = m[1].toLowerCase();
        }

        // 1. Direct and edition-stripped slug match
        if (slug) {
            if (slugMap[slug]) return slugMap[slug];
            var strippedSlug = stripSlugEdition(slug);
            if (strippedSlug && strippedSlugMap[strippedSlug]) {
                return strippedSlugMap[strippedSlug];
            }
        }

        // 2. Card title detection
        var titleEl = card.querySelector('[data-testid*="title" i], [class*="title" i], [class*="Title" i], h1, h2, h3, h4');
        var rawTitle = titleEl ? (titleEl.textContent || '').trim() : '';
        if (!rawTitle && (card === document || card === document.body)) {
            var docH1 = document.querySelector('h1');
            if (docH1) rawTitle = (docH1.textContent || '').trim();
            if (!rawTitle && document.title) {
                rawTitle = document.title.split('|')[0].split(' - ')[0].trim();
            }
        }
        if (!rawTitle) {
            var spans = card.querySelectorAll('span, div, p');
            for (var s = 0; s < spans.length; s++) {
                var txt = (spans[s].textContent || '').trim();
                if (txt.length >= 3 && txt.length <= 60 && !txt.startsWith('â‚º') && !txt.startsWith('$') && !txt.startsWith('â‚¬') && txt !== 'Ana Oyun' && txt !== 'Eklenti' && txt !== 'Temel Oyun') {
                    if (titleMap[normalizeText(txt)]) {
                        rawTitle = txt;
                        break;
                    }
                }
            }
        }

        // 3. Title match (exact and edition-stripped)
        if (rawTitle) {
            var norm = normalizeText(rawTitle);
            if (titleMap[norm]) return titleMap[norm];

            var clean = norm.replace(/[^a-z0-9]+/g, '');
            if (clean && titleMap[clean]) return titleMap[clean];

            var titleSlug = norm.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            if (titleSlug && slugMap[titleSlug]) return slugMap[titleSlug];

            // Exact edition-stripped match (e.g. GTA V Premium Edition -> GTA 5, Watch Dogs 2 Standard Edition -> Watch Dogs 2)
            var strippedCardTitle = stripEdition(rawTitle);
            if (strippedCardTitle && strippedTitleMap[strippedCardTitle]) {
                return strippedTitleMap[strippedCardTitle];
            }
        }

        return null;
    }

    function isCardRoot(el) {
        if (!el || el === document.body) return true;
        if (el.tagName === 'A' || el.tagName === 'ARTICLE' || el.tagName === 'LI') return true;
        var c = (el.className || '').toString();
        if (/card/i.test(c)) return true;
        if (el.getAttribute('data-component') && /card/i.test(el.getAttribute('data-component'))) return true;
        return false;
    }

    // Finds the price container inside a card (discounted or standard price row)
    function getPriceContainer(card) {
        // 1. Discounted card: if a discount badge (-95%, -50%, etc.) exists, its parent is the whole price row
        var all = card.querySelectorAll('span, div, p');
        var discountEl = null;
        for (var i = 0; i < all.length; i++) {
            var t = (all[i].textContent || '').trim();
            if (/^-\s*%?\s*\d+%?$/.test(t) || all[i].matches('[class*="discount" i], [class*="Discount" i]')) {
                discountEl = all[i];
                break;
            }
        }
        if (discountEl && discountEl.parentElement && !isCardRoot(discountEl.parentElement)) {
            return discountEl.parentElement;
        }

        // 2. Standard price component (data-component or class based)
        var priceEl = card.querySelector('[data-component*="Price" i], [class*="price" i], [class*="Price" i], [data-testid*="price" i]');
        if (priceEl) {
            if (priceEl.parentElement && !isCardRoot(priceEl.parentElement) && priceEl.parentElement.querySelectorAll('span, div').length > 1) {
                return priceEl.parentElement;
            }
            return priceEl;
        }

        // 3. Detect price / free / release date from text content
        for (var j = all.length - 1; j >= 0; j--) {
            var txt = (all[j].textContent || '').trim();
            if (/^[₺$€£]|ücretsiz|ucretsiz|free|\d+[,.]\d{2}/i.test(txt)) {
                if (txt !== 'Ana Oyun' && txt !== 'Eklenti' && txt !== 'Temel Oyun' && txt !== 'Sürüm' && txt !== 'Surum') {
                    if (all[j].parentElement && !isCardRoot(all[j].parentElement) && all[j].parentElement.querySelectorAll('span, div').length > 1) {
                        return all[j].parentElement;
                    }
                    return all[j];
                }
            }
        }

        // 4. Title container fallback
        var titleEl = card.querySelector('[data-testid*="title" i], [class*="title" i], [class*="Title" i], h2, h3, h4');
        if (titleEl && titleEl.parentElement && !isCardRoot(titleEl.parentElement)) {
            return titleEl.parentElement;
        }

        return null;
    }

    // Finds the detail page purchase / library container and the action button
    function findPdpTarget() {
        var allBtns = document.querySelectorAll('button, a[role="button"], div[role="button"]');
        var actionBtn = null;
        for (var i = 0; i < allBtns.length; i++) {
            var b = allBtns[i];
            if (b.classList.contains('efxlve-pdp-cta-button')) continue;
            var btxt = normalizeText(b.textContent);
            if (
                btxt === 'kutuphanede' ||
                btxt === 'in library' ||
                btxt === 'yukle' ||
                btxt === 'indir' ||
                btxt === 'satin al' ||
                btxt === 'get' ||
                btxt.indexOf('kutuphanede') !== -1 ||
                btxt.indexOf('in library') !== -1 ||
                btxt.indexOf('satin al') !== -1
            ) {
                actionBtn = b;
                break;
            }
        }

        var box = document.querySelector('aside, [data-component*="Purchase" i], [data-component*="Sidebar" i], [class*="SideBar" i], [class*="sidebar" i], [data-testid*="purchase" i]');
        if (box) return { container: box, insertBefore: (actionBtn && actionBtn.parentElement === box ? actionBtn : box.firstChild), button: actionBtn };

        if (actionBtn) {
            var col = actionBtn.closest('aside, [class*="side" i], [class*="Side" i], section');
            if (col) return { container: col, insertBefore: col.firstChild, button: actionBtn };
            if (actionBtn.parentElement) {
                var parent = actionBtn.parentElement;
                while (parent && parent !== document.body && parent.children.length < 2) {
                    parent = parent.parentElement;
                }
                if (parent && parent !== document.body) {
                    return { container: parent, insertBefore: actionBtn.parentElement || actionBtn, button: actionBtn };
                }
                return { container: actionBtn.parentElement, insertBefore: actionBtn, button: actionBtn };
            }
        }

        var layoutCols = document.querySelectorAll('[data-component*="Layout" i] > div, [class*="Layout" i] > div');
        if (layoutCols.length >= 2) {
            var rightCol = layoutCols[layoutCols.length - 1];
            return { container: rightCol, insertBefore: rightCol.firstChild, button: actionBtn };
        }

        return null;
    }

    var isScanning = false;
    function scanAndDecorate() {
        if (isScanning) return;
        // A parked storefront is hidden: scanning its DOM only burns CPU while the
        // player is somewhere else in the launcher.
        if (document.visibilityState === 'hidden') return;
        isScanning = true;
        try {
            injectStyle();
            hideDownloadButton();
            var i18n = getI18n();

            // Fully remove old on-image badges from the DOM
            var legacyBadges = document.querySelectorAll('.efxlve-store-badge');
            for (var b = 0; b < legacyBadges.length; b++) {
                legacyBadges[b].remove();
            }

            var curPath = window.location.pathname.toLowerCase();
            var curPdpMatch = curPath.match(/\/p\/([a-z0-9-]+)/i);
            var currentPdpSlug = curPdpMatch ? curPdpMatch[1].toLowerCase() : null;

            // A. Store cards (library indicator in the price area)
            var links = document.querySelectorAll('a[href*="/p/"], a[href*="/bundles/"]');
            for (var i = 0; i < links.length; i++) {
                var link = links[i];

                if (link.closest('nav, header, [role="tablist"], [role="tab"], [data-component*="Tab"], [data-component*="Breadcrumb"], [class*="breadcrumb" i]')) {
                    continue;
                }

                var href = link.getAttribute('href') || '';
                var card = link.closest('[data-component*="Card" i], [class*="Card" i], [class*="card" i], li, article') || link;

                if (currentPdpSlug && href.toLowerCase().indexOf('/p/' + currentPdpSlug) !== -1) {
                    continue;
                }

                var match = matchGame(card, href);
                if (match) {
                    var priceContainer = getPriceContainer(card);
                    if (priceContainer) {
                        var isInstalled = !!match.i;
                        var existingTag = priceContainer.querySelector('.efxlve-price-tag');
                        var needsRender = (priceContainer.getAttribute('data-efxlve-owned') !== match.a) ||
                                          !existingTag ||
                                          (isInstalled && !existingTag.classList.contains('installed')) ||
                                          (!isInstalled && !existingTag.classList.contains('owned'));

                        if (needsRender) {
                            priceContainer.setAttribute('data-efxlve-owned', match.a);
                            priceContainer.innerHTML = '<span class="efxlve-price-tag ' + (isInstalled ? 'installed' : 'owned') + '">' +
                                (isInstalled ? SVG_PLAY : SVG_GRID) +
                                '<span>' + (isInstalled ? i18n.installed : i18n.owned) + '</span>' +
                                '</span>';
                        }

                        // On discounted cards, definitively hide old discount badges (-95%) and strikethrough prices.
                        // This walks every text node in the card, so it runs once per card DOM node: a
                        // re-rendered card arrives as a new node and is swept again, while repeated scans of
                        // the same card stay cheap.
                        if (!card.dataset || card.dataset.efxlveSwept !== '1') {
                            if (card.dataset) card.dataset.efxlveSwept = '1';
                            var leftovers = card.querySelectorAll('[class*="discount" i], [class*="Discount" i], s, del, [class*="strike" i], [class*="original" i]');
                            for (var d = 0; d < leftovers.length; d++) {
                                if (leftovers[d] !== priceContainer && !priceContainer.contains(leftovers[d])) {
                                    leftovers[d].style.setProperty('display', 'none', 'important');
                                }
                            }
                            var allDesc = card.querySelectorAll('span, div, p');
                            for (var ad = 0; ad < allDesc.length; ad++) {
                                var elDesc = allDesc[ad];
                                if (elDesc === priceContainer || priceContainer.contains(elDesc)) continue;
                                var dtxt = (elDesc.textContent || '').trim();
                                if (/^-\s*%?\s*\d+%?$/.test(dtxt)) {
                                    elDesc.style.setProperty('display', 'none', 'important');
                                } else if (/\*\s*$/.test(dtxt) && /^[₺$€£]|\d+[.,]\d{2}/.test(dtxt)) {
                                    elDesc.style.setProperty('display', 'none', 'important');
                                }
                            }
                        }
                    }
                    continue;
                } else {
                    var strayOwned = card.querySelector('[data-efxlve-owned]');
                    if (strayOwned) {
                        strayOwned.removeAttribute('data-efxlve-owned');
                        var strayTag = strayOwned.querySelector('.efxlve-price-tag');
                        if (strayTag) strayTag.remove();
                    }
                }

                // Wishlist check (added to the price area)
                var wishBtn = card.querySelector('button[aria-label*="istek" i], button[aria-label*="wishlist" i], [data-testid*="wishlist" i]');
                if (wishBtn) {
                    var aria = normalizeText(wishBtn.getAttribute('aria-label'));
                    var pressed = wishBtn.getAttribute('aria-pressed') === 'true';
                    if (pressed || aria.indexOf('kaldir') !== -1 || aria.indexOf('remove') !== -1) {
                        var priceElWish = getPriceContainer(card);
                        if (priceElWish && !priceElWish.getAttribute('data-efxlve-owned')) {
                            if (priceElWish.getAttribute('data-efxlve-wishlist') !== '1') {
                                priceElWish.setAttribute('data-efxlve-wishlist', '1');
                                priceElWish.innerHTML = '<span class="efxlve-price-tag wishlist">' +
                                    SVG_STAR +
                                    '<span>' + i18n.wishlist + '</span>' +
                                    '</span>';
                            }
                        }
                    }
                }
            }

            // B. Product Detail Page (PDP)
            if (currentPdpSlug) {
                var pageH1 = '';
                var h1El = document.querySelector('h1');
                if (h1El) pageH1 = (h1El.textContent || '').trim();
                var docTitle = document.title ? document.title.split('|')[0].split(' - ')[0].trim() : '';

                var pMatch = matchGame(document, window.location.pathname);
                if (!pMatch) pMatch = slugMap[currentPdpSlug];
                if (!pMatch) {
                    var strippedPdp = stripSlugEdition(currentPdpSlug);
                    if (strippedPdp) pMatch = strippedSlugMap[strippedPdp];
                }
                if (!pMatch && pageH1) {
                    var normH1 = normalizeText(pageH1);
                    if (titleMap[normH1]) pMatch = titleMap[normH1];
                    else if (strippedTitleMap[stripEdition(pageH1)]) pMatch = strippedTitleMap[stripEdition(pageH1)];
                }
                if (!pMatch && docTitle) {
                    var normDoc = normalizeText(docTitle);
                    if (titleMap[normDoc]) pMatch = titleMap[normDoc];
                    else if (strippedTitleMap[stripEdition(docTitle)]) pMatch = strippedTitleMap[stripEdition(docTitle)];
                }

                // Find the page's action button and purchase container
                var pdpTarget = findPdpTarget();
                var pageHasOwnedBtn = false;
                if (pdpTarget && pdpTarget.button) {
                    var btxt = normalizeText(pdpTarget.button.textContent);
                    var baria = normalizeText(pdpTarget.button.getAttribute('aria-label'));
                    if (btxt === 'kutuphanede' || btxt === 'in library' || baria.indexOf('kutuphane') !== -1 || baria.indexOf('in library') !== -1) {
                        pageHasOwnedBtn = true;
                    }
                }

                // If the Epic Store itself says "In Library" but the slug did not match, fuzzy search / safe fallback
                if (!pMatch && pageHasOwnedBtn) {
                    var targetTokens = (pageH1 || docTitle || currentPdpSlug).toLowerCase();
                    for (var og = 0; og < ownedGamesList.length; og++) {
                        var ogItem = ownedGamesList[og];
                        var ogNorm = normalizeText(ogItem.t);
                        if (ogNorm && (targetTokens.indexOf(ogNorm) !== -1 || ogNorm.indexOf(targetTokens) !== -1)) {
                            pMatch = ogItem;
                            break;
                        }
                    }
                    if (!pMatch) {
                        pMatch = {
                            a: '',
                            t: pageH1 || docTitle || currentPdpSlug,
                            s: currentPdpSlug,
                            i: false
                        };
                    }
                }

                // The custom Efxlve card on top was removed; Epic's own active blue button is used
                var strayCards = document.querySelectorAll('.efxlve-pdp-card, .efxlve-pdp-banner');
                for (var sc = 0; sc < strayCards.length; sc++) {
                    strayCards[sc].remove();
                }

                // Capture Epic's own "In Library" button, remove disabled and route to the library
                var epicButtons = document.querySelectorAll('button, a, div[role="button"]');
                for (var ebIndex = 0; ebIndex < epicButtons.length; ebIndex++) {
                    var eb = epicButtons[ebIndex];
                    var ebTxt = normalizeText(eb.textContent);
                    var ebAria = normalizeText(eb.getAttribute('aria-label'));
                    if (ebTxt === 'kutuphanede' || ebTxt === 'in library' || ebAria.indexOf('kutuphane') !== -1 || ebAria.indexOf('in library') !== -1) {
                        eb.removeAttribute('disabled');
                        eb.disabled = false;
                        eb.removeAttribute('aria-disabled');
                        eb.style.setProperty('cursor', 'pointer', 'important');
                        eb.style.setProperty('pointer-events', 'auto', 'important');
                        eb.style.setProperty('opacity', '1', 'important');
                        eb.title = getI18n().ctaOpen;
                        if (!eb.getAttribute('data-efxlve-hijacked')) {
                            eb.setAttribute('data-efxlve-hijacked', '1');
                            eb.addEventListener('click', function(ev) {
                                ev.preventDefault();
                                ev.stopPropagation();
                                ev.stopImmediatePropagation();
                                var app = (pMatch && pMatch.a) ? pMatch.a : '';
                                var slug = (pMatch && pMatch.s) ? pMatch.s : (currentPdpSlug || '');
                                var title = (pMatch && pMatch.t) ? pMatch.t : (pageH1 || docTitle || '');
                                window.location.href = 'https://efxlve.local/open-game?app=' + encodeURIComponent(app) + '&slug=' + encodeURIComponent(slug) + '&title=' + encodeURIComponent(title);
                            }, true);
                        }
                    }
                }
            } else {
                var strayPdp = document.querySelectorAll('.efxlve-pdp-card, .efxlve-pdp-banner');
                for (var sp = 0; sp < strayPdp.length; sp++) {
                    strayPdp[sp].remove();
                }
            }
        } catch(e) {
        } finally {
            isScanning = false;
        }
    }

    var debounceTimer = null;
    function scheduleScan() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(scanAndDecorate, 350);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        scheduleScan();
    } else {
        document.addEventListener('DOMContentLoaded', scheduleScan);
        window.addEventListener('load', scheduleScan);
    }

    window.addEventListener('popstate', scheduleScan);
    try {
        var origPush = history.pushState;
        if (origPush) {
            history.pushState = function() {
                var ret = origPush.apply(this, arguments);
                scheduleScan();
                return ret;
            };
        }
        var origRepl = history.replaceState;
        if (origRepl) {
            history.replaceState = function() {
                var ret = origRepl.apply(this, arguments);
                scheduleScan();
                return ret;
            };
        }
    } catch(e) {}

    // Safety net for a storefront that replaces text without adding nodes.
    // A full DOM walk every few seconds is what made the embedded store hitch;
    // history changes and added nodes already schedule a scan.
    var lastScanPath = '';
    setInterval(function() {
        if (document.visibilityState !== 'visible') return;
        if (window.location.pathname === lastScanPath) return;
        lastScanPath = window.location.pathname;
        scheduleScan();
    }, 8000);

    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') scheduleScan();
    });

    try {
        function addedByUs(node) {
            if (!node || node.nodeType !== 1) return true;
            var cls = node.classList;
            if (cls && (cls.contains('efxlve-price-tag') || cls.contains('efxlve-store-badge') || cls.contains('efxlve-pdp-card') || cls.contains('efxlve-pdp-banner'))) return true;
            if (node.id === 'efxlve-store-veil' || node.id === 'efxlve-store-style') return true;
            return false;
        }
        var obs = new MutationObserver(function(mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var nodes = mutations[i].addedNodes;
                if (!nodes) continue;
                for (var j = 0; j < nodes.length; j++) {
                    if (!addedByUs(nodes[j])) {
                        scheduleScan();
                        return;
                    }
                }
            }
        });
        var startObserver = function() {
            if (document.body) {
                obs.observe(document.body, { childList: true, subtree: true });
            } else {
                setTimeout(startObserver, 150);
            }
        };
        startObserver();
    } catch(e) {}
})();

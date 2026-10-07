//! Dark theme for storefronts that only ship a light one.
//!
//! The Xbox store renders a white page (`.appBackground`) and its Microsoft
//! header arrives with the `uhf-theme--light` class. The header has its own
//! dark theme, so flipping that class beats repainting every control by hand;
//! the page surfaces and card components are painted with the launcher's own
//! dark obsidian palette (`#0e0f12` and `#14151a`).
//!
//! An anti-FOUC veil covers the view from frame 0 and lifts smoothly once the
//! page and styles have painted, preventing white flashes ("flashbang").

/// Injected into the Xbox storefront webview.
pub const XBOX_DARK_SCRIPT: &str = r#"
(function () {
  // The initialization script and the PageLoadEvent::Finished eval both run on
  // one load. Without this guard the second run stacked another observer and
  // interval, and dropped the anti-FOUC veil over an already painted page.
  if (window.__EFXLVE_XBOX_THEME__) return;
  window.__EFXLVE_XBOX_THEME__ = true;

  var CSS = [
    // Ensure root and body are immediately painted in obsidian and declare dark color-scheme
    'html { background-color: #0e0f12 !important; color-scheme: dark !important; }',
    'html, body { background-color: #0e0f12 !important; color-scheme: dark !important; }',
    '.appBackground, #root, main, div[class*="pageContainer"], div[class*="PageContainer"], div[class*="browsePage"], div[class*="BrowsePage"] { background: #0e0f12 !important; color: #e8e8e8 !important; }',

    // Anti-FOUC overlay: shields the view in dark obsidian until the page styles are ready
    '#efxlve-store-veil { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; background: #0e0f12 !important; pointer-events: none !important; opacity: 1 !important; transition: opacity 0.22s ease !important; }',
    '#efxlve-store-veil.gone { opacity: 0 !important; }',

    // Microsoft UHF Header
    'header.uhf-header { background: #14151a !important; }',
    'header.uhf-header, header.uhf-header * { color: #e8e8e8 !important; }',
    '.uhf-search-input { background: #1c1d23 !important; color: #e8e8e8 !important; border-color: rgba(255,255,255,0.16) !important; }',
    '.uhf-autosuggest, .uhf-dropdown-menu, .c-uhff-lang-selector { background: #1c1d23 !important; color: #e8e8e8 !important; }',

    // Product cards (Xbox browse cards)
    '[class*="ProductCard-module__cardWrapper"] a, [class*="productCard"] a, [class*="ProductCard"] a, div[class*="cardWrapper"] a { background: #14151a !important; color: #e8e8e8 !important; border: 1px solid rgba(255, 255, 255, 0.08) !important; border-radius: 8px !important; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4) !important; }',
    '[class*="ProductCard-module__cardWrapper"]:hover a, [class*="ProductCard-module__cardWrapper"]:focus a, div[class*="cardWrapper"]:hover a { background: #1c1d23 !important; border-color: rgba(255, 255, 255, 0.22) !important; transform: translateY(-2px); }',
    '[class*="ProductCard-module__infoBox"], [class*="infoBox"], [class*="InfoBox"] { background: transparent !important; color: #e8e8e8 !important; }',
    '[class*="ProductCard-module__title"], [class*="ProductCard-module__singleLineTitle"], [class*="cardTitle"] { color: #ffffff !important; }',
    '[class*="ProductCard-module__price"], [class*="Price-module"], [class*="priceGroup"] { color: #e0e0e0 !important; }',
    '[class*="Price-module__originalPrice"] { color: #8a8d98 !important; }',
    '[class*="LoadingProductGrid-module__card"] { background-color: #14151a !important; border-radius: 8px !important; }',
    '[class*="badges"], [class*="badges"] * { color: #101010 !important; }',

    // Filter sidebar accordion buttons & Sort dropdown button
    'button[class*="SelectionDropdown-module__titleContainer"], [class*="SelectionDropdown-module__titleContainer"], [class*="Selections-module__titleContainer"], button[class*="Selections-module__titleContainer"] { background: #14151a !important; background-color: #14151a !important; color: #e8e8e8 !important; border: 1px solid rgba(255, 255, 255, 0.1) !important; border-radius: 6px !important; box-shadow: none !important; filter: none !important; }',
    'button[class*="SelectionDropdown-module__titleContainer"]:hover, [class*="SelectionDropdown-module__titleContainer"]:hover, [class*="Selections-module__titleContainer"]:hover { background-color: #1c1d23 !important; border-color: rgba(255, 255, 255, 0.22) !important; }',
    '[class*="SelectionDropdown-module__titleText"], [class*="Selections-module__titleText"], [class*="Selections-module__label"], [class*="Selections-module__textColor"] { color: #ffffff !important; }',
    '[class*="SelectionDropdown-module__icon"], [class*="Selections-module__icon"], [class*="SelectionDropdown-module__chevronIcon"], [class*="Selections-module__chevronIcon"], [class*="SelectionDropdown-module__icon"] svg, [class*="Selections-module__icon"] svg { fill: #e8e8e8 !important; color: #e8e8e8 !important; }',
    '[class*="SelectionDropdown-module__selectedLabel"] { background: #242630 !important; border-color: rgba(255, 255, 255, 0.2) !important; color: #ffffff !important; }',

    // Expanded filter options list
    '[class*="Selections-module__container"], [class*="SelectionDropdown-module__container"], [class*="LoadingFilters-module__filtersPanel"] { background-color: #14151a !important; color: #e8e8e8 !important; border: 1px solid rgba(255, 255, 255, 0.08) !important; border-radius: 6px !important; }',
    '[class*="Selections-module__selectionContainer"]:hover { background-color: rgba(255, 255, 255, 0.06) !important; border-radius: 4px !important; }',

    // Filter action chips & "Clear all filters" button
    '[class*="StackFilters-module__buttonContainer"], [class*="SortAndFilters-module__clearAllButtonContainer"], [class*="FiltersPanel-module__clearAllButtonContainer"] { background-color: #1c1d23 !important; border: 1px solid rgba(255, 255, 255, 0.14) !important; border-radius: 6px !important; opacity: 1 !important; }',
    '[class*="StackFilters-module__buttonContainer"]:hover, [class*="SortAndFilters-module__clearAllButtonContainer"]:hover, [class*="FiltersPanel-module__clearAllButtonContainer"]:hover { background-color: #252730 !important; border-color: rgba(255, 255, 255, 0.26) !important; }',
    '[class*="StackFilters-module__buttonContainer"] *, [class*="SortAndFilters-module__clearAllButtonContainer"] *, [class*="FiltersPanel-module__clearAllButtonContainer"] * { color: #e8e8e8 !important; fill: #e8e8e8 !important; }',

    // Flyouts, Popovers, Modals & Pickers (e.g. Sort menu options)
    '[class*="ButtonWithFlyout-module__flyout"], [class*="SortAndFilters-module__modalContainer"], [class*="FiltersPanel-module__modalContainer"], [class*="Picker-module__pickerContainer"], [class*="OverflowMenuButton-module"], [class*="ContextualStoreBrowsePage-module__rootContainer"] { background-color: #14151a !important; color: #e8e8e8 !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; }',
    '[class*="Picker-module__pickerItem"] { background-color: #14151a !important; color: #e8e8e8 !important; fill: #e8e8e8 !important; }',
    '[class*="Picker-module__pickerItem"]:hover, [class*="Picker-module__pickerItem"]:focus { background-color: #1c1d23 !important; }',
    '[class*="Picker-module__itemText"] { color: #e8e8e8 !important; }',
    '[class*="Picker-module__selected"] { background-color: #1f232b !important; color: #ffffff !important; }',

    // Dialog action buttons
    '[class*="SortAndFilters-module__cancelButtonContainer"], [class*="FiltersPanel-module__cancelButtonContainer"], [class*="SortAndFilters-module__applyButtonContainer"], [class*="FiltersPanel-module__applyButtonContainer"] { background-color: #1c1d23 !important; color: #e8e8e8 !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; }',
    '[class*="SortAndFilters-module__cancelButtonContainer"] *, [class*="FiltersPanel-module__cancelButtonContainer"] *, [class*="SortAndFilters-module__applyButtonContainer"] *, [class*="FiltersPanel-module__applyButtonContainer"] * { color: #e8e8e8 !important; fill: #e8e8e8 !important; }',

    // General Headings, Labels, & Pagination
    'h1, h2, h3, h4, h5, h6, [class*="titleText"], [class*="filtersText"], [class*="filterText"] { color: #e8e8e8 !important; }',
    'button[class*="loadMore"], button[class*="LoadMore"], [class*="pagination"] button, [class*="Pagination"] button { background: #1c1d23 !important; color: #e8e8e8 !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; border-radius: 6px !important; }',
    'button[class*="loadMore"]:hover, button[class*="LoadMore"]:hover, [class*="pagination"] button:hover, [class*="Pagination"] button:hover { background: #242630 !important; border-color: rgba(255, 255, 255, 0.24) !important; }',

    // Dark scrollbars
    '::-webkit-scrollbar { width: 8px; height: 8px; }',
    '::-webkit-scrollbar-track { background: #0e0f12; }',
    '::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.16); border-radius: 4px; }',
    '::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.28); }'
  ].join('\n');

  function installVeil() {
    try {
      if (document.getElementById('efxlve-store-veil')) return;
      var target = document.body || document.documentElement;
      if (!target) return;
      var veil = document.createElement('div');
      veil.id = 'efxlve-store-veil';
      target.appendChild(veil);
    } catch (e) {}
  }

  function liftVeil() {
    try {
      var veil = document.getElementById('efxlve-store-veil');
      if (!veil) return;
      veil.classList.add('gone');
      setTimeout(function () {
        if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
      }, 260);
    } catch (e) {}
  }

  function apply() {
    try {
      var root = document.documentElement;
      if (root) {
        if (!root.classList.contains('theme-dark')) {
          root.classList.add('theme-dark');
        }
        if (root.getAttribute('data-theme') !== 'dark') {
          root.setAttribute('data-theme', 'dark');
        }
        root.style.backgroundColor = '#0e0f12';
      }

      var body = document.body;
      if (body) {
        if (!body.classList.contains('theme-dark')) {
          body.classList.add('theme-dark');
        }
        if (body.getAttribute('data-theme') !== 'dark') {
          body.setAttribute('data-theme', 'dark');
        }
        body.style.backgroundColor = '#0e0f12';
      }

      // Microsoft UHF header dark mode
      var header = document.querySelector('header.uhf-header');
      if (header && header.classList.contains('uhf-theme--light')) {
        header.classList.remove('uhf-theme--light');
        header.classList.add('uhf-theme--dark');
      }

      var parent = document.head || root;
      if (parent) {
        var el = document.getElementById('efxlve-store-theme');
        if (!el) {
          el = document.createElement('style');
          el.id = 'efxlve-store-theme';
          parent.appendChild(el);
        }
        if (el.textContent !== CSS) {
          el.textContent = CSS;
        }
      }
    } catch (e) {}
  }

  // 1. Immediate application as early as document creation
  apply();
  installVeil();

  // 2. Continuous enforcement through MutationObserver (catches dynamic DOM updates instantly)
  try {
    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        apply();
      });
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'data-theme']
      });
    }
  } catch (e) {}

  // 3. Lifecycle hooks
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      apply();
      installVeil();
      setTimeout(liftVeil, 120);
    });
  } else {
    setTimeout(liftVeil, 120);
  }

  window.addEventListener('load', function () {
    apply();
    setTimeout(liftVeil, 60);
  });

  // Safety fallback in case page is slow: always lift veil after 1.5s
  setTimeout(liftVeil, 1500);

  // Periodic safeguard for long-lived single-page app navigations
  setInterval(apply, 1500);
})();
"#;

#[cfg(test)]
mod tests {
    #[test]
    fn the_xbox_theme_flips_the_header_and_paints_the_page() {
        let script = super::XBOX_DARK_SCRIPT;
        assert!(script.contains("uhf-theme--dark"));
        assert!(script.contains(".appBackground"));
        assert!(script.contains("#0e0f12"));
        assert!(script.contains("ProductCard-module"));
        assert!(script.contains("SelectionDropdown-module"));
        assert!(script.contains("theme-dark"));
        assert!(script.contains("efxlve-store-veil"));
        assert!(script.contains("__EFXLVE_XBOX_THEME__"));
    }
}

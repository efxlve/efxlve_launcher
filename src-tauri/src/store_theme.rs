//! Dark theme for storefronts that only ship a light one.
//!
//! The Xbox store renders a white page (`.appBackground`) and its Microsoft
//! header arrives with the `uhf-theme--light` class. The header has its own
//! dark theme, so flipping that class beats repainting every control by hand;
//! the page surfaces are painted with the launcher's own background.

/// Injected into the Xbox storefront webview.
pub const XBOX_DARK_SCRIPT: &str = r#"
(function () {
  var CSS = [
    'html, body { background: #0e0f12 !important; }',
    '.appBackground { background: #0e0f12 !important; }',
    'body { color: #e8e8e8 !important; }',
    'header.uhf-header { background: #14151a !important; }',
    'header.uhf-header, header.uhf-header * { color: #e8e8e8 !important; }',
    '.uhf-search-input { background: #1c1d23 !important; color: #e8e8e8 !important; border-color: rgba(255,255,255,0.16) !important; }',
    '.uhf-autosuggest { background: #1c1d23 !important; }',
    // Product cards paint a white panel under the artwork; give it the
    // launcher surface. The little "GAME PASS" labels keep their own pill.
    '[class*="ProductCard-module__cardWrapper"] { background: #14151a !important; color: #e8e8e8 !important; border-color: rgba(255,255,255,0.08) !important; }',
    '[class*="badges"], [class*="badges"] * { color: #101010 !important; }'
  ].join('\n');

  function apply() {
    var el = document.getElementById('efxlve-store-theme');
    if (!el) {
      el = document.createElement('style');
      el.id = 'efxlve-store-theme';
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = CSS;
    // Microsoft's own dark theme for the header, instead of overriding each
    // control's colours from here.
    var header = document.querySelector('header.uhf-header');
    if (header && header.classList.contains('uhf-theme--light')) {
      header.classList.remove('uhf-theme--light');
      header.classList.add('uhf-theme--dark');
    }
  }

  apply();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  }
  // The store is a single-page app: the header and the page root are rebuilt
  // on navigation, so keep the theme applied. Idempotent and cheap.
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
    }
}

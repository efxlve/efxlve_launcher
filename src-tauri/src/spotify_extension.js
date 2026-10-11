// Page script for the embedded Spotify player (`spotify_host.rs`).
//
// Spotify pushes its desktop app in two places: a header button and a card in
// the right rail. Whoever is reading this inside the launcher already *has* a
// player, so both promos are hidden. Everything is selector- or label-based
// (no exact copy matching) so it keeps working in every language.

(() => {
  const STYLE_ID = "efxlve-spotify-cleanup";
  const CSS = `
    a[href="/download"],
    a[href*="spotify.com/download"] { display: none !important; }
    [data-testid="install-app-button"],
    [data-testid="download-app-card"],
    [data-testid="download-app-banner"],
    [data-testid="customer-referral-card"] { display: none !important; }
  `;

  const addStyle = () => {
    if (!document.head || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  };

  // Promo copy in the languages Spotify ships: "Download app", "Uygulamayı
  // indir", and friends. The control itself may be a link or a button.
  const PROMO =
    /(install|download|indir|herunterladen|descargar|t[eé]l[eé]charger|installa|instalar|скачать|ダウンロード|다운로드|下[载載]|تحميل|تنزيل)/i;

  // Widest a container may be to count as "the promo card": the right rail and
  // everything inside it stay well under this, while the header and the page
  // body are far wider — that keeps the header's profile/bell/avatar safe.
  const CARD_MAX_WIDTH = 460;

  const seen = new WeakSet();

  const hidePromos = () => {
    for (const control of document.querySelectorAll("a, button")) {
      if (seen.has(control)) continue;
      seen.add(control);
      const label = `${control.getAttribute("aria-label") || ""} ${control.textContent || ""}`;
      if (!PROMO.test(label)) continue;
      // The header install button is a bare link: the stylesheet hides it and a
      // walk up from here would take the header's own controls with it.
      if (control.closest("header, nav")) continue;
      let card = null;
      let node = control;
      for (let depth = 0; depth < 6 && node.parentElement; depth += 1) {
        node = node.parentElement;
        if (node.clientWidth > CARD_MAX_WIDTH) break;
        // Stay inside the promo block: the rail's now-playing info (song and
        // artist) sits above it and must survive.
        if ((node.textContent || "").length > 400) break;
        card = node;
      }
      if (card) card.style.display = "none";
    }
  };

  // The web player is a single-page app: new cards appear without a reload.
  let queued = false;
  const queueCleanup = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      hidePromos();
    }, 400);
  };

  const boot = () => {
    addStyle();
    hidePromos();
    const root = document.body || document.documentElement;
    if (root) new MutationObserver(queueCleanup).observe(root, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();

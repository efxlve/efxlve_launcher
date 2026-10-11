// Page script for the embedded Spotify player (`spotify_host.rs`).
//
// 1. Hides the desktop-app promos Spotify pushes in the header and the right
//    rail, and collapses the rail while the promo was its only content (some
//    views fill it with the song and artist info again — then it comes back).
// 2. Puts the launcher's Back / Reload controls into the player's own top bar
//    instead of the launcher header. Clicks go through
//    `https://efxlve.local/act?...`, which `spotify_host.rs` turns into acts.
//
// Everything is selector- or label-based (no exact copy matching) so it keeps
// working in every language.

(() => {
  const STYLE_ID = "efxlve-spotify-cleanup";
  const CONTROLS_ID = "efxlve-spotify-controls";
  const CSS = `
    a[href="/download"],
    a[href*="spotify.com/download"] { display: none !important; }
    [data-testid="install-app-button"],
    [data-testid="download-app-card"],
    [data-testid="download-app-banner"],
    [data-testid="customer-referral-card"] { display: none !important; }
    #${CONTROLS_ID} { display: none; gap: 8px; align-items: center; }
    #${CONTROLS_ID} button { display: grid; place-items: center; width: 32px; height: 32px;
      border: none; border-radius: 999px; background: hsla(0, 0%, 100%, 0.07); color: #b3b3b3;
      cursor: pointer; transition: background .15s ease, color .15s ease, transform .15s ease; }
    #${CONTROLS_ID} button:hover { background: hsla(0, 0%, 100%, 0.14); color: #ffffff; transform: scale(1.04); }
    #${CONTROLS_ID} button:active { background: hsla(0, 0%, 100%, 0.22); color: #ffffff; transform: scale(0.94); }
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

  /** True when nothing in the subtree is actually painted. */
  const isEmpty = (el) => {
    for (const child of el.querySelectorAll("img, svg, a, button, h1, h2, h3, p")) {
      if (child.getClientRects().length > 0) return false;
    }
    return true;
  };

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
      if (!card) continue;
      card.style.display = "none";

      // The promo was the rail's only content in some views: collapse the rail
      // instead of leaving an empty column. It is restored below once Spotify
      // paints something else into it.
      let rail = null;
      let up = card.parentElement;
      for (let depth = 0; depth < 6 && up; depth += 1) {
        if (up.clientWidth > CARD_MAX_WIDTH) break;
        if (!isEmpty(up)) break;
        rail = up;
        up = up.parentElement;
      }
      if (rail && !rail.hasAttribute("data-efxlve-collapsed")) {
        rail.style.display = "none";
        rail.setAttribute("data-efxlve-collapsed", "1");
      }
    }

    for (const rail of document.querySelectorAll("[data-efxlve-collapsed]")) {
      if (!isEmpty(rail)) {
        rail.style.display = "";
        rail.removeAttribute("data-efxlve-collapsed");
      }
    }
  };

  const iconButton = (label, act, path) =>
    `<button type="button" data-efxlve-act="${act}" aria-label="${label}" title="${label}">${path}</button>`;

  const BACK_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>';
  const RELOAD_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>';

  /** Back / Reload in the player's bar, right of the Spotify logo. */
  const placeControls = () => {
    let host = document.getElementById(CONTROLS_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = CONTROLS_ID;
      host.innerHTML =
        iconButton("Back", "music-back", BACK_ICON) +
        iconButton("Reload", "music-reload", RELOAD_ICON);
      document.body.appendChild(host);
    }
    const logo = document.querySelector('a[href="/"] svg, img[alt="Spotify"], a[aria-label="Spotify"]');
    if (!logo) {
      host.style.display = "none";
      return;
    }
    const rect = logo.getBoundingClientRect();
    if (rect.width < 4) {
      host.style.display = "none";
      return;
    }
    host.style.display = "flex";
    host.style.position = "fixed";
    host.style.left = `${Math.round(rect.right + 14)}px`;
    host.style.top = `${Math.round(rect.top + rect.height / 2 - 16)}px`;
    host.style.zIndex = "60";
  };

  // The player swallows page-level clicks in its own capture handlers, so the
  // act is taken on the document in the capture phase and fired on pointerdown:
  // one press is enough and the button reacts instantly.
  let lastActAt = 0;
  const forward = (act) => {
    if (!act) return;
    const now = Date.now();
    if (now - lastActAt < 350) return;
    lastActAt = now;
    location.href = "https://efxlve.local/act?act=" + act + "&t=" + now;
  };
  const onPointerPress = (event) => {
    const target = event.target;
    const button = target && target.closest ? target.closest("[data-efxlve-act]") : null;
    if (!button) return;
    forward(button.getAttribute("data-efxlve-act") || "");
  };

  // --- What the page itself is playing --------------------------------------
  // The page can play through its own engine instead of the Connect receiver;
  // the launcher's sidebar player reads this through the same act channel and
  // prefers it while the page is the one making sound.
  let lastPageState = "";

  const postPageState = () => {
    const session = navigator.mediaSession;
    const meta = session && session.metadata;
    if (!meta) return;
    const state = session.playbackState || "none";
    const art =
      meta.artwork && meta.artwork.length
        ? meta.artwork[meta.artwork.length - 1].src || ""
        : "";
    const payload = JSON.stringify({
      title: meta.title || "",
      artist: meta.artist || "",
      album: meta.album || "",
      art,
      playing: state === "playing",
      paused: state === "paused",
    });
    if (payload === lastPageState) return;
    lastPageState = payload;
    location.href =
      "https://efxlve.local/act?act=page-now&id=" + encodeURIComponent(payload) + "&t=" + Date.now();
  };

  /** Transport from the launcher's sidebar player, straight on the page. */
  window.__efxlveControl = (action) => {
    const testId =
      action === "next"
        ? "control-button-skip-forward"
        : action === "previous"
          ? "control-button-skip-back"
          : "control-button-playpause";
    const button = document.querySelector('[data-testid="' + testId + '"]');
    if (button) button.click();
  };

  // The web player is a single-page app: new cards appear without a reload.
  let queued = false;
  const queueCleanup = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      hidePromos();
      placeControls();
      postPageState();
    }, 400);
  };

  const boot = () => {
    addStyle();
    hidePromos();
    placeControls();
    postPageState();
    document.addEventListener("pointerdown", onPointerPress, true);
    window.addEventListener("resize", queueCleanup);
    window.setInterval(postPageState, 1500);
    const root = document.body || document.documentElement;
    if (root) new MutationObserver(queueCleanup).observe(root, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();

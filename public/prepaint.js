/*
 * Runs in the document head before the first paint: applies the saved surface
 * and the saved sidebar width so the shell never flashes the wrong theme.
 *
 * It is a classic script on purpose — a module would run after the body is
 * parsed, which is exactly the flash it exists to prevent. It lives in
 * `public/` so the main webview can keep `script-src 'self'` without
 * `'unsafe-inline'`.
 */
(function () {
  document.documentElement.classList.add("sb-no-anim");
  try {
    var surface = localStorage.getItem("efxlve-surface") || "";
    if (surface === "soft" || surface === "white" || surface === "aero") {
      document.documentElement.dataset.surface = surface;
    }
    var w = parseInt(localStorage.getItem("efxlve-sidebar-w") || "", 10);
    if (w >= 72 && w <= 400) {
      document.documentElement.style.setProperty("--sidebar-w", w + "px");
      if (w < 160) document.documentElement.classList.add("sb-narrow");
    }
  } catch (e) {}
})();

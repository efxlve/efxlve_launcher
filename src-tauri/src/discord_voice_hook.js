// Discord voice hook: runs before any page script.
//
// The client's webpack runtime can replace or drop `webpackChunkdiscord_app`
// once it has booted, so the require is captured early (and kept for the whole
// page) instead of being re-derived on every probe. The probe in
// `discord_voice_probe.js` prefers this captured reference.
(function () {
  if (window.__efxlveVoiceHook) return;
  window.__efxlveVoiceHook = true;

  function capture() {
    var chunk = null;
    try {
      chunk = window.webpackChunkdiscord_app;
    } catch (e) {
      return false;
    }
    if (!chunk || typeof chunk.push !== "function") return false;
    var req = null;
    try {
      chunk.push([[Math.random().toString(36).slice(2)], {}, function (r) { req = r; }]);
      chunk.pop();
    } catch (e) {
      return false;
    }
    if (req) {
      window.__efxlveVoiceRequire = req;
      return true;
    }
    return false;
  }

  if (capture()) return;
  // Keep trying while the app boots (~60s), then leave it to the probe.
  var tries = 0;
  var timer = window.setInterval(function () {
    tries += 1;
    if (capture() || tries > 120) window.clearInterval(timer);
  }, 500);
})()

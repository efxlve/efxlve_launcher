// Discord voice hook: runs before any page script.
//
// The client's webpack runtime can replace or drop `webpackChunkdiscord_app`
// once it has booted, so the require is captured early (and kept for the whole
// page) instead of being re-derived on every probe. The probe in
// `discord_voice_probe.js` prefers this captured reference.
(function () {
  if (window.__efxlveVoiceHook) return;
  window.__efxlveVoiceHook = true;

  // Every webpack runtime the client builds assigns its module table to
  // `require.m`; a setter on Function.prototype collects them all, so the
  // probe can pick the runtime that carries the client (the most loaded
  // modules) even when several of them share the chunk global. This is the
  // same trick maintained plugins use; the assignment is passed through so the
  // runtime keeps working.
  try {
    var existing = Object.getOwnPropertyDescriptor(Function.prototype, "m");
    var previous = existing && existing.set;
    Object.defineProperty(Function.prototype, "m", {
      configurable: true,
      set: function (value) {
        try {
          var list = window.__efxlveRequires || (window.__efxlveRequires = []);
          if (value && value.c && value.m && list.indexOf(value) < 0) list.push(value);
        } catch (e) {}
        if (previous) {
          try {
            previous.call(this, value);
            return;
          } catch (e) {}
        }
        Object.defineProperty(this, "m", { value: value, configurable: true, writable: true });
      },
    });
  } catch (e) {}

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

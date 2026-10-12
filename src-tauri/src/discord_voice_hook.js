// Discord runtime hook: runs before any page script.
//
// The client builds several webpack runtimes in the top realm (its own, plus
// sentry/libdiscore/fast-connect) and they all attach to the same chunk global.
// A helper instance can look identical to the client's (`p === "/assets/"`)
// while carrying only the boot modules, so every runtime is remembered here at
// document start, before anything can drop the global. The setter passes the
// assignment through so the runtime keeps working; the `exports:{}` source
// check keeps ordinary functions out. The probe then picks the one the client
// actually uses.
(function () {
  if (window.__efxlveRuntimeHook) return;
  window.__efxlveRuntimeHook = true;
  var runtimes = [];
  Object.defineProperty(window, "__efxlveRuntimes", { value: runtimes });
  try {
    var existing = Object.getOwnPropertyDescriptor(Function.prototype, "m");
    var previous = existing && existing.set;
    Object.defineProperty(Function.prototype, "m", {
      configurable: true,
      enumerable: false,
      set: function (value) {
        if (previous) {
          try {
            previous.call(this, value);
          } catch (e) {}
        } else {
          Object.defineProperty(this, "m", {
            value: value,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
        try {
          if (runtimes.indexOf(this) < 0 && String(this).indexOf("exports:{}") >= 0) {
            runtimes.push(this);
          }
        } catch (e) {}
      },
    });
  } catch (e) {}
})()

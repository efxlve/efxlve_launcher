// Discord web voice probe.
//
// Injected by `discord_host.rs` through WebView2's own `ExecuteScript`; the
// returned value comes back as JSON. The client keeps most of its modules as
// un-evaluated factories (`require.m`), so a plain lookup in the instance
// cache finds nothing: factories whose source mentions the store functions are
// materialised on demand and only those, which keeps side effects to what the
// page would do anyway. Nothing touches Discord's DOM. Every failure returns
// `ok: false` with a bounded diagnostic line, and the Rust side keeps the
// overlay on the RPC source instead.
(function () {
  // Store lookups are cached per page: the first sweep costs ~150ms, later
  // ticks reuse the result, and a failed sweep is not repeated every tick.
  var cache = window.__efxlveVoiceProbe;
  if (!cache) {
    cache = window.__efxlveVoiceProbe = { at: 0, stores: null, via: "", why: "" };
  }

  function registryOf(win) {
    try {
      var chunk = win.webpackChunkdiscord_app;
      if (!chunk || !chunk.push) return null;
      var req = null;
      chunk.push([[Math.random().toString(36).slice(2)], {}, function (r) { req = r; }]);
      chunk.pop();
      return req || null;
    } catch (e) {
      return null;
    }
  }

  function hasProps(exp, props) {
    if (!exp || typeof exp !== "object") return false;
    for (var i = 0; i < props.length; i++) {
      if (typeof exp[props[i]] !== "function") return false;
    }
    return true;
  }

  function byProps(req, props) {
    var mods = (req && req.c) || {};
    for (var key in mods) {
      var exp = null;
      try { exp = mods[key] && mods[key].exports; } catch (e) { continue; }
      if (hasProps(exp, props)) return exp;
    }
    return null;
  }

  var WANTED = [
    ["selected", "getVoiceChannelId"],
    ["channels", "getChannel"],
    ["voice", "getVoiceStatesForChannel"],
    ["users", "getUser"],
    ["guilds", "getGuild"]
  ];

  // One pass over the factories: materialise only the ones whose source
  // mentions a function we still need.
  function fillStores(req, stores) {
    var m = (req && req.m) || {};
    var ids = Object.keys(m);
    for (var i = 0; i < ids.length; i++) {
      var missing = null;
      for (var w = 0; w < WANTED.length; w++) {
        if (!stores[WANTED[w][0]]) {
          missing = missing || [];
          missing.push(w);
        }
      }
      if (!missing) return stores;
      var src = "";
      try { src = String(m[ids[i]]); } catch (e) { continue; }
      var relevant = false;
      for (var n = 0; n < missing.length; n++) {
        if (src.indexOf(WANTED[missing[n]][1]) >= 0) { relevant = true; break; }
      }
      if (!relevant) continue;
      var exp = null;
      try { exp = req(ids[i]); } catch (e) { continue; }
      if (!exp) continue;
      for (var k = 0; k < missing.length; k++) {
        var key = WANTED[missing[k]][0];
        if (!stores[key] && hasProps(exp, [WANTED[missing[k]][1]])) stores[key] = exp;
      }
    }
    return stores;
  }

  function storesOf(req) {
    if (!req) return null;
    var stores = {
      selected: byProps(req, ["getVoiceChannelId"]),
      channels: byProps(req, ["getChannel"]),
      voice: byProps(req, ["getVoiceStatesForChannel"]),
      users: byProps(req, ["getUser"]),
      guilds: byProps(req, ["getGuild"])
    };
    if (stores.selected && stores.channels && stores.voice && stores.users) return stores;
    stores = fillStores(req, stores);
    if (stores.selected && stores.channels && stores.voice && stores.users) return stores;
    return null;
  }

  // Which store-like method names this registry actually carries, straight from
  // the factory sources. Bounded and only run when a sweep failed.
  function sourceInventory(req) {
    var m = (req && req.m) || {};
    var ids = Object.keys(m);
    var tokens = [];
    var pattern = /get[A-Z][A-Za-z0-9_]{3,}/g;
    for (var i = 0; i < ids.length; i++) {
      var src = "";
      try { src = String(m[ids[i]]); } catch (e) { continue; }
      if (src.indexOf("Voice") < 0 && src.indexOf("Channel") < 0 && src.indexOf("User") < 0) continue;
      var match = null;
      var guard = 0;
      while ((match = pattern.exec(src)) !== null && guard < 80) {
        guard += 1;
        if (tokens.indexOf(match[0]) < 0 && tokens.length < 40) tokens.push(match[0]);
      }
      if (tokens.length >= 40) break;
    }
    return tokens;
  }

  function channelOf(stores, channelId) {
    var channel = stores.channels.getChannel(channelId) || {};
    var guild = "";
    try {
      var guildId = channel.guild_id;
      var guildStore = guildId && stores.guilds ? stores.guilds.getGuild(guildId) : null;
      guild = guildStore && guildStore.name ? guildStore.name : "";
    } catch (e) {}
    return { id: String(channelId), name: channel.name || "", guild: guild };
  }

  function participantsOf(stores, channelId) {
    var people = [];
    var states = stores.voice.getVoiceStatesForChannel(channelId) || {};
    for (var userId in states) {
      var state = states[userId] || {};
      var user = stores.users.getUser(userId) || {};
      people.push({
        id: String(userId),
        name: user.globalName || user.username || state.nick || "",
        avatar: user.avatar || "",
        muted: !!(state.selfMute || state.mute)
      });
    }
    return people;
  }

  try {
    var stores = cache.stores;
    var via = cache.via;
    if (!stores) {
      // A sweep costs ~150ms; refresh at most every 10s while it fails.
      if (cache.why && Date.now() - cache.at < 10000) {
        return { ok: false, why: cache.why };
      }
      var candidates = [window];
      try {
        for (var f = 0; f < window.frames.length; f++) candidates.push(window.frames[f]);
      } catch (e) {}

      var best = null;
      var bestIndex = 0;
      var bestCount = -1;
      var found = null;
      var foundIndex = 0;
      for (var c = 0; c < candidates.length; c++) {
        var req = registryOf(candidates[c]);
        var count = req ? Object.keys(req.c || {}).length : -1;
        if (count > bestCount) {
          bestCount = count;
          best = req;
          bestIndex = c;
        }
        var probe = storesOf(req);
        if (probe) {
          found = probe;
          foundIndex = c;
          break;
        }
      }

      if (found) {
        cache.stores = found;
        cache.via = foundIndex === 0 ? "top" : "frame" + foundIndex;
        cache.at = Date.now();
        stores = found;
        via = cache.via;
      } else {
        var mounts = [];
        var hrefs = [];
        for (var m = 0; m < candidates.length; m++) {
          var kids = -1;
          var href = "";
          try {
            var mount = candidates[m].document.getElementById("app-mount");
            kids = mount ? mount.childElementCount : -1;
          } catch (e) {
            kids = -9;
          }
          try {
            href = String(candidates[m].location.href).slice(0, 90);
          } catch (e) {
            href = "x";
          }
          mounts.push(kids);
          hrefs.push(href);
        }
        var globals = [];
        try {
          for (var g in window) {
            if (!/webpack/i.test(g)) continue;
            var value = null;
            try {
              value = window[g];
            } catch (e) {
              continue;
            }
            var kind = value && typeof value.push === "function" ? "chunk" : typeof value;
            var cached = value && value.c ? "(" + Object.keys(value.c).length + ")" : "";
            globals.push(g + ":" + kind + cached);
            if (globals.length >= 12) break;
          }
        } catch (e) {}
        var shape = "";
        if (best) {
          shape = " rk=[" + Object.keys(best).slice(0, 10).join("|") + "]"
            + " m=" + Object.keys(best.m || {}).length;
        }
        cache.at = Date.now();
        cache.why = "no-stores wins=" + candidates.length
          + " bestIdx=" + bestIndex
          + " bestM=" + bestCount
          + " mounts=[" + mounts.join(",") + "]"
          + " top=" + (window.top === window ? 1 : 0)
          + " hrefs=[" + hrefs.join(" | ") + "]"
          + " globals=[" + globals.join(",") + "]"
          + shape
          + " names=[" + sourceInventory(best).join(",") + "]";
        return { ok: false, why: cache.why };
      }
    }

    var channelId = stores.selected.getVoiceChannelId();
    if (!channelId) return { ok: true, inCall: false, via: via };
    return {
      ok: true,
      inCall: true,
      via: via,
      channel: channelOf(stores, channelId),
      participants: participantsOf(stores, channelId)
    };
  } catch (e) {
    return { ok: false, why: String(e) };
  }
})()

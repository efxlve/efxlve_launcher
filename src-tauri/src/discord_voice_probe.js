// Discord web voice probe.
//
// Injected by `discord_host.rs` through WebView2's own `ExecuteScript`; the
// returned value comes back as JSON. This client keeps most modules as
// un-evaluated factories (`require.m`) with minified, getter-based exports, so
// the probe (a) checks the instance cache, (b) materialises only the factories
// whose source mentions a wanted store method, and (c) looks one level into
// wrapped exports. Every property access is guarded: out-of-order
// materialisation can throw Temporal-Dead-Zone errors. Nothing touches
// Discord's DOM. Failures return `ok: false` with a bounded diagnostic line
// (module shapes included) and the overlay stays on the RPC source.
(function () {
  // Store lookups are cached per page; a failed sweep is retried at most every
  // 10 seconds.
  var cache = window.__efxlveVoiceProbe;
  if (!cache) {
    cache = window.__efxlveVoiceProbe = { at: 0, stores: null, via: "", why: "" };
  }

  function registryOf(win) {
    // The hook captures the app's require before its runtime can replace or
    // drop the global; prefer it and fall back to a live lookup.
    try {
      if (win.__efxlveVoiceRequire) return win.__efxlveVoiceRequire;
    } catch (e) {}
    var chunk = null;
    try {
      chunk = win.webpackChunkdiscord_app;
    } catch (e) {
      return { error: "get:" + String(e).slice(0, 50) };
    }
    if (!chunk) return null;
    if (typeof chunk.push !== "function") {
      return { error: "push-not-fn:" + typeof chunk.push };
    }
    var req = null;
    try {
      chunk.push([[Math.random().toString(36).slice(2)], {}, function (r) { req = r; }]);
      chunk.pop();
    } catch (e) {
      return { error: "push:" + String(e).slice(0, 60) };
    }
    return req || null;
  }

  // The object on which `prop` is callable: the export itself, or a wrapped
  // value one level in. `null` when nothing matches.
  function findCallable(exp, prop) {
    try {
      if (exp && typeof exp[prop] === "function") return exp;
    } catch (e) {}
    var keys = [];
    try {
      keys = Object.keys(exp);
    } catch (e) {
      return null;
    }
    for (var i = 0; i < keys.length && i < 12; i++) {
      var inner = null;
      try {
        inner = exp[keys[i]];
      } catch (e) {
        continue;
      }
      if (!inner || (typeof inner !== "object" && typeof inner !== "function")) continue;
      try {
        if (typeof inner[prop] === "function") return inner;
      } catch (e) {}
    }
    return null;
  }

  function shapeOf(exp) {
    try {
      return (typeof exp) + "{" + Object.keys(exp).slice(0, 6).join("|") + "}";
    } catch (e) {
      return "?" + typeof exp;
    }
  }

  function byProps(req, prop) {
    var mods = (req && req.c) || {};
    for (var key in mods) {
      var exp = null;
      try {
        exp = mods[key] && mods[key].exports;
      } catch (e) {
        continue;
      }
      var hit = findCallable(exp, prop);
      if (hit) return hit;
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
  // mentions a method we still need. `report` collects bounded shapes so a
  // failed sweep is still diagnosable from the log.
  function fillStores(req, stores, report) {
    var m = (req && req.m) || {};
    var ids = Object.keys(m);
    for (var i = 0; i < ids.length; i++) {
      var missing = [];
      for (var w = 0; w < WANTED.length; w++) {
        if (!stores[WANTED[w][0]]) missing.push(w);
      }
      if (!missing.length) return stores;
      var src = "";
      try {
        src = String(m[ids[i]]);
      } catch (e) {
        continue;
      }
      var relevant = false;
      for (var n = 0; n < missing.length; n++) {
        if (src.indexOf(WANTED[missing[n]][1]) >= 0) {
          relevant = true;
          break;
        }
      }
      if (!relevant) continue;
      var exp = null;
      try {
        exp = req(ids[i]);
      } catch (e) {
        report.threw += 1;
        continue;
      }
      if (exp && report.shapes.length < 8) {
        report.shapes.push(ids[i] + ":" + shapeOf(exp));
      }
      for (var k = 0; k < missing.length; k++) {
        var key = WANTED[missing[k]][0];
        if (stores[key]) continue;
        var hit = findCallable(exp, WANTED[missing[k]][1]);
        if (hit) stores[key] = hit;
      }
    }
    return stores;
  }

  function storesOf(req) {
    if (!req) return null;
    var stores = {
      selected: byProps(req, "getVoiceChannelId"),
      channels: byProps(req, "getChannel"),
      voice: byProps(req, "getVoiceStatesForChannel"),
      users: byProps(req, "getUser"),
      guilds: byProps(req, "getGuild")
    };
    if (stores.selected && stores.channels && stores.voice && stores.users) return stores;
    var report = { shapes: [], threw: 0 };
    stores = fillStores(req, stores, report);
    if (stores.selected && stores.channels && stores.voice && stores.users) {
      return stores;
    }
    return { report: report };
  }

  // Which store-like method names the factory sources carry. Bounded, only run
  // when everything else failed.
  function sourceInventory(req) {
    var m = (req && req.m) || {};
    var ids = Object.keys(m);
    var tokens = [];
    var pattern = /get[A-Z][A-Za-z0-9_]{3,}/g;
    for (var i = 0; i < ids.length; i++) {
      var src = "";
      try {
        src = String(m[ids[i]]);
      } catch (e) {
        continue;
      }
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
    var name = channel.name || "";
    if (!name) {
      try {
        if (typeof stores.channels.getName === "function") {
          name = stores.channels.getName(channelId) || "";
        }
      } catch (e) {}
    }
    var guild = "";
    try {
      var guildId = channel.guild_id;
      var guildStore = guildId && stores.guilds ? stores.guilds.getGuild(guildId) : null;
      guild = guildStore && guildStore.name ? guildStore.name : "";
    } catch (e) {}
    return { id: String(channelId), name: name, guild: guild };
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
      var report = { shapes: [], threw: 0 };
      var chunkInfo = [];
      for (var c = 0; c < candidates.length; c++) {
        var reg = registryOf(candidates[c]);
        if (reg && reg.error) {
          chunkInfo.push(c + ":" + reg.error);
          continue;
        }
        var req = reg || null;
        var count = req ? Object.keys(req.c || {}).length : -1;
        chunkInfo.push(c + ":" + (req ? "ok" + count : "none"));
        if (count > bestCount) {
          bestCount = count;
          best = req;
          bestIndex = c;
        }
        var probe = storesOf(req);
        if (probe && probe.selected) {
          found = probe;
          foundIndex = c;
          break;
        }
        if (probe && probe.report) report = probe.report;
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
        for (var m2 = 0; m2 < candidates.length; m2++) {
          var kids = -1;
          var href = "";
          try {
            var mount = candidates[m2].document.getElementById("app-mount");
            kids = mount ? mount.childElementCount : -1;
          } catch (e) {
            kids = -9;
          }
          try {
            href = String(candidates[m2].location.href).slice(0, 90);
          } catch (e) {
            href = "x";
          }
          mounts.push(kids);
          hrefs.push(href);
        }
        var shape = "";
        if (best) {
          shape = " rk=[" + Object.keys(best).slice(0, 10).join("|") + "]"
            + " m=" + Object.keys(best.m || {}).length;
        }
        cache.at = Date.now();
        cache.why = "no-stores wins=" + candidates.length
          + " bestIdx=" + bestIndex
          + " bestM=" + bestCount
          + " chunks=[" + chunkInfo.join(" | ") + "]"
          + " mounts=[" + mounts.join(",") + "]"
          + " top=" + (window.top === window ? 1 : 0)
          + " ready=" + document.readyState
          + " hrefs=[" + hrefs.join(" | ") + "]"
          + shape
          + " threw=" + report.threw
          + " shapes=[" + report.shapes.join(" ") + "]"
          + " names=[" + sourceInventory(best).join(",") + "]";
        return { ok: false, why: cache.why };
      }
    }

    var channelId = stores.selected.getVoiceChannelId();
    if (!channelId) return { ok: true, inCall: false, via: via };
    var channel = channelOf(stores, channelId);
    var participants = participantsOf(stores, channelId);
    var payload = {
      ok: true,
      inCall: true,
      via: via,
      channel: channel,
      participants: participants
    };
    // While the name or the first participant still comes back empty, say what
    // the raw objects actually hold so the extraction can be fixed from the
    // log alone.
    if (!channel.name || (participants[0] && !participants[0].name)) {
      var bits = [];
      try {
        var rawChannel = stores.channels.getChannel(channelId) || {};
        bits.push("ch=[" + Object.keys(rawChannel).slice(0, 12).join("|") + "]");
        bits.push("chName=" + typeof rawChannel.name);
      } catch (e) {
        bits.push("ch=err");
      }
      try {
        if (participants[0]) {
          var rawUser = stores.users.getUser(participants[0].id) || {};
          bits.push("u=[" + Object.keys(rawUser).slice(0, 12).join("|") + "]");
          bits.push("uName=" + typeof rawUser.username);
        }
      } catch (e) {
        bits.push("u=err");
      }
      payload.debug = bits.join(" ");
    }
    return payload;
  } catch (e) {
    return { ok: false, why: String(e) };
  }
})()

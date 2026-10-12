// Discord web voice probe.
//
// Injected by `discord_host.rs` through WebView2's own `ExecuteScript`; the
// returned value comes back as JSON. This client keeps most modules as
// un-evaluated factories (`require.m`) with minified, getter-based exports, and
// several unrelated modules expose same-named helpers — so candidates are
// verified by behaviour (a channel lookup must return the channel for the id,
// a user lookup the user, voice-state keys must be numeric ids) before a store
// is accepted. Every property access is guarded: out-of-order materialisation
// can throw Temporal-Dead-Zone errors. Nothing touches Discord's DOM. Failures
// return `ok: false` with a bounded diagnostic line and the overlay stays on
// the RPC source.
(function () {
  // Store lookups are cached per page; a failed sweep is retried at most every
  // 10 seconds.
  var cache = window.__efxlveVoiceProbe;
  if (!cache) {
    cache = window.__efxlveVoiceProbe = { at: 0, stores: null, via: "", why: "" };
  }

  var ID = /^\d{5,}$/;

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
      return typeof exp + "{" + Object.keys(exp).slice(0, 6).join("|") + "}";
    } catch (e) {
      return "?" + typeof exp;
    }
  }

  // Up to `limit` distinct objects exposing `prop`, instance cache first, then
  // factories whose source mentions the name.
  function collect(req, prop, limit, report) {
    var out = [];
    var mods = (req && req.c) || {};
    for (var key in mods) {
      var exp = null;
      try {
        exp = mods[key] && mods[key].exports;
      } catch (e) {
        continue;
      }
      var hit = findCallable(exp, prop);
      if (hit && out.indexOf(hit) < 0) {
        out.push(hit);
        if (out.length >= limit) return out;
      }
    }
    var m = (req && req.m) || {};
    var ids = Object.keys(m);
    var materialised = 0;
    for (var i = 0; i < ids.length && out.length < limit; i++) {
      var src = "";
      try {
        src = String(m[ids[i]]);
      } catch (e) {
        continue;
      }
      if (src.indexOf(prop) < 0) continue;
      var exp2 = null;
      try {
        exp2 = req(ids[i]);
        materialised += 1;
      } catch (e) {
        if (report) report.threw += 1;
        continue;
      }
      var hit2 = findCallable(exp2, prop);
      if (report && report.shapes.length < 6 && hit2) {
        report.shapes.push(ids[i] + ":" + shapeOf(hit2));
      }
      if (hit2 && out.indexOf(hit2) < 0) out.push(hit2);
    }
    if (report) report.materialised += materialised;
    return out;
  }

  // Picks the stores that actually behave like the client's stores.
  function resolveStores(req, report) {
    var out = {
      selected: null,
      channels: null,
      voice: null,
      users: null,
      guilds: null,
      channelId: null
    };

    var selected = collect(req, "getVoiceChannelId", 8, report);
    for (var i = 0; i < selected.length; i++) {
      try {
        var id = selected[i].getVoiceChannelId();
        if (id === null || id === undefined || typeof id === "string") {
          out.selected = selected[i];
          out.channelId = typeof id === "string" ? id : null;
          break;
        }
      } catch (e) {}
    }
    if (!out.selected && selected.length) out.selected = selected[0];

    var channelId = out.channelId;
    var channels = collect(req, "getChannel", 24, report);
    for (var c = 0; c < channels.length; c++) {
      try {
        var channel = channelId ? channels[c].getChannel(channelId) : null;
        if (
          channel &&
          typeof channel === "object" &&
          (String(channel.id) === String(channelId) || typeof channel.name === "string")
        ) {
          out.channels = channels[c];
          break;
        }
      } catch (e) {}
    }

    var voice = collect(req, "getVoiceStatesForChannel", 12, report);
    var states = null;
    for (var v = 0; v < voice.length; v++) {
      try {
        var map = channelId ? voice[v].getVoiceStatesForChannel(channelId) : null;
        if (map && typeof map === "object" && !Array.isArray(map)) {
          out.voice = voice[v];
          states = map;
          break;
        }
      } catch (e) {}
    }

    var userId = null;
    if (states) {
      for (var key in states) {
        if (ID.test(key)) {
          userId = key;
          break;
        }
      }
    }
    var users = collect(req, "getUser", 24, report);
    for (var u = 0; u < users.length; u++) {
      try {
        var person = userId ? users[u].getUser(userId) : null;
        if (!userId || (person && typeof person === "object" && String(person.id) === String(userId))) {
          out.users = users[u];
          break;
        }
      } catch (e) {}
    }

    var guilds = collect(req, "getGuild", 12, report);
    for (var g = 0; g < guilds.length; g++) {
      try {
        var probe = guilds[g].getGuild ? guilds[g].getGuild("0") : null;
        if (probe === null || probe === undefined || typeof probe === "object") {
          out.guilds = guilds[g];
          break;
        }
      } catch (e) {}
    }

    if (out.selected && out.channels && out.voice && out.users) return out;
    return out;
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
    var channel = {};
    try {
      channel = stores.channels.getChannel(channelId) || {};
    } catch (e) {}
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
    var states = {};
    try {
      states = stores.voice.getVoiceStatesForChannel(channelId) || {};
    } catch (e) {}
    for (var userId in states) {
      // Only snowflakes are people; wrapper objects leak other keys.
      if (!ID.test(userId)) continue;
      var state = states[userId] || {};
      var user = {};
      try {
        user = stores.users.getUser(userId) || {};
      } catch (e) {}
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
      var report = { shapes: [], threw: 0, materialised: 0 };
      var chunkInfo = [];
      for (var c2 = 0; c2 < candidates.length; c2++) {
        var reg = registryOf(candidates[c2]);
        if (reg && reg.error) {
          chunkInfo.push(c2 + ":" + reg.error);
          continue;
        }
        var req = reg || null;
        var count = req ? Object.keys(req.c || {}).length : -1;
        chunkInfo.push(c2 + ":" + (req ? "ok" + count : "none"));
        if (count > bestCount) {
          bestCount = count;
          best = req;
          bestIndex = c2;
        }
        if (!req) continue;
        var resolved = resolveStores(req, report);
        if (resolved.selected && resolved.channels && resolved.voice && resolved.users) {
          found = resolved;
          foundIndex = c2;
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
          shape = " m=" + Object.keys(best.m || {}).length;
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
          + " mat=" + report.materialised
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

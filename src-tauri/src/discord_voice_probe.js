// Discord web voice probe.
//
// Injected by `discord_host.rs` through WebView2's own `ExecuteScript`; the
// returned value comes back as JSON. This client build keeps modules lazy,
// wraps exports in minified layers, and exposes several unrelated modules with
// same-named helpers. So candidates are (a) unwrapped up to three levels,
// (b) scored by how many extra store methods they expose, and (c) verified by
// behaviour (a channel lookup must return the channel for the id, a user
// lookup the user, voice-state keys must be numeric ids). Every property
// access is guarded: out-of-order materialisation can throw
// Temporal-Dead-Zone errors. Failures return `ok: false` with a bounded
// diagnostic line and the overlay stays on the RPC source.
(function () {
  var cache = window.__efxlveVoiceProbe;
  if (!cache) {
    cache = window.__efxlveVoiceProbe = { at: 0, stores: null, via: "", why: "" };
  }

  var ID = /^\d{5,}$/;

  // Extra names a real store of this kind tends to carry, used for scoring.
  var ROLES = [
    { key: "selected", need: "getVoiceChannelId", extras: ["getChannelId", "getLastSelectedChannelId"] },
    { key: "channels", need: "getChannel", extras: ["getChannels", "hasChannel", "getDMFromUserId", "getGuildId"] },
    { key: "voice", need: "getVoiceStatesForChannel", extras: ["getVoiceStates", "getVoiceState", "getVoiceChannelId"] },
    { key: "users", need: "getUser", extras: ["getUsers", "getCurrentUser"] },
    { key: "guilds", need: "getGuild", extras: ["getGuilds", "getGuildCount"] }
  ];

  function registryOf(win) {
    try {
      if (win.__efxlveVoiceRequire) return win.__efxlveVoiceRequire;
    } catch (e) {}
    var chunk = null;
    try {
      chunk = win.webpackChunkDiscord_app;
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

  // The object on which `prop` is callable, unwrapping up to `depth` layers of
  // minified wrappers. `null` when nothing matches.
  function findDeep(exp, prop, depth) {
    if (!exp || depth < 0) return null;
    try {
      if (typeof exp[prop] === "function") return exp;
    } catch (e) {}
    if (depth === 0) return null;
    var keys = [];
    try {
      keys = Object.keys(exp);
    } catch (e) {
      return null;
    }
    for (var i = 0; i < keys.length && i < 10; i++) {
      var inner = null;
      try {
        inner = exp[keys[i]];
      } catch (e) {
        continue;
      }
      if (!inner || (typeof inner !== "object" && typeof inner !== "function")) continue;
      var hit = findDeep(inner, prop, depth - 1);
      if (hit) return hit;
    }
    return null;
  }

  function score(candidate, extras) {
    var hits = 0;
    for (var i = 0; i < extras.length; i++) {
      try {
        if (typeof candidate[extras[i]] === "function") hits += 1;
      } catch (e) {}
    }
    return hits;
  }

  function pushCandidate(found, candidate, extras) {
    if (!candidate) return;
    for (var i = 0; i < found.length; i++) {
      if (found[i].candidate === candidate) return;
    }
    found.push({ candidate: candidate, score: score(candidate, extras) });
  }

  // Candidates for one role: instance cache first (deep unwrap), then factory
  // sources that mention the name (materialised, deep unwrap).
  function collect(req, role, report) {
    var found = [];
    var limit = 24;
    var mods = (req && req.c) || {};
    for (var key in mods) {
      if (found.length >= limit) break;
      var exp = null;
      try {
        exp = mods[key] && mods[key].exports;
      } catch (e) {
        continue;
      }
      pushCandidate(found, findDeep(exp, role.need, 3), role.extras);
    }
    if (found.length) {
      found.sort(function (a, b) { return b.score - a.score; });
      return found;
    }
    var m = (req && req.m) || {};
    var ids = Object.keys(m);
    for (var i = 0; i < ids.length && found.length < limit; i++) {
      var src = "";
      try {
        src = String(m[ids[i]]);
      } catch (e) {
        continue;
      }
      if (src.indexOf(role.need) < 0) continue;
      var mod = null;
      try {
        mod = req(ids[i]);
        report.materialised += 1;
      } catch (e) {
        report.threw += 1;
        continue;
      }
      var hit = findDeep(mod, role.need, 3);
      if (report.shapes.length < 6 && hit) {
        report.shapes.push(ids[i] + ":" + shapeOf(hit));
      }
      pushCandidate(found, hit, role.extras);
    }
    found.sort(function (a, b) { return b.score - a.score; });
    return found;
  }

  function shapeOf(exp) {
    try {
      return typeof exp + "{" + Object.keys(exp).slice(0, 6).join("|") + "}";
    } catch (e) {
      return "?" + typeof exp;
    }
  }

  // Picks the stores that behave like the client's own stores.
  function resolveStores(req, report) {
    var out = { selected: null, channels: null, voice: null, users: null, guilds: null, channelId: null };

    var selected = collect(req, ROLES[0], report);
    for (var i = 0; i < selected.length; i++) {
      try {
        var id = selected[i].candidate.getVoiceChannelId();
        if (id === null || id === undefined || typeof id === "string") {
          out.selected = selected[i].candidate;
          out.channelId = typeof id === "string" ? id : null;
          break;
        }
      } catch (e) {}
    }

    var channels = collect(req, ROLES[1], report);
    for (var c = 0; c < channels.length; c++) {
      try {
        var channel = out.channelId ? channels[c].candidate.getChannel(out.channelId) : null;
        if (
          channel &&
          typeof channel === "object" &&
          (String(channel.id) === String(out.channelId) || typeof channel.name === "string")
        ) {
          out.channels = channels[c].candidate;
          break;
        }
      } catch (e) {}
    }

    var voice = collect(req, ROLES[2], report);
    var states = null;
    for (var v = 0; v < voice.length; v++) {
      try {
        var map = out.channelId ? voice[v].candidate.getVoiceStatesForChannel(out.channelId) : null;
        if (map && typeof map === "object" && !Array.isArray(map)) {
          out.voice = voice[v].candidate;
          states = map;
          break;
        }
      } catch (e) {}
    }

    var userId = null;
    if (states) {
      for (var key2 in states) {
        if (ID.test(key2)) {
          userId = key2;
          break;
        }
      }
    }
    var users = collect(req, ROLES[3], report);
    for (var u = 0; u < users.length; u++) {
      try {
        var person = userId ? users[u].candidate.getUser(userId) : null;
        if (!userId || (person && typeof person === "object" && String(person.id) === String(userId))) {
          out.users = users[u].candidate;
          break;
        }
      } catch (e) {}
    }

    var guilds = collect(req, ROLES[4], report);
    if (guilds.length) out.guilds = guilds[0].candidate;

    if (out.selected && out.channels && out.voice && out.users) return out;
    return out;
  }

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

  function domFacts() {
    var bits = [];
    try {
      bits.push("rtc=" + (document.querySelector('[class*="rtcConnection"]') ? 1 : 0));
      bits.push("chanRows=" + document.querySelectorAll('[data-list-item-id^="channels___"]').length);
      bits.push(
        "avatars=" +
          document.querySelectorAll('img[src*="/avatars/"], img[src*="/embed/avatars/"]').length
      );
    } catch (e) {
      bits.push("dom=err");
    }
    return bits.join(" ");
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
            href = String(candidates[m2].location.href).slice(0, 80);
          } catch (e) {
            href = "x";
          }
          mounts.push(kids);
          hrefs.push(href);
        }
        var shape = best ? " m=" + Object.keys(best.m || {}).length : "";
        cache.at = Date.now();
        cache.why = "no-stores wins=" + candidates.length
          + " bestIdx=" + bestIndex
          + " bestM=" + bestCount
          + " chunks=[" + chunkInfo.join(" | ") + "]"
          + " mounts=[" + mounts.join(",") + "]"
          + " ready=" + document.readyState
          + " hrefs=[" + hrefs.join(" | ") + "]"
          + shape
          + " mat=" + report.materialised
          + " threw=" + report.threw
          + " shapes=[" + report.shapes.join(" ") + "]"
          + " dom=[" + domFacts() + "]"
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

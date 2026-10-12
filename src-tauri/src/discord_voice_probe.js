// Discord web voice probe.
//
// Injected by `discord_host.rs` through WebView2's own `ExecuteScript`; the
// returned value comes back as JSON. The visible client can live in the top
// window or in a same-origin frame, so every window is searched with the
// biggest module registry first. Nothing here touches Discord's DOM: the state
// is read from the client's own stores. Every failure returns `ok: false` with
// a bounded diagnostic line, and the Rust side keeps the overlay on the RPC
// source instead.
(function () {
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

  function byProps(req, names) {
    var mods = (req && req.c) || {};
    for (var key in mods) {
      var exp = null;
      try { exp = mods[key] && mods[key].exports; } catch (e) { continue; }
      if (!exp) continue;
      var hit = true;
      for (var i = 0; i < names.length; i++) {
        if (typeof exp[names[i]] !== "function") { hit = false; break; }
      }
      if (hit) return exp;
    }
    return null;
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
    return null;
  }

  // What a registry actually holds, so a renamed store can be fixed from the
  // log alone.
  function interestingNames(req) {
    var names = [];
    var mods = (req && req.c) || {};
    var keys = Object.keys(mods);
    for (var k = 0; k < keys.length; k++) {
      var exp = null;
      try { exp = mods[keys[k]] && mods[keys[k]].exports; } catch (e) { continue; }
      if (!exp || typeof exp !== "object") continue;
      for (var prop in exp) {
        if (typeof exp[prop] !== "function") continue;
        if (prop.indexOf("Voice") < 0 && prop.indexOf("Channel") < 0 && prop.indexOf("User") < 0) continue;
        if (names.indexOf(prop) < 0 && names.length < 30) names.push(prop);
      }
    }
    return names;
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
      var stores = storesOf(req);
      if (stores) {
        found = stores;
        foundIndex = c;
        break;
      }
    }

    if (!found) {
      var mounts = [];
      for (var m = 0; m < candidates.length; m++) {
        var kids = -1;
        try {
          var mount = candidates[m].document.getElementById("app-mount");
          kids = mount ? mount.childElementCount : -1;
        } catch (e) {
          kids = -9;
        }
        mounts.push(kids);
      }
      return {
        ok: false,
        why: "no-stores wins=" + candidates.length
          + " bestIdx=" + bestIndex
          + " bestM=" + bestCount
          + " mounts=[" + mounts.join(",") + "]"
          + " top=" + (window.top === window ? 1 : 0)
          + " href=" + location.href
          + " names=[" + interestingNames(best).join(",") + "]"
      };
    }

    var via = foundIndex === 0 ? "top" : "frame" + foundIndex;
    var channelId = found.selected.getVoiceChannelId();
    if (!channelId) return { ok: true, inCall: false, via: via };
    return {
      ok: true,
      inCall: true,
      via: via,
      channel: channelOf(found, channelId),
      participants: participantsOf(found, channelId)
    };
  } catch (e) {
    return { ok: false, why: String(e) };
  }
})()

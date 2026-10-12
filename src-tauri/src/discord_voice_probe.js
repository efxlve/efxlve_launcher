// Discord web probe (read-only).
//
// Injected by `discord_host.rs` through WebView2's own `ExecuteScript`; the
// returned value comes back as JSON. The client's modules are lazy and minified
// and several unrelated modules expose same-named helpers, so this follows the
// technique maintained plugins ship today (checked against Vencord `main`,
// October 2026):
//   * the main webpack require is captured early by `discord_voice_hook.js`;
//   * only *loaded* modules are walked (`mod.loaded`), getters are guarded
//     (a TDZ getter on a circular import must not break the page), and a
//     module whose factory threw stays half-built in the cache — so factories
//     are never called here;
//   * the Flux store base class is the module exporting `connectStores`; its
//     static `Store.getAll()` lists every registered store, keyed by
//     `getName()`.
//
// Strictly read-only: no dispatches, no actions, no REST. The only
// subscription is the `SPEAKING` event, used as a fallback for the speaking
// ring.
(function () {
  var S = window.__efxlveVoiceProbe;
  if (!S) {
    S = window.__efxlveVoiceProbe = {
      req: null,
      Base: null,
      dispatcher: null,
      speaking: {},
      lastScan: 0,
    };
  }

  // 1) The runtimes: the client may live in another same-origin realm (the
  //    empty iframe Discord keeps), so every realm is searched and the runtime
  //    with the most loaded modules wins. A live push only works while the
  //    chunk global still exists; the init hook's collector covers the rest.
  function realms() {
    var list = [window];
    try {
      for (var i = 0; i < window.frames.length; i++) {
        try {
          var frame = window.frames[i];
          if (frame && frame.document) list.push(frame);
        } catch (e) {}
      }
    } catch (e) {}
    return list;
  }
  function liveRequire(space) {
    try {
      var chunk = space.webpackChunkDiscord_app;
      if (!chunk || typeof chunk.push !== "function") return null;
      var captured = null;
      chunk.push([[Math.random().toString(36).slice(2)], {}, function (r) { captured = r; }]);
      chunk.pop();
      return captured;
    } catch (e) {
      return null;
    }
  }
  function loadedCount(candidate) {
    try {
      return candidate && candidate.c ? Object.keys(candidate.c).length : -1;
    } catch (e) {
      return -1;
    }
  }
  function pickRequire() {
    var best = null;
    var bestLoaded = -1;
    var bestSource = "none";
    var bestRealm = -1;
    var runs = 0;
    var spaces = realms();
    for (var s = 0; s < spaces.length; s++) {
      var space = spaces[s];
      var candidates = [];
      try {
        var collected = space.__efxlveRequires || null;
        if (collected) {
          runs += collected.length;
          for (var i = 0; i < collected.length; i++) candidates.push([collected[i], "collect" + i]);
        }
      } catch (e) {}
      try {
        if (space.__efxlveVoiceRequire) candidates.push([space.__efxlveVoiceRequire, "hook"]);
      } catch (e) {}
      candidates.push([liveRequire(space), "live"]);
      for (var c = 0; c < candidates.length; c++) {
        var value = candidates[c][0];
        if (!value || !value.c || !value.m) continue;
        var loaded = loadedCount(value);
        if (loaded > bestLoaded) {
          best = value;
          bestLoaded = loaded;
          bestSource = candidates[c][1];
          bestRealm = s;
        }
      }
    }
    if (loadedCount(S.req) > bestLoaded) {
      best = S.req;
      bestLoaded = loadedCount(S.req);
      bestSource = "cache";
      bestRealm = -1;
    }
    return { req: best, realm: bestRealm, source: bestSource, runs: runs, spaces: spaces.length };
  }
  var picked = pickRequire();
  var req = picked.req;
  if (!req || !req.c || !req.m) return { ok: false, why: "no-require" };
  S.req = req;

  var diag = "src=" + picked.source
    + " realm=" + picked.realm
    + " spaces=" + picked.spaces
    + " runs=" + picked.runs
    + " m=" + Object.keys(req.m).length
    + " c=" + Object.keys(req.c).length
    + " p=" + String(req.p || "");

  // 2) Walk only loaded modules, at most two levels deep and only into plain
  //    namespace objects. Getters are read at the top level only ("the module
  //    is already evaluated", so its own bindings are safe), never deeper: a
  //    nested getter is a re-export that would run another module early and a
  //    factory that throws leaves a half-built module in the cache. A node
  //    budget keeps the sweep from ever becoming a stall.
  var PROBE_KEY = "__efxlve_key_probe__";
  var NODE_BUDGET = 6000;
  function usable(value) {
    if (value == null || value === window || value === document) return false;
    var kind = typeof value;
    if (kind !== "object" && kind !== "function") return false;
    try {
      var tag = value[Symbol.toStringTag];
      if (tag === "IntlMessagesProxy" || tag === "DOMTokenList") return false;
      if (value[PROBE_KEY] !== undefined) return false;
      if (ArrayBuffer.isView(value)) return false;
    } catch (e) {
      return true;
    }
    return true;
  }
  function* walk(maxDepth) {
    var seen = new Set();
    var budget = NODE_BUDGET;
    for (var id in req.c) {
      if (budget <= 0) return;
      var mod = req.c[id];
      if (!mod || mod.loaded === false) continue;
      var root = null;
      try {
        root = mod.exports;
      } catch (e) {
        continue;
      }
      var stack = [[root, 0]];
      while (stack.length && budget > 0) {
        var item = stack.pop();
        var value = item[0];
        var depth = item[1];
        if (!usable(value) || seen.has(value)) continue;
        seen.add(value);
        budget -= 1;
        yield value;
        if (depth >= maxDepth || typeof value !== "object") continue;
        // Descend into plain objects only. The runtime may sit in another
        // same-origin realm, so its Object.prototype is not ours: a plain
        // object's prototype has no further prototype.
        var proto = Object.getPrototypeOf(value);
        if (proto !== null && Object.getPrototypeOf(proto) !== null) continue;
        var keys;
        try {
          keys = Object.keys(value);
        } catch (e) {
          continue;
        }
        for (var i = 0; i < keys.length; i++) {
          if (budget <= 0) break;
          var inner = null;
          try {
            var descriptor = Object.getOwnPropertyDescriptor(value, keys[i]);
            if (!descriptor) continue;
            if (descriptor.get) {
              if (depth > 0) continue;
              inner = value[keys[i]];
            } else {
              inner = descriptor.value;
            }
          } catch (e) {
            continue;
          }
          stack.push([inner, depth + 1]);
        }
      }
    }
  }

  // 3) The Flux store base class, then every registered store by name.
  function findStoreBase() {
    for (var first of walk(2)) {
      try {
        if (
          typeof first.connectStores === "function" &&
          first.Store &&
          typeof first.Store.getAll === "function"
        ) {
          return first.Store;
        }
      } catch (e) {}
    }
    for (var second of walk(2)) {
      try {
        var ctor = second.constructor;
        var name = ctor && ctor.displayName;
        if (typeof name !== "string" || name.length < 5) continue;
        if (name.slice(-5) !== "Store") continue;
        for (var proto = ctor; proto && proto !== Function.prototype; proto = Object.getPrototypeOf(proto)) {
          if (Object.prototype.hasOwnProperty.call(proto, "getAll") && typeof proto.getAll === "function") {
            return proto;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function nameOf(store) {
    try {
      return store.getName ? store.getName() : store.constructor && store.constructor.displayName;
    } catch (e) {
      return undefined;
    }
  }

  if (!S.Base) {
    // One sweep at a time: while the base class has not been found yet, the
    // probe must not re-walk every call.
    var now = Date.now();
    if (S.lastBaseScan && now - S.lastBaseScan < 10000) {
      return { ok: false, why: "store-base pending " + diag };
    }
    S.lastBaseScan = now;
    S.Base = findStoreBase();
  }
  if (!S.Base) return { ok: false, why: "no-store-base " + diag };

  var stores = {};
  try {
    var all = S.Base.getAll();
    for (var i = 0; i < all.length; i++) {
      var name = nameOf(all[i]);
      if (name && !stores[name]) stores[name] = all[i];
    }
  } catch (e) {
    return { ok: false, why: "store-scan " + String(e).slice(0, 60) + " " + diag };
  }
  // The fallback Vencord keeps for stores that are exported but not registered.
  var missing = ["SpeakingStore", "RTCConnectionStore", "MediaEngineStore"];
  if (Date.now() - S.lastScan > 30000) {
    var need = [];
    for (var m = 0; m < missing.length; m++) {
      if (!stores[missing[m]]) need.push(missing[m]);
    }
    if (need.length) {
      S.lastScan = Date.now();
      for (var value of walk(2)) {
        try {
          var display = value.constructor && value.constructor.displayName;
          if (display && need.indexOf(display) >= 0 && !stores[display]) stores[display] = value;
        } catch (e) {}
      }
    }
  }
  diag += " stores=" + Object.keys(stores).length;

  var users = stores.UserStore;
  var me = null;
  try {
    me = users && users.getCurrentUser ? users.getCurrentUser() : null;
  } catch (e) {}
  if (!me) {
    // Boot modules load before login settles; the caller polls until ready.
    return { ok: false, why: "not-ready " + diag };
  }

  // 4) Speaking: the store when present, the flux event as the fallback.
  if (!S.dispatcher) {
    var dispatcher = null;
    try {
      dispatcher = users._dispatcher;
    } catch (e) {}
    if (!(dispatcher && typeof dispatcher.subscribe === "function")) {
      dispatcher = null;
      for (var candidate of walk(2)) {
        try {
          if (
            typeof candidate.dispatch === "function" &&
            typeof candidate.subscribe === "function" &&
            typeof candidate.unsubscribe === "function" &&
            typeof candidate.getName !== "function"
          ) {
            dispatcher = candidate;
            break;
          }
        } catch (e) {}
      }
    }
    if (dispatcher) {
      S.dispatcher = dispatcher;
      try {
        dispatcher.subscribe("SPEAKING", function (event) {
          if (!event || (event.context && event.context !== "default")) return;
          if (event.speakingFlags) S.speaking[event.userId] = true;
          else delete S.speaking[event.userId];
        });
      } catch (e) {}
    }
  }

  function user(id) {
    try {
      return (users.getUser ? users.getUser(id) : null) || null;
    } catch (e) {
      return null;
    }
  }

  function displayName(person, guildId) {
    if (!person) return null;
    try {
      var nick = guildId && stores.GuildMemberStore && stores.GuildMemberStore.getNick
        ? stores.GuildMemberStore.getNick(guildId, person.id)
        : null;
      if (nick) return nick;
    } catch (e) {}
    try {
      var friendNick = stores.RelationshipStore && stores.RelationshipStore.getNickname
        ? stores.RelationshipStore.getNickname(person.id)
        : null;
      if (friendNick) return friendNick;
    } catch (e) {}
    return person.globalName || person.global_name || person.username || null;
  }

  function watching(userId) {
    var speakingStore = stores.SpeakingStore;
    try {
      if (speakingStore && typeof speakingStore.isSpeaking === "function") {
        return !!speakingStore.isSpeaking(userId);
      }
    } catch (e) {}
    return !!S.speaking[userId];
  }

  // Map-like values may come from another realm, so `instanceof Map` is not
  // enough: duck-type instead.
  function isMapLike(value) {
    return (
      value &&
      typeof value === "object" &&
      typeof value.get === "function" &&
      typeof value.entries === "function" &&
      typeof value.keys === "function"
    );
  }

  function valuesOf(collection) {
    if (isMapLike(collection)) return Array.from(collection.values());
    return Object.values(collection || {});
  }

  function entriesOf(collection) {
    if (isMapLike(collection)) return Array.from(collection.entries());
    return Object.entries(collection || {});
  }

  // 5) The voice call this client is in.
  var voice = null;
  var channelId = null;
  try {
    channelId = stores.SelectedChannelStore && stores.SelectedChannelStore.getVoiceChannelId
      ? stores.SelectedChannelStore.getVoiceChannelId()
      : null;
  } catch (e) {}
  if (!channelId) {
    try {
      channelId = stores.RTCConnectionStore && stores.RTCConnectionStore.getChannelId
        ? stores.RTCConnectionStore.getChannelId()
        : null;
    } catch (e) {}
  }
  if (channelId) {
    var channel = null;
    try {
      channel = stores.ChannelStore && stores.ChannelStore.getChannel
        ? stores.ChannelStore.getChannel(channelId)
        : null;
    } catch (e) {}
    var guildId = channel ? channel.guild_id || channel.guildId || null : null;
    var guild = null;
    try {
      guild = guildId && stores.GuildStore && stores.GuildStore.getGuild
        ? stores.GuildStore.getGuild(guildId)
        : null;
    } catch (e) {}
    var engine = stores.MediaEngineStore;
    var states = null;
    try {
      states = stores.VoiceStateStore && stores.VoiceStateStore.getVoiceStatesForChannel
        ? stores.VoiceStateStore.getVoiceStatesForChannel(channelId)
        : null;
    } catch (e) {}
    var people = [];
    var list = valuesOf(states);
    for (var p = 0; p < list.length; p++) {
      var state = list[p] || {};
      if (!state.userId) continue;
      var person = user(state.userId);
      var muted = !!state.selfMute || !!state.mute;
      try {
        if (engine && typeof engine.isLocalMute === "function" && engine.isLocalMute(state.userId)) muted = true;
      } catch (e) {}
      people.push({
        id: String(state.userId),
        name: displayName(person, guildId) || String(state.userId),
        avatar: person && person.avatar ? person.avatar : "",
        muted: muted,
        speaking: watching(state.userId),
      });
    }
    voice = {
      channel: {
        id: String(channelId),
        name: channel && channel.name
          ? channel.name
          : channel && channel.recipients
            ? channel.recipients.map(function (id) { return displayName(user(id)) || id; }).join(", ")
            : "",
        guild: guild && guild.name ? guild.name : "",
      },
      participants: people,
    };
    try {
      if (engine && typeof engine.isSelfMute === "function" && engine.isSelfMute()) {
        voice.selfMuted = true;
      }
      if (engine && typeof engine.isSelfDeaf === "function" && engine.isSelfDeaf()) {
        voice.selfDeafened = true;
      }
    } catch (e) {}
  }

  // 6) Relationships: 1 friend, 2 blocked, 3 incoming, 4 outgoing (5 implicit,
  //    6 suggestion are not people you asked for).
  var friends = [];
  var pending = 0;
  try {
    var relationshipStore = stores.RelationshipStore;
    var relationships = null;
    if (relationshipStore) {
      relationships = relationshipStore.getMutableRelationships
        ? relationshipStore.getMutableRelationships()
        : relationshipStore.getRelationships
          ? relationshipStore.getRelationships()
          : null;
    }
    var mode = stores.PresenceStore;
    var pairs = entriesOf(relationships);
    for (var r = 0; r < pairs.length; r++) {
      var userId = pairs[r][0];
      var kind = pairs[r][1];
      if (kind === 3 || kind === 4) {
        pending += 1;
        continue;
      }
      if (kind !== 1) continue;
      var friend = user(userId);
      var status = "offline";
      try {
        if (mode && typeof mode.getStatus === "function") status = mode.getStatus(userId) || "offline";
      } catch (e) {}
      friends.push({
        id: String(userId),
        name: displayName(friend, null) || String(userId),
        avatar: friend && friend.avatar ? friend.avatar : "",
        status: status,
      });
    }
  } catch (e) {}
  // The list can be long; the card shows the first rows and a count.
  var friendTotal = friends.length;
  if (friends.length > 300) friends = friends.slice(0, 300);

  return {
    ok: true,
    inCall: !!voice,
    via: "top",
    channel: voice ? voice.channel : null,
    participants: voice ? voice.participants : [],
    friends: friends,
    friendsTotal: friendTotal,
    pending: pending,
    me: { id: me.id, name: displayName(me, null) || me.username || "", avatar: me.avatar || "" },
    diag: diag,
  };
})()

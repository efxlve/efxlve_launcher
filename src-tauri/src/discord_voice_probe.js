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

  // 1) The main webpack runtime. The client keeps several of them in this
  //    realm (its own, plus sentry/libdiscore/fast-connect), they all share the
  //    chunk global and a helper can look identical (`p === "/assets/"`) while
  //    carrying only boot modules. One push is answered by every runtime in the
  //    chain, and `discord_voice_hook.js` also remembered them at document
  //    start. The client's own instance is the one with the most loaded modules
  //    among those with `/assets/` and a real chunk-name function.
  function collectRuntimes() {
    try {
      var chunk = window.webpackChunkDiscord_app;
      if (!chunk || typeof chunk.push !== "function") return [];
      var found = [];
      var entry = [
        [Math.random().toString(36).slice(2)],
        {},
        function (r) {
          if (found.indexOf(r) < 0) found.push(r);
        },
      ];
      chunk.push(entry);
      try {
        if (chunk[chunk.length - 1] === entry) chunk.pop();
      } catch (e) {}
      return found;
    } catch (e) {
      return [];
    }
  }
  // A constant chunk-name function marks the libdiscore helper runtime.
  function constantChunkName(runtime) {
    try {
      return /(?:=>|{return)"[^"]+?"[^=]/.test(String(runtime.u));
    } catch (e) {
      return true;
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
    var candidates = [];
    try {
      var remembered = window.__efxlveRuntimes || [];
      for (var i = 0; i < remembered.length; i++) candidates.push(remembered[i]);
    } catch (e) {}
    var live = collectRuntimes();
    for (var j = 0; j < live.length; j++) candidates.push(live[j]);
    candidates.push(S.req);
    var best = null;
    var bestLoaded = -1;
    var fallback = null;
    var fallbackLoaded = -1;
    var counts = [];
    for (var c = 0; c < candidates.length; c++) {
      var value = candidates[c];
      if (!value || !value.c || !value.m) continue;
      var loaded = loadedCount(value);
      var usable = String(value.p || "") === "/assets/" && !constantChunkName(value);
      counts.push(loaded + (usable ? "" : "*"));
      if (loaded > fallbackLoaded) {
        fallback = value;
        fallbackLoaded = loaded;
      }
      if (usable && loaded > bestLoaded) {
        best = value;
        bestLoaded = loaded;
      }
    }
    return {
      req: best || fallback,
      loaded: best ? bestLoaded : fallbackLoaded,
      runs: candidates.length,
      counts: counts.join("/"),
    };
  }
  var picked = pickRequire();
  var req = picked.req;
  if (!req || !req.c || !req.m) return { ok: false, why: "no-require" };
  S.req = req;

  var diag = "runs=" + picked.runs
    + " c=" + picked.loaded
    + " all=[" + picked.counts + "]"
    + " m=" + Object.keys(req.m).length
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

  // Voice channels the user can jump to, grouped by guild in the client's own
  // order (read-only: joining happens in the real client).
  var channels = [];
  try {
    var guildStore = stores.GuildStore;
    var channelStore = stores.ChannelStore;
    var guilds = null;
    try {
      guilds = guildStore && guildStore.getSortedGuilds
        ? guildStore.getSortedGuilds()
        : guildStore && guildStore.getGuilds
          ? valuesOf(guildStore.getGuilds()).sort(function (a, b) {
              return String(a && a.name).localeCompare(String(b && b.name));
            })
          : null;
    } catch (e) {}
    for (var gi = 0; guilds && gi < guilds.length && channels.length < 24; gi++) {
      var guild = guilds[gi] || {};
      if (!guild.id) continue;
      var raw = null;
      try {
        raw = channelStore && channelStore.getChannels ? channelStore.getChannels(guild.id) : null;
      } catch (e) {}
      var pool = [];
      if (raw && typeof raw === "object") {
        var grouped = false;
        for (var group in raw) {
          if (Array.isArray(raw[group])) {
            grouped = true;
            pool = pool.concat(raw[group]);
          }
        }
        if (!grouped) pool = valuesOf(raw);
      }
      for (var ci = 0; ci < pool.length && channels.length < 24; ci++) {
        var channel = pool[ci];
        if (!channel || Number(channel.type) !== 2) continue;
        channels.push({
          id: String(channel.id),
          name: channel.name || "",
          guild: guild.name || "",
          guildId: String(guild.id),
        });
      }
    }
  } catch (e) {}

  // 6) An incoming call rings in the web client: IncomingCallStore is the
  //    signal (the SDK's call API covers only calls it started itself).
  var call = { found: false, ringing: 0, active: 0, from: "", channelId: "" };
  try {
    var incoming = stores.IncomingCallStore;
    if (incoming) {
      call.found = true;
      if (typeof incoming.hasIncomingCalls === "function") {
        call.ringing = incoming.hasIncomingCalls() ? 1 : 0;
      }
      if (typeof incoming.getIncomingCallChannelIds === "function") {
        var incomingIds = incoming.getIncomingCallChannelIds() || [];
        if (incomingIds.length) call.channelId = String(incomingIds[0]);
      }
      if (typeof incoming.getIncomingCalls === "function") {
        var incomingList = incoming.getIncomingCalls() || {};
        for (var incomingKey in incomingList) {
          var entry = incomingList[incomingKey] || {};
          var who = entry.userId || entry.ringingUserId || entry.callerId || entry.otherUserId || "";
          if (who) call.from = String(who);
          break;
        }
      }
      // A DM channel knows its recipients, which is the caller.
      if (!call.from && call.channelId) {
        try {
          if (stores.ChannelStore && typeof stores.ChannelStore.getChannel === "function") {
            var dmChannel = stores.ChannelStore.getChannel(call.channelId);
            var recipients = (dmChannel && (dmChannel.recipients || dmChannel.rawRecipients)) || [];
            if (recipients.length) {
              call.from = String(recipients[0].userId || recipients[0].id || recipients[0] || "");
            }
          }
        } catch (e) {}
      }
    }
    var callStore = stores.CallStore;
    if (callStore && typeof callStore.getCalls === "function") {
      var calls = callStore.getCalls() || {};
      call.active = Object.keys(calls).length;
      call.found = true;
    }
  } catch (e) {}

  // 7) Discovery: which call-ish stores exist and what they expose, logged
  //    once per page load so the reader can be corrected without a live call.
  //    Class methods are non-enumerable, so getOwnPropertyNames is the only way
  //    to see them.
  if (!S.CallDiag) {
    var storeNames = [];
    try {
      for (var storeKey in stores) {
        if (!/call|ring/i.test(storeKey)) continue;
        var probeStore = stores[storeKey];
        var names = [];
        try {
          names = names.concat(Object.getOwnPropertyNames(probeStore));
        } catch (e) {}
        try {
          names = names.concat(Object.getOwnPropertyNames(Object.getPrototypeOf(probeStore) || {}));
        } catch (e) {}
        var methods = [];
        for (var ni = 0; ni < names.length && methods.length < 12; ni++) {
          if (names[ni] === "constructor") continue;
          try {
            if (typeof probeStore[names[ni]] === "function") methods.push(names[ni]);
          } catch (e) {}
        }
        storeNames.push(storeKey + "{" + methods.join(",") + "}");
      }
    } catch (e) {}
    S.CallDiag = storeNames.join(" ") || "none";
  }

  return {
    ok: true,
    inCall: !!voice,
    via: "top",
    channel: voice ? voice.channel : null,
    participants: voice ? voice.participants : [],
    friends: friends,
    friendsTotal: friendTotal,
    pending: pending,
    channels: channels,
    call: call,
    callDiag: S.CallDiag,
    me: { id: me.id, name: displayName(me, null) || me.username || "", avatar: me.avatar || "" },
    diag: diag,
  };
})()

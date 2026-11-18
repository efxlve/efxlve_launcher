/**
 * Overlay Discord view: the friend picker, the conversation, the voice card,
 * the reply composer and the Social SDK event glue.
 *
 * One-way dependency: the page configures view queries through
 * configureDiscord; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { toast } from "../../core/toast";
import { emptyBlockHtml } from "./overlay-view-helpers";

interface DiscordDeps {
  viewEl: (tab: "discord" | "chat") => HTMLElement | null;
  isWidgetOpen: (tab: "discord" | "chat") => boolean;
  openWidget: (tab: "discord" | "chat") => void;
  bringToFront: (tab: "discord" | "chat") => void;
}

let deps: DiscordDeps | null = null;

export function configureDiscord(next: DiscordDeps): void {
  deps = next;
}

function pageView(tab: "discord" | "chat"): HTMLElement | null {
  return deps?.viewEl(tab) ?? null;
}

function pageOpen(tab: "discord" | "chat"): boolean {
  return deps?.isWidgetOpen(tab) ?? false;
}

/* ---------- Discord voice (streamed by the Rust worker) ---------- */

export interface VoiceParticipant {
  id: string;
  name: string;
  avatarUrl: string;
  speaking: boolean;
  muted: boolean;
}

export interface VoiceChannel {
  id: string;
  name: string;
  guildId: string | null;
}

export interface DiscordVoiceState {
  status: string;
  channel: VoiceChannel | null;
  participants: VoiceParticipant[];
  error: string | null;
}

let voiceState: DiscordVoiceState = { status: "idle", channel: null, participants: [], error: null };
/** Last channel with its people, kept so a reconnect does not blank the card. */
let lastVoiceChannel: VoiceChannel | null = null;
let lastVoiceParticipants: VoiceParticipant[] = [];

export interface FriendEntry {
  id: string;
  name: string;
  avatarUrl: string;
  /** "online" | "idle" | "dnd" | "offline" */
  status: string;
}

export interface DiscordFriendsState {
  status: string;
  friends: FriendEntry[];
  /** Incoming requests, straight from the SDK's relationship list. */
  pendingUsers?: FriendEntry[];
  pending: number;
  error: string | null;
}

let friendsState: DiscordFriendsState = { status: "idle", friends: [], pending: 0, error: null };
/** Last list, kept so a reconnect does not blank the card. */
let lastFriends: FriendEntry[] = [];
let lastFriendsPending = 0;

/* ---------- Discord Social SDK (the reply path) ---------- */

export interface SdkMe {
  id: string;
  name: string;
  avatarUrl: string;
  /** "online" | "idle" | "dnd" | "offline" */
  status?: string;
}

export interface SdkState {
  /** "idle" | "starting" | "authorizing" | "connecting" | "ready" | "error" */
  status: string;
  error: string | null;
  me: SdkMe | null;
}

let sdkState: SdkState = { status: "idle", error: null, me: null };
/** The SDK's own relationship list: the source that also works with no page. */
let sdkFriends: DiscordFriendsState = { status: "idle", friends: [], pending: 0, error: null };

/** The launcher's own Discord page call (no desktop app involved). */
export interface WebVoiceParticipant {
  id: string;
  name: string;
  avatarUrl: string;
  muted: boolean;
  speaking: boolean;
}

export interface WebFriend {
  id: string;
  name: string;
  avatarUrl: string;
  status: string;
}

/** A group DM the launcher's own client knows. Read-only here: the overlay
 * lists it and opens the conversation in the real client. */
export interface WebGroupConversation {
  id: string;
  name: string;
  members: { id: string; name: string; avatarUrl: string }[];
  memberCount: number;
  unread: number;
  preview: { author: string; text: string } | null;
}

export interface WebVoiceState {
  inCall: boolean;
  channel: { id: string; name: string; guild: string } | null;
  participants: WebVoiceParticipant[];
  /** Relationships read from the same stores. */
  friends?: WebFriend[];
  friendsTotal?: number;
  pending?: number;
  /** Voice channels to jump to (the client opens them; joining stays there). */
  channels?: { id: string; name: string; guild: string; guildId: string }[];
  /** Group DMs the client has: the overlay shows them, the client writes them. */
  conversations?: WebGroupConversation[];
}

let webVoice: WebVoiceState | null = null;


/* 8. Discord View */
/**
 * Exactly two areas: the friend picker (left) and the conversation (right).
 * Everything else — requests, channels, adding a friend, the status — is a
 * takeover behind one labelled button in the picker or conversation header, so
 * the default screen only shows who is talking and what they said. Writing and
 * calling go through the Social SDK; the full client stays one tab away.
 */

/** One message in the conversation: what we sent, and what arrived. */
interface ReplyLogEntry {
  id: number;
  friendId: string;
  /** The Discord message id, once the SDK reported it: delete and open need it. */
  messageId?: string;
  time: string;
  text: string;
  /** An attachment's name (image, GIF, sticker): the SDK sends no URL. */
  attachment?: string;
  state: "sending" | "sent" | "error";
  error?: string;
  /** "out" = sent from here, "in" = received. */
  direction: "out" | "in";
}

let replyLog: ReplyLogEntry[] = [];
let replyLogSeq = 0;
/** Per-friend drafts, so switching targets never loses what was typed. */
const replyDrafts = new Map<string, string>();
/** Unread arrivals per friend, cleared when their conversation is picked. */
const replyUnread = new Map<string, number>();
const LAST_FRIEND_KEY = "efxlve-overlay-dm";
/** The friend the composer writes to. */
let replyTarget: { id: string; name: string } | null = null;
/** True while a send is in flight: the button stays disabled until the SDK reports. */
let replySending = false;
/** The log row being edited, if any: the composer then saves instead of sends. */
let editingEntryId: number | null = null;
/** The compose draft put aside while editing, per friend. */
const editStash = new Map<string, string>();
/** Which takeover borrows the picker column, if any. */
type PickerMode = "friends" | "requests" | "add" | "status" | "channels";
let pickerMode: PickerMode = "friends";
/** The add-friend search's state. */
let searchQuery = "";
let searchRan = false;
let searchResults: { id: string; name: string; username: string; avatarUrl: string }[] = [];
/** Usernames a request was sent to this session, so the row stops offering it. */
const sentRequests = new Set<string>();
/** The DM call the overlay started, if any (the SDK's own call). */
let callState: { active: boolean; friendId: string | null; muted: boolean } = {
  active: false,
  friendId: null,
  muted: false,
};

/** The friend rows the picker shows: the live desktop read, the launcher's own
 * web client, the SDK's own list, then the last known list. Online first. */
function friendEntries(): FriendEntry[] {
  const state = friendsState;
  const live = state.status === "ready" && state.friends.length ? state.friends : null;
  const web = webVoice && webVoice.friends && webVoice.friends.length ? webVoice.friends : null;
  const sdk = sdkFriends.status === "ready" && sdkFriends.friends.length ? sdkFriends.friends : null;
  const friends = live ?? web ?? sdk ?? lastFriends;
  return [...friends].sort(
    (a, b) =>
      Number(a.status === "offline") - Number(b.status === "offline") ||
      a.name.localeCompare(b.name),
  );
}

/** The presence word for a friend's status (or the account's own). */
function presenceWord(status: string): string {
  switch (status) {
    case "online":
      return t("overlay.discordStatusOnline");
    case "idle":
      return t("overlay.discordStatusIdle");
    case "dnd":
      return t("overlay.discordStatusDnd");
    case "invisible":
      return t("overlay.discordStatusInvisible");
    default:
      return t("overlay.discordStatusOffline");
  }
}

let friendsFilterQuery = "";

/** One intentional first screen instead of a profile row above a dead list. */
function discordConnectStateHtml(): string {
  const starting = sdkState.status === "starting";
  const failed = sdkState.status === "error";
  const body = starting
    ? t("overlay.discordApprove")
    : failed
      ? sdkState.error || t("common.unknownError")
      : t("overlay.discordSdkDesc");
  return `
    <div class="ov-dc-onboard">
      <div class="ov-dc-onboard-mark">${icon("discord", 30)}</div>
      <h2 class="ov-dc-onboard-title">${esc(starting ? t("overlay.discordConnecting") : t("overlay.discordNotConnected"))}</h2>
      <p class="ov-dc-onboard-desc">${esc(body)}</p>
      <div class="ov-dc-onboard-features">
        <span>${icon("users", 14)} ${esc(t("overlay.discordFriendsTitle"))}</span>
        <span>${icon("mail", 14)} ${esc(t("overlay.discordReplyTitle"))}</span>
        <span>${icon("mic", 14)} ${esc(t("overlay.discordVoiceTitle"))}</span>
      </div>
      <button class="btn primary ov-dc-onboard-connect" data-ov="discord-sdk-start" ${starting ? "disabled" : ""}>
        ${icon("discord", 14)} <span>${esc(starting ? t("overlay.discordConnecting") : t("overlay.discordConnect"))}</span>
      </button>
      <button class="btn ghost small" data-ov="discord-open-launcher">
        ${icon("external", 13)} <span>${esc(t("overlay.openDiscord"))}</span>
      </button>
    </div>`;
}

export function renderDiscordSocial(): void {
  const el = pageView("discord");
  if (!el) return;
  // With no SDK session, no RPC friend list and no active call there is nothing
  // useful to list: show the single connect surface instead of an empty column.
  if (sdkState.status !== "ready" && friendEntries().length === 0 && !webVoice?.inCall) {
    el.innerHTML = `<div class="ov-dc-social-body">${discordConnectStateHtml()}</div>`;
    return;
  }
  const requests = sdkFriends.pendingUsers ?? [];
  if (pickerMode === "requests") {
    el.innerHTML = takeoverSocialHtml(
      t("overlay.discordRequests"),
      requests.length
        ? requests.map(requestRowHtml).join("")
        : `<div class="empty-picker-wrap"><span>${esc(t("overlay.discordFriendsEmpty"))}</span></div>`,
    );
    return;
  }
  if (pickerMode === "add") {
    el.innerHTML = takeoverSocialHtml(t("overlay.discordAddFriend"), addFriendBodyHtml());
    return;
  }
  if (pickerMode === "status") {
    el.innerHTML = takeoverSocialHtml(t("overlay.discordStatusLabel"), statusBodyHtml());
    return;
  }
  if (pickerMode === "channels") {
    el.innerHTML = takeoverSocialHtml(t("overlay.discordChannels"), channelsBodyHtml());
    return;
  }

  el.innerHTML = `
    <div class="ov-dc-social-body">
      ${socialProfileHtml()}
      ${socialVoiceHtml()}
      ${socialSearchStripHtml(requests.length)}
      <div class="ov-dc-friends-scroll">
        ${socialListHtml()}
      </div>
    </div>`;
}

function takeoverSocialHtml(title: string, body: string): string {
  return `
    <div class="ov-dc-social-body">
      <div class="takeover-header">
        <button class="takeover-back-btn" data-ov="discord-picker" data-mode="friends">← ${esc(t("overlay.discordFriendsTitle"))}</button>
        <span class="takeover-title">${esc(title)}</span>
      </div>
      <div class="ov-dc-friends-scroll">${body}</div>
    </div>`;
}

export function renderDiscordChat(): void {
  const el = pageView("chat");
  if (!el) return;
  if (sdkState.status !== "ready") {
    el.innerHTML = `
      <div class="ov-dc-chat-body">
        ${connectHtml()}
      </div>`;
    return;
  }
  if (!replyTarget) {
    const stored = localStorage.getItem(LAST_FRIEND_KEY);
    const pick = friendEntries().find((f) => f.id === stored);
    if (pick) replyTarget = { id: pick.id, name: pick.name };
  }
  if (replyTarget) {
    ensureHistory(replyTarget.id);
  }
  const target = replyTarget;
  if (!target) {
    el.innerHTML = `
      <div class="ov-dc-chat-body">
        ${chatEmptyPlaceholderHtml()}
      </div>`;
    return;
  }
  const friend = friendEntries().find((f) => f.id === target.id);
  const draft = replyDrafts.get(target.id) ?? "";
  const editing =
    editingEntryId !== null
      ? replyLog.find((item) => item.id === editingEntryId) ?? null
      : null;

  el.innerHTML = `
    <div class="ov-dc-chat-body">
      ${chatTargetHeaderHtml(target, friend)}
      <div class="ov-dc-chat-messages" id="ov-dc-chat-messages">
        ${chatMessagesHtml(target)}
      </div>
      ${chatComposerHtml(target, draft, editing)}
    </div>`;

  const box = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  if (box && box.value) growComposer(box);

  const scrollContainer = document.getElementById("ov-dc-chat-messages");
  if (scrollContainer) {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }
}

function renderDiscord(): void {
  if (pageOpen("discord")) renderDiscordSocial();
  if (pageOpen("chat")) renderDiscordChat();
}

/** The field grows with the draft, then scrolls at six lines. */
export function growComposer(box: HTMLTextAreaElement): void {
  box.style.height = "auto";
  box.style.height = `${Math.min(88, Math.max(34, box.scrollHeight))}px`;
}

export function repaintDiscordChat(): void {
  const box = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  const wasFocused = box !== null && document.activeElement === box;
  const caret = box ? box.selectionStart : 0;
  renderDiscordChat();
  if (!wasFocused) return;
  const fresh = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  if (!fresh) return;
  fresh.focus();
  fresh.setSelectionRange(caret, caret);
}

/** True when a Discord surface is on screen. The chat widget can be open on its
 * own, so a `discord`-only guard left its send/edit state stale. */
export function discordOnScreen(): boolean {
  return (pageOpen("discord") || pageOpen("chat")) && !document.hidden;
}

export function repaintDiscord(): void {
  if (pageOpen("discord")) {
    const social = pageView("discord");
    const active = document.activeElement as HTMLElement | null;
    // Presence events must not pull the caret out of the friend filter or the
    // add-friend box. While those own focus, patch only the list underneath.
    if (
      social &&
      active &&
      social.contains(active) &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
    ) {
      if (pickerMode === "friends") repaintFriendsList();
    } else {
      const scrollTop = social?.querySelector<HTMLElement>(".ov-dc-friends-scroll")?.scrollTop ?? 0;
      renderDiscordSocial();
      if (scrollTop > 0) {
        const next = pageView("discord")?.querySelector<HTMLElement>(".ov-dc-friends-scroll");
        if (next) next.scrollTop = scrollTop;
      }
    }
  }
  if (pageOpen("chat")) repaintDiscordChat();
}

/** Puts the caret in the composer: after picking a friend the keyboard belongs
 * to the text box, not to the focus ring (Enter/Space would re-fire the row). */
export function focusReplyInput(): void {
  requestAnimationFrame(() => {
    document.getElementById("ov-discord-reply-input")?.focus();
  });
}

/** Selects a friend for the composer; a typed letter can seed the draft. */
export function selectReplyTarget(id: string, name: string, seed = ""): void {
  // Switching conversations ends an edit started in the previous one: saveEdit
  // holds that entry's id, so the composer would edit A while showing B.
  if (editingEntryId !== null) cancelEdit();
  replyTarget = { id, name };
  if (seed) replyDrafts.set(id, seed);
  replyUnread.delete(id);
  pickerMode = "friends";
  localStorage.setItem(LAST_FRIEND_KEY, id);
  ensureHistory(id);
  deps?.openWidget("chat");
  deps?.bringToFront("chat");
  renderDiscordChat();
  if (pageOpen("discord")) renderDiscordSocial();
  focusReplyInput();
}

/** A message that arrived while the overlay is open: it lands in that friend's
 * thread, and a badge waits on the row if the conversation is not on screen. */
export function noteIncoming(
  friendId: string,
  text: string,
  at: number,
  messageId?: string,
  attachment?: string,
): void {
  const time = new Date(at > 0 ? at : Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  replyLog.push({
    id: ++replyLogSeq,
    friendId,
    messageId,
    time,
    text,
    attachment,
    state: "sent",
    direction: "in",
  });
  if (replyLog.length > 400) replyLog.splice(0, replyLog.length - 400);
  if (replyTarget?.id !== friendId) {
    replyUnread.set(friendId, (replyUnread.get(friendId) ?? 0) + 1);
  }
  void notifyMessage(friendId, text);
  if ((pageOpen("discord") || pageOpen("chat")) && !document.hidden) repaintDiscord();
}

/** A desktop notification for a message that arrived while the panel was not
 * showing that conversation. The permission is asked once, on the first one.
 *
 * The toast plugin does not wire clicks on Windows desktop (its action API is
 * mobile-only), so the sender is preselected instead: opening the panel lands
 * straight in their conversation. */
async function notifyMessage(friendId: string, text: string): Promise<void> {
  const showing = pageOpen("chat") && !document.hidden && replyTarget?.id === friendId;
  if (showing) return;
  // A conversation is already on screen: never move its target behind the
  // user's back, or the draft they typed for A is sent to B.
  const conversationOnScreen =
    (pageOpen("chat") || pageOpen("discord")) && !document.hidden;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    const friend = friendEntries().find((item) => item.id === friendId);
    sendNotification({
      title: friend?.name ?? t("overlay.tabDiscord"),
      body: text || t("overlay.discordSent"),
    });
    // Next open lands in that conversation.
    if (friend && !conversationOnScreen) {
      replyTarget = { id: friend.id, name: friend.name };
      localStorage.setItem(LAST_FRIEND_KEY, friend.id);
    }
  } catch {
    // No permission: the unread badge in the panel is still waiting.
  }
}

/** An incoming call in the launcher's own client: a desktop notification, and
 * the caller is preselected so opening the panel lands in their conversation. */
export async function notifyIncomingCall(from: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    const friend = friendEntries().find((item) => item.id === from);
    // With a name the title is the caller and the body says what this is; with
    // no name the title carries it alone.
    sendNotification({
      title: friend?.name ?? t("overlay.discordCallIncoming"),
      body: friend ? t("overlay.discordCallIncoming") : "",
    });
    // Only preselect when the panel is not already showing a conversation.
    if (friend && !((pageOpen("chat") || pageOpen("discord")) && !document.hidden)) {
      replyTarget = { id: friend.id, name: friend.name };
      localStorage.setItem(LAST_FRIEND_KEY, friend.id);
    }
  } catch {
    // No permission: nothing else to do here.
  }
}

/** Ctrl+Up/Down inside the box: walk the friend list without losing the draft. */
export function stepReplyTarget(direction: number): void {
  const friends = friendEntries();
  if (friends.length < 2) return;
  const index = friends.findIndex((friend) => friend.id === replyTarget?.id);
  const next = friends[(index < 0 ? 0 : index + direction + friends.length) % friends.length];
  const box = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  if (box && replyTarget) replyDrafts.set(replyTarget.id, box.value);
  selectReplyTarget(next.id, next.name);
}

/** Esc leaves the box back to the selected row; a second Esc closes the panel. */
export function focusSelectedFriendRow(): void {
  const row =
    document.querySelector<HTMLElement>('.ov-dc-friend-item[data-ov="discord-select-friend"].is-active') ??
    document.querySelector<HTMLElement>('.ov-dc-friend-item[data-ov="discord-select-friend"]');
  row?.focus();
}

/** A conversation's entries, oldest first. Snowflake ids order the messages;
 * ones still in flight (no id yet) go last. */
function threadEntries(friendId: string): ReplyLogEntry[] {
  return replyLog
    .filter((entry) => entry.friendId === friendId)
    .sort((a, b) => compareMessageIds(a.messageId, b.messageId));
}

function compareMessageIds(a?: string, b?: string): number {
  if (a && b) {
    // Snowflakes are all the same length; lexicographic order is time order.
    return a.length === b.length ? a.localeCompare(b) : a.length - b.length;
  }
  if (a) return -1;
  if (b) return 1;
  return 0;
}

/** Friends whose history was already pulled this session. */
const historyLoaded = new Set<string>();

/** Pulls the last messages once per conversation, so the log opens with the
 * real thread instead of only what happened since the overlay started. */
function ensureHistory(friendId: string): void {
  if (historyLoaded.has(friendId)) return;
  historyLoaded.add(friendId);
  void invoke("discord_sdk_history", { userId: friendId, limit: 30 }).catch(() => {
    historyLoaded.delete(friendId);
  });
}

export interface HistoryMessage {
  messageId: string;
  text: string;
  attachment?: string;
  at: number;
  direction: "out" | "in";
}

/** History merges under the session entries: known ids are skipped, and the
 * thread keeps snowflake order. */
export function mergeHistory(friendId: string, messages: HistoryMessage[]): void {
  const known = new Set(
    replyLog
      .filter((entry) => entry.friendId === friendId && entry.messageId)
      .map((entry) => entry.messageId),
  );
  let added = 0;
  for (const message of messages) {
    if (!message.messageId || known.has(message.messageId)) continue;
    known.add(message.messageId);
    replyLog.push({
      id: ++replyLogSeq,
      friendId,
      messageId: message.messageId,
      time: new Date(message.at > 0 ? message.at : Date.now()).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      text: message.text,
      attachment: message.attachment || undefined,
      state: "sent",
      direction: message.direction,
    });
    added += 1;
  }
  if (!added) return;
  if (replyLog.length > 400) replyLog.splice(0, replyLog.length - 400);
  if ((pageOpen("discord") || pageOpen("chat")) && !document.hidden) repaintDiscord();
}

/* --- Area 1: Discord Social (Friends List & Voice) --- */

function socialProfileHtml(): string {
  const me = sdkState.me;
  const connected = sdkState.status === "ready";
  if (!connected) {
    return `
      <div class="ov-dc-profile-card">
        <div class="ov-dc-profile-left">
          <div class="ov-dc-avatar-wrap">
            <div class="ov-dc-avatar-fallback">${icon("discord", 18)}</div>
          </div>
          <div class="ov-dc-profile-info">
            <span class="ov-dc-profile-name">${esc(t("overlay.discordNotConnected"))}</span>
            <span class="ov-dc-profile-desc">${esc(t("overlay.discordSdkDesc"))}</span>
          </div>
        </div>
        <button class="btn primary small" data-ov="discord-sdk-start">${icon("discord", 13)} <span>${esc(t("overlay.discordConnect"))}</span></button>
      </div>`;
  }
  const currentStatus = me?.status ?? "online";
  return `
    <div class="ov-dc-profile-card">
      <div class="ov-dc-profile-left">
        <div class="ov-dc-avatar-wrap">
          ${me?.avatarUrl ? `<img class="ov-dc-avatar" src="${esc(me.avatarUrl)}" alt="" />` : `<div class="ov-dc-avatar-fallback">${icon("user", 16)}</div>`}
          <span class="ov-dc-status-dot ${esc(currentStatus)}"></span>
        </div>
        <div class="ov-dc-profile-info">
          <span class="ov-dc-profile-name">${esc(me?.name ?? "Discord")}</span>
          <span class="ov-dc-profile-status">${esc(presenceWord(currentStatus))}</span>
        </div>
      </div>
      <div class="ov-dc-profile-actions">
        <button class="ov-dc-tool-btn" data-ov="discord-picker" data-mode="status" title="${esc(t("overlay.discordStatusLabel"))}">
          ${icon("sliders", 14)}
        </button>
      </div>
    </div>`;
}

function socialVoiceHtml(): string {
  if (voiceState.status === "ready" && voiceState.channel) {
    const ch = voiceState.channel;
    const count = voiceState.participants.length;
    return `
      <div class="ov-dc-voice-strip">
        <div class="ov-dc-voice-left">
          <span class="ov-dc-voice-icon live">${icon("mic", 14)}</span>
          <div class="ov-dc-voice-meta">
            <span class="ov-dc-voice-channel">${esc(ch.name)}</span>
            <span class="ov-dc-voice-count">${esc(t("overlay.discordGroupMembers", { count }))}</span>
          </div>
        </div>
        <button class="ov-dc-voice-leave-btn" data-ov="discord-voice-leave" title="${esc(t("overlay.discordCallEnd"))}">
          ${icon("x", 13)}
        </button>
      </div>`;
  }
  if (callState.active) {
    const friend = friendEntries().find((f) => f.id === callState.friendId);
    return `
      <div class="ov-dc-voice-strip">
        <div class="ov-dc-voice-left">
          <span class="ov-dc-voice-icon live">${icon("mic", 14)}</span>
          <div class="ov-dc-voice-meta">
            <span class="ov-dc-voice-channel">${esc(friend?.name ?? t("overlay.discordCallActive"))}</span>
            <span class="ov-dc-voice-count">${esc(t("overlay.discordCallActive"))}</span>
          </div>
        </div>
        <div class="ov-dc-voice-btns">
          <button class="ov-dc-tool-btn ${callState.muted ? "is-muted" : ""}" data-ov="discord-call-mute" title="${esc(callState.muted ? t("overlay.discordCallUnmute") : t("overlay.discordCallMute"))}">
            ${icon(callState.muted ? "mic-off" : "mic", 13)}
          </button>
          <button class="ov-dc-voice-leave-btn" data-ov="discord-call-end" title="${esc(t("overlay.discordCallEnd"))}">
            ${icon("x", 13)}
          </button>
        </div>
      </div>`;
  }
  return "";
}

function socialSearchStripHtml(pendingCount: number): string {
  return `
    <div class="ov-dc-search-row">
      <div class="ov-dc-search-box">
        <span class="ov-dc-search-ico">${icon("search", 13)}</span>
        <input id="ov-dc-friends-filter" class="ov-dc-search-input" placeholder="${esc(t("overlay.discordSearchPlaceholder"))}" value="${esc(friendsFilterQuery)}" spellcheck="false" />
        ${friendsFilterQuery ? `<button class="ov-dc-search-clear" data-ov="discord-clear-filter">${icon("x", 11)}</button>` : ""}
      </div>
      ${(webVoice?.channels?.length ?? 0) > 0 ? `
        <button class="ov-dc-add-btn" data-ov="discord-picker" data-mode="channels" title="${esc(t("overlay.discordChannelsShort"))}">
          ${icon("hash", 13)}
        </button>
      ` : ""}
      <button class="ov-dc-add-btn" data-ov="discord-picker" data-mode="add" title="${esc(t("overlay.discordAddFriend"))}">
        ${icon("plus", 13)}
      </button>
      ${pendingCount > 0 ? `
        <button class="ov-dc-requests-btn" data-ov="discord-picker" data-mode="requests" title="${esc(t("overlay.discordRequests"))}">
          ${icon("bell", 13)}
          <span class="ov-dc-badge">${pendingCount}</span>
        </button>
      ` : ""}
    </div>`;
}

function socialFriendsListHtml(): string {
  const allFriends = friendEntries();
  const filter = friendsFilterQuery.trim().toLowerCase();
  const filtered = filter
    ? allFriends.filter((f) => f.name.toLowerCase().includes(filter))
    : allFriends;

  const online = filtered.filter((f) => f.status === "online" || f.status === "idle" || f.status === "dnd");
  const offline = filtered.filter((f) => f.status !== "online" && f.status !== "idle" && f.status !== "dnd");

  if (allFriends.length === 0) {
    return `
      <div class="ov-dc-empty-list">
        ${icon("users", 24)}
        <span>${esc(sdkState.status === "ready" ? t("overlay.discordFriendsEmpty") : t("overlay.discordFriendsEmptyHint"))}</span>
        <button class="btn ghost small" data-ov="discord-picker" data-mode="add">
          ${icon("plus", 12)} ${esc(t("overlay.discordAddFriend"))}
        </button>
      </div>`;
  }

  if (filtered.length === 0) {
    return `
      <div class="ov-dc-empty-list">
        <span>${esc(t("overlay.discordNoResults"))}</span>
        <button class="btn ghost small" data-ov="discord-clear-filter">
          ${esc(t("lib.clearSearch"))}
        </button>
      </div>`;
  }

  let html = "";
  if (online.length > 0) {
    html += `
      <div class="ov-dc-group-header">
        <span>${esc(t("overlay.discordFriendsOnline", { count: String(online.length) }))}</span>
      </div>
      <div class="ov-dc-group-items">
        ${online.map(socialFriendItemHtml).join("")}
      </div>`;
  }
  if (offline.length > 0) {
    html += `
      <div class="ov-dc-group-header">
        <span>${esc(t("overlay.discordFriendsOffline", { count: String(offline.length) }))}</span>
      </div>
      <div class="ov-dc-group-items">
        ${offline.map(socialFriendItemHtml).join("")}
      </div>`;
  }
  return html;
}

/** Group DMs the launcher's own client knows: read-only rows that open the
 * conversation in the Discord page (reading and writing stay there). */
function socialGroupsHtml(): string {
  const groups = webVoice?.conversations ?? [];
  if (groups.length === 0) return "";
  return `
    <div class="ov-dc-group-header">
      <span>${esc(t("overlay.discordGroupsTitle"))} · ${groups.length}</span>
    </div>
    <div class="ov-dc-group-items">
      ${groups.map(socialGroupItemHtml).join("")}
    </div>`;
}

/** A group DM has a user-set name or none: fall back to the member names. */
function groupTitle(conv: WebGroupConversation): string {
  const named = conv.name.trim();
  if (named) return named;
  const names = conv.members.map((member) => member.name).filter(Boolean);
  return names.length ? names.slice(0, 3).join(", ") : t("overlay.discordGroupsTitle");
}

function socialGroupItemHtml(conv: WebGroupConversation): string {
  const members = conv.members.slice(0, 3);
  const label = t("overlay.discordGroupMembers", { count: String(conv.memberCount) });
  const preview = conv.preview
    ? `${conv.preview.author ? `${conv.preview.author}: ` : ""}${conv.preview.text}`
    : "";
  return `
    <button class="ov-dc-friend-item ov-dc-group-item" data-ov="discord-open-group" data-id="${esc(conv.id)}" title="${esc(t("overlay.discordGroupOpen"))}">
      <div class="ov-dc-avatar-wrap ov-dc-stack">
        ${members.length
          ? members
              .map(
                (member, index) =>
                  `<img class="ov-dc-avatar ov-dc-stack-avatar" src="${esc(member.avatarUrl)}" alt="" loading="lazy" style="z-index:${members.length - index}" />`,
              )
              .join("")
          : `<div class="ov-dc-avatar-fallback">${icon("users", 14)}</div>`}
      </div>
      <div class="ov-dc-friend-info">
        <span class="ov-dc-friend-name">${esc(groupTitle(conv))}</span>
        <span class="ov-dc-friend-status">${esc(preview ? `${label} · ${preview}` : label)}</span>
      </div>
      ${conv.unread > 0 ? `<span class="ov-dc-unread-pill">${conv.unread}</span>` : ""}
      <span class="ov-dc-item-chat-icon">${icon("external", 13)}</span>
    </button>`;
}

/** Voice channels grouped by server: duplicate channel names stay unambiguous. */
function channelsBodyHtml(): string {
  const channels = webVoice?.channels ?? [];
  if (channels.length === 0) {
    return `
      <div class="ov-dc-empty-list">
        ${icon("hash", 24)}
        <span>${esc(t("overlay.discordNoChannel"))}</span>
      </div>`;
  }
  const groups = new Map<string, { label: string; items: typeof channels }>();
  for (const channel of channels) {
    const key = channel.guildId || `name:${channel.guild}`;
    const group = groups.get(key) ?? {
      label: channel.guild || t("overlay.discordChannelsShort"),
      items: [],
    };
    group.items.push(channel);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(
      (group) => `
      <div class="ov-dc-channel-group">
        <div class="ov-dc-group-header"><span>${esc(group.label)}</span></div>
        <div class="ov-dc-group-items">
          ${group.items
            .map(
              (channel) => `
            <button
              class="ov-dc-channel-row"
              data-ov="discord-open-channel"
              data-id="${esc(channel.id)}"
              data-guild="${esc(channel.guildId)}"
              title="${esc(t("overlay.discordOpenChannel"))}"
            >
              <span class="ov-dc-channel-ico">${icon("volume-2", 13)}</span>
              <span class="ov-dc-channel-name">${esc(channel.name)}</span>
              <span class="ov-dc-channel-open">${icon("external", 12)}</span>
            </button>`,
            )
            .join("")}
        </div>
      </div>`,
    )
    .join("");
}

/** Everything in the picker's scroll area: group DMs first, then the friends. */
function socialListHtml(): string {
  return socialGroupsHtml() + socialFriendsListHtml();
}

/** Re-paints only the list while the filter box keeps focus: a full picker
 * re-render on every keystroke used to drop the caret. */
export function repaintFriendsList(): void {
  const scroll = document.querySelector<HTMLElement>(".ov-dc-friends-scroll");
  if (scroll) scroll.innerHTML = socialListHtml();
  const row = document.querySelector<HTMLElement>(".ov-dc-search-row");
  const clearBtn = row?.querySelector<HTMLElement>(".ov-dc-search-clear");
  if (friendsFilterQuery && !clearBtn && row) {
    row.insertAdjacentHTML(
      "beforeend",
      `<button class="ov-dc-search-clear" data-ov="discord-clear-filter">${icon("x", 11)}</button>`,
    );
  } else if (!friendsFilterQuery) {
    clearBtn?.remove();
  }
}

function socialFriendItemHtml(friend: FriendEntry): string {
  const active = replyTarget?.id === friend.id;
  const unread = replyUnread.get(friend.id) ?? 0;
  const isOffline = friend.status !== "online" && friend.status !== "idle" && friend.status !== "dnd";
  return `
    <button class="ov-dc-friend-item${active ? " is-active" : ""}${isOffline ? " is-offline" : ""}" data-ov="discord-select-friend" data-id="${esc(friend.id)}" data-name="${esc(friend.name)}" title="${esc(t("overlay.discordReplyTitle"))}">
      <div class="ov-dc-avatar-wrap">
        <img class="ov-dc-avatar" src="${esc(friend.avatarUrl)}" alt="" loading="lazy" />
        <span class="ov-dc-status-dot ${esc(friend.status)}"></span>
      </div>
      <div class="ov-dc-friend-info">
        <span class="ov-dc-friend-name">${esc(friend.name)}</span>
        <span class="ov-dc-friend-status ${esc(friend.status)}">${esc(presenceWord(friend.status))}</span>
      </div>
      ${unread > 0 ? `<span class="ov-dc-unread-pill">${unread}</span>` : ""}
      <span class="ov-dc-item-chat-icon">${icon("mail", 13)}</span>
    </button>`;
}

/** An incoming friend request: accept or decline, right from the list. */
function requestRowHtml(friend: FriendEntry): string {
  return `
    <div class="request-row">
      <span class="avatar-wrap"><img src="${esc(friend.avatarUrl)}" alt="" loading="lazy" /></span>
      <span class="friend-meta">
        <span class="friend-name">${esc(friend.name)}</span>
        <span class="friend-status">${esc(t("overlay.discordIncomingRequest"))}</span>
      </span>
      <span class="conv-actions">
        <button class="action-btn" style="border-color:var(--ok);color:var(--ok)" data-ov="discord-accept" data-id="${esc(friend.id)}">${esc(t("overlay.discordAccept"))}</button>
        <button class="action-btn" data-ov="discord-reject" data-id="${esc(friend.id)}">${esc(t("overlay.discordReject"))}</button>
      </span>
    </div>`;
}

function addFriendBodyHtml(): string {
  const results = searchResults.map(searchRowHtml).join("");
  const empty =
    searchRan && !searchResults.length
      ? `<div class="empty-picker-wrap"><span>${esc(t("overlay.discordNoResults"))}</span></div>`
      : "";
  return `
    <div class="search-strip">
      <input id="ov-discord-search" class="composer-input" type="text" value="${esc(searchQuery)}" placeholder="${esc(t("overlay.discordSearchPlaceholder"))}" spellcheck="false" />
      <button class="action-btn" data-ov="discord-search-run">${esc(t("overlay.discordSearchRun"))}</button>
    </div>
    ${results}${empty}`;
}

function searchRowHtml(user: { id: string; name: string; username: string; avatarUrl: string }): string {
  const handle = user.username || user.name;
  const friend = friendEntries().find((item) => item.id === user.id);
  const action = friend
    ? `<span class="msg-status-text">${esc(t("overlay.discordAlreadyFriend"))}</span>`
    : sentRequests.has(handle)
      ? `<span class="msg-status-text">${esc(t("overlay.discordRequestSent"))}</span>`
      : `<button class="action-btn" style="border-color:var(--ok);color:var(--ok)" data-ov="discord-add" data-username="${esc(handle)}">${esc(t("overlay.discordAddFriend"))}</button>`;
  return `
    <div class="request-row">
      <span class="avatar-wrap"><img src="${esc(user.avatarUrl)}" alt="" loading="lazy" /></span>
      <span class="friend-meta">
        <span class="friend-name">${esc(user.name)}</span>
        ${user.username ? `<span class="friend-status">@${esc(user.username)}</span>` : ""}
      </span>
      <span class="conv-actions">${action}</span>
    </div>`;
}

/** The four statuses Discord shows, with the current one marked. */
function statusBodyHtml(): string {
  const current = sdkState.me?.status ?? "online";
  const options = [
    { id: "online", key: "overlay.discordStatusOnline" },
    { id: "idle", key: "overlay.discordStatusIdle" },
    { id: "dnd", key: "overlay.discordStatusDnd" },
    { id: "invisible", key: "overlay.discordStatusInvisible" },
  ];
  return options
    .map(
      (option) => `
      <button class="friend-row${option.id === current ? " is-active" : ""}" data-ov="discord-status" data-status="${option.id}" style="height:48px">
        <span class="presence-dot ${option.id === "invisible" ? "offline" : option.id}" style="position:static"></span>
        <span class="friend-meta"><span class="friend-name">${esc(t(option.key))}</span></span>
      </button>`,
    )
    .join("");
}

/* --- Area 2: Discord Chat (Chat & Messages) --- */

function chatEmptyPlaceholderHtml(): string {
  return `
    <div class="ov-dc-chat-empty">
      <div class="ov-dc-chat-empty-icon">${icon("mail", 28)}</div>
      <div class="ov-dc-chat-empty-title">${esc(t("overlay.discordReplyTitle"))}</div>
      <p class="ov-dc-chat-empty-desc">${esc(t("overlay.discordReplyPick"))}</p>
      <button class="btn primary small" data-ov="discord-open-social">
        ${icon("users", 13)} <span>${esc(t("overlay.discordFriendsTitle"))}</span>
      </button>
    </div>`;
}

function chatTargetHeaderHtml(target: { id: string; name: string }, friend?: FriendEntry): string {
  const status = friend?.status ?? "offline";
  const inCall = callState.active && callState.friendId === target.id;
  return `
    <div class="ov-dc-target-header">
      <div class="ov-dc-target-left">
        <div class="ov-dc-avatar-wrap">
          <img class="ov-dc-avatar" src="${esc(friend?.avatarUrl ?? "")}" alt="" />
          <span class="ov-dc-status-dot ${esc(status)}"></span>
        </div>
        <div class="ov-dc-target-meta">
          <span class="ov-dc-target-name">${esc(target.name)}</span>
          <span class="ov-dc-target-sub ${esc(status)}">● ${esc(presenceWord(status))}</span>
        </div>
      </div>
      <div class="ov-dc-target-actions">
        ${inCall ? `
          <button class="ov-dc-tool-btn is-calling" data-ov="discord-call-end" title="${esc(t("overlay.discordCallEnd"))}">
            ${icon("mic-off", 14)}
          </button>
        ` : `
          <button class="ov-dc-tool-btn" data-ov="discord-call-start" data-id="${esc(target.id)}" title="${esc(t("overlay.discordCall"))}">
            ${icon("mic", 14)}
          </button>
        `}
      </div>
    </div>`;
}

function chatMessagesHtml(target: { id: string; name: string }): string {
  const entries = threadEntries(target.id).slice(-60);
  if (entries.length === 0) {
    return `
      <div class="ov-dc-chat-thread-empty">
        <span>${esc(t("overlay.discordFriendsEmpty"))}</span>
      </div>`;
  }
  const friend = sdkFriends.friends.find((f) => f.id === target.id) || friendsState.friends.find((f) => f.id === target.id);
  const avatarUrl = friend?.avatarUrl;
  return entries.map((entry) => chatBubbleHtml(entry, target.name, avatarUrl)).join("");
}

function chatBubbleHtml(entry: ReplyLogEntry, targetName: string, partnerAvatar?: string): string {
  const isIncoming = entry.direction === "in";
  const actionsHtml =
    !isIncoming && entry.state === "sent" && entry.messageId
      ? `<div class="ov-dc-bubble-actions"><button class="ov-dc-bubble-act-btn" data-ov="discord-edit" data-entry="${entry.id}" title="${esc(t("overlay.discordEdit"))}">${icon("edit", 12)}</button><button class="ov-dc-bubble-act-btn is-danger" data-ov="discord-delete" data-entry="${entry.id}" title="${esc(t("overlay.discordDelete"))}">${icon("trash", 12)}</button></div>`
      : "";
  const statusMeta =
    isIncoming
      ? ""
      : entry.state === "sending"
        ? `<span class="ov-dc-msg-status sending">${esc(t("overlay.discordSending"))}</span>`
        : entry.state === "error"
          ? `<button class="ov-dc-msg-retry" data-ov="discord-retry" data-entry="${entry.id}">${esc(t("overlay.discordRetry"))}</button>`
          : "";
  const errorBadge = entry.state === "error"
    ? `<div class="ov-dc-msg-error-label">${esc(t("overlay.discordNotDelivered"))}</div>`
    : "";
  const attachment = entry.attachment
    ? `<div class="ov-dc-msg-attachment">${icon("clipboard", 12)} <span>${esc(entry.attachment)}</span></div>`
    : "";

  const hasText = Boolean(entry.text && entry.text.trim().length > 0);
  const textHtml = hasText
    ? `<div class="ov-dc-bubble-text">${esc(entry.text)}</div>`
    : "";

  const metaHtml = `<div class="ov-dc-bubble-meta"><span class="ov-dc-bubble-time num">${esc(entry.time)}</span>${statusMeta}</div>`;
  const avatarHtml = isIncoming
    ? `<div class="ov-dc-bubble-avatar-wrap" title="${esc(targetName)}">${partnerAvatar ? `<img class="ov-dc-bubble-avatar" src="${esc(partnerAvatar)}" alt="" />` : `<div class="ov-dc-bubble-avatar placeholder">${icon("user", 12)}</div>`}</div>`
    : "";
  const bubbleClasses = `ov-dc-bubble${entry.state === "error" ? " is-failed" : ""}`;

  return `<div class="ov-dc-bubble-row ${isIncoming ? "incoming" : "outgoing"}">${avatarHtml}<div class="${bubbleClasses}">${actionsHtml}${textHtml}${attachment}${errorBadge}${metaHtml}</div></div>`;
}

function chatComposerHtml(target: { id: string; name: string }, draft: string, editing: ReplyLogEntry | null): string {
  const placeholder = editing
    ? `${t("overlay.discordEdit")} · ${target.name}`
    : t("overlay.discordReplyTo", { name: target.name });
  const sendLabel = editing ? t("overlay.discordSave") : t("overlay.discordSend");
  const sendAction = editing ? "discord-edit-save" : "discord-send";

  return `
    <div class="ov-dc-composer-wrap">
      ${editing ? `
        <div class="ov-dc-editing-banner">
          <span>${icon("edit", 12)} ${esc(t("overlay.discordEdit"))}</span>
          <button class="ov-dc-edit-cancel-btn" data-ov="discord-edit-cancel">${icon("x", 12)}</button>
        </div>
      ` : ""}
      <div class="ov-dc-composer-input-row">
        <textarea
          id="ov-discord-reply-input"
          class="ov-dc-composer-input"
          placeholder="${esc(placeholder)}"
          rows="1"
          spellcheck="false"
        >${esc(draft)}</textarea>
        <button
          class="ov-dc-send-btn ${replySending ? "is-sending" : ""}"
          data-ov="${sendAction}"
          ${replySending ? "disabled" : ""}
          title="${esc(sendLabel)}"
        >
          ${icon("arrow-right", 15)}
        </button>
      </div>
      <div class="ov-dc-composer-hints">
        <span><kbd class="kbd">Enter</kbd> ${esc(t("overlay.discordSend"))} · <kbd class="kbd">Shift+Enter</kbd> ${esc(t("overlay.discordNewLine"))}</span>
      </div>
    </div>`;
}

/** Before the session exists: one clear way in, never a dead end. */
function connectHtml(): string {
  return discordConnectStateHtml();
}

/* --- SDK calls the tab drives --- */

/** Fetches the SDK session and its relationship list, so the panel paints at once. */
export async function refreshSdkState(): Promise<void> {
  try {
    const state = await invoke<SdkState>("discord_sdk_state");
    if (state) sdkState = state;
    const friends = await invoke<DiscordFriendsState>("discord_sdk_friends");
    if (friends) sdkFriends = friends;
    if (discordOnScreen()) repaintDiscord();
  } catch {
    // Older hosts have no Social SDK commands; the other sources stay.
  }
}

export async function startDiscordSdk(): Promise<void> {
  sdkState = { ...sdkState, status: "starting", error: null };
  renderDiscord();
  try {
    await invoke("discord_sdk_start", { silent: false });
  } catch (error) {
    sdkState = { ...sdkState, status: "error", error: String(error) };
    renderDiscord();
  }
}

/** Sends the draft. The outcome arrives on `discord-sdk-dm` and lands in the
 * log, so the typed text is only cleared once the host accepted the call. */
export async function sendDiscordReply(): Promise<void> {
  const target = replyTarget;
  const input = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  const text = (input?.value ?? (target ? replyDrafts.get(target.id) ?? "" : "")).trim();
  if (!target || !text || replySending) return;
  replySending = true;
  replyDrafts.set(target.id, "");
  replyLog.push({
    id: ++replyLogSeq,
    friendId: target.id,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    text,
    state: "sending",
    direction: "out",
  });
  if (replyLog.length > 400) replyLog.splice(0, replyLog.length - 400);
  renderDiscord();
  focusReplyInput();
  try {
    await invoke("discord_sdk_send_dm", { userId: target.id, text });
  } catch (error) {
    const entry = [...replyLog].reverse().find((item) => item.state === "sending");
    if (entry) {
      entry.state = "error";
      entry.error = String(error);
    }
    replySending = false;
    repaintDiscord();
  }
}

/** Retries a failed log row in place. */
export async function retryReply(entryId: number): Promise<void> {
  const entry = replyLog.find((item) => item.id === entryId);
  if (!entry || entry.state !== "error") return;
  entry.state = "sending";
  entry.error = undefined;
  repaintDiscord();
  try {
    await invoke("discord_sdk_send_dm", { userId: entry.friendId, text: entry.text });
  } catch (error) {
    entry.state = "error";
    entry.error = String(error);
    repaintDiscord();
  }
}

/** Deletes a message this overlay sent; the row goes when Discord confirms. */
export async function deleteReply(entryId: number): Promise<void> {
  const entry = replyLog.find((item) => item.id === entryId);
  if (!entry || !entry.messageId) return;
  const button = document.querySelector<HTMLButtonElement>(
    `[data-ov="discord-delete"][data-entry="${entryId}"]`,
  );
  if (button) button.disabled = true;
  try {
    await invoke("discord_sdk_delete_dm", {
      userId: entry.friendId,
      messageId: entry.messageId,
    });
  } catch (error) {
    if (button) button.disabled = false;
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Puts a sent message back in the composer to rewrite it; the compose draft
 * waits in the stash so nothing is lost if the edit is cancelled. */
export function startEdit(entryId: number): void {
  const entry = replyLog.find((item) => item.id === entryId);
  if (!entry || entry.direction !== "out" || !entry.messageId) return;
  editingEntryId = entry.id;
  editStash.set(entry.friendId, replyDrafts.get(entry.friendId) ?? "");
  replyDrafts.set(entry.friendId, entry.text);
  renderDiscord();
  focusReplyInput();
}

/** Leaves edit mode and brings the compose draft back. */
export function cancelEdit(): void {
  const entry = replyLog.find((item) => item.id === editingEntryId);
  editingEntryId = null;
  if (entry) {
    replyDrafts.set(entry.friendId, editStash.get(entry.friendId) ?? "");
    editStash.delete(entry.friendId);
  }
  renderDiscord();
}

/** Saves the edit through the SDK; the row updates when Discord confirms. */
export async function saveEdit(): Promise<void> {
  const entry = replyLog.find((item) => item.id === editingEntryId);
  const input = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  const text = (input?.value ?? "").trim();
  if (!entry || !entry.messageId || !text) return;
  const button = document.querySelector<HTMLButtonElement>('[data-ov="discord-edit-save"]');
  if (button) button.disabled = true;
  try {
    await invoke("discord_sdk_edit_dm", {
      userId: entry.friendId,
      messageId: entry.messageId,
      text,
    });
  } catch (error) {
    if (button) button.disabled = false;
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Sets the account's own Discord status. */
export async function setDiscordStatus(status: string): Promise<void> {
  try {
    await invoke("discord_sdk_set_status", { status });
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Calls a friend over their DM channel (the SDK's own call). */
export async function startDiscordCall(friendId: string): Promise<void> {
  try {
    await invoke("discord_sdk_call", { userId: friendId });
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Ends the call the overlay started. */
export async function endDiscordCall(): Promise<void> {
  try {
    await invoke("discord_sdk_hangup");
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Mutes (or unmutes) the call's microphone. */
export async function muteDiscordCall(mute: boolean): Promise<void> {
  try {
    await invoke("discord_sdk_call_mute", { mute });
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Accepts or rejects an incoming friend request; the list refreshes itself
 * when the SDK reports the relationship change. */
export async function answerFriendRequest(friendId: string, accept: boolean): Promise<void> {
  try {
    await invoke("discord_sdk_friend_request", { userId: friendId, accept });
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Runs the username search through the SDK; results arrive on the event. */
export function runUserSearch(): void {
  const input = document.getElementById("ov-discord-search") as HTMLInputElement | null;
  const query = (input?.value ?? searchQuery).trim();
  if (!query) return;
  searchQuery = query;
  searchRan = false;
  void invoke("discord_sdk_search_users", { query }).catch((error) => {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  });
}

/** Sends a friend request to the picked username. */
export async function addFriend(username: string): Promise<void> {
  try {
    await invoke("discord_sdk_add_friend", { username });
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Fetches the web page's last voice report, so the card paints immediately. */
export async function refreshWebVoice(): Promise<void> {
  try {
    const state = await invoke<WebVoiceState | null>("discord_web_voice_state");
    if (state) {
      webVoice = state;
      if (discordOnScreen()) repaintDiscord();
    }
  } catch {
    // Older hosts have no web voice bridge; the RPC source stays.
  }
}

/** The web client's call, shaped like an RPC read. */
function webVoiceAsState(): { channel: VoiceChannel; people: VoiceParticipant[] } | null {
  const web = webVoice;
  if (!web || !web.inCall || !web.channel) return null;
  return {
    channel: { id: web.channel.id, name: web.channel.name, guildId: web.channel.guild || null },
    people: web.participants.map((person) => ({
      id: person.id,
      name: person.name,
      avatarUrl: person.avatarUrl,
      speaking: person.speaking,
      muted: person.muted,
    })),
  };
}

/** The voice state the tab shows: the live desktop read, the launcher's own
 * web client, then the last known channel while (re)connecting. */
function voiceDisplay(): { channel: VoiceChannel; people: VoiceParticipant[]; stale: boolean } | null {
  const state = voiceState;
  const busy = state.status === "connecting" || state.status === "error";
  const web = webVoiceAsState();
  const live = state.channel ? { channel: state.channel, people: state.participants } : null;
  const display =
    live ??
    web ??
    (busy && lastVoiceChannel ? { channel: lastVoiceChannel, people: lastVoiceParticipants } : null);
  if (!display) return null;
  return { channel: display.channel, people: display.people, stale: !live && !web };
}

/** Voice/friends/web state pushed by the Rust workers. */
export function applyVoiceState(payload: DiscordVoiceState): void {
  voiceState = payload;
  if (voiceState.status === "ready" && voiceState.channel) {
    lastVoiceChannel = voiceState.channel;
    lastVoiceParticipants = voiceState.participants;
  } else if (voiceState.status === "idle") {
    lastVoiceChannel = null;
    lastVoiceParticipants = [];
  }
  if (discordOnScreen()) repaintDiscord();
}

export function applyFriendsState(payload: DiscordFriendsState): void {
  friendsState = payload;
  if (friendsState.status === "ready") {
    lastFriends = friendsState.friends;
    lastFriendsPending = friendsState.pending;
  } else if (friendsState.status === "idle") {
    lastFriends = [];
    lastFriendsPending = 0;
  }
  if (discordOnScreen()) repaintDiscord();
}

export function applyWebVoice(payload: WebVoiceState | null): void {
  webVoice = payload;
  if (discordOnScreen()) repaintDiscord();
}

export function applySdkState(payload: SdkState): void {
  sdkState = payload;
  if (discordOnScreen()) repaintDiscord();
}

export function applySdkFriends(payload: DiscordFriendsState): void {
  sdkFriends = payload;
  if (discordOnScreen()) repaintDiscord();
}

export function applyDmResult(payload: { userId: string; ok: boolean; messageId?: string; error?: string }): void {
  replySending = false;
  const entry = [...replyLog]
    .reverse()
    .find((item) => item.friendId === payload.userId && item.state === "sending");
  if (entry) {
    entry.state = payload.ok ? "sent" : "error";
    entry.error = payload.error;
    if (payload.messageId) entry.messageId = payload.messageId;
  }
  if (discordOnScreen()) repaintDiscord();
}

export function applyMessageDeleted(messageId: string): void {
  const before = replyLog.length;
  replyLog = replyLog.filter((item) => item.messageId !== messageId);
  if (replyLog.length !== before && discordOnScreen()) repaintDiscord();
}

export function applyDmDeleted(payload: { userId: string; messageId: string; ok: boolean; error?: string }): void {
  if (payload.ok) return;
  toast(t("overlay.discordSendFailed", { error: payload.error || "" }), "err");
  const button = document.querySelector<HTMLButtonElement>('[data-ov="discord-delete"]');
  if (button) button.disabled = false;
}

export function applyCallState(payload: { state: string; friendId: string; muted: boolean; error?: string | null }): void {
  const active = payload.state === "active";
  callState = {
    active,
    friendId: active ? payload.friendId : null,
    muted: payload.muted,
  };
  if (!active && payload.error) {
    toast(t("overlay.discordSendFailed", { error: payload.error }), "err");
  }
  if (discordOnScreen()) repaintDiscord();
}

export function applyStatusDone(payload: { status: string; ok: boolean; error?: string }): void {
  if (!payload.ok) {
    toast(t("overlay.discordSendFailed", { error: payload.error || "" }), "err");
    return;
  }
  pickerMode = "friends";
  if (discordOnScreen()) repaintDiscord();
}

export function applySearchResults(payload: { query: string; users: { id: string; name: string; username: string; avatarUrl: string }[] }): void {
  if (payload.query !== searchQuery) return;
  searchResults = payload.users;
  searchRan = true;
  if (discordOnScreen()) repaintDiscord();
}

export function applyRequestSent(payload: { username: string; ok: boolean; error?: string }): void {
  if (!payload.ok) {
    toast(t("overlay.discordSendFailed", { error: payload.error || "" }), "err");
    return;
  }
  toast(t("overlay.discordRequestSent"), "");
  sentRequests.add(payload.username);
  if (discordOnScreen()) repaintDiscord();
}

export function applyRequestDone(payload: { userId: string; accept: boolean; ok: boolean; error?: string }): void {
  if (!payload.ok) {
    toast(t("overlay.discordSendFailed", { error: payload.error || "" }), "err");
    return;
  }
  sdkFriends = {
    ...sdkFriends,
    pendingUsers: (sdkFriends.pendingUsers ?? []).filter((item) => item.id !== payload.userId),
    pending: Math.max(0, sdkFriends.pending - 1),
  };
  if (discordOnScreen()) repaintDiscord();
}

export function applyDmEdited(payload: { userId: string; messageId: string; text?: string; ok: boolean; error?: string }): void {
  const entry = replyLog.find((item) => item.messageId === payload.messageId);
  if (!payload.ok) {
    toast(t("overlay.discordSendFailed", { error: payload.error || "" }), "err");
    const button = document.querySelector<HTMLButtonElement>('[data-ov="discord-edit-save"]');
    if (button) button.disabled = false;
    return;
  }
  if (entry) {
    if (payload.text) entry.text = payload.text;
    if (entry.id === editingEntryId) {
      editingEntryId = null;
      replyDrafts.set(entry.friendId, editStash.get(entry.friendId) ?? "");
      editStash.delete(entry.friendId);
    }
  }
  if (discordOnScreen()) repaintDiscord();
}

/** Input wiring from the page's one text listener. */
export function setDiscordSearchQuery(value: string): void {
  searchQuery = value;
}

export function setDiscordFriendsFilter(value: string): void {
  friendsFilterQuery = value;
  repaintFriendsList();
}

export function setDiscordReplyDraft(value: string): void {
  if (replyTarget) replyDrafts.set(replyTarget.id, value);
}

export function isEditingDiscordEntry(): boolean {
  return editingEntryId !== null;
}

export function submitDiscordComposer(): void {
  if (editingEntryId !== null) void saveEdit();
  else void sendDiscordReply();
}

export function typeIntoDiscordReply(id: string, name: string, key: string): void {
  selectReplyTarget(id, name, key);
}

export function cancelDiscordEdit(): void {
  cancelEdit();
  focusReplyInput();
}

/** Picker takeover switch used by the click wiring. */
export function setDiscordPickerMode(mode: string): void {
  pickerMode = mode as PickerMode;
  repaintDiscord();
  if (pickerMode === "add") {
    requestAnimationFrame(() => document.getElementById("ov-discord-search")?.focus());
  }
}

export function clearDiscordFilter(): void {
  friendsFilterQuery = "";
  renderDiscordSocial();
}

export function isDiscordCallMuted(): boolean {
  return callState.muted;
}

/** A new panel session drops the transient pickers, not the typed drafts. */
export function resetDiscordSession(): void {
  replySending = false;
  editingEntryId = null;
  searchQuery = "";
  friendsFilterQuery = "";
  searchRan = false;
  searchResults = [];
  pickerMode = "friends";
}

/**
 * Opens a conversation in the launcher's own Discord client and brings the
 * launcher forward: typing and joining stay in the real client, so the overlay
 * never writes anything by itself.
 */
export async function openDiscordInLauncher(url: string): Promise<void> {
  try {
    await invoke("discord_open_conversation", { url });
  } catch {
    // Older hosts have no such command; the launcher still comes forward.
  }
  void invoke("overlay_show_launcher").catch(() => undefined);
}

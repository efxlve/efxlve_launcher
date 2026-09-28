/**
 * Friends page: one list for every connected store (Epic + GOG) plus the
 * live social signals both stores expose.
 *
 * - GOG: the presence service reports which friends are online in Galaxy right now.
 * - Epic: the presence service reports each friend's last-online timestamp
 *   (the launcher token cannot read live presence; that needs the EOS overlay).
 *
 * Presence is refreshed on open and every 60 seconds while the page is visible;
 * the interval clears itself as soon as the user leaves the view, so idle cost
 * stays at zero. Requests only touch the DOM through `refreshFriendsListInPlace`.
 */

import { emptyState, icon, loadingState } from "../../core/icons";
import { S } from "../../core/state";
import { esc, relativeTime } from "../../core/utils";
import { localizeMessage, t } from "../../i18n";
import { epicFriendAccept, epicFriendRemove, epicFriendsPresence } from "../../epic";
import { gogFriends, gogFriendsPresence } from "../../gog";
import { toast } from "../../core/toast";
import { loadFriends } from "../store/store-view";

/** Presence poll cadence while the friends view is open (GOG/Epic launchers use a similar one). */
const PRESENCE_INTERVAL_MS = 60_000;
/** A friend seen within this window counts as "active" in the Aktif tab. */
const ACTIVE_WINDOW_MS = 15 * 60_000;

/** One merged row: Epic and GOG friends share the same shape. */
interface FriendRow {
  key: string;
  store: "epic" | "gog";
  name: string;
  alias: string;
  avatar: string;
  favorite: boolean;
  mutual: number;
  online: boolean;
  lastOnline: string | null;
}

function lastOnlineMs(row: FriendRow): number {
  return row.lastOnline ? Date.parse(row.lastOnline) || 0 : 0;
}

function isActive(row: FriendRow): boolean {
  if (row.online) return true;
  const ts = lastOnlineMs(row);
  return ts > 0 && Date.now() - ts < ACTIVE_WINDOW_MS;
}

function epicRows(): FriendRow[] {
  return (S.friends || []).map((f) => ({
    key: f.accountId,
    store: "epic" as const,
    name: f.displayName || f.alias || f.accountId.slice(0, 8),
    alias: f.alias && f.displayName ? f.alias : "",
    avatar: "",
    favorite: Boolean(f.favorite),
    mutual: f.mutual || 0,
    online: false,
    lastOnline: f.lastOnline,
  }));
}

function gogRows(): FriendRow[] {
  return (S.gogFriends || []).map((f) => ({
    key: f.userId,
    store: "gog" as const,
    name: f.username,
    alias: "",
    avatar: f.avatarUrl || "",
    favorite: false,
    mutual: 0,
    online: S.gogOnline.has(f.userId),
    lastOnline: null,
  }));
}

/**
 * Merged list, most active first: online friends, then recent last-seen,
 * then everyone else alphabetically.
 */
function allRows(): FriendRow[] {
  const list = [...epicRows(), ...gogRows()];
  return list.sort((a, b) => {
    const actA = isActive(a) ? 0 : 1;
    const actB = isActive(b) ? 0 : 1;
    if (actA !== actB) return actA - actB;
    const tsA = lastOnlineMs(a);
    const tsB = lastOnlineMs(b);
    if (tsA !== tsB) return tsB - tsA;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

function visibleRows(all: FriendRow[]): FriendRow[] {
  const q = S.friendsQuery.trim().toLowerCase();
  return all.filter((f) => {
    if (S.friendsFilter === "active" && !isActive(f)) return false;
    if ((S.friendsFilter === "epic" || S.friendsFilter === "gog") && f.store !== S.friendsFilter) return false;
    return !q || f.name.toLowerCase().includes(q) || f.alias.toLowerCase().includes(q);
  });
}

/** Second row line: alias and/or the store's activity signal. */
function rowMeta(f: FriendRow, onlineLabel: string): string {
  const parts: string[] = [];
  if (f.alias) parts.push(esc(f.alias));
  if (f.online) parts.push(`<span class="friend-status online">${esc(onlineLabel)}</span>`);
  else if (f.lastOnline) parts.push(esc(t("friends.lastSeen", { when: relativeTime(f.lastOnline) })));
  if (f.mutual > 0) parts.push(esc(t("friends.mutual", { count: f.mutual })));
  return parts.join(`<span class="friend-meta-sep" aria-hidden="true">·</span>`);
}

function friendRow(f: FriendRow): string {
  const initial = (f.name.trim().charAt(0) || "?").toUpperCase();
  const meta = rowMeta(f, t("friends.onlineNow"));
  return `
    <div class="row friend-row">
      <span class="friend-avatar">${f.avatar ? `<img src="${esc(f.avatar)}" alt="" loading="lazy" decoding="async" />` : esc(initial)}${f.online ? `<span class="friend-dot online" title="${esc(t("friends.onlineNow"))}"></span>` : ""}</span>
      <div class="row-main">
        <div class="row-title" title="${esc(f.name)}">${esc(f.name)}${f.favorite ? ` <span class="friend-fav">${icon("star", 11)}</span>` : ""}</div>
        ${meta ? `<div class="row-meta">${meta}</div>` : ""}
      </div>
      <span class="store-token">${f.store === "epic" ? "EPIC" : "GOG"}</span>
    </div>`;
}

/** Incoming Epic friend requests: accept adds the friend, ignore drops the request. */
function renderFriendRequests(): string {
  const requests = S.friendsIncoming || [];
  if (requests.length === 0) return "";
  const rows = requests
    .map((r) => {
      const name = r.displayName || r.accountId.slice(0, 8);
      const initial = (name.trim().charAt(0) || "?").toUpperCase();
      const meta = r.mutual > 0 ? `<div class="row-meta">${esc(t("friends.mutual", { count: r.mutual }))}</div>` : "";
      return `
        <div class="row friend-row">
          <span class="friend-avatar">${esc(initial)}</span>
          <div class="row-main">
            <div class="row-title" title="${esc(name)}">${esc(name)}</div>
            ${meta}
          </div>
          <div class="row-actions">
            <button class="btn small primary" data-act="friends-accept" data-id="${esc(r.accountId)}">${t("friends.accept")}</button>
            <button class="btn small ghost" data-act="friends-decline" data-id="${esc(r.accountId)}">${t("friends.decline")}</button>
          </div>
        </div>`;
    })
    .join("");
  return `
    <section class="card friends-requests">
      <div class="profile-side-head">
        <h3 class="gp-section-title">${t("friends.requestsTitle")} <span class="count">${requests.length}</span></h3>
      </div>
      <div class="list">${rows}</div>
    </section>`;
}

function renderFriendsList(rows: FriendRow[]): string {
  if (rows.length === 0) {
    const connected = Boolean(S.epicAccount || S.gogAccount);
    if (!connected) {
      return emptyState(
        "users",
        t("friends.connectTitle"),
        t("friends.connectDesc"),
        `<button class="btn primary" data-view="accounts">${t("accounts.connectCta")}</button>`,
      );
    }
    return emptyState("users", t("friends.empty"), t("friends.emptyHint"));
  }
  return `<div class="list">${rows.map(friendRow).join("")}</div>`;
}

/** In-place patch of the request card, list and counts (search, filters, presence). */
export function refreshFriendsListInPlace(): void {
  const host = document.getElementById("friends-list");
  if (!host) return;
  const all = allRows();
  const rows = visibleRows(all);
  host.innerHTML = renderFriendsList(rows);
  const req = document.getElementById("friends-requests");
  if (req) req.innerHTML = renderFriendRequests();
  const count = document.getElementById("friends-count");
  if (count) count.textContent = t("friends.count", { count: rows.length });
  const online = document.getElementById("friends-online");
  if (online) online.textContent = t("friends.onlineCount", { count: rows.filter((f) => f.online).length });
  const active = document.getElementById("friends-active-count");
  if (active) active.textContent = String(all.filter(isActive).length);
  const updated = document.getElementById("friends-updated");
  if (updated) updated.textContent = S.friendsPresenceAt > 0 ? t("friends.updated", { when: relativeTime(S.friendsPresenceAt) }) : "";
}

export function renderFriendsView(): string {
  const all = allRows();
  const rows = visibleRows(all);
  const loading = (S.friendsLoading || S.gogFriendsLoading) && all.length === 0;
  const error = S.friendsError || S.gogFriendsError;
  const activeCount = all.filter(isActive).length;
  const epicCount = all.filter((f) => f.store === "epic").length;

  const filterTab = (val: string, label: string): string =>
    `<button class="tab ${S.friendsFilter === val ? "active" : ""}" data-act="friends-filter" data-val="${val}">${label}</button>`;

  // A failing store must be visible even when the other store returned rows.
  const body = loading
    ? loadingState(t("friends.loading"))
    : error && rows.length === 0
      ? emptyState(
          "info",
          t("friends.errorTitle"),
          esc(error),
          `<button class="btn ghost small" data-act="refresh-friends">${t("profile.retry")}</button>`,
        )
      : renderFriendsList(rows);

  return `
    <div class="page friends-page">
      <div class="gp-toolbar">
        <div class="tabs">
          ${filterTab("all", t("profile.filterAll"))}
          <button class="tab ${S.friendsFilter === "active" ? "active" : ""}" data-act="friends-filter" data-val="active">${t("friends.filterActive")}<span class="count" id="friends-active-count">${activeCount}</span></button>
          ${filterTab("epic", "Epic Games")}
          ${filterTab("gog", "GOG.COM")}
        </div>
        <div class="gp-toolbar-right">
          <label class="search gp-search">
            ${icon("search", 15)}
            <input type="text" id="friends-search" placeholder="${t("friends.search")}" value="${esc(S.friendsQuery)}" />
            ${S.friendsQuery ? `<button class="icon-btn" data-act="friends-search-clear">${icon("x", 12)}</button>` : ""}
          </label>
          <button class="icon-btn lib-refresh-btn ${S.friendsLoading || S.gogFriendsLoading ? "spinning" : ""}" data-act="refresh-friends" title="${t("friends.refresh")}">${icon("refresh", 16)}</button>
        </div>
      </div>
      <p class="page-sub friends-sub">
        <span id="friends-count" class="friends-count tabular-nums">${t("friends.count", { count: rows.length })}</span>
        <span class="friends-sub-sep" aria-hidden="true">·</span><span id="friends-online" class="friends-count tabular-nums">${t("friends.onlineCount", { count: all.filter((f) => f.online).length })}</span>
        ${all.length > 0 && S.friendsPresenceAt > 0 ? `<span class="friends-sub-sep" aria-hidden="true">·</span><span id="friends-updated" class="friends-updated">${t("friends.updated", { when: relativeTime(S.friendsPresenceAt) })}</span>` : ""}
      </p>
      ${error && rows.length > 0 ? `<p class="page-sub friends-error">${esc(error)}</p>` : ""}
      ${epicCount > 0 ? `<p class="page-sub friends-note">${esc(t("friends.epicNote"))}</p>` : ""}
      <div id="friends-requests">${renderFriendRequests()}</div>
      <div id="friends-list">${body}</div>
    </div>`;
}

/** Refreshes presence only (cheap: one request per store). */
export async function refreshFriendsPresence(epic = true, gog = true): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (epic && S.epicAccount && S.friends.length > 0) {
    tasks.push(
      epicFriendsPresence()
        .then((map) => {
          for (const f of S.friends) {
            const seen = map[f.accountId];
            if (seen) f.lastOnline = seen;
          }
        })
        .catch(() => {}),
    );
  }
  if (gog && (S.gogAccount || S.gogAccountId)) {
    const ids = S.gogFriends.map((f) => f.userId);
    if (ids.length > 0) {
      tasks.push(
        gogFriendsPresence(ids)
          .then((online) => {
            S.gogOnline = new Set(online);
          })
          .catch(() => {}),
      );
    }
  }
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
  S.friendsPresenceAt = Date.now();
  refreshFriendsListInPlace();
}

let presenceTimer: number | null = null;

function stopPresenceTimer(): void {
  if (presenceTimer !== null) {
    window.clearInterval(presenceTimer);
    presenceTimer = null;
  }
}

/** Polls presence only while the friends view is open and visible. */
function startPresenceTimer(): void {
  if (presenceTimer !== null) return;
  presenceTimer = window.setInterval(() => {
    if (S.view !== "friends") {
      stopPresenceTimer();
      return;
    }
    if (document.visibilityState === "hidden") return;
    void refreshFriendsPresence();
  }, PRESENCE_INTERVAL_MS);
}

/** Loads both stores in parallel; a failing store keeps the other's list. */
export async function loadFriendsView(force = false): Promise<void> {
  if ((S.friendsLoading || S.gogFriendsLoading) && !force) {
    startPresenceTimer();
    return;
  }

  // `loadFriends` owns its loading flag and re-renders; setting the flag here
  // first would make it hit its own "already loading" guard and skip the fetch.
  const epicPromise = loadFriends(force);

  const gogPromise = (async () => {
    if (!S.gogAccount && !S.gogAccountId) return;
    S.gogFriendsLoading = true;
    try {
      S.gogFriends = await gogFriends();
      S.gogFriendsError = "";
    } catch (err) {
      S.gogFriendsError = localizeMessage(String(err));
    } finally {
      S.gogFriendsLoading = false;
    }
  })();

  await Promise.allSettled([epicPromise, gogPromise]);
  refreshFriendsListInPlace();
  startPresenceTimer();
  // Refresh both sources so the "Updated" line is accurate on first paint too.
  void refreshFriendsPresence();
}

/** Accepts or ignores an incoming Epic friend request. */
export async function respondToFriendRequest(friendId: string, accept: boolean): Promise<void> {
  try {
    if (accept) await epicFriendAccept(friendId);
    else await epicFriendRemove(friendId);
    S.friendsIncoming = S.friendsIncoming.filter((r) => r.accountId !== friendId);
    refreshFriendsListInPlace();
    toast(accept ? t("friends.accepted") : t("friends.declined"), "ok");
    // Accepted requests become friends; pull the fresh list with their details.
    if (accept) void loadFriendsView(true);
  } catch (err) {
    toast(String(err), "err");
  }
}

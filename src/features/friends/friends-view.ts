/**
 * Friends page: one list for every connected store (Epic + GOG).
 *
 * Both store APIs are read-only here. Online presence is not exposed by Epic
 * (the launcher token gets a 403 from the presence service) and GOG's presence
 * is websocket-only, so the list shows every friend sorted by name; presence can
 * be layered on later (EOS SDK / GOG chat socket) without touching this view.
 */

import { emptyState, icon, loadingState } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { localizeMessage, t } from "../../i18n";
import { gogFriends } from "../../gog";
import { loadFriends } from "../store/store-view";

/** One merged row: Epic and GOG friends share the same shape. */
interface FriendRow {
  store: "epic" | "gog";
  name: string;
  alias: string;
  avatar: string;
  favorite: boolean;
}

function epicRows(): FriendRow[] {
  return (S.friends || []).map((f) => ({
    store: "epic" as const,
    name: f.displayName || f.alias || f.accountId.slice(0, 8),
    alias: f.alias && f.displayName ? f.alias : "",
    avatar: "",
    favorite: Boolean(f.favorite),
  }));
}

function gogRows(): FriendRow[] {
  return (S.gogFriends || []).map((f) => ({
    store: "gog" as const,
    name: f.username,
    alias: "",
    avatar: f.avatarUrl || "",
    favorite: false,
  }));
}

function allRows(): FriendRow[] {
  const list = [...epicRows(), ...gogRows()];
  return list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function visibleRows(all: FriendRow[]): FriendRow[] {
  const q = S.friendsQuery.trim().toLowerCase();
  return all.filter((f) => {
    if (S.friendsFilter !== "all" && f.store !== S.friendsFilter) return false;
    return !q || f.name.toLowerCase().includes(q) || f.alias.toLowerCase().includes(q);
  });
}

function friendRow(f: FriendRow): string {
  const initial = (f.name.trim().charAt(0) || "?").toUpperCase();
  return `
    <div class="row friend-row">
      <span class="friend-avatar">${f.avatar ? `<img src="${esc(f.avatar)}" alt="" loading="lazy" decoding="async" />` : esc(initial)}</span>
      <div class="row-main">
        <div class="row-title" title="${esc(f.name)}">${esc(f.name)}${f.favorite ? ` <span class="friend-fav">${icon("star", 11)}</span>` : ""}</div>
        ${f.alias ? `<div class="row-meta" title="${esc(f.alias)}">${esc(f.alias)}</div>` : ""}
      </div>
      <span class="store-token">${f.store === "epic" ? "EPIC" : "GOG"}</span>
    </div>`;
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

/** In-place patch of the list area (filters, search, refresh). */
export function refreshFriendsListInPlace(): void {
  const host = document.getElementById("friends-list");
  if (!host) return;
  const rows = visibleRows(allRows());
  host.innerHTML = renderFriendsList(rows);
  const count = document.getElementById("friends-count");
  if (count) count.textContent = t("friends.count", { count: rows.length });
}

export function renderFriendsView(): string {
  const all = allRows();
  const rows = visibleRows(all);
  const loading = (S.friendsLoading || S.gogFriendsLoading) && all.length === 0;
  const error = S.friendsError || S.gogFriendsError;

  const filterTab = (val: string, label: string): string =>
    `<button class="tab ${S.friendsFilter === val ? "active" : ""}" data-act="friends-filter" data-val="${val}">${label}</button>`;

  const body = loading ? loadingState(t("friends.loading")) : renderFriendsList(rows);

  return `
    <div class="page friends-page">
      <div class="gp-toolbar">
        <div class="tabs">
          ${filterTab("all", t("profile.filterAll"))}
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
        <span class="friends-sub-sep" aria-hidden="true">·</span>${t("friends.note")}
      </p>
      ${error && rows.length === 0 ? `<p class="page-sub friends-error">${esc(error)}</p>` : ""}
      <div id="friends-list">${body}</div>
    </div>`;
}

/** Loads both stores in parallel; a failing store keeps the other's list. */
export async function loadFriendsView(force = false): Promise<void> {
  if ((S.friendsLoading || S.gogFriendsLoading) && !force) return;

  const epicPromise = (async () => {
    S.friendsLoading = true;
    try {
      await loadFriends(force);
      S.friendsError = "";
    } finally {
      S.friendsLoading = false;
    }
  })();

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
}

import { getCustomAvatar } from "./profile-avatar";
/**
 * Profile page renderer.
 *
 * Header with identity and real account totals, then a two-column layout:
 * achievement progress per game (left) and recently played + friends (right).
 * Only data the launcher actually has is shown; no derived or estimated
 * trophy tiers.
 */

import { PROFILE_CARD_CHUNK } from "../../core/constants";
import { emptyState, epicPlatinumIcon, icon } from "../../core/icons";
import { rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";

import { epicPortrait, type ProfileGameRecord } from "../../epic";

function coverOf(appName: string, fallback = ""): string {
  const s = S.epicSummariesMap.get(appName);
  const raw = rawOf(appName);
  return S.customCovers[appName] || (raw ? epicPortrait(raw) : null) || s?.cover || fallback;
}

function renderProfileGameCards(cardGames: ProfileGameRecord[]): string {
  if (cardGames.length === 0) {
    const title = S.profileShowHidden ? t("profile.hiddenEmpty") : t("profile.emptyTitle");
    const desc = S.profileShowHidden ? t("profile.hiddenEmptyDesc") : t("profile.emptyDesc");
    return `<div class="row">${emptyState("trophy", title, desc)}</div>`;
  }
  return cardGames.map((g) => {
    const isPlat = g.is_platinum || g.unlocked_percent >= 100;
    const pt = S.playtimeMap.get(g.app_name);
    const cover = coverOf(g.app_name, g.cover || "");
    const pct = Math.min(100, Math.max(0, g.unlocked_percent));
    const meta = [
      `${g.total_unlocked} / ${g.total_achievements} ${t("profile.trophies")}`,
      g.total_product_xp > 0 ? `${g.total_xp.toLocaleString()} / ${g.total_product_xp.toLocaleString()} XP` : "",
      pt && pt.total_seconds > 0 ? fmtPlaytime(pt.total_seconds) : "",
    ].filter(Boolean).join(" · ");
    const show = S.profileShowHidden && g.sandbox_id
      ? `<button type="button" class="btn ghost small" data-act="unhide-achievement" data-id="${esc(g.sandbox_id)}">${t("profile.hiddenShow")}</button>`
      : "";
    return `
      <div class="row profile-game-row" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button">
        ${cover ? `<img class="row-thumb" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="row-thumb"></span>`}
        <div class="row-main">
          <div class="row-title">${esc(g.app_title)}${isPlat ? ` <span class="profile-plat">${epicPlatinumIcon(12)}</span>` : ""}</div>
          <div class="row-meta">${meta}</div>
          <div class="progress profile-game-progress"><span style="width:${pct}%"></span></div>
        </div>
        ${show}
        <div class="profile-game-pct${isPlat ? " plat" : ""}">${pct}%</div>
      </div>`;
  }).join("");
}

/** Resets the profile list back to the first chunk (on filter/sort/search change). */
export function resetProfileCards(): void {
  S.profileCardCount = PROFILE_CARD_CHUNK;
}

/**
 * Progress list with progressive rendering: only the first chunk is built so a
 * large profile never turns into thousands of DOM nodes at once.
 */
export function renderProfileGrid(cardGames: ProfileGameRecord[]): string {
  const shown = cardGames.slice(0, S.profileCardCount);
  const more = cardGames.length > shown.length
    ? `<div class="row profile-more"><button class="btn ghost small" data-act="profile-show-more">${t("profile.showMore")} (${cardGames.length - shown.length})</button></div>`
    : "";
  return renderProfileGameCards(shown) + more;
}

function platformLabel(key: string): string {
  const map: Record<string, string> = { steam: "Steam", psn: "PSN", xbl: "Xbox", nintendo: "Switch", epic: "Epic" };
  return map[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

function recentApps(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): boolean => {
    if (!seen.has(name) && S.epicSummariesMap.has(name)) {
      seen.add(name);
      out.push(name);
    }
    return out.length >= 9;
  };
  for (const name of S.epicRecent) if (push(name)) return out;
  const played = [...S.playtimeMap.entries()]
    .filter(([, r]) => (r.total_seconds || 0) > 0)
    .sort((a, b) => (b[1].last_played_timestamp || 0) - (a[1].last_played_timestamp || 0));
  for (const [name] of played) if (push(name)) return out;
  for (const s of S.epicSummaries) if (s.installed && push(s.appName)) return out;
  return out;
}

function renderRecentGrid(): string {
  const items = recentApps().map((appName) => {
    const title = S.epicSummariesMap.get(appName)?.title || appName;
    const cover = coverOf(appName);
    return `<button class="profile-recent-item" data-act="epic-detail" data-id="${esc(appName)}" title="${esc(title)}">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : ""}</button>`;
  }).join("");
  return `
    <section class="card profile-side-card">
      <div class="profile-side-head"><h3 class="gp-section-title">${t("profile.recentGamesTitle")}</h3><button class="btn ghost small" data-view="library">${t("profile.showAll")}</button></div>
      ${items ? `<div class="profile-recent-grid">${items}</div>` : `<p class="row-meta">${t("profile.noRecentGames")}</p>`}
    </section>`;
}

function renderFriendsSection(): string {
  let body: string;
  if (S.friendsLoading && S.friends.length === 0) {
    body = `<div class="empty-state"><span class="spinner"></span></div>`;
  } else if (S.friendsError) {
    body = `<p class="row-meta">${esc(S.friendsError)}</p><button class="btn ghost small" data-act="refresh-friends">${t("profile.retry")}</button>`;
  } else if (S.friends.length === 0) {
    body = `<p class="row-meta">${t("friends.empty")}</p>`;
  } else {
    const sorted = [...S.friends].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
    body = `<div class="friends-list">${sorted.map((f) => {
      const name = f.displayName || f.alias || f.accountId.slice(0, 8);
      const plats = f.platforms.map((p) => `<span class="chip">${esc(platformLabel(p))}</span>`).join("");
      return `
        <div class="friend-row">
          <span class="settings-avatar">${esc((name.trim().charAt(0) || "?").toUpperCase())}</span>
          <div class="row-main">
            <div class="row-title" title="${esc(name)}">${esc(name)}${f.favorite ? ` <span class="friend-fav">${icon("star", 11)}</span>` : ""}</div>
            ${f.alias && f.displayName ? `<div class="row-meta" title="${esc(f.alias)}">${esc(f.alias)}</div>` : ""}
          </div>
          ${plats ? `<div class="friend-plats">${plats}</div>` : ""}
        </div>`;
    }).join("")}</div>`;
  }
  return `
    <section class="card profile-side-card">
      <div class="profile-side-head">
        <h3 class="gp-section-title">${t("friends.title")}${S.friends.length > 0 ? ` <span class="count">${S.friends.length}</span>` : ""}</h3>
        <button class="icon-btn lib-refresh-btn ${S.friendsLoading ? "spinning" : ""}" data-act="refresh-friends" title="${t("friends.refresh")}">${icon("refresh", 15)}</button>
      </div>
      ${body}
    </section>`;
}

function userHidAchievement(g: ProfileGameRecord): boolean {
  return !!g.sandbox_id && S.hiddenAchievements.has(g.sandbox_id);
}

/** Applies the profile filter tab, search box, sort order, and hidden rows. */
export function filteredProfileGames(allGames: ProfileGameRecord[]): ProfileGameRecord[] {
  const q = S.profileSearchQuery.trim().toLowerCase();
  const list = allGames.filter((g) => {
    if (S.hiddenGames.has(g.app_name)) return false;
    const hiddenRow = userHidAchievement(g);
    if (S.profileShowHidden) {
      if (!hiddenRow) return false;
    } else if (hiddenRow) return false;
    const done = g.is_platinum || g.unlocked_percent >= 100;
    if (S.profileFilter === "platinum" && !done) return false;
    if (S.profileFilter === "in_progress" && !(g.unlocked_percent > 0 && !done)) return false;
    if (S.profileFilter === "not_started" && g.unlocked_percent !== 0) return false;
    return !q || g.app_title.toLowerCase().includes(q) || g.app_name.toLowerCase().includes(q);
  });
  return list.sort((a, b) => {
    if (S.profileSort === "progress") {
      return b.is_platinum !== a.is_platinum ? (b.is_platinum ? 1 : -1) : b.unlocked_percent - a.unlocked_percent || b.total_xp - a.total_xp;
    }
    if (S.profileSort === "xp") return b.total_xp - a.total_xp;
    if (S.profileSort === "playtime") {
      return (S.playtimeMap.get(b.app_name)?.total_seconds || 0) - (S.playtimeMap.get(a.app_name)?.total_seconds || 0);
    }
    if (S.profileSort === "alpha") return S.trCollator.compare(a.app_title, b.app_title);
    return 0;
  });
}

export function renderProfile(): string {
  if (S.profileLoading && !S.playerProfileData) {
    return `<div class="page">${`<div class="empty-state"><span class="spinner"></span><h3>${t("profile.loadingTitle")}</h3><p>${t("profile.loadingDesc")}</p></div>`}</div>`;
  }
  if (S.profileError && !S.playerProfileData) {
    return `<div class="page">${emptyState("info", t("profile.errorTitle"), esc(S.profileError), `<button class="btn primary" data-act="refresh-profile">${t("profile.retry")}</button>`)}</div>`;
  }

  const prof = S.playerProfileData;
  const displayName = prof?.display_name || S.epicAccount || t("profile.player");
  const accountId = prof?.account_id || S.epicAccountId || "";
  const allGames = prof?.games || [];
  let totalPlaytimeSec = 0;
  for (const r of S.playtimeMap.values()) totalPlaytimeSec += r.total_seconds || 0;
  const customAvatar = getCustomAvatar(accountId);
  const initial = displayName.trim().charAt(0).toUpperCase() || "E";

  const filtered = filteredProfileGames(allGames);
  let countPlat = 0, countProgress = 0, countNotStarted = 0, countVisible = 0, countHidden = 0;
  for (const g of allGames) {
    if (S.hiddenGames.has(g.app_name)) continue;
    if (userHidAchievement(g)) {
      countHidden++;
      continue;
    }
    countVisible++;
    const done = g.is_platinum || g.unlocked_percent >= 100;
    if (done) countPlat++;
    else if (g.unlocked_percent > 0) countProgress++;
    else countNotStarted++;
  }
  const stat = (value: string, label: string): string => `<div class="profile-stat"><span class="profile-stat-val">${value}</span><span class="profile-stat-label">${label}</span></div>`;
  const filterTab = (val: string, label: string, n: number): string =>
    `<button class="tab ${S.profileFilter === val ? "active" : ""}" data-act="profile-filter" data-val="${val}">${label}<span class="count">${n}</span></button>`;

  return `
    <div class="page profile-page">
      <section class="card profile-head">
        <button class="profile-avatar-btn" data-act="profile-change-avatar" title="${customAvatar ? t("profile.changeAvatarTitle") : t("profile.uploadAvatarTitle")}">
          <span class="settings-avatar profile-avatar">${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : esc(initial)}</span>
        </button>
        <div class="row-main">
          <h1 class="profile-name">${esc(displayName)}</h1>
          <div class="profile-sub">
            <span class="chip ${S.offlineMode ? "warn" : "ok"}">${S.offlineMode ? t("profile.offlineMode") : t("profile.connected")}</span>
            ${accountId ? `<button class="btn ghost small" data-act="copy-account-id" data-val="${esc(accountId)}" title="${t("profile.copyIdTitle", { id: accountId })}">${icon("copy", 12)} ID</button>` : ""}
          </div>
        </div>
        <div class="profile-stats">
          ${stat(String(S.epicSummaries.length), t("profile.games"))}
          ${stat(esc(fmtPlaytime(totalPlaytimeSec)), t("profile.played"))}
          ${stat((prof?.total_unlocked || 0).toLocaleString(), t("profile.trophies"))}
          ${stat(String(prof?.platinum_count || 0), t("profile.platLabel"))}
          ${stat((prof?.total_xp || 0).toLocaleString(), "XP")}
        </div>
        <button class="icon-btn lib-refresh-btn ${S.profileLoading ? "spinning" : ""}" data-act="refresh-profile" title="${t("profile.refreshTitle")}">${icon("refresh", 16)}</button>
      </section>

      <div class="profile-body">
        <div class="profile-main">
          <div class="gp-toolbar">
            <div class="tabs">
              ${filterTab("all", t("profile.filterAll"), countVisible)}
              ${filterTab("platinum", t("profile.filterPlatinum"), countPlat)}
              ${filterTab("in_progress", t("profile.filterInProgress"), countProgress)}
              ${filterTab("not_started", t("profile.filterNotStarted"), countNotStarted)}
              ${countHidden > 0 ? `<button class="tab ${S.profileShowHidden ? "active" : ""}" data-act="profile-toggle-hidden">${t("profile.hiddenToggle")}<span class="count">${countHidden}</span></button>` : ""}
            </div>
            <div class="gp-toolbar-right">
              <button class="icon-btn" data-act="open-hide-achievements" title="${esc(t("profile.hideAchTip"))}" aria-label="${esc(t("profile.hideAchTip"))}">${icon("eye-off", 16)}</button>
              <label class="search gp-search">${icon("search", 15)}<input type="text" id="profile-search" placeholder="${t("profile.searchPlaceholder")}" value="${esc(S.profileSearchQuery)}" />
                ${S.profileSearchQuery ? `<button class="icon-btn" data-act="profile-search-clear">${icon("x", 12)}</button>` : ""}
              </label>
              <select id="profile-sort-select" data-act="profile-sort-change">
                <option value="progress" ${S.profileSort === "progress" ? "selected" : ""}>${t("profile.sortProgress")}</option>
                <option value="xp" ${S.profileSort === "xp" ? "selected" : ""}>${t("profile.sortXp")}</option>
                <option value="playtime" ${S.profileSort === "playtime" ? "selected" : ""}>${t("profile.sortPlaytime")}</option>
                <option value="alpha" ${S.profileSort === "alpha" ? "selected" : ""}>${t("profile.sortAlpha")}</option>
              </select>
            </div>
          </div>
          <div id="profile-games-grid" class="list">${renderProfileGrid(filtered)}</div>
        </div>
        <aside class="profile-side">
          ${renderRecentGrid()}
          ${renderFriendsSection()}
        </aside>
      </div>
    </div>`;
}

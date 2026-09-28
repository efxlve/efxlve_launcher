/**
 * Profile page renderer.
 *
 * Account-centric layout for multiple Epic/GOG accounts:
 * - a chip row selects the combined "Overview" profile or one linked account;
 * - only the active account of each store has live data, so the combined view
 *   merges the active accounts and inactive accounts show a one-click switch;
 * - photos are strictly per key (`global`, `epic:<id>`, `gog:<id>`).
 *
 * Only data the launcher actually has is shown; no derived or estimated tiers.
 */

import { PROFILE_CARD_CHUNK } from "../../core/constants";
import { achSummaryOf } from "../../core/game-view";
import { emptyState, epicPlatinumIcon, icon } from "../../core/icons";
import { rawOf } from "../../core/selectors";
import { avatarFor, globalAvatar, S } from "../../core/state";
import { esc, fmtPlaytime, isOpaqueId } from "../../core/utils";
import { t } from "../../i18n";

import { epicPortrait, type ProfileGameRecord } from "../../epic";

function coverOf(appName: string, fallback = ""): string {
  const s = S.epicSummariesMap.get(appName);
  const raw = rawOf(appName);
  const gogItem = S.gogSummariesMap.get(appName) || S.allGamesMap.get(appName);
  return S.customCovers[appName] || (raw ? epicPortrait(raw) : null) || s?.cover || gogItem?.coverUrl || fallback;
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
    const isGog = g.app_name.startsWith("gog::") || S.gogSummariesMap.has(g.app_name) || S.allGamesMap.get(g.app_name)?.source === "gog";
    const storeChip = S.gogSummaries.length > 0
      ? (isGog ? ` <span class="profile-store-chip">GOG</span>` : ` <span class="profile-store-chip">EPIC</span>`)
      : "";
    return `
      <div class="row profile-game-row" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button">
        ${cover ? `<img class="row-thumb" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="row-thumb"></span>`}
        <div class="row-main">
          <div class="row-title">${esc(g.app_title)}${storeChip}${isPlat ? ` <span class="profile-plat">${epicPlatinumIcon(12)}</span>` : ""}</div>
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

/** Epic-side library size (hidden games excluded). */
function totalEpicGames(): number {
  let n = 0;
  for (const s of S.epicSummaries) if (!S.hiddenGames.has(s.appName)) n++;
  return n;
}

/** One selectable account in the profile header. */
interface ProfileAccount {
  key: string;
  kind: "epic" | "gog";
  id: string;
  name: string;
  active: boolean;
}

/** Every linked account (Epic + GOG), active one flagged. */
function profileAccounts(): ProfileAccount[] {
  const out: ProfileAccount[] = [];
  const seen = new Set<string>();
  const pushEpic = (id: string, name: string, active: boolean): void => {
    if (!id || seen.has(`epic:${id}`)) return;
    seen.add(`epic:${id}`);
    out.push({ key: `epic:${id}`, kind: "epic", id, name: name || "Epic Games", active });
  };
  for (const acc of S.savedAccounts || []) {
    pushEpic(acc.account_id, acc.display_name, acc.is_active || acc.account_id === S.epicAccountId);
  }
  if (S.epicAccountId) pushEpic(S.epicAccountId, S.epicAccount, true);
  for (const acc of S.gogSavedAccounts || []) {
    const key = `gog:${acc.user_id}`;
    if (!acc.user_id || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind: "gog", id: acc.user_id, name: acc.username || "GOG User", active: acc.is_active || acc.user_id === S.gogAccountId });
  }
  if (S.gogAccountId) {
    const key = `gog:${S.gogAccountId}`;
    if (!seen.has(key)) out.push({ key, kind: "gog", id: S.gogAccountId, name: S.gogAccount || "GOG User", active: true });
  }
  return out;
}

/** Active accounts only: the combined profile merges exactly these. */
function activeAccounts(): ProfileAccount[] {
  return profileAccounts().filter((a) => a.active);
}

type ProfileSelection = { mode: "combined" } | { mode: "account"; account: ProfileAccount };

/**
 * Resolves what the page shows: the combined overview (default once several
 * accounts/stores are linked) or one specific account.
 */
function profileSelection(): ProfileSelection {
  const all = profileAccounts();
  const selected = S.profileAccount;
  if (selected && selected !== "overview") {
    const found = all.find((a) => a.key === selected);
    if (found) return { mode: "account", account: found };
  }
  const actives = activeAccounts();
  if (!selected && actives.length <= 1) {
    if (actives.length === 1) return { mode: "account", account: actives[0] };
  }
  return { mode: "combined" };
}

function accountAvatar(account: ProfileAccount): string | null {
  return avatarFor(account.key);
}

/** Avatar chip row: combined overview plus every linked account. */
function renderProfileAccountChips(selection: ProfileSelection): string {
  const all = profileAccounts();
  const showOverview = activeAccounts().length > 0 && (all.length > 1 || activeAccounts().length > 1);
  if (!showOverview && all.length <= 1) return "";

  const overviewChip = showOverview
    ? (() => {
        const av = globalAvatar();
        return `
      <button type="button" class="profile-acc-chip${selection.mode === "combined" ? " active" : ""}" data-act="profile-account" data-key="overview" title="${esc(t("profile.overview"))}">
        <span class="profile-acc-avatar">${av ? `<img src="${esc(av)}" alt="" />` : icon("gamepad-2", 14)}</span>
        <span class="profile-acc-name">${esc(t("profile.overview"))}</span>
        <span class="profile-acc-platform">${t("profile.overviewChip")}</span>
      </button>`;
      })()
    : "";

  const chips = all.map((a) => {
    const avatar = accountAvatar(a);
    const initial = (a.name.trim().charAt(0) || "?").toUpperCase();
    const isCurrent = selection.mode === "account" && selection.account.key === a.key;
    return `
      <button type="button" class="profile-acc-chip${isCurrent ? " active" : ""}" data-act="profile-account" data-key="${esc(a.key)}" title="${esc(a.name)}">
        <span class="profile-acc-avatar">${avatar ? `<img src="${esc(avatar)}" alt="" />` : esc(initial)}</span>
        <span class="profile-acc-name">${esc(a.name)}</span>
        <span class="profile-acc-platform">${a.kind === "epic" ? "EPIC" : "GOG"}</span>
        ${a.active ? `<span class="profile-acc-dot" aria-hidden="true"></span>` : ""}
      </button>`;
  }).join("");

  return `
    <div class="profile-accounts" role="tablist" aria-label="${esc(t("profile.accountsTitle"))}">
      ${overviewChip}
      ${chips}
      <button type="button" class="profile-acc-add" data-view="accounts" title="${esc(t("settings.accountAdd"))}">${icon("plus", 14)}</button>
    </div>`;
}

/** Side card: every linked account with its store and switch action. */
function renderLinkedAccountsCard(selection: ProfileSelection): string {
  const all = profileAccounts();
  if (all.length === 0) return "";
  const rows = all.map((a) => {
    const avatar = accountAvatar(a);
    const initial = (a.name.trim().charAt(0) || "?").toUpperCase();
    const current = selection.mode === "account" && selection.account.key === a.key;
    const action = a.active
      ? `<button type="button" class="btn ghost small" data-act="profile-account" data-key="${esc(a.key)}">${current ? t("profile.overviewChip") : t("profile.showAccount")}</button>`
      : `<button type="button" class="btn primary small" data-act="${a.kind === "epic" ? "account-switch" : "gog-account-switch"}" data-id="${esc(a.id)}">${t("settings.accountSwitchBtn")}</button>`;
    return `
      <div class="row profile-acc-row">
        <span class="profile-acc-avatar">${avatar ? `<img src="${esc(avatar)}" alt="" />` : esc(initial)}</span>
        <div class="row-main">
          <div class="row-title">${esc(a.name)}</div>
          <div class="row-meta">${a.kind === "epic" ? "Epic Games" : "GOG.COM"}</div>
        </div>
        ${a.active ? `<span class="profile-acc-dot" title="${esc(t("accounts.connected"))}" aria-hidden="true"></span>` : ""}
        ${action}
      </div>`;
  }).join("");
  return `
    <section class="card profile-side-card">
      <div class="profile-side-head"><h3 class="gp-section-title">${t("profile.linkedAccounts")}</h3></div>
      ${rows}
    </section>`;
}

/** Per-store library sizes for the linked stores. */
function renderStoreBreakdown(): string {
  const rows: string[] = [];
  if (S.epicAccount) {
    rows.push(`<div class="row profile-store-row"><div class="row-main"><div class="row-title">Epic Games</div></div><span class="row-meta">${totalEpicGames()} ${t("profile.games")}</span></div>`);
  }
  if (S.gogAccount) {
    rows.push(`<div class="row profile-store-row"><div class="row-main"><div class="row-title">GOG.COM</div></div><span class="row-meta">${S.gogSummaries.length} ${t("profile.games")}</span></div>`);
  }
  if (rows.length === 0) return "";
  return `
    <section class="card profile-side-card">
      <div class="profile-side-head"><h3 class="gp-section-title">${t("profile.storeBreakdown")}</h3></div>
      ${rows.join("")}
    </section>`;
}

function recentApps(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): boolean => {
    if (!seen.has(name) && (S.epicSummariesMap.has(name) || S.allGamesMap.has(name))) {
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
  for (const g of S.gogSummaries) if (g.installed && push(g.key)) return out;
  return out;
}

function renderRecentGrid(): string {
  const items = recentApps().map((appName) => {
    const title = S.epicSummariesMap.get(appName)?.title || S.allGamesMap.get(appName)?.title || appName;
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
    if (isOpaqueId(g.app_title) || S.hiddenGames.has(g.app_name)) return false;
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

function buildGogProfileGames(): ProfileGameRecord[] {
  const games: ProfileGameRecord[] = [];
  for (const item of S.gogSummaries) {
    const ach = achSummaryOf(item.key) || achSummaryOf(item.id);
    if (ach && ach.total_achievements > 0) {
      games.push({
        sandbox_id: "",
        app_name: item.key,
        app_title: item.title,
        cover: item.coverUrl,
        total_unlocked: ach.user_unlocked,
        total_achievements: ach.total_achievements,
        total_xp: ach.user_xp || 0,
        total_product_xp: ach.total_xp || 0,
        is_platinum: ach.is_platinum || false,
        unlocked_percent: ach.total_achievements > 0 ? Math.round((ach.user_unlocked / ach.total_achievements) * 100) : 0,
        last_unlocked_date: null,
      });
    }
  }
  return games;
}

/** Sums the stats the launcher actually has for the given game list. */
function sumStats(games: ProfileGameRecord[]): { unlocked: number; platinums: number; xp: number } {
  let unlocked = 0, platinums = 0, xp = 0;
  for (const g of games) {
    unlocked += g.total_unlocked;
    xp += g.total_xp;
    if (g.is_platinum || g.unlocked_percent >= 100) platinums++;
  }
  return { unlocked, platinums, xp };
}

/** Playtime sum, split by store so totals never mix Epic and GOG hours. */
function playtimeFor(scope: "epic" | "gog" | "all"): number {
  let total = 0;
  for (const [key, rec] of S.playtimeMap) {
    const isGog = key.startsWith("gog::");
    if (scope === "all" || isGog === (scope === "gog")) total += rec.total_seconds || 0;
  }
  return total;
}

/** Relative "last used" label from a unix timestamp (seconds or ms). */
function lastUsedLabel(ts: number): string {
  if (!ts) return "";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("notif.justNow");
  if (mins < 60) return t("notif.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("notif.hoursAgo", { n: hours });
  return t("notif.daysAgo", { n: Math.floor(hours / 24) });
}

/** Archived game count and last use for an account we are not signed in to. */
function accountArchiveInfo(account: ProfileAccount): { games: number | null; lastUsed: string } {
  if (account.kind === "epic") {
    const saved = (S.savedAccounts || []).find((a) => a.account_id === account.id);
    return {
      games: typeof saved?.game_count === "number" ? saved.game_count : null,
      lastUsed: lastUsedLabel(saved?.last_used || 0),
    };
  }
  const saved = (S.gogSavedAccounts || []).find((a) => a.user_id === account.id);
  return {
    games: typeof saved?.game_count === "number" ? saved.game_count : null,
    lastUsed: lastUsedLabel(saved?.last_used || 0),
  };
}

export function renderProfile(): string {
  const hasAnyData = S.playerProfileData || S.gogSummaries.length > 0;
  if (S.profileLoading && !hasAnyData) {
    return `<div class="page">${`<div class="empty-state"><span class="spinner"></span><h3>${t("profile.loadingTitle")}</h3><p>${t("profile.loadingDesc")}</p></div>`}</div>`;
  }
  if (S.profileError && !hasAnyData) {
    return `<div class="page">${emptyState("info", t("profile.errorTitle"), esc(S.profileError), `<button class="btn primary" data-act="refresh-profile">${t("profile.retry")}</button>`)}</div>`;
  }

  const selection = profileSelection();
  const combined = selection.mode === "combined";
  const account = combined ? null : selection.account;
  const isEpic = account?.kind === "epic";
  const prof = combined || isEpic ? (S.epicAccount ? S.playerProfileData : null) : null;

  // Live data exists only for active accounts: never guess another account's
  // trophies or hours (see ROADMAP 7 for the shared-library plan).
  const showData = combined ? Boolean(S.epicAccount || S.gogAccount) : Boolean(account?.active);
  const games: ProfileGameRecord[] = !showData
    ? []
    : combined
      ? [...(prof?.games || []), ...buildGogProfileGames()]
      : isEpic
        ? prof?.games || []
        : buildGogProfileGames();

  const displayName = combined
    ? t("profile.overview")
    : account!.name || (isEpic ? S.epicAccount : S.gogAccount) || t("profile.player");
  const avatarKey = combined ? "global" : account!.key;
  const customAvatar = combined ? globalAvatar() : accountAvatar(account!);
  const initial = displayName.trim().charAt(0).toUpperCase() || "E";

  const filtered = filteredProfileGames(games);
  let countPlat = 0, countProgress = 0, countNotStarted = 0, countVisible = 0, countHidden = 0;
  for (const g of games) {
    if (isOpaqueId(g.app_title) || S.hiddenGames.has(g.app_name)) continue;
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
    `<button class="tab ${!S.profileShowHidden && S.profileFilter === val ? "active" : ""}" data-act="profile-filter" data-val="${val}">${label}<span class="count">${n}</span></button>`;

  // Stats: combined view sums both active stores; an account view uses only that
  // account's data (its own store's hours included).
  let unlocked = 0, platinums = 0, xp = 0, playtimeSeconds = 0;
  if (showData) {
    const sums = sumStats(games);
    if (combined) {
      unlocked = sums.unlocked;
      platinums = sums.platinums;
      xp = sums.xp;
      playtimeSeconds = playtimeFor("all");
    } else if (isEpic) {
      unlocked = prof?.total_unlocked || 0;
      platinums = prof?.platinum_count || 0;
      xp = prof?.total_xp || 0;
      playtimeSeconds = playtimeFor("epic");
    } else {
      unlocked = sums.unlocked;
      platinums = sums.platinums;
      xp = sums.xp;
      playtimeSeconds = playtimeFor("gog");
    }
  }

  const activeNames = activeAccounts().map((a) => `${a.name} (${a.kind === "epic" ? "Epic" : "GOG"})`).join(" · ");
  const token = (label: string): string => `<span class="profile-token">${esc(label)}</span>`;
  const status = (label: string, kind: "ok" | "warn"): string =>
    `<span class="profile-status${kind === "warn" ? " inactive" : ""}"><span class="profile-status-dot"></span>${esc(label)}</span>`;

  const subChips = combined
    ? `${activeAccounts().map((a) => token(a.kind === "epic" ? "Epic Games" : "GOG.COM")).join(`<span class="profile-token-sep">·</span>`)}
       ${activeNames
         ? `<span class="profile-sub-note">${esc(activeNames)}</span>`
         : status(t("profile.inactiveTitle"), "warn")}`
    : `${token(isEpic ? "Epic Games" : "GOG.COM")}
       ${!account!.active
         ? status(t("profile.inactiveTitle"), "warn")
         : S.offlineMode && isEpic
           ? status(t("profile.offlineMode"), "warn")
           : status(t("accounts.connected"), "ok")}`;

  // Dormant account: nothing below loads until the user switches, so the page
  // becomes one calm panel with the data we do have (archive count, last use).
  if (!showData && !combined) {
    const archive = accountArchiveInfo(account!);
    const switchAct = isEpic ? "account-switch" : "gog-account-switch";
    const avatarTitleDormant = customAvatar ? t("profile.changeAvatarTitle") : t("profile.uploadAvatarTitle");
    return `
      <div class="page profile-page">
        ${renderProfileAccountChips(selection)}
        <section class="card profile-head">
          <button class="avatar-edit-btn profile-avatar-btn" data-act="profile-change-avatar" data-key="${esc(avatarKey)}" data-name="${esc(displayName)}" title="${esc(avatarTitleDormant)}" aria-label="${esc(avatarTitleDormant)}">
            <span class="settings-avatar profile-avatar">${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : esc(initial)}</span>
            <span class="avatar-edit-badge" aria-hidden="true">${icon("camera", 12)}</span>
          </button>
          <div class="row-main">
            <h1 class="profile-name">${esc(displayName)}</h1>
            <div class="profile-sub">${subChips}</div>
          </div>
        </section>
        <section class="list profile-dormant">
          <div class="row">
            <span class="profile-dormant-ico" aria-hidden="true">${icon("lock", 18)}</span>
            <div class="row-main">
              <div class="row-title">${t("profile.dormantTitle")}</div>
              <div class="row-meta profile-dormant-desc">${t("profile.inactiveDesc")}</div>
            </div>
          </div>
          ${archive.games !== null
            ? `<div class="row"><div class="row-main"><div class="row-title">${t("profile.archivedGames")}</div></div><span class="profile-dormant-val tabular-nums">${archive.games}</span></div>`
            : ""}
          ${archive.lastUsed
            ? `<div class="row"><div class="row-main"><div class="row-title">${t("profile.lastUsed")}</div></div><span class="profile-dormant-val">${esc(archive.lastUsed)}</span></div>`
            : ""}
          <div class="row">
            <div class="row-main"><div class="row-title">${t("profile.store")}</div></div>
            <span class="profile-dormant-val">${isEpic ? "Epic Games" : "GOG.COM"}</span>
          </div>
          <div class="row profile-dormant-actions">
            <button class="btn primary" data-act="${switchAct}" data-id="${esc(account!.id)}">${t("settings.accountSwitchBtn")}</button>
          </div>
        </section>
      </div>`;
  }

  const gamesCount = combined
    ? totalEpicGames() + S.gogSummaries.length
    : isEpic
      ? totalEpicGames()
      : S.gogSummaries.length;

  const statsRow = showData
    ? `<div class="profile-stats">
        ${stat(String(gamesCount), t("profile.games"))}
        ${stat(esc(fmtPlaytime(playtimeSeconds)), t("profile.played"))}
        ${stat(unlocked.toLocaleString(), t("profile.trophies"))}
        ${stat(String(platinums), t("profile.platLabel"))}
        ${stat(xp.toLocaleString(), "XP")}
      </div>`
    : `<div class="profile-inactive">
        <p class="row-meta">${t("profile.inactiveDesc")}</p>
        <button class="btn primary small" ${combined ? `data-view="accounts"` : `data-act="${isEpic ? "account-switch" : "gog-account-switch"}" data-id="${esc(account!.id)}"`}>${combined ? t("accounts.manageAccounts") : t("settings.accountSwitchBtn")}</button>
      </div>`;

  const body = showData
    ? `
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
          ${renderLinkedAccountsCard(selection)}
          ${renderStoreBreakdown()}
          ${renderRecentGrid()}
          ${!combined || isEpic || S.epicAccount ? renderFriendsSection() : ""}
        </aside>
      </div>`
    : "";

  const avatarTitle = customAvatar ? t("profile.changeAvatarTitle") : t("profile.uploadAvatarTitle");
  return `
    <div class="page profile-page">
      ${renderProfileAccountChips(selection)}
      <section class="card profile-head">
        <button class="avatar-edit-btn profile-avatar-btn" data-act="profile-change-avatar" data-key="${esc(avatarKey)}" data-name="${esc(displayName)}" title="${esc(avatarTitle)}" aria-label="${esc(avatarTitle)}">
          <span class="settings-avatar profile-avatar">${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : combined ? icon("gamepad-2", 26) : esc(initial)}</span>
          <span class="avatar-edit-badge" aria-hidden="true">${icon("camera", 12)}</span>
        </button>
        <div class="row-main">
          <h1 class="profile-name">${esc(displayName)}</h1>
          <div class="profile-sub">${subChips}</div>
        </div>
        ${statsRow}
        <button class="icon-btn lib-refresh-btn ${S.profileLoading ? "spinning" : ""}" data-act="refresh-profile" title="${S.gogSummaries.length > 0 ? t("profile.refreshTitleMulti") : t("profile.refreshTitle")}">${icon("refresh", 16)}</button>
      </section>
      ${body}
    </div>`;
}

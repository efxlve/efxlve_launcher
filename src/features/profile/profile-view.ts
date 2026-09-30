/**
 * Profile page renderer.
 *
 * Modern Universal Gaming Hub profile adhering to the Hydra / PS5 Console Dark
 * aesthetic and inspired by the modern console profile architecture (Xbox Mythic
 * update / PlayStation trophy showcase):
 *
 * - Hero Gamer Banner: Avatar, identity, connected store presence, tabular stats
 *   (Games, Playtime, Total Trophies, 100% Completions / Platinums, XP).
 * - Focused 3-Tab Architecture:
 *   1. "Overview" (Genel Bakış): 100% Mythic / Platinum Completions Showcase,
 *      active In-Progress trophies, Recently Played shelf, and connected stores snapshot.
 *   2. "Achievements" (Başarımlar): Comprehensive catalog with store scope pills,
 *      status filters, search, sort, and sleek game progress rows.
 *   3. "Accounts" (Hesaplar): Clean, uncluttered account manager for Epic, Steam,
 *      and GOG with instant one-click switching.
 * - Single account mode: Dedicated focused view with one-click return to Overview.
 * - Strict adherence to DESIGN_SYSTEM.md: True black (#000000), surface-1/2/3,
 *   tabular-nums for metrics, zero emojis (pure SVGs only), 120 FPS performance.
 */

import { PROFILE_CARD_CHUNK } from "../../core/constants";
import { achSummaryOf } from "../../core/game-view";
import { emptyState, epicPlatinumIcon, icon } from "../../core/icons";
import { rawOf } from "../../core/selectors";
import { avatarFor, globalAvatar, S } from "../../core/state";
import { esc, fmtPlaytime, isOpaqueId } from "../../core/utils";
import { t } from "../../i18n";

import { epicPortrait, type ProfileGameRecord } from "../../epic";
import { storeLogo } from "../store/store-logos";

export function coverOf(appName: string, fallback = ""): string {
  const s = S.epicSummariesMap.get(appName);
  const raw = rawOf(appName);
  const gogItem = S.gogSummariesMap.get(appName) || S.allGamesMap.get(appName);
  return S.customCovers[appName] || (raw ? epicPortrait(raw) : null) || s?.cover || gogItem?.coverUrl || fallback;
}

function renderProfileGameCards(cardGames: ProfileGameRecord[]): string {
  if (cardGames.length === 0) {
    const steamGap = !S.profileShowHidden && !S.profileSearchQuery && S.profileFilter === "all"
      && achievementScope() === "steam" && totalSteamGames() > 0 && buildSteamProfileGames().length === 0;
    const title = S.profileShowHidden ? t("profile.hiddenEmpty") : steamGap ? t("profile.steamEmptyTitle") : t("profile.emptyTitle");
    const desc = S.profileShowHidden ? t("profile.hiddenEmptyDesc") : steamGap ? t("profile.steamEmptyDesc") : t("profile.emptyDesc");
    return `<div class="row">${emptyState("trophy", title, desc)}</div>`;
  }
  const chips = showStoreChips();
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
    const storeChip = chips
      ? ` <span class="profile-store-chip">${storeCode(gameStore(g.app_name))}</span>`
      : "";
    return `
      <div class="row profile-game-row" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button">
        ${cover ? `<img class="profile-game-thumb" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="profile-game-thumb placeholder">${icon("gamepad-2", 16)}</span>`}
        <div class="row-main">
          <div class="row-title">${esc(g.app_title)}${storeChip}${isPlat ? ` <span class="profile-plat" title="${esc(t("profile.platLabel"))}">${epicPlatinumIcon(13)}</span>` : ""}</div>
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

/** Epic-side library size (hidden games excluded). */
function totalEpicGames(): number {
  let n = 0;
  for (const s of S.epicSummaries) if (!S.hiddenGames.has(s.appName)) n++;
  return n;
}

/** Steam library size. Falls back to the client count before the first scan. */
function totalSteamGames(): number {
  if (S.steamSummaries.length > 0) {
    let n = 0;
    for (const g of S.steamSummaries) if (!S.hiddenGames.has(g.key)) n++;
    return n;
  }
  return S.steamStatus?.games ?? 0;
}

export type StoreKind = "epic" | "gog" | "steam";

/** One selectable account in the profile header. */
export interface ProfileAccount {
  key: string;
  kind: StoreKind;
  id: string;
  name: string;
  active: boolean;
}

export function storeName(kind: StoreKind): string {
  if (kind === "epic") return "Epic Games";
  if (kind === "gog") return "GOG.COM";
  return "Steam";
}

export function storeCode(kind: StoreKind): string {
  if (kind === "epic") return "EPIC";
  if (kind === "gog") return "GOG";
  return "STEAM";
}

export function switchAct(kind: StoreKind): string {
  if (kind === "epic") return "account-switch";
  if (kind === "gog") return "gog-account-switch";
  return "steam-account-switch";
}

/** Library key → store. Epic ids have no prefix. */
export function gameStore(appName: string): StoreKind {
  if (appName.startsWith("steam::") || S.steamSummariesMap.has(appName)) return "steam";
  if (appName.startsWith("gog::") || S.gogSummariesMap.has(appName) || S.allGamesMap.get(appName)?.source === "gog") return "gog";
  return "epic";
}

function steamSignedIn(): boolean {
  return S.steamAuthStep === "signed_in" || S.steamAuth?.state === "signed_in";
}

/** Steam library or client session the overview can actually show. */
function steamConnected(): boolean {
  return steamSignedIn() || S.steamSummaries.length > 0 || (S.steamStatus?.games ?? 0) > 0;
}

function steamSessionId(): string {
  return steamSignedIn() ? (S.steamAuth?.steamId || "") : "";
}

/** Every linked account (Epic, GOG, Steam), active one flagged. */
export function profileAccounts(): ProfileAccount[] {
  const out: ProfileAccount[] = [];
  const seen = new Set<string>();
  const push = (kind: StoreKind, id: string, name: string, active: boolean, fallback: string): void => {
    const key = `${kind}:${id}`;
    if (!id || seen.has(key)) return;
    seen.add(key);
    out.push({ key, kind, id, name: name || fallback, active });
  };
  for (const acc of S.savedAccounts || []) {
    push("epic", acc.account_id, acc.display_name, acc.is_active || acc.account_id === S.epicAccountId, "Epic Games");
  }
  if (S.epicAccountId) push("epic", S.epicAccountId, S.epicAccount, true, "Epic Games");
  for (const acc of S.gogSavedAccounts || []) {
    if (acc.user_id === "46899977096215655") continue;
    push("gog", acc.user_id, acc.username, acc.is_active || acc.user_id === S.gogAccountId, "GOG User");
  }
  if (S.gogAccountId && S.gogAccountId !== "46899977096215655") {
    push("gog", S.gogAccountId, S.gogAccount, true, "GOG User");
  }
  const sessionId = steamSessionId();
  for (const acc of S.steamSavedAccounts || []) {
    push("steam", acc.steamId, acc.accountName, acc.isActive || acc.steamId === sessionId, "Steam");
  }
  if (sessionId) push("steam", sessionId, S.steamAuth?.accountName || S.steamStatus?.userName || "", true, "Steam");
  return out;
}

/** Active accounts only: the combined profile merges exactly these. */
function activeAccounts(): ProfileAccount[] {
  return profileAccounts().filter((a) => a.active);
}

export type ProfileSelection = { mode: "combined" } | { mode: "account"; account: ProfileAccount };

/**
 * Resolves what the page shows: the combined overview (default once several
 * accounts/stores are linked) or one specific account.
 */
export function profileSelection(): ProfileSelection {
  const all = profileAccounts();
  const selected = S.profileAccount;
  if (selected && selected !== "overview") {
    const found = all.find((a) => a.key === selected);
    if (found) return { mode: "account", account: found };
  }
  const actives = activeAccounts();
  if (!selected && actives.length <= 1 && overviewStores().length < 2) {
    if (actives.length === 1) return { mode: "account", account: actives[0] };
  }
  return { mode: "combined" };
}

export function accountAvatar(account: ProfileAccount): string | null {
  return avatarFor(account.key);
}

function recentApps(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): boolean => {
    if (!seen.has(name) && (S.epicSummariesMap.has(name) || S.allGamesMap.has(name))) {
      seen.add(name);
      out.push(name);
    }
    return out.length >= 8;
  };
  for (const name of S.epicRecent) if (push(name)) return out;
  const played = [...S.playtimeMap.entries()]
    .filter(([, r]) => (r.total_seconds || 0) > 0)
    .sort((a, b) => (b[1].last_played_timestamp || 0) - (a[1].last_played_timestamp || 0));
  for (const [name] of played) if (push(name)) return out;
  for (const s of S.epicSummaries) if (s.installed && push(s.appName)) return out;
  for (const g of S.gogSummaries) if (g.installed && push(g.key)) return out;
  for (const g of S.steamSummaries) if (g.installed && push(g.key)) return out;
  return out;
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

/** Steam achievement rows from the on-disk summary cache (same shape as GOG). */
function buildSteamProfileGames(): ProfileGameRecord[] {
  const games: ProfileGameRecord[] = [];
  for (const item of S.steamSummaries) {
    const ach = achSummaryOf(item.key);
    if (!ach || ach.total_achievements <= 0 || !ach.supported) continue;
    const pct = Math.round((ach.user_unlocked / ach.total_achievements) * 100);
    games.push({
      sandbox_id: "",
      app_name: item.key,
      app_title: item.title,
      cover: item.coverUrl,
      total_unlocked: ach.user_unlocked,
      total_achievements: ach.total_achievements,
      total_xp: ach.user_xp || 0,
      total_product_xp: ach.total_xp || 0,
      is_platinum: ach.is_platinum || pct >= 100,
      unlocked_percent: pct,
      last_unlocked_date: null,
    });
  }
  return games;
}

/** Stores that currently have a signed-in session or a local library. */
export function overviewStores(): StoreKind[] {
  const out: StoreKind[] = [];
  if (S.epicAccount) out.push("epic");
  if (S.gogAccount) out.push("gog");
  if (steamConnected()) out.push("steam");
  return out;
}

/** Overview store tab. Account pages ignore it and use that account's store. */
function storeScope(): "all" | StoreKind {
  if (profileSelection().mode !== "combined") return "all";
  const store = S.profileStore;
  if (store === "all") return "all";
  return overviewStores().includes(store) ? store : "all";
}

/** The store whose numbers and achievement list are on screen. */
function achievementScope(): "all" | StoreKind {
  const sel = profileSelection();
  if (sel.mode === "account") return sel.account.kind;
  return storeScope();
}

/** Store marks on rows only when Overview is mixing more than one store. */
function showStoreChips(): boolean {
  return profileSelection().mode === "combined" && storeScope() === "all" && overviewStores().length > 1;
}

/**
 * Achievement rows for the current page: one account, or Overview narrowed by
 * the store tab. Search updates call this so GOG and Steam stay in the list.
 */
export function profileListGames(): ProfileGameRecord[] {
  const selection = profileSelection();
  if (selection.mode === "account") {
    if (!selection.account.active) return [];
    if (selection.account.kind === "epic") return S.epicAccount ? (S.playerProfileData?.games || []) : [];
    if (selection.account.kind === "gog") return buildGogProfileGames();
    return buildSteamProfileGames();
  }
  const scope = storeScope();
  const games: ProfileGameRecord[] = [];
  if ((scope === "all" || scope === "epic") && S.epicAccount) games.push(...(S.playerProfileData?.games || []));
  if ((scope === "all" || scope === "gog") && (S.gogAccount || S.gogSummaries.length > 0)) games.push(...buildGogProfileGames());
  if (scope === "all" || scope === "steam") games.push(...buildSteamProfileGames());
  return games;
}

export function libraryCount(scope: "all" | StoreKind): number {
  const epic = totalEpicGames();
  const gog = S.gogSummaries.length;
  const steam = totalSteamGames();
  if (scope === "epic") return epic;
  if (scope === "gog") return gog;
  if (scope === "steam") return steam;
  return epic + gog + steam;
}

/** Store filter pills inside the Achievements tab toolbar. */
function renderStoreScope(): string {
  if (profileSelection().mode !== "combined") return "";
  const stores = overviewStores();
  if (stores.length < 2) return "";
  const current = storeScope();
  const tab = (val: string, label: string, count?: number): string =>
    `<button type="button" class="tab${current === val ? " active" : ""}" data-act="profile-store" data-val="${val}">${esc(label)}${count !== undefined ? `<span class="count">${count}</span>` : ""}</button>`;
  return `<div class="tabs profile-scope-tabs" role="tablist" aria-label="${esc(t("profile.storeBreakdown"))}">
    ${tab("all", t("profile.storeAll"))}
    ${stores.includes("epic") ? tab("epic", "Epic", totalEpicGames()) : ""}
    ${stores.includes("gog") ? tab("gog", "GOG", S.gogSummaries.length) : ""}
    ${stores.includes("steam") ? tab("steam", "Steam", totalSteamGames()) : ""}
  </div>`;
}

/** Sums the stats the launcher actually has for the given game list. */
export function sumStats(games: ProfileGameRecord[]): { unlocked: number; platinums: number; xp: number } {
  let unlocked = 0, platinums = 0, xp = 0;
  for (const g of games) {
    unlocked += g.total_unlocked;
    xp += g.total_xp;
    if (g.is_platinum || g.unlocked_percent >= 100) platinums++;
  }
  return { unlocked, platinums, xp };
}

/** Playtime sum. Steam keys are `steam::`, so they never count as Epic hours. */
export function playtimeFor(scope: "epic" | "gog" | "steam" | "all"): number {
  let total = 0;
  for (const [key, rec] of S.playtimeMap) {
    const store = key.startsWith("steam::") ? "steam" : key.startsWith("gog::") ? "gog" : "epic";
    if (scope === "all" || store === scope) total += rec.total_seconds || 0;
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
export function accountArchiveInfo(account: ProfileAccount): { games: number | null; lastUsed: string } {
  if (account.kind === "epic") {
    const saved = (S.savedAccounts || []).find((a) => a.account_id === account.id);
    return {
      games: typeof saved?.game_count === "number" ? saved.game_count : null,
      lastUsed: lastUsedLabel(saved?.last_used || 0),
    };
  }
  if (account.kind === "steam") {
    const saved = (S.steamSavedAccounts || []).find((a) => a.steamId === account.id);
    return { games: null, lastUsed: lastUsedLabel(saved?.lastUsed || 0) };
  }
  const saved = (S.gogSavedAccounts || []).find((a) => a.user_id === account.id);
  return {
    games: typeof saved?.game_count === "number" ? saved.game_count : null,
    lastUsed: lastUsedLabel(saved?.last_used || 0),
  };
}

/**
 * 1. Gamer Identity Hero Banner:
 * Console-grade layout with large avatar, identity text, store pills, tabular stats,
 * and refresh button.
 */
function renderProfileHero(
  selection: ProfileSelection,
  displayName: string,
  avatarKey: string,
  customAvatar: string | null,
  initial: string,
  scope: "all" | StoreKind,
  games: ProfileGameRecord[],
  showData: boolean,
  combined: boolean,
  account: ProfileAccount | null,
  isEpic: boolean,
  prof: any,
  unlocked: number,
  platinums: number,
  xp: number,
  playtimeSeconds: number,
  gamesCount: number,
): string {
  const avatarTitle = customAvatar ? t("profile.changeAvatarTitle") : t("profile.uploadAvatarTitle");
  const showXp = !combined && isEpic;

  const stores = overviewStores();
  const storePills = combined && stores.length > 0
    ? `<div class="profile-hero-stores">
        ${stores.map((s) => `
          <span class="profile-hero-store-pill">
            <span class="profile-acc-dot" aria-hidden="true"></span>
            ${storeName(s)}
          </span>
        `).join("")}
      </div>`
    : !combined && account
      ? `<div class="profile-hero-stores">
          <span class="profile-hero-store-pill">
            <span class="profile-acc-dot" aria-hidden="true"></span>
            ${storeName(account.kind)}
          </span>
          <button type="button" class="btn ghost small profile-back-overview-btn" data-act="profile-account" data-key="overview">
            ${icon("arrow-left", 12)}
            <span>${t("profile.backToOverview")}</span>
          </button>
        </div>`
      : "";

  const stat = (value: string, label: string, iconPrefix = ""): string => `
    <div class="profile-stat">
      <span class="profile-stat-val tabular-nums">${iconPrefix}${value}</span>
      <span class="profile-stat-label">${label}</span>
    </div>`;

  const statsPod = showData
    ? `<div class="profile-stats">
        ${stat(String(gamesCount), t("profile.games"))}
        ${stat(esc(fmtPlaytime(playtimeSeconds)), t("profile.played"))}
        ${stat(unlocked.toLocaleString(), t("profile.trophies"))}
        ${stat(String(platinums), t("profile.platLabel"), `<span class="profile-stat-plat-ico">${epicPlatinumIcon(14)}</span>`)}
        ${showXp ? stat(xp.toLocaleString(), "XP") : ""}
      </div>`
    : `<div class="profile-inactive">
        <p class="row-meta">${t("profile.inactiveDesc")}</p>
        <button class="btn primary small" ${combined ? `data-view="accounts"` : `data-act="${switchAct(account!.kind)}" data-id="${esc(account!.id)}"`}>
          ${combined ? t("accounts.manageAccounts") : t("settings.accountSwitchBtn")}
        </button>
      </div>`;

  return `
    <section class="card profile-hero">
      <div class="profile-hero-left">
        <button class="avatar-edit-btn profile-avatar-btn" data-act="profile-change-avatar" data-key="${esc(avatarKey)}" data-name="${esc(displayName)}" title="${esc(avatarTitle)}" aria-label="${esc(avatarTitle)}">
          <span class="profile-avatar">${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : combined ? icon("gamepad-2", 28) : esc(initial)}</span>
          <span class="avatar-edit-badge" aria-hidden="true">${icon("camera", 12)}</span>
        </button>
        <div class="profile-hero-identity">
          <h1 class="profile-name">${esc(displayName)}</h1>
          ${storePills}
        </div>
      </div>
      <div class="profile-hero-right">
        ${statsPod}
        <button class="icon-btn lib-refresh-btn ${S.profileLoading ? "spinning" : ""}" data-act="refresh-profile" title="${overviewStores().length > 1 ? t("profile.refreshTitleMulti") : t("profile.refreshTitle")}">${icon("refresh", 16)}</button>
      </div>
    </section>`;
}

/**
 * 2. Focused Primary Navigation Tabs:
 * Overview (Genel Bakış), Achievements (Başarımlar), Accounts (Hesaplar).
 */
function renderProfileNavTabs(allAchievementsCount: number, accountsCount: number): string {
  const currentTab = S.profileTab || "overview";
  return `
    <nav class="tabs profile-nav-tabs" role="tablist">
      <button type="button" class="tab ${currentTab === "overview" ? "active" : ""}" data-act="profile-tab" data-tab="overview">
        ${icon("sparkles", 14)}
        <span>${t("profile.tabOverview")}</span>
      </button>
      <button type="button" class="tab ${currentTab === "achievements" ? "active" : ""}" data-act="profile-tab" data-tab="achievements">
        ${icon("trophy", 14)}
        <span>${t("profile.tabAchievements")}</span>
        ${allAchievementsCount > 0 ? `<span class="count">${allAchievementsCount}</span>` : ""}
      </button>
      <button type="button" class="tab ${currentTab === "accounts" ? "active" : ""}" data-act="profile-tab" data-tab="accounts">
        ${icon("users", 14)}
        <span>${t("profile.tabAccounts")}</span>
        ${accountsCount > 0 ? `<span class="count">${accountsCount}</span>` : ""}
      </button>
    </nav>`;
}

/**
 * 3. Tab 1: "Overview" (Genel Bakış):
 * - Xbox Mythic-inspired 100% Completions Showcase.
 * - Active in-progress achievements.
 * - Recently played games shelf.
 * - Connected stores quick snapshot.
 */
function renderOverviewTab(games: ProfileGameRecord[]): string {
  // A. 100% Mythic / Platinum Completions
  const platGames = games.filter((g) => g.is_platinum || g.unlocked_percent >= 100);

  // B. In-Progress Games (0% < progress < 100%)
  const inProgGames = games
    .filter((g) => !g.is_platinum && g.unlocked_percent > 0 && g.unlocked_percent < 100)
    .sort((a, b) => b.unlocked_percent - a.unlocked_percent || b.total_xp - a.total_xp);

  // C. Recently Played
  const recents = recentApps();

  // 1. Showcase Section HTML
  const showcaseCards = platGames.slice(0, 6).map((g) => {
    const cover = coverOf(g.app_name, g.cover || "");
    const store = storeCode(gameStore(g.app_name));
    return `
      <div class="profile-showcase-card" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button">
        ${cover ? `<img class="profile-showcase-img" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<div class="profile-showcase-placeholder">${icon("gamepad-2", 24)}</div>`}
        <span class="profile-showcase-store-chip">${store}</span>
        <span class="profile-showcase-badge" title="100% Complete">
          ${epicPlatinumIcon(12)}
          <span>100%</span>
        </span>
        <div class="profile-showcase-scrim">
          <div class="profile-showcase-title">${esc(g.app_title)}</div>
          <div class="profile-showcase-meta">${g.total_unlocked} / ${g.total_achievements} ${t("profile.trophies")}</div>
        </div>
      </div>`;
  }).join("");

  const showcaseHtml = `
    <section class="profile-section">
      <div class="profile-section-head">
        <div class="profile-section-title-wrap">
          <span class="profile-section-icon plat">${epicPlatinumIcon(16)}</span>
          <div>
            <h3 class="profile-section-title">${t("profile.showcaseTitle")}</h3>
            <div class="profile-section-desc">${t("profile.showcaseSubtitle")}</div>
          </div>
        </div>
        ${platGames.length > 6 ? `<button type="button" class="btn ghost small" data-act="profile-filter" data-val="platinum" data-tab="achievements">${t("profile.viewAll")} (${platGames.length})</button>` : ""}
      </div>
      ${platGames.length > 0
        ? `<div class="profile-showcase-grid">${showcaseCards}</div>`
        : `<div class="profile-empty-showcase">
            <span class="profile-empty-showcase-ico">${epicPlatinumIcon(28)}</span>
            <div class="profile-empty-showcase-text">
              <h4>${t("profile.showcaseEmpty")}</h4>
              <p>${t("profile.showcaseEmptyDesc")}</p>
            </div>
          </div>`
      }
    </section>`;

  // 2. In-Progress Section HTML
  const inProgCards = inProgGames.slice(0, 6).map((g) => {
    const cover = coverOf(g.app_name, g.cover || "");
    const store = storeCode(gameStore(g.app_name));
    const pt = S.playtimeMap.get(g.app_name);
    const pct = Math.min(100, Math.max(0, g.unlocked_percent));
    const meta = [
      `${g.total_unlocked} / ${g.total_achievements} ${t("profile.trophies")}`,
      pt && pt.total_seconds > 0 ? fmtPlaytime(pt.total_seconds) : "",
    ].filter(Boolean).join(" · ");
    return `
      <div class="profile-inprog-card" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button">
        ${cover ? `<img class="profile-inprog-thumb" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="profile-inprog-thumb placeholder">${icon("gamepad-2", 16)}</span>`}
        <div class="profile-inprog-main">
          <div class="profile-inprog-title">
            <span>${esc(g.app_title)}</span>
            <span class="profile-store-chip">${store}</span>
          </div>
          <div class="profile-inprog-meta">${meta}</div>
          <div class="profile-inprog-progress">
            <span style="width:${pct}%"></span>
          </div>
        </div>
        <div class="profile-inprog-pct tabular-nums">${pct}%</div>
      </div>`;
  }).join("");

  const inProgHtml = `
    <section class="profile-section">
      <div class="profile-section-head">
        <div class="profile-section-title-wrap">
          <span class="profile-section-icon">${icon("timer", 16)}</span>
          <div>
            <h3 class="profile-section-title">${t("profile.inProgressTitle")}</h3>
            <div class="profile-section-desc">${t("profile.inProgressSubtitle")}</div>
          </div>
        </div>
        ${inProgGames.length > 6 ? `<button type="button" class="btn ghost small" data-act="profile-filter" data-val="in_progress" data-tab="achievements">${t("profile.viewAll")} (${inProgGames.length})</button>` : ""}
      </div>
      ${inProgGames.length > 0
        ? `<div class="profile-inprog-grid">${inProgCards}</div>`
        : `<div class="profile-empty-inprog">
            <p class="row-meta">${t("profile.inProgressEmpty")}</p>
          </div>`
      }
    </section>`;

  // 3. Recently Played Section HTML
  const recentItems = recents.map((appName) => {
    const title = S.epicSummariesMap.get(appName)?.title || S.allGamesMap.get(appName)?.title || appName;
    const cover = coverOf(appName);
    return `
      <button type="button" class="profile-recent-card" data-act="epic-detail" data-id="${esc(appName)}" title="${esc(title)}">
        ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="placeholder">${icon("gamepad-2", 18)}</span>`}
      </button>`;
  }).join("");

  const recentHtml = recents.length > 0
    ? `
      <section class="profile-section">
        <div class="profile-section-head">
          <div class="profile-section-title-wrap">
            <span class="profile-section-icon">${icon("clock", 16)}</span>
            <h3 class="profile-section-title">${t("profile.recentGamesTitle")}</h3>
          </div>
          <button type="button" class="btn ghost small" data-view="library">${t("profile.showAll")}</button>
        </div>
        <div class="profile-recent-shelf">${recentItems}</div>
      </section>`
    : "";

  return `
    <div class="profile-overview-view">
      ${showcaseHtml}
      ${inProgHtml}
      ${recentHtml}
    </div>`;
}

/**
 * 4. Tab 2: "Achievements" (Başarımlar):
 * Full, filterable, searchable trophy catalog with clean toolbar and smooth rows.
 */
function renderAchievementsTab(filtered: ProfileGameRecord[], games: ProfileGameRecord[]): string {
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

  const filterTab = (val: string, label: string, n: number): string =>
    `<button type="button" class="tab ${!S.profileShowHidden && S.profileFilter === val ? "active" : ""}" data-act="profile-filter" data-val="${val}">${label}<span class="count">${n}</span></button>`;

  return `
    <div class="profile-achievements-view">
      ${renderStoreScope()}
      <div class="gp-toolbar profile-ach-toolbar">
        <div class="tabs">
          ${filterTab("all", t("profile.filterAll"), countVisible)}
          ${filterTab("platinum", t("profile.filterPlatinum"), countPlat)}
          ${filterTab("in_progress", t("profile.filterInProgress"), countProgress)}
          ${filterTab("not_started", t("profile.filterNotStarted"), countNotStarted)}
          ${countHidden > 0 ? `<button type="button" class="tab ${S.profileShowHidden ? "active" : ""}" data-act="profile-toggle-hidden">${t("profile.hiddenToggle")}<span class="count">${countHidden}</span></button>` : ""}
        </div>
        <div class="gp-toolbar-right">
          <button type="button" class="icon-btn" data-act="open-hide-achievements" title="${esc(t("profile.hideAchTip"))}" aria-label="${esc(t("profile.hideAchTip"))}">${icon("eye-off", 16)}</button>
          <label class="search gp-search">${icon("search", 15)}<input type="text" id="profile-search" placeholder="${t("profile.searchPlaceholder")}" value="${esc(S.profileSearchQuery)}" />
            ${S.profileSearchQuery ? `<button type="button" class="icon-btn" data-act="profile-search-clear">${icon("x", 12)}</button>` : ""}
          </label>
          <select id="profile-sort-select" data-act="profile-sort-change">
            <option value="progress" ${S.profileSort === "progress" ? "selected" : ""}>${t("profile.sortProgress")}</option>
            <option value="xp" ${S.profileSort === "xp" ? "selected" : ""}>${t("profile.sortXp")}</option>
            <option value="playtime" ${S.profileSort === "playtime" ? "selected" : ""}>${t("profile.sortPlaytime")}</option>
            <option value="alpha" ${S.profileSort === "alpha" ? "selected" : ""}>${t("profile.sortAlpha")}</option>
          </select>
        </div>
      </div>
      <div id="profile-games-grid" class="list profile-ach-list">${renderProfileGrid(filtered)}</div>
    </div>`;
}

/**
 * 5. Tab 3: "Accounts" (Hesaplar):
 * Spacious, clutter-free account management cards for Epic, GOG, and Steam.
 */
function renderAccountsTab(allAccounts: ProfileAccount[], selection: ProfileSelection): string {
  const isCombined = selection.mode === "combined";
  const globalPhoto = globalAvatar();

  const overviewCard = allAccounts.length > 1 || overviewStores().length > 1
    ? `
      <div class="card profile-overview-hub-card${isCombined ? " is-active-session" : ""}">
        <div class="profile-overview-hub-left">
          <span class="profile-overview-hub-avatar">
            ${globalPhoto ? `<img src="${esc(globalPhoto)}" alt="" />` : icon("gamepad-2", 28)}
          </span>
          <div class="profile-overview-hub-info">
            <div class="profile-overview-hub-title-row">
              <h4 class="profile-overview-hub-title">${t("profile.overview")}</h4>
              <span class="profile-store-chip">${t("profile.storeAll")}</span>
              ${isCombined ? `<span class="profile-active-tag">${icon("check", 13)} <span>${t("profile.currentSession")}</span></span>` : ""}
            </div>
            <p class="profile-overview-hub-desc">${t("profile.overviewDesc")}</p>
            <div class="profile-overview-hub-stores">
              ${overviewStores().map((s) => `
                <span class="profile-hero-store-pill">
                  <span class="profile-acc-dot" aria-hidden="true"></span>
                  ${storeLogo(s, 13)}
                  <span>${storeName(s)}</span>
                </span>
              `).join("")}
            </div>
          </div>
        </div>
        <div class="profile-overview-hub-actions">
          ${isCombined
            ? `<span class="chip ok">${icon("check", 12)} ${t("profile.currentSession")}</span>`
            : `<button type="button" class="btn primary small" data-act="profile-account" data-key="overview">${t("profile.showAccount")}</button>`
          }
        </div>
      </div>`
    : "";

  const accountCards = allAccounts.map((a) => {
    const avatar = accountAvatar(a);
    const initial = (a.name.trim().charAt(0) || "?").toUpperCase();
    const isCurrent = selection.mode === "account" && selection.account.key === a.key;
    const archive = accountArchiveInfo(a);

    const gameCount = archive.games !== null
      ? archive.games
      : a.kind === "epic"
        ? (a.active ? totalEpicGames() : null)
        : a.kind === "steam"
          ? (a.active ? totalSteamGames() : null)
          : (a.active ? S.gogSummaries.length : null);

    const action = !a.active
      ? `<button type="button" class="btn primary small" data-act="${switchAct(a.kind)}" data-id="${esc(a.id)}">${t("settings.accountSwitchBtn")}</button>`
      : isCurrent
        ? `<span class="chip ok">${icon("check", 12)} ${t("profile.currentSession")}</span>`
        : `<button type="button" class="btn ghost small" data-act="profile-account" data-key="${esc(a.key)}">${t("profile.showAccount")}</button>`;

    const lastUsedText = archive.lastUsed || (a.active ? t("notif.justNow") : "—");

    return `
      <div class="card profile-acc-manage-card${isCurrent ? " is-active-session" : ""}">
        <div class="profile-acc-manage-top">
          <div class="profile-acc-manage-user">
            <span class="profile-acc-avatar-lg">
              ${avatar ? `<img src="${esc(avatar)}" alt="" />` : esc(initial)}
            </span>
            <div class="profile-acc-manage-names">
              <div class="profile-acc-manage-title-row">
                <span class="profile-acc-manage-name">${esc(a.name)}</span>
                ${a.active ? `<span class="profile-acc-dot" title="${esc(t("accounts.connected"))}" aria-hidden="true"></span>` : ""}
              </div>
              <div class="profile-acc-manage-store-tag">
                ${storeLogo(a.kind, 14)}
                <span>${storeName(a.kind)}</span>
              </div>
            </div>
          </div>
          <div class="profile-acc-manage-badge">
            ${a.active
              ? `<span class="profile-acc-status-pill online"><span class="profile-acc-dot" aria-hidden="true"></span>${t("profile.activeSession")}</span>`
              : `<span class="profile-acc-status-pill offline">${t("profile.inactiveTitle")}</span>`
            }
          </div>
        </div>

        <div class="profile-acc-manage-meta-row">
          <span class="profile-acc-meta-item">
            <span class="profile-acc-meta-val tabular-nums">${gameCount !== null ? gameCount : "—"}</span>
            <span class="profile-acc-meta-lbl">${t("profile.games")}</span>
          </span>
          <span class="profile-acc-meta-sep"></span>
          <span class="profile-acc-meta-item">
            <span class="profile-acc-meta-val">${esc(lastUsedText)}</span>
            <span class="profile-acc-meta-lbl">${t("profile.lastUsed")}</span>
          </span>
        </div>

        <div class="profile-acc-manage-footer">
          ${action}
        </div>
      </div>`;
  }).join("");

  return `
    <div class="profile-accounts-view">
      <div class="profile-section-head">
        <div>
          <h3 class="profile-section-title">${t("profile.linkedAccounts")}</h3>
          <div class="profile-section-desc">${t("profile.accountsSubtitle")}</div>
        </div>
        <button type="button" class="btn ghost small" data-view="accounts">
          ${icon("plus", 14)}
          <span>${t("settings.accountAdd")}</span>
        </button>
      </div>

      ${overviewCard}

      <div class="profile-section-subhead">
        <h4 class="profile-section-subtitle">${t("profile.storeAccounts")}</h4>
      </div>

      <div class="profile-accounts-grid">
        ${accountCards}
      </div>
    </div>`;
}

/** Dormant account panel: calm grouped list when an inactive account is selected. */
function renderDormantView(account: ProfileAccount, displayName: string, avatarKey: string, customAvatar: string | null, initial: string): string {
  const archive = accountArchiveInfo(account);
  const dormantSwitch = switchAct(account.kind);
  const avatarTitleDormant = customAvatar ? t("profile.changeAvatarTitle") : t("profile.uploadAvatarTitle");

  return `
    <div class="page profile-page">
      <section class="card profile-hero">
        <div class="profile-hero-left">
          <button class="avatar-edit-btn profile-avatar-btn" data-act="profile-change-avatar" data-key="${esc(avatarKey)}" data-name="${esc(displayName)}" title="${esc(avatarTitleDormant)}" aria-label="${esc(avatarTitleDormant)}">
            <span class="profile-avatar">${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : esc(initial)}</span>
            <span class="avatar-edit-badge" aria-hidden="true">${icon("camera", 12)}</span>
          </button>
          <div class="profile-hero-identity">
            <h1 class="profile-name">${esc(displayName)}</h1>
            <div class="profile-hero-stores">
              <span class="profile-hero-store-pill">${storeName(account.kind)}</span>
              <button type="button" class="btn ghost small profile-back-overview-btn" data-act="profile-account" data-key="overview">
                ${icon("arrow-left", 12)}
                <span>${t("profile.backToOverview")}</span>
              </button>
            </div>
          </div>
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
          <span class="profile-dormant-val">${storeName(account.kind)}</span>
        </div>
        <div class="row profile-dormant-actions">
          <button type="button" class="btn primary" data-act="${dormantSwitch}" data-id="${esc(account.id)}">${t("settings.accountSwitchBtn")}</button>
        </div>
      </section>
    </div>`;
}

/** Main Profile Page Entry Point */
export function renderProfile(): string {
  const hasAnyData = S.playerProfileData || S.gogSummaries.length > 0 || steamConnected();
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
  const scope = achievementScope();
  const prof = isEpic || (combined && (scope === "all" || scope === "epic"))
    ? (S.epicAccount ? S.playerProfileData : null)
    : null;

  const showData = combined ? overviewStores().length > 0 : Boolean(account?.active);
  const games = showData ? profileListGames() : [];

  const displayName = combined
    ? t("profile.overview")
    : account!.name || t("profile.player");
  const avatarKey = combined ? "global" : account!.key;
  const customAvatar = combined ? globalAvatar() : accountAvatar(account!);
  const initial = displayName.trim().charAt(0).toUpperCase() || "E";

  // If selecting an inactive account, show the clean dormant panel
  if (!showData && !combined) {
    return renderDormantView(account!, displayName, avatarKey, customAvatar, initial);
  }

  const filtered = filteredProfileGames(games);

  // Sum statistics
  let unlocked = 0, platinums = 0, xp = 0, playtimeSeconds = 0;
  if (showData) {
    const sums = sumStats(games);
    if (!combined && isEpic && scope === "epic") {
      unlocked = prof?.total_unlocked || 0;
      platinums = prof?.platinum_count || 0;
      xp = prof?.total_xp || 0;
    } else {
      unlocked = sums.unlocked;
      platinums = sums.platinums;
      xp = sums.xp;
    }
    playtimeSeconds = playtimeFor(scope);
  }

  const gamesCount = libraryCount(scope);
  const allAccounts = profileAccounts();

  // Hero Gamer Banner
  const heroHtml = renderProfileHero(
    selection,
    displayName,
    avatarKey,
    customAvatar,
    initial,
    scope,
    games,
    showData,
    combined,
    account,
    isEpic,
    prof,
    unlocked,
    platinums,
    xp,
    playtimeSeconds,
    gamesCount,
  );

  // Nav tabs
  const navTabsHtml = renderProfileNavTabs(games.length, allAccounts.length);

  // Current tab content
  const tab = S.profileTab || "overview";
  let contentHtml = "";
  if (tab === "overview") {
    contentHtml = renderOverviewTab(games);
  } else if (tab === "achievements") {
    contentHtml = renderAchievementsTab(filtered, games);
  } else if (tab === "accounts") {
    contentHtml = renderAccountsTab(allAccounts, selection);
  }

  return `
    <div class="page profile-page">
      ${heroHtml}
      ${navTabsHtml}
      <div class="profile-content">
        ${contentHtml}
      </div>
    </div>`;
}

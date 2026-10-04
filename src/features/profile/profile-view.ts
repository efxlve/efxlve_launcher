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
import { rawOf, sourceOfKey } from "../../core/selectors";
import { avatarFor, currentProfileName, globalAvatar, S } from "../../core/state";
import { esc, fmtPlaytime, isOpaqueId } from "../../core/utils";
import { t } from "../../i18n";

import { epicPortrait, type ProfileGameRecord } from "../../epic";
import { storeLogo } from "../store/store-logos";
import { HEADER_STORES, STORE_LABELS } from "../store/store-view";

export function coverOf(appName: string, fallback = ""): string {
  const s = S.epicSummariesMap.get(appName);
  const raw = rawOf(appName);
  const gogItem = S.gogSummariesMap.get(appName) || S.allGamesMap.get(appName);
  return S.customCovers[appName] || (raw ? epicPortrait(raw) : null) || s?.cover || gogItem?.coverUrl || fallback;
}

/**
 * Re-applies the hover highlight after a background render. The native :hover
 * state is lost when the grid's DOM is replaced under a stationary pointer, so
 * during a render we ask the still-mounted old DOM which showcase card sits
 * under the pointer and mark the fresh card with `is-hover`. Reading the live
 * DOM (instead of remembering a key) means a stale highlight can never outlive
 * the pointer.
 */
let lastPointerX = -1;
let lastPointerY = -1;
let showcaseHoverWired = false;

function wireShowcaseHover(): void {
  if (showcaseHoverWired) return;
  showcaseHoverWired = true;
  // Only the position is tracked; the render reads the DOM itself.
  document.addEventListener("pointermove", (e) => {
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
  }, { passive: true });
  document.addEventListener("mouseleave", () => {
    lastPointerX = -1;
    lastPointerY = -1;
  });
}

/** Showcase card under the pointer right now (the old DOM is still mounted during a render). */
function hoveredShowcaseKey(): string | null {
  if (lastPointerX < 0) return null;
  const el = document.elementFromPoint(lastPointerX, lastPointerY);
  return el?.closest<HTMLElement>(".profile-showcase-card")?.dataset.id ?? null;
}

wireShowcaseHover();

/** Short tab labels: brand names are not translated. */
const STORE_TAB_LABELS: Record<StoreKind, string> = {
  epic: "Epic",
  gog: "GOG",
  steam: "Steam",
  xbox: "Xbox",
  battlenet: "Battle.net",
  ubisoft: "Ubisoft",
  ea: "EA",
  riot: "Riot",
};

/** Stores whose achievements the launcher tracks in bulk. */
const ACHIEVEMENT_STORES: StoreKind[] = ["epic", "gog", "steam", "ubisoft"];

function renderProfileGameCards(cardGames: ProfileGameRecord[]): string {
  if (cardGames.length === 0) {
    const steamGap = !S.profileShowHidden && !S.profileSearchQuery && S.profileFilter === "all"
      && achievementScope() === "steam" && totalSteamGames() > 0 && buildSteamProfileGames().length === 0;
    const companionGap = !S.profileShowHidden && !S.profileSearchQuery && S.profileFilter === "all"
      && achievementScope() !== "all" && !ACHIEVEMENT_STORES.includes(achievementScope() as StoreKind);
    const title = S.profileShowHidden ? t("profile.hiddenEmpty") : companionGap ? t("profile.companionEmptyTitle") : steamGap ? t("profile.steamEmptyTitle") : t("profile.emptyTitle");
    const desc = S.profileShowHidden ? t("profile.hiddenEmptyDesc") : companionGap ? t("profile.companionEmptyDesc") : steamGap ? t("profile.steamEmptyDesc") : t("profile.emptyDesc");
    return `<div class="row">${emptyState("trophy", title, desc)}</div>`;
  }
  const chips = showStoreChips();
  return cardGames.map((g) => {
    const hasAch = g.total_achievements > 0;
    const isPlat = g.is_platinum || (hasAch && g.unlocked_percent >= 100);
    const pt = S.playtimeMap.get(g.app_name);
    const cover = coverOf(g.app_name, g.cover || "");
    const pct = hasAch ? Math.min(100, Math.max(0, g.unlocked_percent)) : 0;
    const meta = [
      hasAch ? `${g.total_unlocked} / ${g.total_achievements} ${t("profile.trophies")}` : (pt && pt.total_seconds > 0 ? fmtPlaytime(pt.total_seconds) : ""),
      g.total_product_xp > 0 ? `${g.total_xp.toLocaleString()} / ${g.total_product_xp.toLocaleString()} XP` : "",
      hasAch && pt && pt.total_seconds > 0 ? fmtPlaytime(pt.total_seconds) : "",
    ].filter(Boolean).join(" · ") || t("profile.readyToPlay") || "Library";
    const show = S.profileShowHidden && g.sandbox_id
      ? `<button type="button" class="btn ghost small" data-act="unhide-achievement" data-id="${esc(g.sandbox_id)}">${t("profile.hiddenShow")}</button>`
      : "";
    const storeChip = chips
      ? ` <span class="profile-store-chip">${storeCode(gameStore(g.app_name))}</span>`
      : "";
    const pctHtml = hasAch
      ? `<div class="profile-game-pct${isPlat ? " plat" : ""}">${pct}%</div>`
      : pt && pt.total_seconds > 0
        ? `<div class="profile-game-pct tabular-nums" style="font-size:12px;opacity:0.75">${fmtPlaytime(pt.total_seconds)}</div>`
        : "";
    const progressBar = hasAch
      ? `<div class="progress profile-game-progress"><span style="width:${pct}%"></span></div>`
      : "";
    return `
      <div class="row profile-game-row" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button">
        ${cover ? `<img class="profile-game-thumb" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="profile-game-thumb placeholder">${icon("gamepad-2", 16)}</span>`}
        <div class="row-main">
          <div class="row-title">${esc(g.app_title)}${storeChip}${isPlat ? ` <span class="profile-plat" title="${esc(t("profile.platLabel"))}">${epicPlatinumIcon(13)}</span>` : ""}</div>
          <div class="row-meta">${meta}</div>
          ${progressBar}
        </div>
        ${show}
        ${pctHtml}
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

/** Every storefront the profile shows. */
export type StoreKind = "epic" | "gog" | "steam" | "xbox" | "battlenet" | "ubisoft" | "ea" | "riot";

export const ALL_PROFILE_STORES: StoreKind[] = ["epic", "gog", "steam", "xbox", "battlenet", "ubisoft", "ea", "riot"];

/** One selectable account in the profile header. */
export interface ProfileAccount {
  key: string;
  kind: StoreKind;
  id: string;
  name: string;
  active: boolean;
}

export function storeName(kind: StoreKind): string {
  if (kind === "riot") return "Riot Games";
  return STORE_LABELS[kind as keyof typeof STORE_LABELS] || "Riot Games";
}

const STORE_CODES: Record<StoreKind, string> = {
  epic: "EPIC",
  gog: "GOG",
  steam: "STEAM",
  xbox: "XBOX",
  battlenet: "BNET",
  ubisoft: "UBI",
  ea: "EA",
  riot: "RIOT",
};

/** Row chip code. */
export function storeCode(kind: StoreKind): string {
  return STORE_CODES[kind] || "RIOT";
}

export function switchAct(kind: StoreKind): string {
  if (kind === "epic") return "account-switch";
  if (kind === "gog") return "gog-account-switch";
  if (kind === "steam") return "steam-account-switch";
  // Companion stores keep a single account; the Accounts page manages it.
  return "";
}

/** Library key → store. Epic ids have no prefix. */
export function gameStore(appName: string): StoreKind {
  return sourceOfKey(appName) as StoreKind;
}

function steamSignedIn(): boolean {
  return S.steamAuthStep === "signed_in" || S.steamAuth?.state === "signed_in";
}

/** Steam library or client session the overview can actually show. */
function steamConnected(): boolean {
  return steamSignedIn() || S.steamSummaries.length > 0 || (S.steamStatus?.games ?? 0) > 0;
}

/** Whether a store has a signed-in session or linked companion account. */
function isStoreConnected(store: StoreKind): boolean {
  if (store === "epic") return !!S.epicAccount;
  if (store === "gog") return !!S.gogAccount;
  if (store === "steam") return steamConnected();
  return S.companionStatus.some((s) => s.store === store && s.linked);
}

/** Whether a companion store's client is detected on the system or has local games. */
function isStoreInstalled(store: StoreKind): boolean {
  if (store === "epic" || store === "gog") return true;
  if (store === "steam") return steamConnected() || S.steamSummaries.length > 0;
  return S.companionStatus.some((s) => s.store === store && (s.clientInstalled || s.gameCount > 0)) || libraryCount(store) > 0;
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
  for (const c of S.companionSummaries) if (c.installed && push(c.key)) return out;
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
    const hasAch = g.total_achievements > 0;
    const done = g.is_platinum || (hasAch && g.unlocked_percent >= 100);
    if (S.profileFilter === "platinum" && !done) return false;
    if (S.profileFilter === "in_progress" && !(hasAch && g.unlocked_percent > 0 && !done)) return false;
    if (S.profileFilter === "not_started" && !(hasAch && g.unlocked_percent === 0)) return false;
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
    const totalAch = ach?.total_achievements || 0;
    const userUnlocked = ach?.user_unlocked || 0;
    const pct = totalAch > 0 ? Math.round((userUnlocked / totalAch) * 100) : 0;
    games.push({
      sandbox_id: "",
      app_name: item.key,
      app_title: item.title,
      cover: item.coverUrl,
      total_unlocked: userUnlocked,
      total_achievements: totalAch,
      total_xp: ach?.user_xp || 0,
      total_product_xp: ach?.total_xp || 0,
      is_platinum: (ach?.is_platinum || false) || (totalAch > 0 && pct >= 100),
      unlocked_percent: pct,
      last_unlocked_date: null,
    });
  }
  return games;
}

/** Steam achievement rows from the on-disk summary cache (same shape as GOG). */
function buildSteamProfileGames(): ProfileGameRecord[] {
  const games: ProfileGameRecord[] = [];
  for (const item of S.steamSummaries) {
    const ach = achSummaryOf(item.key);
    const totalAch = ach && ach.supported ? (ach.total_achievements || 0) : 0;
    const userUnlocked = ach && ach.supported ? (ach.user_unlocked || 0) : 0;
    const pct = totalAch > 0 ? Math.round((userUnlocked / totalAch) * 100) : 0;
    games.push({
      sandbox_id: "",
      app_name: item.key,
      app_title: item.title,
      cover: item.coverUrl,
      total_unlocked: userUnlocked,
      total_achievements: totalAch,
      total_xp: ach?.user_xp || 0,
      total_product_xp: ach?.total_xp || 0,
      is_platinum: (ach?.is_platinum || false) || (totalAch > 0 && pct >= 100),
      unlocked_percent: pct,
      last_unlocked_date: null,
    });
  }
  return games;
}

/** Stores that currently have a signed-in session or a local library. */
export function overviewStores(): StoreKind[] {
  const linkedCompanion = new Set(
    S.companionStatus.filter((s) => s.linked || s.clientInstalled || s.gameCount > 0).map((s) => s.store)
  );
  const out: StoreKind[] = [];
  for (const id of ALL_PROFILE_STORES) {
    if (id === "epic") {
      if (S.epicAccount || totalEpicGames() > 0) out.push(id);
    } else if (id === "gog") {
      if (S.gogAccount || S.gogSummaries.length > 0) out.push(id);
    } else if (id === "steam") {
      if (steamConnected()) out.push(id);
    } else if (linkedCompanion.has(id) || libraryCount(id) > 0) {
      out.push(id);
    }
  }
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

/** Companion achievement rows from the client's local cache (bulk summary). */
function buildCompanionProfileGames(targetStore?: StoreKind): ProfileGameRecord[] {
  const games: ProfileGameRecord[] = [];
  for (const item of S.companionSummaries) {
    const store = gameStore(item.key);
    if (targetStore && store !== targetStore) continue;
    const ach = achSummaryOf(item.key);
    const totalAch = ach?.total_achievements || 0;
    const userUnlocked = ach?.user_unlocked || 0;
    const pct = totalAch > 0 ? Math.round((userUnlocked / totalAch) * 100) : 0;
    games.push({
      sandbox_id: "",
      app_name: item.key,
      app_title: item.title,
      cover: item.coverUrl,
      total_unlocked: userUnlocked,
      total_achievements: totalAch,
      total_xp: ach?.user_xp || 0,
      total_product_xp: ach?.total_xp || 0,
      is_platinum: (ach?.is_platinum || false) || (totalAch > 0 && pct >= 100),
      unlocked_percent: pct,
      last_unlocked_date: null,
    });
  }
  return games;
}

/**
 * Achievement rows for the current page: one account, or Overview narrowed by
 * the store tab. Search updates call this so GOG, Steam and companion stores stay in the list.
 */
export function profileListGames(targetScope?: "all" | StoreKind): ProfileGameRecord[] {
  const selection = profileSelection();
  if (selection.mode === "account") {
    if (!selection.account.active) return [];
    if (selection.account.kind === "epic") return S.epicAccount ? (S.playerProfileData?.games || []) : [];
    if (selection.account.kind === "gog") return buildGogProfileGames();
    if (selection.account.kind === "steam") return buildSteamProfileGames();
    return buildCompanionProfileGames(selection.account.kind);
  }
  const scope = targetScope || storeScope();
  const games: ProfileGameRecord[] = [];
  if ((scope === "all" || scope === "epic") && S.epicAccount) games.push(...(S.playerProfileData?.games || []));
  if ((scope === "all" || scope === "gog") && (S.gogAccount || S.gogSummaries.length > 0)) games.push(...buildGogProfileGames());
  if (scope === "all" || scope === "steam") games.push(...buildSteamProfileGames());
  if (scope === "all" || (scope !== "epic" && scope !== "gog" && scope !== "steam")) {
    games.push(...buildCompanionProfileGames(scope === "all" ? undefined : scope));
  }
  return games;
}

export function libraryCount(scope: "all" | StoreKind): number {
  if (scope === "epic") return totalEpicGames();
  if (scope === "steam") return totalSteamGames();
  if (scope === "gog") {
    let n = 0;
    for (const g of S.gogSummaries) if (!S.hiddenGames.has(g.key)) n++;
    return n;
  }
  if (scope !== "all") {
    let n = 0;
    for (const g of S.companionSummaries) {
      if (!S.hiddenGames.has(g.key) && gameStore(g.key) === scope) n++;
    }
    return n;
  }
  return totalEpicGames() + totalSteamGames() + libraryCount("gog") + libraryCount("xbox") + libraryCount("battlenet") + libraryCount("ubisoft") + libraryCount("ea") + libraryCount("riot");
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
    ${stores.map((s) => tab(s, STORE_TAB_LABELS[s], libraryCount(s))).join("")}
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
/** Playtime sum for one store or everything. Keys carry their store prefix. */
export function playtimeFor(scope: "all" | StoreKind): number {
  let total = 0;
  for (const [key, rec] of S.playtimeMap) {
    if (scope !== "all" && gameStore(key) !== scope) continue;
    total += rec.total_seconds || 0;
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
 * Compact horizontal layout with avatar, identity text, store icons,
 * 4 prominent tabular stats, and an overall library completion bar.
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
  const storeLogosHtml = combined
    ? `<div class="profile-hero-stores">
        ${ALL_PROFILE_STORES.map((s) => {
          const connected = isStoreConnected(s);
          const installed = isStoreInstalled(s);
          const statusClass = connected ? "connected" : installed ? "installed" : "unlinked";
          const count = libraryCount(s);
          const tooltip = `${storeName(s)}${connected ? " · " + t("accounts.connected") : installed ? " · " + t("accounts.localAccount") : " · " + t("accounts.notConnected")}${count > 0 ? " (" + count + ")" : ""}`;
          const isSelected = scope === s;
          return `
            <button type="button" class="profile-hero-store-chip ${statusClass}${isSelected ? " selected" : ""}" data-act="profile-store" data-val="${s}" title="${esc(tooltip)}">
              ${storeLogo(s, 14)}
              <span class="profile-hero-chip-name">${storeName(s)}</span>
              ${count > 0 ? `<span class="profile-hero-chip-count tabular-nums">${count}</span>` : ""}
            </button>`;
        }).join("")}
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

  const avgCompletion = games.length > 0
    ? Math.round(games.reduce((acc, g) => acc + g.unlocked_percent, 0) / games.length)
    : 0;

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
      <div class="profile-hero-main">
        <div class="profile-hero-left">
          <button class="avatar-edit-btn profile-avatar-btn" data-act="profile-change-avatar" data-key="${esc(avatarKey)}" data-name="${esc(displayName)}" title="${esc(avatarTitle)}" aria-label="${esc(avatarTitle)}">
            <span class="profile-avatar">${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : combined ? icon("gamepad-2", 28) : esc(initial)}</span>
            <span class="avatar-edit-badge" aria-hidden="true">${icon("camera", 12)}</span>
          </button>
          <div class="profile-hero-identity">
            <button type="button" class="profile-name-edit-btn" data-act="profile-change-name" title="${esc(t("profile.changeNameTitle"))}">
              <h1 class="profile-name">${esc(displayName)}</h1>
              <span class="profile-name-edit-icon">${icon("edit", 13)}</span>
            </button>
            ${storeLogosHtml}
          </div>
        </div>
        <div class="profile-hero-right">
          ${statsPod}
          <button class="icon-btn lib-refresh-btn ${S.profileLoading ? "spinning" : ""}" data-act="refresh-profile" title="${overviewStores().length > 1 ? t("profile.refreshTitleMulti") : t("profile.refreshTitle")}">${icon("refresh", 16)}</button>
        </div>
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

interface StoreSummaryStat {
  store: StoreKind;
  name: string;
  games: number;
  playtime: number;
  trophies: number | null;
  status: "connected" | "installed" | "none";
}

function computeStoreSummaries(): StoreSummaryStat[] {
  const result: StoreSummaryStat[] = [];
  for (const s of ALL_PROFILE_STORES) {
    const games = libraryCount(s);
    const playtime = playtimeFor(s);
    let trophies: number | null = null;

    if (s === "epic" && S.epicAccount) {
      trophies = S.playerProfileData?.total_unlocked || 0;
    } else if (s === "steam" && steamConnected()) {
      const steamGames = buildSteamProfileGames();
      if (steamGames.length > 0) {
        trophies = steamGames.reduce((acc, g) => acc + g.total_unlocked, 0);
      }
    } else if (s === "gog" && (S.gogAccount || S.gogSummaries.length > 0)) {
      const gogGames = buildGogProfileGames();
      if (gogGames.length > 0) {
        trophies = gogGames.reduce((acc, g) => acc + g.total_unlocked, 0);
      }
    } else {
      const companionGames = buildCompanionProfileGames(s);
      if (companionGames.length > 0) {
        trophies = companionGames.reduce((acc, g) => acc + g.total_unlocked, 0);
      }
    }

    const connected = isStoreConnected(s);
    const installed = isStoreInstalled(s);

    result.push({
      store: s,
      name: storeName(s),
      games,
      playtime,
      trophies,
      status: connected ? "connected" : installed ? "installed" : "none",
    });
  }
  return result;
}

/**
 * 3. Tab 1: "Overview" (Genel Bakış):
 * Layout:
 * - 1. Platinum Shelf: single compact row of 100% completions.
 * - 2. Two equal columns:
 *      Left: "Closest to platinum" (Top 5 games with counter & progress bar)
 *      Right: "By store" (Full breakdown table: games, hours, trophies, completion)
 * - 3. Recently Played: horizontal landscape cards with playtime and last activity.
 */
function renderOverviewTab(games: ProfileGameRecord[]): string {
  // A. Platinum completions
  const platGames = games.filter((g) => g.is_platinum || g.unlocked_percent >= 100);

  // B. In-Progress Games (0% < progress < 100%), sorted by closest to completion
  const inProgGames = games
    .filter((g) => !g.is_platinum && g.unlocked_percent > 0 && g.unlocked_percent < 100)
    .sort((a, b) => b.unlocked_percent - a.unlocked_percent || b.total_xp - a.total_xp);

  // C. Recently Played (up to 6)
  const recents = recentApps().slice(0, 6);

  // D. Store summaries
  const storeSummaries = computeStoreSummaries();

  // --- 1. Platinum Shelf ---
  const platShelfCards = platGames.slice(0, 10).map((g) => {
    const cover = coverOf(g.app_name, g.cover || "");
    return `
      <div class="profile-plat-card" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button" title="${esc(g.app_title)}">
        ${cover ? `<img class="profile-plat-img" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<div class="profile-plat-placeholder">${icon("gamepad-2", 24)}</div>`}
        <div class="profile-plat-scrim">
          <span class="profile-plat-title">${esc(g.app_title)}</span>
        </div>
        <span class="profile-plat-badge" title="${esc(t("profile.platLabel"))}">
          ${epicPlatinumIcon(13)}
        </span>
      </div>`;
  }).join("");

  const platShelfHtml = `
    <section class="profile-section profile-shelf-section">
      <div class="profile-section-head">
        <div class="profile-section-title-wrap">
          <span class="profile-section-icon plat">${epicPlatinumIcon(16)}</span>
          <h3 class="profile-section-title">${t("profile.filterPlatinum")}</h3>
        </div>
        ${platGames.length > 0 ? `<button type="button" class="btn ghost small" data-act="profile-filter" data-val="platinum" data-tab="achievements">${t("profile.viewAll")} (${platGames.length})</button>` : ""}
      </div>
      ${platGames.length > 0
        ? `<div class="profile-plat-shelf">${platShelfCards}</div>`
        : `<div class="profile-empty-showcase">
            <span class="profile-empty-showcase-ico">${epicPlatinumIcon(22)}</span>
            <div class="profile-empty-showcase-text">
              <h4>${t("profile.showcaseEmpty")}</h4>
              <p>${t("profile.showcaseEmptyDesc")}</p>
            </div>
          </div>`
      }
    </section>`;

  // --- 2. Left Column: Closest to Platinum (Top 6) ---
  const closestGames = inProgGames.slice(0, 6);
  const closestRowsHtml = closestGames.length > 0
    ? closestGames.map((g) => {
        const cover = coverOf(g.app_name, g.cover || "");
        const store = storeCode(gameStore(g.app_name));
        const pct = Math.min(100, Math.max(0, g.unlocked_percent));
        return `
          <div class="profile-closest-row" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button">
            ${cover ? `<img class="profile-closest-thumb" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="profile-closest-thumb placeholder">${icon("gamepad-2", 14)}</span>`}
            <div class="profile-closest-info">
              <div class="profile-closest-title-row">
                <span class="profile-closest-title">${esc(g.app_title)}</span>
                <span class="profile-store-chip">${store}</span>
              </div>
            </div>
            <div class="profile-closest-counter tabular-nums">${g.total_unlocked} / ${g.total_achievements}</div>
            <div class="profile-closest-bar-wrap">
              <div class="progress profile-mini-bar"><span style="width:${pct}%"></span></div>
              <span class="profile-closest-pct tabular-nums">${pct}%</span>
            </div>
          </div>`;
      }).join("")
    : `
      <div class="profile-panel-empty">
        <p class="row-meta">${t("profile.inProgressEmpty")}</p>
      </div>`;

  // --- 3. Right Column: By Store Table ---
  const storeTableRowsHtml = storeSummaries.map((st) => {
    const hasTrophies = st.trophies !== null && st.trophies > 0;
    const trophiesText = st.trophies !== null ? (hasTrophies ? st.trophies.toLocaleString() : "0") : "—";
    const playtimeText = st.playtime > 0 ? fmtPlaytime(st.playtime) : "—";

    return `
      <tr class="profile-store-tr${st.status !== "connected" ? " muted" : ""}" data-act="profile-store" data-val="${st.store}" role="button" tabindex="0" title="${esc(st.name)}">
        <td>
          <div class="profile-store-name-cell">
            <span class="profile-store-dot ${st.status}" aria-hidden="true"></span>
            ${storeLogo(st.store, 15)}
            <span class="profile-store-name-label">${esc(st.name)}</span>
          </div>
        </td>
        <td class="text-right tabular-nums">${st.games}</td>
        <td class="text-right tabular-nums">${playtimeText}</td>
        <td class="text-right tabular-nums">${trophiesText}</td>
      </tr>`;
  }).join("");

  const twoColumnsHtml = `
    <div class="profile-overview-columns">
      <!-- Left: Closest to Platinum -->
      <div class="card profile-panel">
        <div class="profile-panel-head">
          <div class="profile-panel-title-wrap">
            <span class="profile-panel-icon">${icon("timer", 14)}</span>
            <h4 class="profile-panel-title">${t("profile.inProgressTitle")}</h4>
          </div>
          ${inProgGames.length > 6 ? `<button type="button" class="btn ghost small" data-act="profile-filter" data-val="in_progress" data-tab="achievements">${t("profile.viewAll")} (${inProgGames.length})</button>` : inProgGames.length > 0 ? `<span class="profile-count-badge tabular-nums">${inProgGames.length}</span>` : ""}
        </div>
        <div class="profile-closest-list">
          ${closestRowsHtml}
        </div>
      </div>

      <!-- Right: By Store -->
      <div class="card profile-panel">
        <div class="profile-panel-head">
          <div class="profile-panel-title-wrap">
            <span class="profile-panel-icon">${icon("layers", 14)}</span>
            <h4 class="profile-panel-title">${t("profile.storeBreakdown")}</h4>
          </div>
          <button type="button" class="btn ghost small" data-act="profile-tab" data-tab="accounts">${t("common.browse")}</button>
        </div>
        <div class="profile-store-table-wrap">
          <table class="profile-store-table">
            <thead>
              <tr>
                <th>${t("profile.store")}</th>
                <th class="text-right">${t("profile.games")}</th>
                <th class="text-right">${t("profile.played")}</th>
                <th class="text-right">${t("profile.trophies")}</th>
              </tr>
            </thead>
            <tbody>
              ${storeTableRowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  // --- 4. Bottom Section: Recently Played ---
  const recentItems = recents.map((appName) => {
    const title = S.epicSummariesMap.get(appName)?.title || S.allGamesMap.get(appName)?.title || appName;
    const cover = coverOf(appName);
    const pt = S.playtimeMap.get(appName);
    const timeStr = pt && pt.total_seconds > 0 ? fmtPlaytime(pt.total_seconds) : "";
    const lastStr = pt?.last_played_timestamp ? lastUsedLabel(pt.last_played_timestamp) : "";
    const metaStr = [timeStr, lastStr].filter(Boolean).join(" · ");

    return `
      <div class="profile-recent-card" data-act="open-game-from-profile" data-id="${esc(appName)}" tabindex="0" role="button">
        <div class="profile-recent-thumb-wrap">
          ${cover ? `<img class="profile-recent-thumb" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<div class="profile-recent-thumb placeholder">${icon("gamepad-2", 20)}</div>`}
        </div>
        <div class="profile-recent-meta-wrap">
          <div class="profile-recent-title" title="${esc(title)}">${esc(title)}</div>
          <div class="profile-recent-sub">${metaStr || "—"}</div>
        </div>
      </div>`;
  }).join("");

  const recentHtml = recents.length > 0
    ? `
      <section class="profile-section profile-recent-section">
        <div class="profile-section-head">
          <div class="profile-section-title-wrap">
            <span class="profile-section-icon">${icon("clock", 16)}</span>
            <h3 class="profile-section-title">${t("profile.recentGamesTitle")}</h3>
          </div>
          <button type="button" class="btn ghost small" data-view="library">${t("profile.showAll")}</button>
        </div>
        <div class="profile-recent-grid">${recentItems}</div>
      </section>`
    : "";

  return `
    <div class="profile-overview-flow">
      ${platShelfHtml}
      ${twoColumnsHtml}
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
    const hasAch = g.total_achievements > 0;
    const done = g.is_platinum || (hasAch && g.unlocked_percent >= 100);
    if (done) countPlat++;
    else if (hasAch && g.unlocked_percent > 0) countProgress++;
    else if (hasAch) countNotStarted++;
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
 * Store accounts (Epic, GOG) on top, client accounts (Steam, EA, Ubisoft, …)
 * below: everything switchable in one place.
 */
function renderAccountsTab(allAccounts: ProfileAccount[], selection: ProfileSelection): string {
  const accountCard = (a: ProfileAccount): string => {
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
  };

  // Store accounts keep Epic and GOG; Steam is a client like EA or Ubisoft.
  const storeCards = allAccounts.filter((a) => a.kind !== "steam").map(accountCard).join("");
  const steamCards = allAccounts.filter((a) => a.kind === "steam").map(accountCard).join("");

  const COMPANION_CLIENTS: StoreKind[] = ["xbox", "battlenet", "ubisoft", "ea", "riot"];

  const companionCards = COMPANION_CLIENTS
    .map((kind) => {
      const status = S.companionStatus.find((s) => s.store === kind);
      const linked = status?.linked ?? false;
      const client = status?.clientInstalled ?? false;
      const games = status?.gameCount ?? libraryCount(kind);
      const accountName = (linked && status?.accountName) ? status.accountName : storeName(kind);
      const isOnline = linked;
      const isLocal = !linked && (client || games > 0);

      const badgeHtml = isOnline
        ? `<span class="profile-acc-status-pill online"><span class="profile-acc-dot" aria-hidden="true"></span>${t("profile.activeSession")}</span>`
        : isLocal
          ? `<span class="profile-acc-status-pill local"><span class="profile-acc-dot amber" aria-hidden="true"></span>${t("accounts.localAccount")}</span>`
          : `<span class="profile-acc-status-pill offline">${t("accounts.notConnected")}</span>`;

      return `
      <div class="card profile-acc-manage-card${isOnline ? " is-active-session" : ""}">
        <div class="profile-acc-manage-top">
          <div class="profile-acc-manage-user">
            <span class="profile-acc-avatar-lg">${storeLogo(kind, 22)}</span>
            <div class="profile-acc-manage-names">
              <div class="profile-acc-manage-title-row">
                <span class="profile-acc-manage-name">${esc(accountName)}</span>
                ${isOnline ? `<span class="profile-acc-dot" title="${esc(t("accounts.connected"))}" aria-hidden="true"></span>` : ""}
              </div>
              <div class="profile-acc-manage-store-tag">
                ${storeLogo(kind, 14)}
                <span>${storeName(kind)}</span>
              </div>
            </div>
          </div>
          <div class="profile-acc-manage-badge">
            ${badgeHtml}
          </div>
        </div>
        <div class="profile-acc-manage-meta-row">
          <span class="profile-acc-meta-item">
            <span class="profile-acc-meta-val tabular-nums">${games > 0 || isLocal ? games : "—"}</span>
            <span class="profile-acc-meta-lbl">${t("profile.games")}</span>
          </span>
          <span class="profile-acc-meta-sep"></span>
          <span class="profile-acc-meta-item">
            <span class="profile-acc-meta-val">${isOnline ? t("accounts.connected") : isLocal ? t("accounts.localAccount") : t("accounts.notConnected")}</span>
            <span class="profile-acc-meta-lbl">${t("profile.store")}</span>
          </span>
        </div>
        <div class="profile-acc-manage-footer">
          <button type="button" class="btn ghost small" data-view="accounts">${t("accounts.manageAccounts")}</button>
        </div>
      </div>`;
    })
    .join("");

  // Client accounts: Steam profiles and the companion clients in one grid.
  const clientCards = `${steamCards}${companionCards}`;

  const clientSection = clientCards
    ? `<div class="profile-section-subhead">
         <h4 class="profile-section-subtitle">${t("profile.companionAccounts")}</h4>
         <span class="profile-section-desc">${t("profile.companionAccountsDesc")}</span>
       </div>
       <div class="profile-accounts-grid">
         ${clientCards}
       </div>`
    : "";

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

      <div class="profile-section-subhead">
        <h4 class="profile-section-subtitle">${t("profile.storeAccounts")}</h4>
      </div>

      <div class="profile-accounts-grid">
        ${storeCards}
      </div>

      ${clientSection}
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
    ? currentProfileName()
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

  // Hero Gamer Banner stats: in combined mode, ALWAYS show the user's GLOBAL stats!
  let heroGamesCount = libraryCount(scope);
  let heroPlaytimeSeconds = playtimeSeconds;
  let heroUnlocked = unlocked;
  let heroPlatinums = platinums;
  let heroXp = xp;

  if (combined) {
    heroGamesCount = libraryCount("all");
    heroPlaytimeSeconds = playtimeFor("all");
    const allProfileList = profileListGames("all");
    const globalSums = sumStats(allProfileList);
    heroUnlocked = globalSums.unlocked;
    heroPlatinums = globalSums.platinums;
    heroXp = globalSums.xp;
  }

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
    heroUnlocked,
    heroPlatinums,
    heroXp,
    heroPlaytimeSeconds,
    heroGamesCount,
  );

  // Nav tabs. The Accounts tab lists store accounts, Steam accounts, and companion platforms.
  const companionTotal = 5; // xbox, battlenet, ubisoft, ea, riot
  const navTabsHtml = renderProfileNavTabs(games.length, allAccounts.length + companionTotal);

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

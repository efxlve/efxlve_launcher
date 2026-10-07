/**
 * Profile page renderer.
 *
 * Single-page, Xbox-style profile: one identity hero on top, the achievement
 * catalog as the main column, and Recently Played, Connected Accounts and the
 * completion showcase in the side rail. There are no tabs; store scope lives
 * on the hero chips and filters live inside the achievement panel.
 *
 * Statistics are scoped and honest by design: only games with a tracked
 * achievement set count toward trophy, completion and platinum numbers, and
 * every number follows the selected store.
 */

import { PROFILE_CARD_CHUNK } from "../../core/constants";
import { achSummaryOf } from "../../core/game-view";
import { emptyState, epicPlatinumIcon, icon } from "../../core/icons";
import { epicWideArt, rawOf, sourceOfKey, summaryOf } from "../../core/selectors";
import { cachedSteamCover, steamCdnPortrait } from "../../core/steam-art-cache";
import { avatarFor, currentProfileName, globalAvatar, S } from "../../core/state";
import { esc, fmtPlaytime, isOpaqueId } from "../../core/utils";
import { t } from "../../i18n";

import { epicPortrait, type ProfileGameRecord } from "../../epic";
import { storeLogo } from "../store/store-logos";
import { STORE_LABELS } from "../store/store-view";

export function coverOf(appName: string, fallback = ""): string {
  const custom = S.customCovers[appName];
  if (custom) return custom;
  if (appName.startsWith("steam::")) {
    const appId = appName.slice(7);
    if (/^\d+$/.test(appId)) {
      // Steam's flat capsule path is missing for many games. Use the cover the
      // library fallback already resolved, and let the shared art fallback
      // repair the first URL when it 404s (`steamArtAttrs` marks the thumb).
      const cached = cachedSteamCover(appId);
      return cached || steamCdnPortrait(appId);
    }
  }
  const s = S.epicSummariesMap.get(appName);
  const raw = rawOf(appName);
  const gogItem = S.gogSummariesMap.get(appName) || S.allGamesMap.get(appName);
  return (raw ? epicPortrait(raw) : null) || s?.cover || gogItem?.coverUrl || fallback;
}

/** Marks Steam art so the shared fallback can repair a 404 cover. A custom
 *  cover is the user's explicit pick, so it never falls back to the store. */
export function steamArtAttrs(appName: string): string {
  if (S.customCovers[appName]) return "";
  if (!appName.startsWith("steam::")) return "";
  const appId = appName.slice(7);
  if (!/^\d+$/.test(appId)) return "";
  return ` data-steam-app="${appId}" data-art-step="${cachedSteamCover(appId) ? "resolved" : "0"}"`;
}

/** Resets the profile list back to the first chunk (on filter/sort/search change). */
export function resetProfileCards(): void {
  S.profileCardCount = PROFILE_CARD_CHUNK;
}

/** Celebrations already played this session (per surface and game). */
const platShineDone = new Set<string>();

/** Score unit: Xbox counts gamerscore, the rest count XP. */
function xpUnitFor(appName: string): string {
  return gameStore(appName) === "xbox" ? "G" : "XP";
}

/**
 * The game page's platinum celebration (glow, sparks, one-shot shine sweep)
 * for a completed set. Each surface celebrates a game once per session.
 */
function platCelebration(size: number, shineKey: string): string {
  const shine = platShineDone.has(shineKey) ? "" : " shine";
  platShineDone.add(shineKey);
  return `<span class="plat-cup${shine}" aria-hidden="true">${epicPlatinumIcon(size)}<span class="plat-spark s1">${icon("sparkles", Math.max(9, Math.round(size * 0.4)))}</span><span class="plat-spark s2">${icon("sparkles", Math.max(8, Math.round(size * 0.34)))}</span><span class="plat-shine"></span></span>`;
}

/** Stores whose achievements the launcher tracks in bulk. */
const ACHIEVEMENT_STORES: StoreKind[] = ["epic", "gog", "steam", "ubisoft"];

/**
 * Achievement row: cover, title, trophy count, earned XP and a progress bar.
 * Only rows the launcher can actually track reach this list; a total that is
 * unknown hides the bar and the percentage instead of inventing one.
 */
function renderProfileGameCards(cardGames: ProfileGameRecord[]): string {
  if (cardGames.length === 0) {
    const steamGap = !S.profileShowHidden && !S.profileSearchQuery && S.profileFilter === "all"
      && achievementScope() === "steam" && totalSteamGames() > 0 && buildSteamProfileGames().filter(trackedGame).length === 0;
    const companionGap = !S.profileShowHidden && !S.profileSearchQuery && S.profileFilter === "all"
      && achievementScope() !== "all" && !ACHIEVEMENT_STORES.includes(achievementScope() as StoreKind);
    const title = S.profileShowHidden ? t("profile.hiddenEmpty") : companionGap ? t("profile.companionEmptyTitle") : steamGap ? t("profile.steamEmptyTitle") : t("profile.emptyTitle");
    const desc = S.profileShowHidden ? t("profile.hiddenEmptyDesc") : companionGap ? t("profile.companionEmptyDesc") : steamGap ? t("profile.steamEmptyDesc") : t("profile.emptyDesc");
    return `<div class="profile-ach-empty">${emptyState("trophy", title, desc)}</div>`;
  }
  const chips = showStoreChips();
  return cardGames.map((g) => {
    const store = gameStore(g.app_name);
    const isPlat = isCompletedGame(g);
    const pt = S.playtimeMap.get(g.app_name);
    const cover = coverOf(g.app_name, g.cover || "");
    const pct = g.total_achievements > 0 ? Math.min(100, Math.max(0, g.unlocked_percent)) : 0;
    const xpUnit = xpUnitFor(g.app_name);
    const xpText = g.total_xp > 0
      ? g.total_product_xp > g.total_xp
        ? `${g.total_xp.toLocaleString()} / ${g.total_product_xp.toLocaleString()} ${xpUnit}`
        : `${g.total_xp.toLocaleString()} ${xpUnit}`
      : "";
    const trophiesText = g.total_achievements > 0
      ? `${g.total_unlocked} / ${g.total_achievements} ${t("profile.trophies")}`
      : g.total_unlocked > 0
        ? `${g.total_unlocked} ${t("profile.trophies")}`
        : "";
    const meta = [
      trophiesText,
      xpText,
      pt && pt.total_seconds > 0 ? fmtPlaytime(pt.total_seconds) : "",
    ].filter(Boolean).join(" · ");
    const show = S.profileShowHidden && g.sandbox_id
      ? `<button type="button" class="btn ghost small profile-unhide-btn" data-act="unhide-achievement" data-id="${esc(g.sandbox_id)}">${t("profile.hiddenShow")}</button>`
      : "";
    const storeChip = chips
      ? `<span class="profile-store-chip">${storeLogo(store, 12)}<span>${storeCode(store)}</span></span>`
      : "";

    return `
      <div class="profile-ach-card${isPlat ? " is-plat" : ""}" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button" title="${esc(`${g.app_title}${meta ? ` · ${meta}` : ""}`)}">
        <div class="profile-ach-art">
          ${cover ? `<img${steamArtAttrs(g.app_name)} src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="profile-ach-ph">${icon("gamepad-2", 24)}</span>`}
          ${isPlat
            ? `<span class="profile-ach-badge plat" title="${t("profile.filterPlatinum")}">${epicPlatinumIcon(14)}<span>100%</span></span>`
            : pct > 0
              ? `<span class="profile-ach-badge pct">${pct}%</span>`
              : ""
          }
          ${storeChip ? `<span class="profile-ach-badge store">${storeChip}</span>` : ""}
          ${show}
        </div>
        <div class="profile-ach-info">
          <span class="profile-ach-title">${esc(g.app_title)}</span>
          <div class="profile-ach-progress-block">
            <div class="profile-ach-meta-row tabular-nums">
              <span class="profile-ach-count">${icon("trophy", 11)} <span>${g.total_achievements > 0 ? `${g.total_unlocked} / ${g.total_achievements}` : g.total_unlocked > 0 ? `${g.total_unlocked}` : "0"}</span></span>
              ${g.total_achievements > 0 ? `<span class="profile-ach-pct">${pct}%</span>` : ""}
            </div>
            ${g.total_achievements > 0 ? `<div class="profile-ach-bar"><span style="width:${pct}%"></span></div>` : ""}
          </div>
          ${xpText || (pt && pt.total_seconds > 0) ? `
            <div class="profile-ach-sub-meta tabular-nums">
              ${xpText ? `<span class="profile-ach-xp">${esc(xpText)}</span>` : ""}
              ${pt && pt.total_seconds > 0 ? `<span class="profile-ach-playtime">${fmtPlaytime(pt.total_seconds)}</span>` : ""}
            </div>
          ` : ""}
        </div>
      </div>`;
  }).join("");
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
export type StoreKind = "epic" | "gog" | "steam" | "amazon" | "xbox" | "battlenet" | "ubisoft" | "ea" | "riot";

export const ALL_PROFILE_STORES: StoreKind[] = ["epic", "gog", "steam", "amazon", "xbox", "battlenet", "ubisoft", "ea", "riot"];

/** One selectable account in the profile header. */
export interface ProfileAccount {
  key: string;
  kind: StoreKind;
  id: string;
  name: string;
  active: boolean;
}

export function storeName(kind: StoreKind): string {
  if (kind === "amazon") return "Amazon Games";
  if (kind === "riot") return "Riot Games";
  return STORE_LABELS[kind as keyof typeof STORE_LABELS] || "Riot Games";
}

const STORE_CODES: Record<StoreKind, string> = {
  epic: "EPIC",
  gog: "GOG",
  steam: "STEAM",
  amazon: "AMZN",
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
  if (store === "amazon") return Boolean(S.amazonStatus?.logged_in);
  return S.companionStatus.some((s) => s.store === store && s.linked);
}

/** Whether a companion store's client is detected on the system or has local games. */
function isStoreInstalled(store: StoreKind): boolean {
  if (store === "epic" || store === "gog" || store === "amazon") return true;
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
  if (S.amazonStatus?.logged_in) {
    push("amazon", "amazon", S.amazonStatus.username || "", true, "Amazon Games");
  }
  return out;
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

/** Up to nine recently played games for the rail, scoped to one store. */
export function recentApps(scope: "all" | StoreKind): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): boolean => {
    if (out.length >= 9) return true;
    if (seen.has(name) || (scope !== "all" && gameStore(name) !== scope)) return false;
    if (!S.epicSummariesMap.has(name) && !S.allGamesMap.has(name)) return false;
    seen.add(name);
    out.push(name);
    return out.length >= 9;
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

/** A row the launcher can report achievement progress for. */
export function trackedGame(g: ProfileGameRecord): boolean {
  return g.total_achievements > 0 || g.total_unlocked > 0;
}

/** A set with every achievement unlocked, or a real platinum award. */
function isCompletedGame(g: ProfileGameRecord): boolean {
  return g.is_platinum || (g.total_achievements > 0 && g.unlocked_percent >= 100);
}

/** At least one unlocked achievement, even when the catalog total is unknown. */
function hasGameProgress(g: ProfileGameRecord): boolean {
  return g.total_achievements > 0 ? g.unlocked_percent > 0 : g.total_unlocked > 0;
}

/** Applies the profile filter tab, search box, sort order, and hidden rows. */
export function filteredProfileGames(allGames: ProfileGameRecord[]): ProfileGameRecord[] {
  const q = S.profileSearchQuery.trim().toLowerCase();
  const list = allGames.filter((g) => {
    if (isOpaqueId(g.app_title) || S.hiddenGames.has(g.app_name)) return false;
    const hiddenRow = userHidAchievement(g);
    if (S.profileShowHidden) {
      if (!hiddenRow) return false;
    } else {
      if (hiddenRow) return false;
      // Games without a tracked achievement set are not achievement rows; they
      // stay on the Recently Played rail instead of showing a fake 0%.
      if (!trackedGame(g)) return false;
    }
    if (S.profileFilter === "platinum" && !isCompletedGame(g)) return false;
    if (S.profileFilter === "in_progress" && !(hasGameProgress(g) && !isCompletedGame(g))) return false;
    if (S.profileFilter === "not_started" && !(!isCompletedGame(g) && !hasGameProgress(g))) return false;
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
      sandbox_id: item.key,
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
      sandbox_id: item.key,
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
    } else if (id === "amazon") {
      if (S.amazonStatus?.logged_in || S.amazonSummaries.length > 0) out.push(id);
    } else if (linkedCompanion.has(id) || libraryCount(id) > 0) {
      out.push(id);
    }
  }
  return out;
}

/** Store filter selected in the hero chips. Account pages ignore it. */
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

/** Store marks on rows only when the list is mixing more than one store. */
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
      sandbox_id: item.key,
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
 * Achievement rows for the current page: one account, or the combined profile
 * narrowed by the hero store chips.
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
  if ((scope === "all" || scope === "steam") && S.steamSummaries.length > 0) games.push(...buildSteamProfileGames());
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
  if (scope === "amazon") {
    let n = 0;
    for (const g of S.amazonSummaries) if (!S.hiddenGames.has(g.key)) n++;
    return n;
  }
  if (scope !== "all") {
    let n = 0;
    for (const g of S.companionSummaries) {
      if (!S.hiddenGames.has(g.key) && gameStore(g.key) === scope) n++;
    }
    return n;
  }
  return totalEpicGames() + totalSteamGames() + libraryCount("gog") + libraryCount("amazon") + libraryCount("xbox") + libraryCount("battlenet") + libraryCount("ubisoft") + libraryCount("ea") + libraryCount("riot");
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

/**
 * Scoped totals for the hero. One completion count drives the platinum stat,
 * the achievements filter and the showcase, so the whole page agrees.
 */
interface ProfileTotals {
  unlocked: number;
  completed: number;
  xp: number;
}

function profileStats(games: ProfileGameRecord[]): ProfileTotals {
  let unlocked = 0, completed = 0, xp = 0;
  for (const g of games) {
    unlocked += g.total_unlocked;
    xp += g.total_xp;
    if (isCompletedGame(g)) completed++;
  }
  return { unlocked, completed, xp };
}

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
  if (account.kind === "gog") {
    const saved = (S.gogSavedAccounts || []).find((a) => a.user_id === account.id);
    return {
      games: typeof saved?.game_count === "number" ? saved.game_count : null,
      lastUsed: lastUsedLabel(saved?.last_used || 0),
    };
  }
  // Amazon and the companion stores keep no archive row here.
  return { games: null, lastUsed: "" };
}

interface ProfileStat {
  value: string;
  label: string;
  icon?: "plat";
}

function renderStat(stat: ProfileStat): string {
  const ico = stat.icon === "plat" ? `<span class="profile-stat-plat-ico">${epicPlatinumIcon(18)}</span>` : "";
  return `<div class="profile-stat"><span class="profile-stat-val tabular-nums">${ico}${stat.value}</span><span class="profile-stat-label">${esc(stat.label)}</span></div>`;
}

/** Store chips under the identity: status marks and the scope filter. */
function renderHeroStoreChips(scope: "all" | StoreKind): string {
  const stores = overviewStores();
  if (stores.length === 0) return "";
  const chip = (val: string, label: string, count: number, connected: boolean, installed: boolean): string => {
    const statusClass = connected ? "connected" : installed ? "installed" : "unlinked";
    const selected = scope === val;
    const tooltip = `${label}${connected ? " · " + t("accounts.connected") : installed ? " · " + t("accounts.localAccount") : " · " + t("accounts.notConnected")}${count > 0 ? ` (${count})` : ""}`;
    return `
      <button type="button" class="profile-hero-store-chip ${statusClass}${selected ? " selected" : ""}" data-act="profile-store" data-val="${val}" title="${esc(tooltip)}">
        ${val === "all" ? icon("layers", 13) : storeLogo(val, 14)}
        ${selected ? `<span class="profile-hero-chip-name">${esc(label)}</span>` : ""}
        ${count > 0 ? `<span class="profile-hero-chip-count tabular-nums">${count}</span>` : ""}
      </button>`;
  };
  const all = stores.length > 1 ? chip("all", t("profile.storeAll"), libraryCount("all"), true, true) : "";
  return `<div class="profile-hero-stores">
    ${all}
    ${stores.map((s) => chip(s, storeName(s), libraryCount(s), isStoreConnected(s), isStoreInstalled(s))).join("")}
  </div>`;
}

/** Wide art for the profile banner: custom pick for this scope, else recent game's hero. */
export function profileBannerArt(scope: "all" | StoreKind, account?: ProfileAccount | null): string {
  const scopeKey = account ? account.key : scope;
  const customPick = S.customProfileBanners?.[scopeKey];
  if (customPick) {
    const custom = S.customHeroes[customPick];
    if (custom) return custom;
    const s = summaryOf(customPick);
    const art = s ? epicWideArt(s) : null;
    if (art) return art;
    const cov = coverOf(customPick);
    if (cov) return cov;
  }
  for (const appName of recentApps(scope)) {
    const custom = S.customHeroes[appName];
    if (custom) return custom;
    const s = summaryOf(appName);
    const art = s ? epicWideArt(s) : null;
    if (art) return art;
  }
  return "";
}

/** Xbox-style identity hero: banner, avatar, name, presence, scope chips and stats. */
function renderProfileHero(
  displayName: string,
  avatarKey: string,
  customAvatar: string | null,
  initial: string,
  scope: "all" | StoreKind,
  stats: ProfileStat[],
  showData: boolean,
  combined: boolean,
  account: ProfileAccount | null,
): string {
  const avatarTitle = customAvatar ? t("profile.changeAvatarTitle") : t("profile.uploadAvatarTitle");
  const isOnline = combined ? overviewStores().length > 0 : Boolean(account?.active);
  const scopeKey = account ? account.key : scope;
  const scopeLabel = combined ? (scope === "all" ? t("profile.storeAll") : storeName(scope)) : storeName(account!.kind);

  const storesHtml = combined
    ? renderHeroStoreChips(scope)
    : account
      ? `<div class="profile-hero-stores"><span class="profile-hero-store-pill"><span class="profile-acc-dot ${account.active ? "" : "offline"}" aria-hidden="true"></span>${esc(storeName(account.kind))}</span></div>`
      : "";

  const statsHtml = showData
    ? `<div class="profile-stats-bar"><div class="profile-stats">${stats.map(renderStat).join("")}</div></div>`
    : `<div class="profile-inactive">
        <p class="row-meta">${t("profile.inactiveDesc")}</p>
        <button class="btn primary small" ${combined ? `data-view="accounts"` : `data-act="${switchAct(account!.kind)}" data-id="${esc(account!.id)}"`}>
          ${combined ? t("accounts.manageAccounts") : t("settings.accountSwitchBtn")}
        </button>
      </div>`;

  const banner = showData ? profileBannerArt(scope, account) : "";

  return `
    <section class="card profile-hero">
      <div class="profile-hero-banner${banner ? "" : " is-plain"}"${banner ? ` style="background-image:url('${esc(banner)}')"` : ""}>
        ${showData ? `
          <button type="button" class="profile-banner-edit-btn" data-act="profile-change-banner" data-scope="${esc(scopeKey)}" data-label="${esc(scopeLabel)}" title="${esc(t("profile.changeBannerTitle"))}">
            ${icon("image", 13)}<span>${esc(t("profile.changeBanner"))}</span>
          </button>
        ` : ""}
      </div>
      <div class="profile-hero-top">
        <button class="avatar-edit-btn profile-avatar-btn" data-act="profile-change-avatar" data-key="${esc(avatarKey)}" data-name="${esc(displayName)}" title="${esc(avatarTitle)}" aria-label="${esc(avatarTitle)}">
          <span class="profile-avatar profile-avatar-lg${isOnline ? " is-online" : ""}">${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : combined ? icon("gamepad-2", 34) : esc(initial)}</span>
          <span class="avatar-edit-badge" aria-hidden="true">${icon("camera", 12)}</span>
        </button>
        <div class="profile-hero-identity">
          <div class="profile-name-row">
            <button type="button" class="profile-name-edit-btn" data-act="profile-change-name" title="${esc(t("profile.changeNameTitle"))}">
              <h1 class="profile-name">${esc(displayName)}</h1>
              <span class="profile-name-edit-icon">${icon("edit", 13)}</span>
            </button>
            <div class="profile-presence">
              <span class="profile-presence-dot ${isOnline ? "online" : "offline"}" aria-hidden="true"></span>
              <span class="profile-presence-text">${isOnline ? t("nav.online") : t("profile.offlineMode")}</span>
            </div>
          </div>
          ${storesHtml}
        </div>
        <div class="profile-hero-actions">
          ${!combined
            ? `<button type="button" class="btn ghost small" data-act="profile-account" data-key="overview">${icon("arrow-left", 13)}<span>${t("profile.backToOverview")}</span></button>`
            : ""}
          <button type="button" class="btn ghost small" data-view="accounts">${icon("settings", 13)}<span>${t("accounts.manageAccounts")}</span></button>
          <button class="icon-btn lib-refresh-btn ${S.profileLoading ? "spinning" : ""}" data-act="refresh-profile" title="${overviewStores().length > 1 ? t("profile.refreshTitleMulti") : t("profile.refreshTitle")}">${icon("refresh", 16)}</button>
        </div>
      </div>
      ${statsHtml}
    </section>`;
}

/** Main column: the achievement catalog. Only tracked sets reach this list. */
function renderAchievementsPanel(games: ProfileGameRecord[], filtered: ProfileGameRecord[]): string {
  let countPlat = 0, countProgress = 0, countNotStarted = 0, countVisible = 0, countHidden = 0;
  for (const g of games) {
    if (isOpaqueId(g.app_title) || S.hiddenGames.has(g.app_name)) continue;
    if (userHidAchievement(g)) {
      countHidden++;
      continue;
    }
    countVisible++;
    const done = isCompletedGame(g);
    if (done) countPlat++;
    else if (hasGameProgress(g)) countProgress++;
    else countNotStarted++;
  }

  const filterTab = (val: string, label: string, n: number): string =>
    `<button type="button" class="tab ${!S.profileShowHidden && S.profileFilter === val ? "active" : ""}" data-act="profile-filter" data-val="${val}">${label}<span class="count">${n}</span></button>`;

  const sub = `${countVisible.toLocaleString()} ${t("profile.games")} · ${profileStats(games).unlocked.toLocaleString()} ${t("profile.trophies")}`;

  return `
    <section class="card profile-panel profile-ach-panel">
      <div class="profile-panel-head">
        <div class="profile-panel-title-wrap">
          <span class="profile-panel-icon">${icon("trophy", 15)}</span>
          <div>
            <h3 class="profile-panel-title">${t("profile.tabAchievements")}</h3>
            <div class="profile-panel-sub tabular-nums">${sub}</div>
          </div>
        </div>
        <button type="button" class="icon-btn" data-act="open-hide-achievements" title="${esc(t("profile.hideAchTip"))}" aria-label="${esc(t("profile.hideAchTip"))}">${icon("eye-off", 16)}</button>
      </div>
      <div class="gp-toolbar profile-ach-toolbar">
        <div class="tabs profile-filter-tabs">
          ${filterTab("all", t("profile.filterAll"), countVisible)}
          ${filterTab("platinum", t("profile.filterPlatinum"), countPlat)}
          ${filterTab("in_progress", t("profile.filterInProgress"), countProgress)}
          ${filterTab("not_started", t("profile.filterNotStarted"), countNotStarted)}
          ${countHidden > 0 ? `<button type="button" class="tab ${S.profileShowHidden ? "active" : ""}" data-act="profile-toggle-hidden">${t("profile.hiddenToggle")}<span class="count">${countHidden}</span></button>` : ""}
        </div>
        <div class="gp-toolbar-right">
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
      <div id="profile-games-grid" class="profile-ach-list">${renderProfileGrid(filtered)}</div>
    </section>`;
}

/** Xbox-style horizontal strip of recently played covers. */
function renderRecentRow(scope: "all" | StoreKind): string {
  const recents = recentApps(scope).slice(0, 10);
  if (recents.length === 0) return "";
  const cards = recents.map((appName) => {
    const title = summaryOf(appName)?.title || appName;
    const cover = coverOf(appName);
    return `
      <button type="button" class="profile-recent-card" data-act="open-game-from-profile" data-id="${esc(appName)}" title="${esc(title)}">
        <span class="profile-recent-thumb-wrap">
          ${cover ? `<img class="profile-recent-thumb"${steamArtAttrs(appName)} src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="profile-recent-thumb placeholder">${icon("gamepad-2", 20)}</span>`}
        </span>
        <span class="profile-recent-name">${esc(title)}</span>
      </button>`;
  }).join("");
  return `
    <section class="profile-row">
      <div class="profile-row-head">
        <h3 class="profile-row-title">${t("profile.recentGamesTitle")}</h3>
        <button type="button" class="btn ghost small" data-view="library">${t("profile.showAll")}</button>
      </div>
      <div class="profile-recent-row">${cards}</div>
    </section>`;
}

/** Dormant account panel: calm grouped list when an inactive account is selected. */
function renderDormantView(account: ProfileAccount, displayName: string, avatarKey: string, customAvatar: string | null, initial: string): string {
  const archive = accountArchiveInfo(account);
  const dormantSwitch = switchAct(account.kind);
  const avatarTitleDormant = customAvatar ? t("profile.changeAvatarTitle") : t("profile.uploadAvatarTitle");

  return `
    <div class="page profile-page">
      <section class="card profile-hero">
        <div class="profile-hero-top">
          <button class="avatar-edit-btn profile-avatar-btn" data-act="profile-change-avatar" data-key="${esc(avatarKey)}" data-name="${esc(displayName)}" title="${esc(avatarTitleDormant)}" aria-label="${esc(avatarTitleDormant)}">
            <span class="profile-avatar profile-avatar-lg">${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : esc(initial)}</span>
            <span class="avatar-edit-badge" aria-hidden="true">${icon("camera", 12)}</span>
          </button>
          <div class="profile-hero-identity">
            <h1 class="profile-name">${esc(displayName)}</h1>
            <div class="profile-presence">
              <span class="profile-presence-dot offline" aria-hidden="true"></span>
              <span class="profile-presence-text">${esc(t("profile.inactiveTitle"))}</span>
            </div>
            <div class="profile-hero-stores">
              <span class="profile-hero-store-pill">${storeName(account.kind)}</span>
            </div>
          </div>
          <div class="profile-hero-actions">
            <button type="button" class="btn ghost small" data-act="profile-account" data-key="overview">${icon("arrow-left", 13)}<span>${t("profile.backToOverview")}</span></button>
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
  const hasAnyData = S.playerProfileData || S.gogSummaries.length > 0 || steamConnected() || S.companionSummaries.length > 0;
  if (S.profileLoading && !hasAnyData) {
    return `<div class="page">${`<div class="empty-state"><span class="spinner"></span><h3>${t("profile.loadingTitle")}</h3><p>${t("profile.loadingDesc")}</p></div>`}</div>`;
  }
  if (S.profileError && !hasAnyData) {
    return `<div class="page">${emptyState("info", t("profile.errorTitle"), esc(S.profileError), `<button class="btn primary" data-act="refresh-profile">${t("profile.retry")}</button>`)}</div>`;
  }

  const selection = profileSelection();
  const combined = selection.mode === "combined";
  const account = combined ? null : selection.account;
  const scope = achievementScope();
  const showData = combined ? overviewStores().length > 0 : Boolean(account?.active);

  const displayName = combined
    ? currentProfileName()
    : account!.name || t("profile.player");
  const avatarKey = combined ? "global" : account!.key;
  const customAvatar = combined ? globalAvatar() : accountAvatar(account!);
  const initial = displayName.trim().charAt(0).toUpperCase() || "E";

  // If selecting an inactive account, show the calm dormant panel.
  if (!showData && !combined) {
    return renderDormantView(account!, displayName, avatarKey, customAvatar, initial);
  }

  const allGames = showData ? profileListGames(scope) : [];
  const games = allGames.filter(trackedGame);
  const filtered = filteredProfileGames(allGames);

  const totals = profileStats(games);
  const playtimeSeconds = showData ? playtimeFor(scope) : 0;

  const stats: ProfileStat[] = [];
  if (showData) {
    stats.push({ value: libraryCount(scope).toLocaleString(), label: t("profile.games") });
    stats.push({ value: playtimeSeconds > 0 ? fmtPlaytime(playtimeSeconds) : "—", label: t("profile.played") });
    stats.push({ value: totals.unlocked.toLocaleString(), label: t("profile.trophies") });
    // The same completion count the Platinum filter and the showcase use.
    stats.push({ value: totals.completed.toLocaleString(), label: t("profile.platLabel"), icon: "plat" });
    // XP is Epic-only currency and only shown when the scope is Epic itself.
    if (scope === "epic" && S.playerProfileData) {
      stats.push({ value: S.playerProfileData.total_xp.toLocaleString(), label: "XP" });
    }
    // Xbox reports gamerscore, the same number the console profile shows.
    if (scope === "xbox") {
      stats.push({ value: totals.xp.toLocaleString(), label: "G" });
    }
  }

  const heroHtml = renderProfileHero(
    displayName,
    avatarKey,
    customAvatar,
    initial,
    scope,
    stats,
    showData,
    combined,
    account,
  );

  return `
    <div class="page profile-page">
      ${heroHtml}
      ${showData ? renderRecentRow(scope) : ""}
      ${renderAchievementsPanel(games, filtered)}
    </div>`;
}

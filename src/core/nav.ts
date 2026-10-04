/**
 * Sidebar shell helpers: active item, download counter, account chip, the
 * installed-games list and back/forward history.
 *
 * These are shared by several features (downloads, collections, library) and by
 * `main.ts`, so they live in `core`.
 */

import { CircleUserRound, createIcons } from "lucide";
import { dlBadge, syncSidebarGameActive } from "./dom";
import { closeAllModals, openEpicModal, registerNavHistoryPush, render } from "./render";
import { rawOf, totalLibraryGamesCount } from "./selectors";
import { currentProfileName, globalAvatar, S } from "./state";
import type { EpicFilter, View } from "./types";
import { esc } from "./utils";
import { icon } from "./icons";
import { t } from "../i18n";
import { epicPortrait } from "../epic";
import { openStoreUrl, setView, syncStoreTabsPill } from "../features/store/store-view";

/** Highlight the sidebar entry that matches the current view (or open game). */
export function updateSidebarActive(): void {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  const gameOpen = Boolean(S.currentModalAppName);
  sidebar.querySelectorAll<HTMLElement>("[data-view], [data-act='open-store']").forEach((el) => {
    const section = S.view === "store" ? el.dataset.act === "open-store" : el.dataset.view === S.view;
    el.classList.toggle("active", section && !gameOpen);
  });
  syncSidebarGameActive();
}

/** Installed games that have a newer build waiting and have not been ignored. */
function pendingUpdateCount(): number {
  let n = 0;
  for (const s of S.epicSummaries) {
    if (S.hiddenGames.has(s.appName) || S.ignoredUpdates.has(s.appName)) continue;
    if (s.installed && (s.updateAvailable || S.availableUpdates.has(s.appName))) n++;
  }
  for (const g of S.gogSummaries) {
    if (S.hiddenGames.has(g.key) || S.ignoredUpdates.has(g.key)) continue;
    if (g.installed && g.updateAvailable) n++;
  }
  for (const g of S.steamSummaries) {
    if (S.hiddenGames.has(g.key) || S.ignoredUpdates.has(g.key)) continue;
    if (g.installed && g.updateAvailable && !g.downloading) n++;
  }
  return n;
}

/** Game count sits in the page header, and only on the library itself. */
function syncPageGameCount(): void {
  const el = document.getElementById("lib-heading-count");
  if (!el) return;
  const visible = S.view === "library" && S.libraryVisibleCount >= 0 ? S.libraryVisibleCount : totalLibraryGamesCount();
  const show = S.view === "library" && !S.currentModalAppName && visible > 0;
  const label = t("lib.gameCount", { count: visible });
  if (el.textContent !== label) el.textContent = label;
  el.hidden = !show;
}

/** Last pending-update total. Download progress must not rescan the library to recompute it. */
let lastPendingUpdates = -1;

/**
 * Refresh the download counter next to the Downloads sidebar entry.
 * `progress` skips the library scan: byte updates do not change which games
 * are installed or which updates are waiting.
 */
export function updateBadge(scope: "full" | "progress" = "full"): void {
  let active = 0;
  for (const d of S.downloads.values()) if (!d.done) active++;
  let steamDl = 0;
  for (const g of S.steamGames) if (g.downloading) steamDl++;
  if (scope === "full" || lastPendingUpdates < 0) lastPendingUpdates = pendingUpdateCount();
  const count = active + S.dlQueueStatus.queue.length + lastPendingUpdates + steamDl;
  const label = count > 0 ? String(count) : "";
  if (dlBadge.textContent !== label) dlBadge.textContent = label;
  dlBadge.classList.toggle("hidden", count === 0);
  if (count > 0) dlBadge.title = label;
  else dlBadge.removeAttribute("title");
  if (scope === "full") updateSidebarGames();
}

/** Page header: window version, back button state and a title for the current view or open game page. */
export function updatePageHeader(): void {
  const winbarVer = document.getElementById("winbar-version-num");
  if (winbarVer && S.appVersion && winbarVer.textContent !== `v${S.appVersion}`) {
    winbarVer.textContent = `v${S.appVersion}`;
  }
  const title = document.getElementById("page-title");
  if (title) {
    const game = S.currentModalAppName ? S.epicSummariesMap.get(S.currentModalAppName)?.title : null;
    const titles: Partial<Record<View, string>> = {
      library: t("nav.library"),
      store: t("nav.store"),
      downloads: t("nav.downloads"),
      settings: t("nav.settings"),
      profile: t("palette.cmdProfile"),
      accounts: t("accounts.title"),
    };
    const next = game ?? titles[S.view] ?? "";
    if (title.textContent !== next) title.textContent = next;
  }
  syncPageGameCount();
  const switcher = document.getElementById("store-switcher");
  if (switcher) {
    const bar = document.getElementById("store-tabs-bar");
    const showTabs = S.view === "store";
    const wasHidden = bar ? bar.hidden : true;
    if (bar) bar.hidden = !showTabs;
    if (showTabs) {
      switcher.querySelectorAll<HTMLElement>("[data-store]").forEach((btn) => {
        const active = (btn.dataset.store || "epic") === (S.activeStore || "epic");
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-current", active ? "page" : "false");
      });
      // The strip is display:none until now, so a measure taken while it was
      // hidden saw a zero box and the pill either stayed invisible or glided
      // in from the corner. Measure after layout.
      if (wasHidden) requestAnimationFrame(() => syncStoreTabsPill());
    }
  }
  const back = document.getElementById("nav-back-btn") as HTMLButtonElement | null;
  if (back) back.disabled = !S.currentModalAppName && !canNavBack();
}

/**
 * Kept so a window resize while the store is open does not throw. The header
 * switcher is a segmented control now, so there is no sliding underline to move.
 */
export function syncStoreTabsUnderline(): void {}

let sidebarGamesSig = "";
/** Installed ids + recent list + language + open game. Unchanged during download progress. */
let sidebarInputs = "";

function sidebarInputStamp(): string {
  let stamp = `${S.appLanguage}\0${S.currentModalAppName ?? ""}\0`;
  for (let i = 0; i < S.epicRecent.length; i++) stamp += `${S.epicRecent[i]}\n`;
  stamp += "\0";
  for (const s of S.epicSummaries) {
    if (s.installed && !S.hiddenGames.has(s.appName)) stamp += `${s.appName}\n`;
  }
  return stamp;
}

const SIDEBAR_RECENT_LIMIT = 5;
const sidebarFillRank = new Map<string, number>();

function fillRank(id: string): number {
  let rank = sidebarFillRank.get(id);
  if (rank === undefined) {
    rank = Math.random();
    sidebarFillRank.set(id, rank);
  }
  return rank;
}

/**
 * Up to five sidebar games: recently played first, then random installed
 * titles so the list stays full. Rebuilt only when membership or a status
 * marker changes.
 */
export function updateSidebarGames(): void {
  const host = document.getElementById("sb-games");
  if (!host) return;
  const stamp = sidebarInputStamp();
  if (stamp === sidebarInputs) return;
  const recentIdx = new Map<string, number>();
  S.epicRecent.forEach((id, i) => recentIdx.set(id, i));
  const installed = S.epicSummaries.filter((s) => s.installed && !S.hiddenGames.has(s.appName));
  const played = installed
    .filter((s) => recentIdx.has(s.appName))
    .sort((a, b) => (recentIdx.get(a.appName) ?? 0) - (recentIdx.get(b.appName) ?? 0));
  const fillers = installed
    .filter((s) => !recentIdx.has(s.appName))
    .sort((a, b) => fillRank(a.appName) - fillRank(b.appName));
  if (sidebarFillRank.size > installed.length + 32) {
    const keep = new Set(installed.map((s) => s.appName));
    for (const id of sidebarFillRank.keys()) {
      if (!keep.has(id)) sidebarFillRank.delete(id);
    }
  }
  const shown = played.concat(fillers).slice(0, SIDEBAR_RECENT_LIMIT);

  const sig = shown.map((s) => s.appName).join("|") + `|${S.appLanguage}|${S.currentModalAppName ?? ""}`;
  sidebarInputs = stamp;
  if (sig === sidebarGamesSig) return;
  sidebarGamesSig = sig;

  if (shown.length === 0) {
    host.innerHTML = "";
    return;
  }
  const rows = shown
    .map((s) => {
      const raw = rawOf(s.appName);
      const cover = S.customCovers[s.appName] || (raw ? epicPortrait(raw) : null) || s.cover;
      const thumb = cover
        ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async" />`
        : `<span class="sb-game-ph">${esc((s.title[0] || "?").toUpperCase())}</span>`;
      return `<button class="sb-game ${s.appName === S.currentModalAppName ? "active" : ""}" data-act="epic-detail" data-id="${esc(s.appName)}" title="${esc(s.title)}">${thumb}<span class="sb-game-title">${esc(s.title)}</span></button>`;
    })
    .join("");
  host.innerHTML = `<div class="sb-games-label">${t("sidebar.recent")}</div>${rows}`;
}

/** Reflect the offline-mode state on the top-bar network chip. */
export function updateOfflineModeUi(): void {
  const btn = document.getElementById("btn-offline-mode");
  if (!btn) return;
  btn.classList.toggle("offline", S.offlineMode);
  btn.classList.toggle("online", !S.offlineMode);
  const label = btn.querySelector<HTMLElement>(".net-label");
  if (label) label.textContent = S.offlineMode ? t("nav.offline") : t("nav.online");
  btn.title = S.offlineMode ? t("nav.offlineTip") : t("nav.onlineTip");
}

/**
 * The library and profile refresh buttons carry `spinning` while their sync
 * runs. The library's in-place grid patch skips the header markup, so a flag
 * that flips false during a patch used to leave the icon rotating forever
 * (one stuck spinner pegs a CPU core and the GPU). Re-apply the class from
 * state on every render, patch or full.
 */
function syncRefreshSpinners(): void {
  document.querySelectorAll<HTMLElement>(".lib-refresh-btn").forEach((btn) => {
    const spinning =
      btn.dataset.act === "refresh-profile" ? S.profileLoading : S.epicSyncing || S.gogSyncing;
    btn.classList.toggle("spinning", spinning);
  });
}

/** Refresh the account chip, the active sidebar item and the installed-games list. */
export function updateChrome(): void {
  updateSidebarActive();
  updateSidebarGames();
  updatePageHeader();
  syncRefreshSpinners();
  const acc = document.getElementById("account");
  if (acc) {
    acc.dataset.view = "profile";
    acc.classList.toggle("active", S.view === "profile");
    const name = currentProfileName();
    // The chip carries the profile's photo and name
    const combinedAvatar = globalAvatar();
    const avatarToken = combinedAvatar ? `${combinedAvatar.length}:${combinedAvatar.slice(0, 32)}` : "none";
    const acctState = `${name}:${avatarToken}`;

    if (acc.dataset.acctState !== acctState) {
      acc.dataset.acctState = acctState;
      acc.innerHTML =
        (combinedAvatar
          ? `<span class="account-avatar custom"><img class="avatar-img" src="${esc(combinedAvatar)}" alt="" /></span>`
          : `<span class="account-avatar">${icon("gamepad-2", 15)}</span>`) +
        `<span class="account-name">${esc(name)}</span>`;
    }
    acc.classList.add("logged");
    acc.title = name;
  }
}

/* ------------------------------------------------------------------ */
/* Navigation History Stack (Back / Forward)                          */
/* ------------------------------------------------------------------ */

export interface NavHistoryItem {
  view: View;
  appName?: string | null;
  collectionId?: string | null;
  filter?: EpicFilter;
}

let navHistory: NavHistoryItem[] = [{ view: "library" }];
let navHistoryIdx = 0;
let isNavigatingHistory = false;

/** True if the user can navigate back in the launcher history. */
export function canNavBack(): boolean {
  return navHistoryIdx > 0;
}

/** True if the user can navigate forward in the launcher history. */
export function canNavForward(): boolean {
  return navHistoryIdx < navHistory.length - 1;
}

/** Push a new state into the navigation history. */
export function pushNavHistory(item: NavHistoryItem): void {
  if (isNavigatingHistory) return;
  const current = navHistory[navHistoryIdx];
  if (
    current &&
    current.view === item.view &&
    (current.appName || null) === (item.appName || null) &&
    (current.collectionId ?? null) === (item.collectionId ?? null) &&
    (current.filter ?? null) === (item.filter ?? null)
  ) {
    return;
  }
  // Discard future history
  navHistory = navHistory.slice(0, navHistoryIdx + 1);
  navHistory.push({
    view: item.view,
    appName: item.appName || null,
    collectionId: item.collectionId ?? null,
    filter: item.filter,
  });
  navHistoryIdx = navHistory.length - 1;
  updateNavHistoryUi();
}

registerNavHistoryPush(pushNavHistory);

/** Step back one entry in the navigation history. */
export function navGoBack(): void {
  if (!canNavBack()) return;
  navHistoryIdx--;
  applyNavHistory(navHistory[navHistoryIdx]);
}

/** Step forward one entry in the navigation history. */
export function navGoForward(): void {
  if (!canNavForward()) return;
  navHistoryIdx++;
  applyNavHistory(navHistory[navHistoryIdx]);
}

function applyNavHistory(item: NavHistoryItem): void {
  isNavigatingHistory = true;
  try {
    if (item.appName) {
      if (item.view !== S.view) {
        setView(item.view);
      }
      openEpicModal(item.appName, false);
    } else {
      closeAllModals();
      if (item.view === "store") {
        void openStoreUrl(S.lastStoreUrl, S.storeMode);
      } else {
        if (item.collectionId !== undefined) {
          S.activeCollectionId = item.collectionId;
        }
        if (item.filter !== undefined) {
          S.epicFilter = item.filter;
        }
        setView(item.view);
        render();
      }
    }
  } finally {
    isNavigatingHistory = false;
    updateNavHistoryUi();
  }
}

/** Refresh the disabled state of the header back button. */
export function updateNavHistoryUi(): void {
  const backBtn = document.getElementById("nav-back-btn") as HTMLButtonElement | null;
  if (backBtn) {
    // The back arrow also closes an open game page (Hydra behavior).
    const hasBack = Boolean(S.currentModalAppName) || canNavBack();
    backBtn.disabled = !hasBack;
    backBtn.setAttribute("aria-disabled", String(!hasBack));
  }
}


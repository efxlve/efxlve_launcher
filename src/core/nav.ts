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
import { rawOf } from "./selectors";
import { getCustomAvatar, S } from "./state";
import type { EpicFilter, View } from "./types";
import { esc } from "./utils";
import { t } from "../i18n";
import { epicPortrait } from "../epic";
import { openStoreUrl, setView } from "../features/store/store-view";

/** Highlight the sidebar entry that matches the current view (or open game). */
export function updateSidebarActive(): void {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  sidebar.querySelectorAll<HTMLElement>("[data-view], [data-act='open-store']").forEach((el) => {
    const active = S.view === "store" ? el.dataset.act === "open-store" : el.dataset.view === S.view;
    el.classList.toggle("active", active);
  });
  syncSidebarGameActive();
}

/** Installed games that have a newer build waiting. */
function pendingUpdateCount(): number {
  let n = 0;
  for (const s of S.epicSummaries) {
    if (s.installed && (s.updateAvailable || S.availableUpdates.has(s.appName))) n++;
  }
  return n;
}

/** Game count sits in the page header, and only on the library itself. */
function syncPageGameCount(): void {
  const el = document.getElementById("lib-heading-count");
  if (!el) return;
  const show = S.view === "library" && !S.currentModalAppName && S.epicSummaries.length > 0;
  const label = t("lib.gameCount", { count: S.epicSummaries.length });
  if (el.textContent !== label) el.textContent = label;
  el.hidden = !show;
}

/** Refresh the download counter next to the Downloads sidebar entry and the status bar. */
export function updateBadge(): void {
  let active = 0;
  for (const d of S.downloads.values()) if (!d.done) active++;
  const count = active + S.dlQueueStatus.queue.length + pendingUpdateCount();
  dlBadge.textContent = count > 0 ? String(count) : "";
  dlBadge.classList.toggle("hidden", count === 0);
  updateSidebarGames();
  updateStatusBar();
}

/** Bottom status bar: the active download (title, percent, speed) or an idle note, plus the version. */
export function updateStatusBar(): void {
  const text = document.getElementById("statusbar-dl-text");
  const btn = document.getElementById("statusbar-dl");
  if (text) {
    let label = t("statusbar.idle");
    let busy = false;
    for (const [id, d] of S.downloads) {
      if (d.done) continue;
      busy = true;
      const m = S.activeDlMetrics && S.activeDlMetrics.id === id ? S.activeDlMetrics : null;
      const title = S.epicSummariesMap.get(id)?.title ?? d.title;
      label = t("statusbar.downloading", { title, p: Math.round(d.progress) }) + (m && m.speed && m.speed !== "—" ? ` · ${m.speed}` : "");
      break;
    }
    const queued = S.dlQueueStatus.queue.length;
    if (!busy && queued > 0) label = t("statusbar.queued", { n: queued });
    if (text.textContent !== label) text.textContent = label;
    btn?.classList.toggle("active", busy);
  }
  const ver = document.getElementById("statusbar-version");
  if (ver && S.appVersion && !ver.textContent) ver.textContent = `v${S.appVersion}`;
}

/** Page header: back button state and a title for the current view or open game page. */
export function updatePageHeader(): void {
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
  const back = document.getElementById("nav-back-btn") as HTMLButtonElement | null;
  if (back) back.disabled = !S.currentModalAppName && !canNavBack();
}

let sidebarGamesSig = "";

const SIDEBAR_RECENT_LIMIT = 7;
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
 * Up to seven sidebar games: recently played first, then random installed
 * titles so the list stays full. Rebuilt only when membership or a status
 * marker changes.
 */
export function updateSidebarGames(): void {
  const host = document.getElementById("sb-games");
  if (!host) return;
  const recentIdx = new Map<string, number>();
  S.epicRecent.forEach((id, i) => recentIdx.set(id, i));
  const installed = S.epicSummaries.filter((s) => s.installed);
  const played = installed
    .filter((s) => recentIdx.has(s.appName))
    .sort((a, b) => (recentIdx.get(a.appName) ?? 0) - (recentIdx.get(b.appName) ?? 0));
  const fillers = installed
    .filter((s) => !recentIdx.has(s.appName))
    .sort((a, b) => fillRank(a.appName) - fillRank(b.appName));
  const shown = played.concat(fillers).slice(0, SIDEBAR_RECENT_LIMIT);

  const stateOf = (app: string, update: boolean): string =>
    S.runningGames.has(app) ? "running" : S.downloads.has(app) && !S.downloads.get(app)?.done ? "dl" : update ? "update" : "";

  const sig = shown
    .map((s) => `${s.appName}:${stateOf(s.appName, s.updateAvailable || S.availableUpdates.has(s.appName))}`)
    .join("|") + `|${S.appLanguage}`;
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
      const state = stateOf(s.appName, s.updateAvailable || S.availableUpdates.has(s.appName));
      const thumb = cover
        ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async" />`
        : `<span class="sb-game-ph">${esc((s.title[0] || "?").toUpperCase())}</span>`;
      const marker = state ? `<span class="sb-game-state ${state}"></span>` : "";
      return `<button class="sb-game ${s.appName === S.currentModalAppName ? "active" : ""}" data-act="epic-detail" data-id="${esc(s.appName)}" title="${esc(s.title)}">${thumb}<span class="sb-game-title">${esc(s.title)}</span>${marker}</button>`;
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

/** Refresh the account chip, the active sidebar item and the installed-games list. */
export function updateChrome(): void {
  updateSidebarActive();
  updateSidebarGames();
  updatePageHeader();
  updateStatusBar();
  const acc = document.getElementById("account");
  if (acc) {
    // Signed in: the account chip opens the profile; signed out: the store accounts page.
    acc.dataset.view = S.epicAccount ? "profile" : "accounts";
    acc.classList.toggle("active", S.view === "profile" || S.view === "accounts");
    const name = S.epicAccount || t("nav.signIn");
    const customAvatar = S.epicAccount ? getCustomAvatar() : null;
    const avatarToken = customAvatar ? `${customAvatar.length}:${customAvatar.slice(0, 32)}` : "none";
    const acctState = `${S.epicAccount || ""}:${avatarToken}`;

    if (acc.dataset.acctState !== acctState) {
      acc.dataset.acctState = acctState;
      if (S.epicAccount) {
        const initial = (S.epicAccount.trim()[0] || "?").toUpperCase();
        acc.innerHTML =
          (customAvatar
            ? `<span class="account-avatar custom"><img class="avatar-img" src="${esc(customAvatar)}" alt="" /></span>`
            : `<span class="account-avatar"><span class="avatar-initial">${esc(initial)}</span></span>`) +
          `<span class="account-name">${esc(name)}</span>`;
      } else {
        acc.innerHTML =
          `<span class="account-avatar"><i data-lucide="circle-user-round"></i></span>` +
          `<span class="account-name">${t("nav.signIn")}</span>`;
        createIcons({ icons: { CircleUserRound } });
      }
    }
    acc.classList.toggle("logged", !!S.epicAccount);
    acc.title = S.epicAccount
      ? t("nav.profileTip", { name })
      : t("nav.loginTip");
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

/** Refresh the state and disabled attributes of the Back/Forward buttons. */
export function updateNavHistoryUi(): void {
  const grp = document.getElementById("nav-history-group");
  const backBtn = document.getElementById("nav-back-btn") as HTMLButtonElement | null;
  const fwdBtn = document.getElementById("nav-forward-btn") as HTMLButtonElement | null;

  if (grp) grp.classList.remove("hidden");
  if (backBtn) {
    // The back arrow also closes an open game page (Hydra behavior).
    const hasBack = Boolean(S.currentModalAppName) || canNavBack();
    backBtn.disabled = !hasBack;
    backBtn.setAttribute("aria-disabled", String(!hasBack));
  }
  if (fwdBtn) {
    const hasFwd = canNavForward();
    fwdBtn.disabled = !hasFwd;
    fwdBtn.classList.toggle("disabled", !hasFwd);
    fwdBtn.setAttribute("aria-disabled", String(!hasFwd));
  }
  const heroBack = document.getElementById("gp-nav-back") as HTMLButtonElement | null;
  const heroFwd = document.getElementById("gp-nav-forward") as HTMLButtonElement | null;
  if (heroBack) {
    const hasBack = Boolean(S.currentModalAppName) || canNavBack();
    heroBack.disabled = !hasBack;
  }
  if (heroFwd) {
    heroFwd.disabled = !canNavForward();
  }
}


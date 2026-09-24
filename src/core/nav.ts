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

/** Refresh the download counter next to the Downloads sidebar entry. */
export function updateBadge(): void {
  let active = 0;
  for (const d of S.downloads.values()) if (!d.done) active++;
  const count = active + S.dlQueueStatus.queue.length;
  dlBadge.textContent = count > 0 ? String(count) : "";
  dlBadge.classList.toggle("hidden", count === 0);
  updateSidebarGames();
}

/** Signature of the last painted sidebar game list; repaint only when it changes. */
let sidebarGamesSig = "";

/**
 * Installed games in the sidebar (Hydra/Heroic pattern): recent first, then
 * alphabetical. Rebuilt only when membership or a status marker changes, so
 * progress events never touch this list.
 */
export function updateSidebarGames(): void {
  const host = document.getElementById("sb-games");
  if (!host) return;
  const recentIdx = new Map<string, number>();
  S.epicRecent.forEach((id, i) => recentIdx.set(id, i));
  const installed = S.epicSummaries.filter((s) => s.installed);
  const collator = S.trCollator ?? new Intl.Collator(S.appLanguage || "en", { sensitivity: "base", numeric: true });
  installed.sort((a, b) => {
    const ra = recentIdx.get(a.appName);
    const rb = recentIdx.get(b.appName);
    if (ra !== undefined || rb !== undefined) return (ra ?? 999) - (rb ?? 999);
    return collator.compare(a.title, b.title);
  });

  const stateOf = (app: string, update: boolean): string =>
    S.runningGames.has(app) ? "running" : S.downloads.has(app) && !S.downloads.get(app)?.done ? "dl" : update ? "update" : "";

  const sig = installed
    .map((s) => `${s.appName}:${stateOf(s.appName, s.updateAvailable || S.availableUpdates.has(s.appName))}`)
    .join("|") + `|${S.appLanguage}`;
  if (sig === sidebarGamesSig) return;
  sidebarGamesSig = sig;

  if (installed.length === 0) {
    host.innerHTML = `<div class="sb-games-empty">${t("sidebar.noInstalled")}</div>`;
    return;
  }
  host.innerHTML = installed
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
  const acc = document.getElementById("account");
  if (acc) {
    const name = S.epicAccount || t("nav.notLoggedIn");
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
          `<span class="account-name">${t("nav.notLoggedIn")}</span>`;
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

  if (grp) {
    grp.classList.toggle("hidden", !S.showNavHistoryButtons);
  }
  if (backBtn) {
    const hasBack = canNavBack();
    backBtn.disabled = !hasBack;
    backBtn.classList.toggle("disabled", !hasBack);
    backBtn.setAttribute("aria-disabled", String(!hasBack));
  }
  if (fwdBtn) {
    const hasFwd = canNavForward();
    fwdBtn.disabled = !hasFwd;
    fwdBtn.classList.toggle("disabled", !hasFwd);
    fwdBtn.setAttribute("aria-disabled", String(!hasFwd));
  }
}


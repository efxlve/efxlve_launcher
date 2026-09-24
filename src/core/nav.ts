/**
 * Top navigation helpers: active-tab indicator, download badge and account chip.
 *
 * These are shared by several features (downloads, collections, library) and by
 * `main.ts`, so they live in `core`.
 */

import { CircleUserRound, createIcons } from "lucide";
import { dlBadge } from "./dom";
import { closeAllModals, openEpicModal, registerNavHistoryPush, render } from "./render";
import { getCustomAvatar, S } from "./state";
import type { EpicFilter, View } from "./types";
import { esc } from "./utils";
import { t } from "../i18n";
import { openStoreUrl, setView } from "../features/store/store-view";

/** Last (active tab + download count) the indicator was measured for. */
let navIndicatorKey = "";

/**
 * Slide the bottom highlight under the active nav tab. Skips the forced layout
 * read when nothing that affects the position changed (pass `force` on resize).
 */
export function updateNavIndicator(force = false): void {
  const bar = document.getElementById("titlebar");
  const seg = document.getElementById("nav-seg");
  const ind = document.getElementById("nav-indicator");
  if (!bar || !seg || !ind) return;
  const active = seg.querySelector<HTMLElement>(".nav-tab.active");
  if (!active) {
    ind.style.opacity = "0";
    return;
  }
  const key = `${active.dataset.view ?? active.dataset.act ?? ""}|${S.downloads.size}`;
  if (!force && S.navIndicatorReady && key === navIndicatorKey) return;
  navIndicatorKey = key;
  if (!S.navIndicatorReady) {
    // Skip the slide animation on first placement (avoid sliding from width 0).
    ind.style.transition = "none";
    S.navIndicatorReady = true;
    window.setTimeout(() => { ind.style.transition = ""; }, 80);
  }
  const barRect = bar.getBoundingClientRect();
  const tabRect = active.getBoundingClientRect();
  ind.style.width = `${tabRect.width}px`;
  ind.style.transform = `translateX(${tabRect.left - barRect.left}px)`;
  ind.style.opacity = "1";
}

/** Refresh the download counter badge and re-align the nav indicator. */
export function updateBadge(): void {
  const active = [...S.downloads.values()].filter((d) => !d.done).length;
  const queued = S.dlQueueStatus.queue.length;
  const count = active + queued;
  dlBadge.textContent = count > 0 ? String(count) : "";
  dlBadge.classList.toggle("hidden", count === 0);
  // The badge is inline, so the tab width changes; force a re-measure.
  updateNavIndicator(true);
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

/** Refresh the account chip in the top bar. */
export function updateChrome(): void {
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


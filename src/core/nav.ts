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
import { avatarFor, globalAvatar, S } from "./state";
import type { EpicFilter, View } from "./types";
import { esc } from "./utils";
import { icon } from "./icons";
import { t } from "../i18n";
import { epicPortrait } from "../epic";
import { openStoreUrl, setView } from "../features/store/store-view";

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
  return n;
}

/** Game count sits in the page header, and only on the library itself. */
function syncPageGameCount(): void {
  const el = document.getElementById("lib-heading-count");
  if (!el) return;
  const visible = totalLibraryGamesCount();
  const show = S.view === "library" && !S.currentModalAppName && visible > 0;
  const label = t("lib.gameCount", { count: visible });
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
    switcher.hidden = S.view !== "store";
    if (S.view === "store") {
      switcher.querySelectorAll<HTMLElement>("[data-store]").forEach((btn) => {
        btn.classList.toggle("active", (btn.dataset.store || "epic") === (S.activeStore || "epic"));
      });
      syncStoreSwitcherIndicator();
      requestAnimationFrame(() => syncStoreSwitcherIndicator());
      if (!storeSwitcherObserver && typeof ResizeObserver !== "undefined") {
        storeSwitcherObserver = new ResizeObserver(() => syncStoreSwitcherIndicator());
        storeSwitcherObserver.observe(switcher);
      }
    }
  }
  const back = document.getElementById("nav-back-btn") as HTMLButtonElement | null;
  if (back) back.disabled = !S.currentModalAppName && !canNavBack();
}

let storeSwitcherObserver: ResizeObserver | null = null;

/** Synchronizes the sliding indicator on the active store switcher button. */
export function syncStoreSwitcherIndicator(): void {
  const switcher = document.getElementById("store-switcher");
  if (!switcher || switcher.hidden) return;
  const activeBtn =
    switcher.querySelector<HTMLElement>(".store-switcher-btn.active") ||
    switcher.querySelector<HTMLElement>("[data-store].active");
  const glider = switcher.querySelector<HTMLElement>(".store-switcher-glider");
  if (!activeBtn || !glider) return;

  const w = activeBtn.offsetWidth;
  const x = activeBtn.offsetLeft;
  if (w > 0) {
    glider.style.width = `${w}px`;
    glider.style.transform = `translateX(${x}px)`;
    glider.style.opacity = "1";
    switcher.classList.add("has-glider");
  }
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
  const installed = S.epicSummaries.filter((s) => s.installed && !S.hiddenGames.has(s.appName));
  const played = installed
    .filter((s) => recentIdx.has(s.appName))
    .sort((a, b) => (recentIdx.get(a.appName) ?? 0) - (recentIdx.get(b.appName) ?? 0));
  const fillers = installed
    .filter((s) => !recentIdx.has(s.appName))
    .sort((a, b) => fillRank(a.appName) - fillRank(b.appName));
  const shown = played.concat(fillers).slice(0, SIDEBAR_RECENT_LIMIT);

  const stateOf = (app: string, update: boolean): string =>
    S.runningGames.has(app) ? "running" : S.downloads.has(app) && !S.downloads.get(app)?.done ? "dl" : update ? "update" : "";

  const hasPendingUpdate = (app: string, update: boolean): boolean =>
    update && !S.ignoredUpdates.has(app);

  const sig = shown
    .map((s) => `${s.appName}:${stateOf(s.appName, hasPendingUpdate(s.appName, s.updateAvailable || S.availableUpdates.has(s.appName)))}`)
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
      const state = stateOf(s.appName, hasPendingUpdate(s.appName, s.updateAvailable || S.availableUpdates.has(s.appName)));
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

let sbSwitcherSig = "";

/**
 * Bottom sidebar multi-platform account switcher button and floating popover menu.
 * Displays connected platforms (Epic, GOG), current user avatar/name, and allows
 * 1-click fast switching or adding new store accounts.
 */
export function updateSidebarAccountSwitcher(): void {
  const host = document.getElementById("sb-account-host");
  if (!host) return;

  // Fast signature check to avoid unnecessary DOM thrashing
  const epicAccsSig = (S.savedAccounts || [])
    .map((a) => `${a.account_id}:${a.display_name}:${a.is_active ? 1 : 0}`)
    .join(",");
  const gogAccsSig = (S.gogSavedAccounts || [])
    .map((a) => `${a.user_id}:${a.username}:${a.is_active ? 1 : 0}`)
    .join(",");
  const sig = [
    S.isAccountSwitcherOpen ? "1" : "0",
    S.epicAccount,
    S.epicAccountId || "",
    S.gogAccount,
    S.gogAccountId || "",
    epicAccsSig,
    gogAccsSig,
    S.appLanguage,
  ].join("|");

  if (sig === sbSwitcherSig && host.firstElementChild) return;
  sbSwitcherSig = sig;

  // Icon-only button: with several linked accounts, showing one name/avatar
  // would be ambiguous. The popover lists the accounts, their platforms and the
  // active one (checkmark), so the button stays neutral.
  const accountCount = (S.savedAccounts?.length || 0) + (S.gogSavedAccounts?.length || 0);

  let popoverHtml = "";
  if (S.isAccountSwitcherOpen) {
    // Epic Section
    const epicItems = (S.savedAccounts || [])
      .map((acc) => {
        const isActive =
          acc.is_active ||
          acc.account_id === S.epicAccountId ||
          acc.display_name === S.epicAccount;
        const av = avatarFor(`epic:${acc.account_id}`);
        const avContent = av
          ? `<img src="${esc(av)}" alt="" />`
          : esc((acc.display_name.trim()[0] || "?").toUpperCase());
        return `
          <button type="button" class="sb-pop-acc-item ${isActive ? "active" : ""}" data-act="sb-switch-epic" data-id="${esc(acc.account_id)}" title="${esc(acc.display_name)}">
            <span class="sb-pop-acc-avatar">${avContent}</span>
            <span class="sb-pop-acc-name">${esc(acc.display_name)}</span>
            ${isActive ? `<span class="sb-pop-check">${icon("check", 14)}</span>` : ""}
          </button>
        `;
      })
      .join("");

    const epicSection = `
      <div class="sb-pop-section">
        <div class="sb-pop-platform-head">
          <span class="sb-pop-platform-badge">EPIC GAMES</span>
          <button type="button" class="sb-pop-add-btn" data-act="sb-add-epic" title="${t("settings.accountAdd")}">
            ${icon("plus", 12)}
          </button>
        </div>
        <div class="sb-pop-account-list">
          ${
            epicItems ||
            `<button type="button" class="sb-pop-empty-add" data-act="sb-add-epic">
              ${icon("plus", 13)}
              <span>${t("nav.signIn")} (Epic)</span>
            </button>`
          }
        </div>
      </div>
    `;

    // GOG Section
    const gogItems = (S.gogSavedAccounts || [])
      .map((acc) => {
        const isActive = acc.is_active || acc.user_id === S.gogAccountId;
        const av = avatarFor(`gog:${acc.user_id}`);
        const avContent = av
          ? `<img src="${esc(av)}" alt="" />`
          : esc((acc.username.trim()[0] || "?").toUpperCase());
        return `
          <button type="button" class="sb-pop-acc-item ${isActive ? "active" : ""}" data-act="sb-switch-gog" data-id="${esc(acc.user_id)}" title="${esc(acc.username)}">
            <span class="sb-pop-acc-avatar">${avContent}</span>
            <span class="sb-pop-acc-name">${esc(acc.username)}</span>
            ${isActive ? `<span class="sb-pop-check">${icon("check", 14)}</span>` : ""}
          </button>
        `;
      })
      .join("");

    const gogSection = `
      <div class="sb-pop-section">
        <div class="sb-pop-platform-head">
          <span class="sb-pop-platform-badge">GOG.COM</span>
          <button type="button" class="sb-pop-add-btn" data-act="sb-add-gog" title="${t("settings.accountAdd")}">
            ${icon("plus", 12)}
          </button>
        </div>
        <div class="sb-pop-account-list">
          ${
            gogItems ||
            `<button type="button" class="sb-pop-empty-add" data-act="sb-add-gog">
              ${icon("plus", 13)}
              <span>${t("nav.signIn")} (GOG)</span>
            </button>`
          }
        </div>
      </div>
    `;

    popoverHtml = `
      <div id="sb-account-popover" class="sb-popover" role="dialog" aria-label="${t("accounts.switchAccountTitle")}">
        <div class="sb-popover-head">
          <span class="sb-popover-title">${t("accounts.switchAccountTitle")}</span>
          <button type="button" class="icon-btn tiny" data-act="open-accounts-settings" title="${t("accounts.manageAccounts")}">
            ${icon("settings", 13)}
          </button>
        </div>
        ${epicSection}
        ${gogSection}
      </div>
    `;
  }

  const btnHtml = `
    <button type="button" class="sb-switcher-btn ${S.isAccountSwitcherOpen ? "active" : ""}" data-act="toggle-account-switcher" aria-haspopup="true" aria-expanded="${S.isAccountSwitcherOpen}" title="${esc(t("accounts.switchAccountTitle"))}">
      ${icon("arrow-left-right", 16)}
      <span class="sb-switcher-label">${t("accounts.switchAccountTitle")}</span>
      ${accountCount > 1 ? `<span class="sb-switcher-count tabular-nums">${accountCount}</span>` : ""}
    </button>
  `;

  host.innerHTML = popoverHtml + btnHtml;
}

/** Refresh the account chip, the active sidebar item and the installed-games list. */
export function updateChrome(): void {
  updateSidebarActive();
  updateSidebarGames();
  updateSidebarAccountSwitcher();
  updatePageHeader();
  const acc = document.getElementById("account");
  if (acc) {
    // Signed in: the account chip opens the profile (if Epic) or accounts page; signed out: the store accounts page.
    const hasAccount = Boolean(S.epicAccount || S.gogAccount);
    acc.dataset.view = S.epicAccount ? "profile" : "accounts";
    acc.classList.toggle("active", S.view === "profile" || S.view === "accounts");
    const name = S.epicAccount || S.gogAccount || t("nav.signIn");
    // The chip carries the combined profile's own photo, not one account's face.
    const combinedAvatar = globalAvatar();
    const avatarToken = combinedAvatar ? `${combinedAvatar.length}:${combinedAvatar.slice(0, 32)}` : "none";
    const acctState = `${name}:${avatarToken}`;

    if (acc.dataset.acctState !== acctState) {
      acc.dataset.acctState = acctState;
      if (hasAccount) {
        acc.innerHTML =
          (combinedAvatar
            ? `<span class="account-avatar custom"><img class="avatar-img" src="${esc(combinedAvatar)}" alt="" /></span>`
            : `<span class="account-avatar">${icon("gamepad-2", 15)}</span>`) +
          `<span class="account-name">${esc(name)}</span>`;
      } else {
        acc.innerHTML =
          `<span class="account-avatar"><i data-lucide="circle-user-round"></i></span>` +
          `<span class="account-name">${t("nav.signIn")}</span>`;
        createIcons({ icons: { CircleUserRound } });
      }
    }
    acc.classList.toggle("logged", hasAccount);
    acc.title = hasAccount
      ? (S.epicAccount ? t("nav.profileTip", { name }) : name)
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


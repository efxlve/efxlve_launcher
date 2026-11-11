/**
 * Stage commands used by the controller layer, the click router and the
 * keyboard shortcuts. Keeping them here means the gamepad module never needs
 * to know a screen's DOM.
 */

import { invoke } from "@tauri-apps/api/core";
import { epicUninstall } from "../../core/epic-actions";
import { epicCreateDesktopShortcut, epicVerifyGame } from "../../epic";
import { toggleFav } from "../../core/game-view";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { gogVerifyGame } from "../../gog";
import { nileCreateDesktopShortcut, nileUninstall, nileVerify } from "../../nile";
import { steamGameAction } from "../../steam";
import type {
  SettingsSection,
  StageAchievementFilter,
  StageLibraryFilter,
  StageProgramTab,
  StageRoute,
  StageSettingsTab,
} from "../../core/types";
import { localizeMessage, t } from "../../i18n";
import { uploadGameCloudAction } from "../cloud-backup/cloud-backup-actions";
import { fetchAndRenderAchievements } from "../drawer/drawer-view";
import { ensureFullShot, fetchAndRenderScreenshots } from "../screenshots/screenshots-view";
import { loadNotes } from "../notes/notes-client";
import { loadSettingsView } from "../settings/settings-view";
import { setView } from "../store/store-view";
import { stageLaunchGame } from "./stage-launch";
import { stageGameByKey, stageHeroSummary, stageLibraryList, stageLibraryStores, stageSearchMatches } from "./stage-model";
import { stageSearchResultsHtml } from "./stage-search";
import { stageFeedback } from "./stage-sound";
import { exitStage, setStageLibrarySort, setStageLibraryView } from "./stage-state";
import { stageCloseBrowserSheet } from "./stage-browser";
import { stageCloseSpotifySheet } from "./stage-spotify";
import { stageCloseDiscordSheet } from "./stage-discord";
import { stageClosePowerSheet } from "./stage-power";

export {
  stageOpenBrowserSheet,
  stageCloseBrowserSheet,
  stageLaunchBrowser,
  stageCloseBrowserWindow,
} from "./stage-browser";
export {
  stageOpenSpotifySheet,
  stageCloseSpotifySheet,
  stageSpotifyAction,
  stageSpotifyPlayPlaylist,
} from "./stage-spotify";
export {
  stageOpenDiscordSheet,
  stageCloseDiscordSheet,
  stageDiscordConnect,
  stageDiscordToggleMute,
  stageDiscordHangup,
  stageDiscordOpenApp,
} from "./stage-discord";
export {
  stageOpenPowerSheet,
  stageClosePowerSheet,
  stageSleepDevice,
  stageShutdownDevice,
  stageQuickVolume,
  stageToggleQuickMute,
} from "./stage-power";

const TOP_ROUTES: StageRoute[] = ["home", "library", "downloads"];
/** The shelf query to restore when the search is cancelled rather than applied. */
let searchStartQuery = "";
const TABS: StageProgramTab[] = ["overview", "achievements", "media", "notes", "extras"];
const SETTINGS_TABS: StageSettingsTab[] = ["general", "controller", "appearance", "about"];
const SORTS = ["recent", "alpha", "playtime", "installed"] as const;

/** Key of the focused game, if the focus is on a game card. */
export function stageFocusedKey(): string {
  const key = S.stage.focusKey;
  if (key.startsWith("game:")) return key.slice(5);
  if (key.startsWith("lib:")) return key.slice(4);
  if (key.startsWith("search:game:")) return key.slice(12);
  return "";
}

function stageMainScroll(): number {
  return document.getElementById("stage-main")?.scrollTop ?? 0;
}

export function stageGo(route: StageRoute): void {
  stageFeedback("select");
  S.stage.quickMenu = false;
  S.stage.controlsOpen = false;
  S.stage.searchOpen = false;
  S.stage.focusKey = "";
  if (route === "program") {
    S.stage.route = "program";
    scheduleRender();
    return;
  }
  S.stage.route = route;
  S.stage.gameKey = null;
  S.stage.stack = [];
  if (route !== "library") S.stage.collectionId = null;
  if (route === "settings") S.stage.settingsTab = "general";
  scheduleRender();
}

/**
 * A submitted search is a whole-library view: keeping an "installed" or
 * single-collection filter would hide the very result the player picked and
 * leave an empty wall behind the back button.
 */
function applySearchShelf(): void {
  if (!S.stage.query.trim()) return;
  S.stage.libraryFilter = "all";
  S.stage.libraryStore = "all";
  S.stage.collectionId = null;
}

export function stageOpenProgram(key: string): void {
  const summary = stageGameByKey(key);
  if (!summary) return;
  if (S.stage.searchOpen) applySearchShelf();
  if (S.stage.route !== "program") {
    // Return to the exact card, not to the top of the shelf. A search result or
    // a side-panel button still resolves to the same library card.
    const focusKey = S.stage.focusKey.startsWith("game:")
      ? S.stage.focusKey
      : `lib:${summary.appName}`;
    S.stage.stack.push({
      route: S.stage.route,
      gameKey: S.stage.gameKey,
      focusKey,
      scroll: stageMainScroll(),
    });
  }
  stageFeedback("select");
  S.stage.route = "program";
  S.stage.gameKey = summary.appName;
  S.stage.programTab = "overview";
  S.stage.quickMenu = false;
  S.stage.searchOpen = false;
  S.stage.controlsOpen = false;
  S.stage.focusKey = "";
  scheduleRender();
}

export function stageBack(): void {
  if (S.stage.launch) return;
  if (S.stage.stillIndex !== null) {
    stageCloseStill();
    return;
  }
  if (S.stage.browserOpen) {
    stageCloseBrowserSheet();
    return;
  }
  if (S.stage.spotifyOpen) {
    stageCloseSpotifySheet();
    return;
  }
  if (S.stage.discordOpen) {
    stageCloseDiscordSheet();
    return;
  }
  if (S.stage.powerOpen) {
    stageClosePowerSheet();
    return;
  }
  stageFeedback("back");
  if (S.stage.manageKey) {
    if (S.stage.manageConfirmUninstall) {
      S.stage.manageConfirmUninstall = false;
      S.stage.focusKey = "manage:uninstall";
      scheduleRender();
      return;
    }
    stageCloseManage();
    return;
  }
  if (S.stage.controlsOpen) {
    stageCloseControls();
    return;
  }
  if (S.stage.quickMenu) {
    S.stage.quickMenu = false;
    S.stage.focusKey = "";
    scheduleRender();
    return;
  }
  if (S.stage.searchOpen) {
    stageCancelSearch();
    return;
  }
  if (S.stage.route === "program") {
    const previous = S.stage.stack.pop();
    if (previous) {
      S.stage.route = previous.route;
      S.stage.gameKey = previous.gameKey;
      S.stage.focusKey = previous.focusKey;
      scheduleRender();
      window.requestAnimationFrame(() => {
        const main = document.getElementById("stage-main");
        if (main) main.scrollTop = previous.scroll;
      });
      return;
    }
    S.stage.route = "library";
    S.stage.gameKey = null;
    S.stage.focusKey = "";
    scheduleRender();
    return;
  }
  if (S.stage.route !== "home") {
    S.stage.route = "home";
    S.stage.gameKey = null;
    S.stage.collectionId = null;
    S.stage.focusKey = "";
    scheduleRender();
    return;
  }
  // Home is the edge of the stage: the menu is the safe way out.
  stageOpenQuickMenu("menu:exit");
}

export function stageToggleQuickMenu(): void {
  if (S.stage.launch) return;
  if (S.stage.quickMenu) {
    stageFeedback("back");
    S.stage.quickMenu = false;
    S.stage.controlsOpen = false;
    S.stage.focusKey = "";
    scheduleRender();
    return;
  }
  stageOpenQuickMenu("menu:resume");
}

export function stageOpenQuickMenu(focusKey = "menu:resume"): void {
  stageFeedback("select");
  S.stage.quickMenu = true;
  S.stage.controlsOpen = false;
  S.stage.searchOpen = false;
  S.stage.focusKey = focusKey;
  scheduleRender();
}

export function stageToggleControls(): void {
  stageFeedback("select");
  S.stage.quickMenu = true;
  S.stage.controlsOpen = !S.stage.controlsOpen;
  S.stage.focusKey = S.stage.controlsOpen ? "controls:close" : "menu:controls";
  scheduleRender();
}

/** Standalone controls sheet, opened from Stage Settings. */
export function stageShowControls(): void {
  stageFeedback("select");
  S.stage.quickMenu = false;
  S.stage.controlsOpen = true;
  S.stage.focusKey = "controls:close";
  scheduleRender();
}

export function stageCloseControls(): void {
  // The caller owns the feedback: B already chirps in `stageBack`, and the
  // close button adds its own tick in the shell dispatcher.
  if (!S.stage.controlsOpen) return;
  const fromQuickMenu = S.stage.quickMenu;
  S.stage.controlsOpen = false;
  S.stage.focusKey = fromQuickMenu
    ? "menu:controls"
    : S.stage.route === "settings"
      ? "set:controls"
      : "";
  scheduleRender();
}

export function stageCycleSection(forward: boolean): void {
  if (
    S.stage.route === "program" ||
    S.stage.route === "settings" ||
    S.stage.quickMenu ||
    S.stage.searchOpen
  ) {
    return;
  }
  stageFeedback("tab");
  const index = Math.max(0, TOP_ROUTES.indexOf(S.stage.route));
  const next = (index + (forward ? 1 : -1) + TOP_ROUTES.length) % TOP_ROUTES.length;
  stageGo(TOP_ROUTES[next]);
}

export function stageCycleTab(forward: boolean): void {
  if (S.stage.route === "settings") {
    stageCycleSettingsTab(forward);
    return;
  }
  if (S.stage.route !== "program" || S.stage.quickMenu || S.stage.searchOpen) return;
  stageFeedback("tab");
  const index = Math.max(0, TABS.indexOf(S.stage.programTab));
  const next = (index + (forward ? 1 : -1) + TABS.length) % TABS.length;
  S.stage.programTab = TABS[next];
  S.stage.focusKey = `tab:${TABS[next]}`;
  if (S.stage.programTab === "achievements") stageEnsureAchievements(S.stage.gameKey);
  if (S.stage.programTab === "media" || S.stage.programTab === "extras") stageEnsureScreenshots(S.stage.gameKey);
  if (S.stage.programTab === "notes") void loadNotes();
  scheduleRender();
}

export function stageSetTab(tab: StageProgramTab): void {
  stageFeedback("select");
  S.stage.programTab = tab;
  S.stage.focusKey = `tab:${tab}`;
  if (tab === "achievements") stageEnsureAchievements(S.stage.gameKey);
  if (tab === "media" || tab === "extras") stageEnsureScreenshots(S.stage.gameKey);
  if (tab === "notes") void loadNotes();
  scheduleRender();
}

export function stageCycleSettingsTab(forward: boolean): void {
  if (S.stage.route !== "settings") return;
  stageFeedback("tab");
  const index = Math.max(0, SETTINGS_TABS.indexOf(S.stage.settingsTab));
  const next = (index + (forward ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length;
  S.stage.settingsTab = SETTINGS_TABS[next];
  S.stage.focusKey = `settings-tab:${SETTINGS_TABS[next]}`;
  scheduleRender();
}

export function stageSetSettingsTab(tab: StageSettingsTab): void {
  if (S.stage.route !== "settings") return;
  stageFeedback("select");
  S.stage.settingsTab = tab;
  S.stage.focusKey = `settings-tab:${tab}`;
  scheduleRender();
}

export function stageCycleStore(forward: boolean): void {
  if (S.stage.route !== "library" || S.stage.searchOpen) return;
  const stores = stageLibraryStores();
  const index = Math.max(0, stores.indexOf(S.stage.libraryStore));
  stageFeedback("move");
  const next = (index + (forward ? 1 : -1) + stores.length) % stores.length;
  S.stage.libraryStore = stores[next];
  S.stage.focusKey = "";
  scheduleRender();
}

export function stageCycleSort(): void {
  if (S.stage.route !== "library") return;
  stageFeedback("move");
  const index = SORTS.indexOf(S.stage.librarySort);
  setStageLibrarySort(SORTS[(index + 1) % SORTS.length]);
  scheduleRender();
}

export function stageToggleView(): void {
  if (S.stage.route !== "library") return;
  stageFeedback("select");
  setStageLibraryView(S.stage.libraryView === "grid" ? "list" : "grid");
  scheduleRender();
}

export function stageSetFilter(filter: StageLibraryFilter): void {
  stageFeedback("select");
  S.stage.libraryFilter = filter;
  S.stage.focusKey = `filter:${filter}`;
  scheduleRender();
}

function stagePreviewKey(): string {
  return S.stage.route === "library" ? S.stage.previewKey || "" : "";
}

/** The game the Home hero is showing, even while the focus is on Play. */
function stageHomeKey(): string {
  if (S.stage.route !== "home") return "";
  return S.stage.homeHeroKey || stageHeroSummary()?.appName || "";
}

export function stageToggleFavorite(key?: string): void {
  const target =
    key ||
    stageFocusedKey() ||
    stagePreviewKey() ||
    S.stage.gameKey ||
    stageHomeKey() ||
    "";
  if (!target) return;
  stageFeedback("select");
  toggleFav(target);
  const now = S.epicFav.has(target);
  toast(now ? t("stage.favorited") : t("stage.unfavorited"), "ok");
  scheduleRender();
}

export function stageQuickPlay(key?: string): void {
  const target =
    key ||
    stageFocusedKey() ||
    stagePreviewKey() ||
    S.stage.gameKey ||
    stageHomeKey() ||
    "";
  if (!target) return;
  stageLaunchGame(target);
}

export function stageOpenSearch(): void {
  if (S.stage.searchOpen) return;
  stageFeedback("select");
  searchStartQuery = S.stage.query;
  S.stage.searchOpen = true;
  S.stage.quickMenu = false;
  S.stage.controlsOpen = false;
  // A controller starts on the letter grid; a keyboard starts in the field.
  S.stage.focusKey = S.stage.controllerConnected ? "search:key:q" : "search:input";
  scheduleRender();
  if (!S.stage.controllerConnected) {
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>("#stage-search-input");
      if (input) {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    });
  }
}

/** Closes the overlay without changing the query; the caller owns the sound. */
export function stageCloseSearch(): void {
  if (!S.stage.searchOpen) return;
  S.stage.searchOpen = false;
  S.stage.focusKey = "";
  scheduleRender();
}

/** X and B restore the shelf query the player had before opening search. */
export function stageCancelSearch(): void {
  if (!S.stage.searchOpen) return;
  S.stage.query = searchStartQuery;
  stageCloseSearch();
}

function searchPatch(): void {
  const input = document.querySelector<HTMLInputElement>("#stage-search-input");
  if (input && input.value !== S.stage.query) {
    input.value = S.stage.query;
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
  const results = document.getElementById("stage-search-results");
  if (results) {
    results.innerHTML = stageSearchResultsHtml();
    results.querySelectorAll<HTMLElement>("button").forEach((button) => {
      button.setAttribute("data-gp-item", "");
    });
  }
  const count = document.querySelector<HTMLElement>("#stage-search-count");
  if (count) count.textContent = String(stageSearchMatches(S.stage.query, 999).length);
}

export function stageSearchInput(value: string): void {
  S.stage.query = value;
  searchPatch();
}

export function stageSearchKey(key: string): void {
  if (key === "backspace") S.stage.query = S.stage.query.slice(0, -1);
  else if (key === "space") S.stage.query += " ";
  else if (key === "clear") S.stage.query = "";
  else if (key === "done") {
    stageSearchSubmit();
    return;
  } else if (key.length === 1) S.stage.query += key;
  stageFeedback("move");
  searchPatch();
}

export function stageSearchSubmit(): void {
  stageFeedback("select");
  applySearchShelf();
  stageCloseSearch();
}

export function stageOpenDesktop(): void {
  stageFeedback("back");
  exitStage();
}

export function stageOpenDesktopSettingsSection(section: SettingsSection): void {
  stageFeedback("back");
  exitStage();
  S.settingsSection = section;
  setView("settings");
  scheduleRender();
  void loadSettingsView();
}

export function stageOpenDesktopSettings(): void {
  stageOpenDesktopSettingsSection("controller");
}

/** In-stage management keeps the player in couch mode without dropping to desktop. */
export function stageOpenManage(key?: string): void {
  const target = key || S.stage.gameKey || stageFocusedKey() || stageHomeKey();
  if (!target) return;
  stageFeedback("select");
  S.stage.manageKey = target;
  S.stage.manageConfirmUninstall = false;
  S.stage.quickMenu = false;
  S.stage.controlsOpen = false;
  S.stage.focusKey = "manage:play";
  scheduleRender();
}

export function stageCloseManage(): void {
  stageFeedback("back");
  S.stage.manageKey = null;
  S.stage.manageConfirmUninstall = false;
  S.stage.focusKey = S.stage.route === "program" ? "prog:manage" : "hero:details";
  scheduleRender();
}

export function stageManageOpenFolder(key?: string): void {
  const target = key || S.stage.manageKey || S.stage.gameKey;
  if (!target) return;
  const game = stageGameByKey(target);
  if (!game?.installPath) {
    toast(t("common.installPathUnknown"), "err");
    return;
  }
  stageFeedback("select");
  invoke<string>("open_folder", { path: game.installPath })
    .then((msg) => toast(msg, "ok"))
    .catch((err) => toast(String(err), "err"));
}

export function stageManageVerify(key?: string): void {
  const target = key || S.stage.manageKey || S.stage.gameKey;
  if (!target) return;
  stageFeedback("select");
  toast(t("manage.verifying"), "");
  if (target.startsWith("amazon::")) {
    nileVerify(target.slice(8))
      .then(() => toast(t("manage.verifyTitle"), "ok"))
      .catch((err) => toast(String(err), "err"));
  } else if (target.startsWith("gog::")) {
    gogVerifyGame(target)
      .then(() => toast(t("manage.verifyTitle"), "ok"))
      .catch((err) => toast(String(err), "err"));
  } else if (target.startsWith("steam::")) {
    steamGameAction(target.slice(7), "validate")
      .then(() => toast(t("steam.validate"), "ok"))
      .catch((err) => toast(String(err), "err"));
  } else {
    epicVerifyGame(target)
      .then((msg) => toast(msg, "ok"))
      .catch((err) => toast(String(err), "err"));
  }
}

export function stageManageShortcut(key?: string): void {
  const target = key || S.stage.manageKey || S.stage.gameKey;
  if (!target) return;
  stageFeedback("select");
  if (target.startsWith("amazon::")) {
    nileCreateDesktopShortcut(target.slice(8))
      .then((msg) => toast(localizeMessage(msg), "ok"))
      .catch((err) => toast(String(err), "err"));
  } else {
    epicCreateDesktopShortcut(target)
      .then((msg) => toast(localizeMessage(msg), "ok"))
      .catch((err) => toast(String(err), "err"));
  }
}

export function stageManageAskUninstall(): void {
  stageFeedback("select");
  S.stage.manageConfirmUninstall = true;
  S.stage.focusKey = "manage:confirm-uninstall";
  scheduleRender();
}

export function stageManageCancelUninstall(): void {
  stageFeedback("back");
  S.stage.manageConfirmUninstall = false;
  S.stage.focusKey = "manage:uninstall";
  scheduleRender();
}

export function stageManageConfirmUninstall(key?: string): void {
  const target = key || S.stage.manageKey || S.stage.gameKey;
  if (!target) return;
  stageFeedback("select");
  S.stage.manageKey = null;
  S.stage.manageConfirmUninstall = false;
  S.stage.focusKey = "prog:back";
  scheduleRender();
  if (target.startsWith("steam::")) {
    void steamGameAction(target.slice(7), "uninstall").then(() => scheduleRender());
  } else if (target.startsWith("amazon::")) {
    void nileUninstall(target.slice(8)).then(() => scheduleRender());
  } else {
    void epicUninstall(target).then(() => scheduleRender());
  }
}

export function stageResetFilters(): void {
  stageFeedback("select");
  S.stage.libraryFilter = "all";
  S.stage.collectionId = null;
  S.stage.libraryStore = "all";
  S.stage.query = "";
  S.stage.focusKey = "";
  scheduleRender();
}

/* ---------- Collections ---------- */

export function stageOpenCollection(id: string): void {
  const collection = S.epicCollections.find((item) => item.id === id);
  if (!collection) return;
  stageFeedback("select");
  S.stage.collectionId = id;
  S.stage.route = "library";
  S.stage.gameKey = null;
  S.stage.libraryFilter = "all";
  S.stage.libraryStore = "all";
  S.stage.query = "";
  S.stage.stack = [];
  S.stage.focusKey = "";
  scheduleRender();
}

export function stageClearCollection(): void {
  if (!S.stage.collectionId) return;
  stageFeedback("back");
  S.stage.collectionId = null;
  S.stage.focusKey = "filter:all";
  scheduleRender();
}

/* ---------- Achievements ---------- */

export function stageEnsureAchievements(appName: string | null): void {
  if (!appName) return;
  if (S.loadedAchievements.has(appName) || S.loadingAchFor.has(appName)) return;
  void fetchAndRenderAchievements(appName, false, true)
    .then(() => scheduleRender())
    .catch(() => scheduleRender());
}

export function stageRefreshAchievements(appName: string): void {
  if (!appName) return;
  stageFeedback("select");
  // Force the loading state so the render guard cannot reuse the old counts.
  S.loadedAchievements.delete(appName);
  scheduleRender();
  void fetchAndRenderAchievements(appName, true, true)
    .then(() => scheduleRender())
    .catch(() => scheduleRender());
}

export function stageSetAchievementFilter(filter: StageAchievementFilter): void {
  stageFeedback("select");
  S.stage.achievementFilter = filter;
  S.stage.focusKey = `ach-filter:${filter}`;
  scheduleRender();
}

/* ---------- Screenshots ---------- */

export function stageEnsureScreenshots(appName: string | null): void {
  if (!appName) return;
  if (S.loadedScreenshots.has(appName) || S.loadingScreenshotsFor.has(appName)) return;
  fetchAndRenderScreenshots(appName, stageGameByKey(appName)?.title || appName);
}

function stillItems(): import("../../epic").GameScreenshotItem[] {
  const app = S.stage.stillApp || S.stage.gameKey;
  return app ? (S.loadedScreenshots.get(app) || []) : [];
}

export function stageOpenStill(index: number, appName?: string): void {
  const app = appName || S.stage.gameKey;
  if (!app) return;
  const items = S.loadedScreenshots.get(app) || [];
  if (index < 0 || index >= items.length) return;
  stageFeedback("select");
  S.stage.stillApp = app;
  S.stage.stillIndex = index;
  S.stage.focusKey = items.length > 1 ? "still:next" : "still:close";
  scheduleRender();
  void ensureFullShot(app, items[index]).then(() => scheduleRender()).catch(() => undefined);
}

export function stageCloseStill(): void {
  if (S.stage.stillIndex === null) return;
  const index = S.stage.stillIndex;
  stageFeedback("back");
  S.stage.stillIndex = null;
  S.stage.stillApp = null;
  S.stage.focusKey = `still:${index}`;
  scheduleRender();
}

export function stageStillStep(forward: boolean): void {
  const items = stillItems();
  if (S.stage.stillIndex === null || items.length === 0) return;
  stageFeedback("move");
  const next = (S.stage.stillIndex + (forward ? 1 : -1) + items.length) % items.length;
  S.stage.stillIndex = next;
  scheduleRender();
  const app = S.stage.stillApp;
  if (app) void ensureFullShot(app, items[next]).then(() => scheduleRender()).catch(() => undefined);
}

/* ---------- Cloud saves ---------- */

export function stageCloudBackup(appName: string): void {
  if (!appName) return;
  stageFeedback("select");
  void uploadGameCloudAction(appName)
    .then(() => scheduleRender())
    .catch(() => scheduleRender());
}

export function stageDismissWelcome(): void {
  S.stage.lastSession = null;
  stageFeedback("back");
  scheduleRender();
}

export function stagePickRandomGame(): void {
  const all = stageLibraryList();
  const installed = all.filter((s) => s.installed);
  const pool = installed.length > 0 ? installed : all;
  if (pool.length === 0) return;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  stageFeedback("select");
  stageOpenProgram(picked.appName);
}

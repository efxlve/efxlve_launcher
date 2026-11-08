/**
 * Stage commands used by the controller layer, the click router and the
 * keyboard shortcuts. Keeping them here means the gamepad module never needs
 * to know a screen's DOM.
 */

import { toggleFav } from "../../core/game-view";
import { openEpicModal, scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import type { StageLibraryFilter, StageProgramTab, StageRoute } from "../../core/types";
import { t } from "../../i18n";
import { loadSettingsView } from "../settings/settings-view";
import { setView } from "../store/store-view";
import { stageLaunchGame } from "./stage-launch";
import { stageGameByKey, stageHeroSummary, stageLibraryList, stageLibraryStores } from "./stage-model";
import { stageSearchResultsHtml } from "./stage-search";
import { exitStage, setStageLibrarySort, setStageLibraryView } from "./stage-state";

const TOP_ROUTES: StageRoute[] = ["home", "library", "downloads"];
const TABS: StageProgramTab[] = ["overview", "achievements", "extras"];
const SORTS = ["recent", "alpha", "playtime", "installed"] as const;

/** Key of the focused game, if the focus is on a game card. */
export function stageFocusedKey(): string {
  const key = S.stage.focusKey;
  if (key.startsWith("game:")) return key.slice(5);
  if (key.startsWith("lib:")) return key.slice(4);
  if (key.startsWith("prog:")) return key.slice(5);
  if (key.startsWith("search:game:")) return key.slice(12);
  return "";
}

function stageMainScroll(): number {
  return document.getElementById("stage-main")?.scrollTop ?? 0;
}

export function stageGo(route: StageRoute): void {
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
  scheduleRender();
}

export function stageOpenProgram(key: string): void {
  const summary = stageGameByKey(key);
  if (!summary) return;
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
  if (S.stage.controlsOpen) {
    S.stage.controlsOpen = false;
    S.stage.focusKey = "menu:controls";
    scheduleRender();
    return;
  }
  if (S.stage.quickMenu) {
    S.stage.quickMenu = false;
    S.stage.focusKey = "";
    scheduleRender();
    return;
  }
  if (S.stage.searchOpen) {
    S.stage.searchOpen = false;
    S.stage.focusKey = "";
    scheduleRender();
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
    S.stage.quickMenu = false;
    S.stage.controlsOpen = false;
    S.stage.focusKey = "";
    scheduleRender();
    return;
  }
  stageOpenQuickMenu("menu:resume");
}

export function stageOpenQuickMenu(focusKey = "menu:resume"): void {
  S.stage.quickMenu = true;
  S.stage.controlsOpen = false;
  S.stage.searchOpen = false;
  S.stage.focusKey = focusKey;
  scheduleRender();
}

export function stageToggleControls(): void {
  S.stage.quickMenu = true;
  S.stage.controlsOpen = !S.stage.controlsOpen;
  S.stage.focusKey = S.stage.controlsOpen ? "controls:close" : "menu:controls";
  scheduleRender();
}

export function stageCycleSection(forward: boolean): void {
  if (S.stage.route === "program" || S.stage.quickMenu || S.stage.searchOpen) return;
  const index = Math.max(0, TOP_ROUTES.indexOf(S.stage.route));
  const next = (index + (forward ? 1 : -1) + TOP_ROUTES.length) % TOP_ROUTES.length;
  stageGo(TOP_ROUTES[next]);
}

export function stageCycleTab(forward: boolean): void {
  if (S.stage.route !== "program" || S.stage.quickMenu || S.stage.searchOpen) return;
  const index = Math.max(0, TABS.indexOf(S.stage.programTab));
  const next = (index + (forward ? 1 : -1) + TABS.length) % TABS.length;
  S.stage.programTab = TABS[next];
  S.stage.focusKey = `tab:${TABS[next]}`;
  scheduleRender();
}

export function stageSetTab(tab: StageProgramTab): void {
  S.stage.programTab = tab;
  S.stage.focusKey = `tab:${tab}`;
  scheduleRender();
}

export function stageCycleStore(forward: boolean): void {
  if (S.stage.route !== "library" || S.stage.searchOpen) return;
  const stores = stageLibraryStores();
  const index = Math.max(0, stores.indexOf(S.stage.libraryStore));
  const next = (index + (forward ? 1 : -1) + stores.length) % stores.length;
  S.stage.libraryStore = stores[next];
  S.stage.focusKey = "";
  scheduleRender();
}

export function stageCycleSort(): void {
  if (S.stage.route !== "library") return;
  const index = SORTS.indexOf(S.stage.librarySort);
  setStageLibrarySort(SORTS[(index + 1) % SORTS.length]);
  scheduleRender();
}

export function stageToggleView(): void {
  if (S.stage.route !== "library") return;
  setStageLibraryView(S.stage.libraryView === "grid" ? "list" : "grid");
  scheduleRender();
}

export function stageSetFilter(filter: StageLibraryFilter): void {
  S.stage.libraryFilter = filter;
  S.stage.focusKey = `filter:${filter}`;
  scheduleRender();
}

export function stageToggleFavorite(key?: string): void {
  const target = key || stageFocusedKey() || S.stage.gameKey || (S.stage.route === "home" ? stageHeroSummary()?.appName : "") || "";
  if (!target) return;
  toggleFav(target);
  const now = S.epicFav.has(target);
  toast(now ? t("stage.favorited") : t("stage.unfavorited"), "ok");
  scheduleRender();
}

export function stageQuickPlay(key?: string): void {
  const target = key || stageFocusedKey() || S.stage.gameKey || stageHeroSummary()?.appName || "";
  if (!target) return;
  stageLaunchGame(target);
}

export function stageOpenSearch(): void {
  if (S.stage.searchOpen) return;
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

export function stageCloseSearch(): void {
  if (!S.stage.searchOpen) return;
  S.stage.searchOpen = false;
  S.stage.focusKey = "";
  scheduleRender();
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
  if (count) count.textContent = String(stageLibraryList().length);
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
    stageCloseSearch();
    return;
  } else if (key.length === 1) S.stage.query += key;
  searchPatch();
}

export function stageSearchSubmit(): void {
  stageCloseSearch();
}

export function stageOpenDesktop(): void {
  exitStage();
}

export function stageOpenDesktopSettings(): void {
  exitStage();
  S.settingsSection = "controller";
  setView("settings");
  scheduleRender();
  void loadSettingsView();
}

/** Advanced management lives in the desktop game page; Stage stays a launcher. */
export function stageOpenDesktopGame(key?: string): void {
  const target = key || S.stage.gameKey || stageFocusedKey();
  if (!target) return;
  exitStage();
  setView("library");
  scheduleRender();
  window.setTimeout(() => openEpicModal(target), 80);
}

export function stageResetFilters(): void {
  S.stage.libraryFilter = "all";
  S.stage.libraryStore = "all";
  S.stage.query = "";
  S.stage.focusKey = "";
  scheduleRender();
}

export function stageClearQuery(): void {
  S.stage.query = "";
  scheduleRender();
}

/**
 * Stage shell and route dispatch.
 *
 * The shell owns the one thing every screen shares: the top status line, the
 * chapter spine, the hint bar, the overlay stack and the focus contract. The
 * screens only return the content inside the active layer.
 */

import { currentLanguage, t } from "../../i18n";
import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import type {
  SettingsSection,
  StageAchievementFilter,
  StageLibraryFilter,
  StageProgramTab,
  StageRoute,
  StageSettingsTab,
} from "../../core/types";
import { esc } from "../../core/utils";
import { activateGamepadFocus, moveGamepadFocus, setGamepadFocus } from "../gamepad/gamepad";
import {
  stageBack,
  stageCancelSearch,
  stageClearCollection,
  stageCloseControls,
  stageCloseStill,
  stageCloudBackup,
  stageCycleSettingsTab,
  stageCycleSort,
  stageCycleStore,
  stageGo,
  stageOpenCollection,
  stageOpenDesktop,
  stageOpenDesktopGame,
  stageOpenDesktopSettings,
  stageOpenDesktopSettingsSection,
  stageOpenProgram,
  stageOpenQuickMenu,
  stageOpenSearch,
  stageOpenStill,
  stageRefreshAchievements,
  stageResetFilters,
  stageSearchInput,
  stageSearchKey,
  stageSearchSubmit,
  stageSetAchievementFilter,
  stageSetFilter,
  stageSetSettingsTab,
  stageSetTab,
  stageShowControls,
  stageStillStep,
  stageToggleControls,
  stageToggleFavorite,
  stageToggleView,
} from "./stage-actions";
import {
  setStageHaptics,
  setStageSafeArea,
  setStageSound,
  setStageSoundVolume,
  setStageTextScale,
} from "./stage-state";
import { stageLaunchGame } from "./stage-launch";
import { renderStageDownloads } from "./stage-downloads";
import { renderStageHome, stageHomeFocus } from "./stage-home";
import { renderStageLibrary, stageLibraryFocus, stageLibraryMore, stageLibraryRenderToken } from "./stage-library";
import { stageGameByKey } from "./stage-model";
import { renderStageProgram } from "./stage-program";
import { renderStageSearch } from "./stage-search";
import { renderStageSettings } from "./stage-settings";
import { resetStageBackdrop, stageBackdropMarkup, updateStageBackdrop } from "./stage-backdrop";
import { stageWideArt } from "./stage-art";
import { fullShotSrc } from "../screenshots/screenshots-view";
// Side effect: register the button/back contract with the gamepad loop.
import "./stage-input";
import { previewStageSound, stageFeedback } from "./stage-sound";
import { stageActiveDownload, stageBatteryLabel, stageBumperGlyphs, stageFaceGlyph, stageHint, stageHintBar } from "./stage-ui";

let clockTimer = 0;
let focusBound = false;
let wasQuickMenu = false;
let wasControls = false;
let wasSearch = false;
let wasLaunch = false;
let wasError = false;
let wasSettingsTab = "";
let lastStageSignature = "";
let pointerFocus = false;

/**
 * The shell should repaint when the screen changes, not when a download ticks.
 * Focus changes are deliberately absent: they are patched in place by the
 * focus event, so moving across a shelf never rebuilds the shelf.
 */
function stageLiveSignature(): string {
  const download = stageActiveDownload();
  const downloadProgress = S.stage.route === "downloads" || S.stage.quickMenu
    ? Array.from(S.downloads.entries()).map(([id, item]) => `${id}:${Math.round(item.progress)}`).join(",") +
      `:${Math.round(S.activeDlMetrics?.progress ?? 0)}`
    : "";
  return [
    S.stage.route,
    S.stage.gameKey ?? "",
    S.stage.programTab,
    S.stage.settingsTab,
    S.stage.achievementFilter,
    S.stage.collectionId ?? "",
    String(S.stage.stillIndex ?? -1),
    S.stage.stillApp ?? "",
    String(S.stage.textScale),
    String(S.stage.safeArea),
    S.stage.sound ? "1" : "0",
    String(S.stage.soundVolume),
    S.stage.haptics ? "1" : "0",
    S.stage.autoEnter ? "1" : "0",
    S.stage.openAtLaunch ? "1" : "0",
    S.reduceEffects ? "1" : "0",
    S.stage.libraryFilter,
    S.stage.libraryStore,
    S.stage.librarySort,
    S.stage.libraryView,
    S.stage.searchOpen ? "" : S.stage.query,
    S.stage.searchOpen ? "1" : "0",
    S.stage.quickMenu ? "1" : "0",
    S.stage.controlsOpen ? "1" : "0",
    S.stage.launch?.key ?? "",
    S.stage.launchError,
    String(S.loadedAchievements.size),
    String(S.loadingAchFor.size),
    S.stage.gameKey
      ? [
          S.loadedAchievements.get(S.stage.gameKey)?.user_unlocked ?? -1,
          S.loadedAchievements.get(S.stage.gameKey)?.total_achievements ?? -1,
          S.loadedAchievements.get(S.stage.gameKey)?.achievements.length ?? -1,
        ].join("/")
      : "",
    String(S.loadedScreenshots.size),
    String(S.loadingScreenshotsFor.size),
    String(S.screenshotFullSrc.size),
    S.stage.gameKey ? (S.loadedScreenshots.get(S.stage.gameKey)?.[0]?.file_path ?? "") : "",
    S.stage.controllerConnected ? "1" : "0",
    String(Math.round((S.stage.controllerBattery ?? -1) * 100)),
    S.offlineMode ? "1" : "0",
    navigator.onLine ? "1" : "0",
    S.appLanguage,
    String(S.libraryDataRev),
    [S.epicSummaries.length, S.gogSummaries.length, S.steamSummaries.length, S.amazonSummaries.length, S.companionSummaries.length, S.customSummaries.length].join(","),
    S.epicRecent.join(","),
    String(S.epicFav.size),
    Array.from(S.gameStatus).sort().join(","),
    String(S.hiddenGames.size),
    Array.from(S.enabledStores).sort().join(","),
    S.separateCopies ? "1" : "0",
    S.showSharedLibrary ? "1" : "0",
    String(S.epicCopyOverrides.size),
    String(S.ignoredUpdates.size),
    String(S.playtimeMap.size),
    String(S.customGames.length),
    String(S.epicCollections.length),
    Array.from(S.runningGames).sort().join(","),
    String(S.availableUpdates.size),
    String(S.gogUpdates.size),
    String(S.downloads.size),
    download?.title ?? "",
    S.activeDlMetrics?.done ? "1" : "0",
    S.dlQueueStatus.isPaused ? "1" : "0",
    S.gogDlPaused ? "1" : "0",
    S.dlQueueStatus.active ?? "",
    S.dlQueueStatus.queue.join(","),
    S.activeDlMetrics?.speed ?? "",
    S.activeDlMetrics?.eta ?? "",
    String(S.activeDlMetrics?.downloadedBytes ?? -1),
    String(S.activeDlMetrics?.totalBytes ?? -1),
    S.stage.gameKey ? String(S.playtimeMap.get(S.stage.gameKey)?.total_seconds ?? -1) : "",
    downloadProgress,
    stageLibraryRenderToken(),
  ].join("\u001f");
}

/** Live counters that can update without rebuilding a shelf. */
function patchLiveStage(): void {
  const download = stageActiveDownload();
  if (!download) return;
  const chip = document.querySelector<HTMLElement>(".stage-top-download");
  if (!chip) return;
  const percent = Math.max(0, Math.min(100, Math.round(download.percent)));
  const label = chip.querySelector<HTMLElement>("span");
  if (label) label.textContent = `${percent}%`;
  const bar = chip.querySelector<HTMLElement>("i");
  if (bar) bar.style.width = `${Math.max(2, percent)}%`;
}

function clockText(): string {
  try {
    return new Date().toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function paintClock(): void {
  const node = document.querySelector<HTMLElement>(".stage-clock");
  if (node) node.textContent = clockText();
}

function startClock(): void {
  paintClock();
  if (clockTimer) return;
  clockTimer = window.setInterval(paintClock, 15_000);
}

function stopClock(): void {
  if (clockTimer) window.clearInterval(clockTimer);
  clockTimer = 0;
}

function firstFocusable(container: HTMLElement): HTMLElement | null {
  if (container.matches("button:not([disabled]), input:not([disabled]), [data-gp-item]")) return container;
  return container.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), [data-gp-item]");
}

/** Only the top overlay participates in controller navigation. */
function markFocusables(layer: HTMLElement | null): void {
  const root = document.getElementById("stage-root");
  if (!root) return;
  root.querySelectorAll<HTMLElement>("[data-gp-item]").forEach((el) => el.removeAttribute("data-gp-item"));
  if (!layer) return;
  layer.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])").forEach((el) => {
    if (el.closest("[data-gp-skip]")) return;
    el.setAttribute("data-gp-item", "");
  });
}

function restoreFocus(layer: HTMLElement | null): void {
  if (!layer) {
    setGamepadFocus(null);
    return;
  }
  const key = S.stage.focusKey;
  let target: HTMLElement | null = null;
  if (key) {
    try {
      target = layer.querySelector<HTMLElement>(`[data-gp-key="${CSS.escape(key)}"]`);
    } catch {
      target = null;
    }
  }
  if (!target) {
    const fallback = layer.querySelector<HTMLElement>("[data-gp-default]");
    target = fallback ? firstFocusable(fallback) : firstFocusable(layer);
  }
  if (!target) {
    setGamepadFocus(null);
    return;
  }
  if (target instanceof HTMLInputElement && target.id === "stage-search-input") {
    const end = target.value.length;
    target.setSelectionRange(end, end);
  }
  if (target.dataset.gpKey) S.stage.focusKey = target.dataset.gpKey;
  setGamepadFocus(target);
}

function topbar(): string {
  const dl = stageActiveDownload();
  const pad = S.stage.controllerConnected;
  const battery = stageBatteryLabel();
  const online = navigator.onLine && !S.offlineMode;
  const kind = S.gamepadKind;
  const lbGlyph = kind === "playstation" ? "L1" : "LB";
  const rbGlyph = kind === "playstation" ? "R1" : "RB";
  const selectGlyph = kind === "playstation" ? "Share" : kind === "xbox" ? "View" : "Select";

  const navTab = (route: StageRoute, label: string): string => {
    const active = S.stage.route === route;
    return `<button type="button" class="stage-nav-tab${active ? " active" : ""}" data-stage-act="go" data-route="${route}" data-gp-item data-gp-key="nav:${route}">
      <span>${esc(label)}</span>
      ${route === "downloads" && dl ? `<span class="stage-nav-badge tabular-nums">${Math.round(dl.percent)}%</span>` : ""}
    </button>`;
  };

  return `<header class="stage-topbar">
    <div class="stage-topbar-left">
      <div class="stage-brand">
        <span class="stage-brand-name">EFXLVE</span>
        <span class="stage-brand-mode">STAGE</span>
      </div>
      <nav class="stage-top-nav" aria-label="${esc(t("stage.navHome"))}">
        <span class="stage-bumper-hint is-left">${lbGlyph}</span>
        ${navTab("home", t("stage.navHome"))}
        ${navTab("library", t("stage.navLibrary"))}
        ${navTab("downloads", t("stage.navDownloads"))}
        ${navTab("settings", t("stage.navSettings"))}
        <span class="stage-bumper-hint is-right">${rbGlyph}</span>
      </nav>
    </div>
    <div class="stage-topbar-right">
      <button type="button" class="stage-icon-pill" data-stage-act="open-search" data-gp-item data-gp-key="top:search" aria-label="${esc(t("stage.search"))}" title="${esc(t("stage.search"))}">
        ${icon("search", 16)}
      </button>
      ${dl ? `<button type="button" class="stage-top-download" data-stage-act="go" data-route="downloads" data-gp-item data-gp-key="top:downloads">${icon("download", 15)}<span class="tabular-nums">${Math.round(dl.percent)}%</span><i style="width:${Math.max(2, Math.min(100, dl.percent))}%"></i></button>` : ""}
      <span class="stage-net ${online ? "is-online" : "is-offline"}"><span class="stage-net-dot"></span><span class="stage-net-label">${esc(online ? t("nav.online") : t("nav.offline"))}</span></span>
      ${pad ? `<span class="stage-pad-status" title="${esc(S.stage.controllerName)}">${icon("gamepad-2", 15)}${battery ? `<span class="tabular-nums">${esc(battery)}</span>` : ""}</span>` : ""}
      <span class="stage-clock tabular-nums"></span>
      <button type="button" class="stage-icon-pill" data-stage-act="open-menu" data-gp-item data-gp-key="top:menu" aria-label="${esc(t("stage.quickMenu"))}" title="${esc(t("stage.quickMenu"))}">${icon("dots", 18)}</button>
    </div>
  </header>`;
}

function hints(): string {
  const pad = S.stage.controllerConnected || S.gamepadPolling;
  const face = (b: "a" | "b" | "x" | "y") => stageFaceGlyph(b);
  const bumpers = stageBumperGlyphs();
  if (S.stage.searchOpen) {
    return stageHintBar([
      stageHint(face("a"), t("gamepad.select")),
      stageHint(face("b"), t("common.close")),
      stageHint(pad ? "↑↓←→" : "↑ ↓", t("gamepad.navigate")),
    ]);
  }
  if (S.stage.quickMenu) {
    return stageHintBar([
      stageHint(face("a"), t("gamepad.select")),
      stageHint(face("b"), t("stage.closeMenu")),
    ]);
  }
  if (S.stage.route === "program") {
    return stageHintBar([
      stageHint(face("a"), t("gamepad.select")),
      stageHint(face("x"), t("stage.quickPlay")),
      stageHint(bumpers, t("gamepad.tabs")),
      stageHint(face("b"), t("common.back")),
      stageHint("Menu", t("stage.quickMenu")),
    ]);
  }
  if (S.stage.route === "library") {
    return stageHintBar([
      stageHint(face("a"), t("stage.open")),
      stageHint(face("x"), t("stage.quickPlay")),
      stageHint(face("y"), S.stage.libraryView === "grid" ? t("stage.viewList") : t("stage.viewGrid")),
      stageHint("L2 / R2", t("stage.storeFilter")),
      stageHint("View", t("stage.search")),
      stageHint("Menu", t("stage.quickMenu")),
    ]);
  }
  if (S.stage.route === "downloads") {
    return stageHintBar([
      stageHint(face("a"), t("gamepad.select")),
      stageHint(face("b"), t("common.back")),
      stageHint(bumpers, t("gamepad.tabs")),
      stageHint("Menu", t("stage.quickMenu")),
    ]);
  }
  if (S.stage.route === "settings") {
    return stageHintBar([
      stageHint(face("a"), t("gamepad.select")),
      stageHint(bumpers, t("gamepad.tabs")),
      stageHint(face("b"), t("common.back")),
      stageHint("Menu", t("stage.quickMenu")),
    ]);
  }
  return stageHintBar([
    stageHint(face("a"), t("stage.open")),
    stageHint(face("x"), t("stage.quickPlay")),
    stageHint(bumpers, t("gamepad.tabs")),
    stageHint("Menu", t("stage.quickMenu")),
  ]);
}

function quickMenu(entered: boolean): string {
  const dl = stageActiveDownload();
  const pad = S.stage.controllerConnected
    ? `${S.stage.controllerName || t("stage.controller")} · ${stageBatteryLabel()}`
    : t("stage.noController");
  return `<div class="stage-overlay stage-quick-menu${entered ? " stage-overlay-enter" : ""}">
    <div class="stage-dock-panel" role="dialog" aria-modal="true" aria-label="${esc(t("stage.quickMenu"))}">
      <div class="stage-dock-head">
        <span class="stage-dock-kicker">${esc(t("stage.quickMenu"))}</span>
        <span class="stage-dock-status tabular-nums">${esc(pad)}</span>
      </div>
      <div class="stage-dock-items" data-gp-row>
        <button type="button" class="stage-dock-item" data-stage-act="go" data-route="home" data-gp-item data-gp-key="dock:home">
          <span class="stage-dock-icon">${icon("home", 22)}</span>
          <span class="stage-dock-text">${esc(t("stage.navHome"))}</span>
        </button>
        <button type="button" class="stage-dock-item" data-stage-act="go" data-route="library" data-gp-item data-gp-key="dock:library">
          <span class="stage-dock-icon">${icon("layout-grid", 22)}</span>
          <span class="stage-dock-text">${esc(t("stage.navLibrary"))}</span>
        </button>
        <button type="button" class="stage-dock-item" data-stage-act="go" data-route="downloads" data-gp-item data-gp-key="dock:downloads">
          <span class="stage-dock-icon">${icon("download", 22)}</span>
          <span class="stage-dock-text">${esc(t("stage.navDownloads"))}</span>
          ${dl ? `<span class="stage-dock-badge tabular-nums">${Math.round(dl.percent)}%</span>` : ""}
        </button>
        <button type="button" class="stage-dock-item" data-stage-act="controls" data-gp-item data-gp-key="dock:controls">
          <span class="stage-dock-icon">${icon("gamepad-2", 22)}</span>
          <span class="stage-dock-text">${esc(t("stage.controller"))}</span>
        </button>
        <button type="button" class="stage-dock-item" data-stage-act="go" data-route="settings" data-gp-item data-gp-key="dock:settings">
          <span class="stage-dock-icon">${icon("sliders", 22)}</span>
          <span class="stage-dock-text">${esc(t("stage.navSettings"))}</span>
        </button>
        <button type="button" class="stage-dock-item stage-dock-danger" data-stage-act="desktop" data-gp-item data-gp-key="dock:desktop">
          <span class="stage-dock-icon">${icon("external", 22)}</span>
          <span class="stage-dock-text">${esc(t("stage.exit"))}</span>
        </button>
      </div>
      <div class="stage-dock-hints">
        <span>${stageFaceGlyph("a")} ${esc(t("gamepad.select"))}</span>
        <span>${stageFaceGlyph("b")} ${esc(t("stage.closeMenu"))}</span>
      </div>
    </div>
  </div>`;
}

function controlsSheet(entered: boolean): string {
  const rows: Array<[string, string]> = [
    [stageFaceGlyph("a"), t("stage.controlsA")],
    [stageFaceGlyph("b"), t("stage.controlsB")],
    [stageFaceGlyph("x"), t("stage.controlsX")],
    [stageFaceGlyph("y"), t("stage.controlsY")],
    [stageBumperGlyphs(), t("stage.controlsBumpers")],
    ["↑ ↓ ← →", t("stage.controlsDpad")],
    ["Menu", t("stage.quickMenu")],
    ["View", t("stage.search")],
  ];
  return `<div class="stage-overlay stage-controls${entered ? " stage-overlay-enter" : ""}">
    <div class="stage-sheet stage-sheet-narrow" role="dialog" aria-modal="true" aria-label="${esc(t("stage.controls"))}">
      <div class="stage-sheet-head">
        <div><span class="stage-kicker">${esc(t("stage.controller"))}</span><h2>${esc(S.stage.controllerName || t("stage.controls"))}</h2></div>
        <button type="button" class="stage-icon-btn" data-stage-act="close-controls" data-gp-item data-gp-key="controls:close" aria-label="${esc(t("common.close"))}">${icon("x", 20)}</button>
      </div>
      <div class="stage-controls-grid">
        ${rows.map(([glyph, label]) => `<div class="stage-controls-row"><span class="stage-controls-glyph">${glyph}</span><span>${esc(label)}</span></div>`).join("")}
      </div>
      <div class="stage-sheet-foot">
        <span class="stage-sheet-note">${esc(t("stage.controlsHint"))}</span>
      </div>
    </div>
  </div>`;
}

function curtain(entered: boolean): string {
  const launch = S.stage.launch;
  if (!launch) return "";
  return `<div class="stage-overlay stage-curtain${entered ? " stage-overlay-enter" : ""}" aria-live="polite">
    <div class="stage-curtain-art">${launch.art ? `<img src="${esc(launch.art)}" alt="" />` : ""}</div>
    <div class="stage-curtain-shade"></div>
    <div class="stage-curtain-line"></div>
    <div class="stage-curtain-copy">
      <span class="stage-kicker">${esc(t("stage.launching"))}</span>
      <h1>${esc(launch.title)}</h1>
      <span class="stage-curtain-dots"><i></i><i></i><i></i></span>
    </div>
  </div>`;
}

function launchError(entered: boolean): string {
  if (!S.stage.launchError) return "";
  return `<div class="stage-overlay stage-error${entered ? " stage-overlay-enter" : ""}">
    <div class="stage-error-card" role="alertdialog" aria-modal="true">
      <span class="stage-error-icon">${icon("alert-triangle", 30)}</span>
      <span class="stage-kicker">${esc(t("stage.launchFailed"))}</span>
      <h2>${esc(S.stage.launchError)}</h2>
      <div class="stage-error-actions">
        <button type="button" class="stage-btn stage-btn-primary" data-stage-act="retry" data-gp-item data-gp-key="error:retry" data-gp-default>${esc(t("stage.retry"))}</button>
        <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="desktop" data-gp-item data-gp-key="error:desktop">${esc(t("stage.openDesktop"))}</button>
        <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="close-error" data-gp-item data-gp-key="error:close">${esc(t("common.close"))}</button>
      </div>
    </div>
  </div>`;
}

function stillViewer(): string {
  const index = S.stage.stillIndex;
  const app = S.stage.stillApp;
  if (index === null || !app) return "";
  const items = S.loadedScreenshots.get(app) || [];
  const item = items[index];
  if (!item) return "";
  const title = stageGameByKey(app)?.title || app;
  const total = items.length;
  return `<div class="stage-overlay stage-still-viewer">
    <div class="stage-still-frame">
      <img src="${esc(fullShotSrc(item))}" alt="${esc(item.file_name)}" />
      <div class="stage-still-caption">
        <strong>${esc(title)}</strong>
        <span>${esc(item.file_name)}</span>
      </div>
      <button type="button" class="stage-icon-btn stage-still-close" data-stage-act="close-still" data-gp-item data-gp-key="still:close" aria-label="${esc(t("common.close"))}">${icon("x", 22)}</button>
      ${total > 1 ? `<button type="button" class="stage-still-nav is-prev" data-stage-act="still-prev" data-gp-item data-gp-key="still:prev" aria-label="${esc(t("stage.stillsPrev"))}">${icon("chevron-left", 30)}</button>
      <button type="button" class="stage-still-nav is-next" data-stage-act="still-next" data-gp-item data-gp-key="still:next" aria-label="${esc(t("stage.stillsNext"))}">${icon("chevron-right", 30)}</button>` : ""}
      <span class="stage-still-count tabular-nums">${index + 1} / ${total}</span>
    </div>
  </div>`;
}

function contentForRoute(): string {
  switch (S.stage.route) {
    case "library": return renderStageLibrary();
    case "program": return renderStageProgram();
    case "downloads": return renderStageDownloads();
    case "settings": return renderStageSettings();
    default: return renderStageHome();
  }
}

/** Render the whole Stage shell into its own root. */
export function renderStage(): void {
  if (!S.stage.active) {
    document.getElementById("stage-root")?.remove();
    stopClock();
    resetStageBackdrop();
    lastStageSignature = "";
    return;
  }
  const signature = stageLiveSignature();
  if (signature === lastStageSignature && document.getElementById("stage-root")) {
    patchLiveStage();
    return;
  }
  lastStageSignature = signature;
  let root = document.getElementById("stage-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "stage-root";
    root.className = "stage-root";
    document.body.appendChild(root);
  }
  bindStageEvents(root);
  bindGlobalFocus();

  const previousRoute = root.dataset.route || "";
  const routeChanged = previousRoute !== S.stage.route;
  const previousScroll = document.getElementById("stage-main")?.scrollTop ?? 0;
  const quickEntered = S.stage.quickMenu && !wasQuickMenu;
  const controlsEntered = S.stage.controlsOpen && !wasControls;
  const searchEntered = S.stage.searchOpen && !wasSearch;
  const launchEntered = Boolean(S.stage.launch) && !wasLaunch;
  const errorEntered = Boolean(S.stage.launchError) && !wasError;
  const settingsTabChanged = S.stage.settingsTab !== wasSettingsTab;
  wasSettingsTab = S.stage.settingsTab;
  let search = S.stage.searchOpen ? renderStageSearch() : "";
  if (search && searchEntered) {
    search = search.replace('class="stage-search"', 'class="stage-search stage-overlay-enter"');
  }
  const quick = S.stage.quickMenu ? quickMenu(quickEntered) : "";
  const controls = S.stage.controlsOpen ? controlsSheet(controlsEntered) : "";
  const still = S.stage.stillIndex !== null ? stillViewer() : "";
  const cover = S.stage.launch ? curtain(launchEntered) : "";
  const error = launchError(errorEntered);
  wasQuickMenu = S.stage.quickMenu;
  wasControls = S.stage.controlsOpen;
  wasSearch = S.stage.searchOpen;
  wasLaunch = Boolean(S.stage.launch);
  wasError = Boolean(S.stage.launchError);

  if (S.stage.route === "program" && S.stage.gameKey) {
    const summary = stageGameByKey(S.stage.gameKey);
    if (summary) updateStageBackdrop(stageWideArt(summary));
  }

  root.className = `stage-root stage-route-${S.stage.route}${S.stage.route === "program" ? " is-program" : ""}${S.stage.quickMenu ? " is-menu-open" : ""}${S.stage.searchOpen ? " is-search-open" : ""}${S.stage.stillIndex !== null ? " is-still-open" : ""}${S.stage.route === "settings" && settingsTabChanged ? " stage-settings-tab-enter" : ""}`;
  root.dataset.route = S.stage.route;
  root.style.setProperty("--stage-safe", `${S.stage.safeArea * 1.5}vmin`);
  root.innerHTML = `${stageBackdropMarkup()}
  <div class="stage-shell">
    ${topbar()}
    <main id="stage-main" class="stage-main">
      <div class="stage-layer stage-layer-main${routeChanged ? " stage-page-enter" : ""}" data-stage-layer="main">${contentForRoute()}</div>
    </main>
    ${hints()}
  </div>
  ${quick}
  ${controls}
  ${search}
  ${still}
  ${cover}
  ${error}`;

  const main = document.getElementById("stage-main");
  if (main) main.scrollTop = previousRoute === S.stage.route ? previousScroll : 0;

  const layerSelector = error
    ? ".stage-error"
    : cover
      ? ".stage-curtain"
      : still
        ? ".stage-still-viewer"
        : controls
          ? ".stage-controls"
          : quick
            ? ".stage-quick-menu"
            : search
              ? ".stage-search"
              : '[data-stage-layer="main"]';
  const layer = root.querySelector<HTMLElement>(layerSelector);
  markFocusables(layer);
  // An install/manage dialog owns the focus while it is open. The Stage shell
  // can repaint behind it, but it must not steal the ring back.
  if (!modalOpen()) restoreFocus(layer);
  startClock();
  // The render may have advanced the library chunk or normalized the query;
  // recompute so the next pass can take the lightweight patch path.
  lastStageSignature = stageLiveSignature();
}

function bindGlobalFocus(): void {
  if (focusBound) return;
  focusBound = true;
  window.addEventListener("stage:focus", (event) => {
    if (!S.stage.active) return;
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    const key = detail?.key || "";
    const changed = Boolean(key) && key !== S.stage.focusKey;
    if (key) S.stage.focusKey = key;
    if (changed && !pointerFocus) stageFeedback("move");
    if (S.stage.route === "library" && key.startsWith("lib:")) stageLibraryFocus(key);
    if (S.stage.route === "home") {
      if (key.startsWith("game:")) stageHomeFocus(key);
      if (key.startsWith("act:")) {
        const hub = document.getElementById("stage-home-activities");
        if (hub) hub.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (key.startsWith("game:") || key.startsWith("hero:") || key === "home:all-games") {
        const main = document.querySelector(".stage-main");
        if (main && main.scrollTop > 80) {
          main.scrollTo({ top: 0, behavior: "smooth" });
        }
      }
    }
  });
  window.addEventListener("stage-mode", (event) => {
    const active = Boolean((event as CustomEvent<{ active?: boolean }>).detail?.active);
    lastStageSignature = "";
    if (active) startClock();
    else stopClock();
  });
  window.addEventListener("keydown", onStageKeydown, true);
  window.addEventListener("online", () => {
    if (S.stage.active) scheduleRender();
  });
  window.addEventListener("offline", () => {
    if (S.stage.active) scheduleRender();
  });
}

function modalOpen(): boolean {
  return Boolean(document.querySelector(
    ".modal:not(.hidden), .selective-overlay, .confirm-dialog:not(.hidden), .palette-backdrop, #modal-root > div, #install-root > div",
  ));
}

function onStageKeydown(event: KeyboardEvent): void {
  if (!S.stage.active || event.defaultPrevented) return;
  if (modalOpen()) return;
  const input = document.activeElement;
  const inSearchInput = input instanceof HTMLInputElement && input.id === "stage-search-input";
  const key = event.key;

  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "k") {
    event.preventDefault();
    event.stopPropagation();
    stageOpenSearch();
    return;
  }
  if (key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    stageBack();
    return;
  }
  if (inSearchInput) {
    if (key === "ArrowDown") {
      event.preventDefault();
      moveGamepadFocus("down");
    } else if (key === "Enter") {
      event.preventDefault();
      stageSearchSubmit();
    } else if (key === "Backspace" && S.stage.query.length === 0) {
      event.preventDefault();
      stageBack();
    }
    return;
  }
  if (S.stage.searchOpen && key === "Backspace") {
    event.preventDefault();
    stageSearchKey("backspace");
    return;
  }
  if (S.stage.stillIndex !== null && (key === "ArrowLeft" || key === "ArrowRight")) {
    // A viewer steps through stills; the focus ring stays on the nav buttons.
    event.preventDefault();
    event.stopPropagation();
    stageStillStep(key === "ArrowRight");
    return;
  }
  if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
    event.preventDefault();
    event.stopPropagation();
    moveGamepadFocus(key.slice(5).toLowerCase() as "up" | "down" | "left" | "right");
  } else if (key === "Enter" || key === " ") {
    event.preventDefault();
    event.stopPropagation();
    activateGamepadFocus();
  }
}

/* ---------- Event delegation ---------- */

function bindStageEvents(root: HTMLElement): void {
  if (root.dataset.eventsBound === "1") return;
  root.dataset.eventsBound = "1";

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;

    // The shared primary-action markup still carries `data-act="epic-play"`.
    // Stage owns that click so the launch curtain runs; stopping the bubble
    // keeps the document router from launching a second time.
    const launchEl = target?.closest<HTMLElement>(
      '[data-act="epic-play"], [data-act="amazon-play"], [data-act="steam-action"][data-mode="launch"]',
    );
    if (launchEl) {
      event.preventDefault();
      event.stopPropagation();
      const act = launchEl.dataset.act;
      const id = launchEl.dataset.id || "";
      if (act === "amazon-play") stageLaunchGame(`amazon::${id}`);
      else if (act === "steam-action") stageLaunchGame(`steam::${id}`);
      else stageLaunchGame(id);
      return;
    }

    const actionEl = target?.closest<HTMLElement>("[data-stage-act]");
    if (!actionEl) return;
    const action = actionEl.dataset.stageAct || "";
    const key = actionEl.dataset.key || "";
    const route = actionEl.dataset.route as StageRoute | undefined;
    const filter = actionEl.dataset.filter as StageLibraryFilter | undefined;
    const tab = actionEl.dataset.tab as StageProgramTab | undefined;
    const settingsTab = actionEl.dataset.tab as StageSettingsTab | undefined;
    const achFilter = actionEl.dataset.filter as StageAchievementFilter | undefined;
    const section = actionEl.dataset.section as SettingsSection | undefined;
    const value = Number(actionEl.dataset.value);
    const index = Number(actionEl.dataset.index);
    switch (action) {
      case "go": if (route) stageGo(route); break;
      case "open-program": {
        stageOpenProgram(key);
        if (tab) stageSetTab(tab);
        break;
      }
      case "back": stageBack(); break;
      case "favorite": { void stageToggleFavorite(key); break; }
      case "set-filter": if (filter) stageSetFilter(filter); break;
      case "set-tab": if (tab) stageSetTab(tab); break;
      case "cycle-store": stageCycleStore(true); break;
      case "cycle-sort": stageCycleSort(); break;
      case "toggle-view": stageToggleView(); break;
      case "open-search":
      case "search": stageOpenSearch(); break;
      case "search-close": stageFeedback("back"); stageCancelSearch(); break;
      case "search-key": stageSearchKey(actionEl.dataset.key || ""); break;
      case "search-submit": stageSearchSubmit(); break;
      case "open-menu": stageOpenQuickMenu("menu:resume"); break;
      case "close-menu": S.stage.quickMenu = false; S.stage.controlsOpen = false; S.stage.focusKey = ""; scheduleRender(); break;
      case "controls": stageToggleControls(); break;
      case "show-controls": stageShowControls(); break;
      case "close-controls": stageFeedback("back"); stageCloseControls(); break;
      case "scroll-to-hub": {
        const hub = document.getElementById("stage-home-activities");
        if (hub) hub.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
      case "desktop": stageOpenDesktop(); break;
      case "desktop-settings": stageOpenDesktopSettings(); break;
      case "desktop-game": stageOpenDesktopGame(key); break;
      case "reset-filters": stageResetFilters(); break;
      case "clear-query": S.stage.query = ""; S.stage.focusKey = "tool:search"; scheduleRender(); break;
      case "open-collection": stageOpenCollection(actionEl.dataset.id || ""); break;
      case "clear-collection": stageClearCollection(); break;
      case "set-settings-tab": if (settingsTab) stageSetSettingsTab(settingsTab); break;
      case "cycle-settings-tab": stageCycleSettingsTab(true); break;
      case "set-ach-filter": if (achFilter) stageSetAchievementFilter(achFilter); break;
      case "refresh-achievements": stageRefreshAchievements(key); break;
      case "open-still": stageOpenStill(index, key); break;
      case "close-still": stageCloseStill(); break;
      case "still-prev": stageStillStep(false); break;
      case "still-next": stageStillStep(true); break;
      case "cloud-backup": stageCloudBackup(key); break;
      case "desktop-settings-section": if (section) stageOpenDesktopSettingsSection(section); break;
      case "set-stage-text": if (Number.isFinite(value)) setStageTextScale(value); break;
      case "set-stage-safe": if (Number.isFinite(value)) setStageSafeArea(value); break;
      case "set-stage-volume": if (Number.isFinite(value)) setStageSoundVolume(value); break;
      case "toggle-stage-sound": setStageSound(!S.stage.sound); break;
      case "toggle-stage-haptics": setStageHaptics(!S.stage.haptics); break;
      case "test-stage-sound": previewStageSound(); break;
      case "retry": S.stage.launchError = ""; stageLaunchGame(S.stage.gameKey || ""); break;
      case "close-error": S.stage.launchError = ""; scheduleRender(); break;
      default: break;
    }
  });

  root.addEventListener("pointerover", (event) => {
    if (!S.stage.active || modalOpen()) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-gp-item]") : null;
    if (!target) return;
    // Pointer movement moves the ring but must not chirp like a D-pad.
    pointerFocus = true;
    setGamepadFocus(target);
    pointerFocus = false;
  });

  // Stage is a controller surface, not a desktop page: the library context
  // menu and its hover cards do not belong here.
  root.addEventListener("contextmenu", (event) => {
    if (S.stage.active) event.preventDefault();
  });

  root.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.id === "stage-search-input" && S.stage.searchOpen) {
      stageSearchInput(target.value);
    }
  });

  // The shelf renders in 96-card chunks. Reaching the fold appends the next
  // chunk without a visible button, so the controller never hits a dead end.
  root.addEventListener("scroll", () => {
    if (!S.stage.active || S.stage.route !== "library" || S.stage.searchOpen || S.stage.quickMenu) return;
    const main = document.getElementById("stage-main");
    if (!main) return;
    if (main.scrollTop + main.clientHeight >= main.scrollHeight - 480 && stageLibraryMore()) {
      scheduleRender();
    }
  }, true);
}





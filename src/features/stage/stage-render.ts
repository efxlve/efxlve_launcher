/**
 * Stage shell and route dispatch.
 *
 * The shell owns the one thing every screen shares: the top status line and
 * navigation, the ambient backdrop, the hint bar, the overlay stack and the
 * focus contract. The screens only return the content inside the active layer.
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
import { esc, fmtBytes } from "../../core/utils";
import { libraryItemOf, sourceOfKey } from "../../core/selectors";
import { activateGamepadFocus, moveGamepadFocus, setGamepadFocus } from "../gamepad/gamepad";
import {
  stageBack,
  stageCancelSearch,
  stageClearCollection,
  stageCloseControls,
  stageCloseManage,
  stageCloseStill,
  stageCloudBackup,
  stageCycleSection,
  stageCycleSettingsTab,
  stageCycleSort,
  stageCycleStore,
  stageCycleTab,
  stageGo,
  stageManageAskUninstall,
  stageManageCancelUninstall,
  stageManageConfirmUninstall,
  stageManageOpenFolder,
  stageManageShortcut,
  stageManageVerify,
  stageOpenCollection,
  stageOpenDesktop,
  stageOpenDesktopGame,
  stageOpenDesktopSettings,
  stageOpenDesktopSettingsSection,
  stageOpenManage,
  stageOpenProgram,
  stageOpenQuickMenu,
  stageOpenSearch,
  stageOpenStill,
  stageQuickPlay,
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
  stageToggleQuickMenu,
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
import { patchStageDownloads, renderStageDownloads } from "./stage-downloads";
import { renderStageHome, stageHomeFocus } from "./stage-home";
import { renderStageLibrary, stageLibraryFocus, stageLibraryMore, stageLibraryRenderToken } from "./stage-library";
import { stageGameByKey, stageHeroSummary } from "./stage-model";
import { renderStageProgram } from "./stage-program";
import { renderStageSearch } from "./stage-search";
import { renderStageSettings } from "./stage-settings";
import { resetStageBackdrop, stageBackdropMarkup, updateStageBackdrop } from "./stage-backdrop";
import { stageCoverMarkup, stageWideArt } from "./stage-art";
import { fullShotSrc } from "../screenshots/screenshots-view";
// Side effect: register the button/back contract with the gamepad loop.
import "./stage-input";
import { previewStageSound, stageFeedback } from "./stage-sound";
import {
  stageActiveDownload,
  stageBatteryLabel,
  stageBumperGlyphs,
  stageFaceGlyph,
  stageHint,
  stageHintBar,
  stageKeyGlyph,
  stageStoreName,
} from "./stage-ui";

let clockTimer = 0;
let focusBound = false;
let wasQuickMenu = false;
let wasControls = false;
let wasManage = false;
let wasSearch = false;
let wasLaunch = false;
let wasError = false;
let wasSettingsTab = "";
let lastStageSignature = "";
let pointerFocus = false;
export type StageInputMode = "gamepad" | "keyboard" | "mouse";
let stageInputMode: StageInputMode = S.stage.controllerConnected ? "gamepad" : "keyboard";

export function setStageGamepadMode(): void {
  if (stageInputMode !== "gamepad") {
    stageInputMode = "gamepad";
    scheduleRender();
  }
}

/**
 * The shell should repaint when the screen changes, not when a download ticks.
 * Focus changes are deliberately absent: they are patched in place by the
 * focus event, so moving across a shelf never rebuilds the shelf.
 */
function stageLiveSignature(): string {
  const download = stageActiveDownload();
  return [
    stageInputMode,
    S.stage.route,
    S.stage.gameKey ?? "",
    S.stage.homeHeroKey ?? "",
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
    S.stage.manageKey ?? "",
    S.stage.manageConfirmUninstall ? "1" : "0",
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
    S.stage.gameKey ? String(S.playtimeMap.get(S.stage.gameKey)?.total_seconds ?? -1) : "",
    stageLibraryRenderToken(),
  ].join("\u001f");
}

/** Live counters that can update without rebuilding a shelf. */
function patchLiveStage(): void {
  const download = stageActiveDownload();
  if (download) {
    const percent = Math.max(0, Math.min(100, Math.round(download.percent)));
    const chip = document.querySelector<HTMLElement>(".stage-top-download");
    if (chip) {
      const label = chip.querySelector<HTMLElement>("span");
      if (label) label.textContent = `${percent}%`;
      const bar = chip.querySelector<HTMLElement>("i");
      if (bar) bar.style.width = `${Math.max(2, percent)}%`;
    }
    const badge = document.querySelector<HTMLElement>(".stage-dock-badge");
    if (badge) badge.textContent = `${percent}%`;
  }
  if (S.stage.route === "downloads") patchStageDownloads();
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
  const isKbd = stageInputMode === "keyboard" || stageInputMode === "mouse";
  const pad = S.stage.controllerConnected;
  const battery = stageBatteryLabel();
  const online = navigator.onLine && !S.offlineMode;
  const kind = S.gamepadKind;
  const lbGlyph = isKbd ? "Q" : (kind === "playstation" ? "L1" : "LB");
  const rbGlyph = isKbd ? "E" : (kind === "playstation" ? "R1" : "RB");
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
        <span class="stage-beta-chip">${esc(t("stage.beta"))}</span>
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
      <button type="button" class="stage-icon-pill" data-stage-act="open-search" data-gp-item data-gp-key="top:search" aria-label="${esc(t("stage.search"))}">
        ${icon("search", 16)}
      </button>
      ${dl ? `<button type="button" class="stage-top-download" data-stage-act="go" data-route="downloads" data-gp-item data-gp-key="top:downloads">${icon("download", 15)}<span class="tabular-nums">${Math.round(dl.percent)}%</span><i style="width:${Math.max(2, Math.min(100, dl.percent))}%"></i></button>` : ""}
      <span class="stage-net ${online ? "is-online" : "is-offline"}"><span class="stage-net-dot"></span><span class="stage-net-label">${esc(online ? t("nav.online") : t("nav.offline"))}</span></span>
      ${pad ? `<span class="stage-pad-status">${icon("gamepad-2", 15)}${battery ? `<span class="tabular-nums">${esc(battery)}</span>` : ""}</span>` : ""}
      <span class="stage-clock tabular-nums"></span>
      <button type="button" class="stage-icon-pill" data-stage-act="open-menu" data-gp-item data-gp-key="top:menu" aria-label="${esc(t("stage.quickMenu"))}">${icon("dots", 18)}</button>
    </div>
  </header>`;
}

function faceOrKey(b: "a" | "b" | "x" | "y"): string {
  const isKbd = stageInputMode === "keyboard" || stageInputMode === "mouse";
  if (isKbd) {
    if (b === "a") return stageKeyGlyph("Enter");
    if (b === "b") return stageKeyGlyph("Esc");
    if (b === "x") return stageKeyGlyph("X");
    if (b === "y") return stageKeyGlyph("F");
  }
  return stageFaceGlyph(b);
}

function hints(): string {
  const isKbd = stageInputMode === "keyboard" || stageInputMode === "mouse";
  const face = (b: "a" | "b" | "x" | "y") => faceOrKey(b);
  const bumpers = isKbd ? `${stageKeyGlyph("Q")} ${stageKeyGlyph("E")}` : stageBumperGlyphs();
  const menuKey = isKbd ? stageKeyGlyph("M") : "Menu";

  if (S.stage.searchOpen) {
    return stageHintBar([
      stageHint(face("a"), t("gamepad.select")),
      stageHint(face("b"), t("common.close")),
      stageHint(isKbd ? "↑↓" : "↑ ↓", t("gamepad.navigate")),
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
      stageHint(menuKey, t("stage.quickMenu")),
    ]);
  }
  if (S.stage.route === "library") {
    return stageHintBar([
      stageHint(face("a"), t("stage.open")),
      stageHint(face("x"), t("stage.quickPlay")),
      stageHint(face("y"), S.stage.libraryView === "grid" ? t("stage.viewList") : t("stage.viewGrid")),
      stageHint(bumpers, t("gamepad.tabs")),
      stageHint(isKbd ? stageKeyGlyph("Tab") : "L2 / R2", t("stage.storeFilter")),
      stageHint(isKbd ? stageKeyGlyph("Ctrl+K") : "View", t("stage.search")),
      stageHint(menuKey, t("stage.quickMenu")),
    ]);
  }
  if (S.stage.route === "downloads") {
    return stageHintBar([
      stageHint(face("a"), t("gamepad.select")),
      stageHint(face("b"), t("common.back")),
      stageHint(bumpers, t("gamepad.tabs")),
      stageHint(menuKey, t("stage.quickMenu")),
    ]);
  }
  if (S.stage.route === "settings") {
    return stageHintBar([
      stageHint(face("a"), t("gamepad.select")),
      stageHint(bumpers, t("gamepad.tabs")),
      stageHint(face("b"), t("common.back")),
      stageHint(menuKey, t("stage.quickMenu")),
    ]);
  }
  return stageHintBar([
    stageHint(face("a"), t("stage.open")),
    stageHint(face("x"), t("stage.quickPlay")),
    stageHint(isKbd ? stageKeyGlyph("↓ / S") : "↓", t("stage.details")),
    stageHint(bumpers, t("gamepad.tabs")),
    stageHint(menuKey, t("stage.quickMenu")),
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
        <span>${faceOrKey("a")} ${esc(t("gamepad.select"))}</span>
        <span>${faceOrKey("b")} ${esc(t("stage.closeMenu"))}</span>
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

function stageManageSheet(appName: string, entered: boolean): string {
  const game = stageGameByKey(appName);
  if (!game) return "";
  const source = sourceOfKey(game.appName);
  const isInstalled = Boolean(game.installed);
  const cloud = Boolean(libraryItemOf(game.appName, source)?.cloudSavesSupported);
  const isConfirming = S.stage.manageConfirmUninstall;

  if (isConfirming) {
    return `<div class="stage-overlay stage-manage-overlay${entered ? " stage-overlay-enter" : ""}">
      <div class="stage-sheet stage-confirm-sheet" role="dialog" aria-modal="true" aria-label="${esc(t("manage.uninstallTitle"))}">
        <div class="stage-confirm-icon is-danger">${icon("trash", 38)}</div>
        <div class="stage-confirm-copy">
          <span class="stage-kicker is-danger">${esc(t("manage.uninstallTitle"))}</span>
          <h2>${esc(game.title)}</h2>
          <p>${esc(t("confirm.uninstallBody"))}</p>
          ${game.installPath ? `<span class="stage-confirm-path tabular-nums">${esc(game.installPath)}</span>` : ""}
        </div>
        <div class="stage-confirm-actions" data-gp-row>
          <button type="button" class="stage-btn stage-btn-danger" data-stage-act="manage-confirm-uninstall" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:confirm-uninstall" data-gp-default>
            ${icon("trash", 18)}
            <span>${esc(t("common.uninstall"))}</span>
          </button>
          <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="manage-cancel-uninstall" data-gp-item data-gp-key="manage:cancel-uninstall">
            <span>${esc(t("common.cancel"))}</span>
          </button>
        </div>
      </div>
    </div>`;
  }

  return `<div class="stage-overlay stage-manage-overlay${entered ? " stage-overlay-enter" : ""}">
    <div class="stage-sheet stage-manage-sheet" role="dialog" aria-modal="true" aria-label="${esc(t("stage.manage"))}: ${esc(game.title)}">
      <div class="stage-manage-header">
        <div class="stage-manage-thumb">
          ${stageCoverMarkup(game)}
        </div>
        <div class="stage-manage-info">
          <div class="stage-manage-badges">
            <span class="stage-badge-store">${esc(stageStoreName(source))}</span>
            <span class="stage-badge-status ${isInstalled ? "is-installed" : "is-not-installed"}">
              <span class="stage-status-dot"></span>
              ${esc(isInstalled ? t("common.installed") : t("common.notInstalled"))}
            </span>
            ${game.installSize > 0 ? `<span class="stage-badge-size tabular-nums">${esc(fmtBytes(game.installSize))}</span>` : ""}
          </div>
          <h2 class="stage-manage-title">${esc(game.title)}</h2>
          ${game.installPath ? `<div class="stage-manage-path tabular-nums">${icon("folder", 14)}<span>${esc(game.installPath)}</span></div>` : ""}
        </div>
        <button type="button" class="stage-manage-close" data-stage-act="close-manage" data-gp-item data-gp-key="manage:close" aria-label="${esc(t("common.close"))}">
          ${icon("x", 20)}
        </button>
      </div>

      <div class="stage-manage-grid" data-gp-row>
        ${isInstalled ? `
          <button type="button" class="stage-manage-card stage-manage-card-highlight" data-stage-act="quick-play" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:play" data-gp-default>
            <span class="stage-manage-card-icon is-play">${icon("play", 22)}</span>
            <div class="stage-manage-card-text">
              <strong>${esc(t("common.play"))}</strong>
              <span>${esc(t("stage.quickPlay"))}</span>
            </div>
          </button>
        ` : `
          <button type="button" class="stage-manage-card stage-manage-card-highlight" data-stage-act="quick-play" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:play" data-gp-default>
            <span class="stage-manage-card-icon is-install">${icon("download", 22)}</span>
            <div class="stage-manage-card-text">
              <strong>${esc(t("common.install"))}</strong>
              <span>${esc(t("stage.installFolder"))}</span>
            </div>
          </button>
        `}

        ${isInstalled ? `
          <button type="button" class="stage-manage-card" data-stage-act="manage-open-folder" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:folder">
            <span class="stage-manage-card-icon">${icon("folder", 20)}</span>
            <div class="stage-manage-card-text">
              <strong>${esc(t("manage.openFolder"))}</strong>
              <span>${esc(t("stage.installFolder"))}</span>
            </div>
          </button>
        ` : ""}

        ${isInstalled ? `
          <button type="button" class="stage-manage-card" data-stage-act="manage-verify" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:verify">
            <span class="stage-manage-card-icon">${icon("shield-check", 20)}</span>
            <div class="stage-manage-card-text">
              <strong>${esc(t("manage.verify"))}</strong>
              <span>${esc(t("manage.verifyTitle"))}</span>
            </div>
          </button>
        ` : ""}

        ${isInstalled ? `
          <button type="button" class="stage-manage-card" data-stage-act="manage-shortcut" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:shortcut">
            <span class="stage-manage-card-icon">${icon("monitor", 20)}</span>
            <div class="stage-manage-card-text">
              <strong>${esc(t("manage.createShortcut"))}</strong>
              <span>${esc(t("manage.shortcutTitle"))}</span>
            </div>
          </button>
        ` : ""}

        ${cloud ? `
          <button type="button" class="stage-manage-card" data-stage-act="manage-sync-cloud" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:cloud">
            <span class="stage-manage-card-icon">${icon("cloud", 20)}</span>
            <div class="stage-manage-card-text">
              <strong>${esc(t("manage.sync"))}</strong>
              <span>${esc(t("stage.cloudBackupNow"))}</span>
            </div>
          </button>
        ` : ""}

        <button type="button" class="stage-manage-card" data-stage-act="favorite" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:fav">
          <span class="stage-manage-card-icon ${S.epicFav.has(game.appName) ? "is-faved" : ""}">${icon("heart", 20)}</span>
          <div class="stage-manage-card-text">
            <strong>${esc(S.epicFav.has(game.appName) ? t("stage.favorited") : t("stage.favorite"))}</strong>
            <span>${esc(t("stage.favorite"))}</span>
          </div>
        </button>

        ${isInstalled ? `
          <button type="button" class="stage-manage-card stage-manage-card-danger" data-stage-act="manage-ask-uninstall" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:uninstall">
            <span class="stage-manage-card-icon is-danger">${icon("trash", 20)}</span>
            <div class="stage-manage-card-text">
              <strong>${esc(t("common.uninstall"))}</strong>
              <span>${esc(t("manage.uninstallTitle"))}</span>
            </div>
          </button>
        ` : ""}
      </div>

      <div class="stage-manage-hints">
        <span>${faceOrKey("a")} ${esc(t("gamepad.select"))}</span>
        <span>${faceOrKey("b")} ${esc(t("common.close"))}</span>
      </div>
    </div>
  </div>`;
}

/** The art behind the shell for the current screen. */
function currentBackdropArt(): string | null {
  if (S.stage.route === "home") {
    const key = S.stage.focusKey.startsWith("game:")
      ? S.stage.focusKey.slice(5)
      : S.stage.homeHeroKey || "";
    const hero = (key ? stageGameByKey(key) : undefined) ?? stageHeroSummary();
    return hero ? stageWideArt(hero) : null;
  }
  if (S.stage.route === "program" && S.stage.gameKey) {
    const game = stageGameByKey(S.stage.gameKey);
    return game ? stageWideArt(game) : null;
  }
  if (S.stage.route === "library") {
    const game = S.stage.previewKey ? stageGameByKey(S.stage.previewKey) : null;
    return game ? stageWideArt(game) : null;
  }
  return null;
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
  const manageEntered = Boolean(S.stage.manageKey) && !wasManage;
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
  const manage = S.stage.manageKey ? stageManageSheet(S.stage.manageKey, manageEntered) : "";
  const still = S.stage.stillIndex !== null ? stillViewer() : "";
  const cover = S.stage.launch ? curtain(launchEntered) : "";
  const error = launchError(errorEntered);
  wasQuickMenu = S.stage.quickMenu;
  wasControls = S.stage.controlsOpen;
  wasManage = Boolean(S.stage.manageKey);
  wasSearch = S.stage.searchOpen;
  wasLaunch = Boolean(S.stage.launch);
  wasError = Boolean(S.stage.launchError);

  root.className = `stage-root stage-route-${S.stage.route}${S.stage.route === "program" ? " is-program" : ""}${S.stage.quickMenu ? " is-menu-open" : ""}${S.stage.manageKey ? " is-manage-open" : ""}${S.stage.searchOpen ? " is-search-open" : ""}${S.stage.stillIndex !== null ? " is-still-open" : ""}${S.stage.route === "settings" && settingsTabChanged ? " stage-settings-tab-enter" : ""}`;
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
  ${manage}
  ${search}
  ${still}
  ${cover}
  ${error}`;

  // The shell is rebuilt above, so the backdrop layers are fresh and empty.
  // Apply the current route's art after the markup exists, not before.
  resetStageBackdrop();
  updateStageBackdrop(currentBackdropArt());

  const main = document.getElementById("stage-main");
  if (main) main.scrollTop = previousRoute === S.stage.route ? previousScroll : 0;

  const layerSelector = error
    ? ".stage-error"
    : cover
      ? ".stage-curtain"
      : still
        ? ".stage-still-viewer"
        : manage
          ? ".stage-manage-overlay"
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
  const lower = key.toLowerCase();

  if (stageInputMode !== "keyboard") {
    stageInputMode = "keyboard";
    scheduleRender();
  }

  if ((event.ctrlKey || event.metaKey) && lower === "k") {
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
  if (S.stage.stillIndex !== null) {
    if (key === "ArrowLeft" || lower === "a" || lower === "q") {
      event.preventDefault();
      event.stopPropagation();
      stageStillStep(false);
      return;
    }
    if (key === "ArrowRight" || lower === "d" || lower === "e") {
      event.preventDefault();
      event.stopPropagation();
      stageStillStep(true);
      return;
    }
    return;
  }

  // Section / Tab cycling: Q and E, or Tab / Shift+Tab, or PageUp / PageDown
  if (lower === "q" || key === "PageUp" || (key === "Tab" && event.shiftKey)) {
    event.preventDefault();
    event.stopPropagation();
    if (S.stage.route === "program") stageCycleTab(false);
    else stageCycleSection(false);
    return;
  }
  if (lower === "e" || key === "PageDown" || (key === "Tab" && !event.shiftKey)) {
    event.preventDefault();
    event.stopPropagation();
    if (S.stage.route === "program") stageCycleTab(true);
    else stageCycleSection(true);
    return;
  }

  // Directional navigation: Arrow keys OR WASD
  if (key === "ArrowUp" || lower === "w") {
    event.preventDefault();
    event.stopPropagation();
    moveGamepadFocus("up");
    return;
  }
  if (key === "ArrowDown" || lower === "s") {
    event.preventDefault();
    event.stopPropagation();
    moveGamepadFocus("down");
    return;
  }
  if (key === "ArrowLeft" || lower === "a") {
    event.preventDefault();
    event.stopPropagation();
    moveGamepadFocus("left");
    return;
  }
  if (key === "ArrowRight" || lower === "d") {
    event.preventDefault();
    event.stopPropagation();
    moveGamepadFocus("right");
    return;
  }

  // Selection / Activation: Enter or Space
  if (key === "Enter" || key === " ") {
    event.preventDefault();
    event.stopPropagation();
    activateGamepadFocus();
    return;
  }

  // Back: Backspace
  if (key === "Backspace") {
    event.preventDefault();
    event.stopPropagation();
    stageBack();
    return;
  }

  // Quick Play: X
  if (lower === "x" && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    stageQuickPlay();
    return;
  }

  // Favorite: F
  if (lower === "f" && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    if (S.stage.route === "program") stageToggleFavorite(S.stage.gameKey ?? undefined);
    else stageToggleFavorite();
    return;
  }

  // Quick Menu: M
  if (lower === "m" && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    stageToggleQuickMenu();
    return;
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

    if (target?.classList.contains("stage-manage-overlay")) {
      stageCloseManage();
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
      case "desktop-game":
      case "manage-game": stageOpenManage(key); break;
      case "close-manage": stageCloseManage(); break;
      case "manage-open-folder": stageManageOpenFolder(key); break;
      case "manage-verify": stageManageVerify(key); break;
      case "manage-shortcut": stageManageShortcut(key); break;
      case "manage-sync-cloud": stageCloudBackup(key || S.stage.manageKey || ""); break;
      case "manage-ask-uninstall": stageManageAskUninstall(key); break;
      case "manage-cancel-uninstall": stageManageCancelUninstall(); break;
      case "manage-confirm-uninstall": stageManageConfirmUninstall(key); break;
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

  // Horizontal mouse wheel scrolling for ribbon and card shelves
  root.addEventListener(
    "wheel",
    (event) => {
      if (!S.stage.active) return;
      const target = event.target instanceof Element ? event.target : null;
      const hRow = target?.closest<HTMLElement>(
        ".stage-ribbon-track, .stage-activity-row, .stage-collection-row, .stage-filter-tabs, .stage-program-tabs",
      );
      if (!hRow) return;

      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        const maxScroll = hRow.scrollWidth - hRow.clientWidth;
        if (maxScroll > 0) {
          event.preventDefault();
          hRow.scrollLeft += event.deltaY * 1.1;
        }
      }
    },
    { passive: false },
  );

  // Mouse drag-to-scroll on horizontal carousels
  let dragTrack: HTMLElement | null = null;
  let startX = 0;
  let startScroll = 0;
  let isDragging = false;
  let dragMoved = false;

  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const hRow = target?.closest<HTMLElement>(
      ".stage-ribbon-track, .stage-activity-row, .stage-collection-row",
    );
    if (!hRow) return;
    dragTrack = hRow;
    startX = event.clientX;
    startScroll = hRow.scrollLeft;
    isDragging = false;
    dragMoved = false;
  });

  window.addEventListener("pointermove", (event) => {
    if (!dragTrack) return;
    const diff = event.clientX - startX;
    if (!isDragging && Math.abs(diff) > 7) {
      isDragging = true;
      dragMoved = true;
    }
    if (isDragging) {
      dragTrack.scrollLeft = startScroll - diff;
    }
  });

  window.addEventListener("pointerup", () => {
    if (dragTrack) {
      if (dragMoved) {
        window.addEventListener(
          "click",
          (e) => {
            e.stopPropagation();
            e.preventDefault();
          },
          { capture: true, once: true },
        );
      }
      dragTrack = null;
      isDragging = false;
      dragMoved = false;
    }
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

  // Switch to mouse input mode on pointer interaction
  root.addEventListener("pointerdown", () => {
    if (stageInputMode !== "mouse") {
      stageInputMode = "mouse";
      scheduleRender();
    }
  });

  // Switch dynamically when gamepad inputs are detected
  window.addEventListener("stage-input-mode", (event) => {
    const mode = (event as CustomEvent<{ mode?: StageInputMode }>).detail?.mode;
    if (mode && stageInputMode !== mode) {
      stageInputMode = mode;
      scheduleRender();
    }
  });
}





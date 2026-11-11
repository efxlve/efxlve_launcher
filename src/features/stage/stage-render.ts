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
import { currentProfileName, getCustomAvatar, globalAvatar, S } from "../../core/state";
import { isSteamDeckDevice } from "../../core/constants";
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
  stageAskDeleteAudio,
  stageBack,
  stageCancelDeleteAudio,
  stageCancelSearch,
  stageChooseCustomAmbience,
  stageChooseGameTrack,
  stageClearCollection,
  stageClearCustomAmbience,
  stageClearGameTrack,
  stageCloseControls,
  stageCloseManage,
  stageCloseStill,
  stageCloudBackup,
  stageConfirmDeleteAudio,
  stageCycleCollection,
  stageCycleSection,
  stageCycleSettingsTab,
  stageCycleSort,
  stageCycleStore,
  stageCycleTab,
  stageGo,
  stageImportAudioFile,
  stageManageAskUninstall,
  stageManageCancelUninstall,
  stageManageConfirmUninstall,
  stageManageOpenFolder,
  stageManageShortcut,
  stageManageVerify,
  stageOpenCollection,
  stageOpenDesktop,
  stageOpenDesktopManage,
  stageOpenDesktopSettings,
  stageOpenDesktopSettingsSection,
  stageOpenManage,
  stageOpenProgram,
  stageOpenQuickMenu,
  stageDismissWelcome,
  stageOpenSearch,
  stagePickRandomGame,
  stageOpenStill,
  stagePreviewAudio,
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
  stageUseAudioForMenu,
} from "./stage-actions";
import {
  setStageAmbience,
  setStageAmbienceVolume,
  setStageAttract,
  setStageCinematic,
  setStageHaptics,
  setStageSafeArea,
  setStageSound,
  setStageSoundVolume,
  setStageTextScale,
} from "./stage-state";
import { stageLaunchGame } from "./stage-launch";
import type { EpicSummary } from "../../epic";
import { epicDlProgress } from "../../core/game-view";
import { patchStageDownloads, renderStageDownloads } from "./stage-downloads";
import { renderStageHome, stageHomeActivitiesHtml, stageHomeFocus, stageHomeHeroHtml } from "./stage-home";
import { renderStageLibrary, stageLibraryFocus, stageLibraryMore, stageLibraryRenderToken, stageLibrarySideHtml } from "./stage-library";
import {
  stageAchievements,
  stageGameByKey,
  stageGamePlaytime,
  stageHasUpdate,
  stageHeroSummary,
} from "./stage-model";
import { renderStageProgram } from "./stage-program";
import { renderStageSearch } from "./stage-search";
import { renderStageSettings } from "./stage-settings";
import {
  renderStageBrowserSheet,
  stageCloseBrowserSheet,
  stageCloseBrowserWindow,
  stageLaunchBrowser,
  stageOpenBrowserSheet,
} from "./stage-browser";
import {
  renderStageSpotifySheet,
  stageCloseSpotifySheet,
  stageOpenSpotifySheet,
  patchStageSpotifyProgress,
  stageSpotifyAction,
  stageSpotifyPlayPlaylist,
} from "./stage-spotify";
import {
  renderStageDiscordSheet,
  stageCloseDiscordSheet,
  stageDiscordConnect,
  stageDiscordHangup,
  stageDiscordOpenApp,
  stageOpenDiscordSheet,
  stageDiscordToggleMute,
} from "./stage-discord";
import { initStageBattery, stageBatteryInfo, stageBatteryMarkup } from "./stage-battery";
import {
  renderStagePowerSheet,
  stageCancelShutdown,
  stageClosePowerSheet,
  stageOpenPowerSheet,
  stageQuickVolume,
  stageShutdownDevice,
  stageSleepDevice,
  stageToggleQuickMute,
} from "./stage-power";
import { resetStageBackdrop, stageBackdropMarkup, updateStageBackdrop } from "./stage-backdrop";
import { stageCoverArt, stageCoverMarkup, stagePoster, stageWideArt } from "./stage-art";
import { stageIntroMarkup, resetStageIntro, skipStageIntro, startStageIntro } from "./stage-intro";
import {
  applyStageAmbienceSettings,
  duckStageAmbience,
  setStageAmbienceScene,
  stageAmbienceActive,
  startStageAmbience,
  stopStageAmbience,
} from "./stage-ambience";
import {
  initStageIdle,
  previewStageIdle,
  refreshStageIdle,
  resetStageIdleTimer,
  stageIdleGreeting,
  touchStageActivity,
  wakeStageIdle,
} from "./stage-idle";
import { fullShotSrc } from "../screenshots/screenshots-view";
import { notesRevision } from "../notes/notes-client";
import { stageAudioCancelDelete, stageAudioPendingDelete, stageAudioRevision } from "./stage-audio-library";
import { stageAudioPreviewName, stageCustomAudioActive, stopStageAudioPreview, stopStageCustomAudio, updateStageCustomAudio } from "./stage-custom-audio";
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
  stageMenuGlyph,
  stageStatus,
  stageStoreName,
  stageTriggerGlyphs,
  stageViewGlyph,
} from "./stage-ui";

let clockTimer = 0;
let focusBound = false;
let wasQuickMenu = false;
let wasControls = false;
let wasManage = false;
let wasSearch = false;
let wasLaunch = false;
let wasError = false;
let wasBrowser = false;
let wasSpotify = false;
let wasDiscord = false;
let wasPower = false;
let wasSettingsTab = "";
let lastStageSignature = "";
let lastCardPatchSig = "";
let introStarted = false;
/* Mouse drag-to-scroll state; the window listeners are bound exactly once. */
let dragTrack: HTMLElement | null = null;
let dragStartX = 0;
let dragStartScroll = 0;
let dragActive = false;
let dragMoved = false;
export type StageInputMode = "gamepad" | "keyboard" | "mouse";
let stageInputMode: StageInputMode = S.stage.controllerConnected ? "gamepad" : "keyboard";

/**
 * The shell should repaint when the screen changes, not when a download ticks.
 * Focus changes are deliberately absent: they are patched in place by the
 * focus event, so moving across a shelf never rebuilds the shelf.
 *
 * The Home shelf is represented by its inputs, not by a fresh sort of the
 * whole library: `stageLiveSignature()` runs on every download tick, and a
 * 600-title `stageRibbonSummaries()` call there was the real cost behind the
 * "constant re-render" feel.
 */
function stageHomeRevision(): string {
  if (S.stage.route !== "home") return "";
  return [
    S.libraryDataRev,
    S.epicRecent.join(","),
    S.separateCopies ? "1" : "0",
    S.hiddenGames.size,
    [...S.enabledStores].sort().join(","),
    [...S.epicCopyOverrides.keys()].sort().join(","),
    S.stage.lastSession?.timestamp ?? 0,
  ].join("\u001f");
}

/** The programme page has no in-place patch; its loaded data is its signature. */
function stageProgramRevision(): string {
  if (S.stage.route !== "program") return "";
  const key = S.stage.gameKey ?? "";
  const game = stageGameByKey(key);
  const ach = S.loadedAchievements.get(key);
  const shots = S.loadedScreenshots.get(key);
  const playtime = S.playtimeMap.get(key);
  return [
    key,
    game ? stageWideArt(game) ?? "" : "",
    S.libraryDataRev,
    S.runningGames.has(key) ? "1" : "0",
    S.epicFav.has(key) ? "1" : "0",
    playtime?.total_seconds ?? 0,
    playtime?.last_played_timestamp ?? 0,
    ach?.user_unlocked ?? -1,
    ach?.user_xp ?? -1,
    ach?.total_achievements ?? -1,
    ach?.achievements?.length ?? -1,
    ach?.hidden?.length ?? -1,
    ach?.is_platinum ? "1" : "0",
    ach?.platinum_rarity?.percent ?? -1,
    shots?.length ?? -1,
    S.loadedHltb.has(key) ? "1" : "0",
    S.loadedCritic.has(key) ? "1" : "0",
    S.stage.gameTracks[key] ?? "",
    S.stage.programTab === "notes" ? notesRevision() : "",
  ].join("\u001f");
}

/** The topbar chip and dock badge need a full render when a transfer starts or ends. */
function activeDownloadKey(): string {
  if (S.activeDlMetrics && !S.activeDlMetrics.done) return S.activeDlMetrics.id;
  for (const [id, item] of S.downloads) if (!item.done) return id;
  return "";
}

function stageDownloadsRevision(): string {
  if (S.stage.route !== "downloads") return "";
  const active: string[] = [];
  for (const [id, item] of S.downloads) if (!item.done) active.push(id);
  active.sort();
  return [
    S.downloads.size,
    active.join(","),
    S.activeDlMetrics?.id ?? "",
    S.dlQueueStatus.active ?? "",
    S.dlQueueStatus.queue.join(","),
    S.dlQueueStatus.isPaused ? "1" : "0",
    S.gogDlPaused ? "1" : "0",
  ].join("\u001f");
}

function stageLiveSignature(): string {
  const homeRevision = stageHomeRevision();
  const programRevision = stageProgramRevision();
  const downloadsRevision = stageDownloadsRevision();
  return [
    stageInputMode,
    S.stage.route,
    S.stage.route === "program" ? (S.stage.gameKey ?? "") : "",
    S.stage.programTab,
    S.stage.settingsTab,
    S.stage.achievementFilter,
    S.stage.collectionId ?? "",
    String(S.stage.stillIndex ?? -1),
    S.stage.stillApp ?? "",
    S.screenshotFullSrc.size,
    String(S.stage.textScale),
    String(S.stage.safeArea),
    S.stage.sound ? "1" : "0",
    String(S.stage.soundVolume),
    S.stage.haptics ? "1" : "0",
    S.stage.ambience ? "1" : "0",
    String(S.stage.ambienceVolume),
    S.stage.customAmbience,
    S.stage.gameTracks[S.stage.gameKey ?? ""] ?? "",
    stageAudioRevision(),
    stageAudioPreviewName(),
    S.stage.cinematic ? "1" : "0",
    S.stage.attract ? "1" : "0",
    S.stage.intro ? "1" : "0",
    stageTimeOfDay(),
    S.stage.autoEnter ? "1" : "0",
    S.stage.openAtLaunch ? "1" : "0",
    S.reduceEffects ? "1" : "0",
    S.stage.libraryFilter,
    S.stage.libraryStore,
    S.stage.librarySort,
    S.stage.libraryView,
    S.stage.searchOpen ? "" : S.stage.query,
    S.stage.searchOpen ? "1" : "0",
    S.stage.searchOpen ? String(S.libraryDataRev) : "",
    S.stage.powerOpen ? `${stageBatteryInfo().level}:${stageBatteryInfo().charging ? "1" : "0"}` : "",
    S.stage.quickMenu ? "1" : "0",
    S.stage.powerOpen ? "1" : "0",
    S.stage.powerConfirm ? "1" : "0",
    S.stage.controlsOpen ? "1" : "0",
    S.stage.browserOpen ? "1" : "0",
    S.stage.spotifyOpen ? "1" : "0",
    S.stage.discordOpen ? "1" : "0",
    S.stage.manageKey ?? "",
    S.stage.manageConfirmUninstall ? "1" : "0",
    S.stage.launch?.key ?? "",
    S.stage.launchError,
    S.stage.controllerConnected ? "1" : "0",
    S.stage.controllerBattery ?? -1,
    [...S.runningGames].sort().join(","),
    S.offlineMode ? "1" : "0",
    navigator.onLine ? "1" : "0",
    S.appLanguage,
    homeRevision,
    programRevision,
    stageLibraryRenderToken(),
    S.stage.route === "library"
      ? `${S.libraryDataRev}\u001f${S.epicRecent.join(",")}`
      : S.stage.route === "downloads"
        ? String(S.libraryDataRev)
        : "",
    downloadsRevision,
    activeDownloadKey(),
    S.availableUpdates.size,
    S.gogUpdates.size,
    S.ignoredUpdates.size,
  ].join("\u001f");
}

function patchStageCoverInCard(card: HTMLElement, s: EpicSummary, className: string): void {
  const coverNode = card.querySelector<HTMLElement>("[data-cover-key]");
  if (!coverNode) return;
  const targetUrl = stageCoverArt(s);

  if (targetUrl) {
    if (coverNode instanceof HTMLImageElement) {
      if (coverNode.getAttribute("src") !== targetUrl) {
        coverNode.src = targetUrl;
      }
    } else {
      const isSteam = s.appName.startsWith("steam::");
      const steamApp = isSteam ? s.appName.slice(7) : "";
      const steamAttr = steamApp ? ` data-steam-app="${esc(steamApp)}" data-art-step="resolved"` : "";
      coverNode.outerHTML = `<img class="${className}" src="${esc(targetUrl)}"${steamAttr} data-cover-key="${esc(s.appName)}" alt="" decoding="async" />`;
    }
  } else if (!targetUrl && coverNode instanceof HTMLImageElement) {
    coverNode.outerHTML = stagePoster(s.title, s.installed ? "" : s.version, s.appName);
  }
}

/** Cheap inputs for the cover/status patch: progress alone never changes them. */
function stageCardPatchSignature(): string {
  const downloads: string[] = [];
  for (const [id, item] of S.downloads) if (!item.done) downloads.push(id);
  downloads.sort();
  const steamDownloads = S.steamSummaries
    .filter((game) => game.downloading)
    .map((game) => game.key)
    .sort();
  return [
    S.libraryDataRev,
    [...S.runningGames].sort().join(","),
    downloads.join(","),
    S.dlQueueStatus.active ?? "",
    S.dlQueueStatus.queue.join(","),
    steamDownloads.join(","),
    S.availableUpdates.size,
    S.gogUpdates.size,
    S.ignoredUpdates.size,
  ].join("\u001f");
}

function patchStageCardsInPlace(): void {
  const root = document.getElementById("stage-root");
  if (!root) return;
  const sig = stageCardPatchSignature();
  if (sig === lastCardPatchSig) return;
  lastCardPatchSig = sig;

  const ribbonCards = root.querySelectorAll<HTMLElement>(".stage-ribbon-card[data-key]");
  for (const card of ribbonCards) {
    const key = card.dataset.key;
    if (!key) continue;
    const s = stageGameByKey(key);
    if (!s) continue;
    patchStageCoverInCard(card, s, "stage-ribbon-image");

    const isRunning = S.runningGames.has(s.appName);
    const hasDl = epicDlProgress(s.appName) !== null;
    const isUpdating = s.updateAvailable && !S.ignoredUpdates.has(s.appName);
    card.classList.toggle("is-running", isRunning);

    const runDot = card.querySelector(".stage-ribbon-running");
    if (isRunning && !runDot) {
      card.insertAdjacentHTML("beforeend", '<span class="stage-ribbon-running"></span>');
    } else if (!isRunning && runDot) {
      runDot.remove();
    }

    const indDot = card.querySelector(".stage-ribbon-indicator");
    const wantInd = !isRunning && (hasDl || isUpdating);
    if (wantInd && !indDot) {
      card.insertAdjacentHTML("beforeend", '<span class="stage-ribbon-indicator"></span>');
    } else if (!wantInd && indDot) {
      indDot.remove();
    }
  }

  const libCards = root.querySelectorAll<HTMLElement>(".stage-cover-card[data-key], .stage-list-row[data-key]");
  for (const card of libCards) {
    const key = card.dataset.key;
    if (!key) continue;
    const s = stageGameByKey(key);
    if (!s) continue;
    patchStageCoverInCard(card, s, "stage-cover-art");
  }
}

/** Progress text is the one thing the card patch cannot skip for a whole tick. */
function patchStageCardStatuses(): void {
  const root = document.getElementById("stage-root");
  if (!root) return;
  const cards = root.querySelectorAll<HTMLElement>(
    ".stage-cover-card[data-key], .stage-list-row[data-key]",
  );
  for (const card of cards) {
    const key = card.dataset.key;
    if (!key) continue;
    const summary = stageGameByKey(key);
    if (!summary) continue;
    const next = stageStatus(summary);
    const status = card.querySelector<HTMLElement>(".stage-status");
    if (status && status.outerHTML !== next) status.outerHTML = next;
  }
}

function patchStageHomeHeroInPlace(hero: EpicSummary): void {
  const root = document.getElementById("stage-root");
  if (!root) return;

  const targetArt = stageWideArt(hero);
  const heroArtImg = root.querySelector<HTMLImageElement>("#stage-home-art img");
  if (heroArtImg && targetArt && heroArtImg.getAttribute("src") !== targetArt) {
    heroArtImg.src = targetArt;
    updateStageBackdrop(targetArt);
  }

  const heroWrap = document.getElementById("stage-home-hero");
  if (heroWrap && heroWrap.dataset.key === hero.appName) {
    const hasUpdate = stageHasUpdate(hero);
    const isRunning = S.runningGames.has(hero.appName);
    const isFav = S.epicFav.has(hero.appName);
    const hasDl = epicDlProgress(hero.appName) !== null;
    const heroPlay = stageGamePlaytime(hero);
    const heroSig = `${hasUpdate ? "1" : "0"}:${isRunning ? "1" : "0"}:${isFav ? "1" : "0"}:${hasDl ? "1" : "0"}:${heroPlay.seconds}:${heroPlay.lastPlayed}:${hero.installed ? "1" : "0"}:${hero.installSize}`;
    if (heroWrap.dataset.heroActionSig !== heroSig) {
      heroWrap.dataset.heroActionSig = heroSig;
      heroWrap.innerHTML = stageHomeHeroHtml(hero);
      heroWrap.querySelectorAll<HTMLElement>("button, [data-gp-item]").forEach((btn) => {
        if (!btn.closest("[data-gp-skip]")) btn.setAttribute("data-gp-item", "");
      });
    }
  }

  const actEl = document.getElementById("stage-home-activities");
  if (actEl) {
    const ach = stageAchievements(hero);
    const shots = S.loadedScreenshots.get(hero.appName) || [];
    const play = stageGamePlaytime(hero);
    const isRunning = S.runningGames.has(hero.appName);
    const achLoaded = S.loadedAchievements.has(hero.appName) ? "1" : "0";
    const actSig = `${ach?.user_unlocked ?? -1}:${ach?.total_achievements ?? -1}:${achLoaded}:${shots.length}:${play.seconds}:${isRunning ? "1" : "0"}:${hero.installed ? "1" : "0"}:${hero.installSize}`;
    if (actEl.dataset.actSig !== actSig) {
      actEl.dataset.actSig = actSig;
      actEl.innerHTML = stageHomeActivitiesHtml(hero);
      actEl.querySelectorAll<HTMLElement>("button, [data-gp-item]").forEach((el) => el.setAttribute("data-gp-item", ""));
    }
  }
}

function patchStageLibrarySideInPlace(previewed: EpicSummary): void {
  const side = document.getElementById("stage-library-side");
  if (!side) return;
  const ach = stageAchievements(previewed);
  const isRunning = S.runningGames.has(previewed.appName);
  const isFav = S.epicFav.has(previewed.appName);
  const hasUpdate = stageHasUpdate(previewed) ? "1" : "0";
  const hasDl = epicDlProgress(previewed.appName) !== null ? "1" : "0";
  const play = stageGamePlaytime(previewed);
  const sideSig = `${ach?.user_unlocked ?? -1}:${ach?.total_achievements ?? -1}:${isRunning ? "1" : "0"}:${isFav ? "1" : "0"}:${previewed.installed ? "1" : "0"}:${previewed.installSize}:${play.seconds}:${play.lastPlayed}:${hasUpdate}:${hasDl}:${stageWideArt(previewed) ?? ""}`;
  if (side.dataset.sideSig !== sideSig) {
    side.dataset.sideSig = sideSig;
    side.outerHTML = stageLibrarySideHtml(previewed);
    const nextSide = document.getElementById("stage-library-side");
    if (nextSide) {
      nextSide.dataset.sideSig = sideSig;
      nextSide.querySelectorAll<HTMLElement>("button").forEach((b) => b.setAttribute("data-gp-item", ""));
    }
  }
}

/** Live counters, cards, covers and indicators that update without rebuilding the Stage shell. */
function patchLiveStage(): void {
  const root = document.getElementById("stage-root");
  if (!root) return;

  paintClock();
  const ambience = stageAmbienceActive() || stageCustomAudioActive() ? "on" : "off";
  if (root.dataset.ambience !== ambience) root.dataset.ambience = ambience;

  const bat = stageBatteryInfo();
  const batEl = root.querySelector<HTMLElement>(".stage-battery");
  if (batEl) {
    const batSpan = batEl.querySelector<HTMLElement>("span");
    const batText = bat.available ? `${bat.level}%` : "";
    if (batSpan && batSpan.textContent !== batText) batSpan.textContent = batText;
    batEl.classList.toggle("is-charging", bat.charging);
  }

  const download = stageActiveDownload();
  if (download) {
    const percent = Math.max(0, Math.min(100, Math.round(download.percent)));
    const chip = root.querySelector<HTMLElement>(".stage-top-download");
    if (chip) {
      const label = chip.querySelector<HTMLElement>("span");
      const text = `${percent}%`;
      if (label && label.textContent !== text) label.textContent = text;
      const bar = chip.querySelector<HTMLElement>("i");
      const width = `${Math.max(2, percent)}%`;
      if (bar && bar.style.width !== width) bar.style.width = width;
    }
    const badge = root.querySelector<HTMLElement>(".stage-dock-badge");
    const text = `${percent}%`;
    if (badge && badge.textContent !== text) badge.textContent = text;
  }
  if (S.stage.route === "downloads") patchStageDownloads();
  if (S.stage.spotifyOpen) patchStageSpotifyProgress();

  patchStageCardsInPlace();
  patchStageCardStatuses();

  if (S.stage.route === "home") {
    const heroKey = S.stage.homeHeroKey || root.querySelector<HTMLElement>("#stage-home-hero")?.dataset.key;
    if (heroKey) {
      const hero = stageGameByKey(heroKey);
      if (hero) patchStageHomeHeroInPlace(hero);
    }
  }

  if (S.stage.route === "library" && S.stage.previewKey) {
    const previewed = stageGameByKey(S.stage.previewKey);
    if (previewed) patchStageLibrarySideInPlace(previewed);
  }
}

function clockText(): string {
  try {
    return new Date().toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** The room changes colour with the hour; never with a random value. */
function stageTimeOfDay(): "morning" | "day" | "evening" | "night" {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "day";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

function paintClock(): void {
  const text = clockText();
  const node = document.querySelector<HTMLElement>(".stage-clock");
  if (node && node.textContent !== text) node.textContent = text;
  const idle = document.querySelector<HTMLElement>(".stage-idle-clock");
  if (idle && idle.textContent !== text) idle.textContent = text;
  const greeting = document.querySelector<HTMLElement>(".stage-idle-greeting");
  if (greeting) {
    const name = S.customProfileName.trim();
    const next = `${stageIdleGreeting()}${name ? ` · ${name}` : ""}`;
    if (greeting.textContent !== next) greeting.textContent = next;
  }
  // A Stage left open crosses sunset without a render; move the room with it.
  const root = document.getElementById("stage-root");
  if (root) {
    const tod = `stage-tod-${stageTimeOfDay()}`;
    if (!root.classList.contains(tod)) {
      root.classList.remove("stage-tod-morning", "stage-tod-day", "stage-tod-evening", "stage-tod-night");
      root.classList.add(tod);
    }
  }
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

/** A quiet profile mark: the custom avatar, or a user glyph. */
function stageProfileChip(): string {
  const name = currentProfileName();
  const avatar = globalAvatar() || getCustomAvatar();
  return `<span class="stage-profile" title="${esc(name)}" aria-hidden="true">${avatar ? `<img src="${esc(avatar)}" alt="" />` : icon("user", 14)}</span>`;
}

function topbar(): string {
  const dl = stageActiveDownload();
  const isKbd = stageInputMode === "keyboard" || stageInputMode === "mouse";
  const pad = S.stage.controllerConnected;
  const controllerBatteryPercent = S.stage.controllerBattery !== null && Number.isFinite(S.stage.controllerBattery) ? Math.round(S.stage.controllerBattery * 100) : null;
  const online = navigator.onLine && !S.offlineMode;
  const kind = S.gamepadKind;
  const lbGlyph = isKbd ? "Q" : (kind === "playstation" ? "L1" : kind === "switch" ? "L" : "LB");
  const rbGlyph = isKbd ? "E" : (kind === "playstation" ? "R1" : kind === "switch" ? "R" : "RB");

  const navTab = (route: StageRoute, label: string): string => {
    const active = S.stage.route === route;
    return `<button type="button" class="stage-nav-tab${active ? " active" : ""}" data-stage-act="go" data-route="${route}" data-gp-item data-gp-key="nav:${route}">
      <span>${esc(label)}</span>
      ${route === "downloads" && dl ? `<span class="stage-nav-badge tabular-nums">${Math.round(dl.percent)}%</span>` : ""}
    </button>`;
  };

  // The console bar is deliberately small: navigation on the left, status on
  // the right. The browser, music, Discord and power panels live one press
  // away in the Quick menu instead of six equal circles competing with the
  // shelf for the same 40 pixels.
  return `<header class="stage-topbar">
    <div class="stage-topbar-left">
      <div class="stage-brand">
        <span class="stage-brand-name">EFXLVE</span>
        <span class="stage-brand-mode">STAGE</span>
      </div>
      <span class="stage-top-greeting">${esc(stageIdleGreeting())}${S.customProfileName.trim() ? ` · ${esc(S.customProfileName.trim())}` : ""}</span>
      <nav class="stage-top-nav" aria-label="${esc(t("stage.title"))}">
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
      ${S.stage.ambience && S.stage.ambienceVolume > 0 ? `<span class="stage-ambient-status" title="${esc(t("stage.ambience"))}" aria-hidden="true">${icon("music", 13)}<span class="stage-ambient-bars"><i></i><i></i><i></i><i></i></span></span>` : ""}
      <span class="stage-net ${online ? "is-online" : "is-offline"}"><span class="stage-net-dot"></span><span class="stage-net-label">${esc(online ? t("nav.online") : t("nav.offline"))}</span></span>
      ${stageBatteryMarkup()}
      ${pad ? `<span class="stage-pad-status" title="${esc(t("stage.controllerBattery"))}">${icon("gamepad-2", 15)}${controllerBatteryPercent !== null ? `<span class="tabular-nums">${controllerBatteryPercent}%</span>` : ""}</span>` : ""}
      <span class="stage-clock tabular-nums"></span>
      ${stageProfileChip()}
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
  if (S.stage.idle) return "";
  const isKbd = stageInputMode === "keyboard" || stageInputMode === "mouse";
  const face = (b: "a" | "b" | "x" | "y") => faceOrKey(b);
  const bumpers = isKbd ? `${stageKeyGlyph("Q")} ${stageKeyGlyph("E")}` : stageBumperGlyphs();
  const menuKey = isKbd ? stageKeyGlyph("M") : stageMenuGlyph();
  const viewGlyph = isKbd ? stageKeyGlyph("Ctrl+K") : stageViewGlyph();
  const triggerGlyphs = isKbd ? stageKeyGlyph("Tab") : stageTriggerGlyphs();

  if (S.stage.quickMenu) {
    // Quick menu has integrated dock hints inside its sheet
    return "";
  }
  if (S.stage.manageKey) {
    return stageHintBar([
      stageHint(face("a"), t("stage.select")),
      stageHint(face("b"), t("common.close")),
    ]);
  }
  if (S.stage.controlsOpen) {
    return stageHintBar([
      stageHint(face("b"), t("common.close")),
    ]);
  }
  if (S.stage.searchOpen) {
    return stageHintBar([
      stageHint(face("a"), t("stage.select")),
      stageHint(face("b"), t("common.close")),
      stageHint(isKbd ? "↑↓" : "↑ ↓", t("gamepad.navigate")),
    ]);
  }
  if (S.stage.powerOpen) {
    return stageHintBar([
      stageHint(face("a"), t("stage.select")),
      stageHint(face("b"), t("common.close")),
    ]);
  }
  if (S.stage.route === "program") {
    return stageHintBar([
      stageHint(face("a"), t("stage.select")),
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
      stageHint(triggerGlyphs, t("stage.storeFilter")),
      stageHint("← →", t("stage.collections")),
      stageHint(viewGlyph, t("stage.search")),
      stageHint(menuKey, t("stage.quickMenu")),
    ]);
  }
  if (S.stage.route === "downloads") {
    return stageHintBar([
      stageHint(face("a"), t("stage.select")),
      stageHint(face("b"), t("common.back")),
      stageHint(bumpers, t("gamepad.tabs")),
      stageHint(menuKey, t("stage.quickMenu")),
    ]);
  }
  if (S.stage.route === "settings") {
    return stageHintBar([
      stageHint(face("a"), t("stage.select")),
      stageHint(bumpers, t("gamepad.tabs")),
      stageHint(face("b"), t("common.back")),
      stageHint(menuKey, t("stage.quickMenu")),
    ]);
  }
  return stageHintBar([
    stageHint(face("a"), t("stage.open")),
    stageHint(face("b"), t("common.back")),
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
  const runningAppName = Array.from(S.runningGames)[0];
  const runningGame = runningAppName ? stageGameByKey(runningAppName) : null;
  return `<div class="stage-overlay stage-quick-menu${entered ? " stage-overlay-enter" : ""}">
    <div class="stage-dock-panel" role="dialog" aria-modal="true" aria-label="${esc(t("stage.quickMenu"))}">
      <div class="stage-dock-head">
        <span class="stage-dock-kicker">${esc(t("stage.quickMenu"))}</span>
        <span class="stage-dock-status tabular-nums">${esc(pad)}</span>
      </div>
      <div class="stage-dock-items">
        ${runningGame ? `
          <button type="button" class="stage-dock-item stage-dock-resume" data-stage-act="open-program" data-key="${esc(runningGame.appName)}" data-gp-item data-gp-key="dock:resume" data-gp-default>
            <span class="stage-dock-icon is-running">${icon("play", 22)}</span>
            <div class="stage-dock-resume-text">
              <strong>${esc(t("stage.continue"))}: ${esc(runningGame.title)}</strong>
              <span>${esc(t("common.playing"))}</span>
            </div>
          </button>
        ` : ""}
        <button type="button" class="stage-dock-item" data-stage-act="go" data-route="home" data-gp-item data-gp-key="dock:home"${!runningGame ? " data-gp-default" : ""}>
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
        <button type="button" class="stage-dock-item" data-stage-act="open-browser-sheet" data-gp-item data-gp-key="dock:browser"><span class="stage-dock-icon">${icon("globe", 22)}</span><span class="stage-dock-text">${esc(t("overlay.tabBrowser"))}</span></button>
        <button type="button" class="stage-dock-item" data-stage-act="open-spotify-sheet" data-gp-item data-gp-key="dock:spotify"><span class="stage-dock-icon">${icon("spotify", 22)}</span><span class="stage-dock-text">Spotify</span></button>
        <button type="button" class="stage-dock-item" data-stage-act="open-discord-sheet" data-gp-item data-gp-key="dock:discord"><span class="stage-dock-icon">${icon("discord", 22)}</span><span class="stage-dock-text">Discord</span></button>
        <button type="button" class="stage-dock-item" data-stage-act="open-power-sheet" data-gp-item data-gp-key="dock:power"><span class="stage-dock-icon">${icon("zap", 22)}</span><span class="stage-dock-text">${esc(t("stage.power"))}</span></button>
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
        <span>${faceOrKey("a")} ${esc(t("stage.select"))}</span>
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
    [stageMenuGlyph(), t("stage.quickMenu")],
    [stageViewGlyph(), t("stage.search")],
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
  const canVerify = source === "epic" || source === "gog" || source === "amazon" || source === "steam";
  const cloud = Boolean(libraryItemOf(game.appName, source)?.cloudSavesSupported);
  const isConfirming = S.stage.manageConfirmUninstall;

  if (isConfirming) {
    return `<div class="stage-overlay stage-manage-overlay${entered ? " stage-overlay-enter" : ""}">
      <div class="stage-sheet stage-confirm-sheet" role="dialog" aria-modal="true" aria-label="${esc(t("manage.uninstallTitle"))}">
        <div class="stage-confirm-icon is-danger">${icon("trash", 38)}</div>
        <div class="stage-confirm-copy">
          <span class="stage-kicker is-danger">${esc(t("manage.uninstallTitle"))}</span>
          <h2>${esc(game.title)}</h2>
          <p>${esc(t("confirm.uninstallBody", { name: game.title }))}</p>
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

        

        ${isInstalled && canVerify ? `
          <button type="button" class="stage-manage-card" data-stage-act="manage-verify" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:verify">
            <span class="stage-manage-card-icon">${icon("shield-check", 20)}</span>
            <div class="stage-manage-card-text">
              <strong>${esc(t("manage.verify"))}</strong>
              <span>${esc(t("manage.verifyTitle"))}</span>
            </div>
          </button>
        ` : ""}

        ${isInstalled ? `
          <button type="button" class="stage-manage-card" data-stage-act="manage-open-folder" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:folder">
            <span class="stage-manage-card-icon">${icon("folder", 20)}</span>
            <div class="stage-manage-card-text">
              <strong>${esc(t("manage.openFolder"))}</strong>
              <span>${esc(t("stage.installFolder"))}</span>
            </div>
          </button>
        ` : ""}

        ${isInstalled && (source === "epic" || source === "amazon") ? `
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

        ${isInstalled && canVerify ? `
          <button type="button" class="stage-manage-card stage-manage-card-danger" data-stage-act="manage-ask-uninstall" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:uninstall">
            <span class="stage-manage-card-icon is-danger">${icon("trash", 20)}</span>
            <div class="stage-manage-card-text">
              <strong>${esc(t("common.uninstall"))}</strong>
              <span>${esc(t("manage.uninstallTitle"))}</span>
            </div>
          </button>
        ` : ""}

        <button type="button" class="stage-manage-card" data-stage-act="desktop-manage" data-key="${esc(game.appName)}" data-gp-item data-gp-key="manage:desktop">
          <span class="stage-manage-card-icon">${icon("external", 20)}</span>
          <div class="stage-manage-card-text">
            <strong>${esc(t("stage.manageInDesktop"))}</strong>
            <span>${esc(t("stage.desktopHint"))}</span>
          </div>
        </button>
      </div>

      <div class="stage-manage-hints">
        <span>${faceOrKey("a")} ${esc(t("stage.select"))}</span>
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

/** A custom track replaces the generative room; otherwise the room returns. */
function syncStageAudio(): void {
  // A library sample only belongs on the Appearance panel. Leaving it must
  // never leave a preview playing over Home.
  if (S.stage.route !== "settings" || S.stage.settingsTab !== "appearance") {
    stopStageAudioPreview();
    // Leaving Appearance abandons an unfinished delete confirmation.
    if (stageAudioPendingDelete()) stageAudioCancelDelete();
  }
  const custom = updateStageCustomAudio();
  if (custom) {
    if (stageAmbienceActive()) stopStageAmbience();
  } else if (!stageAmbienceActive()) {
    startStageAmbience();
  }
  duckStageAmbience(S.runningGames.size > 0 || Boolean(stageAudioPreviewName()));
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
    lastCardPatchSig = "";
    introStarted = false;
    return;
  }
  if (!introStarted) {
    introStarted = true;
    // The stage-mode event fires before the lazy chunk exists on the first
    // entry, so the chunk starts its own intro once it is ready.
    startStageIntro();
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
  const browserEntered = S.stage.browserOpen && !wasBrowser;
  const spotifyEntered = S.stage.spotifyOpen && !wasSpotify;
  const discordEntered = S.stage.discordOpen && !wasDiscord;
  const powerEntered = S.stage.powerOpen && !wasPower;
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
  const browser = S.stage.browserOpen ? renderStageBrowserSheet(browserEntered) : "";
  const spotify = S.stage.spotifyOpen ? renderStageSpotifySheet(spotifyEntered) : "";
  const discord = S.stage.discordOpen ? renderStageDiscordSheet(discordEntered) : "";
  const power = S.stage.powerOpen ? renderStagePowerSheet(powerEntered) : "";
  const cover = S.stage.launch ? curtain(launchEntered) : "";
  const error = launchError(errorEntered);
  wasQuickMenu = S.stage.quickMenu;
  wasControls = S.stage.controlsOpen;
  wasManage = Boolean(S.stage.manageKey);
  wasSearch = S.stage.searchOpen;
  wasBrowser = S.stage.browserOpen;
  wasSpotify = S.stage.spotifyOpen;
  wasDiscord = S.stage.discordOpen;
  wasPower = S.stage.powerOpen;
  wasLaunch = Boolean(S.stage.launch);
  wasError = Boolean(S.stage.launchError);

  root.className = `stage-root stage-route-${S.stage.route} stage-tod-${stageTimeOfDay()}${isSteamDeckDevice() ? " is-handheld-device" : ""}${S.stage.idle ? " is-idle" : ""}${S.stage.route === "program" ? " is-program" : ""}${S.stage.quickMenu ? " is-menu-open" : ""}${S.stage.powerOpen ? " is-power-open" : ""}${S.stage.manageKey ? " is-manage-open" : ""}${S.stage.searchOpen ? " is-search-open" : ""}${S.stage.browserOpen ? " is-browser-open" : ""}${S.stage.spotifyOpen ? " is-spotify-open" : ""}${S.stage.discordOpen ? " is-discord-open" : ""}${S.stage.stillIndex !== null ? " is-still-open" : ""}${S.stage.route === "settings" && settingsTabChanged ? " stage-settings-tab-enter" : ""}`;
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
  ${browser}
  ${spotify}
  ${discord}
  ${power}
  ${cover}
  ${error}
  ${stageIntroMarkup()}`;

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
        : power
          ? ".stage-power-sheet"
          : browser
          ? ".stage-browser-sheet"
          : spotify
            ? ".stage-spotify-sheet"
            : discord
              ? ".stage-discord-sheet"
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
  // Attract mode owns the screen: a background repaint (a download tick, a
  // store refresh) must not restore the ring and wake the room.
  if (!modalOpen() && !S.stage.idle) restoreFocus(layer);
  startClock();
  // The room follows the screen: Home is the full theme, tools step back.
  setStageAmbienceScene(S.stage.route === "home" ? "home" : S.stage.route === "library" ? "library" : "quiet");
  syncStageAudio();
  // The equalizer in the top bar is honest: it only moves while the audio
  // graph, or a player-imported track, is actually running.
  root.dataset.ambience = stageAmbienceActive() || stageCustomAudioActive() ? "on" : "off";
  refreshStageIdle();
  // The render may have advanced the library chunk or normalized the query;
  // recompute so the next pass can take the lightweight patch path.
  lastStageSignature = stageLiveSignature();
  // The fresh markup already carries the current cover/status state.
  lastCardPatchSig = stageCardPatchSignature();
}

function bindGlobalFocus(): void {
  initStageBattery();
  initStageIdle();
  if (focusBound) return;
  focusBound = true;
  // These window-level listeners outlive the Stage root. Binding them once
  // here keeps a re-entry from stacking another copy on the same event.
  window.addEventListener("pointermove", (event) => {
    if (!dragTrack) return;
    const diff = event.clientX - dragStartX;
    if (!dragActive && Math.abs(diff) > 7) {
      dragActive = true;
      dragMoved = true;
    }
    if (dragActive) dragTrack.scrollLeft = dragStartScroll - diff;
  });
  window.addEventListener("pointerup", () => {
    if (!dragTrack) return;
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
    dragActive = false;
    dragMoved = false;
  });
  window.addEventListener("stage-input-mode", (event) => {
    const mode = (event as CustomEvent<{ mode?: StageInputMode }>).detail?.mode;
    if (mode && stageInputMode !== mode) {
      stageInputMode = mode;
      scheduleRender();
    }
  });
  window.addEventListener("stage:focus", (event) => {
    if (!S.stage.active) return;
    if (S.stage.intro) {
      skipStageIntro();
      return;
    }
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    const key = detail?.key || "";
    const changed = Boolean(key) && key !== S.stage.focusKey;
    if (key) S.stage.focusKey = key;
    if (changed) stageFeedback("move");
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
    syncStageAudio();
  });
  window.addEventListener("stage-mode", (event) => {
    const active = Boolean((event as CustomEvent<{ active?: boolean }>).detail?.active);
    lastStageSignature = "";
    if (active) {
      startClock();
      startStageIntro();
      syncStageAudio();
      resetStageIdleTimer();
    } else {
      stopClock();
      stopStageAmbience();
      stopStageCustomAudio();
      resetStageIntro();
      refreshStageIdle();
      dragTrack = null;
      dragActive = false;
      dragMoved = false;
    }
  });
  // A window that moves from a desktop monitor to a handheld panel keeps the
  // same DOM; the CSS breakpoints do the layout work. This only re-runs the
  // intro/greeting bookkeeping after the resize settles.
  window.addEventListener("resize", () => {
    if (!S.stage.active) return;
    paintClock();
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
  if (S.stage.idle) {
    // The capture listener normally consumes this first; this is the keyboard
    // path when a synthetic event arrives from the automation layer.
    event.preventDefault();
    wakeStageIdle();
    return;
  }
  if (S.stage.intro) {
    event.preventDefault();
    skipStageIntro();
    return;
  }
  if (modalOpen()) return;
  touchStageActivity();
  const input = document.activeElement;
  const inSearchInput = input instanceof HTMLInputElement && input.id === "stage-search-input";
  const inBrowserInput = input instanceof HTMLInputElement && input.id === "stage-browser-input";
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
  if (inBrowserInput) {
    if (key === "ArrowDown") {
      event.preventDefault();
      moveGamepadFocus("down");
    } else if (key === "Enter") {
      event.preventDefault();
      void stageLaunchBrowser(input.value);
    }
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

  // A sheet, the quick menu or the launch curtain owns the keyboard. Escape
  // already backed out above; arrows, Enter and Backspace drive the focused
  // control, while page-level shortcuts must not fire behind the overlay.
  if (
    S.stage.searchOpen ||
    S.stage.quickMenu ||
    S.stage.controlsOpen ||
    S.stage.powerOpen ||
    S.stage.browserOpen ||
    S.stage.spotifyOpen ||
    S.stage.discordOpen ||
    S.stage.manageKey ||
    S.stage.launch ||
    S.stage.launchError
  ) {
    const navigates =
      key === "ArrowUp" ||
      key === "ArrowDown" ||
      key === "ArrowLeft" ||
      key === "ArrowRight" ||
      key === "Enter" ||
      key === " " ||
      key === "Backspace";
    if (!navigates) return;
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

  // The focused collection tool is a horizontal picker: left/right cycles it
  // instead of moving the ring to the next toolbar button.
  if (
    S.stage.route === "library" &&
    S.stage.focusKey === "tool:collection" &&
    (key === "ArrowLeft" || lower === "a" || key === "ArrowRight" || lower === "d")
  ) {
    event.preventDefault();
    event.stopPropagation();
    stageCycleCollection(key === "ArrowRight" || lower === "d");
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
    if (!actionEl) {
      const otherBtn = target?.closest<HTMLElement>("button, [data-act]");
      if (otherBtn && !otherBtn.closest(".stage-search-head")) {
        stageFeedback("select");
      }
      return;
    }
    const action = actionEl.dataset.stageAct || "";
    const key = actionEl.dataset.key || "";
    const name = actionEl.dataset.name || "";
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
      case "cycle-collection": stageCycleCollection(true); break;
      case "cycle-sort": stageCycleSort(); break;
      case "toggle-view": stageToggleView(); break;
      case "random-game": stagePickRandomGame(); break;
      case "dismiss-welcome": stageDismissWelcome(); break;
      case "open-search":
      case "search": stageOpenSearch(); break;
      case "search-close": stageFeedback("back"); stageCancelSearch(); break;
      case "search-key": stageSearchKey(actionEl.dataset.key || ""); break;
      case "search-submit": stageSearchSubmit(); break;
      case "open-menu": stageOpenQuickMenu("dock:resume"); break;
      case "close-menu": stageFeedback("back"); S.stage.quickMenu = false; S.stage.controlsOpen = false; S.stage.focusKey = ""; scheduleRender(); break;
      case "open-power-sheet": stageOpenPowerSheet(); break;
      case "close-power-sheet": stageClosePowerSheet(); break;
      case "power-sleep": void stageSleepDevice(); break;
      case "power-desktop": stageOpenDesktop(); break;
      case "power-shutdown": void stageShutdownDevice(); break;
      case "power-cancel-shutdown": stageCancelShutdown(); break;
      case "power-mute": stageToggleQuickMute(); break;
      case "power-vol-down": stageQuickVolume(-10); break;
      case "power-vol-up": stageQuickVolume(10); break;
      case "open-browser-sheet": void stageOpenBrowserSheet(); break;
      case "close-browser-sheet": stageCloseBrowserSheet(); break;
      case "browser-go": {
        const inp = root.querySelector<HTMLInputElement>("#stage-browser-input");
        if (inp) void stageLaunchBrowser(inp.value);
        break;
      }
      case "browser-bookmark": {
        const url = actionEl.dataset.url || "";
        if (url) void stageLaunchBrowser(url);
        break;
      }
      case "browser-close-window": void stageCloseBrowserWindow(); break;
      case "open-spotify-sheet": stageOpenSpotifySheet(); break;
      case "close-spotify-sheet": stageCloseSpotifySheet(); break;
      case "spotify-toggle": void stageSpotifyAction("toggle"); break;
      case "spotify-prev": void stageSpotifyAction("previous"); break;
      case "spotify-next": void stageSpotifyAction("next"); break;
      case "spotify-shuffle": void stageSpotifyAction("shuffle"); break;
      case "spotify-repeat": void stageSpotifyAction("repeat"); break;
      case "spotify-start": void stageSpotifyAction("start"); break;
      case "spotify-playlist": void stageSpotifyPlayPlaylist(actionEl.dataset.uri || ""); break;
      case "open-discord-sheet": stageOpenDiscordSheet(); break;
      case "close-discord-sheet": stageCloseDiscordSheet(); break;
      case "discord-connect": stageDiscordConnect(); break;
      case "discord-mute": void stageDiscordToggleMute(); break;
      case "discord-hangup": void stageDiscordHangup(); break;
      case "discord-open-app": void stageDiscordOpenApp(); break;
      case "controls": stageToggleControls(); break;
      case "show-controls": stageShowControls(); break;
      case "close-controls": stageFeedback("back"); stageCloseControls(); break;
      case "scroll-to-hub": {
        stageFeedback("select");
        const hub = document.getElementById("stage-home-activities");
        if (hub) hub.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
      case "desktop": stageOpenDesktop(); break;
      case "desktop-manage": stageOpenDesktopManage(key); break;
      case "desktop-settings": stageOpenDesktopSettings(); break;
      case "desktop-game":
      case "manage-game": stageOpenManage(key); break;
      case "close-manage": stageCloseManage(); break;
      case "manage-open-folder": stageManageOpenFolder(key); break;
      case "manage-verify": stageManageVerify(key); break;
      case "manage-shortcut": stageManageShortcut(key); break;
      case "manage-sync-cloud": stageCloudBackup(key || S.stage.manageKey || ""); break;
      case "manage-ask-uninstall": stageManageAskUninstall(); break;
      case "manage-cancel-uninstall": stageManageCancelUninstall(); break;
      case "manage-confirm-uninstall": stageManageConfirmUninstall(key); break;
      case "reset-filters": stageResetFilters(); break;
      case "clear-query": stageFeedback("back"); S.stage.query = ""; S.stage.focusKey = "tool:search"; scheduleRender(); break;
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
      case "set-stage-text": if (Number.isFinite(value)) { stageFeedback("move"); setStageTextScale(value); } break;
      case "set-stage-safe": if (Number.isFinite(value)) { stageFeedback("move"); setStageSafeArea(value); } break;
      case "choose-stage-ambience": void stageChooseCustomAmbience(); break;
      case "clear-stage-ambience": stageClearCustomAmbience(); break;
      case "choose-game-track": void stageChooseGameTrack(key); break;
      case "clear-game-track": stageClearGameTrack(key); break;
      case "preview-stage-audio": stagePreviewAudio(name); break;
      case "import-stage-audio": void stageImportAudioFile(); break;
      case "use-stage-ambience": stageUseAudioForMenu(name); break;
      case "ask-delete-stage-audio": stageAskDeleteAudio(name); break;
      case "cancel-delete-stage-audio": stageCancelDeleteAudio(); break;
      case "delete-stage-audio": void stageConfirmDeleteAudio(name); break;
      case "set-stage-volume": if (Number.isFinite(value)) { setStageSoundVolume(value); stageFeedback("select"); } break;
      case "set-stage-ambience-volume": {
        if (Number.isFinite(value)) {
          setStageAmbienceVolume(value);
          applyStageAmbienceSettings();
          if (value <= 0) stopStageAudioPreview();
          syncStageAudio();
          stageFeedback("select");
        }
        break;
      }
      case "toggle-stage-sound": { const next = !S.stage.sound; setStageSound(next); if (next) stageFeedback("select"); } break;
      case "toggle-stage-ambience": {
        const next = !S.stage.ambience;
        setStageAmbience(next);
        applyStageAmbienceSettings();
        if (!next) {
          // Mark the room inactive before releasing a sample, or it would
          // resume for a frame on the way to silence.
          stopStageCustomAudio();
          stopStageAudioPreview();
        }
        syncStageAudio();
        if (next) stageFeedback("select");
        break;
      }
      case "toggle-stage-cinematic": { stageFeedback("select"); setStageCinematic(!S.stage.cinematic); break; }
      case "toggle-stage-attract": { stageFeedback("select"); setStageAttract(!S.stage.attract); break; }
      case "toggle-stage-haptics": { stageFeedback("select"); setStageHaptics(!S.stage.haptics); } break;
      case "test-stage-sound": previewStageSound(); break;
      case "test-stage-ambience": {
        // The settings screen normally runs the quiet scene; lift it for the
        // test burst so the button actually demonstrates the theme.
        stopStageCustomAudio();
        stopStageAudioPreview();
        setStageAmbienceScene("home");
        applyStageAmbienceSettings();
        stageFeedback("select");
        window.setTimeout(() => {
          if (!S.stage.active) return;
          setStageAmbienceScene(S.stage.route === "home" ? "home" : S.stage.route === "library" ? "library" : "quiet");
          syncStageAudio();
        }, 6000);
        break;
      }
      case "preview-stage-idle": {
        stageFeedback("select");
        // Leave the settings screen first; the preview owns Home only.
        if (S.stage.route !== "home") stageGo("home");
        window.setTimeout(() => previewStageIdle(), 300);
        break;
      }
      case "retry": S.stage.launchError = ""; stageLaunchGame(S.stage.gameKey || ""); break;
      case "close-error": stageFeedback("back"); S.stage.launchError = ""; scheduleRender(); break;
      default: break;
    }
  });

  // A mouse gets CSS hover and clicks; it does not drag the controller ring
  // across the shelf. One tiny movement used to swap the Home hero and the
  // activity cards, which made the mouse feel like a broken D-pad.
  root.addEventListener("pointermove", () => {
    if (stageInputMode !== "mouse") {
      stageInputMode = "mouse";
      scheduleRender();
    }
  }, { passive: true });

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
  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const hRow = target?.closest<HTMLElement>(
      ".stage-ribbon-track, .stage-activity-row, .stage-collection-row",
    );
    if (!hRow) return;
    dragTrack = hRow;
    dragStartX = event.clientX;
    dragStartScroll = hRow.scrollLeft;
    dragActive = false;
    dragMoved = false;
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
    // The boot mark never traps the first tap.
    if (S.stage.intro) skipStageIntro();
    touchStageActivity();
    if (stageInputMode !== "mouse") {
      stageInputMode = "mouse";
      scheduleRender();
    }
  });
}


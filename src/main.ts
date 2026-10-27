/**
 * Application entry point.
 *
 * This file intentionally stays tiny: it owns only the render orchestrator and
 * the "close every modal" helper. All state lives in `src/core/state.ts`, all
 * features in `src/features/*`, and the IPC/bootstrap wiring in
 * `src/features/events/ipc-listeners.ts`.
 */

import "./styles/index.css";
import { invoke } from "@tauri-apps/api/core";
import { initSidebarLayout } from "./core/sidebar-layout";
import { applySidebarPageVisibility, discordPageVisible } from "./core/page-visibility";
import { perfMark } from "./core/perf";
import { applyCustomCss } from "./core/custom-css";
import { applySurface } from "./core/themes";
import { syncAchievementCardTheme } from "./core/achievement-card-theme";
import { achievementGetNotificationOptions } from "./steam";
import { applyReduceEffects } from "./core/effects";
import { S } from "./core/state";
import { closeModal, modalRoot, playtimeRoot, selectiveRoot, viewEl } from "./core/dom";
import { updateChrome, updateNavHistoryUi, updateOfflineModeUi } from "./core/nav";
import { watchConnection } from "./core/offline";
import type { View } from "./core/types";
import { closeCollectionModal } from "./features/collections/collections-view";
import { closeChangelogModal } from "./features/changelog/changelog-view";
import { closeCustomCoverModal } from "./features/cover/cover-view";
import { destroyDiscordPage, hydrateDiscordPage, keepDiscordOpen, renderDiscordPage } from "./features/discord/discord-view";
import { closeInstallDialog } from "./features/install/install-dialog";
import { closeAddCustomGameModal } from "./features/custom-games/add-game-dialog";
import { drawSpeedCanvas, renderDownloads, startSpeedChartTimer } from "./features/downloads/downloads-view";
import "./features/events/click-router";
import "./features/events/input-listeners";
import { initApp } from "./features/events/ipc-listeners";
import { updateGamepadHud } from "./features/gamepad/gamepad";
import { closeHideGamesModal } from "./features/library/hide-games";
import { closeHideAchievementsModal } from "./features/profile/hide-achievements";
import { patchLibraryGridInPlace, positionColDropdownMenu, renderEpic, setupLibScrollObserver } from "./features/library/library-view";
import { renderAccounts } from "./features/accounts/accounts-view";
import { hideSpotifyPlayer, hydrateMusic, renderMusic } from "./features/music/music-view";
import { initMiniPlayer } from "./features/music/mini-player";
import { closeNotifPanel, renderNotificationPanel } from "./features/notifications/notifications";
import { presenceSync } from "./core/render";
import { renderProfile } from "./features/profile/profile-view";
import { closeAvatarModal } from "./features/profile/profile-avatar";
import { closeScreenshotLightbox, closeScreenshotMoveConfirm, closeShareModal } from "./features/screenshots/screenshots-view";
import { renderSettings } from "./features/settings/settings-view";
import { renderNotesPage } from "./features/notes/notes-view";
import { renderScreenshotsPage } from "./features/screenshots/screenshots-page";
import { closeManagePopup } from "./features/manage/manage-view";
import { closeStorageManager } from "./features/storage/storage-view";
import { embeddedStoreHeld, hideStore, isStoreWarm, renderStoreLoadingScreen } from "./features/store/store-view";
import { applyWinbarAppIcon } from "./core/app-icon";
import { applyUiScale } from "./core/game-status";

applySurface(S.surface, false);
// The native achievement card follows the saved theme mode. The palette needs
// the hydrated options, so it is pushed again as soon as the backend answers.
void achievementGetNotificationOptions()
  .then((options) => {
    S.achievementNotificationOptions = options;
    syncAchievementCardTheme();
  })
  .catch(() => undefined);
applyReduceEffects(S.reduceEffects);
if (S.uiScale !== 100) void applyUiScale(S.uiScale);
applyCustomCss(S.customCss);
document.documentElement.classList.add("ready");
applyWinbarAppIcon();
perfMark("main:module");
initSidebarLayout();
initMiniPlayer();
applySidebarPageVisibility();
// Windows reports a lost/restored connection; the chip follows it so the
// launcher never claims "Online" while the cable is out.
watchConnection(updateOfflineModeUi);

// Prewarm the Discord page after the shell settles, so the first visit is
// instant instead of paying the web-client boot in front of the person. The
// page is closed after a few idle minutes unless "Keep Discord open" is on,
// which is what bounds the cost of a parked Discord renderer.
if (discordPageVisible()) {
  window.setTimeout(() => {
    if (!discordPageVisible()) return;
    void invoke("discord_view_prewarm", { keepOpen: keepDiscordOpen() }).catch(() => undefined);
  }, 2500);
}

let lastRenderedView: View | null = null;
viewEl.addEventListener("animationend", (e) => {
  if (e.target instanceof HTMLElement && e.target.parentElement === viewEl) viewEl.classList.remove("view-enter");
});

/** Batch the next render onto the animation frame. */
function scheduleRender(): void {
  if (S.renderScheduled) return;
  S.renderScheduled = true;
  requestAnimationFrame(() => {
    S.renderScheduled = false;
    render();
  });
}

/** Render the active view and refresh the surrounding chrome. */
function render(): void {
  // TV Mode is a full-screen shell state; a single place toggles its body class.
    // The Spotify page is an embedded web player: it owns the whole content area.
  document.body.classList.toggle("spotify-page", S.view === "music");
  // The Discord page is an embedded web client: it owns the whole content area.
  document.body.classList.toggle("discord-page", S.view === "discord");

  // When leaving the store, hard-hide the native webview to avoid overlap.
    if (S.view !== "store" && S.storeShown && !embeddedStoreHeld()) hideStore();

  // Same for the Spotify child, and this must run before the early returns
  // below: the store and patched-library branches would otherwise skip it and
  // leave the web player painted over the next page.
  if (S.view !== "music") hideSpotifyPlayer();

  // The Discord child is a full client renderer: it is destroyed on leave, not
  // kept warm. This must also run before the early returns below.
  if (S.view !== "discord") destroyDiscordPage();

  // Page-enter animation only on a real view change. The class is dropped
  // first: a re-render landing while the previous animation still runs would
  // otherwise replay it on the new children (a detached node's cancel event
  // never reaches #view).
  viewEl.classList.remove("view-enter");
  if (S.view !== lastRenderedView) {
    lastRenderedView = S.view;
    viewEl.classList.add("view-enter");
    viewEl.scrollTop = 0;
    // Cards and dropdowns do not survive a page change: on the storefront and
    // Spotify pages their child host would paint over them.
    closeNotifPanel();
    closeChangelogModal();
  }

  if (S.view === "store") {
    // Only paint the loading screen until the native store webview is shown; a
    // re-render afterwards would restart the animation for nothing. A storefront
    // that is still warm appears within a frame, so it skips the screen entirely.
    if (!S.storeShown && !isStoreWarm(S.lastStoreUrl)) viewEl.innerHTML = renderStoreLoadingScreen();
    updateChrome();
    renderNotificationPanel();
    presenceSync();
    return;
  }
  if (S.view !== "library" && modalRoot.innerHTML.trim()) {
    closeModal();
  }
  // Data arrivals on the library patch the rendered cards in place; a full
  // innerHTML rebuild would re-decode every cover. Falls back when the result
  // set itself changed (a new game, another filter, a different sort).
  if (S.view === "library" && patchLibraryGridInPlace()) {
    updateChrome();
    updateNavHistoryUi();
    updateGamepadHud(S.gamepadPolling);
    renderNotificationPanel();
    presenceSync();
    return;
  }
  // A full rebuild replaces the tab strip; keep its horizontal position.
  const libStripScroll =
    S.view === "library" ? document.querySelector<HTMLElement>(".lib-filters")?.scrollLeft ?? 0 : 0;
  viewEl.innerHTML =
    S.view === "library" ? renderEpic()
    : S.view === "downloads" ? renderDownloads()
    : S.view === "profile" ? renderProfile()
    : S.view === "accounts" ? renderAccounts()
    : S.view === "music" ? renderMusic()
    : S.view === "discord" ? renderDiscordPage()
    : S.view === "notes" ? renderNotesPage()
    : S.view === "screenshots" ? renderScreenshotsPage()
        : renderSettings();
  if (S.view === "library") {
    setupLibScrollObserver();
    if (S.isColDropdownOpen) positionColDropdownMenu();
    if (libStripScroll > 0) {
      const strip = document.querySelector<HTMLElement>(".lib-filters");
      if (strip) strip.scrollLeft = libStripScroll;
    }
  }
    if (S.view === "music") {
    hydrateMusic();
  }
  if (S.view === "discord") {
    hydrateDiscordPage();
  }
  if (S.view === "downloads") {
    startSpeedChartTimer();
    drawSpeedCanvas();
  }
  updateChrome();
  updateNavHistoryUi();
  updateGamepadHud(S.gamepadPolling);
  renderNotificationPanel();
  presenceSync();
}

/** Close every modal/drawer root. */
function closeAllModals(): void {
  closeModal();
  closeScreenshotLightbox();
  closeScreenshotMoveConfirm();
  closeShareModal();
  closeCustomCoverModal();
  closeCollectionModal();
  closeHideGamesModal();
  closeHideAchievementsModal();
  closeStorageManager();
  closeNotifPanel();
  closeAvatarModal();
  closeInstallDialog();
  closeAddCustomGameModal();
  closeManagePopup();
  closeChangelogModal();
  if (selectiveRoot) selectiveRoot.innerHTML = "";
  if (playtimeRoot) playtimeRoot.innerHTML = "";
}

void initApp({ render, scheduleRender, closeAllModals });

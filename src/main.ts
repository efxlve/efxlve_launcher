/**
 * Application entry point.
 *
 * This file intentionally stays tiny: it owns only the render orchestrator and
 * the "close every modal" helper. All state lives in `src/core/state.ts`, all
 * features in `src/features/*`, and the IPC/bootstrap wiring in
 * `src/features/events/ipc-listeners.ts`.
 */

import "./styles/index.css";
import { initSidebarLayout } from "./core/sidebar-layout";
import { S } from "./core/state";
import { closeModal, modalRoot, playtimeRoot, selectiveRoot, viewEl } from "./core/dom";
import { updateChrome, updateNavHistoryUi } from "./core/nav";
import type { View } from "./core/types";
import { closeCollectionModal } from "./features/collections/collections-view";
import { closeChangelogModal } from "./features/changelog/changelog-view";
import { closeCustomCoverModal } from "./features/cover/cover-view";
import { closeInstallDialog } from "./features/install/install-dialog";
import { drawSpeedCanvas, measureInstalledSizes, renderDownloads, startSpeedChartTimer } from "./features/downloads/downloads-view";
import "./features/events/click-router";
import "./features/events/input-listeners";
import { initApp } from "./features/events/ipc-listeners";
import { updateGamepadHud } from "./features/gamepad/gamepad";
import { closeHideGamesModal } from "./features/library/hide-games";
import { closeHideAchievementsModal } from "./features/profile/hide-achievements";
import { patchLibraryGridInPlace, positionColDropdownMenu, renderEpic, setupLibScrollObserver } from "./features/library/library-view";
import { renderAccounts } from "./features/accounts/accounts-view";
import { hydrateMusic, renderMusic } from "./features/music/music-view";
import { closeNotifPanel, renderNotificationPanel } from "./features/notifications/notifications";
import { presenceSync } from "./core/render";
import { renderProfile } from "./features/profile/profile-view";
import { closeAvatarModal } from "./features/profile/profile-avatar";
import { closeScreenshotLightbox, closeScreenshotMoveConfirm, closeShareModal } from "./features/screenshots/screenshots-view";
import { renderSettings } from "./features/settings/settings-view";
import { closeManagePopup } from "./features/manage/manage-view";
import { closeStorageManager } from "./features/storage/storage-view";
import { embeddedStoreHeld, hideStore, isStoreWarm, renderStoreLoadingScreen } from "./features/store/store-view";
import { hydrateTvMode, renderTvMode } from "./features/gamepad/tv-mode";

if (S.surface === "soft") document.documentElement.dataset.surface = "soft";
document.documentElement.classList.add("ready");
initSidebarLayout();

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
  document.body.classList.toggle("tv-mode", S.view === "tv");

  // When leaving the store, hard-hide the native webview to avoid overlap.
  // TV Mode keeps the child on screen while its store panel is open.
  if (S.view !== "store" && S.storeShown && !embeddedStoreHeld()) hideStore();

  // Page-enter animation only on a real view change. The class is dropped
  // first: a re-render landing while the previous animation still runs would
  // otherwise replay it on the new children (a detached node's cancel event
  // never reaches #view).
  viewEl.classList.remove("view-enter");
  if (S.view !== lastRenderedView) {
    lastRenderedView = S.view;
    viewEl.classList.add("view-enter");
    viewEl.scrollTop = 0;
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
    : S.view === "tv" ? renderTvMode()
    : renderSettings();
  if (S.view === "library") {
    setupLibScrollObserver();
    if (S.isColDropdownOpen) positionColDropdownMenu();
    if (libStripScroll > 0) {
      const strip = document.querySelector<HTMLElement>(".lib-filters");
      if (strip) strip.scrollLeft = libStripScroll;
    }
  }
  if (S.view === "tv") {
    hydrateTvMode();
  }
  if (S.view === "music") {
    hydrateMusic();
  }
  if (S.view === "downloads") {
    startSpeedChartTimer();
    drawSpeedCanvas();
    measureInstalledSizes();
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
  closeManagePopup();
  closeChangelogModal();
  if (selectiveRoot) selectiveRoot.innerHTML = "";
  if (playtimeRoot) playtimeRoot.innerHTML = "";
}

void initApp({ render, scheduleRender, closeAllModals });

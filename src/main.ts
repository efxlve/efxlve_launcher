/**
 * Application entry point.
 *
 * This file intentionally stays tiny: it owns only the render orchestrator and
 * the "close every modal" helper. All state lives in `src/core/state.ts`, all
 * features in `src/features/*`, and the IPC/bootstrap wiring in
 * `src/features/events/ipc-listeners.ts`.
 */

import "./styles/index.css";
import { closeModal, modalRoot, playtimeRoot, selectiveRoot, viewEl } from "./core/dom";
import { updateChrome, updateNavHistoryUi, updateNavIndicator } from "./core/nav";
import { S } from "./core/state";
import { closeCollectionModal } from "./features/collections/collections-view";
import { closeCustomCoverModal } from "./features/cover/cover-view";
import { drawSpeedCanvas, renderDownloads, startSpeedChartTimer } from "./features/downloads/downloads-view";
import { renderDlcManager } from "./features/dlc/dlc-manager";
import "./features/events/click-router";
import "./features/events/input-listeners";
import { initApp } from "./features/events/ipc-listeners";
import { updateGamepadHud } from "./features/gamepad/gamepad";
import { renderEpic, setupLibScrollObserver } from "./features/library/library-view";
import { renderOnboarding } from "./features/onboarding/onboarding-view";
import { closeNotifPanel, renderNotificationPanel } from "./features/notifications/notifications";
import { presenceSync } from "./core/render";
import { renderProfile } from "./features/profile/profile-view";
import { closeAvatarModal } from "./features/profile/profile-avatar";
import { closeScreenshotLightbox, closeShareModal } from "./features/screenshots/screenshots-view";
import { renderSettings } from "./features/settings/settings-view";
import { closeStorageManager } from "./features/storage/storage-view";
import { hideStore, renderStoreLoadingScreen } from "./features/store/store-view";

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
  // When leaving the store, hard-hide the native webview to avoid overlap.
  if (S.view !== "store" && S.storeShown) hideStore();

  const isAuthed = Boolean(S.epicAccount) && S.epicPhase === "library" && !S.authLoading;
  document.body.classList.toggle("auth-mode", !isAuthed);

  if (!isAuthed) {
    if (S.storeShown) hideStore();
    closeAllModals();
    viewEl.innerHTML = renderOnboarding();
    updateChrome();
    presenceSync();
    return;
  }

  document.querySelectorAll("#nav button").forEach((b) => {
    const el = b as HTMLElement;
    const active = S.view === "store" ? el.dataset.act === "open-store" : el.dataset.view === S.view;
    el.classList.toggle("active", active);
  });
  updateNavIndicator();

  if (S.view === "store") {
    // Only paint the loading screen until the native store webview is shown; a
    // re-render afterwards would restart the animation for nothing.
    if (!S.storeShown) viewEl.innerHTML = renderStoreLoadingScreen();
    updateChrome();
    renderNotificationPanel();
    presenceSync();
    return;
  }
  if (S.view !== "library" && modalRoot.innerHTML.trim()) {
    closeModal();
  }
  viewEl.innerHTML =
    S.view === "library" ? renderEpic()
    : S.view === "downloads" ? renderDownloads()
    : S.view === "dlc-manager" ? renderDlcManager()
    : S.view === "profile" ? renderProfile()
    : renderSettings();
  if (S.view === "library") {
    setupLibScrollObserver();
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
  closeShareModal();
  closeCustomCoverModal();
  closeCollectionModal();
  closeStorageManager();
  closeNotifPanel();
  closeAvatarModal();
  if (selectiveRoot) selectiveRoot.innerHTML = "";
  if (playtimeRoot) playtimeRoot.innerHTML = "";
}

void initApp({ render, scheduleRender, closeAllModals });

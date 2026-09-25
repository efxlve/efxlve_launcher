/**
 * Application entry point.
 *
 * This file intentionally stays tiny: it owns only the render orchestrator and
 * the "close every modal" helper. All state lives in `src/core/state.ts`, all
 * features in `src/features/*`, and the IPC/bootstrap wiring in
 * `src/features/events/ipc-listeners.ts`.
 */

import "./styles/index.css";
import { S } from "./core/state";
import { closeModal, modalRoot, playtimeRoot, selectiveRoot, viewEl } from "./core/dom";
import { updateChrome, updateNavHistoryUi } from "./core/nav";
import type { View } from "./core/types";
import { closeCollectionModal } from "./features/collections/collections-view";
import { closeCustomCoverModal } from "./features/cover/cover-view";
import { closeInstallDialog } from "./features/install/install-dialog";
import { drawSpeedCanvas, renderDownloads, startSpeedChartTimer } from "./features/downloads/downloads-view";
import "./features/events/click-router";
import "./features/events/input-listeners";
import { initApp } from "./features/events/ipc-listeners";
import { updateGamepadHud } from "./features/gamepad/gamepad";
import { renderEpic, setupLibScrollObserver } from "./features/library/library-view";
import { renderAccounts } from "./features/accounts/accounts-view";
import { closeNotifPanel, renderNotificationPanel } from "./features/notifications/notifications";
import { presenceSync } from "./core/render";
import { renderProfile } from "./features/profile/profile-view";
import { closeAvatarModal } from "./features/profile/profile-avatar";
import { closeScreenshotLightbox, closeShareModal } from "./features/screenshots/screenshots-view";
import { renderSettings } from "./features/settings/settings-view";
import { closeManagePopup } from "./features/manage/manage-view";
import { closeStorageManager } from "./features/storage/storage-view";
import { hideStore, renderStoreLoadingScreen } from "./features/store/store-view";

if (S.surface === "epic") document.documentElement.dataset.surface = "epic";
document.documentElement.classList.add("ready");

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
  // When leaving the store, hard-hide the native webview to avoid overlap.
  if (S.view !== "store" && S.storeShown) hideStore();

  // Page-enter animation only when the view actually changes; regular
  // re-renders of the same view must not replay it.
  if (S.view !== lastRenderedView) {
    lastRenderedView = S.view;
    viewEl.classList.add("view-enter");
    viewEl.scrollTop = 0;
  }

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
    : S.view === "profile" ? renderProfile()
    : S.view === "accounts" ? renderAccounts()
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
  closeInstallDialog();
  closeManagePopup();
  if (selectiveRoot) selectiveRoot.innerHTML = "";
  if (playtimeRoot) playtimeRoot.innerHTML = "";
}

void initApp({ render, scheduleRender, closeAllModals });

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
import { updateChrome, updateNavIndicator } from "./core/nav";
import { S } from "./core/state";
import { closeCollectionModal } from "./features/collections/collections-view";
import { closeCustomCoverModal } from "./features/cover/cover-view";
import { drawSpeedCanvas, renderDownloads } from "./features/downloads/downloads-view";
import { renderDlcManager } from "./features/dlc/dlc-manager";
import "./features/events/click-router";
import "./features/events/input-listeners";
import { initApp } from "./features/events/ipc-listeners";
import { updateGamepadHud } from "./features/gamepad/gamepad";
import { renderEpic, setupLibScrollObserver } from "./features/library/library-view";
import { renderProfile } from "./features/profile/profile-view";
import { closeScreenshotLightbox, closeShareModal } from "./features/screenshots/screenshots-view";
import { renderSettings } from "./features/settings/settings-view";
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

  document.querySelectorAll("#nav button").forEach((b) => {
    const el = b as HTMLElement;
    const active = S.view === "store" ? el.dataset.act === "open-store" : el.dataset.view === S.view;
    el.classList.toggle("active", active);
  });
  updateNavIndicator();

  if (S.view === "store") {
    viewEl.innerHTML = renderStoreLoadingScreen();
    updateChrome();
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
    drawSpeedCanvas();
  }
  updateChrome();
  updateGamepadHud(S.gamepadPolling);
}

/** Close every modal/drawer root. */
function closeAllModals(): void {
  closeModal();
  closeScreenshotLightbox();
  closeShareModal();
  closeCustomCoverModal();
  closeCollectionModal();
  if (selectiveRoot) selectiveRoot.innerHTML = "";
  if (playtimeRoot) playtimeRoot.innerHTML = "";
}

void initApp({ render, scheduleRender, closeAllModals });

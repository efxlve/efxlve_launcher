/**
 * Fullscreen Mode & Controller Focus Management.
 *
 * Replaces the retired TV Mode. When activated, the launcher enters full screen,
 * scales smoothly for couch/monitor viewing, and highlights navigable elements
 * with a high-visibility glowing focus ring for game controllers.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../core/constants";
import { S } from "../../core/state";
import { handleWindowResize } from "../../core/window";
import { t } from "../../i18n";
import { icon } from "../../core/icons";
import { initGamepadFocus, updateGamepadHud } from "./gamepad";

export function isFullscreenMode(): boolean {
  return S.isFullscreen;
}

export async function setFullscreenMode(on: boolean): Promise<void> {
  if (S.isFullscreen === on) return;
  S.isFullscreen = on;

  if (isTauri) {
    try {
      await invoke("app_set_fullscreen", { enabled: on });
      handleWindowResize();
    } catch {
      /* Fallback to web fullscreen */
      try {
        if (on && !document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
        } else if (!on && document.fullscreenElement) {
          await document.exitFullscreen();
        }
      } catch {
        /* Ignored */
      }
    }
  } else {
    try {
      if (on && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else if (!on && document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      /* Ignored */
    }
  }

  document.body.classList.toggle("fullscreen-mode", on);
  updateFullscreenUi();

  if (on) {
    initGamepadFocus();
  }
  updateGamepadHud(S.gamepadPolling);
}

export async function toggleFullscreenMode(): Promise<void> {
  await setFullscreenMode(!S.isFullscreen);
}

export function updateFullscreenUi(): void {
  const btn = document.getElementById("btn-fullscreen-mode");
  if (!btn) return;

  btn.classList.toggle("active", S.isFullscreen);
  const iconSpan = btn.querySelector(".fullscreen-icon-wrap");
  const labelSpan = btn.querySelector<HTMLElement>("[data-i18n]");

  if (S.isFullscreen) {
    btn.title = t("fullscreen.exit");
    if (iconSpan) iconSpan.innerHTML = icon("minimize-2", 14);
    if (labelSpan) labelSpan.textContent = t("fullscreen.exit");
  } else {
    btn.title = t("fullscreen.mode");
    if (iconSpan) iconSpan.innerHTML = icon("maximize-2", 14);
    if (labelSpan) labelSpan.textContent = t("fullscreen.mode");
  }
}

// Global F11 key shortcut for Fullscreen toggle
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "F11") {
    e.preventDefault();
    void toggleFullscreenMode();
  }
});

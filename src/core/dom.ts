/**
 * Cached references to the root DOM containers and shared modal helpers.
 *
 * These elements exist in `index.html` before the module loads, so they are
 * resolved once at import time instead of being queried on every render. This
 * keeps hot paths free of repeated `getElementById` calls.
 */

import { presenceSync, updateGamepadHud } from "./render";
import { S } from "./state";

/** Main view container that renders the active page. */
export const viewEl = document.getElementById("view") as HTMLElement;
/** Game detail drawer (modal) root. */
export const modalRoot = document.getElementById("modal-root") as HTMLElement;
/** Selective install modal root. */
export const selectiveRoot = document.getElementById("selective-root") as HTMLElement;
/** Playtime editor modal root. */
export const playtimeRoot = document.getElementById("playtime-root") as HTMLElement;
/** Cross-drive move modal root. */
export const moveModalRoot = document.getElementById("move-modal-root") as HTMLElement;
/** Toast notification container. */
export const toastsEl = document.getElementById("toasts") as HTMLElement;
/** Download counter badge in the top navigation. */
export const dlBadge = document.getElementById("dl-badge") as HTMLElement;
/** Context menu root (may be absent in minimal layouts). */
export const ctxRoot = document.getElementById("ctx-root") as HTMLElement | null;
/** Collections modal root. */
export const collectionRoot = document.getElementById("collection-root");

/** Close the game detail drawer and refresh the gamepad HUD. */
export function closeModal(): void {
  modalRoot.innerHTML = "";
  S.currentModalAppName = null;
  // Drop per-game manage state along with the drawer that owns the manage tab.
  S.activeManageSettings = null;
  updateGamepadHud(S.gamepadPolling);
  presenceSync();
}

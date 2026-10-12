/**
 * A small yes/no dialog on the shared modal root, answered through the click
 * router (and Escape). Destructive actions such as uninstall ask first, so a
 * stray click cannot remove a game.
 */

import { confirmRoot } from "./dom";
import { icon } from "./icons";
import { esc } from "./utils";
import { t } from "../i18n";

export interface ConfirmRequest {
  /** Dialog heading, e.g. "Uninstall Game". */
  title: string;
  /** Strong line above the body, usually the game name. */
  subject?: string;
  /** What will happen, in plain words. */
  body: string;
  /** Label of the danger button. */
  confirm: string;
  /** Label of the cancel button. */
  cancel: string;
  /** Icon in the tinted medallion; a warning triangle by default. */
  icon?: string;
}

let pending: ((answer: boolean) => void) | null = null;
let layer: HTMLElement | null = null;

function closeLayer(): void {
  layer?.remove();
  layer = null;
}

/** Opens the dialog; true when the user confirms, false on cancel/Escape. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  // A second request replaces the first: the replaced one counts as cancelled.
  if (pending) {
    const resolve = pending;
    pending = null;
    resolve(false);
  }
  closeLayer();
  const el = document.createElement("div");
  el.className = "confirm-layer";
  el.innerHTML = `
    <div class="modal-backdrop" data-act="confirm-cancel">
      <div class="modal confirm-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="confirm-head">
          <span class="confirm-icon">${icon((request.icon || "alert-triangle") as Parameters<typeof icon>[0], 19)}</span>
          <div class="confirm-head-text">
            <h3 class="modal-title">${esc(request.title)}</h3>
            ${request.subject ? `<p class="confirm-subject" title="${esc(request.subject)}">${esc(request.subject)}</p>` : ""}
          </div>
        </div>
        <p class="confirm-body">${esc(request.body)}</p>
        <div class="confirm-actions">
          <button type="button" class="btn ghost confirm-cancel" data-act="confirm-cancel">${esc(request.cancel)}</button>
          <button type="button" class="btn danger confirm-go" data-act="confirm-yes">${esc(request.confirm)}</button>
        </div>
      </div>
    </div>`;
  confirmRoot.appendChild(el);
  layer = el;
  // The safe action owns the keyboard: Enter cancels, Escape cancels.
  el.querySelector<HTMLButtonElement>('[data-act="confirm-cancel"]')?.focus();
  return new Promise((resolve) => {
    pending = resolve;
  });
}

/** Answers the open dialog; the click router and Escape both land here. */
export function answerConfirm(ok: boolean): void {
  const resolve = pending;
  pending = null;
  closeLayer();
  resolve?.(ok);
}

/** Cancels an open dialog; true when there was one (Escape handling). */
export function cancelConfirm(): boolean {
  if (!pending) return false;
  answerConfirm(false);
  return true;
}

/**
 * A small yes/no dialog on the shared modal root, answered through the click
 * router (and Escape). Destructive actions such as uninstall ask first, so a
 * stray click cannot remove a game.
 */

import { modalRoot } from "./dom";
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
}

let pending: ((answer: boolean) => void) | null = null;

/** Opens the dialog; true when the user confirms, false on cancel/Escape. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  // A second request replaces the first: the replaced one counts as cancelled.
  if (pending) {
    const resolve = pending;
    pending = null;
    resolve(false);
  }
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-act="confirm-cancel">
      <div class="modal confirm-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <h3 class="modal-title">${esc(request.title)}</h3>
        <div class="confirm-copy">
          ${request.subject ? `<p class="confirm-subject">${esc(request.subject)}</p>` : ""}
          <p class="confirm-body">${esc(request.body)}</p>
        </div>
        <div class="confirm-actions">
          <button type="button" class="btn ghost" data-act="confirm-cancel">${esc(request.cancel)}</button>
          <button type="button" class="btn danger" data-act="confirm-yes">${esc(request.confirm)}</button>
        </div>
      </div>
    </div>`;
  return new Promise((resolve) => {
    pending = resolve;
  });
}

/** Answers the open dialog; the click router and Escape both land here. */
export function answerConfirm(ok: boolean): void {
  const resolve = pending;
  pending = null;
  modalRoot.innerHTML = "";
  resolve?.(ok);
}

/** Cancels an open dialog; true when there was one (Escape handling). */
export function cancelConfirm(): boolean {
  if (!pending) return false;
  answerConfirm(false);
  return true;
}

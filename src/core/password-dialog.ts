/**
 * A small password prompt on the shared modal root.
 *
 * Profile exports are unencrypted unless the user supplies a password here;
 * an encrypted archive asks again on import. The dialog answers through the
 * click router and Escape, like the confirm dialog, so no per-element listeners
 * are added.
 */

import { confirmRoot } from "./dom";
import { icon } from "./icons";
import { esc } from "./utils";

export interface PasswordRequest {
  title: string;
  body: string;
  placeholder: string;
  confirm: string;
  cancel: string;
}

let pending: ((value: string | null) => void) | null = null;
let layer: HTMLElement | null = null;

function closeLayer(): void {
  layer?.remove();
  layer = null;
}

/** Opens the prompt; resolves to the typed value, or null on cancel/Escape. */
export function askPassword(request: PasswordRequest): Promise<string | null> {
  if (pending) {
    const resolve = pending;
    pending = null;
    resolve(null);
  }
  closeLayer();
  const el = document.createElement("div");
  el.className = "confirm-layer";
  el.innerHTML = `
    <div class="modal-backdrop" data-act="password-cancel">
      <div class="modal confirm-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="modal-head">
          <h3 class="modal-title">${esc(request.title)}</h3>
          <button type="button" class="manage-head-close" data-act="password-cancel" title="${esc(request.cancel)}">${icon("x", 16)}</button>
        </div>
        <p class="confirm-body">${esc(request.body)}</p>
        <input id="password-dialog-input" class="input password-dialog-input" type="password" autocomplete="new-password" spellcheck="false" placeholder="${esc(request.placeholder)}" aria-label="${esc(request.title)}" />
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-act="password-cancel">${esc(request.cancel)}</button>
          <button type="button" class="btn primary" data-act="password-confirm">${esc(request.confirm)}</button>
        </div>
      </div>
    </div>`;
  confirmRoot.appendChild(el);
  layer = el;
  el.querySelector<HTMLInputElement>("#password-dialog-input")?.focus();
  return new Promise((resolve) => {
    pending = resolve;
  });
}

/** Confirms with the current field value; an empty value means "no password". */
export function answerPassword(): void {
  const value = document.getElementById("password-dialog-input") as HTMLInputElement | null;
  const resolve = pending;
  pending = null;
  closeLayer();
  resolve?.(value?.value ?? "");
}

/** Cancels the prompt; true when there was one (Escape handling). */
export function cancelPassword(): boolean {
  if (!pending) return false;
  const resolve = pending;
  pending = null;
  closeLayer();
  resolve?.(null);
  return true;
}

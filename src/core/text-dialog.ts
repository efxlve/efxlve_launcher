/**
 * A one-field text prompt on the shared modal root.
 *
 * Local save backups use it for a user label ("Before the boss"). The dialog
 * answers through the click router and Escape, like the password prompt, so no
 * per-element listeners are added.
 */

import { confirmRoot } from "./dom";
import { icon } from "./icons";
import { esc } from "./utils";

export interface TextRequest {
  title: string;
  body: string;
  placeholder: string;
  value?: string;
  confirm: string;
  cancel: string;
  maxLength?: number;
}

let pending: ((value: string | null) => void) | null = null;
let layer: HTMLElement | null = null;

function closeLayer(): void {
  layer?.remove();
  layer = null;
}

/** Opens the prompt; resolves to the typed value, or null on cancel/Escape. */
export function askText(request: TextRequest): Promise<string | null> {
  if (pending) {
    const resolve = pending;
    pending = null;
    resolve(null);
  }
  closeLayer();
  const max = request.maxLength ?? 80;
  const el = document.createElement("div");
  el.className = "confirm-layer";
  el.innerHTML = `
    <div class="modal-backdrop" data-act="text-cancel">
      <div class="modal confirm-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="modal-head">
          <h3 class="modal-title">${esc(request.title)}</h3>
          <button type="button" class="manage-head-close" data-act="text-cancel" title="${esc(request.cancel)}">${icon("x", 16)}</button>
        </div>
        <p class="confirm-body">${esc(request.body)}</p>
        <input id="text-dialog-input" class="input password-dialog-input" type="text" maxlength="${max}" autocomplete="off" spellcheck="false" placeholder="${esc(request.placeholder)}" value="${esc(request.value ?? "")}" aria-label="${esc(request.title)}" />
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-act="text-cancel">${esc(request.cancel)}</button>
          <button type="button" class="btn primary" data-act="text-confirm">${esc(request.confirm)}</button>
        </div>
      </div>
    </div>`;
  confirmRoot.appendChild(el);
  layer = el;
  const input = el.querySelector<HTMLInputElement>("#text-dialog-input");
  input?.focus();
  input?.select();
  return new Promise((resolve) => {
    pending = resolve;
  });
}

/** Confirms with the current value; an empty answer clears the label. */
export function answerText(): void {
  const value = (document.getElementById("text-dialog-input") as HTMLInputElement | null)?.value ?? "";
  const resolve = pending;
  pending = null;
  closeLayer();
  resolve?.(value.trim());
}

/** Cancels the prompt; true when there was one (Escape handling). */
export function cancelText(): boolean {
  if (!pending) return false;
  const resolve = pending;
  pending = null;
  closeLayer();
  resolve?.(null);
  return true;
}

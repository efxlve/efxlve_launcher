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
  /** Filled into the body's `{name}` placeholder, in bold. */
  name?: string;
  /** What will happen, in plain words; `{name}` is replaced. */
  body: string;
  /** Label of the danger button. */
  confirm: string;
  /** Label of the cancel button. */
  cancel: string;
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
  // The name is filled into the translated line, bolded, so the sentence stays
  // in each language's own grammar.
  const parts = esc(request.body).split("{name}");
  const bodyHtml = parts
    .map((part, index) =>
      index === 0 || !request.name ? part : `<strong>${esc(request.name)}</strong>${part}`,
    )
    .join("");
  const el = document.createElement("div");
  el.className = "confirm-layer";
  el.innerHTML = `
    <div class="modal-backdrop" data-act="confirm-cancel">
      <div class="modal confirm-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="modal-head">
          <h3 class="modal-title">${esc(request.title)}</h3>
          <button type="button" class="manage-head-close" data-act="confirm-cancel" title="${esc(request.cancel)}">${icon("x", 16)}</button>
        </div>
        <p class="confirm-body">${bodyHtml}</p>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-act="confirm-cancel">${esc(request.cancel)}</button>
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

export interface ChoiceOption {
  value: string;
  label: string;
  hint?: string;
  details?: string[];
  primary?: boolean;
}

export interface ChoiceRequest {
  title: string;
  body: string;
  options: ChoiceOption[];
  note?: string;
  cancel: string;
}

let choicePending: ((value: string | null) => void) | null = null;
let choiceLayer: HTMLElement | null = null;

function closeChoiceLayer(): void {
  choiceLayer?.remove();
  choiceLayer = null;
}

/** Opens a small multi-choice dialog; resolves to the chosen value or null. */
export function askChoice(request: ChoiceRequest): Promise<string | null> {
  if (pending) answerConfirm(false);
  if (choicePending) {
    const resolve = choicePending;
    choicePending = null;
    resolve(null);
  }
  closeChoiceLayer();
  const el = document.createElement("div");
  el.className = "confirm-layer";
  el.innerHTML = `
    <div class="modal-backdrop" data-act="choice-cancel">
      <div class="modal confirm-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="modal-head">
          <h3 class="modal-title">${esc(request.title)}</h3>
          <button type="button" class="manage-head-close" data-act="choice-cancel" title="${esc(request.cancel)}">${icon("x", 16)}</button>
        </div>
        <p class="confirm-body">${esc(request.body)}</p>
        <div class="choice-options">
          ${request.options
            .map(
              (option) =>
                `<button type="button" class="btn ${option.primary ? "primary" : "ghost"} choice-option" data-act="choice-pick" data-value="${esc(option.value)}"><strong>${esc(option.label)}</strong>${option.hint ? `<span>${esc(option.hint)}</span>` : ""}${option.details?.length ? `<ul class="choice-details">${option.details.map((detail) => `<li>${esc(detail)}</li>`).join("")}</ul>` : ""}</button>`,
            )
            .join("")}
        </div>
        ${request.note ? `<p class="choice-note">${esc(request.note)}</p>` : ""}
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-act="choice-cancel">${esc(request.cancel)}</button>
        </div>
      </div>
    </div>`;
  confirmRoot.appendChild(el);
  choiceLayer = el;
  el.querySelector<HTMLButtonElement>('[data-act="choice-pick"]')?.focus();
  return new Promise((resolve) => {
    choicePending = resolve;
  });
}

/** Answers the open choice dialog; the click router and Escape land here. */
export function answerChoice(value: string | null): void {
  const resolve = choicePending;
  choicePending = null;
  closeChoiceLayer();
  resolve?.(value);
}

/** Cancels an open choice dialog; true when there was one. */
export function cancelChoice(): boolean {
  if (!choicePending) return false;
  answerChoice(null);
  return true;
}

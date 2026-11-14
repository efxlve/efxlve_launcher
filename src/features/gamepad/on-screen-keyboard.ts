/**
 * On-screen keyboard for Full Screen Mode.
 *
 * The keyboard is a controller surface, not a text field replacement: the real
 * input keeps DOM focus, every key is a `data-gp-item` button, and the gamepad
 * loop routes A/B/X/Y to type, close, delete and add a space. Mouse and touch
 * work on the same keys, and physical typing keeps working because the field
 * never loses focus.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { currentLanguage, t } from "../../i18n";
import { faceGlyph, hudItem, bumperGlyphs } from "./pad-hints";
import { applyTextEdit, isTextEntryTarget } from "./text-entry";

interface Key {
  /** Inserted character or command key. */
  key: string;
  /** Visible label when the letters layer is active. */
  label?: string;
  className?: string;
}

const LETTER_ROWS: string[][] = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];

const NUMBER_ROW = [..."1234567890"];
const SYMBOL_ROWS: string[][] = [
  ["@", "#", "&", "*", "(", ")", "_", "+", "-", "="],
  [".", ",", ":", ";", "!", "?", "/", "'", "\""],
  ["%", "$", "€", "£", "~", "<", ">", "[", "]", "{", "}"],
];

/**
 * Letters the Latin rows do not carry. Without them a Turkish player cannot
 * type "ışık" or "çığlık" with a pad, and the same holds for German umlauts,
 * French accents and Polish diacritics.
 */
const EXTRA_LETTERS: Record<string, string[]> = {
  tr: ["ç", "ğ", "ı", "ö", "ş", "ü"],
  de: ["ä", "ö", "ü", "ß"],
  fr: ["à", "â", "ç", "é", "è", "ê", "ë", "î", "ï", "ô", "ù", "û", "ü", "ÿ", "œ"],
  es: ["á", "é", "í", "ó", "ú", "ñ", "ü"],
  it: ["à", "è", "é", "ì", "ò", "ù"],
  pl: ["ą", "ć", "ę", "ł", "ń", "ó", "ś", "ź", "ż"],
  "pt-BR": ["á", "â", "ã", "à", "ç", "é", "ê", "í", "ó", "ô", "õ", "ú", "ü"],
};

type Target = HTMLInputElement | HTMLTextAreaElement;

let target: Target | null = null;
let shift = false;
let symbols = false;
let layer: HTMLElement | null = null;
/** A just-closed keyboard must not be reopened by the same focused field. */
let suppressAutoOpenUntil = 0;

function root(): HTMLElement | null {
  return document.getElementById("couch-root");
}

function upper(label: string): string {
  // Turkish dotted/dotless i needs the locale-aware mapper.
  return label.toLocaleUpperCase(currentLanguage());
}

function keyButton(key: Key, gpKey: string, extra = "", tag: "button" | "span" = "button"): string {
  if (tag === "span") {
    return `<span class="couch-key couch-key-spacer" aria-hidden="true" ${extra}>${esc(key.label ?? key.key)}</span>`;
  }
  return `<button type="button" class="couch-key${key.className ? ` ${key.className}` : ""}" data-act="couch-key" data-key="${esc(key.key)}" data-gp-item data-gp-key="osk:${esc(gpKey)}" ${extra}>${esc(key.label ?? key.key)}</button>`;
}

function row(keys: Key[], offset = 0, className = "", gpPrefix = "key"): string {
  return `<div class="couch-keyboard-row${className ? ` ${className}` : ""}" style="--couch-key-offset:${offset}">
    ${keys.map((key) => {
      const extra = key.key === "q"
        ? `data-gp-default data-char="${esc(key.key)}"`
        : key.key.length === 1
          ? `data-char="${esc(key.key)}"`
          : "";
      return keyButton(key, `${gpPrefix}:${key.key}`, extra);
    }).join("")}
  </div>`;
}

function letterKey(char: string): Key {
  return { key: char, label: shift ? upper(char) : char };
}

function keyboardBody(): string {
  if (symbols) {
    return `
      <div class="couch-keyboard-row couch-keyboard-row-numbers">${NUMBER_ROW.map((char) => keyButton(letterKey(char), `key:${char}`, `data-char="${esc(char)}"`)).join("")}</div>
      ${SYMBOL_ROWS.map((keys, index) => row(keys.map((char) => ({ key: char, label: char })), index % 2 === 0 ? 0 : 1)).join("")}
    `;
  }
  const extra = EXTRA_LETTERS[currentLanguage()] ?? [];
  return `
    <div class="couch-keyboard-row couch-keyboard-row-numbers">${NUMBER_ROW.map((char) => keyButton(letterKey(char), `key:${char}`, `data-char="${esc(char)}"`)).join("")}</div>
    ${LETTER_ROWS.map((keys, index) => row(keys.map(letterKey), index, "", "letters")).join("")}
    ${extra.length ? `<div class="couch-keyboard-row couch-keyboard-row-extra" style="--couch-key-offset:1">${extra.map((char) => keyButton({ key: char, label: shift ? upper(char) : char }, `extra:${char}`, `data-char="${esc(char)}"`)).join("")}</div>` : ""}
  `;
}

function bottomRow(): string {
  const shiftKey = symbols
    ? ""
    : keyButton({ key: "shift", label: t("couch.shift"), className: shift ? " is-active" : "" }, "shift");
  return `<div class="couch-keyboard-row couch-keyboard-row-bottom">
    ${shiftKey}
    <button type="button" class="couch-key couch-key-icon" data-act="couch-key" data-key="left" data-gp-item data-gp-key="osk:left" aria-label="${esc(t("couch.moveLeft"))}">${icon("chevron-left", 18)}</button>
    <button type="button" class="couch-key couch-key-icon" data-act="couch-key" data-key="right" data-gp-item data-gp-key="osk:right" aria-label="${esc(t("couch.moveRight"))}">${icon("chevron-right", 18)}</button>
    <button type="button" class="couch-key couch-key-wide" data-act="couch-key" data-key="space" data-gp-item data-gp-key="osk:space">${esc(t("couch.keySpace"))}</button>
    <button type="button" class="couch-key couch-key-icon" data-act="couch-key" data-key="backspace" data-gp-item data-gp-key="osk:backspace" aria-label="${esc(t("couch.keyBackspace"))}">${icon("arrow-left", 18)}</button>
    <button type="button" class="couch-key" data-act="couch-key" data-key="${symbols ? "letters" : "symbols"}" data-gp-item data-gp-key="osk:symbols">${esc(symbols ? t("couch.letters") : t("couch.symbols"))}</button>
    <button type="button" class="couch-key couch-key-accent" data-act="couch-key" data-key="done" data-gp-item data-gp-key="osk:done">${esc(t("couch.keyDone"))}</button>
  </div>`;
}

function targetLabel(): string {
  if (!target) return t("couch.keyboard");
  return target.getAttribute("aria-label")
    || target.placeholder
    || target.id
    || t("couch.keyboard");
}

function paint(): void {
  if (!layer) return;
  layer.innerHTML = `
    <button type="button" class="couch-keyboard-backdrop" data-act="close-controller-keyboard" tabindex="-1" aria-hidden="true"></button>
    <div class="couch-keyboard" role="dialog" aria-modal="true" aria-label="${esc(t("couch.keyboard"))}" dir="ltr">
      <div class="couch-keyboard-head">
        <span class="couch-keyboard-heading">${icon("keyboard", 18)}<span>${esc(t("couch.keyboard"))}</span></span>
        <span class="couch-keyboard-target">${esc(targetLabel())}</span>
        <button type="button" class="couch-keyboard-close" data-act="close-controller-keyboard" data-gp-item data-gp-key="osk:close" aria-label="${esc(t("common.close"))}">${icon("x", 18)}</button>
      </div>
      <div class="couch-keyboard-keys">${keyboardBody()}</div>
      ${bottomRow()}
      <div class="couch-keyboard-foot">
        ${hudItem(faceGlyph(S.gamepadKind, S.fullscreenSwapAB ? "b" : "a"), t("gamepad.select"))}
        ${hudItem(faceGlyph(S.gamepadKind, S.fullscreenSwapAB ? "a" : "b"), t("common.close"))}
        ${hudItem(faceGlyph(S.gamepadKind, "x"), t("couch.keyBackspace"))}
        ${hudItem(faceGlyph(S.gamepadKind, "y"), t("couch.keySpace"))}
        ${hudItem(bumperGlyphs(S.gamepadKind), `${t("couch.shift")} / ${t("couch.symbols")}`)}
        <span class="couch-keyboard-hint">${esc(t("couch.keyboardHint"))}</span>
      </div>
    </div>`;
}

/** Update the visible letter labels without replacing the focused button. */
function paintCase(): void {
  layer?.querySelectorAll<HTMLElement>(".couch-key[data-char]").forEach((button) => {
    const char = button.dataset.char ?? "";
    if (char.length !== 1) return;
    button.textContent = shift ? upper(char) : char;
  });
}

function ensureLayer(): HTMLElement | null {
  const host = root();
  if (!host) return null;
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "couch-keyboard-layer";
    layer.dataset.couchKeyboard = "";
    // A real mouse click moves DOM focus to the key. Put it back on the field
    // after the router has applied the key; the keyboard itself stays open.
    layer.addEventListener("click", (event) => {
      const key = event.target instanceof Element ? event.target.closest(".couch-key") : null;
      if (!key) return;
      window.setTimeout(() => {
        if (target?.isConnected) {
          try {
            target.focus({ preventScroll: true });
          } catch {
            /* The dialog may have closed in the same tick. */
          }
        }
      }, 0);
    });
    host.appendChild(layer);
  }
  return layer;
}

function currentSelection(): { start: number; end: number } {
  if (!target) return { start: 0, end: 0 };
  return {
    start: target.selectionStart ?? target.value.length,
    end: target.selectionEnd ?? target.value.length,
  };
}

function apply(editKey: string): void {
  if (!target) return;
  if (!target.isConnected) {
    closeControllerKeyboard();
    return;
  }
  const { start, end } = currentSelection();
  const maxLength = target.maxLength > 0 ? target.maxLength : 0;
  const edit = applyTextEdit(target.value, start, end, editKey, maxLength);
  target.value = edit.value;
  try {
    target.setSelectionRange(edit.caret, edit.caret);
  } catch {
    /* Some input types reject selection updates; the value still changed. */
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Keep the field above the keyboard instead of under it. */
function revealTarget(): void {
  if (!target) return;
  const panel = layer?.querySelector<HTMLElement>(".couch-keyboard");
  const rect = target.getBoundingClientRect();
  const panelTop = panel?.getBoundingClientRect().top ?? window.innerHeight * 0.55;
  if (rect.bottom > panelTop - 16 || rect.top < 0) {
    try {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {
      /* A detached field has nothing to scroll. */
    }
  }
}

/** Re-route the ring into the keyboard after its key set was rebuilt. */
function restoreRing(key = "osk:letters:q"): void {
  window.dispatchEvent(new CustomEvent("controller-keyboard-focus", { detail: { key } }));
}

export function isControllerKeyboardOpen(): boolean {
  return Boolean(layer?.isConnected);
}

export function openControllerKeyboard(el: Element | null = document.activeElement): void {
  if (!S.fullscreenKeyboard) return;
  if (!isTextEntryTarget(el)) return;
  // A live result list can repaint under the same field; an open keyboard is
  // already the right surface and must not reset the player's key position.
  if (isControllerKeyboardOpen() && target === el) return;
  const host = ensureLayer();
  if (!host) return;
  suppressAutoOpenUntil = 0;
  if (target !== el) {
    target = el;
    shift = false;
    symbols = false;
  }
  paint();
  document.body.classList.add("controller-keyboard-open");
  try {
    el.focus({ preventScroll: true });
    // A programmatic click does not place the caret. A couch player expects
    // the new text at the end of the existing value, not before it.
    if (el.value.length > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
      el.setSelectionRange(el.value.length, el.value.length);
    }
  } catch {
    /* A field in a closing dialog has nowhere to focus. */
  }
  window.requestAnimationFrame(revealTarget);
  window.dispatchEvent(new CustomEvent("controller-keyboard-open"));
}

export function closeControllerKeyboard(): void {
  if (!layer) return;
  const previous = target;
  layer.remove();
  layer = null;
  target = null;
  shift = false;
  symbols = false;
  // The field keeps DOM focus after Back. Without this guard the next scope
  // mutation (the palette result patch, a toast) would reopen the keyboard at
  // once and Back would stop working.
  suppressAutoOpenUntil = performance.now() + 900;
  document.body.classList.remove("controller-keyboard-open");
  if (previous?.isConnected) {
    try {
      previous.focus({ preventScroll: true });
    } catch {
      /* A dialog may be unmounting; there is no field to return to. */
    }
  }
  window.dispatchEvent(new CustomEvent("controller-keyboard-close"));
}

/** True right after an explicit close, so scope changes do not reopen it. */
export function controllerKeyboardRecentlyClosed(): boolean {
  return performance.now() < suppressAutoOpenUntil;
}

/** Called by the poller when the field or its dialog disappeared. */
export function syncControllerKeyboard(): void {
  if (!isControllerKeyboardOpen()) return;
  if (!target?.isConnected) closeControllerKeyboard();
}

/** Apply one virtual key. Also the click-router entry point. */
export function controllerKeyboardPress(key: string): void {
  if (!target) {
    closeControllerKeyboard();
    return;
  }
  if (key === "close" || key === "done") {
    closeControllerKeyboard();
    return;
  }
  if (key === "shift") {
    shift = !shift;
    paintCase();
    layer?.querySelector<HTMLElement>('[data-gp-key="osk:shift"]')?.classList.toggle("is-active", shift);
    return;
  }
  if (key === "symbols" || key === "letters" || key === "layout") {
    symbols = key === "layout" ? !symbols : key === "symbols";
    shift = false;
    paint();
    restoreRing("osk:symbols");
    return;
  }
  if (key === "left" || key === "right" || key === "backspace" || key === "clear") {
    apply(key);
    return;
  }
  if (key === "space") {
    apply("space");
    return;
  }
  if (key.length !== 1) return;
  apply(shift ? upper(key) : key);
  if (shift) {
    shift = false;
    paintCase();
    layer?.querySelector<HTMLElement>('[data-gp-key="osk:shift"]')?.classList.remove("is-active");
  }
}

// A mouse click on another field ends the keyboard session for the old one;
// the pad path keeps the target because its keys never take DOM focus.
document.addEventListener("focusin", (event) => {
  if (!isControllerKeyboardOpen()) return;
  const next = event.target;
  if (next === target || !(next instanceof Element)) return;
  if (next.closest("#couch-root .couch-keyboard")) return;
  closeControllerKeyboard();
});

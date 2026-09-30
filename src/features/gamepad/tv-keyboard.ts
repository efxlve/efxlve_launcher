/**
 * On-screen keyboard for TV Mode search.
 *
 * Opens only while a controller is connected, so a mouse-and-keyboard session
 * keeps the normal text field. D-pad moves, A types, B closes.
 */

import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { getTvSearchQuery, setTvSearchQuery } from "./tv-mode";

type KeyKind = "char" | "space" | "back" | "shift" | "lang" | "done";

interface OskKey {
  kind: KeyKind;
  label: string;
  value?: string;
  wide?: boolean;
}

const EN_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const TR_ROWS = ["qwertyuıopğü", "asdfghjklşi", "zxcvbnmöç"];

let open = false;
let buffer = "";
let shift = false;
let lang: "en" | "tr" = "en";
let row = 0;
let col = 0;
let rows: OskKey[][] = [];

export function tvControllerConnected(): boolean {
  if (S.gamepadPolling) return true;
  const pads = navigator.getGamepads?.();
  if (!pads) return false;
  for (const pad of pads) {
    if (pad?.connected) return true;
  }
  return false;
}

export function tvKeyboardOpen(): boolean {
  return open;
}

export function openTvKeyboard(): void {
  buffer = getTvSearchQuery();
  lang = (S.appLanguage || "en").toLowerCase().startsWith("tr") ? "tr" : "en";
  shift = false;
  row = 0;
  col = 0;
  open = true;
  rebuild();
  ensureRoot().innerHTML = markup();
  paintFocus();
  document.dispatchEvent(new Event("efxlve-hud"));
}

export function tvKeyboardClose(): void {
  if (!open) return;
  open = false;
  document.getElementById("tv-osk")?.remove();
  document.dispatchEvent(new Event("efxlve-hud"));
}

export function tvKeyboardMove(dir: "up" | "down" | "left" | "right"): void {
  if (!open || rows.length === 0) return;
  if (dir === "left") col = (col + rows[row].length - 1) % rows[row].length;
  else if (dir === "right") col = (col + 1) % rows[row].length;
  else if (dir === "up") {
    row = (row + rows.length - 1) % rows.length;
    col = Math.min(col, rows[row].length - 1);
  } else {
    row = (row + 1) % rows.length;
    col = Math.min(col, rows[row].length - 1);
  }
  paintFocus();
}

export function tvKeyboardActivate(): void {
  if (!open) return;
  const key = rows[row]?.[col];
  if (!key) return;
  if (key.kind === "char" && key.value) typeChar(key.value);
  else if (key.kind === "space") typeChar(" ");
  else if (key.kind === "back") backspace();
  else if (key.kind === "shift") {
    shift = !shift;
    const keepRow = row;
    const keepCol = col;
    rebuild();
    row = keepRow;
    col = Math.min(keepCol, rows[row].length - 1);
    ensureRoot().innerHTML = markup();
    paintFocus();
  } else if (key.kind === "lang") {
    lang = lang === "tr" ? "en" : "tr";
    const keepRow = row;
    const keepCol = col;
    rebuild();
    row = Math.min(keepRow, rows.length - 1);
    col = Math.min(keepCol, rows[row].length - 1);
    ensureRoot().innerHTML = markup();
    paintFocus();
  } else if (key.kind === "done") {
    tvKeyboardClose();
  }
}

export function tvKeyboardInsert(ch: string): void {
  if (!open || ch.length !== 1) return;
  typeChar(ch);
}

export function tvKeyboardBackspace(): void {
  if (!open) return;
  backspace();
}

function typeChar(ch: string): void {
  if (buffer.length >= 48) return;
  buffer += ch;
  if (shift) {
    shift = false;
    rebuild();
    ensureRoot().innerHTML = markup();
    paintFocus();
  }
  commit();
}

function backspace(): void {
  buffer = buffer.slice(0, -1);
  commit();
}

function commit(): void {
  setTvSearchQuery(buffer);
  const preview = document.getElementById("tv-osk-preview");
  if (preview) {
    preview.textContent = buffer || t("tv.searchPlaceholder");
    preview.classList.toggle("is-empty", buffer.length === 0);
  }
  paintFocus();
}

function rebuild(): void {
  const letters = (lang === "tr" ? TR_ROWS : EN_ROWS).map((line) =>
    [...line].map((ch): OskKey => {
      const value = shift ? ch.toLocaleUpperCase(lang === "tr" ? "tr" : "en") : ch;
      return { kind: "char", label: value, value };
    }),
  );
  rows = [
    ...letters,
    [
      { kind: "shift", label: "Aa" },
      { kind: "lang", label: lang === "tr" ? "TR" : "EN" },
      { kind: "space", label: t("tv.oskSpace"), wide: true },
      { kind: "back", label: t("tv.oskBack") },
      { kind: "done", label: t("tv.oskDone") },
    ],
  ];
}

function markup(): string {
  const preview = buffer || t("tv.searchPlaceholder");
  const grid = rows.map((keys, r) => `
    <div class="tv-osk-row">
      ${keys.map((key, c) => `
        <button type="button"
          class="tv-osk-key${key.wide ? " is-wide" : ""}${key.kind === "shift" && shift ? " is-on" : ""}${key.kind === "done" ? " is-done" : ""}"
          data-tv-osk-kind="${key.kind}"
          data-tv-osk-row="${r}"
          data-tv-osk-col="${c}">${esc(key.label)}</button>`).join("")}
    </div>`).join("");
  return `
    <div class="tv-osk-preview${buffer ? "" : " is-empty"}" id="tv-osk-preview">${esc(preview)}</div>
    ${grid}`;
}

function ensureRoot(): HTMLElement {
  let root = document.getElementById("tv-osk");
  if (!root) {
    root = document.createElement("div");
    root.id = "tv-osk";
    root.className = "tv-osk";
    document.body.appendChild(root);
  }
  return root;
}

function paintFocus(): void {
  document.querySelectorAll(".tv-osk-key.focused").forEach((el) => el.classList.remove("focused"));
  document.querySelector<HTMLElement>(`[data-tv-osk-row="${row}"][data-tv-osk-col="${col}"]`)?.classList.add("focused");
}


document.addEventListener("click", (e) => {
  if (!open) return;
  const key = (e.target as HTMLElement).closest<HTMLElement>("[data-tv-osk-kind]");
  if (!key) return;
  e.preventDefault();
  e.stopPropagation();
  row = Number(key.dataset.tvOskRow);
  col = Number(key.dataset.tvOskCol);
  tvKeyboardActivate();
}, true);

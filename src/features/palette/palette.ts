/**
 * Command palette (Ctrl+K): instant game search plus page and action shortcuts.
 *
 * Each result carries the same data-act / data-view attributes the rest of the
 * UI uses, so selecting one simply clicks it and the global click router does
 * the work. Matching is a bounded linear scan over lowercase titles that stops
 * after MAX_GAMES hits, which stays well under a millisecond for 500+ games.
 */

import { rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { emptyState, icon, type IconName } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { epicPortrait } from "../../epic";

const MAX_GAMES = 8;

interface Command {
  label: string;
  iconName: IconName;
  attrs: string;
  keywords: string;
}

let activeIndex = 0;

function root(): HTMLElement | null {
  return document.getElementById("palette-root");
}

export function isPaletteOpen(): boolean {
  return Boolean(root()?.firstElementChild);
}

function commands(): Command[] {
  const list: Command[] = [
    { label: t("nav.library"), iconName: "layout-grid", attrs: `data-view="library"`, keywords: "library kutuphane" },
    { label: t("nav.store"), iconName: "external", attrs: `data-act="open-store"`, keywords: "store magaza epic" },
    { label: t("nav.downloads"), iconName: "download", attrs: `data-view="downloads"`, keywords: "downloads indirmeler queue" },
    { label: t("palette.cmdProfile"), iconName: "users", attrs: `data-view="profile"`, keywords: "profile profil friends" },
    { label: t("palette.cmdSettings"), iconName: "settings", attrs: `data-view="settings"`, keywords: "settings ayarlar" },
    { label: t("palette.cmdRefresh"), iconName: "refresh", attrs: `data-act="epic-refresh"`, keywords: "refresh sync yenile" },
    { label: t("palette.cmdStorage"), iconName: "hard-drive", attrs: `data-act="open-storage-manager"`, keywords: "storage disk depolama" },
    { label: t("palette.cmdOffline"), iconName: S.offlineMode ? "wifi" : "wifi-off", attrs: `data-act="toggle-offline-mode"`, keywords: "offline online cevrimdisi" },
  ];
  return list;
}

function gameItem(appName: string, title: string, installed: boolean, idx: number): string {
  const raw = rawOf(appName);
  const cover = S.customCovers[appName] || (raw ? epicPortrait(raw) : null);
  const action = installed
    ? `<button class="btn play small" data-act="epic-play" data-id="${esc(appName)}" tabindex="-1">${t("palette.play")}</button>`
    : "";
  return `
    <div class="palette-item" data-idx="${idx}" data-act="epic-detail" data-id="${esc(appName)}" role="option">
      ${cover ? `<img class="palette-thumb" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="palette-thumb"></span>`}
      <span class="palette-label">${esc(title)}</span>
      ${installed ? `<span class="chip ok">${t("library.installed")}</span>` : ""}
      ${action}
    </div>`;
}

function renderResults(query: string): void {
  const list = document.getElementById("palette-results");
  if (!list) return;
  const q = query.trim().toLowerCase();

  const games: string[] = [];
  let idx = 0;
  if (q) {
    // Installed matches first, then the rest, capped at MAX_GAMES.
    const matched: typeof S.epicSummaries = [];
    for (const s of S.epicSummaries) {
      if (s.installed && s.title.toLowerCase().includes(q)) matched.push(s);
      if (matched.length >= MAX_GAMES) break;
    }
    if (matched.length < MAX_GAMES) {
      for (const s of S.epicSummaries) {
        if (!s.installed && s.title.toLowerCase().includes(q)) matched.push(s);
        if (matched.length >= MAX_GAMES) break;
      }
    }
    for (const s of matched) games.push(gameItem(s.appName, s.title, s.installed, idx++));
  } else {
    for (const id of S.epicRecent.slice(0, 5)) {
      const s = S.epicSummariesMap.get(id);
      if (s) games.push(gameItem(s.appName, s.title, s.installed, idx++));
    }
  }

  const cmds = commands()
    .filter((c) => !q || c.label.toLowerCase().includes(q) || c.keywords.includes(q))
    .map((c) => `<div class="palette-item" data-idx="${idx++}" ${c.attrs} role="option">${icon(c.iconName, 16)}<span class="palette-label">${esc(c.label)}</span></div>`);

  list.innerHTML =
    (games.length ? `<div class="palette-group">${t("palette.games")}</div>${games.join("")}` : "") +
    (cmds.length ? `<div class="palette-group">${t("palette.commands")}</div>${cmds.join("")}` : "") +
    (!games.length && !cmds.length ? emptyState("search", t("palette.empty")) : "");
  activeIndex = 0;
  highlight();
}

function items(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("#palette-results .palette-item"));
}

function highlight(): void {
  items().forEach((el, i) => {
    const on = i === activeIndex;
    el.classList.toggle("active", on);
    if (on) el.scrollIntoView({ block: "nearest" });
  });
}

export function closePalette(): void {
  const r = root();
  if (r) r.innerHTML = "";
}

/** Run a palette entry through the global click router, then close. */
function run(el: HTMLElement): void {
  el.click();
  closePalette();
}

export function openPalette(): void {
  const r = root();
  if (!r) return;
  r.innerHTML = `
    <div class="palette-backdrop" data-palette-close>
      <div class="palette" role="dialog" aria-label="${esc(t("palette.open"))}">
        <label class="palette-input">${icon("search", 16)}<input id="palette-input" placeholder="${esc(t("palette.placeholder"))}" autocomplete="off" spellcheck="false" /><span class="kbd">Esc</span></label>
        <div id="palette-results" class="palette-results" role="listbox"></div>
        <div class="palette-hint">${t("palette.hint")}</div>
      </div>
    </div>`;
  const input = document.getElementById("palette-input") as HTMLInputElement | null;
  input?.focus();
  renderResults("");
}

function onKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (isPaletteOpen()) closePalette();
    else openPalette();
    return;
  }
  if (!isPaletteOpen()) return;
  const list = items();
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closePalette();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    if (list.length === 0) return;
    activeIndex = (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
    highlight();
  } else if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    const el = list[activeIndex];
    if (el) run(el);
  }
}

document.addEventListener("keydown", onKey, { capture: true });

document.addEventListener("input", (e) => {
  const target = e.target as HTMLElement;
  if (target.id === "palette-input") renderResults((target as HTMLInputElement).value);
});

// Clicks inside the palette: the document-level router handles the item's
// data-act/data-view first (it is registered earlier), then the palette closes.
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const r = root();
  if (!r || !r.contains(target)) return;
  if (target.closest(".palette-item, .palette-item button") || target.hasAttribute("data-palette-close")) {
    window.setTimeout(closePalette, 0);
  }
});

document.addEventListener("mousemove", (e) => {
  const item = (e.target as HTMLElement).closest?.<HTMLElement>(".palette-item");
  if (!item || !isPaletteOpen()) return;
  const idx = Number(item.dataset.idx);
  if (!Number.isNaN(idx) && idx !== activeIndex) {
    activeIndex = idx;
    items().forEach((el, i) => el.classList.toggle("active", i === activeIndex));
  }
}, { passive: true });

/**
 * Command palette (Ctrl+K): instant game search plus page and action shortcuts.
 *
 * Each result carries the same data-act / data-view attributes the rest of the
 * UI uses, so selecting one simply clicks it and the global click router does
 * the work. Matching is a bounded linear scan over lowercase titles that stops
 * after MAX_GAMES hits, which stays well under a millisecond for 500+ games.
 */

import { allStoreSummaries, rawOf, sharedOwnerOf, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { emptyState, icon, type IconName } from "../../core/icons";
import {
  discordPageVisible,
  notesSidebarVisible,
  screenshotsSidebarVisible,
  spotifyPageVisible,
} from "../../core/page-visibility";
import { esc } from "../../core/utils";
import { igdbImage } from "../../igdb";
import { t } from "../../i18n";
import {
  epicPortrait,
  epicUpcomingReleases,
  type EpicSummary,
  type UpcomingRelease,
} from "../../epic";
import { holdStoreForPalette, releaseStoreForPalette } from "../store/store-view";
import { sharedSummaries } from "../library/shared-library";
import { openReleaseCalendarSearch, releaseDateLabel } from "../library/release-calendar";

const MAX_GAMES = 8;
const MAX_UPCOMING = 4;

interface Command {
  label: string;
  iconName: IconName;
  attrs: string;
  keywords: string;
}

let activeIndex = 0;
let upcomingReleases: UpcomingRelease[] | null = null;
let upcomingLoading = false;
let upcomingFailed = false;

function root(): HTMLElement | null {
  return document.getElementById("palette-root");
}

export function isPaletteOpen(): boolean {
  return Boolean(root()?.firstElementChild);
}

function commands(): Command[] {
  const list: Command[] = [
    { label: t("nav.library"), iconName: "layout-grid", attrs: `data-view="library"`, keywords: "library kutuphane" },
    { label: t("nav.store"), iconName: "external", attrs: `data-act="open-store"`, keywords: "store magaza epic gog" },
    { label: t("nav.downloads"), iconName: "download", attrs: `data-view="downloads"`, keywords: "downloads indirmeler queue" },
    { label: t("palette.cmdProfile"), iconName: "users", attrs: `data-view="profile"`, keywords: "profile profil" },
    { label: t("palette.cmdSettings"), iconName: "settings", attrs: `data-view="settings"`, keywords: "settings ayarlar" },
    { label: t("accounts.title"), iconName: "user", attrs: `data-view="accounts"`, keywords: "accounts hesap" },
    { label: t("calendar.title"), iconName: "calendar", attrs: `data-act="open-release-calendar"`, keywords: "release calendar takvim cikis" },
  ];
  // Pages the user hid from the sidebar stay out of the palette too.
  if (notesSidebarVisible()) {
    list.push({ label: t("notes.title"), iconName: "edit", attrs: `data-view="notes"`, keywords: "notes notlar" });
  }
  if (screenshotsSidebarVisible()) {
    list.push({ label: t("ss.title"), iconName: "clapperboard", attrs: `data-view="screenshots"`, keywords: "media screenshots gallery medya ekran goruntuleri" });
  }
  if (spotifyPageVisible()) {
    list.push({ label: t("overlay.tabSpotify"), iconName: "spotify", attrs: `data-view="music"`, keywords: "spotify music muzik" });
  }
  if (discordPageVisible()) {
    list.push({ label: t("discord.title"), iconName: "discord", attrs: `data-view="discord"`, keywords: "discord chat sohbet" });
  }
  list.push(
    { label: t("palette.cmdRefresh"), iconName: "refresh", attrs: `data-act="epic-refresh"`, keywords: "refresh sync yenile" },
    { label: t("palette.cmdStorage"), iconName: "hard-drive", attrs: `data-act="open-storage-manager"`, keywords: "storage disk depolama" },
    { label: t("palette.cmdOffline"), iconName: S.offlineMode ? "wifi" : "wifi-off", attrs: `data-act="toggle-offline-mode"`, keywords: "offline online cevrimdisi" },
    { label: t("fullscreen.mode"), iconName: "maximize-2", attrs: `data-act="toggle-fullscreen-mode"`, keywords: "tam ekran fullscreen controller gamepad" },
    { label: t("notif.title"), iconName: "bell", attrs: `data-act="toggle-notifications"`, keywords: "notifications bildirim" },
    { label: t("settings.viewChangelog"), iconName: "clock", attrs: `data-act="open-changelog"`, keywords: "changelog whats new surum notlari" },
    { label: t("settings.feedbackOpen"), iconName: "mail", attrs: `data-act="open-feedback"`, keywords: "feedback bug report sorun bildir" },
  );
  return list;
}

function gameItem(appName: string, title: string, installed: boolean, idx: number): string {
  const raw = rawOf(appName);
  const shared = sharedOwnerOf(appName);
  const steam = appName.startsWith("steam::");
  const cover = S.customCovers[appName] || (raw ? epicPortrait(raw) : null) || shared?.cover || summaryOf(appName)?.cover || null;
  const action = shared
    ? `<button class="btn ghost small" data-act="shared-switch" data-id="${esc(shared.ownerKey)}" tabindex="-1" title="${t("shared.detailNote", { name: esc(shared.ownerName) })}">${t("shared.switch")}</button>`
    : steam
      ? installed
        ? `<button class="btn play small" data-act="steam-action" data-id="${esc(appName.slice(7))}" data-mode="launch" tabindex="-1">${t("palette.play")}</button>`
        : `<button class="btn install small" data-act="steam-action" data-id="${esc(appName.slice(7))}" data-mode="install" tabindex="-1">${t("common.install")}</button>`
      : installed
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

/** One cached IGDB call per session; the backend keeps its own six-hour cache. */
function ensureUpcomingReleases(): void {
  if (upcomingReleases || upcomingLoading || upcomingFailed) return;
  upcomingLoading = true;
  void epicUpcomingReleases(false)
    .then((list) => {
      upcomingReleases = list;
      if (!isPaletteOpen()) return;
      const input = document.getElementById("palette-input") as HTMLInputElement | null;
      renderResults(input?.value ?? "");
    })
    .catch(() => {
      upcomingFailed = true;
    })
    .finally(() => {
      upcomingLoading = false;
    });
}

function upcomingItem(release: UpcomingRelease, idx: number): string {
  const cover = release.coverId ? igdbImage(release.coverId, "thumb") : "";
  return `
    <div class="palette-item" data-idx="${idx}" data-act="open-release-calendar-search" data-query="${esc(release.name)}" role="option">
      ${cover ? `<img class="palette-thumb" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : icon("calendar", 16)}
      <span class="palette-label">${esc(release.name)}</span>
      <span class="chip">${esc(releaseDateLabel(release))}</span>
    </div>`;
}

function renderResults(query: string): void {
  const list = document.getElementById("palette-results");
  if (!list) return;
  const q = query.trim().toLowerCase();
  if (q.length >= 2) ensureUpcomingReleases();

  // The palette searches the same union the library shows — Epic, GOG and the
  // whole owned Steam library — plus games from other saved accounts when the
  // shared library is enabled.
  const pool: EpicSummary[] = S.showSharedLibrary
    ? [...allStoreSummaries(), ...sharedSummaries()]
    : allStoreSummaries();

  const games: string[] = [];
  let idx = 0;
  if (q) {
    // Installed matches first, then the rest, capped at MAX_GAMES.
    const matched: EpicSummary[] = [];
    for (const s of pool) {
      if (S.hiddenGames.has(s.appName)) continue;
      if (s.installed && s.title.toLowerCase().includes(q)) matched.push(s);
      if (matched.length >= MAX_GAMES) break;
    }
    if (matched.length < MAX_GAMES) {
      for (const s of pool) {
        if (S.hiddenGames.has(s.appName)) continue;
        if (!s.installed && s.title.toLowerCase().includes(q)) matched.push(s);
        if (matched.length >= MAX_GAMES) break;
      }
    }
    for (const s of matched) games.push(gameItem(s.appName, s.title, s.installed, idx++));
  } else {
    for (const id of S.epicRecent.slice(0, 5)) {
      const s = summaryOf(id);
      if (s && !S.hiddenGames.has(s.appName)) games.push(gameItem(s.appName, s.title, s.installed, idx++));
    }
  }

  const releases =
    q && upcomingReleases
      ? upcomingReleases
          .filter((release) => release.name.toLowerCase().includes(q))
          .slice(0, MAX_UPCOMING)
          .map((release) => upcomingItem(release, idx++))
      : [];

  const cmds = commands()
    .filter((c) => !q || c.label.toLowerCase().includes(q) || c.keywords.includes(q))
    .map((c) => `<div class="palette-item" data-idx="${idx++}" ${c.attrs} role="option">${icon(c.iconName, 16)}<span class="palette-label">${esc(c.label)}</span></div>`);

  list.innerHTML =
    (games.length ? `<div class="palette-group">${t("palette.games")}</div>${games.join("")}` : "") +
    (releases.length ? `<div class="palette-group">${t("calendar.title")}</div>${releases.join("")}` : "") +
    (cmds.length ? `<div class="palette-group">${t("palette.commands")}</div>${cmds.join("")}` : "") +
    (!games.length && !releases.length && !cmds.length ? emptyState("search", t("palette.empty")) : "");
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
  if (!r?.firstElementChild) return;
  r.innerHTML = "";
  // The store child webview sits above this palette. Put it back only after
  // the palette DOM is gone, and only if the user is still on the store.
  releaseStoreForPalette();
}

/** Run a palette entry through the global click router, then close. */
function run(el: HTMLElement): void {
  el.click();
  closePalette();
}

export function openPalette(): void {
  const r = root();
  if (!r) return;
  // Start parking the store child before the palette paints. A native webview
  // ignores z-index, so the palette would otherwise open underneath it.
  const held = holdStoreForPalette();
  r.innerHTML = `
    <div class="palette-backdrop" data-palette-close>
      <div class="palette" role="dialog" aria-label="${esc(t("palette.open"))}">
        <label class="palette-input">${icon("search", 16)}<input id="palette-input" placeholder="${esc(t("palette.placeholder"))}" autocomplete="off" spellcheck="false" /><span class="kbd">Esc</span></label>
        <div id="palette-results" class="palette-results" role="listbox"></div>
        <div class="palette-hint">${t("palette.hint")}</div>
      </div>
    </div>`;
  renderResults("");
  const focusInput = () => (document.getElementById("palette-input") as HTMLInputElement | null)?.focus();
  focusInput();
  // Focus again once the child webview is parked; it can steal focus until hide() lands.
  void held.then(focusInput);
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

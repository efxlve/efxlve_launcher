/**
 * Release calendar: full release dates for the games in the current library
 * view, grouped by month.
 *
 * The library only knows a release year. The backend asks IGDB for exact dates
 * once per title (cached for a week) and returns them in one batch, so reopening
 * the calendar is instant. Games without an exact date stay in a separate
 * "date not confirmed" list instead of inventing a day.
 */

import { confirmRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { epicReleaseCalendar, type ReleaseCalendarEntry, type EpicSummary } from "../../epic";
import { summaryOf } from "../../core/selectors";

const MAX_GAMES = 80;
const MONTHS = Array.from({ length: 12 }, (_, index) => index);

interface DatedEntry extends ReleaseCalendarEntry {
  year: number;
  month: number;
  day: number;
}

let layer: HTMLElement | null = null;
let games: EpicSummary[] = [];
let entries: ReleaseCalendarEntry[] = [];
let selectedYear = 0;
let loading = false;
let capped = false;

function dateParts(entry: ReleaseCalendarEntry): DatedEntry | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((entry.date ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 0 || month > 11 || day < 1 || day > 31) return null;
  return { ...entry, year, month, day };
}

function datedEntries(): DatedEntry[] {
  return entries
    .map(dateParts)
    .filter((entry): entry is DatedEntry => entry !== null)
    .sort((left, right) => left.date!.localeCompare(right.date!));
}

function availableYears(): number[] {
  const years = new Set<number>();
  for (const entry of datedEntries()) years.add(entry.year);
  return [...years].sort((left, right) => right - left);
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(S.appLanguage || undefined, {
    month: "long",
  });
}

function coverOfEntry(appName: string): string {
  return S.customCovers[appName] || summaryOf(appName)?.cover || "";
}

function entryRow(entry: DatedEntry): string {
  const cover = coverOfEntry(entry.appName);
  return `<button type="button" class="calendar-entry" data-act="epic-detail" data-id="${esc(entry.appName)}" title="${esc(`${entry.title} · ${entry.date}`)}">
    ${cover ? `<img class="calendar-entry-cover" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="calendar-entry-cover placeholder">${icon("gamepad-2", 12)}</span>`}
    <span class="calendar-entry-main">
      <span class="calendar-entry-title">${esc(entry.title)}</span>
      <span class="calendar-entry-meta">${esc(monthLabel(entry.year, entry.month))} ${entry.day}</span>
    </span>
  </button>`;
}

function renderMonths(year: number, dated: DatedEntry[]): string {
  return `<div class="calendar-months">${MONTHS.map((month) => {
    const rows = dated.filter((entry) => entry.year === year && entry.month === month);
    return `<div class="calendar-month${rows.length === 0 ? " is-empty" : ""}">
      <div class="calendar-month-head">
        <span>${esc(monthLabel(year, month))}</span>
        ${rows.length > 0 ? `<span class="calendar-month-count tabular-nums">${rows.length}</span>` : ""}
      </div>
      ${rows.length > 0 ? rows.map(entryRow).join("") : `<div class="calendar-month-empty">—</div>`}
    </div>`;
  }).join("")}</div>`;
}

function renderBody(): string {
  if (loading) {
    return `<div class="calendar-loading">
      <span class="spinner"></span>
      <div class="calendar-loading-title">${t("calendar.loading")}</div>
      <div class="calendar-loading-hint">${t("calendar.loadingHint")}</div>
    </div>`;
  }
  const dated = datedEntries();
  const years = availableYears();
  if (years.length === 0) {
    return `<div class="calendar-empty">
      ${icon("calendar", 26)}
      <div class="calendar-empty-title">${t("calendar.empty")}</div>
      <div class="calendar-empty-hint">${t("calendar.emptyHint")}</div>
    </div>`;
  }
  const unconfirmed = entries.filter((entry) => dateParts(entry) === null);
  return `
    ${renderMonths(selectedYear, dated)}
    ${
      unconfirmed.length > 0
        ? `<div class="calendar-unconfirmed">
            <div class="calendar-unconfirmed-head">${t("calendar.unconfirmed")} <span class="count tabular-nums">${unconfirmed.length}</span></div>
            <div class="calendar-unconfirmed-list">${unconfirmed
              .map(
                (entry) => `<button type="button" class="calendar-chip" data-act="epic-detail" data-id="${esc(entry.appName)}" title="${esc(entry.matchedName || entry.title)}">${esc(entry.title)}</button>`,
              )
              .join("")}</div>
          </div>`
        : ""
    }
    ${capped ? `<div class="calendar-capped">${esc(t("calendar.capped", { n: String(MAX_GAMES) }))}</div>` : ""}`;
}

function renderCalendar(): void {
  if (!layer) return;
  const dated = datedEntries();
  const years = availableYears();
  if (years.length > 0 && !years.includes(selectedYear)) {
    const now = new Date().getFullYear();
    selectedYear = years.includes(now) ? now : years[0];
  }
  const total = selectedYear > 0
    ? dated.filter((entry) => entry.year === selectedYear).length
    : dated.length;
  const yearOptions = years
    .map((year) => `<option value="${year}"${year === selectedYear ? " selected" : ""}>${year}</option>`)
    .join("");
  layer.innerHTML = `
    <div class="modal-backdrop" data-act="release-calendar-close">
      <div class="modal calendar-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="calendar-head">
          <div class="calendar-head-text">
            <h2 class="calendar-title">${icon("calendar", 17)} ${t("calendar.title")}</h2>
            <p class="calendar-subtitle tabular-nums">${esc(t("calendar.subtitle", { count: String(total), games: String(games.length) }))}</p>
          </div>
          <div class="calendar-head-actions">
            ${years.length > 0 ? `<select class="settings-select calendar-year" data-act="release-calendar-year" aria-label="${esc(t("calendar.title"))}">${yearOptions}</select>` : ""}
            <button type="button" class="icon-btn${loading ? " spinning" : ""}" data-act="release-calendar-refresh" title="${esc(t("calendar.refresh"))}" aria-label="${esc(t("calendar.refresh"))}" ${loading ? "disabled" : ""}>${icon("refresh", 15)}</button>
            <button type="button" class="manage-head-close" data-act="release-calendar-close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
          </div>
        </div>
        <div class="calendar-body">${renderBody()}</div>
      </div>
    </div>`;
  if (!layer.dataset.bound) {
    layer.dataset.bound = "1";
  }
}

async function load(refresh: boolean): Promise<void> {
  loading = true;
  renderCalendar();
  try {
    entries = await epicReleaseCalendar(
      games.map((game) => ({
        appName: game.appName,
        title: game.title,
        year: game.releaseYear ?? null,
      })),
      refresh,
    );
  } catch {
    entries = [];
  } finally {
    loading = false;
    renderCalendar();
  }
}

/** Opens the calendar for the current library view. */
export function openReleaseCalendar(nextGames: EpicSummary[]): void {
  const seen = new Set<string>();
  games = nextGames
    .filter((game) => {
      if (!game.appName || !game.title || seen.has(game.appName)) return false;
      seen.add(game.appName);
      return true;
    })
    .slice(0, MAX_GAMES);
  capped = nextGames.length > MAX_GAMES;
  entries = [];
  selectedYear = 0;
  if (layer) layer.remove();
  layer = document.createElement("div");
  layer.className = "calendar-layer";
  confirmRoot.appendChild(layer);
  renderCalendar();
  void load(false);
}

export function closeReleaseCalendar(): void {
  layer?.remove();
  layer = null;
  games = [];
  entries = [];
  loading = false;
}

/** Cancels the open calendar; true when there was one (Escape handling). */
export function cancelReleaseCalendar(): boolean {
  if (!layer) return false;
  closeReleaseCalendar();
  return true;
}

/** Year selector change; handled by the input listener. */
export function setReleaseCalendarYear(year: number): void {
  if (!Number.isFinite(year)) return;
  selectedYear = year;
  renderCalendar();
}

/** Refresh button; follows the same cached backend but forces a fresh IGDB pass. */
export function refreshReleaseCalendar(): void {
  if (!layer || loading) return;
  void load(true);
}

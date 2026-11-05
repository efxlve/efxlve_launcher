/**
 * Upcoming PC release calendar.
 *
 * IGDB returns each release with a precision. Only an exact day is placed in
 * the month grid; a month-only entry stays in its month without a day, and a
 * quarter or year goes to the "date not confirmed" list. No day is invented.
 */

import { confirmRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { igdbImage } from "../../igdb";
import { t } from "../../i18n";
import { epicUpcomingReleases, type UpcomingRelease } from "../../epic";

const MONTHS = Array.from({ length: 12 }, (_, index) => index);

let layer: HTMLElement | null = null;
let releases: UpcomingRelease[] = [];
let selectedYear = 0;
let loading = false;
let failed = false;
/** Set once the user picks a year, so a refresh cannot steal it. */
let yearTouched = false;
/** Bumped by a restart or close so a late answer cannot repaint a dead dialog. */
let loadSeq = 0;
/** The game whose store picker is open, if any. */
let storeRelease: UpcomingRelease | null = null;
let storeLayer: HTMLElement | null = null;

function releaseYear(release: UpcomingRelease): number {
  if (release.year) return release.year;
  const year = Number((release.date ?? "").slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : 0;
}

function releaseMonth(release: UpcomingRelease): number {
  if (release.month) return release.month;
  const month = Number((release.date ?? "").slice(5, 7));
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month : 0;
}

function releaseDay(release: UpcomingRelease): number {
  if (release.day) return release.day;
  const day = Number((release.date ?? "").slice(8, 10));
  return Number.isFinite(day) && day >= 1 && day <= 31 ? day : 0;
}

function hasExactDay(release: UpcomingRelease): boolean {
  return (
    release.precision === "day" &&
    /^\d{4}-\d{2}-\d{2}$/.test(release.date ?? "") &&
    releaseDay(release) > 0
  );
}

function hasMonthOnly(release: UpcomingRelease): boolean {
  return release.precision === "month" && releaseYear(release) > 0 && releaseMonth(release) > 0;
}

function availableYears(): number[] {
  const years = new Set<number>();
  for (const release of releases) {
    const year = releaseYear(release);
    if (year > 0) years.add(year);
  }
  return [...years].sort((left, right) => left - right);
}

function preferredYear(): number {
  const years = availableYears();
  if (years.length === 0) return 0;
  const now = new Date().getFullYear();
  const dated = new Map<number, number>();
  for (const release of releases) {
    if (!hasExactDay(release) && !hasMonthOnly(release)) continue;
    const year = releaseYear(release);
    if (year > 0) dated.set(year, (dated.get(year) ?? 0) + 1);
  }
  // A year with only "2027"-style entries would open an empty grid; prefer the
  // current year when it has real dates, then the fullest upcoming year.
  if ((dated.get(now) ?? 0) > 0) return now;
  const upcoming = years.filter((year) => year >= now);
  const pool = upcoming.length > 0 ? upcoming : years;
  return [...pool].sort(
    (left, right) => (dated.get(right) ?? 0) - (dated.get(left) ?? 0) || left - right,
  )[0];
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(S.appLanguage || undefined, {
    month: "long",
  });
}

function entryRow(release: UpcomingRelease, day: number, soft = false): string {
  const cover = igdbImage(release.coverId, "cover_big");
  const meta = day > 0
    ? `${monthLabel(releaseYear(release), releaseMonth(release) - 1)} ${day}`
    : release.precision === "month" && releaseMonth(release) > 0
      ? `${monthLabel(releaseYear(release), releaseMonth(release) - 1)} ${releaseYear(release)}`
      : release.human;
  const art = cover
    ? `<img class="calendar-entry-cover" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="calendar-entry-cover placeholder">${icon("gamepad-2", 12)}</span>`;
  const action = `data-act="release-stores" data-id="${release.id}"`;
  return `<button type="button" class="calendar-entry${soft ? " is-soft" : ""}" ${action} title="${esc(`${release.name} · ${release.human}`)}">
    ${art}
    <span class="calendar-entry-main">
      <span class="calendar-entry-title">${esc(release.name)}</span>
      <span class="calendar-entry-meta">${esc(meta)}</span>
    </span>
  </button>`;
}

function monthEntries(year: number, month: number): UpcomingRelease[] {
  return releases
    .filter(
      (release) =>
        releaseYear(release) === year &&
        releaseMonth(release) - 1 === month &&
        (hasExactDay(release) || hasMonthOnly(release)),
    )
    .sort((left, right) => {
      // Exact days first, then the month-only rows; each group by name.
      const dayLeft = hasExactDay(left) ? releaseDay(left) : 99;
      const dayRight = hasExactDay(right) ? releaseDay(right) : 99;
      return dayLeft - dayRight || left.name.localeCompare(right.name);
    });
}

function renderMonths(year: number): string {
  const now = new Date();
  // The current year starts at today's month: a November calendar has no use
  // for ten empty cards for months that already passed.
  const firstMonth = year === now.getFullYear() ? now.getMonth() : 0;
  const months = MONTHS.filter((month) => month >= firstMonth);
  const columns = months.length === 1 ? " cols-1" : months.length === 2 ? " cols-2" : "";
  return `<div class="calendar-months${columns}">${months.map((month) => {
    const rows = monthEntries(year, month);
    return `<div class="calendar-month${rows.length === 0 ? " is-empty" : ""}">
      <div class="calendar-month-head">
        <span>${esc(monthLabel(year, month))}</span>
        ${rows.length > 0 ? `<span class="calendar-month-count tabular-nums">${rows.length}</span>` : ""}
      </div>
      ${rows.length > 0
        ? rows
            .map((release) =>
              entryRow(
                release,
                hasExactDay(release) ? releaseDay(release) : 0,
                !hasExactDay(release),
              ),
            )
            .join("")
        : `<div class="calendar-month-empty">—</div>`}
    </div>`;
  }).join("")}</div>`;
}

function pendingReleases(year: number): UpcomingRelease[] {
  return releases
    .filter((release) => !hasExactDay(release) && !hasMonthOnly(release))
    .filter((release) => releaseYear(release) === 0 || releaseYear(release) === year)
    .sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      return releaseYear(left) - releaseYear(right) || byName;
    });
}

function loadingHtml(): string {
  return `<div class="calendar-loading">
      <span class="spinner"></span>
      <div class="calendar-loading-title">${t("calendar.loading")}</div>
      <div class="calendar-loading-hint">${t("calendar.loadingHint")}</div>
    </div>`;
}

function emptyHtml(): string {
  return `<div class="calendar-empty">
      ${icon("calendar", 26)}
      <div class="calendar-empty-title">${failed ? t("calendar.error") : t("calendar.empty")}</div>
      <div class="calendar-empty-hint">${t("calendar.emptyHint")}</div>
    </div>`;
}

function renderBody(): string {
  if (loading && releases.length === 0) return loadingHtml();
  if (releases.length === 0) return emptyHtml();
  const pending = pendingReleases(selectedYear);
  return `
    ${renderMonths(selectedYear)}
    ${
      pending.length > 0
        ? `<details class="calendar-unconfirmed">
            <summary class="calendar-unconfirmed-head">${t("calendar.unconfirmed")} <span class="count tabular-nums">${pending.length}</span></summary>
            <div class="calendar-unconfirmed-list">${pending
              .map(
                (release) => `<button type="button" class="calendar-chip" ${release.url ? `data-act="open-external-url" data-url="${esc(release.url)}"` : `data-act="prevent-modal-close"`} title="${esc(`${release.name} · ${release.human}`)}"><span class="calendar-chip-name">${esc(release.name)}</span><span class="calendar-chip-when">${esc(release.human)}</span></button>`,
              )
              .join("")}</div>
          </details>`
        : ""
    }
    <p class="calendar-source">${esc(t("calendar.sourceNote"))}</p>`;
}

function renderCalendar(): void {
  if (!layer) return;
  const years = availableYears();
  if (!yearTouched || !years.includes(selectedYear)) {
    const preferred = preferredYear();
    if (preferred > 0) selectedYear = preferred;
  }
  const yearOptions = years
    .map((year) => `<option value="${year}"${year === selectedYear ? " selected" : ""}>${year}</option>`)
    .join("");
  const scrollTop = layer.querySelector<HTMLElement>(".calendar-body")?.scrollTop ?? 0;
  layer.innerHTML = `
    <div class="modal-backdrop" data-act="release-calendar-close">
      <div class="modal calendar-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="calendar-head">
          <div class="calendar-head-text">
            <h2 class="calendar-title">${icon("calendar", 17)} ${t("calendar.title")}</h2>
            <p class="calendar-subtitle tabular-nums">${esc(
              loading && releases.length === 0
                ? t("calendar.loading")
                : t("calendar.subtitle", { count: String(releases.length) }),
            )}</p>
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
  const nextBody = layer.querySelector<HTMLElement>(".calendar-body");
  if (nextBody && scrollTop > 0) nextBody.scrollTop = scrollTop;
}

/** Full label for the store dialog, with the same precision as the grid. */
function dateLabel(release: UpcomingRelease): string {
  if (hasExactDay(release)) {
    return new Date(
      releaseYear(release),
      releaseMonth(release) - 1,
      releaseDay(release),
    ).toLocaleDateString(S.appLanguage || undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  if (hasMonthOnly(release)) {
    return `${monthLabel(releaseYear(release), releaseMonth(release) - 1)} ${releaseYear(release)}`;
  }
  return release.human;
}

function storeLabel(id: string, label: string): string {
  return id === "official" ? t("calendar.officialSite") : label;
}

/** Search links for stores IGDB has no direct product URL for. */
function storeSearchLinks(name: string): Array<{ id: string; label: string; url: string }> {
  const query = encodeURIComponent(name);
  return [
    { id: "steam", label: "Steam", url: `https://store.steampowered.com/search/?term=${query}` },
    { id: "epic", label: "Epic Games", url: `https://store.epicgames.com/en-US/search?q=${query}` },
    { id: "gog", label: "GOG", url: `https://www.gog.com/en/games?query=${query}` },
    { id: "itch", label: "itch.io", url: `https://itch.io/search?q=${query}` },
  ];
}

function renderStoreDialog(): void {
  if (!storeLayer || !storeRelease) return;
  const release = storeRelease;
  const cover = igdbImage(release.coverId, "cover_big");
  const exact = (release.stores ?? []).map(
    (store) =>
      `<button type="button" class="release-store-btn" data-act="open-external-url" data-url="${esc(store.url)}">
        <span>${esc(storeLabel(store.id, store.label))}</span>${icon("external", 12)}
      </button>`,
  );
  const known = new Set((release.stores ?? []).map((store) => store.id));
  const searches = storeSearchLinks(release.name)
    .filter((store) => !known.has(store.id))
    .map(
      (store) =>
        `<button type="button" class="release-store-btn is-search" data-act="open-external-url" data-url="${esc(store.url)}">
          ${icon("search", 12)}<span>${esc(t("calendar.searchOn", { store: store.label }))}</span>
        </button>`,
    );
  storeLayer.innerHTML = `
    <div class="modal-backdrop" data-act="release-stores-close">
      <div class="modal release-stores-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="release-stores-head">
          ${cover ? `<img class="release-stores-cover" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="release-stores-cover placeholder">${icon("gamepad-2", 20)}</span>`}
          <div class="release-stores-head-text">
            <h3 class="release-stores-title">${esc(release.name)}</h3>
            <p class="release-stores-date">${esc(dateLabel(release))}</p>
          </div>
          <button type="button" class="manage-head-close" data-act="release-stores-close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
        </div>
        <div class="release-stores-section">${esc(t("calendar.whereToBuy"))}</div>
        <div class="release-stores-list">
          ${exact.length > 0 ? exact.join("") : `<p class="release-stores-empty">${esc(t("calendar.noStoreLinks"))}</p>`}
        </div>
        <div class="release-stores-section">${esc(t("calendar.searchStores"))}</div>
        <div class="release-stores-list is-search">${searches.join("")}</div>
        <p class="release-stores-note">${icon("info", 12)}<span>${esc(t("calendar.storeNote"))}</span></p>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-act="release-stores-close">${esc(t("common.close"))}</button>
          ${release.url ? `<button type="button" class="btn ghost" data-act="open-external-url" data-url="${esc(release.url)}">${icon("external", 13)} ${esc(t("calendar.igdbPage"))}</button>` : ""}
        </div>
      </div>
    </div>`;
  storeLayer.querySelector<HTMLButtonElement>('[data-act="release-stores-close"]')?.focus();
}

/** Opens the store picker for one upcoming release. */
export function openReleaseStores(id: number): void {
  if (!layer) return;
  const release = releases.find((item) => item.id === id);
  if (!release) return;
  storeRelease = release;
  if (!storeLayer) {
    storeLayer = document.createElement("div");
    storeLayer.className = "confirm-layer";
    confirmRoot.appendChild(storeLayer);
  }
  renderStoreDialog();
}

/** Closes the store picker. */
export function closeReleaseStores(): void {
  storeLayer?.remove();
  storeLayer = null;
  storeRelease = null;
}

/** Cancels the store picker; true when there was one (Escape handling). */
export function cancelReleaseStores(): boolean {
  if (!storeLayer) return false;
  closeReleaseStores();
  return true;
}

async function load(refresh: boolean): Promise<void> {
  const seq = ++loadSeq;
  loading = true;
  failed = false;
  renderCalendar();
  try {
    const next = await epicUpcomingReleases(refresh);
    if (seq !== loadSeq || !layer) return;
    releases = next;
  } catch {
    if (seq !== loadSeq || !layer) return;
    releases = [];
    failed = true;
  }
  loading = false;
  renderCalendar();
}

/** Opens the upcoming-release calendar. */
export function openReleaseCalendar(): void {
  closeReleaseStores();
  releases = [];
  selectedYear = 0;
  yearTouched = false;
  failed = false;
  if (layer) layer.remove();
  layer = document.createElement("div");
  layer.className = "calendar-layer";
  confirmRoot.appendChild(layer);
  renderCalendar();
  void load(false);
}

export function closeReleaseCalendar(): void {
  closeReleaseStores();
  loadSeq++;
  layer?.remove();
  layer = null;
  releases = [];
  loading = false;
  failed = false;
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
  yearTouched = true;
  selectedYear = year;
  renderCalendar();
}

/** Refresh button; bypasses the six-hour backend cache. */
export function refreshReleaseCalendar(): void {
  if (!layer || loading) return;
  void load(true);
}

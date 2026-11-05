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

interface MonthSel {
  year: number;
  /** 1–12, unlike `Date#getMonth`. */
  month: number;
}

interface MonthInfo extends MonthSel {
  count: number;
}

/** Followed releases are a local display choice; IGDB is never involved. */
const FOLLOW_KEY = "efxlve-release-follows";

let layer: HTMLElement | null = null;
let releases: UpcomingRelease[] = [];
let selected: MonthSel | null = null;
let selectedDay: number | null = null;
let loading = false;
let failed = false;
/** True while the body shows the followed list instead of one month. */
let watching = false;
let followed = loadFollowed();
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

function loadFollowed(): Set<number> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(FOLLOW_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const list = Array.isArray(parsed) ? parsed : [];
    return new Set(
      list.filter((id): id is number => typeof id === "number" && Number.isFinite(id)),
    );
  } catch {
    return new Set();
  }
}

function saveFollowed(): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (followed.size === 0) localStorage.removeItem(FOLLOW_KEY);
    else localStorage.setItem(FOLLOW_KEY, JSON.stringify([...followed]));
  } catch {
    // A full quota must not break the calendar.
  }
}

/** Exact days first inside a month, then month-only entries, then the rest. */
function releaseSortKey(release: UpcomingRelease): number {
  const year = releaseYear(release) || 9999;
  const month = releaseMonth(release) || 13;
  const day = hasExactDay(release) ? releaseDay(release) : hasMonthOnly(release) ? 32 : 33;
  return year * 10_000 + month * 100 + day;
}

function followedReleases(): UpcomingRelease[] {
  return releases
    .filter((release) => followed.has(release.id))
    .sort(
      (left, right) =>
        releaseSortKey(left) - releaseSortKey(right) || left.name.localeCompare(right.name),
    );
}

function renderFollowButton(release: UpcomingRelease, extraClass = ""): string {
  const isFollowed = followed.has(release.id);
  const label = isFollowed ? t("calendar.unfollow") : t("calendar.follow");
  return `<button type="button" class="calendar-follow-btn${isFollowed ? " is-followed" : ""}${extraClass ? ` ${extraClass}` : ""}" data-act="release-follow" data-id="${release.id}" aria-pressed="${isFollowed}" title="${esc(label)}" aria-label="${esc(label)}">${icon("star", 14)}</button>`;
}

function sameMonth(left: MonthSel | null, right: MonthSel | null): boolean {
  return Boolean(left && right && left.year === right.year && left.month === right.month);
}

function availableMonths(): MonthInfo[] {
  const map = new Map<string, MonthInfo>();
  for (const release of releases) {
    if (!hasExactDay(release) && !hasMonthOnly(release)) continue;
    const year = releaseYear(release);
    const month = releaseMonth(release);
    if (year <= 0 || month <= 0) continue;
    const key = `${year}-${month}`;
    const entry = map.get(key) ?? { year, month, count: 0 };
    entry.count += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort(
    (left, right) => left.year - right.year || left.month - right.month,
  );
}

function pickDefaultMonth(months: MonthInfo[]): MonthSel | null {
  if (months.length === 0) return null;
  const now = new Date();
  const current = months.find(
    (entry) => entry.year === now.getFullYear() && entry.month === now.getMonth() + 1,
  );
  return current ?? months[0];
}

function ensureSelectedMonth(): MonthSel | null {
  const months = availableMonths();
  if (!selected || !months.some((entry) => sameMonth(entry, selected))) {
    selected = pickDefaultMonth(months);
  }
  return selected;
}

function monthGames(month: MonthSel): UpcomingRelease[] {
  return releases
    .filter(
      (release) =>
        releaseYear(release) === month.year &&
        releaseMonth(release) === month.month &&
        (hasExactDay(release) || hasMonthOnly(release)),
    )
    .sort((left, right) => {
      const dayLeft = hasExactDay(left) ? releaseDay(left) : 99;
      const dayRight = hasExactDay(right) ? releaseDay(right) : 99;
      return dayLeft - dayRight || left.name.localeCompare(right.name);
    });
}

function monthLabel(year: number, monthIndex: number): string {
  return new Date(year, monthIndex, 1).toLocaleDateString(S.appLanguage || undefined, {
    month: "long",
  });
}

function weekdayLabels(): string[] {
  // 2024-01-01 was a Monday; the grid is Monday-first.
  return Array.from({ length: 7 }, (_, index) =>
    new Date(2024, 0, 1 + index).toLocaleDateString(S.appLanguage || undefined, {
      weekday: "short",
    }),
  );
}

/** Full label for the hero and store dialog, with the same precision as the grid. */
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

function countdownLabel(release: UpcomingRelease): string {
  if (!hasExactDay(release)) return "";
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const target = Date.UTC(releaseYear(release), releaseMonth(release) - 1, releaseDay(release));
  const days = Math.round((target - today) / 86_400_000);
  if (days < 0) return "";
  if (days === 0) return t("calendar.today");
  if (days === 1) return t("calendar.tomorrow");
  return t("calendar.inDays", { n: days });
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

function coverOf(
  release: UpcomingRelease,
  size: "thumb" | "cover_big" | "cover_big_2x" = "cover_big",
): string {
  return igdbImage(release.coverId, size);
}

function dayFullLabel(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day).toLocaleDateString(S.appLanguage || undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function dayShortWeekday(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day).toLocaleDateString(S.appLanguage || undefined, {
    weekday: "short",
  });
}

function renderDay(
  year: number,
  month: number,
  day: number,
  games: UpcomingRelease[],
): string {
  const date = new Date(year, month - 1, day);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const isToday = date.getTime() === today.getTime();
  const isPast = date.getTime() < today.getTime();
  const weekday = (new Date(year, month - 1, day).getDay() + 6) % 7;
  const weekend = weekday >= 5;
  const isSelected = selectedDay === day;
  const stateClasses = `${isToday ? " is-today" : ""}${isPast ? " is-past" : ""}${weekend ? " is-weekend" : ""}${isSelected ? " is-selected" : ""}`;

  if (games.length === 0) {
    return `<div class="calendar-day${stateClasses}">
      <span class="calendar-day-top">
        <span class="calendar-day-num${isToday ? " is-today" : ""}">${day}</span>
      </span>
    </div>`;
  }

  const ranked = [...games].sort((left, right) => (right.hypes ?? 0) - (left.hypes ?? 0));
  const lead = ranked.find((item) => item.coverId) ?? ranked[0];
  // A 40 px cell cannot hold a readable title; the cover, day number and count
  // are the whole story. The full list lives in the schedule on the right.
  const leadCover = coverOf(lead, "thumb");
  const tip = `${dayFullLabel(year, month, day)} · ${games.map((item) => item.name).join(", ")}`;
  return `<button type="button" class="calendar-day has-games${stateClasses}" data-act="release-calendar-day" data-day="${day}" aria-pressed="${isSelected}" title="${esc(tip)}">
    ${leadCover ? `<span class="calendar-day-bg" style="background-image:url('${esc(leadCover)}')"></span><span class="calendar-day-scrim"></span>` : ""}
    <span class="calendar-day-top">
      <span class="calendar-day-num${isToday ? " is-today" : ""}">${day}</span>
      <span class="calendar-day-badge tabular-nums">${games.length}</span>
    </span>
  </button>`;
}

function renderGrid(month: MonthSel, exact: UpcomingRelease[]): string {
  const first = new Date(month.year, month.month - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const totalDays = new Date(month.year, month.month, 0).getDate();
  const cells: string[] = [];
  for (let index = 0; index < lead; index++) {
    cells.push(`<div class="calendar-day is-blank"></div>`);
  }
  for (let day = 1; day <= totalDays; day++) {
    cells.push(
      renderDay(
        month.year,
        month.month,
        day,
        exact.filter((release) => releaseDay(release) === day),
      ),
    );
  }
  while (cells.length % 7 !== 0) {
    cells.push(`<div class="calendar-day is-blank"></div>`);
  }
  return `<div class="calendar-sidebar">
    <div class="calendar-mini-card">
      <div class="calendar-weekdays" aria-hidden="true">${weekdayLabels()
        .map((label) => `<span>${esc(label)}</span>`)
        .join("")}</div>
      <div class="calendar-grid">${cells.join("")}</div>
    </div>
  </div>`;
}

function renderScheduleCard(release: UpcomingRelease): string {
  const cover = coverOf(release, "cover_big");
  const storeList = (release.stores ?? [])
    .slice(0, 2)
    .map((store) => `<span class="calendar-game-store">${esc(storeLabel(store.id, store.label))}</span>`)
    .join("");
  return `<div class="calendar-game-shell">
    <button type="button" class="calendar-game-card" data-act="release-stores" data-id="${release.id}" title="${esc(`${release.name} · ${dateLabel(release)}`)}">
      ${cover ? `<img class="calendar-game-cover" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="calendar-game-cover placeholder">${icon("gamepad-2", 18)}</span>`}
      <span class="calendar-game-info">
        <span class="calendar-game-title">${esc(release.name)}</span>
        ${storeList ? `<span class="calendar-game-stores">${storeList}</span>` : ""}
      </span>
    </button>
    ${renderFollowButton(release)}
  </div>`;
}

function renderSchedule(month: MonthSel, exact: UpcomingRelease[]): string {
  const buckets = new Map<number, UpcomingRelease[]>();
  for (const release of exact) {
    const day = releaseDay(release);
    if (day <= 0) continue;
    const list = buckets.get(day) ?? [];
    list.push(release);
    buckets.set(day, list);
  }
  const allDays = [...buckets.entries()].sort((left, right) => left[0] - right[0]);
  const hasFilter = selectedDay !== null && buckets.has(selectedDay);
  const visibleDays = hasFilter
    ? allDays.filter(([day]) => day === selectedDay)
    : allDays;

  const now = new Date();
  const todayTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const filterBar = hasFilter && selectedDay !== null
    ? `<div class="calendar-filter-bar">
        <span class="calendar-filter-label">${icon("calendar", 13)} <span>${esc(dayFullLabel(month.year, month.month, selectedDay))}</span></span>
        <button type="button" class="calendar-filter-reset" data-act="release-calendar-day" data-day="0">${esc(t("profile.showAll"))} <span class="tabular-nums">(${exact.length})</span></button>
      </div>`
    : "";

  const groups = visibleDays
    .map(([day, games]) => {
      const dateObj = new Date(month.year, month.month - 1, day);
      const isToday = dateObj.getTime() === todayTime;
      const isPast = dateObj.getTime() < todayTime;
      const countdown = countdownLabel(games[0]);
      return `<section class="calendar-day-group${isToday ? " is-today" : ""}${isPast ? " is-past" : ""}">
        <header class="calendar-day-header">
          <div class="calendar-date-badge${isToday ? " is-today" : ""}">
            <span class="calendar-date-num tabular-nums">${String(day).padStart(2, "0")}</span>
            <span class="calendar-date-wk">${esc(dayShortWeekday(month.year, month.month, day))}</span>
          </div>
          <div class="calendar-date-meta">
            <h4 class="calendar-date-title">${esc(dayFullLabel(month.year, month.month, day))}</h4>
            <span class="calendar-date-sub tabular-nums">${esc(t("col.gameCount", { count: String(games.length) }))}</span>
          </div>
          ${countdown ? `<span class="calendar-date-countdown${isToday ? " is-today" : ""} tabular-nums">${esc(countdown)}</span>` : ""}
        </header>
        <div class="calendar-day-cards">${games.map(renderScheduleCard).join("")}</div>
      </section>`;
    })
    .join("");

  return `<div class="calendar-schedule">
    ${filterBar}
    ${groups}
    ${hasFilter ? "" : renderTba(month)}
    ${hasFilter ? "" : renderPending(month.year)}
  </div>`;
}

function renderHero(
  release: UpcomingRelease | null,
  kicker = t("calendar.nextUp"),
): string {
  if (!release) return "";
  const art = release.artworkId
    ? igdbImage(release.artworkId, "1080p")
    : release.coverId
      ? igdbImage(release.coverId, "cover_big_2x")
      : "";
  const poster = coverOf(release, "cover_big_2x");
  const storeTags = (release.stores ?? [])
    .slice(0, 4)
    .map((store) => `<span class="calendar-store-tag">${esc(storeLabel(store.id, store.label))}</span>`)
    .join("");
  const fallbackTag = `<span class="calendar-store-tag is-muted">${esc(t("calendar.whereToBuy"))}</span>`;
  const countdown = countdownLabel(release);
  return `<div class="calendar-hero-shell">
    <button type="button" class="calendar-hero${release.artworkId ? "" : " is-cover"}" data-act="release-stores" data-id="${release.id}" title="${esc(`${release.name} · ${dateLabel(release)}`)}">
      <span class="calendar-hero-art"${art ? ` style="background-image:url('${esc(art)}')" ` : ""}></span>
      <span class="calendar-hero-shade"></span>
      <span class="calendar-hero-content">
        ${poster ? `<img class="calendar-hero-poster" src="${esc(poster)}" alt="" loading="lazy" decoding="async" />` : `<span class="calendar-hero-poster placeholder">${icon("gamepad-2", 22)}</span>`}
        <span class="calendar-hero-body">
          <span class="calendar-hero-topline">
            <span class="calendar-hero-kicker">${kicker}</span>
            ${countdown ? `<span class="calendar-hero-count">${esc(countdown)}</span>` : ""}
            <span class="calendar-hero-date">${esc(dateLabel(release))}</span>
          </span>
          <span class="calendar-hero-title">${esc(release.name)}</span>
          <span class="calendar-hero-stores">${storeTags || fallbackTag}</span>
        </span>
        <span class="calendar-hero-arrow">${icon("arrow-right", 16)}</span>
      </span>
    </button>
    ${renderFollowButton(release, "is-hero-follow")}
  </div>`;
}

function renderToolbar(months: MonthInfo[], active: MonthSel): string {
  const index = months.findIndex((month) => sameMonth(month, active));
  const previous = index > 0;
  const next = index >= 0 && index < months.length - 1;
  const watchCount = followedReleases().length;
  const watchButton =
    watchCount > 0 || watching
      ? `<button type="button" class="calendar-watch-toggle${watching ? " is-active" : ""}" data-act="release-calendar-watch" aria-pressed="${watching}" title="${esc(t("calendar.watchlist"))}" aria-label="${esc(t("calendar.watchlist"))}">${icon("star", 13)}<span class="tabular-nums">${watchCount}</span></button>`
      : "";
  return `<div class="calendar-toolbar">
    <button type="button" class="icon-btn" data-act="release-calendar-prev" title="${esc(t("calendar.previousMonth"))}" aria-label="${esc(t("calendar.previousMonth"))}"${previous ? "" : " disabled"}>${icon("chevron-left", 16)}</button>
    <div class="calendar-monthbar" role="tablist" aria-label="${esc(t("calendar.title"))}">${months
      .map((month) => {
        const isActive = sameMonth(month, active) && !watching;
        return `<button type="button" class="calendar-month-tab${isActive ? " is-active" : ""}" role="tab" aria-selected="${isActive}" data-act="release-calendar-month" data-year="${month.year}" data-month="${month.month}">
          <span class="calendar-month-tab-main">${esc(monthLabel(month.year, month.month - 1))}</span>
          <span class="calendar-month-tab-year">${month.year}</span>
          <span class="calendar-month-tab-count">${month.count}</span>
        </button>`;
      })
      .join("")}</div>
    ${watchButton}
    <button type="button" class="icon-btn" data-act="release-calendar-next" title="${esc(t("calendar.nextMonth"))}" aria-label="${esc(t("calendar.nextMonth"))}"${next ? "" : " disabled"}>${icon("chevron-right", 16)}</button>
  </div>`;
}

function renderTba(month: MonthSel): string {
  const tba = monthGames(month).filter(hasMonthOnly);
  if (tba.length === 0) return "";
  return `<div class="calendar-tba">
    <div class="calendar-tba-head">${esc(t("calendar.dayUnknown"))}<span class="count tabular-nums">${tba.length}</span></div>
    <div class="calendar-tba-list">${tba
      .map((release) => {
        const cover = coverOf(release, "cover_big");
        return `<button type="button" class="calendar-tba-card" data-act="release-stores" data-id="${release.id}" title="${esc(`${release.name} · ${dateLabel(release)}`)}">
          ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="calendar-tba-art placeholder">${icon("gamepad-2", 12)}</span>`}
          <span class="calendar-tba-name">${esc(release.name)}</span>
          <span class="calendar-tba-when">${esc(release.human)}</span>
        </button>`;
      })
      .join("")}</div>
  </div>`;
}

function pendingReleases(year: number): UpcomingRelease[] {
  return releases
    .filter((release) => !hasExactDay(release) && !hasMonthOnly(release))
    .filter((release) => releaseYear(release) === 0 || releaseYear(release) === year)
    .sort((left, right) => releaseYear(left) - releaseYear(right) || left.name.localeCompare(right.name));
}

function renderPending(year: number): string {
  const pending = pendingReleases(year);
  if (pending.length === 0) return "";
  return `<details class="calendar-unconfirmed">
    <summary class="calendar-unconfirmed-head">${icon("chevron-right", 13)} <span>${t("calendar.unconfirmed")}</span> <span class="count tabular-nums">${pending.length}</span></summary>
    <div class="calendar-unconfirmed-list">${pending
      .map(
        (release) => `<button type="button" class="calendar-chip" data-act="release-stores" data-id="${release.id}" title="${esc(`${release.name} · ${release.human}`)}"><span class="calendar-chip-name">${esc(release.name)}</span><span class="calendar-chip-when tabular-nums">${esc(release.human)}</span></button>`,
      )
      .join("")}</div>
  </details>`;
}

function renderWatchCard(release: UpcomingRelease): string {
  const cover = coverOf(release, "cover_big");
  const storeList = (release.stores ?? [])
    .slice(0, 3)
    .map((store) => `<span class="calendar-game-store">${esc(storeLabel(store.id, store.label))}</span>`)
    .join("");
  const countdown = countdownLabel(release);
  return `<div class="calendar-watch-card">
    <button type="button" class="calendar-watch-main" data-act="release-stores" data-id="${release.id}" title="${esc(`${release.name} · ${dateLabel(release)}`)}">
      ${cover ? `<img class="calendar-watch-cover" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="calendar-watch-cover placeholder">${icon("gamepad-2", 18)}</span>`}
      <span class="calendar-watch-info">
        <span class="calendar-watch-title">${esc(release.name)}</span>
        <span class="calendar-watch-meta">
          <span class="calendar-watch-date tabular-nums">${esc(dateLabel(release))}</span>
          ${countdown ? `<span class="calendar-watch-count tabular-nums">${esc(countdown)}</span>` : ""}
        </span>
        ${storeList ? `<span class="calendar-game-stores">${storeList}</span>` : ""}
      </span>
    </button>
    ${renderFollowButton(release, "is-watch-follow")}
  </div>`;
}

function renderWatchlist(list: UpcomingRelease[]): string {
  return `<div class="calendar-watchlist">
    <div class="calendar-watch-head">
      <span class="calendar-watch-head-title">${icon("star", 13)} <span>${esc(t("calendar.watchlist"))}</span></span>
      <span class="calendar-watch-head-count tabular-nums">${list.length}</span>
    </div>
    <div class="calendar-watch-cards">${list.map(renderWatchCard).join("")}</div>
  </div>`;
}

function renderWatchEmpty(): string {
  return `<div class="calendar-empty calendar-watch-empty">
      ${icon("star", 26)}
      <div class="calendar-empty-title">${esc(t("calendar.watchEmpty"))}</div>
      <div class="calendar-empty-hint">${esc(t("calendar.watchHint"))}</div>
      <button type="button" class="btn ghost" data-act="release-calendar-watch">${esc(t("calendar.watchBack"))}</button>
    </div>`;
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
  const month = ensureSelectedMonth();
  if (!month) return emptyHtml();
  const months = availableMonths();
  if (watching) {
    const watch = followedReleases();
    return `
      ${renderHero(watch[0] ?? null, t("calendar.watchNext"))}
      ${renderToolbar(months, month)}
      ${watch.length > 0 ? renderWatchlist(watch) : renderWatchEmpty()}
      <p class="calendar-source">${esc(t("calendar.sourceNote"))}</p>`;
  }
  const pool = monthGames(month);
  const exact = pool.filter(hasExactDay);
  // Feature the month's most followed release that has key art, so the banner
  // is both relevant and visually complete. Fall back to the most followed.
  const ranked = [...exact].sort((left, right) => (right.hypes ?? 0) - (left.hypes ?? 0));
  const hero = ranked.find((release) => release.artworkId) ?? ranked[0] ?? pool.find(hasMonthOnly) ?? null;
  return `
    ${renderHero(hero)}
    ${renderToolbar(months, month)}
    <div class="calendar-workspace">
      ${renderGrid(month, exact)}
      ${renderSchedule(month, exact)}
    </div>
    <p class="calendar-source">${esc(t("calendar.sourceNote"))}</p>`;
}

function renderCalendar(): void {
  if (!layer) return;
  const month = ensureSelectedMonth();
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
            <button type="button" class="icon-btn${loading ? " spinning" : ""}" data-act="release-calendar-refresh" title="${esc(t("calendar.refresh"))}" aria-label="${esc(t("calendar.refresh"))}" ${loading ? "disabled" : ""}>${icon("refresh", 15)}</button>
            <button type="button" class="manage-head-close" data-act="release-calendar-close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
          </div>
        </div>
        <div class="calendar-body">${month ? renderBody() : emptyHtml()}</div>
      </div>
    </div>`;
  const nextBody = layer.querySelector<HTMLElement>(".calendar-body");
  if (nextBody && scrollTop > 0) nextBody.scrollTop = scrollTop;
  const activeTab = layer.querySelector<HTMLElement>(".calendar-month-tab.is-active");
  activeTab?.scrollIntoView({ block: "nearest", inline: "center" });
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
    if (!selected || !availableMonths().some((month) => sameMonth(month, selected))) {
      selected = pickDefaultMonth(availableMonths());
      selectedDay = null;
    }
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
  selected = null;
  selectedDay = null;
  watching = false;
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
  selected = null;
  selectedDay = null;
  watching = false;
  loading = false;
  failed = false;
}

/** Cancels the open calendar; true when there was one (Escape handling). */
export function cancelReleaseCalendar(): boolean {
  if (!layer) return false;
  closeReleaseCalendar();
  return true;
}

/** Month tab; handled by the click router. */
export function setReleaseCalendarMonth(year: number, month: number): void {
  if (!Number.isFinite(year) || !Number.isFinite(month)) return;
  if (!availableMonths().some((entry) => entry.year === year && entry.month === month)) return;
  selected = { year, month };
  selectedDay = null;
  watching = false;
  renderCalendar();
}

/** Day tile in the mini month grid; clicking again or passing 0 clears the filter. */
export function setReleaseCalendarDay(day: number | null): void {
  if (day === null || !Number.isFinite(day) || day <= 0 || selectedDay === day) {
    selectedDay = null;
  } else {
    selectedDay = day;
  }
  renderCalendar();
}

/** Arrow buttons; skip empty months by walking the tab list. */
export function stepReleaseCalendarMonth(delta: -1 | 1): void {
  const months = availableMonths();
  if (months.length === 0) return;
  const current = ensureSelectedMonth();
  const index = months.findIndex((entry) => sameMonth(entry, current));
  const next = months[index + delta];
  if (!next) return;
  selected = { year: next.year, month: next.month };
  selectedDay = null;
  watching = false;
  renderCalendar();
}

/** Follows or unfollows one release. The star is the only writer of this set. */
export function toggleReleaseFollow(id: number): void {
  if (!Number.isFinite(id)) return;
  if (followed.has(id)) followed.delete(id);
  else followed.add(id);
  saveFollowed();
  if (watching && followedReleases().length === 0) watching = false;
  renderCalendar();
  if (storeLayer && storeRelease) {
    renderStoreDialog();
    storeLayer.querySelector<HTMLButtonElement>('[data-act="release-follow"]')?.focus();
  }
}

/** Switches the body between the month view and the followed list. */
export function toggleReleaseWatchlist(): void {
  watching = !watching;
  if (watching) selectedDay = null;
  renderCalendar();
}

/** Refresh button; bypasses the six-hour backend cache. */
export function refreshReleaseCalendar(): void {
  if (!layer || loading) return;
  void load(true);
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
          <button type="button" class="btn ghost${followed.has(release.id) ? " is-following" : ""}" data-act="release-follow" data-id="${release.id}">${icon("star", 13)} ${esc(followed.has(release.id) ? t("calendar.following") : t("calendar.follow"))}</button>
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

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
import { pushNotification } from "../notifications/notifications";
import { storeLogo } from "../store/store-logos";
import { holdStoreForCover } from "../store/store-view";

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
/** The latest follow metadata, so a reminder does not need a network call. */
const FOLLOW_CACHE_KEY = "efxlve-release-follow-cache";
const REMINDER_KEY = "efxlve-release-reminders";
const REMINDER_WINDOW_DAYS = 7;
const REMINDER_KEEP_DAYS = 30;
const MAX_REMINDERS_PER_DAY = 3;

let layer: HTMLElement | null = null;
let releases: UpcomingRelease[] = [];
let selected: MonthSel | null = null;
let selectedDay: number | null = null;
let loading = false;
let failed = false;
/** True while the body shows the followed list instead of one month. */
let watching = false;
let followed = loadFollowed();
/** Title search across every month; empty means the normal month view. */
let query = "";
/** A month, day or watch-list change starts at the top instead of the old scroll. */
let resetScroll = false;
/** Put the keyboard in the search field once the first load has painted. */
let focusSearchWhenLoaded = false;
/** Bumped by a restart or close so a late answer cannot repaint a dead dialog. */
let loadSeq = 0;
/** The game whose store bubble is open, if any. */
let storeRelease: UpcomingRelease | null = null;
let storeLayer: HTMLElement | null = null;
/** The card the bubble points at, so a second click can toggle it. */
let storeAnchor: HTMLElement | null = null;

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

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** Keep a compact local copy so reminders work before IGDB is queried. */
function rememberFollowedReleases(): void {
  try {
    const list = followedReleases();
    if (list.length === 0) localStorage.removeItem(FOLLOW_CACHE_KEY);
    else localStorage.setItem(FOLLOW_CACHE_KEY, JSON.stringify(list));
  } catch {
    // A full quota must not break the calendar.
  }
}

/**
 * One reminder per followed release once it enters the final week.
 * Called at startup; the cache is written whenever the calendar loads or a
 * star changes, so this needs no network and no IGDB call.
 */
export function remindFollowedReleases(): void {
  let cache: UpcomingRelease[] = [];
  try {
    const raw = localStorage.getItem(FOLLOW_CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed)) cache = parsed as UpcomingRelease[];
  } catch {
    return;
  }
  const upcoming = cache
    .filter(
      (release) =>
        release &&
        typeof release.id === "number" &&
        typeof release.name === "string" &&
        followed.has(release.id) &&
        hasExactDay(release),
    )
    .sort(
      (left, right) =>
        releaseSortKey(left) - releaseSortKey(right) || left.name.localeCompare(right.name),
    );
  if (upcoming.length === 0) return;

  const now = new Date();
  const todayKey = localDateKey(now);
  const todayStart = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  let reminders: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(REMINDER_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      reminders = parsed as Record<string, string>;
    }
  } catch {
    reminders = {};
  }

  let changed = false;
  let sent = 0;
  const sentToday = Object.values(reminders).filter((day) => day === todayKey).length;
  for (const release of upcoming) {
    if (sentToday + sent >= MAX_REMINDERS_PER_DAY) break;
    const target = Date.UTC(
      releaseYear(release),
      releaseMonth(release) - 1,
      releaseDay(release),
    );
    const days = Math.round((target - todayStart) / 86_400_000);
    if (days < 0 || days > REMINDER_WINDOW_DAYS) continue;
    const key = String(release.id);
    if (reminders[key]) continue;
    reminders[key] = todayKey;
    changed = true;
    sent += 1;
    pushNotification({
      kind: "info",
      title: release.name,
      body: `${releaseDateLabel(release)} · ${countdownLabel(release)}`,
      context: t("calendar.watchlist"),
      action: "open-release-calendar-search",
      actionData: release.name,
      actionLabel: t("calendar.title"),
    });
  }

  const cutoff = localDateKey(new Date(now.getTime() - REMINDER_KEEP_DAYS * 86_400_000));
  for (const [key, day] of Object.entries(reminders)) {
    if (day < cutoff) {
      delete reminders[key];
      changed = true;
    }
  }
  if (!changed) return;
  try {
    localStorage.setItem(REMINDER_KEY, JSON.stringify(reminders));
  } catch {
    // Reminder history is disposable.
  }
}

function searchReleases(): UpcomingRelease[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return releases
    .filter((release) => release.name.toLowerCase().includes(needle))
    .sort(
      (left, right) =>
        releaseSortKey(left) - releaseSortKey(right) || left.name.localeCompare(right.name),
    );
}

function renderFollowButton(release: UpcomingRelease): string {
  const isFollowed = followed.has(release.id);
  const label = isFollowed ? t("calendar.unfollow") : t("calendar.follow");
  return `<button type="button" class="calendar-follow-btn${isFollowed ? " is-followed" : ""}" data-act="release-follow" data-id="${release.id}" aria-pressed="${isFollowed}" title="${esc(label)}" aria-label="${esc(label)}">${icon("star", 14)}</button>`;
}

function sameMonth(left: MonthSel | null, right: MonthSel | null): boolean {
  return Boolean(left && right && left.year === right.year && left.month === right.month);
}

function monthOrdinal(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function monthAt(ordinal: number): MonthSel {
  return { year: Math.floor(ordinal / 12), month: (ordinal % 12) + 1 };
}

/**
 * A continuous strip from the current month through the last dated release.
 * Empty months stay visible with a zero badge: a hidden month between May and
 * November looked like a broken jump, when it only meant no dated release.
 */
function availableMonths(): MonthInfo[] {
  const now = new Date();
  const first = monthOrdinal(now.getFullYear(), now.getMonth() + 1);
  const counts = new Map<string, number>();
  let last = first;
  for (const release of releases) {
    if (!hasExactDay(release) && !hasMonthOnly(release)) continue;
    const year = releaseYear(release);
    const month = releaseMonth(release);
    if (year <= 0 || month <= 0) continue;
    const key = `${year}-${month}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    last = Math.max(last, monthOrdinal(year, month));
  }
  const months: MonthInfo[] = [];
  for (let index = first; index <= last; index += 1) {
    const month = monthAt(index);
    months.push({ ...month, count: counts.get(`${month.year}-${month.month}`) ?? 0 });
  }
  return months;
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

/** The same localized label for surfaces outside this dialog (command palette). */
export function releaseDateLabel(release: UpcomingRelease): string {
  return dateLabel(release);
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
    { id: "xbox", label: "Microsoft Store", url: `https://apps.microsoft.com/search?query=${query}` },
    { id: "humble", label: "Humble Store", url: `https://www.humblebundle.com/store/search?search=${query}` },
    { id: "fanatical", label: "Fanatical", url: `https://www.fanatical.com/en/search?search=${query}` },
    { id: "gmg", label: "Green Man Gaming", url: `https://www.greenmangaming.com/search?query=${query}` },
    { id: "itch", label: "itch.io", url: `https://itch.io/search?q=${query}` },
  ];
}

function coverOf(
  release: UpcomingRelease,
  size: "thumb" | "cover_small" | "cover_big" | "cover_big_2x" = "cover_big",
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

  const hasFollowed = games.some((game) => followed.has(game.id));
  const dots = games
    .slice(0, 3)
    .map(() => `<i></i>`)
    .join("");
  const tip = `${dayFullLabel(year, month, day)} · ${games.map((item) => item.name).join(", ")}`;
  return `<button type="button" class="calendar-day has-games${stateClasses}" data-act="release-calendar-day" data-day="${day}" aria-pressed="${isSelected}" title="${esc(tip)}">
    <span class="calendar-day-top">
      <span class="calendar-day-num${isToday ? " is-today" : ""}">${day}</span>
      ${hasFollowed ? `<span class="calendar-day-follow" aria-hidden="true">${icon("star", 9)}</span>` : ""}
    </span>
    <span class="calendar-day-foot">
      <span class="calendar-day-dots" aria-hidden="true">${dots}</span>
      <span class="calendar-day-badge tabular-nums">${games.length}</span>
    </span>
  </button>`;
}

function renderSidebar(month: MonthSel, exact: UpcomingRelease[], heroId: number | null): string {
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
  return `<aside class="calendar-sidebar">
    <div class="calendar-mini-card">
      <div class="calendar-mini-head">
        <span class="calendar-mini-title">${esc(monthLabel(month.year, month.month - 1))} <span class="tabular-nums">${month.year}</span></span>
        <span class="calendar-mini-count tabular-nums">${esc(t("col.gameCount", { count: String(exact.length) }))}</span>
      </div>
      <div class="calendar-weekdays" aria-hidden="true">${weekdayLabels()
        .map((label) => `<span>${esc(label)}</span>`)
        .join("")}</div>
      <div class="calendar-grid">${cells.join("")}</div>
    </div>
    ${renderTopReleases(heroId)}
  </aside>`;
}

function renderScheduleCard(release: UpcomingRelease): string {
  const cover = coverOf(release, "cover_big");
  const stores = release.stores ?? [];
  const storeBadges = stores
    .slice(0, 3)
    .map((store) => {
      const logo = storeLogo(store.id, 11, "calendar-card-store-logo");
      return logo
        ? `<span class="calendar-card-store-chip" title="${esc(storeLabel(store.id, store.label))}">${logo}</span>`
        : `<span class="calendar-card-store-chip is-text">${esc(storeLabel(store.id, store.label))}</span>`;
    })
    .join("");
  const storeNames = stores
    .slice(0, 2)
    .map((store) => storeLabel(store.id, store.label))
    .join(" · ");
  return `<div class="calendar-game-shell">
    <button type="button" class="calendar-game-card" data-act="release-stores" data-id="${release.id}" title="${esc(`${release.name} · ${dateLabel(release)}`)}">
      <span class="calendar-game-stage">
        ${cover ? `<img class="calendar-game-cover" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="calendar-game-cover placeholder">${icon("gamepad-2", 22)}</span>`}
        <span class="calendar-game-scrim"></span>
        ${storeBadges ? `<span class="calendar-game-badges">${storeBadges}</span>` : ""}
      </span>
      <span class="calendar-game-info">
        <span class="calendar-game-title">${esc(release.name)}</span>
        <span class="calendar-game-sub">${esc(storeNames || dateLabel(release))}</span>
      </span>
    </button>
    ${renderFollowButton(release)}
  </div>`;
}

function renderMonthEmpty(): string {
  return `<div class="calendar-month-empty">
    ${icon("calendar", 22)}
    <div class="calendar-month-empty-title">${esc(t("calendar.monthEmpty"))}</div>
    <div class="calendar-month-empty-hint">${esc(t("calendar.monthEmptyHint"))}</div>
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
  for (const games of buckets.values()) {
    games.sort(
      (left, right) =>
        (right.hypes ?? 0) - (left.hypes ?? 0) || left.name.localeCompare(right.name),
    );
  }
  const allDays = [...buckets.entries()].sort((left, right) => left[0] - right[0]);
  const hasFilter = selectedDay !== null && buckets.has(selectedDay);
  const now = new Date();
  const todayTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthIsCurrent =
    month.year === now.getFullYear() && month.month === now.getMonth() + 1;
  const visibleDays = hasFilter
    ? allDays.filter(([day]) => day === selectedDay)
    : monthIsCurrent
      ? allDays.filter(
          ([day]) => new Date(month.year, month.month - 1, day).getTime() >= todayTime,
        )
      : allDays;
  const upcomingTotal = monthIsCurrent
    ? allDays
        .filter(([day]) => new Date(month.year, month.month - 1, day).getTime() >= todayTime)
        .reduce((sum, [, games]) => sum + games.length, 0)
    : exact.length;

  const filterBar = hasFilter && selectedDay !== null
    ? `<div class="calendar-filter-bar">
        <span class="calendar-filter-label">${icon("calendar", 13)} <span>${esc(dayFullLabel(month.year, month.month, selectedDay))}</span></span>
        <button type="button" class="calendar-filter-reset" data-act="release-calendar-day" data-day="0">${esc(t("profile.showAll"))} <span class="tabular-nums">(${upcomingTotal})</span></button>
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
    ${groups ? "" : renderMonthEmpty()}
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
    .map(
      (store) =>
        `<span class="calendar-store-tag">${storeLogo(store.id, 12, "release-store-logo")}<span>${esc(storeLabel(store.id, store.label))}</span></span>`,
    )
    .join("");
  const fallbackTag = `<span class="calendar-store-tag is-muted">${icon("search", 11)}<span>${esc(t("calendar.whereToBuy"))}</span></span>`;
  const countdown = countdownLabel(release);
  return `<div class="calendar-hero-shell">
    <button type="button" class="calendar-hero${release.artworkId ? "" : " is-cover"}" data-act="release-stores" data-id="${release.id}">
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
      </span>
    </button>
    ${renderFollowButton(release)}
  </div>`;
}

function renderToolbar(months: MonthInfo[], active: MonthSel): string {
  const index = months.findIndex((month) => sameMonth(month, active));
  const previous = index > 0;
  const next = index >= 0 && index < months.length - 1;
  return `<div class="calendar-toolbar">
    <button type="button" class="icon-btn" data-act="release-calendar-prev" title="${esc(t("calendar.previousMonth"))}" aria-label="${esc(t("calendar.previousMonth"))}"${previous ? "" : " disabled"}>${icon("chevron-left", 16)}</button>
    <div class="calendar-monthbar" role="tablist" aria-label="${esc(t("calendar.title"))}">${months
      .map((month) => {
        const isActive = sameMonth(month, active) && !watching;
        return `<button type="button" class="calendar-month-tab${isActive ? " is-active" : ""}${month.count === 0 ? " is-empty" : ""}" role="tab" aria-selected="${isActive}" data-act="release-calendar-month" data-year="${month.year}" data-month="${month.month}">
          <span class="calendar-month-tab-main">${esc(monthLabel(month.year, month.month - 1))}</span>
          <span class="calendar-month-tab-year">${month.year}</span>
          <span class="calendar-month-tab-count tabular-nums">${month.count}</span>
        </button>`;
      })
      .join("")}</div>
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
        return `<div class="calendar-tba-shell">
          <button type="button" class="calendar-tba-card" data-act="release-stores" data-id="${release.id}">
            ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="calendar-tba-art placeholder">${icon("gamepad-2", 12)}</span>`}
            <span class="calendar-tba-name">${esc(release.name)}</span>
            <span class="calendar-tba-when">${esc(releaseDateLabel(release))}</span>
          </button>
          ${renderFollowButton(release)}
        </div>`;
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
        (release) => `<button type="button" class="calendar-chip" data-act="release-stores" data-id="${release.id}"><span class="calendar-chip-name">${esc(release.name)}</span><span class="calendar-chip-when tabular-nums">${esc(releaseDateLabel(release))}</span></button>`,
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
    <button type="button" class="calendar-watch-main" data-act="release-stores" data-id="${release.id}">
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
    ${renderFollowButton(release)}
  </div>`;
}

function renderSearchResults(): string {
  const matches = searchReleases();
  const head = `<div class="calendar-search-head">
    <span class="calendar-search-head-title">${icon("search", 13)} <span>${esc(t("calendar.searchResults", { count: String(matches.length) }))}</span></span>
  </div>`;
  if (matches.length === 0) {
    return `${head}<div class="calendar-empty calendar-search-empty">
      ${icon("search", 26)}
      <div class="calendar-empty-title">${esc(t("calendar.searchEmpty", { query: query.trim() }))}</div>
      <div class="calendar-empty-hint">${esc(t("calendar.searchHint"))}</div>
    </div>`;
  }
  return `${head}<div class="calendar-watch-cards">${matches.map(renderWatchCard).join("")}</div>
    <p class="calendar-source">${esc(t("calendar.sourceNote"))}</p>`;
}

function renderTopCard(release: UpcomingRelease, rank: number): string {
  const cover = coverOf(release, "cover_big");
  const countdown = countdownLabel(release);
  return `<div class="calendar-top-card">
    <button type="button" class="calendar-top-main" data-act="release-stores" data-id="${release.id}">
      <span class="calendar-top-art">
        ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="calendar-top-placeholder">${icon("gamepad-2", 16)}</span>`}
        <span class="calendar-top-rank tabular-nums">${rank}</span>
      </span>
      <span class="calendar-top-info">
        <span class="calendar-top-name">${esc(release.name)}</span>
        <span class="calendar-top-meta">
          <span class="calendar-top-date tabular-nums">${esc(releaseDateLabel(release))}</span>
          ${countdown ? `<span class="calendar-top-countdown tabular-nums">${esc(countdown)}</span>` : ""}
        </span>
      </span>
    </button>
    ${renderFollowButton(release)}
  </div>`;
}

/** The highest-hype releases across every month, stacked in the sidebar. */
function renderTopReleases(heroId: number | null): string {
  const ranked = releases
    .filter((release) => release.id !== heroId && (release.hypes ?? 0) > 0)
    .sort(
      (left, right) =>
        (right.hypes ?? 0) - (left.hypes ?? 0) || left.name.localeCompare(right.name),
    )
    .slice(0, 5);
  if (ranked.length === 0) return "";
  return `<section class="calendar-top" aria-label="${esc(t("calendar.mostAnticipated"))}">
    <div class="calendar-top-head">
      <span class="calendar-top-title">${icon("sparkles", 13)} <span>${esc(t("calendar.mostAnticipated"))}</span></span>
    </div>
    <div class="calendar-top-rail">${ranked.map((release, index) => renderTopCard(release, index + 1)).join("")}</div>
  </section>`;
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
  if (query.trim()) return renderSearchResults();
  const month = ensureSelectedMonth();
  if (!month) return emptyHtml();
  const months = availableMonths();
  if (watching) {
    const watch = followedReleases();
    return `
      ${renderToolbar(months, month)}
      ${renderHero(watch[0] ?? null, t("calendar.watchNext"))}
      ${watch.length > 0 ? renderWatchlist(watch) : renderWatchEmpty()}
      <p class="calendar-source">${esc(t("calendar.sourceNote"))}</p>`;
  }
  const pool = monthGames(month);
  const exact = pool.filter(hasExactDay);
  const ranked = [...exact].sort((left, right) => (right.hypes ?? 0) - (left.hypes ?? 0));
  const hero = ranked.find((release) => release.artworkId) ?? ranked[0] ?? pool.find(hasMonthOnly) ?? null;
  return `
    ${renderToolbar(months, month)}
    <div class="calendar-workspace">
      ${renderSidebar(month, exact, hero?.id ?? null)}
      <div class="calendar-main">
        ${renderHero(hero)}
        ${renderSchedule(month, exact)}
      </div>
    </div>
    <p class="calendar-source">${esc(t("calendar.sourceNote"))}</p>`;
}

/** Repaints only the body so the search field above it keeps focus and caret. */
function paintSearchBody(): void {
  if (!layer) return;
  const body = layer.querySelector<HTMLElement>(".calendar-body");
  if (!body) return;
  body.innerHTML = renderBody();
  body.scrollTop = 0;
  resetScroll = false;
  const clear = layer.querySelector<HTMLElement>(".calendar-search-clear");
  if (clear) clear.hidden = query.length === 0;
}

function renderCalendar(): void {
  if (!layer) return;
  const month = ensureSelectedMonth();
  const watchCount = followedReleases().length;
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
            <button type="button" class="calendar-watch-toggle${watching ? " is-active" : ""}" data-act="release-calendar-watch" aria-pressed="${watching}" title="${esc(t("calendar.watchlist"))}">
              ${icon("star", 13)}
              <span class="calendar-watch-toggle-label">${esc(t("calendar.watchlist"))}</span>
              ${watchCount > 0 ? `<span class="calendar-watch-toggle-count tabular-nums">${watchCount}</span>` : ""}
            </button>
            <div class="calendar-search" role="search">
              <span class="calendar-search-icon">${icon("search", 13)}</span>
              <input class="calendar-search-input" type="text" value="${esc(query)}" placeholder="${esc(t("calendar.searchPlaceholder"))}" aria-label="${esc(t("calendar.searchPlaceholder"))}" autocomplete="off" spellcheck="false" />
              <button type="button" class="calendar-search-clear" data-act="release-calendar-search-clear" title="${esc(t("common.clear"))}" aria-label="${esc(t("common.clear"))}"${query ? "" : " hidden"}>${icon("x", 12)}</button>
            </div>
            <button type="button" class="icon-btn${loading ? " spinning" : ""}" data-act="release-calendar-refresh" title="${esc(t("calendar.refresh"))}" aria-label="${esc(t("calendar.refresh"))}" ${loading ? "disabled" : ""}>${icon("refresh", 15)}</button>
            <button type="button" class="manage-head-close" data-act="release-calendar-close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
          </div>
        </div>
        <div class="calendar-body">${month ? renderBody() : emptyHtml()}</div>
      </div>
    </div>`;
  const nextBody = layer.querySelector<HTMLElement>(".calendar-body");
  if (nextBody) {
    if (resetScroll) {
      nextBody.scrollTop = 0;
      resetScroll = false;
    } else if (scrollTop > 0) {
      nextBody.scrollTop = scrollTop;
    }
  }
  const monthbar = layer.querySelector<HTMLElement>(".calendar-monthbar");
  const activeTab = monthbar?.querySelector<HTMLElement>(".calendar-month-tab.is-active");
  if (monthbar && activeTab) {
    const firstTab = monthbar.firstElementChild as HTMLElement | null;
    if (activeTab === firstTab) {
      monthbar.scrollLeft = 0;
    } else {
      const targetLeft =
        activeTab.offsetLeft - monthbar.clientWidth / 2 + activeTab.clientWidth / 2;
      monthbar.scrollLeft = Math.max(0, targetLeft);
    }
  }
  monthbar?.addEventListener(
    "wheel",
    (event) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        monthbar.scrollLeft += event.deltaY;
      }
    },
    { passive: false },
  );
  const searchInput = layer.querySelector<HTMLInputElement>(".calendar-search-input");
  searchInput?.addEventListener("input", () => {
    query = searchInput.value;
    paintSearchBody();
  });
  refreshStoreAnchor();
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
    rememberFollowedReleases();
  } catch {
    if (seq !== loadSeq || !layer) return;
    releases = [];
    failed = true;
  }
  loading = false;
  renderCalendar();
  if (focusSearchWhenLoaded) {
    focusSearchWhenLoaded = false;
    layer?.querySelector<HTMLInputElement>(".calendar-search-input")?.focus();
  }
}

/** Opens the upcoming-release calendar. */
export function openReleaseCalendar(): void {
  closeReleaseStores();
  releases = [];
  selected = null;
  selectedDay = null;
  watching = false;
  query = "";
  resetScroll = true;
  focusSearchWhenLoaded = true;
  failed = false;
  if (layer) layer.remove();
  layer = document.createElement("div");
  layer.className = "calendar-layer";
  confirmRoot.appendChild(layer);
  // A native store child ignores z-index; park it now that confirmRoot holds the layer.
  holdStoreForCover();
  renderCalendar();
  void load(false);
}

/** Opens the calendar with a title search, used by the command palette. */
export function openReleaseCalendarSearch(text: string): void {
  openReleaseCalendar();
  query = text.trim();
  renderCalendar();
  layer?.querySelector<HTMLInputElement>(".calendar-search-input")?.focus();
}

/** Opens the calendar directly on the followed list. */
export function openReleaseCalendarWatchlist(): void {
  openReleaseCalendar();
  watching = true;
  resetScroll = true;
  renderCalendar();
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
  query = "";
  resetScroll = false;
  focusSearchWhenLoaded = false;
  loading = false;
  failed = false;
}

/** True while the upcoming-release dialog is mounted. */
export function isReleaseCalendarOpen(): boolean {
  return Boolean(layer);
}

/** True while the store picker sits above the calendar. */
export function isReleaseStoresOpen(): boolean {
  return Boolean(storeLayer);
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
  resetScroll = true;
  renderCalendar();
}

/** Day tile in the mini month grid; clicking again or passing 0 clears the filter. */
export function setReleaseCalendarDay(day: number | null): void {
  if (day === null || !Number.isFinite(day) || day <= 0 || selectedDay === day) {
    selectedDay = null;
  } else {
    selectedDay = day;
  }
  resetScroll = true;
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
  resetScroll = true;
  renderCalendar();
}

/** Follows or unfollows one release. The star is the only writer of this set. */
export function toggleReleaseFollow(id: number): void {
  if (!Number.isFinite(id)) return;
  const active = document.activeElement as HTMLElement | null;
  const focusId = active?.dataset.act === "release-follow" ? active.dataset.id : null;
  // The hero, schedule and search list can show the same release. Remember
  // which surface the star belonged to so focus returns to that same row.
  const focusShell = active?.closest<HTMLElement>(
    ".calendar-hero-shell, .calendar-game-shell, .calendar-top-card, .calendar-watch-card, .calendar-tba-shell",
  )?.classList[0];
  if (followed.has(id)) followed.delete(id);
  else followed.add(id);
  saveFollowed();
  rememberFollowedReleases();
  if (watching && followedReleases().length === 0) watching = false;
  renderCalendar();
  if (focusId) {
    const scoped = focusShell
      ? layer?.querySelector<HTMLButtonElement>(
          `.${focusShell} .calendar-follow-btn[data-id="${focusId}"]`,
        )
      : null;
    (scoped ??
      layer?.querySelector<HTMLButtonElement>(
        `.calendar-follow-btn[data-id="${focusId}"]`,
      ))?.focus();
  }
  if (storeLayer && storeRelease) {
    renderStorePopover();
    storeLayer.querySelector<HTMLButtonElement>('[data-act="release-follow"]')?.focus();
  }
}

/** Switches the body between the month view and the followed list. */
export function toggleReleaseWatchlist(): void {
  watching = !watching;
  if (watching) {
    selectedDay = null;
    query = "";
  }
  resetScroll = true;
  renderCalendar();
}

/** Clears the title search and returns to the month view. */
export function clearReleaseCalendarSearch(): void {
  if (!layer) return;
  query = "";
  const input = layer.querySelector<HTMLInputElement>(".calendar-search-input");
  if (input) input.value = "";
  paintSearchBody();
  input?.focus();
}

/** Escape clears a running search before the next press closes the calendar. */
export function cancelReleaseCalendarSearch(): boolean {
  if (!layer || !query.length) return false;
  clearReleaseCalendarSearch();
  return true;
}

/** Refresh button; bypasses the six-hour backend cache. */
export function refreshReleaseCalendar(): void {
  if (!layer || loading) return;
  void load(true);
}

function ensureStoreLayer(): HTMLElement {
  if (storeLayer) return storeLayer;
  storeLayer = document.createElement("div");
  storeLayer.className = "release-popover-layer";
  confirmRoot.appendChild(storeLayer);
  storeLayer.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-act="open-external-url"]')) {
      window.setTimeout(closeReleaseStores, 0);
    }
  });
  return storeLayer;
}

/** Keep the bubble beside its card, flipping or clamping at the viewport edges. */
function positionStorePopover(): void {
  const popover = storeLayer?.querySelector<HTMLElement>(".release-popover");
  if (!popover || !storeAnchor) return;
  const rect = storeAnchor.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const margin = 12;
  const gap = 10;
  let left = rect.right + gap;
  let top = rect.top;
  if (left + width > window.innerWidth - margin) left = rect.left - width - gap;
  if (left < margin) {
    left = Math.min(
      Math.max(margin, rect.left),
      Math.max(margin, window.innerWidth - width - margin),
    );
    const below = rect.bottom + 8;
    top = below + height <= window.innerHeight - margin ? below : rect.top - height - 8;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

/** After a repaint, point the bubble at the new copy of the same card. */
function refreshStoreAnchor(): void {
  if (!storeLayer || !storeRelease) return;
  const shell = storeAnchor?.closest<HTMLElement>(
    ".calendar-hero-shell, .calendar-game-shell, .calendar-top-card, .calendar-watch-card, .calendar-tba-shell",
  )?.classList[0];
  const id = storeRelease.id;
  const scoped = shell
    ? layer?.querySelector<HTMLElement>(
        `.${shell} [data-act="release-stores"][data-id="${id}"]`,
      )
    : null;
  const anchor =
    scoped ??
    layer?.querySelector<HTMLElement>(`[data-act="release-stores"][data-id="${id}"]`);
  if (!anchor) {
    closeReleaseStores();
    return;
  }
  storeAnchor = anchor;
  positionStorePopover();
}

function renderStorePopover(): void {
  if (!storeLayer || !storeRelease) return;
  const release = storeRelease;
  const cover = coverOf(release, "cover_big");
  const exact = (release.stores ?? []).map(
    (store) =>
      `<button type="button" class="release-store-btn" data-act="open-external-url" data-url="${esc(store.url)}">
        ${storeLogo(store.id, 13, "release-store-logo")}<span>${esc(storeLabel(store.id, store.label))}</span>${icon("external", 11)}
      </button>`,
  );
  const known = new Set((release.stores ?? []).map((store) => store.id));
  const searches = storeSearchLinks(release.name)
    .filter((store) => !known.has(store.id))
    .map(
      (store) =>
        `<button type="button" class="release-store-btn is-search" data-act="open-external-url" data-url="${esc(store.url)}" aria-label="${esc(t("calendar.searchOn", { store: store.label }))}">
          ${storeLogo(store.id, 13, "release-store-logo") || icon("search", 11)}<span>${esc(store.label)}</span>
        </button>`,
    );
  const followedNow = followed.has(release.id);
  storeLayer.innerHTML = `
    <div class="release-popover" role="dialog" aria-label="${esc(`${release.name} · ${dateLabel(release)}`)}">
      <div class="release-popover-head">
        ${cover ? `<img class="release-stores-cover" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="release-stores-cover placeholder">${icon("gamepad-2", 18)}</span>`}
        <div class="release-stores-head-text">
          <p class="release-stores-title">${esc(release.name)}</p>
          <p class="release-stores-date">${esc(
            [dateLabel(release), countdownLabel(release)].filter(Boolean).join(" · "),
          )}</p>
        </div>
        <button type="button" class="manage-head-close" data-act="release-stores-close" title="${esc(t("common.close"))}">${icon("x", 15)}</button>
      </div>
      <div class="release-popover-body">
        <div class="release-stores-section">${esc(t("calendar.whereToBuy"))}</div>
        <div class="release-stores-list">
          ${exact.length > 0 ? exact.join("") : `<p class="release-stores-empty">${esc(t("calendar.noStoreLinks"))}</p>`}
        </div>
        <div class="release-stores-section">${esc(t("calendar.searchStores"))}</div>
        <div class="release-stores-list is-search">${searches.join("")}</div>
        <p class="release-stores-note">${icon("info", 11)}<span>${esc(t("calendar.storeNote"))}</span></p>
      </div>
      <div class="release-popover-foot">
        <button type="button" class="btn ghost small${followedNow ? " is-following" : ""}" data-act="release-follow" data-id="${release.id}">${icon("star", 12)} ${esc(followedNow ? t("calendar.following") : t("calendar.follow"))}</button>
        ${release.url ? `<button type="button" class="release-popover-link" data-act="open-external-url" data-url="${esc(release.url)}">${icon("external", 11)} ${esc(t("calendar.igdbPage"))}</button>` : ""}
      </div>
    </div>`;
  positionStorePopover();
  storeLayer.querySelector<HTMLButtonElement>('[data-act="release-stores-close"]')?.focus();
}

/** Clicking a card opens the store bubble; clicking the same card again closes it. */
export function openReleaseStores(id: number, anchor?: HTMLElement | null): void {
  if (!layer) return;
  const release = releases.find((item) => item.id === id);
  if (!release) return;
  if (storeRelease?.id === id && storeLayer) {
    closeReleaseStores();
    return;
  }
  storeRelease = release;
  storeAnchor =
    anchor ??
    layer.querySelector<HTMLElement>(`[data-act="release-stores"][data-id="${id}"]`);
  ensureStoreLayer();
  renderStorePopover();
}

/** Closes the store bubble. */
export function closeReleaseStores(): void {
  const restoreFocus = Boolean(storeLayer?.contains(document.activeElement));
  const anchor = storeAnchor;
  storeLayer?.remove();
  storeLayer = null;
  storeRelease = null;
  storeAnchor = null;
  if (restoreFocus && anchor?.isConnected) anchor.focus();
}

/** Cancels the store bubble; true when there was one (Escape handling). */
export function cancelReleaseStores(): boolean {
  if (!storeLayer) return false;
  closeReleaseStores();
  return true;
}

/* ---------- Outside-click and viewport handling ---------- */

document.addEventListener("click", (event) => {
  if (!storeLayer) return;
  const target = event.target as HTMLElement | null;
  if (!target || storeLayer.contains(target)) return;
  if (
    target.closest(
      '[data-act="release-stores"], [data-act="release-calendar-close"], [data-act="release-stores-close"]',
    )
  ) {
    return;
  }
  closeReleaseStores();
});

document.addEventListener(
  "scroll",
  (event) => {
    if (!storeLayer) return;
    const target = event.target as HTMLElement | null;
    if (!target || storeLayer.contains(target)) return;
    if (layer?.contains(target)) closeReleaseStores();
  },
  true,
);

window.addEventListener("resize", () => {
  if (storeLayer) closeReleaseStores();
});

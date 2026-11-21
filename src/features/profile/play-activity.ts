/**
 * Play activity: daily totals, a fourteen-day chart and a weekly recap.
 *
 * Sessions are stored as local spans (`started_at` + `seconds`) so a session
 * that crosses midnight is split across both days by the local clock. The
 * profile renders this from the same playtime map the cards use, which keeps
 * the numbers consistent with the "played" stat in the hero.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { sourceOfKey, summaryOf } from "../../core/selectors";
import type { GameSource } from "../../core/types";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";

export interface PlaySession {
  /** Unix seconds when the session started. */
  started_at: number;
  /** Length of the session in seconds. */
  seconds: number;
}

export interface PlayDay {
  /** Local `YYYY-MM-DD` key. */
  key: string;
  seconds: number;
}

export interface PlayActivityData {
  /** Last fourteen days, oldest first. */
  days: PlayDay[];
  today: number;
  last7: number;
  prev7: number;
  last30: number;
  /** True when at least one session span exists for the scope. */
  hasSessions: boolean;
  /** Games with any playtime in the scope, even from before session tracking. */
  trackedGames: number;
  top: Array<{ appName: string; seconds: number; title: string; cover: string }>;
}

const DAY_MS = 86_400_000;

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Splits one session across local midnights. A session longer than the guard
 * (64 days) is clamped; real sessions never come close, and a corrupt
 * timestamp must not spin a render loop.
 */
export function splitSessionByLocalDay(startedAt: number, seconds: number): Map<string, number> {
  const out = new Map<string, number>();
  let remaining = Math.max(0, Math.floor(seconds));
  if (remaining <= 0) return out;
  let cursor = new Date(startedAt * 1000);
  if (Number.isNaN(cursor.getTime())) return out;
  for (let guard = 0; remaining > 0 && guard < 64; guard++) {
    const nextMidnight = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    const span = Math.max(1, Math.floor((nextMidnight.getTime() - cursor.getTime()) / 1000));
    const chunk = Math.min(remaining, span);
    const key = localDayKey(cursor);
    out.set(key, (out.get(key) ?? 0) + chunk);
    remaining -= chunk;
    cursor = new Date(cursor.getTime() + chunk * 1000);
  }
  return out;
}

/** Aggregates the session spans for one profile scope. */
export function playActivityFor(scope: "all" | GameSource): PlayActivityData {
  const today = startOfLocalDay(new Date());
  const days: PlayDay[] = [];
  const totals = new Map<string, number>();
  for (let offset = 29; offset >= 0; offset--) {
    days.push({ key: localDayKey(addDays(today, -offset)), seconds: 0 });
  }
  const windowKeys = new Set(days.slice(-30).map((day) => day.key));
  const weekStart = days[days.length - 7].key;
  const monthStart = days[0].key;
  const gameWeek = new Map<string, number>();
  const gameMonth = new Map<string, number>();
  let hasSessions = false;
  let trackedGames = 0;

  for (const [appName, record] of S.playtimeMap) {
    if (scope !== "all" && sourceOfKey(appName) !== scope) continue;
    if ((record.total_seconds || 0) > 0) trackedGames++;
    for (const session of record.sessions ?? []) {
      const seconds = Number(session?.seconds) || 0;
      const startedAt = Number(session?.started_at) || 0;
      if (seconds <= 0 || startedAt <= 0) continue;
      hasSessions = true;
      for (const [key, part] of splitSessionByLocalDay(startedAt, seconds)) {
        // A session that started before the window can still contribute its
        // post-midnight part, so every part is tested separately.
        if (!windowKeys.has(key)) continue;
        totals.set(key, (totals.get(key) ?? 0) + part);
        if (key >= weekStart) gameWeek.set(appName, (gameWeek.get(appName) ?? 0) + part);
        if (key >= monthStart) gameMonth.set(appName, (gameMonth.get(appName) ?? 0) + part);
      }
    }
  }

  for (const day of days) day.seconds = totals.get(day.key) ?? 0;
  const last7 = days.slice(-7).reduce((sum, day) => sum + day.seconds, 0);
  const prev7 = days.slice(-14, -7).reduce((sum, day) => sum + day.seconds, 0);
  const last30 = days.reduce((sum, day) => sum + day.seconds, 0);

  // A week without play still owes the user a useful recap: fall back to the
  // month so the card never opens empty while sessions exist.
  const source = last7 > 0 ? gameWeek : gameMonth;
  const top = [...source.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([appName, seconds]) => {
      const summary = summaryOf(appName);
      return {
        appName,
        seconds,
        title: summary?.title || appName,
        cover: S.customCovers[appName] || summary?.cover || "",
      };
    });

  return {
    days,
    today: days[days.length - 1]?.seconds ?? 0,
    last7,
    prev7,
    last30,
    hasSessions,
    trackedGames,
    top,
  };
}

function stat(label: string, seconds: number): string {
  return `<div class="play-stat">
    <span class="play-stat-val tabular-nums">${esc(fmtPlaytime(seconds))}</span>
    <span class="play-stat-label">${esc(label)}</span>
  </div>`;
}

function deltaText(data: PlayActivityData): string {
  const delta = data.last7 - data.prev7;
  if (delta === 0) return "";
  const sign = delta > 0 ? "+" : "−";
  return t("profile.activityVsPrev", { delta: `${sign}${fmtPlaytime(Math.abs(delta))}` });
}

function renderChart(data: PlayActivityData): string {
  const shown = data.days.slice(-14);
  const max = Math.max(1, ...shown.map((day) => day.seconds));
  const todayKey = shown[shown.length - 1]?.key ?? "";
  const bars = shown
    .map((day) => {
      const height = day.seconds > 0 ? Math.max(4, Math.round((day.seconds / max) * 100)) : 0;
      const [year, month, date] = day.key.split("-");
      const label = `${date}.${month}.${year}`;
      const tip = `${label} · ${fmtPlaytime(day.seconds)}`;
      return `<span class="play-bar-slot" title="${esc(tip)}">
        <span class="play-bar${day.key === todayKey ? " is-today" : ""}" style="height:${height}%"></span>
      </span>`;
    })
    .join("");
  return `<div class="play-chart" role="img" aria-label="${esc(t("profile.activityChartTitle"))}">${bars}</div>`;
}

function renderTop(data: PlayActivityData): string {
  if (data.top.length === 0) return "";
  const max = Math.max(1, ...data.top.map((row) => row.seconds));
  const rows = data.top
    .map((row) => {
      const width = Math.max(3, Math.round((row.seconds / max) * 100));
      const art = row.cover
        ? `<img class="play-top-art" src="${esc(row.cover)}" alt="" loading="lazy" decoding="async" />`
        : `<span class="play-top-art placeholder">${icon("gamepad-2", 14)}</span>`;
      return `<button type="button" class="play-top-row" data-act="open-game-from-profile" data-id="${esc(row.appName)}" title="${esc(row.title)}">
        ${art}
        <span class="play-top-main">
          <span class="play-top-name">${esc(row.title)}</span>
          <span class="play-top-track"><span style="width:${width}%"></span></span>
        </span>
        <span class="play-top-time tabular-nums">${esc(fmtPlaytime(row.seconds))}</span>
      </button>`;
    })
    .join("");
  return `<div class="play-top">
    <div class="play-top-head">${esc(data.last7 > 0 ? t("profile.activityTopWeek") : t("profile.activityTopMonth"))}</div>
    ${rows}
  </div>`;
}

/**
 * The activity card for the profile page. Returns an empty string when the
 * scope has no playtime at all, so a fresh profile never gains a blank panel.
 */
export function renderPlayActivity(scope: "all" | GameSource): string {
  const data = playActivityFor(scope);
  if (!data.hasSessions && data.trackedGames === 0) return "";
  const body = data.hasSessions
    ? `<div class="play-activity-card">
        <div class="play-summary">
          ${stat(t("profile.activityToday"), data.today)}
          <div class="play-stat-group">
            ${stat(t("profile.activityWeek"), data.last7)}
            ${deltaText(data) ? `<span class="play-delta${data.last7 >= data.prev7 ? " up" : ""}">${esc(deltaText(data))}</span>` : ""}
          </div>
          ${stat(t("profile.activityMonth"), data.last30)}
        </div>
        <div class="play-chart-wrap">
          <div class="play-chart-head">${esc(t("profile.activityChartTitle"))}</div>
          ${renderChart(data)}
        </div>
        ${renderTop(data)}
      </div>`
    : `<div class="play-activity-card is-new">
        <p class="play-empty-copy">${esc(t("profile.activityNoSessions"))}</p>
      </div>`;
  return `
    <section class="profile-row play-activity">
      <div class="profile-row-head">
        <h3 class="profile-row-title">${esc(t("profile.activityTitle"))}</h3>
        <span class="profile-unlock-stats tabular-nums">${esc(`${data.trackedGames} ${t("profile.games")}`)}</span>
      </div>
      ${body}
    </section>`;
}

// Kept next to the aggregation so a future test can exercise the split rule
// without a DOM: one local day is exactly 24h except across a DST change.
export const __activityInternals = { localDayKey, DAY_MS };

/**
 * Play activity: daily totals, a 14-day / 30-day chart and a weekly or monthly recap.
 *
 * Sessions are stored as local spans (`started_at` + `seconds`) so a session
 * that crosses midnight is split across both days by the local clock. The
 * profile renders this from the same playtime map the cards use, which keeps
 * the numbers consistent with the "played" stat in the hero.
 */

import { icon } from "../../core/icons";
import { rawOf, sourceOfKey, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { cachedSteamCover, steamCdnPortrait } from "../../core/steam-art-cache";
import type { GameSource } from "../../core/types";
import { esc, fmtPlaytime } from "../../core/utils";
import { epicPortrait } from "../../epic";
import { t } from "../../i18n";

export interface PlaySession {
  /** Unix seconds when the session started. */
  started_at: number;
  /** Length of the session in seconds. */
  seconds: number;
}

export interface PlayDayGame {
  appName: string;
  title: string;
  seconds: number;
  cover: string;
}

export interface PlayDay {
  /** Local `YYYY-MM-DD` key. */
  key: string;
  seconds: number;
  games: PlayDayGame[];
}

export interface PlayTopEntry {
  appName: string;
  seconds: number;
  title: string;
  cover: string;
}

export interface PlayActivityData {
  /** Last thirty days, oldest first. */
  days: PlayDay[];
  today: number;
  last7: number;
  prev7: number;
  last30: number;
  /** True when at least one session span exists for the scope. */
  hasSessions: boolean;
  /** Games with any playtime in the scope, even from before session tracking. */
  trackedGames: number;
  top: PlayTopEntry[];
  topWeek: PlayTopEntry[];
  topMonth: PlayTopEntry[];
}

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

function topCoverOf(appName: string): string {
  const custom = S.customCovers[appName];
  if (custom) return custom;
  if (appName.startsWith("steam::")) {
    const appId = appName.slice(7);
    if (/^\d+$/.test(appId)) {
      return cachedSteamCover(appId) || steamCdnPortrait(appId);
    }
  }
  const s = S.epicSummariesMap.get(appName) || summaryOf(appName);
  const raw = rawOf(appName);
  const gogItem = S.gogSummariesMap.get(appName) || S.allGamesMap.get(appName);
  return (raw ? epicPortrait(raw) : null) || s?.cover || gogItem?.coverUrl || "";
}

function topSteamArtAttrs(appName: string): string {
  if (S.customCovers[appName] || !appName.startsWith("steam::")) return "";
  const appId = appName.slice(7);
  if (!/^\d+$/.test(appId)) return "";
  return ` data-steam-app="${appId}" data-art-step="${cachedSteamCover(appId) ? "resolved" : "0"}"`;
}

function buildTopList(map: Map<string, number>): PlayTopEntry[] {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([appName, seconds]) => {
      const summary = summaryOf(appName);
      return {
        appName,
        seconds,
        title: summary?.title || appName,
        cover: topCoverOf(appName),
      };
    });
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
  const dayGames = new Map<string, Map<string, number>>();
  for (let offset = 29; offset >= 0; offset--) {
    days.push({ key: localDayKey(addDays(today, -offset)), seconds: 0, games: [] });
  }
  const windowKeys = new Set(days.slice(-30).map((day) => day.key));
  const weekStart = days[days.length - 7].key;
  const monthStart = days[0].key;
  const gameWeek = new Map<string, number>();
  const gameMonth = new Map<string, number>();
  let hasSessions = false;
  let trackedGames = 0;

  for (const [appName, record] of S.playtimeMap) {
    if (S.hiddenGames.has(appName)) continue;
    if (scope !== "all" && sourceOfKey(appName) !== scope) continue;
    if ((record.total_seconds || 0) > 0) trackedGames++;
    for (const session of record.sessions ?? []) {
      const seconds = Number(session?.seconds) || 0;
      const startedAt = Number(session?.started_at) || 0;
      if (seconds <= 0 || startedAt <= 0) continue;
      hasSessions = true;
      for (const [key, part] of splitSessionByLocalDay(startedAt, seconds)) {
        if (!windowKeys.has(key)) continue;
        totals.set(key, (totals.get(key) ?? 0) + part);
        if (key >= weekStart) gameWeek.set(appName, (gameWeek.get(appName) ?? 0) + part);
        if (key >= monthStart) gameMonth.set(appName, (gameMonth.get(appName) ?? 0) + part);

        let perGame = dayGames.get(key);
        if (!perGame) {
          perGame = new Map<string, number>();
          dayGames.set(key, perGame);
        }
        perGame.set(appName, (perGame.get(appName) ?? 0) + part);
      }
    }
  }

  for (const day of days) {
    day.seconds = totals.get(day.key) ?? 0;
    const perGame = dayGames.get(day.key);
    if (perGame && perGame.size > 0) {
      day.games = [...perGame.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([appName, seconds]) => {
          const summary = summaryOf(appName);
          return {
            appName,
            seconds,
            title: summary?.title || appName,
            cover: topCoverOf(appName),
          };
        });
    } else {
      day.games = [];
    }
  }
  const last7 = days.slice(-7).reduce((sum, day) => sum + day.seconds, 0);
  const prev7 = days.slice(-14, -7).reduce((sum, day) => sum + day.seconds, 0);
  const last30 = days.reduce((sum, day) => sum + day.seconds, 0);

  const topWeek = buildTopList(gameWeek);
  const topMonth = buildTopList(gameMonth);
  const top = topWeek.length > 0 ? topWeek : topMonth;

  return {
    days,
    today: days[days.length - 1]?.seconds ?? 0,
    last7,
    prev7,
    last30,
    hasSessions,
    trackedGames,
    top,
    topWeek,
    topMonth,
  };
}

function stat(label: string, seconds: number, highlight = false, delta = ""): string {
  return `<div class="play-stat${highlight ? " is-active-range" : ""}">
    <span class="play-stat-label">${esc(label)}</span>
    <span class="play-stat-val-row">
      <span class="play-stat-val tabular-nums">${esc(fmtPlaytime(seconds))}</span>
      ${delta}
    </span>
  </div>`;
}

function deltaHtml(data: PlayActivityData): string {
  const delta = data.last7 - data.prev7;
  if (delta === 0) return "";
  const sign = delta > 0 ? "+" : "−";
  const text = t("profile.activityVsPrev", { delta: `${sign}${fmtPlaytime(Math.abs(delta))}` });
  return `<span class="play-delta tabular-nums${delta > 0 ? " up" : ""}">${esc(text)}</span>`;
}

function fmtShortDay(key: string): string {
  const [, month, date] = key.split("-");
  return `${date}.${month}`;
}

function renderDayPopover(day: PlayDay, isToday: boolean): string {
  const [year, month, date] = day.key.split("-");
  const dateFormatted = `${date}.${month}.${year}`;
  const totalLabel = day.seconds > 0 ? fmtPlaytime(day.seconds) : t("playtime.notPlayed");
  const games = day.games ?? [];
  const maxShown = 4;
  const shownGames = games.slice(0, maxShown);
  const remaining = games.length - shownGames.length;

  let bodyHtml = "";
  if (games.length > 0) {
    const rows = shownGames
      .map((g) => {
        const art = g.cover
          ? `<img class="play-popover-cover"${topSteamArtAttrs(g.appName)} src="${esc(g.cover)}" alt="" loading="lazy" decoding="async" />`
          : `<span class="play-popover-cover placeholder">${icon("gamepad-2", 12)}</span>`;
        return `<div class="play-popover-game">
          ${art}
          <span class="play-popover-title" title="${esc(g.title)}">${esc(g.title)}</span>
          <span class="play-popover-duration tabular-nums">${esc(fmtPlaytime(g.seconds))}</span>
        </div>`;
      })
      .join("");
    const moreHtml =
      remaining > 0
        ? `<div class="play-popover-more">${esc(t("steam.more", { count: remaining }))}</div>`
        : "";
    bodyHtml = `<div class="play-popover-list">${rows}${moreHtml}</div>`;
  } else {
    bodyHtml = `<div class="play-popover-empty">${esc(t("playtime.notPlayed"))}</div>`;
  }

  return `<div class="play-day-popover" role="tooltip" aria-hidden="true">
    <div class="play-popover-head">
      <div class="play-popover-date-wrap">
        <span class="play-popover-date tabular-nums">${esc(dateFormatted)}</span>
        ${isToday ? `<span class="play-popover-today-badge">${esc(t("profile.activityToday"))}</span>` : ""}
      </div>
      <span class="play-popover-total tabular-nums">${esc(totalLabel)}</span>
    </div>
    ${bodyHtml}
  </div>`;
}

function renderChart(data: PlayActivityData, range: "7d" | "30d"): string {
  const shown = range === "30d" ? data.days : data.days.slice(-14);
  const max = Math.max(1, ...shown.map((day) => day.seconds));
  const todayKey = shown[shown.length - 1]?.key ?? "";
  const firstKey = shown[0]?.key ?? "";
  const midKey = shown[Math.floor(shown.length / 2)]?.key ?? "";
  const activeDays = shown.filter((d) => d.seconds > 0).length;
  const edgeThreshold = shown.length > 20 ? 6 : 3;

  const bars = shown
    .map((day, idx) => {
      const isToday = day.key === todayKey;
      const isActive = day.seconds > 0;
      const height = isActive ? Math.max(10, Math.round((day.seconds / max) * 100)) : 5;
      const [year, month, date] = day.key.split("-");
      const label = isToday ? `${t("profile.activityToday")} (${date}.${month}.${year})` : `${date}.${month}.${year}`;
      const cls = [
        "play-bar",
        isActive ? "is-active" : "is-empty",
        isToday ? "is-today" : "",
      ].filter(Boolean).join(" ");
      const edgeCls =
        idx < edgeThreshold
          ? " is-edge-left"
          : idx >= shown.length - edgeThreshold
            ? " is-edge-right"
            : " is-center";
      const popover = renderDayPopover(day, isToday);
      return `<span class="play-bar-slot${edgeCls}" tabindex="0" role="button" aria-label="${esc(`${label} · ${fmtPlaytime(day.seconds)}`)}">
        <span class="${cls}" style="height:${height}%;--bar-i:${idx}"></span>
        ${popover}
      </span>`;
    })
    .join("");

  return `
    <div class="play-chart-head-row">
      <span class="play-chart-head">${esc(t("profile.activityChartTitle"))}</span>
      <span class="play-chart-meta tabular-nums">${activeDays} / ${shown.length}</span>
    </div>
    <div class="play-chart${range === "30d" ? " is-30d" : ""}" role="img" aria-label="${esc(t("profile.activityChartTitle"))}">${bars}</div>
    <div class="play-chart-axis tabular-nums" aria-hidden="true">
      <span>${esc(fmtShortDay(firstKey))}</span>
      <span>${esc(fmtShortDay(midKey))}</span>
      <span class="is-today">${esc(t("profile.activityToday"))}</span>
    </div>`;
}

function renderTop(data: PlayActivityData, range: "7d" | "30d"): string {
  const useMonth = range === "30d" || data.topWeek.length === 0;
  const list = useMonth ? data.topMonth : data.topWeek;
  if (list.length === 0) return "";
  const heading = useMonth ? t("profile.activityTopMonth") : t("profile.activityTopWeek");
  const max = Math.max(1, ...list.map((row) => row.seconds));
  const rows = list
    .map((row, idx) => {
      const width = Math.max(4, Math.round((row.seconds / max) * 100));
      const art = row.cover
        ? `<img class="play-top-art"${topSteamArtAttrs(row.appName)} src="${esc(row.cover)}" alt="" loading="lazy" decoding="async" />`
        : `<span class="play-top-art placeholder">${icon("gamepad-2", 14)}</span>`;
      return `<button type="button" class="play-top-row" data-act="open-game-from-profile" data-id="${esc(row.appName)}" title="${esc(`${row.title} · ${fmtPlaytime(row.seconds)}`)}">
        <span class="play-top-rank tabular-nums">${idx + 1}</span>
        ${art}
        <span class="play-top-main">
          <span class="play-top-line">
            <span class="play-top-name">${esc(row.title)}</span>
            <span class="play-top-time tabular-nums">${esc(fmtPlaytime(row.seconds))}</span>
          </span>
          <span class="play-top-track"><span style="width:${width}%"></span></span>
        </span>
      </button>`;
    })
    .join("");
  return `<div class="play-top">
    <div class="play-top-head">${esc(heading)}</div>
    <div class="play-top-list">${rows}</div>
  </div>`;
}

/**
 * The activity card for the profile page. Returns an empty string when the
 * scope has no playtime at all, so a fresh profile never gains a blank panel.
 */
export function renderPlayActivity(scope: "all" | GameSource): string {
  const data = playActivityFor(scope);
  if (!data.hasSessions && data.trackedGames === 0) return "";
  const range = S.profileActivityRange || "7d";
  const rangeToggle = data.hasSessions
    ? `<div class="seg play-range-seg" role="group" aria-label="${esc(t("profile.activityTitle"))}">
        <button type="button" class="${range === "7d" ? "active" : ""}" data-act="profile-activity-range" data-val="7d" aria-pressed="${range === "7d"}">${esc(t("profile.activityRange7d"))}</button>
        <button type="button" class="${range === "30d" ? "active" : ""}" data-act="profile-activity-range" data-val="30d" aria-pressed="${range === "30d"}">${esc(t("profile.activityRange30d"))}</button>
      </div>`
    : "";
  const topHtml = data.hasSessions ? renderTop(data, range) : "";
  const body = data.hasSessions
    ? `<div class="play-activity-card${topHtml ? "" : " is-single"}">
        <div class="play-activity-left">
          <div class="play-summary">
            ${stat(t("profile.activityToday"), data.today)}
            ${stat(t("profile.activityWeek"), data.last7, range === "7d", deltaHtml(data))}
            ${stat(t("profile.activityMonth"), data.last30, range === "30d")}
          </div>
          <div class="play-chart-wrap">
            ${renderChart(data, range)}
          </div>
        </div>
        ${topHtml}
      </div>`
    : `<div class="play-activity-card is-new">
        <p class="play-empty-copy">${esc(t("profile.activityNoSessions"))}</p>
      </div>`;
  return `
    <section class="profile-row play-activity">
      <div class="profile-row-head">
        <div class="profile-row-title-group">
          <h3 class="profile-row-title">${esc(t("profile.activityTitle"))}</h3>
        </div>
        ${rangeToggle}
      </div>
      ${body}
    </section>`;
}

/**
 * Small, shared Stage markup pieces.
 *
 * These helpers never read the DOM and never schedule a render; they only turn
 * state into a string so the route modules stay focused on their own layout.
 */

import { psShapeFor, psShapeSvg } from "../../core/controller-glyphs";
import { epicDlProgress } from "../../core/game-view";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import type { ControllerKind, GameSource } from "../../core/types";
import { esc, fmtBytes, fmtPlaytime, relativeTime } from "../../core/utils";
import { gameStoresLabel, libraryPlaytime, sourceOfKey } from "../../core/selectors";
import { t } from "../../i18n";
import type { EpicSummary } from "../../epic";

/** Face-button glyph for the connected pad. */
export function stageFaceGlyph(button: "a" | "b" | "x" | "y"): string {
  const kind = S.gamepadKind;
  if (kind === "playstation") {
    return `<span class="stage-glyph stage-glyph-face ps-${psShapeFor(button)}">${psShapeSvg(button, 12)}</span>`;
  }
  return `<span class="stage-glyph stage-glyph-${button}">${button.toUpperCase()}</span>`;
}

/** Shoulder-button glyph for the connected pad. */
export function stageBumperGlyphs(): string {
  const kind = S.gamepadKind;
  const [left, right] =
    kind === "playstation"
      ? ["L1", "R1"]
      : kind === "switch"
        ? ["L", "R"]
        : ["LB", "RB"];
  return `<span class="stage-glyph stage-glyph-bumper">${left}</span><span class="stage-glyph stage-glyph-bumper">${right}</span>`;
}

/** Trigger-button glyph for the connected pad (L2/R2, LT/RT, ZL/ZR). */
export function stageTriggerGlyphs(): string {
  const kind = S.gamepadKind;
  const [left, right] =
    kind === "playstation"
      ? ["L2", "R2"]
      : kind === "switch"
        ? ["ZL", "ZR"]
        : ["LT", "RT"];
  return `<span class="stage-glyph stage-glyph-bumper">${left}</span><span class="stage-glyph stage-glyph-bumper">${right}</span>`;
}

/** Menu / Start / Options button glyph for the connected pad. */
export function stageMenuGlyph(): string {
  const kind = S.gamepadKind;
  let label = "Menu";
  if (kind === "playstation") label = "Options";
  else if (kind === "switch") label = "+";
  else if (kind === "steamdeck") label = "Menu";
  else if (kind === "generic") label = "Start";
  return `<span class="stage-glyph stage-glyph-aux">${label}</span>`;
}

/** View / Select / Touchpad / Back button glyph for the connected pad. */
export function stageViewGlyph(): string {
  const kind = S.gamepadKind;
  let label = "View";
  if (kind === "playstation") label = "Touchpad";
  else if (kind === "switch") label = "−";
  else if (kind === "steamdeck") label = "View";
  else if (kind === "generic") label = "Select";
  return `<span class="stage-glyph stage-glyph-aux">${label}</span>`;
}

/** Keyboard keycap glyph. */
export function stageKeyGlyph(key: string): string {
  return `<span class="stage-glyph stage-glyph-kbd">${esc(key)}</span>`;
}

export function stageHint(glyph: string, label: string): string {
  return `<span class="stage-hint"><span class="stage-hint-glyph">${glyph}</span><span>${esc(label)}</span></span>`;
}

export function stageHintBar(items: string[]): string {
  return `<div class="stage-hints" aria-hidden="true">${items.join("")}</div>`;
}

/** Store wording used in the side stage and the program meta line. */
export function stageStoreName(source: GameSource): string {
  switch (source) {
    case "epic": return t("source.epic");
    case "gog": return t("source.gog");
    case "steam": return t("source.steam");
    case "amazon": return "Amazon Games";
    case "ea": return "EA App";
    case "ubisoft": return "Ubisoft Connect";
    case "xbox": return "Xbox";
    case "battlenet": return "Battle.net";
    case "riot": return "Riot Games";
    case "custom": return t("customGames.storeLabel");
  }
}

export function stageKindName(kind: ControllerKind): string {
  switch (kind) {
    case "playstation": return t("controller.kindPlaystation");
    case "xbox": return t("controller.kindXbox");
    case "switch": return t("controller.kindSwitch");
    case "steamdeck": return t("controller.kindSteamDeck");
    default: return t("controller.kindGeneric");
  }
}

export interface StageMetaOptions {
  /** Hide the store name when the caller already shows it elsewhere. */
  withStore?: boolean;
  /** Include the install size even when the game is not installed. */
  withSize?: boolean;
}

/** "Epic Games · 42 h · 2 h ago" — the one meta line used everywhere. */
export function stageMetaLine(s: EpicSummary, opts: StageMetaOptions = {}): string {
  const parts: string[] = [];
  if (opts.withStore !== false) {
    const source = sourceOfKey(s.appName);
    const label = gameStoresLabel(s.appName);
    parts.push(
      source === "custom"
        ? t("customGames.storeLabel")
        : label === "Epic" && source !== "epic"
          ? stageStoreName(source)
          : label,
    );
  }
  const size = s.installSize > 0 ? fmtBytes(s.installSize) : "";
  if (size && (s.installed || opts.withSize)) parts.push(size);
  if (!s.installed) parts.push(t("stage.notInstalled"));
  const play = stagePlaytime(s);
  if (play.seconds > 0) parts.push(fmtPlaytime(play.seconds));
  const last = play.lastPlayed > 946684800 ? relativeTime(play.lastPlayed * 1000) : "";
  if (last) parts.push(last);
  return parts.filter(Boolean).map((part) => esc(part)).join(`<span class="stage-dot">·</span>`);
}

/** Playtime across the copies of a title, matching the desktop card. */
export function stagePlaytime(s: EpicSummary): { seconds: number; lastPlayed: number } {
  return libraryPlaytime(s);
}

/**
 * The shared game facts: install state, size, playtime and the last session.
 * The programme hero and the library side stage both read this so the chips
 * never drift apart.
 */
export function stageGameFactChips(s: EpicSummary): string {
  const play = stagePlaytime(s);
  const size = s.installSize > 0 ? fmtBytes(s.installSize) : "";
  const last = play.lastPlayed > 946684800 ? relativeTime(play.lastPlayed * 1000) : "";
  return `<span class="stage-stat"><i class="${s.installed ? "is-ready" : "is-off"}" aria-hidden="true"></i><span>${esc(s.installed ? t("stage.installed") : t("stage.notInstalled"))}</span></span>
    ${size ? `<span class="stage-stat">${icon("package", 13)}<b class="tabular-nums">${esc(size)}</b></span>` : ""}
    ${play.seconds > 0 ? `<span class="stage-stat">${icon("clock", 13)}<b class="tabular-nums">${esc(fmtPlaytime(play.seconds))}</b></span>` : ""}
    ${last ? `<span class="stage-stat">${icon("calendar", 13)}<span>${esc(last)}</span></span>` : ""}`;
}

/** Status dot + word; colour never carries the meaning alone. */
export function stageStatus(s: EpicSummary): string {
  if (S.runningGames.has(s.appName)) {
    return `<span class="stage-status is-running"><span class="stage-status-dot"></span>${esc(t("stage.running"))}</span>`;
  }
  const download = epicDlProgress(s.appName);
  if (download !== null) {
    return `<span class="stage-status is-updating"><span class="stage-status-dot"></span>${esc(t("stage.downloading", { p: Math.round(download) }))}</span>`;
  }
  if (s.updateAvailable && !S.ignoredUpdates.has(s.appName)) {
    return `<span class="stage-status is-updating"><span class="stage-status-dot"></span>${esc(t("common.update"))}</span>`;
  }
  if (s.installed) {
    return `<span class="stage-status is-installed"><span class="stage-status-dot"></span>${esc(t("stage.installed"))}</span>`;
  }
  return `<span class="stage-status is-muted"><span class="stage-status-dot"></span>${esc(t("stage.notInstalled"))}</span>`;
}

/** Horizontal progress track used by downloads and achievements. */
export function stageProgress(percent: number, className = "", attrs = ""): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return `<span class="stage-progress ${className}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clamped}"${attrs ? ` ${attrs}` : ""}><span style="width:${clamped}%"></span></span>`;
}

/** The active download, if any, for the status bar and Home. */
export function stageActiveDownload(): { title: string; percent: number; speed: string } | null {
  const metrics = S.activeDlMetrics;
  if (metrics && !metrics.done) {
    return {
      title: metrics.title,
      percent: Math.max(0, Math.min(100, metrics.progress)),
      speed: metrics.speed,
    };
  }
  for (const [id, item] of S.downloads) {
    if (item.done) continue;
    const title = item.title || id;
    return { title, percent: Math.max(0, Math.min(100, item.progress)), speed: "" };
  }
  return null;
}

/** Controller battery is optional; render nothing when the browser hides it. */
export function stageBatteryLabel(): string {
  const level = S.stage.controllerBattery;
  if (level === null || !Number.isFinite(level)) return "";
  return t("stage.battery", { p: Math.round(level * 100) });
}

/**
 * Controller status chip: the connection dot, the pad name and its battery.
 * Shared by the quick menu head and the idle screen so both report the same
 * thing in the same shape.
 */
export function stageControllerChip(): string {
  const connected = S.stage.controllerConnected;
  const battery = S.stage.controllerBattery;
  const percent = battery !== null && Number.isFinite(battery) ? Math.round(battery * 100) : null;
  const name = connected ? (S.stage.controllerName || t("stage.controller")) : t("stage.noController");
  return `<span class="stage-stat">${icon("gamepad-2", 13)}<i class="${connected ? "is-ready" : "is-off"}" aria-hidden="true"></i><span>${esc(name)}</span>${connected && percent !== null ? `<b class="tabular-nums">${percent}%</b>` : ""}</span>`;
}

/** Strip raw store HTML tags so synopses read cleanly on Home, Library and Programme. */
export function stageStripHtml(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Release year and top genre pills for hero and preview headers. */
export function stageGenreChips(s: EpicSummary, maxGenres = 2): string {
  const parts: string[] = [];
  if (s.releaseYear && s.releaseYear > 1970) {
    parts.push(`<span class="stage-meta-pill tabular-nums">${s.releaseYear}</span>`);
  }
  const genres = (s.genres ?? []).filter(Boolean).slice(0, maxGenres);
  for (const g of genres) {
    parts.push(`<span class="stage-meta-pill">${esc(g)}</span>`);
  }
  return parts.join("");
}

/** Critic score pill when already cached for this title. */
export function stageCriticChip(s: EpicSummary): string {
  const critic = S.loadedCritic.get(s.appName);
  const score = critic?.metacritic_score || critic?.opencritic_score;
  if (!score || score <= 0) return "";
  const tone = score >= 75 ? "is-good" : score >= 50 ? "is-avg" : "is-bad";
  return `<span class="stage-critic-pill ${tone} tabular-nums" title="Metacritic / OpenCritic">${icon("star", 11)}<b>${score}</b></span>`;
}




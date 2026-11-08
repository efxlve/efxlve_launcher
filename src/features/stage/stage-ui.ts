/**
 * Small, shared Stage markup pieces.
 *
 * These helpers never read the DOM and never schedule a render; they only turn
 * state into a string so the route modules stay focused on their own layout.
 */

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
    const shapes = { a: "x", b: "circle", x: "square", y: "triangle" } as const;
    return `<span class="stage-glyph stage-glyph-${button}">${icon(shapes[button], 12)}</span>`;
  }
  return `<span class="stage-glyph stage-glyph-${button}">${button.toUpperCase()}</span>`;
}

/** Shoulder-button glyph for the connected pad. */
export function stageBumperGlyphs(): string {
  const [left, right] = S.gamepadKind === "xbox" || S.gamepadKind === "generic" ? ["LB", "RB"] : ["L1", "R1"];
  return `<span class="stage-glyph stage-glyph-bumper">${left}</span><span class="stage-glyph stage-glyph-bumper">${right}</span>`;
}

export function stageHint(glyph: string, label: string): string {
  return `<span class="stage-hint"><span class="stage-hint-glyph">${glyph}</span><span>${esc(label)}</span></span>`;
}

export function stageHintBar(items: string[]): string {
  return `<div class="stage-hints" aria-hidden="true">${items.join("")}</div>`;
}

export function stageSectionLabel(label: string, action = ""): string {
  return `<div class="stage-row-head">
    <h2 class="stage-row-title">${esc(label)}</h2>
    ${action ? `<span class="stage-row-action">${action}</span>` : ""}
  </div>`;
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
  const last = play.lastPlayed > 946684800000 ? relativeTime(play.lastPlayed) : "";
  if (last) parts.push(last);
  return parts.filter(Boolean).map((part) => esc(part)).join(`<span class="stage-dot">·</span>`);
}

/** Playtime across the copies of a title, matching the desktop card. */
export function stagePlaytime(s: EpicSummary): { seconds: number; lastPlayed: number } {
  return libraryPlaytime(s);
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

/** Small text chip for a shelf card. */
export function stageChip(text: string, tone: "ok" | "warn" | "" = ""): string {
  return `<span class="stage-chip${tone ? ` is-${tone}` : ""}">${esc(text)}</span>`;
}

/** Horizontal progress track used by downloads and achievements. */
export function stageProgress(percent: number, className = ""): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return `<span class="stage-progress ${className}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clamped}"><span style="width:${clamped}%"></span></span>`;
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



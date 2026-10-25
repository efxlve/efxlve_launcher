/**
 * Game-level PowerPyx roadmap strip.
 *
 * One line, not a card: the achievements list is the subject and this is a
 * secondary reference. The full roadmap text stays in the tooltip and on the
 * site; only the facts that fit on one row are shown.
 */

import { icon } from "../../core/icons";
import { esc, stripEmoji } from "../../core/utils";
import type { PowerPyxGuide } from "../../guides";
import { t } from "../../i18n";

function short(value: string, max = 34): string {
  const text = stripEmoji(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** PowerPyx writes hours in English; the rail should use the reader's unit. */
function localizedTime(value: string): string {
  const match = value.match(/(\d+)(?:\s*[–-]\s*(\d+))?\+?\s*hours?/i);
  if (!match) return short(value, 18);
  const unit = t("common.hoursShort");
  if (match[2]) return `${match[1]}–${match[2]} ${unit}`;
  return `${match[1]}${value.includes("+") ? "+" : ""} ${unit}`;
}

export function renderPowerPyxCard(guide: PowerPyxGuide | undefined): string {
  if (!guide?.supported || !guide.url) return "";
  const difficulty = guide.difficulty.match(/^\d+\s*\/\s*\d+/)?.[0] ??
    stripEmoji(guide.difficulty).split(",")[0].trim();
  const missables = stripEmoji(guide.missables).trim();
  const missableValue = missables.toLowerCase().startsWith("no")
    ? t("ach.powerpyxNone")
    : missables.match(/\d+/)?.[0] ?? short(missables, 22);
  const facts = [
    difficulty ? `${t("ach.powerpyxDifficulty")} ${short(difficulty, 24)}` : "",
    guide.time ? `${t("ach.powerpyxTime")} ${localizedTime(guide.time)}` : "",
    missables ? `${t("ach.powerpyxMissables")} ${missableValue}` : "",
  ].filter(Boolean);
  const tooltip = stripEmoji([guide.title, guide.difficulty, guide.time, guide.missables]
    .filter(Boolean)
    .join(" · "));

  return `<button type="button" class="ach-side-guide-row ach-powerpyx-row" data-act="ach-guide" data-url="${esc(guide.url)}" title="${esc(tooltip)}">
    <span class="ach-side-guide-icon">${icon("external", 14)}</span>
    <span class="ach-side-guide-main">
      <span class="ach-side-guide-title">PowerPyx</span>
      ${facts.length > 0 ? `<span class="ach-side-guide-meta">${facts.map((fact) => esc(fact)).join(" · ")}</span>` : ""}
    </span>
    <span class="ach-side-guide-arrow">${icon("chevron-right", 13)}</span>
  </button>`;
}

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

export function renderPowerPyxCard(guide: PowerPyxGuide | undefined): string {
  if (!guide?.supported || !guide.url) return "";
  const difficulty = guide.difficulty.match(/^\d+\s*\/\s*\d+/)?.[0] ??
    stripEmoji(guide.difficulty).split(",")[0].trim();
  const missables = stripEmoji(guide.missables).split(",")[0].trim();
  const facts = [
    difficulty ? `${t("ach.powerpyxDifficulty")} ${short(difficulty, 24)}` : "",
    guide.time ? `${t("ach.powerpyxTime")} ${short(guide.time, 18)}` : "",
    missables
      ? `${t("ach.powerpyxMissables")} ${missables.toLowerCase().startsWith("no") ? t("ach.powerpyxNone") : short(missables, 22)}`
      : "",
  ].filter(Boolean);
  const tooltip = stripEmoji([guide.title, guide.difficulty, guide.time, guide.missables]
    .filter(Boolean)
    .join(" · "));

  return `<div class="ach-powerpyx" title="${esc(tooltip)}">
    <span class="ach-powerpyx-title">${icon("external", 12)} <span>PowerPyx</span></span>
    ${facts.length > 0 ? `<span class="ach-powerpyx-facts">${facts.map((fact) => esc(fact)).join(" · ")}</span>` : ""}
    <button type="button" class="btn ghost small" data-act="ach-guide" data-url="${esc(guide.url)}">
      ${esc(t("ach.powerpyxOpen"))}
    </button>
  </div>`;
}

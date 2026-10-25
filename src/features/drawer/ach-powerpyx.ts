/**
 * Game-level PowerPyx roadmap card.
 *
 * This is deliberately small: difficulty, completion time, missable count and
 * a link. It is not a second guide reader; the guide itself opens in the
 * browser. A game without a matching guide renders nothing.
 */

import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import type { PowerPyxGuide } from "../../guides";
import { t } from "../../i18n";

export function renderPowerPyxCard(guide: PowerPyxGuide | undefined): string {
  if (!guide?.supported || !guide.url) return "";
  const facts = [
    guide.difficulty ? `${t("ach.powerpyxDifficulty")}: ${guide.difficulty}` : "",
    guide.time ? `${t("ach.powerpyxTime")}: ${guide.time}` : "",
    guide.missables ? `${t("ach.powerpyxMissables")}: ${guide.missables}` : "",
  ].filter(Boolean);

  return `<div class="ach-powerpyx">
    <div class="ach-powerpyx-head">
      <span class="ach-powerpyx-title">${icon("external", 12)} <span>PowerPyx</span></span>
      <button type="button" class="btn ghost small" data-act="ach-guide" data-url="${esc(guide.url)}" title="${esc(guide.title || t("ach.powerpyxOpen"))}">
        ${esc(t("ach.powerpyxOpen"))}
      </button>
    </div>
    ${
      facts.length > 0
        ? `<div class="ach-powerpyx-facts">${facts.map((fact) => `<span>${esc(fact)}</span>`).join("")}</div>`
        : ""
    }
  </div>`;
}

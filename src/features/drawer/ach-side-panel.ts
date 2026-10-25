/**
 * The achievements workspace's right rail.
 *
 * After the redesign the list already answers "what next"; the rail is only
 * the guide launcher. Keeping it to one card and one row per source makes the
 * tab calmer and leaves the detail rail free for the selected achievement.
 */

import { achievementGuideLinks } from "../../core/achievements";
import { icon, type IconName } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import type { EpicAchievementsData, EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { sourceOfKey } from "../../core/selectors";
import { renderPowerPyxCard } from "./ach-powerpyx";

export interface AchSidePanelInput {
  summary: EpicSummary;
  data: EpicAchievementsData;
  steamAppId: string | null;
}

function guideRow(url: string | undefined, label: string, glyph: IconName): string {
  if (!url) return "";
  return `<button type="button" class="ach-side-guide-row" data-act="ach-guide" data-url="${esc(url)}">
    <span class="ach-side-guide-icon">${icon(glyph, 14)}</span>
    <span class="ach-side-guide-title">${esc(label)}</span>
    <span class="ach-side-guide-arrow">${icon("chevron-right", 13)}</span>
  </button>`;
}

export function renderAchSidePanel(input: AchSidePanelInput): string {
  const { summary, steamAppId } = input;
  const links = achievementGuideLinks({
    title: summary.title,
    achievement: "",
    store: sourceOfKey(summary.appName),
    steamAppId,
  });
  const rows = [
    guideRow(links.video, t("ach.guideVideo"), "youtube"),
    guideRow(links.steamGuides, t("ach.guideSteamGuides"), "link"),
    guideRow(links.steamDiscussions, t("ach.guideSteamDiscussions"), "users"),
    guideRow(links.trueSteamAchievements, t("ach.guideTrueSteam"), "external"),
    guideRow(links.trueAchievements, t("ach.guideTrueAchievements"), "external"),
    guideRow(links.web, t("ach.guideWeb"), "globe"),
  ]
    .filter(Boolean)
    .join("");

  return `<div class="ach-side">
    <section class="ach-side-card">
      <div class="ach-side-head">
        <span class="ach-side-title">${icon("link", 13)} ${esc(t("ach.guidesTitle"))}</span>
      </div>
      <div class="ach-side-guide-list">
        <div id="ach-powerpyx-host">${renderPowerPyxCard(S.powerpyxGuides.get(summary.appName))}</div>
        ${rows}
      </div>
    </section>
  </div>`;
}

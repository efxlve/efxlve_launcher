/**
 * The default right-hand rail of the achievements workspace.
 *
 * It answers the two questions the list alone cannot: what should I chase next,
 * and where do I read about it. The rail becomes the achievement detail when a
 * row is selected, so the list never loses its context.
 */

import {
  achievementGuideLinks,
  achievementProgress,
  achievementRarity,
  isAchievementUnlocked,
  nextAchievements,
} from "../../core/achievements";
import { icon, type IconName } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtDecimal1 } from "../../core/utils";
import type { EpicAchievementsData, EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { sourceOfKey } from "../../core/selectors";
import { renderPowerPyxCard } from "./ach-powerpyx";

export interface AchSidePanelInput {
  summary: EpicSummary;
  data: EpicAchievementsData;
  steamAppId: string | null;
}

function guideButton(url: string | undefined, label: string, glyph: IconName): string {
  if (!url) return "";
  return `<button type="button" class="btn ghost small ach-side-guide" data-act="ach-guide" data-url="${esc(url)}" title="${esc(label)}">${icon(glyph, 12)}<span>${esc(label)}</span></button>`;
}

export function renderAchSidePanel(input: AchSidePanelInput): string {
  const { summary, data, steamAppId } = input;
  const recommended = nextAchievements(data.achievements, 3);
  const next = recommended.length > 0
    ? recommended
    : data.achievements
        .filter((item) => !isAchievementUnlocked(item) && !item.hidden)
        .slice(0, 3);
  const links = achievementGuideLinks({
    title: summary.title,
    achievement: "",
    store: sourceOfKey(summary.appName),
    steamAppId,
  });
  const complete = Boolean(data.is_platinum) ||
    (data.total_achievements > 0 && data.user_unlocked >= data.total_achievements);

  const nextRows = next
    .map((item) => {
      const rarity = achievementRarity(item);
      const progress = achievementProgress(item);
      const meta = [
        rarity != null ? `%${fmtDecimal1(rarity)}` : "",
        progress > 0 ? `${Math.round(progress * 100)}%` : "",
      ].filter(Boolean).join(" · ");
      return `<button type="button" class="ach-side-next" data-act="ach-open" data-ach="${esc(item.name)}">
        ${item.icon_link ? `<img src="${esc(item.icon_link)}" alt="" loading="lazy" />` : `<span class="ach-side-next-ph">${icon("trophy", 16)}</span>`}
        <span class="ach-side-next-main">
          <span class="ach-side-next-title">${esc(item.display_name || item.name)}</span>
          ${meta ? `<span class="ach-side-next-meta tabular-nums">${esc(meta)}</span>` : ""}
        </span>
        <span class="ach-side-chevron">${icon("chevron-right", 13)}</span>
      </button>`;
    })
    .join("");

  const guideButtons = [
    guideButton(links.video, t("ach.guideVideo"), "youtube"),
    guideButton(links.steamGuides, t("ach.guideSteamGuides"), "link"),
    guideButton(links.steamDiscussions, t("ach.guideSteamDiscussions"), "users"),
    guideButton(links.trueSteamAchievements, t("ach.guideTrueSteam"), "external"),
    guideButton(links.trueAchievements, t("ach.guideTrueAchievements"), "external"),
    guideButton(links.web, t("ach.guideWeb"), "globe"),
  ].filter(Boolean).join("");

  return `<div class="ach-side">
    <section class="ach-side-card">
      <div class="ach-side-head">
        <span class="ach-side-title">${icon("trophy", 13)} ${esc(t("drawer.nextAchievements"))}</span>
      </div>
      ${
        nextRows
          ? `<div class="ach-side-next-list">${nextRows}</div>`
          : `<div class="ach-side-empty">${esc(complete ? t("ach.platinumComplete") : t("ach.sideNoNext"))}</div>`
      }
    </section>

    <section class="ach-side-card">
      <div class="ach-side-head">
        <span class="ach-side-title">${icon("link", 13)} ${esc(t("ach.guidesTitle"))}</span>
      </div>
      <div id="ach-powerpyx-host">${renderPowerPyxCard(S.powerpyxGuides.get(summary.appName))}</div>
      <div class="ach-side-guides">${guideButtons}</div>
    </section>
  </div>`;
}

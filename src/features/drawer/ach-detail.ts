/**
 * One achievement, opened from the game page's achievements tab.
 *
 * The list stays the owner of filtering and sorting; this view only renders the
 * selected item, its store facts, and the guide launchpad. It talks to the DOM
 * exclusively through `data-act` so the single click router and the keyboard
 * activation in input-listeners keep working.
 */

import {
  achievementGuideLinks,
  achievementProgress,
  achievementRarity,
  achievementTier,
  achievementTierKnown,
  isAchievementUnlocked,
  rarityMultiplier,
} from "../../core/achievements";
import { icon, type IconName } from "../../core/icons";
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtAchDate, fmtDecimal1 } from "../../core/utils";
import type { EpicAchievementItem, EpicAchievementsData, EpicSummary } from "../../epic";
import { t } from "../../i18n";

export interface AchievementDetailInput {
  summary: EpicSummary;
  data: EpicAchievementsData;
  item: EpicAchievementItem;
  steamAppId: string | null;
}

function tierName(tier: "platinum" | "gold" | "silver" | "bronze"): string {
  if (tier === "platinum") return t("trophy.plat");
  if (tier === "gold") return t("trophy.gold");
  if (tier === "silver") return t("trophy.silver");
  return t("trophy.bronze");
}

function guideButton(
  url: string | undefined,
  label: string,
  glyph: IconName,
): string {
  if (!url) return "";
  return `<button type="button" class="btn ghost small ach-guide-btn" data-act="ach-guide" data-url="${esc(url)}" title="${esc(label)}">${icon(glyph, 13)}<span>${esc(label)}</span></button>`;
}

export function renderAchievementDetail(input: AchievementDetailInput): string {
  const { summary, item, steamAppId } = input;
  const isDemo = S.demoPlatinumApps.has(summary.appName);
  const isUnlocked = isAchievementUnlocked(item) || isDemo;
  const isSecret = item.hidden && !isUnlocked;
  const revealed = S.revealedAchievements.has(`${summary.appName}:${item.name}`);
  const masked = isSecret && !revealed;
  const progress = achievementProgress(item);
  const rarity = achievementRarity(item);
  const multiplier = rarityMultiplier(item);
  const tier = achievementTier(item) ?? "bronze";
  const tierKnown = achievementTierKnown(item);
  const xp = Number(item.xp) || 0;
  const title = masked ? t("ach.hiddenName") : item.display_name || item.name;
  const description = masked
    ? t("ach.hiddenDesc")
    : item.description || t("ach.noDesc");
  const links = achievementGuideLinks({
    title: summary.title,
    achievement: item.display_name || item.name,
    store: sourceOfKey(summary.appName),
    steamAppId,
  });

  const date = item.unlock_date && isUnlocked ? fmtAchDate(item.unlock_date) : "";
  const meta = [
    tierKnown
      ? `<span class="ach-pill tier ${tier}">${icon("trophy", 11)} ${esc(tierName(tier))}</span>`
      : "",
    rarity != null
      ? `<span class="ach-pill${rarity < 10 ? " rarity ultra-rare" : ""}">${icon("sparkles", 10)} ${esc(t("ach.detailRarity", { n: fmtDecimal1(rarity) }))}</span>`
      : "",
    multiplier != null
      ? `<span class="ach-pill">${esc(t("ach.detailMultiplier", { n: fmtDecimal1(multiplier) }))}</span>`
      : "",
    xp > 0 ? `<span class="ach-pill">+${xp} XP</span>` : "",
    !item.is_base ? `<span class="ach-pill dlc">${icon("package", 9)} DLC</span>` : "",
    item.hidden && !masked ? `<span class="ach-pill secret">${icon("lock", 9)} ${esc(t("ach.secret"))}</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  const guideButtons = [
    guideButton(links.video, t("ach.guideVideo"), "youtube"),
    guideButton(links.steamGuides, t("ach.guideSteamGuides"), "link"),
    guideButton(links.steamDiscussions, t("ach.guideSteamDiscussions"), "users"),
    guideButton(links.trueSteamAchievements, t("ach.guideTrueSteam"), "external"),
    guideButton(links.trueAchievements, t("ach.guideTrueAchievements"), "external"),
    guideButton(links.web, t("ach.guideWeb"), "globe"),
  ]
    .filter(Boolean)
    .join("");

  const status = isUnlocked
    ? `<span class="ach-detail-state is-earned">${icon("check", 13)} <span>${esc(t("ach.earned"))}</span></span>${date ? `<span class="ach-pill date">${esc(date)}</span>` : ""}`
    : `<span class="ach-detail-state is-locked">${icon("lock", 12)} <span>${esc(t("ach.locked"))}</span></span>`;

  return `
    <div class="ach-detail">
      <button type="button" class="btn ghost small ach-detail-back" data-act="ach-back">
        ${icon("arrow-left", 13)}<span>${esc(t("common.back"))}</span>
      </button>

      <section class="ach-detail-hero">
        <div class="ach-detail-art ${masked ? "is-masked" : ""}">
          ${
            masked
              ? `<div class="ach-mystery-box">${icon("lock", 28)}</div>`
              : item.icon_link
                ? `<img src="${esc(item.icon_link)}" alt="" loading="eager" />`
                : `<div class="ach-fallback-icon ${tier}">${icon("trophy", 30)}</div>`
          }
        </div>
        <div class="ach-detail-main">
          <div class="ach-detail-eyebrow">${masked ? icon("lock", 12) + " " : ""}${esc(summary.title)}</div>
          <h2 class="ach-detail-name">${esc(title)}</h2>
          <p class="ach-detail-desc">${esc(description)}</p>
          ${meta ? `<div class="ach-detail-meta">${meta}</div>` : ""}
        </div>
      </section>

      <section class="ach-detail-status">
        ${status}
        ${
          !isUnlocked && progress > 0
            ? `<div class="ach-detail-progress">
                 <div class="progress"><span style="width:${Math.round(progress * 100)}%"></span></div>
                 <span class="ach-detail-progress-label tabular-nums">${esc(t("ach.detailProgress", { n: Math.round(progress * 100) }))}</span>
               </div>`
            : ""
        }
      </section>

      ${
        isSecret
          ? `<section class="ach-detail-spoiler">
               <div class="ach-detail-spoiler-icon">${icon(revealed ? "eye-off" : "eye", 17)}</div>
               <div class="ach-detail-spoiler-body">
                 <div class="ach-detail-spoiler-title">${esc(masked ? t("ach.detailSpoiler") : t("ach.hideSpoiler"))}</div>
                 <button type="button" class="btn ghost small" data-act="ach-reveal" data-id="${esc(summary.appName)}" data-ach="${esc(item.name)}">
                   ${icon(revealed ? "eye-off" : "eye", 12)}<span>${esc(revealed ? t("ach.hide") : t("ach.showSpoiler"))}</span>
                 </button>
               </div>
             </section>`
          : ""
      }

      ${
        masked
          ? ""
          : `<section class="ach-detail-guides">
               <div class="ach-detail-guides-head">
                 <h3 class="ach-detail-heading">${icon("link", 13)} <span>${esc(t("ach.detailHowTo"))}</span></h3>
                 <span class="ach-detail-hint">${esc(t("ach.detailGuideHint"))}</span>
               </div>
               <div class="ach-guide-grid">${guideButtons}</div>
             </section>`
      }
    </div>`;
}

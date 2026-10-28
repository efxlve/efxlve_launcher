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
import { achievementGuides, achievementNote } from "./ach-notes";
import { renderAchievementEditBar } from "./ach-editor";
import { isAchievementPinned } from "../../core/achievement-pins";
import { icon, type IconName } from "../../core/icons";
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtAchDate, fmtDecimal1, stripEmoji } from "../../core/utils";
import type { EpicAchievementItem, EpicAchievementsData, EpicSummary } from "../../epic";
import { t } from "../../i18n";
import type { SteamAchievementCommunity } from "../../steam";

export interface AchievementDetailNeighbour {
  name: string;
  title: string;
}

export interface AchievementDetailPosition {
  index: number;
  total: number;
  prev?: AchievementDetailNeighbour;
  next?: AchievementDetailNeighbour;
}

export interface AchievementDetailInput {
  summary: EpicSummary;
  data: EpicAchievementsData;
  item: EpicAchievementItem;
  steamAppId: string | null;
  community?: SteamAchievementCommunity | null;
  communityLoading?: boolean;
  /** Where the item sits in the list that is on screen, for the rail's stepper. */
  position?: AchievementDetailPosition;
}

function tierName(tier: "platinum" | "gold" | "silver" | "bronze"): string {
  if (tier === "platinum") return t("trophy.plat");
  if (tier === "gold") return t("trophy.gold");
  if (tier === "silver") return t("trophy.silver");
  return t("trophy.bronze");
}

function guideHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function linkGlyph(url: string): IconName {
  const host = guideHost(url).toLowerCase();
  if (host.includes("youtube.") || host === "youtu.be") return "youtube";
  if (host.includes("steamcommunity.")) return "link";
  return "globe";
}

function guideButton(
  url: string | undefined,
  label: string,
  glyph: IconName,
  fullLabel = label,
): string {
  if (!url) return "";
  return `<button type="button" class="ach-guide-btn" data-act="ach-guide" data-url="${esc(url)}" title="${esc(fullLabel)}">
    <span class="ach-guide-btn-icon">${icon(glyph, 14)}</span>
    <span class="ach-guide-btn-label">${esc(label)}</span>
    <span class="ach-guide-btn-open">${icon("external", 11)}</span>
  </button>`;
}

function communityRow(
  url: string,
  title: string,
  meta: string,
  snippet: string,
): string {
  const cleanTitle = stripEmoji(title) || "—";
  const cleanSnippet = stripEmoji(snippet);
  return `<button type="button" class="ach-community-row" data-act="ach-guide" data-url="${esc(url)}">
    <span class="ach-community-row-main">
      <span class="ach-community-title">${esc(cleanTitle)}</span>
      ${meta ? `<span class="ach-community-meta">${meta}</span>` : ""}
      ${cleanSnippet ? `<span class="ach-community-snippet">${esc(cleanSnippet)}</span>` : ""}
    </span>
    <span class="ach-community-open">${icon("external", 13)}</span>
  </button>`;
}

function renderCommunity(
  community: SteamAchievementCommunity | null | undefined,
  loading: boolean,
  fallbackUrl: string | undefined,
): string {
  if (loading) {
    return `<div class="ach-community-loading" aria-hidden="true">
      <span class="skel skel-line"></span>
      <span class="skel skel-line short"></span>
      <span class="skel skel-line"></span>
    </div>`;
  }
  if (!community || !community.supported) return "";

  const guides = community.guides
    .slice(0, 2)
    .map((guide) => {
      const meta = [
        guide.author ? esc(stripEmoji(guide.author)) : "",
        guide.rating != null
          ? `<span class="ach-community-rating">${icon("star", 10)} ${guide.rating}/5</span>`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return communityRow(guide.url, guide.title, meta, guide.description);
    })
    .join("");
  const threads = community.threads
    .slice(0, 2)
    .map((thread) => {
      const meta = [
        thread.replies > 0 ? esc(t("ach.communityReplies", { n: thread.replies })) : "",
        thread.date ? esc(thread.date) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return communityRow(thread.url, thread.title, meta, thread.snippet);
    })
    .join("");

  if (!guides && !threads) {
    return `<div class="ach-community-empty">
      <span>${esc(t("ach.communityEmpty"))}</span>
      ${
        fallbackUrl
          ? `<button type="button" class="btn ghost small" data-act="ach-guide" data-url="${esc(fallbackUrl)}">${icon("search", 12)}<span>${esc(t("ach.communityFallback"))}</span></button>`
          : ""
      }
    </div>`;
  }

  return `<div class="ach-community">
    ${
      guides
        ? `<div class="ach-community-group">
             <div class="ach-community-group-title">${icon("link", 11)} ${esc(t("ach.communityGuides"))}</div>
             ${guides}
           </div>`
        : ""
    }
    ${
      threads
        ? `<div class="ach-community-group">
             <div class="ach-community-group-title">${icon("users", 11)} ${esc(t("ach.communityThreads"))}</div>
             ${threads}
           </div>`
        : ""
    }
  </div>`;
}

export function renderAchievementDetail(input: AchievementDetailInput): string {
  const { summary, item, steamAppId, community, communityLoading } = input;
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
  const note = achievementNote(summary.appName, item.name);
  const savedGuides = achievementGuides(summary.appName, item.name);
  const appId = esc(summary.appName);
  const achId = esc(item.name);

  const date = item.unlock_date && isUnlocked ? fmtAchDate(item.unlock_date) : "";
  const rarityHint = rarity != null
    ? [
        t("ach.detailRarity", { n: fmtDecimal1(rarity) }),
        multiplier != null ? t("ach.detailMultiplier", { n: fmtDecimal1(multiplier) }) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const eyebrowTags = [
    !item.is_base ? `<span class="ach-detail-tag">DLC</span>` : "",
    !masked && item.hidden
      ? `<span class="ach-detail-tag">${icon("lock", 9)}<span>${esc(t("ach.secret"))}</span></span>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  const hideButton = isSecret && !masked
    ? `<button type="button" class="ach-detail-hide" data-act="ach-reveal" data-id="${appId}" data-ach="${achId}" title="${esc(t("ach.hideTitle"))}">${icon("eye-off", 11)}<span>${esc(t("ach.hide"))}</span></button>`
    : "";
  // Pinning is a local display choice: the card survives even when the store
  // page is closed or offline.
  const pinned = isAchievementPinned(summary.appName, item.name);
  const pinButton = masked
    ? ""
    : `<button type="button" class="ach-detail-pin${pinned ? " is-active" : ""}" data-act="ach-pin" data-id="${appId}" data-ach="${achId}" title="${esc(pinned ? t("ach.unpin") : t("ach.pin"))}" aria-pressed="${pinned}">${icon("pin", 11)}</button>`;
  // One quiet fact line carries state, date, tier, rarity and XP; the rarity
  // tooltip keeps the multiplier so the rail stays scannable.
  const facts = masked
    ? ""
    : [
        `<span class="ach-detail-fact ${isUnlocked ? "is-earned" : "is-locked"}">${isUnlocked ? icon("check", 11) : icon("lock", 10)}<span>${esc(isUnlocked ? t("ach.earned") : t("ach.locked"))}</span></span>`,
        isUnlocked && date ? `<span class="ach-detail-fact">${esc(date)}</span>` : "",
        item.hardcore ? `<span class="ach-detail-fact" title="${esc(t("ach.hardcoreHint"))}">${icon("shield", 10)}<span>${esc(t("ach.hardcore"))}</span></span>` : "",
        tierKnown ? `<span class="ach-detail-fact tier ${tier}">${icon("trophy", 10)}<span>${esc(tierName(tier))}</span></span>` : "",
        rarity != null
          ? `<span class="ach-detail-fact"${rarityHint ? ` title="${esc(rarityHint)}"` : ""}>${icon("sparkles", 10)}<span>%${esc(fmtDecimal1(rarity))}</span></span>`
          : "",
        xp > 0 ? `<span class="ach-detail-fact">+${xp} XP</span>` : "",
      ]
        .filter(Boolean)
        .join(`<span class="ach-detail-sep" aria-hidden="true">·</span>`);

  const guideButtons = [
    guideButton(links.video, t("ach.guideVideo"), "youtube"),
    guideButton(links.steamGuides, t("ach.guideSteamGuides"), "link"),
    guideButton(links.steamDiscussions, t("ach.guideSteamDiscussions"), "users"),
    guideButton(links.trueSteamAchievements, t("ach.guideTrueSteamShort"), "external", t("ach.guideTrueSteam")),
    guideButton(links.trueAchievements, t("ach.guideTrueAchievements"), "external"),
    guideButton(links.web, t("ach.guideWeb"), "globe"),
  ]
    .filter(Boolean)
    .join("");

  const communityBlock = steamAppId && !masked
    ? renderCommunity(community, Boolean(communityLoading), links.steamGuides)
    : "";

  const position = input.position;
  const detailBar = `<div class="ach-detail-bar${position ? "" : " is-positionless"}">
    <button type="button" class="ach-detail-back" data-act="ach-back" title="${esc(t("common.back"))}">
      ${icon("arrow-left", 13)}<span>${esc(t("drawer.achievements"))}</span>
    </button>
    ${
      position
        ? `<div class="ach-detail-nav">
             <span class="ach-detail-index">${icon("trophy", 11)}<span>${position.index} / ${position.total}</span></span>
             <button type="button" class="ach-detail-step" data-act="ach-open" data-ach="${esc(position.prev?.name ?? "")}" title="${esc(position.prev?.title ?? "")}"${position.prev ? "" : " disabled"}>${icon("chevron-left", 14)}</button>
             <button type="button" class="ach-detail-step" data-act="ach-open" data-ach="${esc(position.next?.name ?? "")}" title="${esc(position.next?.title ?? "")}"${position.next ? "" : " disabled"}>${icon("chevron-right", 14)}</button>
           </div>`
        : ""
    }
  </div>`;
  const progressLine = !masked && !isUnlocked && progress > 0
    ? `<div class="ach-detail-progress-line">
         <div class="progress"><span style="width:${Math.round(progress * 100)}%"></span></div>
         <span class="ach-detail-progress-label tabular-nums">${esc(t("ach.detailProgress", { n: Math.round(progress * 100) }))}</span>
       </div>`
    : "";
  const personalMark = note || savedGuides.length > 0
    ? `<span class="ach-personal-mark" title="${esc(t("common.saved"))}"></span>`
    : "";
  const guideRows = savedGuides
    .map(
      (url) => `<div class="ach-link-row">
        <button type="button" class="ach-link-open" data-act="ach-guide" data-url="${esc(url)}" title="${esc(url)}">
          <span class="ach-link-icon">${icon(linkGlyph(url), 14)}</span>
          <span class="ach-link-text">
            <span class="ach-link-host">${esc(guideHost(url))}</span>
            <span class="ach-link-url">${esc(url)}</span>
          </span>
          ${icon("external", 12)}
        </button>
        <button type="button" class="icon-btn ach-link-remove" data-act="ach-guide-remove" data-id="${appId}" data-ach="${achId}" data-url="${esc(url)}" title="${esc(t("common.delete"))}">${icon("trash", 13)}</button>
      </div>`,
    )
    .join("");

  return `
    <div class="ach-detail">
      ${detailBar}

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
          <div class="ach-detail-eyebrow">
            <span class="ach-detail-game">${esc(summary.title)}</span>
            ${eyebrowTags}
            <span class="ach-detail-tools">${hideButton}${pinButton}</span>
          </div>
          <h2 class="ach-detail-name">${esc(title)}</h2>
          <p class="ach-detail-desc">${esc(description)}</p>
          ${facts ? `<div class="ach-detail-facts">${facts}</div>` : ""}
          ${masked ? "" : renderAchievementEditBar(summary, item)}
          ${progressLine}
        </div>
      </section>

      ${
        isSecret && masked
          ? `<section class="ach-detail-spoiler">
               <div class="ach-detail-spoiler-icon">${icon("eye", 17)}</div>
               <div class="ach-detail-spoiler-body">
                 <div class="ach-detail-spoiler-title">${esc(t("ach.detailSpoiler"))}</div>
                 <button type="button" class="btn ghost small" data-act="ach-reveal" data-id="${esc(summary.appName)}" data-ach="${esc(item.name)}">
                   ${icon("eye", 12)}<span>${esc(t("ach.showSpoiler"))}</span>
                 </button>
               </div>
             </section>`
          : ""
      }

      ${
        masked
          ? ""
          : `<details class="ach-personal" data-ach-section>
               <summary class="ach-detail-section-summary">${icon("edit", 13)} <span>${esc(t("ach.personalTitle"))}</span>${personalMark}<span class="ach-detail-section-chevron">${icon("chevron-down", 12)}</span></summary>
               <div class="ach-personal-body">
                 <p class="ach-personal-hint">${icon("info", 11)}<span>${esc(t("ach.noteSyncHint"))}</span></p>
                 <div class="ach-personal-grid">
                   <div class="ach-personal-block">
                     <div class="ach-personal-label">
                       <h3 class="ach-detail-heading">${icon("edit", 13)} <span>${esc(t("ach.noteTitle"))}</span></h3>
                       <span class="ach-note-tools">
                         <span class="ach-note-count tabular-nums" id="ach-note-count">${note.length} / 4000</span>
                         ${
                           note || savedGuides.length > 0
                             ? `<button type="button" class="icon-btn ach-note-delete" data-act="ach-note-delete" data-id="${appId}" data-ach="${achId}" title="${esc(t("ach.noteDeleteTitle"))}">${icon("trash", 12)}</button>`
                             : ""
                         }
                       </span>
                     </div>
                     <textarea id="ach-note-input" class="ach-note-input" data-id="${appId}" data-ach="${achId}" rows="4" maxlength="4000" placeholder="${esc(t("ach.notePlaceholder"))}">${esc(note)}</textarea>
                     <span class="ach-note-status" id="ach-note-status" data-state="${note ? "saved" : ""}">${note ? esc(t("notes.saved")) : ""}</span>
                   </div>
                   <div class="ach-personal-block">
                     <h3 class="ach-detail-heading">${icon("link", 13)} <span>${esc(t("ach.savedGuideTitle"))}</span></h3>
                     ${guideRows ? `<div class="ach-link-list">${guideRows}</div>` : ""}
                     <div class="ach-link-add">
                       <div class="ach-guide-field">
                         ${icon("link", 13)}
                         <input id="ach-guide-url-input" class="input" type="url" placeholder="${esc(t("ach.guideUrlPlaceholder"))}" autocomplete="off" spellcheck="false" />
                       </div>
                       <button type="button" class="btn ghost small ach-link-add-btn" data-act="ach-guide-add" data-id="${appId}" data-ach="${achId}" title="${esc(t("ach.linkAdd"))}" aria-label="${esc(t("ach.linkAdd"))}">${icon("plus", 13)}</button>
                     </div>
                   </div>
                 </div>
               </div>
             </details>
             <details class="ach-detail-guides" data-ach-section open>
               <summary class="ach-detail-section-summary">
                 <h3 class="ach-detail-heading">${icon("link", 13)} <span>${esc(t("ach.detailHowTo"))}</span></h3>
                 <span class="ach-detail-section-chevron">${icon("chevron-down", 12)}</span>
               </summary>
               <div class="ach-detail-guides-body">
                 <div class="ach-guide-grid">${guideButtons}</div>
                 <p class="ach-detail-footnote">${icon("info", 11)}<span>${esc(t("ach.detailGuideHint"))}</span></p>
                 ${communityBlock}
               </div>
             </details>`
      }
    </div>`;
}

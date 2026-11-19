/**
 * The achievement card: one markup builder shared by the Settings stage and the
 * in-game toast, so the preview and the real notification cannot drift apart.
 *
 * The card is deliberately quiet. An art tile, the tier word in the accent
 * colour, one title and one muted line carry the whole notification: rarity is
 * read in the text instead of being painted with glows, rays or particles.
 */

import { icon, type IconName } from "../../core/icons";
import { t } from "../../i18n";
import { esc } from "../../core/utils";

export interface AchCardPalette {
  background: string;
  accent: string;
  border: string;
  icon: string;
  title: string;
  body: string;
}

export interface AchCardModel {
  /** The tier word ("GOLD", "PLATINUM"). Empty hides the rarity line. */
  tagLabel: string;
  /** Rarity and set counts ("%8.4 · 25/34"). Empty hides that half. */
  tagMeta: string;
  title: string;
  desc: string;
  /** small | normal | large */
  size: string;
  palette: AchCardPalette;
  glyph: IconName;
  /** The achievement's own picture; replaces the glyph underneath it. */
  iconSrc?: string;
  /** Overlay / system hints wear an accent tile and no rarity line. */
  hint?: boolean;
  /** 50..100 */
  opacity?: number;
  hideTag?: boolean;
  hideDesc?: boolean;
  showProgress?: boolean;
  progressPct?: number;
}

/** CSS custom properties that colour the card and its accent surfaces. */
export function achCardVars(palette: AchCardPalette, opacity = 100): string {
  const op = Math.max(50, Math.min(100, opacity)) / 100;
  return `--ach-bg:${palette.background};--ach-accent:${palette.accent};--ach-border:${palette.border};--ach-icon:${palette.icon};--ach-title:${palette.title};--ach-body:${palette.body};--ach-opacity:${op};`;
}

export interface AchTagParts {
  /** The tier word, painted in the accent colour. */
  label: string;
  /** Rarity percentage and set counts, painted muted. */
  meta: string;
}

/**
 * The rarity line, split so the tier word can wear the accent colour while the
 * numbers stay quiet. Both surfaces call this, so the counts and the percentage
 * always read the same way. Labels come from the locale.
 */
export function achTagParts(
  tier: number,
  unlocked: number,
  total: number,
  rarityPercent: number | null | undefined,
): AchTagParts {
  const label = tier >= 4
    ? t("ach.tierPlatinum")
    : tier === 3
      ? t("settings.achTierUltra")
      : tier === 2
        ? t("ach.tierGold")
        : tier === 1
          ? t("ach.tierSilver")
          : t("ach.tierBronze");
  // Platinum means the set is complete; the rarity percentage (often <1%) is
  // not what the line should show, and the preview already reads 100%.
  const percentValue = tier >= 4 ? 100 : rarityPercent;
  const pct = typeof percentValue === "number" && Number.isFinite(percentValue)
    ? `%${percentValue.toFixed(1)}`
    : "";
  const counts = total > 0 ? `${unlocked}/${total}` : "";
  return {
    label: label.toUpperCase(),
    meta: [pct, counts].filter(Boolean).join(" · "),
  };
}

/** The card itself. No stage, no position: both callers place it. */
export function achCardHtml(m: AchCardModel): string {
  const hintClass = m.hint ? " is-hint" : "";
  const tagHtml = !m.hideTag && (m.tagLabel || m.tagMeta)
    ? `<span class="ach-hud-tag">${
        m.tagLabel ? `<span class="ach-hud-tag-tier">${esc(m.tagLabel)}</span>` : ""
      }${
        m.tagLabel && m.tagMeta ? `<span class="ach-hud-tag-sep">·</span>` : ""
      }${
        m.tagMeta ? `<span class="ach-hud-tag-meta">${esc(m.tagMeta)}</span>` : ""
      }</span>`
    : "";
  const descHtml = !m.hideDesc && m.desc ? `<span class="ach-hud-desc">${esc(m.desc)}</span>` : "";
  const progressHtml = m.showProgress && typeof m.progressPct === "number" && m.progressPct >= 0
    ? `<div class="ach-hud-progress-track"><div class="ach-hud-progress-fill" style="width: ${Math.min(100, Math.max(0, m.progressPct))}%;"></div></div>`
    : "";
  const art = m.iconSrc
    ? `<img class="ach-hud-ach-icon" src="${esc(m.iconSrc)}" alt="" />`
    : "";

  return `
    <div class="ach-hud-toast size-${esc(m.size)}${hintClass}" style="${achCardVars(m.palette, m.opacity)}">
      <div class="ach-hud-medallion">
        <span class="ach-hud-ico">${icon(m.glyph, 20)}</span>
        ${art}
      </div>

      <div class="ach-hud-text-col">
        ${tagHtml}
        <span class="ach-hud-title">${esc(m.title)}</span>
        ${descHtml}
        ${progressHtml}
      </div>
    </div>`;
}

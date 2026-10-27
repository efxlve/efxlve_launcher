/**
 * The achievement card: one markup builder, one tag format, one particle set.
 *
 * Both surfaces render this module — the Settings stage preview and the
 * in-game toast webview — so a change here can never make the preview and the
 * real notification drift apart.
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
  /** Uppercase rarity line ("ULTRA RARE • %1.8 • 31/34"). Empty hides it. */
  tag: string;
  title: string;
  desc: string;
  /** 0 bronze .. 4 platinum; selects the tier class (glow strength). */
  tier: number;
  /** small | normal | large */
  size: string;
  /** prism | cyber | shatter | jackpot | xbox | playstation | epic */
  style: string;
  /** Card theme id, kept as a class for theme-specific rules. */
  theme: string;
  palette: AchCardPalette;
  /** Alternates 0/1 so the CSS burst animations replay on every card. */
  seq: number;
  glyph: IconName;
  /** The achievement's own picture (data URL); replaces the trophy glyph. */
  iconSrc?: string;
  /** When true, renders the distinct system / overlay hint UI rather than an achievement trophy. */
  hint?: boolean;
}

export interface AchCardParticle {
  dx: number;
  dy: number;
  rot: number;
  delay: number;
  size: number;
  diamond: boolean;
}

/** 14 diamonds/sparks that burst out of the medallion once, like the preview. */
export const ACH_CARD_PARTICLES: readonly AchCardParticle[] = [
  { dx: -52, dy: -38, rot: 45, delay: 40, size: 6, diamond: true },
  { dx: -28, dy: -56, rot: 120, delay: 65, size: 5, diamond: false },
  { dx: 14, dy: -62, rot: 210, delay: 30, size: 7, diamond: true },
  { dx: 54, dy: -46, rot: 85, delay: 80, size: 5, diamond: false },
  { dx: 76, dy: -18, rot: 160, delay: 50, size: 6, diamond: true },
  { dx: 82, dy: 22, rot: 310, delay: 95, size: 4, diamond: false },
  { dx: 58, dy: 48, rot: 45, delay: 60, size: 6, diamond: true },
  { dx: 18, dy: 58, rot: 195, delay: 70, size: 5, diamond: false },
  { dx: -24, dy: 54, rot: 260, delay: 45, size: 6, diamond: true },
  { dx: -58, dy: 34, rot: 135, delay: 85, size: 5, diamond: false },
  { dx: -68, dy: -4, rot: 25, delay: 55, size: 7, diamond: true },
  { dx: 36, dy: -32, rot: 70, delay: 110, size: 4, diamond: false },
  { dx: -38, dy: 28, rot: 150, delay: 120, size: 5, diamond: true },
  { dx: 96, dy: -6, rot: 45, delay: 105, size: 5, diamond: true },
];

function particlesHtml(): string {
  return ACH_CARD_PARTICLES.map(
    (p) =>
      `<span class="ach-fx-particle ${p.diamond ? "diamond" : "spark"}" style="--dx:${p.dx}px;--dy:${p.dy}px;--rot:${p.rot}deg;--delay:${p.delay}ms;--sz:${p.size}px;"></span>`,
  ).join("");
}

/** CSS custom properties that colour the card and its FX layers. */
export function achCardVars(palette: AchCardPalette): string {
  return `--ach-bg:${palette.background};--ach-accent:${palette.accent};--ach-border:${palette.border};--ach-icon:${palette.icon};--ach-title:${palette.title};--ach-body:${palette.body};`;
}

/**
 * The rarity line, shared by the preview and the real card so the counts and
 * the percentage always read the same way. Labels come from the locale.
 */
export function achTagLine(
  tier: number,
  unlocked: number,
  total: number,
  rarityPercent: number | null | undefined,
): string {
  const counts = total > 0 ? `${unlocked}/${total}` : "";
  // Platinum means the set is complete; the rarity percentage (often <1%) is
  // not what the line should show, and the preview already reads 100%.
  const percentValue = tier >= 4 ? 100 : rarityPercent;
  const pct = typeof percentValue === "number" && Number.isFinite(percentValue)
    ? `%${percentValue.toFixed(1)}`
    : "";
  const parts: string[] = [];
  if (tier >= 4) parts.push(t("ach.tierPlatinum").toUpperCase());
  else if (tier === 3) parts.push(t("settings.achTierUltra").toUpperCase());
  else if (tier === 2) parts.push(t("ach.tierGold").toUpperCase());
  else parts.push(t("settings.achUnlockedTag"));
  if (pct) parts.push(pct);
  if (counts) parts.push(counts);
  return parts.join(" • ");
}

function achHintCardHtml(m: AchCardModel): string {
  const art = m.iconSrc
    ? `<img class="ach-hint-app-icon" src="${esc(m.iconSrc)}" alt="" />`
    : `<span class="ach-hint-ico">${icon(m.glyph || "layers", 20)}</span>`;
  return `
    <div class="ach-hud-toast ach-hud-hint size-${esc(m.size)} style-${esc(m.style)} theme-${esc(m.theme)} seq-${m.seq % 2}" data-seq="${m.seq}" style="${achCardVars(m.palette)}">
      <div class="ach-hint-badge">
        ${art}
      </div>
      <div class="ach-hint-text-col">
        <span class="ach-hint-title">${esc(m.title)}</span>
        <span class="ach-hint-desc">${esc(m.desc)}</span>
      </div>
    </div>`;
}

/** The card itself. No stage, no position: both callers place it. */
export function achCardHtml(m: AchCardModel): string {
  if (m.hint) {
    return achHintCardHtml(m);
  }
  const art = m.iconSrc
    ? `<img class="ach-hud-ach-icon" src="${esc(m.iconSrc)}" alt="" />`
    : "";
  return `
    <div class="ach-hud-toast size-${esc(m.size)} style-${esc(m.style)} theme-${esc(m.theme)} tier-${m.tier} seq-${m.seq % 2}" data-seq="${m.seq}" style="${achCardVars(m.palette)}">
      <svg class="ach-fx-border-beam" aria-hidden="true"><rect pathLength="100" /></svg>
      <div class="ach-fx-godrays"></div>
      <div class="ach-hud-gold-bar"></div>

      <div class="ach-hud-medallion-wrap">
        <span class="ach-fx-shockwave ring-1"></span>
        <span class="ach-fx-shockwave ring-2"></span>
        <div class="ach-fx-particles">${particlesHtml()}</div>
        <div class="ach-hud-medallion">
          <span class="ach-medallion-ring"></span>
          ${art || `<span class="ach-hud-trophy-ico">${icon(m.glyph, 18)}</span>`}
        </div>
      </div>

      <div class="ach-hud-text-col">
        ${m.tag ? `<span class="ach-hud-tag">${esc(m.tag)}</span>` : ""}
        <span class="ach-hud-title">${esc(m.title)}</span>
        <span class="ach-hud-desc">${esc(m.desc)}</span>
      </div>
    </div>`;
}

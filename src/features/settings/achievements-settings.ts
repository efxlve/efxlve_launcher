/**
 * Modern Achievements & Notifications settings view and live interactive stage.
 *
 * Provides a live monitor stage showing the real-time notification toast at the
 * user's chosen screen position, visual position selector, animation style &
 * theme presets, rarity-tier escalation preview, multi-harmonic audio chime
 * audition, volume/duration controls, and toggle switches.
 */

import { icon, type IconName } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { achievementCardPalette, syncAchievementCardTheme } from "../../core/achievement-card-theme";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import {
  achievementClearCustomSound,
  achievementGetNotificationOptions,
  achievementPickCustomSound,
  achievementSetNotificationOptions,
  achievementTestNotification,
} from "../../steam";
import { t } from "../../i18n";

/** Active rarity tier in the interactive stage (0=Bronze, 1=Silver, 2=Gold, 3=Ultra, 4=Platinum). */
let previewRarityTier = 2;
/** Incremented on every replay/preset change so CSS animations restart cleanly. */
let stageReplaySeq = 1;

const STAGE_PARTICLES: ReadonlyArray<{
  dx: number;
  dy: number;
  rot: number;
  delay: number;
  size: number;
  diamond: boolean;
}> = [
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

let sharedAudioCtx: AudioContext | null = null;
let activeMasterGain: GainNode | null = null;

function stopWebAudioAchievementChime(): void {
  try {
    if (activeMasterGain && sharedAudioCtx) {
      const now = sharedAudioCtx.currentTime;
      const prev = activeMasterGain;
      activeMasterGain = null;
      prev.gain.cancelScheduledValues(now);
      prev.gain.setValueAtTime(Math.max(0.0001, prev.gain.value), now);
      prev.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);
      window.setTimeout(() => {
        try {
          prev.disconnect();
        } catch {
          /* ignore */
        }
      }, 40);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Synthesizes the multi-harmonic dopamine chime live in the browser using Web Audio,
 * tailored to the chosen animation style ("prism", "cyber", "shatter", "jackpot")
 * and rarity tier (0..4). Reuses a single AudioContext and stops any previous
 * preview sound so rapid clicks never overlap or clip.
 */
export function playWebAudioAchievementChime(
  volumePct = 100,
  animStyle = S.achievementNotificationOptions.animStyle || "prism",
  rarityTier = previewRarityTier,
): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
      sharedAudioCtx = new AudioCtx();
    }
    const ctx = sharedAudioCtx;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    stopWebAudioAchievementChime();

    const now = ctx.currentTime;
    const vol = (Math.max(0, Math.min(100, volumePct)) / 100) * 0.28;
    if (vol <= 0.001) return;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(1.0, now);
    activeMasterGain = masterGain;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-14, now);
    compressor.knee.setValueAtTime(18, now);
    compressor.ratio.setValueAtTime(4, now);
    compressor.attack.setValueAtTime(0.005, now);
    compressor.release.setValueAtTime(0.18, now);

    const masterFilter = ctx.createBiquadFilter();
    masterFilter.type = "lowpass";
    masterFilter.frequency.setValueAtTime(rarityTier >= 3 ? 3800 : 3000, now);
    masterFilter.Q.setValueAtTime(0.7, now);

    masterFilter.connect(compressor);
    compressor.connect(masterGain);
    masterGain.connect(ctx.destination);

    // 1. Warm sub-bass thump (96 Hz -> 42 Hz)
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = "sine";
    subOsc.frequency.setValueAtTime(96, now);
    subOsc.frequency.exponentialRampToValueAtTime(42, now + 0.22);
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.linearRampToValueAtTime(vol * 0.55, now + 0.015);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    subOsc.connect(subGain);
    subGain.connect(masterFilter);
    subOsc.start(now);
    subOsc.stop(now + 0.26);

    const noteCount = rarityTier <= 0 ? 3 : rarityTier === 1 ? 4 : rarityTier === 2 ? 5 : 6;

    if (animStyle === "cyber") {
      // Cyber Overload: warm analog synth fifths & octave arpeggio (no harsh sawtooth)
      const freqs = [220.0, 329.63, 440.0, 493.88, 554.37, 659.25].slice(0, noteCount);
      freqs.forEach((hz, idx) => {
        const at = now + idx * 0.068;
        const osc = ctx.createOscillator();
        const over = ctx.createOscillator();
        const gain = ctx.createGain();
        const overGain = ctx.createGain();
        osc.type = "triangle";
        over.type = "sine";
        osc.frequency.setValueAtTime(hz, at);
        over.frequency.setValueAtTime(hz * 2.0, at);
        overGain.gain.setValueAtTime(0.28, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(vol * 0.42, at + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.25 + rarityTier * 0.12);
        over.connect(overGain);
        overGain.connect(gain);
        osc.connect(gain);
        gain.connect(masterFilter);
        osc.start(at);
        over.start(at);
        osc.stop(at + 1.35 + rarityTier * 0.12);
        over.stop(at + 1.35 + rarityTier * 0.12);
      });
    } else if (animStyle === "shatter") {
      // Crystal Shatter: pure Lydian celesta / vibraphone harmonics (F5..G6)
      const freqs = [698.46, 783.99, 880.0, 1046.5, 1318.51, 1567.98].slice(0, noteCount);
      freqs.forEach((hz, idx) => {
        const at = now + idx * 0.065;
        for (const [mult, weight, decay] of [
          [1.0, 0.48, 1.35],
          [2.0, 0.16, 0.65],
        ] as const) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(hz * mult, at);
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.linearRampToValueAtTime(vol * weight, at + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
          osc.connect(gain);
          gain.connect(masterFilter);
          osc.start(at);
          osc.stop(at + decay + 0.05);
        }
      });
    } else if (animStyle === "jackpot") {
      // Arcade Jackpot: crisp 3-note grace flourish into a lush Major-9th triumph chord
      [523.25, 659.25, 783.99].forEach((hz, c) => {
        const at = now + c * 0.062;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(hz, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(vol * 0.38, at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
        osc.connect(gain);
        gain.connect(masterFilter);
        osc.start(at);
        osc.stop(at + 0.36);
      });
      const chordAt = now + 0.18;
      [261.63, 523.25, 659.25, 783.99, 987.77, 1174.66].slice(0, noteCount).forEach((hz) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(hz, chordAt);
        gain.gain.setValueAtTime(0.0001, chordAt);
        gain.gain.linearRampToValueAtTime(vol * 0.28, chordAt + 0.026);
        gain.gain.exponentialRampToValueAtTime(0.0001, chordAt + 1.65);
        osc.connect(gain);
        gain.connect(masterFilter);
        osc.start(chordAt);
        osc.stop(chordAt + 1.7);
      });
    } else {
      // Prism Unfurl (default): PS5-inspired warm D-Maj9 crystal pad + chime arpeggio
      [146.83, 220.0].forEach((padHz) => {
        const padOsc = ctx.createOscillator();
        const padGain = ctx.createGain();
        padOsc.type = "sine";
        padOsc.frequency.setValueAtTime(padHz, now);
        padGain.gain.setValueAtTime(0.0001, now);
        padGain.gain.linearRampToValueAtTime(vol * 0.24, now + 0.05);
        padGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.65);
        padOsc.connect(padGain);
        padGain.connect(masterFilter);
        padOsc.start(now);
        padOsc.stop(now + 1.7);
      });

      const freqs = [587.33, 739.99, 880.0, 1108.73, 1318.51, 1760.0].slice(0, noteCount);
      freqs.forEach((hz, idx) => {
        const at = now + idx * 0.075;
        const osc = ctx.createOscillator();
        const bell = ctx.createOscillator();
        const gain = ctx.createGain();
        const bellGain = ctx.createGain();
        osc.type = "sine";
        bell.type = "triangle";
        osc.frequency.setValueAtTime(hz, at);
        bell.frequency.setValueAtTime(hz * 2.0, at);
        const decay = 1.4 + rarityTier * 0.14;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(vol * 0.46, at + 0.016);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
        bellGain.gain.setValueAtTime(0.2, at);
        bell.connect(bellGain);
        bellGain.connect(gain);
        osc.connect(gain);
        gain.connect(masterFilter);
        osc.start(at);
        bell.start(at);
        osc.stop(at + decay + 0.05);
        bell.stop(at + decay + 0.05);
      });
    }

    // Ultra-Rare / Platinum warm choir shimmer tail
    if (rarityTier >= 3) {
      const shimmerFreqs = rarityTier >= 4 ? [1174.66, 1479.98, 1760.0] : [1174.66, 1479.98];
      shimmerFreqs.forEach((hz, i) => {
        const at = now + 0.3 + i * 0.065;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(hz, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(vol * 0.22, at + 0.07);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.8);
        osc.connect(gain);
        gain.connect(masterFilter);
        osc.start(at);
        osc.stop(at + 1.85);
      });
    }
  } catch {
    /* browser audio blocked or unavailable */
  }
}

function getPreviewTierMeta(tier: number): {
  tag: string;
  title: string;
  desc: string;
  rarityBadge: string;
  progressPct: number;
  progressText: string;
  iconName: IconName;
} {
  switch (tier) {
    case 0:
      return {
        tag: t("settings.achUnlockedTag"),
        title: "İlk Adım",
        desc: t("settings.achTestDesc"),
        rarityBadge: "%64.2",
        progressPct: 32,
        progressText: "11 / 34 • %32",
        iconName: "trophy",
      };
    case 1:
      return {
        tag: t("settings.achUnlockedTag"),
        title: "Keskin Gözlemci",
        desc: t("settings.achTestDesc"),
        rarityBadge: "%21.8",
        progressPct: 56,
        progressText: "19 / 34 • %56",
        iconName: "trophy",
      };
    case 3:
      return {
        tag: `${t("settings.achTierUltra").toUpperCase()} • %1.8`,
        title: "Kusursuz Senkron",
        desc: t("settings.achTestDesc"),
        rarityBadge: "%1.8",
        progressPct: 92,
        progressText: "31 / 34 • %92",
        iconName: "sparkles",
      };
    case 4:
      return {
        tag: `${t("ach.tierPlatinum").toUpperCase()} • %100`,
        title: "Platin Avcısı",
        desc: t("ach.platinumEarnedDesc"),
        rarityBadge: "100% PLATINUM",
        progressPct: 100,
        progressText: "34 / 34 • %100",
        iconName: "crown",
      };
    default:
      return {
        tag: `${t("ach.tierGold").toUpperCase()} • %8.4`,
        title: "Zamanın Efendisi",
        desc: t("settings.achTestDesc"),
        rarityBadge: "%8.4",
        progressPct: 74,
        progressText: "25 / 34 • %74",
        iconName: "trophy",
      };
  }
}

/** Renders the full modern Achievements & Notifications view. */
export function renderAchievementsSettingsView(): string {
  const options = S.achievementNotificationOptions;
  const soundName = options.customSoundName || t("settings.achDefaultChime");
  const position = options.position || "top-right";
  const currentSize = ["small", "normal", "large"].includes(options.size)
    ? options.size
    : options.size === "compact"
      ? "small"
      : "normal";

  const allowedThemes = ["gold", "rarity", "launcher", "cyber", "emerald", "crimson", "amethyst"];
  const cardTheme = allowedThemes.includes(options.cardTheme) ? options.cardTheme : "gold";

  const allowedStyles = ["prism", "cyber", "shatter", "jackpot"];
  const animStyle = allowedStyles.includes(options.animStyle) ? options.animStyle : "prism";

  const palette = achievementCardPalette(cardTheme, previewRarityTier);
  const tierMeta = getPreviewTierMeta(previewRarityTier);

  const sizeOptions: Array<{ id: string; label: string }> = [
    { id: "small", label: t("settings.achSizeSmall") },
    { id: "normal", label: t("settings.achSizeNormal") },
    { id: "large", label: t("settings.achSizeLarge") },
  ];

  const sizeButtons = sizeOptions
    .map(
      (opt) => `
        <button type="button" class="${currentSize === opt.id ? "active" : ""}" data-act="set-ach-size" data-val="${opt.id}">
          ${esc(opt.label)}
        </button>
      `,
    )
    .join("");

  const volumeButtons = [25, 50, 75, 100]
    .map(
      (value) => `
        <button type="button" class="${options.volume === value ? "active" : ""}" data-act="set-ach-volume" data-val="${value}">
          ${value}%
        </button>
      `,
    )
    .join("");

  const durationButtons = [
    [3000, "3s"],
    [5000, "5s"],
    [8000, "8s"],
  ]
    .map(
      ([value, label]) => `
        <button type="button" class="${options.durationMs === value ? "active" : ""}" data-act="set-ach-duration" data-val="${value}">
          ${label}
        </button>
      `,
    )
    .join("");

  const animStyleOptions: Array<{ id: string; label: string; ico: IconName }> = [
    { id: "prism", label: t("settings.achAnimPrism"), ico: "sparkles" },
    { id: "cyber", label: t("settings.achAnimCyber"), ico: "zap" },
    { id: "shatter", label: t("settings.achAnimShatter"), ico: "star" },
    { id: "jackpot", label: t("settings.achAnimJackpot"), ico: "trophy" },
  ];

  const animStyleButtons = animStyleOptions
    .map(
      (opt) => `
        <button type="button" class="ach-style-chip ${animStyle === opt.id ? "active" : ""}" data-act="set-ach-anim-style" data-val="${opt.id}">
          ${icon(opt.ico, 13)}
          <span>${esc(opt.label)}</span>
        </button>
      `,
    )
    .join("");

  const cardThemeButtons = [
    { id: "gold", label: t("settings.achCardThemeGold"), swatch: "#f59e0b" },
    { id: "rarity", label: t("settings.achCardThemeRarity"), swatch: "conic-gradient(#cd7f32, #94a3b8, #f59e0b, #22d3ee, #e879f9)" },
    { id: "launcher", label: t("settings.achCardThemeLauncher"), swatch: "var(--accent)" },
    { id: "cyber", label: t("settings.achCardThemeCyber"), swatch: "#00f0ff" },
    { id: "emerald", label: t("settings.achCardThemeEmerald"), swatch: "#10b981" },
    { id: "crimson", label: t("settings.achCardThemeCrimson"), swatch: "#f43f5e" },
    { id: "amethyst", label: t("settings.achCardThemeAmethyst"), swatch: "#a855f7" },
  ]
    .map(
      (option) => `
        <button type="button" class="ach-theme-chip ${cardTheme === option.id ? "active" : ""}" data-act="set-ach-card-theme" data-val="${option.id}">
          <span class="ach-theme-swatch" style="background: ${option.swatch};"></span>
          <span>${esc(option.label)}</span>
        </button>
      `,
    )
    .join("");

  const rarityTierPills = [
    { tier: 0, label: t("ach.tierBronze"), dot: "#cd7f32" },
    { tier: 1, label: t("ach.tierSilver"), dot: "#94a3b8" },
    { tier: 2, label: t("ach.tierGold"), dot: "#f59e0b" },
    { tier: 3, label: t("settings.achTierUltra"), dot: "#22d3ee" },
    { tier: 4, label: t("ach.tierPlatinum"), dot: "#e879f9" },
  ]
    .map(
      (r) => `
        <button type="button" class="ach-tier-pill ${previewRarityTier === r.tier ? "active" : ""}" data-act="set-ach-preview-tier" data-val="${r.tier}">
          <span class="ach-tier-dot" style="background: ${r.dot}; box-shadow: 0 0 6px ${r.dot};"></span>
          <span>${esc(r.label)}</span>
        </button>
      `,
    )
    .join("");

  const particlesHtml = STAGE_PARTICLES.map(
    (p) =>
      `<span class="ach-fx-particle ${p.diamond ? "diamond" : "spark"}" style="--dx:${p.dx}px;--dy:${p.dy}px;--rot:${p.rot}deg;--delay:${p.delay}ms;--sz:${p.size}px;"></span>`,
  ).join("");

  // Position anchors for the visual monitor pad
  const positions: Array<{ id: string; label: string; iconName: string }> = [
    { id: "top-left", label: t("settings.achPositionTopLeft"), iconName: "arrow-up-left" },
    { id: "center-top", label: t("settings.achPositionCenterTop"), iconName: "arrow-up" },
    { id: "top-right", label: t("settings.achPositionTopRight"), iconName: "arrow-up-right" },
    { id: "bottom-left", label: t("settings.achPositionBottomLeft"), iconName: "arrow-down-left" },
    { id: "center-bottom", label: t("settings.achPositionCenterBottom"), iconName: "arrow-down" },
    { id: "bottom-right", label: t("settings.achPositionBottomRight"), iconName: "arrow-down-right" },
  ];

  const positionPadButtons = positions
    .map((p) => {
      const isCurrent = position === p.id;
      return `
      <button type="button" class="ach-pad-btn ${isCurrent ? "active" : ""}" data-act="set-ach-position" data-val="${esc(p.id)}" title="${esc(p.label)}">
        <span class="ach-pad-dot"></span>
        <span class="ach-pad-label">${esc(p.label)}</span>
        ${isCurrent ? `<span class="ach-pad-check">${icon("check", 11)}</span>` : ""}
      </button>
    `;
    })
    .join("");

  return `
    <div class="ach-settings-view">
      <!-- Section Header -->
      <div class="theme-section-header">
        <div class="theme-section-titles">
          <h3 class="section-title">${esc(t("settings.secAchievements"))}</h3>
          <p class="page-sub">${esc(t("settings.achNotifyDesc"))}</p>
        </div>
        <div class="theme-section-actions">
          <button type="button" class="btn ghost small" data-act="ach-replay-stage">
            ${icon("refresh", 13)} <span>${esc(t("settings.achReplayBtn"))}</span>
          </button>
          <button type="button" class="btn primary small" data-act="ach-test-notification">
            ${icon("bell", 13)} <span>${esc(t("settings.achTestTitle"))}</span>
          </button>
        </div>
      </div>

      <!-- Live Interactive Stage Preview -->
      <div class="ach-stage-container">
        <div class="ach-stage-header">
          <span class="theme-preview-head-title">
            <span class="theme-pulse-dot"></span>
            <span>${esc(t("settings.achPreviewTitle"))}</span>
          </span>
          <div class="ach-stage-tier-bar" role="group" aria-label="${esc(t("settings.achRarityStageLabel"))}">
            ${rarityTierPills}
          </div>
          <span class="settings-value">${esc(t("settings.achPositionTitle"))}: <strong>${esc(position)}</strong></span>
        </div>

        <div class="ach-stage-screen pos-${esc(position)} tier-${previewRarityTier}" style="--ach-bg:${palette.background};--ach-accent:${palette.accent};--ach-border:${palette.border};--ach-icon:${palette.icon};--ach-title:${palette.title};--ach-body:${palette.body};--ach-progress:${tierMeta.progressPct}%;">
          <div class="ach-stage-backdrop"></div>
          <div class="ach-stage-aura"></div>

          <!-- Dopamine Choreography Toast Capsule -->
          <div class="ach-hud-toast size-${esc(currentSize)} style-${esc(animStyle)} theme-${esc(cardTheme)} tier-${previewRarityTier} seq-${stageReplaySeq % 2}" data-seq="${stageReplaySeq}">
            <div class="ach-fx-border-beam"></div>
            <div class="ach-fx-godrays"></div>
            <div class="ach-fx-shimmer"></div>
            <div class="ach-hud-gold-bar"></div>

            <div class="ach-hud-medallion-wrap">
              <span class="ach-fx-shockwave ring-1"></span>
              <span class="ach-fx-shockwave ring-2"></span>
              <div class="ach-fx-particles">${particlesHtml}</div>
              <div class="ach-hud-medallion">
                <span class="ach-medallion-ring"></span>
                <span class="ach-hud-trophy-ico">${icon(tierMeta.iconName, 18)}</span>
              </div>
            </div>

            <div class="ach-hud-text-col">
              <div class="ach-hud-top-row">
                <span class="ach-hud-tag">${esc(tierMeta.tag)}</span>
                <span class="ach-hud-rarity-pill">${esc(tierMeta.rarityBadge)}</span>
              </div>
              <span class="ach-hud-title">${esc(tierMeta.title)}</span>
              <span class="ach-hud-desc">${esc(tierMeta.desc)}</span>
              <div class="ach-hud-progress-row">
                <div class="ach-hud-progress-track">
                  <div class="ach-hud-progress-fill">
                    <span class="ach-hud-progress-tip"></span>
                  </div>
                </div>
                <span class="ach-hud-progress-meta">${esc(tierMeta.progressText)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Controls Group -->
      <div class="list settings-group" style="margin-top: 18px;">
        <!-- Animation Style -->
        <div class="row settings-row stacked">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achAnimStyleTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achAnimStyleDesc"))}</div>
          </div>
          <div class="settings-row-control" style="width: 100%;">
            <div class="ach-style-grid" role="group">${animStyleButtons}</div>
          </div>
        </div>

        <!-- Card Theme -->
        <div class="row settings-row stacked">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achCardThemeTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achCardThemeDesc"))}</div>
          </div>
          <div class="settings-row-control" style="width: 100%;">
            <div class="ach-theme-grid" role="group">${cardThemeButtons}</div>
          </div>
        </div>

        <!-- Size Selector -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achSizeTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achSizeDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <div class="seg" role="group">${sizeButtons}</div>
          </div>
        </div>

        <!-- Toggles -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achNotifyTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achNotifyDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-ach-notifications" ${options.enabled ? "checked" : ""} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achOverlayTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achOverlayDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-ach-overlay" ${options.overlay ? "checked" : ""} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <!-- Visual Screen Position Pad -->
        <div class="row settings-row stacked">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achPositionTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achPositionDesc"))}</div>
          </div>
          <div class="settings-row-control" style="width: 100%;">
            <div class="ach-pad-grid">
              ${positionPadButtons}
            </div>
          </div>
        </div>

        <!-- Sound switch -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achSoundTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achSoundDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-ach-sound" ${options.sound ? "checked" : ""} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <!-- Sound file row -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achCustomSoundTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achCustomSoundDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <div class="ach-sound-control-wrap">
              <span class="ach-sound-file-label" title="${esc(soundName)}">${esc(soundName)}</span>
              <button type="button" class="btn ghost small" data-act="ach-audition-sound" title="${esc(t("settings.achAuditionBtn"))}">
                ${icon("volume-2", 13)} <span>${esc(t("settings.achAuditionBtn"))}</span>
              </button>
              <button type="button" class="btn ghost small" data-act="ach-pick-sound">
                ${icon("folder", 13)} <span>${esc(t("settings.achSoundChoose"))}</span>
              </button>
              ${options.customSound ? `
                <button type="button" class="btn ghost small danger" data-act="ach-clear-sound" title="${esc(t("settings.achSoundClear"))}">
                  ${icon("trash", 13)}
                </button>
              ` : ""}
            </div>
          </div>
        </div>

        <!-- Volume -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achVolumeTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achVolumeDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <div class="seg" role="group">${volumeButtons}</div>
          </div>
        </div>

        <!-- Duration -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achDurationTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achDurationDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <div class="seg" role="group">${durationButtons}</div>
          </div>
        </div>
      </div>

      <!-- Info note -->
      <div class="info-box" style="margin-top: 14px;">
        ${icon("info", 14)}
        <span>${esc(t("settings.achNotificationsNote"))}</span>
      </div>
    </div>
  `;
}

/** Handles all achievement settings actions from click-router. */
export function handleAchievementsSettingsAction(act: string | undefined, el: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "toggle-ach-notifications": {
      const next = {
        ...S.achievementNotificationOptions,
        enabled: (el as HTMLInputElement).checked,
      };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

    case "toggle-ach-overlay": {
      const next = {
        ...S.achievementNotificationOptions,
        overlay: (el as HTMLInputElement).checked,
      };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

    case "toggle-ach-sound": {
      const next = {
        ...S.achievementNotificationOptions,
        sound: (el as HTMLInputElement).checked,
      };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

    case "set-ach-anim-style": {
      const allowed = ["prism", "cyber", "shatter", "jackpot"];
      const animStyle = allowed.includes(el.dataset.val ?? "") ? el.dataset.val! : "prism";
      const next = { ...S.achievementNotificationOptions, animStyle };
      S.achievementNotificationOptions = next;
      stageReplaySeq++;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      if (next.sound) {
        playWebAudioAchievementChime(next.volume, animStyle, previewRarityTier);
      }
      return true;
    }

    case "set-ach-card-theme": {
      const allowed = ["gold", "rarity", "launcher", "cyber", "emerald", "crimson", "amethyst"];
      const cardTheme = allowed.includes(el.dataset.val ?? "") ? el.dataset.val! : "gold";
      const next = { ...S.achievementNotificationOptions, cardTheme };
      S.achievementNotificationOptions = next;
      stageReplaySeq++;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      syncAchievementCardTheme();
      render();
      return true;
    }

    case "set-ach-preview-tier": {
      const tier = Math.max(0, Math.min(4, Number(el.dataset.val ?? 2)));
      previewRarityTier = Number.isNaN(tier) ? 2 : tier;
      stageReplaySeq++;
      render();
      if (S.achievementNotificationOptions.sound) {
        playWebAudioAchievementChime(
          S.achievementNotificationOptions.volume,
          S.achievementNotificationOptions.animStyle,
          previewRarityTier,
        );
      }
      return true;
    }

    case "ach-replay-stage": {
      stageReplaySeq++;
      render();
      if (S.achievementNotificationOptions.sound) {
        playWebAudioAchievementChime(
          S.achievementNotificationOptions.volume,
          S.achievementNotificationOptions.animStyle,
          previewRarityTier,
        );
      }
      return true;
    }

    case "set-ach-size": {
      const allowed = ["small", "normal", "large"];
      const size = allowed.includes(el.dataset.val ?? "") ? el.dataset.val! : "normal";
      const next = { ...S.achievementNotificationOptions, size };
      S.achievementNotificationOptions = next;
      stageReplaySeq++;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

    case "set-ach-position": {
      const allowed = ["top-left", "center-top", "top-right", "bottom-left", "center-bottom", "bottom-right"];
      const position = allowed.includes(el.dataset.val ?? "") ? el.dataset.val! : "top-right";
      const next = { ...S.achievementNotificationOptions, position };
      S.achievementNotificationOptions = next;
      stageReplaySeq++;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

    case "set-ach-volume": {
      const volume = Math.max(0, Math.min(100, Number(el.dataset.val) || 100));
      const next = { ...S.achievementNotificationOptions, volume };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      playWebAudioAchievementChime(volume, next.animStyle, previewRarityTier);
      return true;
    }

    case "set-ach-duration": {
      const durationMs = Number(el.dataset.val) || 5000;
      const next = { ...S.achievementNotificationOptions, durationMs };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

    case "ach-audition-sound": {
      playWebAudioAchievementChime(
        S.achievementNotificationOptions.volume,
        S.achievementNotificationOptions.animStyle,
        previewRarityTier,
      );
      return true;
    }

    case "ach-pick-sound": {
      void (async () => {
        try {
          const name = await achievementPickCustomSound();
          if (!name) return;
          S.achievementNotificationOptions = await achievementGetNotificationOptions();
          render();
        } catch (e) {
          toast(String(e), "err");
        }
      })();
      return true;
    }

    case "ach-clear-sound": {
      void (async () => {
        try {
          await achievementClearCustomSound();
          S.achievementNotificationOptions = await achievementGetNotificationOptions();
          render();
        } catch (e) {
          toast(String(e), "err");
        }
      })();
      return true;
    }

    case "ach-test-notification": {
      stopWebAudioAchievementChime();
      stageReplaySeq++;
      render();
      const meta = getPreviewTierMeta(previewRarityTier);
      void achievementTestNotification(
        meta.title,
        meta.desc,
        meta.tag,
        previewRarityTier,
      ).catch((e) => toast(String(e), "err"));
      return true;
    }

    default:
      return false;
  }
}

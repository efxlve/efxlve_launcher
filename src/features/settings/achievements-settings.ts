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
import { getGeneralNotifPrefs, setGeneralNotifPrefs } from "../notifications/notifications";
import { storeLogo } from "../store/store-logos";
import { t } from "../../i18n";
import { achCardHtml, achCardVars, achTagLine } from "../achievement-card/ach-card";
import { playAchCardEntry, playAchCardExit } from "../achievement-card/ach-card-motion";
import {
  clearAchievementEdits,
  editedAchievementGames,
  revertAchievementEditsFromSummaries,
} from "../../core/achievement-edits";
import { achievementStoreName } from "../drawer/ach-editor";
import { askConfirm } from "../../core/confirm-dialog";

/** Active rarity tier in the interactive stage (0=Bronze, 1=Silver, 2=Gold, 3=Ultra, 4=Platinum). */
let previewRarityTier = 2;
/** Incremented on every replay/preset change so CSS animations restart cleanly. */
let stageReplaySeq = 1;

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
    } else if (animStyle === "xbox") {
      // Xbox Series Capsule: signature warm two-tone sonar chime (A4 -> E5) + rare diamond bell tail
      const freqs = [440.0, 659.25, 880.0, 1108.73, 1318.51, 1760.0].slice(0, noteCount);
      freqs.forEach((hz, idx) => {
        const at = now + (idx === 0 ? 0 : idx === 1 ? 0.135 : 0.26 + (idx - 2) * 0.068);
        const osc = ctx.createOscillator();
        const over = ctx.createOscillator();
        const gain = ctx.createGain();
        const overGain = ctx.createGain();
        osc.type = "sine";
        over.type = "triangle";
        osc.frequency.setValueAtTime(hz, at);
        over.frequency.setValueAtTime(hz * 2.0, at);
        overGain.gain.setValueAtTime(0.22, at);
        const decay = 1.45 + rarityTier * 0.12;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(vol * (idx <= 1 ? 0.52 : 0.36), at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
        over.connect(overGain);
        overGain.connect(gain);
        osc.connect(gain);
        gain.connect(masterFilter);
        osc.start(at);
        over.start(at);
        osc.stop(at + decay + 0.05);
        over.stop(at + decay + 0.05);
      });
    } else if (animStyle === "playstation") {
      // PlayStation 5 Trophy: airy celestial synth pad + bright metallic trophy ping (G5 -> D6 -> F#6)
      [196.0, 293.66].forEach((padHz) => {
        const padOsc = ctx.createOscillator();
        const padGain = ctx.createGain();
        padOsc.type = "sine";
        padOsc.frequency.setValueAtTime(padHz, now);
        padGain.gain.setValueAtTime(0.0001, now);
        padGain.gain.linearRampToValueAtTime(vol * 0.28, now + 0.05);
        padGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.75);
        padOsc.connect(padGain);
        padGain.connect(masterFilter);
        padOsc.start(now);
        padOsc.stop(now + 1.8);
      });
      const freqs = [783.99, 1174.66, 1479.98, 1567.98, 1975.53, 2349.32].slice(0, noteCount);
      freqs.forEach((hz, idx) => {
        const at = now + 0.04 + idx * 0.058;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(hz, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(vol * 0.42, at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.25);
        osc.connect(gain);
        gain.connect(masterFilter);
        osc.start(at);
        osc.stop(at + 1.3);
      });
    } else if (animStyle === "epic") {
      // Epic Games EOS Portal: modern crisp ascending triad + warm sub-octave resonance (C4..B5)
      const freqs = [261.63, 392.0, 587.33, 659.25, 783.99, 987.77].slice(0, noteCount);
      freqs.forEach((hz, idx) => {
        const at = now + idx * 0.062;
        const osc = ctx.createOscillator();
        const over = ctx.createOscillator();
        const gain = ctx.createGain();
        const overGain = ctx.createGain();
        osc.type = "triangle";
        over.type = "sine";
        osc.frequency.setValueAtTime(hz, at);
        over.frequency.setValueAtTime(hz * 2.0, at);
        overGain.gain.setValueAtTime(0.3, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(vol * 0.44, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.35);
        over.connect(overGain);
        overGain.connect(gain);
        osc.connect(gain);
        gain.connect(masterFilter);
        osc.start(at);
        over.start(at);
        osc.stop(at + 1.4);
        over.stop(at + 1.4);
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

let stagePreviewTimer: number | null = null;

/**
 * Drives the live preview stage card using the Web Animations API so that
 * opening and closing animations ALWAYS play visibly on every click. The
 * keyframes come from the same module as the in-game toast.
 */
export function runStagePreviewChoreography(mode: "entry" | "exit" | "cycle" = "entry"): void {
  if (stagePreviewTimer !== null) {
    window.clearTimeout(stagePreviewTimer);
    stagePreviewTimer = null;
  }
  window.requestAnimationFrame(() => {
    const card = document.querySelector<HTMLElement>(".ach-stage-screen .ach-hud-toast");
    if (!card) return;

    const animStyle = S.achievementNotificationOptions.animStyle || "prism";
    const exitStyle = S.achievementNotificationOptions.exitStyle || "auto";

    const playEntry = () => {
      if (!card.isConnected) return;
      playAchCardEntry(card, animStyle, previewRarityTier);
    };

    const playExitThenRestore = () => {
      playAchCardExit(card, animStyle, exitStyle, () => {
        stagePreviewTimer = window.setTimeout(playEntry, 220);
      });
    };

    if (mode === "exit") {
      playExitThenRestore();
    } else if (mode === "cycle") {
      playEntry();
      stagePreviewTimer = window.setTimeout(playExitThenRestore, 1550);
    } else {
      playEntry();
    }
  });
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
        tag: achTagLine(0, 11, 34, 64.2),
        title: "First Steps",
        desc: t("settings.achTestDesc"),
        rarityBadge: "%64.2",
        progressPct: 32,
        progressText: "11 / 34 • %32",
        iconName: "trophy",
      };
    case 1:
      return {
        tag: achTagLine(1, 19, 34, 21.8),
        title: "Keen Observer",
        desc: t("settings.achTestDesc"),
        rarityBadge: "%21.8",
        progressPct: 56,
        progressText: "19 / 34 • %56",
        iconName: "trophy",
      };
    case 3:
      return {
        tag: achTagLine(3, 31, 34, 1.8),
        title: "Perfect Sync",
        desc: t("settings.achTestDesc"),
        rarityBadge: "%1.8",
        progressPct: 92,
        progressText: "31 / 34 • %92",
        iconName: "trophy",
      };
    case 4:
      return {
        tag: achTagLine(4, 34, 34, 100),
        title: "Platinum Hunter",
        desc: t("ach.platinumEarnedDesc"),
        rarityBadge: "100% PLATINUM",
        progressPct: 100,
        progressText: "34 / 34 • %100",
        iconName: "trophy",
      };
    default:
      return {
        tag: achTagLine(2, 25, 34, 8.4),
        title: "Master of Time",
        desc: t("settings.achTestDesc"),
        rarityBadge: "%8.4",
        progressPct: 74,
        progressText: "25 / 34 • %74",
        iconName: "trophy",
      };
  }
}

/** Renders the full modern Achievements & Notifications view with 2 distinct sections. */
export function renderAchievementsSettingsView(): string {
  const options = S.achievementNotificationOptions;
  const genPrefs = getGeneralNotifPrefs();
  const soundName = options.customSoundName || t("settings.achDefaultChime");
  const position = options.position || "top-right";
  const currentSize = ["small", "normal", "large"].includes(options.size)
    ? options.size
    : options.size === "compact"
      ? "small"
      : "normal";

  const allowedThemes = ["gold", "rarity", "launcher", "cyber", "emerald", "crimson", "amethyst"];
  const cardTheme = allowedThemes.includes(options.cardTheme) ? options.cardTheme : "gold";

  const allowedStyles = ["prism", "cyber", "shatter", "jackpot", "xbox", "playstation", "epic"];
  const animStyle = allowedStyles.includes(options.animStyle) ? options.animStyle : "prism";

  const allowedExitStyles = ["auto", "collapse", "glide", "fold", "laser", "implode", "zoom"];
  const exitStyle = allowedExitStyles.includes(options.exitStyle || "auto")
    ? (options.exitStyle as string)
    : "auto";

  const palette = achievementCardPalette(cardTheme, previewRarityTier);
  const tierMeta = getPreviewTierMeta(previewRarityTier);

  const generalStoreList: Array<{ id: string; label: string; logoId?: string; ico?: IconName }> = [
    { id: "steam", label: "Steam", logoId: "steam" },
    { id: "epic", label: "Epic Games", logoId: "epic" },
    { id: "gog", label: "GOG Galaxy", logoId: "gog" },
    { id: "ubisoft", label: "Ubisoft Connect", logoId: "ubisoft" },
    { id: "ea", label: "EA App", logoId: "ea" },
    { id: "xbox", label: "Xbox / Game Pass", logoId: "xbox" },
    { id: "amazon", label: "Amazon Games", logoId: "amazon" },
    { id: "custom", label: t("settings.storeCustom"), ico: "gamepad-2" },
  ];

  const generalStoreChips = generalStoreList
    .map((s) => {
      const enabled = !genPrefs.disabledStores.includes(s.id);
      const badgeIco = s.logoId ? storeLogo(s.logoId, 16) : icon(s.ico || "gamepad-2", 16);
      return `
        <button type="button" class="ach-store-chip ${enabled ? "active" : "muted"}" data-act="toggle-gen-store-notif" data-val="${esc(s.id)}">
          <span class="ach-store-chip-left">
            ${badgeIco}
            <span>${esc(s.label)}</span>
          </span>
          <span class="ach-store-chip-status ${enabled ? "on" : "off"}">
            ${esc(enabled ? t("settings.storeNotifOn") : t("settings.storeNotifOff"))}
          </span>
        </button>
      `;
    })
    .join("");

  const achDisabledStores = options.disabledStores || [];
  const achStoreList: Array<{ id: string; label: string; logoId?: string; ico?: IconName }> = [
    { id: "steam", label: "Steam", logoId: "steam" },
    { id: "epic", label: "Epic Games", logoId: "epic" },
    { id: "gog", label: "GOG Galaxy", logoId: "gog" },
    { id: "ubisoft", label: "Ubisoft Connect", logoId: "ubisoft" },
    { id: "ea", label: "EA App", logoId: "ea" },
    { id: "xbox", label: "Xbox / Game Pass", logoId: "xbox" },
    { id: "amazon", label: "Amazon Games", logoId: "amazon" },
    { id: "custom", label: t("settings.storeCustom"), ico: "gamepad-2" },
  ];

  const achStoreChips = achStoreList
    .map((s) => {
      const enabled = !achDisabledStores.includes(s.id);
      const badgeIco = s.logoId ? storeLogo(s.logoId, 16) : icon(s.ico || "gamepad-2", 16);
      return `
        <button type="button" class="ach-store-chip ${enabled ? "active" : "muted"}" data-act="toggle-ach-store-notif" data-val="${esc(s.id)}">
          <span class="ach-store-chip-left">
            ${badgeIco}
            <span>${esc(s.label)}</span>
          </span>
          <span class="ach-store-chip-status ${enabled ? "on" : "off"}">
            ${esc(enabled ? t("settings.storeNotifOn") : t("settings.storeNotifOff"))}
          </span>
        </button>
      `;
    })
    .join("");

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
    { id: "xbox", label: t("settings.achAnimXbox"), ico: "circle" },
    { id: "playstation", label: t("settings.achAnimPlaystation"), ico: "sparkles" },
    { id: "epic", label: t("settings.achAnimEpic"), ico: "layers" },
    { id: "prism", label: t("settings.achAnimPrism"), ico: "maximize-2" },
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

  // Launcher-only achievement state, one row per game. The count comes from the
  // stored edit list, so a game whose page was never opened still shows up.
  const editGames = editedAchievementGames();
  const editRows = editGames
    .map(({ appName, edits }) => {
      const marked = Object.values(edits.items).filter((entry) => entry.state === "unlocked").length;
      const cleared = Object.values(edits.items).filter((entry) => entry.state === "locked").length;
      const facts = [
        achievementStoreName(appName),
        marked > 0 ? t("ach.editsSettingsMarked", { n: marked }) : "",
        cleared > 0 ? t("ach.editsSettingsCleared", { n: cleared }) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(edits.title || appName)}</div>
            <div class="settings-row-desc tabular-nums">${esc(facts)}</div>
          </div>
          <div class="settings-row-control">
            <button type="button" class="btn ghost small" data-act="ach-edits-sync-game" data-id="${esc(appName)}">
              ${icon("refresh", 13)}<span>${esc(t("ach.editsSettingsSync"))}</span>
            </button>
          </div>
        </div>`;
    })
    .join("");

  const editsSection = `
      <div class="ach-section-divider"></div>

      <div class="theme-section-header">
        <div class="theme-section-titles">
          <h3 class="section-title">${esc(t("ach.editsSettingsTitle"))}</h3>
          <p class="page-sub">${esc(t("ach.editsSettingsDesc"))}</p>
        </div>
        ${
          editGames.length > 0
            ? `<div class="theme-section-actions">
                 <button type="button" class="btn ghost small danger" data-act="ach-edits-clear-all">
                   ${icon("trash", 13)}<span>${esc(t("ach.editsSettingsClearAll"))}</span>
                 </button>
               </div>`
            : ""
        }
      </div>

      <div class="list settings-group">
        ${
          editRows ||
          `<div class="row settings-row">
             <div class="row-main">
               <div class="settings-row-desc">${esc(t("ach.editsSettingsEmpty"))}</div>
             </div>
           </div>`
        }
      </div>`;

  return `
    <div class="ach-settings-view">
      <!-- ================================================================
           SECTION 1: BİLDİRİMLER (GENERAL NOTIFICATIONS)
           ================================================================ -->
      <div class="theme-section-header">
        <div class="theme-section-titles">
          <h3 class="section-title">${esc(t("settings.generalNotifHeading"))}</h3>
          <p class="page-sub">${esc(t("settings.generalNotifDesc"))}</p>
        </div>
      </div>

      <div class="list settings-group">
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.genNotifEnabledTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.genNotifEnabledDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-gen-notif-enabled" ${genPrefs.enabled ? "checked" : ""} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.genNotifToastsTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.genNotifToastsDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-gen-notif-toasts" ${genPrefs.toasts ? "checked" : ""} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.genNotifDownloadsTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.genNotifDownloadsDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-gen-notif-downloads" ${genPrefs.downloads ? "checked" : ""} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.genNotifUpdatesTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.genNotifUpdatesDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-gen-notif-updates" ${genPrefs.updates ? "checked" : ""} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <!-- Per-store General Notification Toggles -->
        <div class="row settings-row stacked">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.storeNotifTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.storeNotifDesc"))}</div>
          </div>
          <div class="settings-row-control" style="width: 100%;">
            <div class="ach-store-grid" role="group">
              ${generalStoreChips}
            </div>
          </div>
        </div>
      </div>

      <div class="ach-section-divider"></div>

      <!-- ================================================================
           SECTION 2: BAŞARIM BİLDİRİMLERİ (ACHIEVEMENT NOTIFICATIONS)
           ================================================================ -->
      <div class="theme-section-header">
        <div class="theme-section-titles">
          <h3 class="section-title">${esc(t("settings.achNotifHeading"))}</h3>
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

        <div class="ach-stage-screen pos-${esc(position)} tier-${previewRarityTier}" style="${achCardVars(palette)}--ach-progress:${tierMeta.progressPct}%;">
          <div class="ach-stage-backdrop"></div>
          <div class="ach-stage-aura"></div>

          <!-- The same component the in-game toast renders -->
          ${achCardHtml({
            tag: tierMeta.tag,
            title: tierMeta.title,
            desc: tierMeta.desc,
            tier: previewRarityTier,
            size: currentSize,
            style: animStyle,
            theme: cardTheme,
            palette,
            seq: stageReplaySeq,
            glyph: tierMeta.iconName,
          })}
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

        <!-- Per-store Achievement Notification Toggles -->
        <div class="row settings-row stacked">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achStoreNotifTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achStoreNotifDesc"))}</div>
          </div>
          <div class="settings-row-control" style="width: 100%;">
            <div class="ach-store-grid" role="group">${achStoreChips}</div>
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

      ${editsSection}
    </div>
  `;
}

/** Handles all achievement & notification settings actions from click-router. */
export function handleAchievementsSettingsAction(act: string | undefined, el: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "toggle-gen-notif-enabled": {
      setGeneralNotifPrefs({ enabled: (el as HTMLInputElement).checked });
      render();
      return true;
    }

    case "toggle-gen-notif-toasts": {
      setGeneralNotifPrefs({ toasts: (el as HTMLInputElement).checked });
      render();
      return true;
    }

    case "toggle-gen-notif-downloads": {
      setGeneralNotifPrefs({ downloads: (el as HTMLInputElement).checked });
      render();
      return true;
    }

    case "toggle-gen-notif-updates": {
      setGeneralNotifPrefs({ updates: (el as HTMLInputElement).checked });
      render();
      return true;
    }

    case "toggle-gen-store-notif": {
      const store = (el.dataset.val || "").trim().toLowerCase();
      if (!store) return true;
      const cur = getGeneralNotifPrefs().disabledStores;
      const nextDisabled = cur.includes(store)
        ? cur.filter((s) => s !== store)
        : [...cur, store];
      setGeneralNotifPrefs({ disabledStores: nextDisabled });
      render();
      return true;
    }

    case "toggle-ach-store-notif": {
      const store = (el.dataset.val || "").trim().toLowerCase();
      if (!store) return true;
      const cur = S.achievementNotificationOptions.disabledStores || [];
      const disabledStores = cur.includes(store)
        ? cur.filter((s) => s !== store)
        : [...cur, store];
      const next = { ...S.achievementNotificationOptions, disabledStores };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

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
      const allowed = ["prism", "cyber", "shatter", "jackpot", "xbox", "playstation", "epic"];
      const animStyle = allowed.includes(el.dataset.val ?? "") ? el.dataset.val! : "prism";
      const next = { ...S.achievementNotificationOptions, animStyle, exitStyle: "auto" };
      S.achievementNotificationOptions = next;
      stageReplaySeq++;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      runStagePreviewChoreography("entry");
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
      runStagePreviewChoreography("entry");
      return true;
    }

    case "set-ach-preview-tier": {
      const tier = Math.max(0, Math.min(4, Number(el.dataset.val ?? 2)));
      previewRarityTier = Number.isNaN(tier) ? 2 : tier;
      stageReplaySeq++;
      render();
      runStagePreviewChoreography("entry");
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
      runStagePreviewChoreography("cycle");
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
      runStagePreviewChoreography("entry");
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
      runStagePreviewChoreography("entry");
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
      const meta = getPreviewTierMeta(previewRarityTier);
      void achievementTestNotification(
        meta.title,
        meta.desc,
        previewRarityTier,
      ).catch((e) => toast(String(e), "err"));
      return true;
    }

    case "ach-edits-sync-game": {
      const appName = (el.dataset.id || "").trim();
      if (!appName) return true;
      void askConfirm({
        title: t("ach.editsSettingsSync"),
        body: t("ach.editsSettingsConfirm"),
        confirm: t("ach.editsSettingsSync"),
        cancel: t("common.cancel"),
      }).then((ok) => {
        if (!ok) return;
        dropLocalEdits(appName);
        toast(t("ach.editsSettingsClearedAll"), "ok");
        render();
      });
      return true;
    }

    case "ach-edits-clear-all": {
      const games = editedAchievementGames();
      if (games.length === 0) return true;
      void askConfirm({
        title: t("ach.editsSettingsClearAll"),
        body: t("ach.editsSettingsClearAllBody"),
        confirm: t("common.delete"),
        cancel: t("common.cancel"),
      }).then((ok) => {
        if (!ok) return;
        for (const { appName } of games) dropLocalEdits(appName);
        toast(t("ach.editsSettingsClearedAll"), "ok");
        render();
      });
      return true;
    }

    default:
      return false;
  }
}

/**
 * Drops one game's launcher-only edits and takes its stored delta back out of
 * the in-memory summaries. The cached page data is thrown away so the next
 * open reads the store again instead of re-painting the edited answer.
 */
function dropLocalEdits(appName: string): void {
  revertAchievementEditsFromSummaries(appName, S.epicAchSummaries);
  clearAchievementEdits(appName);
  S.loadedAchievements.delete(appName);
}

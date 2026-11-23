/**
 * Achievements & Notifications settings view and live interactive stage.
 *
 * Provides a live monitor stage showing the real-time notification toast at the
 * user's chosen screen position, visual position selector, theme presets,
 * rarity-tier escalation preview, audio chime audition, volume/duration
 * controls, and toggle switches.
 */

import { icon, type IconName } from "../../core/icons";
import { openEpicModal, render } from "../../core/render";
import { S } from "../../core/state";
import { achievementCardPalette, syncAchievementCardTheme } from "../../core/achievement-card-theme";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import {
  achievementAuditionSound,
  achievementClearCustomSound,
  achievementClearRareCustomSound,
  achievementGetNotificationOptions,
  achievementPickCustomSound,
  achievementPickRareCustomSound,
  achievementSetNotificationOptions,
  achievementTestNotification,
} from "../../steam";
import { getGeneralNotifPrefs, setGeneralNotifPrefs } from "../notifications/notifications";
import { storeLogo } from "../store/store-logos";
import { t } from "../../i18n";
import { achCardHtml, achCardVars, achTagParts } from "../achievement-card/ach-card";
import {
  achMotionDirection,
  achMotionVerticalDirection,
  playAchCardEntry,
  playAchCardExit,
} from "../achievement-card/ach-card-motion";
import { sortedAchievementHistory } from "../../core/achievement-history";
import {
  clearAchievementEdits,
  editedAchievementGames,
  revertAchievementEditsFromSummaries,
} from "../../core/achievement-edits";
import { achievementStoreName } from "../drawer/ach-editor";
import { askConfirm } from "../../core/confirm-dialog";
import { coverThumb } from "../../core/game-view";
import { summaryOf } from "../../core/selectors";
import { setView } from "../store/store-view";

/** Active rarity tier in the interactive stage (0=Bronze, 1=Silver, 2=Gold, 3=Ultra, 4=Platinum). */
let previewRarityTier = 2;

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
 * Web Audio fallback for the Settings audition: the same quiet two-note bell
 * the native worker synthesizes, so the preview never promises a sound the
 * notification will not make. Reuses one AudioContext and silences a previous
 * preview so rapid clicks never overlap.
 */
function playWebAudioAchievementChime(volumePct = 100, rarityTier = previewRarityTier): void {
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
    const vol = (Math.max(0, Math.min(100, volumePct)) / 100) * 0.22;
    if (vol <= 0.001) return;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(1, now);
    activeMasterGain = masterGain;

    // The same soft ceiling the native chime has: two notes and a light octave,
    // no sub-bass thump and no shimmer choir.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(rarityTier >= 3 ? 7200 : 6000, now);
    filter.Q.setValueAtTime(0.6, now);
    filter.connect(masterGain);
    masterGain.connect(ctx.destination);

    const notes = rarityTier >= 2 ? [880.0, 1318.51, 1760.0] : [880.0, 1318.51];
    const decay = 0.9 + Math.min(4, Math.max(0, rarityTier)) * 0.08;
    notes.forEach((hz, index) => {
      const at = now + index * 0.105;
      for (const [mult, weight] of [[1, 1], [2, 0.22]] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(hz * mult, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(vol * weight, at + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + decay * (mult > 1 ? 0.55 : 1));
        osc.connect(gain);
        gain.connect(filter);
        osc.start(at);
        osc.stop(at + decay + 0.05);
      }
    });
  } catch {
    /* browser audio blocked or unavailable */
  }
}

/**
 * Auditions the sound the player will actually hear. The native worker plays
 * the real custom file on every desktop; the Web Audio chime is the fallback
 * when the command itself cannot run.
 */
function previewAchievementSound(tier = previewRarityTier): void {
  const options = S.achievementNotificationOptions;
  void achievementAuditionSound(options, tier).catch(() => {
    playWebAudioAchievementChime(options.volume, tier);
  });
}

let stagePreviewTimer: number | null = null;

/**
 * A real achievement picture for the preview: the newest unlock in the local
 * history, so the stage shows the same art path a live card uses. A launcher
 * with no recorded unlock yet keeps the trophy fallback.
 */
function previewAchievementArt(): string | undefined {
  const icon = sortedAchievementHistory()
    .map((entry) => entry.icon.trim())
    .find((value) => value.length > 0);
  return icon || undefined;
}

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
  // An art URL that cannot load must reveal the trophy underneath instead of
  // leaving an empty tile.
  document
    .querySelectorAll<HTMLImageElement>(".ach-stage-screen .ach-hud-ach-icon")
    .forEach((image) => {
      image.onerror = () => image.remove();
    });
  window.requestAnimationFrame(() => {
    const card = document.querySelector<HTMLElement>(".ach-stage-screen .ach-hud-toast");
    if (!card) return;
    const options = S.achievementNotificationOptions;
    const style = options.animStyle;
    const direction = achMotionDirection(options.position);
    const vDir = achMotionVerticalDirection(options.position);

    const playEntry = () => {
      if (!card.isConnected) return;
      playAchCardEntry(card, style, direction, vDir);
    };

    const playExitThenRestore = () => {
      playAchCardExit(card, style, direction, () => {
        stagePreviewTimer = window.setTimeout(playEntry, 240);
      }, vDir);
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

/** The five stage cards: the same counts the test notification sends. */
const PREVIEW_TIERS = [
  { title: "First Steps", unlocked: 11, total: 34, percent: 64.2 },
  { title: "Keen Observer", unlocked: 19, total: 34, percent: 21.8 },
  { title: "Master of Time", unlocked: 25, total: 34, percent: 8.4 },
  { title: "Perfect Sync", unlocked: 31, total: 34, percent: 1.8 },
  { title: "Platinum Hunter", unlocked: 34, total: 34, percent: 100 },
] as const;

function getPreviewTierMeta(tier: number): {
  tagLabel: string;
  tagMeta: string;
  title: string;
  desc: string;
  progressPct: number;
  iconName: IconName;
} {
  const index = Math.max(0, Math.min(PREVIEW_TIERS.length - 1, tier));
  const item = PREVIEW_TIERS[index];
  const tag = achTagParts(index, item.unlocked, item.total, item.percent);
  return {
    tagLabel: tag.label,
    tagMeta: tag.meta,
    title: item.title,
    desc: index === 4 ? t("ach.platinumEarnedDesc") : t("settings.achTestDesc"),
    progressPct: Math.round((item.unlocked / item.total) * 100),
    iconName: "trophy",
  };
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

  const allowedThemes = ["gold", "rarity", "launcher", "cyber", "emerald", "crimson", "amethyst", "custom"];
  const cardTheme = allowedThemes.includes(options.cardTheme) ? options.cardTheme : "rarity";
  const customAccent = options.customAccent || "#00f0ff";

  // One choice covers the whole card: opening and closing are the same motion.
  const allowedMotions = ["minimal", "slide", "soft", "pop", "spring", "drift", "drop"];
  const animStyle = allowedMotions.includes(options.animStyle) ? options.animStyle : "minimal";

  const opacity = typeof options.opacity === "number" ? Math.max(50, Math.min(100, options.opacity)) : 100;
  const offset = typeof options.offset === "number" ? Math.max(0, Math.min(80, options.offset)) : 18;
  const rareSoundName = options.rareCustomSoundName || t("settings.achRareSoundSame");

  const palette = achievementCardPalette(cardTheme, previewRarityTier, customAccent);
  const tierMeta = getPreviewTierMeta(previewRarityTier);
  const previewArt = previewAchievementArt();

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

  // Rarity threshold: every unlock, or only the rare ones. A store without a
  // rarity figure is never filtered out, so the row explains that too.
  const minRarity = [0, 5, 10, 25].includes(Number(options.minRarityPercent))
    ? Number(options.minRarityPercent)
    : 0;
  const rarityButtons = [
    { value: 0, label: t("settings.achRarityAll") },
    { value: 25, label: t("settings.achRarityAtMost", { n: 25 }) },
    { value: 10, label: t("settings.achRarityAtMost", { n: 10 }) },
    { value: 5, label: t("settings.achRarityAtMost", { n: 5 }) },
  ]
    .map(
      (mode) => `
        <button type="button" class="${minRarity === mode.value ? "active" : ""}" data-act="set-ach-min-rarity" data-val="${mode.value}">
          ${esc(mode.label)}
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

  const opacityButtons = [60, 75, 90, 100]
    .map(
      (val) => `
        <button type="button" class="${opacity === val ? "active" : ""}" data-act="set-ach-opacity" data-val="${val}">
          %${val}
        </button>
      `,
    )
    .join("");

  const animStyleOptions: Array<{ id: string; label: string; ico: IconName }> = [
    { id: "minimal", label: t("settings.achAnimMinimal"), ico: "square" },
    { id: "slide", label: t("settings.achAnimSlide"), ico: "arrow-right" },
    { id: "soft", label: t("settings.achAnimSoft"), ico: "circle" },
    { id: "pop", label: t("settings.achAnimPop"), ico: "sparkles" },
    { id: "spring", label: t("settings.achAnimSpring"), ico: "zap" },
    { id: "drift", label: t("settings.achAnimDrift"), ico: "activity" },
    { id: "drop", label: t("settings.achAnimDrop"), ico: "chevron-down" },
  ];

  const animStyleButtons = animStyleOptions
    .map(
      (opt) => `
        <button type="button" class="ach-style-chip ${animStyle === opt.id ? "active" : ""}" data-act="set-ach-anim" data-val="${opt.id}">
          ${icon(opt.ico, 13)}
          <span>${esc(opt.label)}</span>
        </button>
      `,
    )
    .join("");

  const offsetButtons = [
    [0, "0px"],
    [18, "18px"],
    [36, "36px"],
    [60, "60px"],
  ]
    .map(
      ([val, label]) => `
        <button type="button" class="${offset === val ? "active" : ""}" data-act="set-ach-offset" data-val="${val}">
          ${label}
        </button>
      `,
    )
    .join("");

  const cardThemeButtons = [
    { id: "rarity", label: t("settings.achCardThemeRarity"), swatch: "conic-gradient(#cd7f32, #94a3b8, #f59e0b, #22d3ee, #e879f9)" },
    { id: "gold", label: t("settings.achCardThemeGold"), swatch: "#f59e0b" },
    { id: "launcher", label: t("settings.achCardThemeLauncher"), swatch: "var(--accent)" },
    { id: "cyber", label: t("settings.achCardThemeCyber"), swatch: "#00f0ff" },
    { id: "emerald", label: t("settings.achCardThemeEmerald"), swatch: "#10b981" },
    { id: "crimson", label: t("settings.achCardThemeCrimson"), swatch: "#f43f5e" },
    { id: "amethyst", label: t("settings.achCardThemeAmethyst"), swatch: "#a855f7" },
    { id: "custom", label: t("settings.achCardThemeCustom"), swatch: customAccent },
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

  const customAccentPresets = ["#00f0ff", "#ff007f", "#76ff03", "#a855f7", "#ffab00", "#ff1744", "#3b82f6"];
  const presetDots = customAccentPresets
    .map(
      (c) => `
        <button type="button" class="ach-preset-dot ${customAccent.toLowerCase() === c.toLowerCase() ? "active" : ""}" data-act="set-ach-custom-accent" data-val="${c}" style="background: ${c};" title="${c}"></button>
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
  // The portrait and the row body are one button: the row opens that game's
  // achievements tab, while Sync stays its own action.
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
      const summary = summaryOf(appName);
      const title = edits.title || summary?.title || appName;
      // The library's own cover fallback chain: custom cover, Steam resolver,
      // Epic URL rewrite and a trophy-free placeholder.
      const thumb = summary
        ? coverThumb(summary, "ach-edits-thumb")
        : `<span class="ach-edits-thumb art-thumb-placeholder">${icon("gamepad-2", 16)}</span>`;
      return `
        <div class="row settings-row ach-edits-row">
          <button type="button" class="ach-edits-open" data-act="ach-edits-open-game" data-id="${esc(appName)}"${summary ? "" : " disabled"} title="${esc(t("drawer.achievements"))}">
            ${thumb}
            <span class="row-main">
              <span class="settings-row-title">${esc(title)}</span>
              <span class="settings-row-desc tabular-nums">${esc(facts)}</span>
            </span>
          </button>
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

        <div class="ach-stage-screen pos-${esc(position)}" style="${achCardVars(palette, opacity)} padding: ${offset}px;">
          <!-- The same component the in-game toast renders -->
          ${achCardHtml({
            tagLabel: tierMeta.tagLabel,
            tagMeta: tierMeta.tagMeta,
            title: tierMeta.title,
            desc: tierMeta.desc,
            size: currentSize,
            palette,
            glyph: tierMeta.iconName,
            iconSrc: previewArt,
            opacity,
            hideTag: options.hideTag,
            hideDesc: options.hideDesc,
            showProgress: options.showProgress,
            progressPct: tierMeta.progressPct,
          })}
        </div>
      </div>

      <!-- Controls Group -->
      <div class="list settings-group" style="margin-top: 18px;">
        <!-- One animation for the whole card -->
        <div class="row settings-row stacked">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achAnimTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achAnimDesc"))}</div>
          </div>
          <div class="settings-row-control" style="width: 100%;">
            <div class="ach-style-grid" role="group">${animStyleButtons}</div>
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

        <!-- Rarity threshold -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achRarityTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achRarityDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <div class="seg" role="group">${rarityButtons}</div>
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
            ${
              cardTheme === "custom"
                ? `
              <div class="ach-custom-accent-row">
                <span class="settings-row-desc" style="margin: 0; font-size: 12px;">${esc(t("settings.achCustomAccentTitle"))}:</span>
                <input type="color" class="ach-color-input" data-act="set-ach-custom-accent" value="${esc(customAccent)}" title="${esc(t("settings.achCustomAccentTitle"))}" />
                <span class="settings-value tabular-nums" style="font-size: 12px; margin-right: 6px;">${esc(customAccent)}</span>
                <div style="display: flex; gap: 6px; align-items: center; margin-left: auto;">
                  ${presetDots}
                </div>
              </div>`
                : ""
            }
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

        <!-- Opacity Selector -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achOpacityTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achOpacityDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <div class="seg" role="group">${opacityButtons}</div>
          </div>
        </div>

        <!-- Screen Margin Offset Selector -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achOffsetTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achOffsetDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <div class="seg" role="group">${offsetButtons}</div>
          </div>
        </div>

        <!-- Progress Bar Display Toggle -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achShowProgressTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achShowProgressDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-ach-show-progress" ${options.showProgress ? "checked" : ""} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <!-- Content Visibility Toggles -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achHideTagTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achHideTagDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-ach-hide-tag" ${options.hideTag ? "checked" : ""} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achHideDescTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achHideDescDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-ach-hide-desc" ${options.hideDesc ? "checked" : ""} />
              <span class="track"></span>
            </label>
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

        <!-- Rare & Platinum Sound row -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achRareSoundTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achRareSoundDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <div class="ach-sound-control-wrap">
              <span class="ach-sound-file-label" title="${esc(rareSoundName)}">${esc(rareSoundName)}</span>
              <button type="button" class="btn ghost small" data-act="ach-audition-rare-sound" title="${esc(t("settings.achAuditionBtn"))}">
                ${icon("volume-2", 13)} <span>${esc(t("settings.achAuditionBtn"))}</span>
              </button>
              <button type="button" class="btn ghost small" data-act="ach-pick-rare-sound">
                ${icon("folder", 13)} <span>${esc(t("settings.achSoundChoose"))}</span>
              </button>
              ${options.rareCustomSound ? `
                <button type="button" class="btn ghost small danger" data-act="ach-clear-rare-sound" title="${esc(t("settings.achSoundClear"))}">
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

        <!-- Souvenir screenshot on unlock -->
        <div class="row settings-row">
          <div class="row-main">
            <div class="settings-row-title">${esc(t("settings.achSouvenirTitle"))}</div>
            <div class="settings-row-desc">${esc(t("settings.achSouvenirDesc"))}</div>
          </div>
          <div class="settings-row-control">
            <label class="switch">
              <input type="checkbox" data-act="toggle-ach-souvenir" ${options.unlockScreenshots ? "checked" : ""} />
              <span class="track"></span>
            </label>
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

    case "set-ach-min-rarity": {
      const requested = Number(el.dataset.val);
      const minRarityPercent = [0, 5, 10, 25].includes(requested) ? requested : 0;
      const next = { ...S.achievementNotificationOptions, minRarityPercent };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

    case "toggle-ach-souvenir": {
      const next = {
        ...S.achievementNotificationOptions,
        unlockScreenshots: (el as HTMLInputElement).checked,
      };
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

    case "set-ach-anim": {
      const allowed = ["minimal", "slide", "soft", "pop", "spring", "drift", "drop"];
      const animStyle = allowed.includes(el.dataset.val ?? "") ? el.dataset.val! : "minimal";
      const next = { ...S.achievementNotificationOptions, animStyle };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      runStagePreviewChoreography("entry");
      return true;
    }

    case "set-ach-card-theme": {      const allowed = ["gold", "rarity", "launcher", "cyber", "emerald", "crimson", "amethyst", "custom"];
      const cardTheme = allowed.includes(el.dataset.val ?? "") ? el.dataset.val! : "rarity";
      const next = { ...S.achievementNotificationOptions, cardTheme };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      syncAchievementCardTheme();
      render();
      runStagePreviewChoreography("entry");
      return true;
    }

    case "set-ach-custom-accent": {
      const val = (el.dataset.val || (el as HTMLInputElement).value || "").trim();
      if (!val) return true;
      const next = { ...S.achievementNotificationOptions, customAccent: val, cardTheme: "custom" };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      runStagePreviewChoreography("entry");
      return true;
    }

    case "set-ach-opacity": {
      const opacity = Math.max(50, Math.min(100, Number(el.dataset.val) || 100));
      const next = { ...S.achievementNotificationOptions, opacity };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

    case "set-ach-offset": {
      const offset = Math.max(0, Math.min(80, Number(el.dataset.val) || 18));
      const next = { ...S.achievementNotificationOptions, offset };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

    case "toggle-ach-show-progress": {
      const next = {
        ...S.achievementNotificationOptions,
        showProgress: (el as HTMLInputElement).checked,
      };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      runStagePreviewChoreography("entry");
      return true;
    }

    case "toggle-ach-hide-tag": {
      const next = {
        ...S.achievementNotificationOptions,
        hideTag: (el as HTMLInputElement).checked,
      };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      runStagePreviewChoreography("entry");
      return true;
    }

    case "toggle-ach-hide-desc": {
      const next = {
        ...S.achievementNotificationOptions,
        hideDesc: (el as HTMLInputElement).checked,
      };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      runStagePreviewChoreography("entry");
      return true;
    }

    case "set-ach-preview-tier": {
      const tier = Math.max(0, Math.min(4, Number(el.dataset.val ?? 2)));
      previewRarityTier = Number.isNaN(tier) ? 2 : tier;
      render();
      runStagePreviewChoreography("entry");
      if (S.achievementNotificationOptions.sound) {
        previewAchievementSound();
      }
      return true;
    }

    case "ach-replay-stage": {
      render();
      runStagePreviewChoreography("entry");
      if (S.achievementNotificationOptions.sound) {
        previewAchievementSound();
      }
      return true;
    }

    case "set-ach-size": {
      const allowed = ["small", "normal", "large"];
      const size = allowed.includes(el.dataset.val ?? "") ? el.dataset.val! : "normal";
      const next = { ...S.achievementNotificationOptions, size };
      S.achievementNotificationOptions = next;
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
      previewAchievementSound();
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
      previewAchievementSound();
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

    case "ach-audition-rare-sound": {
      previewAchievementSound(4);
      return true;
    }

    case "ach-pick-rare-sound": {
      void (async () => {
        try {
          const name = await achievementPickRareCustomSound();
          if (!name) return;
          S.achievementNotificationOptions = await achievementGetNotificationOptions();
          render();
        } catch (e) {
          toast(String(e), "err");
        }
      })();
      return true;
    }

    case "ach-clear-rare-sound": {
      void (async () => {
        try {
          await achievementClearRareCustomSound();
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
      // The test card paints the same picture the stage shows, so the preview
      // and the in-game notification stay one design.
      void achievementTestNotification(
        meta.title,
        meta.desc,
        previewRarityTier,
        undefined,
        undefined,
        previewAchievementArt(),
      ).catch((e) => toast(String(e), "err"));
      return true;
    }

    case "ach-edits-open-game": {
      const appName = (el.dataset.id || "").trim();
      if (!appName || !summaryOf(appName)) return true;
      // The game page lives over the library: any settings re-render would
      // close a hub opened there. Land on the tab the edits belong to.
      setView("library");
      render();
      openEpicModal(appName, true, true, "achievements");
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

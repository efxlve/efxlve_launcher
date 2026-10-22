/**
 * Modern Achievements & Notifications settings view and live interactive stage.
 *
 * Provides a live monitor stage showing the real-time notification toast at the
 * user's chosen screen position, visual position selector, audio chime audition,
 * volume/duration controls, and toggle switches.
 */

import { icon } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
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

/** Synthesizes the warm velvet console chime live in the browser using Web Audio. */
function playWebAudioAchievementChime(volumePct = 100): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const vol = (Math.max(0, Math.min(100, volumePct)) / 100) * 0.4;

    // Warm D-major acoustic bell harmonics matching scripts/achievement-chime.mjs
    const notes = [
      { hz: 293.665, at: 0.0, gain: 0.85, decay: 1.4 },   // D4
      { hz: 440.000, at: 0.08, gain: 0.75, decay: 1.3 },  // A4
      { hz: 587.330, at: 0.16, gain: 0.90, decay: 1.5 },  // D5
      { hz: 739.989, at: 0.24, gain: 0.70, decay: 1.2 },  // F#5
    ];

    // Master lowpass filter to eliminate ear-piercing high frequencies
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2400, now);
    filter.Q.setValueAtTime(0.7, now);
    filter.connect(ctx.destination);

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(note.hz, now + note.at);

      const startTime = now + note.at;
      // Soft 20ms attack curve
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(vol * note.gain, startTime + 0.022);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + note.decay);

      osc.connect(gain);
      gain.connect(filter);

      osc.start(startTime);
      osc.stop(startTime + note.decay + 0.05);
    }
  } catch {
    /* browser audio blocked or unavailable */
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

  // Position anchors for the visual monitor pad
  const positions: Array<{ id: string; label: string; iconName: string }> = [
    { id: "top-left", label: t("settings.achPositionTopLeft"), iconName: "arrow-up-left" },
    { id: "center-top", label: t("settings.achPositionCenterTop"), iconName: "arrow-up" },
    { id: "top-right", label: t("settings.achPositionTopRight"), iconName: "arrow-up-right" },
    { id: "bottom-left", label: t("settings.achPositionBottomLeft"), iconName: "arrow-down-left" },
    { id: "center-bottom", label: t("settings.achPositionCenterBottom"), iconName: "arrow-down" },
    { id: "bottom-right", label: t("settings.achPositionBottomRight"), iconName: "arrow-down-right" },
  ];

  const positionPadButtons = positions.map((p) => {
    const isCurrent = position === p.id;
    return `
      <button type="button" class="ach-pad-btn ${isCurrent ? "active" : ""}" data-act="set-ach-position" data-val="${esc(p.id)}" title="${esc(p.label)}">
        <span class="ach-pad-dot"></span>
        <span class="ach-pad-label">${esc(p.label)}</span>
        ${isCurrent ? `<span class="ach-pad-check">${icon("check", 11)}</span>` : ""}
      </button>
    `;
  }).join("");

  return `
    <div class="ach-settings-view">
      <!-- Section Header -->
      <div class="theme-section-header">
        <div class="theme-section-titles">
          <h3 class="section-title">${esc(t("settings.secAchievements"))}</h3>
          <p class="page-sub">${esc(t("settings.achNotifyDesc"))}</p>
        </div>
        <div class="theme-section-actions">
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
          <span class="settings-value">${esc(t("settings.achPositionTitle"))}: <strong>${esc(position)}</strong></span>
        </div>

        <div class="ach-stage-screen pos-${esc(position)}">
          <div class="ach-stage-backdrop"></div>
          
          <!-- Next-Gen Console Toast Card -->
          <div class="ach-hud-toast size-${esc(currentSize)}">
            <div class="ach-hud-gold-bar"></div>
            <div class="ach-hud-medallion">
              <span class="ach-hud-trophy-ico">${icon("trophy", 16)}</span>
            </div>
            <div class="ach-hud-text-col">
              <span class="ach-hud-tag">${esc(t("settings.achUnlockedTag"))}</span>
              <span class="ach-hud-title">Platin Avcısı</span>
              <span class="ach-hud-desc">${esc(t("settings.achTestDesc"))}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Controls Group -->
      <div class="list settings-group" style="margin-top: 18px;">
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
              <button type="button" class="btn ghost small" data-act="ach-audition-sound" title="Sesi Önizle">
                ${icon("volume-2", 13)} <span>Dinle</span>
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

    case "set-ach-size": {
      const allowed = ["small", "normal", "large"];
      const size = allowed.includes(el.dataset.val ?? "") ? el.dataset.val! : "normal";
      const next = { ...S.achievementNotificationOptions, size };
      S.achievementNotificationOptions = next;
      void achievementSetNotificationOptions(next).catch((e) => toast(String(e), "err"));
      render();
      return true;
    }

    case "set-ach-position": {
      const allowed = ["top-left", "center-top", "top-right", "bottom-left", "center-bottom", "bottom-right"];
      const position = allowed.includes(el.dataset.val ?? "") ? el.dataset.val! : "top-right";
      const next = { ...S.achievementNotificationOptions, position };
      S.achievementNotificationOptions = next;
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
      playWebAudioAchievementChime(volume);
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
      playWebAudioAchievementChime(S.achievementNotificationOptions.volume);
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
      playWebAudioAchievementChime(S.achievementNotificationOptions.volume);
      void achievementTestNotification(
        "Platin Avcısı",
        t("settings.achTestDesc"),
        t("settings.achUnlockedTag"),
      ).catch((e) => toast(String(e), "err"));
      return true;
    }

    default:
      return false;
  }
}

/**
 * Power & Quick System Hub for Stage Mode.
 *
 * Dedicated console power drawer designed for handheld gaming PCs and couch play.
 * Provides instant Sleep (suspend), Shut down, Desktop Mode return, and
 * fast on-the-fly volume adjustment with audio/haptic feedback.
 */

import { invoke } from "@tauri-apps/api/core";
import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { stageBatteryInfo } from "./stage-battery";
import { stageFeedback } from "./stage-sound";
import { setStageSound, setStageSoundVolume } from "./stage-state";
import { stageOpenDesktop } from "./stage-actions";

export function stageOpenPowerSheet(): void {
  stageFeedback("select");
  S.stage.powerOpen = true;
  S.stage.quickMenu = false;
  S.stage.searchOpen = false;
  S.stage.browserOpen = false;
  S.stage.spotifyOpen = false;
  S.stage.discordOpen = false;
  S.stage.focusKey = "power:sleep";
  scheduleRender();
}

export function stageClosePowerSheet(): void {
  stageFeedback("back");
  S.stage.powerOpen = false;
  S.stage.focusKey = "";
  scheduleRender();
}

export async function stageSleepDevice(): Promise<void> {
  stageFeedback("launch");
  await invoke("app_power_action", { action: "sleep" }).catch(() => undefined);
}

export async function stageShutdownDevice(): Promise<void> {
  stageFeedback("launch");
  await invoke("app_power_action", { action: "shutdown" }).catch(() => undefined);
}

export function stageQuickVolume(delta: number): void {
  const current = S.stage.soundVolume;
  const next = Math.max(0, Math.min(100, Math.round((current + delta) / 10) * 10));
  setStageSoundVolume(next);
  if (!S.stage.sound && next > 0) {
    setStageSound(true);
  }
  stageFeedback("select");
  scheduleRender();
}

export function stageToggleQuickMute(): void {
  const next = !S.stage.sound;
  setStageSound(next);
  stageFeedback(next ? "select" : "back");
  scheduleRender();
}

export function renderStagePowerSheet(entered: boolean): string {
  const battery = stageBatteryInfo();
  const soundOn = S.stage.sound;
  const vol = S.stage.soundVolume;
  const controllerName = S.stage.controllerConnected ? S.stage.controllerName || t("stage.controller") : t("stage.noController");

  return `<div class="stage-overlay stage-power-sheet${entered ? " stage-overlay-enter" : ""}">
    <div class="stage-power-panel" role="dialog" aria-modal="true" aria-label="${esc(t("stage.navSettings"))}">
      <div class="stage-power-head">
        <div class="stage-power-title-wrap">
          <span class="stage-power-brand">${icon("zap", 24)}</span>
          <div>
            <h2 class="stage-power-title">${esc(t("stage.navSettings"))}</h2>
            <span class="stage-power-subtitle">${esc(controllerName)}</span>
          </div>
        </div>
        <button type="button" class="stage-icon-btn" data-stage-act="close-power-sheet" data-gp-item data-gp-key="power:close" aria-label="${esc(t("common.close"))}">
          ${icon("x", 20)}
        </button>
      </div>

      ${battery.available ? `
        <div class="stage-power-battery-card">
          <div class="stage-p-bat-left">
            <span class="stage-p-bat-icon ${battery.charging ? "is-charging" : ""}">${icon(battery.charging ? "battery-charging" : "battery", 28)}</span>
            <div>
              <strong class="stage-p-bat-level tabular-nums">${battery.level}%</strong>
              <small>${battery.charging ? "Charging" : esc(t("common.battery"))}</small>
            </div>
          </div>
          <div class="stage-p-bat-meter">
            <span class="stage-p-bat-fill ${battery.level <= 15 ? "is-danger" : battery.level <= 25 ? "is-warn" : ""}" style="width: ${battery.level}%"></span>
          </div>
        </div>
      ` : ""}

      <div class="stage-power-volume-card">
        <div class="stage-p-vol-head">
          <span class="stage-kicker">${icon(soundOn ? "volume-2" : "volume-x", 14)} ${esc(t("stage.settingsVolume"))}</span>
          <span class="stage-p-vol-val tabular-nums">${soundOn ? `${vol}%` : "Muted"}</span>
        </div>
        <div class="stage-p-vol-controls" data-gp-row>
          <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="power-mute" data-gp-item data-gp-key="power:mute">
            ${icon(soundOn ? "volume-x" : "volume-2", 16)} <span>${soundOn ? "Mute" : "Unmute"}</span>
          </button>
          <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="power-vol-down" data-gp-item data-gp-key="power:voldown">
            <span>- 10%</span>
          </button>
          <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="power-vol-up" data-gp-item data-gp-key="power:volup">
            <span>+ 10%</span>
          </button>
        </div>
      </div>

      <div class="stage-power-grid" data-gp-row>
        <button
          type="button"
          class="stage-power-card is-primary"
          data-stage-act="power-sleep"
          data-gp-item
          data-gp-key="power:sleep"
          data-gp-default
        >
          <span class="stage-power-card-icon">${icon("clock", 24)}</span>
          <div class="stage-power-card-text">
            <strong>${esc(t("settings.finishActionSleep"))}</strong>
            <span>Suspend handheld / PC</span>
          </div>
        </button>

        <button
          type="button"
          class="stage-power-card"
          data-stage-act="power-desktop"
          data-gp-item
          data-gp-key="power:desktop"
        >
          <span class="stage-power-card-icon">${icon("monitor", 24)}</span>
          <div class="stage-power-card-text">
            <strong>${esc(t("stage.openDesktop"))}</strong>
            <span>Switch to Window Mode</span>
          </div>
        </button>

        <button
          type="button"
          class="stage-power-card is-danger"
          data-stage-act="power-shutdown"
          data-gp-item
          data-gp-key="power:shutdown"
        >
          <span class="stage-power-card-icon is-danger">${icon("alert-triangle", 24)}</span>
          <div class="stage-power-card-text">
            <strong>${esc(t("settings.finishActionShutdown"))}</strong>
            <span>Turn off device</span>
          </div>
        </button>
      </div>

      <div class="stage-power-foot">
        <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="close-power-sheet" data-gp-item data-gp-key="power:cancel">
          ${icon("x", 16)} <span>${esc(t("common.close"))}</span>
        </button>
      </div>
    </div>
  </div>`;
}

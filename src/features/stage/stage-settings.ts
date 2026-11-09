/**
 * Stage settings: the few controls a couch player changes often, with the
 * full desktop settings one button away. Every control is a large switch or a
 * row of choices; nothing here is a desktop-sized form.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import type { StageSettingsTab } from "../../core/types";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { stageBatteryLabel, stageKindName } from "./stage-ui";

const TABS: StageSettingsTab[] = ["general", "controller", "appearance", "about"];

function tabLabel(tab: StageSettingsTab): string {
  switch (tab) {
    case "controller": return t("stage.settingsTabController");
    case "appearance": return t("stage.settingsTabAppearance");
    case "about": return t("stage.settingsTabAbout");
    default: return t("stage.settingsTabGeneral");
  }
}

function tabs(): string {
  return `<div class="stage-settings-tabs" role="tablist">
    ${TABS.map((tab) => `<button type="button" role="tab" aria-selected="${S.stage.settingsTab === tab}" class="stage-settings-tab${S.stage.settingsTab === tab ? " active" : ""}" data-stage-act="set-settings-tab" data-tab="${tab}" data-gp-item data-gp-key="settings-tab:${tab}">${esc(tabLabel(tab))}</button>`).join("")}
  </div>`;
}

function row(
  key: string,
  title: string,
  desc: string,
  control: string,
): string {
  return `<div class="stage-setting-row" data-gp-item data-gp-key="set:${esc(key)}">
    <span class="stage-setting-copy">
      <strong>${esc(title)}</strong>
      <small>${esc(desc)}</small>
    </span>
    <span class="stage-setting-control">${control}</span>
  </div>`;
}

function toggleControl(on: boolean): string {
  return `<span class="stage-switch${on ? " is-on" : ""}" aria-hidden="true"><span></span></span>`;
}

function stageToggle(key: string, title: string, desc: string, on: boolean, act: string): string {
  return `<button type="button" class="stage-setting-row is-button" role="switch" aria-checked="${on}" data-stage-act="${esc(act)}" data-gp-item data-gp-key="set:${esc(key)}">
    <span class="stage-setting-copy"><strong>${esc(title)}</strong><small>${esc(desc)}</small></span>
    <span class="stage-setting-control">${toggleControl(on)}</span>
  </button>`;
}

function globalToggle(key: string, title: string, desc: string, on: boolean, act: string): string {
  return `<button type="button" class="stage-setting-row is-button" role="switch" aria-checked="${on}" data-act="${esc(act)}" data-gp-item data-gp-key="set:${esc(key)}">
    <span class="stage-setting-copy"><strong>${esc(title)}</strong><small>${esc(desc)}</small></span>
    <span class="stage-setting-control">${toggleControl(on)}</span>
  </button>`;
}

interface Choice {
  label: string;
  value: number;
  selected: boolean;
}

function choiceRow(
  key: string,
  title: string,
  desc: string,
  act: string,
  choices: Choice[],
): string {
  return row(
    key,
    title,
    desc,
    `<span class="stage-choice-row">${choices.map((choice) => `<button type="button" class="stage-choice${choice.selected ? " active" : ""}" data-stage-act="${esc(act)}" data-value="${choice.value}" data-gp-item data-gp-key="set:${esc(key)}:${choice.value}">${esc(choice.label)}</button>`).join("")}</span>`,
  );
}

function general(): string {
  return `<div class="stage-settings-panel">
    ${choiceRow("text", t("stage.settingsTextSize"), t("stage.settingsTextSizeDesc"), "set-stage-text", [
      { label: t("stage.settingsTextNormal"), value: 100, selected: S.stage.textScale === 100 },
      { label: t("stage.settingsTextLarge"), value: 110, selected: S.stage.textScale === 110 },
      { label: t("stage.settingsTextXLarge"), value: 120, selected: S.stage.textScale === 120 },
    ])}
    ${choiceRow("safe", t("stage.settingsSafeArea"), t("stage.settingsSafeAreaDesc"), "set-stage-safe", [
      { label: t("stage.settingsSafeOff"), value: 0, selected: S.stage.safeArea === 0 },
      { label: t("stage.settingsSafeSmall"), value: 1, selected: S.stage.safeArea === 1 },
      { label: t("stage.settingsSafeMedium"), value: 2, selected: S.stage.safeArea === 2 },
      { label: t("stage.settingsSafeLarge"), value: 3, selected: S.stage.safeArea === 3 },
    ])}
    ${globalToggle("launch", t("stage.settingsOpenAtLaunch"), t("stage.settingsOpenAtLaunchDesc"), S.stage.openAtLaunch, "toggle-stage-open-launch")}
    ${globalToggle("auto", t("stage.settingsAuto"), t("stage.settingsAutoDesc"), S.stage.autoEnter, "toggle-stage-auto")}
    ${globalToggle("reduce", t("settings.reduceEffectsTitle"), t("settings.reduceEffectsDesc"), S.reduceEffects, "toggle-reduce-effects")}
  </div>`;
}

function appearance(): string {
  return `<div class="stage-settings-panel">
    ${stageToggle("sound", t("stage.settingsSound"), t("stage.settingsSoundDesc"), S.stage.sound, "toggle-stage-sound")}
    ${choiceRow("volume", t("stage.settingsVolume"), t("stage.settingsVolumeDesc"), "set-stage-volume", [
      { label: t("stage.settingsVolumeOff"), value: 0, selected: S.stage.soundVolume === 0 },
      { label: t("stage.settingsVolumeLow"), value: 25, selected: Math.round(S.stage.soundVolume / 25) * 25 === 25 },
      { label: t("stage.settingsVolumeMedium"), value: 50, selected: Math.round(S.stage.soundVolume / 25) * 25 === 50 },
      { label: t("stage.settingsVolumeHigh"), value: 75, selected: Math.round(S.stage.soundVolume / 25) * 25 === 75 },
      { label: t("stage.settingsVolumeMax"), value: 100, selected: Math.round(S.stage.soundVolume / 25) * 25 === 100 },
    ])}
    ${stageToggle("haptics", t("stage.settingsHaptics"), t("stage.settingsHapticsDesc"), S.stage.haptics, "toggle-stage-haptics")}
    <div class="stage-settings-actions">
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="test-stage-sound" data-gp-item data-gp-key="set:sound-test">${icon("volume-2", 16)}<span>${esc(t("stage.settingsTestSound"))}</span></button>
    </div>
    <div class="stage-settings-note">${icon("sliders", 15)}<span>${esc(t("stage.settingsAppearanceNote"))}</span></div>
  </div>`;
}

function controller(): string {
  const connected = S.stage.controllerConnected;
  return `<div class="stage-settings-panel">
    <div class="stage-controller-card">
      <span class="stage-controller-icon">${icon("gamepad-2", 34)}</span>
      <div class="stage-controller-copy">
        <span class="stage-kicker">${esc(t("stage.controller"))}</span>
        <strong>${esc(connected ? (S.stage.controllerName || t("stage.controller")) : t("stage.noController"))}</strong>
        <small>${esc(connected ? `${stageKindName(S.gamepadKind)}${stageBatteryLabel() ? ` · ${stageBatteryLabel()}` : ""}` : t("stage.settingsControllerHint"))}</small>
      </div>
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="show-controls" data-gp-item data-gp-key="set:controls">${icon("keyboard", 16)}<span>${esc(t("stage.controls"))}</span></button>
    </div>
    ${globalToggle("auto-controller", t("stage.settingsAuto"), t("stage.settingsAutoDesc"), S.stage.autoEnter, "toggle-stage-auto")}
    ${globalToggle("launch-controller", t("stage.settingsOpenAtLaunch"), t("stage.settingsOpenAtLaunchDesc"), S.stage.openAtLaunch, "toggle-stage-open-launch")}
    <div class="stage-settings-actions">
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="desktop-settings" data-gp-item data-gp-key="set:desktop-controller">${icon("settings", 16)}<span>${esc(t("stage.settingsDesktopController"))}</span></button>
    </div>
    <div class="stage-settings-note">${icon("info", 15)}<span>${esc(t("stage.settingsControllerNote"))}</span></div>
  </div>`;
}

function about(): string {
  return `<div class="stage-settings-panel">
    <div class="stage-about-card">
      <span class="stage-about-mark">${icon("clapperboard", 40)}</span>
      <div>
        <span class="stage-kicker">Efxlve Launcher</span>
        <h2>${esc(t("stage.settingsAboutTitle"))}</h2>
        <p>${esc(t("stage.settingsAboutBody"))}</p>
        <small class="tabular-nums">${esc(t("stage.settingsVersion", { v: S.appVersion }))}</small>
      </div>
    </div>
    <div class="stage-settings-note">${icon("info", 15)}<span>${esc(t("stage.settingsBetaNote"))}</span></div>
    <div class="stage-settings-actions">
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="desktop-settings" data-gp-item data-gp-key="about:desktop-settings">${icon("settings", 16)}<span>${esc(t("stage.openDesktopSettings"))}</span></button>
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="desktop" data-gp-item data-gp-key="about:desktop">${icon("monitor", 16)}<span>${esc(t("stage.openDesktop"))}</span></button>
    </div>
  </div>`;
}

export function renderStageSettings(): string {
  return `<div class="stage-settings">
    <header class="stage-settings-head">
      <div>
        <h1>${esc(t("stage.navSettings"))}</h1>
        <p>${esc(t("stage.settingsSubtitle"))}</p>
      </div>
      <div class="stage-settings-head-actions">
        <button type="button" class="stage-back" data-stage-act="back" data-gp-item data-gp-key="settings:back">${icon("arrow-left", 18)}<span>${esc(t("common.back"))}</span></button>
      </div>
    </header>
    ${tabs()}
    ${S.stage.settingsTab === "controller"
      ? controller()
      : S.stage.settingsTab === "appearance"
        ? appearance()
        : S.stage.settingsTab === "about"
          ? about()
          : general()}
  </div>`;
}

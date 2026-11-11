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
import { loadStageAudioFiles, stageAudioFiles, stageAudioLabel, stageAudioPendingDelete } from "./stage-audio-library";
import { stageAudioPreviewName } from "./stage-custom-audio";
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

function levelChoices(current: number): Choice[] {
  return [
    { label: t("stage.settingsVolumeOff"), value: 0, selected: current === 0 },
    { label: t("stage.settingsVolumeLow"), value: 25, selected: Math.round(current / 25) * 25 === 25 },
    { label: t("stage.settingsVolumeMedium"), value: 50, selected: Math.round(current / 25) * 25 === 50 },
    { label: t("stage.settingsVolumeHigh"), value: 75, selected: Math.round(current / 25) * 25 === 75 },
    { label: t("stage.settingsVolumeMax"), value: 100, selected: Math.round(current / 25) * 25 === 100 },
  ];
}

function audioSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The imported file rows: assign, sample and remove without a file dialog. */
function musicLibrary(): string {
  const files = stageAudioFiles();
  const pending = stageAudioPendingDelete();
  const previewing = stageAudioPreviewName();
  const rows = files.map((file) => {
    const confirming = pending === file.name;
    const assigned = S.stage.customAmbience === file.name;
    const actions = confirming
      ? `<button type="button" class="stage-choice is-danger" data-stage-act="delete-stage-audio" data-name="${esc(file.name)}" data-gp-item data-gp-key="music-delete:${esc(file.name)}">${esc(t("stage.settingsMusicDeleteConfirm"))}</button>
         <button type="button" class="stage-choice" data-stage-act="cancel-delete-stage-audio" data-gp-item data-gp-key="music-cancel:${esc(file.name)}">${esc(t("stage.settingsMusicCancel"))}</button>`
      : `<button type="button" class="stage-choice${previewing === file.name ? " active" : ""}" data-stage-act="preview-stage-audio" data-name="${esc(file.name)}" data-gp-item data-gp-key="music-preview:${esc(file.name)}">${esc(previewing === file.name ? t("stage.settingsMusicStop") : t("stage.settingsMusicPreview"))}</button>
         ${assigned ? "" : `<button type="button" class="stage-choice" data-stage-act="use-stage-ambience" data-name="${esc(file.name)}" data-gp-item data-gp-key="music-use:${esc(file.name)}">${esc(t("stage.settingsMusicUse"))}</button>`}
         <button type="button" class="stage-choice" data-stage-act="ask-delete-stage-audio" data-name="${esc(file.name)}" data-gp-item data-gp-key="music-ask-delete:${esc(file.name)}">${esc(t("stage.settingsMusicDelete"))}</button>`;
    return `<div class="stage-music-row${confirming ? " is-confirming" : ""}">
      <span class="stage-music-copy">
        <strong>${esc(file.label)}</strong>
        <small class="tabular-nums">${esc(audioSize(file.size))}${assigned ? ` · ${esc(t("stage.settingsMusicAssigned"))}` : ""}</small>
      </span>
      <span class="stage-choice-row">${actions}</span>
    </div>`;
  }).join("");
  return `<div class="stage-settings-group">
    <span class="stage-kicker">${esc(t("stage.settingsMusicLibrary"))}</span>
    <div class="stage-settings-actions">
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="import-stage-audio" data-gp-item data-gp-key="set:music-add">${icon("plus", 16)}<span>${esc(t("stage.settingsMusicAdd"))}</span></button>
    </div>
    ${files.length
      ? `<div class="stage-music-list">${rows}</div>`
      : `<div class="stage-settings-note">${icon("music", 15)}<span>${esc(t("stage.settingsMusicLibraryEmpty"))}</span></div>`}
  </div>`;
}

function appearance(): string {
  return `<div class="stage-settings-panel">
    <div class="stage-settings-group">
      <span class="stage-kicker">${esc(t("stage.settingsConsoleTitle"))}</span>
      ${stageToggle("sound", t("stage.settingsSound"), t("stage.settingsSoundDesc"), S.stage.sound, "toggle-stage-sound")}
      ${choiceRow("volume", t("stage.settingsVolume"), t("stage.settingsVolumeDesc"), "set-stage-volume", levelChoices(S.stage.soundVolume))}
      ${stageToggle("ambience", t("stage.settingsAmbience"), t("stage.settingsAmbienceDesc"), S.stage.ambience, "toggle-stage-ambience")}
      ${S.stage.ambience ? choiceRow("ambience-volume", t("stage.settingsAmbienceVolume"), t("stage.settingsAmbienceVolumeDesc"), "set-stage-ambience-volume", levelChoices(S.stage.ambienceVolume)) : ""}
      <div class="stage-settings-actions">
        <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="test-stage-sound" data-gp-item data-gp-key="set:sound-test">${icon("volume-2", 16)}<span>${esc(t("stage.settingsTestSound"))}</span></button>
        <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="test-stage-ambience" data-gp-item data-gp-key="set:ambience-test">${icon("music", 16)}<span>${esc(t("stage.settingsTestAmbience"))}</span></button>
      </div>
    </div>

    <div class="stage-settings-group">
      <span class="stage-kicker">${esc(t("stage.settingsMusicTitle"))}</span>
      <div class="stage-setting-row">
        <span class="stage-setting-copy">
          <strong>${esc(t("stage.settingsAmbience"))}</strong>
          <small>${esc(S.stage.customAmbience ? stageAudioLabel(S.stage.customAmbience) : t("stage.settingsMusicBuiltIn"))}</small>
        </span>
        <span class="stage-setting-control">
          <span class="stage-choice-row">
            <button type="button" class="stage-choice" data-stage-act="choose-stage-ambience" data-gp-item data-gp-key="set:music-choose">${esc(t("stage.settingsMusicChoose"))}</button>
            ${S.stage.customAmbience ? `<button type="button" class="stage-choice" data-stage-act="clear-stage-ambience" data-gp-item data-gp-key="set:music-clear">${esc(t("stage.settingsMusicClear"))}</button>` : ""}
          </span>
        </span>
      </div>
      <div class="stage-settings-note">${icon("music", 15)}<span>${esc(t("stage.settingsMusicDesc"))}</span></div>
      ${musicLibrary()}
    </div>

    <div class="stage-settings-group">
      <span class="stage-kicker">${esc(t("stage.settingsPresentationTitle"))}</span>
      ${stageToggle("cinematic", t("stage.settingsCinematic"), t("stage.settingsCinematicDesc"), S.stage.cinematic, "toggle-stage-cinematic")}
      ${stageToggle("attract", t("stage.settingsAttract"), t("stage.settingsAttractDesc"), S.stage.attract, "toggle-stage-attract")}
      <div class="stage-settings-actions">
        <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="preview-stage-idle" data-gp-item data-gp-key="set:idle-preview">${icon("sparkles", 16)}<span>${esc(t("stage.settingsPreviewIdle"))}</span></button>
      </div>
      ${stageToggle("haptics", t("stage.settingsHaptics"), t("stage.settingsHapticsDesc"), S.stage.haptics, "toggle-stage-haptics")}
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
  void loadStageAudioFiles();
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

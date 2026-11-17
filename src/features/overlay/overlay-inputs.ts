/**
 * Overlay input handling: the change, text-input and keyboard listeners that
 * sit between the DOM controls and the feature modules.
 *
 * One-way dependency: the page supplies its own context and settings helpers
 * through configureInputs; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { HOMEPAGE_STORAGE_KEY } from "./browser-shared";
import { OVERLAY_OPACITY_KEY } from "../../core/constants";
import { type CrosshairConfig, type CrosshairHotkey } from "../../core/crosshair";
import {
  activeCrosshair,
  commitCrosshair,
  handleSettingsToggle,
  paintCrosshairPreview,
  scheduleCrosshairConfig,
  type SettingsDeps,
} from "./overlay-settings";
import { setGhostOpacity } from "./overlay-widgets";
import {
  holdAudioLevels,
  scheduleAudioMaster,
  scheduleAudioVolume,
  selectAudioPreset,
  setAudioDevice,
} from "./overlay-audio";
import {
  cancelDiscordEdit,
  focusSelectedFriendRow,
  growComposer,
  isEditingDiscordEntry,
  runUserSearch,
  selectReplyTarget,
  setDiscordFriendsFilter,
  setDiscordReplyDraft,
  setDiscordSearchQuery,
  stepReplyTarget,
  submitDiscordComposer,
} from "./overlay-discord";
import { overlaySpotifyControl, setSpotifySearchQuery } from "./overlay-music";
import {
  closeShotFilterPopover,
  hideLightbox,
  isShotFilterPopoverOpen,
  lightboxIsOpen,
  stepLightbox,
} from "./overlay-screenshots";
import {
  activateFocused,
  adjustFocusedRange,
  focusedElement,
  goBack,
  isTextEntryFocused,
  moveFocus,
  type Dir,
} from "./overlay-controller";

type TabId = string;

interface InputsDeps {
  contextAppName: () => string;
  settingsDeps: () => SettingsDeps;
  saveOpacity: (value: number) => void;
}

let deps: InputsDeps | null = null;

function contextAppName(): string {
  return deps?.contextAppName() ?? "";
}


function onOverlayChange(event: Event): void {
const input = event.target as HTMLInputElement | null;
    if (!input) return;
    if (input.id === "ov-audio-preset-select") {
      selectAudioPreset(input.value);
      return;
    }
    if (input.id === "ov-audio-device") {
      const id = input.value;
      if (!id) return;
      setAudioDevice(id);
      return;
    }
    if (input.dataset.crosshairHotkey !== undefined) {
      commitCrosshair(
        { ...activeCrosshair(contextAppName()), hotkey: input.value as CrosshairHotkey },
        true,
      );
      return;
    }
    const toggle = input.dataset.ovToggle;
    if (toggle && handleSettingsToggle(toggle, input, deps!.settingsDeps())) {
      return;
    }
    if (input.id === "ov-setting-browser-hp-select") {
      const sel = input as unknown as HTMLSelectElement;
      const customInput = document.getElementById("ov-setting-browser-hp-custom") as HTMLInputElement | null;
      if (sel.value === "custom") {
        if (customInput) {
          customInput.style.display = "inline-block";
          customInput.focus();
        }
      } else {
        if (customInput) customInput.style.display = "none";
        localStorage.setItem(HOMEPAGE_STORAGE_KEY, sel.value);
      }
    }
}

function onSpotifyVolumeChange(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (input?.id === "ov-sp-volume") {
      void overlaySpotifyControl("volume", Number(input.value));
    }
}

function onOverlayInput(event: Event): void {
const target = event.target;
    if (target instanceof HTMLInputElement && target.id === "ov-discord-search") {
      setDiscordSearchQuery(target.value);
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "ov-dc-friends-filter") {
      setDiscordFriendsFilter(target.value);
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "ov-sp-search-input") {
      setSpotifySearchQuery(target.value);
      return;
    }
    if (target instanceof HTMLTextAreaElement && target.id === "ov-discord-reply-input") {
      setDiscordReplyDraft(target.value);
      growComposer(target);
      const count = document.querySelector<HTMLElement>(".composer-count");
      if (count) count.textContent = `${target.value.length} / 2000`;
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "ov-setting-browser-hp-custom") {
      let val = target.value.trim();
      if (val && !val.startsWith("http://") && !val.startsWith("https://")) {
        val = `https://${val}`;
      }
      if (val) localStorage.setItem(HOMEPAGE_STORAGE_KEY, val);
      return;
    }
    const input = event.target as HTMLInputElement | null;
    if (input?.dataset.crosshairSize !== undefined) {
      const value = Number(input.value);
      const badge = document.getElementById("ov-crosshair-size-val");
      if (badge) badge.textContent = `${Math.round(value)}px`;
      const next = { ...activeCrosshair(contextAppName()), size: value };
      paintCrosshairPreview(next);
      scheduleCrosshairConfig(next);
      return;
    }
    if (input?.dataset.crosshairGap !== undefined) {
      const value = Number(input.value);
      const badge = document.getElementById("ov-crosshair-gap-val");
      if (badge) badge.textContent = `${Math.round(value)}px`;
      const next = { ...activeCrosshair(contextAppName()), gap: value };
      paintCrosshairPreview(next);
      scheduleCrosshairConfig(next);
      return;
    }
    if (input?.dataset.crosshairThickness !== undefined) {
      const value = Number(input.value);
      const badge = document.getElementById("ov-crosshair-thickness-val");
      if (badge) badge.textContent = `${value.toFixed(1)}px`;
      const next = { ...activeCrosshair(contextAppName()), thickness: value };
      paintCrosshairPreview(next);
      scheduleCrosshairConfig(next);
      return;
    }
    if (input?.dataset.crosshairOpacity !== undefined) {
      const value = Number(input.value);
      const badge = document.getElementById("ov-crosshair-opacity-val");
      if (badge) badge.textContent = `${Math.round(value)}%`;
      const next = { ...activeCrosshair(contextAppName()), opacity: value / 100 };
      paintCrosshairPreview(next);
      scheduleCrosshairConfig(next);
      return;
    }
    if (input?.dataset.ghostOpacity) {
      const tab = input.dataset.ghostOpacity as TabId;
      const value = Number(input.value) / 100;
      const badge = document.getElementById(`ov-ghost-opacity-${tab}`);
      if (badge) badge.textContent = `${Math.round(value * 100)}%`;
      setGhostOpacity(tab, value);
      return;
    }
    if (input?.dataset.audioVolume !== undefined) {
      const id = input.dataset.audioVolume;
      const volume = Number(input.value) / 100;
      holdAudioLevels();
      const pct = input.closest(".ov-audio-row")?.querySelector(".ov-audio-pct");
      if (pct) pct.textContent = `${input.value}%`;
      scheduleAudioVolume(id, volume);
      return;
    }
    if (input?.dataset.audioMaster !== undefined) {
      const volume = Number(input.value) / 100;
      holdAudioLevels();
      const pct = input.closest(".ov-audio-row")?.querySelector(".ov-audio-pct");
      if (pct) pct.textContent = `${input.value}%`;
      scheduleAudioMaster(volume);
      return;
    }
    if (input?.dataset.ovOpacity === undefined) return;
    const val = Number(input.value);
    localStorage.setItem(OVERLAY_OPACITY_KEY, String(val));
    deps?.saveOpacity(val);
    const badge = document.getElementById("ov-opacity-val");
    if (badge) badge.textContent = `${val}%`;
}

function onOverlayKeydown(event: KeyboardEvent): void {
// Shift+Tab is the global close hotkey; plain Tab would jump focus to
    // hidden nodes, so it is swallowed here.
    if (event.key === "Tab") {
      event.preventDefault();
      return;
    }
    // The lightbox is modal: arrows page through the gallery and Escape closes
    // it, instead of moving the hidden panel's focus ring behind it.
    if (lightboxIsOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        hideLightbox();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        stepLightbox(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
    }
    if (event.key === "Escape" && isShotFilterPopoverOpen()) {
      closeShotFilterPopover();
      return;
    }
    // Composer keys: Enter sends, Shift+Enter adds a line, Ctrl+Up/Down walks
    // the friend list without leaving the box.
    const typed = event.target;
    // Enter in the add-friend search runs it.
    if (typed instanceof HTMLInputElement && typed.id === "ov-discord-search") {
      if (event.key === "Enter") {
        event.preventDefault();
        runUserSearch();
      }
      return;
    }
    if (typed instanceof HTMLInputElement && (typed.id === "ov-home-browser-input" || typed.id === "ov-browser-hub-input")) {
      if (event.key === "Enter") {
        event.preventDefault();
        const url = typed.value.trim() || null;
        void invoke("overlay_browser_open", { url });
      }
      return;
    }
    if (typed instanceof HTMLInputElement && (typed.id === "ov-add-bm-label" || typed.id === "ov-add-bm-url")) {
      if (event.key === "Enter") {
        event.preventDefault();
        const addBtn = document.querySelector<HTMLButtonElement>('[data-ov="add-browser-bookmark"]');
        addBtn?.click();
      }
      return;
    }
    const inComposer = typed instanceof HTMLTextAreaElement && typed.id === "ov-discord-reply-input";
    if (inComposer && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitDiscordComposer();
      return;
    }
    if (inComposer && (event.ctrlKey || event.metaKey) && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      stepReplyTarget(event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    // Typing on a focused friend row jumps into the box with that letter.
    if (!isTextEntryFocused() && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const row = document.activeElement as HTMLElement | null;
      if (row?.dataset.ov === "discord-select-friend" && row.dataset.id) {
        event.preventDefault();
        selectReplyTarget(row.dataset.id, row.dataset.name || row.dataset.id, event.key);
        return;
      }
    }
    if (isTextEntryFocused()) {
      // Esc leaves the box back to the friend row first; the next Esc closes.
      // While editing, it cancels the edit and brings the compose draft back.
      if (event.key === "Escape") {
        if (isEditingDiscordEntry()) {
          cancelDiscordEdit();
        } else {
          (document.activeElement as HTMLElement | null)?.blur();
          focusSelectedFriendRow();
        }
      }
      return;
    }
    const dirs: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    const dir = dirs[event.key];
    if (dir) {
      event.preventDefault();
      const focused = focusedElement();
      if (focused instanceof HTMLInputElement && focused.type === "range" && (dir === "left" || dir === "right")) {
        adjustFocusedRange(dir === "right" ? 4 : -4);
        return;
      }
      moveFocus(dir);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      // The lightbox is modal: never activate a control hidden behind it.
      if (lightboxIsOpen()) {
        const box = document.getElementById("ov-lightbox");
        const focused = focusedElement();
        if (focused && box?.contains(focused)) focused.click();
        return;
      }
      activateFocused();
      return;
    }
    if (event.key === "Escape" || event.key === "Backspace") {
      event.preventDefault();
      goBack();
    }
}

/** Registers the change, input and keydown listeners once. */
export function wireInputEvents(inputDeps: InputsDeps): void {
  deps = inputDeps;
  document.addEventListener("change", onOverlayChange);
  document.addEventListener("change", onSpotifyVolumeChange);
  document.addEventListener("input", onOverlayInput);
  document.addEventListener("keydown", onOverlayKeydown);
}

/**
 * Overlay clip recorder widget: the recorder status, last clip, polling and
 * the transient card that confirms a start, save or failure.
 *
 * One-way dependency: the page configures the widget queries through
 * configureClipWidget; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  clipList,
  clipStart,
  clipStatus,
  clipStop,
  type ClipItem,
  type ClipStatus,
} from "../../epic";
import { clipEnabled, clipFps, clipHotkeyName } from "../screenshots/ss-settings";
import { icon } from "../../core/icons";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { localizeMessage, t } from "../../i18n";

interface ClipWidgetDeps {
  isOpen: () => boolean;
  body: () => HTMLElement | null;
}

let clipDeps: ClipWidgetDeps | null = null;

export function configureClipWidget(deps: ClipWidgetDeps): void {
  clipDeps = deps;
}

function isClipOpen(): boolean {
  return clipDeps?.isOpen() ?? false;
}

function clipBody(): HTMLElement | null {
  return clipDeps?.body() ?? null;
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/* ---------- Clips (recorder widget) ---------- */

/** Live recorder state, refreshed while the overlay is on screen. */
let clipState: ClipStatus | null = null;
let lastClip: ClipItem | null = null;
let clipPollTimer: number | null = null;

/** mm:ss for a clip: a clip timer has to tick every second, which the session
 *  pill's minute-granularity format does not. */
export function clipClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function clipWidgetHtml(): string {
  const running = clipState?.running ?? false;
  const enabled = clipEnabled();
  const seconds = clipState?.seconds ?? 0;
  const frames = clipState?.frames ?? 0;
  const error = clipState?.error ?? "";
  const asked = clipState?.fps ?? clipFps();
  // The recorder writes frames as fast as it can, so the honest number is the
  // measured one — the same one the file's own header carries.
  const measured = running && seconds > 0 ? frames / seconds : 0;
  const rate = measured > 0 ? `${measured.toFixed(1)} / ${asked}` : String(asked);
  return `
    <div class="ov-clip">
      <div class="ov-clip-state${running ? " is-recording" : ""}">
        <span class="ov-clip-dot"></span>
        <span class="ov-clip-state-text">${esc(t(running ? "overlay.clipRecording" : "overlay.clipIdle"))}</span>
        <span class="ov-clip-timer">${clipClock(seconds)}</span>
      </div>
      <div class="ov-clip-meta">
        <span>${esc(t("overlay.clipFrames", { count: String(frames) }))}</span>
        <span>${esc(t("overlay.clipRate", { rate }))}</span>
      </div>
      ${
        enabled || running
          ? `<button class="ov-clip-btn${running ? " is-stop" : ""}" data-ov="clip-toggle">
        ${running ? icon("square", 14) : icon("video", 14)}
        <span>${esc(t(running ? "overlay.clipStop" : "overlay.clipRecord"))}</span>
      </button>
      <div class="ov-clip-hint">${esc(t("overlay.clipHotkeyHint", { key: clipHotkeyName() }))}</div>`
          : ""
      }
      ${error ? `<div class="ov-clip-error">${esc(localizeMessage(error))}</div>` : ""}
      ${lastClip ? `
        <div class="ov-clip-last" title="${esc(lastClip.path)}">
          <div class="ov-clip-last-name">${esc(lastClip.name)}</div>
          <div class="ov-clip-last-meta">${esc(clipClock(lastClip.seconds))} · ${esc(fmtMb(Math.round(lastClip.sizeBytes / (1024 * 1024))))}</div>
        </div>` : ""}
      <button class="ov-clip-folder" data-ov="clip-folder">${icon("folder", 12)} <span>${esc(t("overlay.clipOpenFolder"))}</span></button>
    </div>`;
}

/** Repaints the widget, optionally asking Rust for the live state first. */
export async function refreshClipWidget(fetch: boolean): Promise<void> {
  if (fetch) {
    try {
      clipState = await clipStatus();
    } catch {
      clipState = null;
    }
    // The list is only needed to show the last clip; fetch it once.
    if (isClipOpen() && !lastClip) await loadLastClip();
  }
  syncClipIndicator();
  if (!isClipOpen()) return;
  const body = clipBody();
  if (body) body.innerHTML = clipWidgetHtml();
}

/** The dock button carries the recording dot, so the state shows even with the
 *  widget itself closed. */
function syncClipIndicator(): void {
  const running = clipState?.running ?? false;
  const btn = document.querySelector<HTMLElement>('[data-ov-widget-toggle="clip"]');
  if (btn) btn.classList.toggle("is-recording", running);
}

export async function loadLastClip(): Promise<void> {
  try {
    const clips = await clipList();
    lastClip = clips[0] ?? null;
  } catch {
    lastClip = null;
  }
}

export function startClipPolling(): void {
  void refreshClipWidget(true);
  void loadLastClip().then(() => refreshClipWidget(false));
  if (clipPollTimer !== null) return;
  clipPollTimer = window.setInterval(() => {
    if (document.hidden) return;
    // Events update the dock dot when the recorder starts or stops; there is
    // nothing to poll while the clip widget is closed.
    if (!isClipOpen()) {
      stopClipPolling();
      return;
    }
    void refreshClipWidget(true);
  }, 1000);
}

export function stopClipPolling(): void {
  if (clipPollTimer === null) return;
  window.clearInterval(clipPollTimer);
  clipPollTimer = null;
}

export async function toggleClipRecording(): Promise<void> {
  try {
    if (clipState?.running) await clipStop();
    else await clipStart();
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  }
  // Rust flips the flag on its own thread; give it a moment before reading back.
  window.setTimeout(() => void refreshClipWidget(true), 250);
}

/** The card over the game. The launcher's notification is invisible in a
 *  full-screen game, which is exactly where a clip is taken. */
export function clipCard(titleKey: string, body: string): void {
  void invoke("overlay_flash_hint", { title: t(titleKey), body }).catch(() => undefined);
}


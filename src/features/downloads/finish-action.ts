/**
 * What happens after the last queued download finishes.
 *
 * A queue that ends while the user is away is the one moment the launcher can
 * act on its own. The watcher arms when real transfer progress arrives, not at
 * startup, so an empty queue never sleeps or shuts down a machine. Sleep and
 * shutdown run through a sixty-second countdown that a new download, a pause,
 * a failure or a cancel tears down; the command is never persisted, so an old
 * shutdown cannot fire after a restart.
 */

import { invoke } from "@tauri-apps/api/core";
import { DOWNLOAD_FINISH_ACTION_KEY, isTauri } from "../../core/constants";
import { confirmRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { notifyBackgrounded } from "../../core/system-notify";
import { toast } from "../../core/toast";
import type { DownloadFinishAction } from "../../core/types";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { pushNotification } from "../notifications/notifications";

type PowerAction = "sleep" | "shutdown";

const COUNTDOWN_SECONDS = 60;
const WATCH_MS = 2000;

let armed = false;
let watchTimer: number | null = null;
let idleTicks = 0;
let countdownTimer: number | null = null;
let countdownLeft = 0;
let pendingPower: PowerAction | null = null;
let layer: HTMLElement | null = null;

/** True while any launcher-watched transfer still has bytes to move. */
export function launcherTransfersBusy(): boolean {
  if (S.activeDlMetrics && !S.activeDlMetrics.done) return true;
  if (S.dlQueueStatus.active) return true;
  if (S.dlQueueStatus.queue.length > 0) return true;
  for (const entry of S.downloads.values()) {
    if (!entry.done) return true;
  }
  if (S.amazonProgress.size > 0) return true;
  if (S.ubiDirectInstalling.size > 0) return true;
  if (S.eaContentInstalling.size > 0) return true;
  // Other clients are watched too: sleeping through their transfer would
  // interrupt a download the launcher did not start but can still see.
  if (S.steamGames.some((game) => game.downloading)) return true;
  if (S.companionSummaries.some((game) => game.downloading)) return true;
  return false;
}

function stopWatch(): void {
  if (watchTimer === null) return;
  window.clearInterval(watchTimer);
  watchTimer = null;
}

function closeLayer(): void {
  if (countdownTimer !== null) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
  pendingPower = null;
  layer?.remove();
  layer = null;
}

function stopAll(): void {
  stopWatch();
  closeLayer();
  armed = false;
  idleTicks = 0;
}

/** Arms the watcher; the queue is worth watching only once bytes move. */
function startWatch(): void {
  if (watchTimer !== null) return;
  watchTimer = window.setInterval(() => {
    // The countdown owns its own timer and polls the queue itself.
    if (countdownTimer !== null) return;
    if (launcherTransfersBusy()) {
      idleTicks = 0;
      return;
    }
    idleTicks++;
    // Two quiet ticks cover the gap between a completed process and the queue
    // snapshot that reports it, without delaying a real shutdown noticeably.
    if (idleTicks < 2) return;
    stopWatch();
    if (!armed) return;
    armed = false;
    void finishReached();
  }, WATCH_MS);
}

/** Called on every progress line: a transfer exists, so arm the watcher. */
export function noteDownloadActivity(): void {
  if (S.downloadFinishAction === "none") return;
  if (countdownTimer !== null) {
    closeLayer();
    toast(t("downloads.finishNewDownload"), "");
  }
  armed = true;
  idleTicks = 0;
  startWatch();
}

/** Called when one transfer completes; the queue may still have more work. */
export function noteDownloadFinished(): void {
  if (S.downloadFinishAction === "none") return;
  armed = true;
  idleTicks = 0;
  startWatch();
}

/**
 * A pause, cancel or failure drops the pending power action: the queue did not
 * reach its natural end, so acting on it would surprise the user.
 */
export function noteDownloadInterrupted(): void {
  if (countdownTimer !== null) {
    toast(t("downloads.finishInterrupted"), "");
  }
  stopAll();
}

/** Answers the countdown dialog from the shared click router. */
export function handleFinishAction(act: string): boolean {
  if (act === "finish-cancel") {
    cancelFinishCountdown();
    return true;
  }
  if (act === "finish-now") {
    const action = pendingPower;
    closeLayer();
    if (action) void runPowerAction(action);
    return true;
  }
  return false;
}

/** Cancels an open countdown; true when there was one (Escape handling). */
export function cancelFinishCountdown(): boolean {
  if (countdownTimer === null && !layer) return false;
  closeLayer();
  return true;
}

function countLabel(): string {
  return t("downloads.finishCountdown", { seconds: countdownLeft });
}

function paintCountdown(): void {
  const el = document.getElementById("finish-count");
  if (el) el.textContent = String(countdownLeft);
  const body = document.getElementById("finish-count-body");
  if (body) body.setAttribute("aria-label", countLabel());
}

function showCountdown(action: PowerAction): void {
  closeLayer();
  pendingPower = action;
  countdownLeft = COUNTDOWN_SECONDS;
  const bodyKey = action === "sleep" ? "downloads.finishSleepBody" : "downloads.finishShutdownBody";
  const body = esc(t(bodyKey)).replace("{seconds}", `<strong id="finish-count" class="tabular-nums">${countdownLeft}</strong>`);

  layer = document.createElement("div");
  layer.className = "confirm-layer finish-layer";
  layer.innerHTML = `
    <div class="modal-backdrop" data-act="finish-cancel">
      <div class="modal confirm-dialog finish-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="modal-head">
          <h3 class="modal-title">${esc(t("downloads.finishDoneTitle"))}</h3>
          <button type="button" class="manage-head-close" data-act="finish-cancel" title="${esc(t("common.cancel"))}">${icon("x", 16)}</button>
        </div>
        <p class="confirm-body" id="finish-count-body" aria-live="polite">${body}</p>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-act="finish-cancel">${esc(t("common.cancel"))}</button>
          <button type="button" class="btn primary" data-act="finish-now">${esc(t("downloads.finishNow"))}</button>
        </div>
      </div>
    </div>`;
  confirmRoot.appendChild(layer);
  // The safe action owns the keyboard while the countdown runs.
  layer.querySelector<HTMLButtonElement>('[data-act="finish-cancel"]')?.focus();

  countdownTimer = window.setInterval(() => {
    // A fresh download during the countdown keeps the machine awake.
    if (launcherTransfersBusy()) {
      closeLayer();
      toast(t("downloads.finishNewDownload"), "");
      return;
    }
    countdownLeft--;
    if (countdownLeft <= 0) {
      const run = pendingPower;
      closeLayer();
      if (run) void runPowerAction(run);
      return;
    }
    paintCountdown();
  }, 1000);
}

async function finishReached(): Promise<void> {
  const action = S.downloadFinishAction;
  if (action === "none") return;
  if (action === "notify") {
    const title = t("downloads.finishDoneTitle");
    const body = t("downloads.finishDoneBody");
    pushNotification({ kind: "download", title, body });
    toast(title, "ok");
    void notifyBackgrounded(title, body);
    return;
  }
  showCountdown(action);
}

async function runPowerAction(action: PowerAction): Promise<void> {
  if (!isTauri) {
    toast(t("downloads.finishFailed", { msg: t("common.unavailable") }), "err");
    return;
  }
  try {
    await invoke("app_power_action", { action });
  } catch (error) {
    toast(t("downloads.finishFailed", { msg: String(error) }), "err");
  }
}

/** Persists a new choice; the watcher only runs while a queue is active. */
export function setDownloadFinishAction(action: DownloadFinishAction): void {
  S.downloadFinishAction = action;
  localStorage.setItem(DOWNLOAD_FINISH_ACTION_KEY, action);
  if (action === "none") {
    stopAll();
    return;
  }
  if (action === "notify") {
    // A pending power countdown belongs to the old choice.
    closeLayer();
  }
}

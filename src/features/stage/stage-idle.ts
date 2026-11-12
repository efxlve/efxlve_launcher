/**
 * Attract mode for the Stage Home screen.
 *
 * A console left alone becomes part of the room: the chrome steps back, the
 * key art starts a slow pan and the clock stays readable. The transition is a
 * class on the shell, not a render, so waking never loses the focus ring or
 * replays an entrance animation.
 */

import { S } from "../../core/state";
import { t } from "../../i18n";
import { stageFeedback } from "./stage-sound";

/** Long enough to read a shelf, short enough to feel intentional. */
const IDLE_MS = 75_000;

let timer = 0;
let bound = false;
let lastMoveAt = 0;

function overlayOpen(): boolean {
  return Boolean(
    S.stage.searchOpen ||
    S.stage.quickMenu ||
    S.stage.controlsOpen ||
    S.stage.notifOpen ||
    S.stage.powerOpen ||
    S.stage.browserOpen ||
    S.stage.spotifyOpen ||
    S.stage.discordOpen ||
    S.stage.manageKey ||
    S.stage.launch ||
    S.stage.stillIndex !== null ||
    S.stage.launchError,
  );
}

function eligible(): boolean {
  return S.stage.active && S.stage.attract && S.stage.route === "home" && !overlayOpen();
}

function applyIdle(on: boolean): void {
  S.stage.idle = on;
  const root = document.getElementById("stage-root");
  if (root) root.classList.toggle("is-idle", on);
}

export function wakeStageIdle(): void {
  if (!S.stage.idle) return;
  applyIdle(false);
  // The clock and the greeting live in the idle overlay; a light tick makes
  // the wake feel like the console acknowledging the controller.
  stageFeedback("toggle");
  resetStageIdleTimer();
}

function scheduleIdle(): void {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    if (!eligible()) return;
    applyIdle(true);
  }, IDLE_MS);
}

export function resetStageIdleTimer(): void {
  if (timer) window.clearTimeout(timer);
  timer = 0;
  if (!eligible()) return;
  scheduleIdle();
}

/** Called after every render; a route or an overlay changes the contract. */
export function refreshStageIdle(): void {
  if (!eligible()) {
    if (S.stage.idle) applyIdle(false);
    if (timer) window.clearTimeout(timer);
    timer = 0;
    return;
  }
  if (!S.stage.idle) resetStageIdleTimer();
}

/** Any real input wakes the room and restarts the quiet countdown. */
export function touchStageActivity(): void {
  if (S.stage.idle) {
    wakeStageIdle();
    return;
  }
  resetStageIdleTimer();
}

export function stageIdleGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return t("stage.greetingMorning");
  if (hour >= 12 && hour < 18) return t("stage.greetingAfternoon");
  if (hour >= 18 && hour < 23) return t("stage.greetingEvening");
  return t("stage.greetingNight");
}

export function initStageIdle(): void {
  if (bound) return;
  bound = true;

  const consume = (event: Event): void => {
    if (!S.stage.idle) {
      resetStageIdleTimer();
      return;
    }
    // The first press only wakes the room. Without this the same press would
    // also open the item under the ring, which is not what a sleeping console
    // does.
    event.preventDefault();
    event.stopPropagation();
    wakeStageIdle();
  };

  window.addEventListener("pointerdown", consume, true);
  window.addEventListener("keydown", consume, true);
  window.addEventListener("wheel", consume, { capture: true, passive: false });
  window.addEventListener("pointermove", () => {
    if (S.stage.idle) {
      wakeStageIdle();
      return;
    }
    // A mouse reports hundreds of moves per second; the countdown only needs
    // to know that the user is still there.
    const now = performance.now();
    if (now - lastMoveAt < 500) return;
    lastMoveAt = now;
    resetStageIdleTimer();
  }, { passive: true });
  // D-pad movement ends here: it is the only pad input that should wake by
  // moving the ring. Face and menu buttons go through the Stage bridge, which
  // consumes the first press instead of activating the item under it.
  window.addEventListener("stage:focus", () => {
    if (S.stage.idle) wakeStageIdle();
    else resetStageIdleTimer();
  });
  window.addEventListener("stage-mode", (event) => {
    if ((event as CustomEvent<{ active?: boolean }>).detail?.active) {
      resetStageIdleTimer();
    } else {
      applyIdle(false);
      if (timer) window.clearTimeout(timer);
      timer = 0;
    }
  });
}

/** A small test hook for the settings page. */
export function previewStageIdle(): void {
  if (!S.stage.active || S.stage.route !== "home") return;
  applyIdle(true);
}

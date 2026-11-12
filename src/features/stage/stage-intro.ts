/**
 * The Stage boot flourish.
 *
 * A console does not throw its dashboard at the screen the instant the box is
 * switched on. Stage opens with a short, original mark: the wordmark, a thin
 * line and a low chime. It is decorative only; the Home screen is already
 * mounted underneath and the overlay never traps input.
 */

import { scheduleRender } from "../../core/render";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { stageFeedback } from "./stage-sound";

const BOOT_MS = 2800;
let timer = 0;
let handled = false;

function canPlay(): boolean {
  if (!S.stage.cinematic || S.reduceEffects) return false;
  try {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

export function startStageIntro(): void {
  if (!S.stage.active || !canPlay()) return;
  if (handled) return;
  handled = true;
  S.stage.intro = true;
  stageFeedback("boot");
  scheduleRender();
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    if (!S.stage.intro) return;
    S.stage.intro = false;
    scheduleRender();
  }, BOOT_MS);
}

export function skipStageIntro(): void {
  if (!S.stage.intro) return;
  if (timer) window.clearTimeout(timer);
  timer = 0;
  S.stage.intro = false;
  scheduleRender();
}

export function resetStageIntro(): void {
  handled = false;
  if (timer) window.clearTimeout(timer);
  timer = 0;
  S.stage.intro = false;
}

/** The overlay is painted above the shell and disappears after the CSS fade. */
export function stageIntroMarkup(): string {
  if (!S.stage.intro) return "";
  return `<div class="stage-intro" role="presentation" aria-hidden="true">
    <div class="stage-intro-ring"></div>
    <div class="stage-intro-mark">
      <span class="stage-intro-brand">EFXLVE</span>
      <span class="stage-intro-mode">STAGE</span>
      <span class="stage-intro-rule"></span>
      <span class="stage-intro-note">${t("stage.introNote")}</span>
    <div class="stage-stat-row">
      <span class="stage-stat">${icon("package", 13)}<span>${esc(t("stage.settingsVersion", { v: S.appVersion }))}</span></span>
      <span class="stage-stat">${icon("sparkles", 13)}<span>BETA</span></span>
    </div>
    </div>
  </div>`;
}

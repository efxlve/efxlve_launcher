/**
 * Sign-in, first-run setup and post-login loading views.
 *
 * Split layout: a focused form panel on the left and a static, dimmed key-art
 * backdrop on the right. No looping animations run on this screen.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

/** Progress thresholds for the four post-login steps. */
const STEP_DONE_AT = [40, 72, 90, 100];

/** In-place DOM update for the post-login loading sequence. */
export function updateAuthProgressUi(): void {
  const bar = document.getElementById("auth-progress-bar");
  const pct = document.getElementById("auth-progress-percent");
  const stage = document.getElementById("auth-stage-text");
  if (bar) bar.style.width = `${S.authProgress}%`;
  if (pct) pct.textContent = `${S.authProgress}%`;
  if (stage) stage.textContent = S.authStageText || "";
  const p = S.authProgress;
  document.querySelectorAll<HTMLElement>(".auth-step-row").forEach((row, i) => {
    const doneAt = STEP_DONE_AT[i] ?? 100;
    const startAt = i === 0 ? 0 : STEP_DONE_AT[i - 1];
    row.classList.toggle("done", p >= doneAt);
    row.classList.toggle("active", p >= startAt && p < doneAt);
  });
}

function shell(panel: string): string {
  return `
    <div class="auth-screen">
      <div class="auth-panel">
        <div class="auth-brand"><span class="sb-logo">${icon("gamepad-2", 17)}</span><span>Efxlve Launcher</span></div>
        ${panel}
      </div>
      <div class="auth-art" aria-hidden="true"></div>
    </div>`;
}

/** Render the standalone login / loading / setup view. */
export function renderOnboarding(): string {
  if (S.epicPhase === "setup") {
    const pct = S.setupProgress ?? 0;
    return shell(`
      <h1 class="auth-title">${t("ob.setupTitle")}</h1>
      <p class="auth-lead">${t("ob.setupLead")}</p>
      ${S.epicBusy === "download" ? `
        <div class="progress auth-progress"><span style="width:${pct}%"></span></div>
        <p class="auth-hint">${esc(S.setupMessage || t("ob.downloading"))}</p>` : ""}
      <button class="btn primary lg full" data-act="epic-download" ${S.epicBusy ? "disabled" : ""}>${icon("download", 16)} ${S.epicBusy ? t("ob.downloading") : t("ob.setupDownload")}</button>
      <p class="auth-hint">${t("auth.sourceNote")}</p>`);
  }

  if (S.authLoading) {
    const p = S.authProgress;
    const steps = [t("auth.stepAuth"), t("auth.stepCatalog"), t("auth.stepTrophies"), t("auth.stepReady")];
    return shell(`
      <h1 class="auth-title">${t("auth.syncingTitle")}</h1>
      <p class="auth-lead" id="auth-stage-text">${esc(S.authStageText || t("auth.stageAuth"))}</p>
      <div class="auth-progress-row">
        <div class="progress auth-progress"><span id="auth-progress-bar" style="width:${p}%"></span></div>
        <span class="tabular-nums auth-hint" id="auth-progress-percent">${p}%</span>
      </div>
      <ol class="auth-steps">
        ${steps.map((label, i) => {
          const doneAt = STEP_DONE_AT[i];
          const startAt = i === 0 ? 0 : STEP_DONE_AT[i - 1];
          return `<li class="auth-step-row ${p >= doneAt ? "done" : p >= startAt ? "active" : ""}"><span class="auth-step-pip">${icon("check", 12)}</span>${label}</li>`;
        }).join("")}
      </ol>`);
  }

  return shell(`
    ${S.epicAccount ? `<button class="btn ghost small auth-back" data-act="auth-cancel" ${S.epicBusy || S.authLoading ? "disabled" : ""}>${icon("arrow-left", 14)} ${t("auth.backToAccount")}</button>` : ""}
    <h1 class="auth-title">${t("auth.epicWebLogin")}</h1>
    <p class="auth-lead">${t("auth.subtitle")}</p>

    <button class="btn primary lg full" data-act="epic-open-login">${icon("external", 16)} ${t("auth.epicWebLogin")}</button>
    <div class="auth-code">
      <input id="epic-code" class="input" placeholder="${t("auth.pastePlaceholder")}" autocomplete="off" spellcheck="false" />
      <button class="btn ghost" data-act="auth-paste" title="${t("auth.pasteBtn")}">${icon("copy", 14)} ${t("auth.pasteBtn")}</button>
      <button class="btn primary icon-only" data-act="epic-do-login" title="${t("auth.submitCode")}">${icon("arrow-right", 15)}</button>
    </div>

    <ol class="auth-guide">
      <li><strong>${t("auth.guideStep1Title")}</strong> ${t("auth.guideStep1Desc")}</li>
      <li><strong>${t("auth.guideStep2Title")}</strong> ${t("auth.guideStep2Desc")}</li>
      <li><strong>${t("auth.guideStep3Title")}</strong> ${t("auth.guideStep3Desc")}</li>
    </ol>

    <div class="auth-divider"><span>${t("auth.orDivider")}</span></div>
    <button class="auth-import" data-act="epic-import">
      ${icon("download", 18)}
      <span class="auth-import-text"><strong>${t("auth.importTitle")}</strong><span>${t("auth.importSubtitle")}</span></span>
      ${icon("arrow-right", 15)}
    </button>`);
}

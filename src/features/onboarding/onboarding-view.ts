/**
 * First-run onboarding and Epic account linking wizard.
 *
 * Renders the setup / login phases as a three-step wizard. It reads shared
 * state (S) and is shown by the library view while the account is not linked.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
export function renderOnboarding(): string {
  if (S.epicPhase === "setup") {
    const pct = S.setupProgress ?? 0;
    return `
      <div class="onboarding-shell">
        <div class="onboarding-card ob-card-setup">
          <div class="ob-hero-mark">${icon("download", 34)}</div>
          <h1 class="ob-title">${t("ob.setupTitle")}</h1>
          <p class="ob-lead">${t("ob.setupLead")}</p>
          ${S.epicBusy === "download" ? `<div class="ob-progress"><div class="ob-progress-fill" style="width:${pct}%"></div></div><p class="ob-muted">${esc(S.setupMessage || t("ob.downloading"))}</p>` : ""}
          <div class="ob-actions">
            <button class="ps5-btn primary" data-act="epic-download" ${S.epicBusy ? "disabled" : ""}>${S.epicBusy ? t("ob.downloading") : t("ob.setupDownload")}</button>
          </div>
          <p class="ob-fineprint">Kaynak: github.com/legendary-gl/legendary (GPL-3.0)</p>
        </div>
      </div>`;
  }

  const steps = [t("ob.stepWelcome"), t("ob.stepLink"), t("ob.stepVerify")];
  const stepper = steps
    .map((label, i) => {
      const n = i + 1;
      const cls = S.onboardingStep === n ? "active" : S.onboardingStep > n ? "done" : "";
      const num = S.onboardingStep > n ? icon("check", 12) : String(n);
      const line = i < steps.length - 1 ? `<span class="ob-step-line"></span>` : "";
      return `<div class="ob-step ${cls}"><span class="ob-step-num">${num}</span><span class="ob-step-label">${label}</span></div>${line}`;
    })
    .join("");

  let body = "";
  if (S.onboardingStep === 1) {
    body = `
      <div class="ob-hero">
        <div class="ob-hero-mark">${icon("gamepad-2", 34)}</div>
        <h1 class="ob-title">${t("ob.welcomeTitle")}</h1>
        <p class="ob-lead">${t("ob.welcomeLead")}</p>
        <div class="ob-features">
          <div class="ob-feature">${icon("zap", 18)}<div><strong>${t("ob.f1Title")}</strong><span>${t("ob.f1Desc")}</span></div></div>
          <div class="ob-feature">${icon("gamepad-2", 18)}<div><strong>${t("ob.f2Title")}</strong><span>${t("ob.f2Desc")}</span></div></div>
          <div class="ob-feature">${icon("shield-check", 18)}<div><strong>${t("ob.f3Title")}</strong><span>${t("ob.f3Desc")}</span></div></div>
        </div>
        <div class="ob-actions">
          <button class="ps5-btn primary" data-act="onboarding-goto" data-step="2">${t("ob.start")} ${icon("chevron-right", 15)}</button>
        </div>
      </div>`;
  } else if (S.onboardingStep === 2) {
    body = `
      <div class="ob-head">
        <h1 class="ob-title">${t("ob.linkTitle")}</h1>
        <p class="ob-lead">${t("ob.linkLead")}</p>
      </div>
      <div class="ob-methods">
        <button class="ob-method" data-act="epic-import" ${S.epicBusy ? "disabled" : ""}>
          <div class="ob-method-icon">${icon("download", 22)}</div>
          <div class="ob-method-body">
            <div class="ob-method-title">${t("ob.importTitle")}</div>
            <div class="ob-method-desc">${t("ob.importDesc")}</div>
          </div>
          <span class="ob-method-badge">${S.epicBusy === "import" ? t("ob.importing") : t("ob.recommended")}</span>
        </button>
        <button class="ob-method" data-act="onboarding-goto" data-step="3">
          <div class="ob-method-icon">${icon("external", 22)}</div>
          <div class="ob-method-body">
            <div class="ob-method-title">${t("ob.codeTitle")}</div>
            <div class="ob-method-desc">${t("ob.codeDesc")}</div>
          </div>
          <span class="ob-method-arrow">${icon("chevron-right", 16)}</span>
        </button>
      </div>
      <div class="ob-actions">
        <button class="ps5-btn secondary" data-act="onboarding-goto" data-step="1">${icon("arrow-left", 15)} ${t("ob.back")}</button>
      </div>`;
  } else {
    body = `
      <div class="ob-head">
        <h1 class="ob-title">${t("ob.verifyTitle")}</h1>
        <p class="ob-lead">${t("ob.verifyLead")}</p>
      </div>
      <div class="ob-guide">
        <div class="ob-guide-step"><span class="ob-guide-num">1</span><div><strong>${t("ob.g1Title")}</strong><span>${t("ob.g1Desc")}</span></div></div>
        <div class="ob-guide-step"><span class="ob-guide-num">2</span><div><strong>${t("ob.g2Title")}</strong><span>${t("ob.g2Desc")}</span></div></div>
        <div class="ob-guide-step"><span class="ob-guide-num">3</span><div><strong>${t("ob.g3Title")}</strong><span>${t("ob.g3Desc")}</span></div></div>
      </div>
      <div class="ob-actions ob-actions-column">
        <button class="ps5-btn secondary" data-act="epic-open-login">${icon("external", 15)} ${t("ob.openLogin")}</button>
        <input id="epic-code" class="ps5-input ob-code-input" placeholder='{"authorizationCode": "..."}' autocomplete="off" spellcheck="false" />
        <button class="ps5-btn primary" data-act="epic-do-login" ${S.epicBusy ? "disabled" : ""}>${S.epicBusy === "login" ? t("ob.loggingIn") : t("ob.login")}</button>
      </div>
      <div class="ob-actions">
        <button class="ps5-btn secondary" data-act="onboarding-goto" data-step="2">${icon("arrow-left", 15)} ${t("ob.back")}</button>
      </div>`;
  }

  return `
    <div class="onboarding-shell">
      <div class="onboarding-card">
        <div class="onboarding-stepper">${stepper}</div>
        <div class="onboarding-body">${body}</div>
      </div>
    </div>`;
}


/**
 * Efxlve Launcher — Authentication & Progressive Loading View.
 *
 * Renders the animated login screen with a 3D tilted game posters marquee,
 * unified input pill, and the progressive console synchronization sequence.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

/** Build the atmospheric backdrop using the authentic Epic Games background image. */
function renderAuthBackdrop(): string {
  return `
    <div class="auth-ambient-backdrop" aria-hidden="true">
      <div class="auth-bg-backdrop-art"></div>
      <div class="auth-vignette-overlay"></div>
      <div class="auth-aurora-blob auth-aurora-1"></div>
      <div class="auth-aurora-blob auth-aurora-2"></div>
    </div>`;
}

/** In-place DOM update for the progressive authentication sequence. */
export function updateAuthProgressUi(): void {
  const bar = document.getElementById("auth-progress-bar");
  const pct = document.getElementById("auth-progress-percent");
  const stage = document.getElementById("auth-stage-text");
  if (bar) bar.style.width = `${S.authProgress}%`;
  if (pct) pct.textContent = `${S.authProgress}%`;
  if (stage) stage.textContent = S.authStageText || "";

  const rows = document.querySelectorAll<HTMLElement>(".auth-step-row");
  if (rows.length >= 4) {
    const p = S.authProgress;
    // Step 0: Auth
    rows[0]?.classList.toggle("done", p >= 40);
    rows[0]?.classList.toggle("active", p < 40);
    // Step 1: Library & Catalog
    rows[1]?.classList.toggle("done", p >= 72);
    rows[1]?.classList.toggle("active", p >= 40 && p < 72);
    // Step 2: Achievements & Trophies
    rows[2]?.classList.toggle("done", p >= 90);
    rows[2]?.classList.toggle("active", p >= 72 && p < 90);
    // Step 3: Ready & Console Launch
    rows[3]?.classList.toggle("done", p >= 100);
    rows[3]?.classList.toggle("active", p >= 90 && p < 100);
  }
}

/** Render the standalone login / progressive loading / setup view. */
export function renderOnboarding(): string {
  const backgroundWall = renderAuthBackdrop();

  // 1. Initial Legendary binary setup phase (if required)
  if (S.epicPhase === "setup") {
    const pct = S.setupProgress ?? 0;
    return `
      <div class="auth-screen">
        ${backgroundWall}
        <div class="auth-card-wrapper">
          <div class="auth-card auth-setup-card">
            <div class="auth-emblem-halo">${icon("download", 28)}</div>
            <div class="auth-tagline-chip">BAŞLANGIÇ KURULUMU</div>
            <h1 class="auth-title">${t("ob.setupTitle")}</h1>
            <p class="auth-subtitle">${t("ob.setupLead")}</p>
            ${S.epicBusy === "download" ? `
              <div class="auth-progress-track"><div class="auth-progress-bar" style="width:${pct}%"></div></div>
              <p class="auth-loading-stage">${esc(S.setupMessage || t("ob.downloading"))}</p>
            ` : ""}
            <div style="margin-top: 6px;">
              <button class="auth-hero-login-btn" data-act="epic-download" ${S.epicBusy ? "disabled" : ""}>
                ${icon("download", 16)}
                <span>${S.epicBusy ? t("ob.downloading") : t("ob.setupDownload")}</span>
              </button>
            </div>
            <p class="auth-hero-hint">Kaynak: github.com/legendary-gl/legendary (GPL-3.0)</p>
          </div>
        </div>
      </div>`;
  }

  // 2. Cinematic Progressive Loading Sequence
  if (S.authLoading) {
    const p = S.authProgress;
    return `
      <div class="auth-screen">
        ${backgroundWall}
        <div class="auth-card-wrapper">
          <div class="auth-card auth-loading-card">
            <div class="auth-loading-halo">
              <div class="auth-loading-spinner"></div>
              <div class="auth-loading-emblem">
                ${icon("gamepad-2", 30)}
              </div>
            </div>

            <div class="auth-tagline-chip">BAŞLATILIYOR</div>
            <h2 class="auth-loading-title">${t("auth.syncingTitle")}</h2>
            <p class="auth-loading-stage" id="auth-stage-text">${esc(S.authStageText || t("auth.stageAuth"))}</p>

            <div class="auth-progress-track">
              <div class="auth-progress-bar" id="auth-progress-bar" style="width: ${p}%;"></div>
            </div>
            <div class="auth-progress-percent tabular-nums" id="auth-progress-percent">${p}%</div>

            <div class="auth-steps-list">
              <div class="auth-step-row ${p >= 40 ? "done" : "active"}">
                <span class="auth-step-pip">${p >= 40 ? icon("check", 12) : '<span class="auth-step-dot"></span>'}</span>
                <span>${t("auth.stepAuth")}</span>
              </div>
              <div class="auth-step-row ${p >= 72 ? "done" : p >= 40 ? "active" : ""}">
                <span class="auth-step-pip">${p >= 72 ? icon("check", 12) : '<span class="auth-step-dot"></span>'}</span>
                <span>${t("auth.stepCatalog")}</span>
              </div>
              <div class="auth-step-row ${p >= 90 ? "done" : p >= 72 ? "active" : ""}">
                <span class="auth-step-pip">${p >= 90 ? icon("check", 12) : '<span class="auth-step-dot"></span>'}</span>
                <span>${t("auth.stepTrophies")}</span>
              </div>
              <div class="auth-step-row ${p >= 100 ? "done" : p >= 90 ? "active" : ""}">
                <span class="auth-step-pip">${p >= 100 ? icon("check", 12) : '<span class="auth-step-dot"></span>'}</span>
                <span>${t("auth.stepReady")}</span>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  // 3. Cinematic Standalone Console Login View
  return `
    <div class="auth-screen">
      ${backgroundWall}

      <div class="auth-card-wrapper">
        <div class="auth-card">
          <!-- Brand Header -->
          <div class="auth-brand-header">
            <div class="auth-emblem-halo">
              ${icon("gamepad-2", 30)}
            </div>
            <div class="auth-tagline-chip">${t("auth.tagline")}</div>
            <h1 class="auth-title">Efxlve Launcher</h1>
            <p class="auth-subtitle">${t("auth.subtitle")}</p>
          </div>

          <!-- Focused Action Stack -->
          <div class="auth-action-stack">
            <!-- 1. Primary Action: Instant 1-Click EGL Import (Passwordless) -->
            <button class="auth-hero-import-btn" data-act="epic-import">
              <div class="auth-import-btn-icon">${icon("download", 20)}</div>
              <div class="auth-import-btn-body">
                <span class="auth-import-btn-title">${t("auth.importTitle")}</span>
                <span class="auth-import-btn-subtitle">${t("auth.importSubtitle")}</span>
              </div>
              <div class="auth-import-btn-arrow">${icon("arrow-right", 16)}</div>
            </button>

            <!-- Subtle Elegant Divider -->
            <div class="auth-section-divider">
              <span class="auth-divider-line"></span>
              <span class="auth-divider-pill">${t("auth.orDivider")}</span>
              <span class="auth-divider-line"></span>
            </div>

            <!-- 2. Web Sign-in Flow -->
            <button class="auth-hero-login-btn" data-act="epic-open-login">
              ${icon("external", 18)}
              <span>${t("auth.epicWebLogin")}</span>
            </button>

            <!-- Single Unified Code Pill Input -->
            <div class="auth-input-pill">
              <input
                id="epic-code"
                class="auth-pill-input"
                placeholder="${t("auth.pastePlaceholder")}"
                autocomplete="off"
                spellcheck="false"
              />
              <button class="auth-pill-paste-btn" data-act="auth-paste" title="${t("auth.pasteBtn")}">
                ${icon("copy", 13)}
                <span>${t("auth.pasteBtn")}</span>
              </button>
              <button class="auth-pill-submit-btn" data-act="epic-do-login" title="${t("auth.submitCode")}">
                ${icon("arrow-right", 15)}
              </button>
            </div>

            <!-- 3. First-Time User 3-Step Guide Box -->
            <div class="auth-guide-box">
              <div class="auth-guide-header">
                <div class="auth-guide-chip">
                  ${icon("info", 12)}
                  <span>${t("auth.guideBadge")}</span>
                </div>
              </div>
              <div class="auth-guide-steps">
                <div class="auth-guide-step">
                  <span class="auth-guide-num">1</span>
                  <div class="auth-guide-text">
                    <strong>${t("auth.guideStep1Title")}</strong> ${t("auth.guideStep1Desc")}
                  </div>
                </div>
                <div class="auth-guide-step">
                  <span class="auth-guide-num">2</span>
                  <div class="auth-guide-text">
                    <strong>${t("auth.guideStep2Title")}</strong> ${t("auth.guideStep2Desc")}
                  </div>
                </div>
                <div class="auth-guide-step">
                  <span class="auth-guide-num">3</span>
                  <div class="auth-guide-text">
                    <strong>${t("auth.guideStep3Title")}</strong> ${t("auth.guideStep3Desc")}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

/**
 * PlayStation 5 console-grade authentication & progressive loading view.
 *
 * Renders the standalone animated login stage, the progressive sync sequence,
 * and the initial legendary binary setup wizard. Follows AGENTS.md PS5 dark
 * console aesthetics and strict zero-emoji policy.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

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
  // 1. Initial Legendary binary setup phase (if required)
  if (S.epicPhase === "setup") {
    const pct = S.setupProgress ?? 0;
    return `
      <div class="auth-screen">
        <div class="auth-ambient-backdrop" aria-hidden="true">
          <div class="auth-aurora-blob auth-aurora-1"></div>
          <div class="auth-aurora-blob auth-aurora-2"></div>
        </div>
        <div class="auth-card-wrapper">
          <div class="auth-card auth-setup-card">
            <div class="auth-emblem-halo">${icon("download", 30)}</div>
            <div class="auth-badge">BAŞLANGIÇ KURULUMU</div>
            <h1 class="auth-title">${t("ob.setupTitle")}</h1>
            <p class="auth-subtitle">${t("ob.setupLead")}</p>
            ${S.epicBusy === "download" ? `
              <div class="auth-progress-track"><div class="auth-progress-bar" style="width:${pct}%"></div></div>
              <p class="auth-loading-stage">${esc(S.setupMessage || t("ob.downloading"))}</p>
            ` : ""}
            <div class="auth-actions-panel" style="margin-top: 6px;">
              <button class="ps5-btn primary auth-primary-login-btn" data-act="epic-download" ${S.epicBusy ? "disabled" : ""}>
                ${icon("download", 16)}
                <span>${S.epicBusy ? t("ob.downloading") : t("ob.setupDownload")}</span>
              </button>
            </div>
            <p class="auth-web-hint">Kaynak: github.com/legendary-gl/legendary (GPL-3.0)</p>
          </div>
        </div>
      </div>`;
  }

  // 2. Cinematic Progressive Loading Sequence
  if (S.authLoading) {
    const p = S.authProgress;
    return `
      <div class="auth-screen">
        <div class="auth-ambient-backdrop" aria-hidden="true">
          <div class="auth-aurora-blob auth-aurora-1"></div>
          <div class="auth-aurora-blob auth-aurora-2"></div>
        </div>

        <div class="auth-card-wrapper">
          <div class="auth-card auth-loading-card">
            <div class="auth-loading-halo">
              <div class="auth-loading-spinner"></div>
              <div class="auth-loading-emblem">
                ${icon("gamepad-2", 32)}
              </div>
            </div>

            <div class="auth-badge">BAŞLATILIYOR</div>
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
      <div class="auth-ambient-backdrop" aria-hidden="true">
        <div class="auth-aurora-blob auth-aurora-1"></div>
        <div class="auth-aurora-blob auth-aurora-2"></div>
      </div>

      <div class="auth-card-wrapper">
        <div class="auth-card">
          <!-- Console Brand Header -->
          <div class="auth-brand-header">
            <div class="auth-emblem-halo">
              ${icon("gamepad-2", 34)}
            </div>
            <div class="auth-badge">PLAYSTATION 5 CONSOLE ARCHITECTURE</div>
            <h1 class="auth-title">EFXLVE</h1>
            <p class="auth-subtitle">Epic Games Kütüphaneniz İçin Bağımsız Konsol Deneyimi</p>
          </div>

          <!-- Action Panel -->
          <div class="auth-actions-panel">
            <!-- 1. Epic Games Web Girişi (Birincil) -->
            <div class="auth-web-section">
              <button class="ps5-btn primary auth-primary-login-btn" data-act="epic-open-login">
                ${icon("external", 18)}
                <span>${t("auth.epicWebLogin")}</span>
              </button>
              <div class="auth-web-hint">${t("auth.webHint")}</div>
            </div>

            <!-- 2. Yetkilendirme Kodu Giriş Alanı -->
            <div class="auth-code-container">
              <div class="auth-input-group">
                <input
                  id="epic-code"
                  class="ps5-input auth-code-input"
                  placeholder='${t("auth.pastePlaceholder")}'
                  autocomplete="off"
                  spellcheck="false"
                />
                <button class="auth-paste-btn" data-act="auth-paste" title="${t("auth.pasteBtn")}">
                  ${icon("copy", 14)}
                  <span>${t("auth.pasteBtn")}</span>
                </button>
              </div>
              <button class="ps5-btn primary auth-submit-btn" data-act="epic-do-login" ${S.epicBusy ? "disabled" : ""}>
                ${icon("chevron-right", 16)}
                <span>${S.epicBusy === "login" ? t("ob.loggingIn") : t("auth.submitCode")}</span>
              </button>
            </div>

            <!-- VEYA Ayırıcı -->
            <div class="auth-divider">
              <span class="auth-divider-line"></span>
              <span class="auth-divider-text">${t("auth.or")}</span>
              <span class="auth-divider-line"></span>
            </div>

            <!-- 3. Epic Games Launcher'dan İçe Aktar (İkincil Kart) -->
            <button class="auth-import-card" data-act="epic-import" ${S.epicBusy ? "disabled" : ""}>
              <div class="auth-import-icon">${icon("download", 18)}</div>
              <div class="auth-import-info">
                <div class="auth-import-title">${t("auth.importShort")}</div>
                <div class="auth-import-desc">${t("auth.importDescShort")}</div>
              </div>
              <span class="auth-import-arrow">${icon("chevron-right", 16)}</span>
            </button>
          </div>

          <!-- Alt Konsol Rozetleri (3'lü Özellik Çubuğu) -->
          <div class="auth-features-bar">
            <div class="auth-feature-pill">
              ${icon("zap", 14)}
              <span>120 FPS Akıcı Konsol</span>
            </div>
            <div class="auth-feature-pill">
              ${icon("gamepad-2", 14)}
              <span>Koltuk &amp; Gamepad</span>
            </div>
            <div class="auth-feature-pill">
              ${icon("shield-check", 14)}
              <span>Resmi &amp; Güvenli</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

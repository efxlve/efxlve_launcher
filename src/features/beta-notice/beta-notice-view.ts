/**
 * Beta milestone announcement & thank-you popup.
 *
 * Expresses appreciation to beta testers, announces the upcoming v1.0 milestone,
 * and provides direct channels to report issues (in-app feedback, GitHub, Discord).
 */

import { betaNoticeRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

export function openBetaNotice(): void {
  renderBetaNotice();
}

export function closeBetaNotice(): void {
  if (betaNoticeRoot) betaNoticeRoot.innerHTML = "";
}

function renderBetaNotice(): void {
  if (!betaNoticeRoot) return;

  betaNoticeRoot.innerHTML = `
    <div class="confirm-layer beta-notice-layer">
      <div class="modal-backdrop" data-act="close-beta-notice">
        <div class="modal beta-notice-modal" role="dialog" aria-modal="true" aria-labelledby="beta-notice-title" data-act="prevent-modal-close">
          <div class="beta-notice-head">
            <span class="beta-notice-head-mark">
              ${icon("heart", 18)}
            </span>
            <div class="beta-notice-head-text">
              <h3 class="beta-notice-title" id="beta-notice-title">${esc(t("betaNotice.title"))}</h3>
              <p class="beta-notice-sub">${esc(t("betaNotice.phaseTag"))}</p>
            </div>
            <button type="button" class="manage-head-close" data-act="close-beta-notice" title="${esc(t("common.close"))}">
              ${icon("x", 16)}
            </button>
          </div>

          <div class="beta-notice-body">
            <div class="beta-notice-message">
              <p class="beta-notice-p beta-notice-heartfelt">${esc(t("betaNotice.heartfelt"))}</p>
              <p class="beta-notice-p">${esc(t("betaNotice.roadmap"))}</p>
            </div>

            <div class="beta-notice-cards">
              <div class="beta-notice-card" data-act="beta-notice-feedback">
                <span class="beta-notice-card-icon">
                  ${icon("alert-triangle", 16)}
                </span>
                <div class="beta-notice-card-content">
                  <span class="beta-notice-card-title">${esc(t("betaNotice.reportInAppTitle"))}</span>
                  <span class="beta-notice-card-desc">${esc(t("betaNotice.reportInAppDesc"))}</span>
                </div>
                <span class="beta-notice-card-action">${icon("arrow-right", 14)}</span>
              </div>

              <div class="beta-notice-card" data-act="beta-notice-github">
                <span class="beta-notice-card-icon">
                  ${icon("github", 16)}
                </span>
                <div class="beta-notice-card-content">
                  <span class="beta-notice-card-title">${esc(t("betaNotice.githubTitle"))}</span>
                  <span class="beta-notice-card-desc">${esc(t("betaNotice.githubDesc"))}</span>
                </div>
                <span class="beta-notice-card-action">${icon("external", 14)}</span>
              </div>

              <div class="beta-notice-card" data-act="beta-notice-discord">
                <span class="beta-notice-card-icon">
                  ${icon("discord", 16)}
                </span>
                <div class="beta-notice-card-content">
                  <span class="beta-notice-card-title">${esc(t("betaNotice.discordTitle"))}</span>
                  <span class="beta-notice-card-desc">${esc(t("betaNotice.discordDesc"))}</span>
                </div>
                <span class="beta-notice-card-action">${icon("external", 14)}</span>
              </div>
            </div>
          </div>

          <div class="beta-notice-foot">
            <button type="button" class="btn primary" data-act="close-beta-notice">
              ${esc(t("betaNotice.understandBtn"))}
            </button>
          </div>
        </div>
      </div>
    </div>`;
}

// Escape key closes the notice when visible.
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape" || !betaNoticeRoot || !betaNoticeRoot.firstElementChild) return;
    event.stopPropagation();
    closeBetaNotice();
  },
  true,
);

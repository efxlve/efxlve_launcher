/**
 * Beta milestone announcement & thank-you popup.
 *
 * Expresses appreciation to beta testers, announces the upcoming v1.0 milestone,
 * and provides direct channels to report issues (in-app feedback, GitHub, Discord).
 *
 * The storefront, Spotify, and Discord pages are native child webviews: there the
 * popup is presented in the top-level notification child overlay so it stays visible
 * and interactive above them. In all other views, the standard in-page DOM modal is used.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../../core/constants";
import { betaNoticeRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { overlayThemeStyle } from "../../core/overlay-theme";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { openFeedback } from "../feedback/feedback-view";
import { embeddedContentShown, holdStoreOverlay, releaseStoreOverlay } from "../store/store-view";

/** True while the popup floats in the native child host instead of the DOM. */
let betaNoticeOverlayOn = false;

/** Debounce guard to avoid handling duplicate events from synthesized clicks. */
let lastHandledAct = "";
let lastHandledTime = 0;

export function isBetaNoticeOpen(): boolean {
  return betaNoticeOverlayOn || Boolean(betaNoticeRoot?.firstElementChild);
}

export function openBetaNotice(): void {
  if (embeddedContentShown()) {
    void presentBetaNoticeOverlay();
    return;
  }
  void holdStoreOverlay("beta-notice");
  renderBetaNotice();
}

export function closeBetaNotice(): void {
  if (betaNoticeRoot) betaNoticeRoot.innerHTML = "";
  if (betaNoticeOverlayOn) {
    betaNoticeOverlayOn = false;
    if (isTauri) void invoke("hide_notif_overlay").catch(() => undefined);
  }
  releaseStoreOverlay("beta-notice");
}

export function renderBetaNotice(): void {
  if (!betaNoticeRoot) return;
  betaNoticeRoot.innerHTML = betaNoticeModalHtml();
}

/** Sizes the child host to the modal card and centers it over the embedded page. */
async function presentBetaNoticeOverlay(): Promise<void> {
  if (!isTauri) {
    void holdStoreOverlay("beta-notice");
    renderBetaNotice();
    return;
  }

  // Measure the real card in the DOM first to size the child host accurately.
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-4000px;top:0;width:560px;visibility:hidden;";
  holder.innerHTML = betaNoticeModalHtml();
  document.body.appendChild(holder);
  const card = holder.querySelector<HTMLElement>(".beta-notice-modal");
  const width = Math.min(card?.offsetWidth ?? 560, window.innerWidth - 32);
  const height = Math.min(card?.offsetHeight ?? 480, Math.round(window.innerHeight * 0.9));
  holder.remove();

  // Centered on the launcher window, exactly where the in-page modal sits.
  const x = Math.max(8, Math.round((window.innerWidth - width) / 2));
  const y = Math.max(8, Math.round((window.innerHeight - height) / 2));
  betaNoticeOverlayOn = true;
  try {
    await invoke("show_notif_overlay", {
      x,
      y,
      width,
      height,
      html: overlayThemeStyle() + betaNoticeOverlayStyle() + betaNoticeModalHtml(),
    });
  } catch {
    betaNoticeOverlayOn = false;
    void holdStoreOverlay("beta-notice");
    renderBetaNotice();
  }
}

function handleOverlayAction(act: string): void {
  const now = Date.now();
  if (act === lastHandledAct && now - lastHandledTime < 250) return;
  lastHandledAct = act;
  lastHandledTime = now;

  if (act === "close-beta-notice" || act === "overlay-close") {
    closeBetaNotice();
  } else if (act === "beta-notice-feedback") {
    closeBetaNotice();
    openFeedback();
  } else if (act === "beta-notice-github") {
    void openUrl("https://github.com/efxlve/efxlve_launcher/issues").catch((error) => toast(String(error), "err"));
  } else if (act === "beta-notice-discord") {
    void openUrl("https://discord.gg/3TY8hNTx5M").catch((error) => toast(String(error), "err"));
  }
}

if (isTauri) {
  void listen<{ act?: string; id?: string }>("notif-overlay-act", (event) => {
    if (!betaNoticeOverlayOn) return;
    const act = event.payload?.act;
    if (act) handleOverlayAction(act);
  });
}

function betaNoticeOverlayStyle(): string {
  return `<style>
    html, body {
      margin: 0;
      height: 100%;
      background: #000000;
      color: var(--text, #ffffff);
      overflow: hidden;
      font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    }
    * {
      box-sizing: border-box;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.14) transparent;
    }
    .beta-notice-layer, .beta-notice-backdrop {
      position: absolute;
      inset: 0;
      display: flex;
      padding: 0;
      margin: 0;
      background: transparent;
    }
    .beta-notice-modal {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
      padding: 0;
      margin: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: var(--surface-1, #0a0a0a);
      border: 1px solid var(--line-strong, rgba(255, 255, 255, 0.12));
      border-radius: var(--r-md, 10px);
      box-shadow: var(--shadow-pop, 0 16px 40px rgba(0, 0, 0, 0.5));
    }
    .beta-notice-head {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      flex-shrink: 0;
      padding: 18px 20px 16px;
      border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.06));
    }
    .beta-notice-head-mark {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      flex-shrink: 0;
      border: 1px solid var(--line-strong, rgba(255, 255, 255, 0.12));
      border-radius: var(--r-sm, 6px);
      background: var(--surface-2, #141414);
      color: var(--text-2, #9a9a9a);
    }
    .beta-notice-head-mark svg {
      width: 18px;
      height: 18px;
    }
    .beta-notice-head-text {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
      flex: 1;
      padding-top: 1px;
    }
    .beta-notice-title {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--text, #ffffff);
    }
    .beta-notice-sub {
      margin: 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-2, #9a9a9a);
    }
    .manage-head-close {
      display: inline-grid;
      place-items: center;
      width: 32px;
      height: 32px;
      flex-shrink: 0;
      border: none;
      border-radius: var(--r-sm, 6px);
      background: transparent;
      color: var(--text-2, #9a9a9a);
      cursor: pointer;
      margin: -4px -6px 0 0;
    }
    .manage-head-close:hover {
      background: var(--surface-2, #141414);
      color: var(--text, #ffffff);
    }
    .manage-head-close svg {
      width: 16px;
      height: 16px;
    }
    .beta-notice-body {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 0;
      padding: 16px 20px 18px;
      overflow-y: auto;
      flex: 1;
      max-height: none;
    }
    .beta-notice-message {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 14px;
      background: var(--surface-2, #141414);
      border: 1px solid var(--line, rgba(255, 255, 255, 0.06));
      border-radius: var(--r-sm, 6px);
    }
    .beta-notice-p {
      margin: 0;
      font-size: 12px;
      line-height: 1.55;
      color: var(--text-2, #9a9a9a);
    }
    .beta-notice-p.beta-notice-heartfelt {
      color: var(--text, #ffffff);
    }
    .beta-notice-cards {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .beta-notice-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 11px 13px;
      background: var(--surface-2, #141414);
      border: 1px solid var(--line, rgba(255, 255, 255, 0.06));
      border-radius: var(--r-sm, 6px);
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      user-select: none;
      transition: background-color 0.15s ease, border-color 0.15s ease;
    }
    .beta-notice-card:hover {
      background: var(--surface-3, #1e1e1e);
      border-color: var(--line-strong, rgba(255, 255, 255, 0.12));
    }
    .beta-notice-card-icon {
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      flex-shrink: 0;
      border-radius: var(--r-sm, 6px);
      background: var(--surface-1, #0a0a0a);
      border: 1px solid var(--line, rgba(255, 255, 255, 0.06));
      color: var(--text-2, #9a9a9a);
    }
    .beta-notice-card:hover .beta-notice-card-icon {
      color: var(--text, #ffffff);
    }
    .beta-notice-card-icon svg {
      width: 16px;
      height: 16px;
    }
    .beta-notice-card-content {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }
    .beta-notice-card-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text, #ffffff);
    }
    .beta-notice-card-desc {
      font-size: 11.5px;
      line-height: 1.4;
      color: var(--text-2, #9a9a9a);
    }
    .beta-notice-card-action {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      flex-shrink: 0;
      color: var(--text-3, #5c5c5c);
    }
    .beta-notice-card:hover .beta-notice-card-action {
      color: var(--text, #ffffff);
    }
    .beta-notice-card-action svg {
      width: 14px;
      height: 14px;
    }
    .beta-notice-foot {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-shrink: 0;
      padding: 12px 20px;
      border-top: 1px solid var(--line, rgba(255, 255, 255, 0.06));
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      height: 32px;
      padding: 0 14px;
      border: 1px solid transparent;
      border-radius: var(--r-sm, 6px);
      background: var(--surface-2, #141414);
      color: var(--text, #ffffff);
      font-size: 13px;
      font-weight: 500;
      font-family: inherit;
      white-space: nowrap;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .btn:hover {
      background: var(--surface-3, #1e1e1e);
    }
    .btn.primary {
      background: var(--accent, #ffffff);
      color: var(--on-accent, #000000);
      font-weight: 600;
    }
    .btn.primary:hover {
      background: var(--accent-hover, #e0e0e0);
    }
  </style>`;
}

export function betaNoticeModalHtml(): string {
  return `
    <div class="confirm-layer beta-notice-layer">
      <div class="modal-backdrop beta-notice-backdrop" data-act="close-beta-notice">
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

// Escape key closes the notice when visible in the main DOM.
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape" || !isBetaNoticeOpen()) return;
    event.stopPropagation();
    closeBetaNotice();
  },
  true,
);

// Window resize re-centers the overlay if open.
window.addEventListener("resize", () => {
  if (betaNoticeOverlayOn) {
    void presentBetaNoticeOverlay();
  }
});

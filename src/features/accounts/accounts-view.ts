/**
 * Accounts page: one connector card per store (Epic today, GOG next).
 *
 * There is no blocking sign-in screen: the launcher always opens its shell and
 * each store is connected from here. A connector card owns its own states
 * (setup, signed out, connecting, connected) so adding a store later is only a
 * new card, not a new app-wide auth phase.
 */

import { emptyState, icon } from "../../core/icons";
import { getCustomAvatar, S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

/** Progress thresholds for the four post-login steps. */
const STEP_DONE_AT = [40, 72, 90, 100];

/** In-place DOM update for the connecting sequence inside the Epic card. */
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

function connectingBlock(): string {
  const p = S.authProgress;
  const steps = [t("auth.stepAuth"), t("auth.stepCatalog"), t("auth.stepTrophies"), t("auth.stepReady")];
  return `
    <p class="acc-lead" id="auth-stage-text">${esc(S.authStageText || t("auth.stageAuth"))}</p>
    <div class="auth-progress-row">
      <div class="progress auth-progress"><span id="auth-progress-bar" style="width:${p}%"></span></div>
      <span class="tabular-nums acc-hint" id="auth-progress-percent">${p}%</span>
    </div>
    <ol class="auth-steps">
      ${steps.map((label, i) => {
        const doneAt = STEP_DONE_AT[i];
        const startAt = i === 0 ? 0 : STEP_DONE_AT[i - 1];
        return `<li class="auth-step-row ${p >= doneAt ? "done" : p >= startAt ? "active" : ""}"><span class="auth-step-pip">${icon("check", 12)}</span>${label}</li>`;
      }).join("")}
    </ol>`;
}

function setupBlock(): string {
  const pct = S.setupProgress ?? 0;
  return `
    <p class="acc-lead">${t("ob.setupLead")}</p>
    ${S.epicBusy === "download" ? `
      <div class="progress auth-progress"><span style="width:${pct}%"></span></div>
      <p class="acc-hint">${esc(S.setupMessage || t("ob.downloading"))}</p>` : ""}
    <div class="acc-actions">
      <button class="btn primary" data-act="epic-download" ${S.epicBusy ? "disabled" : ""}>${icon("download", 14)} ${S.epicBusy ? t("ob.downloading") : t("ob.setupDownload")}</button>
    </div>
    <p class="acc-hint">${t("auth.sourceNote")}</p>`;
}

function signInBlock(allowCancel: boolean): string {
  return `
    <div class="acc-signin">
      <div class="acc-actions">
        <button class="btn primary" data-act="epic-open-login">${icon("external", 14)} ${t("auth.epicWebLogin")}</button>
        <button class="btn ghost" data-act="epic-import" title="${esc(t("auth.importSubtitle"))}">${icon("download", 14)} ${t("auth.importTitle")}</button>
        ${allowCancel ? `<button class="btn ghost" data-act="auth-cancel">${t("common.cancel")}</button>` : ""}
      </div>
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
    </div>`;
}

function avatar(url: string | null, name: string): string {
  return `<span class="settings-avatar">${url ? `<img src="${esc(url)}" alt="" />` : esc((name.trim()[0] || "?").toUpperCase())}</span>`;
}

function connectedBlock(): string {
  const accountId = S.playerProfileData?.account_id || S.epicAccountId || "";
  const current = getCustomAvatar();
  const rows = (S.savedAccounts || []).map((acc) => {
    const isCurrent = acc.is_active || acc.account_id === accountId || acc.display_name === S.epicAccount;
    const url = S.customAvatars[acc.account_id] || (isCurrent ? current : null);
    const actions = isCurrent
      ? `<span class="chip ok">${t("settings.accountActiveBadge")}</span>`
      : `<button class="btn small" data-act="account-switch" data-id="${esc(acc.account_id)}">${t("settings.accountSwitchBtn")}</button>
         <button class="icon-btn danger" data-act="account-remove" data-id="${esc(acc.account_id)}" title="${t("settings.accountRemove")}">${icon("trash", 14)}</button>`;
    return `
      <div class="row">
        ${avatar(url, acc.display_name)}
        <div class="row-main"><div class="row-title">${esc(acc.display_name)}</div></div>
        <div class="row-actions">${actions}</div>
      </div>`;
  }).join("");

  return `
    <div class="list acc-accounts">
      ${rows || `<div class="row">${avatar(current, S.epicAccount)}<div class="row-main"><div class="row-title">${esc(S.epicAccount)}</div><div class="row-meta">${S.epicSummaries.length} ${t("settings.accountTotalGames")}</div></div><div class="row-actions"><span class="chip ok">${t("settings.accountActiveBadge")}</span></div></div>`}
    </div>
    ${S.accountsAddMode ? signInBlock(true) : `
      <div class="acc-actions">
        <button class="btn ghost small" data-act="account-add">${icon("plus", 13)} ${t("settings.accountAdd")}</button>
        <button class="btn ghost small" data-view="profile">${t("palette.cmdProfile")}</button>
        <span class="acc-spacer"></span>
        <button class="btn ghost danger small" data-act="epic-logout">${t("settings.logout")}</button>
      </div>`}`;
}

function epicCard(): string {
  const connected = Boolean(S.epicAccount) && S.epicPhase === "library";
  const status = S.authLoading
    ? `<span class="chip">${t("auth.syncingTitle")}</span>`
    : S.epicPhase === "setup"
      ? `<span class="chip warn">${t("accounts.setupNeeded")}</span>`
      : connected
        ? `<span class="chip ok">${t("accounts.connected")}</span>`
        : `<span class="chip">${t("accounts.notConnected")}</span>`;
  const body = S.authLoading
    ? connectingBlock()
    : S.epicPhase === "setup"
      ? setupBlock()
      : connected
        ? connectedBlock()
        : `<p class="acc-lead">${t("accounts.epicDesc")}</p>${signInBlock(false)}`;
  return `
    <section class="card acc-card">
      <div class="acc-card-head">
        <span class="acc-store-mark">E</span>
        <div class="row-main"><div class="acc-store-name">Epic Games</div><div class="row-meta">${connected ? esc(S.epicAccount) : t("accounts.epicShort")}</div></div>
        ${status}
      </div>
      <div class="acc-card-body">${body}</div>
    </section>`;
}

function gogCard(): string {
  return `
    <section class="card acc-card acc-card-soon">
      <div class="acc-card-head">
        <span class="acc-store-mark">G</span>
        <div class="row-main"><div class="acc-store-name">GOG.COM</div><div class="row-meta">${t("accounts.gogDesc")}</div></div>
        <span class="chip">${t("accounts.soon")}</span>
      </div>
    </section>`;
}

/** Account list, switch, add and sign-out, embedded in Settings. */
export function renderAccountSettings(): string {
  const connected = Boolean(S.epicAccount) && S.epicPhase === "library";
  if (!connected) {
    return `<div class="settings-accounts"><p class="page-sub">${t("accounts.epicDesc")}</p>${signInBlock(false)}</div>`;
  }
  const accountId = S.playerProfileData?.account_id || S.epicAccountId || "";
  const current = getCustomAvatar();
  const saved = S.savedAccounts || [];
  const rows = saved.length > 0
    ? saved.map((acc) => {
        const isCurrent = acc.is_active || acc.account_id === accountId || acc.display_name === S.epicAccount;
        const url = S.customAvatars[acc.account_id] || (isCurrent ? current : null);
        const actions = isCurrent
          ? `<span class="chip ok">${t("settings.accountActiveBadge")}</span>`
          : `<button class="btn small" data-act="account-switch" data-id="${esc(acc.account_id)}">${t("settings.accountSwitchBtn")}</button>
             <button class="icon-btn danger" data-act="account-remove" data-id="${esc(acc.account_id)}" title="${t("settings.accountRemove")}">${icon("trash", 14)}</button>`;
        return `
          <div class="row">
            ${avatar(url, acc.display_name)}
            <div class="row-main"><div class="row-title">${esc(acc.display_name)}</div></div>
            <div class="row-actions">${actions}</div>
          </div>`;
      }).join("")
    : `<div class="row">${avatar(current, S.epicAccount)}<div class="row-main"><div class="row-title">${esc(S.epicAccount)}</div><div class="row-meta">${S.epicSummaries.length} ${t("settings.accountTotalGames")}</div></div><div class="row-actions"><span class="chip ok">${t("settings.accountActiveBadge")}</span></div></div>`;
  const tools = S.accountsAddMode
    ? signInBlock(true)
    : `<div class="acc-actions">
        <button class="btn ghost small" data-act="account-add">${icon("plus", 13)} ${t("settings.accountAdd")}</button>
        <button class="btn ghost danger small" data-act="epic-logout">${t("settings.logout")}</button>
      </div>`;
  return `<div class="settings-accounts"><div class="list">${rows}</div>${tools}</div>`;
}

export function renderAccounts(): string {
  if (S.epicPhase === "checking") return emptyState("users", t("accounts.title"), `<span class="spinner"></span>`);
  return `
    <div class="page acc-page">
      <p class="page-sub acc-intro">${t("accounts.subtitle")}</p>
      ${epicCard()}
      ${gogCard()}
    </div>`;
}

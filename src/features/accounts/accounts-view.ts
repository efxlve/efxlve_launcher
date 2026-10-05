/**
 * Accounts page: one card per store, grouped by how the store works.
 *
 * There is no blocking sign-in screen: the launcher always opens its shell and
 * each store is connected from here. A card owns its own states (setup, signed
 * out, connecting, connected) so adding a store later is only a new card, not a
 * new app-wide auth phase. Each card carries a collapsed support matrix so a
 * user can see what the store does, what its own client keeps, and what is not
 * available at all, without the page turning into a wall of text.
 */

import { emptyState, icon } from "../../core/icons";
import { render } from "../../core/render";
import { avatarFor, getCustomAvatar, S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { storeLogo } from "../store/store-logos";

/** Progress thresholds for the four post-login steps. */
const STEP_DONE_AT = [40, 72, 90, 100];

/* ---------- Support matrix ---------- */

/** How one capability is provided: by the launcher, by the client, or not at all. */
type CapState = "yes" | "via" | "local" | "no" | "hotkey" | "clientTool";

interface Cap {
  /** Feature label key, resolved as `accounts.cap.<key>`. */
  key: string;
  state: CapState;
}

const CAP_STATE_ICON: Record<CapState, string> = {
  yes: "check",
  via: "external",
  local: "timer",
  no: "x",
  hotkey: "camera",
  clientTool: "camera",
};

/** What each store can and cannot do, shown inside the card's details block. */
const CAPS: Record<string, Cap[]> = {
  epic: [
    { key: "library", state: "yes" },
    { key: "install", state: "yes" },
    { key: "uninstall", state: "yes" },
    { key: "launch", state: "yes" },
    { key: "achievements", state: "yes" },
    { key: "playtime", state: "yes" },
    { key: "cloud", state: "yes" },
    { key: "store", state: "yes" },
    { key: "screenshots", state: "hotkey" },
  ],
  gog: [
    { key: "library", state: "yes" },
    { key: "install", state: "yes" },
    { key: "uninstall", state: "yes" },
    { key: "launch", state: "yes" },
    { key: "achievements", state: "yes" },
    { key: "playtime", state: "yes" },
    { key: "cloud", state: "yes" },
    { key: "store", state: "yes" },
    { key: "screenshots", state: "hotkey" },
  ],
  steam: [
    { key: "library", state: "yes" },
    { key: "install", state: "via" },
    { key: "uninstall", state: "via" },
    { key: "launch", state: "via" },
    { key: "achievements", state: "yes" },
    { key: "playtime", state: "yes" },
    { key: "cloud", state: "yes" },
    { key: "store", state: "yes" },
    { key: "screenshots", state: "clientTool" },
  ],
  ea: [
    { key: "library", state: "yes" },
    { key: "install", state: "via" },
    { key: "uninstall", state: "via" },
    { key: "launch", state: "yes" },
    { key: "achievements", state: "yes" },
    { key: "playtime", state: "yes" },
    { key: "cloud", state: "via" },
    { key: "store", state: "yes" },
    { key: "screenshots", state: "hotkey" },
  ],
  ubisoft: [
    { key: "library", state: "yes" },
    { key: "install", state: "via" },
    { key: "uninstall", state: "via" },
    { key: "launch", state: "yes" },
    { key: "achievements", state: "yes" },
    { key: "playtime", state: "yes" },
    { key: "cloud", state: "via" },
    { key: "store", state: "yes" },
    { key: "screenshots", state: "clientTool" },
  ],
  xbox: [
    { key: "library", state: "yes" },
    { key: "install", state: "via" },
    { key: "uninstall", state: "via" },
    { key: "launch", state: "yes" },
    { key: "achievements", state: "yes" },
    { key: "playtime", state: "yes" },
    { key: "cloud", state: "via" },
    { key: "store", state: "yes" },
    { key: "screenshots", state: "hotkey" },
  ],
  battlenet: [
    { key: "library", state: "yes" },
    { key: "install", state: "via" },
    { key: "uninstall", state: "via" },
    { key: "launch", state: "yes" },
    { key: "achievements", state: "no" },
    { key: "playtime", state: "local" },
    { key: "cloud", state: "via" },
    { key: "store", state: "yes" },
    { key: "screenshots", state: "hotkey" },
  ],
  amazon: [
    { key: "library", state: "yes" },
    { key: "install", state: "yes" },
    { key: "uninstall", state: "yes" },
    { key: "launch", state: "yes" },
    // Nile ships no achievement feed and Amazon has no cloud saves; the
    // launcher records playtime locally and backs saves up from the manage
    // panel instead.
    { key: "achievements", state: "no" },
    { key: "playtime", state: "local" },
    { key: "cloud", state: "no" },
    { key: "store", state: "yes" },
    { key: "screenshots", state: "hotkey" },
  ],
  riot: [
    { key: "library", state: "yes" },
    { key: "install", state: "via" },
    { key: "uninstall", state: "via" },
    { key: "launch", state: "yes" },
    { key: "achievements", state: "no" },
    { key: "playtime", state: "local" },
    // Riot syncs cloud saves inside its own client, and it has no web
    // storefront at all.
    { key: "cloud", state: "via" },
    { key: "store", state: "no" },
    { key: "screenshots", state: "hotkey" },
  ],
};

/** One row of the support matrix: feature, how it is provided, and the state. */
function capabilityRow(cap: Cap): string {
  return `<div class="acc-feature ${cap.state}">
    <span class="acc-feature-icon">${icon(CAP_STATE_ICON[cap.state] as Parameters<typeof icon>[0], 13)}</span>
    <span class="acc-feature-label">${t(`accounts.cap.${cap.key}`)}</span>
    <span class="acc-feature-state">${t(`accounts.capState.${cap.state}`)}</span>
  </div>`;
}

/**
 * Collapsed support matrix. The cards stay short; the detail a curious user
 * needs (what the store supports, what the client keeps) is one click away.
 */
function supportDetails(store: string): string {
  const caps = CAPS[store] || [];
  if (caps.length === 0) return "";
  const note = t(`accounts.note.${store}`);
  return `<details class="acc-details">
    <summary>${icon("info", 13)} <span>${t("accounts.supportTitle")}</span></summary>
    <div class="acc-features">${caps.map(capabilityRow).join("")}</div>
    <p class="acc-hint">${note}</p>
  </details>`;
}

/** One-line explanation box, used to keep confusing points out of the cards. */
function infoBox(key: string): string {
  return `<div class="info-box">${icon("info", 14)}<span>${t(key)}</span></div>`;
}

/** Section caption that groups the cards. */
function groupTitle(key: string): string {
  return `<h3 class="section-title acc-group-title">${t(key)}</h3>`;
}

/** A store that is announced but not available yet. */
function soonCard(id: string, title: string, descKey: string): string {
  return `
    <section class="card acc-card soon">
      <div class="acc-card-head">
        <span class="acc-store-mark">${storeLogo(id)}</span>
        <div class="row-main">
          <div class="acc-store-name">${esc(title)}</div>
          <div class="row-meta">${t(descKey)}</div>
        </div>
        <span class="chip warn">${t("accounts.soon")}</span>
      </div>
    </section>`;
}

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

/**
 * Avatar for an account row. Clicking it edits that account's own photo
 * (the badge makes the action discoverable).
 */
function avatar(url: string | null, name: string, key?: string): string {
  const initial = (name.trim()[0] || "?").toUpperCase();
  const face = `<span class="settings-avatar">${url ? `<img src="${esc(url)}" alt="" />` : esc(initial)}</span>`;
  if (!key) return face;
  const title = url ? t("profile.changeAvatarTitle") : t("profile.uploadAvatarTitle");
  return `<button type="button" class="avatar-edit-btn" data-act="profile-change-avatar" data-key="${esc(key)}" data-name="${esc(name)}" title="${esc(title)}" aria-label="${esc(title)}">
    ${face}
    <span class="avatar-edit-badge" aria-hidden="true">${icon("camera", 11)}</span>
  </button>`;
}

function connectedBlock(): string {
  const accountId = S.playerProfileData?.account_id || S.epicAccountId || "";
  const current = getCustomAvatar();
  const rows = (S.savedAccounts || []).map((acc) => {
    const isCurrent = acc.is_active || acc.account_id === accountId || acc.display_name === S.epicAccount;
    const url = avatarFor(`epic:${acc.account_id}`);
    const actions = isCurrent
      ? `<span class="chip ok">${t("settings.accountActiveBadge")}</span>`
      : `<button class="btn small" data-act="account-switch" data-id="${esc(acc.account_id)}">${t("settings.accountSwitchBtn")}</button>
         <button class="icon-btn danger" data-act="account-remove" data-id="${esc(acc.account_id)}" title="${t("settings.accountRemove")}">${icon("trash", 14)}</button>`;
    return `
      <div class="row">
        ${avatar(url, acc.display_name, `epic:${acc.account_id}`)}
        <div class="row-main"><div class="row-title">${esc(acc.display_name)}</div></div>
        <div class="row-actions">${actions}</div>
      </div>`;
  }).join("");

  return `
    <div class="list acc-accounts">
      ${rows || `<div class="row">${avatar(current, S.epicAccount, `epic:${accountId}`)}<div class="row-main"><div class="row-title">${esc(S.epicAccount)}</div><div class="row-meta">${S.epicSummaries.length} ${t("settings.accountTotalGames")}</div></div><div class="row-actions"><span class="chip ok">${t("settings.accountActiveBadge")}</span></div></div>`}
    </div>
    ${S.accountsAddMode ? signInBlock(true) : `
      <div class="acc-actions">
        <button class="btn ghost small" data-act="account-add">${icon("plus", 13)} ${t("settings.accountAdd")}</button>
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
        <span class="acc-store-mark">${storeLogo("epic")}</span>
        <div class="row-main"><div class="acc-store-name">Epic Games</div><div class="row-meta">${connected ? esc(S.epicAccount) : t("accounts.epicShort")}</div></div>
        ${status}
      </div>
      <div class="acc-card-body">${body}${supportDetails("epic")}</div>
    </section>`;
}

function gogSignInBlock(): string {
  return `
    <div class="acc-signin">
      <div class="acc-actions">
        <button class="btn primary" data-act="gog-open-login">${icon("external", 14)} ${t("gog.webLogin")}</button>
      </div>
      <div class="auth-code">
        <input id="gog-code" class="input" placeholder="${t("gog.pastePlaceholder")}" autocomplete="off" spellcheck="false" />
        <button class="btn ghost" data-act="gog-paste" title="${t("auth.pasteBtn")}">${icon("copy", 14)} ${t("auth.pasteBtn")}</button>
        <button class="btn primary icon-only" data-act="gog-do-login" title="${t("auth.submitCode")}">${icon("arrow-right", 15)}</button>
      </div>
      <ol class="auth-guide">
        <li><strong>${t("gog.guideStep1Title")}</strong> ${t("gog.guideStep1Desc")}</li>
        <li><strong>${t("gog.guideStep2Title")}</strong> ${t("gog.guideStep2Desc")}</li>
        <li><strong>${t("gog.guideStep3Title")}</strong> ${t("gog.guideStep3Desc")}</li>
      </ol>
    </div>`;
}

function gogConnectedBlock(): string {
  const activeSaved = S.gogSavedAccounts.find((a) => a.is_active || a.user_id === S.gogAccountId);
  const currentName = (activeSaved?.username && activeSaved.username !== "GOG User")
    ? activeSaved.username
    : (S.gogAccount && S.gogAccount !== "GOG User" ? S.gogAccount : (activeSaved?.username || S.gogAccount || "GOG"));

  const accountRows = (S.gogSavedAccounts || []).map((acc) => {
    const isCurrent = acc.is_active || acc.user_id === S.gogAccountId;
    const url = avatarFor(`gog:${acc.user_id}`);
    const name = acc.username && acc.username !== "GOG User" ? acc.username : currentName;
    const actions = isCurrent
      ? `<span class="chip ok">${t("settings.accountActiveBadge")}</span>`
      : `<button class="btn small" data-act="gog-account-switch" data-id="${esc(acc.user_id)}">${t("settings.accountSwitchBtn")}</button>
         <button class="icon-btn danger" data-act="gog-account-remove" data-id="${esc(acc.user_id)}" title="${t("settings.accountRemove")}">${icon("trash", 14)}</button>`;
    return `
      <div class="row">
        ${avatar(url, name, `gog:${acc.user_id}`)}
        <div class="row-main"><div class="row-title">${esc(name)}</div></div>
        <div class="row-actions">${actions}</div>
      </div>`;
  }).join("");

  const singleRow = `<div class="row">${avatar(getCustomAvatar(S.gogAccountId), currentName, `gog:${S.gogAccountId || ""}`)}<div class="row-main"><div class="row-title">${esc(currentName)}</div><div class="row-meta">${S.gogSummaries.length} ${t("settings.accountTotalGames")}</div></div><div class="row-actions"><span class="chip ok">${t("settings.accountActiveBadge")}</span></div></div>`;

  return `
    <div class="list acc-accounts">
      ${accountRows || singleRow}
    </div>
    ${S.gogAccountsAddMode ? gogSignInBlock() + `<div class="acc-actions"><button class="btn ghost small" data-act="gog-auth-cancel">${t("common.cancel")}</button></div>` : `
      <div class="acc-actions">
        <button class="btn ghost small" data-act="gog-account-add">${icon("plus", 13)} ${t("settings.accountAdd")}</button>
        <span class="acc-spacer"></span>
        <button class="btn ghost danger small" data-act="gog-logout">${t("settings.gogLogout")}</button>
      </div>`}`;
}

function gogCard(): string {
  const activeSaved = S.gogSavedAccounts.find((a) => a.is_active || a.user_id === S.gogAccountId);
  const currentName = (activeSaved?.username && activeSaved.username !== "GOG User")
    ? activeSaved.username
    : (S.gogAccount && S.gogAccount !== "GOG User" ? S.gogAccount : (activeSaved?.username || S.gogAccount || "GOG"));
  const connected = Boolean(S.gogAccount) && S.gogPhase === "library";
  const status = S.gogSyncing
    ? `<span class="chip">${t("auth.syncingTitle")}</span>`
    : connected
      ? `<span class="chip ok">${t("accounts.connected")}</span>`
      : `<span class="chip">${t("accounts.notConnected")}</span>`;
  const body = S.gogSyncing
    ? `<p class="acc-lead">${t("gog.syncing")}</p><div class="progress auth-progress"><span style="width:60%"></span></div>`
    : connected
      ? gogConnectedBlock()
      : `<p class="acc-lead">${t("accounts.gogDesc")}</p>${gogSignInBlock()}`;
  return `
    <section class="card acc-card">
      <div class="acc-card-head">
        <span class="acc-store-mark">${storeLogo("gog")}</span>
        <div class="row-main">
          <div class="acc-store-name">GOG.COM</div>
          <div class="row-meta">${connected ? esc(currentName) : t("accounts.gogDesc")}</div>
        </div>
        ${status}
      </div>
      <div class="acc-card-body">${body}${supportDetails("gog")}</div>
    </section>`;
}

/**
 * Amazon Games card. The account and library run through the Nile CLI, so the
 * card owns the same sign-in shape as GOG: open Amazon, paste the redirect URL
 * back, then the library syncs itself.
 */
function amazonSignInBlock(): string {
  return `
    <div class="acc-signin">
      <div class="acc-actions">
        <button class="btn primary" data-act="amazon-open-login" ${S.amazonBusy ? "disabled" : ""}>${icon("external", 14)} ${t("amazon.webLogin")}</button>
        ${S.amazonLogin ? `<button class="btn ghost" data-act="amazon-reopen-login">${icon("link", 14)} ${t("amazon.reopen")}</button>` : ""}
      </div>
      <div class="auth-code">
        <input id="amazon-code" class="input" placeholder="${t("amazon.pastePlaceholder")}" autocomplete="off" spellcheck="false" />
        <button class="btn ghost" data-act="amazon-paste" title="${t("auth.pasteBtn")}">${icon("copy", 14)} ${t("auth.pasteBtn")}</button>
        <button class="btn primary icon-only" data-act="amazon-do-login" ${S.amazonBusy ? "disabled" : ""} title="${t("auth.submitCode")}">${icon("arrow-right", 15)}</button>
      </div>
      <ol class="auth-guide">
        <li><strong>${t("amazon.guideStep1Title")}</strong> ${t("amazon.guideStep1Desc")}</li>
        <li><strong>${t("amazon.guideStep2Title")}</strong> ${t("amazon.guideStep2Desc")}</li>
        <li><strong>${t("amazon.guideStep3Title")}</strong> ${t("amazon.guideStep3Desc")}</li>
      </ol>
    </div>`;
}

/** Signed-in Amazon block: saved accounts, add-account and sign-out. */
function amazonConnectedBlock(): string {
  const activeSaved = S.amazonSavedAccounts.find((a) => a.is_active || a.user_id === S.amazonAccountId);
  const currentName = activeSaved?.username || S.amazonStatus?.username || "Amazon Games";
  const accountRows = (S.amazonSavedAccounts || []).map((acc) => {
    const isCurrent = acc.is_active || acc.user_id === S.amazonAccountId;
    const name = acc.username || currentName;
    const actions = isCurrent
      ? `<span class="chip ok">${t("settings.accountActiveBadge")}</span>`
      : `<button class="btn small" data-act="amazon-account-switch" data-id="${esc(acc.user_id)}">${t("settings.accountSwitchBtn")}</button>
         <button class="icon-btn danger" data-act="amazon-account-remove" data-id="${esc(acc.user_id)}" title="${t("settings.accountRemove")}">${icon("trash", 14)}</button>`;
    return `
      <div class="row">
        ${avatar(avatarFor(`amazon:${acc.user_id}`), name, `amazon:${acc.user_id}`)}
        <div class="row-main"><div class="row-title">${esc(name)}</div></div>
        <div class="row-actions">${actions}</div>
      </div>`;
  }).join("");
  const singleRow = `<div class="row">${avatar(avatarFor(`amazon:${S.amazonAccountId || ""}`), currentName, `amazon:${S.amazonAccountId || ""}`)}<div class="row-main"><div class="row-title">${esc(currentName)}</div><div class="row-meta">${S.amazonGames.length} ${t("settings.accountTotalGames")}</div></div><div class="row-actions"><span class="chip ok">${t("settings.accountActiveBadge")}</span></div></div>`;
  return `
    <div class="list acc-accounts">
      ${accountRows || singleRow}
    </div>
    ${S.amazonAccountsAddMode ? amazonSignInBlock() + `<div class="acc-actions"><button class="btn ghost small" data-act="amazon-cancel-add">${t("common.cancel")}</button></div>` : `
      <div class="acc-actions">
        <button class="btn ghost small" data-act="amazon-account-add">${icon("plus", 13)} ${t("settings.accountAdd")}</button>
        <span class="acc-spacer"></span>
        <button class="btn ghost danger small" data-act="amazon-logout">${t("settings.amazonLogout")}</button>
      </div>`}`;
}

function amazonCard(): string {
  const connected = Boolean(S.amazonStatus?.logged_in);
  const name = S.amazonStatus?.username || "Amazon Games";
  const status = S.amazonBusy
    ? `<span class="chip">${t("auth.syncingTitle")}</span>`
    : connected
      ? `<span class="chip ok">${t("accounts.connected")}</span>`
      : `<span class="chip">${t("accounts.notConnected")}</span>`;
  // The library owns the game list; the card manages the accounts.
  const body = connected
    ? amazonConnectedBlock()
    : S.amazonBusy
      ? `<p class="acc-lead">${t("amazon.starting")}</p><div class="progress auth-progress"><span style="width:55%"></span></div>`
      : `<p class="acc-lead">${t("accounts.amazonDesc")}</p>${amazonSignInBlock()}`;
  return `
    <section class="card acc-card">
      <div class="acc-card-head">
        <span class="acc-store-mark">${storeLogo("amazon")}</span>
        <div class="row-main"><div class="acc-store-name">Amazon Games</div><div class="row-meta">${connected ? esc(name) : t("accounts.amazonShort")}</div></div>
        ${status}
      </div>
      <div class="acc-card-body">${body}${supportDetails("amazon")}</div>
    </section>`;
}

/** Small section caption: keeps "account" and "client" visually separate. */
function steamSectionHead(title: string, chip = ""): string {
  return `<div class="acc-section-head"><h3 class="section-title acc-section-title">${esc(title)}</h3>${chip}</div>`;
}

/**
 * Steam client detection: the installed games belong to the Steam app on this
 * PC, independent of the launcher's own account session above.
 */
function steamClientBlock(): string {
  const status = S.steamStatus;
  if (!status?.installed) return "";
  const meta = status.userName ? t("steam.clientSession", { name: status.userName }) : esc(status.path);
  return `
    ${steamSectionHead(t("steam.clientTitle"), `<span class="chip ok">${t("steam.detected")}</span>`)}
    <div class="list">
      <div class="row">
        <div class="row-main">
          <div class="row-title">${t("steam.games", { count: status.games })}</div>
          <div class="row-meta" title="${esc(status.path)}">${esc(meta)}</div>
        </div>
        <div class="row-actions">
          <button class="btn ghost small" data-act="steam-scan">${icon("refresh", 13)} ${t("settings.rescan")}</button>
          <button class="btn ghost small" data-act="steam-open-client">${icon("external", 13)} ${t("steam.openClient")}</button>
        </div>
      </div>
    </div>`;
}

/** Signed-in block: every saved Steam account with switch/remove, plus actions. */
function steamAccountBlock(): string {
  const sessionId = S.steamAuth?.steamId || "";
  const rows = (S.steamSavedAccounts || []).map((acc) => {
    const isCurrent = acc.isActive || acc.steamId === sessionId;
    const actions = isCurrent
      ? `<span class="chip ok">${t("settings.accountActiveBadge")}</span>`
      : `<button class="btn small" data-act="steam-account-switch" data-id="${esc(acc.steamId)}">${t("settings.accountSwitchBtn")}</button>
         <button class="icon-btn danger" data-act="steam-account-remove" data-id="${esc(acc.steamId)}" title="${t("settings.accountRemove")}">${icon("trash", 14)}</button>`;
    return `
      <div class="row">
        <span class="settings-avatar">${esc((acc.accountName.trim()[0] || "S").toUpperCase())}</span>
        <div class="row-main">
          <div class="row-title">${esc(acc.accountName)}</div>
          ${isCurrent ? `<div class="row-meta tabular-nums">${t("steam.ownedGames", { count: S.steamOwnedCount })}</div>` : ""}
        </div>
        <div class="row-actions">${actions}</div>
      </div>`;
  }).join("");
  // The vault may not be loaded yet (or the session came from a one-off login).
  const name = S.steamAuth?.accountName || "Steam";
  const singleRow = `
    <div class="row">
      <span class="settings-avatar">${esc((name.trim()[0] || "S").toUpperCase())}</span>
      <div class="row-main">
        <div class="row-title">${esc(name)}</div>
        <div class="row-meta tabular-nums">${t("steam.ownedGames", { count: S.steamOwnedCount })}</div>
      </div>
      <div class="row-actions"><span class="chip ok">${t("settings.accountActiveBadge")}</span></div>
    </div>`;
  return `
    ${steamSectionHead(t("steam.accountTitle"))}
    <div class="list acc-accounts">${rows || singleRow}</div>
    <p class="acc-hint">${t("steam.secureNote")}</p>
    <div class="acc-actions">
      <button class="btn ghost small" data-act="steam-account-add">${icon("plus", 13)} ${t("settings.accountAdd")}</button>
      <span class="acc-spacer"></span>
      <button class="btn ghost small" data-act="steam-owned-refresh" ${S.steamLibrarySyncing ? "disabled" : ""}>${icon("refresh", 13)} ${t("steam.refreshLibrary")}</button>
      <button class="btn ghost small icon-only" data-act="steam-open-settings" title="${t("steam.openSettings")}" aria-label="${t("steam.openSettings")}">${icon("settings", 13)}</button>
      <button class="btn ghost danger small" data-act="steam-logout">${t("steam.logout")}</button>
    </div>`;
}

/**
 * Steam sign-in flow: account name + password, then the Steam Guard code or the
 * mobile approval. Passwords are used once and never stored.
 */
function steamSignInBlock(): string {
  const step = S.steamAuthStep;
  if (step === "code" || step === "confirm" || step === "pending") {
    // Steam Guard is not code-only: the mobile app (or an email link) can
    // approve the request with one tap, so that is the default view whenever
    // Steam offers it; the code input is one click away.
    const canApprove = Boolean(S.steamAuth?.confirm);
    const showCodeInput = step === "code" && (!canApprove || S.steamAuthCodeMode);
    const showAppApproval = !showCodeInput;
    const lead = showCodeInput
      ? (S.steamAuth?.emailHint ? t("steam.guardEmail", { email: S.steamAuth.emailHint }) : t("steam.guardDevice"))
      : step === "pending"
        ? t("steam.waiting")
        : t("steam.guardConfirm");
    const codeRow = showCodeInput
      ? `<div class="auth-code">
           <input id="steam-guard" class="input" placeholder="${t("steam.guardPlaceholder")}" autocomplete="one-time-code" spellcheck="false" />
           <button class="btn primary" data-act="steam-login-code" ${S.steamAuthBusy ? "disabled" : ""}>${icon("check", 14)} ${t("steam.guardSubmit")}</button>
         </div>
         ${canApprove ? `<p class="acc-hint">${t("steam.guardHint")}</p>` : ""}`
      : "";
    return `
      ${steamSectionHead(t("steam.accountTitle"))}
      <div class="acc-signin">
        <p class="acc-lead">${esc(lead)}</p>
        ${S.steamAuthUser ? `<p class="acc-hint">${esc(S.steamAuthUser)}</p>` : ""}
        ${codeRow}
        <div class="acc-actions">
          ${showAppApproval ? `<span class="chip">${t("steam.waiting")}</span>` : ""}
          <span class="acc-spacer"></span>
          ${!showCodeInput ? `<button class="btn ghost small" data-act="steam-login-code-mode">${t("steam.useCode")}</button>` : ""}
          <button class="btn ghost small" data-act="steam-login-qr">${icon("qr-code", 13)} ${t("steam.qrLogin")}</button>
          <button class="btn ghost small" data-act="steam-login-cancel">${t("common.cancel")}</button>
        </div>
      </div>`;
  }
  if (step === "credentials") {
    return `
      ${steamSectionHead(t("steam.accountTitle"))}
      <div class="acc-signin">
        <p class="acc-lead">${t("steam.signInDesc")}</p>
        <div class="auth-code">
          <input id="steam-user" class="input" placeholder="${t("steam.userPlaceholder")}" value="${esc(S.steamAuthUser)}" autocomplete="username" spellcheck="false" />
        </div>
        <div class="auth-code">
          <input id="steam-pass" type="password" class="input" placeholder="${t("steam.passPlaceholder")}" autocomplete="current-password" spellcheck="false" />
        </div>
        <label class="acc-check">
          <input id="steam-remember" type="checkbox" checked />
          <span>${t("steam.remember")}</span>
        </label>
        <div class="acc-actions">
          <button class="btn primary" data-act="steam-login-submit" ${S.steamAuthBusy ? "disabled" : ""}>${icon("arrow-right", 14)} ${S.steamAuthBusy ? t("steam.waiting") : t("steam.signInBtn")}</button>
          <button class="btn ghost small" data-act="steam-login-qr">${icon("qr-code", 13)} ${t("steam.qrLogin")}</button>
          <button class="btn ghost small" data-act="steam-login-cancel">${t("common.cancel")}</button>
        </div>
        <p class="acc-hint">${t("steam.secureNote")}</p>
      </div>`;
  }
  if (step === "qr") {
    return `
      ${steamSectionHead(t("steam.accountTitle"))}
      <div class="acc-signin">
        <p class="acc-lead">${t("steam.qrHint")}</p>
        <div class="acc-qr-box">${S.steamQrSvg || `<span class="spinner"></span>`}</div>
        <div class="acc-actions">
          <span class="chip">${t("steam.waiting")}</span>
          <span class="acc-spacer"></span>
          ${S.steamQrUrl ? `<button class="btn ghost small" data-act="steam-qr-copy">${icon("copy", 13)} ${t("steam.qrCopy")}</button>` : ""}
          <button class="btn ghost small" data-act="steam-login-cancel">${t("common.cancel")}</button>
        </div>
      </div>`;
  }
  return `
    ${steamSectionHead(t("steam.accountTitle"))}
    <p class="acc-lead">${t("steam.signInDesc")}</p>
    <label class="acc-check">
      <input id="steam-remember" type="checkbox" checked />
      <span>${t("steam.remember")}</span>
    </label>
    <div class="acc-actions">
      <button class="btn primary" data-act="steam-login-start">${icon("user", 14)} ${t("steam.signInCta")}</button>
      <button class="btn ghost small" data-act="steam-login-qr">${icon("qr-code", 13)} ${t("steam.qrLogin")}</button>
      <button class="btn ghost small" data-act="steam-open-settings">${icon("settings", 13)} ${t("steam.openSettings")}</button>
    </div>`;
}

/** Saved (inactive) accounts when signed out: one click brings them back. */
function steamSavedAccountsBlock(): string {
  const rows = (S.steamSavedAccounts || []).map((acc) => `
    <div class="row">
      <span class="settings-avatar">${esc((acc.accountName.trim()[0] || "S").toUpperCase())}</span>
      <div class="row-main"><div class="row-title">${esc(acc.accountName)}</div></div>
      <div class="row-actions">
        <button class="btn small" data-act="steam-account-switch" data-id="${esc(acc.steamId)}">${t("settings.accountSwitchBtn")}</button>
        <button class="icon-btn danger" data-act="steam-account-remove" data-id="${esc(acc.steamId)}" title="${t("settings.accountRemove")}">${icon("trash", 14)}</button>
      </div>
    </div>`).join("");
  return `${steamSectionHead(t("steam.accountTitle"))}<div class="list acc-accounts">${rows}</div>`;
}

/** Steam card: the launcher account session on top, client detection below. */
function steamCard(): string {
  const installed = S.steamStatus?.installed ?? false;
  const signedIn = S.steamAuthStep === "signed_in";
  const statusChip = signedIn
    ? `<span class="chip ok">${t("accounts.connected")}</span>`
    : `<span class="chip">${t("accounts.notConnected")}</span>`;
  // The header describes the launcher's own session; the Steam client's persona
  // is only shown in the client section below.
  const meta = signedIn && S.steamAuth?.accountName
    ? t("steam.signedInAs", { name: S.steamAuth.accountName })
    : t("accounts.steamDesc");
  // Saved rows only on the idle step: sign-in flows stay focused on the form.
  const savedRows = (S.steamSavedAccounts || []).length > 0 && !signedIn && S.steamAuthStep === "idle"
    ? steamSavedAccountsBlock()
    : "";
  const body = `${signedIn ? steamAccountBlock() : savedRows + steamSignInBlock()}${installed ? steamClientBlock() : ""}`;
  return `
    <section class="card acc-card">
      <div class="acc-card-head">
        <span class="acc-store-mark">${storeLogo("steam")}</span>
        <div class="row-main">
          <div class="acc-store-name">Steam</div>
          <div class="row-meta">${esc(meta)}</div>
        </div>
        ${statusChip}
      </div>
      <div class="acc-card-body">${body}${supportDetails("steam")}</div>
    </section>`;
}

function companionCard(store: "ea" | "ubisoft" | "xbox" | "battlenet" | "riot", title: string): string {
  const status = S.companionStatus.find((row) => row.store === store);
  const linked = status?.linked ?? false;
  const needsLogin = status?.needsLogin ?? false;
  const client = status?.clientInstalled ?? false;
  const count = status?.gameCount ?? S.companionSummaries.filter((g) => g.source === store).length;
  const name = status?.accountName || "";
  const busy = S.companionBusy === store;
  const webLogin = store === "ea" || store === "xbox" || store === "battlenet" || store === "ubisoft";
  const canSignIn = webLogin && (!linked || needsLogin);
  const loginHint = store === "ea"
    ? t("accounts.eaLogin")
    : store === "xbox"
      ? t("accounts.xboxLogin")
      : store === "ubisoft"
        ? t("accounts.ubiLogin")
        : t("accounts.bnetLogin");
  const expired = store === "ea"
    ? t("accounts.eaSessionExpired")
    : store === "xbox"
      ? t("accounts.xboxSessionExpired")
      : t("accounts.ubiSessionExpired");
  const meta = !client
    ? t("accounts.clientMissing")
    : linked
      ? (needsLogin
          ? expired
          : name
            ? t("accounts.signedInClient", { name })
            : t("accounts.localAccount"))
      : webLogin
        ? loginHint
        : t("accounts.foundGames", { count });
  const chip = linked
    ? `<span class="chip ok">${t("accounts.connected")}</span>`
    : `<span class="chip">${t("accounts.notConnected")}</span>`;
  const lead = webLogin ? loginHint : t("accounts.linkHint");
  const accountRow = linked
    ? `<div class="list acc-accounts">
        <div class="row">
          <span class="settings-avatar">${esc((name.trim()[0] || title.trim()[0] || "A").toUpperCase())}</span>
          <div class="row-main">
            <div class="row-title">${esc(name || title)}</div>
            <div class="row-meta tabular-nums">${t("accounts.foundGames", { count })}</div>
          </div>
          <div class="row-actions">
            <button class="icon-btn danger" data-act="companion-unlink" data-id="${store}" title="${t("settings.accountRemove")}">${icon("trash", 14)}</button>
          </div>
        </div>
      </div>`
    : `<p class="acc-lead">${lead}</p>`;
  return `
    <section class="card acc-card">
      <div class="acc-card-head">
        <span class="acc-store-mark">${storeLogo(store)}</span>
        <div class="row-main">
          <div class="acc-store-name">${esc(title)}</div>
          <div class="row-meta">${esc(meta)}</div>
        </div>
        ${chip}
      </div>
      <div class="acc-card-body">
        ${accountRow}
        <div class="acc-actions">
          ${canSignIn ? `<button class="btn primary small" data-act="companion-signin" data-id="${store}">${icon("user", 13)} ${t("accounts.signIn")}</button>` : ""}
          ${linked || webLogin ? "" : `<button class="btn primary small" data-act="companion-link" data-id="${store}" ${!client || busy ? "disabled" : ""}>${icon("plus", 13)} ${busy ? t("accounts.linking") : t("settings.accountAdd")}</button>`}
          ${linked ? `<button class="btn ghost small" data-act="companion-rescan" data-id="${store}">${icon("refresh", 13)} ${t("settings.rescan")}</button>` : ""}
          <button class="btn ghost small" data-act="companion-open" data-id="${store}" ${client ? "" : "disabled"}>${icon("external", 13)} ${t("accounts.openClient")}</button>
        </div>
        ${supportDetails(store)}
      </div>
    </section>`;
}

/**
 * Account cards, grouped so the page reads as three short lists instead of one
 * long wall: stores the launcher manages itself, stores that live in their own
 * client, and the two integrations that are on the way.
 */
function accountCards(): string {
  return `
    ${groupTitle("accounts.groupManaged")}
    ${epicCard()}
    ${gogCard()}
    ${amazonCard()}
    ${groupTitle("accounts.groupClients")}
    ${infoBox("accounts.clientInfo")}
    ${steamCard()}
    ${companionCard("xbox", "Xbox")}
    ${companionCard("battlenet", "Battle.net")}
    ${companionCard("ubisoft", "Ubisoft Connect")}
    ${companionCard("ea", "EA App")}
    ${companionCard("riot", "Riot Games")}
    ${groupTitle("accounts.groupSoon")}
    ${soonCard("discord", "Discord", "accounts.discordDesc")}
    ${soonCard("spotify", "Spotify", "accounts.spotifyDesc")}`;
}

/** Account list, switch, add and sign-out, embedded in Settings. */
export function renderAccountSettings(): string {
  return `<div class="settings-accounts">${infoBox("accounts.optionalInfo")}${accountCards()}</div>`;
}

export function renderAccounts(): string {
  if (S.epicPhase === "checking") return emptyState("users", t("accounts.title"), `<span class="spinner"></span>`);
  return `
    <div class="page acc-page">
      <p class="page-sub acc-intro">${t("accounts.subtitle")}</p>
      ${infoBox("accounts.optionalInfo")}
      ${accountCards()}
    </div>`;
}

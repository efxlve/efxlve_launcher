/**
 * Game page "Manage" tab: markup plus the in-place DOM updates used while it is
 * open (settings sync, verify progress and reset). State lives in S.
 */

import { manageRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { lastPlayedLabel, rawOf, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";

import { epicGetGameSettings, getThirdPartyLauncher, requiresThirdPartyLauncher, type EpicSummary, type GameLocalSettings } from "../../epic";
import { renderBackupListHtml } from "../drawer/drawer-widgets";

/** Serializes env vars as one KEY=VALUE per line for the manage textarea. */
function envToText(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}

function row(title: string, desc: string, actions: string, extra = "", descId = ""): string {
  return `
    <div class="row mg-row">
      <div class="row-main">
        <div class="mg-title">${title}</div>
        <div class="mg-desc"${descId ? ` id="${descId}"` : ""}>${desc}</div>
        ${extra}
      </div>
      <div class="row-actions">${actions}</div>
    </div>`;
}

function toggle(act: string, checked: boolean): string {
  return `<label class="switch"><input type="checkbox" data-act="${act}" ${checked ? "checked" : ""} /><span class="track"></span></label>`;
}

function verifyBox(percent: number, detail: string, speed: string): string {
  return `
    <div class="verify-box">
      <div class="progress"><span id="manage-verify-fill" style="width:${percent}%"></span></div>
      <div class="verify-meta"><span id="manage-verify-count">${esc(detail)}</span><span id="manage-verify-speed">${esc(speed)}</span></div>
    </div>`;
}

/** Closes the manage popup without touching the game page underneath. */
export function closeManagePopup(): void {
  if (manageRoot) manageRoot.innerHTML = "";
}

/** Opens manage settings in a dialog so the game page stays on its current tab. */
export function openManagePopup(appName: string): void {
  if (!manageRoot) return;
  const s = summaryOf(appName);
  if (!s) return;
  manageRoot.innerHTML = `
    <div class="manage-overlay" data-act="manage-overlay-close">
      <div class="manage-dialog">
        <div class="manage-head">
          <div class="manage-head-text">
            <h2>${t("drawer.manage")}</h2>
            <div class="manage-head-sub">${esc(s.title)}</div>
          </div>
          <button class="manage-head-close" data-act="close-manage-popup" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>
        <div class="manage-body">${renderDrawerManage(s)}</div>
      </div>
    </div>`;
}

/** Renders the Manage tab for an installed game. */
export function renderDrawerManage(s: EpicSummary): string {
  if (!S.activeManageSettings || S.activeManageSettings.appName !== s.appName) {
    S.activeManageSettings = {
      appName: s.appName,
      title: s.title,
      launchParameters: "",
      autoUpdate: true,
      highPriority: false,
      cloudSavesEnabled: true,
      lastCloudSync: null,
      installSize: s.installSize || 0,
      installPath: s.installPath || "",
      version: s.installedVersion || s.version || "1.0",
      wrapper: "",
      envVars: {},
    };
    epicGetGameSettings(s.appName).then((st) => {
      if (S.activeManageSettings?.appName === s.appName) {
        S.activeManageSettings = st;
        updateManageModalInputsInPlace(st);
      }
    }).catch(() => {});
  } else if (s.installPath && s.installPath !== S.activeManageSettings.installPath) {
    S.activeManageSettings.installPath = s.installPath;
  }
  const st = S.activeManageSettings;
  const id = st.appName;
  const partner = getThirdPartyLauncher(rawOf(s.appName));
  const blockedMove = requiresThirdPartyLauncher(partner);
  const partnerSaves = partner?.type === "ea" || partner?.type === "ubisoft" || partner?.type === "rockstar";
  const v = S.verifyingMap.get(id);
  const pt = S.playtimeMap.get(id);
  const playtimeStr = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : t("playtime.notPlayed");
  const cloudDesc = S.manageSyncingSaves
    ? t("manage.syncing")
    : st.lastCloudSync ? t("manage.lastSync", { time: esc(st.lastCloudSync) }) : t("manage.cloudDesc");

  const moveBtn = blockedMove
    ? `<button class="btn ghost small disabled-hint" data-act="blocked-move-tp" data-id="${id}" data-partner="${esc(partner?.name || "Third-Party")}" title="${esc(t("manage.moveThirdPartyTip", { name: partner?.name || "Third-Party" }))}">${icon("hard-drive", 13)} ${t("manage.move")}</button>`
    : `<button class="btn ghost small" data-act="open-move-game-modal" data-id="${id}" title="${t("manage.moveTitle")}">${icon("hard-drive", 13)} ${t("manage.move")}</button>`;

  return `
    <div class="manage-tab-content">
      ${s.installed ? `<div class="section-title">${t("manage.groupFiles")}</div>
      <div class="list">
        ${row(t("manage.verifyTitle"), t("manage.verifyDesc"),
          `<button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${id}" ${v ? "disabled" : ""}>${v ? t("manage.verifying") : t("manage.verify")}</button>`,
          `<div id="manage-verify-box-container">${v ? verifyBox(v.percent, v.detail || `${v.current}/${v.total}`, v.speed) : ""}</div>`)}
        ${row(t("manage.installLocation"), `<span id="manage-install-path" class="mg-path">${esc(s.installPath || st.installPath || t("manage.unspecified"))}</span>`,
          `${moveBtn}<button class="btn ghost small" data-act="epic-open-folder" data-id="${id}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`,
          blockedMove ? `<div class="mg-note">${icon("info", 12)} ${t("manage.moveThirdPartyWarning", { name: esc(partner!.name) })}</div>` : "")}
        ${row(t("manage.shortcutTitle"), t("manage.shortcutDesc"),
          `<button class="btn ghost small" data-act="manage-create-shortcut" data-id="${id}">${t("manage.createShortcut")}</button>`)}
      </div>` : ""}

      <div class="section-title">${t("manage.groupCover")}</div>
      <div class="list">
        ${row(t("manage.coverTitle"), t("manage.coverDesc"),
          `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${id}">${icon("image", 13)} ${t("manage.coverChange")}</button>`)}
      </div>

      ${s.installed ? `<div class="section-title">${t("manage.groupSaves")}</div>
      <div class="list">
        ${partnerSaves
          ? row(t("manage.eosCloudTitle"), t("manage.partnerSaves", { name: partner!.name }), "")
          : `${row(t("manage.eosCloudTitle"), cloudDesc,
              `<button class="btn ghost small" data-act="manage-sync-saves" data-id="${id}" title="${t("manage.syncNow")}" ${S.manageSyncingSaves ? "disabled" : ""}>${icon("refresh", 13)} ${t("manage.sync")}</button>${toggle("manage-toggle-cloud", st.cloudSavesEnabled)}`,
              "", "manage-cloud-subtitle")}
            ${row(t("manage.localBackupTitle"), t("manage.backupDesc"),
              `<button class="btn ghost small" data-act="manage-open-backup-folder" data-id="${id}" title="${t("manage.openBackupFolder")}">${icon("folder", 13)} ${t("manage.folder")}</button>
               <button class="btn primary small" data-act="manage-create-backup" data-id="${id}" ${S.isBackingUp ? "disabled" : ""}>${S.isBackingUp ? t("manage.backingUp") : t("manage.backup")}</button>`,
              `<div id="manage-backup-list" class="backup-list">${renderBackupListHtml(id)}</div>`)}`}
      </div>` : ""}

      ${s.installed ? `<div class="section-title">${t("manage.groupLaunch")}</div>
      <div class="list">
        ${s.installed ? row(t("manage.autoUpdateTitle"), t("manage.autoUpdateDesc"), toggle("manage-toggle-autoupdate", st.autoUpdate)) : ""}
        ${s.installed ? row(t("manage.priorityTitle"), t("manage.priorityDesc"), toggle("manage-toggle-priority", st.highPriority)) : ""}
        <div class="row mg-row stack">
          <div class="mg-title">${t("manage.argsTitle")}</div>
          <div class="mg-desc">${t("manage.argsDesc")}</div>
          <div class="mg-inline">
            <input id="manage-args-input" class="input" placeholder="-dx11 -novid" value="${esc(st.launchParameters || "")}" />
            <button class="btn primary small" data-act="manage-save-args" data-id="${id}">${t("common.save")}</button>
          </div>
        </div>
        <div class="row mg-row stack">
          <div class="mg-title">${t("manage.wrapperTitle")}</div>
          <div class="mg-desc">${t("manage.wrapperDesc")}</div>
          <input id="manage-wrapper-input" class="input" placeholder="mangohud" value="${esc(st.wrapper || "")}" spellcheck="false" autocomplete="off" />
          <div class="mg-title mg-gap">${t("manage.envTitle")}</div>
          <div class="mg-desc">${t("manage.envDesc")}</div>
          <textarea id="manage-env-input" class="input mg-env" spellcheck="false" placeholder="DXVK_HUD=1&#10;WINEDLLOVERRIDES=d3d11=n,b">${esc(envToText(st.envVars))}</textarea>
          <div class="mg-inline end"><button class="btn primary small" data-act="manage-save-launch-extras" data-id="${id}">${t("common.save")}</button></div>
        </div>
      </div>` : ""}

      <div class="section-title">${t("manage.groupPlaytime")}</div>
      <div class="list">
        ${row(`${t("manage.totalPlaytime")}: <span id="manage-playtime-val" class="tabular-nums">${esc(playtimeStr)}</span>`,
          pt?.session_count ? t("manage.sessionMeta", { count: pt.session_count, last: esc(lastPlayedLabel(pt.last_played)) }) : t("manage.noSession"),
          `<button class="btn ghost small" data-act="open-edit-playtime" data-id="${id}">${icon("edit", 13)} ${t("manage.editTime")}</button>`,
          "", "manage-playtime-meta")}
        <div class="row mg-row stack mg-callout">
          <div class="mg-title">${t("manage.epicDataTitle")}</div>
          <div class="mg-desc">${t("manage.epicDataP1")}</div>
          <div class="mg-desc">${t("manage.epicDataP2")}</div>
        </div>
      </div>

      <div class="list">
        ${row(t("manage.hideTitle"), t("manage.hideDesc"),
          `<button class="btn ghost small" data-act="hide-game" data-id="${id}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`)}
      </div>

      ${s.installed ? `<div class="list mg-danger">
        ${row(t("manage.dangerTitle"), t("manage.dangerDesc"),
          `<button class="btn danger small" data-act="epic-uninstall" data-id="${id}">${icon("trash", 13)} ${t("manage.uninstallTitle")}</button>`)}
      </div>` : ""}
    </div>`;
}

/** Sync the manage panel inputs after fresh settings arrive from the backend. */
export function updateManageModalInputsInPlace(st: GameLocalSettings): void {
  const autoUpdate = document.querySelector<HTMLInputElement>('[data-act="manage-toggle-autoupdate"]');
  if (autoUpdate) autoUpdate.checked = st.autoUpdate;

  const priority = document.querySelector<HTMLInputElement>('[data-act="manage-toggle-priority"]');
  if (priority) priority.checked = st.highPriority;

  const cloud = document.querySelector<HTMLInputElement>('[data-act="manage-toggle-cloud"]');
  if (cloud) cloud.checked = st.cloudSavesEnabled;

  const cloudSub = document.getElementById("manage-cloud-subtitle");
  if (cloudSub) {
    cloudSub.textContent = st.lastCloudSync
      ? t("manage.lastSync", { time: st.lastCloudSync })
      : t("manage.cloudDesc");
  }

  const argsInput = document.getElementById("manage-args-input") as HTMLInputElement | null;
  if (argsInput) argsInput.value = st.launchParameters || "";

  const wrapperInput = document.getElementById("manage-wrapper-input") as HTMLInputElement | null;
  if (wrapperInput) wrapperInput.value = st.wrapper || "";

  const envInput = document.getElementById("manage-env-input") as HTMLTextAreaElement | null;
  if (envInput) {
    envInput.value = Object.entries(st.envVars || {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }

  document.querySelectorAll("#manage-install-path").forEach((el) => {
    el.textContent = st.installPath || t("manage.unspecified");
  });
}

/** Update the verify progress bar and button without re-rendering the drawer. */
export function updateVerifyProgressInPlace(
  id: string,
  current: number,
  total: number,
  percent: number,
  speed: string,
  detail?: string,
): void {
  const displayDetail = detail || (total > 0 ? `${current}/${total} (%${Math.round(percent)}%)` : `%${Math.round(percent)}%`);
  S.verifyingMap.set(id, { current, total, percent, speed, detail: displayDetail });
  if (!S.activeManageSettings || S.activeManageSettings.appName !== id) return;

  const container = document.getElementById("manage-verify-box-container");
  const fill = document.getElementById("manage-verify-fill");
  const count = document.getElementById("manage-verify-count");
  const spd = document.getElementById("manage-verify-speed");
  const btn = document.getElementById("manage-verify-btn") as HTMLButtonElement | null;

  if (btn) {
    btn.disabled = true;
    btn.textContent = t("manage.verifying");
  }

  if (fill && count && spd) {
    fill.style.width = `${percent}%`;
    count.textContent = displayDetail;
    spd.textContent = speed;
  } else if (container) {
    container.innerHTML = verifyBox(percent, displayDetail, speed);
  }
}

/** Clear the verify progress bar and re-enable the verify button. */
export function resetVerifyInPlace(id: string): void {
  S.verifyingMap.delete(id);
  if (!S.activeManageSettings || S.activeManageSettings.appName !== id) return;

  const container = document.getElementById("manage-verify-box-container");
  if (container) container.innerHTML = "";

  const btn = document.getElementById("manage-verify-btn") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = false;
    btn.textContent = t("manage.verify");
  }
}

/**
 * Game page "Manage" tab: markup plus the in-place DOM updates used while it is
 * open (settings sync, verify progress and reset). State lives in S.
 */

import { manageRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { lastPlayedLabel, rawOf, sourceOfKey, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtPlaytime } from "../../core/utils";
import { formatSyncStamp, t } from "../../i18n";

import { epicGetGameSettings, getThirdPartyLauncher, requiresThirdPartyLauncher, type EpicSummary, type GameLocalSettings } from "../../epic";
import { nileGameSettings } from "../../nile";
import type { GameSource } from "../../core/types";
import { renderBackupListHtml } from "../drawer/drawer-widgets";
import { renderManageCloudBackupRow, updateManageCloudRowInPlace } from "../cloud-backup/cloud-backup-view";
import { initCloudBackupSettings, loadCloudBackupsAction } from "../cloud-backup/cloud-backup-actions";
export { updateManageCloudRowInPlace };

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

/** Live sync bar: indeterminate while packing, a real fill once Legendary
 *  reports per-file transfers. */
function syncPercent(p: { uploaded: number; total: number } | undefined): number {
  if (!p || !p.total) return 0;
  return Math.min(100, Math.round((p.uploaded / p.total) * 100));
}

function syncProgressLabel(p: { phase: string; uploaded: number; total: number }): string {
  if (p.total > 0 && p.phase === "uploading") {
    return t("manage.syncUploading", { done: p.uploaded, total: p.total });
  }
  if (p.total > 0 && p.phase === "downloading") {
    return t("manage.syncDownloading", { done: p.uploaded, total: p.total });
  }
  return t("manage.syncing");
}

function syncProgressHtml(appName: string): string {
  const p = S.cloudSyncProgress.get(appName);
  const indeterminate = !p || !p.total;
  return `<div id="manage-sync-progress" class="manage-sync-progress${p ? "" : " hidden"}${indeterminate ? " indeterminate" : ""}" data-sync-app="${esc(appName)}">
      <div class="manage-sync-track"><span id="manage-sync-fill" class="manage-sync-fill" style="width:${syncPercent(p)}%"></span></div>
      <div id="manage-sync-label" class="manage-sync-label">${p ? esc(syncProgressLabel(p)) : ""}</div>
    </div>`;
}

/** Patches the open Manage panel's sync bar for one app (progress events). */
export function updateManageSyncBar(appName: string): void {
  const bar = document.getElementById("manage-sync-progress");
  if (!bar || bar.dataset.syncApp !== appName) return;
  const p = S.cloudSyncProgress.get(appName);
  bar.classList.toggle("hidden", !p);
  bar.classList.toggle("indeterminate", !p || !p.total);
  const fill = document.getElementById("manage-sync-fill");
  if (fill) fill.style.width = `${syncPercent(p)}%`;
  const label = document.getElementById("manage-sync-label");
  if (label) label.textContent = p ? syncProgressLabel(p) : "";
}

/** Warning shown when a failed sync exposed a path-MTU black hole. */
function mtuIssueHtml(): string {
  const issue = S.mtuIssue;
  if (!issue) return "";
  return `<div class="manage-mtu-issue">
      <div class="manage-mtu-text">${icon("alert-triangle", 13)} ${esc(t("manage.mtuBody", { path: issue.pathMtu, iface: issue.interfaceMtu }))}</div>
      <button class="btn ghost small" data-act="fix-mtu">${icon("wifi", 13)} ${t("manage.mtuFix")}</button>
    </div>`;
}

/** App name of the currently open manage popup; null when it is closed. */
let openManageAppName: string | null = null;

/** Closes the manage popup without touching the game page underneath. */
export function closeManagePopup(): void {
  openManageAppName = null;
  const root = manageRoot ?? document.getElementById("manage-root");
  if (root) root.replaceChildren();
  document.querySelectorAll(".manage-overlay").forEach((el) => el.remove());
}

/** Opens manage settings in a dialog so the game page stays on its current tab. */
export function openManagePopup(appName: string): void {
  if (!manageRoot) return;
  const s = summaryOf(appName);
  if (!s) return;
  openManageAppName = appName;
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

  // Ensure cloud settings and backups are hydrated when the popup opens.
  // Companion games have no cloud saves here, so the fetch is skipped.
  const source = sourceOfKey(appName);
  const companion = source !== "epic" && source !== "gog" && source !== "steam" && source !== "amazon";
  if (!companion && !S.cloudBackupSettings) {
    void initCloudBackupSettings().then((st) => {
      updateManageCloudRowInPlace(appName);
      if (st?.enabled && st.provider !== "none") {
        void loadCloudBackupsAction(appName);
      }
    });
  } else if (!companion && S.cloudBackupSettings?.enabled && S.cloudBackupSettings.provider !== "none") {
    void loadCloudBackupsAction(appName);
  }
}

/** Renders action buttons for the save directory row. */
export function renderSavePathActions(id: string, activeSavePath: string, isCustom: boolean): string {
  const openBtn = activeSavePath
    ? `<button class="btn ghost small" data-act="manage-open-save-folder" data-id="${id}" title="${t("manage.openSaveFolder")}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`
    : "";
  const resetBtn = isCustom
    ? `<button class="btn ghost small" data-act="manage-reset-save-folder" data-id="${id}" title="${t("manage.resetSaveFolder")}">${icon("refresh", 13)}</button>`
    : "";
  const chooseBtn = `<button class="btn ghost small" data-act="manage-choose-save-folder" data-id="${id}" title="${t("manage.chooseSaveFolderTitle")}">${icon("edit", 13)} ${t("manage.chooseSaveFolder")}</button>`;
  return `${openBtn}${resetBtn}${chooseBtn}`;
}

/** Renders the Manage tab for an installed game. */
/** Manage panel for a game owned by EA, Ubisoft, Xbox or Battle.net. */
function companionManageBody(s: EpicSummary, source: GameSource): string {
  const brand = source === "ea" ? "EA App" : source === "ubisoft" ? "Ubisoft Connect" : source === "xbox" ? "Xbox" : source === "riot" ? "Riot Client" : "Battle.net";
  const pt = S.playtimeMap.get(s.appName);
  const playtime = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : t("playtime.notPlayed");
  const files = s.installed
    ? `${row(
        t("manage.installLocation"),
        `<span id="manage-install-path" class="mg-path">${esc(s.installPath || t("manage.unspecified"))}</span>`,
        `<button class="btn ghost small" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`,
      )}
      ${row(
        t("manage.uninstallTitle"),
        t("accounts.companionUninstallDesc", { name: brand }),
        `<button class="btn ghost small danger" data-act="companion-uninstall" data-id="${s.appName}" data-store="${source}">${icon("trash", 13)} ${t("common.uninstall")}</button>`,
      )}`
    : row(
        t("common.install"),
        t("accounts.companionManagedDesc", { name: brand }),
        `<button class="btn primary small" data-act="companion-install" data-id="${s.appName}" data-store="${source}">${icon("download", 13)} ${t("common.install")}</button>`,
      );
  return `
    <div class="manage-tab-content">
      <div class="section-title">${t("manage.groupFiles")}</div>
      <div class="list">${files}</div>
      <div class="section-title">${t("manage.groupPlaytime")}</div>
      <div class="list">${row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtime)}</span>`, "", "")}</div>
      <div class="section-title">${t("manage.groupCover")}</div>
      <div class="list">
        ${row(t("manage.coverTitle"), t("manage.coverDesc"),
          `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`)}
      </div>
    </div>`;
}

/**
 * Shared manage state for one Amazon title. The save-path row, the local/cloud
 * backups and the move refresh all read `S.activeManageSettings`, so seed it
 * from the library item and replace it with the backend values when they load.
 */
function ensureAmazonManageSettings(s: EpicSummary): GameLocalSettings {
  const existing = S.activeManageSettings;
  if (existing && existing.appName === s.appName) return existing;
  const seeded: GameLocalSettings = {
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
  S.activeManageSettings = seeded;
  const id = s.appName.slice(8);
  nileGameSettings(id)
    .then((st) => {
      if (S.activeManageSettings?.appName !== s.appName) return;
      S.activeManageSettings = {
        ...st,
        installPath: s.installPath || st.installPath,
        title: s.title,
        installSize: s.installSize || st.installSize,
      };
      updateManageModalInputsInPlace(S.activeManageSettings);
    })
    .catch(() => {});
  return seeded;
}

/**
 * Manage panel for an Amazon Games title. The launcher owns the files through
 * Nile, so the panel offers what the Epic one does minus the EOS cloud saves
 * Nile does not have: verify, move, shortcut, save backups and playtime.
 */
function amazonManageBody(s: EpicSummary): string {
  const id = s.appName.slice(8);
  const pt = S.playtimeMap.get(s.appName);
  const playtime = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : t("playtime.notPlayed");
  const st = ensureAmazonManageSettings(s);
  const activeSavePath = st.customSavePath || st.savePath || st.detectedSavePath || "";
  const v = S.verifyingMap.get(s.appName);
  const files = s.installed
    ? `${row(
        t("manage.verifyTitle"),
        t("manage.verifyDesc"),
        `<button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${s.appName}" ${v ? "disabled" : ""}>${v ? t("manage.verifying") : t("manage.verify")}</button>`,
        `<div id="manage-verify-box-container">${v ? verifyBox(v.percent, v.detail || `${v.current}/${v.total}`, v.speed) : ""}</div>`,
      )}
      ${row(
        t("manage.installLocation"),
        `<span id="manage-install-path" class="mg-path">${esc(s.installPath || st.installPath || t("manage.unspecified"))}</span>`,
        `<button class="btn ghost small" data-act="open-move-game-modal" data-id="${s.appName}" title="${t("manage.moveTitle")}">${icon("hard-drive", 13)} ${t("manage.move")}</button>
         <button class="btn ghost small" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`,
      )}
      ${row(
        t("manage.shortcutTitle"),
        t("manage.shortcutDesc"),
        `<button class="btn ghost small" data-act="manage-create-shortcut" data-id="${s.appName}">${t("manage.createShortcut")}</button>`,
      )}`
    : row(
        t("common.install"),
        t("amazon.managedDesc"),
        `<button class="btn primary small" data-act="amazon-install" data-id="${esc(id)}">${icon("download", 13)} ${t("common.install")}</button>
         <button class="btn ghost small" data-act="amazon-import" data-id="${esc(id)}" title="${t("amazon.importDesc")}">${icon("folder", 13)} ${t("amazon.importTitle")}</button>`,
      );
  const saves = s.installed
    ? `<div class="section-title">${t("manage.groupSaves")}</div>
      <div class="list">
        <div class="row mg-row">
          <div class="row-main">
            <div class="mg-title">${t("manage.saveFolderTitle")}</div>
            <div class="mg-desc"><span id="manage-save-path" class="mg-path">${esc(activeSavePath || t("manage.noSaveDirDetected"))}</span></div>
          </div>
          <div id="manage-save-path-actions" class="row-actions">${renderSavePathActions(s.appName, activeSavePath, Boolean(st.customSavePath))}</div>
        </div>
        ${row(
          t("manage.localBackupTitle"),
          t("manage.backupDesc"),
          `<button class="btn ghost small" data-act="manage-open-backup-folder" data-id="${s.appName}" title="${t("manage.openBackupFolder")}">${icon("folder", 13)} ${t("manage.folder")}</button>
           <button class="btn primary small" data-act="manage-create-backup" data-id="${s.appName}" ${S.isBackingUp ? "disabled" : ""}>${S.isBackingUp ? t("manage.backingUp") : t("manage.backup")}</button>`,
          `<div id="manage-backup-list" class="backup-list">${renderBackupListHtml(s.appName)}</div>`,
        )}
        <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(s.appName)}</div>
      </div>`
    : "";
  return `
    <div class="manage-tab-content">
      <div class="section-title">${t("manage.groupFiles")}</div>
      <div class="list">${files}</div>
      <div class="section-title">${t("manage.groupCover")}</div>
      <div class="list">
        ${row(t("manage.coverTitle"), t("manage.coverDesc"),
          `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`)}
      </div>
      ${saves}
      ${s.installed ? `<div class="section-title">${t("manage.groupLaunch")}</div>
      <div class="list">
        <div class="row mg-row stack">
          <div class="mg-title">${t("manage.argsTitle")}</div>
          <div class="mg-desc">${t("manage.argsDesc")}</div>
          <div class="mg-inline">
            <input id="manage-args-input" class="input" placeholder="-dx11 -novid" value="${esc(st.launchParameters || "")}" />
            <button class="btn primary small" data-act="manage-save-args" data-id="${s.appName}">${t("common.save")}</button>
          </div>
        </div>
        <div class="row mg-row stack">
          <div class="mg-title">${t("manage.envTitle")}</div>
          <div class="mg-desc">${t("manage.envDesc")}</div>
          <textarea id="manage-env-input" class="input mg-env" spellcheck="false" placeholder="DXVK_HUD=1&#10;WINEDLLOVERRIDES=d3d11=n,b">${esc(envToText(st.envVars))}</textarea>
          <div class="mg-inline end"><button class="btn primary small" data-act="manage-save-launch-extras" data-id="${s.appName}">${t("common.save")}</button></div>
        </div>
      </div>` : ""}
      <div class="section-title">${t("manage.groupPlaytime")}</div>
      <div class="list">
        ${row(`${t("manage.totalPlaytime")}: <span id="manage-playtime-val" class="tabular-nums">${esc(playtime)}</span>`,
          pt?.session_count ? t("manage.sessionMeta", { count: pt.session_count, last: esc(lastPlayedLabel(pt.last_played)) }) : t("manage.noSession"),
          `<button class="btn ghost small" data-act="open-edit-playtime" data-id="${s.appName}">${icon("edit", 13)} ${t("manage.editTime")}</button>`,
          "", "manage-playtime-meta")}
      </div>
      <div class="list">
        ${row(t("manage.hideTitle"), t("manage.hideDesc"),
          `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`)}
      </div>
      ${s.installed ? `<div class="list mg-danger">
        ${row(t("manage.dangerTitle"), t("amazon.uninstallDesc"),
          `<button class="btn danger small" data-act="amazon-uninstall" data-id="${esc(id)}">${icon("trash", 13)} ${t("manage.uninstallTitle")}</button>`)}
      </div>` : ""}
    </div>`;
}

export function renderDrawerManage(s: EpicSummary): string {
  // Amazon Games is managed by the launcher through Nile.
  const source = sourceOfKey(s.appName);
  if (source === "amazon") {
    return amazonManageBody(s);
  }
  // Companion games are managed by their own client: this panel only offers the
  // hand-off actions, the folder and the playtime the service reports.
  if (source !== "epic" && source !== "gog" && source !== "steam") {
    return companionManageBody(s, source);
  }
  // Steam games are maintained by the Steam client: only hand-off actions here,
  // never file moves, verification loops or save backups of our own.
  if (s.appName.startsWith("steam::")) {
    const steamId = s.appName.slice(7);
    const ptSteam = S.playtimeMap.get(s.appName);
    const playtimeSteam = ptSteam?.total_seconds ? fmtPlaytime(ptSteam.total_seconds) : t("playtime.notPlayed");
    // An owned-but-not-installed Steam game has no files of ours to manage:
    // the panel only hands the install request to the client.
    if (!s.installed) {
      return `
        <div class="manage-tab-content">
          <div class="section-title">${t("manage.groupFiles")}</div>
          <div class="list">
            ${row(t("steam.managedBy"), t("steam.managedByDesc"),
              `<button class="btn primary small" data-act="steam-action" data-id="${steamId}" data-mode="install">${icon("download", 13)} ${t("common.install")}</button>`)}
          </div>
          <div class="section-title">${t("manage.groupSaves")}</div>
          <div class="list">
            <div class="row mg-row stack mg-callout">
              <div class="mg-title">${icon("cloud", 14)} ${t("steam.cloudNoticeTitle")}</div>
              <div class="mg-desc">${t("steam.cloudNoticeDesc")}</div>
              <div class="mg-inline" style="margin-top: 8px;">
                <button class="btn ghost small" data-view="settings" data-settings-section="integrations">${icon("settings", 13)} ${t("cloud.openSettings")}</button>
              </div>
            </div>
            <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(s.appName)}</div>
          </div>
          <div class="section-title">${t("manage.groupCover")}</div>
          <div class="list">
            ${row(t("manage.coverTitle"), t("manage.coverDesc"),
              `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`)}
          </div>
          <div class="section-title">${t("manage.groupPlaytime")}</div>
          <div class="list">
            ${row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtimeSteam)}</span>`, t("steam.playtimeSource"), "")}
          </div>
          <div class="list">
            ${row(t("manage.hideTitle"), t("manage.hideDesc"),
              `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`)}
          </div>
        </div>`;
    }
    return `
      <div class="manage-tab-content">
        <div class="section-title">${t("manage.groupFiles")}</div>
        <div class="list">
          ${row(t("steam.managedBy"), t("steam.managedByDesc"), "")}
          ${row(t("manage.installLocation"), `<span id="manage-install-path" class="mg-path">${esc(s.installPath || t("manage.unspecified"))}</span>`,
            `<button class="btn ghost small" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`)}
          ${row(t("manage.verifyTitle"), t("steam.verifyDesc"),
            `<button class="btn ghost small" data-act="steam-action" data-id="${steamId}" data-mode="validate">${icon("shield", 13)} ${t("steam.validate")}</button>`)}
        </div>

        <div class="section-title">${t("manage.groupSaves")}</div>
        <div class="list">
          <div class="row mg-row stack mg-callout">
            <div class="mg-title">${icon("cloud", 14)} ${t("steam.cloudNoticeTitle")}</div>
            <div class="mg-desc">${t("steam.cloudNoticeDesc")}</div>
            <div class="mg-inline" style="margin-top: 8px;">
              <button class="btn ghost small" data-view="settings" data-settings-section="integrations">${icon("settings", 13)} ${t("cloud.openSettings")}</button>
            </div>
          </div>
          <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(s.appName)}</div>
        </div>

        <div class="section-title">${t("manage.groupCover")}</div>
        <div class="list">
          ${row(t("manage.coverTitle"), t("manage.coverDesc"),
            `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`)}
        </div>

        <div class="section-title">${t("manage.groupPlaytime")}</div>
        <div class="list">
          ${row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtimeSteam)}</span>`, t("steam.playtimeSource"), "")}
        </div>

        <div class="list">
          ${row(t("manage.hideTitle"), t("manage.hideDesc"),
            `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`)}
        </div>

        <div class="list mg-danger">
          ${row(t("manage.dangerTitle"), t("steam.uninstallDesc"),
            `<button class="btn danger small" data-act="steam-action" data-id="${steamId}" data-mode="uninstall">${icon("trash", 13)} ${t("steam.uninstall")}</button>`)}
        </div>
      </div>`;
  }

  if (s.appName.startsWith("gog::")) {
    const ptGog = S.playtimeMap.get(s.appName);
    const playtimeGog = ptGog?.total_seconds ? fmtPlaytime(ptGog.total_seconds) : t("playtime.notPlayed");
    return `
      <div class="manage-tab-content">
        <div class="section-title">${t("manage.groupFiles")}</div>
        <div class="list">
          ${row(t("gog.managedBy"), t("gog.managedByDesc"), "")}
          ${row(t("manage.installLocation"), `<span id="manage-install-path" class="mg-path">${esc(s.installPath || t("manage.unspecified"))}</span>`,
            `<button class="btn ghost small" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`)}
          ${s.installed ? row(t("manage.verifyTitle"), t("manage.verifyDesc"),
            `<button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${s.appName}">${icon("shield", 13)} ${t("manage.verify")}</button>`,
            `<div id="manage-verify-box-container"></div>`) : ""}
        </div>
        <div class="section-title">${t("manage.groupSaves")}</div>
        <div class="list">
          <div class="row mg-row stack mg-callout">
            <div class="mg-title">${icon("cloud", 14)} ${t("gog.cloudNoticeTitle")}</div>
            <div class="mg-desc">${t("gog.cloudNoticeDesc")}</div>
            <div class="mg-inline" style="margin-top: 8px;">
              <button class="btn ghost small" data-view="settings" data-settings-section="integrations">${icon("settings", 13)} ${t("cloud.openSettings")}</button>
            </div>
          </div>
          <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(s.appName)}</div>
        </div>
        <div class="section-title">${t("manage.groupCover")}</div>
        <div class="list">
          ${row(t("manage.coverTitle"), t("manage.coverDesc"),
            `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`)}
        </div>
        <div class="section-title">${t("manage.groupPlaytime")}</div>
        <div class="list">
          ${row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtimeGog)}</span>`, "", "")}
        </div>
        <div class="list">
          ${row(t("manage.hideTitle"), t("manage.hideDesc"),
            `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`)}
        </div>
        ${s.installed ? `<div class="list mg-danger">
          ${row(t("manage.dangerTitle"), t("manage.dangerDesc"),
            `<button class="btn danger small" data-act="epic-uninstall" data-id="${s.appName}">${icon("trash", 13)} ${t("common.uninstall")}</button>`)}
        </div>` : ""}
      </div>`;
  }

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
  const rawGame = rawOf(s.appName);
  const partner = getThirdPartyLauncher(rawGame);
  const blockedMove = requiresThirdPartyLauncher(partner);
  const partnerSaves = partner?.type === "ea" || partner?.type === "ubisoft" || partner?.type === "rockstar";
  const activeSavePath = st.customSavePath || st.savePath || st.detectedSavePath || "";
  const v = S.verifyingMap.get(id);
  const pt = S.playtimeMap.get(id);
  const playtimeStr = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : t("playtime.notPlayed");
  const cloudDesc = S.manageSyncingSaves || S.cloudSyncProgress.has(id)
    ? t("manage.syncing")
    : st.lastCloudSync ? t("manage.lastSync", { time: esc(formatSyncStamp(st.lastCloudSync)) }) : t("manage.cloudDesc");

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
              `<div class="mg-note" style="color: var(--text-3); font-size: 11px;">${icon("info", 12)} ${t("manage.eosCloudNotice")}</div>${syncProgressHtml(id)}${mtuIssueHtml()}`, "manage-cloud-subtitle")}
            <div class="row mg-row">
              <div class="row-main">
                <div class="mg-title">${t("manage.saveFolderTitle")}</div>
                <div class="mg-desc"><span id="manage-save-path" class="mg-path">${esc(activeSavePath || t("manage.noSaveDirDetected"))}</span></div>
              </div>
              <div id="manage-save-path-actions" class="row-actions">${renderSavePathActions(id, activeSavePath, Boolean(st.customSavePath))}</div>
            </div>
            ${row(t("manage.localBackupTitle"), t("manage.backupDesc"),
              `<button class="btn ghost small" data-act="manage-open-backup-folder" data-id="${id}" title="${t("manage.openBackupFolder")}">${icon("folder", 13)} ${t("manage.folder")}</button>
               <button class="btn primary small" data-act="manage-create-backup" data-id="${id}" ${S.isBackingUp ? "disabled" : ""}>${S.isBackingUp ? t("manage.backingUp") : t("manage.backup")}</button>`,
              `<div id="manage-backup-list" class="backup-list">${renderBackupListHtml(id)}</div>`)}
            <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(id)}</div>`}
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
      ? t("manage.lastSync", { time: formatSyncStamp(st.lastCloudSync) })
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

  const activeSavePath = st.customSavePath || st.savePath || st.detectedSavePath || "";
  document.querySelectorAll("#manage-save-path").forEach((el) => {
    el.textContent = activeSavePath || t("manage.noSaveDirDetected");
  });

  const actionsEl = document.getElementById("manage-save-path-actions");
  if (actionsEl) {
    actionsEl.innerHTML = renderSavePathActions(st.appName, activeSavePath, Boolean(st.customSavePath));
  }

  updateManageCloudRowInPlace(st.appName);
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

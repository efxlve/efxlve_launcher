/**
 * Visual components for Cloud Save Backup in Settings and Game Manage drawer.
 * Strict PS5 Obsidian console dark aesthetic.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import { initCloudBackupSettings, loadCloudBackupsAction } from "./cloud-backup-actions";

/** Renders the Cloud Save Backup configuration card in Settings > Integrations. */
export function renderCloudBackupSettingsGroup(): string {
  if (!S.cloudBackupSettings) {
    void initCloudBackupSettings();
  }

  const st = S.cloudBackupSettings ?? {
    enabled: false,
    provider: "none",
    autoSyncOnGameExit: false,
    webdavUrl: "",
    webdavUsername: "",
    webdavPassword: "",
    gdriveClientId: null,
    gdriveClientSecret: null,
    gdriveFolderId: null,
    gdriveUserEmail: null,
    gdriveRefreshToken: null,
    lastSyncTime: null,
  };

  const isEnabled = st.enabled && st.provider !== "none";
  const activeProvider = st.provider;

  const providerSeg = `
    <div class="seg" role="radiogroup">
      <button class="${activeProvider === "google_drive" ? "active" : ""}" data-act="set-cloud-provider" data-provider="google_drive">Google Drive</button>
      <button class="${activeProvider === "webdav" ? "active" : ""}" data-act="set-cloud-provider" data-provider="webdav">WebDAV / Nextcloud</button>
    </div>`;

  let providerConfig = "";
  if (activeProvider === "google_drive") {
    const isConnected = Boolean(st.gdriveRefreshToken);
    const email = st.gdriveUserEmail || t("cloud.connected");

    providerConfig = `
      <div class="row settings-row">
        <div class="row-main">
          <div class="settings-row-title">Google Drive</div>
          <div class="settings-row-desc">
            ${isConnected ? `${t("cloud.gdriveConnectedHint", { email: esc(email) })}<div style="font-size: 11px; color: var(--text-3); margin-top: 4px; line-height: 1.5;">${icon("info", 12)} ${t("cloud.gdriveLocationHint")}</div>` : t("cloud.gdriveDisconnectedHint")}
          </div>
        </div>
        <div class="settings-row-control">
          ${isConnected
            ? `<span class="chip ok">${esc(email)}</span>
               <button type="button" class="btn ghost danger small" data-act="cloud-gdrive-disconnect">${t("cloud.disconnect")}</button>`
            : `<button type="button" class="btn primary small" data-act="cloud-gdrive-connect">${icon("globe", 13)} ${t("cloud.connectGoogle")}</button>`}
        </div>
      </div>`;
  } else if (activeProvider === "webdav") {
    providerConfig = `
      <div class="row settings-row stacked">
        <div class="row-main">
          <div class="settings-row-title">${t("cloud.webdavConfigTitle")}</div>
          <div class="settings-row-desc">${t("cloud.webdavConfigDesc")}</div>
        </div>
        <div class="mg-inline" style="flex-direction:column;gap:8px;margin-top:8px">
          <input id="cloud-webdav-url" class="input" placeholder="https://nextcloud.example.com/remote.php/dav/files/user/" value="${esc(st.webdavUrl)}" spellcheck="false" autocomplete="off" />
          <div style="display:flex;gap:8px">
            <input id="cloud-webdav-user" class="input" placeholder="${t("cloud.username")}" value="${esc(st.webdavUsername)}" spellcheck="false" autocomplete="off" style="flex:1" />
            <input id="cloud-webdav-pass" type="password" class="input" placeholder="${t("cloud.password")}" value="${esc(st.webdavPassword)}" spellcheck="false" autocomplete="off" style="flex:1" />
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button type="button" class="btn ghost small" data-act="cloud-webdav-test" ${S.cloudBackupTesting ? "disabled" : ""}>
              ${S.cloudBackupTesting ? t("cloud.testing") : t("cloud.testConnection")}
            </button>
            <button type="button" class="btn primary small" data-act="cloud-webdav-save">
              ${t("common.save")}
            </button>
          </div>
        </div>
      </div>`;
  }

  const toggleRow = `
    <div class="row settings-row">
      <div class="row-main">
        <div class="settings-row-title">${t("cloud.enableTitle")}</div>
        <div class="settings-row-desc">${t("cloud.enableDesc")}</div>
      </div>
      <div class="settings-row-control">
        <label class="switch"><input type="checkbox" data-act="toggle-cloud-backup-enabled" ${isEnabled ? "checked" : ""} /><span class="track"></span></label>
      </div>
    </div>`;

  const autoSyncRow = isEnabled ? `
    <div class="row settings-row">
      <div class="row-main">
        <div class="settings-row-title">${t("cloud.autoSyncTitle")}</div>
        <div class="settings-row-desc">${t("cloud.autoSyncDesc")}</div>
      </div>
      <div class="settings-row-control">
        <label class="switch"><input type="checkbox" data-act="toggle-cloud-auto-sync" ${st.autoSyncOnGameExit ? "checked" : ""} /><span class="track"></span></label>
      </div>
    </div>` : "";

  const providerRow = isEnabled ? `
    <div class="row settings-row">
      <div class="row-main">
        <div class="settings-row-title">${t("cloud.providerTitle")}</div>
        <div class="settings-row-desc">${t("cloud.providerDesc")}</div>
      </div>
      <div class="settings-row-control">${providerSeg}</div>
    </div>` : "";

  return `
    <h3 class="section-title">${t("cloud.title")}</h3>
    <div class="list settings-group">
      ${toggleRow}
      ${providerRow}
      ${isEnabled ? providerConfig : ""}
      ${autoSyncRow}
    </div>`;
}

/** Formats a UNIX timestamp into a human-friendly localized date string. */
export function fmtCloudDate(timestamp: number): string {
  if (!timestamp) return "-";
  const d = new Date(timestamp * 1000);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Renders cloud save action row in Game Manage > Save section. */
export function renderManageCloudBackupRow(appName: string): string {
  const st = S.cloudBackupSettings;
  if (st === null) {
    void initCloudBackupSettings().then((loaded) => {
      updateManageCloudRowInPlace(appName);
      if (loaded?.enabled && loaded.provider !== "none") {
        void loadCloudBackupsAction(appName);
      }
    });
    return `
      <div class="row mg-row stack">
        <div class="mg-title">${t("cloud.title")}</div>
        <div class="mg-desc">${t("cloud.manageRowDesc")}</div>
        <div class="mg-cloud-badge empty">
          ${icon("refresh", 13, "spin")} <span class="badge-text">${t("cloud.statusChecking")}</span>
        </div>
      </div>`;
  }

  if (!st.enabled || st.provider === "none") {
    return `
      <div class="row mg-row stack mg-callout">
        <div class="mg-title">${icon("cloud", 14)} ${t("cloud.notConfiguredTitle")}</div>
        <div class="mg-desc">${t("cloud.notConfiguredDesc")}</div>
        <div class="mg-inline" style="margin-top: 8px;">
          <button class="btn ghost small" data-view="settings" data-settings-section="integrations">${icon("settings", 13)} ${t("cloud.openSettings")}</button>
        </div>
      </div>`;
  }

  const providerLabel = st.provider === "google_drive" ? "Google Drive" : "WebDAV";
  const backups = S.cloudBackupsMap.get(appName);
  const latest = backups?.[0];
  const isSyncing = S.cloudBackupSyncing && (S.cloudBackupSyncingApp === appName || !S.cloudBackupSyncingApp);
  const busy = isSyncing ? "disabled" : "";

  let statusBadge = "";
  if (isSyncing) {
    statusBadge = `
      <div class="mg-cloud-badge syncing">
        ${icon("refresh", 13, "spin")} <span class="badge-text">${t("cloud.statusUploading")}</span>
      </div>`;
  } else if (latest) {
    const dateStr = fmtCloudDate(latest.timestamp) || latest.formattedDate;
    statusBadge = `
      <div class="mg-cloud-badge synced">
        ${icon("check", 13)} <span class="badge-text">${t("cloud.statusSynced")}</span>
        <span class="badge-dot">·</span>
        <span class="badge-time tabular-nums">${esc(dateStr)}</span>
        <span class="badge-dot">·</span>
        <span class="badge-size tabular-nums">${fmtBytes(latest.sizeBytes)}</span>
      </div>`;
  } else if (backups !== undefined) {
    statusBadge = `
      <div class="mg-cloud-badge empty">
        ${icon("cloud", 13)} <span class="badge-text">${t("cloud.statusNotBackedUp")}</span>
      </div>`;
  } else {
    statusBadge = `
      <div class="mg-cloud-badge empty">
        ${icon("refresh", 13, "spin")} <span class="badge-text">${t("cloud.statusChecking")}</span>
      </div>`;
  }

  const uploadBtnText = isSyncing ? t("cloud.uploadingBtn") : t("cloud.uploadBtn");
  const uploadBtnIcon = isSyncing ? icon("refresh", 13, "spin") : icon("upload", 13);

  const gdriveHint = st.provider === "google_drive"
    ? `<div class="mg-note" style="color: var(--text-3); font-size: 11px; margin-top: 6px; line-height: 1.5;">${icon("info", 12)} ${t("cloud.gdriveLocationHint")}</div>`
    : "";

  let backupsListHtml = "";
  if (backups && backups.length > 0) {
    const itemsHtml = backups
      .map((b, idx) => {
        const dateStr = fmtCloudDate(b.timestamp) || b.formattedDate;
        const sizeStr = fmtBytes(b.sizeBytes);
        const isLatest = idx === 0;
        return `
          <div class="backup-item">
            <div class="backup-item-meta">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="backup-item-title tabular-nums">${esc(dateStr)}</span>
                ${isLatest ? `<span class="chip ok" style="font-size: 10px; padding: 1px 6px; line-height: 14px;">${t("cloud.latestChip")}</span>` : ""}
              </div>
              <span class="backup-item-sub tabular-nums">${b.fileCount ? `${b.fileCount} ${t("ach.files")} • ` : ""}${sizeStr}</span>
            </div>
            <div class="backup-item-actions">
              <button class="btn ghost small" data-act="manage-cloud-restore" data-id="${appName}" data-remote-id="${esc(b.remoteId)}" data-bid="${esc(b.backupId)}" title="${t("cloud.restoreTip")}" ${busy}>
                ${icon("download", 13)} ${t("ach.restore")}
              </button>
              <button class="btn ghost danger small" data-act="manage-cloud-delete" data-id="${appName}" data-remote-id="${esc(b.remoteId)}" title="${t("cloud.deleteTip")}" ${busy}>
                ${icon("trash", 13)} ${t("common.delete")}
              </button>
            </div>
          </div>`;
      })
      .join("");

    const deleteAllBtn = backups.length > 1
      ? `<div style="display: flex; justify-content: flex-end; margin-top: 8px;">
           <button class="btn ghost danger small" data-act="manage-cloud-delete-all" data-id="${appName}" title="${t("cloud.deleteAllTip")}" ${busy}>
             ${icon("trash", 13)} ${t("cloud.deleteAllBtn")}
           </button>
         </div>`
      : "";

    backupsListHtml = `
      <div class="backup-list mg-cloud-backup-list" style="margin-top: 12px;">
        <div style="margin-bottom: 4px;">
          <span style="font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums;">
            ${t("cloud.totalBackups", { count: backups.length })}
          </span>
        </div>
        ${itemsHtml}
        ${deleteAllBtn}
      </div>`;
  }

  return `
    <div class="row mg-row stack">
      <div class="mg-title">${t("cloud.manageRowTitle", { provider: providerLabel })}</div>
      <div class="mg-desc">${t("cloud.manageRowDesc")}</div>
      ${gdriveHint}
      ${statusBadge}
      <div class="row-actions mg-inline end" style="margin-top: 10px;">
        <button class="btn ghost small" data-act="manage-cloud-sync" data-id="${appName}" title="${t("cloud.syncTooltip")}" ${busy}>
          ${icon("refresh", 13)} ${t("cloud.syncBtn")}
        </button>
        <button class="btn primary small" data-act="manage-cloud-upload" data-id="${appName}" title="${t("cloud.uploadTooltip")}" ${busy}>
          ${uploadBtnIcon} ${uploadBtnText}
        </button>
      </div>
      ${backupsListHtml}
    </div>`;
}

/** Updates the cloud backup section in the open Manage drawer in-place without reloading the dialog. */
export function updateManageCloudRowInPlace(appName: string): void {
  const container = document.getElementById("manage-cloud-container");
  if (!container) return;
  const btn = container.querySelector<HTMLElement>('[data-act="manage-cloud-upload"]');
  if (btn && btn.dataset.id && btn.dataset.id !== appName) return;
  container.innerHTML = renderManageCloudBackupRow(appName);
}

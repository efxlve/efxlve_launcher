/**
 * Visual components for Cloud Save Backup in Settings and Game Manage drawer.
 * Strict PS5 Obsidian console dark aesthetic.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { initCloudBackupSettings } from "./cloud-backup-actions";

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
          <div class="settings-row-desc">${isConnected ? t("cloud.gdriveConnectedHint", { email: esc(email) }) : t("cloud.gdriveDisconnectedHint")}</div>
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

/** Renders cloud save action row in Game Manage > Save section. */
export function renderManageCloudBackupRow(appName: string): string {
  const st = S.cloudBackupSettings;
  if (!st || !st.enabled || st.provider === "none") return "";

  const providerLabel = st.provider === "google_drive" ? "Google Drive" : "WebDAV";

  return `
    <div class="row mg-row">
      <div class="row-main">
        <div class="mg-title">${t("cloud.manageRowTitle", { provider: providerLabel })}</div>
        <div class="mg-desc">${t("cloud.manageRowDesc")}</div>
      </div>
      <div class="row-actions">
        <button class="btn ghost small" data-act="manage-cloud-sync" data-id="${appName}" title="${t("cloud.syncTooltip")}" ${S.cloudBackupSyncing ? "disabled" : ""}>
          ${icon("refresh", 13)} ${t("cloud.syncBtn")}
        </button>
        <button class="btn ghost small" data-act="manage-cloud-upload" data-id="${appName}" title="${t("cloud.uploadTooltip")}" ${S.cloudBackupSyncing ? "disabled" : ""}>
          ${icon("upload", 13)} ${t("cloud.uploadBtn")}
        </button>
      </div>
    </div>`;
}

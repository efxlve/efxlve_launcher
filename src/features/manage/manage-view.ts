/**
 * Game management modal (files, saves, verify, move, uninstall).
 *
 * Renders and orchestrates the per-game manage panel. State lives in S; backup
 * list rendering is delegated to the drawer widgets.
 */

import { isTauri } from "../../core/constants";
import { manageRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";

import {
  epicGetGameSettings,
  epicListBackups,
  type GameLocalSettings,
} from "../../epic";
import { renderBackupListHtml } from "../drawer/drawer-widgets";
export function closeManageModal(): void {
  if (manageRoot) manageRoot.innerHTML = "";
  S.activeManageSettings = null;
}

export async function openManageModal(appName: string): Promise<void> {
  if (!isTauri) {
    toast(t("manage.desktopOnly"), "err");
    return;
  }
  const sum = S.epicSummaries.find((x) => x.appName === appName);
  const dl = S.downloads.get(appName);
  const title = sum?.title || dl?.title || appName;
  const version = sum?.installedVersion || sum?.version || "1.0";
  const installPath = sum?.installPath || "";
  const installSize = sum?.installSize || 0;

  // 0ms anında açılış için hızlı yerel verilerle hemen render et
  S.activeManageSettings = {
    appName,
    title,
    launchParameters: "",
    autoUpdate: true,
    highPriority: false,
    cloudSavesEnabled: true,
    lastCloudSync: null,
    installSize,
    installPath,
    version,
  };
  S.manageShowArgs = false;
  renderManageModal();

  // Arka planda tam ayarları çek ve dialogu bozmadan yerinde güncelle
  try {
    const st = await epicGetGameSettings(appName);
    if (S.activeManageSettings && S.activeManageSettings.appName === appName) {
      S.activeManageSettings = st;
      updateManageModalInputsInPlace(st);
    }
  } catch (e) {
    toast(t("manage.settingsFailed", { msg: String(e) }), "err");
  }

  // Arka planda yedekleri çek ve listeyi güncelle
  epicListBackups(appName)
    .then((b) => {
      S.gameBackupsMap.set(appName, b);
      const listEl = document.getElementById("manage-backup-list");
      if (listEl && S.activeManageSettings?.appName === appName) {
        listEl.innerHTML = renderBackupListHtml(appName);
      }
    })
    .catch(() => {});
}

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

  const hasArgs = Boolean(st.launchParameters && st.launchParameters.trim().length > 0);
  S.manageShowArgs = hasArgs;
  const argsToggle = document.getElementById("manage-toggle-args-input") as HTMLInputElement | null;
  if (argsToggle) argsToggle.checked = hasArgs;

  const argsContainer = document.getElementById("manage-args-container");
  if (argsContainer) argsContainer.style.display = hasArgs ? "" : "none";

  const argsInput = document.getElementById("manage-args-input") as HTMLInputElement | null;
  if (argsInput) argsInput.value = st.launchParameters || "";

  const installTitle = document.getElementById("manage-install-title");
  if (installTitle) installTitle.textContent = `${t("manage.installTitle")} • ${fmtBytes(st.installSize)}`;

  const installPaths = document.querySelectorAll("#manage-install-path");
  installPaths.forEach((el) => {
    el.textContent = st.installPath || t("manage.unspecified");
  });

  const headSub = document.getElementById("manage-head-sub");
  if (headSub) headSub.textContent = `${t("manage.headSub")} • v${st.version}`;
}

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
    container.innerHTML = `
      <div class="verify-box">
        <div class="verify-bar">
          <div id="manage-verify-fill" class="verify-fill" style="width:${percent}%"></div>
        </div>
        <div class="verify-meta">
          <span id="manage-verify-count">${displayDetail}</span>
          <span id="manage-verify-speed">${esc(speed)}</span>
        </div>
      </div>
    `;
  }
}

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

export function renderManageModal(): void {
  if (!manageRoot || !S.activeManageSettings) return;
  const st = S.activeManageSettings;
  const v = S.verifyingMap.get(st.appName);
  const isVerifying = Boolean(v);
  const pt = S.playtimeMap.get(st.appName);

  manageRoot.innerHTML = `
    <div class="manage-overlay" data-act="manage-overlay-close">
      <div class="manage-dialog">
        <div class="manage-head">
          <div class="manage-head-title-group">
            <div id="manage-head-title" class="manage-head-title">${esc(st.title)}</div>
            <div id="manage-head-sub" class="manage-head-sub">${t("manage.headSub")} • v${esc(st.version)}</div>
          </div>
          <button class="manage-head-close" data-act="manage-close" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>
        <div class="manage-body">
          <!-- 0. Oynama İstatistikleri -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#38bdf8">${icon("clock", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">${t("manage.playStats")}</div>
                <div class="manage-subtitle">
                  ${t("manage.totalTime")}: <strong style="color:#fff">${fmtPlaytime(pt?.total_seconds || 0)}</strong> • ${t("manage.sessionCount")}: <strong style="color:#fff">${pt?.session_count || 0}</strong> • ${t("manage.last")}: <strong style="color:#fff">${pt?.last_played || t("manage.neverPlayed")}</strong>
                </div>
              </div>
            </div>
          </div>

          <!-- 1. Dosyaları Doğrula -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#60a5fa">${icon("shield", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">${t("manage.verifyTitle")}</div>
                <div class="manage-subtitle">${t("manage.verifyDesc")}</div>
                <div id="manage-verify-box-container">
                  ${
                    isVerifying && v
                      ? `
                    <div class="verify-box">
                      <div class="verify-bar">
                        <div id="manage-verify-fill" class="verify-fill" style="width:${v.percent}%"></div>
                      </div>
                      <div class="verify-meta">
                        <span id="manage-verify-count">${esc(v.detail || `${v.current}/${v.total} (%${v.percent})`)}</span>
                        <span id="manage-verify-speed">${esc(v.speed)}</span>
                      </div>
                    </div>`
                      : ""
                  }
                </div>
              </div>
            </div>
            <div class="manage-right">
              <button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${st.appName}" ${isVerifying ? "disabled" : ""}>
                ${isVerifying ? t("manage.verifying") : t("manage.verify")}
              </button>
            </div>
          </div>

          <!-- 2. Otomatik Güncelleme -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#34d399">${icon("refresh", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">${t("manage.autoUpdateTitle")}</div>
                <div class="manage-subtitle">${t("manage.autoUpdateDesc")}</div>
              </div>
            </div>
            <div class="manage-right">
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-autoupdate" ${st.autoUpdate ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- 3. Öncelikli İndirmeler -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#f59e0b">${icon("zap", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">${t("manage.priorityTitle")}</div>
                <div class="manage-subtitle">${t("manage.priorityDesc")}</div>
              </div>
            </div>
            <div class="manage-right">
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-priority" ${st.highPriority ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- 4. Bulut Kayıtları -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#38bdf8">${icon("cloud", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">${t("manage.cloudTitle")}</div>
                <div id="manage-cloud-subtitle" class="manage-subtitle">
                  ${
                    S.manageSyncingSaves
                      ? t("manage.syncing")
                      : st.lastCloudSync
                        ? t("manage.lastSync", { time: esc(st.lastCloudSync) })
                        : t("manage.cloudDesc")
                  }
                </div>
              </div>
            </div>
            <div class="manage-right">
              <button class="btn ghost small" data-act="manage-sync-saves" data-id="${st.appName}" title="${t("manage.syncNow")}" ${S.manageSyncingSaves ? "disabled" : ""}>
                ${icon("refresh", 13)} ${t("manage.sync")}
              </button>
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-cloud" ${st.cloudSavesEnabled ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- 4.1. Yerel Kayıt Yedekleme (Save Backup Manager) -->
          <div class="manage-row" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
              <div class="manage-left">
                <div class="manage-icon" style="color:#a855f7">${icon("hard-drive", 20)}</div>
                <div class="manage-info">
                  <div class="manage-title">${t("manage.backupTitle")}</div>
                  <div class="manage-subtitle">${t("manage.backupDesc")}</div>
                </div>
              </div>
              <div class="manage-right" style="display:flex;gap:6px;align-items:center">
                <button class="btn ghost small" data-act="manage-open-backup-folder" data-id="${st.appName}" title="${t("manage.openBackupFolder")}">
                  ${icon("folder", 13)} ${t("manage.folder")}
                </button>
                <button class="btn primary small" data-act="manage-create-backup" data-id="${st.appName}" ${S.isBackingUp ? "disabled" : ""}>
                  ${S.isBackingUp ? t("manage.backingUp") : t("manage.backup")}
                </button>
              </div>
            </div>
            <div id="manage-backup-list" class="backup-list">
              ${renderBackupListHtml(st.appName)}
            </div>
          </div>

          <!-- 5. Masaüstü Kısayolu Oluştur -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#a78bfa">${icon("monitor", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">${t("manage.shortcutTitle")}</div>
                <div class="manage-subtitle">${t("manage.shortcutDesc")}</div>
              </div>
            </div>
            <div class="manage-right">
              <button class="btn ghost small" data-act="manage-create-shortcut" data-id="${st.appName}">
                ${t("manage.create")}
              </button>
            </div>
          </div>

          <!-- 6. Yükleme (Boyut & Klasör & Kaldır) -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#e2e8f0">${icon("hard-drive", 20)}</div>
              <div class="manage-info">
                <div id="manage-install-title" class="manage-title">${t("manage.installTitle")} • ${fmtBytes(st.installSize)}</div>
                <div id="manage-install-path" class="manage-subtitle" style="word-break:break-all;opacity:0.8">${esc(st.installPath)}</div>
              </div>
            </div>
            <div class="manage-right">
              <button class="btn ghost small" data-act="open-move-game-modal" data-id="${st.appName}" title="${t("manage.moveTitle")}">
                ${icon("hard-drive", 13)} ${t("manage.move")}
              </button>
              <button class="btn ghost small" data-act="epic-open-folder" data-id="${st.appName}" title="${t("manage.openInstallFolder")}">
                ${icon("folder", 13)} ${t("manage.folder")}
              </button>
              <button class="btn danger small" data-act="epic-uninstall" data-id="${st.appName}" title="${t("manage.uninstallTitle")}">
                ${icon("trash", 13)} ${t("common.uninstall")}
              </button>
            </div>
          </div>

          <!-- 7. Eklentiler & DLC -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#00e5ff">${icon("layers", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">${t("manage.dlcTitle")}</div>
                <div class="manage-subtitle">${t("manage.dlcDesc")}</div>
              </div>
            </div>
            <div class="manage-right">
              <button class="btn ghost small" data-act="open-dlc-manager" data-id="${st.appName}">
                ${t("manage.manageDlc")}
              </button>
            </div>
          </div>

          <!-- 8. Gelişmiş Başlatma Seçenekleri -->
          <div class="manage-row" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
              <div class="manage-left">
                <div class="manage-icon" style="color:#fb7185">${icon("terminal", 20)}</div>
                <div class="manage-info">
                  <div class="manage-title">${t("manage.advancedTitle")}</div>
                  <div class="manage-subtitle">${t("manage.advancedDesc")}</div>
                </div>
              </div>
              <div class="manage-right">
                <label class="toggle-switch">
                  <input id="manage-toggle-args-input" type="checkbox" data-act="manage-toggle-args-panel" ${S.manageShowArgs ? "checked" : ""} />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            </div>
            <div id="manage-args-container" style="${S.manageShowArgs ? "" : "display:none;"}">
              <div class="args-panel">
                <input id="manage-args-input" class="args-input" value="${esc(st.launchParameters || "")}" placeholder="-dx11 -windowed -novid" spellcheck="false" autocomplete="off" />
                <button class="btn primary small" data-act="manage-save-args" data-id="${st.appName}">
                  ${t("common.save")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}


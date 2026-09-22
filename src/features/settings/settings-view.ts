/**
 * Settings page renderer.
 *
 * Renders account, storage, integrations, language and system sections. It only
 * reads shared state (S) and imports presentational helpers; all actions are
 * routed through the global data-act delegation in main.ts.
 */

import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { LANGUAGES, t } from "../../i18n";
import { DEFAULT_DISCORD_CLIENT_ID } from "../presence/presence";
import {
  eosOverlayStatus,
  epicDefaultInstallDir,
  epicDetectEglGames,
  epicGetSettings,
  epicGetSteamGridKey,
  epicThirdPartyLaunchers,
  type EglDetectedGame,
  type ThirdPartyLauncher,
} from "../../epic";

export function renderSettings(): string {
  return `
    <h2>${t("settings.title")}</h2><p class="subtitle">${t("settings.subtitle")}</p>
    <div class="settings-box">
      <h3>${t("settings.accountTitle")}</h3>
      <p>${S.epicAccount ? `${t("settings.connectedAccount")}: <strong>${esc(S.epicAccount)}</strong>` : t("settings.notLoggedIn")}</p>
      ${S.epicAccount ? `<p><button class="btn danger" data-act="epic-logout">${t("settings.logout")}</button></p>` : ""}
      <p class="muted">${t("settings.skippedItems")}: ${S.epicSkippedCount}</p>
    </div>
    <div class="settings-box">
      <h3>${t("settings.installDirTitle")}</h3>
      <p><input id="epic-install-dir" class="text-input" value="${esc(S.epicSettingsCache?.install_dir ?? "")}" placeholder="${esc(S.epicDefaultDir || t("downloads.defaultPlaceholder"))}" autocomplete="off" spellcheck="false" /></p>
      <p style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn ghost small" data-act="epic-save-install-dir">${t("common.save")}</button>
        <span class="muted">${t("settings.installDirHint")} <code>${esc(S.epicDefaultDir || "—")}</code></span>
      </p>
    </div>
    <div class="settings-box">
      <h3>${icon("gamepad-2", 16)} ${t("settings.eglTitle")}</h3>
      <p>${t("settings.eglDesc")}</p>
      ${
        S.eglDetectedList.length > 0
          ? `
          <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:10px;padding:14px;margin:12px 0">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
              <span style="font-size:13px;font-weight:600;color:var(--accent);display:flex;align-items:center;gap:6px">
                ${icon("check", 14)} ${S.eglDetectedList.length} ${t("settings.eglDetected")}
              </span>
              <button class="btn primary small" data-act="epic-sync-egl" ${S.eglSyncing ? "disabled" : ""}>
                ${S.eglSyncing ? t("settings.eglSyncing") : t("settings.eglSync")}
              </button>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;padding-right:6px">
              ${S.eglDetectedList
                .map(
                  (g: EglDetectedGame) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.05);border-radius:8px;font-size:12px">
                  <div style="display:flex;flex-direction:column;gap:2px">
                    <span style="font-weight:600;color:#fff">${esc(g.title)}</span>
                    <span style="color:var(--muted);font-size:11px;opacity:0.8">${esc(g.installPath)}</span>
                  </div>
                  <span style="color:var(--accent);font-size:11px;font-weight:600">${fmtBytes(g.installSize)}</span>
                </div>`
                )
                .join("")}
            </div>
          </div>`
          : `
          <p class="muted" style="margin:10px 0">${t("settings.eglNone")}</p>
          <p><button class="btn ghost small" data-act="epic-refresh-egl">${icon("refresh", 12)} ${t("settings.rescan")}</button></p>
          `
      }
    </div>
    <div class="settings-box">
      <h3>${icon("gamepad-2", 16)} ${t("settings.thirdPartyTitle")}</h3>
      <p>${t("settings.thirdPartyDesc")}</p>
      <div class="tpl-grid">
        ${S.thirdPartyLaunchers.length === 0
          ? `<p class="muted">${t("settings.scanning")}</p>`
          : S.thirdPartyLaunchers
              .map(
                (l) => `
          <div class="tpl-card ${l.installed ? "installed" : ""}">
            <div class="tpl-head">
              <span class="tpl-name">${esc(l.name)}</span>
              <span class="tpl-status ${l.installed ? "on" : "off"}">
                ${l.installed ? `${icon("check", 11)} ${t("settings.installed")}${l.version ? ` · v${esc(l.version)}` : ""}` : t("settings.notInstalled")}
              </span>
            </div>
            <div class="tpl-path" title="${esc(l.installPath || "")}">
              ${l.installed ? esc(l.installPath || t("settings.pathUnknown")) : t("settings.thirdPartyRecommended")}
            </div>
            <div class="tpl-actions">
              <button class="ps5-btn secondary" data-act="open-external-url" data-url="${esc(l.downloadUrl)}">
                ${icon("external", 13)} ${t("settings.officialDownload")}
              </button>
            </div>
          </div>`,
              )
              .join("")}
      </div>
      <div style="margin-top:12px">
        <button class="btn ghost small" data-act="third-party-refresh">${icon("refresh", 12)} ${t("settings.rescan")}</button>
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("folder", 16)} ${t("settings.collectionsTitle")}</h3>
      <p>${t("settings.collectionsDesc")}</p>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap;gap:10px">
        <span class="muted">${S.epicCollections.length} ${t("settings.collectionsCount")}</span>
        <button class="btn ghost small" data-act="import-egl-collections">
          ${icon("download", 12)} ${t("settings.importEglCollections")}
        </button>
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("image", 16)} ${t("settings.sgdbTitle")}</h3>
      <p>${t("settings.sgdbDesc")}</p>
      <div style="display:flex;align-items:center;gap:10px;margin:12px 0;flex-wrap:wrap">
        <span class="sgdb-status-badge ${S.steamGridApiKey ? "connected" : "disconnected"}">
          ${S.steamGridApiKey ? `${icon("check", 12)} ${t("settings.connected")}` : t("settings.keyMissing")}
        </span>
        <button class="btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api" style="font-size:11px;padding:3px 8px">
          ${icon("external", 11)} ${t("settings.getFreeKey")}
        </button>
      </div>
      <div style="display:flex;gap:8px;max-width:560px;align-items:center;flex-wrap:wrap">
        <input id="settings-sgdb-key-input" type="${S.showSettingsSgdbKey ? "text" : "password"}" class="text-input" style="flex:1;min-width:240px" placeholder="${t("settings.sgdbPlaceholder")}" value="${esc(S.steamGridApiKey || "")}" spellcheck="false" autocomplete="off" />
        <button class="btn ghost small" data-act="toggle-sgdb-key-visibility" title="${t("settings.showHide")}">${icon(S.showSettingsSgdbKey ? "eye-off" : "eye", 13)}</button>
        <button class="btn primary small" data-act="save-sgdb-key">${t("common.save")}</button>
        <button class="btn ghost small" data-act="test-sgdb-key">${t("settings.test")}</button>
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("zap", 16)} ${t("settings.netTitle")}</h3>
      <p>${t("settings.netDesc")}</p>
      <div class="net-profile-pills" style="margin-top:10px">
        <button class="net-profile-btn ${S.networkProfile === "max" ? "active" : ""}" data-act="set-net-profile" data-profile="max">
          ${icon("rocket", 13)} ${t("settings.netMax")}
        </button>
        <button class="net-profile-btn ${S.networkProfile === "balanced" ? "active" : ""}" data-act="set-net-profile" data-profile="balanced">
          ${icon("shield-check", 13)} ${t("settings.netBalanced")}
        </button>
        <button class="net-profile-btn ${S.networkProfile === "low" ? "active" : ""}" data-act="set-net-profile" data-profile="low">
          ${icon("clock", 13)} ${t("settings.netLow")}
        </button>
      </div>
      <p class="muted" style="margin-top:8px">
        ${S.networkProfile === "max" ? t("settings.netMaxDesc") : S.networkProfile === "low" ? t("settings.netLowDesc") : t("settings.netBalancedDesc")}
      </p>
    </div>
    <div class="settings-box">
      <h3>${icon("wifi-off", 16)} ${t("settings.offlineTitle")}</h3>
      <p>${t("settings.offlineDesc")}</p>
      <div style="display:flex;align-items:center;gap:12px;margin-top:10px">
        <label class="toggle-switch">
          <input type="checkbox" data-act="toggle-offline-mode" ${S.offlineMode ? "checked" : ""} />
          <span class="toggle-slider"></span>
        </label>
        <span style="font-weight:600;color:${S.offlineMode ? "#fbbf24" : "var(--muted)"}">
          ${S.offlineMode ? t("settings.offlineActive") : t("settings.onlineStandard")}
        </span>
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("globe", 16)} ${t("settings.language")}</h3>
      <p>${t("settings.languageDesc")}</p>
      <div class="lang-selection-group">
        ${LANGUAGES.map(
          (l) => `
          <button class="lang-option-btn ${S.appLanguage === l.code ? "active" : ""}" data-act="set-app-language" data-lang="${esc(l.code)}">
            <span class="lang-flag" style="font-size:12px;font-weight:700;letter-spacing:0.04em">${esc(l.code.toUpperCase())}</span>
            <span class="lang-name">${esc(l.label)}</span>
            ${l.code === "tr" ? `<span class="lang-tag">${t("settings.defaultTag")}</span>` : ""}
          </button>`,
        ).join("")}
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("camera", 16)} ${t("settings.screenshotsTitle")}</h3>
      <p>${t("settings.screenshotsDesc")}</p>
      
      <!-- Hotkey -->
      <div style="margin-top:14px;padding:12px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:10px">
        <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;color:#fff;margin-bottom:8px">
          ${icon("keyboard", 14)} ${t("settings.hotkeyLabel")}
        </label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <select id="ss-hotkey-select" class="text-input" style="width:auto;min-width:190px" data-act="change-ss-hotkey">
            ${S.PRESET_HOTKEYS.map(k => `
              <option value="${k.code}" ${k.code === S.screenshotHotkey ? "selected" : ""}>${k.name}${k.code === 0x7b ? ` (${t("settings.defaultKey")})` : ""}</option>
            `).join("")}
            ${!S.PRESET_HOTKEYS.some(k => k.code === S.screenshotHotkey) ? `
              <option value="${S.screenshotHotkey}" selected>${t("settings.customKey")}: ${esc(S.screenshotHotkeyName)} (${S.screenshotHotkey})</option>
            ` : ""}
          </select>
          <button type="button" class="btn ghost small ${S.isRecordingScreenshotHotkey ? "active" : ""}" data-act="record-screenshot-hotkey" style="${S.isRecordingScreenshotHotkey ? "background:rgba(239,68,68,0.2);border-color:#ef4444;color:#fca5a5" : ""}">
            ${S.isRecordingScreenshotHotkey ? `${icon("keyboard", 12)} ${t("settings.pressKey")}` : `${icon("edit", 12)} ${t("settings.assignKey")}`}
          </button>
          <span class="muted" style="font-size:12px">${t("settings.activeKey")}: <strong style="color:var(--accent);background:rgba(124,58,237,0.15);padding:2px 6px;border-radius:4px">${esc(S.screenshotHotkeyName)}</strong></span>
        </div>
      </div>

      <!-- Image compression (optional, off by default) -->
      <div style="margin-top:12px;padding:12px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;color:#fff">
              ${icon("minimize-2", 14)} ${t("settings.compressionLabel")}
            </label>
            <p class="muted" style="font-size:12px;margin:4px 0 0">
              ${t("settings.compressionDesc")}
            </p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" data-act="toggle-screenshot-compression" ${S.screenshotCompressionEnabled ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
        </div>

        ${S.screenshotCompressionEnabled ? `
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span style="font-size:12px;font-weight:600;color:var(--muted)">${t("settings.format")}:</span>
              <div class="ss-format-pills">
                <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "avif" ? "active" : ""}" data-act="set-ss-format" data-format="avif">
                  ${t("settings.avifBest")}
                </button>
                <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "webp" ? "active" : ""}" data-act="set-ss-format" data-format="webp">
                  ${t("settings.webpBalanced")}
                </button>
                <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "jpg" ? "active" : ""}" data-act="set-ss-format" data-format="jpg">
                  ${t("settings.jpegUniversal")}
                </button>
              </div>
            </div>

            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span style="font-size:12px;font-weight:600;color:var(--muted)">${t("settings.quality")}:</span>
              <input type="range" min="0.70" max="0.95" step="0.05" value="${S.screenshotCompressionQuality}" data-act="set-ss-quality" id="ss-quality-slider" style="width:140px;accent-color:var(--accent)" />
              <span id="ss-quality-val" style="font-size:12px;font-weight:600;color:#fff">%${Math.round(S.screenshotCompressionQuality * 100)}</span>
              <span class="muted" style="font-size:11px">${t("settings.qualityHint")}</span>
            </div>

            <div style="font-size:11px;color:#93c5fd;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2);padding:6px 10px;border-radius:6px;display:flex;align-items:center;gap:6px">
              ${icon("info", 13)}
              <span>${t("settings.avifInfo")}</span>
            </div>
          </div>
        ` : `
          <p class="muted" style="font-size:11px;margin-top:6px;opacity:0.8">
            ${t("settings.compressionOffDesc")}
          </p>
        `}
      </div>
    </div>

    <!-- Discord Rich Presence (optional, off by default) -->
    <div class="settings-box">
      <h3>${icon("gamepad-2", 15)} ${t("settings.presenceTitle")}</h3>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;color:#fff">
            ${t("settings.presenceLabel")}
          </label>
          <p class="muted" style="font-size:12px;margin:4px 0 0">${t("settings.presenceDesc")}</p>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" data-act="toggle-presence" ${S.presenceEnabled ? "checked" : ""} />
          <span class="toggle-slider"></span>
        </label>
      </div>
      ${S.presenceEnabled ? `
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05)">
          <label style="font-size:12px;color:var(--muted);display:block">${t("settings.presenceClientIdLabel")}</label>
          <input id="presence-client-id" class="text-input" style="margin-top:6px" placeholder="${DEFAULT_DISCORD_CLIENT_ID}" value="${esc(S.presenceClientId)}" spellcheck="false" autocomplete="off" />
          <p class="muted" style="font-size:11px;margin:6px 0 0;line-height:1.45">${t("settings.presenceClientIdDesc")}</p>
        </div>
      ` : ""}
    </div>

    <!-- EOS Overlay: installed system-wide by the Epic Games Launcher, injected into games. -->
    <div class="settings-box">
      <h3>${icon("users", 15)} ${t("settings.eosTitle")}</h3>
      <div class="eos-row">
        <span class="eos-dot ${S.eosOverlay?.installed ? "on" : "off"}"></span>
        <div style="flex:1;min-width:0">
          <strong style="font-size:13px;color:#fff">${S.eosOverlay?.installed ? t("settings.eosInstalled") : t("settings.eosMissing")}</strong>
          ${S.eosOverlay?.installed && S.eosOverlay.version ? `<span class="eos-version">${esc(S.eosOverlay.version)}</span>` : ""}
          <p class="muted" style="font-size:12px;margin:4px 0 0;line-height:1.45">
            ${S.eosOverlay?.installed ? t("settings.eosInstalledDesc") : t("settings.eosMissingDesc")}
          </p>
          ${S.eosOverlay?.installed && !S.eosOverlay.overlaySupported ? `<p class="muted" style="font-size:11px;margin:6px 0 0;color:var(--warn,#f59e0b)">${t("settings.eosNotSupported")}</p>` : ""}
          ${S.eosOverlay?.installed && S.eosOverlay.path ? `<code style="display:block;margin-top:6px;font-size:11px">${esc(S.eosOverlay.path)}</code>` : ""}
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          ${S.eosOverlay?.installed ? `<button class="ps5-btn ghost small" data-act="open-eos-folder">${t("settings.eosOpenFolder")}</button>` : ""}
          <button class="ps5-btn ghost small" data-act="refresh-eos">${t("settings.eosRefresh")}</button>
        </div>
      </div>
    </div>

    <div class="settings-box">
      <h3>${t("settings.systemTitle")}</h3>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <label style="font-size:13px;font-weight:600;color:#fff">${t("settings.minimizeToTray")}</label>
          <p class="muted" style="font-size:12px;margin:4px 0 0">${t("settings.minimizeToTrayDesc")}</p>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" data-act="toggle-minimize-tray" ${S.minimizeToTray ? "checked" : ""} />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <label style="font-size:13px;font-weight:600;color:#fff">${t("settings.autoBackup")}</label>
          <p class="muted" style="font-size:12px;margin:4px 0 0">${t("settings.autoBackupDesc")}</p>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" data-act="toggle-auto-backup" ${S.autoBackupOnExit ? "checked" : ""} />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p><strong>${t("settings.backend")}:</strong> ${isTauri ? t("settings.backendRust") : t("settings.backendBrowser")}</p>
      <p><strong>${t("settings.libraryFolder")}:</strong><br /><code>${esc(S.libraryPath)}</code></p>
      <p><strong>${t("settings.version")}:</strong> 0.1.0</p>
    </div>`;
}

/** Load settings, default dir, EGL games, SteamGrid key and third-party launchers. */
export async function loadSettingsView(): Promise<void> {
  if (isTauri) {
    try {
      const [st, dir, eglList, sgdbKey, thirdParty, eos] = await Promise.all([
        epicGetSettings(),
        epicDefaultInstallDir(),
        epicDetectEglGames().catch(() => [] as EglDetectedGame[]),
        epicGetSteamGridKey().catch(() => null),
        epicThirdPartyLaunchers().catch(() => [] as ThirdPartyLauncher[]),
        eosOverlayStatus().catch(() => null),
      ]);
      S.epicSettingsCache = st;
      S.epicDefaultDir = dir;
      S.eglDetectedList = eglList;
      S.steamGridApiKey = sgdbKey;
      S.thirdPartyLaunchers = thirdParty;
      S.eosOverlay = eos;
    } catch {
      // Silent: keep the last cached values.
    }
  }
  render();
}
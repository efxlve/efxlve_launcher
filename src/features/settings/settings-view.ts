/**
 * Settings page renderer.
 *
 * Two-pane console layout: a category rail (left) selects one focused content
 * panel (right) so the page never turns into a long, cluttered scroll. It only
 * reads shared state (S) and imports presentational helpers; every action is
 * routed through the global data-act delegation.
 */

import { isTauri } from "../../core/constants";
import { icon, type IconName } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import type { SettingsSection } from "../../core/types";
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

const SECTIONS: { id: SettingsSection; icon: IconName; labelKey: string }[] = [
  { id: "account", icon: "users", labelKey: "settings.secAccount" },
  { id: "downloads", icon: "download", labelKey: "settings.secDownloads" },
  { id: "integrations", icon: "layers", labelKey: "settings.secIntegrations" },
  { id: "appearance", icon: "globe", labelKey: "settings.secAppearance" },
  { id: "screenshots", icon: "camera", labelKey: "settings.secScreenshots" },
  { id: "system", icon: "settings", labelKey: "settings.secSystem" },
];

/** A single setting line: title/description on the left, a control on the right. */
function row(title: string, desc: string | null, control: string, stacked = false): string {
  return `
    <div class="settings-row${stacked ? " stacked" : ""}">
      <div class="settings-row-text">
        <div class="settings-row-title">${title}</div>
        ${desc ? `<div class="settings-row-desc">${desc}</div>` : ""}
      </div>
      ${control ? `<div class="settings-row-control">${control}</div>` : ""}
    </div>`;
}

/** A toggle switch bound to a data-act handler. */
function toggle(act: string, checked: boolean): string {
  return `<label class="toggle-switch"><input type="checkbox" data-act="${act}" ${checked ? "checked" : ""} /><span class="toggle-slider"></span></label>`;
}

function group(rows: string, title = ""): string {
  return `<section class="settings-group">${title ? `<div class="settings-group-title">${title}</div>` : ""}${rows}</section>`;
}

/* ---------- Sections ---------- */

function renderAccount(): string {
  const accountControl = S.epicAccount
    ? `<button class="ps5-btn ghost small" data-act="epic-logout">${t("settings.logout")}</button>`
    : "";
  const accountDesc = S.epicAccount
    ? `${t("settings.connectedAccount")}: <strong>${esc(S.epicAccount)}</strong>`
    : t("settings.notLoggedIn");
  return group(
    row(t("settings.accountTitle"), accountDesc, accountControl) +
      row(t("settings.skippedItems"), null, `<span class="settings-value">${S.epicSkippedCount}</span>`),
  );
}

function renderDownloads(): string {
  const netDesc =
    S.networkProfile === "max"
      ? t("settings.netMaxDesc")
      : S.networkProfile === "low"
        ? t("settings.netLowDesc")
        : t("settings.netBalancedDesc");
  return (
    group(
      `<div class="settings-row stacked">
        <div class="settings-row-text">
          <div class="settings-row-title">${t("settings.installDirTitle")}</div>
          <div class="settings-row-desc">${t("settings.installDirHint")} <code>${esc(S.epicDefaultDir || "—")}</code></div>
        </div>
        <div class="settings-row-control">
          <input id="epic-install-dir" class="text-input" value="${esc(S.epicSettingsCache?.install_dir ?? "")}" placeholder="${esc(S.epicDefaultDir || t("downloads.defaultPlaceholder"))}" autocomplete="off" spellcheck="false" />
          <button class="ps5-btn primary small" data-act="epic-save-install-dir">${t("common.save")}</button>
        </div>
      </div>`,
      t("settings.secDownloads"),
    ) +
    group(
      `<div class="settings-row stacked">
        <div class="settings-row-text">
          <div class="settings-row-title">${t("settings.netTitle")}</div>
          <div class="settings-row-desc">${t("settings.netDesc")}</div>
        </div>
        <div class="settings-row-control">
          <div class="net-profile-pills">
            <button class="net-profile-btn ${S.networkProfile === "max" ? "active" : ""}" data-act="set-net-profile" data-profile="max">${icon("rocket", 13)} ${t("settings.netMax")}</button>
            <button class="net-profile-btn ${S.networkProfile === "balanced" ? "active" : ""}" data-act="set-net-profile" data-profile="balanced">${icon("shield-check", 13)} ${t("settings.netBalanced")}</button>
            <button class="net-profile-btn ${S.networkProfile === "low" ? "active" : ""}" data-act="set-net-profile" data-profile="low">${icon("clock", 13)} ${t("settings.netLow")}</button>
          </div>
        </div>
        <div class="settings-row-desc" style="margin-top:8px">${netDesc}</div>
      </div>`,
      t("settings.secDownloads"),
    ) +
    group(
      row(
        t("settings.offlineTitle"),
        t("settings.offlineDesc"),
        `<span class="settings-row-desc" style="color:${S.offlineMode ? "#fbbf24" : "var(--muted)"};font-weight:600">${S.offlineMode ? t("settings.offlineActive") : t("settings.onlineStandard")}</span>${toggle("toggle-offline-mode", S.offlineMode)}`,
      ),
    )
  );
}

function renderIntegrations(): string {
  if (S.settingsIntegrationsLoading && !S.settingsIntegrationsLoaded) {
    return `<div class="settings-loading">${icon("refresh", 16)}<span>${t("settings.scanning")}</span></div>`;
  }
  const egl = S.eglDetectedList;
  const eglSync =
    egl.length > 0
      ? `<button class="ps5-btn primary small" data-act="epic-sync-egl" ${S.eglSyncing ? "disabled" : ""}>${S.eglSyncing ? t("settings.eglSyncing") : t("settings.eglSync")}</button>`
      : `<button class="ps5-btn ghost small" data-act="epic-refresh-egl">${icon("refresh", 12)} ${t("settings.rescan")}</button>`;

  const eglGroup =
    `<div class="settings-row stacked">
      <div class="settings-row-text"><div class="settings-row-desc">${t("settings.eglDesc")}</div></div>
      <div class="settings-row-control" style="justify-content:space-between">
        <span class="settings-value">${egl.length > 0 ? `${egl.length} ${t("settings.eglDetected")}` : t("settings.eglNone")}</span>
        ${eglSync}
      </div>
      ${
        egl.length > 0
          ? `<div class="settings-list">${egl
              .map(
                (g: EglDetectedGame) => `
        <div class="settings-list-item">
          <div class="li-main">
            <span class="li-title">${esc(g.title)}</span>
            <span class="li-sub" title="${esc(g.installPath)}">${esc(g.installPath)}</span>
          </div>
          <span class="li-size">${fmtBytes(g.installSize)}</span>
        </div>`,
              )
              .join("")}</div>`
          : ""
      }
    </div>` +
    row(
      t("settings.collectionsTitle"),
      `${t("settings.collectionsDesc")} <strong>${S.epicCollections.length}</strong> ${t("settings.collectionsCount")}`,
      `<button class="ps5-btn ghost small" data-act="import-egl-collections">${icon("download", 12)} ${t("settings.importEglCollections")}</button>`,
    );

  const tpl =
    S.thirdPartyLaunchers.length === 0
      ? row(t("settings.thirdPartyDesc"), t("settings.scanning"), "")
      : `<div class="settings-row stacked">
          <div class="settings-row-text"><div class="settings-row-desc">${t("settings.thirdPartyDesc")}</div></div>
          <div class="settings-row-control" style="flex-direction:column;align-items:stretch;gap:10px">
            <div class="tpl-grid">
              ${S.thirdPartyLaunchers
                .map(
                  (l: ThirdPartyLauncher) => `
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
                    <button class="ps5-btn secondary" data-act="open-external-url" data-url="${esc(l.downloadUrl)}">${icon("external", 13)} ${t("settings.officialDownload")}</button>
                  </div>
                </div>`,
                )
                .join("")}
            </div>
            <button class="ps5-btn ghost small" data-act="third-party-refresh" style="align-self:flex-start">${icon("refresh", 12)} ${t("settings.rescan")}</button>
          </div>
        </div>`;

  const sgdb = `<div class="settings-row stacked">
      <div class="settings-row-text"><div class="settings-row-desc">${t("settings.sgdbDesc")}</div></div>
      <div class="settings-row-control">
        <input id="settings-sgdb-key-input" type="${S.showSettingsSgdbKey ? "text" : "password"}" class="text-input" placeholder="${t("settings.sgdbPlaceholder")}" value="${esc(S.steamGridApiKey || "")}" spellcheck="false" autocomplete="off" />
        <button class="ps5-btn-icon" data-act="toggle-sgdb-key-visibility" title="${t("settings.showHide")}">${icon(S.showSettingsSgdbKey ? "eye-off" : "eye", 14)}</button>
        <button class="ps5-btn primary small" data-act="save-sgdb-key">${t("common.save")}</button>
        <button class="ps5-btn ghost small" data-act="test-sgdb-key">${t("settings.test")}</button>
      </div>
      <div class="settings-row-control" style="margin-top:8px">
        <span class="sgdb-status-badge ${S.steamGridApiKey ? "connected" : "disconnected"}">${S.steamGridApiKey ? `${icon("check", 12)} ${t("settings.connected")}` : t("settings.keyMissing")}</span>
        <button class="ps5-btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api">${icon("external", 11)} ${t("settings.getFreeKey")}</button>
      </div>
    </div>`;

  const eos = `<div class="settings-row">
      <div class="settings-row-text">
        <div class="settings-row-title">${icon("users", 13)} ${t("settings.eosTitle")}${S.eosOverlay?.installed && S.eosOverlay.version ? ` <span class="eos-version">${esc(S.eosOverlay.version)}</span>` : ""}</div>
        <div class="settings-row-desc">
          <span class="eos-dot ${S.eosOverlay?.installed ? "on" : "off"}" style="display:inline-block;margin-right:6px"></span>${S.eosOverlay?.installed ? t("settings.eosInstalled") : t("settings.eosMissing")} — ${S.eosOverlay?.installed ? t("settings.eosInstalledDesc") : t("settings.eosMissingDesc")}
        </div>
        ${S.eosOverlay?.installed && !S.eosOverlay.overlaySupported ? `<div class="settings-row-desc" style="color:#f59e0b">${t("settings.eosNotSupported")}</div>` : ""}
        ${S.eosOverlay?.installed && S.eosOverlay.path ? `<div class="settings-row-desc"><code>${esc(S.eosOverlay.path)}</code></div>` : ""}
      </div>
      <div class="settings-row-control">
        ${S.eosOverlay?.installed ? `<button class="ps5-btn ghost small" data-act="open-eos-folder">${t("settings.eosOpenFolder")}</button>` : ""}
        <button class="ps5-btn ghost small" data-act="refresh-eos">${t("settings.eosRefresh")}</button>
      </div>
    </div>`;

  const presence = row(
    t("settings.presenceTitle"),
    t("settings.presenceDesc"),
    toggle("toggle-presence", S.presenceEnabled),
  );

  const presenceExtra = S.presenceEnabled
    ? `<div class="settings-row stacked">
        <div class="settings-row-text"><div class="settings-row-desc">${t("settings.presenceClientIdDesc")}</div></div>
        <div class="settings-row-control">
          <input id="presence-client-id" class="text-input" placeholder="${DEFAULT_DISCORD_CLIENT_ID}" value="${esc(S.presenceClientId)}" spellcheck="false" autocomplete="off" />
        </div>
      </div>`
    : "";

  return (
    group(eglGroup, t("settings.eglTitle")) +
    group(tpl, t("settings.thirdPartyTitle")) +
    group(sgdb, t("settings.sgdbTitle")) +
    group(presence + presenceExtra + eos, t("settings.secSocial"))
  );
}

function renderAppearance(): string {
  const languages = LANGUAGES.map(
    (l) => `
      <button class="lang-option-btn ${S.appLanguage === l.code ? "active" : ""}" data-act="set-app-language" data-lang="${esc(l.code)}">
        <span class="lang-flag" style="font-size:12px;font-weight:700;letter-spacing:0.04em">${esc(l.code.toUpperCase())}</span>
        <span class="lang-name">${esc(l.label)}</span>
        ${l.code === "tr" ? `<span class="lang-tag">${t("settings.defaultTag")}</span>` : ""}
      </button>`,
  ).join("");
  return group(
    row(t("settings.language"), t("settings.languageDesc"), "") +
      `<div class="lang-selection-group">${languages}</div>`,
    t("settings.secAppearance"),
  );
}

function renderScreenshots(): string {
  const hotkey = `<div class="settings-row stacked">
      <div class="settings-row-text">
        <div class="settings-row-title">${icon("keyboard", 13)} ${t("settings.hotkeyLabel")}</div>
        <div class="settings-row-desc">${t("settings.activeKey")}: <strong>${esc(S.screenshotHotkeyName)}</strong></div>
      </div>
      <div class="settings-row-control">
        <select id="ss-hotkey-select" class="text-input" style="width:auto;min-width:190px" data-act="change-ss-hotkey">
          ${S.PRESET_HOTKEYS.map(
            (k) => `<option value="${k.code}" ${k.code === S.screenshotHotkey ? "selected" : ""}>${k.name}${k.code === 0x7b ? ` (${t("settings.defaultKey")})` : ""}</option>`,
          ).join("")}
          ${!S.PRESET_HOTKEYS.some((k) => k.code === S.screenshotHotkey) ? `<option value="${S.screenshotHotkey}" selected>${t("settings.customKey")}: ${esc(S.screenshotHotkeyName)} (${S.screenshotHotkey})</option>` : ""}
        </select>
        <button type="button" class="ps5-btn ghost small ${S.isRecordingScreenshotHotkey ? "active" : ""}" data-act="record-screenshot-hotkey" style="${S.isRecordingScreenshotHotkey ? "background:rgba(239,68,68,0.2);border-color:#ef4444;color:#fca5a5" : ""}">
          ${S.isRecordingScreenshotHotkey ? `${icon("keyboard", 12)} ${t("settings.pressKey")}` : `${icon("edit", 12)} ${t("settings.assignKey")}`}
        </button>
      </div>
    </div>`;

  const compressionOpts = S.screenshotCompressionEnabled
    ? `<div class="settings-row stacked">
        <div class="settings-row-control">
          <span class="settings-row-desc" style="font-weight:600">${t("settings.format")}:</span>
          <div class="ss-format-pills">
            <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "avif" ? "active" : ""}" data-act="set-ss-format" data-format="avif">${t("settings.avifBest")}</button>
            <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "webp" ? "active" : ""}" data-act="set-ss-format" data-format="webp">${t("settings.webpBalanced")}</button>
            <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "jpg" ? "active" : ""}" data-act="set-ss-format" data-format="jpg">${t("settings.jpegUniversal")}</button>
          </div>
        </div>
        <div class="settings-row-control" style="margin-top:12px">
          <span class="settings-row-desc" style="font-weight:600">${t("settings.quality")}:</span>
          <input type="range" min="0.70" max="0.95" step="0.05" value="${S.screenshotCompressionQuality}" data-act="set-ss-quality" id="ss-quality-slider" style="width:140px;accent-color:var(--accent)" />
          <span id="ss-quality-val" style="font-size:12px;font-weight:600;color:#fff">%${Math.round(S.screenshotCompressionQuality * 100)}</span>
        </div>
        <div class="settings-inline-note">${icon("info", 13)}<span>${t("settings.avifInfo")}</span></div>
      </div>`
    : "";

  const compression = row(
    t("settings.compressionLabel"),
    S.screenshotCompressionEnabled ? t("settings.compressionDesc") : t("settings.compressionOffDesc"),
    toggle("toggle-screenshot-compression", S.screenshotCompressionEnabled),
  );

  return group(hotkey + compression + compressionOpts, t("settings.screenshotsTitle"));
}

function renderSystem(): string {
  const autoUpdateControl = `<input id="auto-update-time" class="text-input" style="width:76px;text-align:center;font-variant-numeric:tabular-nums" value="${esc(S.autoUpdateTime)}" maxlength="5" placeholder="03:00" spellcheck="false" autocomplete="off" />${toggle("toggle-auto-update", S.autoUpdateEnabled)}`;
  return (
    group(
      row(t("settings.minimizeToTray"), t("settings.minimizeToTrayDesc"), toggle("toggle-minimize-tray", S.minimizeToTray)) +
        row(t("settings.autoBackup"), t("settings.autoBackupDesc"), toggle("toggle-auto-backup", S.autoBackupOnExit)) +
        row(t("settings.autoUpdate"), t("settings.autoUpdateDesc"), autoUpdateControl),
      t("settings.secSystem"),
    ) +
    group(
      row(t("settings.backend"), null, `<span class="settings-value">${isTauri ? t("settings.backendRust") : t("settings.backendBrowser")}</span>`) +
        row(t("settings.libraryFolder"), `<code>${esc(S.libraryPath)}</code>`, "") +
        row(t("settings.version"), null, `<span class="settings-value">0.1.0</span>`),
      t("settings.systemTitle"),
    )
  );
}

function renderSection(section: SettingsSection): string {
  switch (section) {
    case "downloads":
      return renderDownloads();
    case "integrations":
      return renderIntegrations();
    case "appearance":
      return renderAppearance();
    case "screenshots":
      return renderScreenshots();
    case "system":
      return renderSystem();
    default:
      return renderAccount();
  }
}

export function renderSettings(): string {
  const active = SECTIONS.find((s) => s.id === S.settingsSection) ?? SECTIONS[0];
  const nav = SECTIONS.map(
    (s) => `
      <button class="settings-nav-item ${s.id === active.id ? "active" : ""}" data-act="settings-section" data-section="${s.id}">
        <span class="settings-nav-icon">${icon(s.icon, 16)}</span>
        <span class="settings-nav-label">${t(s.labelKey)}</span>
      </button>`,
  ).join("");

  return `
    <div class="ps5-page ps5-settings-page">
      <header class="ps5-page-header">
        <div class="ps5-header-main">
          <h1 class="ps5-header-title">${t("settings.title")}</h1>
          <p class="ps5-header-subtitle">${t("settings.subtitle")}</p>
        </div>
      </header>
      <main class="ps5-page-body">
        <div class="settings-layout">
          <nav class="settings-nav">${nav}</nav>
          <div class="settings-panel">
            <div class="settings-panel-head">
              <span class="settings-panel-icon">${icon(active.icon, 19)}</span>
              <h2 class="settings-panel-title">${t(active.labelKey)}</h2>
            </div>
            ${renderSection(active.id)}
          </div>
        </div>
      </main>
    </div>`;
}

/**
 * Loads the cheap settings data (settings.json, default dir, SteamGrid key).
 * Heavy integration scans are deferred to {@link loadIntegrationsView} so the
 * page paints instantly and the launcher never appears to freeze.
 */
export async function loadSettingsView(): Promise<void> {
  if (isTauri) {
    try {
      const [st, dir, sgdbKey] = await Promise.all([
        epicGetSettings(),
        epicDefaultInstallDir(),
        epicGetSteamGridKey().catch(() => null),
      ]);
      S.epicSettingsCache = st;
      S.epicDefaultDir = dir;
      S.steamGridApiKey = sgdbKey;
    } catch {
      // Silent: keep the last cached values.
    }
  }
  render();
  if (S.settingsSection === "integrations") void loadIntegrationsView();
}

/**
 * Loads the slow integration data (EGL scan, third-party registry scan, EOS).
 * Runs only when the Integrations section is shown and is cached afterwards.
 */
export async function loadIntegrationsView(force = false): Promise<void> {
  if (!isTauri || S.settingsIntegrationsLoading) return;
  if (S.settingsIntegrationsLoaded && !force) return;
  S.settingsIntegrationsLoading = true;
  render();
  try {
    const [eglList, thirdParty, eos] = await Promise.all([
      epicDetectEglGames().catch(() => [] as EglDetectedGame[]),
      epicThirdPartyLaunchers().catch(() => [] as ThirdPartyLauncher[]),
      eosOverlayStatus().catch(() => null),
    ]);
    S.eglDetectedList = eglList;
    S.thirdPartyLaunchers = thirdParty;
    S.eosOverlay = eos;
    S.settingsIntegrationsLoaded = true;
  } catch {
    // Silent: keep the last cached values.
  } finally {
    S.settingsIntegrationsLoading = false;
    render();
  }
}

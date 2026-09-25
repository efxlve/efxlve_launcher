/**
 * Settings page renderer.
 *
 * Two-pane layout: a plain text sub-navigation (left) selects one focused
 * panel (right) built from the shared list-row component. It only reads shared
 * state (S); every action is routed through the global data-act delegation.
 */

import launcherIcon from "../../../src-tauri/icons/128x128@2x.png";
import { isTauri } from "../../core/constants";
import { emptyState, icon } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import type { SettingsSection } from "../../core/types";
import { cdnShortLabel, esc, fmtBytes } from "../../core/utils";
import { LANGUAGES, t } from "../../i18n";
import { renderAccountSettings } from "../accounts/accounts-view";
import { loadSavedAccounts } from "../auth/account-switcher";
import { appUpdateInstallBlocked } from "../updates/update-manager";
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

const SECTIONS: { id: SettingsSection; labelKey: string }[] = [
  { id: "account", labelKey: "settings.secAccount" },
  { id: "downloads", labelKey: "settings.secDownloads" },
  { id: "integrations", labelKey: "settings.secIntegrations" },
  { id: "appearance", labelKey: "settings.secAppearance" },
  { id: "screenshots", labelKey: "settings.secScreenshots" },
  { id: "system", labelKey: "settings.secSystem" },
  { id: "hidden", labelKey: "settings.secHidden" },
  { id: "about", labelKey: "settings.secAbout" },
];

/** A single setting line: title/description on the left, a control on the right. */
function row(title: string, desc: string | null, control: string, stacked = false): string {
  return `
    <div class="row settings-row${stacked ? " stacked" : ""}">
      <div class="row-main">
        <div class="settings-row-title">${title}</div>
        ${desc ? `<div class="settings-row-desc">${desc}</div>` : ""}
      </div>
      ${control ? `<div class="settings-row-control">${control}</div>` : ""}
    </div>`;
}

/** A toggle switch bound to a data-act handler. */
function toggle(act: string, checked: boolean): string {
  return `<label class="switch"><input type="checkbox" data-act="${act}" ${checked ? "checked" : ""} /><span class="track"></span></label>`;
}

function group(rows: string, title = ""): string {
  return `${title ? `<h3 class="section-title">${title}</h3>` : ""}<div class="list settings-group">${rows}</div>`;
}

function renderDownloads(): string {
  const dir = row(
    t("settings.installDirTitle"),
    `${t("settings.installDirHint")} <code>${esc(S.epicDefaultDir || "—")}</code>`,
    `<input id="epic-install-dir" class="input settings-path-input" value="${esc(S.epicSettingsCache?.install_dir ?? "")}" placeholder="${esc(S.epicDefaultDir || t("downloads.defaultPlaceholder"))}" autocomplete="off" spellcheck="false" />
     <button type="button" class="btn ghost small" data-act="dl-pick-install-dir">${t("common.browse")}</button>
     <button type="button" class="btn primary small" data-act="epic-save-install-dir">${t("common.save")}</button>`,
  );

  const profileDesc = S.networkProfile === "max" ? t("settings.netMaxDesc") : S.networkProfile === "low" ? t("settings.netLowDesc") : t("settings.netBalancedDesc");
  const profile = row(t("settings.netCardsTitle"), profileDesc, `
    <div class="seg" role="radiogroup">
      <button class="${S.networkProfile === "max" ? "active" : ""}" data-act="set-net-profile" data-profile="max">${t("settings.netMax")}</button>
      <button class="${S.networkProfile === "balanced" ? "active" : ""}" data-act="set-net-profile" data-profile="balanced">${t("settings.netBalanced")}</button>
      <button class="${S.networkProfile === "low" ? "active" : ""}" data-act="set-net-profile" data-profile="low">${t("settings.netLow")}</button>
    </div>`);

  const cdnHost = S.preferredCdn ? cdnShortLabel(S.preferredCdn) : "";
  const cdn = row(
    t("downloads.cdnLabel"),
    cdnHost ? t("downloads.cdnHintPicked", { host: cdnHost }) : t("downloads.cdnHint"),
    `<button type="button" class="btn ghost small ${cdnHost ? "" : "active"}" data-act="dl-set-cdn" data-cdn="">${t("downloads.cdnAutoShort")}</button>
     <button type="button" class="btn ghost small" data-act="dl-find-fastest-cdn">${t("downloads.cdnFind")}</button>`,
  );

  return (
    group(dir + profile + cdn, t("settings.secDownloads")) +
    group(
      row(t("downloads.speedBits"), t("downloads.speedBitsDesc"), toggle("toggle-speed-bits", S.speedInBits)) +
      row(t("downloads.pauseOnPlay"), t("downloads.pauseOnPlayDesc"), toggle("toggle-pause-on-play", S.pauseOnPlay)) +
      row(t("settings.autoDesktopShortcut"), t("settings.autoDesktopShortcutDesc"), toggle("toggle-auto-desktop-shortcut", S.autoDesktopShortcut)) +
      row(t("settings.offlineTitle"), t("settings.offlineDesc"), toggle("toggle-offline-mode", S.offlineMode)) +
      row(t("downloads.cacheClear"), t("settings.netCacheDesc"), `<button type="button" class="btn ghost small" data-act="dl-cleanup-cache">${t("downloads.cacheClearBtn")}</button>`),
      t("settings.netAdvTitle"),
    )
  );
}

function renderIntegrations(): string {
  if (S.settingsIntegrationsLoading && !S.settingsIntegrationsLoaded) {
    return `<div class="empty-state"><span class="spinner"></span><p>${t("settings.scanning")}</p></div>`;
  }
  const egl = S.eglDetectedList;
  const eglAction = egl.length > 0
    ? `<button class="btn primary small" data-act="epic-sync-egl" ${S.eglSyncing ? "disabled" : ""}>${S.eglSyncing ? t("settings.eglSyncing") : t("settings.eglSync")}</button>`
    : `<button class="btn ghost small" data-act="epic-refresh-egl">${t("settings.rescan")}</button>`;
  const eglRows = egl.map((g: EglDetectedGame) => `
    <div class="row">
      <div class="row-main"><div class="row-title">${esc(g.title)}</div><div class="row-meta" title="${esc(g.installPath)}">${esc(g.installPath)}</div></div>
      <span class="row-meta">${fmtBytes(g.installSize)}</span>
    </div>`).join("");

  const eglGroup =
    row(egl.length > 0 ? `${egl.length} ${t("settings.eglDetected")}` : t("settings.eglNone"), t("settings.eglDesc"), eglAction) +
    eglRows +
    row(
      t("settings.collectionsTitle"),
      `${t("settings.collectionsDesc")} <strong>${S.epicCollections.length}</strong> ${t("settings.collectionsCount")}`,
      `<button class="btn ghost small" data-act="import-egl-collections">${t("settings.importEglCollections")}</button>`,
    );

  const tplRows = S.thirdPartyLaunchers.length === 0
    ? row(t("settings.thirdPartyDesc"), t("settings.scanning"), "")
    : S.thirdPartyLaunchers.map((l: ThirdPartyLauncher) => row(
        esc(l.name),
        l.installed ? esc(l.installPath || t("settings.pathUnknown")) : t("settings.thirdPartyRecommended"),
        `${l.installed ? `<span class="chip ok">${t("settings.installed")}${l.version ? ` \u00B7 v${esc(l.version)}` : ""}</span>` : `<span class="chip">${t("settings.notInstalled")}</span>`}
         <button class="btn ghost small" data-act="open-external-url" data-url="${esc(l.downloadUrl)}">${t("settings.officialDownload")}</button>`,
      )).join("") +
      row(t("settings.thirdPartyDesc"), null, `<button class="btn ghost small" data-act="third-party-refresh">${t("settings.rescan")}</button>`);

  const sgdb = row(
    t("settings.sgdbTitle"),
    `${t("settings.sgdbDesc")} <span class="chip ${S.steamGridApiKey ? "ok" : ""}">${S.steamGridApiKey ? t("settings.connected") : t("settings.keyMissing")}</span>`,
    `<input id="settings-sgdb-key-input" type="${S.showSettingsSgdbKey ? "text" : "password"}" class="input settings-path-input" placeholder="${t("settings.sgdbPlaceholder")}" value="${esc(S.steamGridApiKey || "")}" spellcheck="false" autocomplete="off" />
     <button class="icon-btn" data-act="toggle-sgdb-key-visibility" title="${t("settings.showHide")}">${icon(S.showSettingsSgdbKey ? "eye-off" : "eye", 15)}</button>
     <button class="btn primary small" data-act="save-sgdb-key">${t("common.save")}</button>
     <button class="btn ghost small" data-act="test-sgdb-key">${t("settings.test")}</button>
     <button class="btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api">${t("settings.getFreeKey")}</button>`,
    true,
  );

  const eos = row(
    `${t("settings.eosTitle")}${S.eosOverlay?.installed && S.eosOverlay.version ? ` <span class="eos-version">${esc(S.eosOverlay.version)}</span>` : ""}`,
    `<span class="eos-dot inline ${S.eosOverlay?.installed ? "on" : "off"}"></span>${S.eosOverlay?.installed ? t("settings.eosInstalledDesc") : t("settings.eosMissingDesc")}` +
      (S.eosOverlay?.installed && !S.eosOverlay.overlaySupported ? `<br /><span class="settings-note-warn">${t("settings.eosNotSupported")}</span>` : "") +
      (S.eosOverlay?.installed && S.eosOverlay.path ? `<br /><code>${esc(S.eosOverlay.path)}</code>` : ""),
    `${S.eosOverlay?.installed ? `<button class="btn ghost small" data-act="open-eos-folder">${t("settings.eosOpenFolder")}</button>` : ""}
     <button class="btn ghost small" data-act="refresh-eos">${t("settings.eosRefresh")}</button>`,
  );

  const presence = row(t("settings.presenceTitle"), t("settings.presenceDesc"), toggle("toggle-presence", S.presenceEnabled));

  return (
    group(eglGroup, t("settings.eglTitle")) +
    group(tplRows, t("settings.thirdPartyTitle")) +
    group(sgdb, "SteamGridDB") +
    group(presence + eos, t("settings.secSocial"))
  );
}

function renderAppearance(): string {
  const languages = LANGUAGES.map((l) => `
    <button class="lang-option-btn ${S.appLanguage === l.code ? "active" : ""}" data-act="set-app-language" data-lang="${esc(l.code)}">
      <span class="lang-flag">${esc(l.code.toUpperCase())}</span>
      <span class="lang-name">${esc(l.label)}</span>
    </button>`).join("");
  return (
    group(
      row(t("settings.coverStatsTitle"), t("settings.coverStatsDesc"), toggle("toggle-cover-stats", S.showCoverStats)),
      t("settings.secAppearance"),
    ) +
    `<h3 class="section-title">${t("settings.language")}</h3><p class="page-sub settings-lang-desc">${t("settings.languageDesc")}</p><div class="lang-selection-group">${languages}</div>`
  );
}

function renderScreenshots(): string {
  const hotkey = row(
    t("settings.hotkeyLabel"),
    `${t("settings.activeKey")}: <strong>${esc(S.screenshotHotkeyName)}</strong>`,
    `<select id="ss-hotkey-select" class="settings-select" data-act="change-ss-hotkey">
      ${S.PRESET_HOTKEYS.map((k) => `<option value="${k.code}" ${k.code === S.screenshotHotkey ? "selected" : ""}>${k.name}${k.code === 0x7b ? ` (${t("settings.defaultKey")})` : ""}</option>`).join("")}
      ${!S.PRESET_HOTKEYS.some((k) => k.code === S.screenshotHotkey) ? `<option value="${S.screenshotHotkey}" selected>${t("settings.customKey")}: ${esc(S.screenshotHotkeyName)} (${S.screenshotHotkey})</option>` : ""}
    </select>
    <button type="button" class="btn ghost small ${S.isRecordingScreenshotHotkey ? "active" : ""}" data-act="record-screenshot-hotkey">${S.isRecordingScreenshotHotkey ? t("settings.pressKey") : t("settings.assignKey")}</button>`,
  );

  const compression = row(
    t("settings.compressionLabel"),
    S.screenshotCompressionEnabled ? t("settings.compressionDesc") : t("settings.compressionOffDesc"),
    toggle("toggle-screenshot-compression", S.screenshotCompressionEnabled),
  );

  const formats: [string, string][] = [["avif", t("settings.avifBest")], ["webp", t("settings.webpBalanced")], ["jpg", t("settings.jpegUniversal")]];
  const options = S.screenshotCompressionEnabled
    ? row(t("settings.format"), t("settings.avifInfo"), `<div class="seg">${formats.map(([f, label]) => `<button type="button" class="${S.screenshotCompressionFormat === f ? "active" : ""}" data-act="set-ss-format" data-format="${f}">${label}</button>`).join("")}</div>`) +
      row(t("settings.quality"), null, `<input type="range" min="0.70" max="0.95" step="0.05" value="${S.screenshotCompressionQuality}" data-act="set-ss-quality" id="ss-quality-slider" class="settings-range" /><span id="ss-quality-val" class="settings-range-val">%${Math.round(S.screenshotCompressionQuality * 100)}</span>`)
    : "";

  return group(hotkey + compression + options, t("settings.screenshotsTitle"));
}

function renderSystem(): string {
  const blocked = appUpdateInstallBlocked();
  const statusText =
    S.appUpdateStatus === "checking" ? t("appUpdate.checking")
    : S.appUpdateStatus === "available" ? t("appUpdate.availableShort", { version: S.appUpdateVersion })
    : S.appUpdateStatus === "downloading" ? t("appUpdate.downloading", { p: S.appUpdateProgress })
    : S.appUpdateStatus === "ready" ? t("appUpdate.readyShort", { version: S.appUpdateVersion })
    : S.appUpdateStatus === "error" ? t("appUpdate.errorShort")
    : t("appUpdate.upToDateShort");

  const updateControl =
    S.appUpdateStatus === "ready"
      ? `<button type="button" class="btn primary small" data-act="app-update-install" ${blocked ? "disabled" : ""}>${t("appUpdate.installNow")}</button>`
      : S.appUpdateStatus === "downloading"
      ? `<span class="settings-value tabular-nums" id="app-update-pct">${S.appUpdateProgress}%</span>`
      : S.appUpdateStatus === "available" && !S.appAutoUpdate
      ? `<button type="button" class="btn primary small" data-act="app-update-download">${t("appUpdate.downloadNow")}</button>`
      : `<button type="button" class="btn ghost small" data-act="app-update-check" ${S.appUpdateStatus === "checking" ? "disabled" : ""}>${t("appUpdate.checkBtn")}</button>`;

  const updateDesc = [t("appUpdate.desc"), `<span class="app-update-status">${statusText}</span>`, S.appUpdateStatus === "ready" && blocked ? t("appUpdate.blockedHint") : ""]
    .filter(Boolean)
    .join(" ");
  const progress = S.appUpdateStatus === "downloading" || S.appUpdateStatus === "ready"
    ? `<div class="row"><div class="progress app-update-progress"><span class="app-update-progress-bar" id="app-update-bar" style="width:${S.appUpdateProgress}%"></span></div></div>`
    : "";

  const autoUpdateControl = `<input id="auto-update-time" class="input settings-field-sm" value="${esc(S.autoUpdateTime)}" maxlength="5" placeholder="03:00" spellcheck="false" autocomplete="off" />${toggle("toggle-auto-update", S.autoUpdateEnabled)}`;

  return (
    group(
      row(`${t("appUpdate.current")} <code>v${esc(S.appVersion)}</code>`, updateDesc, updateControl) + progress +
      row(t("appUpdate.auto"), t("appUpdate.autoDesc"), toggle("toggle-app-auto-update", S.appAutoUpdate)),
      t("appUpdate.title"),
    ) +
    group(
      row(t("settings.minimizeToTray"), t("settings.minimizeToTrayDesc"), toggle("toggle-minimize-tray", S.minimizeToTray)) +
      row(t("settings.autoBackup"), t("settings.autoBackupDesc"), toggle("toggle-auto-backup", S.autoBackupOnExit)) +
      row(t("settings.autoUpdate"), t("settings.autoUpdateDesc"), autoUpdateControl),
      t("settings.secSystem"),
    ) +
    group(
      row(t("settings.backend"), null, `<span class="settings-value">${isTauri ? t("settings.backendRust") : t("settings.backendBrowser")}</span>`) +
      row(t("settings.libraryFolder"), `<code>${esc(S.libraryPath)}</code>`, ""),
      t("settings.systemTitle"),
    )
  );
}

function renderAbout(): string {
  const link = (url: string, label: string, text: string): string =>
    row(label, esc(text), `<button type="button" class="btn ghost small" data-act="open-external-url" data-url="${url}">${icon("external", 13)}</button>`);
  return `
    <div class="card settings-about">
      <img class="settings-about-logo" src="${launcherIcon}" alt="" />
      <div class="settings-about-copy">
        <div class="settings-identity-name">Efxlve Launcher <span class="settings-value">v${esc(S.appVersion)}</span></div>
        <div class="settings-row-desc">${t("settings.aboutTagline")}</div>
      </div>
    </div>
    ${group(
      link("mailto:hi@efxlve.com", t("settings.aboutEmail"), "hi@efxlve.com") +
      link("https://x.com/efxlve", t("settings.aboutTwitter"), "x.com/efxlve") +
      link("https://github.com/efxlve/efxlve_launcher", t("settings.aboutGithub"), "github.com/efxlve/efxlve_launcher") +
      link("https://efxlve.com/efxlve_launcher", t("settings.aboutWebsite"), "efxlve.com/efxlve_launcher"),
      t("settings.aboutLinksTitle"),
    )}
    <h3 class="section-title">${t("settings.aboutDisclaimerTitle")}</h3>
    <p class="settings-about-text">${t("settings.aboutDisclaimer")}</p>
    <p class="settings-about-text">${t("settings.aboutOpenSource")}</p>`;
}

function renderHidden(): string {
  const ids = [...S.hiddenGames];
  if (ids.length === 0) {
    return emptyState("ghost", t("settings.hiddenEmpty"), t("settings.hiddenEmptyDesc"));
  }
  const rows = ids
    .map((id) => ({ id, title: S.epicSummariesMap.get(id)?.title || id }))
    .sort((a, b) => a.title.localeCompare(b.title, S.appLanguage))
    .map((g) => row(esc(g.title), null, `<button class="btn ghost small" data-act="unhide-game" data-id="${esc(g.id)}">${t("settings.hiddenShow")}</button>`))
    .join("");
  return group(rows, t("settings.secHidden"));
}

function renderSection(section: SettingsSection): string {
  switch (section) {
    case "account": return renderAccountSettings();
    case "integrations": return renderIntegrations();
    case "appearance": return renderAppearance();
    case "screenshots": return renderScreenshots();
    case "system": return renderSystem();
    case "hidden": return renderHidden();
    case "about": return renderAbout();
    default: return renderDownloads();
  }
}

export function renderSettings(): string {
  const active = SECTIONS.find((s) => s.id === S.settingsSection) ?? SECTIONS[0];
  const nav = SECTIONS.map((s) => `
    <button class="settings-nav-item ${s.id === active.id ? "active" : ""}" data-act="settings-section" data-section="${s.id}">${t(s.labelKey)}</button>`).join("");
  return `
    <div class="page settings-page">
      <div class="settings-layout">
        <nav class="settings-nav">${nav}</nav>
        <div class="settings-panel">${renderSection(active.id)}</div>
      </div>
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
        loadSavedAccounts().catch(() => []),
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

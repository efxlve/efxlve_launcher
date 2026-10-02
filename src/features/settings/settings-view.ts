/**
 * Settings page renderer.
 *
 * Two-pane layout: a plain text sub-navigation (left) selects one focused
 * panel (right) built from the shared list-row component. It only reads shared
 * state (S); every action is routed through the global data-act delegation.
 */

import launcherIcon from "../../../src-tauri/icons/128x128@2x.png";
import { LIB_PAGE_SIZES, isSteamDeckDevice, isTauri } from "../../core/constants";
import { emptyState, icon } from "../../core/icons";
import { render } from "../../core/render";
import { rawOf, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import type { SettingsSection } from "../../core/types";
import { cdnShortLabel, esc, fmtBytes } from "../../core/utils";
import { toast } from "../../core/toast";
import { LANGUAGES, localizeMessage, t } from "../../i18n";
import { renderAccountSettings } from "../accounts/accounts-view";
import { loadSavedAccounts } from "../auth/account-switcher";
import { appUpdateInstallBlocked } from "../updates/update-manager";
import { renderEosSettingsRow, syncEosNotice } from "../eos/eos-install";
import {
  controllerSupportStatus,
  eosOverlayStatus,
  epicDefaultInstallDir,
  epicDetectEglGames,
  epicGetScreenshotDir,
  epicGetScreenshotMoveInfo,
  epicGetSettings,
  epicGetSteamGridKey,
  epicOpenScreenshotDir,
  epicPortrait,
  epicSelectFolderDialog,
  epicSetScreenshotDir,
  type EglDetectedGame,
  type ScreenshotMoveInfo,
} from "../../epic";
import { gogDefaultInstallDir, gogGetInstallDir } from "../../gog";
import { closeScreenshotMoveConfirm, openScreenshotMoveConfirm, takePendingScreenshotMove } from "../screenshots/screenshots-view";
import { renderCloudBackupSettingsGroup } from "../cloud-backup/cloud-backup-view";
import { companionGetClientSettings } from "../../companion";
import { controllerKind } from "../gamepad/gamepad";
import { steamGetApiKey, steamStatus } from "../../steam";
import type { ControllerKind } from "../../core/types";
import { gogDetectGalaxyGames, type GalaxyDetectedGame } from "../../gog";

const SECTIONS: { id: SettingsSection; labelKey: string }[] = [
  { id: "account", labelKey: "settings.secAccount" },
  { id: "downloads", labelKey: "settings.secDownloads" },
  { id: "cloud", labelKey: "settings.secCloud" },
  { id: "integrations", labelKey: "settings.secIntegrations" },
  { id: "collections", labelKey: "settings.secCollections" },
  { id: "controller", labelKey: "settings.secController" },
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

/** One-line explanation box (shared component, see DESIGN_SYSTEM.md). */
function infoBox(key: string): string {
  return `<div class="info-box">${icon("info", 14)}<span>${t(key)}</span></div>`;
}

/**
 * Collapsible settings row for keys that are set once: the summary shows the
 * title, an optional hint and the current status, the body holds the fields.
 */
function detailsRow(title: string, desc: string, chip: string, control: string, hint = ""): string {
  return `
    <details class="settings-details">
      <summary>
        <span class="settings-details-main">
          <span class="settings-row-title">${title}</span>
          ${hint ? `<span class="settings-row-desc">${hint}</span>` : ""}
        </span>
        ${chip}
      </summary>
      <div class="settings-details-body">
        <div class="settings-row-desc">${desc}</div>
        <div class="settings-row-control">${control}</div>
      </div>
    </details>`;
}

function renderDownloads(): string {
  const savedDir = S.epicSettingsCache?.install_dir?.trim() || "";
  const shownDir = savedDir || S.epicDefaultDir || "—";
  const dir = row(
    t("settings.epicInstallDirTitle"),
    `${t("settings.epicInstallDirHint")} <code>${esc(shownDir)}</code>`,
    `<input id="epic-install-dir" class="input settings-path-input" value="${esc(savedDir)}" placeholder="${esc(S.epicDefaultDir || t("downloads.defaultPlaceholder"))}" autocomplete="off" spellcheck="false" />
     <button type="button" class="btn ghost small" data-act="dl-pick-install-dir">${t("common.browse")}</button>
     <button type="button" class="btn primary small" data-act="epic-save-install-dir">${t("common.save")}</button>`,
  );

  const gogSavedDir = S.gogInstallDir.trim();
  const gogShownDir = gogSavedDir || S.gogDefaultDir || "—";
  const gogDir = row(
    t("settings.gogInstallDirTitle"),
    `${t("settings.gogInstallDirHint")} <code>${esc(gogShownDir)}</code>`,
    `<input id="gog-install-dir" class="input settings-path-input" value="${esc(gogSavedDir)}" placeholder="${esc(S.gogDefaultDir || t("downloads.defaultPlaceholder"))}" autocomplete="off" spellcheck="false" />
     <button type="button" class="btn ghost small" data-act="dl-pick-gog-install-dir">${t("common.browse")}</button>
     <button type="button" class="btn primary small" data-act="gog-save-install-dir">${t("common.save")}</button>`,
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

  const updates = group(
    row(t("settings.autoUpdate"), t("settings.autoUpdateDesc"), toggle("toggle-auto-update", S.autoUpdateEnabled)) +
    row(
      t("settings.autoUpdateTime"),
      t("settings.autoUpdateTimeDesc"),
      `<input id="auto-update-time" class="input settings-time-input" value="${esc(S.autoUpdateTime)}" maxlength="5" placeholder="03:00" spellcheck="false" autocomplete="off" ${S.autoUpdateEnabled ? "" : "disabled"} aria-label="${esc(t("settings.autoUpdateTime"))}" />`,
    ),
    t("settings.updatesTitle"),
  );

  return (
    infoBox("downloads.scopeInfo") +
    group(dir + gogDir + row(
      t("settings.importInstalled"),
      t("settings.importInstalledDesc"),
      `<button type="button" class="btn ghost small" data-act="import-installed-folder">${t("settings.importInstalledBtn")}</button>`,
    ) + profile + cdn, t("settings.secDownloads")) +
    updates +
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

/** Cloud saves page: its own top-level section instead of an Integrations block. */
function renderCloud(): string {
  return infoBox("cloud.pageInfo") + renderCloudBackupSettingsGroup();
}

/**
 * Collections page: import from each client, then review, edit, merge or
 * delete the result. Imports union members by name; the merge action does the
 * same for differently named collections.
 */
function renderCollections(): string {
  const imports = group(
    row(t("col.importEpic"), t("col.importEpicDesc"), `<button type="button" class="btn ghost small" data-act="import-egl-collections">${t("col.importBtn")}</button>`) +
    row(t("col.importGalaxy"), t("col.importGalaxyDesc"), `<button type="button" class="btn ghost small" data-act="gog-import-galaxy-tags">${t("col.importBtn")}</button>`) +
    row(t("col.importSteam"), t("col.importSteamDesc"), `<button type="button" class="btn ghost small" data-act="steam-import-collections">${t("col.importBtn")}</button>`),
    t("col.importTitle"),
  );

  const rows = S.epicCollections.length === 0
    ? row(t("col.noCollectionsLong"), null, "")
    : S.epicCollections.map((c) => {
        const merging = S.colMergeSource === c.id;
        const deleting = S.colDeleteConfirm === c.id;
        const targets = S.epicCollections.filter((other) => other.id !== c.id);
        const mergePanel = merging
          ? `<div class="col-merge-panel">
               <span class="settings-row-desc">${t("col.mergeInto")}</span>
               ${targets.map((other) => `<button type="button" class="btn ghost small" data-act="col-merge-into" data-id="${esc(other.id)}" data-source="${esc(c.id)}">${esc(other.name)} <span class="tabular-nums">${other.app_names.length}</span></button>`).join("")}
               <button type="button" class="btn ghost danger small" data-act="col-merge-cancel">${t("common.cancelShort")}</button>
             </div>`
          : "";
        const deletePanel = deleting
          ? `<div class="col-merge-panel">
               <span class="settings-row-desc"><strong>${t("col.deleteAsk", { name: esc(c.name) })}</strong> ${t("col.deleteHint")}</span>
               <button type="button" class="btn danger small" data-act="col-settings-delete-confirm" data-id="${esc(c.id)}">${t("common.delete")}</button>
               <button type="button" class="btn ghost danger small" data-act="col-settings-delete-cancel">${t("common.cancelShort")}</button>
             </div>`
          : "";
        return `
          <div class="row settings-row">
            <div class="row-main">
              <div class="settings-row-title">${esc(c.name)}</div>
              <div class="settings-row-desc">${t("col.gameCount", { count: c.app_names.length })}</div>
            </div>
            <div class="settings-row-control">
              <button type="button" class="btn ghost small" data-act="edit-collection" data-col-id="${esc(c.id)}">${t("col.edit")}</button>
              <button type="button" class="btn ghost small" data-act="col-merge-ask" data-id="${esc(c.id)}" ${targets.length === 0 ? "disabled" : ""}>${t("col.merge")}</button>
              <button type="button" class="btn ghost danger small" data-act="col-settings-delete-ask" data-id="${esc(c.id)}">${t("common.delete")}</button>
            </div>
          </div>
          ${mergePanel}${deletePanel}`;
      }).join("");

  return (
    infoBox("col.settingsInfo") +
    imports +
    `<div class="settings-section-head">
       <h3 class="section-title">${t("col.allCollections")}</h3>
       <button type="button" class="btn ghost small" data-act="open-new-collection-modal">${t("col.newCollectionBtn")}</button>
     </div>
     <div class="list settings-group">${rows}</div>`
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
    eglRows;

  // GOG Galaxy parity: games installed by the official client are detected from
  // its registry entries and can be imported with full launcher support.
  const galaxy = S.gogGalaxyDetected;
  const galaxyAction = galaxy.length > 0
    ? `<button class="btn primary small" data-act="gog-galaxy-import" ${S.gogGalaxySyncing ? "disabled" : ""}>${S.gogGalaxySyncing ? t("settings.eglSyncing") : t("settings.gogGalaxyImport")}</button>`
    : `<button class="btn ghost small" data-act="gog-galaxy-scan">${t("settings.rescan")}</button>`;
  const galaxyRows = galaxy.map((g: GalaxyDetectedGame) => `
    <div class="row">
      <div class="row-main"><div class="row-title">${esc(g.title)}</div><div class="row-meta" title="${esc(g.installPath)}">${esc(g.installPath)}</div></div>
      ${g.version ? `<span class="row-meta">v${esc(g.version)}</span>` : ""}
    </div>`).join("");
  const galaxyGroup =
    row(
      galaxy.length > 0 ? t("settings.gogGalaxyFound", { count: galaxy.length }) : t("settings.gogGalaxyNone"),
      t("settings.gogGalaxyDesc"),
      galaxyAction,
    ) + galaxyRows;

  const sgdb = detailsRow(
    t("settings.sgdbTitle"),
    t("settings.sgdbDesc"),
    `<span class="chip ${S.steamGridApiKey ? "ok" : ""}">${S.steamGridApiKey ? t("settings.connected") : t("settings.keyMissing")}</span>`,
    `<input id="settings-sgdb-key-input" type="${S.showSettingsSgdbKey ? "text" : "password"}" class="input settings-path-input" placeholder="${t("settings.sgdbPlaceholder")}" value="${esc(S.steamGridApiKey || "")}" spellcheck="false" autocomplete="off" />
     <button class="icon-btn" data-act="toggle-sgdb-key-visibility" title="${t("settings.showHide")}">${icon(S.showSettingsSgdbKey ? "eye-off" : "eye", 15)}</button>
     <button class="btn primary small" data-act="save-sgdb-key">${t("common.save")}</button>
     <button class="btn ghost small" data-act="test-sgdb-key">${t("settings.test")}</button>
     <button class="btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api">${t("settings.getFreeKey")}</button>`,
  );

  const eos = renderEosSettingsRow();

  const presence = row(t("settings.presenceTitle"), t("settings.presenceDesc"), toggle("toggle-presence", S.presenceEnabled));

  // Opt-in per client: quit it once the game it launched closes. Steam keeps
  // its own localStorage toggle; the companion clients read the Rust settings.
  const exitToggle = (store: string) =>
    `<label class="switch"><input type="checkbox" data-act="toggle-client-exit" data-store="${store}" ${S.companionCloseAfterPlay[store] ? "checked" : ""} /><span class="track"></span></label>`;
  const afterPlaying = group(
    row(t("settings.steamExitAfterPlay"), t("settings.steamExitAfterPlayDesc"), toggle("toggle-steam-exit-after-play", S.steamExitAfterPlay)) +
    row(t("settings.eaExitAfterPlay"), t("settings.clientExitAfterPlayDesc"), exitToggle("ea")) +
    row(t("settings.ubiExitAfterPlay"), t("settings.clientExitAfterPlayDesc"), exitToggle("ubisoft")) +
    row(t("settings.bnetExitAfterPlay"), t("settings.clientExitAfterPlayDesc"), exitToggle("battlenet")) +
    row(t("settings.riotExitAfterPlay"), t("settings.clientExitAfterPlayDesc"), exitToggle("riot")),
    t("settings.afterPlayingTitle"),
  );

  return (
    infoBox("settings.integrationsInfo") +
    group(eglGroup, t("settings.eglTitle")) +
    group(eos, t("settings.eosGroupTitle")) +
    group(galaxyGroup, t("settings.gogGalaxyTitle")) +
    renderSteamGroup() +
    afterPlaying +
    group(sgdb, t("settings.coverArtTitle")) +
    group(presence, t("settings.secSocial"))
  );
}

/** Localized controller family names (kept literal so the key audit sees them). */
const CONTROLLER_KIND_KEYS: Record<ControllerKind, string> = {
  playstation: "controller.kindPlaystation",
  xbox: "controller.kindXbox",
  switch: "controller.kindSwitch",
  steamdeck: "controller.kindSteamDeck",
  generic: "controller.kindGeneric",
};

/**
 * Controller section: what is plugged in right now, plus the XInput bridge
 * status. Windows shows PlayStation pads as DirectInput devices, so games that
 * only read XInput (Dead by Daylight and friends) need ViGEmBus/DS4Windows or
 * Steam Input; we detect both and point at the official downloads.
 */
function renderController(): string {
  const pads = (navigator.getGamepads ? navigator.getGamepads() : []).filter(
    (g): g is Gamepad => g !== null && g.connected,
  );
  const padRows = pads.length > 0
    ? pads.map((g) => {
        const name = g.id.split("(")[0].trim();
        return row(
          esc(name),
          t(CONTROLLER_KIND_KEYS[controllerKind(g.id)]),
          `<span class="chip ok">${t("controller.connected")}</span>`,
        );
      }).join("")
    : row(
        t("controller.none"),
        t("controller.noneDesc"),
        `<button class="btn ghost small" data-act="controller-refresh">${t("controller.refresh")}</button>`,
      );

  const status = S.controllerBridge;
  const bridgeChip = status === null
    ? `<span class="chip">${t("controller.checking")}</span>`
    : status.viEmBus
      ? `<span class="chip ok">${t("controller.bridgeFound")}</span>`
      : `<span class="chip warn">${t("controller.bridgeMissing")}</span>`;
  const steamNote = status?.steam ? `<br />${t("controller.steamNote")}` : "";
  const deckNote = isSteamDeckDevice() || pads.some((g) => controllerKind(g.id) === "steamdeck")
    ? `<p class="page-sub">${t("controller.deckNote")}</p>`
    : "";
  const tv = row(
    t("tv.open"),
    t("controller.tvModeDesc"),
    `<button class="btn primary small" data-act="open-tv-mode">${icon("gamepad-2", 14)} ${t("tv.open")}</button>`,
  ) + row(
    t("controller.tvAutoTitle"),
    t("controller.tvAutoDesc"),
    toggle("toggle-tv-auto", S.tvAutoEnter),
  );
  const bridge = row(
    t("controller.bridgeTitle"),
    `${t("controller.bridgeDesc")}${steamNote}`,
    `${bridgeChip}
     <button class="btn ghost small" data-act="open-external-url" data-url="https://github.com/nefarius/ViGEmBus/releases">${t("controller.downloadVigem")}</button>
     <button class="btn ghost small" data-act="open-external-url" data-url="https://github.com/Ryochan7/DS4Windows/releases">${t("controller.downloadDs4")}</button>
     <button class="btn ghost small" data-act="controller-refresh">${t("controller.refresh")}</button>`,
    true,
  );

  return group(padRows, t("controller.padsTitle")) + group(tv, t("tv.open")) + deckNote + group(bridge, t("settings.secController"));
}

/** Steam card: the optional Web API key. Behavior toggles live in After playing. */
function renderSteamGroup(): string {
  const status = S.steamStatus;
  if (!status) return "";
  const rescan = `<button class="btn ghost small" data-act="steam-refresh">${t("settings.rescan")}</button>`;
  if (!status.installed) {
    return group(row(t("steam.notFound"), t("steam.desc"), rescan), "Steam");
  }
  const apiKey = detailsRow(
    t("settings.steamApiTitle"),
    t("settings.steamApiDesc"),
    `<span class="chip ${S.steamApiKey ? "ok" : ""}">${S.steamApiKey ? t("settings.connected") : t("settings.keyMissing")}</span>`,
    `<input id="settings-steam-key-input" type="password" class="input settings-path-input" placeholder="${t("settings.steamApiPlaceholder")}" value="${esc(S.steamApiKey || "")}" spellcheck="false" autocomplete="off" />
     <button class="btn primary small" data-act="save-steam-key">${t("common.save")}</button>
     <button class="btn ghost small" data-act="open-external-url" data-url="https://steamcommunity.com/dev/apikey">${t("settings.getFreeKey")}</button>`,
    t("settings.steamApiHint"),
  );
  return group(apiKey, "Steam");
}

/** Page-size picker shared by Settings and the library pagination bar. */
function pageSizeSelect(): string {
  return `<select class="settings-select" data-act="lib-page-size" aria-label="${t("settings.libPageSizeTitle")}">
    ${LIB_PAGE_SIZES.map((n) => `<option value="${n}" ${n === S.libPageSize ? "selected" : ""}>${n}</option>`).join("")}
  </select>`;
}

function renderAppearance(): string {
  const languages = LANGUAGES.map((l) => `
    <button class="lang-option-btn ${S.appLanguage === l.code ? "active" : ""}" data-act="set-app-language" data-lang="${esc(l.code)}">
      <span class="lang-flag">${esc(l.code.toUpperCase())}</span>
      <span class="lang-name">${esc(l.label)}</span>
    </button>`).join("");
  return (
    group(
      row(t("settings.surfaceTitle"), t("settings.surfaceDesc"), `<div class="seg">
        <button type="button" class="${S.surface === "black" ? "active" : ""}" data-act="set-surface" data-surface="black">${t("settings.surfaceBlack")}</button>
        <button type="button" class="${S.surface === "epic" ? "active" : ""}" data-act="set-surface" data-surface="epic">${t("settings.surfaceEpic")}</button>
      </div>`) +
      row(t("settings.coverStatsTitle"), t("settings.coverStatsDesc"), toggle("toggle-cover-stats", S.showCoverStats)) +
      row(t("settings.coverTitlesTitle"), t("settings.coverTitlesDesc"), toggle("toggle-cover-titles", S.showCoverTitles)) +
      row(t("settings.storeBadgeTitle"), t("settings.storeBadgeDesc"), toggle("toggle-store-badge", S.showStoreBadge)) +
      row(t("settings.installedIconTitle"), t("settings.installedIconDesc"), toggle("toggle-installed-icon", S.showInstalledIcon)) +
      row(t("settings.highlightInstalledTitle"), t("settings.highlightInstalledDesc"), toggle("toggle-highlight-installed", S.highlightInstalled)) +
      row(t("settings.sharedLibraryTitle"), t("settings.sharedLibraryDesc"), toggle("toggle-shared-library", S.showSharedLibrary)) +
      row(t("tv.open"), t("controller.tvModeDesc"), `<button class="btn ghost small" data-act="open-tv-mode">${icon("gamepad-2", 14)} ${t("tv.open")}</button>`) +
      row(t("settings.libPaginationTitle"), t("settings.libPaginationDesc"), toggle("toggle-lib-pagination", S.libPagination)) +
      (S.libPagination ? row(t("settings.libPageSizeTitle"), t("settings.libPageSizeDesc"), pageSizeSelect()) : ""),
    ) +
    `<h3 class="section-title">${t("settings.language")}</h3><p class="page-sub settings-lang-desc">${t("settings.languageDesc")}</p><div class="lang-selection-group">${languages}</div>`
  );
}

function renderScreenshots(): string {
  const folder = row(
    t("settings.ssDirTitle"),
    `${t("settings.ssDirDesc")} <code>${esc(S.screenshotDir || "—")}</code>`,
    `<button type="button" class="btn ghost small" data-act="ss-open-dir">${t("ss.openFolder")}</button>
     <button type="button" class="btn ghost small" data-act="ss-pick-dir">${t("common.browse")}</button>
     <button type="button" class="btn ghost small" data-act="ss-reset-dir">${t("settings.ssDirReset")}</button>`,
    true,
  );

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

  return group(folder + hotkey + compression + options, t("settings.screenshotsTitle"));
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

  return (
    group(
      row(`${t("appUpdate.current")} <code>v${esc(S.appVersion)}</code>`, updateDesc, updateControl) + progress +
      row(t("appUpdate.auto"), t("appUpdate.autoDesc"), toggle("toggle-app-auto-update", S.appAutoUpdate)),
      t("appUpdate.title"),
    ) +
    group(
      row(t("settings.minimizeToTray"), t("settings.minimizeToTrayDesc"), toggle("toggle-minimize-tray", S.minimizeToTray)) +
      row(t("settings.autoBackup"), t("settings.autoBackupDesc"), toggle("toggle-auto-backup", S.autoBackupOnExit)),
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
        <div style="margin-top: 10px;">
          <button type="button" class="btn ghost small" data-act="open-changelog">${icon("clock", 13)} <span>${t("settings.viewChangelog")}</span></button>
        </div>
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
    <p class="settings-about-text">${t("settings.aboutLogos")}</p>
    <p class="settings.about-text">${t("settings.aboutDrmNotice")}</p>
    <p class="settings-about-text">${t("settings.aboutThirdParty")}</p>
    <p class="settings-about-text">${t("settings.aboutPrivacy")}</p>
    <p class="settings-about-text">${t("settings.aboutOpenSource")}</p>`;
}

function hiddenCover(id: string): string {
  const custom = S.customCovers[id];
  if (custom) return custom;
  if (id.startsWith("gog::")) return summaryOf(id)?.cover || "";
  const raw = rawOf(id);
  return (raw ? epicPortrait(raw) : null) || S.epicSummariesMap.get(id)?.cover || "";
}

/** Catalog developer only. Missing metadata stays a blank second line. */
function catalogDeveloper(id: string): string {
  if (id.startsWith("gog::")) {
    const rawId = id.slice(5);
    return S.gogSummariesMap.get(rawId)?.developer || "";
  }
  const value = rawOf(id)?.metadata?.developer;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * One row per app id. Two catalog products can share a title; those stay
 * separate. The second line is the developer, never a platform or id.
 * The row selects. Only Details opens the game page. Show only unhides.
 */
function renderHidden(): string {
  const seen = new Set<string>();
  const games: { id: string; title: string; developer: string }[] = [];
  for (const id of S.hiddenGames) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const raw = rawOf(id);
    const sum = summaryOf(id);
    games.push({
      id,
      title: sum?.title || S.epicSummariesMap.get(id)?.title || raw?.app_title || id,
      developer: catalogDeveloper(id),
    });
  }
  if (games.length === 0) {
    return emptyState("ghost", t("settings.hiddenEmpty"), t("settings.hiddenEmptyDesc"));
  }
  const collator = new Intl.Collator(S.appLanguage || "en", { sensitivity: "base", numeric: true });
  games.sort((a, b) => collator.compare(a.title, b.title) || collator.compare(a.developer, b.developer) || collator.compare(a.id, b.id));
  const rows = games.map((g) => {
    const url = hiddenCover(g.id);
    const thumb = url
      ? `<img class="hide-game-thumb" src="${esc(url)}" alt="" width="32" height="42" loading="lazy" decoding="async" />`
      : `<span class="hide-game-thumb placeholder">${icon("gamepad-2", 14)}</span>`;
    return `
      <div class="row settings-hidden-row" data-hidden-row data-id="${esc(g.id)}">
        <label class="settings-hidden-pick">
          <input type="checkbox" class="selective-checkbox" aria-label="${esc(g.title)}" />
          <span class="settings-hidden-open">
            ${thumb}
            <span class="row-main">
              <span class="row-title">${esc(g.title)}</span>
              <span class="row-meta">${esc(g.developer)}</span>
            </span>
          </span>
        </label>
        <div class="settings-hidden-actions">
          <button type="button" class="btn ghost small" data-act="epic-detail" data-id="${esc(g.id)}">${t("trophy.detail")}</button>
          <button type="button" class="btn ghost small" data-act="unhide-game" data-id="${esc(g.id)}">${t("settings.hiddenShow")}</button>
        </div>
      </div>`;
  }).join("");
  return `
    <div class="settings-section-head settings-hidden-head">
      <h3 class="section-title">${t("settings.secHidden")}</h3>
      <button type="button" class="btn ghost small" id="hidden-show-selected" data-act="unhide-selected" disabled>${t("settings.hiddenShowSelected")}</button>
    </div>
    <div class="list settings-group settings-hidden-list">${rows}</div>`;
}

function renderSection(section: SettingsSection): string {
  switch (section) {
    case "account": return renderAccountSettings();
    case "cloud": return renderCloud();
    case "integrations": return renderIntegrations();
    case "collections": return renderCollections();
    case "controller": return renderController();
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
      const [st, dir, sgdbKey, , ssDir, steamKey, gogDir, gogDefault] = await Promise.all([
        epicGetSettings(),
        epicDefaultInstallDir(),
        epicGetSteamGridKey().catch(() => null),
        loadSavedAccounts().catch(() => []),
        epicGetScreenshotDir().catch(() => ""),
        steamGetApiKey().catch(() => null),
        gogGetInstallDir().catch(() => null),
        gogDefaultInstallDir().catch(() => ""),
      ]);
      S.epicSettingsCache = st;
      S.epicDefaultDir = dir;
      S.steamGridApiKey = sgdbKey;
      S.screenshotDir = ssDir || "";
      S.steamApiKey = steamKey;
      S.gogInstallDir = gogDir || "";
      S.gogDefaultDir = gogDefault || "";
    } catch {
      // Silent: keep the last cached values.
    }
  }
  render();
  // Re-add the EOS notice if it was cleared. Uses the status already in memory.
  syncEosNotice();
  if (S.settingsSection === "integrations") void loadIntegrationsView();
  if (S.settingsSection === "controller") void loadControllerView();
}

/**
 * Refreshes the controller section: connected pads are read synchronously and
 * the XInput bridge probe is one cheap registry query.
 */
export async function loadControllerView(force = false): Promise<void> {
  if (!isTauri) {
    render();
    return;
  }
  if (S.controllerBridge && !force) {
    render();
    return;
  }
  try {
    S.controllerBridge = await controllerSupportStatus();
  } catch {
    S.controllerBridge = { viEmBus: false, steam: false, steamPath: "" };
  }
  render();
}

/**
 * Loads the slow integration data (EGL scan, GOG Galaxy, Steam, EOS).
 * Runs only when the Integrations section is shown and is cached afterwards.
 */
export async function loadIntegrationsView(force = false): Promise<void> {
  if (!isTauri || S.settingsIntegrationsLoading) return;
  if (S.settingsIntegrationsLoaded && !force) {
    syncEosNotice();
    return;
  }
  S.settingsIntegrationsLoading = true;
  render();
  try {
    const [eglList, eos, galaxyList, steamState, clientSettings] = await Promise.all([
      epicDetectEglGames().catch(() => [] as EglDetectedGame[]),
      eosOverlayStatus().catch(() => null),
      gogDetectGalaxyGames().catch(() => [] as GalaxyDetectedGame[]),
      steamStatus().catch(() => null),
      companionGetClientSettings().catch(() => null),
    ]);
    S.eglDetectedList = eglList;
    S.eosOverlay = eos;
    S.gogGalaxyDetected = galaxyList;
    S.steamStatus = steamState;
    S.companionCloseAfterPlay = clientSettings?.closeAfterPlay ?? {};
    syncEosNotice();
    S.settingsIntegrationsLoaded = true;
  } catch {
    // Silent: keep the last cached values.
  } finally {
    S.settingsIntegrationsLoading = false;
    render();
  }
}

/** Applies a new screenshots root and reports how many files were moved. */
async function applyScreenshotDir(target: string | null, moveExisting: boolean): Promise<void> {
  try {
    const res = await epicSetScreenshotDir(target, moveExisting);
    S.screenshotDir = res.dir;
    if (res.moved > 0 && res.skipped > 0) toast(t("ss.movedPartial", { count: res.moved, skipped: res.skipped }), "ok");
    else if (res.moved > 0) toast(t("ss.moved", { count: res.moved }), "ok");
    else toast(target ? t("ss.dirSaved") : t("ss.dirReset"), "ok");
    render();
  } catch (e) {
    toast(localizeMessage(String(e)), "err");
  }
}

/** Current screenshots stats; empty stats when the backend cannot answer. */
async function screenshotMoveInfo(): Promise<ScreenshotMoveInfo> {
  try {
    return await epicGetScreenshotMoveInfo();
  } catch {
    return { count: 0, bytes: 0, dir: "" };
  }
}

/** Opens the folder picker; when files exist, asks whether to move them. */
async function pickScreenshotsFolder(): Promise<void> {
  const chosen = await epicSelectFolderDialog(S.screenshotDir || null, t("settings.ssDirPicker")).catch(() => null);
  if (!chosen || chosen.toLowerCase() === S.screenshotDir.toLowerCase()) return;
  const info = await screenshotMoveInfo();
  if (info.count > 0) {
    openScreenshotMoveConfirm(chosen, info.count, info.bytes);
    return;
  }
  await applyScreenshotDir(chosen, false);
}

/** Opens the effective screenshots root in Explorer (created when missing). */
async function openScreenshotsFolder(): Promise<void> {
  try {
    await epicOpenScreenshotDir();
  } catch (e) {
    toast(localizeMessage(String(e)), "err");
  }
}

/** Restores the default folder; existing files follow only with confirmation. */
async function resetScreenshotsFolder(): Promise<void> {
  const info = await screenshotMoveInfo();
  if (info.count > 0) {
    openScreenshotMoveConfirm(null, info.count, info.bytes);
    return;
  }
  await applyScreenshotDir(null, false);
}

/**
 * Screenshot-folder actions routed here from click-router so the shared router
 * does not grow. Returns true when the action was handled.
 */
export function handleSettingsAction(act: string | undefined, _el: HTMLElement): boolean {
  switch (act) {
    case "ss-open-dir":
      void openScreenshotsFolder();
      return true;
    case "ss-pick-dir":
      void pickScreenshotsFolder();
      return true;
    case "ss-reset-dir":
      void resetScreenshotsFolder();
      return true;
    case "ss-move-confirm": {
      const pending = takePendingScreenshotMove();
      if (pending) void applyScreenshotDir(pending.targetDir, true);
      return true;
    }
    case "ss-move-keep": {
      const pending = takePendingScreenshotMove();
      if (pending) void applyScreenshotDir(pending.targetDir, false);
      return true;
    }
    case "ss-move-cancel":
    case "ss-move-backdrop":
      closeScreenshotMoveConfirm();
      return true;
    default:
      return false;
  }
}

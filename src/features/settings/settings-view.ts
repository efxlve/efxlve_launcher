/**
 * Settings page renderer.
 *
 * Two-pane layout: a plain text sub-navigation (left) selects one focused
 * panel (right) built from the shared list-row component. It only reads shared
 * state (S); every action is routed through the global data-act delegation.
 */

import launcherIcon from "../../../src-tauri/icons/128x128@2x.png";
import { invoke } from "@tauri-apps/api/core";
import { DISCORD_INVITE_URL, LIB_PAGE_SIZES, SS_DENSITY_KEY, SS_NOTIFY_KEY, SS_SORT_KEY, SS_SOUND_KEY, isSteamDeckDevice, isTauri } from "../../core/constants";
import { measuredSize } from "../../core/folder-size";
import { imageCacheSize } from "../../core/picture-cache";
import { emptyState, icon } from "../../core/icons";
import { discordPageVisible, miniPlayerVisible, notesSidebarVisible, overlayBlockedGames, screenshotsSidebarVisible, spotifyPageVisible } from "../../core/page-visibility";
import { appGetAutostart } from "../../core/window";
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
  launchersStatus,
  eosOverlayStatus,
  epicDefaultInstallDir,
  epicDetectEglGames,
  epicGetScreenshotDir,
  epicGetScreenshotScanAll,
  epicGetScreenshotScanRoots,
  epicSetScreenshotScanAll,
  epicGetScreenshotMoveInfo,
  epicGetSettings,
  epicGetSteamGridKey,
  epicOpenFolderPath,
  clipFolderPath,
  clipSetOptions,
  epicOpenScreenshotDir,
  epicPortrait,
  epicSelectFolderDialog,
  epicSetScreenshotDir,
  epicSetScreenshotDisabledGames,
  epicGetAllScreenshots,
  epicDeleteGameScreenshot,
  type EglDetectedGame,
  type GameScreenshotItem,
  type ScreenshotMoveInfo,
} from "../../epic";
import { eglLauncherPresent } from "../../egl-removal";
import { gogDefaultInstallDir, gogGetInstallDir } from "../../gog";
import { amazonDefaultInstallDir, amazonGetInstallDir } from "../../nile";
import { closeScreenshotMoveConfirm, openScreenshotMoveConfirm, takePendingScreenshotMove } from "../screenshots/screenshots-view";
import { ssClearFavorites, ssCleanupPolicy, ssDensity, ssFavorites, ssNotifyOn, ssSetCleanupPolicy, ssSort, ssSoundOn } from "../screenshots/ss-settings";
import { CLIP_ENABLED_KEY, CLIP_FPS_KEY, CLIP_HEIGHT_KEY, CLIP_HOTKEY_KEY, CLIP_HOTKEY_NAME_KEY, CLIP_MAX_MIN_KEY } from "../../core/constants";
import { CLIP_FPS_SUPPORTED, clipFps as clipFpsSetting, clipHeight as clipHeightSetting, pushClipSettings } from "../screenshots/ss-settings";
import { ssAddWebhook, ssRemoveWebhook, ssWebhooks } from "../screenshots/ss-settings";
import { screenshotWebhookInfo } from "../../epic";
import { cachedNotes, exportNotes, importNotesText, LAUNCHER_SCOPE, loadNotes, notesFontSize, setNotesFontSize } from "../notes/notes-client";
import { renderCloudBackupSettingsGroup } from "../cloud-backup/cloud-backup-view";
import { handleCompatAction, loadCompatView, renderCompatSection } from "./compat-view";
import { keepDiscordOpen } from "../discord/discord-view";
import { handleTaskAction, renderTasks } from "./task-manager";
import { storeLogo } from "../store/store-logos";
import { HEADER_STORES, STORE_LABELS } from "../store/store-view";
import { companionGetClientSettings } from "../../companion";
import { controllerKind } from "../gamepad/gamepad";
import { steamGetApiKey, steamStatus } from "../../steam";
import type { ControllerKind } from "../../core/types";
import { gogDetectGalaxyGames, type GalaxyDetectedGame } from "../../gog";
import { igdbProbeProxy, igdbStatus } from "../../igdb";

const SECTIONS: { id: SettingsSection; labelKey: string }[] = [
  { id: "account", labelKey: "settings.secAccount" },
  { id: "downloads", labelKey: "settings.secDownloads" },
  { id: "cloud", labelKey: "settings.secCloud" },
  { id: "integrations", labelKey: "settings.secIntegrations" },
  { id: "social", labelKey: "settings.secSocial" },
  { id: "launchers", labelKey: "settings.secLaunchers" },
  { id: "compat", labelKey: "settings.secCompat" },
  { id: "collections", labelKey: "settings.secCollections" },
  { id: "controller", labelKey: "settings.secController" },
  { id: "appearance", labelKey: "settings.secAppearance" },
  { id: "screenshots", labelKey: "settings.secScreenshots" },
  { id: "notes", labelKey: "settings.secNotes" },
  { id: "system", labelKey: "settings.secSystem" },
  { id: "tasks", labelKey: "settings.secTasks" },
  { id: "hidden", labelKey: "settings.secHidden" },
  { id: "about", labelKey: "settings.secAbout" },
];

/**
 * The nav in three labelled clusters. A flat list of thirteen items was a place
 * to get lost in, and the search is the other way out of that.
 */
const NAV_GROUPS: { labelKey: string; sections: SettingsSection[] }[] = [
  {
    labelKey: "settings.navAccount",
    sections: ["account", "cloud", "integrations", "social", "launchers"],
  },
  {
    labelKey: "settings.navLibrary",
    sections: ["downloads", "collections", "hidden"],
  },
  {
    labelKey: "settings.navApp",
    sections: ["compat", "controller", "appearance", "screenshots", "notes", "system", "tasks", "about"],
  },
];

/** A single setting line: title/description on the left, a control on the right.
 * The plain text lands in `data-search`, which is what the settings search
 * filters on. */
function row(title: string, desc: string | null, control: string, stacked = false): string {
  const search = `${title} ${desc ?? ""}`.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return `
    <div class="row settings-row${stacked ? " stacked" : ""}" data-search="${esc(search)}">
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

function group(rows: string, title = "", note = ""): string {
  return `${title ? `<h3 class="section-title">${title}</h3>` : ""}${note}<div class="list settings-group">${rows}</div>`;
}

/** One-line explanation box (shared component, see DESIGN_SYSTEM.md). */
function infoBox(key: string): string {
  return `<div class="info-box">${icon("info", 14)}<span>${t(key)}</span></div>`;
}

/**
 * Collapsible settings row for keys that are set once: the summary shows the
 * title, an optional hint and the current status, the body holds the fields.
 * `key` is what remembers whether the row was open, so an async re-render does
 * not close the row under the user's cursor.
 */
function detailsRow(key: string, title: string, desc: string, chip: string, control: string, hint = ""): string {
  const search = `${title} ${desc} ${hint}`.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return `
    <details class="settings-details" data-details-key="${esc(key)}" data-search="${esc(search)}"${openDetails.has(key) ? " open" : ""}>
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

/** Collapsible rows the user opened, by key, so a repaint does not close them. */
const openDetails = new Set<string>();

/** Reads the open rows out of the mounted panel before it is replaced. */
function captureOpenDetails(): void {
  const panel = document.querySelector<HTMLElement>(".settings-panel");
  if (!panel) return;
  openDetails.clear();
  panel.querySelectorAll<HTMLDetailsElement>(".settings-details[data-details-key]").forEach((el) => {
    const key = el.dataset.detailsKey;
    if (key && el.open) openDetails.add(key);
  });
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

  const amazonSavedDir = S.amazonInstallDir.trim();
  const amazonShownDir = amazonSavedDir || S.amazonDefaultDir || "—";
  const amazonDir = row(
    t("settings.amazonInstallDirTitle"),
    `${t("settings.amazonInstallDirHint")} <code>${esc(amazonShownDir)}</code>`,
    `<input id="amazon-install-dir" class="input settings-path-input" value="${esc(amazonSavedDir)}" placeholder="${esc(S.amazonDefaultDir || t("downloads.defaultPlaceholder"))}" autocomplete="off" spellcheck="false" />
     <button type="button" class="btn ghost small" data-act="dl-pick-amazon-install-dir">${t("common.browse")}</button>
     <button type="button" class="btn primary small" data-act="amazon-save-install-dir">${t("common.save")}</button>`,
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
    group(dir + gogDir + amazonDir + row(
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
      row(t("downloads.cacheClear"), t("settings.netCacheDesc"), `<button type="button" class="btn ghost small" data-act="dl-cleanup-cache">${t("downloads.cacheClearBtn")}</button>`) +
      row(t("settings.pictureCache"), t("settings.pictureCacheDesc"), `<span class="settings-value tabular-nums">${S.pictureCacheBytes != null ? fmtBytes(S.pictureCacheBytes) : ""}</span><button type="button" class="btn ghost small" data-act="clear-picture-cache">${t("downloads.cacheClearBtn")}</button>`),
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
       <button type="button" class="btn ghost small" data-act="open-new-collection-modal">${icon("plus", 13)} ${t("col.newCollection")}</button>
     </div>
     <div class="list settings-group">${rows}</div>`
  );
}

/** Hand-back actions per store id (missing entries have no open command). */
const LAUNCHER_OPEN: Record<string, { act: string; withId: boolean }> = {
  steam: { act: "steam-open-client", withId: false },
  xbox: { act: "companion-open", withId: true },
  battlenet: { act: "companion-open", withId: true },
  ubisoft: { act: "companion-open", withId: true },
  ea: { act: "companion-open", withId: true },
  rockstar: { act: "companion-open", withId: true },
  riot: { act: "companion-open", withId: true },
};

/** One info box per category: what the launcher manages, what the clients do. */
function launcherInfoBox(): string {
  return `${infoBox("launchers.infoManaged")}${infoBox("launchers.infoDelegated")}`;
}

/**
 * Launchers page: which store clients are installed, where they live, and
 * where to get the missing ones. The launcher never installs a client itself.
 */
function renderLaunchers(): string {
  if (S.launchers.length === 0) {
    return S.launchersLoading
      ? `<div class="empty-state"><span class="spinner"></span></div>`
      : launcherInfoBox();
  }
  // Amazon Games has no client to detect: Nile is managed by the launcher, so
  // the row explains that instead of offering a download.
  const amazonRow = `
      <div class="row settings-row">
        <span class="acc-store-mark">${storeLogo("amazon", 24)}</span>
        <div class="row-main">
          <div class="settings-row-title">Amazon Games</div>
          <div class="settings-row-desc">${t("launchers.amazonNote")}</div>
        </div>
      </div>`;
  const managed: string[] = [];
  const delegated: string[] = [];
  for (const l of S.launchers) {
    const open = LAUNCHER_OPEN[l.id];
    const chip = l.installed
      ? `<span class="chip ok">${t("launchers.detected")}</span>`
      : `<span class="chip warn">${t("launchers.missing")}</span>`;
    const openBtn = l.installed && open
      ? `<button type="button" class="btn ghost small" data-act="${open.act}"${open.withId ? ` data-id="${l.id}"` : ""}>${t("accounts.openClient")}</button>`
      : "";
    const downloadBtn = l.installed
      ? ""
      : `<button type="button" class="btn ghost small" data-act="open-external-url" data-url="${esc(l.downloadUrl)}">${t("launchers.download")}</button>`;
    // Epic and GOG are fully managed by the launcher; their clients are only
    // needed to import what those clients installed.
    const note = l.id === "epic"
      ? t("launchers.epicNote", { section: t("settings.secIntegrations") })
      : l.id === "gog"
        ? t("launchers.gogNote", { section: t("settings.secIntegrations") })
        : "";
    const rowHtml = `
      <div class="row settings-row">
        <span class="acc-store-mark">${storeLogo(l.id, 24) || icon("layers", 24)}</span>
        <div class="row-main">
          <div class="settings-row-title">${esc(l.name)}</div>
          ${l.path ? `<div class="settings-row-desc"><code>${esc(l.path)}</code></div>` : ""}
          ${note ? `<div class="settings-row-desc">${note}</div>` : ""}
        </div>
        <div class="settings-row-control">${chip}${openBtn}${downloadBtn}</div>
      </div>`;
    // Epic and GOG are managed here; Steam and the companion clients own the play.
    if (l.id === "epic" || l.id === "gog") managed.push(rowHtml);
    else delegated.push(rowHtml);
  }
  // Amazon Games sits with the other managed stores, right after GOG.
  managed.push(amazonRow);
  return (
    group(managed.join(""), t("launchers.managedTitle"), infoBox("launchers.infoManaged")) +
    group(delegated.join(""), t("launchers.delegatedTitle"), infoBox("launchers.infoDelegated"))
  );
}

function renderIntegrations(): string {
  if (S.settingsIntegrationsLoading && !S.settingsIntegrationsLoaded) {
    return `<div class="empty-state"><span class="spinner"></span><p>${t("settings.scanning")}</p></div>`;
  }
  const egl = S.eglDetectedList ?? [];
  const eglAction = egl.length > 0
    ? `<button class="btn primary small" data-act="epic-sync-egl" ${S.eglSyncing ? "disabled" : ""}>${S.eglSyncing ? t("settings.eglSyncing") : t("settings.eglSync")}</button>`
    : `<button class="btn ghost small" data-act="epic-refresh-egl">${t("settings.rescan")}</button>`;
  const eglRows = egl.map((g: EglDetectedGame) => `
    <div class="row">
      <div class="row-main"><div class="row-title">${esc(g.title)}</div><div class="row-meta" title="${esc(g.installPath)}">${esc(g.installPath)}</div></div>
      <span class="row-meta">${fmtBytes(measuredSize(g.appName) ?? g.installSize)}</span>
    </div>`).join("");

  const eglGroup =
    row(egl.length > 0 ? `${egl.length} ${t("settings.eglDetected")}` : t("settings.eglNone"), t("settings.eglDesc"), eglAction) +
    eglRows +
    // Epic's own uninstaller deletes the games together with the launcher; this
    // removes only launcher-owned files and migrates the games into Legendary first.
    // The button is hidden when the launcher is not installed, with a rescan in
    // case the detection missed it.
    (S.eglLauncherPresent
      ? row(t("settings.eglRemoveTitle"), t("settings.eglRemoveDesc"),
          `<button class="btn danger small" data-act="egl-remove-open">${icon("trash", 13)} ${t("settings.eglRemove")}</button>`)
      : row(t("settings.eglRemoveTitle"), t("settings.eglRemoveMissing"),
          `<button class="btn ghost small" data-act="egl-remove-rescan">${t("settings.rescan")}</button>`));

  // GOG Galaxy parity: games installed by the official client are detected from
  // its registry entries and can be imported with full launcher support.
  const galaxy = S.gogGalaxyDetected ?? [];
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
    ) + galaxyRows +
    // Comet stands in for Galaxy's Communication Service while a GOG game
    // plays, so in-game achievements unlock without the official client.
    row(t("settings.cometTitle"), t("settings.cometDesc"), toggle("toggle-gog-comet", S.gogCometEnabled));

  const sgdb = detailsRow(
    "sgdb",    t("settings.sgdbTitle"),
    t("settings.sgdbDesc"),
    `<span class="chip ${S.steamGridApiKey ? "ok" : ""}">${S.steamGridApiKey ? t("settings.connected") : t("settings.keyMissing")}</span>`,
    `<input id="settings-sgdb-key-input" type="${S.showSettingsSgdbKey ? "text" : "password"}" class="input settings-path-input" placeholder="${t("settings.sgdbPlaceholder")}" value="${esc(S.steamGridApiKey || "")}" spellcheck="false" autocomplete="off" />
     <button class="icon-btn" data-act="toggle-sgdb-key-visibility" title="${t("settings.showHide")}">${icon(S.showSettingsSgdbKey ? "eye-off" : "eye", 15)}</button>
     <button class="btn primary small" data-act="save-sgdb-key">${t("common.save")}</button>
     <button class="btn ghost small" data-act="test-sgdb-key">${t("settings.test")}</button>
     <button class="btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api">${t("settings.getFreeKey")}</button>`,
  );

  const eos = renderEosSettingsRow();

  // IGDB (Twitch): the shared proxy is the default, so nobody has to register a
  // Twitch app. Own credentials stay possible — the secret is write-only here,
  // sealed on disk and only ever read back by Rust.
  const igdbProxyDown = S.igdbMode === "proxy" && S.igdbProxyReachable === false;
  const igdbModeLine = igdbProxyDown
    ? t("igdb.proxyMissing")
    : S.igdbMode === "direct"
      ? t("igdb.modeDirect")
      : S.igdbMode === "proxy"
        ? t("igdb.modeProxy")
        : t("igdb.modeOff");
  const igdb = detailsRow(
    "igdb",    t("settings.igdbTitle"),
    t("settings.igdbDesc"),
    igdbProxyDown
      ? `<span class="chip warn">${t("igdb.proxyDown")}</span>`
      : `<span class="chip ${S.igdbConfigured ? "ok" : ""}">${S.igdbConfigured ? t("settings.connected") : t("settings.keyMissing")}</span>`,
    `<div class="settings-row-desc" style="flex-basis:100%">${esc(igdbModeLine)}</div>
     <input id="settings-igdb-proxy" class="input settings-path-input" placeholder="${esc(t("settings.igdbProxyPlaceholder"))}" value="${esc(S.igdbProxyUrl)}" spellcheck="false" autocomplete="off" />
     <input id="settings-igdb-id" class="input settings-path-input" placeholder="${esc(t("settings.igdbIdPlaceholder"))}" value="${esc(S.igdbClientId)}" spellcheck="false" autocomplete="off" />
     <input id="settings-igdb-secret" type="${S.showSettingsIgdbSecret ? "text" : "password"}" class="input settings-path-input" placeholder="${esc(t(S.igdbConfigured ? "settings.igdbSecretStored" : "settings.igdbSecretPlaceholder"))}" value="" spellcheck="false" autocomplete="off" />
     <button class="icon-btn" data-act="toggle-igdb-secret-visibility" title="${t("settings.showHide")}">${icon(S.showSettingsIgdbSecret ? "eye-off" : "eye", 15)}</button>
     <button class="btn primary small" data-act="save-igdb-credentials">${t("common.save")}</button>
     <button class="btn ghost small" data-act="test-igdb">${t("settings.test")}</button>
     <button class="btn ghost small" data-act="open-external-url" data-url="https://dev.twitch.tv/console/apps/create">${t("settings.getFreeKey")}</button>
     ${S.igdbMode === "direct" ? `<button class="btn ghost small" data-act="clear-igdb-credentials">${t("common.delete")}</button>` : ""}`,
  );

  // Amazon Games runs through the open-source Nile helper; the row reports
  // whether it is already on disk and links to the account card.
  const nileReady = Boolean(S.amazonStatus?.binary);
  const nileGroup = row(
    t("settings.nileTitle"),
    t("settings.nileDesc"),
    `<span class="chip ${nileReady ? "ok" : ""}">${nileReady ? t("settings.nileReady") : t("settings.nilePending")}</span>
     <button class="btn ghost small" data-view="accounts">${icon("user", 13)} ${t("settings.nileAccount")}</button>`,
  );

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
    group(nileGroup, t("settings.nileTitle")) +
    renderSteamGroup() +
    afterPlaying +
    group(sgdb, t("settings.coverArtTitle")) +
    group(igdb, t("settings.igdbGroup"))
  );
}

/**
 * The Social section: Discord itself — the page, Rich Presence and staying
 * open. It used to live inside Integrations, where nobody found it.
 */
function renderSocial(): string {
  // Discord lives in the launcher: the real web client opens as a page, and
  // the community server stays one click away.
  const discord = row(
    t("settings.aboutDiscord"),
    t("settings.discordDesc"),
    `<button class="btn ghost small" data-view="discord">${icon("discord", 13)} ${t("overlay.openDiscord")}</button>
     <button class="btn ghost small" data-act="open-external-url" data-url="${DISCORD_INVITE_URL}">${icon("external", 13)} ${t("settings.discordJoin")}</button>`,
  );

  const presence = row(
    t("settings.presenceTitle"),
    t("settings.presenceDesc"),
    toggle("toggle-presence", S.presenceEnabled),
  );

  // The Discord page is the message channel: keeping it loaded is what lets
  // messages and calls arrive while a game runs. On by default; the person
  // decides, and turning it off unloads the page on the next start.
  const discordAlways = row(
    t("settings.discordAlwaysTitle"),
    t("settings.discordAlwaysDesc"),
    toggle("toggle-discord-always", keepDiscordOpen()),
  );

  return group(discord + presence + discordAlways, t("settings.secSocial"));
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
  const bridgeRunning = status?.bridgeRunning ?? false;
  const bridgeChip = status === null
    ? `<span class="chip">${t("controller.checking")}</span>`
    : !status.viEmBus
      ? `<span class="chip warn">${t("controller.bridgeMissing")}</span>`
      : bridgeRunning
        ? `<span class="chip ok">${status.bridgeDevice ? t("controller.bridgeRunningWith", { name: status.bridgeDevice }) : t("controller.bridgeWaiting")}</span>`
        : `<span class="chip">${t("controller.bridgeStopped")}</span>`;
  const bridgeControls = status === null
    ? ""
    : !status.viEmBus
      ? `${bridgeChip}
         <button class="btn ghost small" data-act="open-external-url" data-url="https://github.com/nefarius/ViGEmBus/releases">${t("controller.downloadVigem")}</button>
         <button class="btn ghost small" data-act="controller-refresh">${t("controller.refresh")}</button>`
      : `${bridgeChip}${toggle("toggle-controller-bridge", bridgeRunning)}`;
  const deckNote = isSteamDeckDevice() || pads.some((g) => controllerKind(g.id) === "steamdeck")
    ? `<p class="page-sub">${t("controller.deckNote")}</p>`
    : "";
  const tv = row(
    t("controller.tvAutoTitle"),
    t("controller.tvAutoDesc"),
    toggle("toggle-tv-auto", S.tvAutoEnter),
  );
  const bridge = row(
    t("controller.bridgeTitle"),
    t("controller.bridgeDesc"),
    bridgeControls,
    true,
  );

  const virtualNote = status?.bridgeRunning
    ? infoBox("controller.bridgeVirtualNote")
    : "";
  return group(padRows, t("controller.padsTitle")) + virtualNote + group(tv, t("tv.mode")) + deckNote + group(bridge, t("settings.secController"));
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
    "steam-api-key",    t("settings.steamApiTitle"),
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
        <button type="button" class="${S.surface === "soft" ? "active" : ""}" data-act="set-surface" data-surface="soft">${t("settings.surfaceSoft")}</button>
      </div>`) +
      row(t("settings.coverStatsTitle"), t("settings.coverStatsDesc"), toggle("toggle-cover-stats", S.showCoverStats)) +
      row(t("settings.coverTitlesTitle"), t("settings.coverTitlesDesc"), toggle("toggle-cover-titles", S.showCoverTitles)) +
      row(t("settings.storeBadgeTitle"), t("settings.storeBadgeDesc"), toggle("toggle-store-badge", S.showStoreBadge)) +
      row(t("settings.storeIconsTitle"), t("settings.storeIconsDesc"), toggle("toggle-store-icons", S.showStoreIcons)) +
      row(t("settings.caseCoversTitle"), t("settings.caseCoversDesc"), toggle("toggle-case-covers", S.showCaseCovers)) +
      (S.showCaseCovers
        ? row(
            t("settings.caseCoverStyleTitle"),
            t(
              S.caseCoverStyle === "clear"
                ? "settings.caseStyleClearDesc"
                : S.caseCoverStyle === "steelbook"
                  ? "settings.caseStyleSteelbookDesc"
                  : S.caseCoverStyle === "jewel"
                    ? "settings.caseStyleJewelDesc"
                    : S.caseCoverStyle === "holo"
                      ? "settings.caseStyleHoloDesc"
                      : "settings.caseStyleRetailDesc",
            ),
            `<div class="seg" role="radiogroup">${(
              [
                ["retail", "settings.caseStyleRetail"],
                ["clear", "settings.caseStyleClear"],
                ["steelbook", "settings.caseStyleSteelbook"],
                ["jewel", "settings.caseStyleJewel"],
                ["holo", "settings.caseStyleHolo"],
              ] as const
            )
              .map(
                ([style, labelKey]) =>
                  `<button type="button" class="${S.caseCoverStyle === style ? "active" : ""}" data-act="set-case-cover-style" data-style="${style}">${t(labelKey)}</button>`,
              )
              .join("")}</div>`,
          )
        : "") +
      row(t("settings.separateCopiesTitle"), t("settings.separateCopiesDesc"), toggle("toggle-separate-copies", S.separateCopies)) +
      row(t("settings.installedIconTitle"), t("settings.installedIconDesc"), toggle("toggle-installed-icon", S.showInstalledIcon)) +
      row(t("settings.highlightInstalledTitle"), t("settings.highlightInstalledDesc"), toggle("toggle-highlight-installed", S.highlightInstalled)) +
      row(t("settings.sharedLibraryTitle"), t("settings.sharedLibraryDesc"), toggle("toggle-shared-library", S.showSharedLibrary)) +
      row(t("tv.open"), t("controller.tvModeDesc"), `<button class="btn ghost small" data-act="open-tv-mode">${icon("gamepad-2", 14)} ${t("tv.open")}</button>`) +
      row(t("overlay.overlayLabel"), t("overlay.startHint"), `<button class="btn ghost small" data-act="open-overlay">${icon("layers", 14)} ${t("overlay.overlayLabel")}</button>`) +
      (overlayBlockedGames().length > 0
        ? row(
            `${t("overlay.disabledListTitle")} (${overlayBlockedGames().length})`,
            t("overlay.disabledListDesc"),
            `<button class="btn ghost small" data-act="overlay-restore-disabled">${icon("refresh", 13)} ${t("overlay.restoreAll")}</button>`,
          )
        : "") +
      row(t("settings.libPaginationTitle"), t("settings.libPaginationDesc"), toggle("toggle-lib-pagination", S.libPagination)) +
      (S.libPagination ? row(t("settings.libPageSizeTitle"), t("settings.libPageSizeDesc"), pageSizeSelect()) : ""),
    ) +
    group(
      row(t("settings.showSpotifyTitle"), t("settings.showSpotifyDesc"), toggle("toggle-spotify-page", spotifyPageVisible())) +
      row(t("settings.showMiniPlayerTitle"), t("settings.showMiniPlayerDesc"), toggle("toggle-mini-player", miniPlayerVisible())) +
      row(t("settings.showDiscordTitle"), t("settings.showDiscordDesc"), toggle("toggle-discord-page", discordPageVisible())),
      t("settings.secPages"),
      infoBox("settings.pagesNote"),
    ) +
    group(
      HEADER_STORES.map((id) => {
        const hidden = S.hiddenStores.has(id);
        // The last visible store stays: an empty bar would have nothing to open.
        const lastVisible = !hidden && HEADER_STORES.every((store) => store === id || S.hiddenStores.has(store));
        return row(
          `${storeLogo(id, 18, "settings-store-logo")}${STORE_LABELS[id]}`,
          null,
          `<label class="switch"><input type="checkbox" data-act="toggle-store-visible" data-store="${id}" ${hidden ? "" : "checked"} ${lastVisible ? "disabled" : ""} /><span class="track"></span></label>`,
        );
      }).join(""),
      t("settings.secStoreTabs"),
      infoBox("settings.storeTabsNote"),
    ) +
    `<h3 class="section-title">${t("settings.language")}</h3><p class="page-sub settings-lang-desc">${t("settings.languageDesc")}</p><div class="lang-selection-group" data-search="${esc(LANGUAGES.map((l) => l.label).join(" "))}">${languages}</div>`
  );
}

function renderNotes(): string {
  // The list is needed for the stats; one cached call, then a single repaint.
  if (!notesSettingsLoaded) {
    void loadNotes().then(() => {
      notesSettingsLoaded = true;
      if (S.settingsSection === "notes") render();
    });
  }
  const notes = cachedNotes();
  const games = new Set(
    notes.filter((note) => note.scope !== LAUNCHER_SCOPE).map((note) => note.scope),
  ).size;
  const font = notesFontSize();
  const fontSizes: ("s" | "m" | "l")[] = ["s", "m", "l"];
  const fontRow = row(
    t("notes.fontSize"),
    t("notes.fontSizeDesc"),
    `<div class="seg">${fontSizes
      .map(
        (size) =>
          `<button type="button" class="${font === size ? "active" : ""}" data-act="notes-font" data-size="${size}">${t(size === "s" ? "notes.fontSmall" : size === "m" ? "notes.fontMedium" : "notes.fontLarge")}</button>`,
      )
      .join("")}</div>`,
  );
  const statsRow = row(
    t("notes.statsTitle"),
    t("notes.statsDesc"),
    `<span class="settings-value">${t("notes.statsNotes", { count: String(notes.length) })} · ${t("notes.statsGames", { count: String(games) })}</span>`,
  );
  const openRow = row(
    t("notes.openPage"),
    t("notes.openPageDesc"),
    `<button type="button" class="btn ghost small" data-view="notes">${icon("external", 13)} ${t("notes.openPage")}</button>`,
  );
  const sidebarRow = row(
    t("notes.sidebarTitle"),
    t("notes.sidebarDesc"),
    toggle("toggle-notes-sidebar", notesSidebarVisible()),
  );
  const exportRow = row(
    t("notes.exportTitle"),
    t("notes.exportDesc"),
    `<button type="button" class="btn ghost small" data-act="notes-export" data-format="json">${icon("download", 13)} JSON</button>
     <button type="button" class="btn ghost small" data-act="notes-export" data-format="markdown">${icon("download", 13)} Markdown</button>`,
  );
  const importRow = row(
    t("notes.importTitle"),
    t("notes.importDesc"),
    `<textarea id="notes-import-json" class="notes-import-area" placeholder="${esc(t("notes.importPlaceholder"))}" spellcheck="false"></textarea>
     <button type="button" class="btn primary small" data-act="notes-import-text">${icon("upload", 13)} ${t("notes.importBtn")}</button>`,
    true,
  );
  return (
    group(openRow + sidebarRow + statsRow + fontRow, t("settings.secNotes"), infoBox("notes.settingsInfo")) +
    group(exportRow + importRow, t("notes.backupTitle"))
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

  // The gallery reads more than the chosen folder; say so, with the paths, so
  // nobody has to guess where a picture came from. The switch above the list
  // narrows it to the chosen folder for anyone who wants that.
  const scanAll = row(
    t("settings.ssScanAllTitle"),
    t("settings.ssScanAllDesc"),
    toggle("ss-toggle-scan-all", S.screenshotScanAll),
    true,
  );
  const roots = row(
    t("settings.ssRootsTitle"),
    `${t("settings.ssRootsDesc")}<br>${(S.screenshotScanRoots.length
      ? S.screenshotScanRoots
      : [S.screenshotDir]
    )
      .filter(Boolean)
      .map((path) => `<code>${esc(path)}</code>`)
      .join("<br>")}`,
    "",
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
  // The description follows the selected format instead of always praising AVIF.
  const formatInfo = S.screenshotCompressionFormat === "webp"
    ? t("settings.webpInfo")
    : S.screenshotCompressionFormat === "jpg"
      ? t("settings.jpgInfo")
      : t("settings.avifInfo");
  const options = S.screenshotCompressionEnabled
    ? row(t("settings.format"), formatInfo, `<div class="seg">${formats.map(([f, label]) => `<button type="button" class="${S.screenshotCompressionFormat === f ? "active" : ""}" data-act="set-ss-format" data-format="${f}">${label}</button>`).join("")}</div>`) +
      row(t("settings.quality"), null, `<input type="range" min="0.70" max="0.95" step="0.05" value="${S.screenshotCompressionQuality}" data-act="set-ss-quality" id="ss-quality-slider" class="settings-range" /><span id="ss-quality-val" class="settings-range-val">%${Math.round(S.screenshotCompressionQuality * 100)}</span>`)
    : "";

  /* Capture feedback: the shutter sound and the saved notice. */
  const sound = row(t("ss.soundTitle"), t("ss.soundDesc"), toggle("toggle-ss-sound", ssSoundOn()));
  const notify = row(t("ss.notifyTitle"), t("ss.notifyDesc"), toggle("toggle-ss-notify", ssNotifyOn()));

  /* Gallery defaults the drawer and the overlay read. */
  const sort = ssSort();
  const sortRow = row(
    t("ss.sortTitle"),
    t("ss.sortDesc"),
    `<div class="seg">${([["newest", "ss.sortNewest"], ["oldest", "ss.sortOldest"], ["name", "ss.sortName"], ["size", "ss.sortSize"]] as const)
      .map(([value, key]) => `<button type="button" class="${sort === value ? "active" : ""}" data-act="ss-sort" data-sort="${value}">${t(key)}</button>`)
      .join("")}</div>`,
  );
  const density = ssDensity();
  const densityRow = row(
    t("ss.densityTitle"),
    t("ss.densityDesc"),
    `<div class="seg">${([["s", "ss.densitySmall"], ["m", "ss.densityMedium"], ["l", "ss.densityLarge"]] as const)
      .map(([value, key]) => `<button type="button" class="${density === value ? "active" : ""}" data-act="ss-density" data-density="${value}">${t(key)}</button>`)
      .join("")}</div>`,
  );

  /* Games with capture turned off (the game page toggles them). */
  const disabled = S.epicSettingsCache?.screenshot_disabled_games ?? [];
  const disabledRows = disabled.length
    ? disabled
        .map((key) =>
          row(
            esc(summaryOf(key)?.title || key),
            null,
            `<button type="button" class="btn ghost small" data-act="ss-enable-game" data-key="${esc(key)}">${t("overlay.restore")}</button>`,
          ),
        )
        .join("")
    : row(t("ss.disabledEmpty"), null, "");

  /* Favorites and the auto-cleanup policy. */
  const favorites = ssFavorites();
  const favoritesRow = row(
    t("ss.favoritesTitle"),
    t("ss.favoritesDesc", { count: String(favorites.size) }),
    favorites.size
      ? `<button type="button" class="btn ghost small" data-act="ss-clear-favorites">${t("ss.favoritesClear")}</button>`
      : "",
  );
  const policy = ssCleanupPolicy();
  const policyRow = row(
    t("ss.cleanupTitle"),
    t("ss.cleanupDesc"),
    `<div class="seg">${([["off", "ss.cleanupOff"], ["size", "ss.cleanupSize"], ["age", "ss.cleanupAge"]] as const)
      .map(([value, key]) => `<button type="button" class="${policy.mode === value ? "active" : ""}" data-act="ss-cleanup-mode" data-mode="${value}">${t(key)}</button>`)
      .join("")}</div>`,
  );
  const sizeRow = policy.mode === "size"
    ? row(
        t("ss.cleanupSizeTitle"),
        t("ss.cleanupSizeDesc"),
        `<input type="number" min="1" max="2000" id="ss-cleanup-size" class="input settings-time-input" value="${policy.sizeGb}" /><span class="settings-value">GB</span>`,
      )
    : "";
  const ageRow = policy.mode === "age"
    ? row(
        t("ss.cleanupAgeTitle"),
        t("ss.cleanupAgeDesc"),
        `<input type="number" min="1" max="3650" id="ss-cleanup-days" class="input settings-time-input" value="${policy.days}" /><span class="settings-value">${esc(t("ss.daysUnit"))}</span>`,
      )
    : "";
  const cleanupActions = policy.mode !== "off"
    ? `<div class="task-foot"><button type="button" class="btn ghost small" data-act="ss-cleanup-preview">${icon("search", 13)} ${t("ss.cleanupPreview")}</button></div>
       <div id="ss-cleanup-report"></div>`
    : "";

  const sidebar = row(
    t("ss.sidebarTitle"),
    t("ss.sidebarDesc"),
    toggle("toggle-screenshots-sidebar", screenshotsSidebarVisible()),
  );

  /* Sharing: one-click Discord needs the user's own webhooks; the rest copy the
     image and open the compose page. */
  const webhooks = ssWebhooks();
  const maskWebhook = (url: string): string => {
    const tail = url.split("/").pop() ?? "";
    return `${url.replace(/\/[^/]*$/, "/")}${tail.slice(0, 6)}…`;
  };
  const webhookList = webhooks.length
    ? webhooks
        .map((hook) =>
          row(
            `${icon("discord", 14)} ${esc(hook.name)}`,
            `<code>${esc(maskWebhook(hook.url))}</code>`,
            `<button type="button" class="btn ghost danger small" data-act="ss-webhook-remove" data-id="${esc(hook.id)}">${icon("trash", 12)} ${t("common.delete")}</button>`,
          ),
        )
        .join("")
    : row(t("ss.webhookEmpty"), t("ss.webhookEmptyDesc"), "");
  const webhookRow = row(
    t("ss.webhookAddTitle"),
    `${t("ss.webhookDesc")}
     <div class="ss-webhook-howto">
       <div class="ss-webhook-howto-head">
         <span class="ss-webhook-howto-title">${t("ss.webhookHowTo")}</span>
         <button type="button" class="btn ghost small" data-act="open-external-url" data-url="https://support.discord.com/hc/articles/228383668">${icon("external", 12)} ${t("ss.webhookDocs")}</button>
       </div>
       <ol>
         <li>${t("ss.webhookStep1")}</li>
         <li>${t("ss.webhookStep2")}</li>
         <li>${t("ss.webhookStep3")}</li>
       </ol>
       <div class="ss-webhook-safe">${icon("shield", 12)} ${t("ss.webhookSafe")}</div>
     </div>`,
    `<input id="ss-webhook-name" class="input settings-path-input" placeholder="${esc(t("ss.webhookNamePlaceholder"))}" value="" spellcheck="false" autocomplete="off" />
     <input id="ss-webhook-input" class="input settings-path-input" placeholder="https://discord.com/api/webhooks/…" value="" spellcheck="false" autocomplete="off" />
     <button type="button" class="btn primary small" data-act="add-ss-webhook">${icon("plus", 13)} ${t("ss.webhookAdd")}</button>`,
    true,
  );

  /* Video: the MJPEG recorder runs in Rust and is driven by a hotkey. */
  const clipEnabled = localStorage.getItem(CLIP_ENABLED_KEY) === "true";
  const clipHotkey = Number(localStorage.getItem(CLIP_HOTKEY_KEY) ?? "0x78");
  const clipHotkeyCode = Number.isFinite(clipHotkey) && clipHotkey > 0 ? clipHotkey : 0x78;
  const clipHotkeyName = localStorage.getItem(CLIP_HOTKEY_NAME_KEY) || "F9";
  // Read through the helpers, not localStorage: they clamp a rate that was
  // stored before its button was disabled.
  const clipFps = clipFpsSetting();
  const clipHeight = clipHeightSetting();
  const clipMaxMin = Number(localStorage.getItem(CLIP_MAX_MIN_KEY) ?? "5");
  const clipToggle = row(
    t("ss.clipTitle"),
    t("ss.clipDesc"),
    toggle("toggle-clip-recording", clipEnabled),
  );
  const clipHotkeyRow = row(
    t("ss.clipHotkey"),
    `${t("settings.activeKey")}: <strong>${esc(clipHotkeyName)}</strong>`,
    `<select id="clip-hotkey-select" class="settings-select" data-act="change-clip-hotkey">
      ${S.PRESET_HOTKEYS.map((k) => `<option value="${k.code}" ${k.code === clipHotkeyCode ? "selected" : ""}>${k.name}${k.code === 0x78 ? ` (${t("settings.defaultKey")})` : ""}</option>`).join("")}
    </select>`,
  );
  const clipOptions = clipEnabled
    ? row(
        t("ss.clipFps"),
        t("ss.clipFpsDesc"),
        `<div class="seg">${[15, 30, 60, 120]
          .map((fps) => {
            const supported = CLIP_FPS_SUPPORTED.includes(fps);
            const state = supported ? "" : ' disabled aria-disabled="true"';
            return `<button type="button" class="${clipFps === fps ? "active" : ""}" data-act="set-clip-fps" data-fps="${fps}"${state}>${fps}</button>`;
          })
          .join("")}</div><span class="settings-hint">${esc(t("ss.clipFpsNote"))}</span>`,
      ) +
      row(
        t("ss.clipRes"),
        t("ss.clipResDesc"),
        `<div class="seg">${[
          [0, t("ss.clipResNative")],
          [720, "720p"],
          [1080, "1080p"],
          [1440, "1440p"],
        ]
          .map(([height, label]) => `<button type="button" class="${clipHeight === height ? "active" : ""}" data-act="set-clip-height" data-height="${height}">${esc(String(label))}</button>`)
          .join("")}</div>`,
      ) +
      row(
        t("ss.clipMax"),
        t("ss.clipMaxDesc"),
        `<input type="number" min="1" max="60" id="clip-max-min" class="input settings-time-input" value="${clipMaxMin}" /><span class="settings-value">${esc(t("ss.minutesUnit"))}</span>`,
      ) +
      row(
        t("ss.clipFolder"),
        t("ss.clipFolderDesc"),
        `<button type="button" class="btn ghost small" data-act="clip-open-folder">${icon("folder", 13)} ${t("ss.openFolder")}</button>`,
      )
    : "";

  return (
    group(folder + scanAll + roots + hotkey + sidebar + sound + notify, t("settings.screenshotsTitle")) +
    group(compression + options, t("ss.compressionSection")) +
    group(sortRow + densityRow, t("ss.gallerySection")) +
    group(disabledRows, t("ss.disabledTitle"), infoBox("ss.disabledHint")) +
    group(favoritesRow + policyRow + sizeRow + ageRow + cleanupActions, t("ss.cleanupSection")) +
    group(webhookRow + webhookList, t("ss.shareSection")) +
    group(clipToggle + clipHotkeyRow + clipOptions, t("ss.clipSection"))
  );
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
      row(t("settings.startWithWindows"), t("settings.startWithWindowsDesc"), toggle("toggle-autostart", S.startWithWindows)) +
      row(t("settings.minimizeOnGame"), t("settings.minimizeOnGameDesc"), toggle("toggle-minimize-on-game", S.minimizeOnGame)) +
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
  const link = (url: string, leading: string, label: string, text: string): string =>
    row(
      `<span class="about-link-title">${leading} <span>${esc(label)}</span></span>`,
      esc(text),
      `<button type="button" class="btn ghost small" data-act="open-external-url" data-url="${url}">${icon("external", 13)}</button>`,
    );
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
      link("mailto:hi@efxlve.com", icon("mail", 14), t("settings.aboutEmail"), "hi@efxlve.com") +
      link("https://x.com/efxlve", icon("twitter", 14), t("settings.aboutTwitter"), "x.com/efxlve") +
      link("https://github.com/efxlve/efxlve_launcher", icon("github", 14), t("settings.aboutGithub"), "github.com/efxlve/efxlve_launcher") +
      link("https://efxlve.com/", icon("globe", 14), t("settings.aboutWebsite"), "efxlve.com") +
      link(DISCORD_INVITE_URL, storeLogo("discord", 14, "about-link-logo"), t("settings.aboutDiscord"), "discord.gg/3TY8hNTx5M"),
      t("settings.aboutLinksTitle"),
    )}
    <div class="settings-about-texts" data-search="about">
      <h3 class="section-title">${t("settings.aboutDisclaimerTitle")}</h3>
      <p class="settings-about-text">${t("settings.aboutDisclaimer")}</p>
      <p class="settings-about-text">${t("settings.aboutLogos")}</p>
      <p class="settings-about-text">${t("settings.aboutMarks")}</p>
      <p class="settings-about-text">${t("settings.aboutDrmNotice")}</p>
      <p class="settings-about-text">${t("settings.aboutThirdParty")}</p>
      <p class="settings-about-text">${t("settings.aboutPrivacy")}</p>
      <p class="settings-about-text">${t("settings.aboutOpenSource")}</p>
    </div>`;
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
  if (typeof value === "string" && value.trim()) return value.trim();
  // Steam and companion items carry the studio on the unified item.
  return S.allGamesMap.get(id)?.developer || "";
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
    case "social": return renderSocial();
    case "launchers": return renderLaunchers();
    case "compat": return renderCompatSection();
    case "collections": return renderCollections();
    case "controller": return renderController();
    case "appearance": return renderAppearance();
    case "screenshots": return renderScreenshots();
    case "notes": return renderNotes();
    case "tasks": return renderTasks();
    case "system": return renderSystem();
    case "hidden": return renderHidden();
    case "about": return renderAbout();
    default: return renderDownloads();
  }
}

/** The settings search: a query shows every section, filtered to the matches. */
let settingsQuery = "";
let settingsSearching = false;
/** The notes section's stats need the list once; the flag stops re-render loops. */
let notesSettingsLoaded = false;

/** Called when the user leaves the search for a section (nav click, deep link). */
export function resetSettingsSearch(): void {
  settingsQuery = "";
  settingsSearching = false;
}

/** "No results" placeholder, toggled by {@link applySettingsSearch}. */
function searchEmptyHtml(): string {
  return `
    <div class="settings-search-empty" id="settings-search-empty" hidden>
      ${icon("search", 28)}
      <div class="settings-search-empty-title">${esc(t("settings.searchEmpty"))}</div>
      <div class="settings-search-empty-desc">${esc(t("settings.searchEmptyDesc"))}</div>
    </div>`;
}

export function renderSettings(): string {
  const active = SECTIONS.find((s) => s.id === S.settingsSection) ?? SECTIONS[0];
  captureOpenDetails();
  const nav = NAV_GROUPS.map(
    (cluster) => `
      <div class="settings-nav-group">
        <div class="settings-nav-group-label">${esc(t(cluster.labelKey))}</div>
        ${cluster.sections
          .map((id) => {
            const section = SECTIONS.find((s) => s.id === id);
            if (!section) return "";
            const isActive = section.id === active.id && !settingsSearching;
            return `<button class="settings-nav-item ${isActive ? "active" : ""}" data-act="settings-section" data-section="${section.id}">${t(section.labelKey)}</button>`;
          })
          .join("")}
      </div>`,
  ).join("");
  wireSettingsSearch();
  // The paint applies the filter to the fresh DOM; the call also restores the
  // match state after any in-page re-render (a toggle, a section switch).
  queueMicrotask(() => applySettingsSearch(settingsQuery));
  return `
    <div class="page settings-page">
      <div class="settings-layout">
        <nav class="settings-nav">
          <div class="settings-nav-search">
            ${icon("search", 13)}
            <input id="settings-search" class="settings-search" type="text" value="${esc(settingsQuery)}" placeholder="${esc(t("settings.searchPlaceholder"))}" spellcheck="false" />
            ${settingsQuery ? `<button type="button" class="settings-search-clear" data-act="settings-search-clear">${icon("x", 12)}</button>` : ""}
          </div>
          <span class="settings-search-count" id="settings-search-count" hidden></span>
          ${nav}
        </nav>
        <div class="settings-panel">
          ${
            settingsSearching
              ? SECTIONS.map(
                  (s) => `<section class="settings-search-section" data-section-id="${s.id}">
                    <h2 class="settings-search-head">${t(s.labelKey)}</h2>
                    ${renderSection(s.id)}
                  </section>`,
                ).join("") + searchEmptyHtml()
              : renderSection(active.id)
          }
        </div>
      </div>
    </div>`;
}

/**
 * The blocks a search treats as one result: rows, collapsible rows, info boxes,
 * cards and the custom list rows a few sections still hand-write.
 */
const SEARCH_UNIT_SELECTOR =
  "[data-search], .settings-row, .settings-details, .info-box, .card, .row, .empty-state";

/** Marks a block the current query filtered out. A class, not the `hidden`
 * attribute: other code sets `hidden` on its own nodes (`.account-switch`),
 * and the search must not put those back on screen. */
const SEARCH_HIDE_CLASS = "settings-search-hide";

function isSearchHidden(el: HTMLElement): boolean {
  return el.classList.contains(SEARCH_HIDE_CLASS);
}

/** Case- and accent-insensitive fold: Turkish users type "sayfasi" for
 * "sayfası", and the accented locales have the same habit. */
function foldForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ıi̇]/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ç/g, "c")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss");
}

function searchMatches(text: string, tokens: string[]): boolean {
  const hay = foldForSearch(text);
  return tokens.every((token) => hay.includes(token));
}

/**
 * Hides every block that does not match, then the groups, headings and whole
 * sections left without a match. Multi-word queries are AND: every word has to
 * appear somewhere in the block.
 */
function applySettingsSearch(query: string): void {
  const panel = document.querySelector<HTMLElement>(".settings-panel");
  if (!panel) return;
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(foldForSearch);
  const searching = tokens.length > 0;

  panel.querySelectorAll<HTMLElement>(SEARCH_UNIT_SELECTOR).forEach((unit) => {
    // The attribute text is the hand-written part; the rest comes from the DOM,
    // so custom markup is searchable without being tagged.
    const text = `${unit.dataset.search ?? ""} ${unit.textContent ?? ""}`;
    unit.classList.toggle(SEARCH_HIDE_CLASS, searching && !searchMatches(text, tokens));
  });

  panel.querySelectorAll<HTMLElement>(".settings-group").forEach((group) => {
    const anyVisible = [...group.querySelectorAll<HTMLElement>(SEARCH_UNIT_SELECTOR)].some(
      (el) => !isSearchHidden(el),
    );
    group.classList.toggle(SEARCH_HIDE_CLASS, searching && !anyVisible);
  });

  panel.querySelectorAll<HTMLElement>(".settings-search-section").forEach((section) => {
    const anyVisible = [...section.querySelectorAll<HTMLElement>(SEARCH_UNIT_SELECTOR)].some(
      (el) => !isSearchHidden(el),
    );
    section.classList.toggle(SEARCH_HIDE_CLASS, searching && !anyVisible);
  });

  // A heading goes with its content: walk the following siblings until the next
  // heading and keep the heading only when something readable is left.
  panel.querySelectorAll<HTMLElement>(".section-title").forEach((title) => {
    const head = title.closest<HTMLElement>(".settings-section-head, .settings-hidden-head") ?? title;
    let sibling = head.nextElementSibling;
    let anyVisible = false;
    while (sibling instanceof HTMLElement) {
      if (sibling.matches(".section-title") || sibling.querySelector(":scope > .section-title")) break;
      if (!isSearchHidden(sibling) && (sibling.matches(SEARCH_UNIT_SELECTOR) || sibling.querySelector(SEARCH_UNIT_SELECTOR))) {
        anyVisible = true;
        break;
      }
      sibling = sibling.nextElementSibling;
    }
    head.classList.toggle(SEARCH_HIDE_CLASS, searching && !anyVisible);
    // The language page keeps its description between the title and the grid.
    const desc = head.nextElementSibling;
    if (desc instanceof HTMLElement && desc.classList.contains("settings-lang-desc")) {
      desc.classList.toggle(SEARCH_HIDE_CLASS, searching && !anyVisible);
    }
  });

  const visibleSections = [
    ...panel.querySelectorAll<HTMLElement>(".settings-search-section"),
  ].filter((section) => !isSearchHidden(section)).length;
  // The counter sits in the nav, next to the box the query was typed into.
  const count = document.getElementById("settings-search-count");
  if (count) {
    count.hidden = !searching || visibleSections === 0;
    count.textContent = searching ? t("settings.searchResults", { count: String(visibleSections) }) : "";
  }
  const empty = panel.querySelector<HTMLElement>("#settings-search-empty");
  if (empty) empty.hidden = !searching || visibleSections > 0;
}

/** Enter jumps the caret to the first match, so a long page does not hide it. */
function jumpToFirstMatch(): void {
  const first = document.querySelector<HTMLElement>(
    `.settings-search-section:not(.${SEARCH_HIDE_CLASS}) [data-search]:not(.${SEARCH_HIDE_CLASS}), .settings-search-section:not(.${SEARCH_HIDE_CLASS}) .settings-row:not(.${SEARCH_HIDE_CLASS})`,
  );
  if (!first) return;
  first.scrollIntoView({ block: "center" });
  first.classList.add("settings-search-jump");
  window.setTimeout(() => first.classList.remove("settings-search-jump"), 1000);
}

/** Wires the search box once; typing filters in place, and the first character
 * re-renders so matches from every section are on screen. */
let settingsSearchWired = false;

function wireSettingsSearch(): void {
  if (settingsSearchWired) return;
  settingsSearchWired = true;
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "settings-search") return;
    const query = input.value;
    const searching = query.trim().length > 0;
    settingsQuery = query;
    if (searching !== settingsSearching) {
      settingsSearching = searching;
      render();
      const fresh = document.getElementById("settings-search") as HTMLInputElement | null;
      if (fresh) {
        fresh.focus();
        fresh.setSelectionRange(query.length, query.length);
      }
      applySettingsSearch(query);
      return;
    }
    applySettingsSearch(query);
  });
  document.addEventListener("keydown", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "settings-search") return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!input.value) {
        input.blur();
        return;
      }
      resetSettingsSearch();
      render();
      document.getElementById("settings-search")?.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      jumpToFirstMatch();
    }
  });
}

/**
 * Asks the shared IGDB proxy whether it answers with JSON at all. The settings
 * row shows the answer, so an undeployed server stops looking like a working
 * setup — nothing else in the launcher waits for this.
 */
export function refreshIgdbProxyProbe(): void {
  if (S.igdbMode !== "proxy") {
    S.igdbProxyReachable = null;
    return;
  }
  void igdbProbeProxy()
    .then((probe) => {
      S.igdbProxyReachable = probe.reachable;
      if (S.view === "settings") render();
    })
    .catch(() => undefined);
}

/**
 * Loads the cheap settings data (settings.json, default dir, SteamGrid key).
 * Heavy integration scans are deferred to {@link loadIntegrationsView} so the
 * page paints instantly and the launcher never appears to freeze.
 */
export async function loadSettingsView(): Promise<void> {
  if (isTauri) {
    try {
      const [st, dir, sgdbKey, , ssDir, steamKey, gogDir, gogDefault, autostart, amazonDir, amazonDefault, igdb, ssRoots, ssScanAll, cacheBytes] = await Promise.all([
        epicGetSettings(),
        epicDefaultInstallDir(),
        epicGetSteamGridKey().catch(() => null),
        loadSavedAccounts().catch(() => []),
        epicGetScreenshotDir().catch(() => ""),
        steamGetApiKey().catch(() => null),
        gogGetInstallDir().catch(() => null),
        gogDefaultInstallDir().catch(() => ""),
        appGetAutostart().catch(() => false),
        amazonGetInstallDir().catch(() => null),
        amazonDefaultInstallDir().catch(() => ""),
        igdbStatus().catch(() => null),
        epicGetScreenshotScanRoots().catch(() => [] as string[]),
        epicGetScreenshotScanAll().catch(() => true),
        imageCacheSize().catch(() => null),
      ]);
      S.epicSettingsCache = st ?? S.epicSettingsCache;
      S.epicDefaultDir = dir ?? "";
      S.steamGridApiKey = sgdbKey;
      S.screenshotDir = ssDir || "";
      S.steamApiKey = steamKey;
      S.gogInstallDir = gogDir || "";
      S.gogDefaultDir = gogDefault || "";
      S.startWithWindows = autostart;
      S.gogCometEnabled = st?.gog_comet_enabled ?? true;
      S.amazonInstallDir = amazonDir || "";
      S.amazonDefaultDir = amazonDefault || "";
      S.screenshotScanRoots = Array.isArray(ssRoots) ? ssRoots : [];
      S.screenshotScanAll = ssScanAll !== false;
      S.pictureCacheBytes = cacheBytes ?? null;
      if (igdb) {
        S.igdbConfigured = igdb.configured;
        S.igdbClientId = igdb.clientId;
        S.igdbMode = igdb.mode;
        S.igdbProxyUrl = igdb.proxyUrl;
        // The proxy is the default transport, so the row has to say when the
        // server is not deployed: otherwise the chip claims a working setup.
        refreshIgdbProxyProbe();
      }
    } catch {
      // Silent: keep the last cached values.
    }
  }
  render();
  // Re-add the EOS notice if it was cleared. Uses the status already in memory.
  syncEosNotice();
  applySettingsSearch(settingsQuery);
  if (S.settingsSection === "integrations") void loadIntegrationsView();
  if (S.settingsSection === "controller") void loadControllerView(true);
  if (S.settingsSection === "launchers") void loadLaunchersView();
  if (S.settingsSection === "compat") void loadCompatView();
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
    S.controllerBridge = { viEmBus: false, steam: false, steamPath: "", bridgeRunning: false, bridgeDevice: "" };
  }
  render();
}

/** Loads the store client rows for Settings > Launchers. */
export async function loadLaunchersView(force = false): Promise<void> {
  if (!isTauri || S.launchersLoading) return;
  if (S.launchers.length > 0 && !force) {
    render();
    return;
  }
  S.launchersLoading = true;
  render();
  try {
    S.launchers = (await launchersStatus()) ?? [];
  } catch {
    S.launchers = [];
  } finally {
    S.launchersLoading = false;
    render();
  }
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
    const [eglList, eglPresent, eos, galaxyList, steamState, clientSettings] = await Promise.all([
      epicDetectEglGames().catch(() => [] as EglDetectedGame[]),
      eglLauncherPresent().catch(() => false),
      eosOverlayStatus().catch(() => null),
      gogDetectGalaxyGames().catch(() => [] as GalaxyDetectedGame[]),
      steamStatus().catch(() => null),
      companionGetClientSettings().catch(() => null),
    ]);
    // A null from the backend (older binary, shape change) must not white-screen
    // the page: the lists are read with .length right after this.
    S.eglDetectedList = eglList ?? [];
    S.eglLauncherPresent = eglPresent ?? false;
    S.eosOverlay = eos;
    S.gogGalaxyDetected = galaxyList ?? [];
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

/* ---------- Screenshot cleanup (favorites never get deleted) ---------- */

/** The shots the policy would delete right now. */
async function cleanupCandidates(): Promise<GameScreenshotItem[]> {
  const policy = ssCleanupPolicy();
  if (policy.mode === "off") return [];
  const all = await epicGetAllScreenshots().catch(() => [] as GameScreenshotItem[]);
  const favorites = ssFavorites();
  const pool = all.filter((item) => !favorites.has(item.file_path));
  if (policy.mode === "age") {
    const cutoff = Date.now() - policy.days * 86_400_000;
    return pool.filter((item) => item.timestamp > 0 && item.timestamp < cutoff);
  }
  // Size cap: keep the newest shots until the cap is reached, the rest goes.
  const cap = policy.sizeGb * 1024 * 1024 * 1024;
  const sorted = [...pool].sort((a, b) => b.timestamp - a.timestamp);
  let kept = 0;
  const doomed: GameScreenshotItem[] = [];
  for (const item of sorted) {
    kept += item.size_bytes || 0;
    if (kept > cap) doomed.push(item);
  }
  return doomed;
}

async function previewCleanup(): Promise<void> {
  const host = document.getElementById("ss-cleanup-report");
  if (host) {
    host.innerHTML = `<div class="hub-desc-loading"><span class="spinner"></span><span>${esc(t("common.calculating"))}</span></div>`;
  }
  const candidates = await cleanupCandidates();
  const bytes = candidates.reduce((sum, item) => sum + (item.size_bytes || 0), 0);
  if (!host) return;
  host.innerHTML =
    candidates.length === 0
      ? `<div class="settings-row-desc">${esc(t("ss.cleanupNothing"))}</div>`
      : `<div class="ss-cleanup-report">
          <span>${esc(t("ss.cleanupReport", { count: String(candidates.length), size: fmtBytes(bytes) }))}</span>
          <button type="button" class="btn danger small" data-act="ss-cleanup-apply">${icon("trash", 13)} ${esc(t("ss.cleanupApply"))}</button>
        </div>`;
}

async function applyCleanup(): Promise<void> {
  const host = document.getElementById("ss-cleanup-report");
  const candidates = await cleanupCandidates();
  let removed = 0;
  for (const item of candidates) {
    try {
      if (await epicDeleteGameScreenshot(item.file_path)) removed += 1;
    } catch {
      // One locked file must not stop the rest.
    }
  }
  if (host) {
    host.innerHTML = `<div class="settings-row-desc">${esc(t("ss.cleanupDone", { count: String(removed) }))}</div>`;
  }
}

/**
 * Screenshot-folder actions routed here from click-router so the shared router
 * does not grow. Returns true when the action was handled.
 */
export function handleSettingsAction(act: string | undefined, _el: HTMLElement, _targetEl?: HTMLElement): boolean {
  if (handleCompatAction(act, _el)) return true;
  switch (act) {
    case "add-ss-webhook": {
      const nameInput = document.getElementById("ss-webhook-name") as HTMLInputElement | null;
      const urlInput = document.getElementById("ss-webhook-input") as HTMLInputElement | null;
      const url = urlInput?.value.trim() ?? "";
      if (!/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(url)) {
        toast(t("ss.badWebhook"), "err");
        return true;
      }
      void (async () => {
        toast(t("ss.webhookChecking"), "");
        let name = nameInput?.value.trim() ?? "";
        try {
          // The webhook's own name from Discord doubles as the validity check.
          const info = await screenshotWebhookInfo(url);
          if (!name) name = info || "Discord";
        } catch (error) {
          toast(String(error), "err");
          return;
        }
        ssAddWebhook(name, url);
        toast(t("ss.webhookAdded", { name }), "ok");
        render();
      })();
      return true;
    }
    case "ss-webhook-remove": {
      const id = _el.dataset.id ?? "";
      if (id) {
        ssRemoveWebhook(id);
        render();
      }
      return true;
    }
    case "toggle-clip-recording": {
      const enabled = (_el as HTMLInputElement).checked;
      localStorage.setItem(CLIP_ENABLED_KEY, String(enabled));
      // The recorder reads its settings from Rust, so they travel with the toggle.
      if (enabled) pushClipSettings();
      render();
      return true;
    }
    case "set-clip-fps": {
      const fps = Number(_el.dataset.fps ?? "30");
      if (CLIP_FPS_SUPPORTED.includes(fps)) {
        localStorage.setItem(CLIP_FPS_KEY, String(fps));
        void clipSetOptions({ fps });
        render();
      }
      return true;
    }
    case "set-clip-height": {
      const height = Number(_el.dataset.height ?? "0");
      if ([0, 720, 1080, 1440].includes(height)) {
        localStorage.setItem(CLIP_HEIGHT_KEY, String(height));
        void clipSetOptions({ height });
        render();
      }
      return true;
    }
    case "clip-open-folder":
      void clipFolderPath()
        .then((path) => epicOpenFolderPath(path))
        .catch(() => undefined);
      return true;
    case "settings-search-clear":
      resetSettingsSearch();
      render();
      document.getElementById("settings-search")?.focus();
      return true;
    case "toggle-ss-sound":
      localStorage.setItem(SS_SOUND_KEY, String((_el as HTMLInputElement).checked));
      return true;
    case "ss-toggle-scan-all": {
      const on = (_el as HTMLInputElement).checked;
      S.screenshotScanAll = on;
      void epicSetScreenshotScanAll(on)
        .then(() => epicGetScreenshotScanRoots())
        .then((list) => {
          // The list below the switch shows what the new setting scans.
          S.screenshotScanRoots = list;
          render();
        })
        .catch(() => undefined);
      return true;
    }
    case "toggle-ss-notify":
      localStorage.setItem(SS_NOTIFY_KEY, String((_el as HTMLInputElement).checked));
      return true;
    case "ss-sort": {
      const sort = _el.dataset.sort;
      if (sort === "newest" || sort === "oldest" || sort === "name" || sort === "size") {
        localStorage.setItem(SS_SORT_KEY, sort);
        render();
      }
      return true;
    }
    case "ss-density": {
      const density = _el.dataset.density;
      if (density === "s" || density === "m" || density === "l") {
        localStorage.setItem(SS_DENSITY_KEY, density);
        render();
      }
      return true;
    }
    case "ss-enable-game": {
      const key = _el.dataset.key ?? "";
      if (!key) return true;
      const next = (S.epicSettingsCache?.screenshot_disabled_games ?? []).filter((item) => item !== key);
      void epicSetScreenshotDisabledGames(next)
        .then(() => {
          if (S.epicSettingsCache) S.epicSettingsCache.screenshot_disabled_games = next;
          render();
        })
        .catch((error) => toast(String(error), "err"));
      return true;
    }
    case "ss-clear-favorites":
      ssClearFavorites();
      render();
      return true;
    case "ss-cleanup-mode": {
      const mode = _el.dataset.mode;
      if (mode === "off" || mode === "size" || mode === "age") {
        const policy = ssCleanupPolicy();
        ssSetCleanupPolicy({ ...policy, mode });
        render();
      }
      return true;
    }
    case "ss-cleanup-preview":
      void previewCleanup();
      return true;
    case "ss-cleanup-apply":
      void applyCleanup();
      return true;
    case "notes-font": {
      const size = _el.dataset.size;
      if (size === "s" || size === "m" || size === "l") {
        setNotesFontSize(size);
        render();
      }
      return true;
    }
    case "notes-export": {
      const format = _el.dataset.format === "markdown" ? "markdown" : "json";
      void exportNotes(format).then((path) => {
        if (!path) {
          toast(t("notes.exportFailed"), "err");
          return;
        }
        toast(t("notes.exportDone", { path }), "ok");
      });
      return true;
    }
    case "notes-open-export-folder": {
      const path = _el.dataset.path;
      if (!path) return true;
      const dir = path.replace(/[\\/][^\\/]*$/, "");
      void epicOpenFolderPath(dir).catch(() => undefined);
      return true;
    }
    case "notes-import-text": {
      const area = document.getElementById("notes-import-json") as HTMLTextAreaElement | null;
      const json = area?.value.trim() ?? "";
      if (!json) return true;
      void importNotesText(json).then((count) => {
        if (count === null) {
          toast(t("notes.importFailed"), "err");
          return;
        }
        toast(t("notes.importDone", { count: String(count) }), "ok");
        if (area) area.value = "";
        render();
      });
      return true;
    }
    case "task-stop":
    case "task-refresh":
    case "task-sort":
    case "task-toggle-webview":
    case "task-detail":
    case "task-detail-close":
    case "task-detail-backdrop":
      return handleTaskAction(act, _el, _targetEl);
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

/**
 * Game page "Manage" tab: markup plus the in-place DOM updates used while it is
 * open (settings sync, verify progress and reset). State lives in S.
 */

import { manageRoot } from "../../core/dom";
import { icon, type IconName } from "../../core/icons";
import { lastPlayedLabel, rawOf, sourceOfKey, storeKeysForTitle, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtPlaytime } from "../../core/utils";
import { formatSyncStamp, t } from "../../i18n";

import { epicGetGameSettings, getThirdPartyLauncher, requiresThirdPartyLauncher, type EpicSummary, type GameLocalSettings } from "../../epic";
import { nileGameSettings } from "../../nile";
import type { GameSource } from "../../core/types";
import { renderBackupListHtml } from "../drawer/drawer-widgets";
import { storeVersionLabel } from "../drawer/external-versions";
import { renderManageCloudBackupRow, updateManageCloudRowInPlace } from "../cloud-backup/cloud-backup-view";
import { initCloudBackupSettings, loadCloudBackupsAction } from "../cloud-backup/cloud-backup-actions";
export { updateManageCloudRowInPlace };

/** Serializes env vars as one KEY=VALUE per line for the manage textarea. */
function envToText(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}

/** One settings line in the panel. The plain text lands in `data-search`, which
 * is what the panel's search box filters on. */
function row(title: string, desc: string, actions: string, extra = "", descId = ""): string {
  const search = `${title} ${desc} ${actions}`.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return `
    <div class="row mg-row" data-search="${esc(search)}">
      <div class="row-main">
        <div class="mg-title">${title}</div>
        <div class="mg-desc"${descId ? ` id="${descId}"` : ""}>${desc}</div>
        ${extra}
      </div>
      <div class="row-actions">${actions}</div>
    </div>`;
}

/**
 * One titled block of the panel. Sections are the panel's spine: every store
 * uses the same order, and the search hides a section whose rows all filtered
 * out instead of leaving an empty caption behind.
 */
function group(iconName: IconName, title: string, body: string, tone = ""): string {
  return `
    <section class="manage-group${tone ? ` ${tone}` : ""}">
      <h3 class="manage-group-title">${icon(iconName, 14)} ${title}</h3>
      <div class="list">${body}</div>
    </section>`;
}

/** Class that hides a row or a section while the search box filters. */
const MANAGE_HIDE = "manage-hide";

/**
 * Filters the panel the way Settings does: every row matches on its own text,
 * empty sections disappear with their rows, and when nothing matches the panel
 * says so instead of looking empty.
 */
function applyManageSearch(query: string): void {
  const body = document.querySelector<HTMLElement>(".manage-body");
  if (!body) return;
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let visible = 0;
  body.querySelectorAll<HTMLElement>(".row[data-search]").forEach((line) => {
    const text = (line.dataset.search ?? "").toLowerCase();
    const match = tokens.length === 0 || tokens.every((token) => text.includes(token));
    line.classList.toggle(MANAGE_HIDE, !match);
    if (match) visible += 1;
  });
  body.querySelectorAll<HTMLElement>(".manage-group").forEach((section) => {
    const any = Array.from(section.querySelectorAll<HTMLElement>(".row[data-search]")).some(
      (line) => !line.classList.contains(MANAGE_HIDE),
    );
    section.classList.toggle(MANAGE_HIDE, tokens.length > 0 && !any);
  });
  const empty = document.getElementById("manage-search-empty");
  if (empty) empty.hidden = tokens.length === 0 || visible > 0;
}

let manageSearchWired = false;

/** Opens or closes the header's search field; closing clears the filter. */
export function setManageSearchOpen(open: boolean): void {
  const head = document.querySelector<HTMLElement>(".manage-head");
  const input = document.getElementById("manage-search") as HTMLInputElement | null;
  head?.classList.toggle("searching", open);
  document.querySelector<HTMLElement>(".manage-search-toggle")?.setAttribute("aria-expanded", String(open));
  if (!input) return;
  if (open) {
    // The field animates open; focus once it has room to take the caret.
    window.setTimeout(() => input.focus(), 80);
    return;
  }
  input.value = "";
  applyManageSearch("");
}

/** True while the header's search field is open. */
export function manageSearchOpen(): boolean {
  return Boolean(document.querySelector(".manage-head.searching"));
}

/** Binds the panel's search box once; every later open reuses the listener. */
function wireManageSearch(): void {
  if (manageSearchWired) return;
  manageSearchWired = true;
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "manage-search") return;
    applyManageSearch(input.value);
  });
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
  wireManageSearch();
  manageRoot.innerHTML = `
    <div class="manage-overlay" data-act="manage-overlay-close">
      <div class="manage-dialog">
        <div class="manage-head">
          <div class="manage-head-text">
            <h2>${t("drawer.manage")}</h2>
            <div class="manage-head-sub">${esc(s.title)}</div>
          </div>
          <div class="manage-search" id="manage-search-wrap">
            ${icon("search", 13)}
            <input id="manage-search" class="input" type="text" placeholder="${esc(t("manage.searchPlaceholder"))}" spellcheck="false" autocomplete="off" />
          </div>
          <button class="icon-btn manage-search-toggle" data-act="manage-search-toggle" title="${esc(t("manage.searchTitle"))}" aria-expanded="false">${icon("search", 15)}</button>
          <button class="manage-head-close" data-act="close-manage-popup" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>
        <div class="manage-body">${renderDrawerManage(s)}</div>
        <div class="manage-search-empty" id="manage-search-empty" hidden>${esc(t("manage.searchEmpty"))}</div>
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

/**
 * The hours each store recorded for this title. A game played through Xbox Game
 * Pass and Steam at the same time showed one number and hid the other, so the
 * total now names its parts. Silence when only one store has anything.
 */
/** Every store copy of this title with a recorded time, the game's own copy first. */
function playtimeSources(appName: string, title: string): Array<{ label: string; seconds: number }> {
  const rows: Array<{ label: string; seconds: number }> = [];
  const seen = new Set<string>([appName]);
  const own = S.playtimeMap.get(appName);
  if (own?.total_seconds) {
    rows.push({ label: storeVersionLabel(sourceOfKey(appName)), seconds: own.total_seconds });
  }
  for (const key of storeKeysForTitle(title)) {
    if (seen.has(key)) continue;
    seen.add(key);
    const record = S.playtimeMap.get(key);
    if (!record?.total_seconds) continue;
    rows.push({ label: storeVersionLabel(sourceOfKey(key)), seconds: record.total_seconds });
  }
  return rows;
}

/**
 * The seconds every copy of this title has recorded, added up.
 *
 * The breakdown under this number lists each store's own time, so the number
 * above it has to be their sum. It used to be the current copy's time alone,
 * which put "Total Playtime: 134 h" right above "Steam 134 h · Epic Games
 * 316 h" — a card that contradicts itself.
 */
function playtimeTotalLabel(appName: string, title: string): string {
  const total = playtimeSources(appName, title).reduce((sum, entry) => sum + entry.seconds, 0);
  return total > 0 ? fmtPlaytime(total) : t("playtime.notPlayed");
}

function playtimeBreakdownHtml(appName: string, title: string): string {
  const rows = playtimeSources(appName, title);
  if (rows.length < 2) return "";
  return `<div class="mg-info">${icon("clock", 12)} ${rows
    .map((entry) => `${esc(entry.label)} ${esc(fmtPlaytime(entry.seconds))}`)
    .join(" · ")}</div>`;
}

/** Renders the Manage tab for an installed game. */
/** Manage panel for a game owned by EA, Ubisoft, Xbox, Battle.net or Riot. */
function companionManageBody(s: EpicSummary, source: GameSource): string {
  const brand = source === "ea" ? "EA App" : source === "ubisoft" ? "Ubisoft Connect" : source === "xbox" ? "Xbox" : source === "riot" ? "Riot Client" : "Battle.net";
  const pt = S.playtimeMap.get(s.appName);
  const playtime = playtimeTotalLabel(s.appName, s.title);
  const files = s.installed
    ? row(
        t("manage.installLocation"),
        `<span id="manage-install-path" class="mg-path">${esc(s.installPath || t("manage.unspecified"))}</span>`,
        `<button class="btn ghost small" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`,
      )
    : row(
        t("common.install"),
        t("accounts.companionManagedDesc", { name: brand }),
        `<button class="btn primary small" data-act="companion-install" data-id="${s.appName}" data-store="${source}">${icon("download", 13)} ${t("common.install")}</button>`,
      );
  return `
    <div class="manage-tab-content">
      ${group("folder", t("manage.groupFiles"), files)}
      ${group("image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
        `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}
      ${group("clock", t("manage.groupPlaytime"), row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtime)}</span>`, "", "", playtimeBreakdownHtml(s.appName, s.title)))}
      ${group("eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
        `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}
      ${s.installed ? `<div class="list mg-danger">
        ${row(t("manage.uninstallTitle"), t("accounts.companionUninstallDesc", { name: brand }),
          `<button class="btn danger small" data-act="companion-uninstall" data-id="${s.appName}" data-store="${source}">${icon("trash", 13)} ${t("common.uninstall")}</button>`)}
      </div>` : ""}
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
  const playtime = playtimeTotalLabel(s.appName, s.title);
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
    ? group("cloud", t("manage.groupSaves"), `
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
      `)
    : "";
  return `
    <div class="manage-tab-content">
      ${group("folder", t("manage.groupFiles"), files)}
      ${saves}
      ${group("image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
        `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}
      ${s.installed ? group("play", t("manage.groupLaunch"), `
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
      `) : ""}
      ${group("clock", t("manage.groupPlaytime"), row(`${t("manage.totalPlaytime")}: <span id="manage-playtime-val" class="tabular-nums">${esc(playtime)}</span>`,
        pt?.session_count ? t("manage.sessionMeta", { count: pt.session_count, last: esc(lastPlayedLabel(pt.last_played)) }) : t("manage.noSession"),
          `<button class="btn ghost small" data-act="open-edit-playtime" data-id="${s.appName}">${icon("edit", 13)} ${t("manage.editTime")}</button>`,
          playtimeBreakdownHtml(s.appName, s.title), "manage-playtime-meta"))}
      ${group("eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
        `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}
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
    const playtimeSteam = playtimeTotalLabel(s.appName, s.title);
    // An owned-but-not-installed Steam game has no files of ours to manage:
    // the panel only hands the install request to the client.
    if (!s.installed) {
      return `
        <div class="manage-tab-content">
          ${group("folder", t("manage.groupFiles"), row(t("steam.managedBy"), t("steam.managedByDesc"),
            `<button class="btn primary small" data-act="steam-action" data-id="${steamId}" data-mode="install">${icon("download", 13)} ${t("common.install")}</button>`))}
          ${group("cloud", t("manage.groupSaves"), `
            <div class="row mg-row stack mg-callout">
              <div class="mg-title">${icon("cloud", 14)} ${t("steam.cloudNoticeTitle")}</div>
              <div class="mg-desc">${t("steam.cloudNoticeDesc")}</div>
              <div class="mg-inline" style="margin-top: 8px;">
                <button class="btn ghost small" data-view="settings" data-settings-section="integrations">${icon("settings", 13)} ${t("cloud.openSettings")}</button>
              </div>
            </div>
            <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(s.appName)}</div>
          `)}
          ${group("image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
            `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}
          ${group("clock", t("manage.groupPlaytime"), row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtimeSteam)}</span>`, playtimeSources(s.appName, s.title).length > 1 ? t("manage.playtimeAllCopies") : t("steam.playtimeSource"), "", playtimeBreakdownHtml(s.appName, s.title)))}
          ${group("eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
            `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}
        </div>`;
    }
    return `
      <div class="manage-tab-content">
        ${group("folder", t("manage.groupFiles"), `
          ${row(t("steam.managedBy"), t("steam.managedByDesc"), "")}
          ${row(t("manage.installLocation"), `<span id="manage-install-path" class="mg-path">${esc(s.installPath || t("manage.unspecified"))}</span>`,
            `<button class="btn ghost small" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`)}
          ${row(t("manage.verifyTitle"), t("steam.verifyDesc"),
            `<button class="btn ghost small" data-act="steam-action" data-id="${steamId}" data-mode="validate">${icon("shield", 13)} ${t("steam.validate")}</button>`)}
        `)}

        ${group("cloud", t("manage.groupSaves"), `
          <div class="row mg-row stack mg-callout">
            <div class="mg-title">${icon("cloud", 14)} ${t("steam.cloudNoticeTitle")}</div>
            <div class="mg-desc">${t("steam.cloudNoticeDesc")}</div>
            <div class="mg-inline" style="margin-top: 8px;">
              <button class="btn ghost small" data-view="settings" data-settings-section="integrations">${icon("settings", 13)} ${t("cloud.openSettings")}</button>
            </div>
          </div>
          <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(s.appName)}</div>
        `)}

        ${group("image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
          `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}

        ${group("clock", t("manage.groupPlaytime"), row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtimeSteam)}</span>`, t("steam.playtimeSource"), "", playtimeBreakdownHtml(s.appName, s.title)))}

        ${group("eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
          `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}

        <div class="list mg-danger">
          ${row(t("manage.dangerTitle"), t("steam.uninstallDesc"),
            `<button class="btn danger small" data-act="steam-action" data-id="${steamId}" data-mode="uninstall">${icon("trash", 13)} ${t("steam.uninstall")}</button>`)}
        </div>
      </div>`;
  }

  if (s.appName.startsWith("gog::")) {
    const ptGog = S.playtimeMap.get(s.appName);
    const playtimeGog = playtimeTotalLabel(s.appName, s.title);
    return `
      <div class="manage-tab-content">
        ${group("folder", t("manage.groupFiles"), `
          ${row(t("gog.managedBy"), t("gog.managedByDesc"), "")}
          ${row(t("manage.installLocation"), `<span id="manage-install-path" class="mg-path">${esc(s.installPath || t("manage.unspecified"))}</span>`,
            `<button class="btn ghost small" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`)}
          ${s.installed ? row(t("manage.verifyTitle"), t("manage.verifyDesc"),
            `<button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${s.appName}">${icon("shield", 13)} ${t("manage.verify")}</button>`,
            `<div id="manage-verify-box-container"></div>`) : ""}
        `)}
        ${group("cloud", t("manage.groupSaves"), `
          <div class="row mg-row stack mg-callout">
            <div class="mg-title">${icon("cloud", 14)} ${t("gog.cloudNoticeTitle")}</div>
            <div class="mg-desc">${t("gog.cloudNoticeDesc")}</div>
            <div class="mg-inline" style="margin-top: 8px;">
              <button class="btn ghost small" data-view="settings" data-settings-section="integrations">${icon("settings", 13)} ${t("cloud.openSettings")}</button>
            </div>
          </div>
          <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(s.appName)}</div>
        `)}
        ${group("image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
          `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}
        ${group("clock", t("manage.groupPlaytime"), row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtimeGog)}</span>`, "", "", playtimeBreakdownHtml(s.appName, s.title)))}
        ${group("eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
          `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}
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
  const playtimeStr = playtimeTotalLabel(s.appName, s.title);
  const cloudDesc = S.manageSyncingSaves || S.cloudSyncProgress.has(id)
    ? t("manage.syncing")
    : st.lastCloudSync ? t("manage.lastSync", { time: esc(formatSyncStamp(st.lastCloudSync)) }) : t("manage.cloudDesc");

  const moveBtn = blockedMove
    ? `<button class="btn ghost small disabled-hint" data-act="blocked-move-tp" data-id="${id}" data-partner="${esc(partner?.name || "Third-Party")}" title="${esc(t("manage.moveThirdPartyTip", { name: partner?.name || "Third-Party" }))}">${icon("hard-drive", 13)} ${t("manage.move")}</button>`
    : `<button class="btn ghost small" data-act="open-move-game-modal" data-id="${id}" title="${t("manage.moveTitle")}">${icon("hard-drive", 13)} ${t("manage.move")}</button>`;

  return `
    <div class="manage-tab-content">
      ${s.installed ? group("folder", t("manage.groupFiles"), `
        ${row(t("manage.verifyTitle"), t("manage.verifyDesc"),
          `<button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${id}" ${v ? "disabled" : ""}>${v ? t("manage.verifying") : t("manage.verify")}</button>`,
          `<div id="manage-verify-box-container">${v ? verifyBox(v.percent, v.detail || `${v.current}/${v.total}`, v.speed) : ""}</div>`)}
        ${row(t("manage.installLocation"), `<span id="manage-install-path" class="mg-path">${esc(s.installPath || st.installPath || t("manage.unspecified"))}</span>`,
          `${moveBtn}<button class="btn ghost small" data-act="epic-open-folder" data-id="${id}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`,
          blockedMove ? `<div class="mg-note">${icon("info", 12)} ${t("manage.moveThirdPartyWarning", { name: esc(partner!.name) })}</div>` : "")}
        ${row(t("manage.shortcutTitle"), t("manage.shortcutDesc"),
          `<button class="btn ghost small" data-act="manage-create-shortcut" data-id="${id}">${t("manage.createShortcut")}</button>`)}
      `) : ""}

      ${s.installed ? group("cloud", t("manage.groupSaves"), `
        ${partnerSaves
          ? row(t("manage.eosCloudTitle"), t("manage.partnerSaves", { name: partner!.name }), "")
          : `${row(t("manage.eosCloudTitle"), cloudDesc,
              `<button class="btn ghost small" data-act="manage-sync-saves" data-id="${id}" title="${t("manage.syncNow")}" ${S.manageSyncingSaves ? "disabled" : ""}>${icon("refresh", 13)} ${t("manage.sync")}</button>${toggle("manage-toggle-cloud", st.cloudSavesEnabled)}`,
              `<div class="mg-info">${icon("info", 12)} ${t("manage.eosCloudNotice")}</div>${syncProgressHtml(id)}${mtuIssueHtml()}`, "manage-cloud-subtitle")}
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
      `) : ""}

      ${group("image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
        `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${id}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}

      ${s.installed ? group("play", t("manage.groupLaunch"), `
        ${row(t("manage.autoUpdateTitle"), t("manage.autoUpdateDesc"), toggle("manage-toggle-autoupdate", st.autoUpdate))}
        ${row(t("manage.priorityTitle"), t("manage.priorityDesc"), toggle("manage-toggle-priority", st.highPriority))}
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
      `) : ""}

      ${group("clock", t("manage.groupPlaytime"), `
        ${row(`${t("manage.totalPlaytime")}: <span id="manage-playtime-val" class="tabular-nums">${esc(playtimeStr)}</span>`,
          pt?.session_count ? t("manage.sessionMeta", { count: pt.session_count, last: esc(lastPlayedLabel(pt.last_played)) }) : t("manage.noSession"),
          `<button class="btn ghost small" data-act="open-edit-playtime" data-id="${id}">${icon("edit", 13)} ${t("manage.editTime")}</button>`,
          playtimeBreakdownHtml(id, s.title), "manage-playtime-meta")}
        <div class="row mg-row stack mg-callout">
          <div class="mg-title">${t("manage.epicDataTitle")}</div>
          <div class="mg-desc">${t("manage.epicDataP1")}</div>
          <div class="mg-desc">${t("manage.epicDataP2")}</div>
        </div>
      `)}

      ${group("eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
        `<button class="btn ghost small" data-act="hide-game" data-id="${id}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}

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

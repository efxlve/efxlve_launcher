/**
 * Game page "Manage" tab: markup plus the in-place DOM updates used while it is
 * open (settings sync, verify progress and reset). State lives in S.
 */

import { manageRoot } from "../../core/dom";
import { icon, type IconName } from "../../core/icons";
import { IS_WINDOWS } from "../../core/platform";
import { lastPlayedLabel, rawOf, sourceOfKey, storeKeysForTitle, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";
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

/** Left-rail sections of the manage panel. */
type ManageTab = "files" | "saves" | "cover" | "launch" | "playtime" | "library" | "danger";

/**
 * One titled block of the panel. Every group is also a tab: the rail switches
 * between them, and the search can temporarily show every matching group at
 * once. The title is repeated in the header, so the in-body caption only
 * appears while that search mixes sections.
 */
function group(tab: ManageTab, iconName: IconName, title: string, body: string, nav = ""): string {
  return `
    <section class="manage-group" data-tab="${tab}" data-title="${esc(title)}" data-nav="${esc(nav)}" data-icon="${iconName}" id="manage-panel-${tab}" role="tabpanel">
      <h3 class="manage-group-title">${icon(iconName, 14)} ${title}</h3>
      <div class="list">${body}</div>
    </section>`;
}

/** Removal lives in its own tab; the rail says it in one word. */
function dangerGroup(body: string): string {
  const title = t("manage.dangerTitle");
  return `
    <section class="manage-group" data-tab="danger" data-title="${esc(title)}" data-nav="${esc(t("common.uninstall"))}" data-icon="trash" id="manage-panel-danger" role="tabpanel">
      <h3 class="manage-group-title">${icon("trash", 14)} ${title}</h3>
      <div class="list mg-danger">${body}</div>
    </section>`;
}

/** Disk size of the installed copy, shown with the files it describes. */
function installSizeRow(size: number, installed: boolean): string {
  if (!installed || !size || size <= 0) return "";
  return row(
    t("feat.installedSize"),
    "",
    `<span class="mg-size-value tabular-nums">${esc(fmtBytes(size))}</span>`,
  );
}

/** Class that hides a row or a section while the search box filters. */
const MANAGE_HIDE = "manage-hide";

/**
 * Switches the panel to one rail section. The body keeps every group in the
 * DOM, so verification progress, backup lists and settings inputs survive a
 * tab change without a re-render.
 */
export function setManageTab(tab: string): void {
  const dialog = document.querySelector<HTMLElement>(".manage-dialog");
  if (!dialog) return;
  const sections = Array.from(dialog.querySelectorAll<HTMLElement>(".manage-group[data-tab]"));
  if (!sections.length) return;
  // A tab choice is a way out of mixed search results.
  if (manageSearchOpen()) setManageSearchOpen(false);
  const target = sections.find((section) => section.dataset.tab === tab) ?? sections[0];

  sections.forEach((section) => section.classList.toggle("is-active", section === target));
  dialog.querySelectorAll<HTMLElement>(".manage-nav-item").forEach((item) => {
    const active = item.dataset.tab === target.dataset.tab;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
  });

  if (!dialog.classList.contains("manage-searching")) {
    const title = document.getElementById("manage-section-title");
    if (title) {
      title.textContent = target.dataset.title ?? "";
      title.title = target.dataset.title ?? "";
    }
    const iconEl = document.getElementById("manage-section-icon");
    if (iconEl) iconEl.innerHTML = icon(target.dataset.icon as IconName, 17);
  }
  const body = dialog.querySelector<HTMLElement>(".manage-body");
  if (body) body.scrollTop = 0;
}

/** Reads the section the panel is showing, for the search header. */
function activeManageTitle(): string {
  const active = document.querySelector<HTMLElement>(".manage-group.is-active[data-tab]");
  return active?.dataset.title ?? "";
}

/** Icon of the open section; search swaps it for the magnifier. */
function activeManageIcon(): IconName {
  const active = document.querySelector<HTMLElement>(".manage-group.is-active[data-tab]");
  return (active?.dataset.icon as IconName) || "sliders";
}

/**
 * Filters the panel the way Settings does: every row matches on its own text,
 * empty sections disappear with their rows, and when nothing matches the panel
 * says so instead of looking empty. A non-empty query breaks out of the active
 * tab and shows every matching section, so searching never depends on which
 * rail item happens to be open.
 */
function applyManageSearch(query: string): void {
  const dialog = document.querySelector<HTMLElement>(".manage-dialog");
  const body = dialog?.querySelector<HTMLElement>(".manage-body");
  if (!dialog || !body) return;
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  body.scrollTop = 0;
  let visible = 0;
  body.querySelectorAll<HTMLElement>(".row[data-search]").forEach((line) => {
    const text = (line.dataset.search ?? "").toLowerCase();
    const match = tokens.length === 0 || tokens.every((token) => text.includes(token));
    line.classList.toggle(MANAGE_HIDE, !match);
    if (match) visible += 1;
  });
  body.querySelectorAll<HTMLElement>(".manage-group[data-tab]").forEach((section) => {
    const any = Array.from(section.querySelectorAll<HTMLElement>(".row[data-search]")).some(
      (line) => !line.classList.contains(MANAGE_HIDE),
    );
    section.classList.toggle(MANAGE_HIDE, tokens.length > 0 && !any);
  });
  dialog.classList.toggle("manage-searching", tokens.length > 0);
  const empty = document.getElementById("manage-search-empty");
  if (empty) empty.hidden = tokens.length === 0 || visible > 0;
  const title = document.getElementById("manage-section-title");
  if (title) {
    const heading = tokens.length > 0 ? t("manage.searchTitle") : activeManageTitle();
    title.textContent = heading;
    title.title = tokens.length > 0 ? "" : heading;
  }
  const iconEl = document.getElementById("manage-section-icon");
  if (iconEl) iconEl.innerHTML = icon(tokens.length > 0 ? "search" : activeManageIcon(), 17);
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
  const source = sourceOfKey(appName);
  const companion = source !== "epic" && source !== "gog" && source !== "steam" && source !== "amazon";
  wireManageSearch();
  manageRoot.innerHTML = `
    <div class="manage-overlay" data-act="manage-overlay-close">
      <div class="manage-dialog" role="dialog" aria-modal="true" aria-label="${esc(t("drawer.manage"))}: ${esc(s.title)}">
        <aside class="manage-side">
          <div class="manage-side-head">
            <div class="manage-side-title" id="manage-side-title">${esc(s.title)}</div>
            <div class="manage-side-sub">
              <span>${esc(storeVersionLabel(source))}</span>
              <span class="manage-side-state${s.installed ? " is-installed" : ""}">
                <span class="manage-side-dot"></span>
                ${s.installed ? esc(t("common.installed")) : esc(t("common.notInstalled"))}
              </span>
            </div>
          </div>
          <nav class="manage-nav" role="tablist" aria-orientation="vertical" aria-label="${esc(t("drawer.manage"))}"></nav>
        </aside>
        <div class="manage-main">
          <div class="manage-head">
            <div class="manage-head-title">
              <span class="manage-head-icon" id="manage-section-icon" aria-hidden="true"></span>
              <h2 id="manage-section-title"></h2>
            </div>
            <div class="manage-head-actions">
              <div class="manage-search" id="manage-search-wrap">
                ${icon("search", 13)}
                <input id="manage-search" class="input" type="text" placeholder="${esc(t("manage.searchPlaceholder"))}" spellcheck="false" autocomplete="off" />
              </div>
              <button class="icon-btn manage-search-toggle" data-act="manage-search-toggle" title="${esc(t("manage.searchTitle"))}" aria-expanded="false">${icon("search", 15)}</button>
              <button class="manage-head-close" data-act="close-manage-popup" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
            </div>
          </div>
          <div class="manage-body">
            <div class="manage-search-empty" id="manage-search-empty" hidden>${esc(t("manage.searchEmpty"))}</div>
            ${renderDrawerManage(s)}
          </div>
        </div>
      </div>
    </div>`;

  // The rail is built from the groups this store actually rendered, so an
  // uninstalled game or a companion title never shows a tab it cannot fill.
  const body = manageRoot.querySelector<HTMLElement>(".manage-body");
  const nav = manageRoot.querySelector<HTMLElement>(".manage-nav");
  const sections = Array.from(body?.querySelectorAll<HTMLElement>(".manage-group[data-tab]") ?? []);
  if (nav) {
    nav.innerHTML = sections
      .map((section) => {
        const tab = section.dataset.tab ?? "";
        const label = section.dataset.nav || section.dataset.title || "";
        const iconName = (section.dataset.icon as IconName) || "sliders";
        return `<button type="button" class="manage-nav-item" role="tab" id="manage-tab-${esc(tab)}" data-act="manage-tab" data-tab="${esc(tab)}" aria-controls="manage-panel-${esc(tab)}" aria-selected="false" tabindex="-1" title="${esc(label)}"><span class="manage-nav-icon">${icon(iconName, 16)}</span><span class="manage-nav-label">${esc(label)}</span></button>`;
      })
      .join("");
    sections.forEach((section) => {
      section.setAttribute("aria-labelledby", `manage-tab-${section.dataset.tab ?? ""}`);
    });
    wireManageNavKeys(nav);
  }
  setManageTab(sections[0]?.dataset.tab ?? "");

  // Ensure cloud settings and backups are hydrated when the popup opens.
  // Companion games have no cloud saves here, so the fetch is skipped.
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

/** Arrow keys move between tabs, as they do in any vertical tab list. */
function wireManageNavKeys(nav: HTMLElement): void {
  nav.addEventListener("keydown", (event) => {
    const items = Array.from(nav.querySelectorAll<HTMLButtonElement>(".manage-nav-item"));
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    const target = items[next];
    setManageTab(target.dataset.tab ?? "");
    target.focus();
  });
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
      ${group("files", "folder", t("manage.groupFiles"), `${files}${installSizeRow(s.installSize, s.installed)}`)}
      ${group("cover", "image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
        `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}
      ${group("playtime", "clock", t("manage.groupPlaytime"), row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtime)}</span>`, "", "", playtimeBreakdownHtml(s.appName, s.title)), t("manage.totalPlaytime"))}
      ${group("library", "eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
        `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}
      ${s.installed ? dangerGroup(row(t("manage.uninstallTitle"), t("accounts.companionUninstallDesc", { name: brand }),
        `<button class="btn danger small" data-act="companion-uninstall" data-id="${s.appName}" data-store="${source}">${icon("trash", 13)} ${t("common.uninstall")}</button>`)) : ""}
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
        `${
          IS_WINDOWS
            ? `<button class="btn ghost small" data-act="open-move-game-modal" data-id="${s.appName}" title="${t("manage.moveTitle")}">${icon("hard-drive", 13)} ${t("manage.move")}</button>`
            : ""
        }
         <button class="btn ghost small" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`,
      )}
      ${IS_WINDOWS
        ? row(
            t("manage.shortcutTitle"),
            t("manage.shortcutDesc"),
            `<button class="btn ghost small" data-act="manage-create-shortcut" data-id="${s.appName}">${t("manage.createShortcut")}</button>`,
          )
        : ""}`
    : row(
        t("common.install"),
        t("amazon.managedDesc"),
        `<button class="btn primary small" data-act="amazon-install" data-id="${esc(id)}">${icon("download", 13)} ${t("common.install")}</button>
         <button class="btn ghost small" data-act="amazon-import" data-id="${esc(id)}" title="${t("amazon.importDesc")}">${icon("folder", 13)} ${t("amazon.importTitle")}</button>`,
      );
  const saves = s.installed
    ? group("saves", "cloud", t("manage.groupSaves"), `
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
      ${group("files", "folder", t("manage.groupFiles"), `${files}${installSizeRow(st.installSize || s.installSize, s.installed)}`)}
      ${saves}
      ${group("cover", "image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
        `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}
      ${s.installed ? group("launch", "play", t("manage.groupLaunch"), `
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
      ${group("playtime", "clock", t("manage.groupPlaytime"), row(`${t("manage.totalPlaytime")}: <span id="manage-playtime-val" class="tabular-nums">${esc(playtime)}</span>`,
        pt?.session_count ? t("manage.sessionMeta", { count: pt.session_count, last: esc(lastPlayedLabel(pt.last_played)) }) : t("manage.noSession"),
          `<button class="btn ghost small" data-act="open-edit-playtime" data-id="${s.appName}">${icon("edit", 13)} ${t("manage.editTime")}</button>`,
          playtimeBreakdownHtml(s.appName, s.title), "manage-playtime-meta"), t("manage.totalPlaytime"))}
      ${group("library", "eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
        `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}
      ${s.installed ? dangerGroup(row(t("manage.dangerTitle"), t("amazon.uninstallDesc"),
        `<button class="btn danger small" data-act="amazon-uninstall" data-id="${esc(id)}">${icon("trash", 13)} ${t("manage.uninstallTitle")}</button>`)) : ""}
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
          ${group("files", "folder", t("manage.groupFiles"), row(t("steam.managedBy"), t("steam.managedByDesc"),
            `<button class="btn primary small" data-act="steam-action" data-id="${steamId}" data-mode="install">${icon("download", 13)} ${t("common.install")}</button>`))}
          ${group("saves", "cloud", t("manage.groupSaves"), `
            <div class="row mg-row stack mg-callout">
              <div class="mg-title">${icon("cloud", 14)} ${t("steam.cloudNoticeTitle")}</div>
              <div class="mg-desc">${t("steam.cloudNoticeDesc")}</div>
              <div class="mg-inline" style="margin-top: 8px;">
                <button class="btn ghost small" data-view="settings" data-settings-section="cloud">${icon("settings", 13)} ${t("cloud.openSettings")}</button>
              </div>
            </div>
            <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(s.appName)}</div>
          `)}
          ${group("cover", "image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
            `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}
          ${group("playtime", "clock", t("manage.groupPlaytime"), row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtimeSteam)}</span>`, playtimeSources(s.appName, s.title).length > 1 ? t("manage.playtimeAllCopies") : t("steam.playtimeSource"), "", playtimeBreakdownHtml(s.appName, s.title)), t("manage.totalPlaytime"))}
          ${group("library", "eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
            `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}
        </div>`;
    }
    return `
      <div class="manage-tab-content">
        ${group("files", "folder", t("manage.groupFiles"), `
          ${row(t("steam.managedBy"), t("steam.managedByDesc"), "")}
          ${row(t("manage.installLocation"), `<span id="manage-install-path" class="mg-path">${esc(s.installPath || t("manage.unspecified"))}</span>`,
            `<button class="btn ghost small" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`)}
          ${installSizeRow(s.installSize, s.installed)}
          ${row(t("manage.verifyTitle"), t("steam.verifyDesc"),
            `<button class="btn ghost small" data-act="steam-action" data-id="${steamId}" data-mode="validate">${icon("shield", 13)} ${t("steam.validate")}</button>`)}
        `)}

        ${group("saves", "cloud", t("manage.groupSaves"), `
          <div class="row mg-row stack mg-callout">
            <div class="mg-title">${icon("cloud", 14)} ${t("steam.cloudNoticeTitle")}</div>
            <div class="mg-desc">${t("steam.cloudNoticeDesc")}</div>
            <div class="mg-inline" style="margin-top: 8px;">
              <button class="btn ghost small" data-view="settings" data-settings-section="cloud">${icon("settings", 13)} ${t("cloud.openSettings")}</button>
            </div>
          </div>
          <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(s.appName)}</div>
        `)}

        ${group("cover", "image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
          `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}

        ${group("playtime", "clock", t("manage.groupPlaytime"), row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtimeSteam)}</span>`, t("steam.playtimeSource"), "", playtimeBreakdownHtml(s.appName, s.title)), t("manage.totalPlaytime"))}

        ${group("library", "eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
          `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}

        ${dangerGroup(row(t("manage.dangerTitle"), t("steam.uninstallDesc"),
          `<button class="btn danger small" data-act="steam-action" data-id="${steamId}" data-mode="uninstall">${icon("trash", 13)} ${t("steam.uninstall")}</button>`))}
      </div>`;
  }

  if (s.appName.startsWith("gog::")) {
    const ptGog = S.playtimeMap.get(s.appName);
    const playtimeGog = playtimeTotalLabel(s.appName, s.title);
    return `
      <div class="manage-tab-content">
        ${group("files", "folder", t("manage.groupFiles"), `
          ${row(t("gog.managedBy"), t("gog.managedByDesc"), "")}
          ${row(t("manage.installLocation"), `<span id="manage-install-path" class="mg-path">${esc(s.installPath || t("manage.unspecified"))}</span>`,
            `<button class="btn ghost small" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`)}
          ${installSizeRow(s.installSize, s.installed)}
          ${s.installed ? row(t("manage.verifyTitle"), t("manage.verifyDesc"),
            `<button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${s.appName}">${icon("shield", 13)} ${t("manage.verify")}</button>`,
            `<div id="manage-verify-box-container"></div>`) : ""}
        `)}
        ${group("saves", "cloud", t("manage.groupSaves"), `
          <div class="row mg-row stack mg-callout">
            <div class="mg-title">${icon("cloud", 14)} ${t("gog.cloudNoticeTitle")}</div>
            <div class="mg-desc">${t("gog.cloudNoticeDesc")}</div>
            <div class="mg-inline" style="margin-top: 8px;">
              <button class="btn ghost small" data-view="settings" data-settings-section="cloud">${icon("settings", 13)} ${t("cloud.openSettings")}</button>
            </div>
          </div>
          <div id="manage-cloud-container" class="manage-cloud-container">${renderManageCloudBackupRow(s.appName)}</div>
        `)}
        ${group("cover", "image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
          `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${s.appName}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}
        ${group("playtime", "clock", t("manage.groupPlaytime"), row(`${t("manage.totalPlaytime")}: <span class="tabular-nums">${esc(playtimeGog)}</span>`, "", "", playtimeBreakdownHtml(s.appName, s.title)), t("manage.totalPlaytime"))}
        ${group("library", "eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
          `<button class="btn ghost small" data-act="hide-game" data-id="${s.appName}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}
        ${s.installed ? dangerGroup(row(t("manage.dangerTitle"), t("manage.dangerDesc"),
          `<button class="btn danger small" data-act="epic-uninstall" data-id="${s.appName}">${icon("trash", 13)} ${t("common.uninstall")}</button>`)) : ""}
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

  const moveBtn = !IS_WINDOWS
    ? ""
    : blockedMove
      ? `<button class="btn ghost small disabled-hint" data-act="blocked-move-tp" data-id="${id}" data-partner="${esc(partner?.name || "Third-Party")}" title="${esc(t("manage.moveThirdPartyTip", { name: partner?.name || "Third-Party" }))}">${icon("hard-drive", 13)} ${t("manage.move")}</button>`
      : `<button class="btn ghost small" data-act="open-move-game-modal" data-id="${id}" title="${t("manage.moveTitle")}">${icon("hard-drive", 13)} ${t("manage.move")}</button>`;

  return `
    <div class="manage-tab-content">
      ${s.installed ? group("files", "folder", t("manage.groupFiles"), `
        ${row(t("manage.verifyTitle"), t("manage.verifyDesc"),
          `<button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${id}" ${v ? "disabled" : ""}>${v ? t("manage.verifying") : t("manage.verify")}</button>`,
          `<div id="manage-verify-box-container">${v ? verifyBox(v.percent, v.detail || `${v.current}/${v.total}`, v.speed) : ""}</div>`)}
        ${row(t("manage.installLocation"), `<span id="manage-install-path" class="mg-path">${esc(s.installPath || st.installPath || t("manage.unspecified"))}</span>`,
          `${moveBtn}<button class="btn ghost small" data-act="epic-open-folder" data-id="${id}">${icon("folder", 13)} ${t("manage.openFolder")}</button>`,
          blockedMove ? `<div class="mg-note">${icon("info", 12)} ${t("manage.moveThirdPartyWarning", { name: esc(partner!.name) })}</div>` : "")}
        ${installSizeRow(st.installSize || s.installSize, s.installed)}
        ${IS_WINDOWS
          ? row(t("manage.shortcutTitle"), t("manage.shortcutDesc"),
              `<button class="btn ghost small" data-act="manage-create-shortcut" data-id="${id}">${t("manage.createShortcut")}</button>`)
          : ""}
      `) : ""}

      ${s.installed ? group("saves", "cloud", t("manage.groupSaves"), `
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

      ${group("cover", "image", t("manage.groupCover"), row(t("manage.coverTitle"), t("manage.coverDesc"),
        `<button class="btn ghost small" data-act="open-custom-cover" data-target="cover" data-id="${id}">${icon("image", 13)} ${t("manage.coverChange")}</button>`))}

      ${s.installed ? group("launch", "play", t("manage.groupLaunch"), `
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

      ${group("playtime", "clock", t("manage.groupPlaytime"), `
        ${row(`${t("manage.totalPlaytime")}: <span id="manage-playtime-val" class="tabular-nums">${esc(playtimeStr)}</span>`,
          pt?.session_count ? t("manage.sessionMeta", { count: pt.session_count, last: esc(lastPlayedLabel(pt.last_played)) }) : t("manage.noSession"),
          `<button class="btn ghost small" data-act="open-edit-playtime" data-id="${id}">${icon("edit", 13)} ${t("manage.editTime")}</button>`,
          playtimeBreakdownHtml(id, s.title), "manage-playtime-meta")}
        <div class="row mg-row stack mg-callout">
          <div class="mg-title">${t("manage.epicDataTitle")}</div>
          <div class="mg-desc">${t("manage.epicDataP1")}</div>
          <div class="mg-desc">${t("manage.epicDataP2")}</div>
        </div>
      `, t("manage.totalPlaytime"))}

      ${group("library", "eye-off", t("nav.library"), row(t("manage.hideTitle"), t("manage.hideDesc"),
        `<button class="btn ghost small" data-act="hide-game" data-id="${id}">${icon("eye-off", 13)} ${t("manage.hide")}</button>`))}

      ${s.installed ? dangerGroup(row(t("manage.dangerTitle"), t("manage.dangerDesc"),
        `<button class="btn danger small" data-act="epic-uninstall" data-id="${id}">${icon("trash", 13)} ${t("manage.uninstallTitle")}</button>`)) : ""}
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

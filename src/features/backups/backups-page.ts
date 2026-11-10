/**
 * Backups section inside Settings → Cloud Saves: every game with its latest
 * save archive, one screen. The actions live in `backups-handlers.ts`.
 */

import { icon } from "../../core/icons";
import { isRestoreSnapshotBackup } from "../../core/backup-utils";
import { scheduleRender } from "../../core/render";
import { summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { currentLanguage, t } from "../../i18n";
import { storeLogo } from "../store/store-logos";
import { epicBackupExcluded, epicListAllBackups, type SaveBackupInfo } from "../../epic";

/** A backup older than this is worth flagging, not deleting. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function storeLabel(key: string): string {
  if (key.startsWith("gog::")) return "GOG";
  if (key.startsWith("steam::")) return "Steam";
  if (key.startsWith("amazon::")) return "Amazon";
  if (key.startsWith("ubisoft::")) return "Ubisoft";
  if (key.startsWith("ea::")) return "EA";
  if (key.startsWith("xbox::")) return "Xbox";
  if (key.startsWith("battlenet::")) return "Battle.net";
  if (key.startsWith("riot::")) return "Riot Games";
  if (key.startsWith("custom::")) return t("backups.storeCustom");
  return "Epic";
}

/** Storefront id for the logo asset; Epic keys carry no prefix. */
function storeLogoId(key: string): string {
  if (key.startsWith("gog::")) return "gog";
  if (key.startsWith("steam::")) return "steam";
  if (key.startsWith("amazon::")) return "amazon";
  if (key.startsWith("ubisoft::")) return "ubisoft";
  if (key.startsWith("ea::")) return "ea";
  if (key.startsWith("xbox::")) return "xbox";
  if (key.startsWith("battlenet::")) return "battlenet";
  if (key.startsWith("riot::")) return "riot";
  if (key.startsWith("custom::")) return "custom";
  return "epic";
}

/** Installed games the launcher owns save backups for. */
function installedKeys(): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of S.allGamesMap.values()) {
    if (!item.installed) continue;
    if (
      !["epic", "gog", "amazon", "custom", "steam", "ubisoft", "ea", "xbox", "battlenet"].includes(
        item.source,
      )
    ) {
      continue;
    }
    const key = item.source === "epic" ? item.id : item.key;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export async function hydrateBackupsPage(force = false): Promise<void> {
  if (S.backupsPageLoading) return;
  if (!force && S.backupsPage) return;
  S.backupsPageLoading = true;
  try {
    const [list, excluded] = await Promise.all([epicListAllBackups(), epicBackupExcluded()]);
    S.backupsPage = { list, excluded: new Set(excluded) };
  } catch {
    S.backupsPage = { list: [], excluded: new Set() };
  } finally {
    S.backupsPageLoading = false;
    scheduleRender();
  }
}

function fmtDay(timestamp: number): string {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleDateString(currentLanguage(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function latestByKey(list: SaveBackupInfo[]): Map<string, SaveBackupInfo> {
  const map = new Map<string, SaveBackupInfo>();
  for (const info of list) {
    if (isRestoreSnapshotBackup(info.id)) continue;
    if (!map.has(info.app_name)) map.set(info.app_name, info);
  }
  return map;
}

function rowState(info: SaveBackupInfo | undefined): "backed" | "stale" | "missing" {
  if (!info) return "missing";
  return info.timestamp * 1000 < Date.now() - STALE_MS ? "stale" : "backed";
}

function matchesFilter(
  query: string,
  filter: string,
  title: string,
  key: string,
  state: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle && !`${title} ${key}`.toLowerCase().includes(needle)) return false;
  if (filter === "all") return true;
  // A stale archive is still a backup: "Backed up" includes it, and the
  // "Stale" filter narrows the same set further.
  if (filter === "backed") return state !== "missing";
  return filter === state;
}

/** Filters the already-rendered rows without rebuilding the page (keeps focus). */
export function applyBackupsDomFilter(): void {
  let visible = 0;
  for (const row of document.querySelectorAll<HTMLElement>(".bk-row[data-state]")) {
    const match = matchesFilter(
      S.backupsQuery,
      S.backupsFilter,
      row.dataset.title ?? "",
      row.dataset.key ?? "",
      row.dataset.state ?? "",
    );
    row.hidden = !match;
    if (match) visible += 1;
  }
  const empty = document.getElementById("backups-no-match");
  if (empty) empty.hidden = visible > 0;
}

export function renderBackupsSection(): string {
  if (S.backupsPage === null) {
    void hydrateBackupsPage();
  }
  const head = `
    <h3 class="section-title">${t("backups.title")}</h3>
    <div class="bk-section">
      <div class="bk-section-head">
        <div class="bk-sub">${t("backups.sub")}</div>
        <div class="bk-head-actions">
          ${S.cloudBulkProgress?.local
            ? `<span class="bk-stat-num tabular-nums">${S.cloudBulkProgress.done}/${S.cloudBulkProgress.total}</span>`
            : `<button type="button" class="btn ghost small" data-act="backups-refresh">${icon("refresh", 13)} ${t("backups.refresh")}</button>
               <button type="button" class="btn ghost small" data-act="backups-bulk">${icon("package", 13)} ${t("backups.backUpAll")}</button>`}
        </div>
      </div>`;

  if (S.backupsPage === null) {
    return `${head}<div class="bk-empty">${icon("refresh", 16, "spin")} ${t("backups.loading")}</div></div>`;
  }

  const { list, excluded } = S.backupsPage;
  const latest = latestByKey(list);
  const countByKey = new Map<string, number>();
  for (const info of list) {
    countByKey.set(info.app_name, (countByKey.get(info.app_name) ?? 0) + 1);
  }
  const installed = installedKeys();
  const installedSet = new Set(installed);
  const extra = [...latest.keys()].filter((key) => !installedSet.has(key));
  const keys = [...installed, ...extra];

  const withBackup = keys.filter((key) => latest.has(key)).length;
  const stale = keys.filter((key) => {
    const info = latest.get(key);
    return info ? info.timestamp * 1000 < Date.now() - STALE_MS : false;
  }).length;
  const totalBytes = keys.reduce((sum, key) => sum + (latest.get(key)?.size_bytes ?? 0), 0);

  const rows = keys
    .map((key) => {
      const info = latest.get(key);
      const summary = summaryOf(key);
      const title = info?.title || summary?.title || key;
      const isInstalled = installedSet.has(key);
      const isStale = info ? info.timestamp * 1000 < Date.now() - STALE_MS : false;
      const included = !excluded.has(key);
      const state = rowState(info);
      const matches = matchesFilter(S.backupsQuery, S.backupsFilter, title, key, state);
      const meta = info
        ? [
            esc(fmtDay(info.timestamp)),
            esc(fmtBytes(info.size_bytes)),
            `${info.file_count} ${t("ach.files")}`,
            info.label ? esc(info.label) : "",
            info.device ? esc(info.device) : "",
            info.origin_app_name
              ? t("backups.importedFrom", { store: storeLabel(info.origin_app_name) })
              : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : t("backups.never");
      const cover = summary?.cover
        ? `<img src="${esc(summary.cover)}" alt="" loading="lazy" />`
        : icon("package", 18);
      return `
        <div class="bk-row${isStale ? " stale" : ""}" data-title="${esc(title)}" data-key="${esc(key)}" data-state="${state}"${matches ? "" : " hidden"}>
          <div class="bk-cover">${cover}</div>
          <div class="bk-main">
            <div class="bk-title">
              <span class="bk-name">${esc(title)}</span>
              <span class="chip bk-store">${storeLogo(storeLogoId(key), 12, "bk-store-logo")}<span>${esc(storeLabel(key))}</span></span>
              ${isInstalled ? "" : `<span class="chip bk-store">${esc(t("backups.notInstalled"))}</span>`}
              ${isStale ? `<span class="bk-stale">${esc(t("backups.stale"))}</span>` : ""}
            </div>
            <div class="bk-meta tabular-nums"><span class="bk-status-dot ${info ? (isStale ? "is-stale" : "is-backed") : "is-missing"}"></span><span>${meta}</span></div>
          </div>
          <div class="bk-actions">
            ${isInstalled
              ? `<label class="bk-auto-toggle" title="${esc(t("manage.autoBackupTitle"))}">
                   <span class="bk-auto-label">${t("backups.autoLabel")}</span>
                   <span class="switch"><input type="checkbox" data-act="backups-toggle-include" data-id="${esc(key)}" aria-label="${esc(t("manage.autoBackupTitle"))}" ${included ? "checked" : ""} /><span class="track"></span></span>
                 </label>
                 <button type="button" class="btn ghost small" data-act="backups-create" data-id="${esc(key)}">${icon("package", 13)} ${esc(t("backups.backUp"))}</button>`
              : ""}
            ${info
              ? `<button type="button" class="btn ghost small icon-only" data-act="backups-verify" data-id="${esc(key)}" data-bid="${esc(info.id)}" title="${esc(t("backups.verify"))}" aria-label="${esc(t("backups.verify"))}">${icon("shield", 13)}</button>
                 <button type="button" class="btn ghost small" data-act="backups-export" data-id="${esc(key)}" data-bid="${esc(info.id)}">${icon("download", 13)} ${esc(t("backups.export"))}</button>
                 <button type="button" class="btn primary small" data-act="backups-restore" data-id="${esc(key)}" data-bid="${esc(info.id)}" ${isInstalled ? "" : "disabled"}>${icon("upload", 13)} ${esc(t("ach.restore"))}</button>
                 <button type="button" class="btn ghost small icon-only danger" data-act="backups-delete-all" data-id="${esc(key)}" data-count="${countByKey.get(key) ?? 1}" title="${esc(t("backups.deleteAllTip"))}" aria-label="${esc(t("backups.deleteAllTip"))}">${icon("trash", 13)}</button>`
              : `<button type="button" class="btn ghost small" data-act="backups-import" data-id="${esc(key)}">${icon("upload", 13)} ${esc(t("manage.importSave"))}</button>`}
          </div>
        </div>`;
    })
    .join("");

  const visibleCount = keys.filter((key) => {
    const info = latest.get(key);
    const title = info?.title || summaryOf(key)?.title || key;
    return matchesFilter(S.backupsQuery, S.backupsFilter, title, key, rowState(info));
  }).length;
  const filterCounts: Record<string, number> = {
    all: keys.length,
    backed: withBackup,
    missing: keys.length - withBackup,
    stale,
  };
  const filters: Array<["all" | "backed" | "missing" | "stale", string]> = [
    ["all", "backups.filterAll"],
    ["backed", "backups.filterBacked"],
    ["missing", "backups.filterMissing"],
    ["stale", "backups.filterStale"],
  ];
  const filterButtons = filters
    .map(
      ([id, label]) =>
        `<button type="button" class="bk-filter${S.backupsFilter === id ? " is-active" : ""}" data-act="backups-filter" data-filter="${id}" aria-pressed="${S.backupsFilter === id}">
          <span>${t(label)}</span>
          <span class="bk-filter-count tabular-nums">${filterCounts[id] ?? 0}</span>
        </button>`,
    )
    .join("");

  return `
    ${head}
      <div class="bk-stats">
        <div class="bk-stat"><span class="bk-stat-num tabular-nums">${keys.length}</span><span>${t("backups.statGames")}</span></div>
        <div class="bk-stat"><span class="bk-stat-num tabular-nums">${withBackup}</span><span>${t("backups.statBackedUp")}</span></div>
        <div class="bk-stat"><span class="bk-stat-num tabular-nums">${keys.length - withBackup}</span><span>${t("backups.statMissing")}</span></div>
        <div class="bk-stat${stale > 0 ? " warn" : ""}"><span class="bk-stat-num tabular-nums">${stale}</span><span>${t("backups.statStale")}</span></div>
        <div class="bk-stat"><span class="bk-stat-num tabular-nums">${esc(fmtBytes(totalBytes))}</span><span>${t("backups.statSize")}</span></div>
      </div>

      <div class="bk-migrate">
        <div class="bk-migrate-main">
          <div class="bk-migrate-title">${icon("rocket", 14)} ${t("backups.migrateTitle")}</div>
          <div class="bk-migrate-desc">${t("backups.migrateDesc")}</div>
        </div>
        <div class="bk-actions">
          <button type="button" class="btn ghost small" data-act="backups-export-all">${icon("download", 13)} ${t("backups.migrateExport")}</button>
          <button type="button" class="btn ghost small" data-act="backups-import-all">${icon("upload", 13)} ${t("backups.migrateImport")}</button>
        </div>
      </div>

      ${keys.length === 0
        ? `<div class="bk-empty">${t("backups.empty")}</div>`
        : `<p class="bk-note">${icon("info", 12)} ${t("backups.localOnlyNote")}</p>
           <div class="bk-toolbar">
             <input id="backups-search" class="input bk-search" type="search" placeholder="${t("backups.searchPlaceholder")}" value="${esc(S.backupsQuery)}" aria-label="${t("backups.searchPlaceholder")}" />
             <div class="bk-filters">${filterButtons}</div>
           </div>
           <div class="bk-list">${rows}</div>
           <div class="bk-empty" id="backups-no-match"${visibleCount > 0 ? " hidden" : ""}>${t("backups.noMatch")}</div>`}
    </div>`;
}

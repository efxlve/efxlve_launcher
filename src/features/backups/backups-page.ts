/**
 * Backups page: every game with its latest save archive, one screen.
 *
 * The page is read-only HTML; the actions live in `backups-handlers.ts` so a
 * full render never starts a backup by itself.
 */

import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import { epicBackupExcluded, epicListAllBackups, type SaveBackupInfo } from "../../epic";

/** A backup older than this is worth flagging, not deleting. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function storeLabel(key: string): string {
  if (key.startsWith("gog::")) return "GOG";
  if (key.startsWith("steam::")) return "Steam";
  if (key.startsWith("amazon::")) return "Amazon";
  if (key.startsWith("ubisoft::")) return "Ubisoft";
  if (key.startsWith("ea::")) return "EA";
  if (key.startsWith("custom::")) return t("backups.storeCustom");
  return "Epic";
}

/** Installed games the launcher owns save backups for. */
function installedKeys(): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of S.allGamesMap.values()) {
    if (!item.installed) continue;
    if (!["epic", "gog", "amazon", "custom", "steam", "ubisoft", "ea"].includes(item.source)) {
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
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function latestByKey(list: SaveBackupInfo[]): Map<string, SaveBackupInfo> {
  const map = new Map<string, SaveBackupInfo>();
  for (const info of list) {
    if (!map.has(info.app_name)) map.set(info.app_name, info);
  }
  return map;
}

export function renderBackupsPage(): string {
  if (S.backupsPage === null) {
    return `
      <div class="bk-page">
        <div class="bk-head">
          <div>
            <h2>${t("backups.title")}</h2>
            <p class="bk-sub">${t("backups.sub")}</p>
          </div>
        </div>
        <div class="bk-empty">${icon("refresh", 16, "spin")} ${t("backups.loading")}</div>
      </div>`;
  }

  const { list, excluded } = S.backupsPage;
  const latest = latestByKey(list);
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
      const title = summary?.title || key;
      const isInstalled = installedSet.has(key);
      const isStale = info ? info.timestamp * 1000 < Date.now() - STALE_MS : false;
      const included = !excluded.has(key);
      const meta = info
        ? `${esc(fmtDay(info.timestamp))} · ${esc(fmtBytes(info.size_bytes))} · ${info.file_count} ${t("ach.files")}${
            info.origin_app_name
              ? ` · ${t("backups.importedFrom", { store: storeLabel(info.origin_app_name) })}`
              : ""
          }`
        : t("backups.never");
      const cover = summary?.cover
        ? `<img src="${esc(summary.cover)}" alt="" loading="lazy" />`
        : icon("package", 18);
      return `
        <div class="bk-row${isStale ? " stale" : ""}">
          <div class="bk-cover">${cover}</div>
          <div class="bk-main">
            <div class="bk-title">
              <span class="bk-name">${esc(title)}</span>
              <span class="bk-store">${esc(storeLabel(key))}</span>
              ${isInstalled ? "" : `<span class="bk-store">${esc(t("backups.notInstalled"))}</span>`}
              ${isStale ? `<span class="bk-stale">${esc(t("backups.stale"))}</span>` : ""}
            </div>
            <div class="bk-meta tabular-nums">${meta}</div>
          </div>
          <div class="bk-actions">
            ${isInstalled
              ? `<label class="switch" title="${esc(t("manage.autoBackupTitle"))}"><input type="checkbox" data-act="backups-toggle-include" data-id="${esc(key)}" ${included ? "checked" : ""} /><span class="track"></span></label>
                 <button type="button" class="btn ghost small" data-act="backups-create" data-id="${esc(key)}">${icon("cloud", 13)} ${esc(t("backups.backUp"))}</button>`
              : ""}
            ${info
              ? `<button type="button" class="btn ghost small" data-act="backups-export" data-id="${esc(key)}" data-bid="${esc(info.id)}">${icon("download", 13)} ${esc(t("backups.export"))}</button>
                 <button type="button" class="btn primary small" data-act="backups-restore" data-id="${esc(key)}" data-bid="${esc(info.id)}" ${isInstalled ? "" : "disabled"}>${icon("upload", 13)} ${esc(t("ach.restore"))}</button>`
              : `<button type="button" class="btn ghost small" data-act="backups-import" data-id="${esc(key)}">${icon("upload", 13)} ${esc(t("manage.importSave"))}</button>`}
          </div>
        </div>`;
    })
    .join("");

  return `
    <div class="bk-page">
      <div class="bk-head">
        <div>
          <h2>${t("backups.title")}</h2>
          <p class="bk-sub">${t("backups.sub")}</p>
        </div>
        <div class="bk-head-actions">
          ${S.cloudBulkProgress
            ? `<span class="bk-stat-num tabular-nums">${S.cloudBulkProgress.done}/${S.cloudBulkProgress.total}</span>`
            : `<button type="button" class="btn ghost small" data-act="backups-refresh">${icon("refresh", 13)} ${t("backups.refresh")}</button>
               <button type="button" class="btn ghost small" data-act="backups-bulk">${icon("package", 13)} ${t("backups.backUpAll")}</button>`}
        </div>
      </div>

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

      <div class="bk-list">${rows || `<div class="bk-empty">${t("backups.empty")}</div>`}</div>
    </div>`;
}

/**
 * Storage manager: installed games grouped by drive with a usage breakdown.
 *
 * Reuses the drive enumeration from the move-game feature and routes move /
 * uninstall through the global click delegation. Pure presentation; the only
 * shared state touched is `S.moveSystemDrives`.
 */

import { storageRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import { epicGetSystemDrives, getThirdPartyLauncher, requiresThirdPartyLauncher, type EpicSummary } from "../../epic";
import { rawOf } from "../../core/selectors";

export function closeStorageManager(): void {
  if (storageRoot) storageRoot.innerHTML = "";
}

/** Drive letter (uppercase) of an install path, or "" when unknown. */
function driveOf(path: string | null | undefined): string {
  if (!path || path.length < 2 || path[1] !== ":") return "";
  return path[0].toUpperCase();
}

/** Opens the modal instantly from cached data, then refreshes the drive list. */
export async function openStorageManager(): Promise<void> {
  if (!storageRoot) return;
  renderStorageManager();
  try {
    S.moveSystemDrives = await epicGetSystemDrives();
  } catch {
    S.moveSystemDrives = [];
  }
  renderStorageManager();
}

function gameRow(g: EpicSummary): string {
  const raw = rawOf(g.appName);
  const partner = getThirdPartyLauncher(raw);
  const isTp = requiresThirdPartyLauncher(partner);

  const moveBtn = isTp
    ? `<button class="btn ghost small disabled-hint" data-act="blocked-move-tp" data-id="${g.appName}" data-partner="${esc(partner?.name || "Third-Party")}" title="${esc(t("manage.moveThirdPartyTip", { name: partner?.name || "Third-Party" }))}">${icon("hard-drive", 12)} ${t("manage.move")}</button>`
    : `<button class="btn ghost small" data-act="storage-move-game" data-id="${g.appName}">${icon("hard-drive", 12)} ${t("manage.move")}</button>`;

  return `
    <div class="storage-game-row">
      ${g.cover ? `<img class="storage-game-thumb" src="${esc(g.cover)}" alt="" loading="lazy" />` : `<div class="storage-game-thumb"></div>`}
      <div class="storage-game-info">
        <div class="storage-game-title" title="${esc(g.title)}">${esc(g.title)}</div>
        <div class="storage-game-meta">
          <span>${fmtBytes(g.installSize || 0)}</span>
          ${isTp && partner ? `<span class="apple-row-dot" aria-hidden="true">•</span><span class="tp-badge-text" title="${esc(t("manage.moveThirdPartyWarning", { name: partner.name }))}">${esc(partner.name)}</span>` : ""}
        </div>
      </div>
      <div class="storage-game-actions">
        ${moveBtn}
        <button class="btn danger small" data-act="storage-uninstall" data-id="${g.appName}">${icon("trash", 12)} ${t("common.uninstall")}</button>
      </div>
    </div>`;
}

export function renderStorageManager(): void {
  if (!storageRoot) return;
  const installed = S.epicSummaries.filter((s) => s.installed);
  const gamesTotal = installed.reduce((acc, g) => acc + (g.installSize || 0), 0);

  const gamesByDrive = new Map<string, EpicSummary[]>();
  for (const g of installed) {
    const d = driveOf(g.installPath) || "?";
    const arr = gamesByDrive.get(d) ?? [];
    arr.push(g);
    gamesByDrive.set(d, arr);
  }

  const driveCards = S.moveSystemDrives
    .map((d) => {
      const letter = d.letter.toUpperCase();
      const games = (gamesByDrive.get(letter) ?? []).sort((a, b) => (b.installSize || 0) - (a.installSize || 0));
      const gamesSize = games.reduce((acc, g) => acc + (g.installSize || 0), 0);
      const total = d.total_bytes || 0;
      const free = d.available_bytes || 0;
      const otherUsed = Math.max(0, total - free - gamesSize);
      const pct = (v: number) => (total > 0 ? Math.min(100, (v / total) * 100) : 0);
      return `
        <div class="storage-drive-card">
          <div class="storage-drive-head">
            <div class="storage-drive-name">${icon("hard-drive", 16)} <span>${letter}:${d.label ? ` ${esc(d.label)}` : ""}</span></div>
            <div class="storage-drive-free">${t("storage.free")}: <strong>${fmtBytes(free)}</strong> / ${fmtBytes(total)}</div>
          </div>
          <div class="storage-bar">
            <div class="storage-seg games" style="width:${pct(gamesSize)}%"></div>
            <div class="storage-seg other" style="width:${pct(otherUsed)}%"></div>
            <div class="storage-seg free" style="width:${pct(free)}%"></div>
          </div>
          <div class="storage-legend">
            <span><i class="dot games"></i>${t("storage.games")} <strong>${gamesSize > 0 ? fmtBytes(gamesSize) : "0 B"}</strong></span>
            <span><i class="dot other"></i>${t("storage.other")} <strong>${otherUsed > 0 ? fmtBytes(otherUsed) : "0 B"}</strong></span>
            <span><i class="dot free"></i>${t("storage.free")} <strong>${fmtBytes(free)}</strong></span>
          </div>
          <div class="storage-games">
            ${games.length === 0 ? `<div class="storage-empty">${t("storage.noGames")}</div>` : games.map(gameRow).join("")}
          </div>
        </div>`;
    })
    .join("");

  storageRoot.innerHTML = `
    <div class="storage-overlay" data-act="storage-overlay-close">
      <div class="storage-dialog" data-act="prevent-modal-close">
        <div class="storage-head">
          <div class="storage-head-icon">${icon("hard-drive", 18)}</div>
          <div class="storage-head-text">
            <div class="storage-head-title">${t("storage.title")}</div>
            <div class="storage-head-sub">${t("storage.subtitle", { count: installed.length, size: fmtBytes(gamesTotal) })}</div>
          </div>
          <button class="manage-head-close" data-act="close-storage-manager" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>
        <div class="storage-body">
          ${driveCards || `<div class="storage-empty">${t("storage.noDrives")}</div>`}
        </div>
      </div>
    </div>`;
}

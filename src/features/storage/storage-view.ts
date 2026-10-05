/**
 * Storage manager: installed games from every store grouped by drive with a
 * usage breakdown.
 *
 * Rows start from each store's metadata size and are replaced by the real
 * folder size as the background measurement lands (store metadata under-reports
 * some installs). Move is offered where the launcher supports it (Epic and
 * Amazon); uninstall routes to the owning store's own flow.
 */

import { invoke } from "@tauri-apps/api/core";
import { storageRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { rawOf, sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import { epicGetSystemDrives, getThirdPartyLauncher, requiresThirdPartyLauncher } from "../../epic";
import { coverOf, steamArtAttrs } from "../profile/profile-view";

interface StorageGame {
  key: string;
  title: string;
  cover: string;
  path: string | null;
  /** Size from the store's metadata; replaced by `measured` when available. */
  meta: number;
  source: string;
}

/** Real folder sizes measured this session, keyed by library key. */
const measured = new Map<string, { bytes: number; at: number }>();
/** A measurement stays fresh for this long; a later open re-measures it. */
const MEASURE_TTL = 10 * 60 * 1000;
/** Bumped when the modal closes so a running measurement loop stops. */
let measureToken = 0;

export function closeStorageManager(): void {
  measureToken++;
  if (storageRoot) storageRoot.innerHTML = "";
}

/** Drive letter (uppercase) of an install path, or "" when unknown. */
function driveOf(path: string | null | undefined): string {
  if (!path || path.length < 2 || path[1] !== ":") return "";
  return path[0].toUpperCase();
}

/** A game folder worth walking: not empty and not a drive root. */
function measurable(path: string | null | undefined): path is string {
  if (!path || path.length < 4) return false;
  return !/^[a-zA-Z]:[\\/]?$/.test(path);
}

function shownSize(g: StorageGame): number {
  const hit = measured.get(g.key);
  return hit && Date.now() - hit.at < MEASURE_TTL ? hit.bytes : g.meta;
}

/** Every installed game the launcher knows about, across all stores. */
function collectInstalled(): StorageGame[] {
  const out: StorageGame[] = [];
  const push = (key: string, title: string, path: string | null, size: number): void => {
    out.push({ key, title, cover: coverOf(key), path, meta: size || 0, source: sourceOfKey(key) });
  };
  for (const s of S.epicSummaries) if (s.installed) push(s.appName, s.title, s.installPath, s.installSize);
  for (const g of S.gogSummaries) if (g.installed) push(g.key, g.title, g.installPath, g.installSize);
  for (const g of S.amazonSummaries) if (g.installed) push(g.key, g.title, g.installPath, g.installSize);
  for (const g of S.steamSummaries) if (g.installed) push(g.key, g.title, g.installPath, g.installSize);
  for (const g of S.companionSummaries) if (g.installed) push(g.key, g.title, g.installPath, g.installSize);
  return out;
}

function moveButton(g: StorageGame): string {
  if (g.source !== "epic" && g.source !== "amazon") return "";
  if (g.source === "epic") {
    const partner = getThirdPartyLauncher(rawOf(g.key));
    if (requiresThirdPartyLauncher(partner)) {
      return `<button class="btn ghost small disabled-hint" data-act="blocked-move-tp" data-id="${esc(g.key)}" data-partner="${esc(partner?.name || "Third-Party")}" title="${esc(t("manage.moveThirdPartyTip", { name: partner?.name || "Third-Party" }))}">${icon("hard-drive", 12)} ${t("manage.move")}</button>`;
    }
  }
  return `<button class="btn ghost small" data-act="storage-move-game" data-id="${esc(g.key)}">${icon("hard-drive", 12)} ${t("manage.move")}</button>`;
}

function gameRow(g: StorageGame): string {
  const partner = g.source === "epic" ? getThirdPartyLauncher(rawOf(g.key)) : null;
  const tp = g.source === "epic" && requiresThirdPartyLauncher(partner);
  return `
    <div class="storage-game-row">
      ${g.cover ? `<img class="storage-game-thumb"${steamArtAttrs(g.key)} src="${esc(g.cover)}" alt="" loading="lazy" />` : `<div class="storage-game-thumb"></div>`}
      <div class="storage-game-info">
        <div class="storage-game-title" title="${esc(g.title)}">${esc(g.title)}</div>
        <div class="storage-game-meta">
          <span data-storage-size="${esc(g.key)}">${fmtBytes(shownSize(g))}</span>
          ${tp && partner ? `<span class="apple-row-dot" aria-hidden="true">•</span><span class="tp-badge-text" title="${esc(t("manage.moveThirdPartyWarning", { name: partner.name }))}">${esc(partner.name)}</span>` : ""}
        </div>
      </div>
      <div class="storage-game-actions">
        ${moveButton(g)}
        <button class="btn danger small" data-act="storage-uninstall" data-id="${esc(g.key)}">${icon("trash", 12)} ${t("common.uninstall")}</button>
      </div>
    </div>`;
}

export function renderStorageManager(): void {
  if (!storageRoot) return;
  const installed = collectInstalled();
  const gamesTotal = installed.reduce((acc, g) => acc + shownSize(g), 0);

  const gamesByDrive = new Map<string, StorageGame[]>();
  for (const g of installed) {
    const d = driveOf(g.path) || "?";
    const arr = gamesByDrive.get(d) ?? [];
    arr.push(g);
    gamesByDrive.set(d, arr);
  }

  const driveCards = S.moveSystemDrives
    .map((d) => {
      const letter = d.letter.toUpperCase();
      const games = (gamesByDrive.get(letter) ?? []).sort((a, b) => shownSize(b) - shownSize(a));
      const gamesSize = games.reduce((acc, g) => acc + shownSize(g), 0);
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

/**
 * Measures folder sizes in the background, one game at a time, and patches the
 * row in place. A final repaint refreshes the drive totals and bars.
 */
function measureSizes(games: StorageGame[]): void {
  const token = ++measureToken;
  void (async () => {
    let changed = false;
    for (const g of games) {
      if (token !== measureToken) return;
      const hit = measured.get(g.key);
      if (hit && Date.now() - hit.at < MEASURE_TTL) continue;
      if (!measurable(g.path) || g.key.startsWith("steam::")) continue;
      let bytes = 0;
      try {
        bytes = await invoke<number>("storage_path_size", { path: g.path });
      } catch {
        bytes = 0;
      }
      if (token !== measureToken) return;
      if (bytes <= 0) continue;
      measured.set(g.key, { bytes, at: Date.now() });
      changed = true;
      const el = document.querySelector<HTMLElement>(`[data-storage-size="${CSS.escape(g.key)}"]`);
      if (el) el.textContent = fmtBytes(bytes);
    }
    if (changed && token === measureToken) renderStorageManager();
  })();
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
  measureSizes(collectInstalled());
}

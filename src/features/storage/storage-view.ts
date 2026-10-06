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
import { icon, type IconName } from "../../core/icons";
import { rawOf, sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import type { GameSource } from "../../core/types";
import { t } from "../../i18n";
import { epicGetSystemDrives, getThirdPartyLauncher, requiresThirdPartyLauncher } from "../../epic";
import { coverOf, steamArtAttrs, storeName } from "../profile/profile-view";
import { storeLogo } from "../store/store-logos";

export interface StorageGame {
  key: string;
  title: string;
  cover: string;
  path: string | null;
  /** Size from the store's metadata; replaced by `measured` when available. */
  meta: number;
  source: GameSource;
}

/** Real folder sizes measured this session, keyed by library key. */
const measured = new Map<string, { bytes: number; at: number }>();
/** A measurement stays fresh for this long; a later open re-measures it. */
const MEASURE_TTL = 10 * 60 * 1000;
/** Bumped when the modal closes so a running measurement loop stops. */
let measureToken = 0;

interface StorageState {
  activeDrive: string;
  searchQuery: string;
  storeFilter: string;
  sortMode: "size-desc" | "size-asc" | "title-asc";
}

const S_STORAGE: StorageState = {
  activeDrive: "",
  searchQuery: "",
  storeFilter: "all",
  sortMode: "size-desc",
};

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

export function setStorageDrive(drive: string): void {
  S_STORAGE.activeDrive = drive.toUpperCase();
  S_STORAGE.searchQuery = "";
  S_STORAGE.storeFilter = "all";
  renderStorageManager();
}

export function setStorageStoreFilter(store: string): void {
  S_STORAGE.storeFilter = store;
  renderStorageGamesList();
}

export function toggleStorageSort(): void {
  if (S_STORAGE.sortMode === "size-desc") {
    S_STORAGE.sortMode = "size-asc";
  } else if (S_STORAGE.sortMode === "size-asc") {
    S_STORAGE.sortMode = "title-asc";
  } else {
    S_STORAGE.sortMode = "size-desc";
  }
  renderStorageManager();
}

export function clearStorageSearch(): void {
  S_STORAGE.searchQuery = "";
  S_STORAGE.storeFilter = "all";
  const input = storageRoot?.querySelector<HTMLInputElement>("#storage-search-input");
  if (input) input.value = "";
  const select = storageRoot?.querySelector<HTMLSelectElement>("#storage-store-select");
  if (select) select.value = "all";
  renderStorageGamesList();
}

export function setStorageSearch(val: string): void {
  S_STORAGE.searchQuery = val.trim().toLowerCase();
  renderStorageGamesList();
}

function moveButton(g: StorageGame): string {
  if (g.source !== "epic" && g.source !== "amazon") return "";
  if (g.source === "epic") {
    const partner = getThirdPartyLauncher(rawOf(g.key));
    if (requiresThirdPartyLauncher(partner)) {
      return `<button type="button" class="storage-action-btn ghost btn-move disabled-hint" data-act="blocked-move-tp" data-id="${esc(g.key)}" data-partner="${esc(partner?.name || "Third-Party")}" title="${esc(t("manage.moveThirdPartyTip", { name: partner?.name || "Third-Party" }))}">${icon("hard-drive", 13)} <span>${t("manage.move")}</span></button>`;
    }
  }
  return `<button type="button" class="storage-action-btn ghost btn-move" data-act="storage-move-game" data-id="${esc(g.key)}" title="${t("manage.move")}">${icon("hard-drive", 13)} <span>${t("manage.move")}</span></button>`;
}

function folderButton(g: StorageGame): string {
  if (!g.path) {
    return `<button type="button" class="storage-action-btn ghost btn-folder disabled-hint" disabled title="${esc(t("common.installPathUnknown"))}">${icon("folder", 13)} <span>${t("manage.openFolder")}</span></button>`;
  }
  return `<button type="button" class="storage-action-btn ghost btn-folder" data-act="storage-open-folder" data-path="${esc(g.path)}" data-id="${esc(g.key)}" title="${esc(t("ctx.openFolder"))}">${icon("folder", 13)} <span>${t("manage.openFolder")}</span></button>`;
}

function uninstallButton(g: StorageGame): string {
  return `<button type="button" class="storage-action-btn danger btn-uninstall" data-act="storage-uninstall" data-id="${esc(g.key)}" title="${t("common.uninstall")}">${icon("trash", 13)} <span>${t("common.uninstall")}</span></button>`;
}

function gameRow(g: StorageGame, maxGameSize: number): string {
  const partner = g.source === "epic" ? getThirdPartyLauncher(rawOf(g.key)) : null;
  const tp = g.source === "epic" && requiresThirdPartyLauncher(partner);
  const size = shownSize(g);
  const pct = maxGameSize > 0 ? Math.min(100, Math.max(2, Math.round((size / maxGameSize) * 100))) : 0;
  const store = `<span class="storage-game-store">${storeLogo(g.source, 13, "storage-store-logo")}<span>${esc(storeName(g.source))}</span></span>`;
  const cleanPath = g.path ? g.path.replace(/\//g, "\\") : "";
  return `
    <div class="storage-game-row">
      <div class="storage-game-cover-wrap">
        ${g.cover ? `<img class="storage-game-thumb"${steamArtAttrs(g.key)} src="${esc(g.cover)}" alt="" loading="lazy" />` : `<div class="storage-game-thumb storage-thumb-fallback">${icon("gamepad-2", 18)}</div>`}
      </div>
      <div class="storage-game-info">
        <div class="storage-game-top">
          <div class="storage-game-title" title="${esc(g.title)}">${esc(g.title)}</div>
          <div class="storage-game-size" data-storage-size="${esc(g.key)}">${fmtBytes(size)}</div>
        </div>
        <div class="storage-game-bar-track" aria-hidden="true">
          <div class="storage-game-bar-fill" style="width: ${pct}%"></div>
        </div>
        <div class="storage-game-meta">
          ${store}
          ${tp && partner ? `<span class="storage-meta-dot" aria-hidden="true">•</span><span class="storage-tp-badge" title="${esc(t("manage.moveThirdPartyWarning", { name: partner.name }))}">${esc(partner.name)}</span>` : ""}
          ${cleanPath ? `<span class="storage-meta-dot" aria-hidden="true">•</span><span class="storage-game-path" title="${esc(cleanPath)}">${esc(cleanPath)}</span>` : ""}
        </div>
      </div>
      <div class="storage-game-actions">
        ${moveButton(g)}
        ${folderButton(g)}
        ${uninstallButton(g)}
      </div>
    </div>`;
}

function renderStorageGamesList(): void {
  const container = document.getElementById("storage-games-container");
  if (!container) return;

  const installed = collectInstalled();
  const currentDrive = S_STORAGE.activeDrive;
  const gamesOnDrive = installed.filter((g) => (driveOf(g.path) || "?") === currentDrive);
  const maxGameSize = gamesOnDrive.reduce((max, g) => Math.max(max, shownSize(g)), 0);

  let filtered = gamesOnDrive;
  if (S_STORAGE.storeFilter !== "all") {
    filtered = filtered.filter((g) => g.source === S_STORAGE.storeFilter);
  }
  if (S_STORAGE.searchQuery) {
    const q = S_STORAGE.searchQuery;
    filtered = filtered.filter((g) => g.title.toLowerCase().includes(q));
  }

  // Sort
  filtered.sort((a, b) => {
    if (S_STORAGE.sortMode === "size-desc") return shownSize(b) - shownSize(a);
    if (S_STORAGE.sortMode === "size-asc") return shownSize(a) - shownSize(b);
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  // Update select element value if needed
  const select = document.getElementById("storage-store-select") as HTMLSelectElement | null;
  if (select && select.value !== S_STORAGE.storeFilter) {
    select.value = S_STORAGE.storeFilter;
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="storage-empty-state">
        <div class="storage-empty-icon">${icon("search", 28)}</div>
        <div class="storage-empty-title">${t("lib.noGames")}</div>
        ${S_STORAGE.searchQuery || S_STORAGE.storeFilter !== "all" ? `<button type="button" class="storage-empty-btn" data-act="storage-clear-search">${t("lib.filterClear")}</button>` : ""}
      </div>`;
    return;
  }

  container.innerHTML = filtered.map((g) => gameRow(g, maxGameSize)).join("");
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

  // Determine available drives from S.moveSystemDrives or installed games
  const systemDrives = [...S.moveSystemDrives];
  const driveLetters = new Set<string>();
  for (const d of systemDrives) driveLetters.add(d.letter.toUpperCase());
  for (const d of gamesByDrive.keys()) if (d !== "?") driveLetters.add(d);

  const sortedLetters = [...driveLetters].sort();
  if (!S_STORAGE.activeDrive || !driveLetters.has(S_STORAGE.activeDrive)) {
    S_STORAGE.activeDrive = sortedLetters[0] || "C";
  }

  const activeLetter = S_STORAGE.activeDrive;
  const activeSysDrive = systemDrives.find((d) => d.letter.toUpperCase() === activeLetter);
  const gamesOnDrive = gamesByDrive.get(activeLetter) ?? [];
  const gamesSize = gamesOnDrive.reduce((acc, g) => acc + shownSize(g), 0);

  const total = activeSysDrive?.total_bytes || Math.max(gamesSize * 1.5, 1);
  const free = activeSysDrive?.available_bytes || 0;
  const otherUsed = Math.max(0, total - free - gamesSize);
  const pct = (v: number) => (total > 0 ? Math.min(100, Math.max(0, (v / total) * 100)) : 0);
  const pctGames = pct(gamesSize);
  const pctOther = pct(otherUsed);
  const pctFree = Math.max(0, 100 - pctGames - pctOther);

  // Store counts for filter chips on this drive
  const storeCounts = new Map<string, number>();
  for (const g of gamesOnDrive) {
    storeCounts.set(g.source, (storeCounts.get(g.source) ?? 0) + 1);
  }

  // Drive tabs
  const driveTabs = sortedLetters.map((ltr) => {
    const sys = systemDrives.find((d) => d.letter.toUpperCase() === ltr);
    const count = (gamesByDrive.get(ltr) ?? []).length;
    const freeText = sys?.available_bytes ? fmtBytes(sys.available_bytes) : "";
    const active = ltr === activeLetter;
    return `
      <button type="button" class="storage-drive-tab ${active ? "active" : ""}" data-act="storage-select-drive" data-drive="${ltr}">
        <span class="storage-drive-tab-icon">${icon("hard-drive", 15)}</span>
        <span>${ltr}:${sys?.label ? ` ${esc(sys.label)}` : ""}</span>
        ${freeText ? `<span class="storage-drive-tab-badge">${freeText} ${t("storage.free")}</span>` : `<span class="storage-drive-tab-badge">${count}</span>`}
      </button>`;
  }).join("");

  // Store filter options for selectbox
  const storeOptions = [
    `<option value="all" ${S_STORAGE.storeFilter === "all" ? "selected" : ""}>${t("source.all")} (${gamesOnDrive.length})</option>`,
  ];
  for (const [src, cnt] of storeCounts.entries()) {
    storeOptions.push(`
      <option value="${src}" ${S_STORAGE.storeFilter === src ? "selected" : ""}>${esc(storeName(src as GameSource))} (${cnt})</option>`);
  }

  // Sort info
  let sortIcon: IconName = "chevron-down";
  let sortLabel = `${t("lib.filterSize")} ↓`;
  if (S_STORAGE.sortMode === "size-asc") {
    sortIcon = "chevron-up";
    sortLabel = `${t("lib.filterSize")} ↑`;
  } else if (S_STORAGE.sortMode === "title-asc") {
    sortIcon = "arrow-down-a-z";
    sortLabel = t("lib.sortAlpha");
  }

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
          ${sortedLetters.length > 1 ? `<div class="storage-drives-strip">${driveTabs}</div>` : ""}

          <div class="storage-overview-card">
            <div class="storage-overview-top">
              <div class="storage-overview-drive-name">
                ${icon("hard-drive", 16)}
                <span>${activeLetter}:${activeSysDrive?.label ? ` ${esc(activeSysDrive.label)}` : ""}</span>
              </div>
              <div class="storage-overview-free-text">
                ${t("storage.free")}: <strong>${fmtBytes(free)}</strong> / ${fmtBytes(total)}
              </div>
            </div>

            <div class="storage-meter-track" aria-hidden="true">
              <div class="storage-meter-seg seg-games" style="width: ${pctGames}%" title="${t("storage.games")}: ${fmtBytes(gamesSize)}"></div>
              <div class="storage-meter-seg seg-other" style="width: ${pctOther}%" title="${t("storage.other")}: ${fmtBytes(otherUsed)}"></div>
              <div class="storage-meter-seg seg-free" style="width: ${pctFree}%" title="${t("storage.free")}: ${fmtBytes(free)}"></div>
            </div>

            <div class="storage-stats-grid">
              <div class="storage-stat-pill stat-games">
                <span class="storage-stat-dot dot-games"></span>
                <div class="storage-stat-info">
                  <div class="storage-stat-label">${t("storage.games")}</div>
                  <div class="storage-stat-val">${fmtBytes(gamesSize)} <span class="storage-stat-meta">(${gamesOnDrive.length} • %${pctGames.toFixed(1)})</span></div>
                </div>
              </div>
              <div class="storage-stat-pill stat-other">
                <span class="storage-stat-dot dot-other"></span>
                <div class="storage-stat-info">
                  <div class="storage-stat-label">${t("storage.other")}</div>
                  <div class="storage-stat-val">${fmtBytes(otherUsed)} <span class="storage-stat-meta">(%${pctOther.toFixed(1)})</span></div>
                </div>
              </div>
              <div class="storage-stat-pill stat-free">
                <span class="storage-stat-dot dot-free"></span>
                <div class="storage-stat-info">
                  <div class="storage-stat-label">${t("storage.free")}</div>
                  <div class="storage-stat-val">${fmtBytes(free)} <span class="storage-stat-meta">(%${pctFree.toFixed(1)})</span></div>
                </div>
              </div>
            </div>
          </div>

          <div class="storage-toolbar">
            <div class="storage-search-wrap">
              ${icon("search", 13)}
              <input type="text" id="storage-search-input" class="storage-search-input" placeholder="${t("common.search")}..." value="${esc(S_STORAGE.searchQuery)}" />
              ${S_STORAGE.searchQuery ? `<button type="button" class="storage-search-clear" data-act="storage-clear-search">${icon("x", 12)}</button>` : ""}
            </div>

            <div class="storage-store-select-wrap">
              <select id="storage-store-select" class="storage-store-select" aria-label="${t("source.all")}">
                ${storeOptions.join("")}
              </select>
              <span class="storage-store-select-icon" aria-hidden="true">${icon("chevron-down", 13)}</span>
            </div>

            <button type="button" class="storage-sort-btn" data-act="storage-sort-toggle">
              ${icon(sortIcon, 13)}
              <span>${sortLabel}</span>
            </button>
          </div>

          <div id="storage-games-container" class="storage-games-container"></div>
        </div>
      </div>
    </div>`;

  renderStorageGamesList();

  if (storageRoot && !storageRoot.dataset.boundStorage) {
    storageRoot.dataset.boundStorage = "1";
    storageRoot.addEventListener("input", (e) => {
      const input = (e.target as HTMLElement)?.closest<HTMLInputElement>("#storage-search-input");
      if (input) setStorageSearch(input.value);
    });
    storageRoot.addEventListener("change", (e) => {
      const select = (e.target as HTMLElement)?.closest<HTMLSelectElement>("#storage-store-select");
      if (select) setStorageStoreFilter(select.value);
    });
  }
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
  S_STORAGE.searchQuery = "";
  S_STORAGE.storeFilter = "all";
  S_STORAGE.sortMode = "size-desc";
  renderStorageManager();
  try {
    S.moveSystemDrives = await epicGetSystemDrives();
  } catch {
    S.moveSystemDrives = [];
  }
  renderStorageManager();
  measureSizes(collectInstalled());
}

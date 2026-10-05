/**
 * Downloads and storefronts that stay inside TV Mode.
 *
 * Switching the app view to "downloads" or "store" drops the console shell.
 * These panels keep S.view === "tv" and, for stores, place the child webview
 * in the frame under the TV header.
 */

import { epicPortrait, epicStorePageUrlForGame } from "../../epic";
import { emptyState, icon, type IconName } from "../../core/icons";
import { render } from "../../core/render";
import { gogToEpicSummary, isCompanionSource, libraryItemToSummary, rawOf, sourceOfKey, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import type { DlMetrics } from "../../core/types";
import { esc, fmtBytes, fmtSpeed } from "../../core/utils";
import { localizeMessage, t } from "../../i18n";
import {
  visibleHeaderStores,
  STORE_LABELS,
  embeddedStoreHeld,
  isStoreWarm,
  releaseEmbeddedStore,
  setEmbeddedStoreRect,
  showEmbeddedStore,
  storeIdForUrl,
  storeUrlFor,
  syncStoreViewSize,
  type StoreId,
  type StoreRect,
} from "../store/store-view";
import { storeLogo } from "../store/store-logos";

export type TvPanel = "downloads" | "stores";

interface TvDlRow {
  id: string;
  title: string;
  meta: string;
  bar: string;
  actions: string;
  section: string;
}

let panel: TvPanel | null = null;
let dlFocus = 0;
let dlHeader = false;
let storeFocus = 0;
let storeUrl = "";

export function tvPanel(): TvPanel | null {
  return panel;
}

/** Rectangle the store child should cover: everything under the TV header. */
export function tvStoreRect(): StoreRect {
  const frame = document.getElementById("tv-store-frame");
  const r = frame?.getBoundingClientRect();
  const hud = document.getElementById("gamepad-hud-bar");
  const hudBox = hud && !hud.classList.contains("hidden") ? hud.getBoundingClientRect() : null;
  if (!r || r.width < 50 || r.height < 50) {
    const y = 64;
    const hudOverlap = hudBox ? Math.max(0, window.innerHeight - hudBox.top) : 0;
    const height = Math.max(100, window.innerHeight - y - hudOverlap);
    return { x: 0, y, width: window.innerWidth, height, bottom: Math.max(0, window.innerHeight - y - height) };
  }
  const hudOverlap = hudBox ? Math.max(0, r.bottom - hudBox.top) : 0;
  const height = Math.max(100, r.height - hudOverlap);
  return {
    x: r.left,
    y: r.top,
    width: r.width,
    height,
    bottom: Math.max(0, window.innerHeight - r.top - height),
  };
}

function bumpTvHud(): void {
  document.dispatchEvent(new Event("efxlve-hud"));
}

/** Drops panel state. Hides the child webview when TV Mode was holding it. */
export function tvDismissPanels(): void {
  const was = panel;
  panel = null;
  if (embeddedStoreHeld()) releaseEmbeddedStore();
  if (was) bumpTvHud();
}

export function tvOpenDownloadsPanel(): void {
  if (embeddedStoreHeld()) releaseEmbeddedStore();
  panel = "downloads";
  dlFocus = 0;
  dlHeader = false;
  render();
  bumpTvHud();
}

export function tvOpenStoresPanel(url?: string): void {
  const next = url || storeUrl || storeUrlFor("epic");
  const id = storeIdForUrl(next);
  const idx = visibleHeaderStores().indexOf(id);
  storeFocus = idx < 0 ? 0 : idx;
  storeUrl = next;
  panel = "stores";
  setEmbeddedStoreRect(tvStoreRect);
  S.storeLoading = !isStoreWarm(next);
  S.activeStore = id;
  render();
  requestAnimationFrame(() => {
    void showEmbeddedStore(storeUrl, tvStoreRect());
  });
  bumpTvHud();
}

export function tvClosePanel(): void {
  if (!panel) return;
  tvDismissPanels();
  render();
}

export function tvSelectStore(id: string): void {
  // Every storefront tab the header shows is selectable, Amazon Games included.
  const stores = visibleHeaderStores();
  if (!(stores as string[]).includes(id)) return;
  const next = storeUrlFor(id as StoreId);
  if (panel === "stores" && storeUrl === next && S.storeShown) {
    storeFocus = stores.indexOf(id as StoreId);
    paintStoreTabs();
    return;
  }
  tvOpenStoresPanel(next);
}

/** Store page for a library game, without leaving TV Mode. */
export function tvStoreUrlForApp(id: string): string {
  const source = sourceOfKey(id);
  // Amazon Games and Riot have no web storefront of their own.
  if (source === "amazon" || source === "riot") return "";
  if (source === "gog") {
    const s = summaryOf(id);
    const title = s ? s.title : id.slice(5);
    return `https://www.gog.com/en/games?query=${encodeURIComponent(title)}`;
  }
  if (source === "steam") return `https://store.steampowered.com/app/${id.slice(7)}`;
  const s = summaryOf(id);
  const title = s ? s.title : id;
  if (isCompanionSource(source)) {
    return source === "ubisoft"
      ? `https://store.ubi.com/search?q=${encodeURIComponent(title)}`
      : storeUrlFor(source as Parameters<typeof storeUrlFor>[0]);
  }
  return epicStorePageUrlForGame(rawOf(id), title);
}

export function renderTvDownloads(): string {
  const rows = collectDownloadRows();
  if (rows.length === 0) dlHeader = true;
  else if (dlFocus >= rows.length) dlFocus = rows.length - 1;
  const body = rows.length === 0
    ? emptyState("download", t("downloads.emptyTitle"), t("downloads.emptyDesc"))
    : rows.map((row, i) => rowHtml(row, i, rows[i - 1]?.section !== row.section)).join("");
  return `
    <div class="tv-screen tv-panel" id="tv-screen">
      ${panelHeader(t("nav.downloads"))}
      <div class="tv-dl-scroll" id="tv-dl-list">${body}</div>
    </div>`;
}

export function renderTvStores(): string {
  const tabs = visibleHeaderStores().map((id, i) => `
    <button type="button" class="tv-cat-btn tv-store-tab${i === storeFocus ? " active focused" : ""}" data-tv-store="${id}">
      ${storeLogo(id, 18)}
      <span>${STORE_LABELS[id]}</span>
    </button>`).join("");
  return `
    <div class="tv-screen tv-panel" id="tv-screen">
      <header class="tv-header">
        ${backButton()}
        <nav class="tv-nav-tabs" id="tv-store-tabs">
          <span class="tv-bumper-glyph">L1</span>
          ${tabs}
          <span class="tv-bumper-glyph">R1</span>
        </nav>
        <div class="tv-status-cluster">
          <button type="button" class="tv-exit-btn" data-act="close-tv-mode" title="${esc(t("tv.exit"))}">
            ${icon("x", 14)} <span>${t("tv.exit")}</span>
          </button>
        </div>
      </header>
      <div class="tv-store-frame" id="tv-store-frame">
        <div class="tv-store-pending" id="tv-store-pending"${S.storeLoading ? "" : " hidden"}>
          <span>${esc(t("store.starting"))}</span>
        </div>
      </div>
    </div>`;
}

/** Positions the child after the TV shell has been painted. */
export function hydrateTvPanel(): boolean {
  if (panel === "stores") {
    paintStoreTabs();
    syncStoreViewSize();
    return true;
  }
  if (panel === "downloads") {
    applyTvDownloadsFocus();
    return true;
  }
  return false;
}

export function tvPanelMove(dir: "up" | "down" | "left" | "right"): void {
  if (panel === "stores") {
    const stores = visibleHeaderStores();
    if (stores.length === 0) return;
    if (dir === "left") tvSelectStore(stores[(storeFocus + stores.length - 1) % stores.length]);
    else if (dir === "right") tvSelectStore(stores[(storeFocus + 1) % stores.length]);
    return;
  }
  if (panel !== "downloads") return;
  const count = document.querySelectorAll("[data-tv-dl-row]").length;
  if (dir === "up") {
    if (!dlHeader && dlFocus > 0) dlFocus -= 1;
    else dlHeader = true;
  } else if (dir === "down") {
    if (dlHeader && count > 0) dlHeader = false;
    else if (!dlHeader && dlFocus < count - 1) dlFocus += 1;
  }
  applyTvDownloadsFocus();
}

export function tvPanelActivate(): void {
  if (panel === "stores") return;
  if (panel !== "downloads") return;
  if (dlHeader) {
    tvClosePanel();
    return;
  }
  const row = document.querySelector<HTMLElement>(`[data-tv-dl-row="${dlFocus}"]`);
  row?.querySelector<HTMLElement>("[data-act]")?.click();
}

export function tvFocusDownloadRow(index: number): void {
  if (!Number.isFinite(index)) return;
  dlHeader = false;
  dlFocus = index;
  applyTvDownloadsFocus();
}

function panelHeader(title: string): string {
  return `
    <header class="tv-header">
      ${backButton()}
      <div class="tv-panel-title">${esc(title)}</div>
      <div class="tv-status-cluster">
        <button type="button" class="tv-exit-btn" data-act="close-tv-mode" title="${esc(t("tv.exit"))}">
          ${icon("x", 14)} <span>${t("tv.exit")}</span>
        </button>
      </div>
    </header>`;
}

function backButton(): string {
  return `
    <button type="button" class="tv-exit-btn tv-panel-back${dlHeader && panel === "downloads" ? " focused" : ""}" data-act="tv-panel-back">
      ${icon("arrow-left", 16)} <span>${esc(t("common.back"))}</span>
    </button>`;
}

function paintStoreTabs(): void {
  const id = visibleHeaderStores()[storeFocus];
  document.querySelectorAll<HTMLElement>(".tv-store-tab").forEach((tab) => {
    const on = tab.dataset.tvStore === id;
    tab.classList.toggle("active", on);
    tab.classList.toggle("focused", on);
    if (on) tab.focus({ preventScroll: true });
  });
}

function applyTvDownloadsFocus(): void {
  document.querySelectorAll(".tv-dl-row, .tv-panel-back").forEach((el) => el.classList.remove("focused"));
  if (dlHeader) {
    document.querySelector(".tv-panel-back")?.classList.add("focused");
    return;
  }
  const row = document.querySelector<HTMLElement>(`[data-tv-dl-row="${dlFocus}"]`);
  if (!row) return;
  row.classList.add("focused");
  row.scrollIntoView({ block: "nearest" });
}

function rowHtml(row: TvDlRow, index: number, lead: boolean): string {
  const focused = !dlHeader && index === dlFocus ? " focused" : "";
  const head = lead ? `<div class="tv-dl-section">${esc(row.section)}</div>` : "";
  return `
    ${head}
    <div class="tv-dl-row${focused}" data-tv-dl-row="${index}" tabindex="0">
      ${thumbHtml(row.id)}
      <div class="tv-dl-main">
        <div class="tv-dl-title">${esc(row.title)}</div>
        ${row.meta}
        ${row.bar}
      </div>
      <div class="tv-dl-actions">${row.actions}</div>
    </div>`;
}

function thumbHtml(id: string): string {
  const s = summaryOf(id);
  const raw = rawOf(id);
  const url = (s && S.customCovers[s.appName]) || (raw ? epicPortrait(raw) : null) || s?.cover || "";
  return url
    ? `<img class="tv-dl-thumb" src="${esc(url)}" alt="" decoding="async" />`
    : `<span class="tv-dl-thumb tv-dl-thumb-ph">${icon("gamepad-2", 22)}</span>`;
}

function collectDownloadRows(): TvDlRow[] {
  const rows: TvDlRow[] = [];
  const active = activeDownload();
  if (active) {
    const isAmazon = active.id.startsWith("amazon::");
    // Nile has no pause and the launcher does not cancel an install, so the
    // Amazon row carries no queue controls (same rule as the Downloads page).
    const paused = !isAmazon && (active.id.startsWith("gog::") ? S.gogDlPaused : S.dlQueueStatus.isPaused);
    const pct = Math.round(active.progress);
    const speed = fmtSpeed(active.speedBytes, S.speedInBits);
    const eta = localizeMessage(active.eta) || t("dl.calculating");
    const bytes = `${fmtBytes(active.downloadedBytes)} / ${fmtBytes(active.totalBytes)}`;
    rows.push({
      id: active.id,
      title: summaryOf(active.id)?.title || active.title || active.id,
      section: paused ? t("dl.statusPaused") : t("dl.statusActive"),
      meta: `<div class="tv-dl-meta tabular-nums"><span id="dl-hero-pct">%${pct}</span> · <span id="dl-stat-speed">${esc(speed)}</span> · <span id="dl-stat-eta">${esc(eta)}</span> · <span id="dl-stat-bytes">${esc(bytes)}</span></div>`,
      bar: `<div class="tv-dl-track"><div class="tv-dl-bar" id="dl-hero-fill" data-dlbar="${esc(active.id)}" style="width:${pct}%"></div></div>`,
      actions: isAmazon
        ? ""
        : paused
          ? primary("dl-resume", active.id, "play", t("downloads.resume")) + quiet("epic-cancel", active.id, t("common.cancel"))
          : primary("dl-pause", active.id, "pause", t("downloads.pause")) + quiet("epic-cancel", active.id, t("common.cancel")),
    });
  }

  const queue = S.dlQueueStatus.queue.filter((id) => !active || id !== active.id);
  queue.forEach((id) => {
    const s = summaryOf(id);
    rows.push({
      id,
      title: s?.title || id,
      section: t("dl.queueTitle"),
      meta: `<div class="tv-dl-meta">${s?.installSize ? fmtBytes(s.installSize) : esc(t("dl.queued"))}</div>`,
      bar: "",
      actions: primary("dl-reorder-now", id, "download", t("dl.downloadNow")) + quiet("dl-reorder-remove", id, t("dl.removeFromQueue")),
    });
  });

  for (const g of S.steamGames) {
    if (!g.downloading) continue;
    const id = `steam::${g.appId}`;
    const pct = g.bytesToDownload > 0
      ? Math.min(100, Math.round((g.bytesDownloaded / g.bytesToDownload) * 100))
      : null;
    const bytes = g.bytesDownloaded > 0
      ? `${fmtBytes(g.bytesDownloaded)}${g.bytesToDownload > 0 ? ` / ${fmtBytes(g.bytesToDownload)}` : ""}`
      : "";
    const meta = [pct !== null ? `%${pct}` : "", bytes].filter(Boolean).join(" · ") || t("steam.downloadingHint");
    rows.push({
      id,
      title: summaryOf(id)?.title || g.name || id,
      section: t("steam.downloading"),
      meta: `<div class="tv-dl-meta tabular-nums" data-steam-dl="${esc(g.appId)}">${esc(meta)}</div>`,
      bar: pct !== null
        ? `<div class="tv-dl-track"><div class="tv-dl-bar" data-tv-dlbar="${esc(id)}" style="width:${pct}%"></div></div>`
        : "",
      actions: primary("steam-open-downloads", id, "download", t("steam.openDownloads")),
    });
  }

  const updates = [
    ...S.epicSummaries.filter((s) => s.installed && (s.updateAvailable || S.availableUpdates.has(s.appName))),
    ...S.gogSummaries.filter((g) => g.installed && g.updateAvailable).map(gogToEpicSummary),
    ...S.amazonSummaries.filter((g) => g.installed && g.updateAvailable).map(libraryItemToSummary),
    ...S.steamSummaries.filter((g) => g.installed && g.updateAvailable && !g.downloading).map((g) => libraryItemToSummary(g)),
  ];
  for (const s of updates) {
    const info = S.availableUpdates.get(s.appName);
    const gInfo = S.gogUpdates.get(s.appName);
    const latest = info?.latestVersion || gInfo?.latestVersion || "";
    const installed = info?.installedVersion || gInfo?.installedBuildId || "";
    const ver = latest ? `${installed ? `${installed} → ` : ""}${latest}` : t("drawer.updateAvailable");
    const updateAct = s.appName.startsWith("steam::")
      ? primary("steam-action", s.appName.slice(7), "download", t("common.update"), `data-mode="update"`)
      : s.appName.startsWith("amazon::")
        ? primary("amazon-install", s.appName.slice(8), "download", t("common.update"))
        : primary("epic-install", s.appName, "download", t("common.update"));
    rows.push({
      id: s.appName,
      title: s.title,
      section: t("lib.updates"),
      meta: `<div class="tv-dl-meta">${esc(ver)}</div>`,
      bar: "",
      actions: updateAct,
    });
  }
  return rows;
}

function activeDownload(): DlMetrics | null {
  if (S.activeDlMetrics && !S.activeDlMetrics.done) return S.activeDlMetrics;
  for (const [id, d] of S.downloads) {
    if (!d.done) {
      return {
        id,
        title: d.title,
        progress: d.progress,
        done: false,
        speed: "—",
        speedBytes: 0,
        diskSpeed: "—",
        diskBytes: 0,
        eta: t("common.calculating"),
        downloadedBytes: 0,
        totalBytes: 0,
      };
    }
  }
  return null;
}

function primary(act: string, id: string, glyph: IconName, label: string, extra = ""): string {
  return `<button type="button" class="tv-btn-primary tv-dl-btn" data-act="${act}" data-id="${esc(id)}" ${extra}>${icon(glyph, 16)} <span>${esc(label)}</span></button>`;
}

function quiet(act: string, id: string, label: string): string {
  return `<button type="button" class="tv-btn-secondary tv-dl-btn" data-act="${act}" data-id="${esc(id)}">${esc(label)}</button>`;
}

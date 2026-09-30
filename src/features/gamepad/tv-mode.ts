/**
 * TV Mode: Console-grade Big Picture Dashboard for Steam Deck and 10-ft TV.
 *
 * PS5/Hydra console aesthetic:
 * - Top header bar with category tabs (Recent, Installed, Favorites, All, Updates),
 *   live system clock, battery indicator and download speed
 * - Stage area presenting the focused game with dynamic crossfade hero art,
 *   metadata pills and prominent Play / Install CTA
 * - Horizontal carousel shelf with crisp white outline focus and smooth scroll
 * - Integrated TV Game Hub for in-depth trophies, DLCs, screenshots, and management
 */

import { invoke } from "@tauri-apps/api/core";
import { isSteamDeckDevice, isTauri, NO_DESC } from "../../core/constants";
import { toastsEl } from "../../core/dom";
import { achSummaryOf, epicArt, epicDlProgress, isAppPlatinum, toggleFav } from "../../core/game-view";
import { emptyState, epicPlatinumIcon, icon } from "../../core/icons";
import { closeModal } from "../../core/dom";
import { render } from "../../core/render";
import { epicWideArt, gogToEpicSummary, libraryItemToSummary, sourceOfKey, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";
import { handleWindowResize } from "../../core/window";
import { t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import { setView } from "../store/store-view";
import { storeLogo } from "../store/store-logos";
import { storeVersionLabel } from "../drawer/external-versions";
import {
  ensureGameHubData,
  renderTvGameHub,
  renderTvHubTabContent,
  tvHubPrimaryAction,
  type TvHubTab,
} from "./tv-hub";

export { isSteamDeckDevice };

const SKIP = 5;
const BOOT_MS = 1700;

export type TvCategory = "recent" | "installed" | "favorites" | "all" | "updates";

interface CategoryMeta {
  id: TvCategory;
  labelKey: string;
  apps: string[];
}

let categories: CategoryMeta[] = [];
let activeCatIndex = 0;
let focusCol = 0;
let headerFocused = false;
let autoEntered = false;
let lastBgUrl = "";
let detailApp: string | null = null;
let activeHubTab: TvHubTab = "overview";
let bootTimer = 0;
let clockTimer = 0;
let searchQuery = "";

interface BatteryManager extends EventTarget {
  charging: boolean;
  level: number;
}
interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManager>;
}

let cachedBattery: { level: number; charging: boolean } | null = null;
let batteryListenerAttached = false;

function initBatteryMonitoring(): void {
  const nav = navigator as NavigatorWithBattery;
  if (!nav.getBattery || batteryListenerAttached) return;
  batteryListenerAttached = true;
  nav.getBattery()
    .then((battery) => {
      const update = (): void => {
        cachedBattery = {
          level: Math.round(battery.level * 100),
          charging: battery.charging,
        };
        paintStatusCluster();
      };
      update();
      battery.addEventListener("levelchange", update);
      battery.addEventListener("chargingchange", update);
    })
    .catch(() => {
      /* Battery API not supported or blocked */
    });
}

export function tvDetailOpen(): boolean {
  return detailApp !== null;
}

function bumpHud(): void {
  document.dispatchEvent(new Event("efxlve-hud"));
}

function allItems(): EpicSummary[] {
  const out: EpicSummary[] = [];
  for (const s of S.epicSummaries) {
    if (!S.hiddenGames.has(s.appName)) out.push(s);
  }
  for (const g of S.gogSummaries) {
    if (!S.hiddenGames.has(g.key)) out.push(gogToEpicSummary(g));
  }
  for (const g of S.steamSummaries) {
    if (!S.hiddenGames.has(g.key)) out.push(libraryItemToSummary(g));
  }
  return out;
}

function hasPendingUpdate(s: EpicSummary): boolean {
  return Boolean(s.updateAvailable || S.availableUpdates.has(s.appName) || S.gogUpdates.has(s.appName));
}

function take(ids: Iterable<string>, byId: Map<string, EpicSummary>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function buildCategories(): void {
  const items = allItems();
  const byId = new Map(items.map((s) => [s.appName, s]));

  const rawCats: CategoryMeta[] = [
    { id: "recent", labelKey: "tv.rowRecent", apps: take(S.epicRecent, byId) },
    { id: "installed", labelKey: "tv.rowInstalled", apps: take(items.filter((s) => s.installed).map((s) => s.appName), byId) },
    { id: "favorites", labelKey: "tv.rowFavorites", apps: take(S.epicFav, byId) },
    { id: "all", labelKey: "tv.allGames", apps: items.map((s) => s.appName) },
    { id: "updates", labelKey: "tv.rowUpdates", apps: take(items.filter(hasPendingUpdate).map((s) => s.appName), byId) },
  ];

  // Keep categories that have games (or recent/installed as baseline)
  categories = rawCats.filter((c) => c.apps.length > 0 || c.id === "recent" || c.id === "installed");
  if (categories.length === 0) {
    categories = [{ id: "all", labelKey: "tv.allGames", apps: [] }];
  }

  activeCatIndex = Math.min(activeCatIndex, categories.length - 1);
  const curApps = activeCategoryApps();
  focusCol = Math.min(focusCol, Math.max(0, curApps.length - 1));
}

function activeCategoryApps(): string[] {
  const cat = categories[activeCatIndex];
  if (!cat) return [];
  if (!searchQuery.trim()) return cat.apps;
  const q = searchQuery.trim().toLowerCase();
  return cat.apps.filter((id) => {
    const s = summaryOf(id);
    return s && s.title.toLowerCase().includes(q);
  });
}

function focusedGame(): EpicSummary | undefined {
  const apps = activeCategoryApps();
  const id = apps[focusCol];
  return id ? summaryOf(id) : undefined;
}

function artUrl(s: EpicSummary | undefined): string {
  if (!s) return "";
  return epicWideArt(s) || s.cover || "";
}

function storeLabel(id: string): string {
  const src = sourceOfKey(id);
  return storeVersionLabel(src);
}

function paintBg(url: string): void {
  const layer = document.getElementById("tv-bg");
  if (!layer) return;
  if (!url) {
    lastBgUrl = "";
    return;
  }
  if (url === lastBgUrl) return;
  const shown = layer.querySelector<HTMLImageElement>(".tv-bg-img.is-show");
  const hidden = layer.querySelector<HTMLImageElement>(".tv-bg-img:not(.is-show)");
  if (!hidden) return;
  hidden.src = url;
  const reveal = (): void => {
    hidden.classList.add("is-show");
    shown?.classList.remove("is-show");
    lastBgUrl = url;
  };
  if (hidden.complete && hidden.naturalWidth > 0) reveal();
  else hidden.onload = reveal;
}

function downloadsChipHtml(): string {
  const hasDl = S.downloads.size > 0 || Boolean(S.activeDlMetrics?.speedBytes);
  if (!hasDl) return "";
  const speed = S.activeDlMetrics?.speedBytes ?? 0;
  const speedText = speed > 0 ? `${fmtBytes(speed)}/s` : t("steam.downloading");
  return `
    <button type="button" class="tv-status-chip is-dl" data-view="downloads" title="${esc(t("nav.downloads"))}">
      ${icon("download", 13)}
      <span class="tv-dl-speed tabular-nums">${esc(speedText)}</span>
    </button>`;
}

function batteryChipHtml(): string {
  if (!cachedBattery) return "";
  const ic = cachedBattery.charging ? icon("battery-charging", 14) : icon("battery", 14);
  return `
    <div class="tv-status-chip is-battery" title="${esc(t("tv.battery"))}: ${cachedBattery.level}%">
      ${ic}
      <span class="tabular-nums">${cachedBattery.level}%</span>
    </div>`;
}

function clockChipHtml(): string {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return `<div class="tv-status-clock tabular-nums" id="tv-clock">${timeStr}</div>`;
}

function statusClusterHtml(): string {
  return `
    <div class="tv-status-cluster" id="tv-status-cluster">
      ${downloadsChipHtml()}
      ${batteryChipHtml()}
      ${clockChipHtml()}
      <button type="button" class="tv-exit-btn" data-act="close-tv-mode" title="${esc(t("tv.exit"))}">
        ${icon("x", 14)} <span>${t("tv.exit")}</span>
      </button>
    </div>`;
}

function paintStatusCluster(): void {
  const el = document.getElementById("tv-status-cluster");
  if (el) el.outerHTML = statusClusterHtml();
}

function paintClock(): void {
  const el = document.getElementById("tv-clock");
  if (!el) return;
  const now = new Date();
  el.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function homeStageHtml(s: EpicSummary | undefined): string {
  if (!s) {
    return `<div class="tv-stage-empty">${emptyState("gamepad-2", t("tv.emptyCategory"), "")}</div>`;
  }

  const pt = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
  const ach = achSummaryOf(s.appName);
  const isPlat = isAppPlatinum(s.appName);
  const faved = S.epicFav.has(s.appName);
  const updateAvail = hasPendingUpdate(s);
  const source = sourceOfKey(s.appName);

  const statusLabel = s.installed
    ? updateAvail
      ? t("common.update")
      : t("common.installed")
    : t("common.notInstalled");

  const statusTone = s.installed
    ? updateAvail
      ? "status-update"
      : "status-installed"
    : "";

  let trophyText = "";
  if (ach && ach.total_achievements > 0) {
    const pct = Math.round((ach.user_unlocked / ach.total_achievements) * 100);
    trophyText = `${ach.user_unlocked}/${ach.total_achievements} (%${pct})`;
  }

  return `
    <div class="tv-stage-content">
      <h1 class="tv-stage-title">${esc(s.title)}</h1>
      <div class="tv-stage-meta">
        <span class="tv-meta-pill tv-store-pill">${storeLogo(source, 15)}<span>${esc(storeLabel(s.appName))}</span></span>
        <span class="tv-meta-pill ${statusTone}"><span class="tv-status-dot"></span>${esc(statusLabel)}</span>
        ${pt > 0 ? `<span class="tv-meta-pill">${icon("clock", 13)}<span class="tabular-nums">${esc(fmtPlaytime(pt))}</span></span>` : ""}
        ${trophyText ? `<span class="tv-meta-pill${isPlat ? " is-plat" : ""}">${isPlat ? epicPlatinumIcon(13) : icon("trophy", 13)}<span class="tabular-nums">${esc(trophyText)}</span></span>` : ""}
      </div>

      <div class="tv-stage-actions">
        ${tvHubPrimaryAction(s)}
        <button type="button" class="tv-btn-secondary" data-act="tv-open-details" data-id="${esc(s.appName)}" title="${esc(t("tv.hudDetails"))}">
          ${icon("info", 16)} <span>${t("tv.hudDetails")}</span>
        </button>
        <button type="button" class="tv-btn-secondary${faved ? " faved" : ""}" data-act="epic-fav" data-id="${esc(s.appName)}" title="${esc(t("drawer.favTitle"))}">
          ${icon("heart", 16)} <span>${faved ? t("common.favorited") : t("common.favorite")}</span>
        </button>
      </div>
    </div>`;
}

function shelfCardsHtml(): string {
  const apps = activeCategoryApps();
  if (apps.length === 0) {
    return `<div class="tv-shelf-empty">${emptyState("gamepad-2", t("tv.emptyCategory"), "")}</div>`;
  }

  return apps
    .map((id, c) => {
      const s = summaryOf(id);
      if (!s) return "";
      const focused = !headerFocused && c === focusCol;
      const isRunning = S.runningGames.has(s.appName);
      const isUpdate = hasPendingUpdate(s);
      const p = epicDlProgress(s.appName);

      return `
      <button type="button"
        class="tv-card${focused ? " focused" : ""}"
        data-col="${c}"
        data-id="${esc(id)}"
        tabindex="-1"
        title="${esc(s.title)}">
        ${epicArt(s)}
        ${isRunning ? `<span class="tv-card-badge is-running">${t("lib.running")}</span>` : ""}
        ${!isRunning && isUpdate ? `<span class="tv-card-badge is-update">${t("common.update")}</span>` : ""}
        ${p !== null ? `<div class="tv-card-dl-track"><div class="tv-card-dl-bar" style="width:${p}%"></div></div>` : ""}
      </button>`;
    })
    .join("");
}

function categoryTabsHtml(): string {
  return categories
    .map((cat, i) => {
      const active = i === activeCatIndex;
      const focused = headerFocused && i === activeCatIndex;
      const count = cat.apps.length;
      return `
      <button type="button"
        class="tv-cat-btn${active ? " active" : ""}${focused ? " focused" : ""}"
        data-tv-cat="${i}"
        tabindex="-1">
        <span>${t(cat.labelKey as Parameters<typeof t>[0])}</span>
        ${count > 0 ? `<span class="tv-cat-badge tabular-nums">${count}</span>` : ""}
      </button>`;
    })
    .join("");
}

function paintStage(): void {
  const host = document.getElementById("tv-stage");
  if (host) host.innerHTML = homeStageHtml(focusedGame());
}

function paintShelf(): void {
  const host = document.getElementById("tv-shelf-track");
  if (host) host.innerHTML = shelfCardsHtml();
}

function paintHeaderTabs(): void {
  const host = document.getElementById("tv-nav-tabs");
  if (host) host.innerHTML = `<span class="tv-bumper-glyph">L1</span>${categoryTabsHtml()}<span class="tv-bumper-glyph">R1</span>`;
}

function applyFocus(): void {
  if (detailApp) return;

  // Header vs Shelf focus
  document.querySelectorAll<HTMLElement>(".tv-card.focused, .tv-cat-btn.focused").forEach((el) => el.classList.remove("focused"));

  if (headerFocused) {
    const tab = document.querySelector<HTMLElement>(`.tv-cat-btn[data-tv-cat="${activeCatIndex}"]`);
    if (tab) {
      tab.classList.add("focused");
      tab.focus({ preventScroll: true });
    }
  } else {
    const card = document.querySelector<HTMLElement>(`.tv-card[data-col="${focusCol}"]`);
    if (card) {
      card.classList.add("focused");
      card.focus({ preventScroll: true });
      card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }

  const game = focusedGame();
  paintBg(artUrl(game));
  paintStage();
}

export function renderTvMode(): string {
  buildCategories();
  initBatteryMonitoring();
  startClockTimer();

  if (detailApp) {
    const s = summaryOf(detailApp);
    if (s) return renderTvGameHub(s, activeHubTab);
    detailApp = null;
  }

  lastBgUrl = "";
  const game = focusedGame();
  const bg = artUrl(game);

  return `
    <div class="tv-screen" id="tv-screen">
      <div class="tv-bg" id="tv-bg">
        <img class="tv-bg-img is-show" alt="" decoding="async" ${bg ? `src="${esc(bg)}"` : ""} />
        <img class="tv-bg-img" alt="" decoding="async" />
        <div class="tv-bg-scrim"></div>
      </div>

      <header class="tv-header">
        <nav class="tv-nav-tabs" id="tv-nav-tabs">
          <span class="tv-bumper-glyph">L1</span>
          ${categoryTabsHtml()}
          <span class="tv-bumper-glyph">R1</span>
        </nav>

        <div class="tv-header-center">
          <label class="tv-search-wrap">
            ${icon("search", 14)}
            <input type="text"
              class="tv-search-input"
              id="tv-search-input"
              placeholder="${esc(t("tv.searchPlaceholder"))}"
              value="${esc(searchQuery)}"
              autocomplete="off" />
            ${searchQuery ? `<button type="button" class="tv-search-clear" data-act="tv-clear-search">${icon("x", 12)}</button>` : ""}
          </label>
        </div>

        ${statusClusterHtml()}
      </header>

      <section class="tv-stage" id="tv-stage">
        ${homeStageHtml(game)}
      </section>

      <div class="tv-shelf" id="tv-shelf">
        <div class="tv-shelf-track" id="tv-shelf-track">
          ${shelfCardsHtml()}
        </div>
      </div>

      <div class="tv-hub-slot" id="tv-hub-slot" hidden></div>
    </div>`;
}

export function hydrateTvMode(): void {
  lastBgUrl = "";
  if (detailApp) {
    const s = summaryOf(detailApp);
    if (s) {
      const slot = document.getElementById("tv-hub-slot");
      if (slot) {
        slot.hidden = false;
        slot.innerHTML = renderTvGameHub(s, activeHubTab);
      }
      return;
    }
  }
  applyFocus();
}

export function tvMove(dir: "up" | "down" | "left" | "right"): void {
  if (detailApp) {
    if (dir === "left" || dir === "right") {
      tvNeighbor(dir === "right" ? 1 : -1);
    }
    return;
  }

  const apps = activeCategoryApps();
  if (dir === "up") {
    if (!headerFocused) {
      headerFocused = true;
      applyFocus();
    }
  } else if (dir === "down") {
    if (headerFocused) {
      headerFocused = false;
      applyFocus();
    } else {
      // Down on focused card opens Game Hub (PS5 pattern)
      tvOpenDetails();
    }
  } else if (dir === "left") {
    if (headerFocused) {
      tvCategoryJump(-1);
    } else {
      focusCol = Math.max(0, focusCol - 1);
      applyFocus();
    }
  } else if (dir === "right") {
    if (headerFocused) {
      tvCategoryJump(1);
    } else {
      focusCol = Math.min(apps.length - 1, focusCol + 1);
      applyFocus();
    }
  }
}

export function tvCategoryJump(step: number): void {
  if (categories.length === 0) return;
  activeCatIndex = (activeCatIndex + step + categories.length) % categories.length;
  focusCol = 0;
  headerFocused = false;
  paintHeaderTabs();
  paintShelf();
  applyFocus();
  bumpHud();
}

export function tvRowJump(step: number): void {
  if (detailApp) {
    tvNeighbor(step);
    return;
  }
  tvCategoryJump(step);
}

export function tvSkip(dir: 1 | -1): void {
  if (detailApp) return;
  const apps = activeCategoryApps();
  focusCol = Math.max(0, Math.min(apps.length - 1, focusCol + dir * SKIP));
  applyFocus();
}

/** Step through tabs in Game Hub or step to next card. */
export function tvNeighbor(step: number): void {
  if (detailApp) {
    const s = summaryOf(detailApp);
    if (!s) return;
    const tabOrder: TvHubTab[] = ["overview", "achievements", "dlcs", "screenshots", "manage"];
    const curIdx = tabOrder.indexOf(activeHubTab);
    const nextIdx = (curIdx + step + tabOrder.length) % tabOrder.length;
    activeHubTab = tabOrder[nextIdx];
    const hub = document.getElementById("tv-hub");
    if (hub) {
      hub.querySelectorAll(".tv-hub-tab").forEach((btn) => btn.classList.remove("active"));
      hub.querySelector(`.tv-hub-tab[data-tv-tab="${activeHubTab}"]`)?.classList.add("active");
      const body = document.getElementById("tv-hub-body");
      if (body) body.innerHTML = renderTvHubTabContent(s, activeHubTab);
    }
    bumpHud();
    return;
  }
  tvCategoryJump(step);
}

/** A button: Play if installed, install/details if not. */
export function tvActivate(): void {
  if (detailApp) {
    const s = summaryOf(detailApp);
    if (!s) return;
    const primaryBtn = document.querySelector<HTMLElement>("#tv-hub .tv-action-btn");
    primaryBtn?.click();
    return;
  }

  const s = focusedGame();
  if (!s) return;
  if (s.installed) {
    const playBtn = document.querySelector<HTMLElement>("#tv-stage .tv-action-btn");
    if (playBtn) {
      playBtn.click();
      return;
    }
  }
  tvOpenDetails();
}

export function tvOpenDetails(appName?: string): void {
  const targetId = appName || focusedGame()?.appName;
  if (!targetId) return;
  const s = summaryOf(targetId);
  if (!s) return;
  detailApp = s.appName;
  activeHubTab = "overview";
  ensureGameHubData(s);
  render();
  bumpHud();
}

export function tvCloseDetails(): void {
  detailApp = null;
  activeHubTab = "overview";
  render();
  bumpHud();
  requestAnimationFrame(applyFocus);
}

export function tvFavorite(): void {
  const s = detailApp ? summaryOf(detailApp) : focusedGame();
  if (!s) return;
  toggleFav(s.appName);
  if (detailApp) {
    const btn = document.querySelector<HTMLElement>(`#tv-hub [data-act="epic-fav"]`);
    if (btn) {
      const faved = S.epicFav.has(s.appName);
      btn.classList.toggle("faved", faved);
    }
  } else {
    paintStage();
  }
}

export function tvBack(): void {
  if (detailApp) {
    tvCloseDetails();
    return;
  }
  if (S.currentModalAppName) {
    closeModal();
    return;
  }
  closeTvMode();
}

async function setOsFullscreen(on: boolean): Promise<void> {
  if (isTauri) {
    try {
      await invoke("app_set_fullscreen", { enabled: on });
      handleWindowResize();
      return;
    } catch {
      /* Fallback to browser fullscreen API */
    }
  }
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* Ignored */
  }
}

function spawnBoot(): void {
  window.clearTimeout(bootTimer);
  document.getElementById("tv-boot")?.remove();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = document.createElement("div");
  el.id = "tv-boot";
  el.className = "tv-boot";
  el.innerHTML = `<div class="tv-boot-line"></div><div class="tv-boot-mark">Efxlve</div>`;
  document.body.appendChild(el);
  const done = (): void => el.remove();
  el.addEventListener("animationend", (e) => {
    if ((e as AnimationEvent).animationName === "tv-boot-fade") done();
  });
  bootTimer = window.setTimeout(done, BOOT_MS);
}

function startClockTimer(): void {
  window.clearInterval(clockTimer);
  clockTimer = window.setInterval(paintClock, 10000);
}

function stopClockTimer(): void {
  window.clearInterval(clockTimer);
  clockTimer = 0;
}

export function openTvMode(): void {
  if (S.view === "tv") return;
  activeCatIndex = 0;
  focusCol = 0;
  headerFocused = false;
  detailApp = null;
  searchQuery = "";
  lastBgUrl = "";
  setView("tv");
  render();
  spawnBoot();
  void setOsFullscreen(true);
  requestAnimationFrame(hydrateTvMode);
}

export function closeTvMode(): void {
  if (S.view !== "tv") return;
  window.clearTimeout(bootTimer);
  stopClockTimer();
  document.getElementById("tv-boot")?.remove();
  detailApp = null;
  searchQuery = "";
  void setOsFullscreen(false);
  setView("library");
  render();
}

export function toggleTvMode(): void {
  if (S.view === "tv") closeTvMode();
  else openTvMode();
}

export function showTvPrompt(name: string): boolean {
  if (S.view === "tv") return false;
  const el = document.createElement("div");
  el.className = "toast ok tv-prompt";
  el.innerHTML = `<span>${esc(t("gamepad.connected", { name }))}</span><button class="btn primary small" data-act="open-tv-mode">${t("tv.prompt")}</button>`;
  toastsEl.appendChild(el);
  el.addEventListener("click", () => el.remove());
  window.setTimeout(() => el.remove(), 8000);
  return true;
}

export function onControllerConnected(name: string): boolean {
  if (S.view === "tv") return false;
  if (S.tvAutoEnter && !autoEntered) {
    autoEntered = true;
    openTvMode();
    return true;
  }
  return showTvPrompt(name);
}

export function markDeckChrome(): void {
  document.documentElement.classList.toggle("is-steam-deck", isSteamDeckDevice());
}

/** Global click routing for TV mode elements. */
document.addEventListener("click", (e) => {
  if (S.view !== "tv") return;
  const tEl = e.target as HTMLElement;

  // Category tab click
  const catBtn = tEl.closest<HTMLElement>("[data-tv-cat]");
  if (catBtn) {
    e.preventDefault();
    activeCatIndex = Number(catBtn.dataset.tvCat);
    focusCol = 0;
    headerFocused = false;
    paintHeaderTabs();
    paintShelf();
    applyFocus();
    bumpHud();
    return;
  }

  // Clear search click
  const clearBtn = tEl.closest<HTMLElement>("[data-act=\"tv-clear-search\"]");
  if (clearBtn) {
    e.preventDefault();
    searchQuery = "";
    const input = document.getElementById("tv-search-input") as HTMLInputElement | null;
    if (input) input.value = "";
    focusCol = 0;
    paintShelf();
    applyFocus();
    return;
  }

  // Open details button
  const detailsBtn = tEl.closest<HTMLElement>("[data-act=\"tv-open-details\"]");
  if (detailsBtn) {
    e.preventDefault();
    const id = detailsBtn.dataset.id;
    if (id) tvOpenDetails(id);
    return;
  }

  // Close TV Hub button
  const closeHubBtn = tEl.closest<HTMLElement>("[data-act=\"tv-hub-close\"]");
  if (closeHubBtn) {
    e.preventDefault();
    tvCloseDetails();
    return;
  }

  // Clicking directly on a game card
  const card = tEl.closest<HTMLElement>(".tv-card");
  if (card) {
    e.preventDefault();
    e.stopPropagation();
    focusCol = Number(card.dataset.col);
    headerFocused = false;
    applyFocus();
    tvOpenDetails();
    return;
  }
}, true);

/** Input listener for live search filter. */
document.addEventListener("input", (e) => {
  if (S.view !== "tv") return;
  const target = e.target as HTMLInputElement;
  if (target?.id === "tv-search-input") {
    searchQuery = target.value;
    focusCol = 0;
    paintShelf();
    applyFocus();
  }
});

/** Global keydown delegation for TV mode. */
document.addEventListener("keydown", (e) => {
  if (S.view !== "tv" || document.getElementById("palette-root")?.firstElementChild) return;
  const target = e.target as HTMLElement;
  const isTyping = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

  if (isTyping && e.key !== "Escape" && e.key !== "Enter") return;

  const map: Record<string, "up" | "down" | "left" | "right"> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
  };

  if (map[e.key]) {
    e.preventDefault();
    e.stopPropagation();
    tvMove(map[e.key]);
  } else if (e.key === "Enter") {
    e.preventDefault();
    tvActivate();
  } else if (e.key === "Escape" || e.key === "Backspace") {
    if (!isTyping || e.key === "Escape") {
      e.preventDefault();
      tvBack();
    }
  } else if (e.key === "f" || e.key === "F") {
    if (!isTyping) {
      e.preventDefault();
      tvFavorite();
    }
  } else if (e.key === "x" || e.key === "X") {
    if (!isTyping) {
      e.preventDefault();
      tvOpenDetails();
    }
  } else if (e.key === "PageDown") {
    e.preventDefault();
    tvSkip(1);
  } else if (e.key === "PageUp") {
    e.preventDefault();
    tvSkip(-1);
  } else if (e.key === "Tab") {
    e.preventDefault();
    tvNeighbor(e.shiftKey ? -1 : 1);
  }
}, true);

/** Mouseover shelf card updates focus smoothly. */
document.addEventListener("mouseover", (e) => {
  if (S.view !== "tv" || detailApp) return;
  const card = (e.target as HTMLElement).closest?.<HTMLElement>(".tv-card");
  if (!card) return;
  const c = Number(card.dataset.col);
  if (c !== focusCol || headerFocused) {
    focusCol = c;
    headerFocused = false;
    applyFocus();
  }
}, { passive: true });

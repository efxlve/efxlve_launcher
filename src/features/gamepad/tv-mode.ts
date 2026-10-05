/**
 * TV Mode: console shell for a gamepad (A select, B back, LB/RB shelves).
 * Status color only. Covers stay free of permanent badges.
 *
 * PS5/Hydra console aesthetic:
 * - Top header bar with category tabs (Recent, Installed, Favorites, All, Updates),
 *   live system clock, battery indicator and download speed
 * - Stage area presenting the focused game with dynamic crossfade hero art,
 *   metadata pills and prominent Play / Install CTA
 * - Horizontal carousel shelf with crisp white outline focus and smooth scroll
 * - Integrated TV Game Hub for in-depth trophies, DLCs, screenshots, and management
 */

import launcherIcon from "../../../src-tauri/icons/icon.png";
import { invoke } from "@tauri-apps/api/core";
import { isSteamDeckDevice, isTauri, NO_DESC } from "../../core/constants";
import { toastsEl } from "../../core/dom";
import { achSummaryOf, epicArt, epicDlProgress, isAppPlatinum, toggleFav } from "../../core/game-view";
import { emptyState, epicPlatinumIcon, icon } from "../../core/icons";
import { closeModal } from "../../core/dom";
import { render } from "../../core/render";
import { epicWideArt, gogToEpicSummary, libraryItemToSummary, sourceOfKey, summaryOf } from "../../core/selectors";
import { globalAvatar, S } from "../../core/state";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";
import { handleWindowResize } from "../../core/window";
import { t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import { setView, storeUrlFor } from "../store/store-view";
import { storeLogo } from "../store/store-logos";
import { forgetGameScreenshots } from "../screenshots/screenshots-view";
import { storeVersionLabel } from "../drawer/external-versions";
import { accountAvatar, profileSelection } from "../profile/profile-view";
import {
  ensureGameHubData,
  renderTvGameHub,
  renderTvHubTabContent,
  tvHubPrimaryAction,
  type TvHubTab,
} from "./tv-hub";
import {
  applyTvProfileFocus,
  renderTvProfile,
  resetTvProfileFocus,
  tvProfileActivate,
  tvProfileMove,
  tvProfileShelfJump,
} from "./tv-profile";
import {
  openTvKeyboard,
  tvControllerConnected,
  tvKeyboardActivate,
  tvKeyboardBackspace,
  tvKeyboardClose,
  tvKeyboardInsert,
  tvKeyboardMove,
  tvKeyboardOpen,
} from "./tv-keyboard";
import {
  hydrateTvPanel,
  renderTvDownloads,
  renderTvStores,
  tvClosePanel,
  tvDismissPanels,
  tvFocusDownloadRow,
  tvOpenDownloadsPanel,
  tvOpenStoresPanel,
  tvPanel,
  tvPanelActivate,
  tvPanelMove,
  tvSelectStore,
  tvStoreUrlForApp,
} from "./tv-panels";

export { isSteamDeckDevice, tvProfileShelfJump };

const SKIP = 5;
const BOOT_MS = 1700;

export type TvCategory = "recent" | "installed" | "favorites" | "all" | "updates";

interface CategoryMeta {
  id: TvCategory;
  labelKey: string;
  apps: string[];
}

export type TvHomeSection = "header" | "stage" | "shelf";

let categories: CategoryMeta[] = [];
let activeCatIndex = 0;
let focusCol = 0;
let focusSection: TvHomeSection = "shelf";
let headerFocusIndex = 0;
let stageActionIndex = 0;
let autoEntered = false;
let lastBgUrl = "";
let tvProfileOpenState = false;
let openedDetailsFromProfile = false;
let activeHubTab: TvHubTab = "overview";
let bootTimer = 0;
let clockTimer = 0;
let searchQuery = "";

export function getTvSearchQuery(): string {
  return searchQuery;
}

export function setTvSearchQuery(q: string): void {
  searchQuery = q;
  focusCol = 0;
  paintShelf();
  paintStage();
  const searchLabel = document.querySelector(".tv-search-chip-text");
  if (searchLabel) searchLabel.textContent = q || t("common.search");
  document.querySelector(".tv-status-chip.is-search")?.classList.toggle("is-active", Boolean(q.trim()));
}

function enterTvDownloads(): void {
  tvProfileOpenState = false;
  S.tvDetailAppName = null;
  tvOpenDownloadsPanel();
}

function enterTvStores(url?: string): void {
  tvProfileOpenState = false;
  S.tvDetailAppName = null;
  tvOpenStoresPanel(url);
}

export function tvOpenProfile(): void {
  tvDismissPanels();
  tvProfileOpenState = true;
  S.tvDetailAppName = null;
  resetTvProfileFocus();
  render();
  bumpHud();
  requestAnimationFrame(applyTvProfileFocus);
}

export function tvCloseProfile(): void {
  tvProfileOpenState = false;
  openedDetailsFromProfile = false;
  render();
  bumpHud();
  requestAnimationFrame(applyFocus);
}

export function isTvProfileOpen(): boolean {
  return tvProfileOpenState;
}

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
  return S.tvDetailAppName !== null;
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
  for (const g of S.amazonSummaries) {
    if (!S.hiddenGames.has(g.key)) out.push(libraryItemToSummary(g));
  }
  for (const g of S.steamSummaries) {
    if (!S.hiddenGames.has(g.key)) out.push(libraryItemToSummary(g));
  }
  // Companion stores (EA, Ubisoft, Xbox, Battle.net, Riot) keep their own
  // clients; their games still belong on the shelf for a controller session.
  for (const g of S.companionSummaries) {
    if (!S.hiddenGames.has(g.key)) out.push(libraryItemToSummary(g));
  }
  return out;
}

function hasPendingUpdate(s: EpicSummary): boolean {
  if (s.downloading) return false;
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

function searchChipHtml(): string {
  const isFocused = focusSection === "header" && headerFocusIndex === categories.length;
  const hasQuery = Boolean(searchQuery.trim());
  return `
    <button type="button"
      class="tv-status-chip is-search${hasQuery ? " is-active" : ""}${isFocused ? " focused" : ""}"
      data-act="tv-open-search"
      title="${esc(t("common.search"))}">
      ${icon("search", 13)}
      <span class="tv-search-chip-text">${hasQuery ? esc(searchQuery) : esc(t("common.search"))}</span>
      ${hasQuery
        ? `<span class="tv-search-clear-inline" data-act="tv-clear-search" title="${esc(t("common.clear"))}">${icon("x", 11)}</span>`
        : `<span class="tv-bumper-glyph tv-key-glyph">Y</span>`}
    </button>`;
}

function downloadsChipHtml(): string {
  const isFocused = focusSection === "header" && headerFocusIndex === categories.length + 3;
  const steamDl = S.steamGames.find((g) => g.downloading);
  let epicActive = false;
  for (const d of S.downloads.values()) {
    if (!d.done) {
      epicActive = true;
      break;
    }
  }
  const hasDl = epicActive || Boolean(S.activeDlMetrics && !S.activeDlMetrics.done) || Boolean(steamDl);
  let speedText = t("nav.downloads");
  if (hasDl) {
    const speed = S.activeDlMetrics?.speedBytes ?? 0;
    if (speed > 0) {
      speedText = `${fmtBytes(speed)}/s`;
    } else if (steamDl) {
      const pct = steamDl.bytesToDownload > 0
        ? Math.min(100, Math.round((steamDl.bytesDownloaded / steamDl.bytesToDownload) * 100))
        : null;
      speedText = pct !== null ? `%${pct}` : t("steam.downloading");
    } else {
      // Epic/GOG/Amazon progress without a live rate: show the percent instead
      // of another store's "downloading" label.
      let progress: number | null = S.activeDlMetrics?.progress ?? null;
      if (progress === null) {
        for (const d of S.downloads.values()) {
          if (!d.done) {
            progress = d.progress;
            break;
          }
        }
      }
      speedText = progress !== null ? `%${Math.round(progress)}` : t("steam.downloading");
    }
  }
  return `
    <button type="button" class="tv-status-chip${hasDl ? " is-dl" : ""}${isFocused ? " focused" : ""}" data-act="tv-open-downloads" title="${esc(t("nav.downloads"))}">
      ${icon("download", 13)}
      <span class="tv-dl-speed tabular-nums">${esc(speedText)}</span>
    </button>`;
}

function storesChipHtml(): string {
  const isFocused = focusSection === "header" && headerFocusIndex === categories.length + 2;
  return `
    <button type="button" class="tv-status-chip${isFocused ? " focused" : ""}" data-act="tv-open-stores" title="${esc(t("nav.store"))}">
      ${icon("globe", 13)}
      <span>${esc(t("nav.store"))}</span>
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

function profileChipHtml(): string {
  const isFocused = focusSection === "header" && headerFocusIndex === categories.length + 1;
  const sel = profileSelection();
  const isCombined = sel.mode === "combined";
  const name = isCombined
    ? (S.epicAccount || S.steamAuth?.accountName || S.gogAccount || t("profile.player"))
    : sel.account.name;
  const avatar = isCombined ? globalAvatar() : accountAvatar(sel.account);
  const initial = (name.trim().charAt(0) || "E").toUpperCase();
  return `
    <button type="button" class="tv-status-chip is-profile${isFocused ? " focused" : ""}" data-act="tv-open-profile" title="${esc(t("nav.profile"))}">
      <span class="tv-status-avatar">${avatar ? `<img src="${esc(avatar)}" alt="" />` : `<span class="tv-avatar-initial">${esc(initial)}</span>`}</span>
      <span class="tv-status-username">${esc(name)}</span>
    </button>`;
}

function exitBtnHtml(): string {
  const isFocused = focusSection === "header" && headerFocusIndex === categories.length + 4;
  return `
    <button type="button" class="tv-exit-btn${isFocused ? " focused" : ""}" data-act="close-tv-mode" title="${esc(t("tv.exit"))}">
      ${icon("x", 14)} <span>${t("tv.exit")}</span>
    </button>`;
}

function statusClusterHtml(): string {
  return `
    <div class="tv-status-cluster" id="tv-status-cluster">
      ${searchChipHtml()}
      ${profileChipHtml()}
      ${storesChipHtml()}
      ${downloadsChipHtml()}
      ${batteryChipHtml()}
      ${clockChipHtml()}
      ${exitBtnHtml()}
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

  const statusLabel = s.downloading
    ? t("steam.downloading")
    : s.installed
      ? updateAvail
        ? t("common.update")
        : t("common.installed")
      : t("common.notInstalled");

  const statusTone = s.downloading
    ? "status-update"
    : s.installed
      ? updateAvail
        ? "status-update"
        : "status-installed"
      : "";

  let trophyText = "";
  if (ach && ach.total_achievements > 0) {
    const pct = Math.round((ach.user_unlocked / ach.total_achievements) * 100);
    trophyText = `${ach.user_unlocked}/${ach.total_achievements} (%${pct})`;
  }

  const isCtaFocused = focusSection === "stage" && stageActionIndex === 0;
  const isDetailsFocused = focusSection === "stage" && stageActionIndex === 1;
  const isFavFocused = focusSection === "stage" && stageActionIndex === 2;

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
        ${tvHubPrimaryAction(s, isCtaFocused)}
        <button type="button" class="tv-btn-secondary${isDetailsFocused ? " focused" : ""}" data-act="tv-open-details" data-id="${esc(s.appName)}" title="${esc(t("tv.hudDetails"))}">
          ${icon("info", 16)} <span>${t("tv.hudDetails")}</span>
        </button>
        <button type="button" class="tv-btn-secondary${faved ? " faved" : ""}${isFavFocused ? " focused" : ""}" data-act="epic-fav" data-id="${esc(s.appName)}" title="${esc(t("drawer.favTitle"))}">
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
      const focused = focusSection === "shelf" && c === focusCol;
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
        ${p !== null ? `<div class="tv-card-dl-track"><div class="tv-card-dl-bar" data-tv-dlbar="${esc(id)}" style="width:${p}%"></div></div>` : ""}
      </button>`;
    })
    .join("");
}

function categoryTabsHtml(): string {
  return categories
    .map((cat, i) => {
      const active = i === activeCatIndex;
      const focused = focusSection === "header" && i === headerFocusIndex;
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
  if (S.tvDetailAppName) return;

  const game = focusedGame();
  paintBg(artUrl(game));
  paintStage();
  paintHeaderTabs();
  paintStatusCluster();

  document.querySelectorAll<HTMLElement>(
    ".tv-card.focused, .tv-cat-btn.focused, .tv-stage-actions .focused, .tv-status-chip.focused, .tv-exit-btn.focused"
  ).forEach((el) => el.classList.remove("focused"));

  if (focusSection === "header") {
    if (headerFocusIndex < categories.length) {
      const tab = document.querySelector<HTMLElement>(`.tv-cat-btn[data-tv-cat="${headerFocusIndex}"]`);
      if (tab) {
        tab.classList.add("focused");
        tab.focus({ preventScroll: true });
        tab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
    } else {
      const relIdx = headerFocusIndex - categories.length;
      const statusMap = [
        '[data-act="tv-open-search"]',
        '[data-act="tv-open-profile"]',
        '[data-act="tv-open-stores"]',
        '[data-act="tv-open-downloads"]',
        '[data-act="close-tv-mode"]',
      ];
      const targetSel = statusMap[relIdx];
      if (targetSel) {
        const item = document.querySelector<HTMLElement>(targetSel);
        if (item) {
          item.classList.add("focused");
          item.focus({ preventScroll: true });
        }
      }
    }
  } else if (focusSection === "stage") {
    const stageButtons = Array.from(document.querySelectorAll<HTMLElement>(".tv-stage-actions button"));
    if (stageButtons.length > 0) {
      const idx = Math.min(stageActionIndex, stageButtons.length - 1);
      const btn = stageButtons[idx];
      btn.classList.add("focused");
      btn.focus({ preventScroll: true });
    }
  } else {
    // Shelf
    const card = document.querySelector<HTMLElement>(`.tv-card[data-col="${focusCol}"]`);
    if (card) {
      card.classList.add("focused");
      card.focus({ preventScroll: true });
      card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }
}

export function renderTvMode(): string {
  buildCategories();
  initBatteryMonitoring();
  startClockTimer();

  if (tvProfileOpenState && !S.tvDetailAppName) {
    tvKeyboardClose();
    return renderTvProfile();
  }

  if (S.tvDetailAppName) {
    tvKeyboardClose();
    const s = summaryOf(S.tvDetailAppName);
    if (s) return renderTvGameHub(s, activeHubTab);
    S.tvDetailAppName = null;
  }

  if (tvPanel() === "downloads" || tvPanel() === "stores") {
    tvKeyboardClose();
    return tvPanel() === "downloads" ? renderTvDownloads() : renderTvStores();
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
  if (!S.tvDetailAppName && !tvProfileOpenState && hydrateTvPanel()) return;
  if (tvProfileOpenState && !S.tvDetailAppName) {
    applyTvProfileFocus();
    return;
  }
  if (S.tvDetailAppName) {
    const s = summaryOf(S.tvDetailAppName);
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
  if (tvKeyboardOpen()) {
    tvKeyboardMove(dir);
    return;
  }
  if (tvProfileOpenState && !S.tvDetailAppName) {
    tvProfileMove(dir);
    return;
  }

  if (S.tvDetailAppName) {
    if (dir === "left" || dir === "right") {
      tvNeighbor(dir === "right" ? 1 : -1);
    } else if (dir === "down") {
      document.getElementById("tv-hub-body")?.scrollBy({ top: 160, behavior: "smooth" });
    } else if (dir === "up") {
      document.getElementById("tv-hub-body")?.scrollBy({ top: -160, behavior: "smooth" });
    }
    return;
  }

  if (tvPanel()) {
    tvPanelMove(dir);
    return;
  }

  const apps = activeCategoryApps();
  const totalHeaderItems = categories.length + 5;

  if (focusSection === "shelf") {
    if (dir === "up") {
      if (apps.length > 0) {
        focusSection = "stage";
        stageActionIndex = 0;
      } else {
        focusSection = "header";
        headerFocusIndex = Math.min(activeCatIndex, categories.length - 1);
      }
      applyFocus();
    } else if (dir === "left") {
      focusCol = Math.max(0, focusCol - 1);
      applyFocus();
    } else if (dir === "right") {
      focusCol = Math.min(Math.max(0, apps.length - 1), focusCol + 1);
      applyFocus();
    }
  } else if (focusSection === "stage") {
    if (dir === "down") {
      focusSection = "shelf";
      applyFocus();
    } else if (dir === "up") {
      focusSection = "header";
      headerFocusIndex = Math.min(activeCatIndex, categories.length - 1);
      applyFocus();
    } else if (dir === "left") {
      stageActionIndex = Math.max(0, stageActionIndex - 1);
      applyFocus();
    } else if (dir === "right") {
      stageActionIndex = Math.min(2, stageActionIndex + 1);
      applyFocus();
    }
  } else if (focusSection === "header") {
    if (dir === "down") {
      if (apps.length > 0) {
        focusSection = "stage";
        stageActionIndex = 0;
      } else {
        focusSection = "shelf";
      }
      applyFocus();
    } else if (dir === "left") {
      headerFocusIndex = Math.max(0, headerFocusIndex - 1);
      if (headerFocusIndex < categories.length && headerFocusIndex !== activeCatIndex) {
        activeCatIndex = headerFocusIndex;
        focusCol = 0;
      }
      applyFocus();
    } else if (dir === "right") {
      headerFocusIndex = Math.min(totalHeaderItems - 1, headerFocusIndex + 1);
      if (headerFocusIndex < categories.length && headerFocusIndex !== activeCatIndex) {
        activeCatIndex = headerFocusIndex;
        focusCol = 0;
      }
      applyFocus();
    }
  }
}

export function tvCategoryJump(step: number): void {
  if (categories.length === 0) return;
  activeCatIndex = (activeCatIndex + step + categories.length) % categories.length;
  if (focusSection === "header") {
    headerFocusIndex = activeCatIndex;
  }
  focusCol = 0;
  paintHeaderTabs();
  paintShelf();
  applyFocus();
  bumpHud();
}

export function tvRowJump(step: number): void {
  if (tvKeyboardOpen()) {
    tvKeyboardMove(step > 0 ? "right" : "left");
    return;
  }
  if (tvPanel() && !S.tvDetailAppName && !tvProfileOpenState) {
    tvPanelMove(step > 0 ? "right" : "left");
    return;
  }
  if (tvProfileOpenState && !S.tvDetailAppName) {
    tvProfileShelfJump(step > 0 ? 1 : -1);
    return;
  }
  if (S.tvDetailAppName) {
    tvNeighbor(step);
    return;
  }
  tvCategoryJump(step);
}

export function tvSkip(dir: 1 | -1): void {
  if (S.tvDetailAppName || tvProfileOpenState || tvPanel() || tvKeyboardOpen()) return;
  const apps = activeCategoryApps();
  focusCol = Math.max(0, Math.min(apps.length - 1, focusCol + dir * SKIP));
  applyFocus();
}

/** Step through tabs in Game Hub or step to next card. */
export function tvNeighbor(step: number): void {
  if (tvProfileOpenState && !S.tvDetailAppName) {
    tvProfileShelfJump(step > 0 ? 1 : -1);
    return;
  }
  if (S.tvDetailAppName) {
    const s = summaryOf(S.tvDetailAppName);
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
  if (tvKeyboardOpen()) {
    tvKeyboardActivate();
    return;
  }
  if (S.tvDetailAppName) {
    const primaryBtn = document.querySelector<HTMLElement>("#tv-hub .tv-action-btn");
    primaryBtn?.click();
    return;
  }

  if (tvProfileOpenState) {
    tvProfileActivate();
    return;
  }

  if (tvPanel()) {
    tvPanelActivate();
    return;
  }

  if (focusSection === "header") {
    if (headerFocusIndex < categories.length) {
      activeCatIndex = headerFocusIndex;
      focusCol = 0;
      focusSection = "shelf";
      applyFocus();
      return;
    }
    const relIdx = headerFocusIndex - categories.length;
    if (relIdx === 0) {
      openTvKeyboard();
    } else if (relIdx === 1) {
      tvOpenProfile();
    } else if (relIdx === 2) {
      enterTvStores();
    } else if (relIdx === 3) {
      enterTvDownloads();
    } else if (relIdx === 4) {
      closeTvMode();
    }
    return;
  }

  if (focusSection === "stage") {
    const s = focusedGame();
    if (!s) return;
    if (stageActionIndex === 0) {
      const playBtn = document.querySelector<HTMLElement>("#tv-stage .tv-action-btn");
      if (playBtn) playBtn.click();
      else tvOpenDetails();
    } else if (stageActionIndex === 1) {
      tvOpenDetails();
    } else if (stageActionIndex === 2) {
      tvFavorite();
    }
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
  if (tvKeyboardOpen()) return;
  if (tvPanel() && !appName) return;
  const targetId = appName || focusedGame()?.appName;
  if (!targetId) return;
  const s = summaryOf(targetId);
  if (!s) return;
  // Moving between games inside the hub frees the previous gallery.
  if (S.tvDetailAppName && S.tvDetailAppName !== s.appName) {
    forgetGameScreenshots(S.tvDetailAppName);
  }
  S.tvDetailAppName = s.appName;
  activeHubTab = "overview";
  ensureGameHubData(s);
  render();
  bumpHud();
}

export function tvCloseDetails(): void {
  // The hub's screenshot gallery is tens of megabytes; free it with the hub.
  if (S.tvDetailAppName) forgetGameScreenshots(S.tvDetailAppName);
  S.tvDetailAppName = null;
  activeHubTab = "overview";
  render();
  bumpHud();
  if (tvProfileOpenState) {
    requestAnimationFrame(applyTvProfileFocus);
  } else {
    requestAnimationFrame(applyFocus);
  }
}

export function tvFavorite(): void {
  if (tvKeyboardOpen()) return;
  if (tvPanel() && !S.tvDetailAppName) return;
  const s = S.tvDetailAppName ? summaryOf(S.tvDetailAppName) : focusedGame();
  if (!s) return;
  toggleFav(s.appName);
  if (S.tvDetailAppName) {
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
  if (tvKeyboardOpen()) {
    tvKeyboardClose();
    return;
  }
  if (S.tvDetailAppName) {
    tvCloseDetails();
    return;
  }
  if (tvProfileOpenState) {
    tvCloseProfile();
    return;
  }
  if (tvPanel()) {
    tvClosePanel();
    return;
  }
  if (S.currentModalAppName) {
    closeModal();
    return;
  }
  if (searchQuery.trim()) {
    setTvSearchQuery("");
    render();
    applyFocus();
    return;
  }
  if (focusSection !== "shelf") {
    focusSection = "shelf";
    applyFocus();
    return;
  }
  // At root shelf: do nothing (never accidentally quit to desktop).
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
  el.innerHTML = `<div class="tv-boot-line"></div><div class="tv-boot-mark"><img src="${launcherIcon}" alt="" draggable="false" /></div>`;
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
  focusSection = "shelf";
  headerFocusIndex = 0;
  stageActionIndex = 0;
  S.tvDetailAppName = null;
  searchQuery = "";
  lastBgUrl = "";
  tvDismissPanels();
  setView("tv");
  render();
  bumpHud();
  spawnBoot();
  void setOsFullscreen(true);
  requestAnimationFrame(hydrateTvMode);
}

export function closeTvMode(): void {
  if (S.view !== "tv") return;
  window.clearTimeout(bootTimer);
  stopClockTimer();
  document.getElementById("tv-boot")?.remove();
  // Leaving TV Mode frees the hub's gallery too, not only its own close path.
  if (S.tvDetailAppName) forgetGameScreenshots(S.tvDetailAppName);
  S.tvDetailAppName = null;
  tvProfileOpenState = false;
  openedDetailsFromProfile = false;
  searchQuery = "";
  focusSection = "shelf";
  focusCol = 0;
  headerFocusIndex = 0;
  stageActionIndex = 0;
  tvKeyboardClose();
  tvDismissPanels();
  void setOsFullscreen(false);
  setView("library");
  bumpHud();
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

  const viewBtn = tEl.closest<HTMLElement>("[data-view]");
  if (viewBtn) {
    const next = viewBtn.dataset.view;
    if (next === "downloads" || next === "store") {
      e.preventDefault();
      e.stopPropagation();
      if (next === "downloads") enterTvDownloads();
      else enterTvStores();
      return;
    }
  }

  const openSearch = tEl.closest<HTMLElement>("[data-act=\"tv-open-search\"]");
  if (openSearch) {
    e.preventDefault();
    e.stopPropagation();
    openTvKeyboard();
    return;
  }

  const clearSearch = tEl.closest<HTMLElement>("[data-act=\"tv-clear-search\"]");
  if (clearSearch) {
    e.preventDefault();
    e.stopPropagation();
    setTvSearchQuery("");
    render();
    applyFocus();
    return;
  }

  const openDl = tEl.closest<HTMLElement>("[data-act=\"tv-open-downloads\"]");
  if (openDl) {
    e.preventDefault();
    e.stopPropagation();
    enterTvDownloads();
    return;
  }

  const openStores = tEl.closest<HTMLElement>("[data-act=\"tv-open-stores\"]");
  if (openStores) {
    e.preventDefault();
    e.stopPropagation();
    enterTvStores();
    return;
  }

  const openStoreAct = tEl.closest<HTMLElement>("[data-act=\"open-store\"]");
  if (openStoreAct) {
    e.preventDefault();
    e.stopPropagation();
    const store = openStoreAct.dataset.store;
    enterTvStores(store ? storeUrlFor(store as Parameters<typeof storeUrlFor>[0]) : undefined);
    return;
  }

  const storePage = tEl.closest<HTMLElement>("[data-act=\"epic-store-page\"]");
  if (storePage?.dataset.id) {
    e.preventDefault();
    e.stopPropagation();
    const url = tvStoreUrlForApp(storePage.dataset.id);
    if (url) enterTvStores(url);
    return;
  }

  const panelBack = tEl.closest<HTMLElement>("[data-act=\"tv-panel-back\"]");
  if (panelBack) {
    e.preventDefault();
    e.stopPropagation();
    tvClosePanel();
    return;
  }

  const storeTab = tEl.closest<HTMLElement>("[data-tv-store]");
  if (storeTab?.dataset.tvStore) {
    e.preventDefault();
    e.stopPropagation();
    tvSelectStore(storeTab.dataset.tvStore);
    return;
  }

  const dlRow = tEl.closest<HTMLElement>("[data-tv-dl-row]");
  if (dlRow && !tEl.closest("[data-act]")) {
    e.preventDefault();
    tvFocusDownloadRow(Number(dlRow.dataset.tvDlRow));
    return;
  }

  // TV Profile open / close
  const openProfBtn = tEl.closest<HTMLElement>("[data-act=\"tv-open-profile\"]");
  if (openProfBtn) {
    e.preventDefault();
    tvOpenProfile();
    return;
  }

  const closeProfBtn = tEl.closest<HTMLElement>("[data-act=\"tv-close-profile\"]");
  if (closeProfBtn) {
    e.preventDefault();
    tvCloseProfile();
    return;
  }

  const openGameFromProf = tEl.closest<HTMLElement>("[data-act=\"tv-open-game-from-profile\"]");
  if (openGameFromProf) {
    e.preventDefault();
    const id = openGameFromProf.dataset.id;
    if (id) {
      openedDetailsFromProfile = true;
      tvOpenDetails(id);
    }
    return;
  }

  // Category tab click
  const catBtn = tEl.closest<HTMLElement>("[data-tv-cat]");
  if (catBtn) {
    e.preventDefault();
    activeCatIndex = Number(catBtn.dataset.tvCat);
    headerFocusIndex = activeCatIndex;
    focusCol = 0;
    focusSection = "shelf";
    paintHeaderTabs();
    paintShelf();
    applyFocus();
    bumpHud();
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
    const c = Number(card.dataset.col);
    if (!isNaN(c)) {
      if (focusSection === "shelf" && focusCol === c) {
        tvOpenDetails();
      } else {
        focusCol = c;
        focusSection = "shelf";
        applyFocus();
      }
    }
    return;
  }
}, true);

/** Global keydown delegation for TV mode. */
document.addEventListener("keydown", (e) => {
  if (S.view !== "tv" || document.getElementById("palette-root")?.firstElementChild) return;
  if (tvKeyboardOpen()) {
    const arrows: Record<string, "up" | "down" | "left" | "right"> = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    };
    e.preventDefault();
    e.stopPropagation();
    if (arrows[e.key]) tvKeyboardMove(arrows[e.key]);
    else if (e.key === "Enter") tvKeyboardActivate();
    else if (e.key === "Escape") tvKeyboardClose();
    else if (e.key === "Backspace") tvKeyboardBackspace();
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) tvKeyboardInsert(e.key);
    return;
  }
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
  } else if (e.key === "/" || e.key === "s" || e.key === "S") {
    if (!isTyping) {
      e.preventDefault();
      openTvKeyboard();
    }
  } else if (e.key === "p" || e.key === "P") {
    if (!isTyping) {
      e.preventDefault();
      if (tvProfileOpenState) tvCloseProfile();
      else tvOpenProfile();
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
  if (S.view !== "tv" || S.tvDetailAppName || tvPanel() || tvKeyboardOpen()) return;
  const card = (e.target as HTMLElement).closest?.<HTMLElement>(".tv-card");
  if (!card) return;
  const c = Number(card.dataset.col);
  if (c !== focusCol || focusSection !== "shelf") {
    focusCol = c;
    focusSection = "shelf";
    applyFocus();
  }
}, { passive: true });

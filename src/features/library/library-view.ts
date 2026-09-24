/**
 * Library view: quiet Steam / Epic cover wall.
 *
 * Default All is a portrait grid only. Filters are plain text. Cards rest as
 * covers; hover shows title + one action. Exception badges are Update / Running
 * only. Full-page innerHTML of a grown 500-card chunk is treated as a bug.
 */

import { isCollectionIcon } from "../../core/collection-icons";
import { INITIAL_CARD_CHUNK, MORE_CARD_CHUNK, isTauri } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { epicActionButtons, epicArt, epicDlProgress, isAppPlatinum, libraryCardBadge, libraryDlBar } from "../../core/game-view";
import { icon, type IconName } from "../../core/icons";
import { rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";

import { epicPortrait, type EpicSummary } from "../../epic";
import type { EpicSort } from "../../core/types";
import { t } from "../../i18n";
import { renderFreeGamesGrid } from "../freegames/freegames";
import { renderOnboarding } from "../onboarding/onboarding-view";

/** Sort options shown in the library sort dropdown, evaluated dynamically with current language. */
export function getSortOptions(): {
  id: EpicSort;
  label: string;
  icon: "clock" | "arrow-down-a-z" | "check-circle" | "trophy" | "refresh";
}[] {
  return [
    { id: "recent", label: t("lib.sortRecent"), icon: "clock" },
    { id: "alpha", label: t("lib.sortAlpha"), icon: "arrow-down-a-z" },
    { id: "installed", label: t("lib.sortInstalled"), icon: "check-circle" },
    { id: "platinum", label: t("lib.sortPlatinum"), icon: "trophy" },
    { id: "updates", label: t("lib.sortUpdates"), icon: "refresh" },
  ];
}

/** Studio/publisher name for a game (empty when unknown). */
export function studioOf(s: EpicSummary): string {
  const g = rawOf(s.appName);
  const d = g?.metadata?.developer;
  return typeof d === "string" ? d.trim() : "";
}

/**
 * Parses the search box into plain terms plus `key:value` operators:
 * `dev:<studio>` and `is:installed|notinstalled|fav|update`.
 */
function parseQuery(q: string): {
  terms: string[];
  dev: string;
  installed: boolean;
  notInstalled: boolean;
  fav: boolean;
  update: boolean;
} {
  const out = { terms: [] as string[], dev: "", installed: false, notInstalled: false, fav: false, update: false };
  for (const tk of q.split(/\s+/)) {
    if (!tk) continue;
    if (tk.startsWith("dev:") || tk.startsWith("studio:")) out.dev = tk.slice(tk.indexOf(":") + 1).toLowerCase();
    else if (tk === "is:installed") out.installed = true;
    else if (tk === "is:notinstalled") out.notInstalled = true;
    else if (tk === "is:fav" || tk === "is:favorite") out.fav = true;
    else if (tk === "is:update" || tk === "is:updates") out.update = true;
    else out.terms.push(tk);
  }
  return out;
}

let cachedCollatorLang = "";
let cachedCollator: Intl.Collator | null = null;

function getCollator(): Intl.Collator {
  const lang = S.appLanguage || "en";
  if (cachedCollator && cachedCollatorLang === lang) return cachedCollator;
  try {
    cachedCollator = new Intl.Collator(lang, { sensitivity: "base", numeric: true });
  } catch {
    cachedCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  }
  cachedCollatorLang = lang;
  S.trCollator = cachedCollator;
  return cachedCollator;
}

let visibleCache: EpicSummary[] | null = null;
let visibleCacheSig = "";

function visibleSignature(): string {
  return [
    S.query,
    S.epicFilter,
    S.epicSort,
    S.activeCollectionId ?? "",
    String(S.libraryDataRev),
    S.appLanguage,
    String(S.epicFav.size),
    String(S.availableUpdates.size),
    S.epicRecent.join(","),
  ].join("\x1f");
}

export function invalidateLibraryVisibleCache(): void {
  visibleCache = null;
  visibleCacheSig = "";
}

export function epicVisibleSummaries(): EpicSummary[] {
  const sig = visibleSignature();
  if (visibleCache && visibleCacheSig === sig) return visibleCache;

  const q = S.query.trim().toLowerCase();
  const query = parseQuery(q);
  const activeCol =
    S.activeCollectionId && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav" && S.activeCollectionId !== "uncategorized"
      ? S.epicCollections.find((c) => c.id === S.activeCollectionId)
      : null;
  const colSet = activeCol
    ? new Set(activeCol.app_names.map((n) => n.toLowerCase()))
    : null;

  let uncatSet: Set<string> | null = null;
  if (S.activeCollectionId === "uncategorized") {
    uncatSet = new Set();
    for (const c of S.epicCollections) {
      for (const name of c.app_names) {
        uncatSet.add(name.toLowerCase());
      }
    }
  }

  const list = S.epicSummaries.filter((s) => {
    if (S.activeCollectionId === "fav") {
      if (!S.epicFav.has(s.appName)) return false;
    } else if (S.activeCollectionId === "uncategorized" && uncatSet) {
      if (uncatSet.has(s.appName.toLowerCase())) return false;
    } else if (colSet) {
      if (!colSet.has(s.appName.toLowerCase())) return false;
    }

    if (S.epicFilter === "installed" && !s.installed) return false;
    if (S.epicFilter === "fav" && !S.epicFav.has(s.appName)) return false;
    if (S.epicFilter === "updates" && !s.updateAvailable && !S.availableUpdates.has(s.appName)) return false;
    if (S.epicFilter === "platinum" && !isAppPlatinum(s.appName)) return false;

    const studio = studioOf(s).toLowerCase();
    if (query.installed && !s.installed) return false;
    if (query.notInstalled && s.installed) return false;
    if (query.fav && !S.epicFav.has(s.appName)) return false;
    if (query.update && !s.updateAvailable && !S.availableUpdates.has(s.appName)) return false;
    if (query.dev && !studio.includes(query.dev)) return false;

    const title = s.title.toLowerCase();
    for (const term of query.terms) {
      if (!title.includes(term) && !studio.includes(term)) return false;
    }
    return true;
  });

  const collator = getCollator();
  const byTitle = (a: EpicSummary, b: EpicSummary) => collator.compare(a.title, b.title);

  let result: EpicSummary[];
  switch (S.epicSort) {
    case "alpha":
      result = [...list].sort(byTitle);
      break;
    case "installed":
      result = [...list].sort((a, b) => Number(b.installed) - Number(a.installed) || byTitle(a, b));
      break;
    case "updates":
      result = [...list].sort(
        (a, b) =>
          Number(b.updateAvailable || S.availableUpdates.has(b.appName)) -
            Number(a.updateAvailable || S.availableUpdates.has(a.appName)) ||
          byTitle(a, b),
      );
      break;
    case "platinum":
      result = [...list].sort(
        (a, b) => Number(isAppPlatinum(b.appName)) - Number(isAppPlatinum(a.appName)) || byTitle(a, b),
      );
      break;
    default: {
      const recentIdxMap = new Map<string, number>();
      for (let i = 0; i < S.epicRecent.length; i++) {
        recentIdxMap.set(S.epicRecent[i], i);
      }
      result = [...list].sort((a, b) => {
        const inRecentA = recentIdxMap.has(a.appName);
        const inRecentB = recentIdxMap.has(b.appName);
        if (inRecentA && inRecentB) {
          return recentIdxMap.get(a.appName)! - recentIdxMap.get(b.appName)!;
        }
        if (inRecentA) return -1;
        if (inRecentB) return 1;

        const ptA = S.playtimeMap.get(a.appName);
        const ptB = S.playtimeMap.get(b.appName);
        const tsA = ptA?.last_played_timestamp ?? 0;
        const tsB = ptB?.last_played_timestamp ?? 0;
        if (tsA > 0 || tsB > 0) {
          if (tsA !== tsB) return tsB - tsA;
        }

        const secA = ptA?.total_seconds ?? 0;
        const secB = ptB?.total_seconds ?? 0;
        if (secA > 0 || secB > 0) {
          if (secA !== secB) return secB - secA;
        }

        if (a.installed !== b.installed) {
          return Number(b.installed) - Number(a.installed);
        }

        return byTitle(a, b);
      });
    }
  }

  visibleCache = result;
  visibleCacheSig = sig;
  return result;
}

/**
 * Grid tile: cover + one-line caption. Uninstalled games rest slightly dimmed
 * (Steam convention) instead of carrying an "Installed" badge; hover reveals
 * the single primary action.
 */
export function epicCardPortrait(s: EpicSummary): string {
  const title = esc(s.title);
  return `
    <div class="pcard${s.installed ? "" : " not-installed"}" data-act="epic-detail" data-id="${s.appName}" data-lib-item="${s.appName}" tabindex="0" role="button">
      <div class="pcard-art" data-card-art data-badge-host>
        ${epicArt(s)}
        ${libraryCardBadge(s)}
        <div class="poverlay"><div class="bottom" data-card-action>${epicActionButtons(s, "full", { primaryOnly: true })}</div></div>
        ${libraryDlBar(s.appName, epicDlProgress(s.appName))}
      </div>
      <div class="pcard-title" title="${title}">${title}</div>
    </div>`;
}

/** Dense list row: thumbnail, title + studio, playtime, size and the primary action. */
function epicListRow(s: EpicSummary): string {
  const title = esc(s.title);
  const secs = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
  return `
    <div class="lrow${s.installed ? "" : " not-installed"}" data-act="epic-detail" data-id="${s.appName}" data-lib-item="${s.appName}" tabindex="0" role="button">
      <div class="lrow-art" data-card-art>${epicArt(s)}${libraryDlBar(s.appName, epicDlProgress(s.appName))}</div>
      <div class="lrow-main">
        <div class="lrow-title" data-badge-host><span class="lrow-name" title="${title}">${title}</span>${libraryCardBadge(s)}</div>
        <div class="lrow-meta">${esc(studioOf(s))}</div>
      </div>
      <div class="lrow-col" data-lib-playtime="${s.appName}">${secs > 0 ? fmtPlaytime(secs) : "—"}</div>
      <div class="lrow-col">${s.installed && s.installSize > 0 ? fmtBytes(s.installSize) : "—"}</div>
      <div class="lrow-action" data-card-action>${epicActionButtons(s, "small", { primaryOnly: true })}</div>
    </div>`;
}

function renderItem(s: EpicSummary): string {
  return S.epicViewMode === "list" ? epicListRow(s) : epicCardPortrait(s);
}

export function resetCardChunk(): void {
  S.renderedCardCount = INITIAL_CARD_CHUNK;
}

/** Helper to retrieve cover artwork URL for collage previews. */
function coverUrlOf(s: EpicSummary): string | null {
  const custom = S.customCovers[s.appName];
  if (custom) return custom;
  const g = rawOf(s.appName);
  return (g ? epicPortrait(g) : null) || s.cover || null;
}

function collage(games: EpicSummary[], fallbackIcon: IconName): string {
  const covers: string[] = [];
  for (const g of games) {
    const url = coverUrlOf(g);
    if (url) covers.push(url);
    if (covers.length === 4) break;
  }
  if (covers.length === 0) return `<div class="col-collage-empty">${icon(fallbackIcon, 32)}</div>`;
  return `<div class="col-card-collage">${covers.map((url) => `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" />`).join("")}</div>`;
}

function folderCard(id: string, name: string, marker: IconName, games: EpicSummary[], editable: boolean): string {
  return `
    <div class="col-folder-card" data-act="open-collection" data-col-id="${esc(id)}" tabindex="0" role="button">
      <div class="col-folder-preview">${collage(games, marker)}</div>
      <div class="col-folder-footer">
        <span class="col-folder-icon">${icon(marker, 15)}</span>
        <div class="col-folder-info">
          <div class="col-folder-title" title="${esc(name)}">${esc(name)}</div>
          <div class="col-folder-count">${t("col.gameCount", { count: games.length })}</div>
        </div>
        ${editable ? `<button class="icon-btn" data-act="edit-collection" data-col-id="${esc(id)}" title="${t("lib.editCollection", { name: esc(name) })}">${icon("edit", 14)}</button>` : ""}
      </div>
    </div>`;
}

/** Collections folder gallery (separate filter mode, not a shelf on the cover wall). */
function renderCollectionsGallery(): string {
  const categorized = new Set<string>();
  for (const col of S.epicCollections) for (const name of col.app_names) categorized.add(name.toLowerCase());
  const uncategorized = S.epicSummaries.filter((s) => !categorized.has(s.appName.toLowerCase()));

  const folders = S.epicCollections.map((col) => {
    const set = new Set(col.app_names.map((n) => n.toLowerCase()));
    const games = S.epicSummaries.filter((s) => set.has(s.appName.toLowerCase()));
    return folderCard(col.id, col.name, isCollectionIcon(col.emoji) ? col.emoji : "folder", games, true);
  }).join("");

  const newCard = `
    <div class="col-folder-card new-col-card" data-act="open-new-collection-modal" tabindex="0" role="button">
      <div class="new-col-content">${icon("plus", 22)}<span class="new-col-title">${t("col.newTitle")}</span><span class="new-col-desc">${t("col.newSubtitle")}</span></div>
    </div>`;
  const uncat = uncategorized.length > 0 ? folderCard("uncategorized", t("col.noCategory"), "layers", uncategorized, false) : "";
  return `<div class="col-folders-grid">${newCard}${folders}${uncat}</div>`;
}

function collectionHeader(count: number | null): string {
  const activeCol = S.epicCollections.find((c) => c.id === S.activeCollectionId);
  const isUncat = S.activeCollectionId === "uncategorized";
  const colName = activeCol ? activeCol.name : isUncat ? t("col.noCategory") : t("lib.collections");
  const marker = activeCol && isCollectionIcon(activeCol.emoji) ? activeCol.emoji : isUncat ? "layers" : "folder";
  return `
    <div class="col-breadcrumb-header">
      <button class="btn ghost small" data-act="back-to-collections">${icon("chevron-left", 14)} ${t("lib.collections")}</button>
      <span class="col-breadcrumb-icon">${icon(marker, 16)}</span>
      <h2 class="col-breadcrumb-title">${esc(colName)}</h2>
      ${count !== null ? `<span class="lib-count">${t("lib.gameCount", { count })}</span>` : ""}
      ${activeCol ? `<button class="btn ghost small col-breadcrumb-edit" data-act="edit-collection" data-col-id="${esc(activeCol.id)}">${icon("edit", 13)} ${t("col.edit")}</button>` : ""}
    </div>`;
}

function emptyState(iconName: IconName, title: string, desc: string, action = ""): string {
  return `<div class="empty-state">${icon(iconName, 36)}<h3>${esc(title)}</h3>${desc ? `<p>${esc(desc)}</p>` : ""}${action}</div>`;
}

function renderResults(itemsHtml: string, sentinelHtml: string): string {
  if (S.epicViewMode === "list") {
    return `
      <div class="lib-list">
        <div class="lrow-head"><span></span><span>${t("lib.colTitle")}</span><span>${t("lib.colPlaytime")}</span><span>${t("lib.colSize")}</span><span></span></div>
        ${itemsHtml}${sentinelHtml}
      </div>`;
  }
  return `<div class="pgrid">${itemsHtml}${sentinelHtml}</div>`;
}

/**
 * Renders the library content area. Default All is a cover grid (or list).
 * Collections and Free Games are separate filter modes.
 */
export function renderEpicItems(): string {
  if (S.epicFilter === "freegames") {
    return renderFreeGamesGrid();
  }

  const inCollection = S.epicFilter === "collections" && S.activeCollectionId !== null;
  if (S.epicFilter === "collections" && S.query.trim().length === 0 && (S.activeCollectionId === null || S.activeCollectionId === "all")) {
    return renderCollectionsGallery();
  }

  const visible = epicVisibleSummaries();

  if (visible.length === 0) {
    if (inCollection) {
      const activeCol = S.epicCollections.find((c) => c.id === S.activeCollectionId);
      const action = activeCol ? `<button class="btn primary" data-act="edit-collection" data-col-id="${esc(activeCol.id)}">${t("col.edit")}</button>` : "";
      return `${collectionHeader(0)}${emptyState("folder", t("col.noMatch"), "", action)}`;
    }
    if (S.query.trim()) {
      return emptyState("search", t("lib.noResults"), t("lib.noResultsHint"), `<button class="btn" data-act="lib-clear-search">${t("lib.clearSearch")}</button>`);
    }
    return emptyState("gamepad-2", t("lib.noGames"), "", `<button class="btn primary" data-act="open-store">${t("nav.store")}</button>`);
  }

  const chunk = visible.slice(0, S.renderedCardCount);
  const itemsHtml = chunk.map(renderItem).join("");
  const sentinelHtml = S.renderedCardCount < visible.length ? `<div id="lib-scroll-sentinel" class="lib-sentinel"></div>` : "";

  return `${inCollection ? collectionHeader(visible.length) : ""}${renderResults(itemsHtml, sentinelHtml)}`;
}

export function setupLibScrollObserver(): void {
  if (S.libScrollObserver) {
    S.libScrollObserver.disconnect();
    S.libScrollObserver = null;
  }

  const sentinel = document.getElementById("lib-scroll-sentinel");
  if (!sentinel) return;

  const stop = (): void => {
    sentinel.remove();
    S.libScrollObserver?.disconnect();
    S.libScrollObserver = null;
  };

  S.libScrollObserver = new IntersectionObserver((entries) => {
    if (!entries[0]?.isIntersecting) return;
    const visible = epicVisibleSummaries();
    if (S.renderedCardCount >= visible.length) {
      stop();
      return;
    }
    const nextSlice = visible.slice(S.renderedCardCount, S.renderedCardCount + MORE_CARD_CHUNK);
    S.renderedCardCount += nextSlice.length;
    sentinel.insertAdjacentHTML("beforebegin", nextSlice.map(renderItem).join(""));
    if (S.renderedCardCount >= visible.length) stop();
  }, {
    root: viewEl,
    rootMargin: "450px",
  });

  S.libScrollObserver.observe(sentinel);
}

function libraryHeader(countLabel: string, tools: string, filters: string): string {
  return `
    <div class="lib-head">
      <div class="lib-title"><h1 class="page-title">${t("nav.library")}</h1><span id="lib-heading-count" class="lib-count">${countLabel}</span></div>
      <div class="lib-tools">${tools}</div>
    </div>
    <div class="tabs lib-filters">${filters}</div>`;
}

export function renderSkeletonLibrary(): string {
  const cards = Array.from({ length: 12 }, () => `<div class="pcard"><div class="pcard-art skeleton"></div><div class="pcard-title"><span class="skeleton" style="display:block;width:70%;height:12px"></span></div></div>`).join("");
  return `${libraryHeader("", "", "")}<div class="pgrid">${cards}</div>`;
}

function countUpdates(): number {
  let n = 0;
  for (const s of S.epicSummaries) {
    if (s.updateAvailable || S.availableUpdates.has(s.appName)) n++;
  }
  return n;
}

function updatesFilterBtn(count: number): string {
  return `<button class="tab lib-filter ${S.epicFilter === "updates" ? "active" : ""}" data-act="quick-tab" data-tab="updates">${t("library.updates")}<span class="count lib-filter-count">${count}</span></button>`;
}

export function syncLibraryHeadingCount(): void {
  const el = document.getElementById("lib-heading-count");
  if (el) el.textContent = t("lib.gameCount", { count: S.epicSummaries.length });
}

export function syncLibraryUpdatesTab(): void {
  const rail = document.querySelector(".lib-filters");
  if (!rail) return;
  const count = countUpdates();
  const existing = rail.querySelector<HTMLElement>(".lib-filter[data-tab='updates']");
  if (count === 0) {
    existing?.remove();
    return;
  }
  if (existing) {
    const n = existing.querySelector(".lib-filter-count");
    if (n) n.textContent = String(count);
    existing.classList.toggle("active", S.epicFilter === "updates");
    return;
  }
  rail.insertAdjacentHTML("beforeend", updatesFilterBtn(count));
}

export function refreshLibraryResultsInPlace(): boolean {
  if (S.view !== "library") return false;
  const resultsEl = document.getElementById("lib-results");
  if (!resultsEl) return false;
  resetCardChunk();
  invalidateLibraryVisibleCache();
  resultsEl.innerHTML = renderEpicItems();
  setupLibScrollObserver();
  return true;
}

function isFilterActive(tab: string | undefined): boolean {
  switch (tab) {
    case "all": return S.activeCollectionId === null && S.epicFilter === "all";
    case "fav": return S.activeCollectionId === "fav" || S.epicFilter === "fav";
    case "installed": return S.epicFilter === "installed";
    case "updates": return S.epicFilter === "updates";
    case "collections": return S.epicFilter === "collections";
    case "freegames": return S.epicFilter === "freegames";
    default: return false;
  }
}

function filterTab(tab: string, label: string): string {
  return `<button class="tab lib-filter ${isFilterActive(tab) ? "active" : ""}" data-act="quick-tab" data-tab="${tab}">${label}</button>`;
}

export function renderEpic(): string {
  if (!isTauri) {
    return emptyState("zap", t("lib.epicIntegration"), t("lib.desktopOnly"));
  }
  if (S.epicPhase === "checking" || (S.epicPhase === "library" && S.epicSummaries.length === 0)) {
    return renderSkeletonLibrary();
  }
  if (S.epicPhase === "setup" || S.epicPhase === "login") {
    return renderOnboarding();
  }
  if (S.epicPhase === "error") {
    return `
      <div class="empty-state">
        ${icon("alert-triangle", 36)}
        <h3>${t("lib.problem")}</h3>
        <p class="lib-error-code">${esc(S.epicError)}</p>
        <div class="page-actions">
          <button class="btn primary" data-act="epic-retry">${t("lib.retry")}</button>
          <button class="btn ghost danger" data-act="epic-logout">${t("lib.logoutEpic")}</button>
        </div>
        <p>${t("lib.logoutHint")}</p>
      </div>`;
  }

  // A full page rebuild must not replay a grown 200–520 card chunk.
  resetCardChunk();

  const updates = countUpdates();
  const sortOpts = getSortOptions();
  const currentSort = sortOpts.find((o) => o.id === S.epicSort) || sortOpts[0];

  const tools = `
    <label class="search lib-search">
      ${icon("search", 15)}
      <input id="search" type="search" placeholder="${t("lib.searchPlaceholder")}" value="${esc(S.query)}" autocomplete="off" spellcheck="false" />
    </label>
    <div class="sort-dropdown-container">
      <button class="btn ghost lib-sort-btn" data-act="toggle-sort-dropdown" title="${t("lib.sortTip", { label: esc(currentSort.label) })}">
        ${icon(currentSort.icon, 14)}<span class="sort-btn-label">${esc(currentSort.label)}</span>${icon("chevron-down", 12)}
      </button>
      <div id="sort-dropdown-menu" class="sort-dropdown-menu ${S.isSortDropdownOpen ? "show" : ""}">
        ${sortOpts.map((opt) => `
          <button class="ps5-context-item sort-menu-item-btn ${S.epicSort === opt.id ? "selected" : ""}" data-act="select-sort" data-sort="${opt.id}">
            ${icon(opt.icon, 14)}<span class="sort-menu-item-name">${esc(opt.label)}</span>${S.epicSort === opt.id ? icon("check", 13) : ""}
          </button>`).join("")}
      </div>
    </div>
    <div class="seg" role="group" aria-label="${t("lib.viewMode")}">
      <button class="${S.epicViewMode === "grid" ? "active" : ""}" data-act="lib-view-mode" data-val="grid" title="${t("lib.viewGrid")}">${icon("layout-grid", 14)}</button>
      <button class="${S.epicViewMode === "list" ? "active" : ""}" data-act="lib-view-mode" data-val="list" title="${t("lib.viewList")}">${icon("list", 14)}</button>
    </div>
    <button class="icon-btn lib-refresh-btn ${S.epicSyncing ? "spinning" : ""}" data-act="epic-refresh" title="${t("lib.refreshTip")}">${icon("refresh", 16)}</button>`;

  const filters = [
    filterTab("all", t("library.all")),
    filterTab("installed", t("library.installed")),
    filterTab("fav", t("library.favorites")),
    filterTab("collections", t("lib.collections")),
    filterTab("freegames", t("free.title")),
    updates > 0 ? updatesFilterBtn(updates) : "",
  ].join("");

  return `
    <div class="page lib-page">
      ${libraryHeader(t("lib.gameCount", { count: S.epicSummaries.length }), tools, filters)}
      ${S.epicSyncNote ? `<p class="page-sub">${esc(S.epicSyncNote)}</p>` : ""}
      <div id="lib-results">${renderEpicItems()}</div>
    </div>`;
}

export function updateLibraryFilterInPlace(): boolean {
  if (S.view !== "library") return false;
  const filters = document.querySelector(".lib-filters");
  const resultsEl = document.getElementById("lib-results");
  if (!filters || !resultsEl) return false;

  filters.querySelectorAll<HTMLElement>(".lib-filter[data-act='quick-tab']").forEach((tabEl) => {
    tabEl.classList.toggle("active", isFilterActive(tabEl.dataset.tab));
  });

  resetCardChunk();
  invalidateLibraryVisibleCache();
  resultsEl.innerHTML = renderEpicItems();
  setupLibScrollObserver();
  syncLibraryUpdatesTab();

  return true;
}

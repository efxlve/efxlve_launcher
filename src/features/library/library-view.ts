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
import { epicActionButtons, epicArt, epicDlProgress, isAppPlatinum } from "../../core/game-view";
import { icon } from "../../core/icons";
import { rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc } from "../../core/utils";

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

/** Cover-only tile. Hover overlay is title + one primary action. */
export function epicCardPortrait(s: EpicSummary): string {
  const p = epicDlProgress(s.appName);
  const hasUpdate = s.updateAvailable || S.availableUpdates.has(s.appName);
  const isRunning = S.runningGames.has(s.appName);
  const badge = isRunning
    ? `<span class="pbadge running">${t("lib.running")}</span>`
    : hasUpdate
      ? `<span class="pbadge update">${t("lib.updateBadge")}</span>`
      : "";
  const dlBar =
    p !== null
      ? `<div class="card-dl-track"><div class="card-dl-bar" data-dlbar="${s.appName}" style="width:${p}%"></div></div>`
      : "";

  return `
    <div class="pcard" data-act="epic-detail" data-id="${s.appName}" data-app="${s.appName}" tabindex="0" role="button">
      ${epicArt(s)}
      ${badge}
      <div class="poverlay">
        <div class="bottom">
          <div class="ptitle">${esc(s.title)}</div>
          ${epicActionButtons(s, "full", { primaryOnly: true })}
        </div>
      </div>
      ${dlBar}
    </div>`;
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

/**
 * Collections folder gallery. Kept as a separate mode from the default cover wall.
 */
function renderCollectionsGallery(): string {
  const allCategorizedApps = new Set<string>();
  for (const col of S.epicCollections) {
    for (const name of col.app_names) {
      allCategorizedApps.add(name.toLowerCase());
    }
  }

  const uncategorized = S.epicSummaries.filter((s) => !allCategorizedApps.has(s.appName.toLowerCase()));

  const renderCollage = (games: EpicSummary[]): string => {
    const validCovers: string[] = [];
    for (const g of games) {
      const url = coverUrlOf(g);
      if (url) validCovers.push(url);
      if (validCovers.length === 4) break;
    }

    if (validCovers.length === 0) {
      return `<div class="col-collage-empty">${icon("folder", 40)}</div>`;
    }

    return `
      <div class="col-card-collage count-${validCovers.length}">
        ${validCovers.map((url) => `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" />`).join("")}
      </div>`;
  };

  const folderCards = S.epicCollections.map((col) => {
    const cSet = new Set(col.app_names.map((n) => n.toLowerCase()));
    const colGames = S.epicSummaries.filter((s) => cSet.has(s.appName.toLowerCase()));
    const marker = isCollectionIcon(col.emoji) ? col.emoji : "folder";

    return `
      <div class="col-folder-card" data-act="open-collection" data-col-id="${esc(col.id)}">
        <div class="col-folder-preview">
          ${renderCollage(colGames)}
          <div class="col-folder-overlay"></div>
        </div>
        <div class="col-folder-footer">
          <div class="col-folder-info">
            <div class="col-folder-title-row">
              <span class="col-folder-icon">${icon(marker, 16)}</span>
              <h3 class="col-folder-title" title="${esc(col.name)}">${esc(col.name)}</h3>
            </div>
            <span class="col-folder-count">${t("col.gameCount", { count: colGames.length })}</span>
          </div>
          <button class="col-folder-edit-btn" data-act="edit-collection" data-col-id="${esc(col.id)}" title="${t("lib.editCollection", { name: esc(col.name) })}">
            ${icon("edit", 13)}
          </button>
        </div>
      </div>`;
  }).join("");

  const newColCard = `
    <div class="col-folder-card new-col-card" data-act="open-new-collection-modal">
      <div class="new-col-content">
        <div class="new-col-icon-wrap">${icon("plus", 22)}</div>
        <span class="new-col-title">${t("col.newTitle")}</span>
        <span class="new-col-desc">${t("col.newSubtitle")}</span>
      </div>
    </div>`;

  const uncatCard = uncategorized.length > 0 ? `
    <div class="col-folder-card uncat-card" data-act="open-collection" data-col-id="uncategorized">
      <div class="col-folder-preview">
        ${renderCollage(uncategorized)}
        <div class="col-folder-overlay"></div>
      </div>
      <div class="col-folder-footer">
        <div class="col-folder-info">
          <div class="col-folder-title-row">
            <span class="col-folder-icon">${icon("layers", 16)}</span>
            <h3 class="col-folder-title">${t("col.noCategory")}</h3>
          </div>
          <span class="col-folder-count">${t("col.gameCount", { count: uncategorized.length })}</span>
        </div>
      </div>
    </div>` : "";

  return `
    <div class="collections-gallery-view">
      <div class="col-gallery-header">
        <div class="col-gallery-header-info">
          <h2 class="col-gallery-header-title">
            ${icon("folder", 18)}
            <span>${t("lib.collections")}</span>
            <span class="shelf-badge">${S.epicCollections.length}</span>
          </h2>
        </div>
      </div>
      <div class="col-folders-grid">
        ${newColCard}
        ${folderCards}
        ${uncatCard}
      </div>
    </div>`;
}

function renderGrid(cardsHtml: string, sentinelHtml: string): string {
  return `
    <div class="pgrid size-${S.epicCardSize}">
      ${cardsHtml}
      ${sentinelHtml}
    </div>`;
}

/**
 * Renders the library content area. Default All is a cover grid.
 * Collections and Free Games are separate filter modes.
 */
export function renderEpicItems(): string {
  if (S.epicFilter === "freegames") {
    return renderFreeGamesGrid();
  }

  if (
    S.epicFilter === "collections" &&
    S.query.trim().length === 0 &&
    (S.activeCollectionId === null || S.activeCollectionId === "all")
  ) {
    return renderCollectionsGallery();
  }

  const visible = epicVisibleSummaries();

  if (visible.length === 0) {
    if (S.epicFilter === "collections" && S.activeCollectionId !== null) {
      const activeCol = S.epicCollections.find((c) => c.id === S.activeCollectionId);
      const isUncat = S.activeCollectionId === "uncategorized";
      const colName = activeCol ? activeCol.name : isUncat ? t("col.noCategory") : t("lib.collections");
      const marker = activeCol && isCollectionIcon(activeCol.emoji) ? activeCol.emoji : isUncat ? "layers" : "folder";
      return `
        <div class="col-detail-stage">
          <div class="col-breadcrumb-header">
            <button class="col-back-btn" data-act="back-to-collections">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
              <span>${t("lib.collections")}</span>
            </button>
            <span class="col-breadcrumb-sep">/</span>
            <div class="col-breadcrumb-meta">
              <span class="col-breadcrumb-icon">${icon(marker, 16)}</span>
              <h2 class="col-breadcrumb-title">${esc(colName)}</h2>
            </div>
          </div>
          <div class="empty">
            <div style="font-size:32px;margin-bottom:12px;opacity:0.5">${icon(marker, 36)}</div>
            <div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:6px">${t("col.noMatch")}</div>
            ${activeCol ? `<button class="btn install" data-act="edit-collection" data-col-id="${esc(activeCol.id)}">${t("col.edit")}</button>` : ""}
          </div>
        </div>`;
    }
    return `<div class="empty">${t("lib.noGames")}</div>`;
  }

  const chunk = visible.slice(0, S.renderedCardCount);
  const cardsHtml = chunk.map((s) => epicCardPortrait(s)).join("");

  const hasMore = S.renderedCardCount < visible.length;
  const sentinelHtml = hasMore
    ? `<div id="lib-scroll-sentinel" style="height:24px;grid-column:1/-1;width:100%;pointer-events:none;"></div>`
    : "";

  if (S.epicFilter === "collections" && S.activeCollectionId !== null) {
    const activeCol = S.epicCollections.find((c) => c.id === S.activeCollectionId);
    const isUncat = S.activeCollectionId === "uncategorized";
    const colName = activeCol ? activeCol.name : isUncat ? t("col.noCategory") : t("lib.collections");
    const marker = activeCol && isCollectionIcon(activeCol.emoji) ? activeCol.emoji : isUncat ? "layers" : "folder";
    return `
      <div class="col-detail-stage">
        <div class="col-breadcrumb-header">
          <button class="col-back-btn" data-act="back-to-collections">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
            <span>${t("lib.collections")}</span>
          </button>
          <span class="col-breadcrumb-sep">/</span>
          <div class="col-breadcrumb-meta">
            <span class="col-breadcrumb-icon">${icon(marker, 16)}</span>
            <h2 class="col-breadcrumb-title">${esc(colName)}</h2>
            <span class="shelf-badge">${visible.length}</span>
          </div>
          ${activeCol ? `
            <button class="col-breadcrumb-edit-btn" data-act="edit-collection" data-col-id="${esc(activeCol.id)}">
              ${icon("edit", 13)}
              <span>${t("col.edit")}</span>
            </button>` : ""}
        </div>
        ${renderGrid(cardsHtml, sentinelHtml)}
      </div>`;
  }

  return renderGrid(cardsHtml, sentinelHtml);
}

export function setupLibScrollObserver(): void {
  if (S.libScrollObserver) {
    S.libScrollObserver.disconnect();
    S.libScrollObserver = null;
  }

  const sentinel = document.getElementById("lib-scroll-sentinel");
  if (!sentinel) return;

  S.libScrollObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    if (!entry || !entry.isIntersecting) return;

    const visible = epicVisibleSummaries();
    if (S.renderedCardCount >= visible.length) {
      sentinel.remove();
      S.libScrollObserver?.disconnect();
      S.libScrollObserver = null;
      return;
    }

    const nextSlice = visible.slice(S.renderedCardCount, S.renderedCardCount + MORE_CARD_CHUNK);
    S.renderedCardCount += nextSlice.length;

    const newCardsHtml = nextSlice
      .map((s) => epicCardPortrait(s))
      .join("");

    sentinel.insertAdjacentHTML("beforebegin", newCardsHtml);

    if (S.renderedCardCount >= visible.length) {
      sentinel.remove();
      S.libScrollObserver?.disconnect();
      S.libScrollObserver = null;
    }
  }, {
    root: viewEl,
    rootMargin: "450px",
  });

  S.libScrollObserver.observe(sentinel);
}

export function renderSkeletonLibrary(): string {
  const skelCards = Array.from({ length: 12 })
    .map(
      () => `
      <div class="pcard skeleton-card">
        <div class="skeleton-cover"></div>
      </div>`
    )
    .join("");

  return `
    <div class="lib-top-bar">
      <div class="lib-title-group">
        <h1 class="lib-heading">${t("nav.library")}</h1>
      </div>
    </div>
    <div class="lib-unified-toolbar">
      <div class="unified-toolbar-left">
        <div class="lib-filters">
          <div class="skeleton-pill" style="width:48px;height:20px;border-radius:4px;"></div>
          <div class="skeleton-pill" style="width:64px;height:20px;border-radius:4px;"></div>
          <div class="skeleton-pill" style="width:72px;height:20px;border-radius:4px;"></div>
        </div>
      </div>
      <div class="unified-toolbar-right">
        <div class="skeleton-pill" style="width:180px;height:32px;border-radius:8px;"></div>
      </div>
    </div>
    <div class="pgrid size-${S.epicCardSize}">${skelCards}</div>`;
}

function countUpdates(): number {
  let n = 0;
  for (const s of S.epicSummaries) {
    if (s.updateAvailable || S.availableUpdates.has(s.appName)) n++;
  }
  return n;
}

function updatesFilterBtn(count: number): string {
  return `<button class="lib-filter ${S.epicFilter === "updates" ? "active" : ""}" data-act="quick-tab" data-tab="updates">
    <span>${t("library.updates")}</span>
    <span class="lib-filter-count">${count}</span>
  </button>`;
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

export function renderEpic(): string {
  if (!isTauri) {
    return `<h2>${icon("zap", 18)} Epic</h2><p class="subtitle">${t("lib.epicIntegration")}</p><div class="empty">${t("lib.desktopOnly")}</div>`;
  }
  if (S.epicPhase === "checking" || (S.epicPhase === "library" && S.epicSummaries.length === 0)) {
    return renderSkeletonLibrary();
  }
  if (S.epicPhase === "setup" || S.epicPhase === "login") {
    return renderOnboarding();
  }
  if (S.epicPhase === "error") {
    return `
      <h2>${t("nav.library")}</h2><p class="subtitle">${t("lib.problem")}</p>
      <div class="settings-box">
        <p><code>${esc(S.epicError)}</code></p>
        <p style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn ghost" data-act="epic-retry">${t("lib.retry")}</button>
          <button class="btn danger" data-act="epic-logout">${t("lib.logoutEpic")}</button>
        </p>
        <p class="muted">${t("lib.logoutHint")}</p>
      </div>`;
  }

  // A full page rebuild must not replay a grown 200–520 card chunk.
  resetCardChunk();

  const allUpdatesCount = countUpdates();
  const currentSortOpt = getSortOptions().find((o) => o.id === S.epicSort) || getSortOptions()[0];

  return `
    <div class="lib-top-bar">
      <div class="lib-title-group">
        <h1 class="lib-heading">${t("nav.library")}</h1>
        <span id="lib-heading-count" class="lib-heading-count">${t("lib.gameCount", { count: S.epicSummaries.length })}</span>
      </div>
      <div class="lib-top-actions">
        <button class="lib-refresh-btn ${S.epicSyncing ? "spinning" : ""}" data-act="epic-refresh" title="${t("lib.refreshTip")}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
            <path d="M16 21h5v-5"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="lib-unified-toolbar">
      <div class="unified-toolbar-left">
        <div class="lib-filters">
          <button class="lib-filter ${S.activeCollectionId === null && S.epicFilter === "all" ? "active" : ""}" data-act="quick-tab" data-tab="all">${t("library.all")}</button>
          <button class="lib-filter ${S.epicFilter === "installed" ? "active" : ""}" data-act="quick-tab" data-tab="installed">${t("library.installed")}</button>
          <button class="lib-filter ${S.activeCollectionId === "fav" || S.epicFilter === "fav" ? "active" : ""}" data-act="quick-tab" data-tab="fav">${t("library.favorites")}</button>
          <button class="lib-filter ${S.epicFilter === "collections" ? "active" : ""}" data-act="quick-tab" data-tab="collections">${t("lib.collections")}</button>
          <button class="lib-filter ${S.epicFilter === "freegames" ? "active" : ""}" data-act="quick-tab" data-tab="freegames">${t("free.title")}</button>
          ${allUpdatesCount > 0 ? updatesFilterBtn(allUpdatesCount) : ""}
        </div>
      </div>

      <div class="unified-toolbar-right">
        <label class="lib-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="search" type="search" placeholder="${t("lib.searchPlaceholder")}" value="${esc(S.query)}" autocomplete="off" spellcheck="false" />
        </label>

        <div class="sort-dropdown-container">
          <button class="lib-sort-btn" data-act="toggle-sort-dropdown" title="${t("lib.sortTip", { label: esc(currentSortOpt.label) })}">
            ${icon(currentSortOpt.icon, 13)}
            <span class="sort-btn-label">${esc(currentSortOpt.label)}</span>
            <span class="dropdown-chevron">${icon("chevron-down", 12)}</span>
          </button>
          <div id="sort-dropdown-menu" class="sort-dropdown-menu ${S.isSortDropdownOpen ? "show" : ""}">
            <div class="sort-menu-header">${t("lib.sort")}</div>
            <div class="sort-menu-list">
              ${getSortOptions().map((opt) => {
                const isSelected = S.epicSort === opt.id;
                return `
                  <button class="sort-menu-item-btn ${isSelected ? "selected" : ""}" data-act="select-sort" data-sort="${opt.id}">
                    <span class="sort-menu-item-icon">${icon(opt.icon, 13)}</span>
                    <span class="sort-menu-item-name" style="flex:1">${esc(opt.label)}</span>
                    ${isSelected ? icon("check", 12) : ""}
                  </button>
                `;
              }).join("")}
            </div>
          </div>
        </div>
      </div>
    </div>

    ${S.epicSyncNote ? `<p class="subtitle">${esc(S.epicSyncNote)}</p>` : ""}
    <div id="lib-results">${renderEpicItems()}</div>`;
}

export function updateLibraryFilterInPlace(): boolean {
  if (S.view !== "library") return false;
  const toolbar = document.querySelector(".lib-unified-toolbar");
  const resultsEl = document.getElementById("lib-results");
  if (!toolbar || !resultsEl) return false;

  toolbar.querySelectorAll<HTMLElement>(".lib-filter[data-act='quick-tab']").forEach((tabEl) => {
    const tab = tabEl.dataset.tab;
    const isAct =
      tab === "all"
        ? S.activeCollectionId === null && S.epicFilter === "all"
        : tab === "fav"
          ? S.activeCollectionId === "fav" || S.epicFilter === "fav"
          : tab === "installed"
            ? S.epicFilter === "installed"
            : tab === "updates"
              ? S.epicFilter === "updates"
              : tab === "collections"
                ? S.epicFilter === "collections"
                : tab === "freegames"
                  ? S.epicFilter === "freegames"
                  : false;
    tabEl.classList.toggle("active", isAct);
  });

  document.querySelector(".plat-category-banner")?.remove();

  resetCardChunk();
  invalidateLibraryVisibleCache();
  resultsEl.innerHTML = renderEpicItems();
  setupLibScrollObserver();
  syncLibraryUpdatesTab();

  return true;
}

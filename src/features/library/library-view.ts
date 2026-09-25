/**
 * Library view: quiet Steam / Epic cover wall.
 *
 * Default All is a portrait grid only. Filters are plain text. Cards rest as
 * covers. Hover scales the cover with a light rim. The only badge is Running.
 * Full-page innerHTML of a grown 500-card chunk is treated as a bug.
 */

import { INITIAL_CARD_CHUNK, MORE_CARD_CHUNK, isTauri } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { epicActionButtons, epicArt, epicDlProgress, isAppPlatinum, libraryCardBadge, libraryCoverStats, libraryDlBar } from "../../core/game-view";
import { emptyState, icon } from "../../core/icons";
import { rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";

import { epicReorderCollections, type EpicSummary } from "../../epic";
import type { EpicSort } from "../../core/types";
import { t } from "../../i18n";
/** Sort options shown in the library sort dropdown, in the menu order. */
export function getSortOptions(): { id: EpicSort; label: string }[] {
  return [
    { id: "alpha", label: t("lib.sortAlpha") },
    { id: "recent", label: t("lib.sortRecent") },
    { id: "played", label: t("lib.sortPlayed") },
    { id: "achievements", label: t("lib.sortAchievements") },
    { id: "installed", label: t("lib.sortInstalled") },
    { id: "alphaDesc", label: t("lib.sortAlphaDesc") },
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

/** Higher means more of the achievement set is unlocked. Games without data stay at the bottom. */
function achievementRank(appName: string): number {
  const a = S.epicAchSummaries[appName];
  if (!a?.supported || !a.total_achievements) return 0;
  return a.user_unlocked / a.total_achievements;
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
    [...S.hiddenGames].sort().join(","),
    String(S.availableUpdates.size),
    String(S.playtimeMap.size),
    String(Object.keys(S.epicAchSummaries).length),
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
    if (S.hiddenGames.has(s.appName)) return false;
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
    case "alphaDesc":
      result = [...list].sort((a, b) => byTitle(b, a));
      break;
    case "installed":
      result = [...list].sort((a, b) => Number(b.installed) - Number(a.installed) || byTitle(a, b));
      break;
    case "played":
      result = [...list].sort(
        (a, b) =>
          (S.playtimeMap.get(b.appName)?.total_seconds ?? 0) - (S.playtimeMap.get(a.appName)?.total_seconds ?? 0) ||
          byTitle(a, b),
      );
      break;
    case "achievements":
      result = [...list].sort((a, b) => achievementRank(b.appName) - achievementRank(a.appName) || byTitle(a, b));
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
 * Grid tile is the portrait only. Hover grows the whole tile, not the image inside it.
 */
export function epicCardPortrait(s: EpicSummary): string {
  const title = esc(s.title);
  return `
    <div class="pcard${s.installed ? "" : " not-installed"}" data-act="epic-detail" data-id="${s.appName}" data-lib-item="${s.appName}" tabindex="0" role="button" title="${title}">
      <div class="pcard-art" data-card-art data-badge-host>
        ${epicArt(s)}
        ${libraryCoverStats(s.appName)}
        ${libraryCardBadge(s)}
        ${libraryDlBar(s.appName, epicDlProgress(s.appName))}
      </div>
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
  const inCollection = S.activeCollectionId !== null && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav";
  const visible = epicVisibleSummaries();

  if (visible.length === 0) {
    if (inCollection) {
      const activeCol = S.epicCollections.find((c) => c.id === S.activeCollectionId);
      const action = activeCol ? `<button class="btn primary" data-act="edit-collection" data-col-id="${esc(activeCol.id)}">${t("col.edit")}</button>` : "";
      return emptyState("folder", t("col.noMatch"), "", action);
    }
    if (S.query.trim()) {
      return emptyState("search", t("lib.noResults"), t("lib.noResultsHint"), `<button class="btn" data-act="lib-clear-search">${t("lib.clearSearch")}</button>`);
    }
    return emptyState("gamepad-2", t("lib.noGames"), "", `<button class="btn primary" data-act="open-store">${t("nav.store")}</button>`);
  }

  const chunk = visible.slice(0, S.renderedCardCount);
  const itemsHtml = chunk.map(renderItem).join("");
  const sentinelHtml = S.renderedCardCount < visible.length ? `<div id="lib-scroll-sentinel" class="lib-sentinel"></div>` : "";

  return renderResults(itemsHtml, sentinelHtml);
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

function libraryHeader(tools: string, filters: string): string {
  return `
    <div class="lib-head">
      <div class="tabs lib-filters">${filters}</div>
      <div class="lib-tools">${tools}</div>
    </div>`;
}

export function renderSkeletonLibrary(): string {
  const cards = Array.from({ length: 12 }, () => `<div class="pcard"><div class="pcard-art skeleton"></div></div>`).join("");
  return `${libraryHeader("", "")}<div class="pgrid">${cards}</div>`;
}

export function syncLibraryHeadingCount(): void {
  const el = document.getElementById("lib-heading-count");
  if (!el) return;
  const show = S.view === "library" && !S.currentModalAppName && S.epicSummaries.length > 0;
  el.textContent = t("lib.gameCount", { count: S.epicSummaries.length });
  el.hidden = !show;
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

function isFilterActive(tab: string | undefined, colId?: string): boolean {
  if (tab === "collection") return !!colId && S.activeCollectionId === colId;
  switch (tab) {
    case "all": return S.activeCollectionId === null && S.epicFilter === "all";
    case "fav": return S.activeCollectionId === "fav";
    case "installed": return S.epicFilter === "installed";
    case "updates": return S.epicFilter === "updates";
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
    return emptyState("layers", t("lib.connectTitle"), t("lib.connectDesc"), `<button class="btn primary" data-view="accounts">${t("accounts.connectCta")}</button>`);
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

  if (S.epicFilter === "updates" || S.epicFilter === "installed" || S.epicFilter === "collections") S.epicFilter = "all";
  const sortOpts = getSortOptions();
  const currentSort = sortOpts.find((o) => o.id === S.epicSort) || sortOpts[0];

  const tools = `
    <div class="sort-dropdown-container">
      <button class="btn ghost lib-sort-btn" data-act="toggle-sort-dropdown" title="${t("lib.sortTip", { label: esc(currentSort.label) })}">
        <span class="lib-sort-kicker">${esc(t("lib.sortBy"))}</span>
        <span class="sort-btn-label">${esc(currentSort.label)}</span>
        ${icon(S.isSortDropdownOpen ? "chevron-up" : "chevron-down", 14)}
      </button>
      <div id="sort-dropdown-menu" class="sort-dropdown-menu ${S.isSortDropdownOpen ? "show" : ""}">
        ${sortOpts.map((opt) => `
          <button class="sort-menu-item-btn ${S.epicSort === opt.id ? "selected" : ""}" data-act="select-sort" data-sort="${opt.id}">${esc(opt.label)}</button>`).join("")}
      </div>
    </div>
    <div class="seg" role="group" aria-label="${t("lib.viewMode")}">
      <button class="${S.epicViewMode === "grid" ? "active" : ""}" data-act="lib-view-mode" data-val="grid" title="${t("lib.viewGrid")}">${icon("layout-grid", 14)}</button>
      <button class="${S.epicViewMode === "list" ? "active" : ""}" data-act="lib-view-mode" data-val="list" title="${t("lib.viewList")}">${icon("list", 14)}</button>
    </div>
    <button class="icon-btn lib-refresh-btn ${S.epicSyncing ? "spinning" : ""}" data-act="epic-refresh" title="${t("lib.refreshTip")}">${icon("refresh", 16)}</button>`;

  const filters = [
    filterTab("all", t("library.all")),
    filterTab("fav", t("library.favorites")),
    ...S.epicCollections.map((col) =>
      `<button class="tab lib-filter lib-col-tab ${S.activeCollectionId === col.id ? "active" : ""}" data-act="quick-tab" data-tab="collection" data-col-id="${esc(col.id)}">${esc(col.name)}</button>`,
    ),
    `<button class="icon-btn lib-col-add" data-act="open-new-collection-modal" title="${esc(t("col.newTitle"))}">${icon("plus", 16)}</button>`,
  ].join("");

  return `
    <div class="page lib-page">
      ${libraryHeader(tools, filters)}
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
    tabEl.classList.toggle("active", isFilterActive(tabEl.dataset.tab, tabEl.dataset.colId));
  });

  resetCardChunk();
  invalidateLibraryVisibleCache();
  resultsEl.innerHTML = renderEpicItems();
  setupLibScrollObserver();
  return true;
}

/** Set while a collection tab is dragged so the following click does not also select it. */
let collectionDragged = false;

export function consumeCollectionDragClick(): boolean {
  if (!collectionDragged) return false;
  collectionDragged = false;
  return true;
}

/** Hold-and-drag reorder. A draggable button never starts a drag in WebView2. */
export function initCollectionTabs(): void {
  let tab: HTMLElement | null = null;
  let startX = 0;
  let moved = false;

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const hit = (e.target as HTMLElement).closest<HTMLElement>(".lib-col-tab");
    if (!hit?.dataset.colId) return;
    collectionDragged = false;
    tab = hit;
    startX = e.clientX;
    moved = false;
  });

  document.addEventListener("mousemove", (e) => {
    if (!tab) return;
    if (!moved) {
      if (Math.abs(e.clientX - startX) < 5) return;
      moved = true;
      collectionDragged = true;
      tab.classList.add("dragging");
    }
    const bar = tab.parentElement;
    const add = bar?.querySelector(".lib-col-add");
    if (!bar || !add) return;
    let before: Element = add;
    for (const other of bar.querySelectorAll<HTMLElement>(".lib-col-tab")) {
      if (other === tab) continue;
      const rect = other.getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 2) {
        before = other;
        break;
      }
    }
    if (tab.nextElementSibling !== before) slideCollectionTabs(bar, tab, before);
  });

  document.addEventListener("mouseup", () => {
    if (!tab) return;
    tab.classList.remove("dragging");
    const didMove = moved;
    const bar = tab.parentElement;
    tab = null;
    moved = false;
    if (!didMove || !bar) return;
    const ids = [...bar.querySelectorAll<HTMLElement>(".lib-col-tab")]
      .map((el) => el.dataset.colId)
      .filter((id): id is string => Boolean(id));
    void persistCollectionOrder(ids);
  });
}

/** Slide tabs from their previous x into the new order. One shot, no idle loop. */
function slideCollectionTabs(bar: HTMLElement, dragged: HTMLElement, before: Element): void {
  const tabs = [...bar.querySelectorAll<HTMLElement>(".lib-col-tab")];
  const from = new Map(tabs.map((el) => [el, el.getBoundingClientRect().left]));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  bar.insertBefore(dragged, before);
  if (reduce) return;
  for (const el of tabs) {
    const dx = (from.get(el) ?? 0) - el.getBoundingClientRect().left;
    if (dx === 0) continue;
    el.style.transition = "none";
    el.style.transform = `translateX(${dx}px)`;
    requestAnimationFrame(() => {
      el.style.transition = "transform 140ms ease-out";
      el.style.transform = "";
      el.addEventListener("transitionend", () => {
        el.style.transition = "";
      }, { once: true });
    });
  }
}

async function persistCollectionOrder(ids: string[]): Promise<void> {
  const byId = new Map(S.epicCollections.map((c) => [c.id, c]));
  S.epicCollections = ids.flatMap((id) => {
    const col = byId.get(id);
    return col ? [col] : [];
  });
  try {
    await epicReorderCollections(ids);
  } catch (err) {
    toast(String(err));
  }
}

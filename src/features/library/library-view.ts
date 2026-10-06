/**
 * Library view: quiet Steam / Epic cover wall.
 *
 * Default All is a portrait grid only. Filters are plain text. Cards rest as
 * covers. Hover scales the cover with a light rim. The only badge is Running.
 * Full-page innerHTML of a grown 500-card chunk is treated as a bug.
 */

import { INITIAL_CARD_CHUNK, LIB_PAGE_SIZES, MORE_CARD_CHUNK, isTauri } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { achSummaryOf, epicActionButtons, epicArt, epicDlProgress, isAppPlatinum, libraryCardBadge, libraryCoverStats, libraryDlBar, libraryInstalledIcon, libraryListDimmed, listAchievementCell, patchLibraryCardDom } from "../../core/game-view";
import { emptyState, icon } from "../../core/icons";
import { canonicalGameTitle, gameStoresLabel, libraryItemToSummary, sourceOfKey, totalLibraryGamesCount } from "../../core/selectors";
import { storeLogo } from "../store/store-logos";
import { STORE_LABELS } from "../store/store-view";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";

import { epicReorderCollections, type EpicSummary } from "../../epic";
import type { EpicSort, GameSource } from "../../core/types";
import { t } from "../../i18n";
import { sharedSummaries } from "./shared-library";
import { allStoresMenuCount, enabledStoreKey, pickShownCopy, storeFilterLabel, storeFilterMenuHtml, storeFilterRowOn } from "./store-filter";
import { LIB_FILTERS_ENABLED, libFiltersActiveCount, matchesLibFilters, renderLibFilterPanel, studioOf } from "./library-filters";
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

/**
 * Parses the search box into plain terms plus `key:value` operators:
 * `dev:<studio>`, `is:installed|notinstalled|fav|update|epic|gog`.
 */
function parseQuery(q: string): {
  terms: string[];
  dev: string;
  installed: boolean;
  notInstalled: boolean;
  fav: boolean;
  update: boolean;
  source: string;
} {
  const out = { terms: [] as string[], dev: "", installed: false, notInstalled: false, fav: false, update: false, source: "" };
  for (const tk of q.split(/\s+/)) {
    if (!tk) continue;
    if (tk.startsWith("dev:") || tk.startsWith("studio:")) out.dev = tk.slice(tk.indexOf(":") + 1).toLowerCase();
    else if (tk === "is:installed") out.installed = true;
    else if (tk === "is:notinstalled") out.notInstalled = true;
    else if (tk === "is:fav" || tk === "is:favorite") out.fav = true;
    else if (tk === "is:update" || tk === "is:updates") out.update = true;
    else if (tk === "is:epic") out.source = "epic";
    else if (tk === "is:gog") out.source = "gog";
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
  const a = achSummaryOf(appName);
  if (!a?.supported || !a.total_achievements) return 0;
  return a.user_unlocked / a.total_achievements;
}

let visibleCache: EpicSummary[] | null = null;
let visibleCacheSig = "";

function visibleSignature(): string {
  // Only cheap, stable keys belong here. Counters such as fav/update/playtime
  // sizes miss add+remove pairs, so those writers bump `libraryDataRev`.
  return [
    S.query,
    S.epicFilter,
    S.epicSort,
    enabledStoreKey(),
    S.activeCollectionId ?? "",
    String(S.libraryDataRev),
    S.appLanguage,
    S.epicRecent.join(","),
  ].join("\x1f");
}

export function invalidateLibraryVisibleCache(): void {
  visibleCache = null;
  visibleCacheSig = "";
  S.libraryVisibleCount = -1;
}

/** Base list after query, tab, collection and store filters; facets excluded. */
export function libraryFilteredList(): EpicSummary[] {
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

  const baseItems = libraryBaseItems();

  const list = baseItems.filter((s) => {
    if (query.source === "epic" && s.appName.startsWith("gog::")) return false;
    if (query.source === "epic" && s.appName.startsWith("steam::")) return false;
    if (query.source === "gog" && !s.appName.startsWith("gog::")) return false;
    if (query.source === "steam" && !s.appName.startsWith("steam::")) return false;

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
  return list;
}

export function epicVisibleSummaries(): EpicSummary[] {
  const sig = visibleSignature();
  if (visibleCache && visibleCacheSig === sig) return visibleCache;

  const list = libraryFilteredList().filter(matchesLibFilters);
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
  S.libraryVisibleCount = result.length;
  return result;
}

/**
 * One row per title, limited to the storefronts that are checked.
 * A saved store choice supplies the playtime and trophies on that card.
 */
function libraryBaseItems(): EpicSummary[] {
  const groups = new Map<string, EpicSummary[]>();
  const push = (s: EpicSummary): void => {
    if (S.hiddenGames.has(s.appName)) return;
    const canon = canonicalGroup(s);
    const list = groups.get(canon);
    if (list) list.push(s);
    else groups.set(canon, [s]);
  };
  if (S.enabledStores.has("epic")) {
    for (const s of S.epicSummaries) push(s);
    for (const s of sharedSummaries()) {
      if (!s.appName.startsWith("gog::")) push(s);
    }
  }
  if (S.enabledStores.has("gog")) {
    for (const g of S.gogSummaries) push(libraryItemToSummary(g));
    for (const s of sharedSummaries()) {
      if (s.appName.startsWith("gog::")) push(s);
    }
  }
  if (S.enabledStores.has("amazon")) {
    for (const g of S.amazonSummaries) push(libraryItemToSummary(g));
  }
  if (S.enabledStores.has("steam")) {
    for (const g of S.steamSummaries) push(libraryItemToSummary(g));
  }
  for (const g of S.companionSummaries) {
    if (S.enabledStores.has(g.source)) push(libraryItemToSummary(g));
  }
  const out: EpicSummary[] = [];
  for (const list of groups.values()) out.push(pickShownCopy(list));
  return out;
}

function canonicalGroup(s: EpicSummary): string {
  return canonicalGameTitle(s.title) || `\0${s.appName}`;
}

/**
 * Grid tile is the portrait only, plus an optional caption under the cover
 * ("Titles under covers" in Settings). Hover grows the cover frame, not the caption.
 * The caption already shows the name, so the card does not also set a title
 * tooltip (that tooltip is a square system box on the rounded cover).
 */
export function epicCardPortrait(s: EpicSummary): string {
  const title = esc(s.title);
  const showStores = S.showStoreBadge && S.enabledStores.size > 1;
  const storesLabel = showStores ? esc(gameStoresLabel(s.title || s.appName)) : "";
  const playBtnHtml = libraryInstalledIcon(s.appName, s.installed);
  const titleRow = S.showCoverTitles
    ? `<span class="pcard-title-row"><span class="pcard-title" title="${title}">${title}</span>${playBtnHtml}</span>`
    : "";
  const caption = (S.showCoverTitles || Boolean(storesLabel))
    ? `<div class="pcard-caption">
        ${titleRow}
        ${storesLabel ? `<span class="pcard-stores">${storesLabel}</span>` : ""}
      </div>`
    : "";
  const tip = S.showCoverTitles ? "" : ` title="${title}"`;
  const source = sourceOfKey(s.appName);
  // Optional: the storefront mark on the cover (bottom-right, clear of the
  // stats chips on the left and the running badge on the top-right).
  const storeIcon = S.showStoreIcons ? `<span class="cover-store">${storeLogo(source, 14, "cover-store-logo")}</span>` : "";
  return `
    <div class="pcard${s.installed ? "" : " not-installed"}" data-act="epic-detail" data-id="${s.appName}" data-source="${source}" data-lib-item="${s.appName}" tabindex="0" role="button"${tip}>
      <div class="pcard-art" data-card-art data-badge-host>
        ${epicArt(s)}
        ${storeIcon}
        ${libraryCoverStats(s.appName)}
        ${libraryCardBadge(s)}
        ${libraryDlBar(s.appName, epicDlProgress(s.appName))}
      </div>
      ${caption}
    </div>`;
}

/** Dense list row: thumbnail, title + studio, playtime, size and the primary action. */
function epicListRow(s: EpicSummary): string {
  const title = esc(s.title);
  const secs = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
  const source = sourceOfKey(s.appName);
  const showStores = S.showStoreBadge && S.enabledStores.size > 1;
  const storesLabel = showStores ? esc(gameStoresLabel(s.title || s.appName)) : "";
  const studio = esc(studioOf(s));
  const metaText = [studio, storesLabel].filter(Boolean).join(" · ");
  // The storefront column is always on, aligned like the achievements column.
  const storeCell = `<div class="lrow-store">${storeLogo(source, 16, "lrow-store-logo")}<span class="lrow-store-name">${esc(sourceLabel(source))}</span></div>`;
  return `
    <div class="lrow${libraryListDimmed(s) ? " not-installed" : ""}" data-act="epic-detail" data-id="${s.appName}" data-source="${source}" data-lib-item="${s.appName}" tabindex="0" role="button">
      <div class="lrow-art" data-card-art>${epicArt(s)}${libraryDlBar(s.appName, epicDlProgress(s.appName))}</div>
      <div class="lrow-main">
        <div class="lrow-title" data-badge-host><span class="lrow-name" title="${title}">${title}</span>${libraryCardBadge(s)}</div>
        <div class="lrow-meta">${metaText}</div>
      </div>
      ${storeCell}
      <div class="lrow-col" data-lib-ach="${s.appName}">${listAchievementCell(s.appName)}</div>
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

/** Brand label for a library source. Amazon's and Riot's library ids differ
 *  from the store-tab ids, so they are mapped here instead of falling back to
 *  the raw lowercase id. */
function sourceLabel(source: string): string {
  if (source === "amazon") return "Amazon Games";
  if (source === "riot") return "Riot Games";
  return (STORE_LABELS as Record<string, string>)[source] ?? source;
}

function renderResults(itemsHtml: string, sentinelHtml: string): string {
  const isHighlight = S.highlightInstalled ?? (S.dimUninstalled || S.contrastTitles);
  const highlightCls = isHighlight ? " dim-uninstalled contrast-titles highlight-installed" : "";
  if (S.epicViewMode === "list") {
    return `
      <div class="lib-list${highlightCls} has-store-col has-ach-progress">
        <div class="lrow-head"><span></span><span>${t("lib.colTitle")}</span><span>${t("lib.colStore")}</span><span>${t("lib.colAchievements")}</span><span>${t("lib.colPlaytime")}</span><span>${t("lib.colSize")}</span><span></span></div>
        ${itemsHtml}${sentinelHtml}
      </div>`;
  }
  return `<div class="pgrid${S.showCoverTitles || S.showStoreBadge ? " has-captions" : ""}${highlightCls}">${itemsHtml}${sentinelHtml}</div>`;
}

/**
 * Result-set fingerprint. Any change to query, filter, sort, collection or page
 * size restarts pagination at page 1; page navigation itself is preserved.
 */
let lastResultKey = "";

/** Page numbers with gap markers, e.g. 1 … 4 5 6 … 29. */
function pageNumbers(page: number, pages: number): (number | "gap")[] {
  const wanted = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]);
  const ordered = [...wanted].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  let prev = 0;
  for (const n of ordered) {
    if (prev > 0 && n - prev > 1) out.push("gap");
    out.push(n);
    prev = n;
  }
  return out;
}

/** Optional pagination bar: range label, page buttons and a page-size picker. */
function renderLibraryPager(total: number): string {
  if (!S.libPagination) return "";
  const size = S.libPageSize;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, S.libPage), pages);
  const from = (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  const buttons = pageNumbers(page, pages)
    .map((n) =>
      n === "gap"
        ? `<span class="lib-pager-gap">…</span>`
        : `<button class="btn ${n === page ? "primary" : "ghost"} small lib-pager-num" data-act="lib-page" data-page="${n}" title="${t("lib.pageNumber", { n })}" aria-label="${t("lib.pageNumber", { n })}">${n}</button>`,
    )
    .join("");
  return `
    <div class="lib-pager">
      <span class="lib-pager-range">${t("lib.showingRange", { from, to, total })}</span>
      <div class="lib-pager-pages">
        <button class="btn ghost small icon-only" data-act="lib-page-prev" title="${t("lib.pagePrev")}" aria-label="${t("lib.pagePrev")}" ${page <= 1 ? "disabled" : ""}>${icon("chevron-left", 14)}</button>
        ${buttons}
        <button class="btn ghost small icon-only" data-act="lib-page-next" title="${t("lib.pageNext")}" aria-label="${t("lib.pageNext")}" ${page >= pages ? "disabled" : ""}>${icon("chevron-right", 14)}</button>
      </div>
      <label class="lib-pager-size">
        <span>${t("lib.pageSize")}</span>
        <select class="settings-select" data-act="lib-page-size" aria-label="${t("lib.pageSize")}">
          ${LIB_PAGE_SIZES.map((n) => `<option value="${n}" ${n === size ? "selected" : ""}>${n}</option>`).join("")}
        </select>
      </label>
    </div>`;
}

/** Result-set fingerprint. A change restarts pagination and the card chunk. */
function libraryResultKey(): string {
  return [S.query, S.epicFilter, S.epicSort, S.activeCollectionId ?? "", S.libPageSize, S.libPagination, enabledStoreKey(), String(S.libFiltersRev)].join("\x1f");
}

/**
 * Collections fingerprint (names and row counts). The dropdown counts live in
 * the header, which the in-place patch skips, so a change forces a full repaint
 * instead of leaving stale numbers behind.
 */
let lastCollectionsSig = "";

function collectionsSignature(): string {
  return S.epicCollections.map((c) => `${c.id}\x1f${c.name}\x1f${c.app_names.length}`).join("\x1e");
}

/**
 * Renders the library content area. Default All is a cover grid (or list).
 * Collections are a separate filter mode.
 */
export function renderEpicItems(): string {
  const inCollection = S.activeCollectionId !== null && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav";
  // Any change to the result set definition restarts pagination at page 1.
  const resultKey = libraryResultKey();
  if (resultKey !== lastResultKey) {
    lastResultKey = resultKey;
    S.libPage = 1;
    // A new result set starts at the first card chunk. Re-renders for the same
    // set keep the grown chunk, so a scrolled grid is not collapsed to the top.
    resetCardChunk();
  }
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
    // Favorites empty: send the user back to the whole library, not the store.
    if (S.activeCollectionId === "fav") {
      return emptyState(
        "heart",
        t("lib.favEmptyTitle"),
        t("lib.favEmptyHint"),
        `<button class="btn primary" data-act="quick-tab" data-tab="all">${t("lib.favEmptyCta")}</button>`,
      );
    }
    return emptyState("gamepad-2", t("lib.noGames"), "", `<button class="btn primary" data-act="open-store">${t("nav.store")}</button>`);
  }

  const chunk = renderedSlice(visible);
  const sentinelHtml = !S.libPagination && S.renderedCardCount < visible.length
    ? `<div id="lib-scroll-sentinel" class="lib-sentinel"></div>`
    : "";
  const itemsHtml = chunk.map(renderItem).join("");

  return `${renderResults(itemsHtml, sentinelHtml)}${renderLibraryPager(visible.length)}`;
}

/** The summaries the current grid renders, in order (page or chunk). */
function renderedSlice(visible: EpicSummary[]): EpicSummary[] {
  if (S.libPagination) {
    const pages = Math.max(1, Math.ceil(visible.length / S.libPageSize));
    S.libPage = Math.min(Math.max(1, S.libPage), pages);
    const start = (S.libPage - 1) * S.libPageSize;
    return visible.slice(start, start + S.libPageSize);
  }
  return visible.slice(0, S.renderedCardCount);
}

/**
 * Patches the rendered cards when the result set is unchanged, so a data
 * arrival (playtime, achievements, install state) does not rebuild the grid and
 * re-decode every cover. Returns false when the grid needs a full rebuild.
 */
export function patchLibraryGridInPlace(): boolean {
  if (S.view !== "library") return false;
  const resultsEl = document.getElementById("lib-results");
  if (!resultsEl) return false;
  // Collection counts and labels live in the header; a change needs the full
  // page rebuild, not the card-only patch.
  if (collectionsSignature() !== lastCollectionsSig) return false;
  // The sync note sits outside the grid; a changed note needs a full rebuild.
  const noteEl = document.getElementById("lib-sync-note");
  if ((noteEl?.textContent ?? "") !== (S.epicSyncNote || "")) return false;
  const rendered = [...resultsEl.querySelectorAll<HTMLElement>("[data-lib-item]")];
  if (rendered.length === 0) return false;
  const expected = renderedSlice(epicVisibleSummaries());
  if (expected.length !== rendered.length) return false;
  for (let i = 0; i < rendered.length; i++) {
    if ((rendered[i].dataset.libItem || "") !== expected[i].appName) return false;
  }
  for (const item of rendered) patchLibraryCardDom(item.dataset.libItem || "");
  syncLibraryHeadingCount();
  return true;
}

let cardSettleWired = false;

/** Keep the grown cover unclipped until its shrink finishes. */
function wireCardSettle(): void {
  if (cardSettleWired) return;
  cardSettleWired = true;
  document.addEventListener("pointerout", (e) => {
    const card = (e.target as HTMLElement | null)?.closest<HTMLElement>(".pcard");
    if (!card) return;
    const next = e.relatedTarget as Node | null;
    if (next && card.contains(next)) return;
    card.classList.add("pcard-settling");
    window.setTimeout(() => card.classList.remove("pcard-settling"), 150);
  });
}

wireCardSettle();

export function setupLibScrollObserver(): void {
  wireCardSettle();
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

  // One chunk per frame. If the new cards add no height, the sentinel never
  // leaves the viewport and this callback would append the whole library in a
  // single turn: the WebView stops pumping, Windows reports "Not Responding",
  // and the grid stays a black row of empty covers.
  let busy = false;
  S.libScrollObserver = new IntersectionObserver((entries) => {
    if (busy || !entries[0]?.isIntersecting) return;
    const visible = epicVisibleSummaries();
    if (S.renderedCardCount >= visible.length) {
      stop();
      return;
    }
    const nextSlice = visible.slice(S.renderedCardCount, S.renderedCardCount + MORE_CARD_CHUNK);
    if (nextSlice.length === 0) {
      stop();
      return;
    }
    const before = viewEl.scrollHeight;
    busy = true;
    S.libScrollObserver?.disconnect();
    S.renderedCardCount += nextSlice.length;
    sentinel.insertAdjacentHTML("beforebegin", nextSlice.map(renderItem).join(""));
    if (viewEl.scrollHeight <= before || S.renderedCardCount >= visible.length) {
      stop();
      return;
    }
    requestAnimationFrame(() => {
      busy = false;
      if (sentinel.isConnected) S.libScrollObserver?.observe(sentinel);
    });
  }, {
    root: viewEl,
    rootMargin: "200px",
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
  const total = S.libraryVisibleCount >= 0 ? S.libraryVisibleCount : totalLibraryGamesCount();
  const show = S.view === "library" && !S.currentModalAppName && total > 0;
  el.textContent = t("lib.gameCount", { count: total });
  el.hidden = !show;
}

export function refreshLibraryResultsInPlace(): boolean {
  if (S.view !== "library") return false;
  const resultsEl = document.getElementById("lib-results");
  if (!resultsEl) return false;
  invalidateLibraryVisibleCache();
  resultsEl.innerHTML = renderEpicItems();
  setupLibScrollObserver();
  syncLibraryHeadingCount();
  return true;
}

/** Store-menu checks and the button label. The menu itself stays open. */
function syncStoreFilterMenu(): void {
  const label = document.querySelector<HTMLElement>(".lib-store-btn .sort-btn-label");
  if (label) label.textContent = storeFilterLabel();
  document.querySelectorAll<HTMLElement>('#store-dropdown-menu [data-act="source-filter"]').forEach((btn) => {
    const on = storeFilterRowOn(btn.dataset.val || "");
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
    const mark = btn.querySelector(".store-option-mark");
    if (mark) mark.innerHTML = on ? icon("check", 14) : "";
  });
}

/** Pins the open collections menu under its button. The strip scrolls, so the
 *  menu is fixed and gets its viewport coordinates here. */
export function positionColDropdownMenu(): void {
  const menu = document.getElementById("col-dropdown-menu");
  const btn = document.querySelector<HTMLElement>(".lib-col-dropdown-btn");
  if (!menu || !btn) return;
  const rect = btn.getBoundingClientRect();
  const width = menu.offsetWidth || 248;
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 6)}px`;
}

/** Filter-button badge, panel result count and the clear button, in place. */
export function syncLibFilterUi(): void {
  const btn = document.querySelector<HTMLElement>('[data-act="toggle-lib-filters"]');
  if (btn) {
    const count = libFiltersActiveCount();
    btn.classList.toggle("active", count > 0);
    let badge = btn.querySelector<HTMLElement>(".lib-filter-badge");
    if (count > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "lib-filter-badge tabular-nums";
        btn.appendChild(badge);
      }
      badge.textContent = String(count);
    } else if (badge) {
      badge.remove();
    }
  }
  const resultEl = document.querySelector<HTMLElement>(".lib-filter-result");
  if (resultEl) {
    resultEl.textContent = t("lib.filterResults", { n: Math.max(0, S.libraryVisibleCount) });
  }
  const clearBtn = document.querySelector<HTMLButtonElement>('[data-act="lib-filter-clear"]');
  if (clearBtn) clearBtn.disabled = libFiltersActiveCount() === 0;
}

/**
 * Applies a store-filter change without rebuilding the page. Cards that stay
 * in the slice keep their cover elements, so the WebView does not decode the
 * whole grid again. A full `render()` here was what froze the launcher.
 */
export function refreshLibraryForStoreFilter(): boolean {
  if (S.view !== "library") return false;
  const results = document.getElementById("lib-results");
  const grid = results?.querySelector<HTMLElement>(".pgrid, .lib-list");
  if (!results || !grid) return false;

  invalidateLibraryVisibleCache();
  resetCardChunk();
  const visible = epicVisibleSummaries();
  if (visible.length === 0) return false;

  lastResultKey = libraryResultKey();
  S.libPage = 1;
  const slice = renderedSlice(visible);
  const head = grid.querySelector<HTMLElement>(":scope > .lrow-head");
  const existing = new Map<string, HTMLElement>();
  grid.querySelectorAll<HTMLElement>(":scope > [data-lib-item]").forEach((el) => {
    const id = el.dataset.libItem || "";
    if (id) existing.set(id, el);
  });

  const frag = document.createDocumentFragment();
  for (const s of slice) {
    const kept = existing.get(s.appName);
    if (kept) {
      existing.delete(s.appName);
      frag.appendChild(kept);
    } else {
      const holder = document.createElement("template");
      holder.innerHTML = renderItem(s);
      const card = holder.content.firstElementChild;
      if (card) frag.appendChild(card);
    }
  }
  for (const stale of existing.values()) stale.remove();
  grid.replaceChildren(frag);
  if (head) grid.prepend(head);
  if (!S.libPagination && S.renderedCardCount < visible.length) {
    const sentinel = document.createElement("div");
    sentinel.id = "lib-scroll-sentinel";
    sentinel.className = "lib-sentinel";
    grid.appendChild(sentinel);
  }
  results.querySelector(".lib-pager")?.remove();
  if (S.libPagination) {
    const holder = document.createElement("template");
    holder.innerHTML = renderLibraryPager(visible.length);
    const pager = holder.content.firstElementChild;
    if (pager) results.appendChild(pager);
  }
  viewEl.scrollTop = 0;
  setupLibScrollObserver();
  syncLibraryHeadingCount();
  syncStoreFilterMenu();
  syncLibFilterUi();
  return true;
}

function isFilterActive(tab: string | undefined, colId?: string): boolean {
  if (tab === "collection") return !!colId && S.activeCollectionId === colId;
  switch (tab) {
    case "all": return S.activeCollectionId === null && S.epicFilter === "all";
    case "fav": return S.activeCollectionId === "fav";
    case "installed": return S.activeCollectionId === null && S.epicFilter === "installed";
    case "updates": return S.epicFilter === "updates";
    default: return false;
  }
}

function filterTab(tab: string, label: string): string {
  return `<button class="tab lib-filter ${isFilterActive(tab) ? "active" : ""}" data-act="quick-tab" data-tab="${tab}">${label}</button>`;
}

export function renderEpic(): string {
  lastCollectionsSig = collectionsSignature();
  if (!isTauri) {
    return emptyState("zap", t("lib.epicIntegration"), t("lib.desktopOnly"));
  }
  // Every store counts: a Steam-only player (no Epic/GOG account) must still
  // see the grid instead of the "connect an account" empty state.
  const hasGames = S.epicSummaries.length > 0 || S.gogSummaries.length > 0 || S.amazonSummaries.length > 0 || S.steamSummaries.length > 0 || S.companionSummaries.length > 0;
  const isAnyConnected = (S.epicPhase === "library" && Boolean(S.epicAccount)) || (S.gogPhase === "library" && Boolean(S.gogAccount));

  if (S.epicPhase === "checking" && S.gogPhase === "checking") {
    return renderSkeletonLibrary();
  }
  if (!isAnyConnected && (S.epicPhase === "setup" || S.epicPhase === "login") && !hasGames) {
    return emptyState("layers", t("lib.connectTitle"), t("lib.connectDesc"), `<button class="btn primary" data-view="accounts">${t("accounts.connectCta")}</button>`);
  }
  if (S.epicPhase === "error" && !hasGames) {
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

  // A full page rebuild keeps the current card chunk: collapsing a scrolled
  // grid back to the first chunk would jump the user to the top. The chunk is
  // reset when the result set itself changes (see renderEpicItems).

  // Installed is a live tab and must survive a rebuild. Updates and the retired
  // collections mode have no tab, so a redraw must not leave the grid stuck there.
  if (S.epicFilter === "updates" || S.epicFilter === "collections") S.epicFilter = "all";
  const sortOpts = getSortOptions();
  const currentSort = sortOpts.find((o) => o.id === S.epicSort) || sortOpts[0];

  const visibleCount = (keys: string[]): number => keys.filter((key) => !S.hiddenGames.has(key)).length;
  const companionCount = (source: GameSource): number =>
    visibleCount(S.companionSummaries.filter((g) => g.source === source).map((g) => g.key));
  // Only connected or detected stores get a row in the menu.
  const sourceDropdown = storeFilterMenuHtml(
    {
      all: allStoresMenuCount(),
      epic: visibleCount(S.epicSummaries.map((s) => s.appName)),
      gog: visibleCount(S.gogSummaries.map((g) => g.key)),
      amazon: visibleCount(S.amazonSummaries.map((g) => g.key)),
      steam: visibleCount(S.steamSummaries.map((g) => g.key)),
      ea: companionCount("ea"),
      ubisoft: companionCount("ubisoft"),
      xbox: companionCount("xbox"),
      battlenet: companionCount("battlenet"),
      riot: companionCount("riot"),
    },
  );

  const filterCount = libFiltersActiveCount();
  const filterButton = LIB_FILTERS_ENABLED
    ? `<button class="btn ghost lib-sort-btn lib-filter-btn${filterCount > 0 ? " active" : ""}" data-act="toggle-lib-filters" title="${esc(t("lib.filters"))}">
      <span class="lib-sort-kicker">${icon("sliders", 13)} ${esc(t("lib.filters"))}</span>
      ${filterCount > 0 ? `<span class="lib-filter-badge tabular-nums">${filterCount}</span>` : ""}
    </button>`
    : "";
  const tools = `
    ${sourceDropdown}
    ${filterButton}
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
    <button class="icon-btn lib-hide-btn" data-act="open-hide-games" title="${esc(t("lib.hideGamesTip"))}" aria-label="${esc(t("lib.hideGamesTip"))}">${icon("eye-off", 16)}</button>
    <button class="icon-btn lib-refresh-btn ${S.epicSyncing || S.gogSyncing ? "spinning" : ""}" data-act="epic-refresh" title="${t("lib.refreshTip")}">${icon("refresh", 16)}</button>`;

  const isColActive = S.activeCollectionId !== null && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav";
  const activeCol = isColActive ? S.epicCollections.find((c) => c.id === S.activeCollectionId) : null;
  const colBtnLabel = activeCol ? activeCol.name : t("col.allCollections");

  const colDropdown = `
    <div class="col-dropdown-container">
      <button class="tab lib-filter lib-col-dropdown-btn lib-col-tab ${isColActive ? "active" : ""}" data-act="toggle-col-dropdown" data-col-id="${esc(activeCol?.id ?? "")}" title="${esc(t("col.allCollections"))}">
        <span>${esc(colBtnLabel)}</span>
        ${icon(S.isColDropdownOpen ? "chevron-up" : "chevron-down", 14)}
      </button>
      <div id="col-dropdown-menu" class="sort-dropdown-menu col-dropdown-menu ${S.isColDropdownOpen ? "show" : ""}">
        ${S.epicCollections.length > 0 ? `
          <div class="col-dropdown-list">
            ${isColActive ? `
              <button class="sort-menu-item-btn col-menu-item-btn" data-act="select-col-filter" data-col-id="none">
                <span class="col-item-name" style="opacity: 0.7;">${esc(t("col.noCollectionFilter"))}</span>
              </button>
              <div class="col-dropdown-divider"></div>
            ` : ""}
            ${S.epicCollections.map((col) => {
              const isSelected = S.activeCollectionId === col.id;
              const count = col.app_names?.length ?? 0;
              return `
                <button class="sort-menu-item-btn col-menu-item-btn lib-col-tab ${isSelected ? "selected" : ""}" data-act="select-col-filter" data-tab="collection" data-col-id="${esc(col.id)}">
                  <span class="col-item-name">${esc(col.name)}</span>
                  <span class="col-item-count">${count}</span>
                </button>`;
            }).join("")}
          </div>
          <div class="col-dropdown-divider"></div>
        ` : `
          <div class="col-dropdown-empty">${esc(t("col.noCollectionsLong"))}</div>
          <div class="col-dropdown-divider"></div>
        `}
        <button class="sort-menu-item-btn col-menu-add-btn" data-act="open-new-collection-modal">
          ${icon("plus", 14)} <span>${esc(t("col.newTitle"))}</span>
        </button>
      </div>
    </div>`;

  const filters = [
    filterTab("all", t("library.all")),
    filterTab("installed", t("library.installed")),
    filterTab("fav", t("library.favorites")),
    colDropdown,
  ].join("");

  return `
    <div class="page lib-page">
      ${libraryHeader(tools, filters)}
      ${S.epicSyncNote ? `<p class="page-sub" id="lib-sync-note">${esc(S.epicSyncNote)}</p>` : ""}
      <div id="lib-results">${renderEpicItems()}</div>
      ${LIB_FILTERS_ENABLED ? renderLibFilterPanel(S.isFilterPanelOpen ? libraryFilteredList() : [], Math.max(0, S.libraryVisibleCount)) : ""}
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

  const colDropdownBtn = filters.querySelector<HTMLElement>(".lib-col-dropdown-btn");
  if (colDropdownBtn) {
    const isColActive = S.activeCollectionId !== null && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav";
    colDropdownBtn.classList.toggle("active", isColActive);
    const activeCol = isColActive ? S.epicCollections.find((c) => c.id === S.activeCollectionId) : null;
    const labelSpan = colDropdownBtn.querySelector("span");
    if (labelSpan) labelSpan.textContent = activeCol ? activeCol.name : t("col.allCollections");
    colDropdownBtn.dataset.colId = activeCol?.id ?? "";
  }

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

/** Hold-and-drag reorder inside the collections dropdown list. A moved pointer
 *  must not also select the collection, so the follow-up click is consumed. */
export function initCollectionTabs(): void {
  let tab: HTMLElement | null = null;
  let startY = 0;
  let moved = false;

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const hit = (e.target as HTMLElement).closest<HTMLElement>(".lib-col-tab");
    if (!hit?.dataset.colId || !hit.closest(".col-dropdown-list")) return;
    collectionDragged = false;
    tab = hit;
    startY = e.clientY;
    moved = false;
  });

  document.addEventListener("mousemove", (e) => {
    if (!tab) return;
    if (!moved) {
      if (Math.abs(e.clientY - startY) < 5) return;
      moved = true;
      collectionDragged = true;
      tab.classList.add("dragging");
    }
    const bar = tab.parentElement;
    if (!bar) return;
    let before: Element | null = null;
    for (const other of bar.querySelectorAll<HTMLElement>(".lib-col-tab")) {
      if (other === tab) continue;
      const rect = other.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
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

/** Slide list items from their previous y into the new order. One shot, no idle loop. */
function slideCollectionTabs(bar: HTMLElement, dragged: HTMLElement, before: Element | null): void {
  const tabs = [...bar.querySelectorAll<HTMLElement>(".lib-col-tab")];
  const from = new Map(tabs.map((el) => [el, el.getBoundingClientRect().top]));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  bar.insertBefore(dragged, before);
  if (reduce) return;
  for (const el of tabs) {
    const dy = (from.get(el) ?? 0) - el.getBoundingClientRect().top;
    if (dy === 0) continue;
    el.style.transition = "none";
    el.style.transform = `translateY(${dy}px)`;
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
  S.libraryDataRev++;
  try {
    await epicReorderCollections(ids);
  } catch (err) {
    toast(String(err));
  }
}

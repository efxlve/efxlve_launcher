/**
 * Advanced library filters: status, playtime, size, genre, release year and
 * developer facets, rendered as a slide-over panel from the library header.
 *
 * Facets only list values the fold actually has: genres come from Amazon's and
 * Steam's own metadata plus Epic's store tags once a game page fetched them,
 * and the release year needs a store that publishes one.
 */

import { icon } from "../../core/icons";
import { rawOf, sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import type { LibFilters, LibPlaytimeBucket, LibSizeBucket, LibYearBucket } from "../../core/types";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";

/** Studio/publisher name for a game (empty when unknown). */
export function studioOf(s: EpicSummary): string {
  if (s.appName.startsWith("gog::")) {
    const rawId = s.appName.slice(5);
    const item = S.gogSummariesMap.get(rawId) || S.allGamesMap.get(s.appName);
    return item?.developer || "";
  }
  if (s.appName.startsWith("steam::")) {
    // The client's app cache fills the summary; an opened game page can fill the gap.
    const item = S.steamSummariesMap.get(s.appName);
    if (item?.developer) return item.developer;
    const details = S.steamDetails.get(s.appName);
    return details?.developers[0] || details?.publishers[0] || "";
  }
  const g = rawOf(s.appName);
  const d = g?.metadata?.developer;
  if (typeof d === "string" && d.trim()) return d.trim();
  // Companion stores (EA, Ubisoft, Xbox, Battle.net, Riot) keep the studio on
  // the unified item, filled by the store-page resolver.
  return S.allGamesMap.get(s.appName)?.developer || "";
}

/** Genre labels for one game, wherever the fold knows them. */
function genresOf(s: EpicSummary): string[] {
  if (s.genres && s.genres.length > 0) return s.genres;
  if (s.appName.startsWith("steam::")) {
    return S.steamDetails.get(s.appName)?.genres ?? [];
  }
  if (sourceOfKey(s.appName) === "epic") {
    return S.loadedRequirements.get(s.appName)?.tags ?? [];
  }
  return [];
}

export function playtimeBucket(seconds: number): LibPlaytimeBucket {
  if (seconds <= 0) return "never";
  if (seconds < 3600) return "under1";
  if (seconds < 36000) return "1to10";
  if (seconds < 180000) return "10to50";
  return "over50";
}

/** Size bucket of an installed game; null when nothing is installed. */
export function sizeBucket(bytes: number): LibSizeBucket | null {
  if (bytes <= 0) return null;
  const gb = bytes / 1024 ** 3;
  if (gb < 1) return "under1";
  if (gb < 10) return "1to10";
  if (gb < 50) return "10to50";
  return "over50";
}

export function yearBucket(year: number): LibYearBucket {
  if (year < 2000) return "pre2000";
  if (year < 2010) return "2000s";
  if (year < 2020) return "2010s";
  return "2020s";
}

/** Total number of checked facet values (the header badge). */
export function libFiltersActiveCount(): number {
  const f = S.libFilters;
  return f.status.size + f.playtime.size + f.size.size + f.genres.size + f.years.size + f.developers.size;
}

/** Drops every facet selection and invalidates the visible-library cache. */
export function clearLibFilters(): void {
  const f = S.libFilters;
  f.status.clear();
  f.playtime.clear();
  f.size.clear();
  f.genres.clear();
  f.years.clear();
  f.developers.clear();
  S.libFiltersRev++;
  S.libraryDataRev++;
}

/** Toggles one facet value. Values inside a group are OR-ed together. */
export function toggleLibFilter(group: keyof LibFilters, value: string): boolean {
  const set = S.libFilters[group] as Set<string>;
  if (!set) return false;
  if (set.has(value)) set.delete(value);
  else set.add(value);
  S.libFiltersRev++;
  S.libraryDataRev++;
  return true;
}

/** Whether one game passes every active facet (groups AND-ed, values OR-ed). */
export function matchesLibFilters(s: EpicSummary): boolean {
  const f = S.libFilters;
  if (f.status.size > 0) {
    const ok =
      (f.status.has("installed") && s.installed) ||
      (f.status.has("notInstalled") && !s.installed) ||
      (f.status.has("update") && (s.updateAvailable || S.availableUpdates.has(s.appName)));
    if (!ok) return false;
  }
  if (f.playtime.size > 0) {
    const seconds = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
    if (!f.playtime.has(playtimeBucket(seconds))) return false;
  }
  if (f.size.size > 0) {
    const bucket = sizeBucket(s.installSize);
    if (!bucket || !f.size.has(bucket)) return false;
  }
  if (f.years.size > 0) {
    const year = s.releaseYear ?? null;
    if (!year || !f.years.has(yearBucket(year))) return false;
  }
  if (f.genres.size > 0) {
    const genres = genresOf(s);
    if (!genres.some((g) => f.genres.has(g))) return false;
  }
  if (f.developers.size > 0) {
    const dev = studioOf(s);
    if (!dev || !f.developers.has(dev)) return false;
  }
  return true;
}

export interface FacetEntry {
  value: string;
  count: number;
}

export interface LibFacets {
  status: Record<"installed" | "notInstalled" | "update", number>;
  playtime: Record<LibPlaytimeBucket, number>;
  size: Record<LibSizeBucket, number>;
  years: Record<LibYearBucket, number>;
  genres: FacetEntry[];
  developers: FacetEntry[];
}

function facetEntries(map: Map<string, number>): FacetEntry[] {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Counts for every facet, computed from the list before facet filtering. */
export function libFacets(base: EpicSummary[]): LibFacets {
  const status = { installed: 0, notInstalled: 0, update: 0 };
  const playtime: Record<LibPlaytimeBucket, number> = { never: 0, under1: 0, "1to10": 0, "10to50": 0, over50: 0 };
  const size: Record<LibSizeBucket, number> = { under1: 0, "1to10": 0, "10to50": 0, over50: 0 };
  const years: Record<LibYearBucket, number> = { pre2000: 0, "2000s": 0, "2010s": 0, "2020s": 0 };
  const genreMap = new Map<string, number>();
  const devMap = new Map<string, number>();
  for (const s of base) {
    if (s.installed) status.installed++;
    else status.notInstalled++;
    if (s.updateAvailable || S.availableUpdates.has(s.appName)) status.update++;
    playtime[playtimeBucket(S.playtimeMap.get(s.appName)?.total_seconds ?? 0)]++;
    const sb = sizeBucket(s.installSize);
    if (sb) size[sb]++;
    const year = s.releaseYear ?? null;
    if (year) years[yearBucket(year)]++;
    for (const genre of new Set(genresOf(s))) {
      genreMap.set(genre, (genreMap.get(genre) ?? 0) + 1);
    }
    const dev = studioOf(s);
    if (dev) devMap.set(dev, (devMap.get(dev) ?? 0) + 1);
  }
  return {
    status,
    playtime,
    size,
    years,
    genres: facetEntries(genreMap),
    developers: facetEntries(devMap),
  };
}

function facetButton(
  group: keyof LibFilters,
  value: string,
  label: string,
  count: number,
  on: boolean,
): string {
  return `<button type="button" class="lib-facet-row${on ? " is-on" : ""}" data-act="lib-filter-toggle" data-group="${group}" data-value="${esc(value)}" data-facet-name="${esc(label.toLowerCase())}" role="menuitemcheckbox" aria-checked="${on}">
    <span class="lib-facet-mark">${on ? icon("check", 13) : ""}</span>
    <span class="lib-facet-label">${esc(label)}</span>
    <span class="lib-facet-count tabular-nums">${count}</span>
  </button>`;
}

function facetSection(title: string, body: string, hint = ""): string {
  return `
    <section class="lib-filter-section">
      <h4 class="lib-filter-title">${esc(title)}</h4>
      ${hint ? `<p class="lib-filter-hint">${esc(hint)}</p>` : ""}
      ${body}
    </section>`;
}

function facetSearch(placeholder: string): string {
  return `<input type="search" class="input lib-facet-search" data-facet-search="1" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off" />`;
}

function facetList(entries: FacetEntry[], group: keyof LibFilters, on: (value: string) => boolean): string {
  if (entries.length === 0) return "";
  const search = entries.length >= 8 ? facetSearch(t("lib.filterSearch")) : "";
  const rows = entries.map((entry) => facetButton(group, entry.value, entry.value, entry.count, on(entry.value))).join("");
  return `${search}${rows}`;
}

/**
 * Slide-over panel markup. `base` is the library list before facet filtering,
 * so the counts never collapse while a filter is selected.
 */
export function renderLibFilterPanel(base: EpicSummary[], resultCount: number): string {
  if (!S.isFilterPanelOpen) return "";
  const facets = libFacets(base);
  const f = S.libFilters;
  const active = libFiltersActiveCount();

  const status = facetSection(
    t("lib.filterStatus"),
    facetButton("status", "installed", t("library.installed"), facets.status.installed, f.status.has("installed")) +
      facetButton("status", "notInstalled", t("lib.filterNotInstalled"), facets.status.notInstalled, f.status.has("notInstalled")) +
      facetButton("status", "update", t("drawer.updateAvailable"), facets.status.update, f.status.has("update")),
  );

  const playtime = facetSection(
    t("lib.filterPlaytime"),
    facetButton("playtime", "never", t("lib.ptNever"), facets.playtime.never, f.playtime.has("never")) +
      facetButton("playtime", "under1", t("lib.ptUnder1"), facets.playtime.under1, f.playtime.has("under1")) +
      facetButton("playtime", "1to10", t("lib.pt1to10"), facets.playtime["1to10"], f.playtime.has("1to10")) +
      facetButton("playtime", "10to50", t("lib.pt10to50"), facets.playtime["10to50"], f.playtime.has("10to50")) +
      facetButton("playtime", "over50", t("lib.ptOver50"), facets.playtime.over50, f.playtime.has("over50")),
  );

  const size = facetSection(
    t("lib.filterSize"),
    facetButton("size", "under1", t("lib.sizeUnder1"), facets.size.under1, f.size.has("under1")) +
      facetButton("size", "1to10", t("lib.size1to10"), facets.size["1to10"], f.size.has("1to10")) +
      facetButton("size", "10to50", t("lib.size10to50"), facets.size["10to50"], f.size.has("10to50")) +
      facetButton("size", "over50", t("lib.sizeOver50"), facets.size.over50, f.size.has("over50")),
  );

  const genreBody = facetList(facets.genres, "genres", (value) => f.genres.has(value));
  const genre = genreBody ? facetSection(t("lib.filterGenre"), genreBody, t("lib.filterMetaHint")) : "";

  const year = facetSection(
    t("lib.filterYear"),
    facetButton("years", "pre2000", t("lib.yrPre2000"), facets.years.pre2000, f.years.has("pre2000")) +
      facetButton("years", "2000s", t("lib.yr2000s"), facets.years["2000s"], f.years.has("2000s")) +
      facetButton("years", "2010s", t("lib.yr2010s"), facets.years["2010s"], f.years.has("2010s")) +
      facetButton("years", "2020s", t("lib.yr2020s"), facets.years["2020s"], f.years.has("2020s")),
    t("lib.filterMetaHint"),
  );

  const devBody = facetList(facets.developers, "developers", (value) => f.developers.has(value));
  const developer = devBody ? facetSection(t("lib.filterDeveloper"), devBody) : "";

  return `
    <div class="lib-filter-backdrop" data-act="lib-filter-close"></div>
    <aside class="lib-filter-panel" role="dialog" aria-label="${esc(t("lib.filters"))}">
      <div class="lib-filter-head">
        <div class="lib-filter-head-text">
          <h3 class="lib-filter-title-main">${esc(t("lib.filters"))}</h3>
          <span class="lib-filter-result tabular-nums">${esc(t("lib.filterResults", { n: resultCount }))}</span>
        </div>
        <button class="icon-btn" data-act="lib-filter-close" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${icon("x", 16)}</button>
      </div>
      <div class="lib-filter-body">
        ${status}
        ${playtime}
        ${size}
        ${genre}
        ${year}
        ${developer}
      </div>
      <div class="lib-filter-foot">
        <button class="btn ghost small" data-act="lib-filter-clear" ${active > 0 ? "" : "disabled"}>${icon("refresh", 13)} ${esc(t("lib.filterClear"))}</button>
        <button class="btn primary small" data-act="lib-filter-close">${esc(t("common.close"))}</button>
      </div>
    </aside>`;
}

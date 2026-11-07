/**
 * Advanced library filters: status, playtime, size, genre, release year,
 * review score and developer facets, rendered as a slide-over panel from the
 * library header.
 */

import {
  cachedDeveloperOf,
  cachedGenresOf,
  gameRatingOf,
  ratingBucket as scoreBucket,
} from "../../core/game-ratings";
import { icon } from "../../core/icons";
import { libraryPlaytime, rawOf, sourceOfKey, storeKeysForTitle } from "../../core/selectors";
import { S } from "../../core/state";
import type {
  LibFilters,
  LibPlaytimeBucket,
  LibRatingBucket,
  LibSizeBucket,
  LibYearBucket,
} from "../../core/types";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { effectiveReleaseYear } from "./library-sort";

/** Advanced facets (status, playtime, size, genre, year, rating, studio). */
export const LIB_FILTERS_ENABLED = true;

/** Studio/publisher name for a game (empty when unknown). */
export function studioOf(s: EpicSummary): string {
  if (s.appName.startsWith("gog::")) {
    const rawId = s.appName.slice(5);
    const item = S.gogSummariesMap.get(rawId) || S.allGamesMap.get(s.appName);
    if (item?.developer) return item.developer;
  }
  if (s.appName.startsWith("steam::")) {
    const item = S.steamSummariesMap.get(s.appName);
    if (item?.developer) return item.developer;
    const details = S.steamDetails.get(s.appName);
    if (details?.developers[0] || details?.publishers[0]) {
      return details.developers[0] || details.publishers[0] || "";
    }
  }
  const g = rawOf(s.appName);
  const d = g?.metadata?.developer;
  if (typeof d === "string" && d.trim()) return d.trim();
  const unified = S.allGamesMap.get(s.appName)?.developer;
  if (unified) return unified;
  const cached = cachedDeveloperOf(s.appName, s.title);
  if (cached) return cached;
  if (!S.separateCopies) {
    for (const key of storeKeysForTitle(s.title)) {
      const sibling = S.allGamesMap.get(key)?.developer;
      if (sibling) return sibling;
    }
  }
  return "";
}

/** Genre labels for one game, across store metadata, IGDB cache and sibling copies. */
export function genresOf(s: EpicSummary): string[] {
  if (s.genres && s.genres.length > 0) return s.genres;
  if (s.appName.startsWith("steam::")) {
    const steamGenres = S.steamDetails.get(s.appName)?.genres;
    if (steamGenres && steamGenres.length > 0) return steamGenres;
  }
  if (sourceOfKey(s.appName) === "epic") {
    const tags = S.loadedRequirements.get(s.appName)?.tags;
    if (tags && tags.length > 0) return tags;
  }
  const cached = cachedGenresOf(s.appName, s.title);
  if (cached.length > 0) return [...cached];
  if (!S.separateCopies) {
    for (const key of storeKeysForTitle(s.title)) {
      const siblingGenres = S.allGamesMap.get(key)?.genres;
      if (siblingGenres && siblingGenres.length > 0) return siblingGenres;
    }
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
  if (year >= 2026) return "2026";
  if (year === 2025) return "2025";
  if (year === 2024) return "2024";
  if (year === 2023) return "2023";
  if (year === 2022) return "2022";
  if (year === 2021) return "2021";
  if (year === 2020) return "2020";
  if (year >= 2010) return "2010s";
  if (year >= 2000) return "2000s";
  if (year >= 1990) return "1990s";
  return "pre1990";
}

/** Total number of checked facet values (the header badge). */
export function libFiltersActiveCount(): number {
  const f = S.libFilters;
  return (
    f.status.size +
    f.playtime.size +
    f.size.size +
    f.genres.size +
    f.years.size +
    f.ratings.size +
    f.developers.size
  );
}

/** Drops every facet selection and invalidates the visible-library cache. */
export function clearLibFilters(): void {
  const f = S.libFilters;
  f.status.clear();
  f.playtime.clear();
  f.size.clear();
  f.genres.clear();
  f.years.clear();
  f.ratings.clear();
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
  if (!LIB_FILTERS_ENABLED) return true;
  const f = S.libFilters;
  if (f.status.size > 0) {
    const ok =
      (f.status.has("installed") && s.installed) ||
      (f.status.has("notInstalled") && !s.installed) ||
      (f.status.has("update") && (s.updateAvailable || S.availableUpdates.has(s.appName)));
    if (!ok) return false;
  }
  if (f.playtime.size > 0) {
    const seconds = libraryPlaytime(s).seconds;
    if (!f.playtime.has(playtimeBucket(seconds))) return false;
  }
  if (f.size.size > 0) {
    const bucket = sizeBucket(s.installSize);
    if (!bucket || !f.size.has(bucket)) return false;
  }
  if (f.years.size > 0) {
    const year = effectiveReleaseYear(s);
    if (!year || !f.years.has(yearBucket(year))) return false;
  }
  if (f.ratings.size > 0) {
    if (!f.ratings.has(scoreBucket(gameRatingOf(s.appName, s.title)))) return false;
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
  ratings: Record<LibRatingBucket, number>;
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
  const playtime: Record<LibPlaytimeBucket, number> = {
    never: 0,
    under1: 0,
    "1to10": 0,
    "10to50": 0,
    over50: 0,
  };
  const size: Record<LibSizeBucket, number> = { under1: 0, "1to10": 0, "10to50": 0, over50: 0 };
  const years: Record<LibYearBucket, number> = {
    "2026": 0,
    "2025": 0,
    "2024": 0,
    "2023": 0,
    "2022": 0,
    "2021": 0,
    "2020": 0,
    "2010s": 0,
    "2000s": 0,
    "1990s": 0,
    pre1990: 0,
  };
  const ratings: Record<LibRatingBucket, number> = {
    "90": 0,
    "80": 0,
    "70": 0,
    "60": 0,
    "50": 0,
    under50: 0,
    unrated: 0,
  };
  const genreMap = new Map<string, number>();
  const devMap = new Map<string, number>();
  for (const s of base) {
    if (s.installed) status.installed++;
    else status.notInstalled++;
    if (s.updateAvailable || S.availableUpdates.has(s.appName)) status.update++;
    playtime[playtimeBucket(libraryPlaytime(s).seconds)]++;
    const sb = sizeBucket(s.installSize);
    if (sb) size[sb]++;
    const year = effectiveReleaseYear(s);
    if (year) years[yearBucket(year)]++;
    ratings[scoreBucket(gameRatingOf(s.appName, s.title))]++;
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
    ratings,
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

function facetSearch(placeholder: string, group: keyof LibFilters): string {
  return `<input type="search" class="input lib-facet-search" data-facet-search="${group}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off" />`;
}

function facetList(entries: FacetEntry[], group: keyof LibFilters, on: (value: string) => boolean): string {
  if (entries.length === 0) return "";
  const search = entries.length >= 8 ? facetSearch(t("lib.filterSearch"), group) : "";
  const rows = entries.map((entry) => facetButton(group, entry.value, entry.value, entry.count, on(entry.value))).join("");
  return `${search}${rows}`;
}

const YEAR_FACET_ORDER: { id: LibYearBucket; label: () => string }[] = [
  { id: "2026", label: () => "2026" },
  { id: "2025", label: () => "2025" },
  { id: "2024", label: () => "2024" },
  { id: "2023", label: () => "2023" },
  { id: "2022", label: () => "2022" },
  { id: "2021", label: () => "2021" },
  { id: "2020", label: () => "2020" },
  { id: "2010s", label: () => t("lib.yr2010s") },
  { id: "2000s", label: () => t("lib.yr2000s") },
  { id: "1990s", label: () => t("lib.yr1990s") },
  { id: "pre1990", label: () => t("lib.yrPre1990") },
];

/**
 * Inner facet sections markup. `base` is the library list before facet
 * filtering, so counts stay stable while facets are toggled.
 */
export function renderLibFilterBody(base: EpicSummary[]): string {
  const facets = libFacets(base);
  const f = S.libFilters;

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

  const yearRows = YEAR_FACET_ORDER
    .filter((entry) => facets.years[entry.id] > 0 || f.years.has(entry.id))
    .map((entry) => facetButton("years", entry.id, entry.label(), facets.years[entry.id], f.years.has(entry.id)))
    .join("");
  const year = yearRows ? facetSection(t("lib.filterYear"), yearRows, t("lib.filterMetaHint")) : "";

  const rating = facetSection(
    t("lib.filterRating"),
    facetButton("ratings", "90", "90+", facets.ratings["90"], f.ratings.has("90")) +
      facetButton("ratings", "80", "80–89", facets.ratings["80"], f.ratings.has("80")) +
      facetButton("ratings", "70", "70–79", facets.ratings["70"], f.ratings.has("70")) +
      facetButton("ratings", "60", "60–69", facets.ratings["60"], f.ratings.has("60")) +
      facetButton("ratings", "50", "50–59", facets.ratings["50"], f.ratings.has("50")) +
      facetButton("ratings", "under50", "< 50", facets.ratings.under50, f.ratings.has("under50")) +
      facetButton("ratings", "unrated", t("lib.ratingUnrated"), facets.ratings.unrated, f.ratings.has("unrated")),
  );

  const devBody = facetList(facets.developers, "developers", (value) => f.developers.has(value));
  const developer = devBody ? facetSection(t("lib.filterDeveloper"), devBody) : "";

  return `${status}${playtime}${size}${genre}${year}${rating}${developer}`;
}

/**
 * Slide-over panel markup. `base` is the library list before facet filtering,
 * so the counts never collapse while a filter is selected.
 */
export function renderLibFilterPanel(base: EpicSummary[], resultCount: number): string {
  if (!LIB_FILTERS_ENABLED || !S.isFilterPanelOpen) return "";
  const active = libFiltersActiveCount();

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
        ${renderLibFilterBody(base)}
      </div>
      <div class="lib-filter-foot">
        <button class="btn ghost small" data-act="lib-filter-clear" ${active > 0 ? "" : "disabled"}>${icon("refresh", 13)} ${esc(t("lib.filterClear"))}</button>
        <button class="btn primary small" data-act="lib-filter-close">${esc(t("common.close"))}</button>
      </div>
    </aside>`;
}

/** Sync the `#page-header` filter button, active badge, and open drawer counters. */
export function syncLibFilterHeaderBtn(resultCount = Math.max(0, S.libraryVisibleCount)): void {
  const count = libFiltersActiveCount();
  const showOnHeader = LIB_FILTERS_ENABLED && S.view === "library" && !S.currentModalAppName;
  const btn = document.getElementById("lib-header-filter-btn");
  if (btn) {
    btn.hidden = !showOnHeader;
    btn.classList.toggle("active", count > 0);
    btn.classList.toggle("is-open", showOnHeader && S.isFilterPanelOpen);
    btn.setAttribute("aria-expanded", String(showOnHeader && S.isFilterPanelOpen));
  }
  const badge = document.getElementById("lib-header-filter-badge");
  if (badge) {
    badge.hidden = count === 0;
    if (count > 0) badge.textContent = String(count);
  }
  const root = document.getElementById("lib-filter-root");
  if (root && S.isFilterPanelOpen) {
    const resultEl = root.querySelector<HTMLElement>(".lib-filter-result");
    if (resultEl) {
      resultEl.textContent = t("lib.filterResults", { n: Math.max(0, resultCount) });
    }
    const clearBtn = root.querySelector<HTMLButtonElement>('[data-act="lib-filter-clear"]');
    if (clearBtn) clearBtn.disabled = count === 0;
  }
}

/**
 * Mounts or patches `#lib-filter-root` in place without touching `#view` or
 * replaying the drawer entrance animation when already open.
 */
export function mountLibFilterPanel(base: EpicSummary[], resultCount: number): void {
  const root = document.getElementById("lib-filter-root");
  if (!root) {
    syncLibFilterHeaderBtn(resultCount);
    return;
  }
  if (!LIB_FILTERS_ENABLED || !S.isFilterPanelOpen || S.view !== "library" || Boolean(S.currentModalAppName)) {
    S.isFilterPanelOpen = false;
    if (root.innerHTML) root.innerHTML = "";
    syncLibFilterHeaderBtn(resultCount);
    return;
  }
  const existingBody = root.querySelector<HTMLElement>(".lib-filter-panel .lib-filter-body");
  if (existingBody) {
    const scrollTop = existingBody.scrollTop;
    const queries = new Map<string, string>();
    existingBody.querySelectorAll<HTMLInputElement>("input[data-facet-search]").forEach((inp) => {
      if (inp.dataset.facetSearch && inp.value) {
        queries.set(inp.dataset.facetSearch, inp.value);
      }
    });
    const activeEl = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
    const focusedGroup = activeEl?.dataset.facetSearch || "";
    const selStart = activeEl?.selectionStart ?? null;
    const selEnd = activeEl?.selectionEnd ?? null;

    existingBody.innerHTML = renderLibFilterBody(base);
    existingBody.scrollTop = scrollTop;

    for (const [group, val] of queries) {
      const inp = existingBody.querySelector<HTMLInputElement>(`input[data-facet-search="${group}"]`);
      if (!inp) continue;
      inp.value = val;
      const q = val.trim().toLowerCase();
      inp.closest(".lib-filter-section")?.querySelectorAll<HTMLElement>("[data-facet-name]").forEach((row) => {
        row.hidden = q.length > 0 && !(row.dataset.facetName || "").includes(q);
      });
    }
    if (focusedGroup) {
      const focusTarget = existingBody.querySelector<HTMLInputElement>(`input[data-facet-search="${focusedGroup}"]`);
      if (focusTarget) {
        focusTarget.focus({ preventScroll: true });
        if (selStart !== null && selEnd !== null) {
          try {
            focusTarget.setSelectionRange(selStart, selEnd);
          } catch {
            /* type="search" in some engines */
          }
        }
      }
    }
    syncLibFilterHeaderBtn(resultCount);
    return;
  }

  root.innerHTML = renderLibFilterPanel(base, resultCount);
  syncLibFilterHeaderBtn(resultCount);
}

/** Close the library filter slide-over panel without rebuilding the cover grid. */
export function closeLibFilterPanel(): void {
  S.isFilterPanelOpen = false;
  const root = document.getElementById("lib-filter-root");
  if (root && root.innerHTML) root.innerHTML = "";
  syncLibFilterHeaderBtn();
}

/**
 * Collapsible library grouping (by status, rating, release year, storefront,
 * playtime or genre).
 *
 * Groups partition the already-filtered, already-sorted `visible` list while
 * preserving the active sort order inside each shelf.
 */

import { LIB_COLLAPSED_GROUPS_KEY, LIB_GROUP_BY_KEY, saveStrSet } from "../../core/constants";
import { gameRatingOf, ratingBucket } from "../../core/game-ratings";
import { formatGenreLabel } from "../../core/genres";
import { icon } from "../../core/icons";
import { libraryPlaytime, sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import type { GameSource, LibGroupBy, LibPlaytimeBucket, LibRatingBucket } from "../../core/types";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { playtimeBucket, primaryGenreOf } from "./library-filters";
import { effectiveReleaseYear, libraryCollator } from "./library-sort";

export interface LibGroupSection {
  id: string;
  collapseKey: string;
  label: string;
  items: EpicSummary[];
  collapsed: boolean;
}

export function getGroupByOptions(): { id: LibGroupBy; label: string }[] {
  return [
    { id: "none", label: t("lib.groupNone") },
    { id: "status", label: t("lib.groupStatus") },
    { id: "rating", label: t("lib.groupRating") },
    { id: "year", label: t("lib.groupYear") },
    { id: "store", label: t("lib.groupStore") },
    { id: "playtime", label: t("lib.groupPlaytime") },
    { id: "genre", label: t("lib.groupGenre") },
  ];
}

export function setLibGroupBy(mode: LibGroupBy): void {
  S.libGroupBy = mode;
  S.libPage = 1;
  try {
    if (mode === "none") localStorage.removeItem(LIB_GROUP_BY_KEY);
    else localStorage.setItem(LIB_GROUP_BY_KEY, mode);
  } catch {
    // Session value still applies.
  }
}

export function toggleLibGroupCollapsed(collapseKey: string): void {
  if (!collapseKey) return;
  if (S.collapsedLibGroups.has(collapseKey)) {
    S.collapsedLibGroups.delete(collapseKey);
  } else {
    S.collapsedLibGroups.add(collapseKey);
  }
  saveStrSet(LIB_COLLAPSED_GROUPS_KEY, S.collapsedLibGroups);
}

const STORE_GROUP_ORDER: readonly GameSource[] = [
  "steam",
  "epic",
  "gog",
  "amazon",
  "xbox",
  "ea",
  "ubisoft",
  "battlenet",
  "riot",
  "custom",
];

function storeGroupLabel(source: GameSource): string {
  switch (source) {
    case "steam":
      return "Steam";
    case "epic":
      return "Epic Games";
    case "gog":
      return "GOG";
    case "amazon":
      return "Amazon Games";
    case "xbox":
      return "Xbox";
    case "ea":
      return "EA App";
    case "ubisoft":
      return "Ubisoft Connect";
    case "battlenet":
      return "Battle.net";
    case "riot":
      return "Riot Games";
    case "custom":
      return t("customGames.storeLabel");
  }
}

function buildOrderedGroups<K extends string>(
  mode: LibGroupBy,
  order: readonly { id: K; label: string }[],
  items: EpicSummary[],
  keyOf: (item: EpicSummary) => K,
): LibGroupSection[] {
  const buckets = new Map<K, EpicSummary[]>();
  for (const item of items) {
    const k = keyOf(item);
    let list = buckets.get(k);
    if (!list) {
      list = [];
      buckets.set(k, list);
    }
    list.push(item);
  }
  const out: LibGroupSection[] = [];
  for (const entry of order) {
    const list = buckets.get(entry.id);
    if (!list || list.length === 0) continue;
    const collapseKey = `${mode}:${entry.id}`;
    out.push({
      id: entry.id,
      collapseKey,
      label: entry.label,
      items: list,
      collapsed: S.collapsedLibGroups.has(collapseKey),
    });
  }
  return out;
}

/**
 * Effective library grouping mode. Picking `Sort by: Genre` while `Group by`
 * is `none` automatically renders alphabetical Genre shelves so players see
 * clear section boundaries (`Action`, `Racing`, `Simulation`, `Strategy`, …).
 */
export function effectiveLibGroupBy(): LibGroupBy {
  if (S.libGroupBy !== "none") return S.libGroupBy;
  if (S.epicSort === "genre") return "genre";
  return "none";
}

/** Partitions `visible` into collapsible sections for the active grouping mode. */
export function buildLibraryGroups(visible: EpicSummary[]): LibGroupSection[] {
  const mode = effectiveLibGroupBy();
  if (mode === "none" || visible.length === 0) return [];

  if (mode === "status") {
    return buildOrderedGroups(
      mode,
      [
        { id: "update", label: t("drawer.updateAvailable") },
        { id: "installed", label: t("library.installed") },
        { id: "notInstalled", label: t("lib.filterNotInstalled") },
      ],
      visible,
      (s) => {
        if (s.updateAvailable || S.availableUpdates.has(s.appName)) return "update";
        return s.installed ? "installed" : "notInstalled";
      },
    );
  }

  if (mode === "rating") {
    const order: { id: LibRatingBucket; label: string }[] = [
      { id: "90", label: "90+" },
      { id: "80", label: "80–89" },
      { id: "70", label: "70–79" },
      { id: "60", label: "60–69" },
      { id: "50", label: "50–59" },
      { id: "under50", label: "< 50" },
      { id: "unrated", label: t("lib.ratingUnrated") },
    ];
    return buildOrderedGroups(mode, order, visible, (s) =>
      ratingBucket(gameRatingOf(s.appName, s.title)),
    );
  }

  if (mode === "year") {
    const recentYears = new Set<number>();
    for (const s of visible) {
      const y = effectiveReleaseYear(s);
      if (y !== null && y >= 2020) recentYears.add(y);
    }
    const sortedRecent = [...recentYears].sort((a, b) => b - a);
    const knownOrder: { id: string; label: string }[] = [
      ...sortedRecent.map((y) => ({ id: String(y), label: String(y) })),
      { id: "2010s", label: t("lib.yr2010s") },
      { id: "2000s", label: t("lib.yr2000s") },
      { id: "1990s", label: t("lib.yr1990s") },
      { id: "pre1990", label: t("lib.yrPre1990") },
    ];
    if (S.epicSort === "yearOld") {
      knownOrder.reverse();
    }
    knownOrder.push({ id: "unknown", label: t("lib.groupUnknownYear") });

    return buildOrderedGroups(mode, knownOrder, visible, (s) => {
      const y = effectiveReleaseYear(s);
      if (y === null) return "unknown";
      if (y >= 2020) return String(y);
      if (y >= 2010) return "2010s";
      if (y >= 2000) return "2000s";
      if (y >= 1990) return "1990s";
      return "pre1990";
    });
  }

  if (mode === "store") {
    return buildOrderedGroups(
      mode,
      STORE_GROUP_ORDER.map((src) => ({ id: src, label: storeGroupLabel(src) })),
      visible,
      (s) => sourceOfKey(s.appName),
    );
  }

  if (mode === "playtime") {
    const order: { id: LibPlaytimeBucket; label: string }[] = [
      { id: "over50", label: t("lib.ptOver50") },
      { id: "10to50", label: t("lib.pt10to50") },
      { id: "1to10", label: t("lib.pt1to10") },
      { id: "under1", label: t("lib.ptUnder1") },
      { id: "never", label: t("lib.ptNever") },
    ];
    return buildOrderedGroups(mode, order, visible, (s) =>
      playtimeBucket(libraryPlaytime(s).seconds),
    );
  }

  if (mode === "genre") {
    const buckets = new Map<string, EpicSummary[]>();
    const uncategorized: EpicSummary[] = [];
    for (const s of visible) {
      const primary = primaryGenreOf(s);
      if (!primary) {
        uncategorized.push(s);
        continue;
      }
      let list = buckets.get(primary);
      if (!list) {
        list = [];
        buckets.set(primary, list);
      }
      list.push(s);
    }
    const collator = libraryCollator();
    const sortedGenres = [...buckets.entries()].sort((a, b) => {
      const leftLabel = formatGenreLabel(a[0]);
      const rightLabel = formatGenreLabel(b[0]);
      if (S.epicSort === "genre") {
        return collator.compare(leftLabel, rightLabel);
      }
      return b[1].length - a[1].length || collator.compare(leftLabel, rightLabel);
    });
    const out: LibGroupSection[] = sortedGenres.map(([genre, items]) => {
      const collapseKey = `genre:${genre}`;
      return {
        id: genre,
        collapseKey,
        label: formatGenreLabel(genre),
        items,
        collapsed: S.collapsedLibGroups.has(collapseKey),
      };
    });
    if (uncategorized.length > 0) {
      const collapseKey = "genre:__none__";
      out.push({
        id: "__none__",
        collapseKey,
        label: t("lib.groupUncategorized"),
        items: uncategorized,
        collapsed: S.collapsedLibGroups.has(collapseKey),
      });
    }
    return out;
  }

  return [];
}

/**
 * Renders collapsible library groups while respecting progressive card chunking
 * (`maxCards`). Every group header is always painted with its full item count so
 * shelves never appear missing before scrolling.
 */
export function renderGroupedLibraryItems(
  groups: LibGroupSection[],
  maxCards: number,
  renderCard: (item: EpicSummary) => string,
  wrapContainer: (innerHtml: string) => string,
): { html: string; hasMore: boolean; mountedCount: number } {
  let remaining = Math.max(1, maxCards);
  let mountedCount = 0;
  let hasMore = false;

  const sectionsHtml = groups
    .map((group) => {
      const chevron = group.collapsed ? icon("chevron-right", 14) : icon("chevron-down", 14);
      let bodyHtml = "";
      if (!group.collapsed) {
        if (remaining > 0) {
          const slice = group.items.slice(0, remaining);
          remaining -= slice.length;
          mountedCount += slice.length;
          if (slice.length < group.items.length) hasMore = true;
          bodyHtml = `<div class="lib-group-body">${wrapContainer(slice.map(renderCard).join(""))}</div>`;
        } else {
          hasMore = true;
        }
      }
      return `<section class="lib-group${group.collapsed ? " is-collapsed" : ""}" data-lib-group="${esc(group.collapseKey)}">
        <button type="button" class="lib-group-head" data-act="toggle-lib-group" data-group-key="${esc(group.collapseKey)}" aria-expanded="${!group.collapsed}">
          <span class="lib-group-chevron">${chevron}</span>
          <span class="lib-group-title">${esc(group.label)}</span>
          <span class="lib-group-count tabular-nums">${group.items.length}</span>
          <span class="lib-group-rule" aria-hidden="true"></span>
        </button>
        ${bodyHtml}
      </section>`;
    })
    .join("");

  return {
    html: `<div class="lib-groups" id="lib-groups">${sectionsHtml}</div>`,
    hasMore,
    mountedCount,
  };
}

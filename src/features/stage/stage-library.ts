/**
 * Stage library: a vertical wall of covers on one side and the focused game's
 * side stage on the other. The wall is the navigation; the side stage is the
 * preview, so browsing never opens a modal.
 */

import { icon } from "../../core/icons";
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import type { StageLibraryFilter, StageLibrarySort } from "../../core/types";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import { stageCoverMarkup, stageHeroMarkup, stagePrefetch, stageWideArt } from "./stage-art";
import { updateStageBackdrop } from "./stage-backdrop";
import {
  stageAchievements,
  stageFilterCounts,
  stageGameByKey,
  stageLibraryList,
  stageLibraryStores,
  stagePrimaryAction,
  stageStoreFilterLabel,
} from "./stage-model";
import { stageMetaLine, stageProgress, stageStatus, stageStoreName } from "./stage-ui";

const FILTERS: StageLibraryFilter[] = ["all", "installed", "favorites", "updates"];
const LIBRARY_CHUNK = 96;

let renderedLimit = LIBRARY_CHUNK;
let renderedSignature = "";
/** The list the current wall was built from; focus previews reuse it. */
let renderedList: EpicSummary[] = [];

function librarySignature(): string {
  return [
    S.stage.libraryFilter,
    S.stage.libraryStore,
    S.stage.query,
    S.stage.librarySort,
    S.stage.libraryView,
  ].join("\u001f");
}

function ensureRenderedLimit(): void {
  const signature = librarySignature();
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    renderedLimit = LIBRARY_CHUNK;
  }
}

/** Append the next shelf chunk when the scrollbar reaches the fold. */
export function stageLibraryMore(): boolean {
  const total = stageLibraryList().length;
  if (renderedLimit >= total) return false;
  renderedLimit = Math.min(total, renderedLimit + LIBRARY_CHUNK);
  return true;
}

/** Signature token for the render guard: a new chunk must repaint the shelf. */
export function stageLibraryRenderToken(): string {
  return `${renderedSignature}:${renderedLimit}`;
}

function filterLabel(filter: StageLibraryFilter): string {
  switch (filter) {
    case "installed": return t("stage.filterInstalled");
    case "favorites": return t("stage.filterFavorites");
    case "updates": return t("stage.filterUpdates");
    default: return t("stage.filterAll");
  }
}

function sortLabel(sort: StageLibrarySort): string {
  switch (sort) {
    case "alpha": return t("stage.sortAlpha");
    case "playtime": return t("stage.sortPlaytime");
    case "installed": return t("stage.sortInstalled");
    default: return t("stage.sortRecent");
  }
}

function filterTabs(): string {
  const counts = stageFilterCounts();
  return `<div class="stage-filter-tabs" role="tablist">
    ${FILTERS.map((filter) => `<button type="button" role="tab" aria-selected="${S.stage.libraryFilter === filter}" class="stage-filter${S.stage.libraryFilter === filter ? " active" : ""}" data-stage-act="set-filter" data-filter="${filter}" data-gp-item data-gp-key="filter:${filter}">
      <span>${esc(filterLabel(filter))}</span><span class="stage-filter-count tabular-nums">${counts[filter]}</span>
    </button>`).join("")}
  </div>`;
}

function tools(): string {
  const collection = S.stage.collectionId
    ? S.epicCollections.find((item) => item.id === S.stage.collectionId)
    : undefined;
  const collectionChip = collection
    ? `<button type="button" class="stage-tool stage-query-chip" data-stage-act="clear-collection" data-gp-item data-gp-key="tool:collection">${icon("layers", 14)}<span>${esc(collection.name)}</span>${icon("x", 14)}</button>`
    : "";
  const queryChip = S.stage.query
    ? `<button type="button" class="stage-tool stage-query-chip" data-stage-act="clear-query" data-gp-item data-gp-key="tool:query">${icon("search", 14)}<span>${esc(S.stage.query)}</span>${icon("x", 14)}</button>`
    : "";
  return `<div class="stage-library-tools">
    ${collectionChip}
    ${queryChip}
    <button type="button" class="stage-tool" data-stage-act="cycle-store" data-gp-item data-gp-key="tool:store">${icon("layers", 16)}<span>${esc(stageStoreFilterLabel())}</span></button>
    <button type="button" class="stage-tool" data-stage-act="cycle-sort" data-gp-item data-gp-key="tool:sort">${icon("arrow-down-a-z", 16)}<span>${esc(sortLabel(S.stage.librarySort))}</span></button>
    <button type="button" class="stage-tool" data-stage-act="random-game" data-gp-item data-gp-key="tool:random" title="${esc(t("library.random"))}">${icon("sparkles", 16)}<span>${esc(t("library.random"))}</span></button>
    <button type="button" class="stage-tool" data-stage-act="toggle-view" data-gp-item data-gp-key="tool:view">${icon(S.stage.libraryView === "grid" ? "rows" : "layout-grid", 16)}<span>${esc(S.stage.libraryView === "grid" ? t("stage.viewList") : t("stage.viewGrid"))}</span></button>
    <button type="button" class="stage-tool" data-stage-act="open-search" data-gp-item data-gp-key="tool:search">${icon("search", 16)}<span>${esc(t("stage.search"))}</span></button>
  </div>`;
}

function gridCard(s: EpicSummary, index: number): string {
  return `<button type="button" class="stage-cover-card" data-stage-act="open-program" data-key="${esc(s.appName)}" data-lib-preview="${esc(s.appName)}" data-gp-item data-gp-key="lib:${esc(s.appName)}">
    <span class="stage-cover-frame">${stageCoverMarkup(s, "stage-cover-art", index > 30)}${stageStatus(s)}</span>
    <span class="stage-cover-title">${esc(s.title)}</span>
  </button>`;
}

function listRow(s: EpicSummary, index: number): string {
  return `<button type="button" class="stage-list-row" data-stage-act="open-program" data-key="${esc(s.appName)}" data-lib-preview="${esc(s.appName)}" data-gp-item data-gp-key="lib:${esc(s.appName)}">
    <span class="stage-list-cover">${stageCoverMarkup(s, "stage-cover-art", index > 30)}</span>
    <span class="stage-list-main">
      <strong>${esc(s.title)}</strong>
      <span>${stageMetaLine(s)}</span>
    </span>
    <span class="stage-list-status">${stageStatus(s)}</span>
    <span class="stage-list-chevron">${icon("chevron-right", 18)}</span>
  </button>`;
}

export function stageLibrarySideHtml(s: EpicSummary | undefined): string {
  if (!s) {
    return `<aside class="stage-library-side" id="stage-library-side"><div class="stage-side-empty">${icon("search", 30)}<strong>${esc(t("stage.noResults"))}</strong><span>${esc(t("stage.noResultsHint"))}</span></div></aside>`;
  }
  const ach = stageAchievements(s);
  const favorite = S.epicFav.has(s.appName);
  const achKnown = ach?.progress_known !== false;
  const achPercent = ach?.supported && ach.total_achievements > 0 && achKnown
    ? Math.round((ach.user_unlocked / ach.total_achievements) * 100)
    : 0;
  const achLine = ach?.supported && ach.total_achievements > 0
    ? `<div class="stage-side-ach">
        <span>${icon("trophy", 16)} ${esc(t("stage.achievements"))}</span>
        <strong class="tabular-nums">${achKnown ? `${ach.user_unlocked} / ${ach.total_achievements}` : String(ach.total_achievements)}</strong>
        ${achKnown ? stageProgress(achPercent, "stage-progress-thin") : ""}
      </div>`
    : "";
  return `<aside class="stage-library-side" id="stage-library-side">
    <div class="stage-side-art">${stageHeroMarkup(s, "stage-side-image")}</div>
    <div class="stage-side-body">
      <span class="stage-side-store">${esc(stageStoreName(sourceOfKey(s.appName)))}</span>
      <h2 class="stage-side-title">${esc(s.title)}</h2>
      <div class="stage-side-meta">${stageMetaLine(s, { withStore: false })}</div>
      <div class="stage-side-actions">
        <div class="stage-primary-action">${stagePrimaryAction(s)}</div>
        <button type="button" class="stage-icon-btn${favorite ? " faved" : ""}" data-stage-act="favorite" data-key="${esc(s.appName)}" data-gp-item data-gp-key="side:favorite" aria-label="${esc(t("stage.favorite"))}">${icon("heart", 18)}</button>
        <button type="button" class="stage-icon-btn" data-stage-act="open-program" data-key="${esc(s.appName)}" data-gp-item data-gp-key="side:details" aria-label="${esc(t("stage.details"))}">${icon("dots", 18)}</button>
      </div>
      ${achLine}
      <div class="stage-side-note">${esc(t("stage.sideHint"))}</div>
    </div>
  </aside>`;
}

const sidePanel = stageLibrarySideHtml;

export function renderStageLibrary(): string {
  ensureRenderedLimit();
  const list = stageLibraryList();
  renderedList = list;
  const visible = list.slice(0, renderedLimit);
  const focusKey = S.stage.focusKey;
  const focused = focusKey.startsWith("lib:") ? stageGameByKey(focusKey.slice(4)) : undefined;
  // The side stage keeps the last previewed game when the focus moves up to the
  // filters or the tools; it must not snap back to the first cover.
  const previewed = S.stage.previewKey
    ? visible.find((s) => s.appName === S.stage.previewKey)
    : undefined;
  const selected = previewed
    ?? (visible.some((s) => s.appName === focused?.appName) ? focused : visible[0]);
  if (selected) S.stage.previewKey = selected.appName;
  // The wall owns the default focus; the filter row stays reachable with Up.
  if (!S.stage.focusKey && selected) S.stage.focusKey = `lib:${selected.appName}`;
  if (selected) stagePrefetch([stageWideArt(selected)], 1);

  const more = list.length > visible.length
    ? `<div class="stage-wall-more">${esc(t("stage.loadingMore"))}</div>`
    : "";
  const body = list.length === 0
    ? `<div class="stage-library-empty">
        ${icon("search", 38)}
        <h2>${esc(t("stage.noResults"))}</h2>
        <p>${esc(t("stage.noResultsHint"))}</p>
        <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="reset-filters" data-gp-item data-gp-key="empty:reset">${esc(t("stage.resetFilters"))}</button>
      </div>`
    : S.stage.libraryView === "grid"
      ? `<div class="stage-wall stage-wall-grid" data-gp-default>${visible.map((s, index) => gridCard(s, index)).join("")}${more}</div>`
      : `<div class="stage-wall stage-wall-list" data-gp-default>${visible.map((s, index) => listRow(s, index)).join("")}${more}</div>`;

  return `<div class="stage-library">
    <header class="stage-library-head">
      <div class="stage-library-titles">
        <h1>${esc(t("stage.navLibrary"))}</h1>
        <span>${esc(t("stage.libraryCount", { n: list.length }))}</span>
      </div>
      ${filterTabs()}
      ${tools()}
    </header>
    <div class="stage-library-body">
      <div class="stage-library-wall">${body}</div>
      ${sidePanel(selected)}
    </div>
  </div>`;
}

/** Focus preview: repaint only the side stage, never the whole wall. */
export function stageLibraryFocus(key: string): void {
  if (!key.startsWith("lib:")) return;
  const summary = stageGameByKey(key.slice(4));
  const side = document.getElementById("stage-library-side");
  if (!summary || !side) return;
  S.stage.previewKey = summary.appName;
  updateStageBackdrop(stageWideArt(summary));
  side.outerHTML = sidePanel(summary);
  const next = stageGameByKey(key.slice(4));
  if (next) {
    // The wall was just rendered from this exact list: sorting and filtering
    // 600 games again for every D-pad step is wasted work.
    const all = renderedList.length > 0 ? renderedList : stageLibraryList();
    const index = all.findIndex((s) => s.appName === next.appName);
    stagePrefetch(
      [all[index - 1], all[index + 1], all[index + 2]].map((s) => (s ? stageWideArt(s) : null)),
      3,
    );
  }
  const panel = document.getElementById("stage-library-side");
  if (panel) {
    panel.querySelectorAll<HTMLElement>("button").forEach((button) => button.setAttribute("data-gp-item", ""));
  }
}

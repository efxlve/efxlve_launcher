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
import { SMART_COLLECTIONS, smartCollection } from "../library/smart-collections";
import { stageCoverMarkup, stageHeroMarkup, stagePrefetch, stageWideArt } from "./stage-art";
import { swapStageArt } from "./stage-art-swap";
import { updateStageBackdrop } from "./stage-backdrop";
import {
  stageAchievements,
  stageFilterCounts,
  stageGameByKey,
  stageHasUpdate,
  stageLibraryList,
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
    S.stage.collectionId ?? "",
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
  const collectionId = S.stage.collectionId;
  const manual = collectionId
    ? S.epicCollections.find((item) => item.id === collectionId)
    : undefined;
  const smart = collectionId ? smartCollection(collectionId) : undefined;
  const collectionName = manual?.name ?? smart?.label() ?? "";
  const hasCollections =
    S.epicCollections.some((collection) => collection.app_names.length > 0) ||
    SMART_COLLECTIONS.length > 0;
  const collectionChip = collectionName
    ? `<button type="button" class="stage-tool stage-query-chip" data-stage-act="clear-collection" data-gp-item data-gp-key="tool:collection-clear">${icon("layers", 14)}<span>${esc(collectionName)}</span>${icon("x", 14)}</button>`
    : "";
  const collectionTool = hasCollections
    ? `<button type="button" class="stage-tool" data-stage-act="cycle-collection" data-gp-item data-gp-key="tool:collection">${icon("layers", 16)}<span>${esc(collectionName || t("stage.collections"))}</span></button>`
    : "";
  const queryChip = S.stage.query
    ? `<button type="button" class="stage-tool stage-query-chip" data-stage-act="clear-query" data-gp-item data-gp-key="tool:query">${icon("search", 14)}<span>${esc(S.stage.query)}</span>${icon("x", 14)}</button>`
    : "";
  return `<div class="stage-library-tools">
    ${collectionChip}
    ${queryChip}
    ${collectionTool}
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

/** The achievements card's inner content; empty means the card is hidden. */
function sideAchievementsInner(s: EpicSummary): string {
  const ach = stageAchievements(s);
  if (!ach?.supported || ach.total_achievements <= 0) return "";
  const known = ach.progress_known !== false;
  const percent = known ? Math.round((ach.user_unlocked / ach.total_achievements) * 100) : 0;
  return `<span>${icon("trophy", 16)} ${esc(t("stage.achievements"))}</span>
    <strong class="tabular-nums">${known ? `${ach.user_unlocked} / ${ach.total_achievements}` : String(ach.total_achievements)}</strong>
    ${known ? stageProgress(percent, "stage-progress-thin") : ""}`;
}

/** Play/favourite/details row, shared by the first render and the in-place patch. */
function sideActionsHtml(s: EpicSummary): string {
  const favorite = S.epicFav.has(s.appName);
  return `<div class="stage-primary-action">${stagePrimaryAction(s)}</div>
    <button type="button" class="stage-icon-btn${favorite ? " faved" : ""}" data-stage-act="favorite" data-key="${esc(s.appName)}" data-gp-item data-gp-key="side:favorite" aria-label="${esc(t("stage.favorite"))}">${icon("heart", 18)}</button>
    <button type="button" class="stage-icon-btn" data-stage-act="open-program" data-key="${esc(s.appName)}" data-gp-item data-gp-key="side:details" aria-label="${esc(t("stage.details"))}">${icon("dots", 18)}</button>`;
}

/**
 * Everything the side stage shows that can change between two focus stops.
 * The signature keeps the live patch from rewriting the same panel on every
 * download tick.
 */
function sideSignature(s: EpicSummary): string {
  const ach = stageAchievements(s);
  return [
    s.appName,
    s.title,
    stageWideArt(s) ?? "",
    stageMetaLine(s, { withStore: false }),
    ach?.supported ? "1" : "0",
    ach?.progress_known === false ? "0" : "1",
    ach?.user_unlocked ?? -1,
    ach?.total_achievements ?? -1,
    S.epicFav.has(s.appName) ? "1" : "0",
    S.runningGames.has(s.appName) ? "1" : "0",
    s.installed ? "1" : "0",
    s.downloading ? "1" : "0",
    stageHasUpdate(s) ? "1" : "0",
  ].join("\u001f");
}

export function stageLibrarySideHtml(s: EpicSummary | undefined): string {
  if (!s) {
    return `<aside class="stage-library-side" id="stage-library-side"><div class="stage-side-empty">${icon("search", 30)}<strong>${esc(t("stage.noResults"))}</strong><span>${esc(t("stage.noResultsHint"))}</span></div></aside>`;
  }
  const achInner = sideAchievementsInner(s);
  return `<aside class="stage-library-side" id="stage-library-side" data-side-sig="${esc(sideSignature(s))}">
    <div class="stage-side-art" id="stage-side-art">${stageHeroMarkup(s, "stage-side-image")}</div>
    <div class="stage-side-body">
      <span class="stage-side-store" data-side="store">${esc(stageStoreName(sourceOfKey(s.appName)))}</span>
      <h2 class="stage-side-title" data-side="title">${esc(s.title)}</h2>
      <div class="stage-side-meta" data-side="meta">${stageMetaLine(s, { withStore: false })}</div>
      <div class="stage-side-actions" data-side="actions">${sideActionsHtml(s)}</div>
      <div class="stage-side-ach" data-side="ach"${achInner ? "" : " hidden"}>${achInner}</div>
      <div class="stage-side-note">${esc(t("stage.sideHint"))}</div>
    </div>
  </aside>`;
}

/**
 * Repaint the side stage in place. The panel node, its store/title/meta
 * elements and the favourite/details buttons survive a focus move; only the
 * picture is layered and the action row is rewritten (it can change shape
 * between Play, Install and Update). Rebuilding the whole aside per D-pad step
 * re-decoded the art and dropped the ring's node identity.
 */
export function patchStageLibrarySide(s: EpicSummary | undefined): void {
  const side = document.getElementById("stage-library-side");
  if (!side || !s) return;
  const sig = sideSignature(s);
  if (side.dataset.sideSig === sig) return;
  side.dataset.sideSig = sig;

  const artEl = document.getElementById("stage-side-art");
  if (artEl) {
    swapStageArt(artEl, {
      url: stageWideArt(s),
      key: s.appName,
      className: "stage-side-image",
      fallback: stageHeroMarkup(s, "stage-side-image"),
    });
  }
  const text = (name: string, value: string): void => {
    const el = side.querySelector<HTMLElement>(`[data-side="${name}"]`);
    if (el) el.textContent = value;
  };
  text("store", stageStoreName(sourceOfKey(s.appName)));
  text("title", s.title);
  const meta = side.querySelector<HTMLElement>('[data-side="meta"]');
  if (meta) meta.innerHTML = stageMetaLine(s, { withStore: false });

  const actions = side.querySelector<HTMLElement>('[data-side="actions"]');
  if (actions) {
    actions.innerHTML = sideActionsHtml(s);
    actions.querySelectorAll<HTMLElement>("button").forEach((button) => button.setAttribute("data-gp-item", ""));
  }
  const achEl = side.querySelector<HTMLElement>('[data-side="ach"]');
  if (achEl) {
    const achInner = sideAchievementsInner(s);
    achEl.innerHTML = achInner;
    achEl.hidden = !achInner;
  }
}

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
      ${stageLibrarySideHtml(selected)}
    </div>
  </div>`;
}

/** Focus preview: patch the side stage in place, never the whole wall. */
export function stageLibraryFocus(key: string): void {
  if (!key.startsWith("lib:")) return;
  const summary = stageGameByKey(key.slice(4));
  if (!summary) return;
  S.stage.previewKey = summary.appName;
  updateStageBackdrop(stageWideArt(summary));
  patchStageLibrarySide(summary);
  // The wall was just rendered from this exact list: sorting and filtering
  // 600 games again for every D-pad step is wasted work.
  const all = renderedList.length > 0 ? renderedList : stageLibraryList();
  const index = all.findIndex((s) => s.appName === summary.appName);
  stagePrefetch(
    [all[index - 1], all[index + 1], all[index + 2]].map((s) => (s ? stageWideArt(s) : null)),
    3,
  );
}

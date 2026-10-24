/**
 * Collections (categories) management UI.
 *
 * Renders the collection editor modal and the per-game collection picker, and
 * persists changes through the Epic collections commands. State lives in S;
 * re-renders go through the render bus.
 */

import { COLLECTION_ICONS, collectionMarker, isCollectionIcon } from "../../core/collection-icons";
import { isTauri } from "../../core/constants";
import { collectionRoot } from "../../core/dom";
import { cachedImage, warmImages } from "../../core/picture-cache";
import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { allStoreSummaries, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

import { epicDeleteCollection, epicGetCollections, epicImportEglCollections, epicSaveCollection, epicSetGameCollections, type GameCollection } from "../../epic";
import { renderCollectionTags } from "../drawer/drawer-view";
import { SMART_COLLECTIONS } from "../library/smart-collections";

/** The picker renders in pages so a 1,000-game library does not build every row before the first paint. */
const COL_PAGE_SIZE = 120;
let colVisible = COL_PAGE_SIZE;
let colSearchTimer: number | null = null;

function filteredColSummaries() {
  const q = S.colModalSearchQuery.toLowerCase();
  let filtered = allStoreSummaries().filter((s) => s.title.toLowerCase().includes(q));
  if (S.colModalTabFilter === "selected") {
    filtered = filtered.filter((s) => S.colModalSelectedApps.has(s.appName));
  } else if (S.colModalTabFilter === "installed") {
    filtered = filtered.filter((s) => s.installed);
  }
  return filtered;
}

function colGameRowsHtml(filtered: ReturnType<typeof filteredColSummaries>): string {
  if (filtered.length === 0) return `<div class="col-empty-msg">${t("col.noMatch")}</div>`;
  const rows = filtered.slice(0, colVisible).map((s) => colGameRow(s)).join("");
  const remaining = filtered.length - colVisible;
  const more = remaining > 0
    ? `<button type="button" class="col-load-more" data-act="col-load-more">${t("profile.showMore")} (${remaining})</button>`
    : "";
  return rows + more;
}

export function openCollectionModal(colId?: string | null): void {
  S.activeEditingColId = colId ?? null;
  S.colModalSearchQuery = "";
  S.colModalTabFilter = "all";
  S.isMarkerPaletteOpen = false;
  colVisible = COL_PAGE_SIZE;
  if (colId) {
    const col = S.epicCollections.find((c) => c.id === colId);
    S.colModalSelectedApps = new Set(col?.app_names || []);
    S.colModalMarker = isCollectionIcon(col?.emoji) ? (col!.emoji as string) : "";
  } else {
    S.colModalSelectedApps = new Set();
    S.colModalMarker = "";
  }
  renderCollectionModal();
}

export function closeCollectionModal(): void {
  if (collectionRoot) collectionRoot.innerHTML = "";
  S.activeEditingColId = null;
  S.gameColModalAppName = null;
  S.isMarkerPaletteOpen = false;
}

/** Refresh the marker avatar/palette in place (avoids a full modal re-render). */
export function updateMarkerUi(): void {
  const display = document.getElementById("col-marker-display");
  const avatarBtn = document.querySelector(".col-marker-avatar-btn");
  const headerAvatar = document.getElementById("col-header-avatar");
  if (display) {
    display.innerHTML = collectionMarker(S.colModalMarker, 20);
  }
  if (avatarBtn) {
    avatarBtn.classList.toggle("has-marker", Boolean(S.colModalMarker));
  }
  if (headerAvatar) {
    headerAvatar.innerHTML = collectionMarker(S.colModalMarker, 18);
  }
  const pal = document.getElementById("col-marker-palette");
  if (pal) {
    pal.classList.toggle("open", S.isMarkerPaletteOpen);
    pal.querySelectorAll(".col-marker-item").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.icon === S.colModalMarker);
    });
  }
}

function colGameRow(s: { appName: string; title: string; cover?: string | null; installed: boolean }): string {
  const checked = S.colModalSelectedApps.has(s.appName);
  const thumb = s.cover
    ? `<img class="col-game-thumb" src="${esc(s.cover)}" alt="" loading="lazy" />`
    : `<div class="col-game-thumb placeholder">${icon("gamepad-2", 14)}</div>`;
  return `
    <button type="button" class="col-game-item ${checked ? "selected" : ""}" data-act="col-toggle-game" data-app="${esc(s.appName)}">
      <span class="col-custom-cb ${checked ? "checked" : ""}">${icon("check", 12)}</span>
      ${thumb}
      <span class="col-game-title">${esc(s.title)}</span>
      ${s.installed ? `<span class="col-inst-badge">${t("common.installed")}</span>` : ""}
    </button>`;
}

export function renderCollectionModal(): void {
  if (!collectionRoot) return;
  const col = S.activeEditingColId ? S.epicCollections.find((c) => c.id === S.activeEditingColId) : null;
  const colName = col ? col.name : "";
  const isEditing = Boolean(S.activeEditingColId);

  const filtered = filteredColSummaries();
  colVisible = COL_PAGE_SIZE;

  const selectedCount = S.colModalSelectedApps.size;

  collectionRoot.innerHTML = `
    <div class="col-modal-backdrop" data-act="col-modal-backdrop">
      <div class="col-modal-card ced" role="dialog" aria-modal="true">
        <div class="col-modal-header">
          <h2>${isEditing ? t("col.editTitle") : t("col.newTitle")}</h2>
          <button class="col-modal-close" data-act="close-col-modal" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>

        <div class="col-modal-body">
          <div class="col-name-row">
            <div class="col-marker-picker-container">
              <button type="button" class="col-marker-avatar-btn ${S.colModalMarker ? "has-marker" : ""}" data-act="toggle-col-marker-palette" title="${t("col.pickIcon")}">
                <span id="col-marker-display">${collectionMarker(S.colModalMarker, 18)}</span>
              </button>
              <div id="col-marker-palette" class="col-marker-palette ${S.isMarkerPaletteOpen ? "open" : ""}">
                <div class="col-marker-grid">
                  ${COLLECTION_ICONS.map((name) => `
                    <button type="button" class="col-marker-item ${S.colModalMarker === name ? "active" : ""}" data-act="pick-col-marker" data-icon="${name}" title="${name}">${icon(name, 16)}</button>
                  `).join("")}
                  ${S.colModalMarker ? `<button type="button" class="col-marker-item" data-act="clear-col-marker" title="${t("col.remove")}">${icon("x", 14)}</button>` : ""}
                </div>
              </div>
            </div>
            <input id="col-name-input" class="text-input col-name-input" placeholder="${t("col.namePlaceholder")}" value="${esc(colName)}" autocomplete="off" spellcheck="false" />
          </div>

          <div class="col-toolbar">
            <div class="col-search-wrap">
              <span>${icon("search", 14)}</span>
              <input id="col-search-input" class="text-input" placeholder="${t("lib.searchPlaceholder")}" value="${esc(S.colModalSearchQuery)}" autocomplete="off" />
              ${S.colModalSearchQuery ? `<button type="button" class="col-search-clear" data-act="col-search-clear" title="${t("col.clear")}">${icon("x", 12)}</button>` : ""}
            </div>
            <div class="col-toolbar-row">
              <div class="col-filter-tabs">
                <button type="button" class="col-filter-tab ${S.colModalTabFilter === "all" ? "active" : ""}" data-act="col-tab-filter" data-filter="all">${t("library.all")}</button>
                <button type="button" class="col-filter-tab ${S.colModalTabFilter === "selected" ? "active" : ""}" data-act="col-tab-filter" data-filter="selected">${t("col.filterSelected")} <span class="col-tab-cnt" id="col-tab-selected-cnt">${selectedCount}</span></button>
                <button type="button" class="col-filter-tab ${S.colModalTabFilter === "installed" ? "active" : ""}" data-act="col-tab-filter" data-filter="installed">${t("library.installed")}</button>
              </div>
              <button type="button" class="col-text-btn" data-act="col-select-all">${t("col.selectAll")}</button>
              <button type="button" class="col-text-btn" data-act="col-deselect-all">${t("col.clear")}</button>
            </div>
          </div>

          <div class="col-games-list">
            ${colGameRowsHtml(filtered)}
          </div>
        </div>

        <div class="col-modal-footer">
          <div id="col-delete-confirm" class="col-delete-bar" hidden>
            <span>${t("col.deleteHint")}</span>
            <button class="btn ghost" data-act="col-delete-cancel">${t("common.cancelShort")}</button>
            <button class="btn danger" data-act="col-delete-confirm" data-col-id="${isEditing ? esc(col!.id) : ""}">${t("col.delete")}</button>
          </div>
          <div class="col-footer-actions">
            ${isEditing ? `<button class="btn ghost danger" data-act="col-delete-ask">${t("col.delete")}</button>` : `<span class="col-footer-summary" id="col-footer-count">${selectedCount}</span>`}
            <span class="col-footer-spacer"></span>
            <button class="btn ghost" data-act="close-col-modal">${t("common.cancelShort")}</button>
            <button class="btn primary" data-act="col-save-btn">${isEditing ? t("col.saveChanges") : t("col.create")}</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const nameInput = document.getElementById("col-name-input") as HTMLInputElement | null;
  if (nameInput && !isEditing) nameInput.focus();

  const searchInput = document.getElementById("col-search-input") as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      S.colModalSearchQuery = (e.target as HTMLInputElement).value;
      colVisible = COL_PAGE_SIZE;
      if (colSearchTimer !== null) window.clearTimeout(colSearchTimer);
      // Typing rebuilds a list of every store; wait for a short pause instead
      // of doing that on each keystroke.
      colSearchTimer = window.setTimeout(() => {
        colSearchTimer = null;
        updateColGamesListInPlace();
      }, 120);
    });
  }
}

export function updateColGamesListInPlace(preserveScroll = false): void {
  const container = document.querySelector(".col-games-list");
  if (!container) return;
  const filtered = filteredColSummaries();
  const previousScroll = preserveScroll ? container.scrollTop : 0;

  container.innerHTML = colGameRowsHtml(filtered);
  if (preserveScroll) container.scrollTop = previousScroll;

  const selCountEl = document.getElementById("col-tab-selected-cnt");
  if (selCountEl) selCountEl.textContent = String(S.colModalSelectedApps.size);

  const headerBadge = document.getElementById("col-header-selected-badge");
  if (headerBadge) headerBadge.textContent = t("col.selectedCount", { count: S.colModalSelectedApps.size });

  const footerCnt = document.getElementById("col-footer-count");
  if (footerCnt) footerCnt.textContent = String(S.colModalSelectedApps.size);
}

/** Resets the picker to its first page after a search or filter change. */
export function resetCollectionPickerLimit(): void {
  colVisible = COL_PAGE_SIZE;
}

/** Reveals the next page while keeping the scroll position. */
export function showMoreCollectionGames(): void {
  colVisible += COL_PAGE_SIZE;
  updateColGamesListInPlace(true);
}

export async function saveCollectionFromModal(): Promise<boolean> {
  const nameInput = document.getElementById("col-name-input") as HTMLInputElement | null;
  const name = nameInput?.value.trim() || "";
  if (!name) {
    toast(t("col.needName"), "err");
    return false;
  }
  try {
    const saved = await epicSaveCollection(
      name,
      Array.from(S.colModalSelectedApps),
      S.activeEditingColId,
      S.colModalMarker || null,
    );
    toast(t("col.saved", { name: saved.name }), "ok");
    closeCollectionModal();
    await loadEpicCollections();
    return true;
  } catch (e) {
    toast(t("col.saveFailed", { msg: String(e) }), "err");
    return false;
  }
}

export async function deleteCollectionFromModal(colId: string): Promise<boolean> {
  const col = S.epicCollections.find((c) => c.id === colId);
  const name = col ? col.name : t("col.defaultName");
  try {
    await epicDeleteCollection(colId);
    if (S.activeCollectionId === colId) S.activeCollectionId = null;
    toast(t("col.deleted", { name }), "ok");
    closeCollectionModal();
    await loadEpicCollections();
    return true;
  } catch (e) {
    toast(t("col.deleteFailed", { msg: String(e) }), "err");
    return false;
  }
}

/* ---------- Per-game collection picker (opened from the detail drawer) ---------- */




export function openGameCollectionsModal(appName: string): void {
  if (!collectionRoot) return;
  S.gameColModalAppName = appName;
  S.gameColModalSelectedCols = new Set(
    S.epicCollections
      .filter((c) => c.app_names.some((a) => a.toLowerCase() === appName.toLowerCase()))
      .map((c) => c.id),
  );

  const sum = summaryOf(appName);
  const title = sum?.title || appName;

  collectionRoot.innerHTML = `
    <div class="col-modal-backdrop" data-act="col-modal-backdrop">
      <div class="col-modal-card" role="dialog" aria-modal="true">
        <div class="col-modal-header">
          <div class="col-modal-title">
            <div class="col-modal-header-avatar">
              ${icon("folder", 20)}
            </div>
            <div>
              <h2>${t("lib.collections")}</h2>
              <div class="col-modal-subtitle">${t("col.chooseCategories", { name: esc(title) })}</div>
            </div>
          </div>
          <button class="col-modal-close" data-act="close-col-modal" title="${t("common.close")}">
            ${icon("x", 16)}
          </button>
        </div>
        <div class="col-modal-body">
          <div class="col-game-checkboxes">
            ${S.epicCollections.length > 0 ? S.epicCollections.map((c) => {
              const checked = S.gameColModalSelectedCols.has(c.id);
              return `
                <div class="col-game-item ${checked ? "selected" : ""}" data-col-id="${esc(c.id)}">
                  <div class="col-custom-cb ${checked ? "checked" : ""}">
                    ${icon("check", 12)}
                  </div>
                  <div class="col-game-info">
                    <div class="col-game-title">
                      ${isCollectionIcon(c.emoji) ? `<span class="col-item-marker">${collectionMarker(c.emoji, 14)}</span> ` : ""}${esc(c.name)}
                    </div>
                    <div class="col-game-sub">${t("col.gameCount", { count: c.app_names.length })}</div>
                  </div>
                </div>
              `;
            }).join("") : `
              <div class="col-empty-msg">
                ${t("col.noCollectionsLong")}<br/>
                <button class="btn ghost small" data-act="open-new-collection-modal" style="margin-top:8px">${t("col.newCollectionBtn")}</button>
              </div>
            `}
          </div>
        </div>
        <div class="col-modal-footer">
          <button class="btn ghost small" data-act="open-new-collection-modal">${t("lib.newCollection")}</button>
          <div style="display:flex;gap:10px">
            <button class="btn ghost small" data-act="close-col-modal">${t("common.cancelShort")}</button>
            <button class="btn primary small" data-act="save-game-col-btn">${t("common.save")}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export async function saveGameCollectionsFromModal(): Promise<void> {
  if (!S.gameColModalAppName) return;
  const appName = S.gameColModalAppName;
  const colIds = Array.from(S.gameColModalSelectedCols);
  try {
    await epicSetGameCollections(appName, colIds);
    toast(t("col.updated"), "ok");
    closeCollectionModal();
    await loadEpicCollections();
    if (S.currentModalAppName === appName) {
      updateDrawerCollectionsBoxInPlace(appName);
    }
  } catch (e) {
    toast(t("col.updateFailed", { msg: String(e) }), "err");
  }
}

export function updateDrawerCollectionsBoxInPlace(appName: string): void {
  const container = document.getElementById("drawer-col-chips-container");
  if (container) {
    const html = renderCollectionTags(appName);
    container.innerHTML = html;
    container.style.display = html ? "" : "none";
  }
}

/** Load the user's collections from Epic and refresh the library if visible. */
export async function loadEpicCollections(): Promise<void> {
  if (!isTauri) return;
  try {
    // `?? []`: a null from the backend (older binary, shape change) must not
    // reach the state — every collection view calls `.map`/`.find` on it.
    S.epicCollections = (await epicGetCollections()) ?? [];
    S.libraryDataRev++;
    if (S.view === "library") scheduleRender();
  } catch (e) {
    console.warn("Collections could not be fetched:", e);
  }
  syncEglCollectionsOnce();
}

let eglSynced = false;

function collectionSig(cols: GameCollection[]): string {
  return cols
    .map((c) => `${c.id}\t${c.name}\t${c.app_names.join(",")}`)
    .sort()
    .join("\n");
}

/**
 * Pull Epic Games Launcher categories once per session.
 * The manual import button stays; this is the same merge, run at startup so a
 * reboot does not leave the library without those categories.
 */
function syncEglCollectionsOnce(): void {
  if (!isTauri || eglSynced) return;
  eglSynced = true;
  void epicImportEglCollections()
    .then((cols) => {
      if (!cols.length) return;
      if (collectionSig(S.epicCollections) === collectionSig(cols)) return;
      S.epicCollections = cols;
      S.libraryDataRev++;
      if (S.view === "library" || S.view === "settings") scheduleRender();
    })
    .catch(() => {
      eglSynced = false;
    });
}
function smartIcon(id: string): string {
  switch (id) {
    case "smart:not-played": return icon("clock", 15);
    case "smart:playing": return icon("play", 15);
    case "smart:almost": return icon("star", 15);
    case "smart:completed": return icon("trophy", 15);
    case "smart:on-hold": return icon("pause", 15);
    case "smart:forgotten": return icon("ghost", 15);
    default: return icon("sparkles", 15);
  }
}

/** Decorative gallery shown by the library's Collections tab. */
export function openCollectionGallery(): void {
  if (!collectionRoot) return;
  const summaries = allStoreSummaries();

  // One pass over summaries to count matches across all smart collections simultaneously
  const smartCounts = new Map<string, number>();
  for (const item of SMART_COLLECTIONS) smartCounts.set(item.id, 0);
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    for (const item of SMART_COLLECTIONS) {
      if (item.test(s)) {
        smartCounts.set(item.id, (smartCounts.get(item.id) ?? 0) + 1);
      }
    }
  }

  const smart = SMART_COLLECTIONS
    .map((item) => ({ item, count: smartCounts.get(item.id) ?? 0 }))
    .filter((entry) => entry.count > 0);

  const total = S.epicCollections.length;
  const warmUrls: string[] = [];

  const smartCards = smart.map(({ item, count }) => `
    <button type="button" class="col-smart-card${S.activeCollectionId === item.id ? " active" : ""}" data-act="select-col-filter" data-col-id="${esc(item.id)}" title="${esc(item.label())}">
      <span class="col-smart-card-icon">${smartIcon(item.id)}</span>
      <span class="col-smart-card-name">${esc(item.label())}</span>
      <span class="col-smart-card-count">${count}</span>
    </button>`).join("");

  const manualCards = S.epicCollections.map((col) => {
    const appNames = col.app_names ?? [];
    const totalGames = appNames.length;
    let installed = 0;
    const foundCovers: string[] = [];

    // Scan apps once: count installed and take up to 4 covers without mapping all entries
    for (let i = 0; i < appNames.length; i++) {
      const s = summaryOf(appNames[i]);
      if (s) {
        if (s.installed) installed++;
        if (s.cover && foundCovers.length < 4) foundCovers.push(s.cover);
      }
    }

    const covers = foundCovers.length > 0 && foundCovers.length < 4
      ? Array.from({ length: 4 }, (_, i) => foundCovers[i % foundCovers.length])
      : foundCovers;

    if (covers.length > 0) warmUrls.push(...covers);

    const artHtml = covers.length === 0
      ? `<span class="col-gallery-art empty">${icon("layers", 28)}</span>`
      : `<span class="col-gallery-art covers-${covers.length}">${covers.map((c) => `<img src="${esc(cachedImage(c))}" data-img-url="${esc(c)}" alt="" loading="lazy" decoding="async" />`).join("")}</span>`;

    const markerHtml = isCollectionIcon(col.emoji)
      ? `<span class="col-gallery-marker">${collectionMarker(col.emoji, 15)}</span>`
      : "";

    return `
      <div class="col-gallery-card${S.activeCollectionId === col.id ? " active" : ""}" role="button" tabindex="0" data-act="select-col-filter" data-col-id="${esc(col.id)}">
        ${artHtml}
        <span class="col-gallery-shade"></span>
        <span class="col-gallery-info">
          <span class="col-gallery-name-row">
            ${markerHtml}
            <span class="col-gallery-name">${esc(col.name)}</span>
          </span>
          <span class="col-gallery-count">${installed} / ${totalGames} ${t("common.installed")}</span>
        </span>
        <button type="button" class="col-gallery-edit" data-act="edit-collection" data-col-id="${esc(col.id)}" title="${esc(t("col.edit"))}" aria-label="${esc(t("col.edit"))}">${icon("settings", 13)}</button>
      </div>`;
  }).join("");

  collectionRoot.innerHTML = `
    <div class="col-gallery-backdrop" data-act="close-col-gallery">
      <section class="col-gallery" role="dialog" aria-modal="true" aria-label="${esc(t("col.allCollections"))}" data-gallery-panel data-act="col-gallery-panel">
        <header class="col-gallery-head">
          <div class="col-gallery-title-wrap">
            <span class="col-gallery-head-icon">${icon("layers", 20)}</span>
            <div>
              <div class="col-gallery-title-row">
                <h2>${esc(t("col.allCollections"))}</h2>
                <span class="col-gallery-pill">${total}</span>
              </div>
              <p class="col-gallery-sub">${t("col.gameCount", { count: summaries.length })}</p>
            </div>
          </div>
          <div class="col-gallery-actions">
            ${S.activeCollectionId ? `
              <button type="button" class="btn ghost small col-gallery-clear" data-act="select-col-filter" data-col-id="all">
                ${icon("x", 13)} <span>${esc(t("col.noCollectionFilter"))}</span>
              </button>` : ""}
            <button type="button" class="col-gallery-close" data-act="close-col-gallery" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">
              ${icon("x", 16)}
            </button>
          </div>
        </header>

        ${smartCards ? `
          <div class="col-gallery-section">
            <div class="col-gallery-section-head">
              <h3>${icon("sparkles", 13)} <span>${esc(t("smart.title"))}</span></h3>
            </div>
            <div class="col-smart-grid">${smartCards}</div>
          </div>` : ""}

        <div class="col-gallery-section">
          <div class="col-gallery-section-head">
            <h3>${icon("folder", 13)} <span>${esc(t("col.allCollections"))}</span></h3>
            <button type="button" class="btn primary small col-gallery-add-btn" data-act="open-new-collection-modal">
              ${icon("plus", 14)} <span>${esc(t("col.newTitle"))}</span>
            </button>
          </div>
          <div class="col-gallery-grid">
            ${manualCards}
            ${total === 0 ? `
              <div class="col-gallery-empty">
                <div class="col-gallery-empty-icon">${icon("layers", 36)}</div>
                <div class="col-gallery-empty-title">${esc(t("col.noCollectionsLong"))}</div>
                <button type="button" class="btn primary small" data-act="open-new-collection-modal">${icon("plus", 14)} ${esc(t("col.newTitle"))}</button>
              </div>` : ""}
          </div>
        </div>
      </section>
    </div>`;

  // The gallery opens with visible covers; ask the Rust disk cache for
  // them once so the next open paints from local data instead of the CDN.
  warmImages(warmUrls);
  collectionRoot.querySelectorAll<HTMLImageElement>(".col-gallery-art img").forEach((img) => {
    img.addEventListener("error", () => { img.style.display = "none"; }, { once: true });
  });
}

export function closeCollectionGallery(): void {
  if (collectionRoot) collectionRoot.innerHTML = "";
}

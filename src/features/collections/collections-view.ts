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
import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

import { epicDeleteCollection, epicGetCollections, epicSaveCollection, epicSetGameCollections } from "../../epic";
import { renderCollectionTags } from "../drawer/drawer-view";
export function openCollectionModal(colId?: string | null): void {
  S.activeEditingColId = colId ?? null;
  S.colModalSearchQuery = "";
  S.colModalTabFilter = "all";
  S.isMarkerPaletteOpen = false;
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

  const q = S.colModalSearchQuery.toLowerCase();
  let filtered = S.epicSummaries.filter((s) => s.title.toLowerCase().includes(q));
  if (S.colModalTabFilter === "selected") {
    filtered = filtered.filter((s) => S.colModalSelectedApps.has(s.appName));
  } else if (S.colModalTabFilter === "installed") {
    filtered = filtered.filter((s) => s.installed);
  }

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
            ${filtered.length > 0 ? filtered.map((s) => colGameRow(s)).join("") : `<div class="col-empty-msg">${t("col.noMatch")}</div>`}
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
      updateColGamesListInPlace();
    });
  }
}

export function updateColGamesListInPlace(): void {
  const container = document.querySelector(".col-games-list");
  if (!container) return;
  const q = S.colModalSearchQuery.toLowerCase();
  let filtered = S.epicSummaries.filter((s) => s.title.toLowerCase().includes(q));
  if (S.colModalTabFilter === "selected") {
    filtered = filtered.filter((s) => S.colModalSelectedApps.has(s.appName));
  } else if (S.colModalTabFilter === "installed") {
    filtered = filtered.filter((s) => s.installed);
  }

  container.innerHTML = filtered.length > 0
    ? filtered.map((s) => colGameRow(s)).join("")
    : `<div class="col-empty-msg">${t("col.noMatch")}</div>`;

  const selCountEl = document.getElementById("col-tab-selected-cnt");
  if (selCountEl) selCountEl.textContent = String(S.colModalSelectedApps.size);

  const headerBadge = document.getElementById("col-header-selected-badge");
  if (headerBadge) headerBadge.textContent = t("col.selectedCount", { count: S.colModalSelectedApps.size });

  const footerCnt = document.getElementById("col-footer-count");
  if (footerCnt) footerCnt.textContent = String(S.colModalSelectedApps.size);
}

export async function saveCollectionFromModal(): Promise<void> {
  const nameInput = document.getElementById("col-name-input") as HTMLInputElement | null;
  const name = nameInput?.value.trim() || "";
  if (!name) {
    toast(t("col.needName"), "err");
    return;
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
  } catch (e) {
    toast(t("col.saveFailed", { msg: String(e) }), "err");
  }
}

export async function deleteCollectionFromModal(colId: string): Promise<void> {
  const col = S.epicCollections.find((c) => c.id === colId);
  const name = col ? col.name : t("col.defaultName");
  try {
    await epicDeleteCollection(colId);
    if (S.activeCollectionId === colId) S.activeCollectionId = null;
    toast(t("col.deleted", { name }), "ok");
    closeCollectionModal();
    await loadEpicCollections();
  } catch (e) {
    toast(t("col.deleteFailed", { msg: String(e) }), "err");
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

  const sum = S.epicSummaries.find((s) => s.appName === appName);
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
  if (container) container.innerHTML = renderCollectionTags(appName);
}

/** Load the user's collections from Epic and refresh the library if visible. */
export async function loadEpicCollections(): Promise<void> {
  if (!isTauri) return;
  try {
    S.epicCollections = await epicGetCollections();
    if (S.view === "library") scheduleRender();
  } catch (e) {
    console.warn("Collections could not be fetched:", e);
  }
}
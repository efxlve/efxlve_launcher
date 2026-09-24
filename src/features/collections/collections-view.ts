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

export function updateColPresetArrows(): void {
  const container = document.getElementById("col-presets-scrollable");
  const wrapper = container?.closest(".col-presets-track-wrapper");
  if (!container || !wrapper) return;

  const leftFade = wrapper.querySelector(".col-presets-fade.left") as HTMLElement | null;
  const rightFade = wrapper.querySelector(".col-presets-fade.right") as HTMLElement | null;

  const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
  const hasOverflow = maxScroll > 4;

  const canScrollLeft = hasOverflow && container.scrollLeft > 4;
  const canScrollRight = hasOverflow && container.scrollLeft < maxScroll - 4;

  if (leftFade) leftFade.classList.toggle("visible", canScrollLeft);
  if (rightFade) rightFade.classList.toggle("visible", canScrollRight);
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

  const installedCount = S.epicSummaries.filter((s) => s.installed).length;
  const selectedCount = S.colModalSelectedApps.size;

  collectionRoot.innerHTML = `
    <div class="col-modal-backdrop" data-act="col-modal-backdrop">
      <div class="col-modal-card" role="dialog" aria-modal="true">
        <div class="col-modal-header">
          <div class="col-modal-title">
            <div class="col-modal-header-avatar" id="col-header-avatar">
              ${collectionMarker(S.colModalMarker, 20)}
            </div>
            <div>
              <h2>
                <span>${isEditing ? t("col.editTitle") : t("col.newTitle")}</span>
                <span class="col-header-count" id="col-header-selected-badge">${t("col.selectedCount", { count: selectedCount })}</span>
              </h2>
              <div class="col-modal-subtitle">${isEditing ? t("col.editSubtitle", { name: esc(colName) }) : t("col.newSubtitle")}</div>
            </div>
          </div>
          <button class="col-modal-close" data-act="close-col-modal" title="${t("common.close")}">
            ${icon("x", 16)}
          </button>
        </div>

        <div class="col-modal-body">
          <div class="col-input-group">
            <label for="col-name-input" class="col-label">${t("col.markerLabel")}</label>
            <div class="col-name-row">
              <div class="col-marker-picker-container">
                <button type="button" class="col-marker-avatar-btn ${S.colModalMarker ? "has-marker" : ""}" data-act="toggle-col-marker-palette" title="${t("col.pickIcon")}">
                  <span id="col-marker-display">${collectionMarker(S.colModalMarker, 22)}</span>
                  <span class="col-marker-edit-badge">${icon("edit", 10)}</span>
                </button>
                <div id="col-marker-palette" class="col-marker-palette ${S.isMarkerPaletteOpen ? "open" : ""}">
                  <div class="col-marker-palette-header">
                    <span>${t("col.pickIconHeader")}</span>
                    ${S.colModalMarker ? `<button type="button" class="col-marker-clear-btn" data-act="clear-col-marker">${icon("trash", 11)} ${t("col.remove")}</button>` : ""}
                  </div>
                  <div class="col-marker-grid">
                    ${COLLECTION_ICONS.map((name) => `
                      <button type="button" class="col-marker-item ${S.colModalMarker === name ? "active" : ""}" data-act="pick-col-marker" data-icon="${name}" title="${name}">${icon(name, 18)}</button>
                    `).join("")}
                  </div>
                </div>
              </div>
              <input id="col-name-input" class="text-input col-name-input" placeholder="${t("col.namePlaceholder")}" value="${esc(colName)}" autocomplete="off" spellcheck="false" />
            </div>

            <!-- Detail-page style scrollable quick presets -->
            <div class="col-presets-wrapper">
              <span class="col-quick-label">${t("col.quickPresets")}</span>
              <div class="col-presets-track-wrapper">
                <div class="col-presets-fade left">
                  <button type="button" class="col-presets-arrow left" data-act="col-presets-scroll" data-dir="left" title="${t("lib.scrollLeft")}">
                    ${icon("chevron-left", 12)}
                  </button>
                </div>
                <div class="col-quick-presets" id="col-presets-scrollable">
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="list" data-name="${t("col.presetStory")}">${icon("list", 13)} <span>${t("col.presetStory")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="globe" data-name="${t("col.presetOnline")}">${icon("globe", 13)} <span>${t("col.presetOnline")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="trophy" data-name="${t("col.presetPlatinum")}">${icon("trophy", 13)} <span>${t("col.presetPlatinum")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="shield" data-name="${t("col.presetRpg")}">${icon("shield", 13)} <span>${t("col.presetRpg")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="zap" data-name="${t("col.presetRacing")}">${icon("zap", 13)} <span>${t("col.presetRacing")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="eye" data-name="${t("col.presetHorror")}">${icon("eye", 13)} <span>${t("col.presetHorror")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="heart" data-name="${t("col.presetFavorites")}">${icon("heart", 13)} <span>${t("col.presetFavorites")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="zap" data-name="${t("col.presetAction")}">${icon("zap", 13)} <span>${t("col.presetAction")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="layers" data-name="${t("col.presetPuzzle")}">${icon("layers", 13)} <span>${t("col.presetPuzzle")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="rocket" data-name="${t("col.presetSciFi")}">${icon("rocket", 13)} <span>${t("col.presetSciFi")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="gamepad-2" data-name="${t("col.presetRetro")}">${icon("gamepad-2", 13)} <span>${t("col.presetRetro")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="cpu" data-name="${t("col.presetStrategy")}">${icon("cpu", 13)} <span>${t("col.presetStrategy")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="crown" data-name="${t("col.presetVip")}">${icon("crown", 13)} <span>${t("col.presetVip")}</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="check-circle" data-name="${t("col.presetCompleted")}">${icon("check-circle", 13)} <span>${t("col.presetCompleted")}</span></button>
                </div>
                <div class="col-presets-fade right">
                  <button type="button" class="col-presets-arrow right" data-act="col-presets-scroll" data-dir="right" title="${t("lib.scrollRight")}">
                    ${icon("chevron-right", 12)}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="col-picker-box">
            <div class="col-picker-head">
              <div class="col-filter-tabs">
                <button type="button" class="col-filter-tab ${S.colModalTabFilter === "all" ? "active" : ""}" data-act="col-tab-filter" data-filter="all">
                  ${t("library.all")} <span class="col-tab-cnt">${S.epicSummaries.length}</span>
                </button>
                <button type="button" class="col-filter-tab ${S.colModalTabFilter === "selected" ? "active" : ""}" data-act="col-tab-filter" data-filter="selected">
                  ${t("col.filterSelected")} <span class="col-tab-cnt" id="col-tab-selected-cnt">${selectedCount}</span>
                </button>
                <button type="button" class="col-filter-tab ${S.colModalTabFilter === "installed" ? "active" : ""}" data-act="col-tab-filter" data-filter="installed">
                  ${t("library.installed")} <span class="col-tab-cnt">${installedCount}</span>
                </button>
              </div>

              <div class="col-quick-btns">
                <button type="button" class="col-quick-btn" data-act="col-select-all">${t("col.selectAll")}</button>
                <button type="button" class="col-quick-btn" data-act="col-deselect-all">${t("col.clear")}</button>
              </div>
            </div>

            <div class="col-search-wrap">
              <span>${icon("search", 13)}</span>
              <input id="col-search-input" class="text-input" placeholder="${t("col.searchPlaceholder", { count: S.epicSummaries.length })}" value="${esc(S.colModalSearchQuery)}" autocomplete="off" />
              ${S.colModalSearchQuery ? `<button type="button" class="col-search-clear" data-act="col-search-clear" title="${t("col.clear")}">${icon("x", 12)}</button>` : ""}
            </div>

            <div class="col-games-list">
              ${filtered.length > 0 ? filtered.map((s) => {
                const checked = S.colModalSelectedApps.has(s.appName);
                return `
                  <div class="col-game-item ${checked ? "selected" : ""}" data-act="col-toggle-game" data-app="${s.appName}">
                    <div class="col-custom-cb ${checked ? "checked" : ""}">
                      ${icon("check", 12)}
                    </div>
                    ${s.cover ? `<img class="col-game-thumb" src="${esc(s.cover)}" alt="" loading="lazy" />` : `<div class="col-game-thumb placeholder">${icon("gamepad-2", 16)}</div>`}
                    <div class="col-game-info">
                      <div class="col-game-title">${esc(s.title)}</div>
                      <div class="col-game-sub">${s.installed ? `<span class="col-inst-badge">${icon("check", 10)} ${t("common.installed")}</span>` : t("common.notInstalled")}</div>
                    </div>
                  </div>
                `;
              }).join("") : `<div class="col-empty-msg">${t("col.noMatch")}</div>`}
            </div>
          </div>
        </div>

        <div class="col-modal-footer">
          <div>
            ${isEditing ? `<button class="btn danger small" data-act="col-delete-btn" data-col-id="${col!.id}">${icon("trash", 13)} ${t("col.delete")}</button>` : `<div class="col-footer-summary">${t("col.footerSummary", { selected: `<span id="col-footer-count">${selectedCount}</span>`, total: S.epicSummaries.length })}</div>`}
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
            <button class="btn ghost small" data-act="close-col-modal">${t("common.cancelShort")}</button>
            <button class="btn primary small" data-act="col-save-btn">${isEditing ? t("col.saveChanges") : t("col.create")}</button>
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

  const presetsScrollable = document.getElementById("col-presets-scrollable");
  if (presetsScrollable) {
    presetsScrollable.addEventListener("scroll", updateColPresetArrows, { passive: true });
    requestAnimationFrame(() => updateColPresetArrows());
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

  container.innerHTML = filtered.length > 0 ? filtered.map((s) => {
    const checked = S.colModalSelectedApps.has(s.appName);
    return `
      <div class="col-game-item ${checked ? "selected" : ""}" data-act="col-toggle-game" data-app="${s.appName}">
        <div class="col-custom-cb ${checked ? "checked" : ""}">
          ${icon("check", 12)}
        </div>
        ${s.cover ? `<img class="col-game-thumb" src="${esc(s.cover)}" alt="" loading="lazy" />` : `<div class="col-game-thumb placeholder">${icon("gamepad-2", 16)}</div>`}
        <div class="col-game-info">
          <div class="col-game-title">${esc(s.title)}</div>
          <div class="col-game-sub">${s.installed ? `<span class="col-inst-badge">${icon("check", 10)} ${t("common.installed")}</span>` : t("common.notInstalled")}</div>
        </div>
      </div>
    `;
  }).join("") : `<div class="col-empty-msg">${t("col.noMatch")}</div>`;

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
  if (!confirm(t("col.deleteConfirm", { name }))) {
    return;
  }
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
      <div class="col-modal-card" style="max-width:540px; height:auto; max-height:75vh;" role="dialog" aria-modal="true">
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
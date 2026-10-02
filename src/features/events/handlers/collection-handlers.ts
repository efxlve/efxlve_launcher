/**
 * Click delegation handlers for game collections, tagging, marker palette,
 * and EGL collections import.
 */

import { toast } from "../../../core/toast";
import { t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import { closeModal } from "../../../core/dom";
import { render } from "../../../core/render";
import { allStoreSummaries } from "../../../core/selectors";
import { resetCardChunk } from "../../library/library-view";
import { loadSettingsView } from "../../settings/settings-view";
import { epicDeleteCollection, epicImportEglCollections, epicSaveCollection } from "../../../epic";
import { gogImportGalaxyTags } from "../../../gog";
import { steamImportCollections } from "../../../steam";
import { hideGameIds } from "../../library/hide-games";
import {
  closeCollectionModal,
  deleteCollectionFromModal,
  loadEpicCollections,
  openCollectionModal,
  openGameCollectionsModal,
  saveCollectionFromModal,
  saveGameCollectionsFromModal,
  updateColGamesListInPlace,
  updateMarkerUi,
} from "../../collections/collections-view";

export function handleCollectionAction(act: string | undefined, t: HTMLElement, id?: string, targetEl?: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "select-collection": {
      const colId = t.dataset.colId;
      if (colId === "all") {
        S.activeCollectionId = null;
        if (S.epicFilter === "fav") S.epicFilter = "all";
      } else if (colId === "fav") {
        S.activeCollectionId = "fav";
        S.epicFilter = "all";
      } else if (colId) {
        S.activeCollectionId = colId;
        if (S.epicFilter === "fav") S.epicFilter = "all";
      }
      if (S.currentModalAppName) closeModal();
      resetCardChunk();
      render();
      return true;
    }

    case "open-new-collection-modal": {
      S.isColDropdownOpen = false;
      const menu = document.getElementById("col-dropdown-menu");
      if (menu) menu.classList.remove("show");
      openCollectionModal();
      return true;
    }

    case "edit-collection": {
      const colId = t.dataset.colId;
      if (colId) openCollectionModal(colId);
      return true;
    }

    case "close-col-modal":
      closeCollectionModal();
      return true;

    case "col-modal-backdrop":
      if (targetEl === t) closeCollectionModal();
      return true;

    case "toggle-col-marker-palette": {
      S.isMarkerPaletteOpen = !S.isMarkerPaletteOpen;
      const pal = document.getElementById("col-marker-palette");
      if (pal) pal.classList.toggle("open", S.isMarkerPaletteOpen);
      return true;
    }

    case "pick-col-marker": {
      const marker = t.dataset.icon;
      if (marker) {
        S.colModalMarker = marker;
        S.isMarkerPaletteOpen = false;
        updateMarkerUi();
      }
      return true;
    }

    case "clear-col-marker":
      S.colModalMarker = "";
      S.isMarkerPaletteOpen = false;
      updateMarkerUi();
      return true;

    case "col-delete-ask":
      document.getElementById("col-delete-confirm")?.removeAttribute("hidden");
      document.querySelector(".col-footer-actions")?.setAttribute("hidden", "");
      return true;

    case "col-delete-cancel":
      document.getElementById("col-delete-confirm")?.setAttribute("hidden", "");
      document.querySelector(".col-footer-actions")?.removeAttribute("hidden");
      return true;

    case "col-tab-filter": {
      const filter = t.dataset.filter as "all" | "selected" | "installed";
      if (filter) {
        S.colModalTabFilter = filter;
        document.querySelectorAll(".col-filter-tab").forEach((tab) => {
          tab.classList.toggle("active", (tab as HTMLElement).dataset.filter === filter);
        });
        updateColGamesListInPlace();
      }
      return true;
    }

    case "col-search-clear": {
      S.colModalSearchQuery = "";
      const sInput = document.getElementById("col-search-input") as HTMLInputElement | null;
      if (sInput) {
        sInput.value = "";
        sInput.focus();
      }
      updateColGamesListInPlace();
      return true;
    }

    case "col-toggle-game": {
      const app = t.dataset.app || (t.closest(".col-game-item") as HTMLElement)?.dataset.app;
      if (app) {
        if (S.colModalSelectedApps.has(app)) {
          S.colModalSelectedApps.delete(app);
        } else {
          S.colModalSelectedApps.add(app);
        }
        const itemEl = (t.classList.contains("col-game-item") ? t : t.closest(".col-game-item")) as HTMLElement | null;
        const isChecked = S.colModalSelectedApps.has(app);
        const cb = itemEl?.querySelector(".col-game-cb") as HTMLInputElement | null;
        if (cb) cb.checked = isChecked;
        if (itemEl) itemEl.classList.toggle("selected", isChecked);

        const selCountEl = document.getElementById("col-tab-selected-cnt");
        if (selCountEl) selCountEl.textContent = String(S.colModalSelectedApps.size);

        if (S.colModalTabFilter === "selected") {
          updateColGamesListInPlace();
        }
      }
      return true;
    }

    case "col-select-all": {
      const q = S.colModalSearchQuery.toLocaleLowerCase("tr");
      let matches = allStoreSummaries().filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
      if (S.colModalTabFilter === "installed") {
        matches = matches.filter((s) => s.installed);
      }
      matches.forEach((s) => S.colModalSelectedApps.add(s.appName));
      updateColGamesListInPlace();
      return true;
    }

    case "col-deselect-all": {
      if (S.colModalTabFilter === "all" && !S.colModalSearchQuery.trim()) {
        S.colModalSelectedApps.clear();
      } else {
        const q = S.colModalSearchQuery.toLocaleLowerCase("tr");
        let matches = allStoreSummaries().filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
        if (S.colModalTabFilter === "installed") {
          matches = matches.filter((s) => s.installed);
        }
        matches.forEach((s) => S.colModalSelectedApps.delete(s.appName));
      }
      updateColGamesListInPlace();
      return true;
    }

    case "col-save-btn":
      void saveCollectionFromModal();
      return true;

    case "col-delete-confirm": {
      const colId = t.dataset.colId;
      if (colId) void deleteCollectionFromModal(colId);
      return true;
    }

    case "manage-game-collections":
      if (id) openGameCollectionsModal(id);
      return true;

    case "save-game-col-btn":
      void saveGameCollectionsFromModal();
      return true;

    case "import-egl-collections":
      toast(i18nT("col.scanningEgl"), "");
      void epicImportEglCollections()
        .then((cols) => {
          toast(i18nT("col.importedCount", { count: cols.length }), "ok");
          void loadEpicCollections();
          if (S.view === "settings") void loadSettingsView();
        })
        .catch((err) => {
          toast(i18nT("col.importFailed", { msg: String(err) }), "err");
        });
      return true;

    case "gog-import-galaxy-tags":
      toast(i18nT("col.scanningGalaxy"), "");
      void gogImportGalaxyTags()
        .then((result) => {
          toast(i18nT("col.importedCount", { count: result.collections.length }), "ok");
          if (result.hidden.length) hideGameIds(result.hidden);
          void loadEpicCollections();
          if (S.view === "settings") void loadSettingsView();
        })
        .catch((err) => {
          toast(i18nT("col.importFailed", { msg: String(err) }), "err");
        });
      return true;

    case "steam-import-collections":
      toast(i18nT("col.scanningSteam"), "");
      void steamImportCollections()
        .then((result) => {
          toast(i18nT("col.importedCount", { count: result.collections.length }), "ok");
          if (result.hidden.length) hideGameIds(result.hidden);
          void loadEpicCollections();
          if (S.view === "settings") void loadSettingsView();
        })
        .catch((err) => {
          toast(i18nT("col.importFailed", { msg: String(err) }), "err");
        });
      return true;

    case "col-merge-ask": {
      const colId = t.dataset.id;
      S.colMergeSource = S.colMergeSource === colId ? null : colId ?? null;
      render();
      return true;
    }

    case "col-merge-cancel":
      S.colMergeSource = null;
      render();
      return true;

    case "col-merge-into": {
      const sourceId = t.dataset.source;
      const targetId = t.dataset.id;
      S.colMergeSource = null;
      void mergeCollectionsInto(sourceId, targetId);
      return true;
    }

    default:
      return false;
  }
}

/** Unions the source collection's games into the target and removes the source. */
async function mergeCollectionsInto(sourceId?: string, targetId?: string): Promise<void> {
  const source = S.epicCollections.find((c) => c.id === sourceId);
  const target = S.epicCollections.find((c) => c.id === targetId);
  if (!source || !target) return;
  const merged = [...new Set([...target.app_names, ...source.app_names])];
  try {
    await epicSaveCollection(target.name, merged, target.id);
    await epicDeleteCollection(source.id);
    toast(i18nT("col.merged", { count: source.app_names.length, name: target.name }), "ok");
    await loadEpicCollections();
    if (S.view === "settings") void loadSettingsView();
  } catch (e) {
    toast(i18nT("col.mergeFailed", { msg: String(e) }), "err");
  }
}

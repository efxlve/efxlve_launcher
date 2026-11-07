/**
 * Click delegation handlers for library grouping, collapsible shelves,
 * and per-game custom sorting titles ("Sort As").
 */

import { render } from "../../../core/render";
import { S } from "../../../core/state";
import type { LibGroupBy } from "../../../core/types";
import { setLibGroupBy, toggleLibGroupCollapsed } from "../../library/library-groups";
import { refreshLibraryResultsInPlace, resetCardChunk } from "../../library/library-view";
import {
  closeSortNameModal,
  openSortNameModal,
  resetSortNameModal,
  saveSortNameModal,
} from "../../library/sort-name";

export function handleLibraryFeatureAction(
  act: string | undefined,
  t: HTMLElement,
  id?: string,
  targetEl?: HTMLElement,
): boolean {
  if (!act) return false;

  switch (act) {
    case "select-group-by": {
      const mode = (t.dataset.groupBy || t.dataset.group || "none") as LibGroupBy;
      S.isSortDropdownOpen = false;
      document.getElementById("sort-dropdown-menu")?.classList.remove("show");
      if (mode !== S.libGroupBy) {
        setLibGroupBy(mode);
        resetCardChunk();
        render();
      }
      return true;
    }

    case "toggle-lib-group": {
      const key = t.dataset.groupKey;
      if (key) {
        toggleLibGroupCollapsed(key);
        if (!refreshLibraryResultsInPlace()) render();
      }
      return true;
    }

    case "open-sort-name-modal": {
      const appName = id || t.dataset.id || S.currentModalAppName || "";
      if (appName) openSortNameModal(appName);
      return true;
    }

    case "close-sort-name-backdrop":
      if (targetEl === t) closeSortNameModal();
      return true;

    case "close-sort-name-modal":
      closeSortNameModal();
      return true;

    case "save-sort-name-modal":
      saveSortNameModal();
      return true;

    case "reset-sort-name-modal":
      resetSortNameModal();
      return true;

    default:
      return false;
  }
}

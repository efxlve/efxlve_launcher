/**
 * Optional library display preferences: cover captions and page-by-page browsing.
 *
 * Both are opt-in from Settings so the default quiet cover wall stays untouched.
 * Pagination caps how many cards exist in the DOM at once; when it is off the
 * library keeps its progressive chunk rendering.
 */

import { COVER_TITLES_KEY, LIB_PAGE_SIZE_KEY, LIB_PAGINATION_KEY, normalizeLibraryPageSize } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { render } from "../../core/render";
import { S } from "../../core/state";

/** Persist the "title under cover" preference. */
export function setCoverTitlesEnabled(on: boolean): void {
  S.showCoverTitles = on;
  localStorage.setItem(COVER_TITLES_KEY, String(on));
}

/** Toggle pagination. The page always restarts at 1 when the mode changes. */
export function setLibraryPaginationEnabled(on: boolean): void {
  S.libPagination = on;
  S.libPage = 1;
  localStorage.setItem(LIB_PAGINATION_KEY, String(on));
}

/** Persist the page size and return to the first page. */
export function setLibraryPageSize(size: number): void {
  S.libPageSize = normalizeLibraryPageSize(size);
  S.libPage = 1;
  localStorage.setItem(LIB_PAGE_SIZE_KEY, String(S.libPageSize));
}

/**
 * Jump to a page. The target is clamped by the renderer against the current
 * result set, so an out-of-range value can never render an empty page.
 */
export function goToLibraryPage(page: number): void {
  const next = Math.max(1, Math.floor(page));
  if (next === S.libPage) return;
  S.libPage = next;
  viewEl.scrollTop = 0;
  render();
}

/** Move one page forward/backward (rounded by the renderer at the bounds). */
export function stepLibraryPage(delta: number): void {
  goToLibraryPage(S.libPage + delta);
}

/**
 * Click delegation for the new library controls. Returns true when the action
 * was handled so the caller can stop routing it.
 */
export function handleLibraryOptionAction(act: string | undefined, el: HTMLElement): boolean {
  switch (act) {
    case "toggle-cover-titles":
      setCoverTitlesEnabled(!S.showCoverTitles);
      render();
      return true;
    case "toggle-lib-pagination":
      setLibraryPaginationEnabled(!S.libPagination);
      render();
      return true;
    case "lib-page": {
      const page = Number(el.dataset.page);
      if (page > 0) goToLibraryPage(page);
      return true;
    }
    case "lib-page-prev":
      stepLibraryPage(-1);
      return true;
    case "lib-page-next":
      stepLibraryPage(1);
      return true;
    default:
      return false;
  }
}

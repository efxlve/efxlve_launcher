/**
 * Click actions for the "Fix metadata" dialog: opening it from the game page's
 * More menu, searching either service, and picking or resetting an entry.
 */

import {
  closeMatchModal,
  matchModalOpen,
  openMatchModal,
  restoreAutomaticHltb,
  restoreAutomaticIgdb,
  searchHltbFromDialog,
  searchIgdbFromDialog,
  useHltbHit,
  useIgdbHit,
} from "../../drawer/match-view";

export function handleMatchAction(
  act: string | undefined,
  el: HTMLElement,
  id?: string,
  targetEl?: HTMLElement,
): boolean {
  if (!act) return false;

  switch (act) {
    case "open-match-modal":
      if (id) openMatchModal(id);
      return true;

    case "close-match-modal":
      closeMatchModal();
      return true;

    case "match-backdrop":
      if (targetEl === el) closeMatchModal();
      return true;

    case "match-igdb-search":
      searchIgdbFromDialog();
      return true;

    case "match-hltb-search":
      searchHltbFromDialog();
      return true;

    case "match-igdb-use": {
      const hit = Number(el.dataset.game);
      if (matchModalOpen() && Number.isFinite(hit) && hit > 0) void useIgdbHit(hit);
      return true;
    }

    case "match-hltb-use": {
      const index = Number(el.dataset.hit);
      if (matchModalOpen() && Number.isFinite(index)) void useHltbHit(index);
      return true;
    }

    case "match-igdb-auto":
      void restoreAutomaticIgdb();
      return true;

    case "match-hltb-auto":
      void restoreAutomaticHltb();
      return true;

    default:
      return false;
  }
}

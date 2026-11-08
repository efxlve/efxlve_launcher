/**
 * Controller-to-command mapping for Stage. The polling loop stays in
 * `gamepad.ts`; this file only decides what a face button means on the current
 * Stage screen, so the two modules never depend on each other.
 */

import { S } from "../../core/state";
import {
  stageBack,
  stageCycleSection,
  stageCycleStore,
  stageCycleTab,
  stageOpenSearch,
  stageQuickPlay,
  stageToggleFavorite,
  stageToggleQuickMenu,
  stageToggleView,
} from "./stage-actions";

export type StagePadButton = "x" | "y" | "lb" | "rb" | "lt" | "rt" | "start" | "select";

export function stageIsActive(): boolean {
  return S.stage.active;
}

/** Handle one non-directional pad button while Stage is active. */
export function stageButton(button: StagePadButton): void {
  if (!S.stage.active) return;
  // A dialog owns the pad while it is open. A/B reach its focus ring through
  // the generic path; the contextual buttons must not fire behind it.
  if (document.querySelector(".modal:not(.hidden), .selective-overlay, .confirm-dialog:not(.hidden), .palette-backdrop, #modal-root > div, #install-root > div")) {
    return;
  }
  const overlay = S.stage.quickMenu || S.stage.searchOpen || S.stage.controlsOpen;
  if (overlay && button !== "start" && button !== "select") return;
  if (S.stage.route === "downloads" && (button === "x" || button === "y" || button === "lt" || button === "rt")) return;

  switch (button) {
    case "start":
      stageToggleQuickMenu();
      return;
    case "select":
      if (S.stage.searchOpen) stageBack();
      else stageOpenSearch();
      return;
    case "x":
      stageQuickPlay();
      return;
    case "y":
      if (S.stage.route === "library") stageToggleView();
      else if (S.stage.route === "program") stageToggleFavorite(S.stage.gameKey ?? undefined);
      else stageToggleFavorite();
      return;
    case "lb":
      if (S.stage.route === "program") stageCycleTab(false);
      else stageCycleSection(false);
      return;
    case "rb":
      if (S.stage.route === "program") stageCycleTab(true);
      else stageCycleSection(true);
      return;
    case "lt":
      stageCycleStore(false);
      return;
    case "rt":
      stageCycleStore(true);
      return;
  }
}

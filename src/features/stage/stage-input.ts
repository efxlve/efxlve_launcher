import { stageFeedback } from "./stage-sound";
let lastBumpTime = 0;
export function stageEdgeBump(dir: "up" | "down" | "left" | "right"): void {
  const now = performance.now();
  if (now - lastBumpTime < 180) return;
  lastBumpTime = now;
  stageFeedback("bump");
  const focused = document.querySelector<HTMLElement>(".stage-focused, .gp-focused");
  if (focused) {
    focused.classList.remove("stage-bump-up", "stage-bump-down", "stage-bump-left", "stage-bump-right");
    void focused.offsetWidth;
    focused.classList.add(`stage-bump-${dir}`);
  }
}
/**
 * Controller-to-command mapping for Stage. The polling loop stays in
 * `gamepad.ts`; this file only decides what a face button means on the current
 * Stage screen, so the two modules never depend on each other.
 */

import { S } from "../../core/state";
import { registerStageBridge, type StagePadButton } from "../gamepad/stage-bridge";
import { wakeStageIdle } from "./stage-idle";
import { skipStageIntro } from "./stage-intro";
import {
  stageBack,
  stageCloseControls,
  stageCloseStill,
  stageCycleSection,
  stageStillStep,
  stageCycleStore,
  stageCycleTab,
  stageGo,
  stageOpenSearch,
  stageSearchKey,
  stageSearchSubmit,
  stageQuickPlay,
  stageToggleFavorite,
  stageToggleQuickMenu,
  stageToggleView,
} from "./stage-actions";

/** Handle one non-directional pad button while Stage is active. */
export function stageButton(button: StagePadButton): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("stage-input-mode", { detail: { mode: "gamepad" } }));
  }
  if (!S.stage.active) return;
  if (S.stage.intro) {
    // The boot mark consumes the first press; it never doubles as an action.
    skipStageIntro();
    return;
  }
  if (S.stage.idle) {
    // The first button only wakes the room, exactly like a sleeping console.
    wakeStageIdle();
    return;
  }
  // A dialog owns the pad while it is open. A/B reach its focus ring through
  // the generic path; the contextual buttons must not fire behind it.
  if (document.querySelector(".modal:not(.hidden), .selective-overlay, .confirm-dialog:not(.hidden), .palette-backdrop, #modal-root > div, #install-root > div")) {
    return;
  }
  if (S.stage.stillIndex !== null) {
    if (button === "start" || button === "select") stageCloseStill();
    if (button === "lb" || button === "lt") stageStillStep(false);
    if (button === "rb" || button === "rt") stageStillStep(true);
    return;
  }
  if (S.stage.controlsOpen) {
    // A standalone sheet from Settings closes with the same buttons that
    // opened it; the quick-menu toggle must not run behind it.
    if (button === "start" || button === "select") stageCloseControls();
    return;
  }
  if (S.stage.searchOpen) {
    if (button === "select") { stageBack(); return; }
    if (button === "x") { stageSearchKey("backspace"); return; }
    if (button === "y") { stageSearchKey("space"); return; }
    if (button === "start") { stageSearchSubmit(); return; }
    return;
  }
  if (S.stage.powerOpen || S.stage.browserOpen || S.stage.spotifyOpen || S.stage.discordOpen) {
    if (button === "start" || button === "select") {
      stageBack();
      return;
    }
  }
  if (S.stage.quickMenu && button !== "start" && button !== "select") return;
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

// The Stage chunk registers its input contract with the always-loaded polling
// loop; the loop never imports this file directly.
registerStageBridge({
  button: stageButton,
  back: stageBack,
  go: (view) => stageGo(view),
  bump: (dir) => stageEdgeBump(dir),
  wake: () => {
    if (S.stage.idle) {
      wakeStageIdle();
      return true;
    }
    if (S.stage.intro) {
      skipStageIntro();
      return true;
    }
    return false;
  },
});

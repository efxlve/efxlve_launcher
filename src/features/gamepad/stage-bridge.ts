/**
 * The one link between the always-loaded gamepad loop and the lazy Stage
 * chunk. The desktop bundle must not parse the Stage screens just because a
 * controller is plugged in; the Stage chunk registers these callbacks when it
 * loads, and the polling loop calls them only while `S.stage.active`.
 */

export type StagePadButton = "x" | "y" | "lb" | "rb" | "lt" | "rt" | "start" | "select";

export interface StageBridge {
  button(button: StagePadButton): void;
  back(): void;
  go(view: "downloads" | "library"): void;
  bump?(dir: "up" | "down" | "left" | "right"): void;
  /** Left/right on the focused Library collection tool. */
  cycleCollection?(dir: "next" | "prev"): void;
  /**
   * Wake attract mode (or dismiss the boot mark). Returns true when the press
   * belongs to the wake-up and must not activate the focused control.
   */
  wake?(): boolean;
}

let bridge: StageBridge | null = null;

export function registerStageBridge(next: StageBridge | null): void {
  bridge = next;
}

export function stageBridge(): StageBridge | null {
  return bridge;
}

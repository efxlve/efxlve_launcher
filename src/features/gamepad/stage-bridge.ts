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
}

let bridge: StageBridge | null = null;

export function registerStageBridge(next: StageBridge | null): void {
  bridge = next;
}

export function stageBridge(): StageBridge | null {
  return bridge;
}

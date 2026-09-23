/**
 * Render bus.
 *
 * `main.ts` owns the single `render()` / `scheduleRender()` implementation and
 * registers it here at startup. Feature modules import these functions to
 * request a re-render without importing `main.ts` (which would create a cycle).
 */

import type { NotifKind } from "./types";

let renderImpl: () => void = () => {};
let scheduleImpl: () => void = () => {};
let gamepadHudImpl: (active?: boolean) => void = () => {};

/** Called once by main.ts to wire the real render functions. */
export function registerRender(render: () => void, scheduleRender: () => void): void {
  renderImpl = render;
  scheduleImpl = scheduleRender;
}

/** Called once by main.ts to wire the gamepad HUD updater. */
export function registerGamepadHud(fn: (active?: boolean) => void): void {
  gamepadHudImpl = fn;
}

/** Refresh the gamepad HUD bar (no-op until registered). */
export function updateGamepadHud(active?: boolean): void {
  gamepadHudImpl(active);
}

let openEpicModalImpl: (appName: string, isInitialOpen?: boolean, animateTabContent?: boolean) => void =
  () => {};

/** Called once by main.ts to wire the game detail drawer opener. */
export function registerOpenEpicModal(
  fn: (appName: string, isInitialOpen?: boolean, animateTabContent?: boolean) => void,
): void {
  openEpicModalImpl = fn;
}

let navHistoryPushImpl: ((item: { view: any; appName?: string | null }) => void) | null = null;

/** Wire the navigation history tracker into the render bus. */
export function registerNavHistoryPush(fn: (item: { view: any; appName?: string | null }) => void): void {
  navHistoryPushImpl = fn;
}

/** Push a view or item into navigation history if registered. */
export function recordNavHistory(item: { view: any; appName?: string | null }): void {
  navHistoryPushImpl?.(item);
}

/** Open (or refresh) the game detail drawer. No-op until registered. */
export function openEpicModal(appName: string, isInitialOpen = true, animateTabContent = true): void {
  if (isInitialOpen) {
    navHistoryPushImpl?.({ view: "library", appName });
  }
  openEpicModalImpl(appName, isInitialOpen, animateTabContent);
}

let presenceSyncImpl: () => void = () => {};

/** Called once by main.ts to wire the Discord presence sync. */
export function registerPresenceSync(fn: () => void): void {
  presenceSyncImpl = fn;
}

/** Refresh the Discord presence from the current view/game. No-op until registered. */
export function presenceSync(): void {
  presenceSyncImpl();
}

let notifyImpl: (input: { kind: NotifKind; title: string; body?: string; appName?: string }) => void =
  () => {};

/** Called once by main.ts to wire the notification center (feature module). */
export function registerNotify(
  fn: (input: { kind: NotifKind; title: string; body?: string; appName?: string }) => void,
): void {
  notifyImpl = fn;
}

/** Push an in-app notification. No-op until registered. */
export function notify(input: { kind: NotifKind; title: string; body?: string; appName?: string }): void {
  notifyImpl(input);
}

let closeAllModalsImpl: () => void = () => {};

/** Called once by main.ts to wire the "close every modal" routine. */
export function registerCloseAllModals(fn: () => void): void {
  closeAllModalsImpl = fn;
}

/** Close every open modal/drawer. No-op until registered. */
export function closeAllModals(): void {
  closeAllModalsImpl();
}

/** Request a synchronous full re-render of the active view. */
export function render(): void {
  renderImpl();
}

/** Request a batched re-render on the next animation frame. */
export function scheduleRender(): void {
  scheduleImpl();
}

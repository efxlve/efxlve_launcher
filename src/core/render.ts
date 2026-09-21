/**
 * Render bus.
 *
 * `main.ts` owns the single `render()` / `scheduleRender()` implementation and
 * registers it here at startup. Feature modules import these functions to
 * request a re-render without importing `main.ts` (which would create a cycle).
 */

let renderImpl: () => void = () => {};
let scheduleImpl: () => void = () => {};

/** Called once by main.ts to wire the real render functions. */
export function registerRender(render: () => void, scheduleRender: () => void): void {
  renderImpl = render;
  scheduleImpl = scheduleRender;
}

/** Request a synchronous full re-render of the active view. */
export function render(): void {
  renderImpl();
}

/** Request a batched re-render on the next animation frame. */
export function scheduleRender(): void {
  scheduleImpl();
}

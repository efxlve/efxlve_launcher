/**
 * Bounds for native child webviews (the storefronts, Spotify, Discord).
 *
 * The interface scale is a WebView2 zoom on the main webview, so its DOM
 * rectangles are CSS pixels while a child webview is placed in window-logical
 * pixels. Handing a raw rectangle to Rust leaves the child short by the zoom
 * factor: a gap at the right and bottom, and the left edge over the sidebar.
 */

import { isTauri } from "./constants";
import { S } from "./state";

export interface ChildRect {
  x: number;
  y: number;
  width: number;
  height: number;
  bottom?: number;
}

/** CSS pixels -> window-logical pixels for a child webview. */
export function childScale(): number {
  if (!isTauri) return 1;
  const scale = S.uiScale / 100;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** The same rectangle, expressed in the units a child webview expects. */
export function childBounds<T extends ChildRect>(rect: T): T {
  const scale = childScale();
  if (scale === 1) return rect;
  return {
    ...rect,
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
    ...(rect.bottom === undefined ? {} : { bottom: rect.bottom * scale }),
  };
}

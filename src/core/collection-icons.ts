/**
 * Collection marker icon set.
 *
 * Collections can carry a small marker. The project forbids raw OS emojis in
 * the UI (AGENTS.md zero-emoji policy), so markers are chosen from a curated
 * set of inline SVG icons instead. The stored value is the icon name; unknown
 * or legacy values fall back to the folder icon.
 */

import { icon, type IconName } from "./icons";

/** Curated icon names available as collection markers. */
export const COLLECTION_ICONS: IconName[] = [
  "folder",
  "trophy",
  "star",
  "heart",
  "zap",
  "rocket",
  "gamepad-2",
  "crown",
  "shield",
  "clock",
  "cloud",
  "image",
  "layers",
  "package",
  "check-circle",
  "list",
  "layout-grid",
  "globe",
  "monitor",
  "cpu",
  "users",
  "link",
  "terminal",
  "sparkles",
];

/** True when the stored value is one of the curated collection icons. */
export function isCollectionIcon(value: string | null | undefined): value is IconName {
  return !!value && (COLLECTION_ICONS as string[]).includes(value);
}

/** Render a collection marker as an SVG icon (folder fallback). */
export function collectionMarker(value: string | null | undefined, size = 16): string {
  return icon(isCollectionIcon(value) ? value : "folder", size);
}

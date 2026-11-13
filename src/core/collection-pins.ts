/**
 * Collections pinned as their own tabs in the library filter strip.
 *
 * The gallery keeps one pin per collection; the strip renders them in pin
 * order. A pinned id whose collection was deleted or merged away is skipped, so
 * the tab strip never points at a collection that no longer exists.
 */

import { PINNED_COLLECTIONS_KEY, saveStrSet } from "./constants";
import type { GameCollection } from "../epic-model";
import { S } from "./state";

/** More pinned tabs than this crowd the filter strip on narrow windows. */
export const MAX_PINNED_COLLECTIONS = 3;

/** Why a pin toggle stopped: the caller shows the matching feedback. */
export type PinToggleResult = "pinned" | "unpinned" | "limit";

export function isCollectionPinned(id: string): boolean {
  return S.pinnedCollections.has(id);
}

/** Flip one collection's pin and persist it. A full strip refuses new pins. */
export function toggleCollectionPin(id: string): PinToggleResult {
  if (S.pinnedCollections.has(id)) {
    S.pinnedCollections.delete(id);
    saveStrSet(PINNED_COLLECTIONS_KEY, S.pinnedCollections);
    return "unpinned";
  }
  if (pinnedCollectionsForTabs().length >= MAX_PINNED_COLLECTIONS) return "limit";
  S.pinnedCollections.add(id);
  saveStrSet(PINNED_COLLECTIONS_KEY, S.pinnedCollections);
  return "pinned";
}

/** Drop a pin when its collection is deleted or merged away. */
export function forgetCollectionPin(id: string): void {
  if (!S.pinnedCollections.delete(id)) return;
  saveStrSet(PINNED_COLLECTIONS_KEY, S.pinnedCollections);
}

/** Pinned collections in pin order, without ids that no longer resolve. */
export function pinnedCollectionsForTabs(): GameCollection[] {
  const byId = new Map(S.epicCollections.map((col) => [col.id, col]));
  return [...S.pinnedCollections].flatMap((id) => {
    const col = byId.get(id);
    return col ? [col] : [];
  });
}

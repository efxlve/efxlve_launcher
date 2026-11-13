/**
 * Collections pinned as their own tabs in the library filter strip.
 *
 * The gallery keeps one pin per collection; the strip renders them in pin
 * order and folds the ones that no longer fit under its chevron. A pinned id
 * whose collection was deleted or merged away is skipped, so the strip never
 * points at a collection that no longer exists.
 */

import { PINNED_COLLECTIONS_KEY, saveStrSet } from "./constants";
import type { GameCollection } from "../epic-model";
import { S } from "./state";

export function isCollectionPinned(id: string): boolean {
  return S.pinnedCollections.has(id);
}

/** Flip one collection's pin and persist it. Returns the new state. */
export function toggleCollectionPin(id: string): boolean {
  const pinned = S.pinnedCollections.has(id);
  if (pinned) S.pinnedCollections.delete(id);
  else S.pinnedCollections.add(id);
  saveStrSet(PINNED_COLLECTIONS_KEY, S.pinnedCollections);
  return !pinned;
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

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

export const MAX_PINNED_COLLECTIONS = 3;

export type PinToggleResult = "pinned" | "unpinned" | "limit_reached";

export function isCollectionPinned(id: string): boolean {
  return S.pinnedCollections.has(id);
}

/** Enforce the maximum pin limit on the stored set. */
export function pruneCollectionPins(): void {
  if (S.pinnedCollections.size > MAX_PINNED_COLLECTIONS) {
    S.pinnedCollections = new Set([...S.pinnedCollections].slice(0, MAX_PINNED_COLLECTIONS));
    saveStrSet(PINNED_COLLECTIONS_KEY, S.pinnedCollections);
  }
}

/** Flip one collection's pin and persist it. Returns "pinned", "unpinned", or "limit_reached". */
export function toggleCollectionPin(id: string): PinToggleResult {
  const pinned = S.pinnedCollections.has(id);
  if (pinned) {
    S.pinnedCollections.delete(id);
    saveStrSet(PINNED_COLLECTIONS_KEY, S.pinnedCollections);
    return "unpinned";
  }
  if (S.pinnedCollections.size >= MAX_PINNED_COLLECTIONS) {
    return "limit_reached";
  }
  S.pinnedCollections.add(id);
  saveStrSet(PINNED_COLLECTIONS_KEY, S.pinnedCollections);
  return "pinned";
}

/** Drop a pin when its collection is deleted or merged away. */
export function forgetCollectionPin(id: string): void {
  if (!S.pinnedCollections.delete(id)) return;
  saveStrSet(PINNED_COLLECTIONS_KEY, S.pinnedCollections);
}

/** Reorder pinned collections to a new sequence of ids and persist it. */
export function reorderPinnedCollections(ids: string[]): void {
  const newSet = new Set<string>();
  for (const id of ids) {
    if (S.pinnedCollections.has(id)) newSet.add(id);
    if (newSet.size >= MAX_PINNED_COLLECTIONS) break;
  }
  for (const id of S.pinnedCollections) {
    if (newSet.size >= MAX_PINNED_COLLECTIONS) break;
    if (!newSet.has(id)) newSet.add(id);
  }
  S.pinnedCollections = newSet;
  saveStrSet(PINNED_COLLECTIONS_KEY, S.pinnedCollections);
}

/** Move a pinned collection left (-1) or right (+1) in tab order. */
export function movePinnedCollection(id: string, delta: number): boolean {
  const list = [...S.pinnedCollections];
  const idx = list.indexOf(id);
  if (idx === -1) return false;
  const target = idx + delta;
  if (target < 0 || target >= list.length) return false;
  list.splice(idx, 1);
  list.splice(target, 0, id);
  reorderPinnedCollections(list);
  return true;
}

/** Pinned collections in pin order, without ids that no longer resolve. */
export function pinnedCollectionsForTabs(): GameCollection[] {
  pruneCollectionPins();
  const byId = new Map(S.epicCollections.map((col) => [col.id, col]));
  return [...S.pinnedCollections].slice(0, MAX_PINNED_COLLECTIONS).flatMap((id) => {
    const col = byId.get(id);
    return col ? [col] : [];
  });
}

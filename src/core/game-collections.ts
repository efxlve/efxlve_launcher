/**
 * Collection membership is per game, not per store copy.
 *
 * A title can be owned on several stores and each copy has its own key. The
 * stored collection may hold any of those keys (or an older one), so every
 * view asks these helpers instead of comparing one app name. Adding a game to a
 * collection stores every loaded key for the title; that way switching the
 * version on the game page cannot drop it out of the collection.
 */

import type { GameCollection } from "../epic-model";
import { canonicalGameTitle, storeKeysForTitle, summaryOf } from "./selectors";

/** Every loaded store key for the same game, including the key passed in. */
export function gameStoreKeys(appName: string, title?: string): string[] {
  const keys = new Set<string>([appName]);
  const name = title ?? summaryOf(appName)?.title ?? "";
  if (name) {
    for (const key of storeKeysForTitle(name)) keys.add(key);
  }
  return [...keys];
}

/**
 * One representative key per game in a collection. Counts, covers and random
 * picks use this so a title owned on three stores still counts once.
 *
 * The stored member is the copy the collection was built from, which is not
 * necessarily the copy the player installed later. Resolving the title's other
 * loaded copies keeps the collection's installed count in step with the library
 * card instead of reporting the stored copy's stale flag.
 */
export function collectionGames(col: GameCollection): string[] {
  const best = new Map<string, { key: string; installed: boolean }>();
  const order: string[] = [];
  for (const name of col.app_names) {
    const summary = summaryOf(name);
    const title = summary?.title;
    const canon = title ? canonicalGameTitle(title) : "";
    const id = canon || `key:${name.toLowerCase()}`;
    let key = name;
    let installed = Boolean(summary?.installed);
    if (!installed && title) {
      for (const copy of storeKeysForTitle(title)) {
        if (copy === name || !summaryOf(copy)?.installed) continue;
        key = copy;
        installed = true;
        break;
      }
    }
    const current = best.get(id);
    if (!current) {
      best.set(id, { key, installed });
      order.push(id);
    } else if (!current.installed && installed) {
      best.set(id, { key, installed });
    }
  }
  return order.map((id) => best.get(id)!.key);
}

/** Unique games in one collection, not store memberships. */
export function collectionGameCount(col: GameCollection): number {
  return collectionGames(col).length;
}

/** True when the collection contains this game through any store copy. */
export function collectionHasGame(col: GameCollection, appName: string, title?: string): boolean {
  const keys = new Set(gameStoreKeys(appName, title).map((key) => key.toLowerCase()));
  const canon = canonicalGameTitle(title ?? summaryOf(appName)?.title ?? "");
  for (const name of col.app_names) {
    if (keys.has(name.toLowerCase())) return true;
    if (!canon) continue;
    const other = summaryOf(name)?.title;
    if (other && canonicalGameTitle(other) === canon) return true;
  }
  return false;
}

/** Precomputed keys and titles for filtering a library against one collection. */
export interface CollectionMatch {
  keys: Set<string>;
  titles: Set<string>;
}

export function collectionMatch(col: GameCollection): CollectionMatch {
  const keys = new Set<string>();
  const titles = new Set<string>();
  for (const name of col.app_names) {
    keys.add(name.toLowerCase());
    const title = summaryOf(name)?.title;
    if (!title) continue;
    const canon = canonicalGameTitle(title);
    if (canon) titles.add(canon);
  }
  return { keys, titles };
}

/** True when a library card belongs to the collection through any store copy. */
export function matchCollectionGame(
  match: CollectionMatch,
  game: { appName: string; title: string },
): boolean {
  if (match.keys.has(game.appName.toLowerCase())) return true;
  const canon = canonicalGameTitle(game.title);
  if (canon && match.titles.has(canon)) return true;
  for (const key of storeKeysForTitle(game.title)) {
    if (match.keys.has(key.toLowerCase())) return true;
  }
  return false;
}

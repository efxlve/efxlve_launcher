/**
 * One GOG store-detail answer per game, for the whole session.
 *
 * `ensureOverviewData` asks for the details every time the page is opened (the
 * description, hero art and requirements all come from the same call). The
 * backend caches on disk, but the call still crossed the IPC boundary and
 * parsed the payload again on every visit. Keeping the answer here makes a
 * reopened page paint from memory, and a second request while the first is in
 * flight shares the same promise instead of starting another one.
 */

import { gogGetGameDetails, type GogGameDetails } from "../../gog";

const cache = new Map<string, GogGameDetails>();
const inFlight = new Map<string, Promise<GogGameDetails>>();

/** The details already fetched this session, or `undefined`. */
export function cachedGogDetails(gameId: string): GogGameDetails | undefined {
  return cache.get(gameId);
}

/** Loads the details once; concurrent callers share the same request. */
export function loadGogDetails(gameId: string, force = false): Promise<GogGameDetails> {
  if (!force) {
    const hit = cache.get(gameId);
    if (hit) return Promise.resolve(hit);
    const pending = inFlight.get(gameId);
    if (pending) return pending;
  }
  const request = gogGetGameDetails(gameId)
    .then((details) => {
      cache.set(gameId, details);
      return details;
    })
    .finally(() => {
      inFlight.delete(gameId);
    });
  inFlight.set(gameId, request);
  return request;
}

/** Drops the cached details (account switch or an explicit refresh). */
export function clearGogDetailsCache(gameId?: string): void {
  if (gameId) cache.delete(gameId);
  else cache.clear();
}

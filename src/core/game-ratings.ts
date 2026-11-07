/**
 * Library ratings: the best review score already stored for a game.
 *
 * The game page fetches OpenCritic, Metacritic and IGDB answers on demand and
 * writes them to disk. This module reads that cache once at boot, so the
 * library can sort and filter by rating without firing a network request for
 * every game. A page opened in this session contributes its live answer too.
 */

import { epicCachedCriticScores, type CriticData } from "../epic";
import { scheduleRender } from "./render";
import { S } from "./state";
import type { LibRatingBucket } from "./types";

/** Normalizes the mixed scales into 0–100 and keeps the best source. */
export function bestCriticScore(
  data: Pick<CriticData, "opencritic_score" | "metacritic_score" | "igdb_score">,
): number | null {
  const igdb = data.igdb_score;
  const normalized =
    typeof igdb === "number" && Number.isFinite(igdb) && igdb > 0
      ? Math.round(Math.min(100, Math.max(0, igdb <= 10 ? igdb * 10 : igdb)))
      : null;
  const scores = [data.opencritic_score, data.metacritic_score, normalized].filter(
    (score): score is number => typeof score === "number" && score > 0,
  );
  return scores.length > 0 ? Math.max(...scores) : null;
}

/** Best known score for one library key, live answer first. */
export function gameRatingOf(appName: string): number | null {
  const live = S.loadedCritic.get(appName);
  if (live) {
    const score = bestCriticScore(live);
    if (score !== null) return score;
  }
  return S.gameRatings.get(appName) ?? null;
}

/** Rating shelf of a score; `null` means no store has answered yet. */
export function ratingBucket(score: number | null): LibRatingBucket {
  if (score === null) return "unrated";
  if (score >= 90) return "90";
  if (score >= 80) return "80";
  if (score >= 70) return "70";
  if (score >= 60) return "60";
  if (score >= 50) return "50";
  return "under50";
}

let ratingsLoaded = false;

/**
 * Loads the disk cache once. A missing cache is not an error: the sort simply
 * leaves those games at the bottom until their page has been opened.
 */
export function ensureGameRatingsLoaded(): void {
  if (ratingsLoaded) return;
  ratingsLoaded = true;
  void epicCachedCriticScores()
    .then((rows) => {
      if (rows.length === 0) return;
      for (const row of rows) {
        if (row.app_name && Number.isFinite(row.score)) {
          S.gameRatings.set(row.app_name, Math.round(row.score));
        }
      }
      S.libraryDataRev++;
      scheduleRender();
    })
    .catch(() => {
      // A cache read failure only hides the rating sort's data; leave it loaded
      // for this session instead of hammering the same failing path.
    });
}

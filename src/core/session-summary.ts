/**
 * What the last session left behind, per game.
 *
 * The page could say how long the player has played in total, but not what
 * happened the last time they played — which is the thing that makes a library
 * page worth opening again. The launcher already sees the session start and end
 * (`game-status`), so the summary is recorded then and kept on disk: the card is
 * still there tomorrow, and it is the reason to come back to the page.
 *
 * One entry per game, the most recent session only. The store is deliberately
 * tiny: a length, a trophy count and a timestamp.
 */

import { isTauri } from "./constants";

const KEY = "efxlve-session-summary";

export interface SessionSummary {
  /** How long the session ran, in seconds. */
  seconds: number;
  /** Trophies unlocked during it (0 when the store cannot say). */
  unlocked: number;
  /** When it ended, epoch ms. */
  at: number;
}

type Stored = Record<string, SessionSummary>;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Stored;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Remembers what just happened. Merges, so the length and the trophies can be
 *  recorded by different calls (the length arrives with the stop event, the
 *  trophies once the store has answered). */
export function recordSessionSummary(appName: string, part: Partial<SessionSummary>): void {
  if (!isTauri || !appName) return;
  const all = readAll();
  const previous = all[appName];
  // A summary older than a day is history, not "the last session": start fresh.
  const base = previous && Date.now() - previous.at < 24 * 60 * 60 * 1000 ? previous : { seconds: 0, unlocked: 0, at: 0 };
  all[appName] = {
    seconds: part.seconds ?? base.seconds,
    unlocked: part.unlocked ?? base.unlocked,
    at: part.at ?? Date.now(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // A full storage quota is not worth breaking the page for.
  }
}

/** The last session for this game, or null when there is nothing worth showing. */
export function sessionSummaryFor(appName: string): SessionSummary | null {
  const entry = readAll()[appName];
  if (!entry || entry.at === 0) return null;
  // A session under a minute with no trophies is not a story.
  if (entry.seconds < 60 && entry.unlocked === 0) return null;
  return entry;
}

/** How long ago, in the unit that reads best; the caller turns it into words. */
export interface SessionWhen {
  unit: "minutes" | "hours" | "days";
  n: number;
}

export function sessionWhen(at: number): SessionWhen {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 60) return { unit: "minutes", n: minutes };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { unit: "hours", n: hours };
  return { unit: "days", n: Math.round(hours / 24) };
}

/**
 * Library title, custom sort-name and series ordering.
 *
 * The collator is numeric, so "Assassin's Creed 2" sorts before "… 10". Roman
 * numerals in titles are folded to Arabic ones before comparing, keeping "II"
 * beside "2" without turning pronouns ("Who Am I") or hyphenated marks
 * ("X-Wing") into numbers. Series mode groups titles by custom sort prefix,
 * IGDB franchise, or shared title prefix (including "… of the <Series>") and
 * orders entries inside each franchise by release year.
 */

import { cachedFranchiseOf, cachedReleaseYearOf } from "../../core/game-ratings";
import { storeKeysForTitle } from "../../core/selectors";
import { S } from "../../core/state";
import type { EpicSort } from "../../core/types";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { customSortNameOf, effectiveSortTitle } from "./sort-name";

/** The sort menu, in the order it is shown. */
export function getSortOptions(): { id: EpicSort; label: string }[] {
  return [
    { id: "alpha", label: t("lib.sortAlpha") },
    { id: "series", label: t("lib.sortSeries") },
    { id: "genre", label: t("lib.groupGenre") },
    { id: "yearNew", label: t("lib.sortYearNew") },
    { id: "yearOld", label: t("lib.sortYearOld") },
    { id: "rating", label: t("lib.sortRating") },
    { id: "recent", label: t("lib.sortRecent") },
    { id: "played", label: t("lib.sortPlayed") },
    { id: "achievements", label: t("lib.sortAchievements") },
    { id: "installed", label: t("lib.sortInstalled") },
    { id: "alphaDesc", label: t("lib.sortAlphaDesc") },
  ];
}

let cachedCollatorLang = "";
let cachedCollator: Intl.Collator | null = null;

/** Collator for the current app language; cached until the language changes. */
export function libraryCollator(): Intl.Collator {
  const lang = S.appLanguage || "en";
  if (cachedCollator && cachedCollatorLang === lang) return cachedCollator;
  try {
    cachedCollator = new Intl.Collator(lang, { sensitivity: "base", numeric: true });
  } catch {
    cachedCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  }
  cachedCollatorLang = lang;
  S.trCollator = cachedCollator;
  return cachedCollator;
}

/** Best known PC/original release year across IGDB, store metadata and merged copies. */
export function effectiveReleaseYear(s: EpicSummary): number | null {
  const igdbOrDetailsYear = cachedReleaseYearOf(s.appName, s.title);
  if (igdbOrDetailsYear !== null) return igdbOrDetailsYear;
  if (typeof s.releaseYear === "number" && s.releaseYear >= 1970 && s.releaseYear <= 2100) {
    // Prefer non-Epic sibling store metadata (e.g. Steam appinfo.vdf) over Epic creationDate when merged.
    if (!S.separateCopies && !s.appName.includes("::")) {
      for (const key of storeKeysForTitle(s.title)) {
        if (key === s.appName) continue;
        const siblingYear = S.allGamesMap.get(key)?.releaseYear;
        if (typeof siblingYear === "number" && siblingYear >= 1970 && siblingYear <= 2100) {
          return siblingYear;
        }
      }
    }
    return s.releaseYear;
  }
  if (!S.separateCopies) {
    for (const key of storeKeysForTitle(s.title)) {
      const siblingYear = S.allGamesMap.get(key)?.releaseYear;
      if (typeof siblingYear === "number" && siblingYear >= 1970 && siblingYear <= 2100) {
        return siblingYear;
      }
    }
  }
  return null;
}

const ROMAN_TO_ARABIC: Record<string, string> = {
  XX: "20",
  XIX: "19",
  XVIII: "18",
  XVII: "17",
  XVI: "16",
  XV: "15",
  XIV: "14",
  XIII: "13",
  XII: "12",
  XI: "11",
  X: "10",
  IX: "9",
  VIII: "8",
  VII: "7",
  VI: "6",
  V: "5",
  IV: "4",
  III: "3",
  II: "2",
  I: "1",
};

const SERIES_MARKER_RE = /\b(?:part|episode|act|chapter|vol|volume|book|season)\s+$/i;
const PRONOUN_PREFIX_RE =
  /\b(?:am|was|were|if|as|than|and|or|nor|but|before|after|until|when|while|where|who|what|why|how)\s+$/i;

/** Title key: trademark marks out, standalone Roman numerals folded safely to Arabic ones. */
export function titleSortKey(title: string): string {
  const normalized = title.normalize("NFKC").replace(/[™®©]/g, "");
  return normalized
    .replace(
      /\b(XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)\b/g,
      (match, _roman: string, offset: number, full: string) => {
        if (offset === 0) return match;
        const before = full.slice(0, offset);
        const after = full.slice(offset + match.length);
        // Keep hyphenated tokens such as "X-Wing" or "V-Rally" intact.
        if (/^-[\p{L}]/u.test(after)) return match;
        if (match === "I") {
          if (SERIES_MARKER_RE.test(before)) return "1";
          if (/^\s*(?:[:\-–—(]|$)/.test(after) && !PRONOUN_PREFIX_RE.test(before)) return "1";
          return match;
        }
        return ROMAN_TO_ARABIC[match] ?? match;
      },
    )
    .replace(/\s+/g, " ")
    .trim();
}

const LEADING_ARTICLES = new Set(["the", "a", "an"]);
const SERIES_CONNECTORS = new Set(["of", "the", "and", "in", "to", "for", "on", "at", "from", "vs"]);

/** Lowercase words for the series heuristic, apostrophes joined so "Assassin's" stays one word. */
function seriesWords(title: string): string[] {
  const clean = titleSortKey(title)
    .toLocaleLowerCase(S.appLanguage || "en")
    .replace(/['’ʼ`]/g, "")
    .replace(/^(?:tom clancys|sid meiers)\s+/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!clean) return [];
  const raw = clean.split(/\s+/);
  while (raw.length > 1 && LEADING_ARTICLES.has(raw[0])) {
    raw.shift();
  }
  return raw;
}

/**
 * Franchise prefix: up to two substantive words (bridging connector prepositions
 * like "Call of Duty" or "God of War"), stopping before numeric sequel tokens.
 */
function seriesPrefix(title: string): string {
  const words = seriesWords(title);
  if (words.length === 0) return "";
  const out: string[] = [];
  let substantive = 0;
  for (const word of words) {
    if (out.length > 0 && /^\d+$/.test(word)) break;
    out.push(word);
    if (!SERIES_CONNECTORS.has(word)) {
      substantive++;
      if (substantive >= 2) break;
    }
  }
  while (out.length > 1 && SERIES_CONNECTORS.has(out[out.length - 1])) {
    out.pop();
  }
  return out.join(" ");
}

/** Extracts trailing "<X> of (the) <Series>" candidate ("Rise of the Tomb Raider" -> "tomb raider"). */
function trailingOfSeries(title: string): string {
  const words = seriesWords(title);
  if (words.length < 3) return "";
  for (let i = 1; i < words.length - 1; i++) {
    if (words[i] !== "of" && words[i] !== "from") continue;
    let start = i + 1;
    if (words[start] === "the" && start + 1 < words.length) start++;
    const tail = words.slice(start);
    if (tail.length === 0 || /^\d+$/.test(tail[0])) continue;
    const candidate = seriesPrefix(tail.join(" "));
    if (candidate && (tail.length >= 2 || candidate.length >= 6)) {
      return candidate;
    }
  }
  return "";
}

/** Every game keeps its full title unless it belongs to a multi-game franchise. */
export function seriesSortKeys(list: EpicSummary[]): Map<string, string> {
  const explicitPrefixes = new Map<string, string>();
  const counts = new Map<string, number>();

  for (const item of list) {
    const custom = customSortNameOf(item.appName, item.title);
    const franchise = !custom ? cachedFranchiseOf(item.appName, item.title) : "";
    const prefix = custom
      ? seriesPrefix(custom)
      : franchise
        ? seriesWords(franchise).join(" ")
        : seriesPrefix(item.title);
    explicitPrefixes.set(item.appName, prefix);
    if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

  // Second pass: let "Rise of the Tomb Raider" / "Shadow of the Tomb Raider"
  // join "tomb raider" when another game in the library already establishes it.
  for (const item of list) {
    if (customSortNameOf(item.appName, item.title)) continue;
    const cur = explicitPrefixes.get(item.appName) ?? "";
    if ((counts.get(cur) ?? 0) > 1) continue;
    const trailing = trailingOfSeries(item.title);
    if (trailing && (counts.get(trailing) ?? 0) >= 1 && trailing !== cur) {
      explicitPrefixes.set(item.appName, trailing);
      counts.set(trailing, (counts.get(trailing) ?? 0) + 1);
    }
  }

  const keys = new Map<string, string>();
  for (const item of list) {
    const prefix = explicitPrefixes.get(item.appName) ?? "";
    const full = seriesWords(effectiveSortTitle(item)).join(" ");
    keys.set(item.appName, prefix && (counts.get(prefix) ?? 0) > 1 ? prefix : full);
  }
  return keys;
}

/**
 * Title comparator with the sort key precomputed once per result set.
 * Respects custom per-game Sort Names (`effectiveSortTitle`) first.
 */
export function titleComparator(
  collator: Intl.Collator,
  list: EpicSummary[],
): (left: EpicSummary, right: EpicSummary) => number {
  const keys = new Map<string, string>();
  for (const item of list) keys.set(item.appName, titleSortKey(effectiveSortTitle(item)));
  return (left, right) => {
    const cmp = collator.compare(keys.get(left.appName) ?? "", keys.get(right.appName) ?? "");
    return cmp !== 0 ? cmp : collator.compare(left.title, right.title);
  };
}

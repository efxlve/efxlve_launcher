/**
 * Library title and series ordering.
 *
 * The collator is numeric, so "Assassin's Creed 2" sorts before "… 10". Roman
 * numerals in titles are folded to Arabic ones before comparing, which keeps
 * "II" beside "2" instead of under I. The series mode groups titles that share
 * a franchise prefix and orders each group by release year.
 */

import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { S } from "../../core/state";
import type { EpicSort } from "../../core/types";

/** The sort menu, in the order it is shown. */
export function getSortOptions(): { id: EpicSort; label: string }[] {
  return [
    { id: "alpha", label: t("lib.sortAlpha") },
    { id: "series", label: t("lib.sortSeries") },
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

/** Title key: trademark marks out, standalone Roman numerals as Arabic ones. */
export function titleSortKey(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[™®©]/g, "")
    .replace(
      /\b(XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)\b/g,
      (match, _roman: string, offset: number) => (offset === 0 ? match : ROMAN_TO_ARABIC[match] ?? match),
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase words for the series heuristic, punctuation folded to spaces. */
function seriesWords(title: string): string[] {
  const clean = titleSortKey(title)
    .toLocaleLowerCase(S.appLanguage || "en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return clean ? clean.split(/\s+/) : [];
}

/**
 * Franchise prefix: the first two words, but a number ends the prefix early so
 * "Anno 1404" and "Anno 1800" share "anno".
 */
function seriesPrefix(title: string): string {
  const words = seriesWords(title);
  if (words.length === 0) return "";
  const out: string[] = [];
  for (const word of words) {
    if (out.length > 0 && /^\d+$/.test(word)) break;
    out.push(word);
    if (out.length === 2) break;
  }
  return out.join(" ");
}

/** Every game keeps its full title unless at least one other game shares its prefix. */
export function seriesSortKeys(list: EpicSummary[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const item of list) {
    const prefix = seriesPrefix(item.title);
    if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const keys = new Map<string, string>();
  for (const item of list) {
    const prefix = seriesPrefix(item.title);
    keys.set(item.appName, prefix && (counts.get(prefix) ?? 0) > 1 ? prefix : seriesWords(item.title).join(" "));
  }
  return keys;
}

/**
 * Title comparator with the sort key precomputed once per result set. The key
 * runs two regular expressions, so recomputing it in every comparison would be
 * the expensive part of sorting a large library.
 */
export function titleComparator(
  collator: Intl.Collator,
  list: EpicSummary[],
): (left: EpicSummary, right: EpicSummary) => number {
  const keys = new Map<string, string>();
  for (const item of list) keys.set(item.appName, titleSortKey(item.title));
  return (left, right) =>
    collator.compare(keys.get(left.appName) ?? "", keys.get(right.appName) ?? "");
}

/**
 * Forgiving title matching for the command palette.
 *
 * A plain `includes()` misses the two things players type most: acronyms
 * ("gta", "rdr2") and different punctuation/spacing ("spiderman"). This module
 * also treats Roman numerals and digits as equal, so "gta 5" finds GTA V.
 */

const ROMAN: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10",
  xi: "11",
  xii: "12",
  xiii: "13",
  xiv: "14",
  xv: "15",
  xvi: "16",
  xvii: "17",
  xviii: "18",
  xix: "19",
  xx: "20",
};

export interface SearchText {
  /** Lowercase, accent-free words in their original form. */
  raw: string[];
  /** The same words with Roman numerals replaced by digits. */
  digits: string[];
  rawNorm: string;
  digitNorm: string;
  /** First letter of every word: "grand theft auto v" -> "gtav". */
  initial: string;
  /** Numerals keep all digits: "grand theft auto v" -> "gta5". */
  numeric: string;
}

/**
 * Common franchise clips. Expanding the title side means a hand-added
 * "GTA 6" still answers a search for "grand theft auto".
 */
const ALIASES: Record<string, string> = {
  gta: "grand theft auto",
  rdr: "red dead redemption",
  cod: "call of duty",
  nfs: "need for speed",
  ac: "assassins creed",
  re: "resident evil",
  ff: "final fantasy",
};

const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
const NUMERIC = /^\d+$/;

/** Own-property lookup: "constructor", "toString" and "__proto__" are titles too. */
function romanValue(word: string): string | undefined {
  return Object.hasOwn(ROMAN, word) ? ROMAN[word] : undefined;
}

function expandSearchWords(raw: string[]): string[] {
  if (raw.length === 0) return raw;
  const first = raw[0];
  for (const alias of ALIAS_KEYS) {
    if (!first.startsWith(alias)) continue;
    const rest = first.slice(alias.length);
    // "gta6", "rdr2", "gtav" expand; "code" and "account" do not.
    if (first !== alias && !NUMERIC.test(rest) && !Object.hasOwn(ROMAN, rest)) continue;
    return [...ALIASES[alias].split(" "), ...(rest ? [rest] : []), ...raw.slice(1)];
  }
  return raw;
}

function words(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function prepareSearchText(value: string): SearchText {
  const raw = expandSearchWords(words(value));
  const digits = raw.map((word) => romanValue(word) ?? word);
  return {
    raw,
    digits,
    rawNorm: raw.join(" "),
    digitNorm: digits.join(" "),
    initial: raw.map((word) => word[0]).join(""),
    numeric: raw.map((word) => romanValue(word) ?? word[0]).join(""),
  };
}

/**
 * 0 means no match; higher values sort first. The bands are intentional:
 * exact title, title prefix, phrase inside the title, acronym, word match,
 * then the no-space fallback.
 */
export function scorePreparedSearch(title: SearchText, query: SearchText): number {
  if (title.raw.length === 0 || query.raw.length === 0) return 0;

  if (title.rawNorm === query.rawNorm || title.digitNorm === query.digitNorm) return 6000;
  if (title.rawNorm.startsWith(query.rawNorm) || title.digitNorm.startsWith(query.digitNorm)) return 5000;
  if (title.rawNorm.includes(query.rawNorm) || title.digitNorm.includes(query.digitNorm)) return 4000;

  const compact = query.raw.join("");
  const digitCompact = query.digits.join("");
  if (compact.length >= 2) {
    if (title.initial.startsWith(compact) || title.numeric.startsWith(compact)) return 3500;
    if (digitCompact !== compact && (title.initial.startsWith(digitCompact) || title.numeric.startsWith(digitCompact))) {
      return 3400;
    }
  }

  // The reverse form: a short title ("GTA 6", "RDR2", "AC Valhalla") against
  // the full name. Alias-expanded titles usually hit the prefix band above;
  // this keeps the short form working even without an alias entry.
  const queryInitial = query.digits.filter((word) => !/^\d+$/.test(word)).map((word) => word[0]).join("");
  if (queryInitial.length >= 2) {
    const titleFirst = title.raw[0] ?? "";
    const rest = titleFirst.slice(queryInitial.length);
    const exact = titleFirst === queryInitial;
    const numbered = rest.length > 0 && (NUMERIC.test(rest) || Object.hasOwn(ROMAN, rest));
    if (exact || (queryInitial.length >= 3 && numbered)) return 3200;
    if (title.initial.startsWith(queryInitial)) {
      const initialRest = title.initial.slice(queryInitial.length);
      if (!initialRest || NUMERIC.test(initialRest) || Object.hasOwn(ROMAN, initialRest)) return 3100;
    }
  }

  let cursor = 0;
  let inOrder = true;
  for (const queryWord of query.digits) {
    let found = -1;
    for (let i = cursor; i < title.digits.length; i += 1) {
      const titleWord = title.digits[i];
      if (titleWord === queryWord || titleWord.startsWith(queryWord)) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      inOrder = false;
      break;
    }
    cursor = found + 1;
  }
  if (inOrder) return 3000;

  if (query.digits.every((queryWord) => title.digits.some((titleWord) => titleWord === queryWord || titleWord.startsWith(queryWord)))) {
    return 2000;
  }

  if (compact.length >= 3) {
    const titleCompact = title.raw.join("");
    const titleDigitCompact = title.digits.join("");
    if (titleCompact.includes(compact) || titleDigitCompact.includes(digitCompact)) return 1000;
  }

  return 0;
}

export function scoreSearchMatch(title: string, query: string): number {
  return scorePreparedSearch(prepareSearchText(title), prepareSearchText(query));
}

/**
 * Steam store details for the game page.
 *
 * The Steam store API answers one app per call and is rate limited, so the
 * Rust layer caches the payload on disk and this module only maps it to the
 * shapes the drawer already renders.
 */

import type { GameRequirementsResponse, SystemDetailItem } from "../../epic";
import type { SteamGameDetails } from "../../steam";

/** UI locale → Steam store language code. */
const STEAM_LANGUAGES: Record<string, string> = {
  ar: "arabic",
  de: "german",
  en: "english",
  es: "spanish",
  fr: "french",
  it: "italian",
  ja: "japanese",
  ko: "koreana",
  pl: "polish",
  "pt-BR": "portuguese",
  ru: "russian",
  th: "thai",
  tr: "turkish",
  "zh-Hans": "schinese",
  "zh-Hant": "tchinese",
};

/** Store language for the current UI language (English when unsupported). */
export function steamLanguage(locale: string): string {
  return STEAM_LANGUAGES[locale] || "english";
}

/**
 * Turns Steam's "Label: Value" requirement bullets into the specs rows the
 * drawer renders (minimum and recommended values per hardware label).
 */
export function buildSteamRequirements(
  appName: string,
  details: SteamGameDetails,
): GameRequirementsResponse {
  const items = new Map<string, SystemDetailItem>();
  const add = (lines: string[], key: "minimum" | "recommended") => {
    for (const line of lines) {
      const at = line.indexOf(":");
      if (at <= 0) continue;
      const label = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (!label || !value) continue;
      const item = items.get(label) ?? { title: label };
      item[key] = value;
      items.set(label, item);
    }
  };
  add(details.requirementsMin, "minimum");
  add(details.requirementsRec, "recommended");
  const rows = Array.from(items.values());
  return {
    supported: rows.length > 0,
    systems: [{ systemType: "Windows", details: rows }],
    languages: [],
    appName,
    description: details.description,
    shortDescription: details.shortDescription,
    tags: details.genres,
  };
}

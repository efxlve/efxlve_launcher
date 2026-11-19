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

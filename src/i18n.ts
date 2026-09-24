import trJson from "./locales/tr.json";
import enJson from "./locales/en.json";

type Dict = Record<string, string>;
const tr = trJson as Dict;
const en = enJson as Dict;

export interface LanguageMeta {
  code: string;
  label: string;
  dir: "ltr" | "rtl";
}

/** Languages officially supported by the Epic Games Store (16+). */
export const LANGUAGES: LanguageMeta[] = [
  { code: "tr", label: "Türkçe", dir: "ltr" },
  { code: "en", label: "English", dir: "ltr" },
  { code: "de", label: "Deutsch", dir: "ltr" },
  { code: "es", label: "Español", dir: "ltr" },
  { code: "fr", label: "Français", dir: "ltr" },
  { code: "it", label: "Italiano", dir: "ltr" },
  { code: "ja", label: "日本語", dir: "ltr" },
  { code: "ko", label: "한국어", dir: "ltr" },
  { code: "pl", label: "Polski", dir: "ltr" },
  { code: "pt-BR", label: "Português (Brasil)", dir: "ltr" },
  { code: "ru", label: "Русский", dir: "ltr" },
  { code: "zh-Hans", label: "简体中文", dir: "ltr" },
  { code: "zh-Hant", label: "繁體中文", dir: "ltr" },
  { code: "ar", label: "العربية", dir: "rtl" },
  { code: "th", label: "ไทย", dir: "ltr" },
];

const REGISTRY: Record<string, Dict> = { tr, en };

// Languages not bundled in the main chunk are lazy-loaded on demand.
const LOADERS: Record<string, () => Promise<{ default: Dict }>> = {
  de: () => import("./locales/de.json"),
  es: () => import("./locales/es.json"),
  fr: () => import("./locales/fr.json"),
  it: () => import("./locales/it.json"),
  ja: () => import("./locales/ja.json"),
  ko: () => import("./locales/ko.json"),
  pl: () => import("./locales/pl.json"),
  "pt-BR": () => import("./locales/pt-BR.json"),
  ru: () => import("./locales/ru.json"),
  "zh-Hans": () => import("./locales/zh-Hans.json"),
  "zh-Hant": () => import("./locales/zh-Hant.json"),
  ar: () => import("./locales/ar.json"),
  th: () => import("./locales/th.json"),
};

let current: Dict = tr;
let currentLang = "tr";

export function currentLanguage(): string {
  return currentLang;
}

/**
 * Translation helper. Missing-key fallback order: selected language → English → Turkish → key.
 * `{name}` placeholders are replaced from `vars`.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = current[key] ?? en[key] ?? tr[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/**
 * Localizes a message coming from the Rust backend.
 *
 * Backend messages are either a plain developer string or a translation
 * descriptor of the form `@t:<key>` / `@t:<key>\u001f<arg1>\u001f<arg2>...`
 * where positional args map to `{a1}`, `{a2}`, ... placeholders. Anything that
 * does not start with `@t:` is returned unchanged.
 */
export function localizeMessage(raw: string): string {
  if (!raw || !raw.startsWith("@t:")) return raw;
  const parts = raw.slice(3).split("\u001f");
  const key = parts[0];
  const vars: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) vars[`a${i}`] = parts[i];
  return t(key, vars);
}

function applyDir(lang: string): void {
  const meta = LANGUAGES.find((l) => l.code === lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = meta?.dir ?? "ltr";
}

/** Translates `data-i18n` / `data-i18n-title` elements in the static HTML. */
export function applyStaticTranslations(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key);
  });
  document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.placeholder = t(key);
  });
}

/** Loads a language, applies its direction and refreshes static translations. */
export async function setLanguage(lang: string): Promise<void> {
  currentLang = lang;
  if (REGISTRY[lang]) {
    current = REGISTRY[lang];
  } else if (LOADERS[lang]) {
    try {
      const mod = await LOADERS[lang]();
      if (mod?.default) {
        REGISTRY[lang] = mod.default;
        current = mod.default;
      }
    } catch {
      current = en;
    }
  } else {
    current = en;
  }
  applyDir(lang);
  applyStaticTranslations();
}

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

/** Epic Games Store'un resmi olarak desteklediği diller (16+). */
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

// İlk yüklemede ana pakete dahil edilmeyen diller dinamik olarak içe aktarılır.
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
 * Çeviri yardımcısı. Eksik anahtar sırasıyla: seçili dil → İngilizce → Türkçe → anahtar.
 * `{isim}` yer tutucuları `vars` ile değiştirilir.
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

function applyDir(lang: string): void {
  const meta = LANGUAGES.find((l) => l.code === lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = meta?.dir ?? "ltr";
}

/** Statik HTML üzerindeki `data-i18n` / `data-i18n-title` öğelerini çevirir. */
export function applyStaticTranslations(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key);
  });
}

/** Dili yükler, yönü uygular ve statik çevirileri tazeler. */
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

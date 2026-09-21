/**
 * Static constants and demo/mock catalog helpers.
 *
 * `isTauri` decides whether the UI talks to the Rust backend or falls back to
 * an in-browser mock catalog (useful for `vite dev` without Tauri).
 */

import { invoke } from "@tauri-apps/api/core";
import type { CatalogMeta, Game } from "./types";

/** True when running inside the Tauri shell. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** localStorage key for the demo "installed" set. */
export const MOCK_KEY = "efxlve-mock-installed";

/** Presentation metadata for the demo catalog. */
export const META: Record<string, CatalogMeta> = {
  "anadolu-efsaneleri": {
    description:
      "Anadolu mitolojisinden ilhamla açık dünya aksiyon RPG. Efsanevi yaratıklarla savaş, antik şehirleri keşfet.",
    gradient: "linear-gradient(135deg,#b33951,#5b2a86)",
    rating: 4.8,
  },
  "neon-surucu": {
    description:
      "Neon ışıklı sokaklarda yüksek hızlı arcade yarış. 40+ araç, çevrimiçi çok oyunculu mod.",
    gradient: "linear-gradient(135deg,#0abde3,#6c5ce7)",
    rating: 4.5,
  },
  "uzay-madencisi": {
    description:
      "Uzak gezegenlerde maden kaz, üssünü büyüt, galaksiler arası ticaret yap. Sakin bir uzay simülasyonu.",
    gradient: "linear-gradient(135deg,#1e3799,#0c2461)",
    rating: 4.2,
  },
  "kale-kusatmasi": {
    description:
      "Orta çağ kuşatma savaşlarında ordunu yönet. Sefer modu ve 4 kişiye kadar co-op.",
    gradient: "linear-gradient(135deg,#e17055,#6d2c1e)",
    rating: 4.7,
  },
  "piksel-ciftligi": {
    description:
      "Kendi piksel çiftliğini kur, hasat yap, kasabalılarla dost ol. Rahatlatıcı bağımsız yapım.",
    gradient: "linear-gradient(135deg,#00b894,#006266)",
    rating: 4.9,
  },
  "derin-dehlizler": {
    description:
      "Her seferinde değişen zindanlarda hayatta kal. Zorlu boss'lar, yüzlerce eşya kombinasyonu.",
    gradient: "linear-gradient(135deg,#2d3436,#6c5ce7)",
    rating: 4.4,
  },
};

/** Fallback metadata when a demo game has no entry. */
export const FALLBACK_META: CatalogMeta = {
  description: "Açıklama yakında eklenecek.",
  gradient: "linear-gradient(135deg,#2d3436,#636e72)",
  rating: 0,
};

/** Safe metadata lookup. */
export const metaOf = (id: string): CatalogMeta => META[id] ?? FALLBACK_META;

/** Read the demo installed set. */
export function mockInstalled(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(MOCK_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** Persist the demo installed set. */
export function saveMockInstalled(set: Set<string>): void {
  localStorage.setItem(MOCK_KEY, JSON.stringify([...set]));
}

/** Fake catalog used when running in a browser without Tauri. */
export function mockCatalog(): Game[] {
  const installed = mockInstalled();
  return [
    { id: "anadolu-efsaneleri", title: "Anadolu Efsaneleri", genre: "RPG", price: 0, sizeMb: 4200, version: "1.4.2", installed: installed.has("anadolu-efsaneleri") },
    { id: "neon-surucu", title: "Neon Sürücü", genre: "Yarış", price: 249, sizeMb: 8100, version: "2.0.1", installed: installed.has("neon-surucu") },
    { id: "uzay-madencisi", title: "Uzay Madencisi", genre: "Simülasyon", price: 149, sizeMb: 2300, version: "0.9.7", installed: installed.has("uzay-madencisi") },
    { id: "kale-kusatmasi", title: "Kale Kuşatması", genre: "Strateji", price: 399, sizeMb: 12500, version: "3.2.0", installed: installed.has("kale-kusatmasi") },
    { id: "piksel-ciftligi", title: "Piksel Çiftliği", genre: "Bağımsız", price: 99, sizeMb: 900, version: "1.1.0", installed: installed.has("piksel-ciftligi") },
    { id: "derin-dehlizler", title: "Derin Dehlizler", genre: "Roguelike", price: 0, sizeMb: 1600, version: "1.0.5", installed: installed.has("derin-dehlizler") },
  ];
}

/** Fetch the game list from Rust or the mock catalog. */
export async function fetchGames(): Promise<Game[]> {
  if (isTauri) return await invoke<Game[]>("list_games");
  await new Promise((r) => setTimeout(r, 200));
  return mockCatalog();
}

/* ------------------------------------------------------------------ */
/* localStorage keys and state hydration helpers.                      */
/* ------------------------------------------------------------------ */

/** Selected UI language. */
export const LANG_KEY = "efxlve-lang";
/** Demo platinum trophy set. */
export const DEMO_PLAT_KEY = "efxlve-demo-platinum";
/** Global screenshot hotkey (virtual key code). */
export const SS_HOTKEY_KEY = "efxlve-ss-hotkey";
/** Global screenshot hotkey display name. */
export const SS_HOTKEY_NAME_KEY = "efxlve-ss-hotkey-name";
/** Screenshot compression toggle. */
export const SS_COMPRESS_KEY = "efxlve-ss-compression";
/** Screenshot compression format (avif/webp/jpeg). */
export const SS_FORMAT_KEY = "efxlve-ss-format";
/** Screenshot compression quality. */
export const SS_QUALITY_KEY = "efxlve-ss-quality";
/** Custom portrait cover URLs keyed by app name. */
export const CUSTOM_COVERS_KEY = "efxlve-custom-covers";
/** Custom hero/landscape URLs keyed by app name. */
export const CUSTOM_HEROES_KEY = "efxlve-custom-heroes";
/** Favorited game ids. */
export const FAV_KEY = "efxlve-favorites";
/** Recently launched game ids. */
export const RECENT_KEY = "efxlve-recent";
/** Initial number of library cards rendered before progressive chunking kicks in. */
export const INITIAL_CARD_CHUNK = 48;
/** Number of extra library cards appended per scroll sentinel hit. */
export const MORE_CARD_CHUNK = 36;

/** Read a string set from localStorage. */
export function loadStrSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

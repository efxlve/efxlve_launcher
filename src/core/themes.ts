/**
 * Theme registry.
 *
 * One entry per theme. A theme that only recolours the shell carries its tokens
 * here and needs no CSS at all: the tokens are written to
 * `:root[data-surface="<id>"]` when the theme is applied. A theme that also
 * changes shapes, backgrounds or glass adds a `[data-surface="<id>"]` block in
 * `styles/themes.css` (White Mode and Frutiger Aero do).
 *
 * The settings picker, the stored choice and the boot path all read this list,
 * so adding a theme is one entry (plus `settings.surface<Name>` in the locales)
 * and no switch stays half-wired.
 */

import { SURFACE_KEY } from "./constants";

export interface ThemeDef {
  /** Stored in `localStorage` and used as the `data-surface` value. */
  id: string;
  /** Locale key for the picker label. */
  labelKey: string;
  /** Picker swatch: the shell background, as any CSS `background` value. */
  bg: string;
  /** Picker swatch border and the theme's accent colour. */
  accent: string;
  /** `color-scheme`, so native scrollbars and menus follow the theme. */
  scheme: "dark" | "light";
  /** Runtime token overrides; omit when `themes.css` owns the theme's block. */
  tokens?: Record<string, string>;
}

const DEFAULT_THEME = "black";
const TOKEN_STYLE_ID = "efxlve-theme-tokens";

/**
 * Midnight is the reference for a colour-only theme: it defines nothing but
 * tokens, so every component picks it up without a single extra CSS rule.
 */
const MIDNIGHT: ThemeDef = {
  id: "midnight",
  labelKey: "settings.surfaceMidnight",
  bg: "#070b14",
  accent: "#4cc2ff",
  scheme: "dark",
  tokens: {
    "--bg": "#070b14",
    "--surface-1": "#0c1220",
    "--surface-2": "#121a2b",
    "--surface-3": "#1a2438",
    "--line": "rgba(120, 170, 255, 0.1)",
    "--line-strong": "rgba(120, 170, 255, 0.2)",
    "--text": "#eef4ff",
    "--text-2": "#9fb0c9",
    "--text-3": "#5f7391",
    "--accent": "#4cc2ff",
    "--accent-hover": "#63cbff",
    "--accent-tint": "rgba(76, 194, 255, 0.14)",
    "--on-accent": "#04121d",
    "--ok": "#2fb36d",
    "--ok-hover": "#38c27a",
    "--ok-tint": "rgba(47, 179, 109, 0.14)",
    "--warn": "#e0a32e",
    "--warn-tint": "rgba(224, 163, 46, 0.14)",
    "--err": "#e5484d",
    "--err-tint": "rgba(229, 72, 77, 0.14)",
    "--shadow-pop": "0 12px 32px rgba(0, 0, 0, 0.55)",
  },
};

/**
 * The community asks are palettes too: a PlayStation grey, the Epic store with a
 * violet accent and Discord's own greys. All three are token-only.
 */
const PS5: ThemeDef = {
  id: "ps5",
  labelKey: "settings.surfacePs5",
  bg: "#eef0f3",
  accent: "#0070d1",
  scheme: "light",
  tokens: {
    "--bg": "#eef0f3",
    "--surface-1": "#ffffff",
    "--surface-2": "#e9ecf1",
    "--surface-3": "#dfe3ea",
    "--line": "rgba(15, 23, 42, 0.1)",
    "--line-strong": "rgba(15, 23, 42, 0.18)",
    "--text": "#101418",
    "--text-2": "#4b5563",
    "--text-3": "#767f8c",
    "--accent": "#0070d1",
    "--accent-hover": "#005fae",
    "--accent-tint": "rgba(0, 112, 209, 0.12)",
    "--on-accent": "#ffffff",
    "--ok": "#1a7f4b",
    "--ok-hover": "#15673d",
    "--ok-tint": "rgba(26, 127, 75, 0.12)",
    "--warn": "#a16207",
    "--warn-tint": "rgba(161, 98, 7, 0.12)",
    "--err": "#b91c1c",
    "--err-tint": "rgba(185, 28, 28, 0.1)",
    "--shadow-pop": "0 12px 32px rgba(15, 23, 42, 0.16)",
    "--scrollbar-thumb": "rgba(15, 23, 42, 0.24)",
    "--scrollbar-thumb-hover": "rgba(15, 23, 42, 0.4)",
  },
};

const EPIC: ThemeDef = {
  id: "epic",
  labelKey: "settings.surfaceEpic",
  bg: "#0a0a0c",
  accent: "#a259ff",
  scheme: "dark",
  tokens: {
    "--bg": "#0a0a0c",
    "--surface-1": "#111114",
    "--surface-2": "#18181d",
    "--surface-3": "#212128",
    "--line": "rgba(190, 160, 255, 0.09)",
    "--line-strong": "rgba(190, 160, 255, 0.2)",
    "--text": "#f6f2ff",
    "--text-2": "#a9a2b8",
    "--text-3": "#6d6680",
    "--accent": "#a259ff",
    "--accent-hover": "#b47bff",
    "--accent-tint": "rgba(162, 89, 255, 0.16)",
    "--on-accent": "#12061f",
    "--ok": "#2fb36d",
    "--ok-hover": "#38c27a",
    "--ok-tint": "rgba(47, 179, 109, 0.14)",
    "--warn": "#e0a32e",
    "--warn-tint": "rgba(224, 163, 46, 0.14)",
    "--err": "#e5484d",
    "--err-tint": "rgba(229, 72, 77, 0.14)",
    "--shadow-pop": "0 12px 32px rgba(0, 0, 0, 0.6)",
  },
};

const DISCORD: ThemeDef = {
  id: "discord",
  labelKey: "settings.surfaceDiscord",
  bg: "#1e1f22",
  accent: "#5865f2",
  scheme: "dark",
  tokens: {
    "--bg": "#1e1f22",
    "--surface-1": "#2b2d31",
    "--surface-2": "#313338",
    "--surface-3": "#383a40",
    "--line": "rgba(255, 255, 255, 0.06)",
    "--line-strong": "rgba(255, 255, 255, 0.13)",
    "--text": "#f2f3f5",
    "--text-2": "#b5bac1",
    "--text-3": "#949ba4",
    "--accent": "#5865f2",
    "--accent-hover": "#4752c4",
    "--accent-tint": "rgba(88, 101, 242, 0.16)",
    "--on-accent": "#ffffff",
    "--ok": "#23a55a",
    "--ok-hover": "#1e8f4e",
    "--ok-tint": "rgba(35, 165, 90, 0.14)",
    "--warn": "#f0b232",
    "--warn-tint": "rgba(240, 178, 50, 0.14)",
    "--err": "#f23f43",
    "--err-tint": "rgba(242, 63, 67, 0.14)",
    "--shadow-pop": "0 12px 32px rgba(0, 0, 0, 0.55)",
  },
};

export const THEMES: readonly ThemeDef[] = [
  {
    id: "black",
    labelKey: "settings.surfaceBlack",
    bg: "#000000",
    accent: "#ffffff",
    scheme: "dark",
  },
  {
    id: "soft",
    labelKey: "settings.surfaceSoft",
    bg: "#18181c",
    accent: "#ffffff",
    scheme: "dark",
  },
  EPIC,
  DISCORD,
  MIDNIGHT,
  {
    id: "white",
    labelKey: "settings.surfaceWhite",
    bg: "#ffffff",
    accent: "#111318",
    scheme: "light",
  },
  PS5,
  {
    id: "aero",
    labelKey: "settings.surfaceAero",
    bg: "linear-gradient(180deg, #1678cc 0%, #8fd6fa 58%, #d9f2ff 100%)",
    accent: "#2b8fef",
    scheme: "light",
  },
];

/** A stored id that no longer exists falls back to the default theme. */
export function normalizeSurface(id: string | null | undefined): string {
  return THEMES.some((theme) => theme.id === id) ? (id as string) : DEFAULT_THEME;
}

export function themeById(id: string): ThemeDef {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function readSurface(): string {
  try {
    return normalizeSurface(localStorage.getItem(SURFACE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

function tokenStyle(): HTMLStyleElement {
  const existing = document.getElementById(TOKEN_STYLE_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const style = document.createElement("style");
  style.id = TOKEN_STYLE_ID;
  document.head.appendChild(style);
  return style;
}

/**
 * Applies a theme and remembers it. Returns the id that was applied, so the
 * caller can store `S.surface` without a second lookup.
 */
export function applySurface(id: string, persist = true): string {
  const theme = themeById(normalizeSurface(id));
  const root = document.documentElement;
  // Black is the base palette in `tokens.css`: it needs no attribute.
  if (theme.id === DEFAULT_THEME) delete root.dataset.surface;
  else root.dataset.surface = theme.id;

  const body = Object.entries(theme.tokens ?? {})
    .map(([name, value]) => `${name}: ${value};`)
    .join("");
  tokenStyle().textContent = body ? `:root[data-surface="${theme.id}"]{${body}}` : "";
  root.style.colorScheme = theme.scheme;

  if (persist) {
    try {
      localStorage.setItem(SURFACE_KEY, theme.id);
    } catch {
      /* private mode: the theme still applies for this session */
    }
  }
  return theme.id;
}

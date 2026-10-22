/**
 * Theme registry.
 *
 * One entry per theme. A theme that only recolours the shell carries its tokens
 * here and needs no CSS at all: the tokens are written to
 * `:root[data-surface="<id>"]` when the theme is applied. A theme that also
 * changes shapes, backgrounds or glass adds a `[data-surface="<id>"]` block in
 * `styles/themes.css` (White Mode, Gloss and Blades do).
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
  /** Label of a user theme, shown instead of `labelKey`. */
  name?: string;
  /** Picker swatch: the shell background, as any CSS `background` value. */
  bg: string;
  /** Picker swatch border and the theme's accent colour. */
  accent: string;
  /** `color-scheme`, so native scrollbars and menus follow the theme. */
  scheme: "dark" | "light";
  /** Runtime token overrides; omit when `themes.css` owns the theme's block. */
  tokens?: Record<string, string>;
  /** True for a theme the user saved from Settings. */
  custom?: boolean;
}

/** What the Settings editor stores for one user theme. */
export interface CustomThemeInput {
  name: string;
  /** Shell background, `#rrggbb`. */
  bg: string;
  /** Accent, `#rrggbb`. */
  accent: string;
  light: boolean;
}

const DEFAULT_THEME = "black";
const TOKEN_STYLE_ID = "efxlve-theme-tokens";

/**
 * Neon Grid: acid yellow (#FCEE0A) on dark tech concrete, with a red warning
 * tone (#FF003C) and a cyan signal tone (#00F0FF).
 */
const NEON_GRID: ThemeDef = {
  id: "neongrid",
  labelKey: "settings.surfaceNeonGrid",
  bg: "linear-gradient(135deg, #07080a 0%, #14171d 55%, #fcee0a 100%)",
  accent: "#fcee0a",
  scheme: "dark",
  tokens: {
    "--bg": "#07080a",
    "--surface-1": "#0c0e12",
    "--surface-2": "#12151b",
    "--surface-3": "#191c24",
    "--line": "rgba(252, 238, 10, 0.2)",
    "--line-strong": "rgba(252, 238, 10, 0.45)",
    "--text": "#fefefe",
    "--text-2": "#a6acb8",
    "--text-3": "#616774",
    "--accent": "#fcee0a",
    "--accent-hover": "#ffffff",
    "--accent-tint": "rgba(252, 238, 10, 0.16)",
    "--on-accent": "#000000",
    "--ok": "#00f0ff",
    "--ok-hover": "#33f3ff",
    "--ok-tint": "rgba(0, 240, 255, 0.16)",
    "--warn": "#fcee0a",
    "--warn-tint": "rgba(252, 238, 10, 0.16)",
    "--err": "#ff003c",
    "--err-tint": "rgba(255, 0, 60, 0.18)",
    "--shadow-pop": "0 18px 44px rgba(0, 0, 0, 0.8)",
    "--scrollbar-thumb": "rgba(252, 238, 10, 0.22)",
    "--scrollbar-thumb-hover": "rgba(252, 238, 10, 0.42)",
  },
};


/**
 * Tokyo Night: the beloved developer palette of deep indigo-black and soft sky blue.
 */
const TOKYO_NIGHT: ThemeDef = {
  id: "tokyonight",
  labelKey: "settings.surfaceTokyoNight",
  bg: "linear-gradient(145deg, #16161e 0%, #1a1b26 50%, #13131a 100%)",
  accent: "#7aa2f7",
  scheme: "dark",
  tokens: {
    "--bg": "#16161e",
    "--surface-1": "#1a1b26",
    "--surface-2": "#212337",
    "--surface-3": "#2a2e48",
    "--line": "rgba(122, 162, 247, 0.11)",
    "--line-strong": "rgba(122, 162, 247, 0.22)",
    "--text": "#c0caf5",
    "--text-2": "#9aa5ce",
    "--text-3": "#565f89",
    "--accent": "#7aa2f7",
    "--accent-hover": "#8cb0f9",
    "--accent-tint": "rgba(122, 162, 247, 0.15)",
    "--on-accent": "#0d111d",
    "--ok": "#9ece6a",
    "--ok-hover": "#aed67d",
    "--ok-tint": "rgba(158, 206, 106, 0.14)",
    "--warn": "#e0af68",
    "--warn-tint": "rgba(224, 175, 104, 0.14)",
    "--err": "#f7768e",
    "--err-tint": "rgba(247, 118, 142, 0.14)",
    "--shadow-pop": "0 12px 32px rgba(6, 8, 14, 0.65)",
    "--scrollbar-thumb": "rgba(122, 162, 247, 0.18)",
    "--scrollbar-thumb-hover": "rgba(122, 162, 247, 0.32)",
  },
};

/**
 * Crimson: deep charcoal obsidian with fiery ruby crimson accents.
 */
const CRIMSON: ThemeDef = {
  id: "crimson",
  labelKey: "settings.surfaceCrimson",
  bg: "linear-gradient(140deg, #0e0a0d 0%, #201017 55%, #0b0709 100%)",
  accent: "#e11d48",
  scheme: "dark",
  tokens: {
    "--bg": "#0d0a0c",
    "--surface-1": "#151014",
    "--surface-2": "#1e171c",
    "--surface-3": "#291f27",
    "--line": "rgba(225, 29, 72, 0.12)",
    "--line-strong": "rgba(225, 29, 72, 0.24)",
    "--text": "#fdf2f4",
    "--text-2": "#cbb1b8",
    "--text-3": "#7e666e",
    "--accent": "#e11d48",
    "--accent-hover": "#f43f5e",
    "--accent-tint": "rgba(225, 29, 72, 0.16)",
    "--on-accent": "#ffffff",
    "--ok": "#2fb36d",
    "--ok-hover": "#38c27a",
    "--ok-tint": "rgba(47, 179, 109, 0.14)",
    "--warn": "#e0a32e",
    "--warn-tint": "rgba(224, 163, 46, 0.14)",
    "--err": "#e11d48",
    "--err-tint": "rgba(225, 29, 72, 0.18)",
    "--shadow-pop": "0 12px 32px rgba(0, 0, 0, 0.7)",
    "--scrollbar-thumb": "rgba(225, 29, 72, 0.18)",
    "--scrollbar-thumb-hover": "rgba(225, 29, 72, 0.3)",
  },
};

/**
 * Nord: clean Arctic slate with muted glacier cyan.
 */
const NORD: ThemeDef = {
  id: "nord",
  labelKey: "settings.surfaceNord",
  bg: "linear-gradient(150deg, #242933 0%, #2e3440 60%, #1f232b 100%)",
  accent: "#88c0d0",
  scheme: "dark",
  tokens: {
    "--bg": "#242933",
    "--surface-1": "#2e3440",
    "--surface-2": "#3b4252",
    "--surface-3": "#434c5e",
    "--line": "rgba(216, 222, 233, 0.08)",
    "--line-strong": "rgba(136, 192, 208, 0.2)",
    "--text": "#eceff4",
    "--text-2": "#d8dee9",
    "--text-3": "#7e889b",
    "--accent": "#88c0d0",
    "--accent-hover": "#8fbcbb",
    "--accent-tint": "rgba(136, 192, 208, 0.16)",
    "--on-accent": "#141920",
    "--ok": "#a3be8c",
    "--ok-hover": "#b4cf9d",
    "--ok-tint": "rgba(163, 190, 140, 0.15)",
    "--warn": "#ebcb8b",
    "--warn-tint": "rgba(235, 203, 139, 0.15)",
    "--err": "#bf616a",
    "--err-tint": "rgba(191, 97, 106, 0.16)",
    "--shadow-pop": "0 12px 32px rgba(10, 14, 20, 0.55)",
    "--scrollbar-thumb": "rgba(216, 222, 233, 0.16)",
    "--scrollbar-thumb-hover": "rgba(216, 222, 233, 0.28)",
  },
};

/**
 * Sunset Amber: warm obsidian dark with golden solar amber.
 */
const SUNSET: ThemeDef = {
  id: "sunset",
  labelKey: "settings.surfaceSunset",
  bg: "linear-gradient(140deg, #100d0a 0%, #26190f 55%, #0d0a08 100%)",
  accent: "#f59e0b",
  scheme: "dark",
  tokens: {
    "--bg": "#100d0a",
    "--surface-1": "#17130f",
    "--surface-2": "#231c15",
    "--surface-3": "#2f251c",
    "--line": "rgba(245, 158, 11, 0.11)",
    "--line-strong": "rgba(245, 158, 11, 0.22)",
    "--text": "#fffaf3",
    "--text-2": "#d6beab",
    "--text-3": "#8c7562",
    "--accent": "#f59e0b",
    "--accent-hover": "#fbbf24",
    "--accent-tint": "rgba(245, 158, 11, 0.16)",
    "--on-accent": "#1b0f00",
    "--ok": "#2fb36d",
    "--ok-hover": "#38c27a",
    "--ok-tint": "rgba(47, 179, 109, 0.14)",
    "--warn": "#f59e0b",
    "--warn-tint": "rgba(245, 158, 11, 0.16)",
    "--err": "#e5484d",
    "--err-tint": "rgba(229, 72, 77, 0.14)",
    "--shadow-pop": "0 12px 32px rgba(0, 0, 0, 0.65)",
    "--scrollbar-thumb": "rgba(245, 158, 11, 0.18)",
    "--scrollbar-thumb-hover": "rgba(245, 158, 11, 0.3)",
  },
};

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
    "--scrollbar-thumb": "rgba(120, 170, 255, 0.15)",
    "--scrollbar-thumb-hover": "rgba(120, 170, 255, 0.28)",
  },
};

/**
 * Two palettes that only need tokens: a violet dark and a chat-grey dark.
 * Blades and Gloss add scenes and glass of their own in `themes.css`.
 */
const VIOLET: ThemeDef = {
  id: "violet",
  labelKey: "settings.surfaceViolet",
  bg: "#0a0a0c",
  accent: "#7c3aed",
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
    "--accent": "#7c3aed",
    "--accent-hover": "#8b5cf6",
    "--accent-tint": "rgba(124, 58, 237, 0.2)",
    "--on-accent": "#ffffff",
    "--ok": "#2fb36d",
    "--ok-hover": "#38c27a",
    "--ok-tint": "rgba(47, 179, 109, 0.14)",
    "--warn": "#e0a32e",
    "--warn-tint": "rgba(224, 163, 46, 0.14)",
    "--err": "#e5484d",
    "--err-tint": "rgba(229, 72, 77, 0.14)",
    "--shadow-pop": "0 12px 32px rgba(0, 0, 0, 0.6)",
    "--scrollbar-thumb": "rgba(190, 160, 255, 0.15)",
    "--scrollbar-thumb-hover": "rgba(190, 160, 255, 0.28)",
  },
};

const BLURPLE: ThemeDef = {
  id: "blurple",
  labelKey: "settings.surfaceBlurple",
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
    "--scrollbar-thumb": "rgba(255, 255, 255, 0.14)",
    "--scrollbar-thumb-hover": "rgba(255, 255, 255, 0.24)",
  },
};

/** Built-in themes. User themes are appended by [`themes`]. */
const BUILTIN_THEMES: readonly ThemeDef[] = [
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
  NEON_GRID,
  TOKYO_NIGHT,
  CRIMSON,
  NORD,
  SUNSET,
  MIDNIGHT,
  VIOLET,
  BLURPLE,
  {
    id: "white",
    labelKey: "settings.surfaceWhite",
    bg: "#ffffff",
    accent: "#111318",
    scheme: "light",
  },
  {
    id: "blades",
    labelKey: "settings.surfaceBlades",
    bg: "linear-gradient(160deg, #06190b 0%, #1f5c18 45%, #76be2b 75%, #a8ea48 100%)",
    accent: "#9bd44a",
    scheme: "dark",
  },
  {
    id: "gloss",
    labelKey: "settings.surfaceGloss",
    bg: "linear-gradient(180deg, #1678cc 0%, #8fd6fa 58%, #d9f2ff 100%)",
    accent: "#2b8fef",
    scheme: "light",
  },
];

/** A stored id that no longer exists falls back to the default theme. */
/** Ids from before the neutral theme names; a stored choice keeps working. */
const LEGACY_SURFACE_IDS: Record<string, string> = {
  cyberpunk: "neongrid",
  xbox360: "blades",
  epic: "violet",
  discord: "blurple",
  aero: "gloss",
};

const CUSTOM_KEY = "efxlve-custom-themes";
const CUSTOM_PREFIX = "custom-";
const HEX = /^#[0-9a-f]{6}$/i;

function rgb(hex: string): [number, number, number] | null {
  if (!HEX.test(hex)) return null;
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hex(parts: [number, number, number]): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${parts.map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`;
}

/** `weight` 0 keeps `from`, 1 keeps `to`. */
function mix(from: string, to: string, weight: number): string {
  const a = rgb(from);
  const b = rgb(to);
  if (!a || !b) return from;
  return hex([
    a[0] + (b[0] - a[0]) * weight,
    a[1] + (b[1] - a[1]) * weight,
    a[2] + (b[2] - a[2]) * weight,
  ]);
}

const lighten = (color: string, amount: number) => mix(color, "#ffffff", amount);
const darken = (color: string, amount: number) => mix(color, "#000000", amount);

function rgba(color: string, alpha: number): string {
  const parts = rgb(color);
  if (!parts) return color;
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
}

/** Relative luminance, for picking readable text on the accent. */
function luminance(color: string): number {
  const parts = rgb(color);
  if (!parts) return 0;
  const [r, g, b] = parts.map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Turns two colours into the full token set. This is what makes a user theme
 * one form instead of twenty variables: the surfaces, text ramp, tints and
 * shadows are derived from the background and the accent.
 */
function customTokens(input: CustomThemeInput): Record<string, string> {
  const onAccent = luminance(input.accent) > 0.55 ? "#101318" : "#ffffff";
  if (input.light) {
    return {
      "--bg": input.bg,
      "--surface-1": "#ffffff",
      "--surface-2": darken(input.bg, 0.04),
      "--surface-3": darken(input.bg, 0.09),
      "--line": "rgba(15, 23, 42, 0.09)",
      "--line-strong": "rgba(15, 23, 42, 0.18)",
      "--text": "#101318",
      "--text-2": "#4b5563",
      "--text-3": "#7b8492",
      "--accent": input.accent,
      "--accent-hover": darken(input.accent, 0.1),
      "--accent-tint": rgba(input.accent, 0.12),
      "--on-accent": onAccent,
      "--ok": "#15803d",
      "--ok-hover": "#166534",
      "--ok-tint": "rgba(21, 128, 61, 0.12)",
      "--warn": "#a16207",
      "--warn-tint": "rgba(161, 98, 7, 0.12)",
      "--err": "#b91c1c",
      "--err-tint": "rgba(185, 28, 28, 0.1)",
      "--shadow-pop": "0 12px 32px rgba(15, 23, 42, 0.16)",
      "--scrollbar-thumb": "rgba(15, 23, 42, 0.24)",
      "--scrollbar-thumb-hover": "rgba(15, 23, 42, 0.4)",
    };
  }
  return {
    "--bg": input.bg,
    "--surface-1": lighten(input.bg, 0.06),
    "--surface-2": lighten(input.bg, 0.12),
    "--surface-3": lighten(input.bg, 0.19),
    "--line": "rgba(255, 255, 255, 0.07)",
    "--line-strong": "rgba(255, 255, 255, 0.14)",
    "--text": "#f7f7fa",
    "--text-2": mix("#f7f7fa", input.bg, 0.55),
    "--text-3": mix("#f7f7fa", input.bg, 0.3),
    "--accent": input.accent,
    "--accent-hover": lighten(input.accent, 0.12),
    "--accent-tint": rgba(input.accent, 0.16),
    "--on-accent": onAccent,
    "--ok": "#2fb36d",
    "--ok-hover": "#38c27a",
    "--ok-tint": "rgba(47, 179, 109, 0.14)",
    "--warn": "#e0a32e",
    "--warn-tint": "rgba(224, 163, 46, 0.14)",
    "--err": "#e5484d",
    "--err-tint": "rgba(229, 72, 77, 0.14)",
    "--shadow-pop": "0 12px 32px rgba(0, 0, 0, 0.55)",
    "--scrollbar-thumb": "rgba(255, 255, 255, 0.12)",
    "--scrollbar-thumb-hover": "rgba(255, 255, 255, 0.22)",
  };
}

function readCustomInputs(): CustomThemeInput[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => typeof item.name === "string" && HEX.test(String(item.bg)) && HEX.test(String(item.accent)))
      .map((item) => ({
        name: String(item.name).slice(0, 24) || "Custom",
        bg: String(item.bg),
        accent: String(item.accent),
        light: item.light === true,
      }));
  } catch {
    return [];
  }
}

function writeCustomInputs(list: CustomThemeInput[]): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* private mode: the theme still applies for this session */
  }
}

/** User themes, already expanded into registry entries. */
export function customThemes(): ThemeDef[] {
  return readCustomInputs().map((input, index) => ({
    id: `${CUSTOM_PREFIX}${index}`,
    labelKey: "",
    name: input.name,
    bg: input.bg,
    accent: input.accent,
    scheme: input.light ? "light" : "dark",
    tokens: customTokens(input),
    custom: true,
  }));
}

/** Every theme the picker shows: built-ins first, then the user's own. */
export function themes(): ThemeDef[] {
  return [...BUILTIN_THEMES, ...customThemes()];
}

/** Saves a user theme and returns its id. */
export function saveCustomTheme(input: CustomThemeInput): string {
  const list = readCustomInputs();
  const clean: CustomThemeInput = {
    name: input.name.trim().slice(0, 24) || "Custom",
    bg: HEX.test(input.bg) ? input.bg : "#141418",
    accent: HEX.test(input.accent) ? input.accent : "#7c3aed",
    light: input.light,
  };
  list.push(clean);
  writeCustomInputs(list);
  return `${CUSTOM_PREFIX}${list.length - 1}`;
}

/** Removes a user theme by id. */
export function deleteCustomTheme(id: string): void {
  const index = Number(id.replace(CUSTOM_PREFIX, ""));
  const list = readCustomInputs();
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
  list.splice(index, 1);
  writeCustomInputs(list);
}

export function normalizeSurface(id: string | null | undefined): string {
  const wanted = id ? (LEGACY_SURFACE_IDS[id] ?? id) : id;
  return themes().some((theme) => theme.id === wanted) ? (wanted as string) : DEFAULT_THEME;
}

export function themeById(id: string): ThemeDef {
  const list = themes();
  return list.find((theme) => theme.id === id) ?? list[0];
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

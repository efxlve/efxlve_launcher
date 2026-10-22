/**
 * Theme registry and engine.
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
  /** Surface color hint for preview swatches. */
  surface?: string;
  /** Picker swatch border and the theme's accent colour. */
  accent: string;
  /** `color-scheme`, so native scrollbars and menus follow the theme. */
  scheme: "dark" | "light";
  /** Runtime token overrides; omit when `themes.css` owns the theme's block. */
  tokens?: Record<string, string>;
  /** True for a theme the user saved from Settings. */
  custom?: boolean;
  /** Backdrop image for a user theme, already a `data:` URL. */
  scene?: string;
  sceneBlur?: number;
  sceneOpacity?: number;
  radius?: "sharp" | "default" | "round";
  customInput?: CustomThemeInput;
}

/** What the Settings editor stores for one user theme. */
export interface CustomThemeInput {
  id?: string;
  name: string;
  /** Shell background, `#rrggbb`. */
  bg: string;
  /** Optional surface card background, `#rrggbb`. */
  surface?: string;
  /** Accent, `#rrggbb`. */
  accent: string;
  /** Optional hover accent, `#rrggbb`. */
  accentHover?: string;
  /** Optional secondary accent for dual-tone gradients, `#rrggbb`. */
  accent2?: string;
  /** Accent glow effect intensity. */
  glow?: "none" | "subtle" | "radiant" | "neon";
  /** Surface glass transparency level. */
  cardGlass?: boolean;
  /** Border style contrast. */
  borderStyle?: "subtle" | "contrast" | "accent";
  light: boolean;
  /** Optional backdrop image as a `data:image/...` URL. */
  scene?: string;
  sceneBlur?: number;
  sceneOpacity?: number;
  radius?: "sharp" | "default" | "round";
  createdAt?: number;
}

export interface ThemePreset {
  id: string;
  name: string;
  bg: string;
  surface: string;
  accent: string;
  light: boolean;
}


export interface PresetWallpaper {
  id: string;
  nameKey: string;
  defaultName: string;
  dataUrl: string;
}

const encodeSvg = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;

export const PRESET_WALLPAPERS: readonly PresetWallpaper[] = [
  {
    id: "cyber-grid",
    nameKey: "settings.themeWpCyberGrid",
    defaultName: "Cyber Grid",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <linearGradient id="cg-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#05050d"/>
          <stop offset="55%" stop-color="#0d081f"/>
          <stop offset="100%" stop-color="#2a0845"/>
        </linearGradient>
        <linearGradient id="cg-glow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff007f" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#7928ca" stop-opacity="0"/>
        </linearGradient>
        <pattern id="cg-grid" width="60" height="60" patternUnits="userSpaceOnUse">
          <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#00f0ff" stroke-width="1" stroke-opacity="0.18"/>
        </pattern>
      </defs>
      <rect width="1920" height="1080" fill="url(#cg-sky)"/>
      <rect y="480" width="1920" height="600" fill="url(#cg-glow)"/>
      <rect y="500" width="1920" height="580" fill="url(#cg-grid)"/>
      <line x1="0" y1="500" x2="1920" y2="500" stroke="#ff007f" stroke-width="2" stroke-opacity="0.8"/>
    </svg>`),
  },
  {
    id: "deep-nebula",
    nameKey: "settings.themeWpDeepNebula",
    defaultName: "Deep Space",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <radialGradient id="nb-g1" cx="30%" cy="40%" r="55%">
          <stop offset="0%" stop-color="#4f1787" stop-opacity="0.55"/>
          <stop offset="50%" stop-color="#180161" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#05030a" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="nb-g2" cx="75%" cy="65%" r="50%">
          <stop offset="0%" stop-color="#005792" stop-opacity="0.45"/>
          <stop offset="60%" stop-color="#0b1b3d" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="#05030a" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1920" height="1080" fill="#06060c"/>
      <rect width="1920" height="1080" fill="url(#nb-g1)"/>
      <rect width="1920" height="1080" fill="url(#nb-g2)"/>
      <circle cx="240" cy="180" r="1.5" fill="#fff" opacity="0.8"/>
      <circle cx="850" cy="120" r="1.2" fill="#fff" opacity="0.6"/>
      <circle cx="1400" cy="220" r="1.8" fill="#a5f3fc" opacity="0.9"/>
      <circle cx="1680" cy="450" r="1.3" fill="#fff" opacity="0.7"/>
      <circle cx="420" cy="620" r="1.4" fill="#fbcfe8" opacity="0.8"/>
      <circle cx="1100" cy="740" r="1.6" fill="#fff" opacity="0.7"/>
    </svg>`),
  },
  {
    id: "cyber-blades",
    nameKey: "settings.themeWpCyberBlades",
    defaultName: "Cyber Blades",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <linearGradient id="b-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0b0d12"/>
          <stop offset="100%" stop-color="#171b24"/>
        </linearGradient>
        <linearGradient id="b-acc" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.7"/>
          <stop offset="100%" stop-color="#ef4444" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect width="1920" height="1080" fill="#08090d"/>
      <polygon points="0,0 900,0 600,1080 0,1080" fill="url(#b-g1)"/>
      <polygon points="898,0 904,0 604,1080 598,1080" fill="url(#b-acc)"/>
      <polygon points="1200,0 1920,0 1920,1080 1500,1080" fill="#0d1017"/>
      <polygon points="1198,0 1202,0 1502,1080 1498,1080" fill="#3b82f6" opacity="0.3"/>
    </svg>`),
  },
  {
    id: "aurora-emerald",
    nameKey: "settings.themeWpAuroraEmerald",
    defaultName: "Aurora Emerald",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <radialGradient id="au-1" cx="40%" cy="30%" r="60%">
          <stop offset="0%" stop-color="#059669" stop-opacity="0.35"/>
          <stop offset="50%" stop-color="#047857" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="#021f16" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="au-2" cx="70%" cy="45%" r="55%">
          <stop offset="0%" stop-color="#10b981" stop-opacity="0.25"/>
          <stop offset="60%" stop-color="#064e3b" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="#021f16" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1920" height="1080" fill="#040b08"/>
      <rect width="1920" height="1080" fill="url(#au-1)"/>
      <rect width="1920" height="1080" fill="url(#au-2)"/>
    </svg>`),
  },
  {
    id: "sakura-dusk",
    nameKey: "settings.themeWpSakuraDusk",
    defaultName: "Sakura Dusk",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <radialGradient id="sk-1" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#db2777" stop-opacity="0.3"/>
          <stop offset="60%" stop-color="#4c0519" stop-opacity="0.1"/>
          <stop offset="100%" stop-color="#0d0408" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="sk-2" cx="20%" cy="70%" r="50%">
          <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#0d0408" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1920" height="1080" fill="#0d060a"/>
      <rect width="1920" height="1080" fill="url(#sk-1)"/>
      <rect width="1920" height="1080" fill="url(#sk-2)"/>
    </svg>`),
  },
  {
    id: "fluid-waves",
    nameKey: "settings.themeWpFluidWaves",
    defaultName: "Fluid Waves",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <linearGradient id="fw-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#1e1e28"/>
          <stop offset="100%" stop-color="#0e0e14"/>
        </linearGradient>
      </defs>
      <rect width="1920" height="1080" fill="#0b0b10"/>
      <path d="M0,600 C400,450 800,750 1200,550 C1600,350 1800,600 1920,520 L1920,1080 L0,1080 Z" fill="url(#fw-g)" opacity="0.65"/>
      <path d="M0,720 C500,580 900,850 1400,660 C1700,550 1850,700 1920,640 L1920,1080 L0,1080 Z" fill="#14141c" opacity="0.75"/>
    </svg>`),
  },
  {
    id: "sunset-horizon",
    nameKey: "settings.themeWpSunsetHorizon",
    defaultName: "Sunset Horizon",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <linearGradient id="sh-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0a0505"/>
          <stop offset="60%" stop-color="#240c0c"/>
          <stop offset="90%" stop-color="#5a1e06"/>
          <stop offset="100%" stop-color="#b45309"/>
        </linearGradient>
      </defs>
      <rect width="1920" height="1080" fill="url(#sh-sky)"/>
      <polygon points="0,1080 300,740 600,860 900,680 1200,800 1500,650 1920,780 1920,1080" fill="#1a0b06" opacity="0.85"/>
      <polygon points="0,1080 200,840 500,920 850,810 1150,910 1400,800 1750,890 1920,830 1920,1080" fill="#0c0502"/>
    </svg>`),
  },
  {
    id: "carbon-fiber",
    nameKey: "settings.themeWpCarbonFiber",
    defaultName: "Carbon Fiber",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <pattern id="cf-p" width="12" height="12" patternUnits="userSpaceOnUse">
          <rect width="12" height="12" fill="#0d0e12"/>
          <polygon points="0,0 6,0 0,6" fill="#171920"/>
          <polygon points="6,6 12,6 6,12" fill="#171920"/>
          <polygon points="6,0 12,0 12,6" fill="#13141a"/>
          <polygon points="0,6 6,6 0,12" fill="#13141a"/>
        </pattern>
      </defs>
      <rect width="1920" height="1080" fill="url(#cf-p)"/>
    </svg>`),
  },
];

export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: "cyberpunk", name: "Cyberpunk", bg: "#07080a", surface: "#12151b", accent: "#fcee0a", light: false },
  { id: "tokyonight", name: "Tokyo Night", bg: "#16161e", surface: "#212337", accent: "#7aa2f7", light: false },
  { id: "dracula", name: "Dracula", bg: "#282a36", surface: "#2d303e", accent: "#bd93f9", light: false },
  { id: "catppuccin", name: "Catppuccin", bg: "#1e1e2e", surface: "#313244", accent: "#cba6f7", light: false },
  { id: "emerald", name: "Emerald Matrix", bg: "#08100d", surface: "#142620", accent: "#10b981", light: false },
  { id: "synthwave", name: "Synthwave '84", bg: "#13111c", surface: "#241d3b", accent: "#ff2a85", light: false },
  { id: "rosepine", name: "Rosé Pine", bg: "#191724", surface: "#26233a", accent: "#eb6f92", light: false },
  { id: "sunset", name: "Sunset Amber", bg: "#100d0a", surface: "#231c15", accent: "#f59e0b", light: false },
  { id: "nord", name: "Nordic Slate", bg: "#242933", surface: "#3b4252", accent: "#88c0d0", light: false },
  { id: "oledcyan", name: "Abyss Cyan", bg: "#000000", surface: "#0e151c", accent: "#00f0ff", light: false },
  { id: "white", name: "Pure White", bg: "#f3f4f6", surface: "#ffffff", accent: "#111318", light: true },
];

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
  surface: "#12151b",
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
  surface: "#212337",
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
  surface: "#1e171c",
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
  surface: "#3b4252",
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
  surface: "#231c15",
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
 * Midnight Blue: deep cosmic navy with electric light blue.
 */
const MIDNIGHT: ThemeDef = {
  id: "midnight",
  labelKey: "settings.surfaceMidnight",
  bg: "#070b14",
  surface: "#121a2b",
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

const VIOLET: ThemeDef = {
  id: "violet",
  labelKey: "settings.surfaceViolet",
  bg: "#0a0a0c",
  surface: "#18181d",
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
  surface: "#313338",
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

/**
 * Dracula: iconic gothic developer theme with purple and pink signals.
 */
const DRACULA: ThemeDef = {
  id: "dracula",
  labelKey: "settings.surfaceDracula",
  bg: "#282a36",
  surface: "#2d303e",
  accent: "#bd93f9",
  scheme: "dark",
  tokens: {
    "--bg": "#282a36",
    "--surface-1": "#21222c",
    "--surface-2": "#2d303e",
    "--surface-3": "#383a59",
    "--line": "rgba(189, 147, 249, 0.14)",
    "--line-strong": "rgba(189, 147, 249, 0.28)",
    "--text": "#f8f8f2",
    "--text-2": "#6272a4",
    "--text-3": "#44475a",
    "--accent": "#bd93f9",
    "--accent-hover": "#ff79c6",
    "--accent-tint": "rgba(189, 147, 249, 0.18)",
    "--on-accent": "#282a36",
    "--ok": "#50fa7b",
    "--ok-hover": "#69ff94",
    "--ok-tint": "rgba(80, 250, 123, 0.15)",
    "--warn": "#f1fa8c",
    "--warn-tint": "rgba(241, 250, 140, 0.15)",
    "--err": "#ff5555",
    "--err-tint": "rgba(255, 85, 85, 0.18)",
    "--shadow-pop": "0 14px 36px rgba(0, 0, 0, 0.65)",
    "--scrollbar-thumb": "rgba(189, 147, 249, 0.2)",
    "--scrollbar-thumb-hover": "rgba(189, 147, 249, 0.35)",
  },
};

/**
 * Catppuccin Mocha: soothing pastel palette with lavender accent.
 */
const CATPPUCCIN: ThemeDef = {
  id: "catppuccin",
  labelKey: "settings.surfaceCatppuccin",
  bg: "#1e1e2e",
  surface: "#313244",
  accent: "#cba6f7",
  scheme: "dark",
  tokens: {
    "--bg": "#1e1e2e",
    "--surface-1": "#181825",
    "--surface-2": "#313244",
    "--surface-3": "#45475a",
    "--line": "rgba(203, 166, 247, 0.14)",
    "--line-strong": "rgba(203, 166, 247, 0.28)",
    "--text": "#cdd6f4",
    "--text-2": "#a6adc8",
    "--text-3": "#6c7086",
    "--accent": "#cba6f7",
    "--accent-hover": "#b4befe",
    "--accent-tint": "rgba(203, 166, 247, 0.18)",
    "--on-accent": "#11111b",
    "--ok": "#a6e3a1",
    "--ok-hover": "#94e2d5",
    "--ok-tint": "rgba(166, 227, 161, 0.15)",
    "--warn": "#f9e2af",
    "--warn-tint": "rgba(249, 226, 175, 0.15)",
    "--err": "#f38ba8",
    "--err-tint": "rgba(243, 139, 168, 0.16)",
    "--shadow-pop": "0 12px 32px rgba(17, 17, 27, 0.7)",
    "--scrollbar-thumb": "rgba(203, 166, 247, 0.2)",
    "--scrollbar-thumb-hover": "rgba(203, 166, 247, 0.35)",
  },
};

/**
 * Emerald Matrix: sleek dark jade with emerald luminescence.
 */
const CYBER_EMERALD: ThemeDef = {
  id: "cyberemerald",
  labelKey: "settings.surfaceCyberEmerald",
  bg: "#08100d",
  surface: "#142620",
  accent: "#10b981",
  scheme: "dark",
  tokens: {
    "--bg": "#08100d",
    "--surface-1": "#0e1a16",
    "--surface-2": "#142620",
    "--surface-3": "#1b332b",
    "--line": "rgba(16, 185, 129, 0.14)",
    "--line-strong": "rgba(16, 185, 129, 0.32)",
    "--text": "#ecfdf5",
    "--text-2": "#a7f3d0",
    "--text-3": "#34d399",
    "--accent": "#10b981",
    "--accent-hover": "#34d399",
    "--accent-tint": "rgba(16, 185, 129, 0.18)",
    "--on-accent": "#022c22",
    "--ok": "#10b981",
    "--ok-hover": "#34d399",
    "--ok-tint": "rgba(16, 185, 129, 0.18)",
    "--warn": "#fbbf24",
    "--warn-tint": "rgba(251, 191, 36, 0.15)",
    "--err": "#f43f5e",
    "--err-tint": "rgba(244, 63, 94, 0.16)",
    "--shadow-pop": "0 14px 36px rgba(0, 0, 0, 0.75)",
    "--scrollbar-thumb": "rgba(16, 185, 129, 0.22)",
    "--scrollbar-thumb-hover": "rgba(16, 185, 129, 0.4)",
  },
};

/**
 * Rosé Pine: soothing Scandinavian dark with muted pine and rose tones.
 */
const ROSE_PINE: ThemeDef = {
  id: "rosepine",
  labelKey: "settings.surfaceRosePine",
  bg: "#191724",
  surface: "#26233a",
  accent: "#eb6f92",
  scheme: "dark",
  tokens: {
    "--bg": "#191724",
    "--surface-1": "#1f1d2e",
    "--surface-2": "#26233a",
    "--surface-3": "#312f44",
    "--line": "rgba(235, 111, 146, 0.13)",
    "--line-strong": "rgba(235, 111, 146, 0.26)",
    "--text": "#e0def4",
    "--text-2": "#908caa",
    "--text-3": "#6e6a86",
    "--accent": "#eb6f92",
    "--accent-hover": "#f6c177",
    "--accent-tint": "rgba(235, 111, 146, 0.16)",
    "--on-accent": "#191724",
    "--ok": "#9ccfd8",
    "--ok-hover": "#31748f",
    "--ok-tint": "rgba(156, 207, 216, 0.15)",
    "--warn": "#f6c177",
    "--warn-tint": "rgba(246, 193, 119, 0.15)",
    "--err": "#eb6f92",
    "--err-tint": "rgba(235, 111, 146, 0.18)",
    "--shadow-pop": "0 12px 32px rgba(15, 13, 20, 0.65)",
    "--scrollbar-thumb": "rgba(235, 111, 146, 0.2)",
    "--scrollbar-thumb-hover": "rgba(235, 111, 146, 0.35)",
  },
};

/**
 * Synthwave '84: retro electro-neon with hot pink and electric cyan.
 */
const SYNTHWAVE: ThemeDef = {
  id: "synthwave",
  labelKey: "settings.surfaceSynthwave",
  bg: "#13111c",
  surface: "#241d3b",
  accent: "#ff2a85",
  scheme: "dark",
  tokens: {
    "--bg": "#13111c",
    "--surface-1": "#1a162b",
    "--surface-2": "#241d3b",
    "--surface-3": "#312652",
    "--line": "rgba(255, 42, 133, 0.16)",
    "--line-strong": "rgba(5, 217, 232, 0.3)",
    "--text": "#fff0f7",
    "--text-2": "#cbbcdb",
    "--text-3": "#7d6b99",
    "--accent": "#ff2a85",
    "--accent-hover": "#05d9e8",
    "--accent-tint": "rgba(255, 42, 133, 0.18)",
    "--on-accent": "#ffffff",
    "--ok": "#05d9e8",
    "--ok-hover": "#45effd",
    "--ok-tint": "rgba(5, 217, 232, 0.18)",
    "--warn": "#f7b538",
    "--warn-tint": "rgba(247, 181, 56, 0.16)",
    "--err": "#fe4450",
    "--err-tint": "rgba(254, 68, 80, 0.18)",
    "--shadow-pop": "0 14px 40px rgba(0, 0, 0, 0.75)",
    "--scrollbar-thumb": "rgba(255, 42, 133, 0.24)",
    "--scrollbar-thumb-hover": "rgba(5, 217, 232, 0.4)",
  },
};

/**
 * Abyss Cyan: pitch OLED black with radiant electric cyan.
 */
const OLED_CYAN: ThemeDef = {
  id: "oledcyan",
  labelKey: "settings.surfaceOledCyan",
  bg: "#000000",
  surface: "#0e151c",
  accent: "#00f0ff",
  scheme: "dark",
  tokens: {
    "--bg": "#000000",
    "--surface-1": "#080c10",
    "--surface-2": "#0e151c",
    "--surface-3": "#16202a",
    "--line": "rgba(0, 240, 255, 0.14)",
    "--line-strong": "rgba(0, 240, 255, 0.28)",
    "--text": "#e8fbff",
    "--text-2": "#88b4bf",
    "--text-3": "#4d737d",
    "--accent": "#00f0ff",
    "--accent-hover": "#3df3ff",
    "--accent-tint": "rgba(0, 240, 255, 0.16)",
    "--on-accent": "#001a1c",
    "--ok": "#00f0ff",
    "--ok-hover": "#3df3ff",
    "--ok-tint": "rgba(0, 240, 255, 0.16)",
    "--warn": "#ffb800",
    "--warn-tint": "rgba(255, 184, 0, 0.15)",
    "--err": "#ff3366",
    "--err-tint": "rgba(255, 51, 102, 0.16)",
    "--shadow-pop": "0 14px 38px rgba(0, 0, 0, 0.8)",
    "--scrollbar-thumb": "rgba(0, 240, 255, 0.22)",
    "--scrollbar-thumb-hover": "rgba(0, 240, 255, 0.38)",
  },
};

/** Built-in themes. User themes are appended by [`themes`]. */
const BUILTIN_THEMES: readonly ThemeDef[] = [
  {
    id: "black",
    labelKey: "settings.surfaceBlack",
    bg: "#000000",
    surface: "#141414",
    accent: "#ffffff",
    scheme: "dark",
  },
  {
    id: "soft",
    labelKey: "settings.surfaceSoft",
    bg: "#18181c",
    surface: "#242429",
    accent: "#ffffff",
    scheme: "dark",
  },
  NEON_GRID,
  TOKYO_NIGHT,
  DRACULA,
  CATPPUCCIN,
  CYBER_EMERALD,
  CRIMSON,
  NORD,
  SUNSET,
  MIDNIGHT,
  VIOLET,
  BLURPLE,
  SYNTHWAVE,
  ROSE_PINE,
  OLED_CYAN,
  {
    id: "white",
    labelKey: "settings.surfaceWhite",
    bg: "#f3f4f6",
    surface: "#ffffff",
    accent: "#111318",
    scheme: "light",
  },
  {
    id: "blades",
    labelKey: "settings.surfaceBlades",
    bg: "linear-gradient(160deg, #06190b 0%, #1f5c18 45%, #76be2b 75%, #a8ea48 100%)",
    surface: "#122a16",
    accent: "#9bd44a",
    scheme: "dark",
  },
  {
    id: "gloss",
    labelKey: "settings.surfaceGloss",
    bg: "linear-gradient(180deg, #1678cc 0%, #8fd6fa 58%, #d9f2ff 100%)",
    surface: "#ffffff",
    accent: "#2b8fef",
    scheme: "light",
  },
];

/** A stored id that no longer exists falls back to the default theme. */
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

function rgb(hexColor: string): [number, number, number] | null {
  if (!HEX.test(hexColor)) return null;
  const value = Number.parseInt(hexColor.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(parts: [number, number, number]): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${parts.map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`;
}

/** `weight` 0 keeps `from`, 1 keeps `to`. */
function mix(from: string, to: string, weight: number): string {
  const a = rgb(from);
  const b = rgb(to);
  if (!a || !b) return from;
  return toHex([
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
 * Turns colours into the full token set.
 * If surface is explicitly provided, it derives elevation from it;
 * otherwise it generates harmonious surfaces from the background.
 */
export function customTokens(input: CustomThemeInput): Record<string, string> {
  const onAccent = luminance(input.accent) > 0.55 ? "#101318" : "#ffffff";
  const glass = Boolean(input.scene) || input.cardGlass === true;
  const baseSurface = input.surface && HEX.test(input.surface) ? input.surface : null;

  const rSm = input.radius === "sharp" ? "0px" : input.radius === "round" ? "10px" : "6px";
  const rMd = input.radius === "sharp" ? "0px" : input.radius === "round" ? "16px" : "10px";

  const secAccent = input.accent2 && HEX.test(input.accent2) ? input.accent2 : input.accentHover ?? (input.light ? darken(input.accent, 0.1) : lighten(input.accent, 0.12));
  const accentGradient = `linear-gradient(135deg, ${input.accent} 0%, ${secAccent} 100%)`;

  let accentGlow = "none";
  if (input.glow === "neon") {
    accentGlow = `0 0 16px ${rgba(input.accent, 0.7)}, 0 0 32px ${rgba(input.accent, 0.4)}`;
  } else if (input.glow === "radiant") {
    accentGlow = `0 0 14px ${rgba(input.accent, 0.45)}`;
  } else if (input.glow === "subtle") {
    accentGlow = `0 0 8px ${rgba(input.accent, 0.25)}`;
  }

  let line = "rgba(255, 255, 255, 0.07)";
  let lineStrong = "rgba(255, 255, 255, 0.15)";
  if (input.borderStyle === "accent") {
    line = rgba(input.accent, 0.22);
    lineStrong = rgba(input.accent, 0.45);
  } else if (input.borderStyle === "contrast") {
    line = input.light ? "rgba(15, 23, 42, 0.18)" : "rgba(255, 255, 255, 0.18)";
    lineStrong = input.light ? "rgba(15, 23, 42, 0.35)" : "rgba(255, 255, 255, 0.32)";
  } else if (input.light) {
    line = "rgba(15, 23, 42, 0.09)";
    lineStrong = "rgba(15, 23, 42, 0.18)";
  }

  if (input.light) {
    const s1 = baseSurface ?? "#ffffff";
    const s2 = baseSurface ? darken(baseSurface, 0.04) : darken(input.bg, 0.04);
    const s3 = baseSurface ? darken(baseSurface, 0.08) : darken(input.bg, 0.09);

    return {
      "--bg": input.bg,
      "--surface-1": glass ? rgba(s1, 0.85) : s1,
      "--surface-2": glass ? rgba(s2, 0.75) : s2,
      "--surface-3": glass ? rgba(s3, 0.65) : s3,
      "--line": line,
      "--line-strong": lineStrong,
      "--text": "#101318",
      "--text-2": "#4b5563",
      "--text-3": "#7b8492",
      "--accent": input.accent,
      "--accent-hover": input.accentHover ?? darken(input.accent, 0.1),
      "--accent-2": secAccent,
      "--accent-gradient": accentGradient,
      "--accent-glow": accentGlow,
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
      "--r-sm": rSm,
      "--r-md": rMd,
    };
  }

  const s1 = baseSurface ?? lighten(input.bg, 0.06);
  const s2 = baseSurface ? lighten(baseSurface, 0.06) : lighten(input.bg, 0.12);
  const s3 = baseSurface ? lighten(baseSurface, 0.12) : lighten(input.bg, 0.19);

  return {
    "--bg": input.bg,
    "--surface-1": glass ? (input.cardGlass ? rgba(s1, 0.65) : rgba(s1, 0.82)) : s1,
    "--surface-2": glass ? (input.cardGlass ? rgba(s2, 0.52) : rgba(s2, 0.72)) : s2,
    "--surface-3": glass ? (input.cardGlass ? rgba(s3, 0.42) : rgba(s3, 0.62)) : s3,
    "--line": line,
    "--line-strong": lineStrong,
    "--text": "#f7f7fa",
    "--text-2": mix("#f7f7fa", input.bg, 0.55),
    "--text-3": mix("#f7f7fa", input.bg, 0.3),
    "--accent": input.accent,
    "--accent-hover": input.accentHover ?? lighten(input.accent, 0.12),
    "--accent-2": secAccent,
    "--accent-gradient": accentGradient,
    "--accent-glow": accentGlow,
    "--accent-tint": rgba(input.accent, 0.16),
    "--on-accent": onAccent,
    "--ok": "#2fb36d",
    "--ok-hover": "#38c27a",
    "--ok-tint": "rgba(47, 179, 109, 0.14)",
    "--warn": "#e0a32e",
    "--warn-tint": "rgba(224, 163, 46, 0.14)",
    "--err": "#e5484d",
    "--err-tint": "rgba(229, 72, 77, 0.14)",
    "--shadow-pop": "0 14px 36px rgba(0, 0, 0, 0.65)",
    "--scrollbar-thumb": "rgba(255, 255, 255, 0.14)",
    "--scrollbar-thumb-hover": "rgba(255, 255, 255, 0.26)",
    "--r-sm": rSm,
    "--r-md": rMd,
  };
}

/** The scene rules for a user theme: photo on the shell, glass panels above. */
function sceneRules(id: string, input: CustomThemeInput): string {
  if (!input.scene) return "";
  const selector = `:root[data-surface="${id}"]`;
  const opacity = typeof input.sceneOpacity === "number" ? Math.max(0.05, Math.min(0.95, input.sceneOpacity)) : input.light ? 0.38 : 0.52;
  const blur = typeof input.sceneBlur === "number" ? Math.max(0, Math.min(30, input.sceneBlur)) : 0;
  const scrim = input.light
    ? `rgba(255, 255, 255, ${opacity})`
    : `rgba(0, 0, 0, ${opacity})`;

  const blurFilter = blur > 0 ? `backdrop-filter: blur(${blur}px); -webkit-backdrop-filter: blur(${blur}px);` : "";

  return [
    `${selector} body { background: ${input.bg} url("${input.scene}") center / cover no-repeat fixed !important; }`,
    `${selector} body::before { content: ""; position: fixed; inset: 0; z-index: -1; background: ${scrim}; ${blurFilter} pointer-events: none; }`,
    `${selector} .overlay, ${selector} #main-col, ${selector} #view { background: transparent !important; }`,
    `${selector} :is(.card, .settings-group, .info-box, .lib-list, .pcard, .sb-item) { backdrop-filter: blur(14px) saturate(130%); -webkit-backdrop-filter: blur(14px) saturate(130%); }` + (input.glow && input.glow !== "none" ? `\n${selector} .btn.primary { box-shadow: var(--accent-glow) !important; }` : "") + (input.accent2 ? `\n${selector} .btn.primary { background: var(--accent-gradient) !important; }` : ""),
  ].join("\n");
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
      .map((item, index) => ({
        id: typeof item.id === "string" && item.id.length > 0 ? item.id : `${CUSTOM_PREFIX}${index}`,
        name: String(item.name).slice(0, 32) || "Custom",
        bg: String(item.bg),
        surface: typeof item.surface === "string" && HEX.test(item.surface) ? item.surface : undefined,
        accent: String(item.accent),
        accentHover: typeof item.accentHover === "string" && HEX.test(item.accentHover) ? item.accentHover : undefined,
        accent2: typeof item.accent2 === "string" && HEX.test(item.accent2) ? item.accent2 : undefined,
        glow: item.glow === "subtle" || item.glow === "radiant" || item.glow === "neon" ? item.glow : "none",
        cardGlass: item.cardGlass === true,
        borderStyle: item.borderStyle === "contrast" || item.borderStyle === "accent" ? item.borderStyle : "subtle",
        light: item.light === true,
        scene:
          typeof item.scene === "string" && item.scene.startsWith("data:image/") && item.scene.length < 2_000_000
            ? item.scene
            : undefined,
        sceneBlur: typeof item.sceneBlur === "number" ? Math.max(0, Math.min(30, item.sceneBlur)) : 0,
        sceneOpacity: typeof item.sceneOpacity === "number" ? Math.max(0.05, Math.min(0.95, item.sceneOpacity)) : undefined,
        radius: item.radius === "sharp" || item.radius === "round" ? item.radius : "default",
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

/** Persists the list; false when the quota rejected it (a large backdrop). */
function writeCustomInputs(list: CustomThemeInput[]): boolean {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** User themes, already expanded into registry entries. */
export function customThemes(): ThemeDef[] {
  return readCustomInputs().map((input, index) => {
    const id = input.id || `${CUSTOM_PREFIX}${index}`;
    return {
      id,
      labelKey: "",
      name: input.name,
      bg: input.bg,
      surface: input.surface,
      accent: input.accent,
      scheme: input.light ? "light" : "dark",
      tokens: customTokens(input),
      custom: true,
      scene: input.scene,
      sceneBlur: input.sceneBlur,
      sceneOpacity: input.sceneOpacity,
      radius: input.radius,
      customInput: input,
    };
  });
}

/** Every theme the picker shows: built-ins first, then the user's own. */
export function themes(): ThemeDef[] {
  return [...BUILTIN_THEMES, ...customThemes()];
}

/** Saves or updates a user theme and returns its id, or "" when it could not be stored. */
export function saveCustomTheme(input: CustomThemeInput): string {
  const list = readCustomInputs();
  const targetId = input.id && input.id.startsWith(CUSTOM_PREFIX) ? input.id : `${CUSTOM_PREFIX}${Date.now()}`;

  const clean: CustomThemeInput = {
    id: targetId,
    name: input.name.trim().slice(0, 32) || "Custom",
    bg: HEX.test(input.bg) ? input.bg : "#141418",
    surface: input.surface && HEX.test(input.surface) ? input.surface : undefined,
    accent: HEX.test(input.accent) ? input.accent : "#7c3aed",
    accentHover: input.accentHover && HEX.test(input.accentHover) ? input.accentHover : undefined,
    accent2: input.accent2 && HEX.test(input.accent2) ? input.accent2 : undefined,
    glow: input.glow === "subtle" || input.glow === "radiant" || input.glow === "neon" ? input.glow : "none",
    cardGlass: Boolean(input.cardGlass),
    borderStyle: input.borderStyle === "contrast" || input.borderStyle === "accent" ? input.borderStyle : "subtle",
    light: Boolean(input.light),
    scene: input.scene?.startsWith("data:image/") ? input.scene : undefined,
    sceneBlur: typeof input.sceneBlur === "number" ? Math.max(0, Math.min(30, input.sceneBlur)) : 0,
    sceneOpacity: typeof input.sceneOpacity === "number" ? Math.max(0.05, Math.min(0.95, input.sceneOpacity)) : undefined,
    radius: input.radius === "sharp" || input.radius === "round" ? input.radius : "default",
    createdAt: input.createdAt || Date.now(),
  };

  const existingIdx = list.findIndex((item, idx) => item.id === targetId || `${CUSTOM_PREFIX}${idx}` === targetId);
  if (existingIdx !== -1) {
    list[existingIdx] = clean;
  } else {
    list.push(clean);
  }

  if (!writeCustomInputs(list)) return "";
  return targetId;
}

/** Retrieves custom theme input by id. */
export function getCustomThemeInput(id: string): CustomThemeInput | null {
  const list = readCustomInputs();
  return list.find((item, idx) => item.id === id || `${CUSTOM_PREFIX}${idx}` === id) ?? null;
}

/** Removes a user theme by id. */
export function deleteCustomTheme(id: string): void {
  const list = readCustomInputs();
  const index = list.findIndex((item, idx) => item.id === id || `${CUSTOM_PREFIX}${idx}` === id);
  if (index === -1) return;
  list.splice(index, 1);
  writeCustomInputs(list);
}

/** Duplicates any theme (built-in or custom) as a new custom theme. */
export function duplicateTheme(sourceId: string, copySuffix = " Copy"): string {
  const custom = getCustomThemeInput(sourceId);
  if (custom) {
    return saveCustomTheme({
      ...custom,
      id: undefined,
      name: `${custom.name}${copySuffix}`,
      createdAt: Date.now(),
    });
  }

  const def = themeById(sourceId);
  const bg = HEX.test(def.bg) ? def.bg : "#141418";
  const accent = HEX.test(def.accent) ? def.accent : "#7c3aed";
  const surface = def.surface && HEX.test(def.surface) ? def.surface : undefined;

  return saveCustomTheme({
    name: `${def.name ?? def.id}${copySuffix}`,
    bg,
    surface,
    accent,
    light: def.scheme === "light",
    radius: "default",
  });
}

/** Exports a theme definition as a JSON string. */
export function exportThemeJson(id: string): string {
  const custom = getCustomThemeInput(id);
  if (custom) {
    return JSON.stringify(
      {
        efxlve_theme: 2,
        name: custom.name,
        author: "User",
        bg: custom.bg,
        surface: custom.surface,
        accent: custom.accent,
        accentHover: custom.accentHover,
        accent2: custom.accent2,
        glow: custom.glow ?? "none",
        cardGlass: Boolean(custom.cardGlass),
        borderStyle: custom.borderStyle ?? "subtle",
        light: custom.light,
        scene: custom.scene,
        sceneBlur: custom.sceneBlur,
        sceneOpacity: custom.sceneOpacity,
        radius: custom.radius,
        exportedAt: Date.now(),
      },
      null,
      2,
    );
  }

  const def = themeById(id);
  return JSON.stringify(
    {
      efxlve_theme: 2,
      name: def.name ?? def.id,
      bg: HEX.test(def.bg) ? def.bg : "#141418",
      surface: def.surface,
      accent: HEX.test(def.accent) ? def.accent : "#7c3aed",
      light: def.scheme === "light",
      radius: "default",
      exportedAt: Date.now(),
    },
    null,
    2,
  );
}

/** Imports a theme from JSON string, saving it as a custom theme. */
export function importThemeJson(jsonStr: string): { id: string; name: string } | null {
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;

    const bg = String(parsed.bg || "");
    const accent = String(parsed.accent || "");
    if (!HEX.test(bg) || !HEX.test(accent)) return null;

    const name = String(parsed.name || "Imported Theme").slice(0, 32);
    const surface = typeof parsed.surface === "string" && HEX.test(parsed.surface) ? parsed.surface : undefined;
    const accentHover = typeof parsed.accentHover === "string" && HEX.test(parsed.accentHover) ? parsed.accentHover : undefined;
    const light = parsed.light === true;
    const sceneBlur = typeof parsed.sceneBlur === "number" ? Math.max(0, Math.min(30, parsed.sceneBlur)) : 0;
    const sceneOpacity = typeof parsed.sceneOpacity === "number" ? Math.max(0.05, Math.min(0.95, parsed.sceneOpacity)) : undefined;
    const radius = parsed.radius === "sharp" || parsed.radius === "round" ? parsed.radius : "default";

    const id = saveCustomTheme({
      name,
      bg,
      surface,
      accent,
      accentHover,
      light,
      sceneBlur,
      sceneOpacity,
      radius,
    });

    if (!id) return null;
    return { id, name };
  } catch {
    return null;
  }
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

  // A user theme can carry a backdrop image; its rules are generated with the
  // theme, so the CSS files stay free of per-user selectors.
  const custom = theme.customInput ?? getCustomThemeInput(theme.id);
  const scene = custom?.scene
    ? sceneRules(theme.id, custom)
    : "";

  tokenStyle().textContent = body || scene
    ? `${body ? `:root[data-surface="${theme.id}"]{${body}}` : ""}${scene}`
    : "";
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

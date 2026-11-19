/** Theme data shapes shared by the registry, storage, designer and transfer. */

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
  /** Free-form discovery tags used by the gallery search. */
  tags?: readonly string[];
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
  /** Built-in theme this user theme was cloned from, for token recovery. */
  sourceId?: string;
  /** Written after the token table was decided; stops legacy name recovery. */
  tokensDecided?: boolean;
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
  /** True when the image lives in IndexedDB and only metadata is stored. */
  sceneStored?: boolean;
  sceneBlur?: number;
  sceneOpacity?: number;
  radius?: "sharp" | "default" | "round";
  tokens?: Record<string, string>;
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


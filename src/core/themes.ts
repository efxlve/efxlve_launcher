/**
 * Theme registry and engine.
 *
 * Built-in definitions live in `core/theme/core.ts`; the extended catalog is
 * dynamically imported from `core/theme/catalog.ts`. Designer presets live in
 * `core/theme/presets.ts` and shared shapes in `core/theme/types.ts`. This file
 * owns storage, validation, transfer and the DOM painter, and re-exports the
 * registry API the rest of the app imports.
 */

import { invoke } from "@tauri-apps/api/core";
import { SURFACE_KEY, isTauri } from "./constants";
import { t } from "../i18n";
import type { CustomThemeInput, ThemeDef, ThemePreset, PresetWallpaper } from "./theme/types";
import { PRESET_WALLPAPERS, THEME_PRESETS } from "./theme/presets";
import { CORE_THEMES, DEFAULT_THEME, LEGACY_SURFACE_IDS } from "./theme/core";
import {
  deleteCachedThemeScene,
  deleteThemeScene,
  getCachedThemeScene,
  isThemeSceneStoreReady,
  loadThemeScenes,
  putThemeScene,
  setCachedThemeScene,
} from "./theme/scenes";
import { customTokens, contrastRatio, HEX } from "./theme/tokens";
export { customTokens, contrastRatio } from "./theme/tokens";
export { defineTheme } from "./theme/recipe";
export type { ThemeRecipe } from "./theme/recipe";
export type { CustomThemeInput, ThemeDef, ThemePreset, PresetWallpaper };
export { PRESET_WALLPAPERS, THEME_PRESETS };
export { CORE_THEMES, DEFAULT_THEME, LEGACY_SURFACE_IDS };

const CUSTOM_KEY = "efxlve-custom-themes";
const CUSTOM_PREFIX = "custom-";
const TOKEN_STYLE_ID = "efxlve-theme-tokens";
let customIdCounter = 0;

/** Timestamp ids collide when two themes are saved in the same millisecond. */
function newCustomThemeId(): string {
  customIdCounter = (customIdCounter + 1) % 1_000_000;
  return `${CUSTOM_PREFIX}${Date.now()}-${customIdCounter}`;
}
/** Parsed user themes; invalidated on save/delete or a cross-window storage event. */
let customCache: CustomThemeInput[] | null = null;
/** Expanded user theme registry entries; rebuilt after the raw list changes. */
let customThemeCache: ThemeDef[] | null = null;
/** Extended built-ins arrive only when the Themes page asks for them. */
let catalogThemes: readonly ThemeDef[] | null = null;
let catalogPromise: Promise<void> | null = null;

function allBuiltinThemes(): readonly ThemeDef[] {
  return catalogThemes ? [...CORE_THEMES, ...catalogThemes] : CORE_THEMES;
}

/** True once the extended catalog is in memory (or its load has settled). */
export function isThemeCatalogLoaded(): boolean {
  return catalogThemes !== null;
}

/** Loads the extended built-ins on first use; a failure leaves core themes. */
export function ensureThemeCatalog(): Promise<void> {
  if (catalogThemes) return Promise.resolve();
  catalogPromise ??= import("./theme/catalog")
    .then((module) => {
      catalogThemes = module.CATALOG_THEMES;
      clearThemeCache();
      const active = readSurface();
      if (active !== DEFAULT_THEME) applySurface(active, false);
    })
    .catch((error) => {
      catalogThemes = [];
      console.warn("Theme catalog could not be loaded", error);
    });
  return catalogPromise;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === CUSTOM_KEY || event.key === null) clearThemeCache();
  });
}
const THEME_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOKEN_NAME = /^--[a-z0-9-]+$/;
const UNSAFE_TOKEN_VALUE = /[;{}<>\\]|\/\*|\*\/|url\s*\(|@import|expression\s*\(/i;
const RASTER_SCENE = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i;
const SVG_SCENE = /^data:image\/svg\+xml,/i;
const UNSAFE_SCENE_TEXT = /["\\\u0000-\u001f]/;
const BUILTIN_SCENE_BG = /^#[0-9a-f]{6} url\("(?:\/assets\/|\/src\/assets\/|\.\.\/assets\/)[A-Za-z0-9_.-]+\.svg"\) 0 0 \/ 100vw 100vh no-repeat fixed$/i;
const PREVIEW_GRADIENT = /^linear-gradient\([#0-9a-z%.,\s-]+\)$/i;

/** Written on every applied theme and read by the boot script in index.html. */
export const BOOT_THEME_KEY = "efxlve-boot-theme";

/** Built-in ids whose background comes from CSS rather than `--bg`. */
const BOOT_BG: Record<string, string> = {
  black: "#000000",
  soft: "#101014",
  white: "#f3f4f6",
  blades: "#06190b",
  gloss: "#8fd6fa",
};

/** Theme ids reach CSS selectors, so only the registry's slug shape is allowed. */
export function isSafeThemeId(value: unknown): value is string {
  return typeof value === "string" && THEME_ID.test(value);
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\\n\r]/g, "");
}

/**
 * A token table may come from localStorage or a `.efxtheme` file. It is written
 * into a `<style>` element verbatim, so declarations must stay declarations.
 */
export function sanitizeThemeTokens(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const clean: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!TOKEN_NAME.test(name) || typeof raw !== "string") continue;
    const token = raw.trim();
    if (!token || UNSAFE_TOKEN_VALUE.test(token)) continue;
    clean[name] = token;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/**
 * Backdrops are injected inside `url("…")`, so a quote or backslash must never
 * reach the CSS. Preset SVGs are trusted; user data URLs are raster base64 or a
 * percent-encoded SVG without CSS-string terminators.
 */
export function sanitizeSceneUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length >= 2_000_000) return undefined;
  if (PRESET_WALLPAPERS.some((wallpaper) => wallpaper.dataUrl === value)) return value;
  if (RASTER_SCENE.test(value)) return value;
  if (SVG_SCENE.test(value) && !UNSAFE_SCENE_TEXT.test(value)) return value;
  return undefined;
}

/**
 * A cloned built-in keeps its bundled scene. The token contains `url(`, so it
 * cannot travel through `sanitizeThemeTokens`; only the exact shipped shape is
 * accepted, and only from the app's own asset folders.
 */
export function sanitizeSceneBackground(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  if (token.length >= 500 || !BUILTIN_SCENE_BG.test(token)) return undefined;
  return token;
}

/** Gallery preview gradients are colours only; quotes and `url()` stay out. */
export function sanitizePreviewBg(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const bg = value.trim();
  if (bg.length > 400 || !PREVIEW_GRADIENT.test(bg)) return undefined;
  return bg;
}

/** Boot snapshots may carry the bundled `--scene-bg` token, never a remote URL. */
function sanitizeSnapshotTokens(value: unknown): Record<string, string> | undefined {
  const clean = sanitizeThemeTokens(value) ?? {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sceneBg = (value as Record<string, unknown>)["--scene-bg"];
    if (typeof sceneBg === "string") {
      const token = sceneBg.trim();
      if (BUILTIN_SCENE_BG.test(token)) clean["--scene-bg"] = token;
    }
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function sceneRules(id: string, input: CustomThemeInput): string {
  const selector = `:root[data-surface="${cssEscape(id)}"]`;
  const rules: string[] = [];
  const scene = sanitizeSceneUrl(input.scene);
  const sceneBg = scene ? undefined : sanitizeSceneBackground(input.sceneBg);
  const bg = HEX.test(input.bg) ? input.bg : "#000000";
  const glassRule = `${selector} :is(.card, .settings-group, .info-box, .lib-list, .pcard, .sb-item, .cs-hero, .cs-dest, .cs-provider, .bk-section, .cs-config-box) { backdrop-filter: blur(14px) saturate(130%); -webkit-backdrop-filter: blur(14px) saturate(130%); }`;

  if (scene) {
    const opacity = typeof input.sceneOpacity === "number" ? Math.max(0.05, Math.min(0.95, input.sceneOpacity)) : input.light ? 0.38 : 0.52;
    const blur = typeof input.sceneBlur === "number" ? Math.max(0, Math.min(30, input.sceneBlur)) : 0;
    const scrim = input.light
      ? `rgba(255, 255, 255, ${opacity})`
      : `rgba(0, 0, 0, ${opacity})`;

    const blurFilter = blur > 0 ? `backdrop-filter: blur(${blur}px); -webkit-backdrop-filter: blur(${blur}px);` : "";

    rules.push(`${selector} body { background: ${bg} url("${scene}") center / cover no-repeat fixed !important; }`);
    rules.push(`${selector} body::before { content: ""; position: fixed; inset: 0; z-index: -1; background: ${scrim}; ${blurFilter} pointer-events: none; }`);
    // Main column and view are transparent so the wallpaper shows in library/settings
    rules.push(`${selector} #main-col, ${selector} #view { background: transparent !important; }`);
    // The game page is its own opaque layer. It carries the same scene, dimmed
    // by the same scrim, so the library cannot bleed through and the theme still
    // reaches the page the user spends the most time on.
    rules.push(`${selector} .overlay { background: linear-gradient(${scrim}, ${scrim}), ${bg} url("${scene}") center / cover no-repeat fixed !important; }`);
    rules.push(glassRule);
  } else if (sceneBg) {
    // A cloned built-in scene is already a complete background shorthand
    // (colour, artwork, sizing); the source theme's own CSS cannot follow it,
    // so the same shorthand is painted on the shell and the game page here.
    rules.push(`${selector} body { background: ${sceneBg} !important; }`);
    rules.push(`${selector} #main-col, ${selector} #view { background: transparent !important; }`);
    rules.push(`${selector} .overlay { background: ${sceneBg} !important; }`);
    if (input.cardGlass) rules.push(glassRule);
  } else if (input.cardGlass) {
    rules.push(glassRule);
  }

  if (input.glow && input.glow !== "none") {
    rules.push(`${selector} :is(.btn.primary, .btn.play) { box-shadow: var(--accent-glow) !important; }`);
  }
  if (input.accent2 && HEX.test(input.accent2)) {
    rules.push(`${selector} :is(.btn.primary, .btn.play) { background: var(--accent-gradient) !important; }`);
    rules.push(`${selector} :is(.progress > span, .gp-progress-fill, .ach-group-bar-fill, .tm-bar-fill) { background: var(--accent-gradient) !important; }`);
  }

  return rules.join("\n");
}

function readCustomInputs(): CustomThemeInput[] {
  if (customCache) return customCache;
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) {
      customCache = [];
      return customCache;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      customCache = [];
      return customCache;
    }
    let migrated = false;
    const list = parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => typeof item.name === "string" && HEX.test(String(item.bg)) && HEX.test(String(item.accent)))
      .map((item, index) => {
        const id = isSafeThemeId(item.id) ? item.id : `${CUSTOM_PREFIX}${index}`;
        const sourceId = isSafeThemeId(item.sourceId) ? item.sourceId : undefined;
        let tokens = sanitizeThemeTokens(item.tokens);
        let recoveredSource = sourceId;
        let recoveredSceneBg: string | undefined;
        let recoveredPreviewBg: string | undefined;
        let recoveredGlass = false;

        // A theme cloned after the token fix carries its source id, so missing
        // tokens can be recovered without looking at a translated name.
        if (!tokens && sourceId && item.tokensDecided !== true) {
          const source = allBuiltinThemes().find((theme) => theme.id === sourceId);
          if (source?.tokens) {
            tokens = { ...source.tokens };
            recoveredSceneBg = sanitizeSceneBackground(tokens["--scene-bg"]);
            delete tokens["--scene-bg"];
            const sourceBg = HEX.test(source.bg) ? source.bg : firstHex(source.bg);
            recoveredPreviewBg =
              sourceBg && sourceBg.toLowerCase() === String(item.bg).toLowerCase()
                ? sanitizePreviewBg(source.bg)
                : undefined;
            recoveredGlass = hasTranslucentSurfaces(source.tokens);
            migrated = true;
          }
        }

        // Older clones only stored a localized "… Copy" name. Recover once and
        // write the tokens back, so a later language change cannot lose them.
        if (!tokens && item.tokensDecided !== true && typeof item.name === "string" && item.name.endsWith(" Copy")) {
          const baseName = item.name.replace(/\s+Copy$/, "").trim().toLowerCase();
          const matched = allBuiltinThemes().find((theme) => {
            const name = (theme.name ?? (theme.labelKey ? t(theme.labelKey) : theme.id)).toLowerCase();
            return name === baseName || theme.id.toLowerCase() === baseName;
          });
          if (matched?.tokens) {
            tokens = { ...matched.tokens };
            recoveredSource = matched.id;
            recoveredSceneBg = sanitizeSceneBackground(tokens["--scene-bg"]);
            delete tokens["--scene-bg"];
            const sourceBg = HEX.test(matched.bg) ? matched.bg : firstHex(matched.bg);
            recoveredPreviewBg =
              sourceBg && sourceBg.toLowerCase() === String(item.bg).toLowerCase()
                ? sanitizePreviewBg(matched.bg)
                : undefined;
            recoveredGlass = hasTranslucentSurfaces(matched.tokens);
            migrated = true;
          }
        }

        const borderStyle: "subtle" | "contrast" | "accent" =
          item.borderStyle === "contrast" || item.borderStyle === "accent" ? item.borderStyle : "subtle";
        const glow: "none" | "subtle" | "radiant" | "neon" =
          item.glow === "subtle" || item.glow === "radiant" || item.glow === "neon" ? item.glow : "none";
        const accentHover = typeof item.accentHover === "string" && HEX.test(item.accentHover) ? item.accentHover : undefined;
        const accent2 = typeof item.accent2 === "string" && HEX.test(item.accent2) ? item.accent2 : undefined;
        const surface = typeof item.surface === "string" && HEX.test(item.surface) ? item.surface : undefined;
        const radius: "default" | "sharp" | "round" =
          item.radius === "sharp" || item.radius === "round" ? item.radius : "default";

        return {
          id,
          sourceId: recoveredSource,
          tokensDecided: item.tokensDecided === true || migrated,
          name: String(item.name).slice(0, 32) || "Custom",
          bg: String(item.bg),
          surface,
          accent: String(item.accent),
          accentHover,
          accent2,
          glow,
          cardGlass: item.cardGlass === true || recoveredGlass,
          borderStyle,
          light: item.light === true,
          scene: sanitizeSceneUrl(item.scene),
          sceneBg: sanitizeSceneBackground(item.sceneBg) ?? recoveredSceneBg,
          previewBg: sanitizePreviewBg(item.previewBg) ?? recoveredPreviewBg,
          sceneStored: item.sceneStored === true,
          sceneBlur: typeof item.sceneBlur === "number" ? Math.max(0, Math.min(30, item.sceneBlur)) : 0,
          sceneOpacity: typeof item.sceneOpacity === "number" ? Math.max(0.05, Math.min(0.95, item.sceneOpacity)) : undefined,
          radius,
          tokens,
          createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
        };
      });
    if (migrated) writeCustomInputs(list);
    customCache = list;
    return list;
  } catch {
    customCache = [];
    return customCache;
  }
}

/** Persists the list; false when the quota rejected it (a large backdrop). */
function writeCustomInputs(list: CustomThemeInput[]): boolean {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
    customCache = list;
    customThemeCache = null;
    return true;
  } catch {
    return false;
  }
}

/** Clears the parsed list after an external storage update (tests, storage event). */
export function clearThemeCache(): void {
  customCache = null;
  customThemeCache = null;
}

/** User themes, already expanded into registry entries. */
export function customThemes(): ThemeDef[] {
  if (customThemeCache) return customThemeCache;
  customThemeCache = readCustomInputs().map((input, index) => {
    const id = input.id || `${CUSTOM_PREFIX}${index}`;
    const generated = customTokens(input);
    const tokens = input.tokens ? { ...generated, ...input.tokens } : generated;
    const scene = input.scene ?? getCachedThemeScene(id);
    return {
      id,
      labelKey: "",
      name: input.name,
      bg: input.bg,
      surface: input.surface,
      accent: input.accent,
      scheme: input.light ? "light" : "dark",
      tokens,
      custom: true,
      tags: ["custom"],
      scene,
      sceneBlur: input.sceneBlur,
      sceneOpacity: input.sceneOpacity,
      radius: input.radius,
      customInput: { ...input, scene },
    };
  });
  return customThemeCache;
}

/** Every theme the picker shows: built-ins first, then the user's own. */
/** Rebuilds the active theme from the boot snapshot until the catalog loads. */
let bootSnapshotRaw: string | null = null;
let bootSnapshotCache: ThemeDef | null = null;

function bootSnapshotTheme(): ThemeDef | null {
  try {
    const raw = localStorage.getItem(BOOT_THEME_KEY) ?? "";
    if (raw === bootSnapshotRaw) return bootSnapshotCache;
    bootSnapshotRaw = raw;
    bootSnapshotCache = null;
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const id = parsed.id;
    if (!isSafeThemeId(id)) return null;

    const tokens = sanitizeSnapshotTokens(parsed.tokens);
    const accent =
      typeof parsed.accent === "string" && HEX.test(parsed.accent)
        ? parsed.accent
        : tokens?.["--accent"] && HEX.test(tokens["--accent"])
          ? tokens["--accent"]
          : "#ffffff";
    const bg =
      typeof parsed.bg === "string" && HEX.test(parsed.bg)
        ? parsed.bg
        : tokens?.["--bg"] && HEX.test(tokens["--bg"])
          ? tokens["--bg"]
          : "#000000";
    const surface =
      typeof parsed.surface === "string" && HEX.test(parsed.surface)
        ? parsed.surface
        : tokens?.["--surface-1"];

    bootSnapshotCache = {
      id,
      labelKey: typeof parsed.labelKey === "string" ? parsed.labelKey : "",
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      bg,
      surface,
      accent,
      scheme: parsed.scheme === "light" ? "light" : "dark",
      tokens,
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((tag): tag is string => typeof tag === "string")
        : undefined,
    };
    return bootSnapshotCache;
  } catch {
    return null;
  }
}

/** Every theme the picker shows: core, the loaded catalog, then user themes. */
export function themes(): ThemeDef[] {
  const custom = customThemes();
  const list = [...allBuiltinThemes()];
  const snapshot = bootSnapshotTheme();
  if (
    snapshot &&
    !list.some((theme) => theme.id === snapshot.id) &&
    !custom.some((theme) => theme.id === snapshot.id)
  ) {
    list.push(snapshot);
  }
  return [...list, ...custom];
}

/** Fallback when IndexedDB rejects a write: keep the image in metadata. */
function restoreSceneMetadata(id: string, scene: string): void {
  const list = readCustomInputs().slice();
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return;
  list[index] = { ...list[index], scene, sceneStored: false };
  writeCustomInputs(list);
}

/** Saves or updates a user theme and returns its id, or "" when it could not be stored. */
export function saveCustomTheme(input: CustomThemeInput): string {
  const list = readCustomInputs().slice();
  const targetId =
    isSafeThemeId(input.id) && input.id.startsWith(CUSTOM_PREFIX) ? input.id : newCustomThemeId();
  const existingIdx = list.findIndex((item, idx) => item.id === targetId || `${CUSTOM_PREFIX}${idx}` === targetId);
  const existing = existingIdx !== -1 ? list[existingIdx] : undefined;
  const scene = sanitizeSceneUrl(input.scene);
  const clearScene = input.removeScene === true;
  const preservedScene = !scene && !clearScene ? existing?.scene ?? getCachedThemeScene(targetId) : undefined;
  const storedScene = scene ?? preservedScene;
  const sceneReady = isThemeSceneStoreReady();
  if (scene) {
    setCachedThemeScene(targetId, scene);
    if (sceneReady) {
      void putThemeScene(targetId, scene).then((stored) => {
        if (!stored) restoreSceneMetadata(targetId, scene);
      });
    }
  } else if (clearScene) {
    deleteCachedThemeScene(targetId);
    if (sceneReady) void deleteThemeScene(targetId);
  } else if (preservedScene && !getCachedThemeScene(targetId)) {
    setCachedThemeScene(targetId, preservedScene);
    if (sceneReady) {
      void putThemeScene(targetId, preservedScene).then((stored) => {
        if (!stored) restoreSceneMetadata(targetId, preservedScene);
      });
    }
  }

  const clean: CustomThemeInput = {
    id: targetId,
    sourceId: isSafeThemeId(input.sourceId) ? input.sourceId : undefined,
    tokensDecided: true,
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
    scene: sceneReady ? undefined : storedScene,
    sceneBg: sanitizeSceneBackground(input.sceneBg),
    previewBg: sanitizePreviewBg(input.previewBg),
    sceneStored: sceneReady ? Boolean(storedScene) : false,
    sceneBlur: typeof input.sceneBlur === "number" ? Math.max(0, Math.min(30, input.sceneBlur)) : 0,
    sceneOpacity: typeof input.sceneOpacity === "number" ? Math.max(0.05, Math.min(0.95, input.sceneOpacity)) : undefined,
    radius: input.radius === "sharp" || input.radius === "round" ? input.radius : "default",
    tokens: sanitizeThemeTokens(input.tokens),
    createdAt: input.createdAt || existing?.createdAt || Date.now(),
  };

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
  const item = list.find((entry, idx) => entry.id === id || `${CUSTOM_PREFIX}${idx}` === id);
  if (!item) return null;
  const resolvedId = item.id ?? `${CUSTOM_PREFIX}0`;
  return { ...item, scene: item.scene ?? getCachedThemeScene(resolvedId) };
}

/** Removes a user theme by id. */
export function deleteCustomTheme(id: string): void {
  const list = readCustomInputs().slice();
  const index = list.findIndex((item, idx) => item.id === id || `${CUSTOM_PREFIX}${idx}` === id);
  if (index === -1) return;
  list.splice(index, 1);
  void deleteThemeScene(id);
  writeCustomInputs(list);
}

/**
 * Opens the wallpaper store and moves legacy base64 scenes out of the theme
 * metadata. Safe to call once at startup; false means this environment has no
 * IndexedDB and the legacy records stay untouched.
 */
export async function hydrateThemeScenes(): Promise<boolean> {
  const scenes = await loadThemeScenes();
  if (!scenes) return false;

  const list = readCustomInputs();
  let changed = false;
  for (const item of list) {
    const id = item.id;
    if (!id) continue;
    if (item.scene) {
      const stored = await putThemeScene(id, item.scene);
      if (!stored) continue;
      item.scene = undefined;
      item.sceneStored = true;
      changed = true;
    } else if (item.sceneStored && !scenes.has(id) && !getCachedThemeScene(id)) {
      item.sceneStored = false;
      changed = true;
    }
  }
  if (changed) writeCustomInputs(list);
  customThemeCache = null;
  return true;
}

/** First `#rrggbb` in a value, for gradients that cannot be stored as-is. */
function firstHex(value: string): string | null {
  const match = value.match(/#[0-9a-f]{6}/i);
  return match ? match[0] : null;
}

/** `--surface-1` may be translucent; the editor still wants a solid swatch. */
function surfaceHint(tokens: Record<string, string> | undefined): string | undefined {
  const value = tokens?.["--surface-1"];
  if (!value) return undefined;
  if (HEX.test(value)) return value;
  const match = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (!match) return undefined;
  const parts = [match[1], match[2], match[3]].map((part) => Math.max(0, Math.min(255, Number(part))));
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

/** True when a built-in paints its panels with a translucent surface colour. */
function hasTranslucentSurfaces(tokens: Record<string, string> | undefined): boolean {
  if (!tokens) return false;
  return ["--surface-1", "--surface-2", "--surface-3"].some((key) => {
    const match = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0?\.\d+|1(?:\.0+)?)\s*\)$/i.exec(tokens[key] ?? "");
    return Boolean(match) && Number(match?.[1]) < 1;
  });
}

/**
 * Everything a built-in can hand to the designer or a clone. Token copying
 * alone drops the structural data (`--scene-bg`, the gallery gradient, the
 * glass flag) because it lives outside or inside sanitised token values.
 */
export function builtinThemeInput(sourceId: string): CustomThemeInput {
  const def = themeById(sourceId);
  const tokens = def.tokens;
  const hasAccentLine = Boolean(tokens?.["--line"] && !tokens["--line"].includes("255, 255, 255") && !tokens["--line"].includes("15, 23, 42"));
  return {
    sourceId,
    name: def.name ?? (def.labelKey ? t(def.labelKey) : def.id),
    bg: HEX.test(def.bg) ? def.bg : firstHex(def.bg) ?? "#141418",
    surface: surfaceHint(tokens) ?? (def.surface && HEX.test(def.surface) ? def.surface : undefined),
    accent: HEX.test(def.accent) ? def.accent : firstHex(def.accent) ?? "#7c3aed",
    accentHover: tokens?.["--accent-hover"],
    accent2: tokens?.["--accent-2"],
    glow: tokens?.["--accent-glow"] && tokens["--accent-glow"] !== "none" ? "radiant" : "none",
    cardGlass: hasTranslucentSurfaces(tokens),
    borderStyle: hasAccentLine ? "accent" : "subtle",
    light: def.scheme === "light",
    sceneBg: sanitizeSceneBackground(tokens?.["--scene-bg"]),
    previewBg: sanitizePreviewBg(def.bg),
    radius: tokens?.["--r-sm"] === "0px" ? "sharp" : tokens?.["--r-sm"] === "10px" ? "round" : "default",
    tokens: tokens ? { ...tokens } : undefined,
    createdAt: Date.now(),
  };
}

/** Duplicates any theme (built-in or custom) as a new custom theme. */
export function duplicateTheme(sourceId: string, copySuffix = " Copy"): string {
  const custom = getCustomThemeInput(sourceId);
  if (custom) {
    return saveCustomTheme({
      ...custom,
      id: undefined,
      sourceId: custom.sourceId ?? sourceId,
      name: `${custom.name}${copySuffix}`,
      tokens: custom.tokens ? { ...custom.tokens } : undefined,
      createdAt: Date.now(),
    });
  }

  const source = builtinThemeInput(sourceId);
  return saveCustomTheme({
    ...source,
    name: `${source.name}${copySuffix}`,
    createdAt: Date.now(),
  });
}

/** Current `.efxtheme` schema. Import still accepts v2 files from old builds. */
const THEME_SCHEMA = 3;
/** `.efxpack` package schema. A future version is rejected, not guessed. */
const THEME_PACK_SCHEMA = 1;
const MAX_PACK_THEMES = 100;
const MAX_PACK_BYTES = 30_000_000;

/** Exports a theme definition as a JSON string. */
export function exportThemeJson(id: string): string {
  const custom = getCustomThemeInput(id);
  if (custom) {
    return JSON.stringify(
      {
        efxlve_theme: THEME_SCHEMA,
        name: custom.name,
        author: "User",
        sourceId: custom.sourceId,
        tags: ["custom"],
        bg: custom.bg,
        surface: custom.surface,
        accent: custom.accent,
        accentHover: custom.accentHover,
        accent2: custom.accent2,
        glow: custom.glow ?? "none",
        cardGlass: Boolean(custom.cardGlass),
        borderStyle: custom.borderStyle ?? "subtle",
        light: custom.light,
        scene: sanitizeSceneUrl(custom.scene),
        sceneBg: sanitizeSceneBackground(custom.sceneBg),
        previewBg: sanitizePreviewBg(custom.previewBg),
        sceneBlur: custom.sceneBlur,
        sceneOpacity: custom.sceneOpacity,
        radius: custom.radius,
        tokens: sanitizeThemeTokens(custom.tokens),
        exportedAt: Date.now(),
      },
      null,
      2,
    );
  }

  const def = themeById(id);
  const source = builtinThemeInput(id);
  return JSON.stringify(
    {
      efxlve_theme: THEME_SCHEMA,
      name: source.name,
      tags: def.tags ?? [],
      bg: source.bg,
      surface: source.surface,
      accent: source.accent,
      accentHover: source.accentHover,
      accent2: source.accent2,
      glow: source.glow ?? "none",
      cardGlass: Boolean(source.cardGlass),
      borderStyle: source.borderStyle ?? "subtle",
      light: source.light,
      sceneBg: source.sceneBg,
      previewBg: source.previewBg,
      radius: source.radius,
      tokens: sanitizeThemeTokens(source.tokens),
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
    const schema = Number(parsed.efxlve_theme);
    if (parsed.efxlve_theme !== undefined && schema !== 2 && schema !== THEME_SCHEMA) return null;

    const bg = String(parsed.bg || "");
    const accent = String(parsed.accent || "");
    if (!HEX.test(bg) || !HEX.test(accent)) return null;

    const name = String(parsed.name || "Imported Theme").slice(0, 32);
    const surface = typeof parsed.surface === "string" && HEX.test(parsed.surface) ? parsed.surface : undefined;
    const accentHover = typeof parsed.accentHover === "string" && HEX.test(parsed.accentHover) ? parsed.accentHover : undefined;
    const accent2 = typeof parsed.accent2 === "string" && HEX.test(parsed.accent2) ? parsed.accent2 : undefined;
    const glow =
      parsed.glow === "subtle" || parsed.glow === "radiant" || parsed.glow === "neon"
        ? parsed.glow
        : "none";
    const cardGlass = parsed.cardGlass === true;
    const borderStyle =
      parsed.borderStyle === "contrast" || parsed.borderStyle === "accent"
        ? parsed.borderStyle
        : "subtle";
    const light = parsed.light === true;
    const scene = sanitizeSceneUrl(parsed.scene);
    const sceneBg = sanitizeSceneBackground(parsed.sceneBg);
    const previewBg = sanitizePreviewBg(parsed.previewBg);
    const sceneBlur = typeof parsed.sceneBlur === "number" ? Math.max(0, Math.min(30, parsed.sceneBlur)) : 0;
    const sceneOpacity = typeof parsed.sceneOpacity === "number" ? Math.max(0.05, Math.min(0.95, parsed.sceneOpacity)) : undefined;
    const radius = parsed.radius === "sharp" || parsed.radius === "round" ? parsed.radius : "default";
    const tokens = sanitizeThemeTokens(parsed.tokens);

    const id = saveCustomTheme({
      name,
      bg,
      surface,
      accent,
      accentHover,
      accent2,
      glow,
      cardGlass,
      borderStyle,
      light,
      scene,
      sceneBg,
      previewBg,
      sceneBlur,
      sceneOpacity,
      radius,
      tokens,
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

export interface ThemePackExport {
  json: string;
  count: number;
}

export interface ThemePackImport {
  imported: number;
  failed: number;
  names: string[];
}

/**
 * Packages every custom theme. Scenes live in a package-level `assets` map and
 * each manifest points at one with `asset:<id>`, so the same wallpaper is
 * stored once even when several themes share it.
 */
export function exportThemePack(): ThemePackExport | null {
  const list = customThemes();
  if (list.length === 0) return null;

  const assets: Record<string, string> = {};
  const assetIds = new Map<string, string>();
  let nextAsset = 1;
  const manifests = list.map((theme) => {
    const manifest = JSON.parse(exportThemeJson(theme.id)) as Record<string, unknown>;
    const scene = typeof manifest.scene === "string" ? sanitizeSceneUrl(manifest.scene) : undefined;
    if (scene) {
      let assetId = assetIds.get(scene);
      if (!assetId) {
        assetId = `scene-${nextAsset}`;
        nextAsset += 1;
        assetIds.set(scene, assetId);
        assets[assetId] = scene;
      }
      manifest.scene = `asset:${assetId}`;
    } else {
      delete manifest.scene;
    }
    return manifest;
  });

  return {
    json: JSON.stringify(
      {
        efxlve_pack: THEME_PACK_SCHEMA,
        name: "Efxlve theme pack",
        exportedAt: Date.now(),
        themes: manifests,
        assets,
      },
      null,
      2,
    ),
    count: manifests.length,
  };
}

/** Imports a `.efxpack`, continuing past invalid entries and resolving assets. */
export function importThemePack(jsonStr: string): ThemePackImport | null {
  if (typeof jsonStr !== "string" || jsonStr.length > MAX_PACK_BYTES) return null;
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (Number(parsed.efxlve_pack) !== THEME_PACK_SCHEMA) return null;

    const themes = parsed.themes;
    if (!Array.isArray(themes) || themes.length === 0 || themes.length > MAX_PACK_THEMES) return null;

    const rawAssets =
      parsed.assets && typeof parsed.assets === "object" && !Array.isArray(parsed.assets)
        ? (parsed.assets as Record<string, unknown>)
        : {};
    if (Object.keys(rawAssets).length > MAX_PACK_THEMES * 2) return null;

    const assets = new Map<string, string>();
    for (const [key, value] of Object.entries(rawAssets)) {
      if (typeof value === "string" && value.length < 2_000_000) assets.set(key, value);
    }

    let imported = 0;
    let failed = 0;
    const names: string[] = [];
    for (const item of themes) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        failed += 1;
        continue;
      }
      const manifest = { ...(item as Record<string, unknown>) };
      if (typeof manifest.scene === "string" && manifest.scene.startsWith("asset:")) {
        const assetId = manifest.scene.slice("asset:".length);
        const data = assets.get(assetId);
        if (data) manifest.scene = data;
        else delete manifest.scene;
      }
      const saved = importThemeJson(JSON.stringify(manifest));
      if (saved) {
        imported += 1;
        names.push(saved.name);
      } else {
        failed += 1;
      }
    }
    return { imported, failed, names };
  } catch {
    return null;
  }
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
 * Writes a theme to the document without storing it. The theme's tokens and
 * generated scene rules replace the previous rule set on every call.
 */
function paintTheme(theme: ThemeDef): void {
  const root = document.documentElement;
  // Black is the base palette in `tokens.css`: it needs no attribute.
  if (theme.id === DEFAULT_THEME) delete root.dataset.surface;
  else root.dataset.surface = theme.id;
  root.dataset.scheme = theme.scheme;

  const tokens = theme.custom || theme.customInput ? sanitizeThemeTokens(theme.tokens) : theme.tokens;
  const body = Object.entries(tokens ?? {})
    .map(([name, value]) => `${name}: ${value};`)
    .join("");

  // A user theme can carry a backdrop image; its rules are generated with the
  // theme, so the CSS files stay free of per-user selectors.
  const custom = theme.customInput ?? getCustomThemeInput(theme.id);
  const scene = custom ? sceneRules(theme.id, custom) : "";
  const selector = `:root[data-surface="${cssEscape(theme.id)}"]`;

  tokenStyle().textContent = body || scene
    ? `${body ? `${selector}{${body}}` : ""}${scene ? `\n${scene}` : ""}`
    : "";
  root.style.colorScheme = theme.scheme;
}

/** The id the designer paints while its draft is on screen. Never stored. */
const PREVIEW_THEME_ID = "custom-preview";

/**
 * Paints an unsaved draft, so "Test in App" shows the real shell instead of
 * writing a throwaway theme to the user's list. Closing the designer calls
 * `applySurface(S.surface, false)` and restores the previous look.
 */
export function previewCustomTheme(input: CustomThemeInput): void {
  if (isTauri && HEX.test(input.bg)) {
    void invoke("app_set_background_color", { color: input.bg }).catch(() => undefined);
  }
  paintTheme({
    id: PREVIEW_THEME_ID,
    labelKey: "",
    name: input.name,
    bg: input.bg,
    surface: input.surface,
    accent: input.accent,
    scheme: input.light ? "light" : "dark",
    tokens: customTokens(input),
    custom: true,
    scene: sanitizeSceneUrl(input.scene),
    sceneBlur: input.sceneBlur,
    sceneOpacity: input.sceneOpacity,
    radius: input.radius,
    customInput: input,
  });
}

/**
 * Fires after `applySurface` paints a theme. The achievement card uses it to
 * repaint its native palette from the new tokens.
 */
export const SURFACE_APPLIED_EVENT = "efxlve:surface-applied";

/**
 * The boot script in index.html cannot import the registry. A tiny snapshot of
 * the applied theme paints the first frame without hard-coding theme ids.
 */
function writeBootSnapshot(theme: ThemeDef): void {
  try {
    const tokens = theme.custom ? sanitizeThemeTokens(theme.tokens) : theme.tokens;
    const tokenBg = tokens?.["--bg"];
    const bg = tokenBg ?? BOOT_BG[theme.id] ?? (HEX.test(theme.bg) ? theme.bg : theme.scheme === "light" ? "#f3f4f6" : "#000000");
    const snapshot = {
      id: theme.id,
      scheme: theme.scheme,
      bg,
      tokens,
      labelKey: theme.labelKey,
      name: theme.name,
      accent: theme.accent,
      surface: theme.surface,
      tags: theme.tags,
    };
    localStorage.setItem(BOOT_THEME_KEY, JSON.stringify(snapshot));
    bootSnapshotRaw = null;
    bootSnapshotCache = null;
    if (isTauri && HEX.test(bg)) {
      void invoke("app_set_background_color", { color: bg }).catch(() => undefined);
    }
  } catch {
    /* private mode: the boot script falls back to black */
  }
}

/**
 * Applies a theme and remembers it. Returns the id that was applied, so the
 * caller can store `S.surface` without a second lookup.
 */
export function applySurface(id: string, persist = true): string {
  const theme = themeById(normalizeSurface(id));
  paintTheme(theme);
  writeBootSnapshot(theme);

  if (persist) {
    try {
      localStorage.setItem(SURFACE_KEY, theme.id);
    } catch {
      /* private mode: the theme still applies for this session */
    }
  }
  window.dispatchEvent(new CustomEvent(SURFACE_APPLIED_EVENT, { detail: theme.id }));
  return theme.id;
}

/** Compact authoring helper for new built-in palettes. */

import type { CustomThemeInput, ThemeDef } from "./types";
import { customTokens } from "./tokens";

export interface ThemeRecipe extends Omit<CustomThemeInput, "name"> {
  id: string;
  labelKey?: string;
  name?: string;
  tags?: readonly string[];
}

/**
 * Builds a colour theme from a small palette. New themes should use this
 * instead of copying a thirty-line token table; a theme that needs a unique
 * component shape still gets a `[data-surface]` block in themes.css.
 */
export function defineTheme(recipe: ThemeRecipe): ThemeDef {
  const { id, labelKey = "", name, tags, ...input } = recipe;
  return {
    id,
    labelKey,
    name,
    tags,
    bg: input.bg,
    surface: input.surface,
    accent: input.accent,
    scheme: input.light ? "light" : "dark",
    tokens: customTokens({ ...input, name: name ?? id }),
    scene: input.scene,
    sceneBlur: input.sceneBlur,
    sceneOpacity: input.sceneOpacity,
    radius: input.radius,
  };
}

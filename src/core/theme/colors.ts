/**
 * Accent colour families for the theme gallery filter.
 *
 * A family is derived from the accent hue, not from tags or theme names, so a
 * custom theme lands in the same group as a built-in with the same accent.
 * Near-grey, near-black and near-white accents have no usable hue and fall
 * into `neutral`.
 */

import type { ThemeDef } from "./types";

export type ThemeColorFamily =
  | "neutral"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "purple"
  | "pink";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Hue-only buckets, in degrees. */
const HUE_RANGES: readonly { family: ThemeColorFamily; from: number; to: number }[] = [
  { family: "red", from: 342, to: 360 },
  { family: "red", from: 0, to: 12 },
  { family: "orange", from: 12, to: 42 },
  { family: "yellow", from: 42, to: 70 },
  { family: "green", from: 70, to: 168 },
  { family: "cyan", from: 168, to: 195 },
  { family: "blue", from: 195, to: 252 },
  { family: "purple", from: 252, to: 290 },
  { family: "pink", from: 290, to: 342 },
];

function channels(value: string): [number, number, number] | null {
  const raw = value.trim();
  if (!HEX.test(raw)) return null;
  const hex = raw.slice(1);
  if (hex.length === 3) {
    const [r, g, b] = hex;
    return [parseInt(`${r}${r}`, 16), parseInt(`${g}${g}`, 16), parseInt(`${b}${b}`, 16)];
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** Classifies one CSS colour value; anything that is not a hex colour is neutral. */
export function colorFamilyOf(accent: string | undefined): ThemeColorFamily {
  const rgb = accent ? channels(accent) : null;
  if (!rgb) return "neutral";

  const [r, g, b] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;

  // White, black, grey and tints too faint to read as a colour. The absolute
  // chroma check catches near-black hues whose HSL saturation looks high.
  if (delta < 0.1 || lightness <= 0.06 || lightness >= 0.94) return "neutral";
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  if (saturation < 0.15) return "neutral";

  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;

  return HUE_RANGES.find((range) => hue >= range.from && hue < range.to)?.family ?? "neutral";
}

/**
 * The family for a theme. A theme's `accent` is the swatch the gallery shows,
 * but an older imported theme can lose it; its token table is the fallback.
 */
export function themeColorFamily(theme: Pick<ThemeDef, "accent" | "tokens">): ThemeColorFamily {
  if (HEX.test(theme.accent?.trim() ?? "")) return colorFamilyOf(theme.accent);
  return colorFamilyOf(theme.tokens?.["--accent"]);
}

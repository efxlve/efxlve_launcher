/**
 * Palette of the native in-game achievement card.
 *
 * The card is painted by Win32 GDI in `overlay/hud.rs`, which cannot read CSS.
 * The frontend therefore resolves the active theme's tokens to plain hex and
 * pushes them once at boot and after every theme change, so the native card and
 * the Settings preview always show the same colours.
 */

import type { AchievementCardColors } from "../steam";
import { achievementSetNotificationColors } from "../steam";
import { isTauri } from "./constants";
import { S } from "./state";
import { SURFACE_APPLIED_EVENT } from "./themes";

/** The built-in console card: warm gold on smoked obsidian. */
export const GOLD_ACHIEVEMENT_CARD: AchievementCardColors = {
  background: "#0d0f14",
  accent: "#f59e0b",
  border: "#785018",
  icon: "#fbbf24",
  title: "#ffffff",
  body: "#acb2b8",
};

type Rgba = [number, number, number, number];

/** Reads `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` values. */
function readColor(value: string): Rgba | null {
  const text = value.trim();
  if (!text) return null;
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (hex.length === 3) {
      const channels = hex.split("").map((digit) => Number.parseInt(digit + digit, 16));
      return [channels[0], channels[1], channels[2], 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      const channels = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
      if (channels.some(Number.isNaN)) return null;
      const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return [channels[0], channels[1], channels[2], alpha];
    }
    return null;
  }
  const match = text.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2], parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1];
}

/** Composites a possibly translucent colour over an opaque base. */
function over(top: Rgba | null, base: Rgba): Rgba {
  if (!top) return base;
  const alpha = Math.min(1, Math.max(0, top[3]));
  return [
    Math.round(top[0] * alpha + base[0] * (1 - alpha)),
    Math.round(top[1] * alpha + base[1] * (1 - alpha)),
    Math.round(top[2] * alpha + base[2] * (1 - alpha)),
    1,
  ];
}

function toHex(color: Rgba): string {
  const channel = (value: number) =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

/**
 * Resolves the selected mode against the live CSS tokens. The card palette is
 * opaque because GDI brushes have no alpha; translucent theme tokens are
 * flattened over the plate first.
 */
export function achievementCardPalette(cardTheme: string): AchievementCardColors {
  if (cardTheme !== "launcher" || typeof document === "undefined") {
    return GOLD_ACHIEVEMENT_CARD;
  }
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => readColor(styles.getPropertyValue(name));
  const black: Rgba = [0, 0, 0, 1];
  const bg = over(token("--bg"), black);
  const surface = over(token("--surface-1"), bg);
  const accent = over(token("--accent"), surface);
  return {
    background: toHex(surface),
    accent: toHex(accent),
    // A 45% accent hairline reads the same weight as the gold card's bronze.
    border: toHex(over([accent[0], accent[1], accent[2], 0.45], surface)),
    icon: toHex(over(token("--accent-hover"), accent)),
    title: toHex(over(token("--text"), surface)),
    body: toHex(over(token("--text-2"), surface)),
  };
}

/** Pushes the palette for the current mode to the native card. */
export function syncAchievementCardTheme(): void {
  if (!isTauri) return;
  const palette = achievementCardPalette(S.achievementNotificationOptions.cardTheme);
  void achievementSetNotificationColors(palette).catch(() => {});
}

// A theme change repaints the shell; the native card has to follow it too.
if (typeof window !== "undefined") {
  window.addEventListener(SURFACE_APPLIED_EVENT, () => syncAchievementCardTheme());
}

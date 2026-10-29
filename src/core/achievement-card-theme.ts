/**
 * Palette of the achievement card.
 *
 * The Settings preview and the in-game toast share one component, so most
 * themes are plain constants resolved here. The "launcher" theme follows the
 * live CSS tokens, which only the main window can read: it is resolved here and
 * pushed to Rust at boot and after every theme change, then travels in the
 * toast payload.
 */

import type { AchievementCardColors } from "../steam";
import { achievementSetNotificationColors } from "../steam";
import { isTauri } from "./constants";
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

export const CYBER_ACHIEVEMENT_CARD: AchievementCardColors = {
  background: "#090b16",
  accent: "#00f0ff",
  border: "#0e7490",
  icon: "#38bdf8",
  title: "#f8fafc",
  body: "#94a3b8",
};

export const EMERALD_ACHIEVEMENT_CARD: AchievementCardColors = {
  background: "#08120e",
  accent: "#10b981",
  border: "#047857",
  icon: "#34d399",
  title: "#f8fafc",
  body: "#a7f3d0",
};

export const CRIMSON_ACHIEVEMENT_CARD: AchievementCardColors = {
  background: "#13090c",
  accent: "#f43f5e",
  border: "#be123c",
  icon: "#fb7185",
  title: "#fff1f2",
  body: "#fda4af",
};

export const AMETHYST_ACHIEVEMENT_CARD: AchievementCardColors = {
  background: "#0f0918",
  accent: "#a855f7",
  border: "#6b21a8",
  icon: "#c084fc",
  title: "#faf5ff",
  body: "#d8b4fe",
};

export function rarityCardPalette(tier = 2): AchievementCardColors {
  switch (tier) {
    case 0:
      return {
        background: "#110d0b",
        accent: "#cd7f32",
        border: "#7c471c",
        icon: "#e09f5a",
        title: "#ffffff",
        body: "#cbb8a8",
      };
    case 1:
      return {
        background: "#0d1015",
        accent: "#94a3b8",
        border: "#475569",
        icon: "#e2e8f0",
        title: "#ffffff",
        body: "#cbd5e1",
      };
    case 3:
      return {
        background: "#08101d",
        accent: "#22d3ee",
        border: "#0284c7",
        icon: "#67e8f9",
        title: "#f0f9ff",
        body: "#bae6fd",
      };
    case 4:
      return {
        background: "#110c1d",
        accent: "#e879f9",
        border: "#9333ea",
        icon: "#f5d0fe",
        title: "#ffffff",
        body: "#f3e8ff",
      };
    default:
      return GOLD_ACHIEVEMENT_CARD;
  }
}

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
 * Resolves the selected mode against the live CSS tokens. Translucent theme
 * tokens are flattened over the plate so the toast and the preview agree.
 */
export function achievementCardPalette(cardTheme: string, rarityTier = 2): AchievementCardColors {
  switch (cardTheme) {
    case "gold":
      return GOLD_ACHIEVEMENT_CARD;
    case "cyber":
      return CYBER_ACHIEVEMENT_CARD;
    case "emerald":
      return EMERALD_ACHIEVEMENT_CARD;
    case "crimson":
      return CRIMSON_ACHIEVEMENT_CARD;
    case "amethyst":
      return AMETHYST_ACHIEVEMENT_CARD;
    case "rarity":
      return rarityCardPalette(rarityTier);
    case "launcher": {
      if (typeof document === "undefined") {
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
    default:
      return rarityCardPalette(rarityTier);
  }
}

/** Pushes the `launcher` palette to Rust for the in-game toast. */
export function syncAchievementCardTheme(): void {
  if (!isTauri) return;
  const palette = achievementCardPalette("launcher");
  void achievementSetNotificationColors(palette).catch(() => {});
}

// A theme change repaints the shell; the native card has to follow it too.
if (typeof window !== "undefined") {
  window.addEventListener(SURFACE_APPLIED_EVENT, () => syncAchievementCardTheme());
}

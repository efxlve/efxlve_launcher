/** Colour maths and token derivation for built-in and user themes. */

import type { CustomThemeInput } from "./types";

export const HEX = /^#[0-9a-f]{6}$/i;

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

/** WCAG relative contrast between two `#rrggbb` colours. */
export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Turns colours into the full token set.
 * If surface is explicitly provided, it derives elevation from it;
 * otherwise it generates harmonious surfaces from the background.
 */
export function customTokens(input: CustomThemeInput): Record<string, string> {
  // 0.18 is the luminance where black text starts to beat white text on the
  // accent. A plain "is it bright" check left white text on hot pink and cyan.
  const onAccent = luminance(input.accent) > 0.18 ? "#101318" : "#ffffff";
  const glass = Boolean(input.scene) || input.cardGlass === true;
  const baseSurface = input.surface && HEX.test(input.surface) ? input.surface : null;

  const rXs = input.radius === "sharp" ? "0px" : input.radius === "round" ? "6px" : "3px";
  const rSm = input.radius === "sharp" ? "0px" : input.radius === "round" ? "10px" : "6px";
  const rMd = input.radius === "sharp" ? "0px" : input.radius === "round" ? "16px" : "10px";
  const rLg = input.radius === "sharp" ? "0px" : input.radius === "round" ? "20px" : "14px";
  const rPill = input.radius === "sharp" ? "0px" : "999px";

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
      "--scrollbar-thumb": "rgba(15, 23, 42, 0.32)",
      "--scrollbar-thumb-hover": "rgba(15, 23, 42, 0.55)",
      "--r-xs": rXs,
      "--r-sm": rSm,
      "--r-md": rMd,
      "--r-lg": rLg,
      "--r-pill": rPill,
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
    "--text-2": mix("#f7f7fa", input.bg, 0.38),
    "--text-3": mix("#f7f7fa", input.bg, 0.58),
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
    "--scrollbar-thumb": input.borderStyle === "accent" ? rgba(input.accent, 0.45) : "rgba(255, 255, 255, 0.28)",
    "--scrollbar-thumb-hover": input.borderStyle === "accent" ? (input.accentHover ?? input.accent) : "rgba(255, 255, 255, 0.55)",
    "--r-xs": rXs,
    "--r-sm": rSm,
    "--r-md": rMd,
    "--r-lg": rLg,
    "--r-pill": rPill,
  };
}

/** The scene rules for a user theme: photo on the shell, glass panels above. */

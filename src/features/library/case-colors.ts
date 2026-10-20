import type { GameSource } from "../../core/types";
import { CASE_STORE_COLORS_KEY } from "../../core/constants";
import { S } from "../../core/state";

export const DEFAULT_STORE_COLORS: Record<GameSource, string> = {
  steam: "#2b63eb",
  epic: "#323640",
  gog: "#7b2cbf",
  xbox: "#168a16",
  ea: "#d62839",
  ubisoft: "#00b4d8",
  battlenet: "#0084f4",
  riot: "#c91e29",
  amazon: "#cc7a14",
};

export const CASE_STORES: readonly GameSource[] = [
  "steam",
  "epic",
  "gog",
  "xbox",
  "ea",
  "ubisoft",
  "battlenet",
  "riot",
  "amazon",
];

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  if (isNaN(num)) return [50, 54, 64];
  if (clean.length === 3) {
    const r = (num >> 8) & 0xf;
    const g = (num >> 4) & 0xf;
    const b = num & 0xf;
    return [r * 17, g * 17, b * 17];
  }
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

export function generateStoreCaseCss(store: string, hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const mid = `rgb(${Math.round(r * 0.72)}, ${Math.round(g * 0.72)}, ${Math.round(b * 0.72)})`;
  const bot = `rgb(${Math.round(r * 0.45)}, ${Math.round(g * 0.45)}, ${Math.round(b * 0.45)})`;
  const border = `rgb(${Math.min(255, Math.round(r * 1.35 + 20))}, ${Math.min(255, Math.round(g * 1.35 + 20))}, ${Math.min(255, Math.round(b * 1.35 + 20))})`;
  const headStart = `rgba(${r}, ${g}, ${b}, 0.85)`;
  const headMid = `rgba(${Math.round(r * 0.45)}, ${Math.round(g * 0.45)}, ${Math.round(b * 0.45)}, 0.95)`;
  const headEnd = `rgba(${Math.round(r * 0.2)}, ${Math.round(g * 0.2)}, ${Math.round(b * 0.2)}, 0.98)`;
  const rule = `rgb(${Math.min(255, Math.round(r * 1.45 + 30))}, ${Math.min(255, Math.round(g * 1.45 + 30))}, ${Math.min(255, Math.round(b * 1.45 + 30))})`;
  const tint = `rgba(${r}, ${g}, ${b}, 0.34)`;

  return `
.pcard.is-case[data-case-color="store"][data-source="${store}"],
.pcard.is-case:not([data-case-color])[data-source="${store}"] {
  --case-shell-top: ${hex} !important;
  --case-shell-mid: ${mid} !important;
  --case-shell-bot: ${bot} !important;
  --case-border: ${border} !important;
  --case-head-bg: linear-gradient(90deg, ${headStart} 0%, ${headMid} 55%, ${headEnd} 100%) !important;
  --case-rule: ${rule} !important;
  --case-tint: ${tint} !important;
}`;
}

export function syncCaseCustomStoreColors(): void {
  if (typeof document === "undefined") return;
  let styleEl = document.getElementById("case-custom-store-colors") as HTMLStyleElement | null;
  const colors = S.caseStoreColors || {};
  const entries = Object.entries(colors).filter(([_, hex]) => typeof hex === "string" && /^#[0-9a-fA-F]{3,8}$/.test(hex));
  if (entries.length === 0) {
    if (styleEl) styleEl.textContent = "";
    return;
  }
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "case-custom-store-colors";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = entries.map(([store, hex]) => generateStoreCaseCss(store, hex)).join("\n");
}

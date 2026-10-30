import { invoke } from "@tauri-apps/api/core";

/** The external crosshair's saved settings. Rust clamps every field again. */
export type CrosshairShape = "dot" | "cross" | "circle" | "t";

/** The fixed combinations the native listener understands. */
export type CrosshairHotkey =
  | "Ctrl+Shift+X"
  | "Ctrl+Shift+C"
  | "Ctrl+Alt+X"
  | "Ctrl+Alt+C"
  | "F8"
  | "F9";

export interface CrosshairConfig {
  enabled: boolean;
  shape: CrosshairShape;
  /** #rrggbb. */
  color: string;
  /** Full span in pixels. */
  size: number;
  /** Space left open in the middle of the arms. */
  gap: number;
  /** Line width of the arms. */
  thickness: number;
  /** 0.1 to 1. */
  opacity: number;
  /** Global toggle combination. */
  hotkey: CrosshairHotkey;
}

export const CROSSHAIR_HOTKEYS: CrosshairHotkey[] = [
  "Ctrl+Shift+X",
  "Ctrl+Shift+C",
  "Ctrl+Alt+X",
  "Ctrl+Alt+C",
  "F8",
  "F9",
];

const KEY = "efxlve-overlay-crosshair";

export const DEFAULT_CROSSHAIR: CrosshairConfig = {
  enabled: false,
  shape: "cross",
  color: "#ffffff",
  size: 24,
  gap: 4,
  thickness: 2,
  opacity: 0.9,
  hotkey: "Ctrl+Shift+X",
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

/** Clamps a stored object (global or per-game) into a usable configuration. */
export function sanitizeCrosshair(parsed: Partial<CrosshairConfig>): CrosshairConfig {
  const shape = parsed.shape;
  return {
    enabled: parsed.enabled === true,
    shape: shape === "dot" || shape === "cross" || shape === "circle" || shape === "t"
      ? shape
      : DEFAULT_CROSSHAIR.shape,
    color: typeof parsed.color === "string" && /^#[0-9a-fA-F]{6}$/.test(parsed.color)
      ? parsed.color
      : DEFAULT_CROSSHAIR.color,
    size: clampNumber(parsed.size, 8, 64, DEFAULT_CROSSHAIR.size),
    gap: clampNumber(parsed.gap, 0, 16, DEFAULT_CROSSHAIR.gap),
    thickness: clampNumber(parsed.thickness, 1, 5, DEFAULT_CROSSHAIR.thickness),
    opacity: clampNumber(parsed.opacity, 0.1, 1, DEFAULT_CROSSHAIR.opacity),
    hotkey: CROSSHAIR_HOTKEYS.includes(parsed.hotkey as CrosshairHotkey)
      ? (parsed.hotkey as CrosshairHotkey)
      : DEFAULT_CROSSHAIR.hotkey,
  };
}

export function loadCrosshair(): CrosshairConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CROSSHAIR };
    return sanitizeCrosshair(JSON.parse(raw) as Partial<CrosshairConfig>);
  } catch {
    return { ...DEFAULT_CROSSHAIR };
  }
}

export function saveCrosshair(config: CrosshairConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config));
}

/** Pushes the saved settings to the native window. Does not change visibility. */
export function applyCrosshairConfig(config: CrosshairConfig = loadCrosshair()): void {
  void invoke("overlay_crosshair_configure", { config }).catch(() => undefined);
}

/** The Settings toggle and the hotkey both end up in the same native state. */
export function setCrosshairVisible(visible: boolean): void {
  void invoke("overlay_crosshair_set_visible", { visible }).catch(() => undefined);
}

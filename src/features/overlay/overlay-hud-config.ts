/**
 * Native performance HUD appearance: the persisted mode, corner and text
 * colour, plus the bridge that pushes the choice to the Rust HUD window.
 *
 * One-way dependency: this module only talks to localStorage and Tauri; the
 * overlay page imports it, never the other way around.
 */

import { invoke } from "@tauri-apps/api/core";

export type HudMode = "minimal" | "compact" | "full";
export type HudCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface HudConfig {
  mode: HudMode;
  corner: HudCorner;
  color: string;
}

const HUD_MODE_KEY = "efxlve-overlay-hud-mode";
const HUD_CORNER_KEY = "efxlve-overlay-hud-corner";
const HUD_COLOR_KEY = "efxlve-overlay-hud-color";

export function loadHudConfig(): HudConfig {
  const mode = localStorage.getItem(HUD_MODE_KEY);
  const corner = localStorage.getItem(HUD_CORNER_KEY);
  const color = localStorage.getItem(HUD_COLOR_KEY) ?? "";
  return {
    mode: mode === "minimal" || mode === "full" ? mode : "compact",
    corner:
      corner === "top-right" || corner === "bottom-left" || corner === "bottom-right"
        ? corner
        : "top-left",
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#f2f2f2",
  };
}

export function saveHudConfig(config: HudConfig): void {
  localStorage.setItem(HUD_MODE_KEY, config.mode);
  localStorage.setItem(HUD_CORNER_KEY, config.corner);
  localStorage.setItem(HUD_COLOR_KEY, config.color);
}

export function applyHudConfig(config: HudConfig = loadHudConfig()): void {
  void invoke("overlay_set_hud_config", { config }).catch(() => undefined);
}

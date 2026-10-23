/**
 * Per-game completion status. This is a personal label, not a store field:
 * it lives in localStorage and never changes a game file or a store manifest.
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { GAME_STATUS_KEY, UI_SCALE_KEY, isTauri } from "./constants";

export type GameStatus = "playing" | "completed" | "onhold" | "dropped";

const VALID: readonly GameStatus[] = ["playing", "completed", "onhold", "dropped"];

export function isGameStatus(value: unknown): value is GameStatus {
  return typeof value === "string" && (VALID as readonly string[]).includes(value);
}

export function loadGameStatus(): Map<string, GameStatus> {
  try {
    const parsed = JSON.parse(localStorage.getItem(GAME_STATUS_KEY) || "{}") as Record<string, unknown>;
    const map = new Map<string, GameStatus>();
    for (const [appName, status] of Object.entries(parsed)) {
      if (isGameStatus(status)) map.set(appName, status);
    }
    return map;
  } catch {
    return new Map();
  }
}

export function saveGameStatus(map: Map<string, GameStatus>): void {
  try {
    localStorage.setItem(GAME_STATUS_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* Storage can be full; the status still lives for this session. */
  }
}

export function loadUiScale(): number {
  const raw = Number(localStorage.getItem(UI_SCALE_KEY));
  return [80, 90, 100, 110, 125, 150].includes(raw) ? raw : 100;
}

export async function applyUiScale(scale: number): Promise<void> {
  document.documentElement.dataset.uiScale = String(scale);
  if (isTauri) {
    try {
      await getCurrentWebview().setZoom(scale / 100);
      delete document.documentElement.dataset.uiFallback;
      return;
    } catch {
      /* Fall through to CSS zoom when the capability is unavailable. */
    }
  }
  document.documentElement.dataset.uiFallback = "1";
  document.documentElement.style.setProperty("--ui-scale", String(scale / 100));
}

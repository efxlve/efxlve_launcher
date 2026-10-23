/**
 * Interface effects switch.
 *
 * The layout and every feature stay the same; only motion, glass blur and
 * hover transitions are removed. Defaults to the operating system's
 * "reduce motion" preference until the user makes an explicit choice.
 */

import { REDUCE_EFFECTS_KEY } from "./constants";

export function systemReducesMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function initialReduceEffects(): boolean {
  const saved = localStorage.getItem(REDUCE_EFFECTS_KEY);
  if (saved === "true") return true;
  if (saved === "false") return false;
  return systemReducesMotion();
}

export function applyReduceEffects(enabled: boolean): void {
  document.documentElement.classList.toggle("reduce-effects", enabled);
} 

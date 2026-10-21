/**
 * Launcher application icon state and DOM synchronization.
 */

import classicIcon from "../assets/icons/classic.png";
import aeroIcon from "../assets/icons/aero.png";
import { S } from "./state";

export { classicIcon, aeroIcon };

export function getActiveAppIconUrl(): string {
  if (S.appIcon === "custom" && S.customAppIcon) {
    return S.customAppIcon;
  }
  if (S.appIcon === "aero") {
    return aeroIcon;
  }
  return classicIcon;
}

export function applyWinbarAppIcon(): void {
  const el = document.getElementById("winbar-icon") as HTMLImageElement | null;
  if (!el) return;
  const url = getActiveAppIconUrl();
  if (el.src !== url) {
    el.src = url;
  }
  el.style.display = "inline-block";
}

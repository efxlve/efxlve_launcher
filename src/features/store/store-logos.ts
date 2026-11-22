/**
 * Store logo assets, keyed by storefront id.
 *
 * Vite hashes these at build time, so the paths are bundled with the app and the
 * cards never depend on the network. The marks belong to their owners and are used
 * for identification only (see src/assets/stores/README.md and Settings → About).
 */

import epic from "../../assets/stores/epic.png";
import gog from "../../assets/stores/gog.png";
import steam from "../../assets/stores/steam.png";
import ea from "../../assets/stores/ea.png";
import ubisoft from "../../assets/stores/ubisoft.png";
import xbox from "../../assets/stores/xbox.png";
import battlenet from "../../assets/stores/battlenet.png";
import riot from "../../assets/stores/riot.png";
import luna from "../../assets/stores/luna.png";
import discord from "../../assets/stores/discord.png";
import spotify from "../../assets/stores/spotify.png";
import type { StoreId } from "./store-view";
import { icon, type IconName } from "../../core/icons";
import { esc } from "../../core/utils";

export const STORE_LOGOS: Record<StoreId, string> = {
  epic,
  gog,
  steam,
  battlenet,
  ubisoft,
  ea,
  xbox,
  luna,
};

/** Marks for services that are not storefronts (the Accounts page uses them). */
const EXTRA_LOGOS: Record<string, string> = { ea, ubisoft, xbox, battlenet, riot, discord, spotify };

// Amazon uses the same gaming mark for Amazon Games and Luna, so one asset
// identifies both rows.
EXTRA_LOGOS.amazon = luna;
EXTRA_LOGOS.origin = ea;
EXTRA_LOGOS.uplay = ubisoft;
EXTRA_LOGOS.blizzard = battlenet;

/** Asset URL of a store/launcher mark, or null when the id has none. */
export function storeLogoUrl(id: string): string | null {
  return STORE_LOGOS[id as StoreId] || EXTRA_LOGOS[id] || null;
}

/** The name's first character as a fallback mark. */
function letterMark(label: string, size: number, className: string): string {
  const letter = (Array.from(label.trim())[0] ?? "").toUpperCase();
  if (!letter) return "";
  const font = Math.max(8, Math.round(size * 0.55));
  const cls = className ? `${className} ` : "";
  return `<span class="${cls}store-mark-fallback" style="width:${size}px;height:${size}px;font-size:${font}px" aria-hidden="true">${esc(letter)}</span>`;
}

/**
 * An image icon. The letter sits underneath until the image loads, so a store
 * whose favicon disappears still shows a tab mark instead of a broken image.
 */
function imageMark(src: string, size: number, className: string, mono: boolean, label: string): string {
  const fallback = letterMark(label, size, "");
  return `<span class="${className} store-icon-wrap" style="width:${size}px;height:${size}px">${fallback}<img class="store-custom-icon${mono ? " store-icon-mono" : ""}" src="${esc(src)}" alt="" draggable="false" decoding="async" onload="this.previousElementSibling?.remove()" onerror="this.remove()" /></span>`;
}

/**
 * Logo markup for a store card. A user-added store can carry a line glyph, an
 * uploaded image or its site's favicon; without one it shows its first letter.
 */
export function storeLogo(id: string, size = 24, className = "acc-store-logo", label = "", storeIcon = ""): string {
  // Custom games have no storefront mark; a gamepad keeps their rows from
  // rendering a blank icon slot.
  if (id === "custom") return icon("gamepad-2", size, className);
  const src = storeLogoUrl(id);
  if (src) return `<img class="${className}" src="${src}" width="${size}" height="${size}" alt="" draggable="false" />`;
  if (storeIcon.startsWith("lucide:")) {
    return icon(storeIcon.slice("lucide:".length) as IconName, size, className);
  }
  if (storeIcon) {
    // Remote favicons are tinted white to sit next to the bundled marks; an
    // uploaded image keeps the colours the user chose.
    return imageMark(storeIcon, size, className, /^https?:\/\//i.test(storeIcon), label);
  }
  return letterMark(label, size, className);
}

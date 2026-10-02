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
import discord from "../../assets/stores/discord.png";
import spotify from "../../assets/stores/spotify.png";
import type { StoreId } from "./store-view";

export const STORE_LOGOS: Record<StoreId, string> = {
  epic,
  gog,
  steam,
  battlenet,
  ubisoft,
  ea,
  xbox,
  riot,
};

/** Marks for services that are not storefronts (the Accounts page uses them). */
const EXTRA_LOGOS: Record<string, string> = { ea, ubisoft, xbox, battlenet, riot, discord, spotify };

/** Logo markup for a store card. */
export function storeLogo(id: string, size = 24, className = "acc-store-logo"): string {
  const src = STORE_LOGOS[id as StoreId] || EXTRA_LOGOS[id];
  if (!src) return "";
  return `<img class="${className}" src="${src}" width="${size}" height="${size}" alt="" draggable="false" />`;
}

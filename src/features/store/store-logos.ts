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
import type { StoreId } from "./store-view";

export const STORE_LOGOS: Record<StoreId, string> = {
  epic,
  gog,
  steam,
};

/** Logo markup for a store card. Companion clients have no mark here yet. */
export function storeLogo(id: string, size = 24): string {
  if (id !== "epic" && id !== "gog" && id !== "steam") return "";
  return `<img class="acc-store-logo" src="${STORE_LOGOS[id]}" width="${size}" height="${size}" alt="" draggable="false" />`;
}

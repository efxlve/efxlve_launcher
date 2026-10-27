import { fetchAndRenderAchievements } from "../drawer/drawer-view";
import { isTauri } from "../../core/constants";
import { S } from "../../core/state";
import { setCustomSummaries } from "../../core/selectors";
import { openEpicModal, scheduleRender } from "../../core/render";
import { rememberSteamCover, rememberSteamHero, isFlatSteamArt } from "../../core/steam-art-cache";
import { customGamesEdit, customGamesList, customGameToLibraryItem, type CustomGame } from "../../custom-games";
import { steamLibraryArt, type SteamLibraryArt } from "../../steam";
import { syncInstalledWatch } from "../library/installed-watch";

/**
 * A missing picture, or the flat CDN path older builds saved. Newer titles only
 * publish the hashed `store_item_assets` path, so a flat URL 404s and no
 * picture can be cached. A URL on another host, or an uploaded `data:` cover,
 * is the user's own choice and is never rewritten.
 */
function missingOrFlat(url: string | undefined, appId: string): boolean {
  if (!url) return true;
  if (url.startsWith("data:")) return false;
  return isFlatSteamArt(url) && url.includes(`/steam/apps/${appId}/`);
}

/**
 * A custom game added from a Steam search used to keep 404 URLs, so its cover
 * and hero stayed broken and the image cache had nothing to store. Resolve the
 * published asset URLs once and save them, so the next boot paints from disk.
 * Returns the ids that actually changed.
 */
async function repairSteamArt(list: CustomGame[]): Promise<string[]> {
  const targets = list.filter((game) => {
    const id = game.steamAppId?.trim() || "";
    if (!/^\d+$/.test(id)) return false;
    return [game.coverUrl, game.headerUrl, game.heroUrl].some((url) => missingOrFlat(url, id));
  });
  if (targets.length === 0) return [];

  const ids = [...new Set(targets.map((game) => game.steamAppId!.trim()))];
  let art: Record<string, SteamLibraryArt>;
  try {
    art = await steamLibraryArt(ids);
  } catch {
    return [];
  }

  const repaired: string[] = [];
  for (const game of targets) {
    const id = game.steamAppId!.trim();
    const found = art[id];
    if (!found) continue;
    let dirty = false;
    if (missingOrFlat(game.coverUrl, id) && found.cover) {
      game.coverUrl = found.cover;
      dirty = true;
    }
    if (missingOrFlat(game.headerUrl, id) && found.header) {
      game.headerUrl = found.header;
      dirty = true;
    }
    if (missingOrFlat(game.heroUrl, id) && found.hero) {
      game.heroUrl = found.hero;
      dirty = true;
    }
    if (!dirty) continue;
    // The same official art the Steam library uses; remembering it lets that
    // view and the cover picker paint without another lookup.
    rememberSteamCover(id, found.cover);
    rememberSteamHero(id, found.hero);
    repaired.push(game.id);
    void customGamesEdit(game).catch(() => {});
  }
  return repaired;
}

export async function loadCustomGamesLibrary(): Promise<void> {
  if (!isTauri) return;
  try {
    const list = await customGamesList();
    S.customGames = list;
    const items = list.map(customGameToLibraryItem);
    setCustomSummaries(items);
    syncInstalledWatch();
    // The list often lands after the first library paint; the empty state must
    // give way to the cards once it does.
    scheduleRender();
    for (const g of list) {
      if (g.steamAppId) {
        void fetchAndRenderAchievements(g.id);
      }
    }
    void repairSteamArt(list).then((repaired) => {
      // A later reload owns the state now; its own repair covers these games.
      if (repaired.length === 0 || S.customGames !== list) return;
      setCustomSummaries(list.map(customGameToLibraryItem));
      scheduleRender();
      if (S.currentModalAppName && repaired.includes(S.currentModalAppName)) {
        openEpicModal(S.currentModalAppName, false, false);
      }
    });
  } catch (e) {
    console.error("Failed to load custom games library:", e);
  }
}

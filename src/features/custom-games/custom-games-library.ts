import { fetchAndRenderAchievements } from "../drawer/drawer-view";
import { isTauri } from "../../core/constants";
import { S } from "../../core/state";
import { setCustomSummaries } from "../../core/selectors";
import { customGamesList, customGameToLibraryItem } from "../../custom-games";
import { syncInstalledWatch } from "../library/installed-watch";

export async function loadCustomGamesLibrary(): Promise<void> {
  if (!isTauri) return;
  try {
    const list = await customGamesList();
    S.customGames = list;
    const items = list.map(customGameToLibraryItem);
    setCustomSummaries(items);
    syncInstalledWatch();
    for (const g of list) {
      if (g.steamAppId) {
        void fetchAndRenderAchievements(g.id);
      }
    }
  } catch (e) {
    console.error("Failed to load custom games library:", e);
  }
}

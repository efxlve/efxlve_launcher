/**
 * Loads EA, Ubisoft, Xbox and Battle.net games into the shared library.
 *
 * Installed games show immediately. Linking an account on the Accounts page
 * also brings in the owned games that client has cached. Covers fill in place.
 */

import { listen } from "@tauri-apps/api/event";
import { companionLibrary, companionResolveCovers, companionStoreStatus, companionToItem } from "../../companion";
import { rebuildAllGamesMap } from "../../core/selectors";
import { scheduleRender, render } from "../../core/render";
import { setView } from "../store/store-view";
import { S } from "../../core/state";

const storeIds = new Map<string, string>();
let loginBound = false;

function bindCompanionLogin(): void {
  if (loginBound) return;
  loginBound = true;
  void listen("companion-signed-in", () => {
    void loadCompanionLibrary().then(() => {
      setView("library");
      render();
    });
  });
}

export async function loadCompanionLibrary(): Promise<void> {
  bindCompanionLogin();
  try {
    const [games, status] = await Promise.all([
      companionLibrary(),
      companionStoreStatus().catch(() => []),
    ]);
    S.companionSummaries = games.map(companionToItem);
    S.companionStatus = status;
    storeIds.clear();
    for (const g of games) {
      if (g.storeId) storeIds.set(`${g.store}::${g.id}`, g.storeId);
    }
  } catch {
    S.companionSummaries = [];
  }
  rebuildAllGamesMap();
  S.libraryDataRev++;
  scheduleRender();
  void fillCompanionCovers();
}

async function fillCompanionCovers(): Promise<void> {
  const missing = S.companionSummaries.filter((g) => !g.coverUrl);
  if (missing.length === 0) return;
  let hits;
  try {
    hits = await companionResolveCovers(missing.map((g) => ({
      store: g.source,
      id: g.id,
      name: g.title,
      storeId: storeIds.get(g.key) || "",
    })));
  } catch {
    return;
  }
  let changed = false;
  for (const hit of hits) {
    if (!hit.coverUrl) continue;
    const key = `${hit.store}::${hit.id}`;
    const item = S.companionSummaries.find((g) => g.key === key);
    if (!item) continue;
    item.coverUrl = hit.coverUrl;
    item.heroUrl = hit.heroUrl || null;
    changed = true;
    patchCompanionCover(key, hit.coverUrl);
  }
  if (changed) rebuildAllGamesMap();
}

function patchCompanionCover(key: string, url: string): void {
  const safe = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : key.replace(/"/g, "");
  document.querySelectorAll<HTMLElement>(`[data-lib-item="${safe}"] [data-card-art]`).forEach((art) => {
    const img = art.querySelector("img");
    if (img) {
      img.src = url;
      return;
    }
    const ph = art.querySelector(".pcover");
    if (!ph) return;
    const next = document.createElement("img");
    next.alt = "";
    next.decoding = "async";
    next.src = url;
    ph.replaceWith(next);
  });
}

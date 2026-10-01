/**
 * Loads EA, Ubisoft, Xbox and Battle.net games into the shared library.
 *
 * Installed games show immediately. Linking an account on the Accounts page
 * also brings in the owned games that client has cached. Covers fill in place.
 */

import { listen } from "@tauri-apps/api/event";
import { companionLibrary, companionPlaytimes, companionResolveCovers, companionStoreStatus, companionSync, companionToItem } from "../../companion";
import { rebuildAllGamesMap } from "../../core/selectors";
import { scheduleRender, render } from "../../core/render";
import { setView, hideStore } from "../store/store-view";
import { S } from "../../core/state";
import { toast } from "../../core/toast";

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
  void listen<string>("companion-signin-failed", (event) => {
    // The store child sits above the toast layer, so close it first.
    hideStore();
    render();
    toast(String(event.payload), "err");
  });
  void listen("companion-store-changed", () => {
    void loadCompanionLibrary();
  });
}

/**
 * One background refresh of the accounts that support it. Ubisoft keeps a
 * sealed session, so buying a game elsewhere shows up without signing in again.
 */
export async function syncCompanionAccounts(): Promise<void> {
  try {
    const report = await companionSync("ubisoft");
    if (report.needsLogin) {
      // The sealed session is missing or expired: tell the user where to fix it.
      toast("@t:accounts.ubiSessionExpired", "err");
    }
    if (report.updated || report.needsLogin) await loadCompanionLibrary();
  } catch {
    // Offline or signed out: the cards keep the cached list.
  }
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
  void fillCompanionPlaytime();
}

/** Playtime the Ubisoft service reports, merged into the shared playtime map. */
let playtimeBusy = false;
async function fillCompanionPlaytime(): Promise<void> {
  if (playtimeBusy || !S.companionSummaries.some((g) => g.source === "ubisoft")) return;
  playtimeBusy = true;
  try {
    const rows = await companionPlaytimes("ubisoft");
    let changed = false;
    for (const row of rows) {
      const existing = S.playtimeMap.get(row.id);
      if (!existing || existing.total_seconds !== row.totalSeconds) {
        S.playtimeMap.set(row.id, {
          total_seconds: row.totalSeconds,
          session_count: existing?.session_count ?? 0,
          last_played_timestamp: existing?.last_played_timestamp,
          last_played: existing?.last_played,
        });
        changed = true;
      }
    }
    if (changed) scheduleRender();
  } catch {
    // Signed out or offline: the columns stay empty.
  } finally {
    playtimeBusy = false;
  }
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

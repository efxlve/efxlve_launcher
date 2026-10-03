/**
 * Loads EA, Ubisoft, Xbox and Battle.net games into the shared library.
 *
 * Installed games show immediately. Linking an account on the Accounts page
 * also brings in the owned games that client has cached. Covers fill in place.
 */

import { listen } from "@tauri-apps/api/event";
import { companionLibrary, companionPlaytimes, companionResolveCovers, companionStoreStatus, companionSync, companionToItem, type CompanionStore } from "../../companion";
import { clearWideArtCache, rebuildAllGamesMap } from "../../core/selectors";
import { scheduleRender, render, openEpicModal } from "../../core/render";
import { setView, hideStore } from "../store/store-view";
import { loadEpicAchSummaries } from "../auth/auth-actions";
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
    // A fresh link also brings new achievement sets (Ubisoft reads its cache).
    void loadEpicAchSummaries();
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
 * One background refresh of the accounts that support it. Ubisoft and EA keep
 * a sealed session, so buying a game elsewhere shows up without signing in
 * again.
 */
export async function syncCompanionAccounts(): Promise<void> {
  let changed = false;
  try {
    const report = await companionSync("ubisoft");
    if (report.needsLogin) {
      // The sealed session is missing or expired: tell the user where to fix it.
      toast("@t:accounts.ubiSessionExpired", "err");
    }
    if (report.updated || report.needsLogin) changed = true;
  } catch {
    // Offline or signed out: the cards keep the cached list.
  }
  try {
    const report = await companionSync("ea");
    if (report.needsLogin) toast("@t:accounts.eaSessionExpired", "err");
    if (report.updated || report.needsLogin) changed = true;
  } catch {
    // Not linked or offline: the cached list stays.
  }
  try {
    const report = await companionSync("xbox");
    if (report.needsLogin) toast("@t:accounts.xboxSessionExpired", "err");
    if (report.updated || report.needsLogin) changed = true;
  } catch {
    // Not linked or offline: the cached list stays.
  }
  if (changed) await loadCompanionLibrary();
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

/** Playtime from the store service (Ubisoft) or the local session cache,
 * merged into the shared playtime map. */
let playtimeBusy = false;
async function fillCompanionPlaytime(): Promise<void> {
  if (playtimeBusy) return;
  const stores = new Set(S.companionSummaries.map((g) => g.source));
  if (stores.size === 0) return;
  playtimeBusy = true;
  try {
    let changed = false;
    let changedCurrent = false;
    for (const store of stores) {
      let rows;
      try {
        rows = await companionPlaytimes(store as CompanionStore);
      } catch {
        // Signed out or offline: that store's columns stay empty.
        continue;
      }
      for (const row of rows) {
        // Rows carry the client's own id; the library key is `<store>::<id>`.
        const key = `${store}::${row.id}`;
        const existing = S.playtimeMap.get(key);
        if (!existing || existing.total_seconds !== row.totalSeconds) {
          S.playtimeMap.set(key, {
            total_seconds: row.totalSeconds,
            session_count: existing?.session_count ?? 0,
            last_played_timestamp: existing?.last_played_timestamp,
            last_played: existing?.last_played,
          });
          changed = true;
          if (S.currentModalAppName === key) changedCurrent = true;
        }
      }
    }
    if (changed) {
      scheduleRender();
      // The game page paints TIME from the map; refresh the open one in place.
      if (changedCurrent && S.currentModalAppName) openEpicModal(S.currentModalAppName, false, false);
    }
  } finally {
    playtimeBusy = false;
  }
}

/** Art the resolver could not match this session (Steam has no such title). */
const coverMisses = new Set<string>();

async function fillCompanionCovers(): Promise<void> {
  // Resolve art when either half is missing: a missing wide hero would leave
  // the game page stretching the portrait cover. The resolver answers up to 48
  // queries per call, so drain the list in bounded rounds.
  for (let round = 0; round < 6; round++) {
    const missing = S.companionSummaries.filter((g) => (!g.coverUrl || !g.heroUrl) && !coverMisses.has(g.key));
    if (missing.length === 0) return;
    const batch = missing.slice(0, 48);
    let hits;
    try {
      hits = await companionResolveCovers(batch.map((g) => ({
        store: g.source,
        id: g.id,
        name: g.title,
        storeId: storeIds.get(g.key) || "",
        cover: g.coverUrl || "",
      })));
    } catch {
      return;
    }
    const hitKeys = new Set(hits.filter((h) => h.coverUrl || h.heroUrl).map((h) => `${h.store}::${h.id}`));
    for (const g of batch) {
      if (!hitKeys.has(g.key)) coverMisses.add(g.key);
    }
    let changed = false;
    let changedCurrent = false;
    for (const hit of hits) {
      if (!hit.coverUrl && !hit.heroUrl) continue;
      const key = `${hit.store}::${hit.id}`;
      const item = S.companionSummaries.find((g) => g.key === key);
      if (!item) continue;
      // Never downgrade art the client catalog already provided.
      if (!item.coverUrl && hit.coverUrl) item.coverUrl = hit.coverUrl;
      if (!item.heroUrl && hit.heroUrl) item.heroUrl = hit.heroUrl;
      changed = true;
      clearWideArtCache(key);
      if (hit.coverUrl) patchCompanionCover(key, hit.coverUrl);
      if (S.currentModalAppName === key) changedCurrent = true;
    }
    if (!changed) return;
    rebuildAllGamesMap();
    if (changedCurrent && S.currentModalAppName) openEpicModal(S.currentModalAppName, false, false);
  }
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

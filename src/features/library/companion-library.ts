/**
 * Loads EA, Ubisoft, Xbox and Battle.net games into the shared library.
 *
 * Installed games show immediately. Linking an account on the Accounts page
 * also brings in the owned games that client has cached. Covers fill in place.
 */

import { listen } from "@tauri-apps/api/event";
import { companionAchievementsSummary, companionLibrary, companionPlaytimes, companionResolveCovers, companionStoreStatus, companionSync, companionToItem, type CompanionStore } from "../../companion";
import { clearWideArtCache, rebuildAllGamesMap } from "../../core/selectors";
import { scheduleRender, render, openEpicModal } from "../../core/render";
import { setView, hideStore } from "../store/store-view";
import { loadEpicAchSummaries } from "../auth/auth-actions";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { currentLanguage } from "../../i18n";
import type { EpicAchievementSummary } from "../../epic";

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
    // Xbox reports per-game achievements and gamerscore with the title
    // history; keep that bulk progress in the shared achievement map so the
    // profile and library rows can read it without a network round trip.
    const summaries: Record<string, EpicAchievementSummary> = {};
    for (const g of games) {
      if (g.achievementsTotal > 0) {
        const key = `${g.store}::${g.id}`;
        summaries[key] = {
          app_name: key,
          user_unlocked: g.achievementsUnlocked,
          total_achievements: g.achievementsTotal,
          user_xp: g.achievementsXp,
          total_xp: g.achievementsTotalXp,
          is_platinum: g.achievementsUnlocked >= g.achievementsTotal,
          supported: true,
        };
      }
    }
    // The title history zeroes its Xbox totals once a title has progress;
    // keep the last service-backed numbers until the fresh pass lands so the
    // cards never flash back to zero during a reload.
    for (const [key, summary] of Object.entries(S.companionAchSummaries)) {
      if (key.startsWith("xbox::") && !summaries[key]) summaries[key] = summary;
    }
    S.companionAchSummaries = summaries;
    S.companionSummaries = games.map(companionToItem);
    S.companionStatus = status;
    storeIds.clear();
    for (const g of games) {
      if (g.storeId) storeIds.set(`${g.store}::${g.id}`, g.storeId);
    }
  } catch {
    S.companionSummaries = [];
    S.companionAchSummaries = {};
  }
  rebuildAllGamesMap();
  S.libraryDataRev++;
  scheduleRender();
  void fillCompanionCovers();
  void fillCompanionPlaytime();
  void fillXboxAchievements();
}

/**
 * Xbox answers achievements per title, so the whole-account summary is a
 * separate paged pass; merge it when it lands and repaint the open lists.
 */
let xboxAchBusy = false;
async function fillXboxAchievements(): Promise<void> {
  if (xboxAchBusy) return;
  xboxAchBusy = true;
  try {
    const summary = await companionAchievementsSummary("xbox", currentLanguage());
    let changed = false;
    for (const [key, row] of Object.entries(summary)) {
      if (!row.supported || row.total_achievements <= 0) continue;
      const current = S.companionAchSummaries[key];
      if (
        current &&
        current.user_unlocked === row.user_unlocked &&
        current.total_achievements === row.total_achievements &&
        current.user_xp === row.user_xp &&
        current.total_xp === row.total_xp
      ) {
        continue;
      }
      S.companionAchSummaries[key] = row;
      changed = true;
    }
    if (changed) {
      S.libraryDataRev++;
      if (S.view === "library" || S.view === "profile") scheduleRender();
    }
  } catch {
    // Signed out or offline: the title-history numbers stay.
  } finally {
    xboxAchBusy = false;
  }
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
  // Resolve art and the studio when either is missing: a missing wide hero
  // would leave the game page stretching the portrait cover. The resolver
  // answers up to 48 queries per call, so drain the list in bounded rounds.
  for (let round = 0; round < 6; round++) {
    const missing = S.companionSummaries.filter((g) => (!g.coverUrl || !g.heroUrl || !g.developer) && !coverMisses.has(g.key));
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
    const hitKeys = new Set(hits.filter((h) => h.coverUrl || h.heroUrl || h.developer).map((h) => `${h.store}::${h.id}`));
    for (const g of batch) {
      if (!hitKeys.has(g.key)) coverMisses.add(g.key);
    }
    let changed = false;
    let changedCurrent = false;
    let developerChanged = false;
    for (const hit of hits) {
      if (!hit.coverUrl && !hit.heroUrl && !hit.developer) continue;
      const key = `${hit.store}::${hit.id}`;
      const item = S.companionSummaries.find((g) => g.key === key);
      if (!item) continue;
      // Never downgrade art or a studio the client catalog already provided.
      let touched = false;
      if (!item.coverUrl && hit.coverUrl) {
        item.coverUrl = hit.coverUrl;
        touched = true;
      }
      if (!item.heroUrl && hit.heroUrl) {
        item.heroUrl = hit.heroUrl;
        touched = true;
      }
      if (!item.developer && hit.developer) {
        item.developer = hit.developer;
        touched = true;
        developerChanged = true;
      }
      if (!touched) continue;
      changed = true;
      if (hit.coverUrl) {
        clearWideArtCache(key);
        patchCompanionCover(key, hit.coverUrl);
      }
      if (S.currentModalAppName === key) changedCurrent = true;
    }
    if (!changed) return;
    rebuildAllGamesMap();
    if (developerChanged) {
      S.libraryDataRev++;
      scheduleRender();
    }
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

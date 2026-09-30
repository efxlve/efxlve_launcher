/**
 * Embedded Epic Games Store view and top-level view state machine.
 *
 * The store is a native child webview; this module manages its bounds, the
 * loading screen, and the single setView entry point that keeps the store
 * visibility atomic. State lives in S.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../core/constants";
import { closeAllModals, render, scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { EPIC_STORE_URL, epicGetPlayerProfile } from "../../epic";
import { t } from "../../i18n";
import type { View } from "../../core/types";
/** Store webview bounds: the #content area (right of the sidebar, between the header and the status bar). */
export function storeRect(): { x: number; y: number; width: number; height: number; bottom: number } {
  const r = document.getElementById("content")?.getBoundingClientRect();
  const x = r ? r.left : 0;
  const y = r ? r.top : 0;
  const height = r ? r.height : window.innerHeight;
  return {
    x,
    y,
    width: Math.max(100, window.innerWidth - x),
    height: Math.max(100, height),
    bottom: Math.max(0, window.innerHeight - y - height),
  };
}

/** Launcher surfaces drawn in the main webview. The store child sits above them. */
const COVERING_ROOT_IDS = [
  "modal-root",
  "storage-root",
  "manage-root",
  "install-root",
  "selective-root",
  "playtime-root",
  "collection-root",
  "cover-modal-root",
  "move-modal-root",
  "options-root",
  "hide-games-root",
  "hide-achievements-root",
  "share-modal-root",
] as const;

/** True while the command palette is keeping the store child webview off-screen. */
let storeHeldForPalette = false;
/** True after a close has already asked Rust to show the child once. */
let storeRestoreInFlight = false;
/** Watches covering roots only while a hold is waiting for them to close. */
let coverWatch: MutationObserver | null = null;

function coveringStore(): boolean {
  for (const id of COVERING_ROOT_IDS) {
    if (document.getElementById(id)?.firstElementChild) return true;
  }
  return false;
}

function paletteDomOpen(): boolean {
  return Boolean(document.getElementById("palette-root")?.firstElementChild);
}

function stopCoverWatch(): void {
  coverWatch?.disconnect();
  coverWatch = null;
}

function watchCoversThenRelease(): void {
  if (coverWatch) return;
  coverWatch = new MutationObserver(() => {
    if (!storeHeldForPalette || paletteDomOpen() || coveringStore()) return;
    releaseStoreForPalette();
  });
  for (const id of COVERING_ROOT_IDS) {
    const el = document.getElementById(id);
    if (el) coverWatch.observe(el, { childList: true });
  }
}

export function syncStoreViewSize(): void {
  // A resize while the palette is open, or the echo of the single restore,
  // must not move or hide the child again.
  if (S.view !== "store" || !S.storeShown || !isTauri || storeHeldForPalette || storeRestoreInFlight) return;
  invoke<void>("resize_store_view", storeRect()).catch(() => undefined);
}

/**
 * Parks the store child webview so the command palette (main webview) can
 * paint above it. Same off-screen hide the store already uses when leaving
 * the page; the store page itself stays current.
 */
export function holdStoreForPalette(): Promise<void> {
  // Also hold while the store page is still loading. An in-flight show checks
  // this flag and parks the child instead of painting over the palette.
  if (storeHeldForPalette || S.view !== "store" || !isTauri) return Promise.resolve();
  storeHeldForPalette = true;
  return invoke("set_store_palette_hold", {
    hold: true,
    restore: false,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    bottom: 0,
  }).then(
    () => undefined,
    () => {
      storeHeldForPalette = false;
    },
  );
}

/** Puts the store child back once, unless the user left the store or a launcher surface is still open. */
export function releaseStoreForPalette(): void {
  // closePalette and a same-turn DOM/resize sync both call this. The first
  // call owns the single restore; the second finds the hold already cleared.
  if (!storeHeldForPalette || paletteDomOpen() || storeRestoreInFlight) return;
  if (S.view === "store" && S.storeShown && coveringStore()) {
    watchCoversThenRelease();
    return;
  }
  stopCoverWatch();
  storeHeldForPalette = false;
  if (!isTauri) return;
  const restore = S.view === "store" && S.storeShown;
  const rect = restore ? storeRect() : { x: 0, y: 0, width: 100, height: 100, bottom: 0 };
  storeRestoreInFlight = true;
  void invoke("set_store_palette_hold", { hold: false, restore, ...rect }).finally(() => {
    storeRestoreInFlight = false;
  });
}

/** Storefront the loading screen names; the child stays hidden until it paints. */
let loadingStoreId: StoreId = "epic";

export function renderStoreLoadingScreen(): string {
  const name = STORE_LABELS[loadingStoreId] ?? STORE_LABELS.epic;
  return `<div class="store-loading-screen"><span class="spinner"></span><span class="store-loading-title">${name} · ${t("store.starting")}</span></div>`;
}

/** Storefronts that can live in the embedded store webview, in menu order. */
export type StoreId = "epic" | "gog" | "steam";

/** Brand names are not translated: they read the same in every locale. */
export const STORE_LABELS: Record<StoreId, string> = {
  epic: "Epic Games",
  gog: "GOG",
  steam: "Steam",
};

/** Storefronts shown in the Stores header. */
export const HEADER_STORES: StoreId[] = ["epic", "gog", "steam"];

export function isHeaderStore(id: string): boolean {
  return (HEADER_STORES as string[]).includes(id);
}

export const GOG_STORE_URL = "https://www.gog.com/";
export const STEAM_STORE_URL = "https://store.steampowered.com/";

const STORE_URLS: Record<StoreId, string> = {
  epic: EPIC_STORE_URL,
  gog: GOG_STORE_URL,
  steam: STEAM_STORE_URL,
};

/** Storefront a URL belongs to (drives the header tabs and the warm cache). */
export function storeIdForUrl(url: string): StoreId {
  const lower = url.toLowerCase();
  if (lower.includes("gog.com")) return "gog";
  if (lower.includes("steampowered.com")) return "steam";
  return "epic";
}

/** Home URL of a storefront. */
export function storeUrlFor(store: StoreId): string {
  return STORE_URLS[store] ?? EPIC_STORE_URL;
}

/**
 * Storefronts whose child webview is already alive. Returning to one of them is
 * a show, not a load, so the loading screen and the progress sweep stay out of
 * the way; Rust reports the ones it closes to stay inside its memory budget.
 */
const warmStores = new Set<StoreId>();

/** True when this URL's storefront can be shown immediately. */
export function isStoreWarm(url: string): boolean {
  return warmStores.has(storeIdForUrl(url));
}

/**
 * Rust keeps only a few storefronts alive (each one is a renderer process) and
 * reports the rest, plus tells us when a cold storefront has painted.
 */
if (isTauri) {
  void listen<{ store: StoreId }>("efxlve-store-closed", (event) => {
    warmStores.delete(event.payload.store);
  });
  void listen<{ store: StoreId }>("efxlve-store-ready", (event) => {
    // The storefront painted and is now on screen.
    warmStores.add(event.payload.store);
    if (S.view === "store" && S.activeStore === event.payload.store) {
      S.storeShown = true;
      S.storeLoading = false;
      setStoreProgress(false);
      scheduleRender();
    }
  });
}

/**
 * Spinner guard: a storefront that never reports a finished load (a captive
 * portal, a page that keeps streaming) must not leave the tab spinning forever.
 */
let storeLoadingTimer: number | null = null;

function armStoreLoadingGuard(store: StoreId): void {
  if (storeLoadingTimer !== null) window.clearTimeout(storeLoadingTimer);
  if (!S.storeLoading) {
    storeLoadingTimer = null;
    return;
  }
  storeLoadingTimer = window.setTimeout(() => {
    storeLoadingTimer = null;
    if (S.activeStore === store) {
      S.storeLoading = false;
      scheduleRender();
    }
  }, 25 * 1000);
}

export async function openStore(store: StoreId = "epic"): Promise<void> {
  S.activeStore = store;
  await openStoreUrl(storeUrlFor(store), "store");
}

/**
 * After this long away from the store, its webviews are destroyed to free RAM.
 * Long enough that coming back from a game session or the library usually finds
 * the storefront still warm; the disk cache covers the rest.
 */
const STORE_IDLE_DESTROY_MS = 15 * 60 * 1000;
/** Invalidates an in-flight show once the user has left the store. */
let storeOpenEpoch = 0;

/** Cancels a pending idle destroy (the store is being used again). */
function cancelStoreDestroy(): void {
  if (S.storeDestroyTimer !== null) {
    window.clearTimeout(S.storeDestroyTimer);
    S.storeDestroyTimer = null;
  }
}

/** Schedules destroying the store webview after a period of inactivity. */
function scheduleStoreDestroy(): void {
  cancelStoreDestroy();
  S.storeDestroyTimer = window.setTimeout(() => {
    S.storeDestroyTimer = null;
    if (!S.storeShown && isTauri) {
      // Every storefront goes away, so nothing is warm until one loads again.
      warmStores.clear();
      invoke<string>("destroy_store_view").catch(() => {});
    }
  }, STORE_IDLE_DESTROY_MS);
}

function setStoreProgress(visible: boolean): void {
  const p = document.getElementById("store-progress-line");
  if (p) p.classList.toggle("hidden", !visible);
}

export async function openStoreUrl(url: string, mode: "store" | "profile"): Promise<void> {
  closeAllModals();
  cancelStoreDestroy();
  const store = storeIdForUrl(url);
  S.activeStore = store;
  loadingStoreId = store;
  if (S.view === "store" && S.storeShown && S.lastStoreUrl === url && S.storeMode === mode) return;
  const epoch = ++storeOpenEpoch;
  // A warm storefront is on screen within a frame; only a cold one needs the
  // loading screen and the progress sweep.
  const warm = warmStores.has(store);
  S.lastStoreUrl = url;
  S.storeMode = mode;
  S.view = "store";
  setStoreProgress(!warm);
  render();
  try {
    const result = await invoke<string>("show_store_view", { ...storeRect(), url, recreate: false, ownedLabel: t("store.inLibrary") });
    if (epoch !== storeOpenEpoch || S.view !== "store") {
      setStoreProgress(false);
      // Only the player leaving the store takes it down. A newer openStoreUrl owns
      // the view otherwise: hiding here would park the storefront that call just
      // showed, leaving the header pointing at a store that is no longer on screen
      // (the "all storefronts stopped opening" case after clicking two tabs fast).
      if (S.view !== "store") {
        S.storeShown = false;
        if (isTauri) invoke<string>("hide_store_view").catch(() => {});
      }
      return;
    }
    // `@t:store.pending` means Rust parked the webview (palette open, or the player
    // already left); anything else means a storefront is on screen.
    const shown = result !== "@t:store.pending";
    S.storeShown = shown;
    // Only a storefront that was already painted is instant. Every fresh load keeps
    // the launcher's spinner on the active tab until the page reports it loaded.
    S.storeLoading = result !== "@t:win.focused";
    armStoreLoadingGuard(store);
    if (shown) {
      warmStores.add(store);
    } else {
      render();
    }
    if (warm && shown) {
      setStoreProgress(false);
    } else {
      window.setTimeout(() => {
        if (epoch === storeOpenEpoch) setStoreProgress(false);
      }, 250);
    }
    window.setTimeout(syncStoreViewSize, 50);
    window.setTimeout(syncStoreViewSize, 200);
  } catch (e) {
    if (epoch !== storeOpenEpoch) return;
    setStoreProgress(false);
    S.storeShown = false;
    S.storeLoading = false;
    S.view = S.lastNonStoreView;
    render();
    toast(String(e), "err");
  }
}

let profileLoadGen = 0;

export async function loadPlayerProfile(forceRefresh = false, replace = false): Promise<void> {
  if (!isTauri) return;
  // `replace` drops an in-flight fetch from the previous account and reads cache.
  if (S.profileLoading && !forceRefresh && !replace) return;
  const gen = ++profileLoadGen;
  S.profileLoading = true;
  S.profileError = "";
  render();
  try {
    const data = await epicGetPlayerProfile(forceRefresh);
    if (gen !== profileLoadGen) return;
    S.playerProfileData = data;
  } catch (e) {
    if (gen !== profileLoadGen) return;
    S.profileError = String(e);
  } finally {
    if (gen === profileLoadGen) {
      S.profileLoading = false;
      render();
    }
  }
}


export async function openProfile(): Promise<void> {
  setView("profile");
  closeAllModals();
  if (!S.playerProfileData && !S.profileLoading) {
    void loadPlayerProfile();
  }
  render();
}

/** Atomically hides the embedded store webview; falls back to the last non-store view. */
export function hideStore(): void {
  storeOpenEpoch += 1;
  const wasShown = S.storeShown;
  S.storeShown = false;
  setStoreProgress(false);
  if (isTauri && (wasShown || S.view === "store")) {
    invoke<string>("hide_store_view").catch((e: unknown) => toast(String(e), "err"));
  }
  if (wasShown) scheduleStoreDestroy();
  if (S.view === "store") S.view = S.lastNonStoreView;
}

/** Single entry point for view changes: store visibility is always updated atomically. */
export function setView(next: View): void {
  if (next !== "store") {
    hideStore();
    if (next !== "tv") S.lastNonStoreView = next;
  }
  S.view = next;
}

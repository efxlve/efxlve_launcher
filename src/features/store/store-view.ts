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
import { EPIC_STORE_URL, epicGetAchievementsSummary, epicGetPlayerProfile } from "../../epic";
import { gogGetAchievementsSummary } from "../../gog";
import { steamGetAchievementsSummary } from "../../steam";
import { t } from "../../i18n";
import type { View } from "../../core/types";
export interface StoreRect {
  [key: string]: unknown;
  x: number;
  y: number;
  width: number;
  height: number;
  bottom: number;
}

/** Bounds of the store child while TV Mode is showing a storefront in place. */
let embeddedStoreRect: (() => StoreRect) | null = null;

/** True while TV Mode owns the store child and a normal view change must not park it. */
export function embeddedStoreHeld(): boolean {
  return embeddedStoreRect !== null;
}

/** TV Mode registers the frame the child webview should cover. Null releases it. */
export function setEmbeddedStoreRect(reader: (() => StoreRect) | null): void {
  embeddedStoreRect = reader;
}

/** Store webview bounds: the #content area (right of the sidebar, between the header and the status bar). */
export function storeRect(): StoreRect {
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
  "changelog-root",
] as const;

/**
 * Surfaces that park the store child. A native webview ignores z-index, so
 * the command palette would otherwise open underneath it.
 */
const storeHoldReasons = new Set<string>();
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
    if (paletteDomOpen() || coveringStore() || !storeHoldReasons.has("cover")) return;
    releaseStoreOverlay("cover");
  });
  for (const id of COVERING_ROOT_IDS) {
    const el = document.getElementById(id);
    if (el) coverWatch.observe(el, { childList: true });
  }
}

export function syncStoreViewSize(): void {
  // A resize while the palette is open, or the echo of the single restore,
  // must not move or hide the child again.
  const embedded = embeddedStoreRect !== null;
  if ((!embedded && S.view !== "store") || !S.storeShown || !isTauri || storeHoldReasons.size > 0 || storeRestoreInFlight) return;
  const rect = embedded ? embeddedStoreRect!() : storeRect();
  invoke<void>("resize_store_view", rect).catch(() => undefined);
}

/**
 * Parks the store child webview so a main-webview surface can paint above it.
 * The store page itself stays current. A second reason does not hide again.
 */
export function holdStoreOverlay(reason: string): Promise<void> {
  if (storeHoldReasons.has(reason)) return Promise.resolve();
  const alreadyParked = storeHoldReasons.size > 0;
  storeHoldReasons.add(reason);
  if (alreadyParked || S.view !== "store" || !isTauri) return Promise.resolve();
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
      storeHoldReasons.delete(reason);
    },
  );
}

export function holdStoreForPalette(): Promise<void> {
  return holdStoreOverlay("palette");
}

/** Puts the store child back once the last covering surface has closed. */
export function releaseStoreOverlay(reason: string): void {
  if (reason === "palette" && paletteDomOpen()) return;
  if (!storeHoldReasons.delete(reason) || storeHoldReasons.size > 0 || storeRestoreInFlight) return;
  if (S.view === "store" && S.storeShown && coveringStore()) {
    storeHoldReasons.add("cover");
    watchCoversThenRelease();
    return;
  }
  stopCoverWatch();
  if (!isTauri) return;
  const restore = S.view === "store" && S.storeShown;
  const rect = restore ? storeRect() : { x: 0, y: 0, width: 100, height: 100, bottom: 0 };
  storeRestoreInFlight = true;
  void invoke("set_store_palette_hold", { hold: false, restore, ...rect }).finally(() => {
    storeRestoreInFlight = false;
  });
}

export function releaseStoreForPalette(): void {
  releaseStoreOverlay("palette");
}

/** Storefront the loading screen names; the child stays hidden until it paints. */
let loadingStoreId: StoreId = "epic";

export function renderStoreLoadingScreen(): string {
  const name = STORE_LABELS[loadingStoreId] ?? STORE_LABELS.epic;
  return `<div class="store-loading-screen"><span class="spinner"></span><span class="store-loading-title">${name} · ${t("store.starting")}</span></div>`;
}

/** Storefronts that can live in the embedded store webview, in menu order. */
export type StoreId = "epic" | "gog" | "steam" | "battlenet" | "ubisoft" | "ea" | "xbox";

/** Brand names are not translated: they read the same in every locale. */
export const STORE_LABELS: Record<StoreId, string> = {
  epic: "Epic Games",
  gog: "GOG",
  steam: "Steam",
  battlenet: "Battle.net",
  ubisoft: "Ubisoft Connect",
  ea: "EA App",
  xbox: "Xbox",
};

/** Storefronts shown in the Stores header. */
export const HEADER_STORES: StoreId[] = ["epic", "gog", "steam", "battlenet", "ubisoft", "ea", "xbox"];

export function isHeaderStore(id: string): boolean {
  return (HEADER_STORES as string[]).includes(id);
}

export const GOG_STORE_URL = "https://www.gog.com/";
export const STEAM_STORE_URL = "https://store.steampowered.com/";

export const BATTLENET_ACCOUNT_URL = "https://account.battle.net/";
export const BATTLENET_STORE_URL = "https://shop.battle.net/";
export const EA_STORE_URL = "https://www.ea.com/games";
/** Microsoft Store web, filtered to PC games. */
export const XBOX_STORE_URL = "https://apps.microsoft.com/games/pc";
export const UBISOFT_STORE_URL = "https://store.ubi.com/";

/**
 * Ubisoft's overlay login page, the same start URL the Galaxy Uplay plugin
 * uses. It is only opened for the sign-in; the tab itself is the store page.
 */
export const UBISOFT_LOGIN_URL =
  "https://connect.cdn.ubisoft.com/overlay/default/" +
  "?env=prod&isStandalone=true&platform=pc&deviceType=desktop" +
  "&locale=en-US&spaceId=0a706b37-4b88-4437-b8f4-4ed2458c9518" +
  "&applicationId=20adeb9c-6dad-404e-af1e-b12b4594e86e" +
  "&country=US&region=WW&ownershipGroup=empty";

const STORE_URLS: Record<StoreId, string> = {
  epic: EPIC_STORE_URL,
  gog: GOG_STORE_URL,
  steam: STEAM_STORE_URL,
  battlenet: BATTLENET_STORE_URL,
  ubisoft: UBISOFT_STORE_URL,
  ea: EA_STORE_URL,
  xbox: XBOX_STORE_URL,
};

/** Storefront a URL belongs to (drives the header tabs and the warm cache). */
export function storeIdForUrl(url: string): StoreId {
  const lower = url.toLowerCase();
  if (lower.includes("gog.com")) return "gog";
  if (lower.includes("steampowered.com")) return "steam";
  if (lower.includes("battle.net")) return "battlenet";
  if (lower.includes("ubisoft.com")) return "ubisoft";
  if (lower.includes("ea.com")) return "ea";
  if (lower.includes("xbox.com") || lower.includes("microsoft.com")) return "xbox";
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
    if (S.activeStore === event.payload.store && (S.view === "store" || embeddedStoreRect !== null)) {
      S.storeShown = true;
      S.storeLoading = false;
      setStoreProgress(false);
      const pending = document.getElementById("tv-store-pending");
      if (pending) pending.hidden = true;
      if (S.view === "store") scheduleRender();
      else syncStoreViewSize();
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
  }
  if (gen !== profileLoadGen) return;
  // Epic's profile payload does not include GOG or Steam. Refresh the shared
  // achievement cache so the profile list matches the library covers.
  try {
    const [epicSummaries, gogSummaries, steamSummaries] = await Promise.all([
      epicGetAchievementsSummary().catch(() => ({})),
      gogGetAchievementsSummary().catch(() => ({})),
      steamGetAchievementsSummary().catch(() => ({})),
    ]);
    if (gen !== profileLoadGen) return;
    S.epicAchSummaries = { ...epicSummaries, ...gogSummaries, ...steamSummaries };
    S.libraryDataRev++;
  } catch {
    // The page still renders whatever was already cached.
  }
  if (gen === profileLoadGen) {
    S.profileLoading = false;
    render();
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

/**
 * Shows a storefront in a caller-supplied rectangle without leaving the current
 * view. TV Mode uses this so Epic, GOG and Steam stay inside the console shell.
 */
export async function showEmbeddedStore(url: string, rect: StoreRect): Promise<void> {
  cancelStoreDestroy();
  const store = storeIdForUrl(url);
  S.activeStore = store;
  loadingStoreId = store;
  const epoch = ++storeOpenEpoch;
  const warm = warmStores.has(store);
  S.lastStoreUrl = url;
  S.storeMode = "store";
  S.storeLoading = !warm;
  try {
    const result = await invoke<string>("show_store_view", {
      ...rect,
      url,
      recreate: false,
      ownedLabel: t("store.inLibrary"),
    });
    if (epoch !== storeOpenEpoch || embeddedStoreRect === null) {
      if (embeddedStoreRect === null && S.view !== "store") {
        S.storeShown = false;
        S.storeLoading = false;
        if (isTauri) invoke<string>("hide_store_view").catch(() => {});
      }
      return;
    }
    const shown = result !== "@t:store.pending";
    S.storeShown = shown;
    S.storeLoading = result !== "@t:win.focused";
    armStoreLoadingGuard(store);
    if (shown) warmStores.add(store);
    if (!S.storeLoading) {
      document.getElementById("tv-store-pending")?.setAttribute("hidden", "");
    }
    window.setTimeout(syncStoreViewSize, 50);
    window.setTimeout(syncStoreViewSize, 200);
  } catch (e) {
    if (epoch !== storeOpenEpoch) return;
    S.storeShown = false;
    S.storeLoading = false;
    toast(String(e), "err");
  }
}

/** Parks the child webview TV Mode was showing and forgets the embed frame. */
export function releaseEmbeddedStore(): void {
  embeddedStoreRect = null;
  storeOpenEpoch += 1;
  const wasShown = S.storeShown;
  S.storeShown = false;
  S.storeLoading = false;
  if (isTauri && wasShown) {
    invoke<string>("hide_store_view").catch(() => {});
    scheduleStoreDestroy();
  }
}

/** Atomically hides the embedded store webview; falls back to the last non-store view. */
export function hideStore(): void {
  embeddedStoreRect = null;
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

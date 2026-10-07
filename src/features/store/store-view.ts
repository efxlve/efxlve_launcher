/**
 * Embedded Epic Games Store view and top-level view state machine.
 *
 * The store is a native child webview; this module manages its bounds, the
 * loading screen, and the single setView entry point that keeps the store
 * visibility atomic. State lives in S.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri, HIDDEN_STORES_KEY, PROFILE_CARD_CHUNK } from "../../core/constants";
import { storeLogo } from "./store-logos";
import { closeAllModals, render, scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { EPIC_STORE_URL, epicGetAchievementsSummary, epicGetPlayerProfile } from "../../epic";
import { gogGetAchievementsSummary } from "../../gog";
import { steamGetAchievementsSummary } from "../../steam";
import { companionAchievementsSummary } from "../../companion";
import { currentLanguage, t } from "../../i18n";
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

/**
 * Parks the storefront while a main-webview cover (the game page) is open over
 * it. A native child webview ignores z-index, so the store would otherwise
 * render on top of the page. The cover watcher puts it back once every
 * covering root is empty again.
 */
export function holdStoreForCover(): void {
  if (S.view !== "store" || !S.storeShown) return;
  void holdStoreOverlay("cover");
  watchCoversThenRelease();
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
export type StoreId = "epic" | "gog" | "steam" | "battlenet" | "ubisoft" | "ea" | "xbox" | "luna";

/** Brand names are not translated: they read the same in every locale. */
export const STORE_LABELS: Record<StoreId, string> = {
  epic: "Epic Games",
  gog: "GOG",
  steam: "Steam",
  battlenet: "Battle.net",
  ubisoft: "Ubisoft Connect",
  ea: "EA App",
  xbox: "Xbox",
  luna: "Amazon Games",
};

/** Storefronts shown in the Stores header. */
export const HEADER_STORES: StoreId[] = ["epic", "gog", "steam", "xbox", "battlenet", "ubisoft", "ea", "luna"];

/** Header stores the user kept visible (Settings > Appearance). */
export function visibleHeaderStores(): StoreId[] {
  return HEADER_STORES.filter((id) => !S.hiddenStores.has(id));
}

export function isHeaderStore(id: string): boolean {
  return (HEADER_STORES as string[]).includes(id);
}

export const GOG_STORE_URL = "https://www.gog.com/";
export const STEAM_STORE_URL = "https://store.steampowered.com/";

export const BATTLENET_ACCOUNT_URL = "https://account.battle.net/";
export const BATTLENET_STORE_URL = "https://shop.battle.net/";
export const EA_STORE_URL = "https://www.ea.com/games";
/**
 * Amazon Games (Luna) monthly games claim page. It is a cloud-service claims
 * page: read-only in the store webview, nothing installs from here.
 */
export const LUNA_STORE_URL = "https://luna.amazon.com/claims/home";
/**
 * Xbox PC games list. No locale segment: Xbox redirects to the visitor's own
 * region, so every user sees their own language and currency.
 */
export const XBOX_STORE_URL = "https://www.xbox.com/games/all-games/pc?PlayWith=PC";
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
  luna: LUNA_STORE_URL,
};

/** Storefront a URL belongs to (drives the header tabs and the warm cache). */
export function storeIdForUrl(url: string): StoreId {
  const lower = url.toLowerCase();
  if (lower.includes("gog.com")) return "gog";
  if (lower.includes("steampowered.com")) return "steam";
  if (lower.includes("battle.net")) return "battlenet";
  if (lower.includes("ubisoft.com") || lower.includes("ubi.com")) return "ubisoft";
  if (lower.includes("ea.com")) return "ea";
  if (lower.includes("xbox.com") || lower.includes("microsoft.com")) return "xbox";
  if (lower.includes("luna.amazon.com")) return "luna";
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
/** Idle time before the embedded store webview is destroyed to free memory.
 *  Fifteen minutes kept a renderer alive long after the user left the store;
 *  five still covers normal browsing between the library and the stores. */
const STORE_IDLE_DESTROY_MS = 5 * 60 * 1000;
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
  // Epic's profile payload does not include GOG, Steam or Ubisoft. Refresh the
  // shared achievement cache so the profile list matches the library covers.
  try {
    const [epicSummaries, gogSummaries, steamSummaries, ubiSummaries] = await Promise.all([
      epicGetAchievementsSummary().catch(() => ({})),
      gogGetAchievementsSummary().catch(() => ({})),
      steamGetAchievementsSummary().catch(() => ({})),
      // Ubisoft keeps its sets on disk; Xbox and EA answer per game.
      companionAchievementsSummary("ubisoft", currentLanguage()).catch(() => ({})),
    ]);
    if (gen !== profileLoadGen) return;
    S.epicAchSummaries = { ...epicSummaries, ...gogSummaries, ...steamSummaries, ...ubiSummaries };
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
  // A fresh entry always lands on the combined profile, unfiltered.
  S.profileStore = "all";
  S.profileAccount = null;
  S.profileFilter = "all";
  S.profileShowHidden = false;
  S.profileCardCount = PROFILE_CARD_CHUNK;
  // Without an Epic session the profile fetch can only fail; skipping it also
  // keeps the hero refresh from spinning and refetching every store summary.
  const epicMaybeSignedIn = Boolean(S.epicAccount) || S.epicPhase === "checking";
  if (epicMaybeSignedIn && !S.playerProfileData && !S.profileLoading) {
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

/**
 * Puts each storefront's mark next to its name in the header. Runs once: the
 * tab buttons are static in `index.html`, the labels live here.
 */
function decorateStoreTabs(): void {
  const switcher = document.getElementById("store-switcher");
  if (!switcher || switcher.dataset.logos === "1") return;
  switcher.dataset.logos = "1";
  switcher.querySelectorAll<HTMLElement>("[data-store]").forEach((btn) => {
    const id = btn.dataset.store as StoreId;
    const label = STORE_LABELS[id];
    const logo = storeLogo(id, 16, "store-tab-logo");
    if (!label || !logo) return;
    btn.innerHTML = `${logo}<span class="store-tab-label">${label}</span>`;
  });
}
decorateStoreTabs();

/**
 * Applies the store-bar settings: hidden stores leave the strip, tabs stay
 * logo-only with a full name on the open store, and the scroll arrows follow
 * the new width. The active store falls back to the first visible one.
 */
export function applyStoreTabs(): void {
  const switcher = document.getElementById("store-switcher");
  if (!switcher) return;
  let activeVisible = false;
  switcher.querySelectorAll<HTMLElement>("[data-store]").forEach((btn) => {
    const id = btn.dataset.store || "";
    const hidden = S.hiddenStores.has(id);
    btn.hidden = hidden;
    if (!hidden && id === S.activeStore) activeVisible = true;
  });
  switcher.classList.add("logos-only");
  if (!activeVisible) {
    const first = switcher.querySelector<HTMLElement>("[data-store]:not([hidden])");
    const id = first?.dataset.store;
    if (id && isHeaderStore(id)) S.activeStore = id as StoreId;
  }
  updateStoreTabsArrows();
}

/** Persists a store's visibility. The last visible store cannot be hidden. */
export function setStoreHidden(id: string, hidden: boolean): void {
  if (!isHeaderStore(id)) return;
  if (hidden) {
    const remaining = HEADER_STORES.filter((store) => store !== id && !S.hiddenStores.has(store));
    if (remaining.length === 0) return;
    S.hiddenStores.add(id);
  } else {
    S.hiddenStores.delete(id);
  }
  localStorage.setItem(HIDDEN_STORES_KEY, JSON.stringify([...S.hiddenStores]));
  applyStoreTabs();
}

/**
 * Keeps the open storefront smoothly scrolled into view inside the tab strip
 * if it ever expands past the visible edge.
 */
export function syncStoreTabsPill(): void {
  const switcher = document.getElementById("store-switcher");
  if (!switcher) return;
  const active = switcher.querySelector<HTMLElement>(".tab.active:not([hidden])");
  if (!active || active.offsetWidth === 0) return;
  const left = active.offsetLeft;
  const right = left + active.offsetWidth;
  if (left < switcher.scrollLeft) {
    switcher.scrollTo({ left, behavior: "smooth" });
  } else if (right > switcher.scrollLeft + switcher.clientWidth) {
    switcher.scrollTo({ left: right - switcher.clientWidth, behavior: "smooth" });
  }
}

// The tab strip is static markup: apply the stored choices once at boot and
// keep the active tab and scroll arrows in step with every later switch.
applyStoreTabs();
syncStoreTabsPill();
if (typeof MutationObserver !== "undefined") {
  const switcher = document.getElementById("store-switcher");
  if (switcher) {
    let arrowTimer: ReturnType<typeof setTimeout> | undefined;
    const watch = new MutationObserver(() => {
      syncStoreTabsPill();
      if (arrowTimer) clearTimeout(arrowTimer);
      arrowTimer = setTimeout(updateStoreTabsArrows, 260);
    });
    switcher.querySelectorAll("[data-store]").forEach((btn) => {
      watch.observe(btn, { attributes: true, attributeFilter: ["class", "hidden"] });
    });
  }
}

/**
 * Shows the tab scroll arrows only while the tab strip overflows, and dims the
 * arrow on the side that has nothing more to scroll.
 */
function updateStoreTabsArrows(): void {
  const bar = document.getElementById("store-tabs-bar");
  const scroller = document.getElementById("store-switcher");
  if (!bar || !scroller) return;
  const overflow = scroller.scrollWidth > scroller.clientWidth + 1;
  bar.classList.toggle("has-overflow", overflow);
  const prev = bar.querySelector<HTMLButtonElement>('[data-dir="-1"]');
  const next = bar.querySelector<HTMLButtonElement>('[data-dir="1"]');
  const atStart = scroller.scrollLeft <= 1;
  const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1;
  if (prev) prev.disabled = !overflow || atStart;
  if (next) next.disabled = !overflow || atEnd;
  syncStoreTabsPill();
}

function initStoreTabsBar(): void {
  const scroller = document.getElementById("store-switcher");
  if (!scroller) return;
  scroller.addEventListener("scroll", updateStoreTabsArrows, { passive: true });
  // ResizeObserver on this strip feeds itself: showing the arrows changes the
  // scroller's size, which fires the observer again and never returns to paint.
  window.addEventListener("resize", updateStoreTabsArrows);
  updateStoreTabsArrows();
}
initStoreTabsBar();

/**
 * Scrolls the tab strip by one comfortable page. The animation is done here
 * instead of with `scrollBy({ behavior: "smooth" })`, which some WebView2
 * builds skip when the window is not focused. A timer lands the final position
 * even if animation frames are throttled (occluded window).
 */
export function scrollStoreTabs(direction: number): void {
  const scroller = document.getElementById("store-switcher");
  if (!scroller) return;
  const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const start = scroller.scrollLeft;
  const delta = direction * Math.max(140, Math.round(scroller.clientWidth * 0.6));
  const target = Math.max(0, Math.min(start + delta, max));
  if (target === start) return;
  let landed = false;
  const land = (): void => {
    if (landed) return;
    landed = true;
    scroller.scrollLeft = target;
    // Some environments throttle the scroll event; keep the arrows in step.
    updateStoreTabsArrows();
  };
  window.setTimeout(land, 300);
  const t0 = performance.now();
  const duration = 220;
  const step = (now: number): void => {
    if (landed) return;
    const progress = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    scroller.scrollLeft = start + (target - start) * eased;
    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      landed = true;
      updateStoreTabsArrows();
    }
  };
  requestAnimationFrame(step);
}

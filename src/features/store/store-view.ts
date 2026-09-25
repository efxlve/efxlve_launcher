/**
 * Embedded Epic Games Store view and top-level view state machine.
 *
 * The store is a native child webview; this module manages its bounds, the
 * loading screen, and the single setView entry point that keeps the store
 * visibility atomic. State lives in S.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { closeAllModals, render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { EPIC_STORE_URL, epicFriends, epicGetPlayerProfile } from "../../epic";
import { localizeMessage, t } from "../../i18n";
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

export function syncStoreViewSize(): void {
  if (S.view !== "store" || !S.storeShown || !isTauri) return;
  invoke<void>("resize_store_view", storeRect()).catch(() => undefined);
}

export function renderStoreLoadingScreen(): string {
  return `<div class="store-loading-screen"><span class="spinner"></span><span class="store-loading-title">${t("store.starting")}</span></div>`;
}

export async function openStore(): Promise<void> {
  await openStoreUrl(EPIC_STORE_URL, "store");
}

/** After this long away from the store, its webview is destroyed to free RAM. */
const STORE_IDLE_DESTROY_MS = 3 * 60 * 1000;
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
      invoke<string>("destroy_store_view").catch(() => {});
    }
  }, STORE_IDLE_DESTROY_MS);
}

export async function openStoreUrl(url: string, mode: "store" | "profile"): Promise<void> {
  closeAllModals();
  cancelStoreDestroy();
  if (S.view === "store" && S.storeShown && S.lastStoreUrl === url && S.storeMode === mode) return;
  const epoch = ++storeOpenEpoch;
  S.lastStoreUrl = url;
  S.storeMode = mode;
  S.view = "store";
  viewEl.innerHTML = renderStoreLoadingScreen();
  render();
  try {
    await invoke<string>("show_store_view", { ...storeRect(), url, recreate: false, ownedLabel: t("store.inLibrary") });
    if (epoch !== storeOpenEpoch || S.view !== "store") {
      S.storeShown = false;
      if (isTauri) invoke<string>("hide_store_view").catch(() => {});
      return;
    }
    S.storeShown = true;
    window.setTimeout(syncStoreViewSize, 50);
    window.setTimeout(syncStoreViewSize, 200);
  } catch (e) {
    if (epoch !== storeOpenEpoch) return;
    S.storeShown = false;
    S.view = S.lastNonStoreView;
    render();
    toast(String(e), "err");
  }
}

export async function loadPlayerProfile(forceRefresh = false): Promise<void> {
  if (!isTauri) return;
  S.profileLoading = true;
  S.profileError = "";
  render();
  try {
    S.playerProfileData = await epicGetPlayerProfile(forceRefresh);
  } catch (e) {
    S.profileError = String(e);
  } finally {
    S.profileLoading = false;
    render();
  }
}

/** Loads the Epic friends list (read-only, unofficial API). */
export async function loadFriends(force = false): Promise<void> {
  if (!isTauri || S.friendsLoading) return;
  if (!force && S.friends.length > 0) return;
  S.friendsLoading = true;
  S.friendsError = "";
  render();
  try {
    const data = await epicFriends();
    S.friends = data.friends;
  } catch (e) {
    S.friendsError = localizeMessage(String(e));
  } finally {
    S.friendsLoading = false;
    render();
  }
}

export async function openProfile(): Promise<void> {
  setView("profile");
  closeAllModals();
  if (!S.playerProfileData && !S.profileLoading) {
    void loadPlayerProfile();
  }
  void loadFriends();
  render();
}

/** Atomically hides the embedded store webview; falls back to the last non-store view. */
export function hideStore(): void {
  storeOpenEpoch += 1;
  const wasShown = S.storeShown;
  S.storeShown = false;
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
    S.lastNonStoreView = next;
  }
  S.view = next;
}

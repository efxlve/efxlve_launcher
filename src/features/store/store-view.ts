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
export function storeRect(): { x: number; y: number; width: number; height: number } {
  const titlebar = document.getElementById("titlebar");
  const top = titlebar ? titlebar.offsetHeight : 0;
  return {
    x: 0,
    y: top,
    width: window.innerWidth,
    height: Math.max(100, window.innerHeight - top),
  };
}

export function syncStoreViewSize(): void {
  if (S.view !== "store" || !S.storeShown || !isTauri) return;
  invoke<void>("resize_store_view", storeRect()).catch(() => undefined);
}

export function renderStoreLoadingScreen(): string {
  return `
    <div class="store-loading-screen">
      <div class="store-loading-canvas">
        <div class="store-loading-brand">
          <div class="store-loading-mark">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/>
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
              <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/>
              <path d="M2 7h20"/>
            </svg>
          </div>
          <div class="store-loading-logotype">
            <span class="store-loading-brand-main">EPIC GAMES STORE</span>
            <span class="store-loading-brand-sub">${t("store.embedded")}</span>
          </div>
        </div>

        <div class="store-loading-track-wrap">
          <div class="store-loading-track">
            <div class="store-loading-laser"></div>
          </div>
        </div>

        <div class="store-loading-status-wrap">
          <span class="store-loading-status-text">${t("store.starting")}</span>
          <span class="store-loading-status-dots"><span>.</span><span>.</span><span>.</span></span>
        </div>
      </div>
    </div>
  `;
}

export async function openStore(): Promise<void> {
  await openStoreUrl(EPIC_STORE_URL, "store");
}

/** After this long away from the store, its webview is destroyed to free RAM. */
const STORE_IDLE_DESTROY_MS = 3 * 60 * 1000;

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
  S.lastStoreUrl = url;
  S.storeMode = mode;
  S.view = "store";
  // Show the modern loading animation while the store opens.
  viewEl.innerHTML = renderStoreLoadingScreen();
  render();
  try {
    await invoke<string>("show_store_view", { ...storeRect(), url, recreate: false });
    S.storeShown = true;
    window.setTimeout(syncStoreViewSize, 50);
    window.setTimeout(syncStoreViewSize, 200);
  } catch (e) {
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
  if (!force && (S.friends.length > 0 || S.friendsError)) return;
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
  if (S.storeShown) {
    S.storeShown = false;
    if (isTauri) invoke<string>("hide_store_view").catch((e: unknown) => toast(String(e), "err"));
    // Release the hidden Chromium renderer after a while to save memory.
    scheduleStoreDestroy();
  }
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

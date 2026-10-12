/**
 * Launcher Discord page: the normal `discord.com/app` web client in an embedded
 * child webview. Friends, direct messages and servers are the real Discord UI;
 * the launcher only places the child, parks it under covering surfaces and
 * destroys it when the page is left.
 *
 * A full Discord client is a heavy renderer, so it is not kept warm next to the
 * store/Spotify children. The WebView2 profile preserves the session, so the
 * next visit stays signed in.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { t } from "../../i18n";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { COVERING_ROOT_IDS } from "../store/store-view";

let viewVisible = false;
let hydrated = false;
let showErrorToasted = false;
let slotObserver: ResizeObserver | null = null;
let listenersReady = false;
let syncRaf: number | null = null;
let settleTimer: number | null = null;

function onDiscordView(): boolean {
  // The view host can hold stale markup after a page change; only the current
  // view may bring the child webview back.
  return S.view === "discord" && Boolean(viewEl?.querySelector(".discord-page"));
}

function coversOpen(): boolean {
  return COVERING_ROOT_IDS.some((id) => document.getElementById(id)?.firstElementChild);
}

/** Discord page markup: one slot that the child webview fills, with a loading
 * note underneath until the child has painted its first load. */
export function renderDiscordPage(): string {
  if (!isTauri) {
    return `<div class="discord-page"><div class="discord-note-box"><h2>Discord</h2><p class="discord-note">${esc(t("lib.desktopOnly"))}</p></div></div>`;
  }
  return `
    <div class="discord-page">
      <div class="discord-webview-slot" id="discord-webview-slot"></div>
      <div class="discord-loading" id="discord-loading"><span class="spinner"></span><p>${esc(t("discord.loading"))}</p></div>
    </div>`;
}

/** Header actions for the Discord page: reload a stuck or erroring page. */
function paintHeaderActions(): void {
  const host = document.getElementById("page-header-actions");
  if (!host) return;
  if (!onDiscordView()) {
    if (host.childElementCount > 0) host.innerHTML = "";
    host.classList.remove("has-actions");
    return;
  }
  host.innerHTML = `<button class="icon-btn" data-discord-act="reload" title="${esc(t("discord.reload"))}">${icon("refresh", 14)}</button>`;
  host.classList.add("has-actions");
}

/** Wires the Discord page once it is on screen. */
export function hydrateDiscordPage(): void {
  hydrated = true;
  showErrorToasted = false;
  ensureListeners();
  paintHeaderActions();
  observeSlot();
  syncDiscordPage();
  // The page-enter animation slides the view for a moment; re-apply the
  // rectangle afterwards so the webview sits flush under the header.
  window.setTimeout(() => {
    if (viewVisible) syncDiscordPage();
  }, 450);
}

/** Destroys the child webview when another page takes over. */
export function destroyDiscordPage(): void {
  if (!hydrated) return;
  hydrated = false;
  viewVisible = false;
  paintHeaderActions();
  void invoke("discord_view_destroy").catch(() => undefined);
}

function syncDiscordPage(): void {
  const slot = document.getElementById("discord-webview-slot");
  if (!slot || !onDiscordView() || coversOpen()) {
    if (viewVisible) {
      viewVisible = false;
      void invoke("discord_view_hide").catch(() => undefined);
    }
    return;
  }
  // A minimize/restore reports a shrinking viewport for a moment; pushing that
  // rectangle would leave the child tiny until the next real resize.
  if (document.hidden) return;
  const rect = slot.getBoundingClientRect();
  // The main window has a hard minimum (1024x640), so a slot this small is a
  // mid-animation measurement, never real layout: keep the previous rectangle.
  if (rect.width < 360 || rect.height < 240) return;
  viewVisible = true;
  void invoke("discord_view_show", {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }).catch((error) => {
    viewVisible = false;
    if (showErrorToasted) return;
    showErrorToasted = true;
    toast(String(error).replace(/^Error: /, ""), "err");
  });
}

/** rAF-throttled reposition: the sidebar drag/drawer moves the slot each frame. */
function scheduleSync(): void {
  if (syncRaf !== null) return;
  syncRaf = window.requestAnimationFrame(() => {
    syncRaf = null;
    syncDiscordPage();
  });
  // A trailing pass lands on the final rectangle once the transition ends.
  if (settleTimer !== null) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = null;
    if (viewVisible) syncDiscordPage();
  }, 340);
}

/**
 * The slot's rectangle changes when the sidebar resizes or drawers open/close
 * (no window resize event fires for those), so follow its size directly.
 */
function observeSlot(): void {
  const slot = document.getElementById("discord-webview-slot");
  if (!slot || typeof ResizeObserver === "undefined") return;
  slotObserver?.disconnect();
  slotObserver = new ResizeObserver(() => {
    if (onDiscordView()) scheduleSync();
  });
  slotObserver.observe(slot);
}

function ensureListeners(): void {
  if (listenersReady) return;
  listenersReady = true;
  window.addEventListener("resize", () => {
    if (viewVisible) syncDiscordPage();
  });
  // Restoring from a minimize can end with no further resize event (the last
  // one lands while the document is still hidden). Re-sync once the window is
  // visible again, or the child would stay at the shrunken restore rectangle.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && onDiscordView()) syncDiscordPage();
  });
  window.addEventListener("focus", () => {
    if (onDiscordView()) syncDiscordPage();
  });
  // Dev diagnostic: F12 opens the child webview's devtools while the Discord
  // page is on screen (a no-op in release builds).
  window.addEventListener("keydown", (event) => {
    if (event.key === "F12" && onDiscordView()) {
      void invoke("discord_open_devtools").catch(() => undefined);
    }
  });
  // Any covering surface (the changelog, a dialog, the palette) parks the child.
  const observer = new MutationObserver(() => {
    if (onDiscordView()) syncDiscordPage();
  });
  for (const id of COVERING_ROOT_IDS) {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { childList: true });
  }
}

// Page actions (reload). The header button lives in the shared header host, so
// the one document listener picks it up like the other feature listeners.
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-discord-act]")?.dataset.discordAct;
  if (action === "reload") {
    void invoke("discord_view_reload").catch(() => undefined);
  }
});

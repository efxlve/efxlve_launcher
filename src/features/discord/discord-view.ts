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
import { listen } from "@tauri-apps/api/event";
import { DISCORD_INVITE_URL, isTauri } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { icon } from "../../core/icons";
import { clearDiscordUnread, pushNavHistory } from "../../core/nav";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { t } from "../../i18n";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { COVERING_ROOT_IDS, setView } from "../store/store-view";

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

/** Swaps the note under the child webview between "loading" and the stalled
 * state. The child itself stays parked, so this note is what the person sees
 * when Discord never paints. */
function paintLoadingNote(stalled: boolean): void {
  const note = document.getElementById("discord-loading");
  if (!note) return;
  note.innerHTML = stalled
    ? `<p>${esc(t("discord.stalled"))}</p><button type="button" class="btn ghost small" data-discord-act="reload">${icon("refresh", 13)} ${esc(t("discord.reload"))}</button>`
    : `<span class="spinner"></span><p>${esc(t("discord.loading"))}</p>`;
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
  host.innerHTML =
    `<button class="page-action-btn" data-act="open-external-url" data-url="${DISCORD_INVITE_URL}" title="${esc(t("settings.discordJoin"))}">${icon("discord", 14)}<span>${esc(t("settings.discordJoin"))}</span></button>` +
    `<button class="page-action-btn" data-view="settings" data-settings-section="social" title="${esc(t("overlay.tabSettings"))}">${icon("settings", 14)}<span>${esc(t("overlay.tabSettings"))}</span></button>` +
    `<button class="page-action-btn" data-discord-act="reload" title="${esc(t("discord.reload"))}">${icon("refresh", 14)}<span>${esc(t("discord.reload"))}</span></button>`;
  host.classList.add("has-actions");
}

/** Wires the Discord page once it is on screen. */
export function hydrateDiscordPage(): void {
  hydrated = true;
  showErrorToasted = false;
  // Seeing the page is what marks the messages read, however it was opened
  // (sidebar, history, overlay focus).
  clearDiscordUnread();
  ensureListeners();
  paintHeaderActions();
  // The page-enter animation slides the view for a moment. Creating the native
  // child while that animation runs can leave the first renderer stuck on a
  // blank document, so wait for the layout to settle before measuring the slot
  // and creating it. The loading note is on screen during the wait.
  window.setTimeout(() => {
    if (!onDiscordView()) return;
    observeSlot();
    syncDiscordPage();
  }, 450);
}

/** Destroys the child webview when another page takes over. */
export function destroyDiscordPage(): void {
  if (!hydrated) return;
  hydrated = false;
  viewVisible = false;
  paintHeaderActions();
  // The host decides what "destroy" means: with the keep-open setting on (or a
  // call running) it parks the page off-screen instead of closing it.
  void invoke("discord_view_destroy", { keepAlive: keepDiscordOpen() }).catch(() => undefined);
}

/** The launcher's own preference: the Discord page stays loaded in the
 * background so messages and calls arrive while a game runs.
 *
 * Opt-in by default: the parked page runs Discord's whole web client and costs
 * ~30% of a CPU core while idle (measured with the process tree). The lighter
 * Discord SDK/RPC path keeps presence and call detection working either way. */
export function keepDiscordOpen(): boolean {
  return localStorage.getItem("efxlve-discord-always") === "true";
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
  // Dev diagnostics: F12 opens the child webview's devtools, F9 starts the
  // voice watch (a dev shortcut until the overlay's Discord tab wires it),
  // F10 probes the friends-list scope and F11 starts the Social SDK session
  // (the same call the overlay's Connect button makes).
  window.addEventListener("keydown", (event) => {
    if (!onDiscordView()) return;
    if (event.key === "F12") {
      void invoke("discord_open_devtools").catch(() => undefined);
    } else if (event.key === "F9") {
      void invoke("discord_voice_watch_start").catch(() => undefined);
    } else if (event.key === "F10") {
      void invoke("discord_relationships_probe").catch(() => undefined);
    } else if (event.key === "F11") {
      void invoke("discord_sdk_start", { silent: false }).catch(() => undefined);
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
    // The backend lowers the paint gate; put the spinner back until the page
    // reports a paint (or stalls again).
    paintLoadingNote(false);
    void invoke("discord_view_reload").catch(() => undefined);
  }
});

// The client never painted after the one automatic rebuild. Keep the page
// parked and tell the person, instead of showing an empty dark rectangle where
// the Discord UI should be.
void listen("discord-view-stalled", () => {
  if (onDiscordView()) paintLoadingNote(true);
});

// The overlay can ask for one conversation (a friend's DM or a voice channel);
// the child already navigated there, this only brings its page forward.
void listen("overlay-focus-discord", () => {
  setView("discord");
  pushNavHistory({ view: "discord" });
  render();
});

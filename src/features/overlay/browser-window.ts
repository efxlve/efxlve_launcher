/**
 * Chrome of the in-game browser window (`overlay-browser`).
 *
 * The window's own webview is only this chrome: the tab strip, the address bar,
 * window controls, quick bookmarks, and transport buttons. Every tab's page is
 * a native child webview that Rust places into `#ov-browser-frame`, so sites
 * render with the full WebView2 engine (Google sign-in included) instead of an
 * iframe. The chrome reports its frame rect on every resize, and the strip and
 * the address bar follow the tab/url events the child webviews emit.
 */

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { initialLanguage, setLanguage, t } from "../../i18n";
import {
  BOOKMARKS_STORAGE_KEY,
  DEFAULT_BOOKMARKS,
  HOMEPAGE_STORAGE_KEY,
  getHomepage,
  loadBookmarks,
  type QuickBookmark,
} from "./browser-shared";
import "../../styles/tokens.css";
import "../../styles/components.css";
import "./overlay.css";

interface BrowserTab {
  id: number;
  url: string;
  active: boolean;
}

let tabs: BrowserTab[] = [];
let activeUrl = "";
let pipMode = false;
let syncTimer: number | null = null;

function frameRect(): { x: number; y: number; width: number; height: number } {
  const frame = document.getElementById("ov-browser-frame");
  if (!frame) return { x: 0, y: 110, width: 800, height: 500 };
  const rect = frame.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(100, Math.round(rect.width)),
    height: Math.max(100, Math.round(rect.height)),
  };
}

async function emitBounds(): Promise<void> {
  try {
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    const scale = window.devicePixelRatio || 1;
    await emit("overlay-browser-bounds", {
      x: pos.x / scale,
      y: pos.y / scale,
      w: size.width / scale,
      h: size.height / scale,
    });
  } catch {
    void emit("overlay-browser-bounds", {
      x: window.screenX,
      y: window.screenY,
      w: window.outerWidth,
      h: window.outerHeight,
    });
  }
}

async function syncBounds(): Promise<void> {
  const rect = frameRect();
  if (rect.width < 40 || rect.height < 40) return;
  await invoke("overlay_browser_show", rect).catch(() => undefined);
  void emitBounds();
}

function scheduleSyncBounds(): void {
  if (syncTimer !== null) {
    cancelAnimationFrame(syncTimer);
  }
  syncTimer = requestAnimationFrame(() => {
    syncTimer = null;
    void syncBounds();
  });
}

/** The bar reads cleaner without the scheme; edits keep the user's own text. */
function pretty(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function addressInput(): HTMLInputElement | null {
  return document.getElementById("ov-browser-input") as HTMLInputElement | null;
}

function activeTab(): BrowserTab | undefined {
  return tabs.find((tab) => tab.active);
}

function paintUrl(): void {
  const input = addressInput();
  if (input && document.activeElement !== input) {
    input.value = pretty(activeUrl);
  }
}

/** Formats tab title and determines website brand icon from URL. */
function siteMeta(url: string): { title: string; iconName: Parameters<typeof icon>[0] } {
  const host = pretty(url).split(/[/?#]/)[0].toLowerCase().replace(/^www\./, "");
  if (host.includes("youtube.com") || host.includes("youtu.be")) {
    return { title: "YouTube", iconName: "youtube" };
  }
  if (host.includes("google.com")) {
    return { title: "Google", iconName: "search" };
  }
  if (host.includes("twitter.com") || host === "x.com" || host.includes("x.com")) {
    return { title: "Twitter", iconName: "twitter" };
  }
  if (host.includes("reddit.com")) {
    return { title: "Reddit", iconName: "users" };
  }
  if (host.includes("twitch.tv")) {
    return { title: "Twitch", iconName: "monitor" };
  }
  if (host.includes("steamcommunity.com") || host.includes("steampowered.com")) {
    return { title: "Steam", iconName: "gamepad-2" };
  }
  if (host.includes("discord.com")) {
    return { title: "Discord", iconName: "discord" };
  }
  if (host.includes("github.com")) {
    return { title: "GitHub", iconName: "github" };
  }
  if (host.includes("spotify.com")) {
    return { title: "Spotify", iconName: "spotify" };
  }
  const clean = host.split(".")[0];
  const cap = clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : t("overlay.tabBrowser");
  return { title: cap, iconName: "globe" };
}

function paintPipTitle(): void {
  const el = document.getElementById("ov-browser-pip-title");
  if (!el) return;
  const meta = siteMeta(activeUrl);
  el.innerHTML = `${icon(meta.iconName, 12)}<span>${esc(meta.title)}</span>`;
}

function applyPip(enabled: boolean): void {
  pipMode = enabled;
  document.body.classList.toggle("ov-browser-pip", enabled);
  paintPipTitle();
  scheduleSyncBounds();
}

function paintTabs(): void {
  const strip = document.getElementById("ov-browser-tabs");
  if (!strip) return;
  strip.innerHTML =
    tabs
      .map((tab) => {
        const meta = siteMeta(tab.url);
        return `
      <div class="ov-browser-tab${tab.active ? " is-active" : ""}" data-tab="${tab.id}" title="${esc(tab.url)}">
        <span class="ov-browser-tab-favicon">${icon(meta.iconName, 12)}</span>
        <span class="ov-browser-tab-title">${esc(meta.title)}</span>
        <button class="ov-browser-tab-x" data-tab-x="${tab.id}" title="${esc(t("common.close"))}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>`;
      })
      .join("") +
    `<button class="ov-browser-tab-new" data-tab-new title="${esc(t("overlay.browserNewTab"))}">${icon("plus", 13)}</button>`;
  paintUrl();
  paintPipTitle();
}

function goto(input: string): void {
  void invoke("overlay_browser_navigate", { url: input }).catch(() => undefined);
}

async function newTab(url?: string): Promise<void> {
  const target = url || getHomepage();
  try {
    const res = await invoke<{ tabs?: BrowserTab[] }>("overlay_browser_new_tab", {
      url: target,
      ...frameRect(),
    });
    if (res?.tabs && res.tabs.length > 0) {
      tabs = res.tabs;
      const active = activeTab();
      if (active) activeUrl = active.url;
      paintTabs();
    }
  } catch (err) {
    console.error("Failed to create new tab:", err);
  }
}

async function closeTab(id: number): Promise<void> {
  try {
    const res = await invoke<{ tabs?: BrowserTab[] }>("overlay_browser_close_tab", {
      id,
      ...frameRect(),
    });
    if (res?.tabs) {
      tabs = res.tabs;
      const active = activeTab();
      if (active) activeUrl = active.url;
      paintTabs();
    }
  } catch (err) {
    console.error("Failed to close tab:", err);
  }
}

async function activateTab(id: number): Promise<void> {
  for (const t of tabs) {
    t.active = t.id === id;
  }
  const active = activeTab();
  if (active) activeUrl = active.url;
  paintTabs();

  try {
    const res = await invoke<{ tabs?: BrowserTab[] }>("overlay_browser_activate_tab", {
      id,
      ...frameRect(),
    });
    if (res?.tabs) {
      tabs = res.tabs;
      const act = activeTab();
      if (act) activeUrl = act.url;
      paintTabs();
    }
  } catch (err) {
    console.error("Failed to activate tab:", err);
  }
}

/** Hides the browser window and emits close state to the overlay. */
function closeWindow(): void {
  // Let the owner hide the browser and update IS_OPEN in one place. Hiding the
  // WebView locally as well made close run twice and woke the panel afterwards.
  void invoke("overlay_browser_close").catch(() => undefined);
}

function chromeHtml(): string {
  const navBtn = (act: string, iconName: Parameters<typeof icon>[0], label: string): string =>
    `<button class="ov-browser-nav-btn" data-br="${act}" title="${esc(label)}">${icon(iconName, 15)}</button>`;
  return `
    <div class="ov-browser-nav">
      ${navBtn("back", "chevron-left", t("common.back"))}
      ${navBtn("forward", "chevron-right", t("overlay.next"))}
      ${navBtn("reload", "refresh", t("overlay.refresh"))}
      ${navBtn("home", "home", t("overlay.tabHome"))}
    </div>
    <div class="ov-browser-omnibox">
      <span class="ov-browser-omni-icon">${icon("search", 13)}</span>
      <input id="ov-browser-input" class="ov-browser-input" spellcheck="false"
        placeholder="${esc(t("overlay.browserAddress"))}" />
      <button class="ov-browser-omni-clear" id="ov-browser-clear-btn" title="Temizle" style="display:none">
        ${icon("x", 12)}
      </button>
    </div>`;
}

function bookmarksHtml(): string {
  return loadBookmarks().map(
    (bm) => `
    <button class="ov-browser-bm-chip" data-bm="${esc(bm.url)}" title="${esc(bm.url)}">
      ${icon(bm.iconName || "globe", 12)}
      <span>${esc(bm.label)}</span>
    </button>`,
  ).join("");
}

export function refreshBookmarksBar(): void {
  const bmBar = document.getElementById("ov-browser-bookmarks");
  if (bmBar) bmBar.innerHTML = bookmarksHtml();
}

function wire(): void {
  const chrome = document.getElementById("ov-browser-chrome");
  if (chrome) chrome.innerHTML = chromeHtml();

  refreshBookmarksBar();

  const pipToggle = document.querySelector<HTMLElement>('[data-pip="toggle"]');
  if (pipToggle) pipToggle.title = t("overlay.browserPip");
  const pipRestore = document.querySelector<HTMLElement>('[data-pip="restore"]');
  if (pipRestore) pipRestore.title = t("overlay.browserPipExit");
  const pipClose = document.querySelector<HTMLElement>('[data-pip="close"]');
  if (pipClose) pipClose.title = t("common.close");

  // Raise browser window above overlay widgets when interacted with
  window.addEventListener("mousedown", () => {
    void invoke("overlay_browser_raise").catch(() => undefined);
  });
  window.addEventListener("focus", () => {
    void invoke("overlay_browser_raise").catch(() => undefined);
  });
  window.addEventListener("resize", () => {
    void emitBounds();
  });

  // Window Controls & Clicks
  document.addEventListener("click", (event) => {
    const el = event.target as HTMLElement;

    // Picture-in-picture controls.
    const pipAct = el.closest<HTMLElement>("[data-pip]")?.dataset.pip;
    if (pipAct) {
      if (pipAct === "toggle") {
        void invoke("overlay_browser_set_pip", { enabled: !pipMode }).catch(() => undefined);
      } else if (pipAct === "restore") {
        void invoke("overlay_browser_set_pip", { enabled: false }).catch(() => undefined);
      } else if (pipAct === "close") {
        closeWindow();
      }
      return;
    }

    // Window close button
    const winAct = el.closest<HTMLElement>("[data-win]")?.dataset.win;
    if (winAct) {
      closeWindow();
      return;
    }

    // Bookmark chips - always open in a new tab
    const bmUrl = el.closest<HTMLElement>("[data-bm]")?.dataset.bm;
    if (bmUrl) {
      void newTab(bmUrl);
      return;
    }

    // Clear omnibox input
    if (el.closest("#ov-browser-clear-btn")) {
      const input = addressInput();
      if (input) {
        input.value = "";
        input.focus();
        toggleClearButton();
      }
      return;
    }

    // Close tab button
    const closeId = el.closest<HTMLElement>("[data-tab-x]")?.dataset.tabX;
    if (closeId) {
      void closeTab(Number(closeId));
      return;
    }

    // New tab button
    if (el.closest("[data-tab-new]")) {
      void newTab();
      return;
    }

    // Activate tab
    const tabEl = el.closest<HTMLElement>("[data-tab]");
    if (tabEl && !el.closest("[data-tab-x]")) {
      const tabId = Number(tabEl.dataset.tab);
      if (tabId) void activateTab(tabId);
      return;
    }

    // Browser navigation actions
    const act = el.closest<HTMLElement>("[data-br]")?.dataset.br;
    if (!act) return;
    if (act === "close") {
      closeWindow();
      return;
    }
    if (act === "home") {
      goto(getHomepage());
      return;
    }
    void invoke("overlay_browser_action", { action: act }).catch(() => undefined);
  });

  // Middle-click on tab to close
  document.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const el = event.target as HTMLElement;
    const tabEl = el.closest<HTMLElement>("[data-tab]");
    if (tabEl && !el.closest("[data-tab-x]")) {
      event.preventDefault();
      const tabId = Number(tabEl.dataset.tab);
      if (tabId) void closeTab(tabId);
    }
  });

  // Window drag fallback using overlay_browser_set_position
  let isDragging = false;
  let startMouseX = 0;
  let startMouseY = 0;
  let startWinX = 0;
  let startWinY = 0;

  document.addEventListener("mousedown", async (event) => {
    if (event.button !== 0) return;
    const el = event.target as HTMLElement | null;
    if (!el || el.closest("button, input, a, .ov-browser-tab, .ov-browser-bm-chip, [data-win]")) return;
    if (!el.closest(".ov-browser-topbar, .ov-browser-drag-filler, .ov-browser-tabs-wrapper, #ov-browser-chrome, #ov-browser-bookmarks, .ov-browser-pipbar")) return;

    // Trigger native Tauri drag first
    void getCurrentWindow().startDragging().catch(() => undefined);

    // Track mouse coordinates for reliable SetWindowPos repositioning
    try {
      const pos = await getCurrentWindow().outerPosition();
      startWinX = pos.x;
      startWinY = pos.y;
      startMouseX = event.screenX;
      startMouseY = event.screenY;
      isDragging = true;
    } catch {
      // ignore
    }
  });

  window.addEventListener("mousemove", (event) => {
    if (!isDragging) return;
    if ((event.buttons & 1) === 0) {
      isDragging = false;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const dx = (event.screenX - startMouseX) * dpr;
    const dy = (event.screenY - startMouseY) * dpr;
    const newX = Math.round(startWinX + dx);
    const newY = Math.round(startWinY + dy);
    void invoke("overlay_browser_set_position", { x: newX, y: newY }).catch(() => undefined);
  });

  window.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      void emitBounds();
    }
  });

  const input = addressInput();
  function toggleClearButton(): void {
    const clearBtn = document.getElementById("ov-browser-clear-btn");
    if (clearBtn && input) {
      clearBtn.style.display = input.value.trim() ? "flex" : "none";
    }
  }

  input?.addEventListener("input", toggleClearButton);
  input?.addEventListener("focus", () => {
    input.select();
    toggleClearButton();
  });
  input?.addEventListener("blur", () => {
    setTimeout(toggleClearButton, 150);
  });

  input?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      input.blur();
      paintUrl();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    goto(input.value);
  });

  // Global hotkeys inside browser
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeWindow();
      return;
    }
    if (event.key === "F5") {
      event.preventDefault();
      void invoke("overlay_browser_action", { action: "reload" }).catch(() => undefined);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.key === "t") {
        event.preventDefault();
        void newTab();
      } else if (event.key === "w") {
        event.preventDefault();
        const active = activeTab();
        if (active) void closeTab(active.id);
      } else if (event.key === "r") {
        event.preventDefault();
        void invoke("overlay_browser_action", { action: "reload" }).catch(() => undefined);
      } else if (event.key === "l") {
        event.preventDefault();
        addressInput()?.focus();
      }
    }
  });

  // Real-time frame bounds sync via ResizeObserver
  const frameEl = document.getElementById("ov-browser-frame");
  if (frameEl && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      scheduleSyncBounds();
    });
    ro.observe(frameEl);
  }
  window.addEventListener("resize", scheduleSyncBounds);

  // The panel owner hides this window through `browser::hide_with_overlay`
  // unless it is a PiP player. Keep a local hide as a safety net, but do not
  // call overlay_browser_close a second time.
  void listen("overlay-close", async () => {
    // A corner player survives the panel close; only a normal browser hides.
    if (pipMode) return;
    const pip = await invoke<boolean>("overlay_browser_is_pip").catch(() => false);
    if (pip) return;
    void getCurrentWindow().hide().catch(() => undefined);
  }).catch(() => undefined);

  void listen<{ enabled: boolean }>("overlay-browser-pip", (event) => {
    applyPip(Boolean(event.payload?.enabled));
  }).catch(() => undefined);

  // Tabs and URL events from Rust
  void listen<{ id: number; url: string }>("overlay-browser-url", (event) => {
    const payload = event.payload;
    if (!payload) return;
    const hit = tabs.find((tab) => tab.id === payload.id);
    if (hit) hit.url = payload.url;
    if (hit?.active) activeUrl = payload.url;
    paintTabs();
  }).catch(() => undefined);

  void listen<{ tabs?: BrowserTab[] }>("overlay-browser-tabs", (event) => {
    tabs = event.payload?.tabs ?? [];
    const active = activeTab();
    if (active) activeUrl = active.url;
    paintTabs();
  }).catch(() => undefined);

  void listen<string>("overlay-browser-new-tab", (event) => {
    if (event.payload) {
      void newTab(event.payload);
    }
  }).catch(() => undefined);

  void listen("overlay-browser-bookmarks-updated", () => {
    refreshBookmarksBar();
  }).catch(() => undefined);

  window.addEventListener("storage", (event) => {
    if (event.key === BOOKMARKS_STORAGE_KEY) {
      refreshBookmarksBar();
    }
  });
}

async function boot(): Promise<void> {
  document.documentElement.dataset.surface = "soft";
  await setLanguage(initialLanguage());
  wire();

  // Strip events can fire before listeners exist: ask for initial tab list
  const initial = await invoke<{ tabs?: BrowserTab[] }>("overlay_browser_tabs").catch(() => null);
  if (initial?.tabs) {
    tabs = initial.tabs;
    const active = activeTab();
    if (active) activeUrl = active.url;
    paintTabs();
  }
  await syncBounds();
  const pip = await invoke<boolean>("overlay_browser_is_pip").catch(() => false);
  if (pip) applyPip(true);
}

// `browser.html` owns this module. Guard the boot so a future import for a
// helper cannot start the browser chrome inside the overlay panel again.
if (document.getElementById("ov-browser-frame")) void boot();

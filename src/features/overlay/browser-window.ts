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
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { initialLanguage, setLanguage, t } from "../../i18n";
import "../../styles/tokens.css";
import "../../styles/components.css";
import "./overlay.css";

interface BrowserTab {
  id: number;
  url: string;
  active: boolean;
}

interface QuickBookmark {
  label: string;
  iconName: Parameters<typeof icon>[0];
  url: string;
}

const QUICK_BOOKMARKS: QuickBookmark[] = [
  { label: "Google", iconName: "search", url: "https://www.google.com" },
  { label: "YouTube", iconName: "play", url: "https://www.youtube.com" },
  { label: "Reddit", iconName: "users", url: "https://www.reddit.com/r/gaming" },
  { label: "Twitch", iconName: "monitor", url: "https://www.twitch.tv" },
  { label: "Steam Guides", iconName: "gamepad-2", url: "https://steamcommunity.com" },
  { label: "Game8", iconName: "sparkles", url: "https://game8.co" },
];

let tabs: BrowserTab[] = [];
let activeUrl = "";
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

async function syncBounds(): Promise<void> {
  const rect = frameRect();
  if (rect.width < 40 || rect.height < 40) return;
  await invoke("overlay_browser_show", rect).catch(() => undefined);
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

/** A tab is known by its site: host only, so long paths do not crowd the strip. */
function tabLabel(tab: BrowserTab): string {
  const host = pretty(tab.url).split(/[/?#]/)[0];
  return host || t("overlay.tabBrowser");
}

function paintTabs(): void {
  const strip = document.getElementById("ov-browser-tabs");
  if (!strip) return;
  strip.innerHTML =
    tabs
      .map(
        (tab) => `
      <div class="ov-browser-tab${tab.active ? " is-active" : ""}" data-tab="${tab.id}" title="${esc(tab.url)}">
        <span class="ov-browser-tab-favicon">${icon("globe", 12)}</span>
        <span class="ov-browser-tab-title">${esc(tabLabel(tab))}</span>
        <button class="ov-browser-tab-x" data-tab-x="${tab.id}" title="${esc(t("common.close"))}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>`,
      )
      .join("") +
    `<button class="ov-browser-tab-new" data-tab-new title="${esc(t("overlay.browserNewTab"))}">${icon("plus", 13)}</button>`;
  paintUrl();
}

function goto(input: string): void {
  void invoke("overlay_browser_navigate", { url: input }).catch(() => undefined);
}

function newTab(url?: string): void {
  void invoke("overlay_browser_new_tab", { url: url || null, ...frameRect() }).catch(() => undefined);
}

function closeTab(id: number): void {
  void invoke("overlay_browser_close_tab", { id, ...frameRect() }).catch(() => undefined);
}

/** Hides the browser window and emits close state to the overlay. */
function closeWindow(): void {
  void getCurrentWindow().hide().catch(() => undefined);
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
      ${navBtn("home", "globe", t("overlay.tabBrowser"))}
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
  return QUICK_BOOKMARKS.map(
    (bm) => `
    <button class="ov-browser-bm-chip" data-bm="${esc(bm.url)}" title="${esc(bm.url)}">
      ${icon(bm.iconName, 12)}
      <span>${esc(bm.label)}</span>
    </button>`,
  ).join("");
}

function wire(): void {
  const badgeIcon = document.getElementById("ov-browser-badge-icon");
  if (badgeIcon) badgeIcon.innerHTML = icon("globe", 14);

  const chrome = document.getElementById("ov-browser-chrome");
  if (chrome) chrome.innerHTML = chromeHtml();

  const bmBar = document.getElementById("ov-browser-bookmarks");
  if (bmBar) bmBar.innerHTML = bookmarksHtml();

  // Window Controls & Clicks
  document.addEventListener("click", (event) => {
    const el = event.target as HTMLElement;

    // Window control buttons (minimize, maximize, close)
    const winAct = el.closest<HTMLElement>("[data-win]")?.dataset.win;
    if (winAct) {
      if (winAct === "minimize" || winAct === "close") {
        closeWindow();
      } else if (winAct === "maximize") {
        void getCurrentWindow().toggleMaximize().catch(() => undefined);
      }
      return;
    }

    // Bookmark chips
    const bmUrl = el.closest<HTMLElement>("[data-bm]")?.dataset.bm;
    if (bmUrl) {
      if (event.ctrlKey || event.metaKey) {
        newTab(bmUrl);
      } else {
        goto(bmUrl);
      }
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
      closeTab(Number(closeId));
      return;
    }

    // New tab button
    if (el.closest("[data-tab-new]")) {
      newTab();
      return;
    }

    // Activate tab
    const tabId = el.closest<HTMLElement>("[data-tab]")?.dataset.tab;
    if (tabId) {
      void invoke("overlay_browser_activate_tab", { id: Number(tabId), ...frameRect() }).catch(() => undefined);
      return;
    }

    // Browser navigation actions
    const act = el.closest<HTMLElement>("[data-br]")?.dataset.br;
    if (!act) return;
    if (act === "close") {
      closeWindow();
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
      if (tabId) closeTab(tabId);
    }
  });

  // Window drag on topbar, chrome, or bookmark empty areas
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const el = event.target as HTMLElement | null;
    if (!el || el.closest("button, input, a, .ov-browser-tab, .ov-browser-bm-chip, [data-win]")) return;
    if (el.closest(".ov-browser-topbar, .ov-browser-badge, .ov-browser-tabs-wrapper, #ov-browser-chrome, #ov-browser-bookmarks")) {
      void getCurrentWindow().startDragging().catch(() => undefined);
    }
  });

  // Double click topbar to toggle maximize
  document.addEventListener("dblclick", (event) => {
    const el = event.target as HTMLElement | null;
    if (!el || el.closest("button, input, a, .ov-browser-tab, .ov-browser-bm-chip, [data-win]")) return;
    if (el.closest(".ov-browser-topbar, .ov-browser-badge, .ov-browser-tabs-wrapper")) {
      void getCurrentWindow().toggleMaximize().catch(() => undefined);
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
        newTab();
      } else if (event.key === "w") {
        event.preventDefault();
        const active = activeTab();
        if (active) closeTab(active.id);
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

  // Synchronize when the overlay itself closes: hide this window immediately!
  void listen("overlay-close", () => {
    closeWindow();
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
}

void boot();

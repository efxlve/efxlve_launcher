/**
 * Chrome of the in-game browser window (`overlay-browser`).
 *
 * The window's own webview is only this chrome: the tab strip, the address bar
 * and the transport buttons. Every tab's page is a native child webview that
 * Rust places into `#ov-browser-frame`, so sites render with the full WebView2
 * engine (Google sign-in included) instead of an iframe. The chrome reports its
 * frame rect on every resize, and the strip and the address bar follow the
 * tab/url events the child webviews emit.
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

let tabs: BrowserTab[] = [];
let activeUrl = "";

function frameRect(): { x: number; y: number; width: number; height: number } {
  const frame = document.getElementById("ov-browser-frame");
  if (!frame) return { x: 0, y: 90, width: 800, height: 500 };
  const rect = frame.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

async function syncBounds(): Promise<void> {
  const rect = frameRect();
  if (rect.width < 40 || rect.height < 40) return;
  await invoke("overlay_browser_show", rect).catch(() => undefined);
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
  if (input && document.activeElement !== input) input.value = pretty(activeUrl);
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
        <span class="ov-browser-tab-title">${esc(tabLabel(tab))}</span>
        <button class="ov-browser-tab-x" data-tab-x="${tab.id}" title="${esc(t("common.close"))}">${icon("x", 10)}</button>
      </div>`,
      )
      .join("") +
    `<button class="ov-browser-tab-new" data-tab-new title="${esc(t("overlay.browserNewTab"))}">${icon("plus", 12)}</button>`;
  paintUrl();
}

function goto(input: string): void {
  void invoke("overlay_browser_navigate", { url: input }).catch(() => undefined);
}

function newTab(): void {
  void invoke("overlay_browser_new_tab", { url: null, ...frameRect() }).catch(() => undefined);
}

function closeTab(id: number): void {
  void invoke("overlay_browser_close_tab", { id, ...frameRect() }).catch(() => undefined);
}

/** Hides the browser; the panel it was opened from is still there behind it. */
function closeWindow(): void {
  void invoke("overlay_browser_close").catch(() => undefined);
}

function chromeHtml(): string {
  const navBtn = (act: string, iconName: Parameters<typeof icon>[0], label: string): string =>
    `<button class="icon-btn" data-br="${act}" title="${esc(label)}">${icon(iconName, 16)}</button>`;
  return `
    <div class="ov-browser-nav">
      ${navBtn("back", "chevron-left", t("common.back"))}
      ${navBtn("forward", "chevron-right", t("overlay.next"))}
      ${navBtn("reload", "refresh", t("overlay.refresh"))}
    </div>
    <input id="ov-browser-input" class="input ov-browser-input" spellcheck="false"
      placeholder="${esc(t("overlay.browserAddress"))}" />
    ${navBtn("home", "globe", t("overlay.tabBrowser"))}
    <button class="modal-close-btn" data-br="close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>`;
}

function wire(): void {
  const chrome = document.getElementById("ov-browser-chrome");
  if (chrome) chrome.innerHTML = chromeHtml();

  document.addEventListener("click", (event) => {
    const el = event.target as HTMLElement;

    const closeId = el.closest<HTMLElement>("[data-tab-x]")?.dataset.tabX;
    if (closeId) {
      closeTab(Number(closeId));
      return;
    }
    if (el.closest("[data-tab-new]")) {
      newTab();
      return;
    }
    const tabId = el.closest<HTMLElement>("[data-tab]")?.dataset.tab;
    if (tabId) {
      void invoke("overlay_browser_activate_tab", { id: Number(tabId), ...frameRect() }).catch(() => undefined);
      return;
    }

    const act = el.closest<HTMLElement>("[data-br]")?.dataset.br;
    if (!act) return;
    if (act === "close") {
      closeWindow();
      return;
    }
    void invoke("overlay_browser_action", { action: act }).catch(() => undefined);
  });

  // Belt and braces for the drag handles: the native attribute plus an explicit
  // startDragging, so the window moves on every setup. Only the handle itself
  // counts as a hit, exactly like the native check, so tabs stay clickable.
  document.addEventListener("mousedown", (event) => {
    const el = event.target as HTMLElement | null;
    if (!el || !el.hasAttribute("data-tauri-drag-region") || el.closest("button, input, a")) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  });

  const input = addressInput();
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // First Esc leaves the bar; a later one closes the window (below).
      event.preventDefault();
      event.stopPropagation();
      input.blur();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    goto(input.value);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeWindow();
      return;
    }
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.key === "t") {
      event.preventDefault();
      newTab();
    } else if (event.key === "w") {
      event.preventDefault();
      const active = activeTab();
      if (active) closeTab(active.id);
    }
  });

  window.addEventListener("resize", () => void syncBounds());

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
  await setLanguage(initialLanguage());
  wire();
  // Strip events can fire before the listeners exist: ask for the current list
  // once, so a window that is already open comes back with its tabs drawn.
  const initial = await invoke<{ tabs?: BrowserTab[] }>("overlay_browser_tabs").catch(() => null);
  if (initial?.tabs) {
    tabs = initial.tabs;
    const active = activeTab();
    if (active) activeUrl = active.url;
    paintTabs();
  }
  await syncBounds();
  addressInput()?.focus();
}

void boot();

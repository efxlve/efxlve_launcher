/**
 * In-game & Web Browser hub for Stage mode.
 *
 * Provides a console-grade web portal with curated quick-access gaming bookmarks,
 * search omnibox, and seamless invocation of the native hardware-accelerated webview.
 */

import { invoke } from "@tauri-apps/api/core";
import { icon, type IconName } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { stageFeedback } from "./stage-sound";

export interface BrowserBookmark {
  id: string;
  title: string;
  url: string;
  iconName: IconName;
}

const DEFAULT_BOOKMARKS: BrowserBookmark[] = [
  { id: "youtube", title: "YouTube", url: "https://www.youtube.com", iconName: "youtube" },
  { id: "twitch", title: "Twitch", url: "https://www.twitch.tv", iconName: "video" },
  { id: "discord", title: "Discord", url: "https://discord.com/app", iconName: "discord" },
  { id: "reddit", title: "Reddit", url: "https://www.reddit.com", iconName: "users" },
  { id: "hltb", title: "HowLongToBeat", url: "https://howlongtobeat.com", iconName: "clock" },
  { id: "speedrun", title: "Speedrun.com", url: "https://www.speedrun.com", iconName: "zap" },
  { id: "steam", title: "Steam Community", url: "https://steamcommunity.com", iconName: "users" },
  { id: "google", title: "Google", url: "https://www.google.com", iconName: "globe" },
];

export function normalizeBrowserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "https://www.google.com";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export async function stageLaunchBrowser(rawUrl?: string): Promise<void> {
  stageFeedback("launch");
  const targetUrl = normalizeBrowserUrl(rawUrl || S.stage.browserUrl || "https://www.google.com");
  S.stage.browserUrl = targetUrl;
  await invoke("overlay_browser_open", { url: targetUrl }).catch(() => undefined);
  S.stage.browserOpen = false;
  scheduleRender();
}

export async function stageCloseBrowserWindow(): Promise<void> {
  stageFeedback("back");
  await invoke("overlay_browser_close").catch(() => undefined);
  scheduleRender();
}

export function stageOpenBrowserSheet(): void {
  stageFeedback("select");
  S.stage.browserOpen = true;
  S.stage.spotifyOpen = false;
  S.stage.discordOpen = false;
  S.stage.quickMenu = false;
  S.stage.focusKey = "browser:input";
  scheduleRender();
}

export function stageCloseBrowserSheet(): void {
  stageFeedback("back");
  S.stage.browserOpen = false;
  S.stage.focusKey = "";
  scheduleRender();
}

export function renderStageBrowserSheet(entered: boolean): string {
  const url = S.stage.browserUrl || "";

  return `<div class="stage-overlay stage-browser-sheet${entered ? " stage-overlay-enter" : ""}">
    <div class="stage-browser-panel" role="dialog" aria-modal="true" aria-label="${esc(t("overlay.tabBrowser"))}">
      <div class="stage-browser-head">
        <div class="stage-browser-title-wrap">
          <span class="stage-browser-icon-main">${icon("globe", 26)}</span>
          <div>
            <h2 class="stage-browser-title">${esc(t("overlay.tabBrowser"))}</h2>
            <span class="stage-browser-subtitle">${esc(t("overlay.browserAddress"))}</span>
          </div>
        </div>
        <button type="button" class="stage-icon-btn" data-stage-act="close-browser-sheet" data-gp-item data-gp-key="browser:close" aria-label="${esc(t("common.close"))}">
          ${icon("x", 20)}
        </button>
      </div>

      <div class="stage-browser-omnibox">
        <span class="stage-browser-omni-icon">${icon("search", 18)}</span>
        <input
          id="stage-browser-input"
          class="stage-browser-input"
          type="text"
          value="${esc(url)}"
          placeholder="https://... ${esc(t("overlay.browserAddress"))}"
          autocomplete="off"
          spellcheck="false"
          data-gp-item
          data-gp-key="browser:input"
          data-gp-default
        />
        <button type="button" class="stage-btn stage-btn-primary stage-browser-go" data-stage-act="browser-go" data-gp-item data-gp-key="browser:go">
          ${icon("arrow-right", 16)} <span>${esc(t("stage.open"))}</span>
        </button>
      </div>

      <div class="stage-browser-shelf">
        <div class="stage-browser-shelf-title">
          <span>${icon("star", 14)}</span>
          <strong>${esc(t("overlay.browserBookmarksTitle"))}</strong>
        </div>
        <div class="stage-browser-bookmarks">
          ${DEFAULT_BOOKMARKS.map((bm) => `
            <button
              type="button"
              class="stage-browser-chip"
              data-stage-act="browser-bookmark"
              data-url="${esc(bm.url)}"
              data-gp-item
              data-gp-key="bm:${esc(bm.id)}"
              aria-label="${esc(bm.title)}"
            >
              <span class="stage-bm-icon">${icon(bm.iconName, 18)}</span>
              <span class="stage-bm-title">${esc(bm.title)}</span>
            </button>
          `).join("")}
        </div>
      </div>

      <div class="stage-browser-foot">
        <div class="stage-browser-actions">
          <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="browser-close-window" data-gp-item data-gp-key="browser:close-window">
            ${icon("x", 15)} <span>${esc(t("common.close"))}</span>
          </button>
        </div>
        <div class="stage-browser-hints">
          <span>${icon("info", 14)} ${esc(t("overlay.browserDesc"))}</span>
        </div>
      </div>
    </div>
  </div>`;
}

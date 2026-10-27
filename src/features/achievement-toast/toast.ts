/**
 * In-game achievement toast. Renders the same `achCardHtml` component as the
 * Settings stage, so the preview is the notification.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../core/constants";
import { achievementCardPalette } from "../../core/achievement-card-theme";
import { initialLanguage, setLanguage } from "../../i18n";
import { achCardHtml, achTagLine, type AchCardPalette } from "../achievement-card/ach-card";
import { playAchCardEntry, playAchCardExit } from "../achievement-card/ach-card-motion";
import "../../styles/tokens.css";
import "../../styles/theme-system.css";
import "./toast.css";

interface ToastPayload {
  generation: number;
  title: string;
  body: string;
  tier: number;
  unlocked: number;
  total: number;
  rarityPercent: number | null;
  theme: string;
  size: string;
  position: string;
  style: string;
  exitStyle?: string;
  holdMs: number;
  palette: AchCardPalette;
  tagless?: boolean;
  icon?: string;
}

interface ToastIconPayload {
  generation: number;
  src: string;
}

let sequence = 1;
let exitTimer: number | null = null;
let current: ToastPayload | null = null;

const POSITIONS = [
  "top-left",
  "center-top",
  "top-right",
  "bottom-left",
  "center-bottom",
  "bottom-right",
] as const;

function safePosition(value: string | undefined): (typeof POSITIONS)[number] {
  return POSITIONS.includes(value as (typeof POSITIONS)[number])
    ? (value as (typeof POSITIONS)[number])
    : "top-right";
}

function clearExitTimer(): void {
  if (exitTimer !== null) {
    window.clearTimeout(exitTimer);
    exitTimer = null;
  }
}

function renderToast(payload: ToastPayload): void {
  const root = document.getElementById("ach-toast-root");
  if (!root) return;
  current = payload;
  sequence += 1;
  const position = safePosition(payload.position);
  // Static themes come from the same TS palette the preview uses; "launcher"
  // needs the live theme tokens, which the main window pushes to Rust.
  const palette =
    payload.theme === "launcher"
      ? payload.palette
      : achievementCardPalette(payload.theme, payload.tier);
  root.innerHTML = `<div class="ach-toast-layer pos-${position}">${achCardHtml({
    tag: payload.tagless
      ? ""
      : achTagLine(payload.tier, payload.unlocked, payload.total, payload.rarityPercent),
    title: payload.title,
    desc: payload.body,
    tier: payload.tier,
    size: payload.size,
    style: payload.style,
    theme: payload.theme,
    palette,
    seq: sequence,
    glyph: payload.tagless ? "layers" : "trophy",
    iconSrc: payload.icon || undefined,
    hint: Boolean(payload.tagless),
  })}</div>`;

  const card = root.querySelector<HTMLElement>(".ach-hud-toast");
  if (!card) return;
  playAchCardEntry(card, payload.style, payload.tier);

  clearExitTimer();
  exitTimer = window.setTimeout(() => {
    playAchCardExit(card, payload.style, payload.exitStyle || "auto", () => {
      void invoke("toast_done", { generation: payload.generation }).catch(() => {});
    });
  }, Math.max(1200, payload.holdMs));
}

function applyIcon(payload: ToastIconPayload): void {
  if (!current || payload.generation !== current.generation) return;
  if (current.tagless) {
    const badge = document.querySelector<HTMLElement>(".ach-hint-badge");
    if (!badge) return;
    badge.querySelector(".ach-hint-ico")?.remove();
    badge.querySelector(".ach-hint-app-icon")?.remove();
    const img = document.createElement("img");
    img.className = "ach-hint-app-icon";
    img.alt = "";
    img.src = payload.src;
    badge.appendChild(img);
    return;
  }
  const medal = document.querySelector<HTMLElement>(".ach-hud-medallion");
  if (!medal) return;
  medal.querySelector(".ach-hud-trophy-ico")?.remove();
  const previous = medal.querySelector(".ach-hud-ach-icon");
  if (previous) previous.remove();
  const img = document.createElement("img");
  img.className = "ach-hud-ach-icon";
  img.alt = "";
  img.src = payload.src;
  medal.appendChild(img);
}

function renderDemo(): void {
  const params = new URLSearchParams(location.search);
  const isHint = params.get("hint") === "true";
  const tier = isHint ? 2 : 3;
  const palette = achievementCardPalette("rarity", tier);
  const style = params.get("style") || "prism";
  const size = params.get("size") || "normal";
  const position = safePosition(params.get("position") || "top-right");
  const root = document.getElementById("ach-toast-root");
  if (!root) return;
  root.innerHTML = `<div class="ach-toast-layer pos-${position}">${achCardHtml({
    tag: isHint ? "" : achTagLine(3, 31, 34, 1.8),
    title: isHint ? "Shift+Tab overlay" : "The Impossible Dream",
    desc: isHint
      ? "Press Shift+Tab to open the overlay. Esc closes it."
      : "Complete the campaign on Legendary difficulty without dying once.",
    tier,
    size,
    style,
    theme: "rarity",
    palette,
    seq: 1,
    glyph: isHint ? "layers" : "trophy",
    hint: isHint,
  })}</div>`;
  const card = root.querySelector<HTMLElement>(".ach-hud-toast");
  if (card) playAchCardEntry(card, style, tier);
}

async function boot(): Promise<void> {
  await setLanguage(initialLanguage()).catch(() => undefined);
  if (!isTauri) {
    renderDemo();
    return;
  }
  await listen<ToastPayload>("ach-toast", (event) => {
    renderToast(event.payload);
  });
  await listen<ToastIconPayload>("ach-toast-icon", (event) => {
    applyIcon(event.payload);
  });
  // The page is up: Rust replays a payload that arrived while it was booting.
  await invoke("toast_ready").catch(() => {});
}

void boot();

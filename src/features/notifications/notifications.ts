/**
 * In-app notification center.
 *
 * Keeps a capped, persisted history of notable events (download finished,
 * update available, errors, social...). The bell lives in the sidebar footer;
 * the panel is a fixed dropdown anchored to it. Items are real buttons so the
 * 10-foot gamepad focus model keeps working.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EOS_OVERLAY_DECLINE_KEY, NOTIF_KEY, isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import type { AppNotification, NotifKind } from "../../core/types";
import { esc, relativeTime } from "../../core/utils";
import { t } from "../../i18n";
import { embeddedStoreHeld, syncStoreViewSize } from "../store/store-view";

const MAX = 50;
/** Re-pushing the same event within this window refreshes instead of duplicating. */
const DEDUPE_MS = 10 * 60 * 1000;
/** Restored history older than this is dropped: it is news, not a mailbox. */
const RESTORE_TTL_MS = 24 * 60 * 60 * 1000;

const KIND_ICON: Record<NotifKind, Parameters<typeof icon>[0]> = {
  download: "download",
  update: "refresh",
  error: "alert-triangle",
  info: "info",
  social: "users",
};

/** Restores the persisted notification history (invalid entries are dropped). */
export function loadNotifications(): void {
  bindNotifOverlay();
  try {
    const raw = localStorage.getItem(NOTIF_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as AppNotification[];
    if (Array.isArray(parsed)) {
      const now = Date.now();
      // A restored entry is history, not a new event: an unread badge that survived
      // a restart announced old news (reported: "12 h ago" right after boot). Stale
      // entries past the TTL are dropped so the bell never shows yesterday's count.
      S.notifications = parsed
        .filter((n) => n && typeof n.id === "string" && now - n.ts < RESTORE_TTL_MS)
        .map((n) => ({ ...n, read: true }))
        .slice(0, MAX);
      if (!S.notifications.length) localStorage.removeItem(NOTIF_KEY);
    }
  } catch {
    // Corrupt history is not worth surfacing; start clean.
  }
}

function persist(): void {
  try {
    localStorage.setItem(NOTIF_KEY, JSON.stringify(S.notifications.slice(0, MAX)));
  } catch {
    // Storage full/blocked: history stays in memory only.
  }
}

export interface NotifInput {
  kind: NotifKind;
  title: string;
  body?: string;
  appName?: string;
  /** Optional `data-act` routed when the entry is clicked. */
  action?: string;
  /** Short label for that action, shown as a chip inside the entry. */
  actionLabel?: string;
  toast?: boolean;
}

/** Adds a notification (deduping identical recent events) and updates the badge. */
export function pushNotification(input: NotifInput): void {
  const now = Date.now();
  const existing = S.notifications.find(
    (n) =>
      n.kind === input.kind &&
      n.title === input.title &&
      n.appName === input.appName &&
      now - n.ts < DEDUPE_MS,
  );
  if (existing) {
    existing.ts = now;
    existing.read = false;
    existing.body = input.body ?? existing.body;
    existing.action = input.action ?? existing.action;
    existing.actionLabel = input.actionLabel ?? existing.actionLabel;
  } else {
    S.notifications.unshift({
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      appName: input.appName,
      action: input.action,
      actionLabel: input.actionLabel,
      ts: now,
      read: false,
    });
    if (S.notifications.length > MAX) S.notifications.length = MAX;
  }
  persist();
  updateNotifBadge();
}

export function unreadCount(): number {
  let n = 0;
  for (const x of S.notifications) if (!x.read) n++;
  return n;
}

export function markAllRead(): void {
  for (const n of S.notifications) n.read = true;
  persist();
  updateNotifBadge();
}

/** Removes a single notification from the history. */
export function dismissNotification(id: string): void {
  S.notifications = S.notifications.filter((n) => n.id !== id);
  persist();
  updateNotifBadge();
}

export function clearNotifications(): void {
  S.notifications = [];
  persist();
  updateNotifBadge();
}

/**
 * One dot on the sidebar bell. A missing EOS overlay keeps it amber until the
 * user installs it or dismisses the notice.
 */
export function updateNotifBadge(): void {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;
  const n = unreadCount();
  const eosMissing = S.eosOverlay !== null && !S.eosOverlay.installed
    && localStorage.getItem(EOS_OVERLAY_DECLINE_KEY) !== "1";
  badge.textContent = n > 9 ? "9+" : String(n);
  badge.classList.toggle("warn", eosMissing);
  badge.classList.toggle("hidden", !eosMissing && n === 0);
}

/** Signature of the last painted panel; renders stay no-op while nothing changes. */
let notifPanelSig = "";
/** The dropdown is a child webview above the store, not HTML under it. */
let notifOverlayOn = false;
let notifOverlayBox = { w: 360, h: 320 };
let notifOverlayBound = false;

/** True while a native store child would paint over an HTML dropdown. */
function storeCoversUi(): boolean {
  return isTauri && ((S.view === "store" && S.storeShown) || embeddedStoreHeld());
}

function panelMarkup(unread: number): string {
  const items = S.notifications
    .map((n) => {
      const action = n.action
        ? `data-act="${esc(n.action)}"`
        : n.appName
          ? `data-act="notif-open" data-id="${esc(n.appName)}"`
          : `data-act="notif-dismiss" data-id="${esc(n.id)}"`;
      return `
        <button class="notif-item${n.read ? "" : " unread"}" ${action} data-nid="${esc(n.id)}">
          <span class="notif-item-icon kind-${n.kind}">${icon(KIND_ICON[n.kind], 14)}</span>
          <span class="notif-item-body">
            <span class="notif-item-title">${esc(n.title)}</span>
            ${n.body ? `<span class="notif-item-text">${esc(n.body)}</span>` : ""}
            ${n.actionLabel ? `<span class="notif-item-act">${esc(n.actionLabel)}${icon("external", 12)}</span>` : ""}
            <span class="notif-item-time">${esc(relativeTime(n.ts))}</span>
          </span>
        </button>`;
    })
    .join("");
  const body =
    S.notifications.length === 0
      ? `<div class="notif-empty">${icon("bell", 26)}<p>${t("notif.empty")}</p></div>`
      : `<div class="notif-list">${items}</div>`;
  return `
    <div class="notif-panel" role="dialog" aria-label="${esc(t("notif.title"))}">
      <div class="notif-head">
        <span class="notif-title">${icon("bell", 14)} ${t("notif.title")}</span>
        <div class="notif-head-actions">
          ${unread > 0 ? `<button class="notif-action" data-act="notif-read-all">${t("notif.readAll")}</button>` : ""}
          ${S.notifications.length > 0 ? `<button class="notif-action" data-act="notif-clear">${t("notif.clear")}</button>` : ""}
        </div>
      </div>
      ${body}
    </div>`;
}

function overlayOrigin(width: number, height: number): { x: number; y: number } {
  const anchor = document.getElementById("notif-btn")?.getBoundingClientRect();
  let x = anchor ? anchor.left : 8;
  let y = anchor ? anchor.bottom + 8 : 40;
  if (x + width > window.innerWidth - 8) x = window.innerWidth - width - 8;
  if (x < 8) x = 8;
  if (y + height > window.innerHeight - 8) y = Math.max(8, (anchor?.top ?? 40) - height - 8);
  return { x, y };
}

/** Shows the list in a child webview that paints above the store. */
async function presentStoreOverlay(panelHtml: string): Promise<void> {
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-4000px;top:0;width:360px;visibility:hidden;";
  holder.innerHTML = panelHtml;
  document.body.appendChild(holder);
  const panel = holder.querySelector<HTMLElement>(".notif-panel");
  const height = Math.max(120, Math.min(panel?.offsetHeight ?? 320, Math.round(window.innerHeight * 0.7)));
  const width = Math.min(360, Math.max(160, window.innerWidth - 16));
  holder.remove();
  notifOverlayBox = { w: width, h: height };
  const { x, y } = overlayOrigin(width, height);
  await invoke("show_notif_overlay", { x, y, width, height, html: panelHtml });
}

function hideStoreOverlay(): void {
  if (!isTauri) return;
  void invoke("hide_notif_overlay").catch(() => undefined);
}

/** Forwards a click inside the overlay into the same button path as the HTML panel. */
function deliverOverlayAct(act: string, id: string): void {
  if (act === "overlay-close") {
    closeNotifPanel();
    return;
  }
  const root = document.getElementById("notif-root");
  if (!root || !act) return;
  const btn = document.createElement("button");
  btn.dataset.act = act;
  if (id) btn.dataset.id = id;
  root.appendChild(btn);
  btn.click();
  btn.remove();
}

function bindNotifOverlay(): void {
  if (notifOverlayBound || !isTauri) return;
  notifOverlayBound = true;
  void listen<{ act?: string; id?: string }>("notif-overlay-act", (event) => {
    deliverOverlayAct(event.payload.act || "", event.payload.id || "");
  });
}

/** Renders the dropdown into #notif-root (or clears it when closed). */
export function renderNotificationPanel(): void {
  const root = document.getElementById("notif-root");
  updateNotifBadge();
  if (!root) return;
  if (!S.notifOpen) {
    notifPanelSig = "";
    notifOverlayOn = false;
    if (root.firstChild) root.innerHTML = "";
    hideStoreOverlay();
    syncStoreViewSize();
    return;
  }

  const unread = unreadCount();
  // `render()` runs on every download progress event; rebuilding the open panel
  // each time was pure DOM churn. Skip when the visible content is unchanged.
  const first = S.notifications[0];
  const sig = `${S.notifications.length}|${unread}|${first?.ts ?? 0}|${first?.read ?? false}|${S.appLanguage}`;
  const covers = storeCoversUi();
  if (sig === notifPanelSig && (root.firstChild || (covers && notifOverlayOn))) return;
  notifPanelSig = sig;

  const markup = panelMarkup(unread);
  if (covers) {
    root.innerHTML = "";
    notifOverlayOn = true;
    void presentStoreOverlay(markup).catch(() => {
      notifOverlayOn = false;
      root.innerHTML = markup;
      positionNotifPanel();
    });
    return;
  }
  if (notifOverlayOn) hideStoreOverlay();
  notifOverlayOn = false;
  root.innerHTML = markup;
  positionNotifPanel();
}

/**
 * Anchors the panel to the sidebar bell. Opens below the icon, or above
 * when the window does not have room underneath.
 */
export function positionNotifPanel(): void {
  if (notifOverlayOn) {
    const { x, y } = overlayOrigin(notifOverlayBox.w, notifOverlayBox.h);
    void invoke("move_notif_overlay", {
      x,
      y,
      width: notifOverlayBox.w,
      height: notifOverlayBox.h,
    }).catch(() => undefined);
    return;
  }
  const panel = document.querySelector<HTMLElement>("#notif-root .notif-panel");
  const anchor = document.getElementById("notif-btn")?.getBoundingClientRect();
  if (!panel || !anchor) return;
  panel.style.width = "";
  const left = Math.min(anchor.left, Math.max(8, window.innerWidth - panel.offsetWidth - 8));
  panel.style.left = `${left}px`;
  const gap = 8;
  const spaceBelow = window.innerHeight - anchor.bottom;
  const openUp = spaceBelow < panel.offsetHeight + gap + 8 && anchor.top > spaceBelow;
  panel.style.top = `${openUp ? Math.max(8, anchor.top - panel.offsetHeight - gap) : anchor.bottom + gap}px`;
}

/** Opens the notification panel (and marks everything as read). */
export function openNotifPanel(): void {
  S.notifOpen = true;
  renderNotificationPanel();
  markAllRead();
  syncStoreViewSize();
}

export function closeNotifPanel(): void {
  if (!S.notifOpen) return;
  S.notifOpen = false;
  renderNotificationPanel();
}

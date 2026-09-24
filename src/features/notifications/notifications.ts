/**
 * In-app notification center.
 *
 * Keeps a capped, persisted history of notable events (download finished,
 * update available, errors, social...). The bell lives in the top nav; the
 * panel is a fixed dropdown anchored under it. Items are real buttons so the
 * 10-foot gamepad focus model keeps working.
 */

import { NOTIF_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import type { AppNotification, NotifKind } from "../../core/types";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

const MAX = 50;
/** Re-pushing the same event within this window refreshes instead of duplicating. */
const DEDUPE_MS = 10 * 60 * 1000;

const KIND_ICON: Record<NotifKind, Parameters<typeof icon>[0]> = {
  download: "download",
  update: "refresh",
  error: "alert-triangle",
  info: "info",
  social: "users",
};

/** Restores the persisted notification history (invalid entries are dropped). */
export function loadNotifications(): void {
  try {
    const raw = localStorage.getItem(NOTIF_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as AppNotification[];
    if (Array.isArray(parsed)) {
      S.notifications = parsed.filter((n) => n && typeof n.id === "string").slice(0, MAX);
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
  } else {
    S.notifications.unshift({
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      appName: input.appName,
      action: input.action,
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

/** Reflects the unread count on the nav bell (shell element, always present). */
export function updateNotifBadge(): void {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;
  const n = unreadCount();
  badge.textContent = n > 9 ? "9+" : String(n);
  badge.classList.toggle("hidden", n === 0);
}

function relTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("notif.justNow");
  if (mins < 60) return t("notif.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("notif.hoursAgo", { n: hours });
  return t("notif.daysAgo", { n: Math.floor(hours / 24) });
}

/** Renders the dropdown into #notif-root (or clears it when closed). */
export function renderNotificationPanel(): void {
  const root = document.getElementById("notif-root");
  updateNotifBadge();
  if (!root) return;
  if (!S.notifOpen) {
    if (root.firstChild) root.innerHTML = "";
    return;
  }

  const unread = unreadCount();
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
            <span class="notif-item-time">${esc(relTime(n.ts))}</span>
          </span>
        </button>`;
    })
    .join("");

  const body =
    S.notifications.length === 0
      ? `<div class="notif-empty">${icon("bell", 26)}<p>${t("notif.empty")}</p></div>`
      : `<div class="notif-list">${items}</div>`;

  root.innerHTML = `
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

/** Opens the notification panel (and marks everything as read). */
export function openNotifPanel(): void {
  S.notifOpen = true;
  renderNotificationPanel();
  markAllRead();
}

export function closeNotifPanel(): void {
  if (!S.notifOpen) return;
  S.notifOpen = false;
  renderNotificationPanel();
}

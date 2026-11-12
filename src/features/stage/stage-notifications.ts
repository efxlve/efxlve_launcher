/**
 * Stage notification centre.
 *
 * The desktop panel splits its history into four tabs because a mouse user can
 * afford them; on a couch the question is only "what happened?", so Stage shows
 * one newest-first list. Opening it clears the badge the way a console does, and
 * a row with a game carries that game into its programme page, where the update
 * or achievement it mentions is one press away.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import type { AppNotification } from "../../core/types";
import { esc, relativeTime } from "../../core/utils";
import { t } from "../../i18n";
import { notifKindIcon } from "../notifications/notifications";

/** A couch list is read in one glance, not scrolled like a mailbox. */
const LIMIT = 14;

function row(n: AppNotification): string {
  const when = relativeTime(n.ts);
  const meta = n.context || when
    ? `<span class="stage-notif-meta">${icon(n.context ? (n.appName ? "gamepad-2" : "info") : "clock", 12)}${n.context ? `<span class="stage-notif-context">${esc(n.context)}</span><i aria-hidden="true"></i>` : ""}<span>${esc(when)}</span></span>`
    : "";
  // A game row opens the programme; an app/EOS notice can only be acted on in
  // the desktop shell, so it leaves Stage instead of pretending to do something.
  const act = n.appName ? "open-program" : n.action ? "notif-desktop" : "notif-done";
  return `<button type="button" class="stage-notif-row" data-stage-act="${act}" data-key="${esc(n.appName || "")}" data-gp-item data-gp-key="notif:${esc(n.id)}">
    <span class="stage-notif-icon kind-${esc(n.kind)}">${icon(notifKindIcon(n.kind), 18)}</span>
    <span class="stage-notif-copy">
      <strong>${esc(n.title)}</strong>
      ${n.body ? `<span class="stage-notif-body">${esc(n.body)}</span>` : ""}
      ${meta}
    </span>
    ${n.actionLabel ? `<span class="stage-stat stage-notif-chip">${esc(n.actionLabel)}</span>` : ""}
  </button>`;
}

export function renderStageNotifications(): string {
  const items = S.notifications.slice(0, LIMIT);
  const total = S.notifications.length;
  return `<div class="stage-overlay stage-notif-overlay">
    <div class="stage-sheet stage-sheet-narrow stage-notif-card" role="dialog" aria-modal="true" aria-label="${esc(t("notif.title"))}">
      <div class="stage-sheet-head">
        <div>
          <span class="stage-kicker">${esc(t("notif.title"))}</span>
          <h2>${esc(t("notif.title"))}${total > 0 ? `<span class="stage-stat stage-notif-count">${icon("bell", 13)}<b class="tabular-nums">${total}</b></span>` : ""}</h2>
        </div>
        <div class="stage-notif-head-actions">
          ${total > 0 ? `<button type="button" class="stage-btn stage-btn-ghost" data-stage-act="notif-clear" data-gp-item data-gp-key="notif:clear">${icon("trash", 16)}<span>${esc(t("notif.clear"))}</span></button>` : ""}
          <button type="button" class="stage-icon-btn" data-stage-act="notif-close" data-gp-item data-gp-key="notif:close" data-gp-default aria-label="${esc(t("common.close"))}">${icon("x", 20)}</button>
        </div>
      </div>
      ${items.length === 0
        ? `<div class="stage-notif-empty">
            <span class="stage-empty-icon">${icon("bell", 30)}</span>
            <p>${esc(t("notif.empty"))}</p>
            <div class="stage-stat-row">
              <span class="stage-stat">${icon("bell", 13)}<span>${esc(t("notif.title"))}</span><b class="tabular-nums">0</b></span>
              <span class="stage-stat">${icon("layers", 13)}<span>${esc(t("stage.achAll"))}</span></span>
            </div>
          </div>`
        : `<div class="stage-notif-list">${items.map(row).join("")}</div>`}
    </div>
  </div>`;
}

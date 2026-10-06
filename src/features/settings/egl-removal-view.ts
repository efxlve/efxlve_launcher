/**
 * Confirmation dialog for the safe Epic Games Launcher removal.
 *
 * Shows what stays (games, their files, Epic Online Services) and what goes
 * (launcher folders, shortcuts, registry entries) before the elevated script
 * runs.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

const ROOT_ID = "egl-removal-root";

function root(): HTMLElement {
  let el = document.getElementById(ROOT_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = ROOT_ID;
    document.body.appendChild(el);
  }
  return el;
}

export function closeEglRemovalModal(): void {
  const el = document.getElementById(ROOT_ID);
  if (el) el.innerHTML = "";
}

/** Renders the dialog from `S.eglRemovalPlan`. */
export function renderEglRemovalModal(): void {
  const plan = S.eglRemovalPlan;
  if (!plan) return;
  const keep: string[] = [t("egl.removeGames", { count: plan.games.length })];
  if (plan.eosPath) keep.push(t("egl.removeEos"));
  const remove: string[] = [];
  if (plan.removePaths.length || plan.removeShortcuts.length || plan.removeRegistry.length) {
    remove.push(
      t("egl.removePaths", {
        paths: plan.removePaths.length,
        shortcuts: plan.removeShortcuts.length,
        registry: plan.removeRegistry.length,
      }),
    );
  }
  root().innerHTML = `
    <div class="egl-remove-overlay" data-act="egl-remove-overlay">
      <div class="egl-remove-dialog" data-act="prevent-modal-close">
        <div class="egl-remove-head">
          <div class="egl-remove-head-title">${icon("trash", 16)} <span>${t("egl.removeTitle")}</span></div>
          <button class="manage-head-close" data-act="egl-remove-close" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>
        <div class="egl-remove-body">
          <div class="egl-remove-section">
            <div class="egl-remove-label keep">${icon("shield-check", 13)} ${t("egl.removeKeep")}</div>
            <ul class="egl-remove-list">${keep.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
            ${plan.games.length ? `<div class="egl-remove-games">${plan.games.map((g) => `<span class="egl-remove-game">${esc(g.title)}</span>`).join("")}</div>` : ""}
          </div>
          <div class="egl-remove-section">
            <div class="egl-remove-label delete">${icon("alert-triangle", 13)} ${t("egl.removeDelete")}</div>
            <ul class="egl-remove-list">${remove.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
            ${plan.removePaths.length ? `<div class="egl-remove-paths">${plan.removePaths.map((p) => `<div title="${esc(p)}">${esc(p)}</div>`).join("")}</div>` : ""}
          </div>
        </div>
        <div class="egl-remove-foot">
          <button class="btn ghost" data-act="egl-remove-close">${t("move.discard")}</button>
          <button class="btn danger" data-act="egl-remove-confirm" ${S.eglRemoving ? "disabled" : ""}>${icon("trash", 14)} ${S.eglRemoving ? t("egl.removing") : t("egl.removeConfirm")}</button>
        </div>
      </div>
    </div>`;
}

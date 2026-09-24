/**
 * Playtime editor modal.
 *
 * Lets the user correct tracked playtime and the last-played date for a game.
 * Reads/writes shared state (S) and persists through the Epic playtime command.
 */

import { playtimeRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { lastPlayedLabel } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";

import { epicSetPlaytime } from "../../epic";
export function closeEditPlaytimeModal(): void {
  if (playtimeRoot) playtimeRoot.innerHTML = "";
}

export function openEditPlaytimeModal(appName: string): void {
  if (!playtimeRoot) return;
  const s = S.epicSummaries.find((x) => x.appName === appName);
  const dl = S.downloads.get(appName);
  const title = s?.title || dl?.title || appName;

  const pt = S.playtimeMap.get(appName);
  const sec = pt?.total_seconds || 0;
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  let lastPlayed = pt?.last_played || "";
  if (!lastPlayed && (hours > 0 || minutes > 0)) {
    lastPlayed = t("playtime.epicPrevious");
  }

  const standardOptions = [
    "",
    t("playtime.epicPrevious"),
    t("playtime.today"),
    t("playtime.yesterday"),
    t("playtime.thisWeek"),
    t("playtime.thisMonth"),
    t("playtime.lastMonth"),
    t("playtime.sixMonths"),
    t("playtime.oneYear"),
  ];
  const hasCustomLastPlayed = Boolean(lastPlayed && !standardOptions.includes(lastPlayed));

  playtimeRoot.innerHTML = `
    <div class="playtime-overlay" data-act="playtime-overlay-close">
      <div class="playtime-dialog">
        <div class="playtime-header">
          <div class="playtime-header-title">
            <div class="playtime-header-icon">${icon("clock", 18)}</div>
            <div>
              <h2>${t("playtime.editTitle")}</h2>
              <div class="playtime-header-sub">${esc(title)}</div>
            </div>
          </div>
          <button class="manage-head-close" data-act="close-edit-playtime" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>

        <div class="playtime-body">
          <div class="playtime-modal-notice">
            <div class="playtime-modal-notice-icon">${icon("info", 16)}</div>
            <div class="playtime-modal-notice-text">
              <strong>${t("playtime.whyTitle")}</strong><br />
              ${t("playtime.whyDesc")}
            </div>
          </div>

          <div class="playtime-form-group">
            <label class="playtime-form-label">${t("playtime.totalPlaytime")}</label>
            <div class="playtime-inputs-row">
              <div class="playtime-input-wrap">
                <input id="pt-hours-input" type="number" min="0" step="1" class="text-input" value="${hours}" placeholder="0" />
                <span class="playtime-unit">${t("playtime.hours")}</span>
              </div>
              <div class="playtime-input-wrap">
                <input id="pt-minutes-input" type="number" min="0" max="59" step="1" class="text-input" value="${minutes}" placeholder="0" />
                <span class="playtime-unit">${t("playtime.minutes")}</span>
              </div>
            </div>
            <div class="playtime-quick-chips">
              <span class="playtime-quick-label">${t("playtime.quickAdd")}</span>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="1">${t("playtime.addHours", { n: 1 })}</button>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="5">${t("playtime.addHours", { n: 5 })}</button>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="10">${t("playtime.addHours", { n: 10 })}</button>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="50">${t("playtime.addHours", { n: 50 })}</button>
              <button type="button" class="quick-chip reset" data-act="pt-reset">${t("playtime.reset")}</button>
            </div>
          </div>

          <div class="playtime-form-group">
            <label class="playtime-form-label">${t("playtime.lastActivity")}</label>
            <select id="pt-last-played-select" class="playtime-select">
              <option value="" ${!lastPlayed ? "selected" : ""}>${t("playtime.unspecified")}</option>
              <option value="Daha önce oynandı (Epic Games)" ${lastPlayed === "Daha önce oynandı (Epic Games)" ? "selected" : ""}>${t("playtime.epicPrevious")}</option>
              <option value="Bugün" ${lastPlayed === "Bugün" ? "selected" : ""}>${t("playtime.today")}</option>
              <option value="Dün" ${lastPlayed === "Dün" ? "selected" : ""}>${t("playtime.yesterday")}</option>
              <option value="Bu hafta" ${lastPlayed === "Bu hafta" ? "selected" : ""}>${t("playtime.thisWeek")}</option>
              <option value="Bu ay" ${lastPlayed === "Bu ay" ? "selected" : ""}>${t("playtime.thisMonth")}</option>
              <option value="Geçen ay" ${lastPlayed === "Geçen ay" ? "selected" : ""}>${t("playtime.lastMonth")}</option>
              <option value="6 ay önce" ${lastPlayed === "6 ay önce" ? "selected" : ""}>${t("playtime.sixMonths")}</option>
              <option value="1 yıl önce veya daha eski" ${lastPlayed === "1 yıl önce veya daha eski" ? "selected" : ""}>${t("playtime.oneYear")}</option>
              ${hasCustomLastPlayed ? `<option value="${esc(lastPlayed)}" selected>${t("playtime.customSaved", { value: esc(lastPlayed) })}</option>` : ""}
            </select>
            <div class="playtime-input-hint">${t("playtime.lastActivityHint")}</div>
          </div>
        </div>

        <div class="playtime-footer">
          <button class="btn ghost" data-act="close-edit-playtime">${t("playtime.cancel")}</button>
          <button class="btn primary" data-act="save-playtime" data-id="${esc(appName)}">
            ${icon("check", 14)} ${t("common.save")}
          </button>
        </div>
      </div>
    </div>
  `;
}

export async function saveEditedPlaytime(appName: string): Promise<void> {
  const hInput = document.getElementById("pt-hours-input") as HTMLInputElement | null;
  const mInput = document.getElementById("pt-minutes-input") as HTMLInputElement | null;
  const lpSelect = document.getElementById("pt-last-played-select") as HTMLSelectElement | null;

  const hours = Math.max(0, parseInt(hInput?.value || "0", 10) || 0);
  const minutes = Math.max(0, Math.min(59, parseInt(mInput?.value || "0", 10) || 0));
  const totalSeconds = hours * 3600 + minutes * 60;
  const selectedLp = lpSelect?.value?.trim() || "";
  const lastPlayed = selectedLp.length > 0 ? selectedLp : null;

  const saveBtn = document.querySelector<HTMLButtonElement>('[data-act="save-playtime"]');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = t("playtime.saving");
  }

  try {
    const updated = await epicSetPlaytime(appName, totalSeconds, lastPlayed);
    S.playtimeMap.set(appName, updated);

    // Update Overview drawer if open
    const overviewPtVal = document.getElementById("drawer-stat-playtime");
    if (overviewPtVal) {
      overviewPtVal.textContent = updated.total_seconds > 0 ? fmtPlaytime(updated.total_seconds) : t("playtime.notPlayed");
    }
    const overviewLpVal = document.getElementById("drawer-stat-last-activity");
    if (overviewLpVal) {
      overviewLpVal.textContent = lastPlayedLabel(updated.last_played);
    }

    // Update Manage drawer if open
    const managePtVal = document.getElementById("manage-playtime-val");
    if (managePtVal) {
      managePtVal.textContent = updated.total_seconds > 0 ? fmtPlaytime(updated.total_seconds) : t("playtime.notPlayed");
    }
    const managePtMeta = document.getElementById("manage-playtime-meta");
    if (managePtMeta) {
      managePtMeta.textContent = updated.session_count
        ? t("playtime.sessionSaved", { count: updated.session_count, last: lastPlayedLabel(updated.last_played) })
        : t("playtime.noSession");
    }

    document.querySelectorAll<HTMLElement>(`[data-lib-playtime="${appName}"]`).forEach((el) => {
      el.textContent = updated.total_seconds > 0 ? fmtPlaytime(updated.total_seconds) : "—";
    });

    toast(
      updated.total_seconds > 0
        ? t("playtime.updated", { time: fmtPlaytime(updated.total_seconds) })
        : t("playtime.resetDone"),
      "ok"
    );
    closeEditPlaytimeModal();
  } catch (err) {
    toast(t("playtime.saveFailed", { msg: String(err) }), "err");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = t("common.save");
    }
  }
}


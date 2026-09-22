/**
 * In-drawer game management helpers.
 *
 * The manage panel markup itself is rendered by `features/drawer/drawer-view.ts`;
 * this module only exposes the in-place DOM updates used while it is open
 * (settings sync, verify progress and reset). State lives in S.
 */

import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

import type { GameLocalSettings } from "../../epic";

/** Sync the manage panel inputs after fresh settings arrive from the backend. */
export function updateManageModalInputsInPlace(st: GameLocalSettings): void {
  const autoUpdate = document.querySelector<HTMLInputElement>('[data-act="manage-toggle-autoupdate"]');
  if (autoUpdate) autoUpdate.checked = st.autoUpdate;

  const priority = document.querySelector<HTMLInputElement>('[data-act="manage-toggle-priority"]');
  if (priority) priority.checked = st.highPriority;

  const cloud = document.querySelector<HTMLInputElement>('[data-act="manage-toggle-cloud"]');
  if (cloud) cloud.checked = st.cloudSavesEnabled;

  const cloudSub = document.getElementById("manage-cloud-subtitle");
  if (cloudSub) {
    cloudSub.textContent = st.lastCloudSync
      ? t("manage.lastSync", { time: st.lastCloudSync })
      : t("manage.cloudDesc");
  }

  const argsInput = document.getElementById("manage-args-input") as HTMLInputElement | null;
  if (argsInput) argsInput.value = st.launchParameters || "";

  const wrapperInput = document.getElementById("manage-wrapper-input") as HTMLInputElement | null;
  if (wrapperInput) wrapperInput.value = st.wrapper || "";

  const envInput = document.getElementById("manage-env-input") as HTMLTextAreaElement | null;
  if (envInput) {
    envInput.value = Object.entries(st.envVars || {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }

  document.querySelectorAll("#manage-install-path").forEach((el) => {
    el.textContent = st.installPath || t("manage.unspecified");
  });
}

/** Update the verify progress bar and button without re-rendering the drawer. */
export function updateVerifyProgressInPlace(
  id: string,
  current: number,
  total: number,
  percent: number,
  speed: string,
  detail?: string,
): void {
  const displayDetail = detail || (total > 0 ? `${current}/${total} (%${Math.round(percent)}%)` : `%${Math.round(percent)}%`);
  S.verifyingMap.set(id, { current, total, percent, speed, detail: displayDetail });
  if (!S.activeManageSettings || S.activeManageSettings.appName !== id) return;

  const container = document.getElementById("manage-verify-box-container");
  const fill = document.getElementById("manage-verify-fill");
  const count = document.getElementById("manage-verify-count");
  const spd = document.getElementById("manage-verify-speed");
  const btn = document.getElementById("manage-verify-btn") as HTMLButtonElement | null;

  if (btn) {
    btn.disabled = true;
    btn.textContent = t("manage.verifying");
  }

  if (fill && count && spd) {
    fill.style.width = `${percent}%`;
    count.textContent = displayDetail;
    spd.textContent = speed;
  } else if (container) {
    container.innerHTML = `
      <div class="verify-box">
        <div class="verify-bar">
          <div id="manage-verify-fill" class="verify-fill" style="width:${percent}%"></div>
        </div>
        <div class="verify-meta">
          <span id="manage-verify-count">${displayDetail}</span>
          <span id="manage-verify-speed">${esc(speed)}</span>
        </div>
      </div>
    `;
  }
}

/** Clear the verify progress bar and re-enable the verify button. */
export function resetVerifyInPlace(id: string): void {
  S.verifyingMap.delete(id);
  if (!S.activeManageSettings || S.activeManageSettings.appName !== id) return;

  const container = document.getElementById("manage-verify-box-container");
  if (container) container.innerHTML = "";

  const btn = document.getElementById("manage-verify-btn") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = false;
    btn.textContent = t("manage.verify");
  }
}

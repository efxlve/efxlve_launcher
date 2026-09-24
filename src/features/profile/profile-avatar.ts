/**
 * Local custom avatar manager for Epic Games accounts.
 *
 * Stores optimized WebP/JPEG base64 avatars in localStorage keyed by account ID.
 * Avatars are strictly local to this PC and isolated per Epic account so that
 * when multiple accounts are switched in the future, each retains its own photo.
 */

import { CUSTOM_AVATARS_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { updateChrome } from "../../core/nav";
import { render } from "../../core/render";
import { esc } from "../../core/utils";
import { getCustomAvatar, S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";

export { getCustomAvatar };

export function getCurrentAccountId(): string {
  return S.playerProfileData?.account_id || S.epicAccountId || S.epicAccount || "default";
}

export function saveCustomAvatar(accountId: string, dataUrl: string): void {
  S.customAvatars[accountId] = dataUrl;
  if (S.playerProfileData?.account_id) {
    S.customAvatars[S.playerProfileData.account_id] = dataUrl;
  }
  if (S.epicAccountId) {
    S.customAvatars[S.epicAccountId] = dataUrl;
  }
  if (S.epicAccount) {
    S.customAvatars[S.epicAccount] = dataUrl;
  }
  try {
    localStorage.setItem(CUSTOM_AVATARS_KEY, JSON.stringify(S.customAvatars));
  } catch (e) {
    console.error("Failed to save avatar to localStorage:", e);
  }
  updateChrome();
  render();
  toast(t("profile.avatarUpdated"), "ok");
}

export function removeCustomAvatar(accountId: string): void {
  delete S.customAvatars[accountId];
  if (S.playerProfileData?.account_id) delete S.customAvatars[S.playerProfileData.account_id];
  if (S.epicAccountId) delete S.customAvatars[S.epicAccountId];
  if (S.epicAccount) delete S.customAvatars[S.epicAccount];
  delete S.customAvatars["default"];
  try {
    localStorage.setItem(CUSTOM_AVATARS_KEY, JSON.stringify(S.customAvatars));
  } catch (e) {
    console.error("Failed to remove avatar from localStorage:", e);
  }
  closeAvatarModal();
  updateChrome();
  render();
  toast(t("profile.avatarRemoved"), "ok");
}

export function openAvatarFilePicker(accountId: string): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png, image/jpeg, image/webp, image/gif";
  input.style.display = "none";

  input.onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast(t("profile.avatarInvalidFile"), "err");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const img = new Image();
      img.onload = () => {
        // Resize to 256x256 square with center crop
        const targetSize = 256;
        const canvas = document.createElement("canvas");
        canvas.width = targetSize;
        canvas.height = targetSize;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          saveCustomAvatar(accountId, result);
          closeAvatarModal();
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        // Center crop calculation
        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;

        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, targetSize, targetSize);
        const optimizedDataUrl = canvas.toDataURL("image/webp", 0.88);
        saveCustomAvatar(accountId, optimizedDataUrl);
        closeAvatarModal();
      };
      img.onerror = () => {
        toast(t("profile.avatarLoadError"), "err");
      };
      img.src = result;
    };
    reader.readAsDataURL(file);
  };

  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 1000);
}

export function closeAvatarModal(): void {
  const modal = document.getElementById("avatar-manage-modal");
  if (modal) modal.remove();
}

export function promptAvatarAction(accId?: string): void {
  const accountId = accId || getCurrentAccountId();
  const currentAvatar = S.customAvatars[accountId];

  // If no custom avatar is set yet, directly launch the file picker.
  if (!currentAvatar) {
    openAvatarFilePicker(accountId);
    return;
  }

  // If custom avatar is set, open a sleek modal to change or remove it.
  closeAvatarModal();
  const displayName = S.playerProfileData?.display_name || S.epicAccount || t("profile.player");
  const modalHtml = `
    <div id="avatar-manage-modal" class="modal-backdrop fadeIn" style="z-index: 1050;">
      <div class="modal-box ps5-avatar-modal" role="dialog" aria-modal="true">
        <div class="ps5-avatar-modal-header">
          <div class="ps5-avatar-modal-title">
            ${icon("camera", 16)}
            <h3>${t("profile.avatarTitle")}</h3>
          </div>
          <button class="modal-close-btn" data-act="avatar-modal-close" title="${t("common.close")}">
            ${icon("x", 16)}
          </button>
        </div>

        <div class="ps5-avatar-modal-body">
          <div class="ps5-avatar-preview-wrap">
            <img class="ps5-avatar-preview-img" src="${esc(currentAvatar)}" alt="${esc(displayName)}" />
          </div>
          <div class="ps5-avatar-modal-info">
            <h4>${esc(displayName)}</h4>
            <p>${t("profile.avatarDesc")}</p>
          </div>
        </div>

        <div class="ps5-avatar-modal-footer">
          <button class="apple-pill-btn secondary" data-act="avatar-modal-remove" data-id="${esc(accountId)}">
            ${icon("trash", 13)} <span>${t("profile.removePhoto")}</span>
          </button>
          <button class="apple-pill-btn primary" data-act="avatar-modal-upload" data-id="${esc(accountId)}">
            ${icon("camera", 13)} <span>${t("profile.choosePhoto")}</span>
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);
}

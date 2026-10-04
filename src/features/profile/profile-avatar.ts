/**
 * Local custom avatar manager.
 *
 * Stores optimized WebP/JPEG base64 avatars in localStorage under namespaced
 * keys: `global` for the combined profile, `epic:<accountId>` and
 * `gog:<userId>` per account. Photos never leak between accounts and the
 * combined profile has its own picture.
 */

import { CUSTOM_AVATARS_KEY, CUSTOM_PROFILE_NAME_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { updateChrome } from "../../core/nav";
import { render } from "../../core/render";
import { esc } from "../../core/utils";
import { avatarFor, currentProfileName, getCustomAvatar, GLOBAL_AVATAR_KEY, S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";

export { getCustomAvatar };

/** Key of the photo the current context edits (active account, else combined). */
export function getCurrentAvatarKey(): string {
  if (S.epicAccountId) return `epic:${S.epicAccountId}`;
  if (S.gogAccountId) return `gog:${S.gogAccountId}`;
  return GLOBAL_AVATAR_KEY;
}

/** Writes the photo for one key only; other accounts keep their own. */
export function saveCustomAvatar(key: string, dataUrl: string): void {
  S.customAvatars[key] = dataUrl;
  // Keep the legacy bare-id alias in sync so older lookups still resolve.
  const raw = key.includes(":") ? key.slice(key.indexOf(":") + 1) : "";
  if (raw) S.customAvatars[raw] = dataUrl;
  try {
    localStorage.setItem(CUSTOM_AVATARS_KEY, JSON.stringify(S.customAvatars));
  } catch (e) {
    console.error("Failed to save avatar to localStorage:", e);
  }
  updateChrome();
  render();
  toast(t("profile.avatarUpdated"), "ok");
}

/** Deletes only this key's photo (and its legacy alias). */
export function removeCustomAvatar(key: string): void {
  delete S.customAvatars[key];
  const raw = key.includes(":") ? key.slice(key.indexOf(":") + 1) : "";
  if (raw) delete S.customAvatars[raw];
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

export function openAvatarFilePicker(key: string): void {
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
          saveCustomAvatar(key, result);
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
        saveCustomAvatar(key, optimizedDataUrl);
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

/** Opens the avatar flow for one key (`global` or `epic:/gog:<id>`). */
export function promptAvatarAction(key?: string, displayName?: string): void {
  const avatarKey = key || getCurrentAvatarKey();
  const name = displayName || S.playerProfileData?.display_name || S.epicAccount || S.gogAccount || t("profile.player");
  const currentAvatar = avatarFor(avatarKey);

  // If no custom avatar is set yet, directly launch the file picker.
  if (!currentAvatar) {
    openAvatarFilePicker(avatarKey);
    return;
  }

  // If custom avatar is set, open a sleek modal to change or remove it.
  closeAvatarModal();
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
            <img class="ps5-avatar-preview-img" src="${esc(currentAvatar)}" alt="${esc(name)}" />
          </div>
          <div class="ps5-avatar-modal-info">
            <h4>${esc(name)}</h4>
            <p>${t("profile.avatarDesc")}</p>
          </div>
        </div>

        <div class="ps5-avatar-modal-footer">
          <button class="apple-pill-btn secondary" data-act="avatar-modal-remove" data-id="${esc(avatarKey)}">
            ${icon("trash", 13)} <span>${t("profile.removePhoto")}</span>
          </button>
          <button class="apple-pill-btn primary" data-act="avatar-modal-upload" data-id="${esc(avatarKey)}">
            ${icon("camera", 13)} <span>${t("profile.choosePhoto")}</span>
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);
}

export function closeChangeNameModal(): void {
  const modal = document.getElementById("profile-name-modal");
  if (modal) modal.remove();
}

export function saveProfileName(name: string): void {
  const trimmed = name.trim();
  S.customProfileName = trimmed;
  try {
    if (trimmed) {
      localStorage.setItem(CUSTOM_PROFILE_NAME_KEY, trimmed);
    } else {
      localStorage.removeItem(CUSTOM_PROFILE_NAME_KEY);
    }
  } catch (e) {
    console.error("Failed to save profile name:", e);
  }
  closeChangeNameModal();
  updateChrome();
  render();
  toast(t("common.saved"), "ok");
}

export function openChangeNameModal(): void {
  closeChangeNameModal();
  const current = S.customProfileName || "";
  const placeholder = t("profile.user");
  const modalHtml = `
    <div id="profile-name-modal" class="modal-backdrop fadeIn" style="z-index: 1050;">
      <div class="modal-box ps5-avatar-modal" role="dialog" aria-modal="true" style="max-width: 400px;">
        <div class="ps5-avatar-modal-header">
          <div class="ps5-avatar-modal-title">
            ${icon("edit", 16)}
            <h3>${esc(t("profile.changeNameTitle"))}</h3>
          </div>
          <button class="modal-close-btn" data-act="profile-name-modal-close" title="${t("common.close")}">
            ${icon("x", 16)}
          </button>
        </div>

        <div class="ps5-avatar-modal-body" style="flex-direction: column; align-items: stretch; gap: 12px; padding: 18px 24px;">
          <label style="font-size: 13px; color: var(--fg-muted); display: flex; flex-direction: column; gap: 8px;">
            <span>${esc(t("profile.user"))}</span>
            <input id="profile-name-input" type="text" class="input" style="padding: 10px 14px; font-size: 14px; border-radius: 8px; border: 1px solid var(--border-subtle); background: var(--bg-surface-elevated, #1a1d24); color: var(--fg-default, #fff); width: 100%; box-sizing: border-box;" value="${esc(current)}" placeholder="${esc(placeholder)}" maxlength="32" autofocus />
          </label>
        </div>

        <div class="ps5-avatar-modal-footer">
          <button class="apple-pill-btn secondary" data-act="profile-name-modal-close">
            <span>${t("common.cancel")}</span>
          </button>
          <button class="apple-pill-btn primary" data-act="profile-name-modal-save">
            <span>${t("common.save")}</span>
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);
  const input = document.getElementById("profile-name-input") as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveProfileName(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeChangeNameModal();
      }
    });
  }
}

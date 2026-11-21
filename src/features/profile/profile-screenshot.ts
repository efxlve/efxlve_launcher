import { captureProfileScreenshot, openProfileScreenshotsFolder } from "../../epic-commands";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import {
  ssProfileClipboardOn,
  ssProfileCustomDir,
  ssProfileOpenFolderOn,
  ssProfileSaveFileOn,
} from "../screenshots/ss-settings";

let isBusy = false;

export async function takeProfileScreenshot(): Promise<void> {
  if (isBusy) return;

  const profileEl = document.querySelector<HTMLElement>(".profile-page");
  if (!profileEl) {
    toast(t("profile.screenshotFailed"), "err");
    return;
  }

  const btn = document.getElementById("profile-screenshot-btn");
  isBusy = true;
  if (btn) {
    btn.classList.add("is-busy");
    btn.setAttribute("aria-busy", "true");
  }

  // Add the capture class which hides winbar, sidebar, page-header, and allows view to expand unclipped
  document.body.classList.add("capturing-profile-screenshot");

  try {
    // Eagerly load and decode any offscreen images inside the profile before taking the screenshot
    const images = profileEl.querySelectorAll<HTMLImageElement>("img");
    const pending: Promise<unknown>[] = [];
    images.forEach((img) => {
      if (img.loading === "lazy") {
        img.loading = "eager";
      }
      if (!img.complete) {
        pending.push(img.decode().catch(() => {}));
      }
    });
    if (pending.length > 0) {
      await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 1200))]);
    }

    // Wait two animation frames for layout to settle cleanly without transition/animation artifacts
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );

    const rect = profileEl.getBoundingClientRect();
    const clip = {
      x: Math.max(0, Math.floor(rect.left)),
      y: Math.max(0, Math.floor(rect.top)),
      width: Math.max(100, Math.ceil(rect.width)),
      height: Math.max(100, Math.ceil(Math.max(rect.height, profileEl.scrollHeight))),
      scale: window.devicePixelRatio || 1,
    };

    const copyToClipboard = ssProfileClipboardOn();
    const saveToFile = ssProfileSaveFileOn();
    const openFolder = ssProfileOpenFolderOn();
    const customDir = ssProfileCustomDir() || null;

    const res = await captureProfileScreenshot(clip, customDir);

    let copied = false;
    if (copyToClipboard && res.dataUrl && navigator.clipboard && typeof ClipboardItem !== "undefined") {
      try {
        const resp = await fetch(res.dataUrl);
        const blob = await resp.blob();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copied = true;
      } catch {
        // Clipboard write might fail if focus is elsewhere; file is still saved
      }
    }

    if (openFolder) {
      void openProfileScreenshotsFolder(customDir).catch(() => {});
    }

    if (copied && saveToFile) {
      toast(t("profile.screenshotSavedClip", { file: res.fileName }), "ok");
    } else if (copied && !saveToFile) {
      toast(t("profile.screenshotCopiedOnly"), "ok");
    } else if (saveToFile) {
      toast(t("profile.screenshotSaved", { file: res.fileName }), "ok");
    } else {
      toast(t("profile.screenshotDone"), "ok");
    }
  } catch (error) {
    console.error("Profile screenshot failed:", error);
    toast(t("profile.screenshotFailed"), "err");
  } finally {
    document.body.classList.remove("capturing-profile-screenshot");
    if (btn) {
      btn.classList.remove("is-busy");
      btn.removeAttribute("aria-busy");
    }
    isBusy = false;
  }
}

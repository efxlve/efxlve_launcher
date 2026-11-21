import { captureProfileScreenshot } from "../../epic-commands";
import { toast } from "../../core/toast";
import { t } from "../../i18n";

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

    const res = await captureProfileScreenshot(clip);

    // Copy to clipboard for instant pasting (Discord, Twitter, Telegram, etc.)
    let copied = false;
    if (res.dataUrl && navigator.clipboard && typeof ClipboardItem !== "undefined") {
      try {
        const resp = await fetch(res.dataUrl);
        const blob = await resp.blob();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copied = true;
      } catch {
        // Clipboard write might fail if window lost focus or permission denied; file is still saved
      }
    }

    if (copied) {
      toast(t("profile.screenshotSavedClip", { file: res.fileName }), "ok");
    } else {
      toast(t("profile.screenshotSaved", { file: res.fileName }), "ok");
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

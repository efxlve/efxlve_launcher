import { captureProfileScreenshot, openProfileScreenshotsFolder } from "../../epic-commands";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { cachedSteamCover, rememberSteamCover, rememberSteamHero } from "../../core/steam-art-cache";
import { steamLibraryArt } from "../../steam";
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

  const view = document.getElementById("view");
  const savedScrollTop = view ? view.scrollTop : 0;

  // Reset scroll to top so client rects and viewport coordinates are aligned from 0
  if (view) view.scrollTop = 0;
  window.scrollTo(0, 0);

  // Add the capture class which overrides content-visibility, containment, hides chrome, and expands view
  document.body.classList.add("capturing-profile-screenshot");

  try {
    // 1. Pre-resolve any uncached Steam art in batch so off-screen cards have valid cover URLs
    const uncachedSteamIds: string[] = [];
    profileEl.querySelectorAll<HTMLImageElement>("img[data-steam-app]").forEach((img) => {
      const appId = img.dataset.steamApp;
      if (appId && /^\d+$/.test(appId) && cachedSteamCover(appId) === undefined) {
        uncachedSteamIds.push(appId);
      }
    });

    if (uncachedSteamIds.length > 0) {
      try {
        const uniqueIds = [...new Set(uncachedSteamIds)];
        const artMap = await steamLibraryArt(uniqueIds);
        for (const [appId, art] of Object.entries(artMap)) {
          const cover = art?.cover || art?.hero || "";
          rememberSteamCover(appId, cover);
          if (art?.hero) rememberSteamHero(appId, art.hero);
          if (cover) {
            profileEl.querySelectorAll<HTMLImageElement>(`img[data-steam-app="${appId}"]`).forEach((img) => {
              img.dataset.artStep = "resolved";
              img.removeAttribute("data-art-pending");
              if (img.getAttribute("src") !== cover) {
                img.src = cover;
              }
            });
          }
        }
      } catch {
        // Fallback chain continues below
      }
    }

    // 2. Set loading="eager" on all images to ensure the browser fetches off-screen images
    const allImages = Array.from(profileEl.querySelectorAll<HTMLImageElement>("img"));
    allImages.forEach((img) => {
      if (img.loading === "lazy") {
        img.loading = "eager";
      }
    });

    // 3. Wait for pending images to finish downloading and decoding
    const pendingImages = allImages.filter((img) => !img.complete);
    if (pendingImages.length > 0) {
      await Promise.race([
        Promise.all(
          pendingImages.map(
            (img) =>
              new Promise<void>((resolve) => {
                if (img.complete) {
                  resolve();
                  return;
                }
                const onDone = () => {
                  img.removeEventListener("load", onDone);
                  img.removeEventListener("error", onDone);
                  resolve();
                };
                img.addEventListener("load", onDone, { once: true });
                img.addEventListener("error", onDone, { once: true });
                img.decode().catch(() => {}).then(onDone);
              })
          )
        ),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }

    // 4. Force layout reflow and wait two animation frames for styles to paint cleanly
    void profileEl.offsetHeight;
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
    if (view && savedScrollTop > 0) {
      view.scrollTop = savedScrollTop;
    }
    if (btn) {
      btn.classList.remove("is-busy");
      btn.removeAttribute("aria-busy");
    }
    isBusy = false;
  }
}

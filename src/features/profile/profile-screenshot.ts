import { captureProfileScreenshot, openProfileScreenshotsFolder } from "../../epic-commands";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { cachedSteamCover, rememberSteamCover, rememberSteamHero } from "../../core/steam-art-cache";
import { steamLibraryArt, type SteamLibraryArt } from "../../steam";
import {
  ssProfileClipboardOn,
  ssProfileCustomDir,
  ssProfileOpenFolderOn,
  ssProfileSaveFileOn,
} from "../screenshots/ss-settings";

let isBusy = false;

/** How long one cover may take before the capture gives up on it. */
const IMAGE_WAIT_MS = 15000;

async function loadAllProfileImages(container: HTMLElement): Promise<void> {
  // 1. Pre-resolve any uncached Steam art in batch so off-screen cards have valid cover URLs
  const uncachedSteamIds: string[] = [];
  container.querySelectorAll<HTMLImageElement>("img[data-steam-app]").forEach((img) => {
    const appId = img.dataset.steamApp;
    if (appId && /^\d+$/.test(appId) && cachedSteamCover(appId) === undefined) {
      uncachedSteamIds.push(appId);
    }
  });

  if (uncachedSteamIds.length > 0) {
    try {
      const uniqueIds = [...new Set(uncachedSteamIds)];
      // steam_library_art answers at most 40 ids per call. A full profile page
      // can easily ask for more, so send one batch per 40 instead of letting
      // the backend's take(40) silently drop the rest.
      const batches: string[][] = [];
      for (let i = 0; i < uniqueIds.length; i += 40) {
        batches.push(uniqueIds.slice(i, i + 40));
      }
      const artMaps = await Promise.all(
        batches.map((batch) =>
          steamLibraryArt(batch).catch((): Record<string, SteamLibraryArt> => ({}))
        ),
      );
      for (const artMap of artMaps) {
        for (const [appId, art] of Object.entries(artMap)) {
          const cover = art?.cover || art?.hero || "";
          rememberSteamCover(appId, cover);
          if (art?.hero) rememberSteamHero(appId, art.hero);
          if (cover) {
            container.querySelectorAll<HTMLImageElement>(`img[data-steam-app="${appId}"]`).forEach((img) => {
              img.dataset.artStep = "resolved";
              img.removeAttribute("data-art-pending");
              if (img.getAttribute("src") !== cover) {
                img.src = cover;
              }
            });
          }
        }
      }
    } catch {
      // Best-effort
    }
  }

  // 2. Find all images in the container
  const allImages = Array.from(container.querySelectorAll<HTMLImageElement>("img"));
  if (allImages.length === 0) return;

  // 3. Every picture is pulled through an in-memory Image() so Chromium's lazy
  //    heuristics cannot skip the cards far below the viewport. The capture
  //    waits for all of them: a fixed short race timed out on a slow connection
  //    and left every offscreen cover blank. A single dead URL still releases
  //    its slot after a ceiling instead of holding the whole page.
  const pending = allImages.map((img) => {
    return new Promise<void>((resolve) => {
      const src = img.getAttribute("src") || img.src;
      if (!src) {
        resolve();
        return;
      }

      img.removeAttribute("loading");
      img.loading = "eager";

      if (img.complete && img.naturalWidth > 0) {
        resolve();
        return;
      }

      let settled = false;
      let timer = 0;
      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        // Re-assign the source instead of writing the same value again: a
        // deferred lazy image ignores an identical src, so the downloaded
        // bytes in the cache would never reach the element. Removing the
        // attribute first forces the element to resolve the source again, and
        // the cached response arrives without a second network request.
        img.removeAttribute("src");
        img.setAttribute("src", src);
        const decodeTimer = window.setTimeout(resolve, 1500);
        img.decode().catch(() => {}).then(() => {
          window.clearTimeout(decodeTimer);
          resolve();
        });
      };

      const loader = new Image();
      loader.onload = done;
      loader.onerror = done;
      timer = window.setTimeout(done, IMAGE_WAIT_MS);
      loader.src = src;
    });
  });

  await Promise.all(pending);
}

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
    // Eagerly resolve and decode all offscreen profile images
    await loadAllProfileImages(profileEl);

    // Force layout reflow and wait two animation frames for styles to paint cleanly
    void profileEl.offsetHeight;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    // The frames schedule the paint; give the compositor a moment to upload the
    // offscreen tiles that were just filled with covers.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    const rect = profileEl.getBoundingClientRect();
    const clip = {
      x: Math.max(0, Math.floor(rect.left)),
      y: Math.max(0, Math.floor(rect.top)),
      width: Math.max(100, Math.ceil(rect.width)),
      height: Math.max(100, Math.ceil(Math.max(rect.height, profileEl.scrollHeight))),
      scale: window.devicePixelRatio || 1,
    };

    // The clipboard write is the only reason to carry the image back over IPC.
    const canCopy = ssProfileClipboardOn()
      && Boolean(navigator.clipboard)
      && typeof ClipboardItem !== "undefined";
    // A capture that neither copies nor writes a file would produce nothing the
    // user can reach, so file output is the fallback when copying is unavailable.
    const saveToFile = ssProfileSaveFileOn() || !canCopy;
    // Opening the folder only makes sense when a new file landed in it.
    const openFolder = saveToFile && ssProfileOpenFolderOn();
    const customDir = ssProfileCustomDir() || null;

    const res = await captureProfileScreenshot(clip, customDir, saveToFile, canCopy);

    let copied = false;
    if (canCopy && res.dataUrl) {
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
      // Copying was the only requested output and the clipboard write failed.
      toast(t("profile.screenshotFailed"), "err");
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

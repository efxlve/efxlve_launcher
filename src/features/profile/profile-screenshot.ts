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
/** The capture class moves #view's 28px side padding onto .profile-page. */
const CAPTURE_PAGE_PADDING_X = 56;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Resolves the published Steam asset URLs for cards whose flat CDN capsule is a
 * 404. `steam_library_art` answers at most 40 ids per call, so a full profile
 * page needs several batches instead of a silent truncation.
 */
async function resolveProfileSteamArt(container: HTMLElement): Promise<void> {
  const uncachedSteamIds: string[] = [];
  container.querySelectorAll<HTMLImageElement>("img[data-steam-app]").forEach((img) => {
    const appId = img.dataset.steamApp;
    if (appId && /^\d+$/.test(appId) && cachedSteamCover(appId) === undefined) {
      uncachedSteamIds.push(appId);
    }
  });
  if (uncachedSteamIds.length === 0) return;

  try {
    const uniqueIds = [...new Set(uncachedSteamIds)];
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
    // Best-effort: the flat CDN capsule is still a valid image for many games.
  }
}

/**
 * Walks the page through the viewport once. Chromium loads and paints a lazy
 * image when it enters the viewport; forcing an offscreen <img> to fetch puts
 * the bytes in the cache but not necessarily a painted tile, which is why the
 * lower rows used to stay blank.
 */
async function primeProfileImages(view: HTMLElement | null, container: HTMLElement): Promise<void> {
  if (!view) return;
  const max = Math.max(0, container.scrollHeight - view.clientHeight);
  if (max <= 0) return;

  const step = Math.max(320, Math.floor(view.clientHeight * 0.7));
  for (let top = step; top < max; top += step) {
    view.scrollTop = top;
    await nextFrame();
    await nextFrame();
  }
  view.scrollTop = max;
  // Give the last lazy rows a moment to start before the layout expands.
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  view.scrollTop = 0;
  await nextFrame();
}

/**
 * Waits for every image the priming pass started. The source is never rewritten
 * here: resetting a decoded cover forces a fresh decode, and forty large covers
 * do not finish that before the capture reads the surface.
 */
async function waitForProfileImages(container: HTMLElement): Promise<void> {
  const allImages = Array.from(container.querySelectorAll<HTMLImageElement>("img"));
  await Promise.all(
    allImages.map(
      (img) =>
        new Promise<void>((resolve) => {
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
            img.removeEventListener("load", done);
            img.removeEventListener("error", done);
            resolve();
          };
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
          timer = window.setTimeout(done, IMAGE_WAIT_MS);
        }),
    ),
  );
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

  try {
    // 1. Resolve the Steam art first, then walk the page through the viewport.
    //    The capture class below changes the geometry, so the normal layout is
    //    the only place native lazy loading can see every row.
    await resolveProfileSteamArt(profileEl);
    await primeProfileImages(view, profileEl);

    // 2. Reset the scroll and expand the page. Pin the width to the rendered
    //    content width: the capture class moves #view's side padding onto the
    //    page, and without this the grids reflow to fewer columns and a card
    //    wraps to a second row in the screenshot only.
    if (view) view.scrollTop = 0;
    window.scrollTo(0, 0);
    const renderWidth = Math.ceil(profileEl.getBoundingClientRect().width);
    document.body.style.setProperty(
      "--capture-page-width",
      `${renderWidth + CAPTURE_PAGE_PADDING_X}px`,
    );
    document.body.classList.add("capturing-profile-screenshot");

    // 3. Wait for the covers the scroll started. A background render can
    //    replace the page while they load, so wait on the live element too.
    await waitForProfileImages(profileEl);
    let live = document.querySelector<HTMLElement>(".profile-page") ?? profileEl;
    if (live !== profileEl) {
      await waitForProfileImages(live);
    }

    // Force layout reflow and wait two animation frames for styles to paint cleanly.
    void live.offsetHeight;
    await nextFrame();
    await nextFrame();
    // The frames schedule the paint; give the compositor a moment to upload the
    // tiles that were just filled with covers.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    const rect = live.getBoundingClientRect();
    const clip = {
      x: Math.max(0, Math.floor(rect.left)),
      y: Math.max(0, Math.floor(rect.top)),
      width: Math.max(100, Math.ceil(rect.width)),
      height: Math.max(100, Math.ceil(Math.max(rect.height, live.scrollHeight))),
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
    document.body.style.removeProperty("--capture-page-width");
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

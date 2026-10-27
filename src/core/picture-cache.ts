/**
 * The pictures the game page paints come from the network (IGDB, the store
 * CDNs), and every source that carries data already caches its answers on disk.
 * This is the same idea for images: ask Rust once for a batch of URLs, get each
 * picture back as a `data:` URL, and paint from that after.
 *
 * Deliberately not a file path plus Tauri's asset protocol: the first version
 * worked that way and the protocol (with a prefetch that ran at boot) is the
 * prime suspect for the window closing seconds after start on some machines.
 * Nothing here runs at boot either — the warm pass waits for an idle moment.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./constants";
import { epicWideArt, summaryOf } from "./selectors";
import { S } from "./state";

interface CachedImage {
  url: string;
  dataUrl: string;
}

/** URL → `data:` URL, for the pictures already on disk. */
const cachedPictures = new Map<string, string>();
/** Keep the decoded data URLs bounded; a long session must not grow forever. */
const PICTURE_CACHE_LIMIT = 32;
/** URLs asked for in this session, so a repaint does not ask twice. */
const requested = new Set<string>();

/** The source to paint: the cached picture when there is one, the URL otherwise. */
export function cachedImage(url: string | null | undefined): string {
  if (!url) return "";
  return cachedPictures.get(url) ?? url;
}

/**
 * Asks for a batch of pictures in the background and swaps whatever is on screen
 * when the answers land. Safe to call with duplicates, `null`s and data URLs.
 */
export function warmImages(urls: Array<string | null | undefined>): void {
  if (!isTauri || S.offlineMode) return;
  const wanted: string[] = [];
  for (const url of urls) {
    if (!url || !url.startsWith("http")) continue;
    if (cachedPictures.has(url) || requested.has(url)) continue;
    requested.add(url);
    wanted.push(url);
  }
  if (wanted.length === 0) return;
  void invoke<CachedImage[]>("cache_images", { urls: wanted })
    .then((entries) => {
      let landed = false;
      for (const entry of entries) {
        if (entry.dataUrl) {
          if (cachedPictures.size >= PICTURE_CACHE_LIMIT) {
            const oldest = cachedPictures.keys().next().value;
            if (oldest) cachedPictures.delete(oldest);
          }
          cachedPictures.set(entry.url, entry.dataUrl);
          landed = true;
        }
      }
      if (landed) swapPaintedImages();
    })
    .catch(() => {
      // A cache miss is not an error: the network URL stays on screen.
      for (const url of wanted) requested.delete(url);
    });
}

/**
 * Repaints every element that asked for a URL, now that some are local. The
 * hero paints its picture twice (an `<img>` over a blurred backdrop), and a
 * backdrop left on the network URL would download again on every open.
 */
function swapPaintedImages(): void {
  document.querySelectorAll<HTMLElement>("[data-img-url]").forEach((node) => {
    const url = node.dataset.imgUrl;
    if (!url) return;
    const local = cachedPictures.get(url);
    if (!local) return;
    if (node instanceof HTMLImageElement) {
      if (node.src !== local) node.src = local;
      return;
    }
    node.style.backgroundImage = `url("${local}")`;
  });
}

/** How much room the picture cache takes on disk, in bytes. */
export const imageCacheSize = () => invoke<number>("image_cache_size");

/** Empties the picture cache; returns the bytes it held. */
export async function clearImageCache(): Promise<number> {
  const bytes = await invoke<number>("clear_image_cache");
  cachedPictures.clear();
  requested.clear();
  return bytes;
}

/**
 * Warms the hero art of the recently played games, once the window is idle.
 *
 * It used to run at boot, which is where the first version hurt: on a slow
 * connection a burst of downloads started while the app was still painting.
 * Nothing here is needed for the first paint — by the time the user clicks a
 * game, its picture is on disk and the page never waits for the network.
 */
export function prefetchRecentPicturesWhenIdle(): void {
  const run = (): void => {
    const urls: string[] = [];
    for (const appName of S.epicRecent.slice(0, 8)) {
      const summary = summaryOf(appName);
      const art = summary ? epicWideArt(summary) || summary.cover : "";
      if (art) urls.push(art);
    }
    warmImages(urls);
  };
  const idleHost = window as Window & { requestIdleCallback?: (cb: () => void) => number };
  if (typeof idleHost.requestIdleCallback === "function") idleHost.requestIdleCallback(run);
  else window.setTimeout(run, 4000);
}

/**
 * The pictures the game page paints come from the network (IGDB, the store
 * CDNs), and every source that carries data already caches its answers on disk.
 * This is the same idea for images: ask Rust once for a batch of URLs, get the
 * local file for each, and paint from disk after that.
 *
 * The map is filled at boot for the recently played games and again whenever a
 * page asks for pictures it has not seen, so a page that was opened once opens
 * without a single image request.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./constants";
import { epicWideArt, summaryOf } from "./selectors";
import { S } from "./state";

interface CachedImage {
  url: string;
  path: string;
}

/** URL → local file path, for the images already on disk. */
const cachedPaths = new Map<string, string>();
/** URLs asked for in this session, so a repaint does not ask twice. */
const requested = new Set<string>();

/** The source to paint: the local file when it is cached, the URL otherwise. */
export function cachedImage(url: string | null | undefined): string {
  if (!url) return "";
  const local = cachedPaths.get(url);
  return local ? convertFileSrc(local) : url;
}

/**
 * Asks for a batch of images in the background and swaps whatever is on screen
 * when the answers land. Safe to call with duplicates, `null`s and data URLs.
 */
export function warmImages(urls: Array<string | null | undefined>): void {
  if (!isTauri) return;
  const wanted: string[] = [];
  for (const url of urls) {
    if (!url || !url.startsWith("http")) continue;
    if (cachedPaths.has(url) || requested.has(url)) continue;
    requested.add(url);
    wanted.push(url);
  }
  if (wanted.length === 0) return;
  void invoke<CachedImage[]>("cache_images", { urls: wanted })
    .then((entries) => {
      let landed = false;
      for (const entry of entries) {
        if (entry.path) {
          cachedPaths.set(entry.url, entry.path);
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

/** Repaints every image that asked for a URL, now that some are local. */
function swapPaintedImages(): void {
  document.querySelectorAll<HTMLImageElement>("img[data-img-url]").forEach((img) => {
    const url = img.dataset.imgUrl;
    if (!url) return;
    const local = cachedPaths.get(url);
    if (!local) return;
    const next = convertFileSrc(local);
    if (img.src !== next) img.src = next;
  });
}

/** True when this URL already paints from disk. */
export function isImageCached(url: string): boolean {
  return cachedPaths.has(url);
}

/** How much room the picture cache takes on disk, in bytes. */
export const imageCacheSize = () => invoke<number>("image_cache_size");

/** Empties the picture cache; returns the bytes it held. */
export const clearImageCache = () => invoke<number>("clear_image_cache");

/**
 * Warms the hero art of the recently played games. Called once from the boot
 * path, well behind the first paint: by the time the user clicks a game, its
 * picture is already on disk and the page never waits for the network.
 */
export function prefetchRecentImages(): void {
  const urls: string[] = [];
  for (const appName of S.epicRecent.slice(0, 8)) {
    const summary = summaryOf(appName);
    const art = summary ? epicWideArt(summary) || summary.cover : "";
    if (art) urls.push(art);
  }
  warmImages(urls);
}

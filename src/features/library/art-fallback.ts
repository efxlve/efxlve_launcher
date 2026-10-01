/**
 * Recovers library covers whose first URL 404s.
 *
 * Steam's flat capsule path is missing for a lot of newer games. Those images
 * walk a short CDN list, then one batched store lookup, then the header.
 * Epic vertical-cover rewrites fall back to the original key image. Anything
 * still broken becomes the plain placeholder instead of an empty black tile.
 */

import { icon } from "../../core/icons";
import {
  cachedSteamCover,
  cachedSteamHero,
  forgetSteamCover,
  rememberSteamCover,
  rememberSteamHero,
  steamHeaderPortrait,
} from "../../core/steam-art-cache";
import { steamLibraryArt } from "../../steam";

const pendingImgs = new Map<string, HTMLImageElement[]>();
const queued = new Set<string>();
const inflight = new Set<string>();
let flushTimer = 0;
let installed = false;

function showPlaceholder(img: HTMLImageElement): void {
  const ph = document.createElement("div");
  ph.className = "pcover";
  ph.innerHTML = icon("gamepad-2", 32);
  img.replaceWith(ph);
}

function applyResolved(appId: string, url: string): void {
  const imgs = document.querySelectorAll<HTMLImageElement>(`img[data-steam-app="${appId}"]`);
  if (!url) {
    imgs.forEach((img) => {
      img.dataset.artStep = "header";
      img.removeAttribute("data-art-pending");
      img.src = steamHeaderPortrait(appId);
    });
    return;
  }
  imgs.forEach((img) => {
    img.dataset.artStep = "resolved";
    img.removeAttribute("data-art-pending");
    if (img.getAttribute("src") !== url) img.src = url;
  });
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    void flush();
  }, 80);
}

async function flush(): Promise<void> {
  const ids = [...queued].slice(0, 40);
  if (ids.length === 0) return;
  for (const id of ids) {
    queued.delete(id);
    inflight.add(id);
  }
  try {
    const map = await steamLibraryArt(ids);
    for (const id of ids) {
      const art = map[id];
      const cover = art?.cover || "";
      const hero = art?.hero || "";
      rememberSteamCover(id, cover);
      rememberSteamHero(id, hero);
      applyResolved(id, cover || hero);
      inflight.delete(id);
      pendingImgs.delete(id);
    }
  } catch {
    for (const id of ids) {
      inflight.delete(id);
      pendingImgs.delete(id);
      applyResolved(id, "");
    }
  }
  if (queued.size > 0) scheduleFlush();
}

function queueSteamResolve(appId: string, img: HTMLImageElement): void {
  const known = cachedSteamCover(appId);
  if (known !== undefined) {
    applyResolved(appId, known);
    return;
  }
  img.dataset.artPending = "1";
  const list = pendingImgs.get(appId) ?? [];
  list.push(img);
  pendingImgs.set(appId, list);
  if (inflight.has(appId) || queued.has(appId)) return;
  queued.add(appId);
  scheduleFlush();
}

function onArtError(ev: Event): void {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.dataset.artPending === "1") return;

  const fallback = img.dataset.artFallback;
  if (fallback) {
    delete img.dataset.artFallback;
    img.src = fallback;
    return;
  }

  const appId = img.dataset.steamApp;
  if (!appId || !/^\d+$/.test(appId)) {
    if (img.closest("[data-card-art], .lrow-art")) showPlaceholder(img);
    return;
  }

  const step = img.dataset.artStep || "0";
  if (step === "header") {
    rememberSteamCover(appId, "");
    showPlaceholder(img);
    return;
  }
  if (step === "resolved") {
    forgetSteamCover(appId);
    const hero = cachedSteamHero(appId);
    if (hero) {
      img.dataset.artStep = "hero";
      img.src = hero;
      return;
    }
    img.dataset.artStep = "header";
    img.src = steamHeaderPortrait(appId);
    return;
  }
  if (step === "hero") {
    img.dataset.artStep = "header";
    img.src = steamHeaderPortrait(appId);
    return;
  }

  queueSteamResolve(appId, img);
}

function onArtLoad(ev: Event): void {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.naturalWidth > 0) return;
  if (!img.closest("[data-card-art], .lrow-art")) return;
  onArtError(ev);
}

/** One capture-phase listener. Image errors do not bubble. */
export function installArtFallback(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("error", onArtError, true);
  document.addEventListener("load", onArtLoad, true);
}

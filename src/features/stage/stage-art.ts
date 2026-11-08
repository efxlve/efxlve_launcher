/**
 * Artwork resolution for Stage Mode.
 *
 * Stage never invents a store library: the URLs come from the same helpers the
 * desktop library uses. When a game has no picture at all, the poster fallback
 * paints a typographic playbill instead of a grey box.
 */

import { epicArtUrl } from "../../core/game-view";
import { epicWideArt } from "../../core/selectors";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";

const prefetched = new Set<string>();

/** Wide key art: hero banners, program pages and the library's side stage. */
export function stageWideArt(s: EpicSummary): string | null {
  return epicWideArt(s) || epicArtUrl(s) || null;
}

/** Portrait cover: the shelf wall. */
export function stageCoverArt(s: EpicSummary): string | null {
  return epicArtUrl(s) || epicWideArt(s) || null;
}

/** Deterministic 0..3 layout choice, so one game always keeps the same poster. */
function posterVariant(title: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < title.length; i++) {
    hash ^= title.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash >>> 0) % 4;
}

function posterMonogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] || "").join("");
  return (letters || title.slice(0, 2)).toUpperCase();
}

/**
 * Typographic poster used when a title has no cover and no hero. The title is
 * the picture; the layout rotates through four quiet compositions.
 */
export function stagePoster(title: string, subtitle = ""): string {
  const variant = posterVariant(title);
  return `<div class="stage-poster stage-poster-${variant}" aria-hidden="true">
    <span class="stage-poster-mono">${esc(posterMonogram(title))}</span>
    <span class="stage-poster-rule"></span>
    <span class="stage-poster-title">${esc(title)}</span>
    ${subtitle ? `<span class="stage-poster-sub">${esc(subtitle)}</span>` : ""}
  </div>`;
}

/** A cover image with the per-game poster fallback kept beside it. */
export function stageCoverMarkup(s: EpicSummary, className = "stage-cover-art", lazy = false): string {
  const url = stageCoverArt(s);
  if (!url) return stagePoster(s.title, s.installed ? "" : s.version);
  return `<img class="${className}" src="${esc(url)}" alt="" decoding="async" loading="${lazy ? "lazy" : "eager"}" />`;
}

/** A wide image with the same fallback discipline. */
export function stageHeroMarkup(s: EpicSummary, className = "stage-hero-art"): string {
  const url = stageWideArt(s);
  if (!url) return stagePoster(s.title, s.version);
  return `<img class="${className}" src="${esc(url)}" alt="" decoding="async" loading="eager" />`;
}

/** Warm a handful of pictures without starting a visible load. */
export function stagePrefetch(urls: Array<string | null | undefined>, limit = 8): void {
  let count = 0;
  for (const url of urls) {
    if (!url || prefetched.has(url)) continue;
    prefetched.add(url);
    if (prefetched.size > 240) prefetched.clear();
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    if (++count >= limit) break;
  }
}

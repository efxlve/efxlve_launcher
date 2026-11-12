/**
 * Two-layer artwork swap for Stage.
 *
 * A focus move must never blank a picture while the next one decodes: the new
 * image is appended at opacity 0, fades in on load, and only the frame that was
 * already painted stays behind it. The Home hero and the library side stage
 * share this helper so both keep the same timing and cleanup rules.
 */

/** Must match `.stage-art-swap` in the stage stylesheets. */
const FADE_MS = 460;
const tokens = new WeakMap<HTMLElement, number>();

export interface StageArtSwapOptions {
  /** Wide art for the game, or null when it only has a poster. */
  url: string | null;
  /** Identity of the picture, kept on the layer for debugging and tests. */
  key: string;
  /** Class that supplies sizing and object-fit for this container. */
  className: string;
  /** Markup used when there is no picture (a typographic poster). */
  fallback: string;
}

export function swapStageArt(container: HTMLElement, options: StageArtSwapOptions): void {
  const { url, key, className, fallback } = options;
  const token = (tokens.get(container) ?? 0) + 1;
  tokens.set(container, token);

  if (!url) {
    container.innerHTML = fallback;
    return;
  }

  // A layer from an earlier sweep that never became visible is dead weight;
  // drop it so a fast sweep cannot stack invisible pictures.
  for (const stale of Array.from(container.querySelectorAll(".stage-art-swap:not(.is-active)"))) {
    stale.remove();
  }

  const next = document.createElement("img");
  next.className = `${className} stage-art-swap`;
  next.alt = "";
  next.decoding = "async";
  next.loading = "eager";
  next.dataset.artKey = key;

  let settled = false;
  const settle = (): void => {
    if (settled || tokens.get(container) !== token) return;
    settled = true;
    // A picture already in the image cache completes immediately; force the
    // 0-opacity frame to be calculated so the fade still runs instead of
    // snapping to the new art.
    void next.offsetWidth;
    next.classList.add("is-active");
    // Only the frame that is currently painted has to stay for the fade; a
    // fast sweep would otherwise stack one full-screen image per step.
    const previous = Array.from(container.children).filter((el) => el !== next).pop();
    for (const old of Array.from(container.children)) {
      if (old === next) continue;
      if (old === previous) window.setTimeout(() => old.remove(), FADE_MS);
      else old.remove();
    }
  };

  next.addEventListener("load", settle, { once: true });
  next.addEventListener(
    "error",
    () => {
      // A broken picture must not replace a working one.
      if (tokens.get(container) === token) next.remove();
    },
    { once: true },
  );
  next.src = url;
  container.appendChild(next);
  // A cached picture is already decoded, so its load event may have been
  // queued for later; settle now and let the queued event be a no-op.
  if (next.complete && next.naturalWidth > 0) settle();
}

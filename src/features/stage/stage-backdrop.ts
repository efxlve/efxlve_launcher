
const accentColorCache = new Map<string, string>();

function extractAccentFromImage(artUrl: string, callback: (rgb: string) => void): void {
  const cached = accentColorCache.get(artUrl);
  if (cached) {
    callback(cached);
    return;
  }
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, 16, 16);
      const data = ctx.getImageData(0, 0, 16, 16).data;
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        if (sat > 0.16 && max > 45 && min < 230) {
          rSum += r;
          gSum += g;
          bSum += b;
          count++;
        }
      }
      let rgb = "86, 140, 255";
      if (count > 0) {
        rgb = `${Math.round(rSum / count)}, ${Math.round(gSum / count)}, ${Math.round(bSum / count)}`;
      }
      accentColorCache.set(artUrl, rgb);
      callback(rgb);
    } catch {
      // Fallback
    }
  };
  img.src = artUrl;
}
/**
 * Dynamic atmospheric backdrop for Stage Mode.
 *
 * Provides a fluid double-buffered canvas that crossfades high-resolution key art
 * behind the entire interface as focus moves across games.
 */

let currentBackdropUrl: string | null = null;
let activeBackdropLayer: "a" | "b" = "a";

export function stageBackdropMarkup(): string {
  return `<div id="stage-backdrop" class="stage-backdrop" aria-hidden="true">
    <div class="stage-backdrop-canvas stage-backdrop-a is-active"></div>
    <div class="stage-backdrop-canvas stage-backdrop-b"></div>
    <div class="stage-backdrop-scrim"></div>
    <div class="stage-backdrop-glow"></div>
  </div>`;
}

export function updateStageBackdrop(artUrl: string | null): void {
  if (artUrl === currentBackdropUrl) return;
  currentBackdropUrl = artUrl;

  const root = document.getElementById("stage-root");
  if (!root) return;

  const layerA = root.querySelector<HTMLElement>(".stage-backdrop-a");
  const layerB = root.querySelector<HTMLElement>(".stage-backdrop-b");
  if (!layerA || !layerB) return;

  const nextLayer = activeBackdropLayer === "a" ? layerB : layerA;
  const prevLayer = activeBackdropLayer === "a" ? layerA : layerB;
  activeBackdropLayer = activeBackdropLayer === "a" ? "b" : "a";

  if (artUrl) {
    // CSS.escape() is for identifiers, not quoted URL strings: it would leave
    // backslashes inside the url() token and can break data URLs. Escape the
    // two characters a CSS string actually treats specially.
    nextLayer.style.backgroundImage = `url("${artUrl.replace(/(["\\])/g, "\\$1")}")`;
    nextLayer.classList.add("is-active");
    extractAccentFromImage(artUrl, (rgb) => {
      if (currentBackdropUrl === artUrl) {
        root.style.setProperty("--stage-accent-rgb", rgb);
      }
    });
    prevLayer.classList.remove("is-active");
    root.style.removeProperty("--stage-accent-rgb");
  } else {
    nextLayer.style.backgroundImage = "";
    nextLayer.classList.remove("is-active");
    prevLayer.classList.remove("is-active");
  }
}

export function resetStageBackdrop(): void {
  currentBackdropUrl = null;
  activeBackdropLayer = "a";
  document.getElementById("stage-root")?.style.removeProperty("--stage-accent-rgb");
}

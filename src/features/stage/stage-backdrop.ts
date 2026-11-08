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
    nextLayer.style.backgroundImage = `url("${CSS.escape(artUrl)}")`;
    nextLayer.classList.add("is-active");
    prevLayer.classList.remove("is-active");
  } else {
    nextLayer.style.backgroundImage = "";
    nextLayer.classList.remove("is-active");
    prevLayer.classList.remove("is-active");
  }
}

export function resetStageBackdrop(): void {
  currentBackdropUrl = null;
  activeBackdropLayer = "a";
}

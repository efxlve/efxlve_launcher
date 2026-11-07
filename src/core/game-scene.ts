/**
 * Blurred acrylic game-art backdrop (`#game-scene`).
 *
 * Renders two stacked `.game-scene-layer` planes inside `#game-scene` and
 * crossfades between them only after the incoming artwork finishes decoding,
 * preventing blank flashes or mid-scroll stutter. Turns `#winbar`, `#sidebar`,
 * `#page-header`, library surfaces and `.gp-hero` into a unified translucent
 * acrylic shell over the currently focused or open game's artwork.
 */

import { GAME_SCENE_KEY } from "./constants";
import { epicArtUrl } from "./game-view";
import { cachedImage, IMAGE_HERO_WIDTH } from "./picture-cache";
import { scheduleRender } from "./render";
import { allStoreSummaries, epicWideArt, summaryOf } from "./selectors";
import { S } from "./state";

let currentSceneUrl = "";
let lastHoveredAppName = "";
let activeSlot: 0 | 1 = 0;
let loadSeq = 0;
let hoverTimer = 0;

/** CSS-safe `url("...")` value; quotes and newlines cannot escape. */
function cssUrl(url: string): string {
  const safe = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
  return `url("${safe}")`;
}

function getSceneLayers(): [HTMLElement, HTMLElement] | null {
  const host = document.getElementById("game-scene");
  if (!host) return null;
  let layerA = host.querySelector<HTMLElement>(".game-scene-layer.is-a");
  let layerB = host.querySelector<HTMLElement>(".game-scene-layer.is-b");
  if (!layerA) {
    layerA = document.createElement("div");
    layerA.className = "game-scene-layer is-a";
    host.appendChild(layerA);
  }
  if (!layerB) {
    layerB = document.createElement("div");
    layerB.className = "game-scene-layer is-b";
    host.appendChild(layerB);
  }
  return [layerA, layerB];
}

function commitLayerSwap(resolvedUrl: string): void {
  document.documentElement.style.setProperty("--game-scene-image", cssUrl(resolvedUrl));
  const layers = getSceneLayers();
  if (!layers) return;
  const nextSlot: 0 | 1 = activeSlot === 0 ? 1 : 0;
  const nextLayer = layers[nextSlot];
  const prevLayer = layers[activeSlot];
  nextLayer.style.backgroundImage = cssUrl(resolvedUrl);
  // Force style flush only when crossfading so opacity transitions cleanly.
  if (!S.reduceEffects) void nextLayer.offsetWidth;
  nextLayer.classList.add("is-active");
  prevLayer.classList.remove("is-active");
  activeSlot = nextSlot;
}

function paintScene(rawUrl: string): void {
  if (!S.gameScene || !rawUrl) return;
  const resolved = cachedImage(rawUrl, IMAGE_HERO_WIDTH) || rawUrl;
  if (!resolved || resolved === currentSceneUrl) return;
  currentSceneUrl = resolved;
  const seq = ++loadSeq;

  if (S.reduceEffects) {
    commitLayerSwap(resolved);
    return;
  }

  const probe = new Image();
  probe.decoding = "async";
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    if (seq !== loadSeq || !S.gameScene) return;
    commitLayerSwap(resolved);
  };
  probe.onload = finish;
  probe.onerror = () => {
    // Fall back to raw URL if resized cache URL failed.
    if (done || seq !== loadSeq || !S.gameScene) return;
    done = true;
    if (rawUrl !== resolved) commitLayerSwap(rawUrl);
  };
  probe.src = resolved;
  if (probe.complete && probe.naturalWidth > 0) finish();
}

/** Resolves the best wide/cover artwork for one summary. */
function artForApp(appName: string): string {
  if (!appName) return "";
  if (S.customHeroes[appName]) return S.customHeroes[appName];
  const item = summaryOf(appName);
  if (!item) return "";
  return epicWideArt(item) || epicArtUrl(item) || item.cover || "";
}

/** Sets the backdrop from a library item or game page. No-op when the mode is off. */
export function setGameSceneArt(url: string | null | undefined): void {
  if (url) paintScene(url);
}

/** First visible title paints a backdrop before the player points at anything. */
export function primeGameScene(): void {
  if (!S.gameScene || currentSceneUrl) return;
  if (S.currentModalAppName) {
    const modalArt = artForApp(S.currentModalAppName);
    if (modalArt) {
      paintScene(modalArt);
      return;
    }
  }
  const first = allStoreSummaries().find((item) => epicWideArt(item) || epicArtUrl(item));
  if (first) paintScene(epicWideArt(first) || epicArtUrl(first));
}

/** Restores the resting library backdrop after a game page closes. */
export function syncGameSceneRest(): void {
  if (!S.gameScene) return;
  if (S.currentModalAppName) {
    const modalArt = artForApp(S.currentModalAppName);
    if (modalArt) paintScene(modalArt);
    return;
  }
  if (lastHoveredAppName) {
    const hoveredArt = artForApp(lastHoveredAppName);
    if (hoveredArt) {
      paintScene(hoveredArt);
      return;
    }
  }
  primeGameScene();
}

/** Mirrors the stored switch onto the root element, or clears layers when off. */
export function applyGameScene(): void {
  if (S.gameScene) {
    document.documentElement.dataset.gameScene = "on";
    primeGameScene();
  } else {
    loadSeq++;
    if (hoverTimer) {
      window.clearTimeout(hoverTimer);
      hoverTimer = 0;
    }
    delete document.documentElement.dataset.gameScene;
    document.documentElement.style.removeProperty("--game-scene-image");
    currentSceneUrl = "";
    const layers = getSceneLayers();
    if (layers) {
      for (const layer of layers) {
        layer.classList.remove("is-active");
        layer.style.backgroundImage = "";
      }
    }
  }
}

export function setGameSceneEnabled(on: boolean): void {
  S.gameScene = on;
  localStorage.setItem(GAME_SCENE_KEY, String(on));
  applyGameScene();
  scheduleRender();
}

let hoverWired = false;

function scheduleCardScene(appName: string): void {
  lastHoveredAppName = appName;
  if (hoverTimer) window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    hoverTimer = 0;
    if (!S.gameScene || S.currentModalAppName) return;
    const art = artForApp(appName);
    if (art) paintScene(art);
  }, 65);
}

/**
 * A library card under the pointer or keyboard/gamepad focus becomes the
 * backdrop after a short 65 ms settle window so fast cursor sweeps across the
 * grid never queue redundant decodes.
 */
export function initGameSceneHover(): void {
  if (hoverWired) return;
  hoverWired = true;

  document.addEventListener(
    "pointerover",
    (event) => {
      if (!S.gameScene || S.view !== "library" || S.currentModalAppName) return;
      const card = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-lib-item]");
      const appName = card?.dataset.libItem;
      if (appName) scheduleCardScene(appName);
    },
    { passive: true },
  );

  document.addEventListener(
    "focusin",
    (event) => {
      if (!S.gameScene || S.view !== "library" || S.currentModalAppName) return;
      const card = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-lib-item]");
      const appName = card?.dataset.libItem;
      if (appName) scheduleCardScene(appName);
    },
    { passive: true },
  );
}

/**
 * Blurred game-art backdrop.
 *
 * The setting turns the shell surfaces into translucent acrylic over a wide,
 * blurred picture. The picture follows the game the player is looking at: a
 * library card under the pointer, or the game page that is open. The image is
 * always one the launcher already displays, so switching it costs no new
 * request unless the game page needs its wide art resolved.
 */

import { GAME_SCENE_KEY } from "./constants";
import { epicArtUrl } from "./game-view";
import { scheduleRender } from "./render";
import { allStoreSummaries, epicWideArt, summaryOf } from "./selectors";
import { S } from "./state";

let currentSceneUrl = "";

/** CSS-safe `url("...")` value; a quote can never escape the string. */
function cssUrl(url: string): string {
  const safe = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
  return `url("${safe}")`;
}

function paintScene(url: string): void {
  if (!S.gameScene || !url || url === currentSceneUrl) return;
  currentSceneUrl = url;
  document.documentElement.style.setProperty("--game-scene-image", cssUrl(url));
}

/** Sets the backdrop from a library item or game page. No-op when the mode is off. */
export function setGameSceneArt(url: string | null | undefined): void {
  if (url) paintScene(url);
}

/** First visible title paints a backdrop before the player points at anything. */
export function primeGameScene(): void {
  if (!S.gameScene || currentSceneUrl) return;
  const first = allStoreSummaries().find((item) => epicWideArt(item) || epicArtUrl(item));
  if (first) paintScene(epicWideArt(first) || epicArtUrl(first));
}

/** Mirrors the stored switch onto the root element, or removes it entirely. */
export function applyGameScene(): void {
  if (S.gameScene) {
    document.documentElement.dataset.gameScene = "on";
    primeGameScene();
  } else {
    delete document.documentElement.dataset.gameScene;
    document.documentElement.style.removeProperty("--game-scene-image");
    currentSceneUrl = "";
  }
}

export function setGameSceneEnabled(on: boolean): void {
  S.gameScene = on;
  localStorage.setItem(GAME_SCENE_KEY, String(on));
  applyGameScene();
  scheduleRender();
}

let hoverWired = false;

/**
 * A library card under the pointer becomes the backdrop. The cover URL is the
 * one the card already has in the page, which is why this can run on every
 * pointer move without a debounce.
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
      if (!appName) return;
      const item = summaryOf(appName);
      if (!item) return;
      paintScene(epicWideArt(item) || epicArtUrl(item));
    },
    { passive: true },
  );
}

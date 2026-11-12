/**
 * The Stage launch ritual.
 *
 * The curtain is a transition, not a progress dialog: the real launch starts
 * immediately and the overlay gets out of the way even when a store launcher
 * needs longer than the animation.
 */

import { epicPlay } from "../../core/epic-actions";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { stageWideArt } from "./stage-art";
import { duckStageAmbience } from "./stage-ambience";
import { stageGameByKey } from "./stage-model";
import { stageFeedback } from "./stage-sound";

let launchToken = 0;
/** A store launch already handed over cannot be cancelled; the gate stays
 *  closed even after the curtain is skipped so a second press cannot fire it. */
let launchInFlight = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Launch a game behind the Stage curtain. */
export function stageLaunchGame(key: string): void {
  const summary = stageGameByKey(key);
  if (!summary) {
    toast(t("stage.gameMissing"), "err");
    return;
  }
  if (S.runningGames.has(summary.appName)) {
    toast(t("stage.alreadyRunning"), "");
    return;
  }
  if (S.stage.launch || launchInFlight) return;

  stageFeedback("launch");
  // The curtain takes the room down a little; the game's own audio should own
  // the speakers the moment it starts.
  duckStageAmbience(true);
  const token = ++launchToken;
  launchInFlight = true;
  S.stage.launch = {
    key: summary.appName,
    title: summary.title,
    art: stageWideArt(summary),
  };
  S.stage.launchError = "";
  S.stage.launchErrorKey = "";
  S.stage.quickMenu = false;
  S.stage.searchOpen = false;
  scheduleRender();

  // Let the curtain finish closing before the store client steals focus.
  void (async () => {
    try {
      await delay(420);
      if (token !== launchToken) return;
      const launch = epicPlay(summary.appName);
      await Promise.race([launch, delay(1600)]);
      if (token !== launchToken) return;
      S.stage.launch = null;
      duckStageAmbience(false);
      scheduleRender();
    } catch (error) {
      if (token !== launchToken) return;
      stageLaunchFailed(String(error), summary.appName);
    } finally {
      launchInFlight = false;
    }
  })();
}

/**
 * Dismiss the curtain early. The store launch keeps running behind it; only
 * the visual transition is skipped, so this can never cancel the launch itself.
 */
export function stageSkipLaunchCurtain(): void {
  if (!S.stage.launch) return;
  stageFeedback("back");
  S.stage.launch = null;
  scheduleRender();
}

/** A failed launch is reported in place; the curtain never hides the error. */
export function stageLaunchFailed(message: string, key?: string): void {
  launchToken++;
  stageFeedback("error");
  duckStageAmbience(false);
  S.stage.launch = null;
  S.stage.launchError = message;
  S.stage.launchErrorKey = key || S.stage.launchErrorKey;
  scheduleRender();
}

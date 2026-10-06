/**
 * Click handlers for the safe Epic Games Launcher removal.
 */

import { refreshEpicInstalled } from "../../../core/epic-actions";
import { render } from "../../../core/render";
import { S } from "../../../core/state";
import { toast } from "../../../core/toast";
import { localizeMessage, t as i18nT } from "../../../i18n";
import { eglRemove, eglRemovalPlan } from "../../../egl-removal";
import { pushNotification } from "../../notifications/notifications";
import { loadIntegrationsView } from "../../settings/settings-view";
import { closeEglRemovalModal, renderEglRemovalModal } from "../../settings/egl-removal-view";

export function handleEglRemovalAction(act: string | undefined, t: HTMLElement, _id?: string, targetEl?: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "egl-remove-open":
      toast(i18nT("settings.scanning"), "");
      void eglRemovalPlan()
        .then((plan) => {
          S.eglRemovalPlan = plan;
          renderEglRemovalModal();
        })
        .catch((err) => toast(i18nT("egl.removeFailed", { msg: localizeMessage(String(err)) }), "err"));
      return true;

    case "egl-remove-close":
      closeEglRemovalModal();
      return true;

    case "egl-remove-overlay":
      if (targetEl === t) closeEglRemovalModal();
      return true;

    case "egl-remove-confirm": {
      if (S.eglRemoving) return true;
      S.eglRemoving = true;
      renderEglRemovalModal();
      eglRemove()
        .then((res) => {
          closeEglRemovalModal();
          const summary = i18nT("egl.removeDone", {
            paths: res.removedPaths,
            shortcuts: res.removedShortcuts,
            registry: res.removedRegistry,
            games: res.gamesKept,
          });
          toast(summary, "ok");
          pushNotification({ kind: "info", title: i18nT("egl.removeTitle"), body: summary });
          // The library keeps the games; refresh what the EGL card shows.
          void refreshEpicInstalled();
          void loadIntegrationsView(true);
        })
        .catch((err) => toast(i18nT("egl.removeFailed", { msg: localizeMessage(String(err)) }), "err"))
        .finally(() => {
          S.eglRemoving = false;
          render();
        });
      return true;
    }

    default:
      return false;
  }
}

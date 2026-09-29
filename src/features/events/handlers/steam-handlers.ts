/**
 * Click delegation handlers for the Steam integration: detection hand-off,
 * Settings shortcuts and the account sign-in flow (ROADMAP §13).
 */

import { render } from "../../../core/render";
import { S } from "../../../core/state";
import { toast } from "../../../core/toast";
import { t as i18nT } from "../../../i18n";
import { steamGameAction, steamOpenClient, steamSetApiKey } from "../../../steam";
import {
  cancelSteamLogin,
  logoutSteam,
  promptSteamLogin,
  submitSteamCredentials,
  submitSteamGuardCode,
  syncSteamOwnedGames,
} from "../../auth/steam-auth-actions";
import { refreshSteamStatus } from "../../library/steam-library";
import { loadIntegrationsView, loadSettingsView } from "../../settings/settings-view";

export function handleSteamAction(act: string | undefined, target: HTMLElement, id?: string): boolean {
  if (!act) return false;

  switch (act) {
    case "steam-action": {
      const mode = target.dataset.mode === "install"
        || target.dataset.mode === "uninstall"
        || target.dataset.mode === "validate"
        ? target.dataset.mode
        : "launch";
      if (id) void steamGameAction(id, mode).catch((e: unknown) => toast(String(e), "err"));
      return true;
    }

    case "steam-open-client":
      void steamOpenClient().catch((e: unknown) => toast(String(e), "err"));
      return true;

    case "steam-open-settings":
      S.view = "settings";
      S.settingsSection = "integrations";
      void loadSettingsView();
      return true;

    case "save-steam-key": {
      const input = document.getElementById("settings-steam-key-input") as HTMLInputElement | null;
      const key = input?.value.trim() || "";
      void steamSetApiKey(key)
        .then(() => {
          S.steamApiKey = key || null;
          toast(key ? i18nT("cover.keySaved") : i18nT("cover.keyRemoved"), "ok");
          render();
        })
        .catch((e: unknown) => toast(String(e), "err"));
      return true;
    }

    case "steam-refresh":
      S.steamStatus = null;
      void loadIntegrationsView(true);
      return true;

    case "steam-scan":
      void refreshSteamStatus().then(() => render());
      return true;

    case "steam-login-start":
      promptSteamLogin();
      return true;

    case "steam-login-submit":
      void submitSteamCredentials();
      return true;

    case "steam-login-code":
      void submitSteamGuardCode();
      return true;

    case "steam-login-cancel":
      cancelSteamLogin();
      return true;

    case "steam-logout":
      void logoutSteam();
      return true;

    case "steam-owned-refresh":
      void syncSteamOwnedGames(true);
      return true;

    default:
      return false;
  }
}

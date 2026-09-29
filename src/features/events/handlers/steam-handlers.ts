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
  beginSteamQrLogin,
  cancelSteamLogin,
  logoutSteam,
  promptSteamCodeMode,
  promptSteamLogin,
  submitSteamCredentials,
  submitSteamGuardCode,
  syncSteamOwnedGames,
} from "../../auth/steam-auth-actions";
import { loadSteamLibrary, refreshSteamStatus, scheduleSteamLibraryResync } from "../../library/steam-library";
import { loadSettingsView } from "../../settings/settings-view";
import {
  removeSavedSteamAccount,
  switchSteamAccount,
} from "../../auth/steam-account-switcher";

export function handleSteamAction(act: string | undefined, target: HTMLElement, id?: string): boolean {
  if (!act) return false;

  switch (act) {
    case "steam-action": {
      const mode = target.dataset.mode === "install"
        || target.dataset.mode === "uninstall"
        || target.dataset.mode === "validate"
        ? target.dataset.mode
        : "launch";
      if (id) {
        void steamGameAction(id, mode)
          .then(() => {
            toast(i18nT("steam.opening"), "");
            // Install/uninstall/validate finish inside the Steam client, so the
            // grid is re-read once instead of trusting the instant hand-off.
            if (mode !== "launch") scheduleSteamLibraryResync();
          })
          .catch((e: unknown) => toast(String(e), "err"));
      }
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
      // The Steam hydrator also fills S.steamGames / S.steamStatus for this
      // card, so one light pass keeps the Settings list and the grid in step
      // (a full integrations pass would re-scan EA/Ubisoft/Xbox as well).
      S.steamStatus = null;
      void loadSteamLibrary().then(() => render());
      return true;

    case "steam-scan":
      void refreshSteamStatus().then(() => render());
      return true;

    case "steam-login-start":
      promptSteamLogin();
      return true;

    case "steam-login-qr":
      void beginSteamQrLogin();
      return true;

    case "steam-qr-copy":
      if (S.steamQrUrl) {
        void navigator.clipboard
          .writeText(S.steamQrUrl)
          .then(() => toast(i18nT("steam.qrCopy"), "ok"))
          .catch(() => toast(S.steamQrUrl, ""));
      }
      return true;

    case "steam-login-submit":
      void submitSteamCredentials();
      return true;

    case "steam-login-code":
      void submitSteamGuardCode();
      return true;

    case "steam-login-code-mode":
      promptSteamCodeMode();
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

    case "steam-account-add":
      promptSteamLogin();
      return true;

    case "steam-account-switch":
      if (id) void switchSteamAccount(id);
      return true;

    case "steam-account-remove":
      if (id) void removeSavedSteamAccount(id);
      return true;

    default:
      return false;
  }
}

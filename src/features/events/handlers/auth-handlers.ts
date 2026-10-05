/**
 * Click delegation handlers for Epic and GOG authentication and account actions.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "../../../core/toast";
import { EPIC_LOGIN_URL, epicSelectFolderDialog } from "../../../epic";
import {
  epicDoImport,
  epicDoLogin,
  epicDoLogout,
  extractAuthCode,
  refreshEpic,
  syncEpicLibrary,
} from "../../auth/auth-actions";
import {
  cancelAddAccount,
  promptAddAccount,
  removeSavedAccount,
  switchAccount,
} from "../../auth/account-switcher";
import {
  extractGogAuthCode,
  gogLoginWithCode,
  gogLogoutAction,
  openGogLoginPage,
  syncGogLibrary,
} from "../../auth/gog-auth-actions";
import {
  cancelAddGogAccount,
  promptAddGogAccount,
  removeSavedGogAccount,
  switchGogAccount,
} from "../../auth/gog-account-switcher";
import {
  amazonLogoutAction,
  beginAmazonLogin,
  finishAmazonLogin,
  importAmazonGame,
  installAmazonGame,
  playAmazonGame,
  reopenAmazonLogin,
  stopAmazonGame,
  syncAmazonLibrary,
  uninstallAmazonGame,
} from "../../auth/amazon-auth-actions";
import { t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import { gogDetectGalaxyGames, gogSyncGalaxyInstalled } from "../../../gog";
import { render } from "../../../core/render";
import { loadSteamLibrary } from "../../library/steam-library";

export function handleAuthAction(act: string | undefined, _t: HTMLElement, id?: string): boolean {
  if (!act) return false;

  switch (act) {
    case "epic-open-login":
      openUrl(EPIC_LOGIN_URL).catch((e: unknown) => toast(String(e), "err"));
      return true;

    case "epic-do-login": {
      const input = document.getElementById("epic-code") as HTMLInputElement | null;
      void epicDoLogin(input?.value ?? "");
      return true;
    }

    case "epic-import":
      void epicDoImport();
      return true;

    case "auth-paste":
      void (async () => {
        try {
          const text = await navigator.clipboard.readText();
          const code = extractAuthCode(text);
          const input = document.getElementById("epic-code") as HTMLInputElement | null;
          if (input && code) {
            input.value = code;
            input.focus();
            toast(i18nT("auth.codePasted"), "ok");
          } else {
            toast(i18nT("auth.pasteFailed"), "err");
          }
        } catch {
          toast(i18nT("auth.pasteFailed"), "err");
        }
      })();
      return true;

    case "auth-cancel":
      cancelAddAccount();
      return true;

    case "epic-logout":
      void epicDoLogout();
      return true;

    case "epic-refresh":
      // One refresh entry point keeps every store library in step.
      void syncEpicLibrary(true);
      if (S.gogAccount) void syncGogLibrary(true);
      // Steam reads its own manifests and the owned list, so it refreshes too.
      void loadSteamLibrary();
      return true;

    case "epic-retry":
      void refreshEpic();
      return true;

    case "gog-open-login":
      void openGogLoginPage();
      return true;

    case "gog-do-login": {
      const input = document.getElementById("gog-code") as HTMLInputElement | null;
      void gogLoginWithCode(input?.value ?? "");
      return true;
    }

    case "gog-paste":
      void (async () => {
        try {
          const text = await navigator.clipboard.readText();
          const code = extractGogAuthCode(text);
          const input = document.getElementById("gog-code") as HTMLInputElement | null;
          if (input && code) {
            input.value = code;
            input.focus();
            toast(i18nT("auth.codePasted"), "ok");
          } else {
            toast(i18nT("auth.pasteFailed"), "err");
          }
        } catch {
          toast(i18nT("auth.pasteFailed"), "err");
        }
      })();
      return true;

    case "gog-logout":
      void gogLogoutAction();
      return true;

    case "amazon-open-login":
      void beginAmazonLogin();
      return true;

    case "amazon-reopen-login":
      reopenAmazonLogin();
      return true;

    case "amazon-do-login": {
      const input = document.getElementById("amazon-code") as HTMLInputElement | null;
      void finishAmazonLogin(input?.value ?? "");
      return true;
    }

    case "amazon-paste":
      void (async () => {
        try {
          const text = await navigator.clipboard.readText();
          const input = document.getElementById("amazon-code") as HTMLInputElement | null;
          if (input && text.trim()) {
            input.value = text.trim();
            input.focus();
            toast(i18nT("auth.codePasted"), "ok");
          } else {
            toast(i18nT("auth.pasteFailed"), "err");
          }
        } catch {
          toast(i18nT("auth.pasteFailed"), "err");
        }
      })();
      return true;

    case "amazon-sync":
      void syncAmazonLibrary();
      return true;

    case "amazon-logout":
      void amazonLogoutAction();
      return true;

    case "amazon-install":
      if (id) void installAmazonGame(id);
      return true;

    case "amazon-import":
      if (id) {
        void (async () => {
          const chosen = await epicSelectFolderDialog(null, i18nT("amazon.importTitle")).catch(() => null);
          if (!chosen) return;
          await importAmazonGame(id, chosen);
        })();
      }
      return true;

    case "amazon-play":
      if (id) void playAmazonGame(id);
      return true;

    case "amazon-stop":
      if (id) void stopAmazonGame(id);
      return true;

    case "amazon-uninstall":
      if (id) void uninstallAmazonGame(id);
      return true;

    case "gog-account-switch":
      if (id) void switchGogAccount(id);
      return true;

    case "gog-account-remove":
      if (id) void removeSavedGogAccount(id);
      return true;

    case "gog-account-add":
      promptAddGogAccount();
      return true;

    case "gog-galaxy-scan":
      void (async () => {
        S.gogGalaxyDetected = await gogDetectGalaxyGames().catch(() => []);
        render();
      })();
      return true;

    case "gog-galaxy-import":
      void (async () => {
        S.gogGalaxySyncing = true;
        render();
        try {
          const count = await gogSyncGalaxyInstalled();
          toast(
            count > 0 ? i18nT("settings.gogGalaxyImported", { count }) : i18nT("settings.gogGalaxyNone"),
            count > 0 ? "ok" : "",
          );
          S.gogGalaxyDetected = await gogDetectGalaxyGames().catch(() => []);
          // Re-hydrate the GOG library so the imported games show as installed.
          await syncGogLibrary();
        } catch (e) {
          toast(String(e), "err");
        } finally {
          S.gogGalaxySyncing = false;
          render();
        }
      })();
      return true;

    case "gog-auth-cancel":
      cancelAddGogAccount();
      return true;

    case "account-switch":
      if (id) void switchAccount(id);
      return true;

    case "account-remove":
      if (id) void removeSavedAccount(id);
      return true;

    case "account-add":
      promptAddAccount();
      return true;

    default:
      return false;
  }
}

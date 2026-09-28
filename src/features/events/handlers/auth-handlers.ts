/**
 * Click delegation handlers for Epic and GOG authentication, account switching,
 * and sidebar account popover interactions.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "../../../core/toast";
import { EPIC_LOGIN_URL } from "../../../epic";
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
  loadSavedAccounts,
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
  loadSavedGogAccounts,
  promptAddGogAccount,
  removeSavedGogAccount,
  switchGogAccount,
} from "../../auth/gog-account-switcher";
import { t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import { pushNavHistory, updateSidebarAccountSwitcher } from "../../../core/nav";
import { closeAllModals, render } from "../../../core/render";
import { setView } from "../../store/store-view";

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
      // One refresh entry point keeps both store libraries in step.
      void syncEpicLibrary(true);
      if (S.gogAccount) void syncGogLibrary();
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

    case "gog-account-switch":
      if (id) void switchGogAccount(id);
      return true;

    case "gog-account-remove":
      if (id) void removeSavedGogAccount(id);
      return true;

    case "gog-account-add":
      promptAddGogAccount();
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

    case "toggle-account-switcher":
      S.isAccountSwitcherOpen = !S.isAccountSwitcherOpen;
      if (S.isAccountSwitcherOpen) {
        void loadSavedAccounts().then(() => updateSidebarAccountSwitcher());
        void loadSavedGogAccounts().then(() => updateSidebarAccountSwitcher());
      }
      updateSidebarAccountSwitcher();
      return true;

    case "sb-switch-epic":
      if (id) {
        S.isAccountSwitcherOpen = false;
        updateSidebarAccountSwitcher();
        void switchAccount(id);
      }
      return true;

    case "sb-switch-gog":
      if (id) {
        S.isAccountSwitcherOpen = false;
        updateSidebarAccountSwitcher();
        void switchGogAccount(id);
      }
      return true;

    case "sb-add-epic":
      S.isAccountSwitcherOpen = false;
      updateSidebarAccountSwitcher();
      closeAllModals();
      promptAddAccount();
      return true;

    case "sb-add-gog":
      S.isAccountSwitcherOpen = false;
      updateSidebarAccountSwitcher();
      closeAllModals();
      setView("accounts");
      pushNavHistory({ view: "accounts" });
      promptAddGogAccount();
      return true;

    case "open-accounts-settings":
      S.isAccountSwitcherOpen = false;
      updateSidebarAccountSwitcher();
      closeAllModals();
      setView("accounts");
      pushNavHistory({ view: "accounts" });
      render();
      return true;

    default:
      return false;
  }
}

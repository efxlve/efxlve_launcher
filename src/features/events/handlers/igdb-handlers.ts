/**
 * IGDB settings actions: save, test and remove the Twitch credentials.
 *
 * The shared proxy is the default transport, so the row works with nothing
 * filled in. Own credentials stay possible: the Client ID comes back from Rust
 * for display, the secret is write-only — sealed on disk and never loaded into
 * the DOM again.
 */

import { icon } from "../../../core/icons";
import { render } from "../../../core/render";
import { S } from "../../../core/state";
import { toast } from "../../../core/toast";
import { t, localizeMessage } from "../../../i18n";
import { refreshIgdbProxyProbe } from "../../settings/settings-view";
import {
  igdbClearCredentials,
  igdbSetCredentials,
  igdbSetProxyUrl,
  igdbStatus,
  igdbTest,
} from "../../../igdb";

function fields(): { proxy: string; id: string; secret: string } {
  const proxyInput = document.getElementById("settings-igdb-proxy") as HTMLInputElement | null;
  const idInput = document.getElementById("settings-igdb-id") as HTMLInputElement | null;
  const secretInput = document.getElementById("settings-igdb-secret") as HTMLInputElement | null;
  return {
    proxy: proxyInput?.value.trim() ?? "",
    id: idInput?.value.trim() || "",
    secret: secretInput?.value.trim() || "",
  };
}

/** Rust sends `@t:<key>` descriptors; a toast should show the sentence. */
function messageOf(error: unknown): string {
  const raw = String(error);
  return raw.startsWith("@t:") ? localizeMessage(raw) : raw;
}

/** Saves the row: the server address and, when filled, own credentials (which
 * take priority). Resolves true when IGDB is usable afterwards. */
async function saveFromRow(): Promise<boolean> {
  const { proxy, id, secret } = fields();
  try {
    if (proxy !== S.igdbProxyUrl) {
      await igdbSetProxyUrl(proxy);
      S.igdbProxyUrl = proxy;
      toast(t("igdb.proxySaved"), "ok");
    }
    if (id && secret) {
      await igdbSetCredentials(id, secret);
      S.igdbConfigured = true;
      S.igdbClientId = id;
      S.igdbMode = "direct";
      toast(t("igdb.saved"), "ok");
      render();
      refreshIgdbProxyProbe();
      return true;
    }
    if (id || secret) {
      toast(t("igdb.missingFields"), "err");
      return false;
    }
    // Only the address changed: ask Rust which transport is active now.
    const status = await igdbStatus();
    S.igdbConfigured = status.configured;
    S.igdbMode = status.mode;
    S.igdbProxyUrl = status.proxyUrl;
    render();
    refreshIgdbProxyProbe();
    return status.configured;
  } catch (error) {
    toast(messageOf(error), "err");
    return false;
  }
}

export function handleIgdbAction(act: string | undefined, el: HTMLElement): boolean {
  switch (act) {
    case "save-igdb-credentials":
      void saveFromRow();
      return true;

    case "test-igdb": {
      const { id, secret } = fields();
      void (async () => {
        // A filled row is saved first, so Test proves what was typed.
        if ((id || secret) && !(await saveFromRow())) return;
        if (!S.igdbConfigured) {
          toast(t("igdb.notConfigured"), "err");
          return;
        }
        toast(t("igdb.testing"), "");
        try {
          const result = await igdbTest();
          toast(
            t(result.mode === "proxy" ? "igdb.testOkProxy" : "igdb.testOk", { name: result.name }),
            "ok",
          );
        } catch (error) {
          toast(t("igdb.testFailed", { error: messageOf(error) }), "err");
        }
      })();
      return true;
    }

    case "toggle-igdb-secret-visibility": {
      const input = document.getElementById("settings-igdb-secret") as HTMLInputElement | null;
      if (input) {
        S.showSettingsIgdbSecret = !S.showSettingsIgdbSecret;
        input.type = S.showSettingsIgdbSecret ? "text" : "password";
        el.innerHTML = icon(S.showSettingsIgdbSecret ? "eye-off" : "eye", 15);
      }
      return true;
    }

    case "clear-igdb-credentials":
      void igdbClearCredentials()
        .then(async () => {
          // Dropping own credentials falls back to the shared server.
          S.igdbClientId = "";
          const status = await igdbStatus().catch(() => null);
          if (status) {
            S.igdbConfigured = status.configured;
            S.igdbMode = status.mode;
            S.igdbProxyUrl = status.proxyUrl;
          } else {
            S.igdbConfigured = true;
            S.igdbMode = "proxy";
          }
          toast(t("igdb.cleared"), "ok");
          render();
        })
        .catch((error) => toast(String(error), "err"));
      return true;

    default:
      return false;
  }
}

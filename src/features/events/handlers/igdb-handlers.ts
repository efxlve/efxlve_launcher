/**
 * IGDB settings actions: save, test and remove the Twitch credentials.
 *
 * The Client ID comes back from Rust for display; the secret is write-only —
 * it is sealed on disk and never loaded into the DOM again.
 */

import { icon } from "../../../core/icons";
import { render } from "../../../core/render";
import { S } from "../../../core/state";
import { toast } from "../../../core/toast";
import { t } from "../../../i18n";
import { igdbClearCredentials, igdbSetCredentials, igdbTest } from "../../../igdb";

function fields(): { id: string; secret: string } {
  const idInput = document.getElementById("settings-igdb-id") as HTMLInputElement | null;
  const secretInput = document.getElementById("settings-igdb-secret") as HTMLInputElement | null;
  return {
    id: idInput?.value.trim() || "",
    secret: secretInput?.value.trim() || "",
  };
}

/** Saves what the row holds; resolves true when the pair is stored. */
async function saveFromRow(): Promise<boolean> {
  const { id, secret } = fields();
  if (!id || !secret) {
    toast(t("igdb.missingFields"), "err");
    return false;
  }
  try {
    await igdbSetCredentials(id, secret);
    S.igdbConfigured = true;
    S.igdbClientId = id;
    toast(t("igdb.saved"), "ok");
    render();
    return true;
  } catch (error) {
    toast(String(error), "err");
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
        // A filled row is saved first, so Test proves the pair that was typed.
        if (id && secret && !(await saveFromRow())) return;
        if (!S.igdbConfigured) {
          toast(t("igdb.missingFields"), "err");
          return;
        }
        toast(t("igdb.testing"), "");
        try {
          const name = await igdbTest();
          toast(t("igdb.testOk", { name }), "ok");
        } catch (error) {
          toast(t("igdb.testFailed", { error: String(error) }), "err");
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
        .then(() => {
          S.igdbConfigured = false;
          S.igdbClientId = "";
          toast(t("igdb.cleared"), "ok");
          render();
        })
        .catch((error) => toast(String(error), "err"));
      return true;

    default:
      return false;
  }
}

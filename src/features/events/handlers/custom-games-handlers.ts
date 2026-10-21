/**
 * Click handlers for custom games (Add, Remove, Browse Exe).
 */

import {
  openAddCustomGameModal,
  closeAddCustomGameModal,
  handlePickCustomExe,
  handleSaveCustomGame,
} from "../../custom-games/add-game-dialog";
import { customGamesRemove } from "../../../custom-games";
import { loadCustomGamesLibrary } from "../../custom-games/custom-games-library";
import { toast } from "../../../core/toast";
import { t } from "../../../i18n";
import { render } from "../../../core/render";
import { summaryOf } from "../../../core/selectors";

export function handleCustomGamesAction(act: string | undefined, id?: string): boolean {
  if (!act) return false;

  switch (act) {
    case "open-add-custom-game-modal":
      openAddCustomGameModal();
      return true;

    case "close-custom-game-modal":
      closeAddCustomGameModal();
      return true;

    case "pick-custom-exe":
      void handlePickCustomExe();
      return true;

    case "save-custom-game":
      void handleSaveCustomGame();
      return true;

    case "custom-game-remove":
      if (id) {
        const customId = id.startsWith("custom::") ? id.slice(8) : id;
        const s = summaryOf(id);
        const title = s?.title || id;
        void (async () => {
          try {
            await customGamesRemove(customId);
            await loadCustomGamesLibrary();
            toast(t("customGames.deletedSuccess", { title }), "ok");
            render();
          } catch (e) {
            toast(String(e), "err");
          }
        })();
      }
      return true;

    default:
      return false;
  }
}

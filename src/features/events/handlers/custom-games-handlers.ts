/**
 * Click handlers for custom games (Add, Remove, Browse Exe).
 */

import {
  openAddCustomGameModal,
  openEditCustomGameModal,
  closeAddCustomGameModal,
  handlePickCustomCover,
  handlePickCustomExe,
  handlePickExeForGame,
  handleSaveCustomGame,
} from "../../custom-games/add-game-dialog";
import { customGamesImportFolder, customGamesPickFolder, customGamesRemove } from "../../../custom-games";
import { loadCustomGamesLibrary } from "../../custom-games/custom-games-library";
import { toast } from "../../../core/toast";
import { t } from "../../../i18n";
import { render } from "../../../core/render";
import { summaryOf } from "../../../core/selectors";
import { askConfirm } from "../../../core/confirm-dialog";

export function handleCustomGamesAction(act: string | undefined, id?: string): boolean {
  if (!act) return false;

  switch (act) {
    case "open-add-custom-game-modal":
      openAddCustomGameModal();
      return true;

    case "edit-custom-game":
      if (id) openEditCustomGameModal(id);
      return true;

    case "import-custom-games-folder":
      void (async () => {
        const folder = await customGamesPickFolder(undefined, t("customGames.importFolderTitle"));
        if (!folder) return;
        try {
          const imported = await customGamesImportFolder(folder);
          await loadCustomGamesLibrary();
          toast(
            imported.length
              ? t("customGames.importedCount", { count: imported.length })
              : t("customGames.importEmpty"),
            imported.length ? "ok" : "",
          );
          render();
        } catch (e) {
          toast(String(e), "err");
        }
      })();
      return true;

    case "close-custom-game-modal":
      closeAddCustomGameModal();
      return true;

    case "pick-custom-exe":
      void handlePickCustomExe();
      return true;

    case "pick-custom-cover":
      handlePickCustomCover();
      return true;

    case "save-custom-game":
      void handleSaveCustomGame();
      return true;

    case "pick-custom-exe-for":
      if (id) {
        void handlePickExeForGame(id);
      }
      return true;

    case "custom-game-remove":
      if (id) {
        const s = summaryOf(id);
        const title = s?.title || id;
        void (async () => {
          const confirmed = await askConfirm({
            title: t("customGames.delete"),
            name: title,
            body: t("customGames.deleteConfirm"),
            confirm: t("common.delete"),
            cancel: t("common.cancel"),
          });
          if (!confirmed) return;
          try {
            await customGamesRemove(id);
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

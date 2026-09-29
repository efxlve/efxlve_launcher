/**
 * External store detection for the game page version selector.
 *
 * EA App / Ubisoft Connect / XBOX games are only known after a registry scan
 * (XBOX needs one PowerShell call), so the scan runs lazily the first time a
 * game page asks for it — never at boot, and only once per session.
 */

import { openEpicModal } from "../../core/render";
import { canonicalGameTitle, summaryOf, type GameVersionSource } from "../../core/selectors";
import { S } from "../../core/state";
import { externalDetectGames, type ExternalGame, type ExternalStore } from "../../external-stores";
import { t } from "../../i18n";

const STORES: ExternalStore[] = ["ea", "ubisoft", "xbox"];

let scanPromise: Promise<void> | null = null;

/** True when the scan (or a settings visit) already produced data. */
export function externalVersionsReady(): boolean {
  return S.externalGamesScanned;
}

/** True when any detected external game matches this title. */
export function hasExternalVersion(title: string): boolean {
  const canon = canonicalGameTitle(title);
  if (!canon) return false;
  return STORES.some((store) =>
    (S.externalGames[store] ?? []).some((game) => canonicalGameTitle(game.title) === canon),
  );
}

/** Brand label for one store version in the game page selector. */
export function storeVersionLabel(source: GameVersionSource): string {
  switch (source) {
    case "epic":
      return "Epic Games";
    case "gog":
      return "GOG";
    case "steam":
      return "Steam";
    case "ea":
      return t("external.eaTitle");
    case "ubisoft":
      return t("external.ubisoftTitle");
    case "xbox":
      return t("external.xboxTitle");
  }
}

/** Runs the one-time scan; the open game page repaints when new matches exist. */
export function ensureExternalVersionsLoaded(): void {
  if (S.externalGamesScanned || scanPromise) return;
  scanPromise = (async () => {
    try {
      const [ea, ubisoft, xbox] = await Promise.all(
        STORES.map((store) => externalDetectGames(store).catch(() => [] as ExternalGame[])),
      );
      S.externalGames = { ea, ubisoft, xbox };
      S.externalGamesScanned = true;
      const current = S.currentModalAppName;
      if (current && hasExternalVersion(summaryOf(current)?.title ?? current)) {
        openEpicModal(current, false);
      }
    } catch {
      // Keep whatever the settings view already loaded and do not retry all session.
      S.externalGamesScanned = true;
    }
  })();
}

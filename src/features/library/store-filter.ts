/**
 * Library storefront filter and the saved copy of a game owned on more than one store.
 *
 * The filter is a set (Epic + Steam, without GOG). The preferred copy is remembered
 * per title so cover playtime and trophies keep coming from the store the player chose.
 */

import { SOURCE_FILTER_KEY, PREFERRED_VERSION_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { storeLogo } from "../store/store-logos";
import { canonicalGameTitle, summaryOf, totalLibraryGamesCount } from "../../core/selectors";
import { S } from "../../core/state";
import type { GameSource } from "../../core/types";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";

const STORE_ORDER: readonly GameSource[] = ["epic", "gog", "steam", "xbox", "battlenet", "ubisoft", "ea", "riot"];
const COMPANION_ORDER: readonly GameSource[] = ["xbox", "battlenet", "ubisoft", "ea", "riot"];

/** Stable signature fragment for the visible-library cache. */
export function enabledStoreKey(): string {
  return STORE_ORDER.filter((id) => S.enabledStores.has(id)).join(",");
}

/** Brand names are not translated: they read the same in every locale. */
function storeName(id: GameSource, short: boolean): string {
  switch (id) {
    case "epic": return short ? "Epic" : t("source.epic");
    case "gog": return t("source.gog");
    case "steam": return t("source.steam");
    case "ea": return "EA App";
    case "ubisoft": return "Ubisoft Connect";
    case "xbox": return "Xbox";
    case "battlenet": return "Battle.net";
    case "riot": return "Riot Games";
  }
}

/** Button label: "All Stores", one store's name, or "Epic, Steam". */
export function storeFilterLabel(): string {
  if (STORE_ORDER.every((id) => S.enabledStores.has(id))) return t("source.all");
  const short = S.enabledStores.size > 1;
  return STORE_ORDER.filter((id) => S.enabledStores.has(id)).map((id) => storeName(id, short)).join(", ");
}

/**
 * Toggle one store, or turn every store on. The last remaining store stays on.
 * Returns false when nothing changed.
 */
export function applyStoreFilter(value: string): boolean {
  if (value === "all") {
    if (STORE_ORDER.every((id) => S.enabledStores.has(id))) return false;
    S.enabledStores = new Set(STORE_ORDER);
  } else if ((STORE_ORDER as readonly string[]).includes(value)) {
    const id = value as GameSource;
    if (S.enabledStores.has(id)) {
      if (S.enabledStores.size === 1) return false;
      S.enabledStores.delete(id);
    } else {
      S.enabledStores.add(id);
    }
  } else {
    return false;
  }
  localStorage.setItem(SOURCE_FILTER_KEY, JSON.stringify(enabledStoreKey().split(",").filter(Boolean)));
  S.libraryDataRev++;
  return true;
}

/** Remember which store copy should represent this title in the library. */
export function rememberPreferredVersion(appName: string): void {
  const summary = summaryOf(appName);
  if (!summary) return;
  const canon = canonicalGameTitle(summary.title);
  if (!canon || S.preferredVersions[canon] === appName) return;
  S.preferredVersions[canon] = appName;
  localStorage.setItem(PREFERRED_VERSION_KEY, JSON.stringify(S.preferredVersions));
  S.libraryDataRev++;
}

/**
 * One card per title. A saved choice wins. Otherwise an installed GOG copy
 * replaces an uninstalled Epic copy; Steam does not replace an Epic row.
 */
export function pickShownCopy(list: EpicSummary[]): EpicSummary {
  const canon = canonicalGameTitle(list[0].title);
  const saved = canon ? S.preferredVersions[canon] : undefined;
  if (saved) {
    const hit = list.find((item) => item.appName === saved);
    if (hit) return hit;
  }
  let chosen = list[0];
  for (let i = 1; i < list.length; i++) {
    const item = list[i];
    if (!chosen.installed && item.installed && !item.appName.startsWith("steam::")) chosen = item;
  }
  return chosen;
}

/** Row counts for the store menu: one per source plus the deduped total. */
export type StoreFilterCounts = Record<GameSource, number> & { all: number };

/** Store menu. Stays open so several storefronts can be checked. */
export function storeFilterMenuHtml(counts: StoreFilterCounts, hasSteam: boolean): string {
  const row = (value: GameSource | "all", label: string, count: number, on: boolean): string => {
    const mark = `<span class="store-option-mark">${on ? icon("check", 14) : ""}</span>`;
    const logo = value === "all" ? `<span class="store-option-logo"></span>` : `<span class="store-option-logo">${storeLogo(value, 16)}</span>`;
    return `<button type="button" class="sort-menu-item-btn store-menu-item${on ? " is-on" : ""}" role="menuitemcheckbox" aria-checked="${on}" data-act="source-filter" data-val="${value}">${mark}${logo}<span class="store-option-label">${esc(label)}</span><span class="store-option-count tabular-nums">${count}</span></button>`;
  };
  const allOn = STORE_ORDER.every((id) => S.enabledStores.has(id));
  // Every storefront gets a row, even with zero games, so the filter never
  // hides a store the user owns nothing in yet.
  const companionRows = COMPANION_ORDER
    .map((id) => row(id, storeName(id, false), counts[id], S.enabledStores.has(id)))
    .join("");
  return `
    <div class="store-dropdown-container">
      <button class="btn ghost lib-sort-btn lib-store-btn" data-act="toggle-store-dropdown" title="${esc(t("filter.source"))}">
        <span class="lib-sort-kicker">${esc(t("lib.storeBy"))}</span>
        <span class="sort-btn-label">${esc(storeFilterLabel())}</span>
        ${icon(S.isStoreDropdownOpen ? "chevron-up" : "chevron-down", 14)}
      </button>
      <div id="store-dropdown-menu" class="sort-dropdown-menu store-dropdown-menu ${S.isStoreDropdownOpen ? "show" : ""}">
        ${row("all", t("source.all"), counts.all, allOn)}
        <div class="store-menu-sep"></div>
        ${row("epic", t("source.epic"), counts.epic, S.enabledStores.has("epic"))}
        ${row("gog", t("source.gog"), counts.gog, S.enabledStores.has("gog"))}
        ${hasSteam ? row("steam", t("source.steam"), counts.steam, S.enabledStores.has("steam")) : ""}
        ${companionRows}
      </div>
    </div>`;
}

/** Whether that menu row should show a check. `all` is on only when every store is. */
export function storeFilterRowOn(value: string): boolean {
  if (value === "all") return STORE_ORDER.every((id) => S.enabledStores.has(id));
  return (STORE_ORDER as readonly string[]).includes(value) && S.enabledStores.has(value as GameSource);
}

/** Deduped size used by the All Stores row. */
export function allStoresMenuCount(): number {
  return totalLibraryGamesCount();
}

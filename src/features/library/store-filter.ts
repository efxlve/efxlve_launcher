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
import type { StoreId } from "../../core/types";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";

const STORE_ORDER: readonly StoreId[] = ["epic", "gog", "steam"];

/** Stable signature fragment for the visible-library cache. */
export function enabledStoreKey(): string {
  return STORE_ORDER.filter((id) => S.enabledStores.has(id)).join(",");
}

function storeName(id: StoreId, short: boolean): string {
  if (id === "epic") return short ? "Epic" : t("source.epic");
  if (id === "gog") return t("source.gog");
  return t("source.steam");
}

/** Button label: "All Stores", one store's name, or "Epic, Steam". */
export function storeFilterLabel(): string {
  if (S.enabledStores.size >= STORE_ORDER.length) return t("source.all");
  const short = S.enabledStores.size > 1;
  return STORE_ORDER.filter((id) => S.enabledStores.has(id)).map((id) => storeName(id, short)).join(", ");
}

/**
 * Toggle one store, or turn every store on. The last remaining store stays on.
 * Returns false when nothing changed.
 */
export function applyStoreFilter(value: string): boolean {
  if (value === "all") {
    if (S.enabledStores.size >= STORE_ORDER.length) return false;
    S.enabledStores = new Set(STORE_ORDER);
  } else if (value === "epic" || value === "gog" || value === "steam") {
    if (S.enabledStores.has(value)) {
      if (S.enabledStores.size === 1) return false;
      S.enabledStores.delete(value);
    } else {
      S.enabledStores.add(value);
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

/** Store menu. Stays open so several storefronts can be checked. */
export function storeFilterMenuHtml(counts: { all: number; epic: number; gog: number; steam: number }, hasSteam: boolean): string {
  const row = (value: StoreId | "all", label: string, count: number, on: boolean): string => {
    const mark = `<span class="store-option-mark">${on ? icon("check", 14) : ""}</span>`;
    const logo = value === "all" ? `<span class="store-option-logo"></span>` : `<span class="store-option-logo">${storeLogo(value, 16)}</span>`;
    return `<button type="button" class="sort-menu-item-btn store-menu-item${on ? " is-on" : ""}" role="menuitemcheckbox" aria-checked="${on}" data-act="source-filter" data-val="${value}">${mark}${logo}<span class="store-option-label">${esc(label)}</span><span class="store-option-count tabular-nums">${count}</span></button>`;
  };
  const allOn = S.enabledStores.size >= STORE_ORDER.length;
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
      </div>
    </div>`;
}

/** Deduped size used by the All Stores row. */
export function allStoresMenuCount(): number {
  return totalLibraryGamesCount();
}

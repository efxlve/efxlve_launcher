/**
 * Library storefront filter and the saved copy of a game owned on more than one store.
 *
 * The menu only offers stores that are connected, detected on this PC, or have
 * games in the library; `enabledStores` remembers which of them are checked.
 * The preferred copy is remembered per title so cover playtime and trophies
 * keep coming from the store the player chose.
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

const STORE_ORDER: readonly GameSource[] = ["epic", "gog", "amazon", "steam", "xbox", "battlenet", "ubisoft", "ea", "riot"];

/** Stable signature fragment for the visible-library cache. */
export function enabledStoreKey(): string {
  return STORE_ORDER.filter((id) => S.enabledStores.has(id)).join(",");
}

/**
 * Whether the filter menu should offer this store: a signed-in session, a
 * detected client, or games already present in the library. Stores the user
 * has never touched stay out of the menu.
 */
function storeIsAvailable(id: GameSource): boolean {
  switch (id) {
    case "epic":
      return Boolean(S.epicAccount) || S.epicSummaries.length > 0;
    case "gog":
      return Boolean(S.gogAccount) || S.gogSummaries.length > 0;
    case "amazon":
      return Boolean(S.amazonStatus?.logged_in) || S.amazonSummaries.length > 0;
    case "steam":
      return (
        S.steamSummaries.length > 0 ||
        S.steamAuthStep === "signed_in" ||
        S.steamAuth?.state === "signed_in" ||
        Boolean(S.steamStatus?.installed)
      );
    default:
      return (
        S.companionSummaries.some((g) => g.source === id) ||
        S.companionStatus.some((s) => s.store === id && (s.linked || s.clientInstalled || s.gameCount > 0))
      );
  }
}

/** Stores the library filter offers, in menu order. */
export function availableStores(): GameSource[] {
  return STORE_ORDER.filter((id) => storeIsAvailable(id));
}

/** Brand names are not translated: they read the same in every locale. */
function storeName(id: GameSource, short: boolean): string {
  switch (id) {
    case "epic": return short ? "Epic" : t("source.epic");
    case "gog": return t("source.gog");
    case "amazon": return "Amazon Games";
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
  const available = availableStores();
  const on = available.filter((id) => S.enabledStores.has(id));
  if (available.length === 0 || on.length === available.length) return t("source.all");
  if (on.length === 0) return t("source.all");
  const short = on.length > 1;
  return on.map((id) => storeName(id, short)).join(", ");
}

/**
 * Toggle one store, or turn every store on. The last remaining available store
 * stays on. Returns false when nothing changed.
 */
export function applyStoreFilter(value: string): boolean {
  const pool = availableStores();
  const selectable = pool.length > 0 ? pool : STORE_ORDER;
  if (value === "all") {
    // "All Stores" switches every store on, including ones the menu does not
    // list yet, so a store connected later starts visible.
    if (STORE_ORDER.every((id) => S.enabledStores.has(id))) return false;
    S.enabledStores = new Set(STORE_ORDER);
  } else if ((STORE_ORDER as readonly string[]).includes(value) && selectable.includes(value as GameSource)) {
    const id = value as GameSource;
    if (S.enabledStores.has(id)) {
      if (selectable.filter((item) => S.enabledStores.has(item)).length <= 1) return false;
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
export function storeFilterMenuHtml(counts: StoreFilterCounts): string {
  const row = (value: GameSource | "all", label: string, count: number, on: boolean): string => {
    const mark = `<span class="store-option-mark">${on ? icon("check", 14) : ""}</span>`;
    const logo = value === "all" ? `<span class="store-option-logo"></span>` : `<span class="store-option-logo">${storeLogo(value, 16)}</span>`;
    return `<button type="button" class="sort-menu-item-btn store-menu-item${on ? " is-on" : ""}" role="menuitemcheckbox" aria-checked="${on}" data-act="source-filter" data-val="${value}">${mark}${logo}<span class="store-option-label">${esc(label)}</span><span class="store-option-count tabular-nums">${count}</span></button>`;
  };
  const available = availableStores();
  const allOn = available.length === 0 || available.every((id) => S.enabledStores.has(id));
  // Only connected, detected or already-populated stores get a row; a store the
  // user has never touched would be a dead filter entry.
  const storeRows = available
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
        ${storeRows}
      </div>
    </div>`;
}

/** Whether that menu row should show a check. `all` is on only when every available store is. */
export function storeFilterRowOn(value: string): boolean {
  const available = availableStores();
  if (value === "all") return available.length === 0 || available.every((id) => S.enabledStores.has(id));
  return (STORE_ORDER as readonly string[]).includes(value) && S.enabledStores.has(value as GameSource);
}

/** Deduped size used by the All Stores row. */
export function allStoresMenuCount(): number {
  return totalLibraryGamesCount();
}

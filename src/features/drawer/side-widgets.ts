/**
 * Which sidebar cards the reader folded away, per game.
 *
 * The cards are facts about one title, so the choice is remembered per title: a
 * player who folds the requirements on one game still wants them on the next.
 */

import { icon, type IconName } from "../../core/icons";
import { esc } from "../../core/utils";

const KEY = "efxlve-gp-side-widgets";
const ORDER_KEY = "efxlve-gp-card-order";

/** The five cards on the game page sidebar, in their default order. */
export const DRAWER_CARDS = ["achievements", "lengths", "scores", "moments", "links"] as const;
export type DrawerCardId = (typeof DRAWER_CARDS)[number];

function isCardId(value: unknown): value is DrawerCardId {
  return typeof value === "string" && (DRAWER_CARDS as readonly string[]).includes(value);
}

/** The saved global order, with unknown ids dropped and new cards appended. */
export function drawerCardOrder(): DrawerCardId[] {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
  } catch {
    saved = null;
  }
  const valid = Array.isArray(saved) ? saved.filter(isCardId) : [];
  const unique = [...new Set(valid)];
  return [...unique, ...DRAWER_CARDS.filter((id) => !unique.includes(id))];
}

/** Moves one card up (-1) or down (+1) in the global order. */
export function moveDrawerCard(id: DrawerCardId, direction: -1 | 1): void {
  const order = drawerCardOrder();
  const index = order.indexOf(id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= order.length) return;
  [order[index], order[next]] = [order[next], order[index]];
  localStorage.setItem(ORDER_KEY, JSON.stringify(order));
}

export function resetDrawerCardOrder(): void {
  localStorage.removeItem(ORDER_KEY);
}

/** Orders the rendered sidebar cards; empty cards are filtered by the caller. */
export function sortDrawerCards<T extends { id: DrawerCardId }>(cards: T[]): T[] {
  const order = drawerCardOrder();
  return [...cards].sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
}

type Folded = Record<string, Record<string, boolean>>;

function readAll(): Folded {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Folded;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** True when this card is folded away on this game's page. */
export function isSideWidgetFolded(appName: string, id: string): boolean {
  return readAll()[appName]?.[id] === true;
}

/** Flips a card and remembers it. Returns the new state (true = folded). */
export function toggleSideWidget(appName: string, id: string): boolean {
  if (!appName || !id) return false;
  const all = readAll();
  const forGame = all[appName] ?? {};
  const folded = forGame[id] !== true;
  forGame[id] = folded;
  all[appName] = forGame;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // A full storage quota is not worth breaking the page for.
  }
  return folded;
}

export interface SideCardOptions {
  idAttr?: string;
  extraClass?: string;
  metaHtml?: string;
  actionHtml?: string;
  /** Trusted icon markup that replaces the named glyph (a platinum cup, for one). */
  glyphHtml?: string;
}

/**
 * A sidebar card whose body folds. The head stays: the title is how the reader
 * knows what they folded.
 */
export function sideCard(
  appName: string,
  id: string,
  title: string,
  glyph: IconName,
  body: string,
  opts: SideCardOptions = {},
): string {
  const folded = isSideWidgetFolded(appName, id);
  const idPart = opts.idAttr ? ` id="${esc(opts.idAttr)}"` : "";
  const clsPart = opts.extraClass ? ` ${opts.extraClass}` : "";
  const metaPart = opts.metaHtml ? ` ${opts.metaHtml}` : "";
  const glyphPart = opts.glyphHtml ?? icon(glyph, 13);
  const headInner = `
    <span class="gp-widget-glyph">${glyphPart}</span>
    <h3 class="gp-section-title"><span>${esc(title)}</span>${metaPart}</h3>`;
  const headHtml = opts.actionHtml
    ? `<div class="gp-widget-head">
        <button type="button" class="gp-fold-head" data-act="toggle-side-widget" data-id="${esc(appName)}" data-widget="${esc(id)}" aria-expanded="${String(!folded)}">
          ${headInner}
        </button>
        <div class="gp-widget-head-actions">
          ${opts.actionHtml}
          <button type="button" class="gp-fold-chevron-btn" data-act="toggle-side-widget" data-id="${esc(appName)}" data-widget="${esc(id)}" aria-label="${esc(title)}" aria-expanded="${String(!folded)}">
            <span class="gp-fold-chevron">${icon("chevron-down", 14)}</span>
          </button>
        </div>
      </div>`
    : `<div class="gp-widget-head">
        <button type="button" class="gp-fold-head" data-act="toggle-side-widget" data-id="${esc(appName)}" data-widget="${esc(id)}" aria-expanded="${String(!folded)}">
          ${headInner}
          <span class="gp-fold-chevron">${icon("chevron-down", 14)}</span>
        </button>
      </div>`;
  return `
    <section${idPart} class="card gp-side-card gp-foldable${clsPart}${folded ? " is-folded" : ""}" data-widget="${esc(id)}">
      ${headHtml}
      <div class="gp-fold-body">${body}</div>
    </section>`;
}


/**
 * Which sidebar cards the reader folded away, per game.
 *
 * The cards are facts about one title, so the choice is remembered per title: a
 * player who folds the requirements on one game still wants them on the next.
 */

import { icon, type IconName } from "../../core/icons";
import { esc } from "../../core/utils";

const KEY = "efxlve-gp-side-widgets";

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
): string {
  const folded = isSideWidgetFolded(appName, id);
  return `
    <section class="card gp-side-card gp-foldable${folded ? " is-folded" : ""}" data-widget="${esc(id)}">
      <button type="button" class="gp-fold-head" data-act="toggle-side-widget" data-id="${esc(appName)}" data-widget="${esc(id)}" aria-expanded="${String(!folded)}">
        <h3 class="gp-section-title">${icon(glyph, 13)} <span>${esc(title)}</span></h3>
        <span class="gp-fold-chevron">${icon("chevron-down", 14)}</span>
      </button>
      <div class="gp-fold-body">${body}</div>
    </section>`;
}

/**
 * Alphabet rail for title-sorted libraries.
 *
 * The rail lists A–Z plus `#`, disables letters the current result set does not
 * have, and carries the first index of each bucket. The click handler lives in
 * library-view because it has to grow the progressive chunk and scroll.
 */

import type { EpicSummary } from "../../epic";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { titleSortKey } from "./library-sort";
import type { EpicSort } from "../../core/types";

const ALPHA_LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** First letter of a title for the rail; accents fold onto their base letter. */
function alphaLetterOf(title: string): string {
  const first = titleSortKey(title)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .charAt(0)
    .toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}

/**
 * Alphabet rail markup, or `""` when the grid is not ordered by title or the
 * result set is too short to need one.
 */
export function renderAlphaRail(visible: EpicSummary[], sort: EpicSort): string {
  if ((sort !== "alpha" && sort !== "alphaDesc") || visible.length < 12) return "";
  const firstIndex = new Map<string, number>();
  visible.forEach((item, index) => {
    const letter = alphaLetterOf(item.title);
    if (!firstIndex.has(letter)) firstIndex.set(letter, index);
  });
  const letters = firstIndex.has("#") ? [...ALPHA_LETTERS, "#"] : ALPHA_LETTERS;
  const buttons = letters
    .map((letter) => {
      const index = firstIndex.get(letter);
      const title = t("lib.alphaJumpTo", { letter });
      return `<button type="button" class="lib-alpha-btn" data-act="lib-alpha-jump" data-index="${index ?? ""}" ${index === undefined ? "disabled" : ""} title="${esc(title)}" aria-label="${esc(title)}">${letter}</button>`;
    })
    .join("");
  return `<nav class="lib-alpha" aria-label="${esc(t("lib.alphaJump"))}">${buttons}</nav>`;
}

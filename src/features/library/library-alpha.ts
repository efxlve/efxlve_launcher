/**
 * Fixed alphabet quick-jump rail (`#lib-alpha`) mounted beside `#view`.
 *
 * Lives in `#content` outside `#view` so scrolling and page-enter transforms
 * never shift it, reserves its own right-hand gutter (`#content.has-lib-alpha`),
 * highlights the currently visible letter on scroll, and supports click + drag
 * scrubbing along A–Z / `#`.
 */

import { S } from "../../core/state";
import type { EpicSort } from "../../core/types";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { effectiveLibGroupBy } from "./library-groups";
import { seriesSortKeys, titleSortKey } from "./library-sort";
import { effectiveSortTitle } from "./sort-name";

const ALPHA_LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** First bucket character of a sort key; diacritics fold onto ASCII A–Z, digits/other onto `#`. */
export function alphaLetterOf(rawTitle: string): string {
  const key = titleSortKey(rawTitle)
    .replace(/[\u0130]/g, "I")
    .replace(/[\u0131]/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim();
  const first = key.charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}

let currentVisibleRef: EpicSummary[] = [];
let appLetterMap = new Map<string, string>();
let scrollRaf = 0;
let scrubbing = false;
let lastScrubIndex = -1;
let jumpCallback: ((index: number, instant?: boolean) => void) | null = null;
let eventsBound = false;

export function registerAlphaJumpHandler(fn: (index: number, instant?: boolean) => void): void {
  jumpCallback = fn;
}

export function hideLibraryAlphaRail(): void {
  const nav = document.getElementById("lib-alpha");
  const content = document.getElementById("content");
  if (nav) {
    nav.hidden = true;
    nav.innerHTML = "";
  }
  content?.classList.remove("has-lib-alpha");
}

function updateActiveLetterFromScroll(): void {
  scrollRaf = 0;
  const nav = document.getElementById("lib-alpha");
  const view = document.getElementById("view");
  if (!nav || nav.hidden || !view || currentVisibleRef.length === 0) return;

  const viewRect = view.getBoundingClientRect();
  const probeY = viewRect.top + 88;
  const cards = view.querySelectorAll<HTMLElement>("[data-lib-item]");
  let activeApp = "";
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (rect.bottom >= probeY) {
      activeApp = cards[i].dataset.libItem || "";
      break;
    }
  }
  if (!activeApp && cards.length > 0) {
    activeApp = cards[cards.length - 1].dataset.libItem || "";
  }
  const activeLetter = activeApp ? appLetterMap.get(activeApp) ?? "" : "";
  const buttons = nav.querySelectorAll<HTMLButtonElement>(".lib-alpha-btn");
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    btn.classList.toggle("is-current", Boolean(activeLetter) && btn.dataset.letter === activeLetter);
  }
}

export function initLibraryAlphaEvents(): void {
  if (eventsBound) return;
  eventsBound = true;

  const view = document.getElementById("view");
  view?.addEventListener(
    "scroll",
    () => {
      if (scrollRaf) return;
      scrollRaf = window.requestAnimationFrame(updateActiveLetterFromScroll);
    },
    { passive: true },
  );

  const nav = document.getElementById("lib-alpha");
  if (!nav) return;

  const scrubAt = (clientX: number, clientY: number) => {
    const hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLButtonElement>(".lib-alpha-btn");
    if (!hit || hit.disabled) return;
    const idx = Number(hit.dataset.index);
    if (!Number.isFinite(idx) || idx < 0 || idx === lastScrubIndex) return;
    lastScrubIndex = idx;
    jumpCallback?.(idx, true);
  };

  nav.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(".lib-alpha-btn");
    if (!btn || btn.disabled) return;
    scrubbing = true;
    lastScrubIndex = Number(btn.dataset.index);
    try {
      nav.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events without active pointer id.
    }
  });

  nav.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    scrubAt(e.clientX, e.clientY);
  });

  const stopScrub = () => {
    scrubbing = false;
    lastScrubIndex = -1;
  };
  nav.addEventListener("pointerup", stopScrub);
  nav.addEventListener("pointercancel", stopScrub);
}

/**
 * Synchronizes `#lib-alpha` inside `#content` with the current library view.
 */
export function syncLibraryAlphaRail(visible: EpicSummary[], sort: EpicSort = S.epicSort): void {
  initLibraryAlphaEvents();
  const nav = document.getElementById("lib-alpha");
  const content = document.getElementById("content");
  if (!nav || !content) return;

  const eligible =
    S.view === "library" &&
    !S.currentModalAppName &&
    effectiveLibGroupBy() === "none" &&
    (sort === "alpha" || sort === "alphaDesc" || sort === "series") &&
    visible.length >= 12;

  if (!eligible) {
    hideLibraryAlphaRail();
    currentVisibleRef = [];
    appLetterMap.clear();
    return;
  }

  currentVisibleRef = visible;
  appLetterMap = new Map();
  const firstIndex = new Map<string, number>();
  const seriesMap = sort === "series" ? seriesSortKeys(visible) : null;

  visible.forEach((item, index) => {
    const keySource = seriesMap
      ? seriesMap.get(item.appName) || effectiveSortTitle(item)
      : effectiveSortTitle(item);
    const letter = alphaLetterOf(keySource);
    appLetterMap.set(item.appName, letter);
    if (!firstIndex.has(letter)) firstIndex.set(letter, index);
  });

  const baseLetters = sort === "alphaDesc" ? [...ALPHA_LETTERS].reverse() : ALPHA_LETTERS;
  const letters = firstIndex.has("#")
    ? sort === "alphaDesc"
      ? [...baseLetters, "#"]
      : ["#", ...baseLetters]
    : baseLetters;

  nav.setAttribute("aria-label", t("lib.alphaJump"));
  nav.innerHTML = letters
    .map((letter) => {
      const index = firstIndex.get(letter);
      const title = t("lib.alphaJumpTo", { letter });
      return `<button type="button" class="lib-alpha-btn" data-act="lib-alpha-jump" data-letter="${letter}" data-index="${index ?? ""}" ${index === undefined ? "disabled" : ""} title="${esc(title)}" aria-label="${esc(title)}">${letter}</button>`;
    })
    .join("");

  nav.hidden = false;
  content.classList.add("has-lib-alpha");
  if (!scrollRaf) {
    scrollRaf = window.requestAnimationFrame(updateActiveLetterFromScroll);
  }
}

/**
 * Stage home: one hero, a filmstrip of recent games, and the player's own
 * "up next" shelf. No store promotion, no carousel that moves by itself.
 */

import { collectionGameCount } from "../../core/game-collections";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import type { EpicSummary, GameCollection } from "../../epic";
import { stageCoverMarkup, stageHeroMarkup } from "./stage-art";
import {
  stageCollectionCoverKeys,
  stageGameByKey,
  stageHeroSummary,
  stagePrimaryAction,
  stageReadyShelf,
  stageRecentSummaries,
  stageTitleKey,
  stageUpNext,
  stageUserCollections,
} from "./stage-model";
import { stageMetaLine, stageSectionLabel, stageStatus } from "./stage-ui";

function reelCard(s: EpicSummary): string {
  return `<button type="button" class="stage-reel-card" data-stage-act="open-program" data-key="${esc(s.appName)}" data-gp-item data-gp-key="game:${esc(s.appName)}">
    <span class="stage-reel-art">${stageHeroMarkup(s, "stage-reel-image")}</span>
    <span class="stage-reel-scrim"></span>
    <span class="stage-reel-copy">
      <span class="stage-reel-title">${esc(s.title)}</span>
      <span class="stage-reel-meta">${stageMetaLine(s, { withSize: false })}</span>
    </span>
    ${stageStatus(s)}
  </button>`;
}

function portraitCard(s: EpicSummary): string {
  return `<button type="button" class="stage-mini-card" data-stage-act="open-program" data-key="${esc(s.appName)}" data-gp-item data-gp-key="game:${esc(s.appName)}">
    <span class="stage-mini-art">${stageHeroMarkup(s, "stage-mini-image")}</span>
    <span class="stage-mini-title">${esc(s.title)}</span>
    <span class="stage-mini-meta">${esc(s.installed ? t("stage.installed") : t("stage.notInstalled"))}</span>
  </button>`;
}

function row(title: string, games: EpicSummary[], card: (s: EpicSummary) => string): string {
  if (games.length === 0) return "";
  return `<section class="stage-row-section">
    ${stageSectionLabel(title, `<span class="stage-row-count">${games.length}</span>`)}
    <div class="stage-card-row" data-gp-row>${games.map(card).join("")}</div>
  </section>`;
}

function collectionCard(collection: GameCollection): string {
  const summaries = stageCollectionCoverKeys(collection)
    .map((key) => stageGameByKey(key))
    .filter((summary): summary is EpicSummary => Boolean(summary));
  const covers = summaries
    .map((summary) => `<span class="stage-collection-cover">${stageCoverMarkup(summary)}</span>`)
    .join("");
  return `<button type="button" class="stage-collection-card" data-stage-act="open-collection" data-id="${esc(collection.id)}" data-gp-item data-gp-key="collection:${esc(collection.id)}">
    <span class="stage-collection-mosaic stage-collection-mosaic-${Math.max(1, summaries.length)}">${covers || `<span class="stage-collection-empty">${icon("layers", 24)}</span>`}</span>
    <span class="stage-collection-copy">
      <strong>${esc(collection.name)}</strong>
      <small>${esc(t("stage.collectionCount", { n: collectionGameCount(collection) }))}</small>
    </span>
  </button>`;
}

function collectionsRow(): string {
  const collections = stageUserCollections();
  if (collections.length === 0) return "";
  return `<section class="stage-row-section">
    ${stageSectionLabel(t("stage.collections"), `<span class="stage-row-count">${collections.length}</span>`)}
    <div class="stage-card-row stage-collection-row" data-gp-row>${collections.map(collectionCard).join("")}</div>
  </section>`;
}

function emptyStage(): string {
  return `<div class="stage-empty">
    <span class="stage-empty-icon">${icon("gamepad-2", 46)}</span>
    <h1>${esc(t("stage.emptyTitle"))}</h1>
    <p>${esc(t("stage.emptyBody"))}</p>
    <div class="stage-empty-actions">
      <button type="button" class="stage-btn stage-btn-primary" data-stage-act="desktop" data-gp-item data-gp-key="empty:desktop">${esc(t("stage.openDesktop"))}</button>
    </div>
  </div>`;
}

export function renderStageHome(): string {
  const hero = stageHeroSummary();
  if (!hero) return emptyStage();

  const heroKey = stageTitleKey(hero);
  const recent = stageRecentSummaries(10).filter((s) => stageTitleKey(s) !== heroKey);
  const upNext = stageUpNext(10).filter((s) => stageTitleKey(s) !== heroKey);
  const upKeys = new Set(upNext.map(stageTitleKey));
  const ready = stageReadyShelf(10).filter(
    (s) => stageTitleKey(s) !== heroKey && !upKeys.has(stageTitleKey(s)),
  );

  return `<div class="stage-home">
    <section class="stage-hero">
      <span class="stage-hero-media">${stageHeroMarkup(hero)}</span>
      <span class="stage-hero-scrim"></span>
      <div class="stage-hero-body">
        <span class="stage-hero-kicker">${esc(t("stage.continue"))}</span>
        <h1 class="stage-hero-title">${esc(hero.title)}</h1>
        <div class="stage-hero-meta">${stageMetaLine(hero)}</div>
        <div class="stage-hero-actions">
          <div class="stage-primary-action">${stagePrimaryAction(hero)}</div>
          <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="open-program" data-key="${esc(hero.appName)}" data-gp-item data-gp-key="game:${esc(hero.appName)}">
            ${icon("dots", 18)}<span>${esc(t("stage.details"))}</span>
          </button>
        </div>
        <div class="stage-hero-foot">${stageStatus(hero)}<span class="stage-hero-beta">${esc(t("stage.betaHint"))}</span></div>
      </div>
    </section>

    ${row(t("stage.continue"), recent, reelCard)}
    ${row(t("stage.upNext"), upNext, portraitCard)}
    ${row(t("stage.ready"), ready, portraitCard)}
    ${collectionsRow()}

    <section class="stage-row-section stage-row-section-end">
      <button type="button" class="stage-library-jump" data-stage-act="go" data-route="library" data-gp-item data-gp-key="home:library">
        <span class="stage-library-jump-icon">${icon("layout-grid", 26)}</span>
        <span>
          <strong>${esc(t("stage.navLibrary"))}</strong>
          <small>${esc(t("stage.libraryJumpHint"))}</small>
        </span>
        ${icon("arrow-right", 18)}
      </button>
    </section>
  </div>`;
}

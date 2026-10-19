/**
 * Valve's Steam Deck compatibility category on the Steam game page.
 *
 * The store's public report answers with 1 unsupported, 2 playable or 3
 * verified. The backend caches it per app for a day; an app Valve has not rated
 * simply leaves the row out.
 */

import { icon } from "../../core/icons";
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { steamDeckStatus, type DeckStatus } from "../../steam";

const statuses = new Map<string, DeckStatus | null>();

function statusName(category: number): string {
  if (category === 3) return t("deck.verified");
  if (category === 2) return t("deck.playable");
  if (category === 1) return t("deck.unsupported");
  return "";
}

function statusClass(category: number): string {
  if (category === 3) return "verified";
  if (category === 2) return "playable";
  return "unsupported";
}

function summaryHtml(appId: string, info: DeckStatus): string {
  const label = statusName(info.category);
  if (!label) return "";
  return `
    <div class="hub-feature-row deck-row">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("monitor", 12)}</div>
        <span>${esc(t("deck.title"))}</span>
      </div>
      <div class="hub-feature-val">
        <button type="button" class="deck-pill ${statusClass(info.category)}" data-act="open-external-url" data-url="https://store.steampowered.com/app/${esc(appId)}/" title="${esc(t("deck.hint"))}">${esc(label)}</button>
      </div>
    </div>`;
}

export function renderDeckHost(s: EpicSummary): string {
  return sourceOfKey(s.appName) === "steam" ? `<div id="deck-chip"></div>` : "";
}

export async function hydrateDeckChip(appName: string): Promise<void> {
  if (sourceOfKey(appName) !== "steam" || !appName.startsWith("steam::")) return;
  if (S.offlineMode) return;
  const host = document.getElementById("deck-chip");
  if (!host || host.dataset.loaded === "1") return;
  const appId = appName.slice(7);
  let info = statuses.get(appId);
  if (info === undefined) {
    info = await steamDeckStatus(appId).catch(() => null);
    statuses.set(appId, info);
  }
  if (S.currentModalAppName !== appName) return;
  host.dataset.loaded = "1";
  if (info) host.innerHTML = summaryHtml(appId, info);
}

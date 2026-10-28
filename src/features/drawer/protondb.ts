/**
 * ProtonDB's community compatibility tier on the Steam game page.
 *
 * The badge is one extra row in the "this copy" card. It is fetched only for
 * Steam apps, cached in memory for the session and on disk by the backend for a
 * day. A missing answer leaves the row out; this is a signal, not a gate.
 */

import { icon } from "../../core/icons";
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { steamProtonDbSummary, type ProtonDbSummary } from "../../steam";

const summaries = new Map<string, ProtonDbSummary | null>();

const TIER_KEYS: Record<string, string> = {
  platinum: "protondb.platinum",
  gold: "protondb.gold",
  silver: "protondb.silver",
  bronze: "protondb.bronze",
  borked: "protondb.borked",
  pending: "protondb.pending",
};

function tierName(tier: string): string {
  const key = TIER_KEYS[tier];
  return key ? t(key) : tier;
}

function summaryHtml(appId: string, summary: ProtonDbSummary): string {
  const tier = summary.tier.trim().toLowerCase();
  const label = tierName(tier);
  const trending = summary.trendingTier?.trim().toLowerCase() ?? "";
  const hint =
    trending && trending !== tier
      ? `${t("protondb.hint")} · ${t("protondb.trending", { tier: tierName(trending) })}`
      : t("protondb.hint");
  return `
    <div class="hub-feature-row protondb-row">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("gamepad-2", 12)}</div>
        <span>${esc(t("protondb.title"))}</span>
      </div>
      <div class="hub-feature-val">
        <button type="button" class="protondb-pill ${esc(tier)} sys-copy-status" data-act="open-external-url" data-url="https://www.protondb.com/app/${esc(appId)}" title="${esc(hint)}">${esc(label)}</button>
      </div>
    </div>`;
}

export function renderProtonDbHost(s: EpicSummary): string {
  return sourceOfKey(s.appName) === "steam" ? `<div id="protondb-chip"></div>` : "";
}

export async function hydrateProtonDbChip(appName: string): Promise<void> {
  if (sourceOfKey(appName) !== "steam" || !appName.startsWith("steam::")) return;
  const host = document.getElementById("protondb-chip");
  if (!host || host.dataset.loaded === "1") return;
  const appId = appName.slice(7);
  let summary = summaries.get(appId);
  if (summary === undefined) {
    summary = await steamProtonDbSummary(appId, S.offlineMode).catch(() => null);
    // A cache-only miss must not be remembered as a failure: when the network
    // comes back the badge may still be fetched.
    if (summary !== null || !S.offlineMode) summaries.set(appId, summary);
  }
  if (S.currentModalAppName !== appName) return;
  host.dataset.loaded = "1";
  if (summary) host.innerHTML = summaryHtml(appId, summary);
}

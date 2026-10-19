/**
 * Are We Anti-Cheat Yet?'s Linux/Wine status on the Steam game page.
 *
 * The catalogue is one shared JSON file; the backend caches it for a day and
 * answers one app at a time. This row sits next to the ProtonDB tier and links
 * to the game's AWACY page. A missing entry simply leaves the row out.
 */

import { icon } from "../../core/icons";
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { steamAntiCheatStatus, type AntiCheatStatus } from "../../steam";

const statuses = new Map<string, AntiCheatStatus | null>();

const STATUS_KEYS: Record<string, string> = {
  supported: "awacy.supported",
  running: "awacy.running",
  broken: "awacy.broken",
  denied: "awacy.denied",
  planned: "awacy.planned",
};

function statusName(status: string): string {
  const key = STATUS_KEYS[status];
  return key ? t(key) : t("awacy.unknown");
}

function summaryHtml(appId: string, info: AntiCheatStatus): string {
  const status = info.status.trim().toLowerCase();
  const known = status in STATUS_KEYS ? status : "unknown";
  const anticheats = info.anticheats.filter(Boolean).join(" · ");
  const hint = anticheats ? `${t("awacy.hint")} · ${anticheats}` : t("awacy.hint");
  const url = info.slug
    ? `https://areweanticheatyet.com/game/${encodeURIComponent(info.slug)}`
    : "https://areweanticheatyet.com/";
  return `
    <div class="hub-feature-row awacy-row">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("shield", 12)}</div>
        <span>${esc(t("awacy.title"))}</span>
      </div>
      <div class="hub-feature-val">
        <button type="button" class="awacy-pill ${esc(known)}" data-act="open-external-url" data-url="${esc(url)}" title="${esc(hint)}">${esc(statusName(status))}</button>
      </div>
    </div>`;
}

export function renderAntiCheatHost(s: EpicSummary): string {
  return sourceOfKey(s.appName) === "steam" ? `<div id="awacy-chip"></div>` : "";
}

export async function hydrateAntiCheatChip(appName: string): Promise<void> {
  if (sourceOfKey(appName) !== "steam" || !appName.startsWith("steam::")) return;
  const host = document.getElementById("awacy-chip");
  if (!host || host.dataset.loaded === "1") return;
  const appId = appName.slice(7);
  let info = statuses.get(appId);
  if (info === undefined) {
    info = await steamAntiCheatStatus(appId).catch(() => null);
    statuses.set(appId, info);
  }
  if (S.currentModalAppName !== appName) return;
  host.dataset.loaded = "1";
  if (info) host.innerHTML = summaryHtml(appId, info);
}

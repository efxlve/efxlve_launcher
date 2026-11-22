/**
 * Exophase tab: the read-only cross-platform mirror of the profile.
 *
 * This step ships the shell only. The account lookup, the games API and the
 * disk cache arrive in the next step, so nothing here touches the network yet.
 * The launcher profile stays authoritative for Steam/Epic; this tab never
 * feeds its totals back into that one.
 */

import { emptyState, icon } from "../../core/icons";
import { t } from "../../i18n";
import { esc } from "../../core/utils";

export function renderExophaseTab(): string {
  return `
    <section class="profile-exophase-head">
      <div class="profile-exophase-identity">
        <span class="profile-exophase-mark" aria-hidden="true">${icon("globe", 26)}</span>
        <div class="profile-exophase-copy">
          <h1 class="profile-exophase-title">Exophase</h1>
          <p class="profile-exophase-sub">${esc(t("profile.exophaseSubtitle"))}</p>
        </div>
      </div>
      <span class="profile-exophase-pill"><span class="profile-exophase-dot" aria-hidden="true"></span>${esc(t("accounts.notConnected"))}</span>
    </section>

    <section class="profile-exophase-connect">
      ${emptyState(
        "globe",
        t("profile.exophaseConnectTitle"),
        t("profile.exophaseConnectDesc"),
        `<button type="button" class="btn primary" data-view="settings">${esc(t("profile.exophaseConnectCta"))}</button>`,
      )}
    </section>`;
}

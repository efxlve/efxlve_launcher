/**
 * Exophase tab: the read-only cross-platform mirror of the profile.
 *
 * This step ships the shell only. The account lookup, the games API and the
 * disk cache arrive in the next step, so nothing here touches the network yet.
 * The launcher profile stays authoritative for Steam/Epic; this tab never
 * feeds its totals back into that one.
 *
 * Exophase is an independent third-party service. The note at the bottom says
 * so explicitly; the launcher only reads public profile data and is not
 * affiliated with or endorsed by Exophase.
 */

import { icon, type IconName } from "../../core/icons";
import { t } from "../../i18n";
import { esc } from "../../core/utils";

function point(name: IconName, label: string): string {
  return `<div class="profile-exophase-point">${icon(name, 15)}<span>${esc(label)}</span></div>`;
}

export function renderExophaseTab(): string {
  return `
    <section class="card profile-exophase-hero">
      <div class="profile-exophase-hero-stage">
        <span class="profile-exophase-mark" aria-hidden="true">${icon("globe", 28)}</span>
        <div class="profile-exophase-hero-copy">
          <div class="profile-exophase-title-row">
            <h1 class="profile-exophase-title">Exophase</h1>
            <span class="profile-exophase-pill"><span class="profile-exophase-dot" aria-hidden="true"></span>${esc(t("accounts.notConnected"))}</span>
          </div>
          <p class="profile-exophase-sub">${esc(t("profile.exophaseSubtitle"))}</p>
        </div>
      </div>
      <div class="profile-exophase-hero-body">
        <div class="profile-exophase-connect-copy">
          <h2 class="profile-exophase-connect-title">${esc(t("profile.exophaseConnectTitle"))}</h2>
          <p class="profile-exophase-connect-desc">${esc(t("profile.exophaseConnectDesc"))}</p>
        </div>
        <button type="button" class="btn primary" data-view="settings">${esc(t("profile.exophaseConnectCta"))}</button>
      </div>
    </section>

    <div class="profile-exophase-points">
      ${point("globe", "PlayStation · Xbox · Switch · GOG")}
      ${point("trophy", t("profile.exophasePointProgress"))}
      ${point("clock", t("profile.unlocksTitle"))}
    </div>

    <footer class="profile-exophase-note">
      <p>${esc(t("profile.exophaseDisclaimer"))}</p>
      <button type="button" class="btn ghost small" data-act="open-external-url" data-url="https://www.exophase.com/">${icon("external", 12)}<span>exophase.com</span></button>
    </footer>`;
}

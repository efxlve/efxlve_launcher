/**
 * Exophase tab: the read-only cross-platform mirror of the profile.
 *
 * The launcher profile stays authoritative for Steam/Epic; this tab only reads
 * the public Exophase profile, never feeds its totals back into the local
 * profile and never writes to Exophase. The service explains that Exophase is
 * an independent third-party service in the note at the bottom.
 */

import { emptyState, epicPlatinumIcon, icon, type IconName } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";
import { EXOPHASE_SITE, type ExophaseAward, type ExophaseData, type ExophaseGame, type ExophaseSummary } from "../../exophase";

function fmtCount(value: number): string {
  return value.toLocaleString();
}

function fmtDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function relativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts * 1000);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("notif.justNow");
  if (mins < 60) return t("notif.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("notif.hoursAgo", { n: hours });
  return t("notif.daysAgo", { n: Math.floor(hours / 24) });
}

function errorText(code: string): string {
  const raw = code.toLowerCase();
  if (raw.includes("not_configured")) return t("profile.exophaseErrNotConfigured");
  if (raw.includes("blocked")) return t("profile.exophaseErrBlocked");
  if (raw.includes("not_found")) return t("profile.exophaseErrNotFound");
  if (raw.includes("network")) return t("profile.exophaseErrNetwork");
  return t("profile.exophaseErrGeneric");
}

/** A numeric player id has no username page; the site home is the honest link. */
function profileUrlFor(username: string): string {
  const trimmed = username.trim();
  return /^\d+$/.test(trimmed)
    ? EXOPHASE_SITE
    : `${EXOPHASE_SITE}user/${encodeURIComponent(trimmed)}/`;
}

function stat(glyph: string, label: string, value: string, sub = "", platinum = false): string {
  return `<div class="profile-stat${platinum ? " is-plat-stat" : ""}">
    <span class="profile-stat-icon" aria-hidden="true">${glyph}</span>
    <span class="profile-stat-text">
      <span class="profile-stat-label">${esc(label)}</span>
      <span class="profile-stat-val tabular-nums"><span>${esc(value)}</span>${sub ? `<span class="profile-stat-sub">${esc(sub)}</span>` : ""}</span>
    </span>
  </div>`;
}

function note(): string {
  return `<footer class="profile-exophase-note">
    <p>${esc(t("profile.exophaseDisclaimer"))}</p>
    <button type="button" class="btn ghost small" data-act="open-external-url" data-url="${EXOPHASE_SITE}">${icon("external", 12)}<span>exophase.com</span></button>
  </footer>`;
}

function point(name: IconName, label: string): string {
  return `<div class="profile-exophase-point">${icon(name, 15)}<span>${esc(label)}</span></div>`;
}

function points(): string {
  return `<div class="profile-exophase-points">
    ${point("globe", "PlayStation · Xbox · Switch · GOG")}
    ${point("trophy", t("profile.exophasePointProgress"))}
    ${point("clock", t("profile.unlocksTitle"))}
  </div>`;
}

/** The unconfigured state: a compact hero, the connect row, what you get and the note. */
function connectView(): string {
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
    ${points()}
    ${note()}`;
}

function profileHero(
  name: string,
  username: string,
  avatar: string,
  stats: string,
  loading: boolean,
  profileUrl: string,
  connected: boolean,
): string {
  const avatarHtml = avatar
    ? `<img src="${esc(avatar)}" alt="" loading="lazy" decoding="async" />`
    : icon("globe", 28);
  const handle = username ? `@${username}` : "Exophase";
  return `<section class="card profile-exophase-hero">
    <div class="profile-exophase-hero-stage">
      <span class="profile-exophase-mark profile-exophase-avatar" aria-hidden="true">${avatarHtml}</span>
      <div class="profile-exophase-hero-copy">
        <div class="profile-exophase-title-row">
          <h1 class="profile-exophase-title">${esc(name)}</h1>
          <span class="profile-exophase-pill${connected ? " is-connected" : ""}"><span class="profile-exophase-dot" aria-hidden="true"></span>${esc(t(connected ? "settings.connected" : "accounts.notConnected"))}</span>
        </div>
        <p class="profile-exophase-sub">${esc(handle)}</p>
      </div>
      <div class="profile-exophase-hero-actions">
        <button type="button" class="icon-btn profile-exophase-refresh${loading ? " is-busy" : ""}" data-act="exophase-refresh" title="${esc(t("profile.exophaseRefresh"))}" aria-label="${esc(t("profile.exophaseRefresh"))}">${icon("refresh", 14)}</button>
        <button type="button" class="btn ghost small" data-act="open-external-url" data-url="${esc(profileUrl)}">${icon("external", 12)}<span>Exophase</span></button>
      </div>
    </div>
    ${stats ? `<div class="profile-stats profile-exophase-stats">${stats}</div>` : ""}
  </section>`;
}

function metaLine(summary: ExophaseSummary): string {
  const sync = summary.lastSync
    ? `${t("profile.exophaseSync")}: ${fmtDate(summary.lastSync)}`
    : "";
  const updated = summary.fetchedAt
    ? t("profile.exophaseUpdated", { when: relativeTime(summary.fetchedAt) })
    : "";
  return `<div class="profile-exophase-meta-block">
    <div class="profile-exophase-meta">
      ${sync ? `<span>${esc(sync)}</span>` : ""}
      ${updated ? `<span class="profile-exophase-updated">${esc(updated)}</span>` : ""}
    </div>
    <p class="profile-exophase-hint">${esc(t("profile.exophaseSyncHint"))}</p>
  </div>`;
}

function servicesRow(data: ExophaseData, selected: string): string {
  const services = data.summary.services.filter((service) => service.games > 0);
  const chip = (value: string, label: string, count: number): string => {
    const active = selected === value;
    return `<button type="button" class="profile-exophase-chip${active ? " active" : ""}" data-act="exophase-service" data-val="${esc(value)}" aria-pressed="${active}">
      <span>${esc(label)}</span><span class="count tabular-nums">${fmtCount(count)}</span>
    </button>`;
  };
  return `<div class="profile-exophase-services" role="group" aria-label="${esc(t("profile.tabExophase"))}">
    ${chip("all", t("profile.filterAll"), data.summary.totalGames)}
    ${services.map((service) => chip(service.slug, service.label, service.games)).join("")}
  </div>`;
}

function gameCard(game: ExophaseGame): string {
  const percent = Math.round(game.percent);
  const total = game.totalAwards;
  const earned = game.earnedAwards;
  const count = total > 0 ? `${earned}/${total}` : `${earned}`;
  const playtime = game.playtimeMinutes > 0 ? fmtPlaytime(game.playtimeMinutes * 60) : "";
  const tip = `${game.title} · ${game.platform} · ${percent}%${playtime ? ` · ${playtime}` : ""}`;
  const action = game.url
    ? ` data-act="open-external-url" data-url="${esc(game.url)}"`
    : "";
  return `<button type="button" class="profile-exophase-card${percent >= 100 ? " is-complete" : ""}"${action} title="${esc(tip)}">
    <span class="profile-exophase-card-art">
      ${game.cover ? `<img src="${esc(game.cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="profile-exophase-card-ph">${icon("gamepad-2", 24)}</span>`}
      ${total > 0 ? `<span class="profile-exophase-card-badge tabular-nums">${percent}%</span>` : ""}
    </span>
    <span class="profile-exophase-card-body">
      <span class="profile-exophase-card-title">${esc(game.title)}</span>
      <span class="profile-exophase-card-meta tabular-nums">
        <span class="profile-exophase-card-platform">${esc(game.platform)}</span>
        <span>${icon("trophy", 10)}<span>${esc(count)}</span></span>
      </span>
      ${playtime ? `<span class="profile-exophase-card-time tabular-nums">${esc(playtime)}</span>` : ""}
    </span>
  </button>`;
}

function gamesSection(data: ExophaseData, selected: string): string {
  const all = [...data.games].sort((left, right) => right.lastPlayed - left.lastPlayed);
  const filtered = selected === "all" ? all : all.filter((game) => game.platformSlug === selected);
  const shown = filtered.slice(0, S.exophaseGameCount);
  const more = filtered.length > shown.length
    ? `<div class="row profile-more"><button type="button" class="btn ghost small" data-act="exophase-show-more">${t("profile.showMore")} (${fmtCount(filtered.length - shown.length)})</button></div>`
    : "";
  const body = shown.length > 0
    ? `<div class="profile-exophase-grid">${shown.map(gameCard).join("")}</div>`
    : emptyState("gamepad-2", t("profile.exophaseEmptyFilter"));
  return `<section class="profile-row profile-exophase-games">
    <div class="profile-row-head">
      <div class="profile-row-title-group">
        <h3 class="profile-row-title">${esc(t("profile.games"))}</h3>
        <span class="profile-row-count tabular-nums">${fmtCount(filtered.length)}</span>
      </div>
    </div>
    ${servicesRow(data, selected)}
    ${body}
    ${more}
  </section>`;
}

function awardCard(award: ExophaseAward): string {
  const rarity = award.rarity != null ? `%${award.rarity.toFixed(1)}` : "";
  const meta = [award.earned, rarity].filter(Boolean).join(" · ");
  const action = award.url
    ? ` data-act="open-external-url" data-url="${esc(award.url)}"`
    : "";
  return `<button type="button" class="profile-exophase-award"${action} title="${esc(`${award.name} — ${award.game}${meta ? ` · ${meta}` : ""}`)}">
    <span class="profile-exophase-award-icon">${award.icon ? `<img src="${esc(award.icon)}" alt="" loading="lazy" decoding="async" />` : icon("trophy", 18)}</span>
    <span class="profile-exophase-award-copy">
      <span class="profile-exophase-award-name">${esc(award.name)}</span>
      <span class="profile-exophase-award-game">${esc(award.game)}</span>
      ${meta ? `<span class="profile-exophase-award-meta tabular-nums">${esc(meta)}</span>` : ""}
    </span>
  </button>`;
}

function awardsSection(data: ExophaseData): string {
  if (data.awards.length === 0) return "";
  return `<section class="profile-row profile-exophase-awards">
    <div class="profile-row-head">
      <div class="profile-row-title-group">
        <h3 class="profile-row-title">${esc(t("profile.unlocksTitle"))}</h3>
      </div>
    </div>
    <div class="profile-exophase-award-grid">${data.awards.map(awardCard).join("")}</div>
  </section>`;
}

function loadedView(data: ExophaseData): string {
  const summary = data.summary;
  const stats = [
    stat(icon("gamepad-2", 21), t("profile.games"), fmtCount(summary.totalGames)),
    stat(icon("trophy", 21), t("profile.trophies"), fmtCount(summary.totalAwards)),
    stat(icon("clock", 21), t("profile.played"), summary.playtimeMinutes > 0 ? fmtPlaytime(summary.playtimeMinutes * 60) : "—"),
    stat(epicPlatinumIcon(22), t("profile.statCompleted"), fmtCount(summary.completedGames), "", true),
    ...(summary.rank > 0 ? [stat(icon("globe", 21), t("profile.exophaseRank"), `#${fmtCount(summary.rank)}`)] : []),
  ].join("");

  const serviceAvailable = summary.services.some((service) => service.slug === S.exophaseService);
  const selected = serviceAvailable ? S.exophaseService : "all";

  return `
    ${profileHero(summary.displayName || summary.username, summary.username, summary.avatar, stats, S.exophaseLoading, summary.profileUrl, true)}
    ${metaLine(summary)}
    ${gamesSection(data, selected)}
    ${awardsSection(data)}
    ${note()}`;
}

function loadingView(): string {
  return `${profileHero(S.exophaseUsername, S.exophaseUsername, "", "", true, profileUrlFor(S.exophaseUsername), true)}
    <div class="profile-exophase-loading"><span class="spinner"></span><p>${esc(t("profile.exophaseLoading"))}</p></div>`;
}

function errorView(): string {
  return `${profileHero(S.exophaseUsername, S.exophaseUsername, "", "", false, profileUrlFor(S.exophaseUsername), false)}
    ${emptyState(
      "info",
      t("profile.errorTitle"),
      errorText(S.exophaseError),
      `<button type="button" class="btn primary" data-act="exophase-refresh">${esc(t("profile.retry"))}</button>
       <button type="button" class="btn ghost small" data-view="settings">${esc(t("profile.exophaseConnectCta"))}</button>`,
    )}
    ${note()}`;
}

export function renderExophaseTab(): string {
  if (!S.exophaseConfigured) return connectView();
  if (!S.exophaseData) {
    if (S.exophaseLoading) return loadingView();
    if (S.exophaseError) return errorView();
    return loadingView();
  }
  return loadedView(S.exophaseData);
}

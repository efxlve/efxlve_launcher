/**
 * TV Profile: Fullscreen Console Gamer Dashboard for Steam Deck and 10-ft TV.
 *
 * PS5/Hydra console aesthetic:
 * - Pure pitch black surfaces (#000000), 1px hairline borders, --accent #ffffff
 * - Big console Gamer Identity banner with avatar, gamertag, connected stores, and tabular stats
 * - Horizontal carousel shelves for:
 *   1. 100% Completions Showcase (Mythic Platinum shelf)
 *   2. In-Progress Achievements with progress bars
 *   3. Connected Store Accounts (Epic, Steam, GOG)
 * - D-pad / Stick / Keyboard navigable with smooth scroll and crisp focus rings
 * - Zero emojis (inline SVG icons only), tabular numbers on all metrics
 */

import { epicPlatinumIcon, icon } from "../../core/icons";
import { S, globalAvatar } from "../../core/state";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";
import { storeLogo } from "../store/store-logos";
import {
  accountArchiveInfo,
  accountAvatar,
  coverOf,
  gameStore,
  libraryCount,
  overviewStores,
  playtimeFor,
  profileAccounts,
  profileListGames,
  profileSelection,
  storeCode,
  storeName,
  sumStats,
  switchAct,
  type ProfileAccount,
} from "../profile/profile-view";
import type { ProfileGameRecord } from "../../epic";

let tvProfileSection = 0; // 0: Showcase, 1: InProgress, 2: Accounts
let tvProfileCol = 0;

export function resetTvProfileFocus(): void {
  tvProfileSection = 0;
  tvProfileCol = 0;
}

function getSectionsData(): {
  platGames: ProfileGameRecord[];
  inProgGames: ProfileGameRecord[];
  accounts: ProfileAccount[];
} {
  const games = profileListGames();
  const platGames = games.filter((g) => g.is_platinum || g.unlocked_percent >= 100);
  const inProgGames = games
    .filter((g) => !g.is_platinum && g.unlocked_percent > 0 && g.unlocked_percent < 100)
    .sort((a, b) => b.unlocked_percent - a.unlocked_percent || b.total_xp - a.total_xp);
  const accounts = profileAccounts();
  return { platGames, inProgGames, accounts };
}

export function tvProfileMove(dir: "up" | "down" | "left" | "right"): void {
  const { platGames, inProgGames, accounts } = getSectionsData();
  const availableSections: number[] = [];
  if (platGames.length > 0) availableSections.push(0);
  if (inProgGames.length > 0) availableSections.push(1);
  if (accounts.length > 0) availableSections.push(2);

  if (availableSections.length === 0) return;

  if (dir === "up") {
    const curIdx = availableSections.indexOf(tvProfileSection);
    if (curIdx > 0) {
      tvProfileSection = availableSections[curIdx - 1];
      tvProfileCol = 0;
    }
  } else if (dir === "down") {
    const curIdx = availableSections.indexOf(tvProfileSection);
    if (curIdx !== -1 && curIdx < availableSections.length - 1) {
      tvProfileSection = availableSections[curIdx + 1];
      tvProfileCol = 0;
    }
  } else if (dir === "left") {
    tvProfileCol = Math.max(0, tvProfileCol - 1);
  } else if (dir === "right") {
    let maxCols = 1;
    if (tvProfileSection === 0) maxCols = platGames.length;
    else if (tvProfileSection === 1) maxCols = inProgGames.length;
    else if (tvProfileSection === 2) maxCols = accounts.length;
    tvProfileCol = Math.min(Math.max(0, maxCols - 1), tvProfileCol + 1);
  }

  applyTvProfileFocus();
}

export function tvProfileShelfJump(step: 1 | -1): void {
  const { platGames, inProgGames, accounts } = getSectionsData();
  const availableSections: number[] = [];
  if (platGames.length > 0) availableSections.push(0);
  if (inProgGames.length > 0) availableSections.push(1);
  if (accounts.length > 0) availableSections.push(2);

  if (availableSections.length === 0) return;
  const curIdx = availableSections.indexOf(tvProfileSection);
  const nextIdx = (curIdx + step + availableSections.length) % availableSections.length;
  tvProfileSection = availableSections[nextIdx];
  tvProfileCol = 0;
  applyTvProfileFocus();
}

export function tvProfileActivate(): void {
  const el = document.querySelector<HTMLElement>(
    `.tv-profile-card.focused, .tv-profile-inprog-card.focused, .tv-profile-acc-card.focused`,
  );
  if (el) {
    const switchBtn = el.querySelector<HTMLElement>(".tv-profile-switch-btn");
    if (switchBtn) {
      switchBtn.click();
    } else {
      el.click();
    }
  }
}

export function applyTvProfileFocus(): void {
  document
    .querySelectorAll<HTMLElement>(
      ".tv-profile-card.focused, .tv-profile-inprog-card.focused, .tv-profile-acc-card.focused",
    )
    .forEach((el) => el.classList.remove("focused"));

  const target = document.querySelector<HTMLElement>(
    `[data-tv-section="${tvProfileSection}"][data-tv-col="${tvProfileCol}"]`,
  );
  if (target) {
    target.classList.add("focused");
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }
}

/** Render Gamer Identity Hero Banner for 10-ft TV */
function renderTvProfileHero(
  displayName: string,
  customAvatar: string | null,
  initial: string,
  gamesCount: number,
  playtimeSeconds: number,
  unlocked: number,
  platinums: number,
  xp: number,
): string {
  const stores = overviewStores();
  const storePills = stores.map((s) => `
    <span class="tv-profile-store-pill">
      <span class="tv-status-dot"></span>
      ${storeLogo(s, 13)}
      <span>${storeName(s)}</span>
    </span>
  `).join("");

  return `
    <section class="tv-profile-hero">
      <div class="tv-profile-hero-left">
        <div class="tv-profile-avatar-wrap">
          <div class="tv-profile-avatar">
            ${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : `<span class="tv-profile-avatar-initial">${esc(initial)}</span>`}
          </div>
        </div>
        <div class="tv-profile-hero-info">
          <h1 class="tv-profile-hero-name">${esc(displayName)}</h1>
          <div class="tv-profile-hero-stores">${storePills}</div>
        </div>
      </div>

      <div class="tv-profile-hero-stats">
        <div class="tv-pstat-card">
          <span class="tv-pstat-title">${icon("gamepad-2", 13)} ${t("profile.games")}</span>
          <span class="tv-pstat-val tabular-nums">${gamesCount}</span>
        </div>
        <div class="tv-pstat-card">
          <span class="tv-pstat-title">${icon("clock", 13)} ${t("profile.played")}</span>
          <span class="tv-pstat-val tabular-nums">${esc(fmtPlaytime(playtimeSeconds))}</span>
        </div>
        <div class="tv-pstat-card">
          <span class="tv-pstat-title">${icon("trophy", 13)} ${t("profile.trophies")}</span>
          <span class="tv-pstat-val tabular-nums">${unlocked.toLocaleString()}</span>
        </div>
        <div class="tv-pstat-card is-plat">
          <span class="tv-pstat-title">${epicPlatinumIcon(14)} ${t("profile.platLabel")}</span>
          <span class="tv-pstat-val tabular-nums">${platinums}</span>
        </div>
        <div class="tv-pstat-card">
          <span class="tv-pstat-title">${icon("sparkles", 13)} XP</span>
          <span class="tv-pstat-val tabular-nums">${xp.toLocaleString()}</span>
        </div>
      </div>
    </section>`;
}

/** Render 100% Completions / Mythic Showcase Shelf */
function renderTvShowcaseShelf(platGames: ProfileGameRecord[]): string {
  if (platGames.length === 0) {
    return `
      <section class="tv-profile-shelf-section">
        <div class="tv-profile-shelf-head">
          <div class="tv-profile-shelf-title-wrap">
            <span class="tv-profile-shelf-icon is-plat">${epicPlatinumIcon(16)}</span>
            <h2 class="tv-profile-shelf-title">${t("profile.showcaseTitle")}</h2>
          </div>
        </div>
        <div class="tv-profile-empty-shelf">
          <span class="tv-profile-empty-ico">${epicPlatinumIcon(28)}</span>
          <div class="tv-profile-empty-text">
            <h4>${t("profile.showcaseEmpty")}</h4>
            <p>${t("profile.showcaseEmptyDesc")}</p>
          </div>
        </div>
      </section>`;
  }

  const cardsHtml = platGames.map((g, idx) => {
    const cover = coverOf(g.app_name, g.cover || "");
    const store = storeCode(gameStore(g.app_name));
    const isFocused = tvProfileSection === 0 && tvProfileCol === idx;

    return `
      <button type="button"
        class="tv-profile-card${isFocused ? " focused" : ""}"
        data-tv-section="0"
        data-tv-col="${idx}"
        data-act="tv-open-game-from-profile"
        data-id="${esc(g.app_name)}"
        tabindex="-1"
        title="${esc(g.app_title)}">
        ${cover ? `<img class="tv-profile-card-img" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<div class="tv-profile-card-placeholder">${icon("gamepad-2", 24)}</div>`}
        <span class="tv-profile-card-store">${store}</span>
        <span class="tv-profile-card-plat-badge">
          ${epicPlatinumIcon(13)}
          <span>100%</span>
        </span>
        <div class="tv-profile-card-scrim">
          <div class="tv-profile-card-title">${esc(g.app_title)}</div>
          <div class="tv-profile-card-meta tabular-nums">${g.total_unlocked} / ${g.total_achievements} ${t("profile.trophies")}</div>
        </div>
      </button>`;
  }).join("");

  return `
    <section class="tv-profile-shelf-section">
      <div class="tv-profile-shelf-head">
        <div class="tv-profile-shelf-title-wrap">
          <span class="tv-profile-shelf-icon is-plat">${epicPlatinumIcon(16)}</span>
          <h2 class="tv-profile-shelf-title">${t("profile.showcaseTitle")}</h2>
        </div>
      </div>
      <div class="tv-profile-shelf-track" id="tv-shelf-track-showcase">
        ${cardsHtml}
      </div>
    </section>`;
}

/** Render In-Progress Achievements Shelf */
function renderTvInProgressShelf(inProgGames: ProfileGameRecord[]): string {
  if (inProgGames.length === 0) return "";

  const cardsHtml = inProgGames.map((g, idx) => {
    const cover = coverOf(g.app_name, g.cover || "");
    const store = storeCode(gameStore(g.app_name));
    const pt = S.playtimeMap.get(g.app_name);
    const pct = Math.min(100, Math.max(0, g.unlocked_percent));
    const isFocused = tvProfileSection === 1 && tvProfileCol === idx;

    return `
      <button type="button"
        class="tv-profile-inprog-card${isFocused ? " focused" : ""}"
        data-tv-section="1"
        data-tv-col="${idx}"
        data-act="tv-open-game-from-profile"
        data-id="${esc(g.app_name)}"
        tabindex="-1"
        title="${esc(g.app_title)}">
        <div class="tv-profile-inprog-thumb-wrap">
          ${cover ? `<img class="tv-profile-inprog-thumb" src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="tv-profile-inprog-thumb placeholder">${icon("gamepad-2", 20)}</span>`}
        </div>
        <div class="tv-profile-inprog-info">
          <div class="tv-profile-inprog-title-row">
            <span class="tv-profile-inprog-title">${esc(g.app_title)}</span>
            <span class="tv-profile-inprog-store">${store}</span>
          </div>
          <div class="tv-profile-inprog-progress-track">
            <div class="tv-profile-inprog-progress-bar" style="width:${pct}%"></div>
          </div>
          <div class="tv-profile-inprog-meta-row">
            <span class="tv-profile-inprog-meta tabular-nums">${g.total_unlocked} / ${g.total_achievements} ${t("profile.trophies")}</span>
            ${pt && pt.total_seconds > 0 ? `<span class="tv-profile-inprog-meta tabular-nums">${esc(fmtPlaytime(pt.total_seconds))}</span>` : ""}
            <span class="tv-profile-inprog-pct tabular-nums">%${pct}</span>
          </div>
        </div>
      </button>`;
  }).join("");

  return `
    <section class="tv-profile-shelf-section">
      <div class="tv-profile-shelf-head">
        <div class="tv-profile-shelf-title-wrap">
          <span class="tv-profile-shelf-icon">${icon("timer", 16)}</span>
          <h2 class="tv-profile-shelf-title">${t("profile.inProgressTitle")}</h2>
        </div>
      </div>
      <div class="tv-profile-shelf-track" id="tv-shelf-track-inprog">
        ${cardsHtml}
      </div>
    </section>`;
}

/** Render Linked Accounts Shelf */
function renderTvAccountsShelf(accounts: ProfileAccount[]): string {
  if (accounts.length === 0) return "";

  const cardsHtml = accounts.map((a, idx) => {
    const avatar = accountAvatar(a);
    const initial = (a.name.trim().charAt(0) || "?").toUpperCase();
    const isFocused = tvProfileSection === 2 && tvProfileCol === idx;
    const archive = accountArchiveInfo(a);

    const gameCount = archive.games !== null
      ? archive.games
      : a.kind === "epic"
        ? (a.active ? libraryCount("epic") : null)
        : a.kind === "steam"
          ? (a.active ? libraryCount("steam") : null)
          : (a.active ? libraryCount("gog") : null);

    return `
      <div class="tv-profile-acc-card${isFocused ? " focused" : ""}${a.active ? " is-active" : ""}"
        data-tv-section="2"
        data-tv-col="${idx}"
        tabindex="-1">
        <div class="tv-profile-acc-top">
          <div class="tv-profile-acc-avatar">
            ${avatar ? `<img src="${esc(avatar)}" alt="" />` : `<span class="tv-avatar-initial">${esc(initial)}</span>`}
          </div>
          <div class="tv-profile-acc-meta">
            <div class="tv-profile-acc-name-row">
              <span class="tv-profile-acc-name">${esc(a.name)}</span>
              ${a.active ? `<span class="tv-status-dot online"></span>` : ""}
            </div>
            <div class="tv-profile-acc-store">
              ${storeLogo(a.kind, 14)}
              <span>${storeName(a.kind)}</span>
            </div>
          </div>
        </div>
        <div class="tv-profile-acc-status-line">
          <span class="tv-profile-acc-status tabular-nums">
            ${gameCount !== null ? `${gameCount} ${t("profile.games")}` : "—"}
          </span>
          ${a.active
            ? `<span class="tv-profile-acc-tag online">${icon("check", 12)} ${t("profile.activeSession")}</span>`
            : `<button type="button" class="tv-profile-switch-btn" data-act="${switchAct(a.kind)}" data-id="${esc(a.id)}">${icon("refresh", 11)} <span>${t("settings.accountSwitchBtn")}</span></button>`
          }
        </div>
      </div>`;
  }).join("");

  return `
    <section class="tv-profile-shelf-section">
      <div class="tv-profile-shelf-head">
        <div class="tv-profile-shelf-title-wrap">
          <span class="tv-profile-shelf-icon">${icon("users", 16)}</span>
          <h2 class="tv-profile-shelf-title">${t("profile.linkedAccounts")}</h2>
        </div>
      </div>
      <div class="tv-profile-shelf-track" id="tv-shelf-track-accounts">
        ${cardsHtml}
      </div>
    </section>`;
}

/** Complete Fullscreen TV Profile Markup */
export function renderTvProfile(): string {
  const sel = profileSelection();
  const isCombined = sel.mode === "combined";
  const displayName = isCombined
    ? (S.epicAccount || S.steamAuth?.accountName || S.gogAccount || t("profile.player"))
    : sel.account.name;
  const customAvatar = isCombined ? globalAvatar() : accountAvatar(sel.account);
  const initial = (displayName.trim().charAt(0) || "E").toUpperCase();

  const games = profileListGames();
  const sums = sumStats(games);
  const playtimeSeconds = playtimeFor("all");
  const gamesCount = libraryCount("all");

  const { platGames, inProgGames, accounts } = getSectionsData();

  return `
    <div class="tv-profile-screen" id="tv-profile-screen">
      <div class="tv-profile-bg">
        <div class="tv-profile-scrim"></div>
      </div>

      <header class="tv-profile-header">
        <button type="button" class="tv-hub-back-btn" data-act="tv-close-profile" title="${esc(t("common.back"))}">
          <span class="tv-btn-glyph">${icon("arrow-left", 14)}</span>
          <span>${t("common.back")}</span>
        </button>

        <div class="tv-profile-header-title">
          ${icon("user", 16)}
          <span>${t("tv.profile")}</span>
        </div>

        <div class="tv-profile-header-right">
          <button type="button" class="tv-exit-btn" data-act="close-tv-mode" title="${esc(t("tv.exit"))}">
            ${icon("x", 14)} <span>${t("tv.exit")}</span>
          </button>
        </div>
      </header>

      <div class="tv-profile-scroll-body">
        ${renderTvProfileHero(
          displayName,
          customAvatar,
          initial,
          gamesCount,
          playtimeSeconds,
          sums.unlocked,
          sums.platinums,
          sums.xp,
        )}

        <div class="tv-profile-shelves">
          ${renderTvShowcaseShelf(platGames)}
          ${renderTvInProgressShelf(inProgGames)}
          ${renderTvAccountsShelf(accounts)}
        </div>
      </div>
    </div>`;
}

/** Global mouseover delegation for TV Profile items */
document.addEventListener("mouseover", (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>(
    ".tv-profile-card, .tv-profile-inprog-card, .tv-profile-acc-card",
  );
  if (!card) return;
  const sec = card.dataset.tvSection;
  const col = card.dataset.tvCol;
  if (sec !== undefined && col !== undefined) {
    tvProfileSection = Number(sec);
    tvProfileCol = Number(col);
    applyTvProfileFocus();
  }
}, { passive: true });

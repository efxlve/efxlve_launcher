/**
 * Settings page renderer.
 *
 * Two-pane console layout: a category rail (left) selects one focused content
 * panel (right) so the page never turns into a long, cluttered scroll. It only
 * reads shared state (S) and imports presentational helpers; every action is
 * routed through the global data-act delegation.
 */

import { isTauri } from "../../core/constants";
import { icon, type IconName } from "../../core/icons";
import { render } from "../../core/render";
import { getCustomAvatar, S } from "../../core/state";
import type { SettingsSection } from "../../core/types";
import { esc, fmtBytes, fmtCdnName } from "../../core/utils";
import { LANGUAGES, t } from "../../i18n";
import { DEFAULT_DISCORD_CLIENT_ID } from "../presence/presence";
import { loadSavedAccounts } from "../auth/account-switcher";
import { appUpdateInstallBlocked } from "../updates/update-manager";
import {
  eosOverlayStatus,
  epicDefaultInstallDir,
  epicDetectEglGames,
  epicGetSettings,
  epicGetSteamGridKey,
  epicThirdPartyLaunchers,
  type EglDetectedGame,
  type ThirdPartyLauncher,
} from "../../epic";

const SECTIONS: { id: SettingsSection; icon: IconName; labelKey: string; subKey: string; color: string }[] = [
  { id: "account", icon: "users", labelKey: "settings.secAccount", subKey: "settings.secAccountSub", color: "#8b5cf6" },
  { id: "downloads", icon: "download", labelKey: "settings.secDownloads", subKey: "settings.secDownloadsSub", color: "#3b82f6" },
  { id: "integrations", icon: "layers", labelKey: "settings.secIntegrations", subKey: "settings.secIntegrationsSub", color: "#10b981" },
  { id: "appearance", icon: "globe", labelKey: "settings.secAppearance", subKey: "settings.secAppearanceSub", color: "#ec4899" },
  { id: "screenshots", icon: "camera", labelKey: "settings.secScreenshots", subKey: "settings.secScreenshotsSub", color: "#f59e0b" },
  { id: "system", icon: "settings", labelKey: "settings.secSystem", subKey: "settings.secSystemSub", color: "#06b6d4" },
  { id: "about", icon: "info", labelKey: "settings.secAbout", subKey: "settings.secAboutSub", color: "#a855f7" },
];

/** A single setting line: title/description on the left, a control on the right. */
function row(title: string, desc: string | null, control: string, stacked = false): string {
  return `
    <div class="settings-row${stacked ? " stacked" : ""}">
      <div class="settings-row-text">
        <div class="settings-row-title">${title}</div>
        ${desc ? `<div class="settings-row-desc">${desc}</div>` : ""}
      </div>
      ${control ? `<div class="settings-row-control">${control}</div>` : ""}
    </div>`;
}

/** A toggle switch bound to a data-act handler. */
function toggle(act: string, checked: boolean): string {
  return `<label class="toggle-switch"><input type="checkbox" data-act="${act}" ${checked ? "checked" : ""} /><span class="toggle-slider"></span></label>`;
}

function group(rows: string, title = ""): string {
  return `<section class="settings-group">${title ? `<div class="settings-group-title">${title}</div>` : ""}${rows}</section>`;
}

/* ---------- Sections ---------- */

function renderAccount(): string {
  const accountId = S.playerProfileData?.account_id || S.epicAccountId || S.epicAccount || "—";
  const customAvatar = S.epicAccount ? getCustomAvatar() : null;
  const initial = (S.epicAccount.trim()[0] || "?").toUpperCase();
  const displayName = S.playerProfileData?.display_name || S.epicAccount || t("settings.notLoggedIn");

  const identityCard = `
    <div class="settings-group account-hero-card">
      <div class="settings-account-hero">
        <div class="settings-account-avatar-wrap" data-act="profile-change-avatar" title="${t("profile.changeAvatarTitle")}">
          <div class="settings-account-avatar ${customAvatar ? "has-img" : ""}">
            ${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : `<span>${esc(initial)}</span>`}
            <div class="settings-account-avatar-badge">${icon("camera", 11)}</div>
          </div>
          <span class="settings-account-pip ${S.offlineMode ? "offline" : "online"}"></span>
        </div>
        <div class="settings-account-details">
          <div class="settings-account-head-row">
            <h3 class="settings-account-name">${esc(displayName)}</h3>
            <span class="settings-account-badge">${icon("shield-check", 12)} ${t("settings.accountConnectedBadge")}</span>
          </div>
          <div class="settings-account-id-row">
            <span class="settings-account-id-label">Epic Account ID:</span>
            <code class="settings-account-id-val">${esc(accountId)}</code>
            <button type="button" class="apple-pill-btn secondary small icon-only" data-act="copy-account-id" data-val="${esc(accountId)}" title="${t("profile.copyId")}">
              ${icon("copy", 12)}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  const statsCard = `
    <div class="settings-group">
      <div class="settings-group-title">${t("settings.accountStatsTitle")}</div>
      <div class="settings-stats-grid">
        <div class="settings-stat-box">
          <span class="stat-num">${S.epicSummaries.length}</span>
          <span class="stat-lbl">${t("settings.accountTotalGames")}</span>
        </div>
        <div class="settings-stat-box">
          <span class="stat-num">${S.epicSkippedCount}</span>
          <span class="stat-lbl">${t("settings.skippedItems")}</span>
        </div>
        <div class="settings-stat-box">
          <span class="stat-num sync ${S.epicSyncing ? "spinning" : ""}">${S.epicSyncing ? icon("refresh", 16) : icon("check-circle", 16)}</span>
          <span class="stat-lbl">${S.epicSyncing ? t("settings.eglSyncing") : t("profile.statusSynced")}</span>
        </div>
      </div>
    </div>
  `;

  const dangerCard = S.epicAccount
    ? `
    <div class="settings-group danger-zone">
      <div class="settings-group-title">${t("settings.accountDangerZone")}</div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">${t("settings.logout")}</div>
          <div class="settings-row-desc">${t("settings.accountDangerDesc")}</div>
        </div>
        <div class="settings-row-control">
          <button type="button" class="apple-pill-btn secondary danger small" data-act="epic-logout">
            ${icon("trash", 12)} <span>${t("settings.logout")}</span>
          </button>
        </div>
      </div>
    </div>
  `
    : "";

  const accounts = S.savedAccounts || [];
  const accountsListHtml = accounts.length > 0
    ? accounts
        .map((acc) => {
          const isCurrent = acc.is_active || acc.account_id === accountId || acc.display_name === displayName;
          const accAvatar = S.customAvatars[acc.account_id] || (isCurrent ? customAvatar : null);
          const init = (acc.display_name.trim()[0] || "?").toUpperCase();
          return `
            <div class="account-switcher-row ${isCurrent ? "active-account" : ""}">
              <div class="account-switcher-left">
                <div class="account-switcher-avatar ${accAvatar ? "has-img" : ""}">
                  ${accAvatar ? `<img src="${esc(accAvatar)}" alt="" />` : `<span>${esc(init)}</span>`}
                  ${isCurrent ? `<span class="account-switcher-pip online"></span>` : ""}
                </div>
                <div class="account-switcher-meta">
                  <div class="account-switcher-name-row">
                    <span class="account-switcher-name">${esc(acc.display_name)}</span>
                    ${isCurrent ? `<span class="account-switcher-active-tag">${icon("check", 11)} ${t("settings.accountActiveBadge")}</span>` : ""}
                  </div>
                  <div class="account-switcher-sub-row">
                    <span class="account-switcher-id">ID: ${esc(acc.account_id.slice(0, 12))}…</span>
                  </div>
                </div>
              </div>
              <div class="account-switcher-actions">
                ${isCurrent
                  ? `<span class="account-current-badge">${t("settings.accountCurrent")}</span>`
                  : `
                    <button type="button" class="apple-pill-btn primary small" data-act="account-switch" data-id="${esc(acc.account_id)}">
                      ${icon("refresh", 12)}
                      <span>${t("settings.accountSwitchBtn")}</span>
                    </button>
                    <button type="button" class="apple-pill-btn secondary small icon-only" data-act="account-remove" data-id="${esc(acc.account_id)}" title="${t("settings.accountRemove")}">
                      ${icon("trash", 12)}
                    </button>
                  `}
              </div>
            </div>
          `;
        })
        .join("")
    : `
      <div class="account-switcher-empty">
        <p>${t("settings.accountSwitcherEmpty")}</p>
      </div>
    `;

  const switcherCard = `
    <div class="settings-group account-switcher-group">
      <div class="settings-group-title-row">
        <div>
          <div class="settings-group-title">${t("settings.accountSwitcherTitle")}</div>
          <div class="settings-group-desc">${t("settings.accountSwitcherDesc")}</div>
        </div>
        <button type="button" class="apple-pill-btn secondary small" data-act="account-add">
          ${icon("plus", 12)}
          <span>${t("settings.accountAdd")}</span>
        </button>
      </div>
      <div class="account-switcher-list">
        ${accountsListHtml}
      </div>
    </div>
  `;

  return identityCard + switcherCard + statsCard + dangerCard;
}

function renderDownloads(): string {
  const dirCard = group(
    `<div class="settings-row stacked">
      <div class="settings-row-text">
        <div class="settings-row-title">${icon("folder", 14)} ${t("settings.installDirTitle")}</div>
        <div class="settings-row-desc">${t("settings.installDirHint")} <code>${esc(S.epicDefaultDir || "—")}</code></div>
      </div>
      <div class="settings-row-control">
        <input id="epic-install-dir" class="text-input" value="${esc(S.epicSettingsCache?.install_dir ?? "")}" placeholder="${esc(S.epicDefaultDir || t("downloads.defaultPlaceholder"))}" autocomplete="off" spellcheck="false" />
        <button type="button" class="apple-pill-btn secondary small" data-act="dl-pick-install-dir" title="${t("common.browse")}">
          ${icon("folder", 12)} <span>${t("common.browse")}</span>
        </button>
        <button type="button" class="apple-pill-btn primary small" data-act="epic-save-install-dir">
          ${icon("check", 12)} <span>${t("common.save")}</span>
        </button>
      </div>
    </div>`,
    t("settings.installDirTitle"),
  );

  const netCards = `
    <div class="settings-group">
      <div class="settings-group-title">${t("settings.netCardsTitle")}</div>
      <div class="settings-net-cards">
        <div class="settings-net-card ${S.networkProfile === "max" ? "active" : ""}" data-act="set-net-profile" data-profile="max">
          <div class="net-card-head">
            <span class="net-card-icon rocket">${icon("rocket", 18)}</span>
            <span class="net-card-badge">${S.networkProfile === "max" ? icon("check", 12) : ""}</span>
          </div>
          <div class="net-card-title">${t("settings.netMax")}</div>
          <div class="net-card-sub">${t("settings.netMaxDesc")}</div>
        </div>

        <div class="settings-net-card ${S.networkProfile === "balanced" ? "active" : ""}" data-act="set-net-profile" data-profile="balanced">
          <div class="net-card-head">
            <span class="net-card-icon shield">${icon("shield-check", 18)}</span>
            <span class="net-card-badge">${S.networkProfile === "balanced" ? icon("check", 12) : ""}</span>
          </div>
          <div class="net-card-title">${t("settings.netBalanced")}</div>
          <div class="net-card-sub">${t("settings.netBalancedDesc")}</div>
        </div>

        <div class="settings-net-card ${S.networkProfile === "low" ? "active" : ""}" data-act="set-net-profile" data-profile="low">
          <div class="net-card-head">
            <span class="net-card-icon clock">${icon("clock", 18)}</span>
            <span class="net-card-badge">${S.networkProfile === "low" ? icon("check", 12) : ""}</span>
          </div>
          <div class="net-card-title">${t("settings.netLow")}</div>
          <div class="net-card-sub">${t("settings.netLowDesc")}</div>
        </div>
      </div>
    </div>
  `;

  const advCard = `
    <div class="settings-group">
      <div class="settings-group-title">${t("settings.netAdvTitle")}</div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">${icon("globe", 13)} ${t("downloads.cdnLabel")}</div>
          <div class="settings-row-desc">${t("downloads.cdnHint")}${S.preferredCdn ? ` <code class="cdn-badge">${esc(fmtCdnName(S.preferredCdn))}</code>` : ` <code class="cdn-badge">${t("downloads.cdnAuto")}</code>`}</div>
        </div>
        <div class="settings-row-control">
          <div class="cdn-pills" role="radiogroup" aria-label="${t("downloads.cdnLabel")}">
            <button type="button" class="cdn-pill-btn ${!S.preferredCdn ? "active" : ""}" data-act="dl-set-cdn" data-cdn="">${t("downloads.cdnAutoShort")}</button>
            <button type="button" class="cdn-pill-btn ${S.preferredCdn === "epicgames-download1.akamaized.net" ? "active" : ""}" data-act="dl-set-cdn" data-cdn="epicgames-download1.akamaized.net">Akamai</button>
            <button type="button" class="cdn-pill-btn ${S.preferredCdn === "egdownload.fastly-edge.com" ? "active" : ""}" data-act="dl-set-cdn" data-cdn="egdownload.fastly-edge.com">Fastly</button>
            <button type="button" class="cdn-pill-btn ${S.preferredCdn === "egs-cloudfront-chunks.epicgamescdn.com" ? "active" : ""}" data-act="dl-set-cdn" data-cdn="egs-cloudfront-chunks.epicgamescdn.com">CloudFront</button>
          </div>
          <button type="button" class="apple-pill-btn primary small" data-act="dl-find-fastest-cdn" title="${t("downloads.cdnFindHint")}">${icon("zap", 12)} ${t("downloads.cdnFind")}</button>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">${icon("trash", 13)} ${t("downloads.cacheClear")}</div>
          <div class="settings-row-desc">${t("settings.netCacheDesc")}</div>
        </div>
        <div class="settings-row-control">
          <button type="button" class="apple-pill-btn secondary small" data-act="dl-cleanup-cache">${icon("trash", 12)} ${t("downloads.cacheClear")}</button>
        </div>
      </div>
      ${row(
        t("settings.offlineTitle"),
        t("settings.offlineDesc"),
        `<span class="settings-status ${S.offlineMode ? "on" : ""}">${S.offlineMode ? t("settings.offlineActive") : t("settings.onlineStandard")}</span>${toggle("toggle-offline-mode", S.offlineMode)}`,
      )}
    </div>
  `;

  return dirCard + netCards + advCard;
}

function renderIntegrations(): string {
  if (S.settingsIntegrationsLoading && !S.settingsIntegrationsLoaded) {
    return `<div class="settings-loading">${icon("refresh", 16)}<span>${t("settings.scanning")}</span></div>`;
  }
  const egl = S.eglDetectedList;
  const eglSync =
    egl.length > 0
      ? `<button class="apple-pill-btn primary small" data-act="epic-sync-egl" ${S.eglSyncing ? "disabled" : ""}>${S.eglSyncing ? t("settings.eglSyncing") : t("settings.eglSync")}</button>`
      : `<button class="apple-pill-btn secondary small" data-act="epic-refresh-egl">${icon("refresh", 12)} ${t("settings.rescan")}</button>`;

  const eglGroup =
    `<div class="settings-row stacked">
      <div class="settings-row-text"><div class="settings-row-desc">${t("settings.eglDesc")}</div></div>
      <div class="settings-row-control between">
        <span class="settings-value">${egl.length > 0 ? `${egl.length} ${t("settings.eglDetected")}` : t("settings.eglNone")}</span>
        ${eglSync}
      </div>
      ${
        egl.length > 0
          ? `<div class="settings-list">${egl
              .map(
                (g: EglDetectedGame) => `
        <div class="settings-list-item">
          <div class="li-main">
            <span class="li-title">${esc(g.title)}</span>
            <span class="li-sub" title="${esc(g.installPath)}">${esc(g.installPath)}</span>
          </div>
          <span class="li-size">${fmtBytes(g.installSize)}</span>
        </div>`,
              )
              .join("")}</div>`
          : ""
      }
    </div>` +
    row(
      t("settings.collectionsTitle"),
      `${t("settings.collectionsDesc")} <strong>${S.epicCollections.length}</strong> ${t("settings.collectionsCount")}`,
      `<button class="apple-pill-btn secondary small" data-act="import-egl-collections">${icon("download", 12)} ${t("settings.importEglCollections")}</button>`,
    );

  const tpl =
    S.thirdPartyLaunchers.length === 0
      ? row(t("settings.thirdPartyDesc"), t("settings.scanning"), "")
      : `<div class="settings-row stacked">
          <div class="settings-row-text"><div class="settings-row-desc">${t("settings.thirdPartyDesc")}</div></div>
          <div class="settings-row-control column">
            <div class="tpl-grid">
              ${S.thirdPartyLaunchers
                .map(
                  (l: ThirdPartyLauncher) => `
                <div class="tpl-card ${l.installed ? "installed" : ""}">
                  <div class="tpl-head">
                    <span class="tpl-name">${esc(l.name)}</span>
                    <span class="tpl-status ${l.installed ? "on" : "off"}">
                      ${l.installed ? `${icon("check", 11)} ${t("settings.installed")}${l.version ? ` · v${esc(l.version)}` : ""}` : t("settings.notInstalled")}
                    </span>
                  </div>
                  <div class="tpl-path" title="${esc(l.installPath || "")}">
                    ${l.installed ? esc(l.installPath || t("settings.pathUnknown")) : t("settings.thirdPartyRecommended")}
                  </div>
                  <div class="tpl-actions">
                    <button class="apple-pill-btn secondary small" data-act="open-external-url" data-url="${esc(l.downloadUrl)}">${icon("external", 12)} ${t("settings.officialDownload")}</button>
                  </div>
                </div>`,
                )
                .join("")}
            </div>
            <button class="apple-pill-btn secondary small start" data-act="third-party-refresh">${icon("refresh", 12)} ${t("settings.rescan")}</button>
          </div>
        </div>`;

  const sgdb = `<div class="settings-row stacked">
      <div class="settings-row-text"><div class="settings-row-desc">${t("settings.sgdbDesc")}</div></div>
      <div class="settings-row-control">
        <input id="settings-sgdb-key-input" type="${S.showSettingsSgdbKey ? "text" : "password"}" class="text-input" placeholder="${t("settings.sgdbPlaceholder")}" value="${esc(S.steamGridApiKey || "")}" spellcheck="false" autocomplete="off" />
        <button class="apple-pill-btn secondary small icon-only" data-act="toggle-sgdb-key-visibility" title="${t("settings.showHide")}">${icon(S.showSettingsSgdbKey ? "eye-off" : "eye", 13)}</button>
        <button class="apple-pill-btn primary small" data-act="save-sgdb-key">${icon("check", 12)} ${t("common.save")}</button>
        <button class="apple-pill-btn secondary small" data-act="test-sgdb-key">${t("settings.test")}</button>
      </div>
      <div class="settings-row-control tight">
        <span class="sgdb-status-badge ${S.steamGridApiKey ? "connected" : "disconnected"}">${S.steamGridApiKey ? `${icon("check", 12)} ${t("settings.connected")}` : t("settings.keyMissing")}</span>
        <button class="apple-pill-btn secondary small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api">${icon("external", 11)} ${t("settings.getFreeKey")}</button>
      </div>
    </div>`;

  const eos = `<div class="settings-row">
      <div class="settings-row-text">
        <div class="settings-row-title">${icon("users", 13)} ${t("settings.eosTitle")}${S.eosOverlay?.installed && S.eosOverlay.version ? ` <span class="eos-version">${esc(S.eosOverlay.version)}</span>` : ""}</div>
        <div class="settings-row-desc">
          <span class="eos-dot inline ${S.eosOverlay?.installed ? "on" : "off"}"></span>${S.eosOverlay?.installed ? t("settings.eosInstalled") : t("settings.eosMissing")} — ${S.eosOverlay?.installed ? t("settings.eosInstalledDesc") : t("settings.eosMissingDesc")}
        </div>
        ${S.eosOverlay?.installed && !S.eosOverlay.overlaySupported ? `<div class="settings-row-desc settings-note-warn">${t("settings.eosNotSupported")}</div>` : ""}
        ${S.eosOverlay?.installed && S.eosOverlay.path ? `<div class="settings-row-desc"><code>${esc(S.eosOverlay.path)}</code></div>` : ""}
      </div>
      <div class="settings-row-control">
        ${S.eosOverlay?.installed ? `<button class="apple-pill-btn secondary small" data-act="open-eos-folder">${icon("folder", 12)} ${t("settings.eosOpenFolder")}</button>` : ""}
        <button class="apple-pill-btn secondary small" data-act="refresh-eos">${icon("refresh", 12)} ${t("settings.eosRefresh")}</button>
      </div>
    </div>`;

  const presence = row(
    t("settings.presenceTitle"),
    t("settings.presenceDesc"),
    toggle("toggle-presence", S.presenceEnabled),
  );

  const presenceExtra = S.presenceEnabled
    ? `<div class="settings-row stacked">
        <div class="settings-row-text"><div class="settings-row-desc">${t("settings.presenceClientIdDesc")}</div></div>
        <div class="settings-row-control">
          <input id="presence-client-id" class="text-input" placeholder="${DEFAULT_DISCORD_CLIENT_ID}" value="${esc(S.presenceClientId)}" spellcheck="false" autocomplete="off" />
        </div>
      </div>`
    : "";

  return (
    group(eglGroup, t("settings.eglTitle")) +
    group(tpl, t("settings.thirdPartyTitle")) +
    group(sgdb, t("settings.sgdbTitle")) +
    group(presence + presenceExtra + eos, t("settings.secSocial"))
  );
}

function renderAppearance(): string {
  const languages = LANGUAGES.map(
    (l) => `
      <button class="lang-option-btn ${S.appLanguage === l.code ? "active" : ""}" data-act="set-app-language" data-lang="${esc(l.code)}">
        <span class="lang-flag">${esc(l.code.toUpperCase())}</span>
        <span class="lang-name">${esc(l.label)}</span>
        ${l.code === "tr" ? `<span class="lang-tag">${t("settings.defaultTag")}</span>` : ""}
      </button>`,
  ).join("");
  return (
    group(
      row(
        t("settings.navHistoryButtonsTitle"),
        t("settings.navHistoryButtonsDesc"),
        toggle("toggle-nav-history-buttons", S.showNavHistoryButtons),
      ),
      t("settings.secAppearance"),
    ) +
    group(
    row(t("settings.language"), t("settings.languageDesc"), "") +
      `<div class="lang-selection-group">${languages}</div>`,
    t("settings.secAppearance"),
    )
  );
}

function renderScreenshots(): string {
  const hotkey = `<div class="settings-row stacked">
      <div class="settings-row-text">
        <div class="settings-row-title">${icon("keyboard", 13)} ${t("settings.hotkeyLabel")}</div>
        <div class="settings-row-desc">${t("settings.activeKey")}: <strong>${esc(S.screenshotHotkeyName)}</strong></div>
      </div>
      <div class="settings-row-control">
        <select id="ss-hotkey-select" class="text-input settings-select" data-act="change-ss-hotkey">
          ${S.PRESET_HOTKEYS.map(
            (k) => `<option value="${k.code}" ${k.code === S.screenshotHotkey ? "selected" : ""}>${k.name}${k.code === 0x7b ? ` (${t("settings.defaultKey")})` : ""}</option>`,
          ).join("")}
          ${!S.PRESET_HOTKEYS.some((k) => k.code === S.screenshotHotkey) ? `<option value="${S.screenshotHotkey}" selected>${t("settings.customKey")}: ${esc(S.screenshotHotkeyName)} (${S.screenshotHotkey})</option>` : ""}
        </select>
        <button type="button" class="apple-pill-btn secondary small ${S.isRecordingScreenshotHotkey ? "settings-recording" : ""}" data-act="record-screenshot-hotkey">
          ${S.isRecordingScreenshotHotkey ? `${icon("keyboard", 12)} ${t("settings.pressKey")}` : `${icon("edit", 12)} ${t("settings.assignKey")}`}
        </button>
      </div>
    </div>`;

  const compressionOpts = S.screenshotCompressionEnabled
    ? `<div class="settings-row stacked">
        <div class="settings-row-control">
          <span class="settings-row-desc settings-label-inline">${t("settings.format")}:</span>
          <div class="ss-format-pills">
            <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "avif" ? "active" : ""}" data-act="set-ss-format" data-format="avif">${t("settings.avifBest")}</button>
            <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "webp" ? "active" : ""}" data-act="set-ss-format" data-format="webp">${t("settings.webpBalanced")}</button>
            <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "jpg" ? "active" : ""}" data-act="set-ss-format" data-format="jpg">${t("settings.jpegUniversal")}</button>
          </div>
        </div>
        <div class="settings-row-control tight">
          <span class="settings-row-desc settings-label-inline">${t("settings.quality")}:</span>
          <input type="range" min="0.70" max="0.95" step="0.05" value="${S.screenshotCompressionQuality}" data-act="set-ss-quality" id="ss-quality-slider" class="settings-range" />
          <span id="ss-quality-val" class="settings-range-val">%${Math.round(S.screenshotCompressionQuality * 100)}</span>
        </div>
        <div class="settings-inline-note">${icon("info", 13)}<span>${t("settings.avifInfo")}</span></div>
      </div>`
    : "";

  const compression = row(
    t("settings.compressionLabel"),
    S.screenshotCompressionEnabled ? t("settings.compressionDesc") : t("settings.compressionOffDesc"),
    toggle("toggle-screenshot-compression", S.screenshotCompressionEnabled),
  );

  return group(hotkey + compression + compressionOpts, t("settings.screenshotsTitle"));
}

function renderSystem(): string {
  const autoUpdateControl = `<input id="auto-update-time" class="text-input settings-field-sm" value="${esc(S.autoUpdateTime)}" maxlength="5" placeholder="03:00" spellcheck="false" autocomplete="off" />${toggle("toggle-auto-update", S.autoUpdateEnabled)}`;

  const blocked = appUpdateInstallBlocked();
  const statusText =
    S.appUpdateStatus === "checking" ? t("appUpdate.checking")
    : S.appUpdateStatus === "available" ? t("appUpdate.availableShort", { version: S.appUpdateVersion })
    : S.appUpdateStatus === "downloading" ? t("appUpdate.downloading", { p: S.appUpdateProgress })
    : S.appUpdateStatus === "ready" ? t("appUpdate.readyShort", { version: S.appUpdateVersion })
    : S.appUpdateStatus === "error" ? t("appUpdate.errorShort")
    : t("appUpdate.upToDateShort");

  const updateControl =
    S.appUpdateStatus === "ready"
      ? `<button type="button" class="apple-pill-btn primary small" data-act="app-update-install" ${blocked ? "disabled" : ""}>${icon("refresh", 12)} <span>${t("appUpdate.installNow")}</span></button>`
      : S.appUpdateStatus === "downloading"
      ? `<span class="settings-value tabular-nums" id="app-update-pct">${S.appUpdateProgress}%</span>`
      : S.appUpdateStatus === "available" && !S.appAutoUpdate
      ? `<button type="button" class="apple-pill-btn primary small" data-act="app-update-download">${icon("download", 12)} <span>${t("appUpdate.downloadNow")}</span></button>`
      : `<button type="button" class="apple-pill-btn secondary small" data-act="app-update-check" ${S.appUpdateStatus === "checking" ? "disabled" : ""}>${icon("refresh", 12)} <span>${t("appUpdate.checkBtn")}</span></button>`;

  const updateDesc = [
    t("appUpdate.desc"),
    `<span class="app-update-status">${statusText}</span>`,
    S.appUpdateStatus === "ready" && blocked ? t("appUpdate.blockedHint") : "",
  ]
    .filter(Boolean)
    .join(" ");

  const updateProgress =
    S.appUpdateStatus === "downloading" || S.appUpdateStatus === "ready"
      ? `<div class="app-update-progress"><div class="app-update-progress-bar" id="app-update-bar" style="width:${S.appUpdateProgress}%"></div></div>`
      : "";

  const updateCard = `
    <section class="settings-group app-update-group">
      <div class="settings-group-title">${icon("refresh", 13)} ${t("appUpdate.title")}</div>
      ${row(`${t("appUpdate.current")} <code>v${esc(S.appVersion)}</code>`, updateDesc, updateControl)}
      ${updateProgress}
      ${row(t("appUpdate.auto"), t("appUpdate.autoDesc"), toggle("toggle-app-auto-update", S.appAutoUpdate))}
    </section>`;

  return (
    updateCard +
    group(
      row(t("settings.minimizeToTray"), t("settings.minimizeToTrayDesc"), toggle("toggle-minimize-tray", S.minimizeToTray)) +
        row(t("settings.autoBackup"), t("settings.autoBackupDesc"), toggle("toggle-auto-backup", S.autoBackupOnExit)) +
        row(t("settings.autoUpdate"), t("settings.autoUpdateDesc"), autoUpdateControl),
      t("settings.secSystem"),
    ) +
    group(
      row(t("settings.backend"), null, `<span class="settings-value">${isTauri ? t("settings.backendRust") : t("settings.backendBrowser")}</span>`) +
        row(t("settings.libraryFolder"), `<code>${esc(S.libraryPath)}</code>`, "") +
        row(t("settings.version"), null, `<span class="settings-value">${esc(S.appVersion)}</span>`),
      t("settings.systemTitle"),
    )
  );
}

function renderAbout(): string {
  const version = S.appVersion;
  const buildInfo = isTauri ? "Tauri v2 · MSVC · 64-bit" : "Web Preview";

  const heroCard = `
    <div class="settings-about-hero ps5-glass-card">
      <div class="about-hero-badge">
        <span class="about-logo-mark">${icon("gamepad-2", 24)}</span>
      </div>
      <div class="about-hero-info">
        <div class="about-hero-title-row">
          <h2 class="about-hero-title">Efxlve Launcher</h2>
          <span class="about-version-badge">v${version}</span>
          <span class="about-build-badge">${buildInfo}</span>
        </div>
        <p class="about-hero-tagline">${t("settings.aboutTagline")}</p>
      </div>
    </div>
  `;

  const disclaimerCard = `
    <div class="settings-about-card ps5-glass-card disclaimer">
      <div class="about-card-header">
        <span class="about-card-icon warn">${icon("alert-triangle", 16)}</span>
        <h3 class="about-card-title">${t("settings.aboutDisclaimerTitle")}</h3>
      </div>
      <p class="about-card-text">${t("settings.aboutDisclaimer")}</p>
    </div>
  `;

  const missionCard = `
    <div class="settings-about-card ps5-glass-card">
      <div class="about-card-header">
        <span class="about-card-icon zap">${icon("zap", 16)}</span>
        <h3 class="about-card-title">${t("settings.aboutMissionTitle")}</h3>
      </div>
      <p class="about-card-text">${t("settings.aboutMission")}</p>
      <div class="about-tech-stack">
        <span class="tech-pill">${icon("cpu", 12)} Rust (Tauri v2)</span>
        <span class="tech-pill">${icon("terminal", 12)} Legendary CLI</span>
        <span class="tech-pill">${icon("sparkles", 12)} Vanilla TS + Vite</span>
        <span class="tech-pill">${icon("shield-check", 12)} 120 FPS Zero-Bloat</span>
      </div>
    </div>
  `;

  const linksCard = `
    <div class="settings-about-card ps5-glass-card">
      <div class="about-card-header">
        <span class="about-card-icon link">${icon("share-2", 16)}</span>
        <h3 class="about-card-title">${t("settings.aboutLinksTitle")}</h3>
      </div>
      <p class="about-card-text">${t("settings.aboutOpenSource")}</p>
      <div class="about-links-grid">
        <button type="button" class="about-link-pill email" data-act="open-external-url" data-url="mailto:hi@efxlve.com">
          <span class="link-icon email">${icon("mail", 15)}</span>
          <div class="link-text">
            <span class="link-label">${t("settings.aboutEmail")}</span>
            <span class="link-url">hi@efxlve.com</span>
          </div>
          <span class="link-ext">${icon("external", 13)}</span>
        </button>

        <button type="button" class="about-link-pill" data-act="open-external-url" data-url="https://x.com/efxlve">
          <span class="link-icon twitter">${icon("twitter", 15)}</span>
          <div class="link-text">
            <span class="link-label">${t("settings.aboutTwitter")}</span>
            <span class="link-url">x.com/efxlve</span>
          </div>
          <span class="link-ext">${icon("external", 13)}</span>
        </button>

        <button type="button" class="about-link-pill" data-act="open-external-url" data-url="https://github.com/efxlve/efxlve_launcher">
          <span class="link-icon github">${icon("github", 15)}</span>
          <div class="link-text">
            <span class="link-label">${t("settings.aboutGithub")}</span>
            <span class="link-url">github.com/efxlve/efxlve_launcher</span>
          </div>
          <span class="link-ext">${icon("external", 13)}</span>
        </button>

        <button type="button" class="about-link-pill" data-act="open-external-url" data-url="https://efxlve.com/efxlve_launcher">
          <span class="link-icon web">${icon("globe", 15)}</span>
          <div class="link-text">
            <span class="link-label">${t("settings.aboutWebsite")}</span>
            <span class="link-url">efxlve.com/efxlve_launcher</span>
          </div>
          <span class="link-ext">${icon("external", 13)}</span>
        </button>
      </div>
    </div>
  `;

  return `
    <div class="settings-about-container">
      ${heroCard}
      ${disclaimerCard}
      ${missionCard}
      ${linksCard}
    </div>
  `;
}

function renderSection(section: SettingsSection): string {
  switch (section) {
    case "downloads":
      return renderDownloads();
    case "integrations":
      return renderIntegrations();
    case "appearance":
      return renderAppearance();
    case "screenshots":
      return renderScreenshots();
    case "system":
      return renderSystem();
    case "about":
      return renderAbout();
    default:
      return renderAccount();
  }
}

export function renderSettings(): string {
  const active = SECTIONS.find((s) => s.id === S.settingsSection) ?? SECTIONS[0];
  const customAvatar = S.epicAccount ? getCustomAvatar() : null;
  const initial = (S.epicAccount.trim()[0] || "?").toUpperCase();

  const accountMini = `
    <div class="settings-sidebar-account ${S.settingsSection === "account" ? "active" : ""}" data-act="settings-section" data-section="account">
      <div class="sidebar-avatar ${customAvatar ? "has-img" : ""}">
        ${customAvatar ? `<img src="${esc(customAvatar)}" alt="" />` : `<span>${esc(initial)}</span>`}
        <span class="sidebar-status-pip ${S.offlineMode ? "offline" : "online"}"></span>
      </div>
      <div class="sidebar-account-info">
        <span class="sidebar-account-name">${esc(S.epicAccount || t("nav.notLoggedIn"))}</span>
        <span class="sidebar-account-sub">${S.epicAccount ? "Epic Games" : t("settings.notLoggedIn")}</span>
      </div>
      ${icon("chevron-right", 13)}
    </div>
  `;

  const nav = SECTIONS.map(
    (s) => `
      <button class="settings-nav-item ${s.id === active.id ? "active" : ""}" data-act="settings-section" data-section="${s.id}">
        <span class="settings-nav-icon" style="--nav-icon-color: ${s.color};">${icon(s.icon, 16)}</span>
        <div class="settings-nav-text">
          <span class="settings-nav-label">${t(s.labelKey)}</span>
          <span class="settings-nav-sub">${t(s.subKey)}</span>
        </div>
        ${s.id === active.id ? `<span class="settings-nav-indicator"></span>` : ""}
      </button>`,
  ).join("");

  return `
    <div class="ps5-page ps5-settings-page">
      <header class="ps5-page-header">
        <div class="ps5-header-main">
          <h1 class="ps5-header-title">${t("settings.title")}</h1>
          <p class="ps5-header-subtitle">${t("settings.subtitle")}</p>
        </div>
      </header>
      <main class="ps5-page-body">
        <div class="settings-layout">
          <nav class="settings-nav">
            ${accountMini}
            <div class="settings-nav-divider"></div>
            <div class="settings-nav-list">${nav}</div>
          </nav>
          <div class="settings-panel">
            <div class="settings-panel-head">
              <div class="settings-panel-icon-wrap" style="--head-icon-color: ${active.color};">
                ${icon(active.icon, 20)}
              </div>
              <div class="settings-panel-titles">
                <h2 class="settings-panel-title">${t(active.labelKey)}</h2>
                <p class="settings-panel-subtitle">${t(active.subKey)}</p>
              </div>
            </div>
            ${renderSection(active.id)}
          </div>
        </div>
      </main>
    </div>`;
}

/**
 * Loads the cheap settings data (settings.json, default dir, SteamGrid key).
 * Heavy integration scans are deferred to {@link loadIntegrationsView} so the
 * page paints instantly and the launcher never appears to freeze.
 */
export async function loadSettingsView(): Promise<void> {
  if (isTauri) {
    try {
      const [st, dir, sgdbKey] = await Promise.all([
        epicGetSettings(),
        epicDefaultInstallDir(),
        epicGetSteamGridKey().catch(() => null),
        loadSavedAccounts().catch(() => []),
      ]);
      S.epicSettingsCache = st;
      S.epicDefaultDir = dir;
      S.steamGridApiKey = sgdbKey;
    } catch {
      // Silent: keep the last cached values.
    }
  }
  render();
  if (S.settingsSection === "integrations") void loadIntegrationsView();
}

/**
 * Loads the slow integration data (EGL scan, third-party registry scan, EOS).
 * Runs only when the Integrations section is shown and is cached afterwards.
 */
export async function loadIntegrationsView(force = false): Promise<void> {
  if (!isTauri || S.settingsIntegrationsLoading) return;
  if (S.settingsIntegrationsLoaded && !force) return;
  S.settingsIntegrationsLoading = true;
  render();
  try {
    const [eglList, thirdParty, eos] = await Promise.all([
      epicDetectEglGames().catch(() => [] as EglDetectedGame[]),
      epicThirdPartyLaunchers().catch(() => [] as ThirdPartyLauncher[]),
      eosOverlayStatus().catch(() => null),
    ]);
    S.eglDetectedList = eglList;
    S.thirdPartyLaunchers = thirdParty;
    S.eosOverlay = eos;
    S.settingsIntegrationsLoaded = true;
  } catch {
    // Silent: keep the last cached values.
  } finally {
    S.settingsIntegrationsLoading = false;
    render();
  }
}

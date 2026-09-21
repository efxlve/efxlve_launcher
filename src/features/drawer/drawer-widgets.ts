/**
 * Detail drawer presentational widgets.
 *
 * Pure HTML builders used by the Game Hub tabs: HLTB/critic cards, feature and
 * controller-support cards, trophy/media spotlights, achievement sections and
 * hardware/system-requirement helpers. They read shared state (S) and never
 * trigger network fetches, which keeps them safe to reuse and test.
 */

import { isAppPlatinum } from "../../core/game-view";
import { epicPlatinumIcon, icon } from "../../core/icons";
import { isTurkishUser } from "../../core/selectors";
import { S } from "../../core/state";
import { cleanDisplayVersion, esc, fmtAchDate, fmtBytes, formatScreenshotDate } from "../../core/utils";
import { t as i18nT } from "../../i18n";
import { type CriticData, type EpicAchievementItem, type EpicAchievementSummary, type EpicGame, type EpicSummary, type GameRequirementsResponse, type HltbData, type ThirdPartyLauncherInfo } from "../../epic";

/** Map an achievement to its trophy tier. */
export function getAchTier(a: EpicAchievementItem): "platinum" | "gold" | "silver" | "bronze" {
  if (a.tier?.name) {
    const n = a.tier.name.toLowerCase();
    if (n.includes("plat")) return "platinum";
    if (n.includes("gold")) return "gold";
    if (n.includes("silver")) return "silver";
    if (n.includes("bronze")) return "bronze";
  }
  if (a.xp >= 200) return "platinum";
  if (a.xp >= 100) return "gold";
  if (a.xp >= 50) return "silver";
  return "bronze";
}
export function renderHltbCard(hltb?: HltbData, isLoading = false): string {
  if (isLoading) {
    return `
      <div class="drawer-hltb-card loading">
        <div class="hltb-head">
          <div class="hltb-title">${icon("timer", 13)} <span>HowLongToBeat</span></div>
          <div class="hltb-loading-text"><span class="hltb-spinner"></span> ${i18nT("hltb.searching")}</div>
        </div>
      </div>
    `;
  }
  if (!hltb || !hltb.supported || (!hltb.main_story && !hltb.main_extra && !hltb.completionist)) {
    return "";
  }
  return `
    <div class="drawer-hltb-card">
      <div class="hltb-head">
        <div class="hltb-title">${icon("timer", 13)} <span>HowLongToBeat</span></div>
        <div class="hltb-source">${i18nT("hltb.times")}</div>
      </div>
      <div class="hltb-grid">
        <div class="hltb-item">
          <div class="hltb-val">${hltb.main_story ? i18nT("hltb.hours", { n: hltb.main_story }) : "—"}</div>
          <div class="hltb-label">${i18nT("hltb.mainStory")}</div>
        </div>
        <div class="hltb-item">
          <div class="hltb-val">${hltb.main_extra ? i18nT("hltb.hours", { n: hltb.main_extra }) : "—"}</div>
          <div class="hltb-label">${i18nT("hltb.mainExtra")}</div>
        </div>
        <div class="hltb-item">
          <div class="hltb-val">${hltb.completionist ? i18nT("hltb.hours", { n: hltb.completionist }) : "—"}</div>
          <div class="hltb-label">${i18nT("hltb.completionist")}</div>
        </div>
      </div>
    </div>
  `;
}

export function renderCriticCard(critic?: CriticData, isLoading = false): string {
  if (isLoading) {
    return `
      <div class="hub-card hub-critic-card loading">
        <div class="hub-card-header">
          <h3 class="hub-card-title">${icon("star", 14)} <span>${i18nT("critic.title")}</span></h3>
        </div>
        <div class="critic-loading-text"><span class="hltb-spinner"></span> ${i18nT("critic.scanning")}</div>
      </div>
    `;
  }

  // Goygoy Engine incelemesi yalnızca Türkçe / Türk kullanıcılara gösterilir
  const showGoygoy = isTurkishUser() && Boolean(critic?.goygoy_review);
  const goygoy = showGoygoy ? critic?.goygoy_review : null;

  if (
    !critic ||
    !critic.supported ||
    (!critic.opencritic_score && !critic.metacritic_score && !critic.igdb_score && !goygoy)
  ) {
    return "";
  }

  const hasGlobalScores = Boolean(critic.opencritic_score || critic.metacritic_score || critic.igdb_score);

  const tierPill = critic.tier
    ? `<span class="critic-tier-pill tier-${critic.tier.toLowerCase()}">${critic.tier}</span>`
    : goygoy && !hasGlobalScores
      ? `<span class="critic-tier-pill tier-goygoy">Goygoy Engine</span>`
      : "";

  let globalScoresHtml = "";
  if (hasGlobalScores) {
    globalScoresHtml = `
      <div class="hub-critic-grid">
        ${
          critic.opencritic_score
            ? `
          <div class="hub-critic-badge opencritic ${critic.opencritic_url ? "clickable" : ""}" ${critic.opencritic_url ? `data-act="open-critic-url" data-url="${esc(critic.opencritic_url)}"` : ""} title="${i18nT("critic.openCriticPage")}">
            <div class="critic-badge-score ${critic.tier ? `tier-${critic.tier.toLowerCase()}` : ""}">${critic.opencritic_score}</div>
            <div class="critic-badge-info">
              <div class="critic-badge-name">OpenCritic</div>
              <div class="critic-badge-sub">${i18nT("critic.topCritic")}</div>
            </div>
            ${critic.opencritic_url ? `<div class="critic-badge-ext">${icon("external", 12)}</div>` : ""}
          </div>`
            : ""
        }
        ${
          critic.metacritic_score
            ? `
          <div class="hub-critic-badge metacritic ${critic.metacritic_url ? "clickable" : ""}" ${critic.metacritic_url ? `data-act="open-critic-url" data-url="${esc(critic.metacritic_url)}"` : ""} title="${i18nT("critic.metacriticPage")}">
            <div class="critic-badge-score mc">${critic.metacritic_score}</div>
            <div class="critic-badge-info">
              <div class="critic-badge-name">Metacritic</div>
              <div class="critic-badge-sub">${i18nT("critic.metascore")}</div>
            </div>
            ${critic.metacritic_url ? `<div class="critic-badge-ext">${icon("external", 12)}</div>` : ""}
          </div>`
            : ""
        }
        ${
          critic.igdb_score
            ? `
          <div class="hub-critic-badge igdb" title="${i18nT("critic.igdbCommunity")}">
            <div class="critic-badge-score igdb">${Math.round(critic.igdb_score <= 10 ? critic.igdb_score * 10 : critic.igdb_score)}</div>
            <div class="critic-badge-info">
              <div class="critic-badge-name">IGDB</div>
              <div class="critic-badge-sub">${i18nT("critic.communityScore")}</div>
            </div>
          </div>`
            : ""
        }
      </div>
    `;
  }

  let goygoyHtml = "";
  if (goygoy) {
    goygoyHtml = `
      <div class="hub-goygoy-box clickable" data-act="open-critic-url" data-url="${esc(goygoy.url)}" title="${i18nT("critic.readOnGoygoy")}">
        <div class="goygoy-box-top">
          <div class="goygoy-badge-top">
            <span class="goygoy-pulse-dot"></span>
            <span class="goygoy-brand"><strong>Goygoy</strong> Engine</span>
            <span class="goygoy-chip">${i18nT("critic.specialReview")}</span>
          </div>
          ${
            goygoy.score
              ? `<div class="goygoy-score-pill">
                  <span class="goygoy-score-num">${goygoy.score}</span>
                  <span class="goygoy-score-denom">/100</span>
                </div>`
              : ""
          }
        </div>
        <div class="goygoy-box-title">${esc(goygoy.title)}</div>
        ${goygoy.summary ? `<div class="goygoy-box-summary">“${esc(goygoy.summary)}”</div>` : ""}
        <div class="goygoy-box-footer">
          <div class="goygoy-writer">
            ${icon("users", 12)}
            <span>${esc(goygoy.writer || "Goygoy Engine")}</span>
          </div>
          <div class="goygoy-read-action">
            <span>${i18nT("critic.readReview")}</span>
            ${icon("external", 12)}
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="hub-card hub-critic-card">
      <div class="hub-card-header">
        <h3 class="hub-card-title">${icon("star", 14)} <span>${i18nT("critic.title")}</span></h3>
        ${tierPill}
      </div>
      ${globalScoresHtml}
      ${goygoyHtml}
    </div>
  `;
}

export function cleanStoreDescription(raw: string): string {
  if (!raw) return "";
  let t = raw;
  t = t.replace(/^#+\s*.*$/gm, "").trim();
  t = t.replace(/!\[.*?\]\(.*?\)/g, "").trim();
  t = t.replace(/<[^>]*>/g, "").trim();
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

export function detectControllerSupport(
  s: EpicSummary,
  g?: EpicGame,
  _reqData?: GameRequirementsResponse,
): { label: string; tooltip: string; iconName: "gamepad-2" | "keyboard"; className: string } {
  const titleLower = s.title.toLowerCase();
  const devRaw = (g?.metadata as { developer?: unknown } | undefined)?.developer;
  const devLower = typeof devRaw === "string" ? devRaw.toLowerCase() : "";

  // 1. Sony / PlayStation PC titles and games with native DualSense PC implementation
  const isDualSenseNative =
    devLower.includes("playstation") ||
    devLower.includes("sony interactive") ||
    titleLower.includes("spider-man") ||
    titleLower.includes("god of war") ||
    titleLower.includes("last of us") ||
    titleLower.includes("horizon zero dawn") ||
    titleLower.includes("horizon forbidden west") ||
    titleLower.includes("days gone") ||
    titleLower.includes("ratchet & clank") ||
    titleLower.includes("returnal") ||
    titleLower.includes("ghost of tsushima") ||
    titleLower.includes("uncharted") ||
    titleLower.includes("sackboy") ||
    titleLower.includes("helldivers") ||
    titleLower.includes("death stranding") ||
    titleLower.includes("cyberpunk 2077") ||
    titleLower.includes("alan wake 2") ||
    titleLower.includes("metro exodus") ||
    titleLower.includes("witcher 3") ||
    titleLower.includes("grand theft auto") ||
    titleLower.includes("gta") ||
    titleLower.includes("red dead");

  if (isDualSenseNative) {
    return {
      label: "✓ DualSense & Xbox Kolu",
      tooltip: "PC'de yerel DualSense / PlayStation (ışık çubuğu, ses) ve Xbox kolları desteklenir.",
      iconName: "gamepad-2",
      className: "supported",
    };
  }

  // 2. Pure Keyboard & Mouse titles (Strategy, RTS, Simulation, City Builder)
  const isKbMouseOnly =
    titleLower.includes("civilization") ||
    titleLower.includes("total war") ||
    titleLower.includes("cities: skylines") ||
    titleLower.includes("football manager") ||
    titleLower.includes("crusader kings") ||
    titleLower.includes("europa universalis") ||
    titleLower.includes("hearts of iron") ||
    titleLower.includes("stellaris") ||
    titleLower.includes("age of empires") ||
    titleLower.includes("command & conquer") ||
    titleLower.includes("simcity") ||
    titleLower.includes("factorio") ||
    titleLower.includes("rimworld");

  if (isKbMouseOnly) {
    return {
      label: "Klavye & Fare",
      tooltip: "Oyun kontrolleri ve menüleri klavye ve fare için tasarlanmıştır.",
      iconName: "keyboard",
      className: "muted",
    };
  }

  // 3. Standard PC Games: Xbox / XInput Gamepad (e.g. Dead by Daylight, etc.)
  return {
    label: "✓ Xbox & Gamepad (XInput)",
    tooltip: "Xbox ve XInput uyumlu kollar doğrudan çalışır. DualSense için XInput / DS4Windows gerekebilir.",
    iconName: "gamepad-2",
    className: "supported",
  };
}

export function isOnlineOnlyGame(
  s: EpicSummary,
  _g?: EpicGame,
  reqData?: GameRequirementsResponse,
): boolean {
  const titleLower = s.title.toLowerCase();
  const appLower = s.appName.toLowerCase();

  // Known online-only titles (Brill = Dead by Daylight)
  if (
    appLower === "brill" ||
    titleLower.includes("dead by daylight") ||
    titleLower.includes("fortnite") ||
    titleLower.includes("rocket league") ||
    titleLower.includes("fall guys") ||
    titleLower.includes("destiny 2") ||
    titleLower.includes("rainbow six siege") ||
    titleLower.includes("apex legends") ||
    titleLower.includes("valorant") ||
    titleLower.includes("warframe") ||
    titleLower.includes("overwatch") ||
    titleLower.includes("the division") ||
    titleLower.includes("genshin impact") ||
    titleLower.includes("honkai") ||
    titleLower.includes("pubg") ||
    titleLower.includes("the finals") ||
    titleLower.includes("world of warships") ||
    titleLower.includes("paladins") ||
    titleLower.includes("smite") ||
    titleLower.includes("rogue company")
  ) {
    return true;
  }

  // Check description and tags for explicit online-only signals
  const allText = [
    ...(reqData?.tags || []),
    reqData?.shortDescription || "",
    reqData?.description || "",
    s.description || "",
  ].join(" ").toLowerCase();

  if (
    allText.includes("multiplayer (4vs1)") ||
    allText.includes("multiplayer (4v1)") ||
    allText.includes("online-only") ||
    allText.includes("requires internet connection") ||
    allText.includes("internet connection required") ||
    allText.includes("persistent internet connection") ||
    allText.includes("sadece çevrimiçi") ||
    allText.includes("sürekli internet bağlantısı")
  ) {
    return true;
  }

  return false;
}

export function renderGameFeatures(
  s: EpicSummary,
  g?: EpicGame,
  partner: ThirdPartyLauncherInfo | null = null,
  antiCheat: string | null = null,
  reqData?: GameRequirementsResponse,
): string {
  const achSum = S.epicAchSummaries[s.appName];
  const customAttrs = g?.metadata?.customAttributes as Record<string, { type?: string; value?: string }> | undefined;
  const cloudFolder = customAttrs?.CloudSaveFolder?.value || customAttrs?.CloudIncludeList?.value;
  const hasCloud = Boolean(cloudFolder || (S.activeManageSettings?.appName === s.appName && S.activeManageSettings.cloudSavesEnabled));
  const canRunOffline = customAttrs?.CanRunOffline?.value === "true";

  const isOnlineOnly = isOnlineOnlyGame(s, g, reqData);

  // 1. Kontrolcü Desteği
  const ctrl = detectControllerSupport(s, g, reqData);

  // 2. Bulut / Sunucu Kayıtları
  let cloudVal = "Yerel Kayıt";
  let cloudClass = "";
  let cloudTooltip = "Kayıt dosyaları yerel diskte saklanır. Launcher üzerinden yedekleyebilirsiniz.";
  if (isOnlineOnly) {
    cloudVal = "✓ Çevrimiçi Sunucu Kaydı";
    cloudClass = "supported";
    cloudTooltip = "Karakterleriniz ve ilerlemeniz doğrudan oyun sunucuları ve hesabınızla senkronize edilir.";
  } else if (hasCloud) {
    cloudVal = "✓ Epic Cloud";
    cloudClass = "supported";
    cloudTooltip = "Epic Games bulut kayıtları etkin.";
  } else if (partner) {
    const pName = partner.name === "Rockstar Games Launcher" ? "Rockstar Games" : partner.name;
    cloudVal = `✓ ${pName} Bulut`;
    cloudClass = "accent";
    cloudTooltip = `${partner.name} bulut senkronizasyonu (Social Club) kullanılır.`;
  }

  // 3. Başarım durumu
  let achVal = "Bulunmuyor";
  let achClass = "";
  if (achSum && achSum.total_achievements > 0) {
    const totalXp = achSum.total_xp || 0;
    achVal = `✓ ${achSum.total_achievements} Kupa${totalXp > 0 ? ` • ${totalXp} XP` : ""}`;
    achClass = isAppPlatinum(s.appName) ? "plat" : "gold";
  } else if (partner) {
    achVal = `✓ ${partner.name} Başarımları`;
    achClass = "accent";
  }

  // 4. Çevrimdışı oynanış
  let offlineVal = "✓ Destekleniyor (Çevrimdışı)";
  let offlineClass = "supported";
  let offlineTooltip = "İnternet bağlantısı olmadan yerel olarak oynanabilir.";
  if (isOnlineOnly) {
    offlineVal = "Sürekli İnternet Gerekir";
    offlineClass = "accent";
    offlineTooltip = "Bu oyun sunucu tabanlıdır; çalışmak için aktif internet bağlantısı gerektirir.";
  } else if (partner) {
    offlineVal = `${partner.name} Bağlantısı Gerekebilir`;
    offlineClass = "muted";
    offlineTooltip = `${partner.name} istemcisi ve hesabı ile ilk doğrulama/çevrimdışı mod gereklidir.`;
  } else if (canRunOffline) {
    offlineVal = "✓ Destekleniyor (Çevrimdışı)";
    offlineClass = "supported";
  }

  // 5. Oyun Modu Analizi
  const gameCols = S.epicCollections.filter((c) =>
    c.app_names.some((name) => name.toLowerCase() === s.appName.toLowerCase()),
  );
  const textCorpus = [
    ...(reqData?.tags || []),
    reqData?.shortDescription || "",
    reqData?.description || "",
    s.description || "",
    ...gameCols.map((c) => c.name),
  ].join(" ").toLowerCase();

  const titleLower = s.title.toLowerCase();
  const appLower = s.appName.toLowerCase();

  const hltb = S.loadedHltb.get(s.appName);
  const hasHltbStory = Boolean(hltb?.main_story && hltb.main_story > 0);

  const isKnownSingleAndMulti =
    titleLower.includes("grand theft auto") ||
    titleLower.includes("gta") ||
    titleLower.includes("red dead") ||
    titleLower.includes("battlefield") ||
    titleLower.includes("call of duty") ||
    titleLower.includes("halo") ||
    titleLower.includes("forza");

  const hasCoop = textCorpus.includes("coop") || textCorpus.includes("co-op") || textCorpus.includes("eşli");
  const hasMultiplayer =
    textCorpus.includes("multiplayer") ||
    textCorpus.includes("çok oyunculu") ||
    textCorpus.includes("online") ||
    textCorpus.includes("pvp") ||
    titleLower.includes("online");

  const hasSinglePlayer =
    hasHltbStory ||
    isKnownSingleAndMulti ||
    textCorpus.includes("single_player") ||
    textCorpus.includes("singleplayer") ||
    textCorpus.includes("single player") ||
    textCorpus.includes("tek oyunculu") ||
    textCorpus.includes("tek kişilik") ||
    textCorpus.includes("campaign") ||
    textCorpus.includes("senaryo") ||
    textCorpus.includes("hikaye") ||
    textCorpus.includes("story");

  let modeVal = "Tek Oyunculu";
  let modeClass = "supported";
  let modeTooltip = "Tek oyunculu hikaye veya oyun deneyimi.";

  if (appLower === "brill" || titleLower.includes("dead by daylight")) {
    modeVal = "Çok Oyunculu (4v1 PvP)";
    modeClass = "accent";
    modeTooltip = "1 Katil ve 4 Kurbandan oluşan asimetrik çevrimiçi çok oyunculu korku oyunu.";
  } else if (textCorpus.includes("4vs1") || textCorpus.includes("4v1") || textCorpus.includes("asymmetric")) {
    modeVal = "Çok Oyunculu (Asimetrik)";
    modeClass = "accent";
    modeTooltip = "Asimetrik çevrimiçi çok oyunculu oyun deneyimi.";
  } else if (textCorpus.includes("battle royale")) {
    modeVal = "Çok Oyunculu (Battle Royale)";
    modeClass = "accent";
    modeTooltip = "Çok oyunculu hayatta kalma ve son kalan olma mücadelesi.";
  } else if (textCorpus.includes("mmo") || textCorpus.includes("mmorpg")) {
    modeVal = "Devasa Çok Oyunculu (MMO)";
    modeClass = "accent";
    modeTooltip = "Geniş oyuncu topluluğu ile sürekli çevrimiçi dünya.";
  } else if (isKnownSingleAndMulti || (hasSinglePlayer && (hasMultiplayer || isOnlineOnly))) {
    modeVal = "Tek & Çok Oyunculu";
    modeClass = "accent";
    modeTooltip = "Hem zengin tek oyunculu hikaye modu hem de çevrimiçi çok oyunculu modlar içerir.";
  } else if (hasCoop && hasSinglePlayer) {
    modeVal = "Tek Oyunculu & Co-op";
    modeClass = "accent";
    modeTooltip = "Hem tek başına hem de arkadaşlarınızla eşli oynanabilir.";
  } else if (hasCoop) {
    modeVal = "Eşli Oyun (Co-op)";
    modeClass = "accent";
    modeTooltip = "Takım halinde eşli oynanış.";
  } else if (hasMultiplayer || isOnlineOnly) {
    modeVal = "Çok Oyunculu";
    modeClass = "accent";
    modeTooltip = "Çevrimiçi çok oyunculu karşılaşmalar.";
  } else {
    modeVal = "Tek Oyunculu";
    modeClass = "supported";
    modeTooltip = "Tek oyunculu oyun deneyimi.";
  }

  const versionInfo = cleanDisplayVersion(s.installedVersion || s.version);

  return `
    <div class="hub-feature-row" title="${esc(ctrl.tooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon(ctrl.iconName, 12)}</div>
        <span>Kontrolcü Desteği</span>
      </div>
      <div class="hub-feature-val ${ctrl.className}">${ctrl.label}</div>
    </div>

    <div class="hub-feature-row" title="${esc(cloudTooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("cloud", 12)}</div>
        <span>Bulut Kayıtları</span>
      </div>
      <div class="hub-feature-val ${cloudClass}">${cloudVal}</div>
    </div>

    <div class="hub-feature-row">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${isAppPlatinum(s.appName) ? epicPlatinumIcon(12) : icon("trophy", 12)}</div>
        <span>Başarımlar</span>
      </div>
      <div class="hub-feature-val ${achClass}">${achVal}</div>
    </div>

    <div class="hub-feature-row" title="${esc(offlineTooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon(isOnlineOnly ? "wifi" : "globe", 12)}</div>
        <span>Çevrimdışı Oynanış</span>
      </div>
      <div class="hub-feature-val ${offlineClass}">${offlineVal}</div>
    </div>

    <div class="hub-feature-row" title="${esc(modeTooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("users", 12)}</div>
        <span>Oyun Modu</span>
      </div>
      <div class="hub-feature-val ${modeClass}">${modeVal}</div>
    </div>

    ${
      partner
        ? `
    <div class="hub-feature-row" title="${esc(partner.name)} harici başlatıcısı üzerinden yürütülür.">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("layers", 12)}</div>
        <span>Harici Başlatıcı</span>
      </div>
      <div class="hub-feature-val accent">${esc(partner.name)}</div>
    </div>`
        : ""
    }

    ${
      antiCheat
        ? `
    <div class="hub-feature-row" title="Aktif Hile Koruması: ${esc(antiCheat)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("shield", 12)}</div>
        <span>Hile Koruması</span>
      </div>
      <div class="hub-feature-val accent">${esc(antiCheat)}</div>
    </div>`
        : ""
    }

    <div class="hub-feature-row">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("monitor", 12)}</div>
        <span>Platform</span>
      </div>
      <div class="hub-feature-val supported">Windows (PC x64)</div>
    </div>

    ${
      s.installed && s.installSize
        ? `
    <div class="hub-feature-row" title="Yüklü disk boyutu ve derleme sürümü">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("hard-drive", 12)}</div>
        <span>Yüklü Boyut</span>
      </div>
      <div class="hub-feature-val">
        <span class="hub-size-val">${fmtBytes(s.installSize)}</span>
        ${versionInfo.display ? `<span class="hub-version-badge" title="Sürüm Yapısı: ${esc(versionInfo.full)}">${esc(versionInfo.display)}</span>` : ""}
      </div>
    </div>`
        : ""
    }
  `;
}

export function renderOverviewTrophySpotlight(
  s: EpicSummary,
  g?: EpicGame,
  achSum?: EpicAchievementSummary,
  partner: ThirdPartyLauncherInfo | null = null,
): string {
  const isPlat = isAppPlatinum(s.appName);
  const isDemo = S.demoPlatinumApps.has(s.appName);
  const raw = (g?.achievements || (g?.metadata as any)?.achievements) as any;
  const rawList: any[] = raw?.achievements || (Array.isArray(raw) ? raw : []);

  const hasAch = Boolean(
    (achSum && achSum.supported !== false && achSum.total_achievements > 0) ||
    rawList.length > 0,
  );

  if (!hasAch) {
    if (partner) {
      return `
        <div class="hub-card hub-trophy-spotlight">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("trophy", 14)} <span>${esc(partner.name)} Başarımları</span></h3>
            <button class="hub-card-link" data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}">
              <span>İncele</span> ${icon("chevron-right", 12)}
            </button>
          </div>
          <div class="hub-media-empty">
            <div class="hub-media-empty-icon">${icon("trophy", 20)}</div>
            <div class="hub-media-empty-info">
              <div class="hub-media-empty-title">${esc(partner.name)} Başarım Takibi</div>
              <div class="hub-media-empty-desc">
                Bu oyunun başarımları doğrudan <strong>${esc(partner.name)}</strong> istemcisi üzerinden takip edilmektedir.
              </div>
            </div>
            <button class="hub-card-link" data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}">
              ${icon("external", 12)} <span>Detay</span>
            </button>
          </div>
        </div>
      `;
    }
    return "";
  }

  const cachedData = S.loadedAchievements.get(s.appName);
  const totalAch = achSum?.total_achievements || rawList.length || 0;
  const unlockedAch = isDemo ? totalAch : (achSum?.user_unlocked ?? 0);
  const pct = totalAch > 0 ? Math.min(100, Math.round((unlockedAch / totalAch) * 100)) : 0;
  const userXp = isDemo ? (achSum?.total_xp || 1000) : (achSum?.user_xp ?? 0);
  const totalXp = achSum?.total_xp || 0;

  // Madalya sayıları (Platin, Altın, Gümüş, Bronz)
  let platCount = isPlat || isDemo ? 1 : 0;
  let goldCount = 0;
  let silverCount = 0;
  let bronzeCount = 0;

  if (cachedData && cachedData.achievements.length > 0) {
    for (const a of cachedData.achievements) {
      if (a.unlocked || isDemo) {
        const t = getAchTier(a);
        if (t === "gold") goldCount++;
        else if (t === "silver") silverCount++;
        else if (t === "bronze") bronzeCount++;
        else if (t === "platinum" && !platCount) platCount = 1;
      }
    }
  } else {
    // Disk metadata'sındaki ham kupa dağılımı
    for (const item of rawList) {
      const ach = (item as any)?.achievement || item;
      const t = (ach.tier?.name || "").toLowerCase();
      const xp = Number(ach.XP || ach.xp || 0);
      if (t.includes("plat") || xp >= 200) platCount++;
      else if (t.includes("gold") || xp >= 100) goldCount++;
      else if (t.includes("silver") || xp >= 50) silverCount++;
      else bronzeCount++;
    }
    if (unlockedAch === 0 && !isDemo && !isPlat) {
      platCount = 0;
      goldCount = 0;
      silverCount = 0;
      bronzeCount = 0;
    }
  }

  // Sıradaki Hedef Kupalar (Next Up)
  interface TargetTrophy {
    title: string;
    desc: string;
    icon: string;
    badgeText: string;
    tierClass: "bronze" | "silver" | "gold" | "plat";
  }
  const targets: TargetTrophy[] = [];

  if (cachedData && cachedData.achievements.length > 0) {
    const lockedItems = cachedData.achievements.filter((a) => !a.unlocked && !isDemo);
    const sourceItems = lockedItems.length > 0 ? lockedItems : cachedData.achievements;
    for (const a of sourceItems.slice(0, 2)) {
      const tier = getAchTier(a);
      const tierName = tier === "platinum" ? "Platin" : tier === "gold" ? "Altın" : tier === "silver" ? "Gümüş" : "Bronz";
      const xpText = a.xp > 0 ? ` • +${a.xp} XP` : "";
      targets.push({
        title: a.display_name || a.name,
        desc: a.hidden && !a.unlocked ? "Gizli Başarım — Detaylar için kupaları görüntüleyin." : (a.description || "Kupa hedefini tamamlayın."),
        icon: a.icon_link,
        badgeText: `${tierName}${xpText}`,
        tierClass: tier === "platinum" ? "plat" : tier,
      });
    }
  } else if (rawList.length > 0) {
    for (const item of rawList.slice(0, 2)) {
      const ach = (item as any)?.achievement || item;
      const t = (ach.tier?.name || "").toLowerCase();
      const xp = Number(ach.XP || ach.xp || 0);
      const tierClass: "bronze" | "silver" | "gold" | "plat" =
        t.includes("plat") || xp >= 200 ? "plat" : t.includes("gold") || xp >= 100 ? "gold" : t.includes("silver") || xp >= 50 ? "silver" : "bronze";
      const tierName = tierClass === "plat" ? "Platin" : tierClass === "gold" ? "Altın" : tierClass === "silver" ? "Gümüş" : "Bronz";
      const xpText = xp > 0 ? ` • +${xp} XP` : "";
      const isHidden = Boolean(ach.hidden);
      const title = ach.unlockedDisplayName || ach.lockedDisplayName || ach.name || "Kupa Hedefi";
      const desc = isHidden ? "Gizli Başarım — Detaylar için kupaları görüntüleyin." : (ach.unlockedDescription || ach.lockedDescription || "Kupa hedefini tamamlayın.");
      const iconUrl = ach.unlockedIconLink || ach.lockedIconLink || "";
      targets.push({
        title,
        desc,
        icon: iconUrl,
        badgeText: `${tierName}${xpText}`,
        tierClass,
      });
    }
  }

  const targetsHtml = targets.length > 0 ? `
    <div class="hub-trophy-next-list">
      ${targets.map((t) => `
        <button type="button" class="hub-trophy-target-card" data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}" title="${esc(t.title)} - ${esc(t.desc)}">
          <div class="hub-trophy-target-icon ${t.tierClass === "plat" ? "plat" : ""}">
            ${t.icon ? `<img src="${esc(t.icon)}" alt="" loading="lazy" />` : (t.tierClass === "plat" ? epicPlatinumIcon(18) : icon("trophy", 18))}
          </div>
          <div class="hub-trophy-target-info">
            <div class="hub-trophy-target-title">${esc(t.title)}</div>
            <div class="hub-trophy-target-desc">${esc(t.desc)}</div>
            <span class="hub-trophy-target-badge ${t.tierClass}">${esc(t.badgeText)}</span>
          </div>
        </button>
      `).join("")}
    </div>
  ` : "";

  return `
    <div class="hub-card hub-trophy-spotlight ${isPlat ? "plat" : ""}">
      <div class="hub-card-header">
        <h3 class="hub-card-title">${isPlat ? epicPlatinumIcon(14) : icon("trophy", 14)} <span>Kupa & Başarım İlerlemesi</span></h3>
        <button class="hub-card-link" data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}">
          <span>Tüm Kupalar</span> ${icon("chevron-right", 12)}
        </button>
      </div>

      <!-- Kupa İlerleme Kutusu -->
      <div class="hub-trophy-progress-box ${isPlat ? "plat" : ""}">
        <div class="hub-trophy-progress-top">
          <div class="hub-trophy-percent-badge">
            <span class="hub-trophy-percent-num ${isPlat ? "plat" : ""}">%${pct}</span>
            <span class="hub-trophy-counts">${unlockedAch} / ${totalAch} Kupa ${totalXp > 0 ? `• ${userXp} XP` : ""}</span>
          </div>
          <div class="hub-trophy-medals">
            <div class="hub-medal-item plat" title="Platin Kupa">${epicPlatinumIcon(12)} <span>${platCount}</span></div>
            <div class="hub-medal-item gold" title="Altın Kupa">${icon("trophy", 12)} <span>${goldCount}</span></div>
            <div class="hub-medal-item silver" title="Gümüş Kupa">${icon("trophy", 12)} <span>${silverCount}</span></div>
            <div class="hub-medal-item bronze" title="Bronz Kupa">${icon("trophy", 12)} <span>${bronzeCount}</span></div>
          </div>
        </div>
        <div class="hub-trophy-bar-track">
          <div class="hub-trophy-bar-fill ${isPlat ? "plat" : ""}" style="width: ${pct}%"></div>
        </div>
      </div>

      ${targetsHtml}
    </div>
  `;
}

export function renderOverviewMediaSpotlight(s: EpicSummary): string {
  const screenshots = S.loadedScreenshots.get(s.appName) || [];
  const recent = screenshots.slice(0, 3);

  const headerRight = `
    <div style="display:flex;align-items:center;gap:6px">
      <span class="hub-card-hotkey" title="Ekran görüntüsü kısayolu">${esc(S.screenshotHotkeyName)}</span>
      <button class="hub-card-link" data-act="drawer-tab" data-tab="screenshots" data-id="${s.appName}">
        <span>Tümü</span> ${icon("chevron-right", 12)}
      </button>
    </div>
  `;

  let contentHtml = "";
  if (recent.length > 0) {
    contentHtml = `
      <div class="hub-media-strip">
        ${recent.map((item, idx) => `
          <button type="button" class="hub-media-item" data-act="open-screenshot-lightbox" data-id="${s.appName}" data-idx="${idx}" title="${esc(item.file_name)}">
            <img src="${item.data_url}" alt="${esc(item.file_name)}" loading="lazy" />
            <div class="hub-media-overlay">
              <div class="hub-media-zoom-icon">${icon("eye", 12)}</div>
              <div class="hub-media-date">${esc(formatScreenshotDate(item.timestamp, item.date_str))}</div>
            </div>
          </button>
        `).join("")}
      </div>
    `;
  } else {
    contentHtml = `
      <div class="hub-media-empty">
        <div class="hub-media-empty-icon">${icon("camera", 20)}</div>
        <div class="hub-media-empty-info">
          <div class="hub-media-empty-title">Ekran Görüntüleri & Klipler</div>
          <div class="hub-media-empty-desc">
            Oyun oynarken <strong>${esc(S.screenshotHotkeyName)}</strong> tuşu ile yakaladığınız kareler burada sergilenir.
          </div>
        </div>
        <button class="hub-card-link" data-act="open-screenshots-folder" data-id="${s.appName}" data-title="${esc(s.title)}" title="Ekran görüntüleri klasörünü aç">
          ${icon("folder", 12)} <span>Klasör</span>
        </button>
      </div>
    `;
  }

  return `
    <div class="hub-card hub-media-spotlight">
      <div class="hub-card-header">
        <h3 class="hub-card-title">
          ${icon("camera", 14)} <span>Medya Galerisi</span>
          ${screenshots.length > 0 ? `<span class="hub-card-count">(${screenshots.length})</span>` : ""}
        </h3>
        ${headerRight}
      </div>
      ${contentHtml}
    </div>
  `;
}

export function renderAchievementSections(
  items: EpicAchievementItem[],
  s: EpicSummary,
  shouldGroup: boolean,
  allAchievements?: EpicAchievementItem[],
): string {
  if (items.length === 0) {
    return `
      <div class="ach-empty-state">
        <div class="ach-empty-state-icon">${icon("search", 28)}</div>
        <div class="ach-empty-state-title">Aramanıza Uygun Başarım Bulunamadı</div>
        <div class="ach-empty-state-sub">Filtreleri veya arama terimini değiştirerek tekrar deneyin.</div>
      </div>
    `;
  }

  const isDemo = S.demoPlatinumApps.has(s.appName);

  if (!shouldGroup) {
    return `<div class="ach-cards-grid">${items.map((a) => renderAchievementCard(a, s)).join("")}</div>`;
  }

  // SteamHunters Kategori Grupları: Ana Oyun ve Ek Paketler
  const baseItems = items.filter((a) => a.is_base);
  const dlcItems = items.filter((a) => !a.is_base);

  // Kategori istatistikleri ve ilerleme oranları SADECE filtrelenmiş liste üzerinden değil,
  // oyunun gerçek tüm başarımları üzerinden hesaplanmalıdır. Aksi halde "Kazanılanlar" filtresinde
  // kilitli olanlar filtrelendiği için kategori toplamı sadece kazanılanlar sayısına eşitlenip %100 bitmiş gibi görünür.
  const allSource = allAchievements && allAchievements.length > 0 ? allAchievements : items;
  const allBase = allSource.filter((a) => a.is_base);
  const allDlc = allSource.filter((a) => !a.is_base);

  const baseTotal = allBase.length;
  const baseUnlocked = isDemo ? baseTotal : allBase.filter((a) => a.unlocked).length;
  const basePct = baseTotal > 0 ? Math.round((baseUnlocked / baseTotal) * 100) : 0;
  const baseXp = allBase.filter((a) => a.unlocked || isDemo).reduce((sum, a) => sum + a.xp, 0);

  const dlcTotal = allDlc.length;
  const dlcUnlocked = isDemo ? dlcTotal : allDlc.filter((a) => a.unlocked).length;
  const dlcPct = dlcTotal > 0 ? Math.round((dlcUnlocked / dlcTotal) * 100) : 0;
  const dlcXp = allDlc.filter((a) => a.unlocked || isDemo).reduce((sum, a) => sum + a.xp, 0);

  let html = "";

  if (baseItems.length > 0) {
    html += `
      <div class="ach-group-section">
        <div class="ach-group-header">
          <div class="ach-group-title">
            <span class="ach-group-icon">${icon("gamepad-2", 14)}</span>
            <span class="ach-group-heading">Ana Oyun</span>
            <span class="ach-group-badge ${baseUnlocked === baseTotal ? "complete" : ""}">${baseUnlocked}/${baseTotal} (%${basePct})</span>
          </div>
          <div class="ach-group-xp">${baseXp} XP</div>
        </div>
        <div class="ach-group-bar">
          <div class="ach-group-bar-fill gold" style="width: ${basePct}%"></div>
        </div>
        <div class="ach-cards-grid">
          ${baseItems.map((a) => renderAchievementCard(a, s)).join("")}
        </div>
      </div>
    `;
  }

  if (dlcItems.length > 0) {
    html += `
      <div class="ach-group-section dlc">
        <div class="ach-group-header">
          <div class="ach-group-title">
            <span class="ach-group-icon">${icon("package", 14)}</span>
            <span class="ach-group-heading">Ek Paketler & DLC</span>
            <span class="ach-group-badge ${dlcUnlocked === dlcTotal ? "complete" : ""}">${dlcUnlocked}/${dlcTotal} (%${dlcPct})</span>
          </div>
          <div class="ach-group-xp">${dlcXp} XP</div>
        </div>
        <div class="ach-group-bar">
          <div class="ach-group-bar-fill purple" style="width: ${dlcPct}%"></div>
        </div>
        <div class="ach-cards-grid">
          ${dlcItems.map((a) => renderAchievementCard(a, s)).join("")}
        </div>
      </div>
    `;
  }

  return html;
}

export function renderAchievementCard(a: EpicAchievementItem, s: EpicSummary): string {
  const isDemo = S.demoPlatinumApps.has(s.appName);
  const isUnlocked = a.unlocked || isDemo;
  const isHidden = a.hidden;
  const isSecretMasked = isHidden && !isUnlocked;
  const isRevealed = S.revealedAchievements.has(`${s.appName}:${a.name}`);

  const title = isSecretMasked && !isRevealed ? "Gizli Başarım" : (a.display_name || a.name);
  const desc = isSecretMasked && !isRevealed
    ? "Bu başarım gizlidir. Spoiler'ı görmek için tıklayın."
    : (a.description || "Açıklama yok.");
  const tier = getAchTier(a);
  const tierClass = tier;
  const tierIcon = icon("trophy", 11);
  const tierName = fmtTierName(tier);

  return `
    <div class="ach-card ${isUnlocked ? "unlocked" : "locked"} ${isSecretMasked ? (isRevealed ? "revealed-secret" : "hidden-secret") : ""}"
         ${isSecretMasked ? `data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" role="button" tabindex="0" title="${isRevealed ? "Tekrar gizle" : "Ayrıntıları gör"}"` : ""}>
      
      <!-- Sol: 52px İkon -->
      <div class="ach-icon-wrapper">
        ${
          isSecretMasked && !isRevealed
            ? `<div class="ach-mystery-box">${icon("lock", 20)}</div>`
            : a.icon_link
              ? `<img class="ach-art" src="${esc(a.icon_link)}" alt="" loading="lazy" />`
              : `<div class="ach-fallback-icon">${icon("trophy", 20)}</div>`
        }
        ${!isUnlocked && (!isSecretMasked || isRevealed) ? `<div class="ach-locked-badge">${icon("lock", 12)}</div>` : ""}
      </div>

      <!-- Orta: Başlık & Açıklama & Meta -->
      <div class="ach-content">
        <div class="ach-title-row">
          <span class="ach-name">${isSecretMasked && !isRevealed ? icon("lock", 11) + " " : ""}${esc(title)}</span>
          ${
            isSecretMasked
              ? (isRevealed
                  ? `<button class="ach-reveal-btn revealed" data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" title="Spoilerı tekrar gizle">${icon("eye-off", 10)} Gizle</button>`
                  : `<button class="ach-reveal-btn" data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" title="Spoilerı göster">${icon("eye", 10)} Göster</button>`)
              : isHidden && isUnlocked
                ? `<span class="ach-pill secret">${icon("lock", 9)} Gizli</span>`
                : ""
          }
          ${!a.is_base ? `<span class="ach-pill dlc">${icon("package", 9)} DLC</span>` : ""}
        </div>

        <p class="ach-description">${esc(desc)}</p>

        <div class="ach-meta-row">
          <span class="ach-pill tier ${tierClass}">${tierIcon} ${esc(tierName)}</span>
          ${a.unlock_date && isUnlocked ? `<span class="ach-pill date">${fmtAchDate(a.unlock_date)}</span>` : ""}
          ${a.rarity?.percent != null && a.rarity.percent < 10 ? `
            <span class="ach-pill rarity ultra-rare">
              ${icon("sparkles", 10)} %${a.rarity.percent.toFixed(1)} Nadir
            </span>` : ""}
        </div>
      </div>

      <!-- Sağ: XP & Durum -->
      <div class="ach-aside">
        <div class="ach-xp-chip ${isUnlocked ? "unlocked" : "locked"}">+${a.xp} XP</div>
        ${isUnlocked
          ? `<div class="ach-status-icon earned" title="Kazanıldı">${icon("check", 13)}</div>`
          : `<div class="ach-status-icon locked" title="Kilitli">${icon("lock", 12)}</div>`
        }
      </div>
    </div>
  `;
}

export function fmtTierName(name: string): string {
  const n = name.toLowerCase().trim();
  if (n === "bronze") return "Bronz";
  if (n === "silver") return "Gümüş";
  if (n === "gold") return "Altın";
  if (n === "platinum") return "Platin";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function getHardwareIcon(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("os") || t.includes("işletim") || t.includes("windows") || t.includes("system")) return icon("layers", 13);
  if (t.includes("processor") || t.includes("işlemci") || t.includes("cpu")) return icon("cpu", 13);
  if (t.includes("memory") || t.includes("bellek") || t.includes("ram")) return icon("server", 13);
  if (t.includes("storage") || t.includes("depolama") || t.includes("disk") || t.includes("hdd") || t.includes("ssd") || t.includes("space")) return icon("hard-drive", 13);
  if (t.includes("graphics") || t.includes("ekran") || t.includes("gpu") || t.includes("video") || t.includes("direct")) return icon("monitor", 13);
  if (t.includes("sound") || t.includes("ses") || t.includes("audio")) return icon("volume-2", 13);
  if (t.includes("net") || t.includes("ağ") || t.includes("broadband") || t.includes("internet")) return icon("globe", 13);
  return icon("shield", 13);
}

export function getHardwareLabel(title: string): string {
  const t = title.toLowerCase().trim();
  if (t.includes("os") || t.includes("işletim")) return "İşletim Sistemi";
  if (t.includes("processor") || t.includes("işlemci") || t.includes("cpu")) return "İşlemci (CPU)";
  if (t.includes("memory") || t.includes("bellek") || t.includes("ram")) return "Bellek (RAM)";
  if (t.includes("storage") || t.includes("depolama") || t.includes("space")) return "Depolama Alanı";
  if (t.includes("graphics") || t.includes("ekran") || t.includes("gpu")) return "Ekran Kartı (GPU)";
  if (t.includes("direct")) return "DirectX Sürümü";
  if (t.includes("sound") || t.includes("ses") || t.includes("audio")) return "Ses Kartı";
  if (t.includes("net") || t.includes("ağ") || t.includes("internet")) return "İnternet / Ağ Bağlantısı";
  if (t.includes("other") || t.includes("ek")) return "Ek Gereksinimler";
  return title;
}

export function isWinSys(type: string): boolean {
  const s = type.toLowerCase();
  return s.includes("win") || s.includes("pc");
}

export function isMacSys(type: string): boolean {
  const s = type.toLowerCase();
  return s.includes("mac") || s.includes("osx") || s.includes("apple");
}

export function renderBackupListHtml(appName: string): string {
  const list = S.gameBackupsMap.get(appName) || [];
  if (list.length === 0) {
    return `<div style="color:#64748b;font-size:12px;padding:6px 0">Henüz yerel kayıt yedeği alınmamış.</div>`;
  }
  return list
    .map(
      (b) => `
    <div class="backup-item">
      <div class="backup-item-meta">
        <span class="backup-item-title">${esc(b.formatted_date)}</span>
        <span class="backup-item-sub">${b.file_count} dosya • ${fmtBytes(b.size_bytes)}</span>
      </div>
      <div class="backup-item-actions">
        <button class="btn ghost small" data-act="manage-restore-backup" data-id="${esc(appName)}" data-bid="${esc(b.id)}" title="Bu Yedeği Geri Yükle">
          Geri Yükle
        </button>
        <button class="btn ghost small" data-act="manage-delete-backup" data-id="${esc(appName)}" data-bid="${esc(b.id)}" title="Yedeği Sil" style="color:#ef4444">
          ${icon("trash", 12)}
        </button>
      </div>
    </div>
  `
    )
    .join("");
}


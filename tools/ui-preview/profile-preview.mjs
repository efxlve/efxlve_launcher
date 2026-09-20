/* eslint-disable */
// Profil sayfası tasarım önizlemesi üretici — gerçek src/styles.css'ten beslenir.
// Kullanım: node tools/ui-preview/profile-preview.mjs
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dir = path.join(process.env.TEMP || "", "efx-profile-preview");
fs.mkdirSync(dir, { recursive: true });

const css = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
const rootBlock = (css.match(/:root \{[\s\S]*?\n\}/) || [""])[0];
const start = css.indexOf("/* --- Profil");
const altStart = css.indexOf(".profile-container");
const s = start >= 0 ? start : altStart;
if (s < 0) throw new Error("profil bolumu bulunamadi");
const after = css.slice(s + 10);
const m = after.match(/\n\/\* --- [A-ZÇĞİÖŞÜ]/);
const end = m ? s + 10 + m.index : css.length;
const block = css.slice(s, end);

const P = {
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  "gamepad-2": '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
};
const icon = (n, sz) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[n] || ""}</svg>`;
const plat = (sz) =>
  `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none"><path d="M7 3h10v3a5 5 0 0 1-10 0V3Z" fill="url(#g)" stroke="#d8b4fe" stroke-width="1"/><path d="M7 4H4.5a2.5 2.5 0 0 0 2.6 4.5M17 4h2.5a2.5 2.5 0 0 1-2.6 4.5" stroke="#d8b4fe" stroke-width="1.2" fill="none"/><path d="M12 11v3" stroke="#d8b4fe" stroke-width="1.2"/><path d="M8.5 21h7l-1-4h-5l-1 4Z" fill="url(#g)" stroke="#d8b4fe" stroke-width="1"/><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7e22ce"/><stop offset="1" stop-color="#e9d5ff"/></linearGradient></defs></svg>`;
function gameCard(title, unlocked, total, xp, maxXp, pct, isPlat, tags) {
  return `
    <div class="ps5-profile-game-card ${isPlat ? "platinum" : ""}" tabindex="0">
      <div class="ps5-card-backdrop" style="background-image:linear-gradient(120deg,#2a1b4a,#0e1530)"></div>
      <div class="ps5-card-backdrop-overlay"></div>
      <div class="ps5-card-inner">
        <div class="ps5-card-poster-wrap">
          <div class="ps5-card-poster-empty">${icon("gamepad-2", 28)}</div>
          ${isPlat ? `<div class="ps5-card-plat-badge">${plat(15)}</div>` : ""}
        </div>
        <div class="ps5-card-info">
          <div class="ps5-card-header-row">
            <div class="ps5-card-title-col">
              <h3 class="ps5-card-title">${title}</h3>
              <div class="ps5-card-tags">${tags || ""}</div>
            </div>
          </div>
          <div class="ps5-card-progress-section">
            <div class="ps5-card-progress-labels">
              <span class="ps5-card-progress-left">${isPlat ? plat(12) : icon("trophy", 12)} <strong>${unlocked}</strong> / ${total} Kupa</span>
              <span class="ps5-card-xp">${icon("sparkles", 11)} <strong>${xp.toLocaleString("tr")}</strong> / ${maxXp.toLocaleString("tr")} XP</span>
            </div>
            <div class="ps5-card-progress-track"><div class="ps5-card-progress-fill ${isPlat ? "plat" : ""}" style="width:${pct}%"></div></div>
          </div>
        </div>
        <div class="ps5-card-right">
          <div class="ps5-card-percent-badge ${isPlat ? "plat" : ""}">
            <span class="ps5-card-percent">%${pct}</span>
            <span class="ps5-card-percent-sub">${isPlat ? "Tamamlandı" : "İlerleme"}</span>
          </div>
          <div class="ps5-card-chevron">${icon("chevron-right", 16)}</div>
        </div>
      </div>
    </div>`;
}

const page = [
'<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>',
rootBlock, block,
'html,body{margin:0;background:#0b0c10;font-family:"Segoe UI",system-ui,sans-serif}',
'body{padding:26px 30px}',
'.status-dot{width:6px;height:6px;border-radius:50%;background:#34d399}',
'*{transition:none !important;animation:none !important}',
'</style></head><body>',
'<div class="profile-container ps5-profile-page">',
'<div class="ps5-profile-hero">',
'<div class="ps5-hero-backdrop" style="background-image:linear-gradient(120deg,#1d1240,#0c1433)"></div>',
'<div class="ps5-hero-gradient"></div><div class="ps5-hero-ambient-lights"></div>',
'<div class="ps5-hero-content"><div class="ps5-hero-left">',
'<div class="ps5-avatar-wrap"><div class="ps5-avatar"><span class="ps5-avatar-letter">E</span></div><div class="ps5-avatar-ring"></div><span class="ps5-avatar-pip online"></span></div>',
'<div class="ps5-hero-meta">',
'<div class="ps5-hero-name-row"><h1 class="ps5-display-name">Efxlve</h1><span class="ps5-status-badge online"><span class="status-dot"></span> Epic Games Bağlı</span></div>',
'<div class="ps5-level-capsule"><div class="ps5-level-crest">' + '__PLAT13__' + '<span class="ps5-level-num">SEVİYE 14</span></div>',
'<div class="ps5-level-progress-col"><div class="ps5-level-labels"><span class="ps5-level-percent">%77</span><span class="ps5-level-remaining">Sonraki seviyeye 235 XP</span></div><div class="ps5-level-track"><div class="ps5-level-fill" style="width:77%"></div></div></div></div>',
'<div class="ps5-hero-sub-row">',
'<span class="ps5-sub-item">' + '__GP12__' + ' 519 Oyun</span><span class="ps5-sub-dot">•</span>',
'<span class="ps5-sub-item">' + '__CLK12__' + ' 12 dk</span><span class="ps5-sub-dot">•</span>',
'<span class="ps5-sub-item">' + '__TR12__' + ' 631 Kupa</span><span class="ps5-sub-dot">•</span>',
'<button class="ps5-id-btn"><span>ID Kopyala</span>' + '__CPY11__' + '</button>',
'</div></div></div>',
'<div class="ps5-hero-right">',
'<div class="ps5-trophy-tier-showcase">',
'<div class="ps5-tier-col plat"><div class="ps5-tier-icon">' + '__PLAT16__' + '</div><span class="ps5-tier-count">3</span><span class="ps5-tier-label">Platin</span></div>',
'<div class="ps5-tier-divider"></div>',
'<div class="ps5-tier-col gold"><div class="ps5-tier-icon">' + '__TR16__' + '</div><span class="ps5-tier-count">50</span><span class="ps5-tier-label">Altın</span></div>',
'<div class="ps5-tier-divider"></div>',
'<div class="ps5-tier-col silver"><div class="ps5-tier-icon">' + '__TR16b__' + '</div><span class="ps5-tier-count">138</span><span class="ps5-tier-label">Gümüş</span></div>',
'<div class="ps5-tier-divider"></div>',
'<div class="ps5-tier-col bronze"><div class="ps5-tier-icon">' + '__TR16c__' + '</div><span class="ps5-tier-count">440</span><span class="ps5-tier-label">Bronz</span></div>',
'</div>',
'<div class="ps5-hero-actions-row">',
'<div class="ps5-xp-capsule">' + '__SPK13__' + '<span><strong>13.765</strong> Toplam XP</span></div>',
'<button class="btn ghost small ps5-refresh-btn">' + '__RFR13__' + '<span>Profili Yenile</span></button>',
'</div></div></div></div>',
'<div class="profile-games-section"><div class="profile-games-header">',
'<div class="profile-games-title-group"><h2 class="profile-section-title">Kupa Vitrini &amp; Oyun İlerlemesi</h2><span class="profile-section-badge">4 Oyun</span></div>',
'<div class="profile-toolbar"><div class="profile-filter-pills">',
'<button class="profile-pill active">' + '__TR12b__' + ' Tümü (23)</button>',
'<button class="profile-pill">' + '__PLAT12__' + ' Platin (3)</button>',
'<button class="profile-pill">' + '__CLK12b__' + ' Devam Edenler (17)</button>',
'<button class="profile-pill">' + '__GP12b__' + ' Başlanmayanlar (3)</button>',
'</div><div class="profile-toolbar-right"><div class="profile-search-wrap"><span class="profile-search-icon">' + '__SRC13__' + '</span><input type="text" class="profile-search-input" placeholder="Başarım veya oyun ara…" /></div></div></div></div>',
'<div class="profile-games-grid">',
gameCard("Star Wars: Jedi Fallen Order", 39, 39, 1000, 1000, 100, true, ""),
gameCard("Cyberpunk 2077 - REDmod", 50, 57, 1300, 1500, 88, false, '<span class="profile-game-tag installed">● Yüklü</span>'),
gameCard("Dead by Daylight", 195, 296, 4975, 7140, 66, false, '<span class="profile-game-tag installed">● Yüklü</span><span class="profile-game-tag playtime">' + icon("clock", 10) + ' 11 dk</span>'),
gameCard("Rocket League", 58, 88, 595, 1000, 66, false, ""),
'</div></div></div></body></html>'
].join("\n")
const rep = {__PLAT13__:plat(13),__PLAT16__:plat(16),__PLAT12__:plat(12),__GP12__:icon("gamepad-2",12),__GP12b__:icon("gamepad-2",12),__CLK12__:icon("clock",12),__CLK12b__:icon("clock",12),__TR12__:icon("trophy",12),__TR12b__:icon("trophy",12),__TR16__:icon("trophy",16),__TR16b__:icon("trophy",16),__TR16c__:icon("trophy",16),__CPY11__:icon("copy",11),__SPK13__:icon("sparkles",13),__RFR13__:icon("refresh",13),__SRC13__:icon("search",13)};
let out = page;
for (const k of Object.keys(rep)) out = out.split(k).join(rep[k]);
const outFile = path.join(dir, "profile.html");
fs.writeFileSync(outFile, out);
console.log("OK " + outFile);

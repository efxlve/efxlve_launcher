/**
 * Changelog modal view.
 * Displays release history, newly added features, improvements, and bug fixes.
 */

import { changelogRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { currentLanguage, t } from "../../i18n";

export interface ChangelogText {
  en: string;
  tr: string;
}

export interface ChangelogRelease {
  version: string;
  date: string;
  isCurrent?: boolean;
  added?: ChangelogText[];
  improved?: ChangelogText[];
  fixed?: ChangelogText[];
}

export const CHANGELOG_DATA: ChangelogRelease[] = [
  {
    version: "0.1.16",
    date: "2026-09-28",
    isCurrent: true,
    added: [
      {
        en: "GOG.COM & GOG Galaxy integration: OAuth2 login, unified library, DRM-free downloads, and cloud saves.",
        tr: "GOG.COM & GOG Galaxy entegrasyonu: OAuth2 girişi, birleşik kütüphane, DRM-free indirmeler ve bulut kayıtları.",
      },
      {
        en: "GOG GamesDB integration: crystal clear vertical box art portraits and 1600px panoramic hero banners.",
        tr: "GOG GamesDB entegrasyonu: kristal netliğinde dikey kutu afişleri ve 1600px panoramik hero görselleri.",
      },
      {
        en: "GOG Gameplay API: full achievements support with rarity percentages, tier cups, and unlock status.",
        tr: "GOG Gameplay API: nadirlik oranları, kupa seviyeleri ve kilit durumuyla tam başarım desteği.",
      },
      {
        en: "Multi-store game deduplication with in-page version switcher (Epic / GOG) for owned duplicates.",
        tr: "Çift oyunları tekil kartta birleştirme ve oyun sayfasında sürüm değiştirici (Epic / GOG).",
      },
      {
        en: "Store selector dropdown menu (Store: All / Epic / GOG) on the library toolbar.",
        tr: "Kütüphane araç çubuğunda açılır mağaza seçim menüsü (Mağaza: Tümü / Epic / GOG ⌄).",
      },
      {
        en: "Collections dropdown tab in the filter bar with per-collection item counters.",
        tr: "Filtre satırında sayaçlı ve filtre temizleme seçenekli açılır Koleksiyonlar menüsü.",
      },
      {
        en: "Hardware-accelerated sliding indicator animation on the store switcher buttons.",
        tr: "Mağaza geçiş düğmelerinde donanım hızlandırmalı kayan gösterge animasyonu.",
      },
      {
        en: "Interactive titlebar version pill with release changelog viewer.",
        tr: "Pencere çubuğunda etkileşimli BETA sürüm hapı ve Değişiklik Günlüğü penceresi.",
      },
    ],
    improved: [
      {
        en: "Store-agnostic system requirements (Windows Minimum and Recommended specifications) across all stores.",
        tr: "Mağazadan bağımsız sistem gereksinimleri (Windows Asgari ve Önerilen donanım tabloları).",
      },
      {
        en: "Instant 0ms store switching with persistent background dual-webviews.",
        tr: "Arka planda korunan çift webview mimarisiyle 0 ms anlık mağaza geçişi.",
      },
      {
        en: "Refined tray minimization while downloads or game sessions are active in the background.",
        tr: "İndirme ve oyun oturumları sırasında sistem tepsisine küçültme ve arka plan desteği.",
      },
    ],
    fixed: [
      {
        en: "Fixed GOG achievements not reflecting in library portrait cards and cover stats.",
        tr: "GOG başarımlarının kütüphane portre kartlarında görünmeme sorunu giderildi.",
      },
      {
        en: "Fixed cropped title text on GOG covers (e.g. 'CONTRO', 'ABSOLU DRIFT').",
        tr: "GOG kapaklarındaki kesilmiş başlık metinleri düzeltildi.",
      },
      {
        en: "Fixed low-resolution stretched background art on GOG game detail pages.",
        tr: "GOG detay sayfalarındaki bulanık ve pikselleşmiş arka plan görselleri düzeltildi.",
      },
      {
        en: "Enhanced 15-second heartbeat crash recovery for game playtime tracking.",
        tr: "Oynanış süresi takibi için 15 saniyelik kalp atışlı çökme ve kapanma kurtarma sistemi.",
      },
    ],
  },
  {
    version: "0.1.15",
    date: "2026-09-25",
    added: [
      {
        en: "Live game descriptions fetched directly from official store APIs with Wikipedia and IGDB fallbacks.",
        tr: "Wikipedia ve IGDB yedekleriyle birlikte doğrudan mağaza API'lerinden canlı oyun açıklamaları.",
      },
      {
        en: "Combined server-side playtime sync with local session tracking.",
        tr: "Sunucu taraflı oyun süresi senkronizasyonu ile yerel oturum kayıtlarının birleştirilmesi.",
      },
    ],
    improved: [
      {
        en: "Streamlined codebase: removed deprecated third-party integrations and cleaned up translation keys.",
        tr: "Kod tabanı sadeleştirmesi: kullanılmayan entegrasyonlar ve çeviri anahtarları temizlendi.",
      },
    ],
  },
  {
    version: "0.1.12",
    date: "2026-09-22",
    added: [
      {
        en: "Optional library pagination (24, 48, 96 games per page) in Appearance settings.",
        tr: "Görünüm ayarlarında isteğe bağlı kütüphane sayfalama seçeneği (sayfa başına 24, 48, 96 oyun).",
      },
      {
        en: "SteamGridDB custom portrait and hero artwork manager with instant reset.",
        tr: "Anında sıfırlama özellikli SteamGridDB özel portre ve yatay afiş yöneticisi.",
      },
      {
        en: "Screenshot gallery with folder migration support.",
        tr: "Klasör taşıma ve yönetme destekli oyun ekran görüntüsü galerisi.",
      },
    ],
  },
  {
    version: "0.1.11",
    date: "2026-09-18",
    added: [
      {
        en: "Epic Online Services (EOS) status detection and overlay check.",
        tr: "Epic Online Services (EOS) durum tespiti ve oyun içi overlay kontrolü.",
      },
      {
        en: "Resumable download manager for interrupted, paused, or network-failed game downloads.",
        tr: "Yarım kalan, duraklatılan veya kesilen oyun indirmeleri için kaldığı yerden devam etme yöneticisi.",
      },
    ],
  },
  {
    version: "0.1.10",
    date: "2026-09-15",
    added: [
      {
        en: "Batch library game hiding with selective management modal.",
        tr: "Toplu seçim penceresiyle çoklu oyun gizleme ve yönetme desteği.",
      },
      {
        en: "Profile trophy privacy controls and Platinum rank showcase.",
        tr: "Profil kupa gizlilik kontrolleri ve Platin kupa vitrini.",
      },
    ],
  },
];

function pickText(item: ChangelogText): string {
  if (currentLanguage() === "tr") return item.tr;
  return item.en;
}

function renderGroup(title: string, items: ChangelogText[] | undefined): string {
  if (!items || items.length === 0) return "";
  return `
    <div class="changelog-group">
      <span class="changelog-group-label">${esc(title)}</span>
      <ul class="changelog-list">
        ${items.map((item) => `<li>${esc(pickText(item))}</li>`).join("")}
      </ul>
    </div>`;
}

export function openChangelogModal(): void {
  renderChangelogModal();
}

export function closeChangelogModal(): void {
  if (changelogRoot) changelogRoot.innerHTML = "";
}

export function renderChangelogModal(): void {
  if (!changelogRoot) return;

  const currentVersion = S.appVersion || "0.1.16";

  const releasesHtml = CHANGELOG_DATA.map((rel) => {
    const isCurrent = rel.isCurrent || rel.version === currentVersion;
    return `
      <div class="changelog-release">
        <div class="changelog-rel-header">
          <div class="changelog-rel-title">
            <span class="changelog-ver">v${esc(rel.version)}</span>
            ${isCurrent ? `<span class="changelog-tag current">${esc(t("changelog.current"))}</span>` : ""}
          </div>
          <span class="changelog-date">${esc(rel.date)}</span>
        </div>
        ${renderGroup(t("changelog.added"), rel.added)}
        ${renderGroup(t("changelog.improved"), rel.improved)}
        ${renderGroup(t("changelog.fixed"), rel.fixed)}
      </div>`;
  }).join("");

  changelogRoot.innerHTML = `
    <div class="modal-backdrop changelog-backdrop" data-act="changelog-backdrop">
      <div class="modal-box changelog-dialog" role="dialog" aria-modal="true" data-changelog-dialog>
        <div class="changelog-head">
          <div class="changelog-head-text">
            <h2>${esc(t("changelog.title"))}</h2>
            <span class="changelog-head-badge">v${esc(currentVersion)}</span>
          </div>
          <button type="button" class="col-modal-close" data-act="close-changelog-modal" title="${esc(t("common.close"))}">
            ${icon("x", 16)}
          </button>
        </div>
        <div class="changelog-body">
          ${releasesHtml}
        </div>
      </div>
    </div>`;
}

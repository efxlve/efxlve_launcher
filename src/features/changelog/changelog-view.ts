/**
 * Changelog modal view.
 * Displays release history, newly added features, improvements, and bug fixes.
 */

import { changelogRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { currentLanguage, t } from "../../i18n";
import { holdStoreOverlay, releaseStoreOverlay } from "../store/store-view";

export interface ChangelogText {
  en: string;
  tr: string;
}

export interface ChangelogRelease {
  version: string;
  date: string;
  isCurrent?: boolean;
  items?: ChangelogText[];
  added?: ChangelogText[];
  improved?: ChangelogText[];
  fixed?: ChangelogText[];
}

export const CHANGELOG_DATA: ChangelogRelease[] = [
  {
    version: "0.1.20",
    date: "2026-10-01",
    isCurrent: true,
    fixed: [
      {
        en: "Opening notifications on the store keeps the store page where it is. The list sits on top of it.",
        tr: "Mağaza sekmesinde bildirimleri açmak mağaza sayfasını kapatmaz veya kaydırmaz. Liste sayfanın üstünde durur.",
      },
      {
        en: "Restoring the launcher from the taskbar no longer flashes from a tiny window to fullscreen.",
        tr: "Launcher görev çubuğundan geri açılınca küçük bir pencereden tam ekrana zıplamaz.",
      },
      {
        en: "Settings lists the Steam client, not every installed Steam game.",
        tr: "Ayarlar her Steam oyununu değil, Steam istemcisini listeler.",
      },
      {
        en: "A Steam game that has already finished downloading is no longer shown as downloading.",
        tr: "İndirmesi bitmiş bir Steam oyunu artık indiriliyor olarak görünmez.",
      },
    ],
  },
  {
    version: "0.1.19",
    date: "2026-10-01",
    items: [
      {
        en: "Personal Cloud Save Backup: seamlessly back up and restore game saves with Google Drive (OAuth 2.0 PKCE) and WebDAV.",
        tr: "Kişisel Bulut Kayıt Yedeği: oyun save'lerinizi Google Drive (OAuth 2.0 PKCE) ve WebDAV ile tek tıkla veya otomatik yedekleyin ve geri yükleyin.",
      },
      {
        en: "Resumable Upload Engine: large save archives (e.g. 250MB+ Cyberpunk saves) upload reliably with Google Drive's resumable chunked protocol.",
        tr: "Kesintisiz Yükleme Motoru: 250MB+ boyutundaki büyük save dosyaları Google Drive Resumable protokolüyle kopmadan güvenle yüklenir.",
      },
      {
        en: "Multi-Version History: inspect full backup history per game with timestamps, sizes, and separate Restore and Delete actions.",
        tr: "Çoklu Sürüm Geçmişi: her oyun için alınan tüm yedekleri zaman damgası ve boyutlarıyla listeleyin; bağımsız Geri Yükle ve Sil butonlarıyla yönetin.",
      },
      {
        en: "Bring Your Own Credentials (BYOC): fully independent Google Cloud setup with zero developer fees, zero user caps, and isolated appData sandboxing.",
        tr: "Topluluk için Bağımsız Bulut (BYOC): kurumsal onay veya kullanıcı limiti olmadan, kişisel Google Cloud anahtarlarınız ve gizli appData alanı ile %100 gizli kullanım.",
      },
      {
        en: "In-App Setup Guide & Documentation: interactive parameter guide modal and comprehensive setup documentation.",
        tr: "Uygulama İçi Kurulum Rehberi ve Dokümantasyon: adım adım yardımcı modal ve kapsamlı açık kaynak kurulum dokümantasyonu.",
      },
    ],
  },
  {
    version: "0.1.18",
    date: "2026-10-01",
    items: [
      {
        en: "Steam: sign in with your password, Steam Guard or a QR code, then browse the whole owned library — covers, playtime, achievements, add-ons, screenshots and downloads — and switch saved accounts without signing in again.",
        tr: "Steam: parola, Steam Guard veya QR koduyla giriş yapın ve sahip olduğunuz kütüphanenin tamamına bakın — kapaklar, oynama süresi, başarımlar, eklentiler, ekran görüntüleri ve indirmeler — kayıtlı hesaplar arasında yeniden giriş yapmadan geçin.",
      },
      {
        en: "TV Mode is back as a fullscreen console shell: controller navigation, an on-screen keyboard, a profile dashboard, and the app icon on the boot screen.",
        tr: "TV Modu tam ekran bir konsol kabuğu olarak geri döndü: kontrolcüyle gezinme, ekran klavyesi, profil paneli ve açılışta uygulama ikonu.",
      },
      {
        en: "Seven storefronts in one window: Epic Games, GOG, Steam, Xbox (PC games only), Battle.net, Ubisoft and EA, with each store's own logo on the Accounts page.",
        tr: "Tek pencerede yedi mağaza: Epic Games, GOG, Steam, Xbox (yalnız PC oyunları), Battle.net, Ubisoft ve EA; Hesaplar sayfasında her mağazanın kendi logosu.",
      },
      {
        en: "EA App, Ubisoft Connect and Xbox installs are detected, and launching them is handed to those clients.",
        tr: "EA App, Ubisoft Connect ve Xbox kurulumları tespit edilir; başlatma o istemcilere bırakılır.",
      },
      {
        en: "Games from every saved account show up in one library, with a one-click switch to the account that owns them.",
        tr: "Kayıtlı her hesabın oyunları tek kütüphanede görünür; oyunun sahibi olan hesaba tek tıkla geçilir.",
      },
      {
        en: "Startup is much faster on large libraries, and the controller hint bar follows the pad you actually have plugged in.",
        tr: "Büyük kütüphanelerde açılış çok daha hızlı, kontrolcü ipucu çubuğu ise takılı olan pad'e göre değişiyor.",
      },
      {
        en: "Fixes: stopping a game no longer blanks the launcher, and the light blue line along the bottom of TV Mode is gone.",
        tr: "Düzeltmeler: bir oyunu durdurmak başlatıcıyı artık boşaltmıyor ve TV Modu'nun altındaki açık mavi çizgi kalktı.",
      },
      {
        en: "More bugs added.",
        tr: "Daha fazla hata eklendi.",
      },
    ],
  },
  {
    version: "0.1.17",
    date: "2026-09-28",
    items: [
      {
        en: "GOG.COM support: connect your account under Accounts and use one library for both stores — install, verify, import, uninstall and launch DRM-free GOG games, with official store descriptions, hero art, covers and achievements.",
        tr: "GOG.COM desteği: hesabınızı Hesaplar sayfasından bağlayın ve iki mağaza için tek kütüphane kullanın — GOG oyunlarını kurun, doğrulayın, içe aktarın, kaldırın ve DRM-free başlatın; resmi mağaza açıklamaları, hero görselleri, kapaklar ve başarımlarla.",
      },
      {
        en: "GOG Galaxy integration: games installed by Galaxy are detected and imported, update checks compare installed builds, and hours played in Galaxy are imported.",
        tr: "GOG Galaxy entegrasyonu: Galaxy ile kurulmuş oyunlar tespit edilip içe aktarılır, güncelleme kontrolü kurulu sürümleri karşılaştırır ve Galaxy'de oynanan süreler içe aktarılır.",
      },
      {
        en: "Multi-account switcher for both stores, with saved sessions, per-account avatars and a sidebar account panel.",
        tr: "İki mağaza için çoklu hesap değiştirici: kayıtlı oturumlar, hesap başına avatarlar ve kenar çubuğu hesap paneli.",
      },
      {
        en: "Cloud save backup: archive saves to your own WebDAV server or Google Drive, list, restore or delete backups per game, and upload automatically when a game closes.",
        tr: "Bulut kayıt yedekleme: kayıtları kendi WebDAV sunucunuza veya Google Drive'a arşivleyin; oyun başına yedekleri listeleyin, geri yükleyin veya silin ve oyun kapanınca otomatik yükleyin.",
      },
      {
        en: "Notification center, per-game update indicators you can dismiss, and a reworked settings panel with download profiles, CDN selection, screenshot options and scheduled updates.",
        tr: "Bildirim merkezi, susturulabilen oyun bazlı güncelleme göstergeleri ve indirme profilleri, CDN seçimi, ekran görüntüsü ayarları ve zamanlanmış güncellemelerle yenilenen ayarlar paneli.",
      },
      {
        en: "Launcher self-update: new versions download silently in the background and install only when you ask; installation defers while a download or a game session is running.",
        tr: "Başlatıcı otomatik güncelleme: yeni sürümler arka planda sessizce indirilir ve yalnızca siz istediğinizde kurulur; indirme veya oyun oturumu sürerken kurulum ertelenir.",
      },
      {
        en: "Fixes: desktop shortcuts now start games through the launcher, so Epic titles no longer open and close immediately; collections can be reordered again and a failed cloud upload is reported.",
        tr: "Düzeltmeler: masaüstü kısayolları oyunları artık launcher üzerinden başlatır, Epic oyunları açılıp hemen kapanmaz; koleksiyonlar yeniden sıralanabilir ve başarısız bulut yüklemesi bildirilir.",
      },
      {
        en: "Cleanup: the TV Mode entry was removed from Settings, retired handlers, styles and translation keys were deleted, and all 15 languages are complete (1305 keys).",
        tr: "Temizlik: TV Modu girdisi Ayarlar'dan kaldırıldı, kullanılmayan işleyiciler, stiller ve çeviri anahtarları silindi; 15 dilin tamamı eksiksiz (1305 anahtar).",
      },
      {
        en: "More bugs added.",
        tr: "Daha fazla hata eklendi.",
      },
    ],
  },
  {
    version: "0.1.16",
    date: "2026-09-27",
    items: [
      {
        en: "Playtime is now counted even if you close the launcher window while a game is running: the window hides to the tray (exactly like an active download) and the session keeps going.",
        tr: "Oyun çalışırken başlatıcı penceresi kapatılsa bile oynama süresi sayılmaya devam eder: pencere sistem tepsisine gizlenir (tıpkı etkin bir indirme gibi) ve oturum sürer.",
      },
      {
        en: "If the launcher is closed by hand, restarted for an update or crashes mid-session, the measured time is recovered on the next start instead of being lost.",
        tr: "Başlatıcı elle kapatılırsa, bir güncelleme için yeniden başlatılırsa veya oturum ortasında çökerse, ölçülen süre kaybolmak yerine bir sonraki açılışta kurtarılır.",
      },
      {
        en: "The playtime explanation in Properties now says exactly that: sessions are counted here, Epic's own hours are merged in when Epic has them for that game, and not every game reports to Epic.",
        tr: "Özellikler'deki oynama süresi açıklaması güncellendi: oturumlar burada sayılır, Epic'in ilgili oyun için saati varsa birleştirilir ve her oyun Epic'e raporlama yapmaz.",
      },
    ],
  },
  {
    version: "0.1.15",
    date: "2026-09-26",
    items: [
      {
        en: "\"About the game\" now comes from the game's own store first (Epic) and falls back to Wikipedia. Source attribution line specifies \"Source: Epic Games Store\" or \"Current source: Wikipedia\" (strictly verified video game articles only).",
        tr: "\"Oyun hakkında\" bölümü artık önce oyunun kendi mağazasından (Epic) alınır ve bulunamazsa Wikipedia'ya başvurulur. Kaynak satırı \"Kaynak: Epic Games Store\" veya \"Geçerli kaynak: Wikipedia\" olarak belirtilir (yalnızca doğrulanabilir video oyunu makaleleri kabul edilir).",
      },
      {
        en: "New Search on IGDB button under the description opens the game on IGDB in your browser without needing an account or API key.",
        tr: "Açıklamanın altındaki yeni \"IGDB'de Ara\" düğmesi oyunu tarayıcınızda açar (hesap veya API anahtarı gerekmez).",
      },
      {
        en: "Real playtime: hours are read from Epic's playtime service and merged with local tracking, displaying on library covers, profile totals, and most-played sorting.",
        tr: "Gerçek oynama süresi: saatler Epic'in servisinden okunur ve yerel takiple birleştirilir; kütüphane kapaklarında, profil toplamında ve en çok oynananlar sıralamasında gösterilir.",
      },
      {
        en: "A quiet loading spinner is displayed while descriptions are fetching instead of showing \"no description\".",
        tr: "Açıklama yüklenirken \"açıklama yok\" uyarısı yerine sessiz bir yükleme göstergesi görüntülenir.",
      },
      {
        en: "Cleanups: removed deprecated overview components, styles, and 20 unused translation keys while keeping all 15 languages complete.",
        tr: "Temizlik: 15 dilin tamamı eksiksiz tutularak kullanılmayan genel bakış bileşenleri, stilleri ve 20 atıl çeviri anahtarı temizlendi.",
      },
    ],
  },
  {
    version: "0.1.14",
    date: "2026-09-26",
    items: [
      {
        en: "Library cover grows smoothly on hover and shrinks cleanly when pointer leaves without clipping contain boundaries.",
        tr: "Kütüphane kapağı imleç üzerine geldiğinde akıcı bir şekilde büyür ve imleç ayrıldığında kırpılma olmadan temiz bir şekilde küçülür.",
      },
    ],
  },
  {
    version: "0.1.13",
    date: "2026-09-26",
    items: [
      {
        en: "Fast account switching: switches accounts without full logout, displaying the saved library snapshot immediately while Epic updates in the background.",
        tr: "Hızlı hesap değiştirme: tam çıkış yapmadan hesaplar arası geçiş yapılır, Epic listesi arka planda güncellenirken kaydedilmiş kütüphane anında gösterilir.",
      },
    ],
  },
  {
    version: "0.1.12",
    date: "2026-09-26",
    items: [
      {
        en: "Optional library pagination: choose 24, 48, or 96 games per page in Settings > Appearance & Language to browse with page buttons.",
        tr: "İsteğe bağlı kütüphane sayfalama: Ayarlar > Görünüm ve Dil bölümünden sayfa başına 24, 48 veya 96 oyun seçilebilir.",
      },
      {
        en: "Optional titles under covers: display game title beneath each grid portrait.",
        tr: "Kapakların altında isteğe bağlı başlıklar: ızgaradaki her kapağın altında oyun adını gösterme seçeneği.",
      },
      {
        en: "Screenshots folder customization: configure custom directory with one-click migration and \"Open Folder\" button.",
        tr: "Ekran görüntüleri klasörü: klasör taşıma onayı ve \"Klasörü Aç\" butonu ile yakalama klasörünü özelleştirme.",
      },
      {
        en: "Image compression on by default: captures saved as AVIF (~1 MB instead of 10-15 MB) with WebP fallback.",
        tr: "Görsel sıkıştırma varsayılan olarak açık: yeni yakalamalar WebP yedeklemeli AVIF formatında (10-15 MB yerine ~1 MB) kaydedilir.",
      },
    ],
  },
  {
    version: "0.1.11",
    date: "2026-09-26",
    items: [
      {
        en: "Epic Online Services requirement detection with notification banner and direct installer download in Settings.",
        tr: "Epic Online Services gereksinimi tespiti: bildirim uyarısı ve Ayarlar'dan tek tıkla resmi yükleyici indirme.",
      },
      {
        en: "Resumable downloads: interrupted downloads or launcher exits resume seamlessly from saved files.",
        tr: "Kaldığı yerden devam eden indirmeler: kesilen indirmeler veya uygulama kapanışları kaydedilen dosyalardan devam eder.",
      },
      {
        en: "Epic Games Store search bar positioned conveniently above the embedded webview.",
        tr: "Epic Games Store arama kutusu gömülü mağaza görünümünün üzerinde açılır.",
      },
    ],
  },
  {
    version: "0.1.10",
    date: "2026-09-25",
    items: [
      {
        en: "Batch game hiding to hide multiple titles at once from the library.",
        tr: "Kütüphaneden birden fazla oyunu aynı anda gizlemek için toplu gizleme yöneticisi.",
      },
      {
        en: "Achievement row visibility controls and game title display on each row.",
        tr: "Başarım satırlarını gizleme ve her satırda oyun adını gösterme kontrolü.",
      },
      {
        en: "Library quick filter for installed games only.",
        tr: "Kütüphaneyi yalnızca yüklü oyunlara göre filtreleme seçeneği.",
      },
      {
        en: "Hidden games manager in Settings displaying covers, developers, and unhide options.",
        tr: "Ayarlar'da kapaklar, geliştirici bilgileri ve yeniden gösterme seçenekleriyle gizli oyunlar yöneticisi.",
      },
    ],
  },
  {
    version: "0.1.9",
    date: "2026-09-25",
    items: [
      {
        en: "Open-source desktop launcher for your Epic Games library powered by legendary CLI.",
        tr: "legendary CLI destekli, Epic Games kütüphaneniz için açık kaynaklı masaüstü başlatıcı.",
      },
      {
        en: "Single consolidated update action on game detail pages.",
        tr: "Oyun detay sayfalarında sadeleştirilmiş tekil güncelleme eylemi.",
      },
      {
        en: "Folder exclusion: skips third-party Rockstar, EA, and Ubisoft folders unless previously installed by Epic.",
        tr: "Klasör filtreleme: Epic tarafından önceden kurulmamışsa Rockstar, EA ve Ubisoft klasörlerini atlar.",
      },
      {
        en: "Automatic desktop shortcut cleanup upon game uninstall.",
        tr: "Oyun kaldırıldığında masaüstü kısayolunun otomatik temizlenmesi.",
      },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-09-24",
    items: [
      {
        en: "Signed launcher auto-update via GitHub Releases, update manager with silent background downloads, and install gating during gameplay.",
        tr: "GitHub Releases üzerinden imzalı otomatik güncelleme sistemi, sessiz arka plan indirmesi ve oyun sırasında kurulumu erteleme.",
      },
    ],
  },
];

function pickText(item: ChangelogText): string {
  if (currentLanguage() === "tr") return item.tr;
  return item.en;
}

function renderGroup(title: string | undefined, items: ChangelogText[] | undefined): string {
  if (!items || items.length === 0) return "";
  return `
    <div class="changelog-group">
      ${title ? `<span class="changelog-group-label">${esc(title)}</span>` : ""}
      <ul class="changelog-list">
        ${items.map((item) => `<li>${esc(pickText(item))}</li>`).join("")}
      </ul>
    </div>`;
}

export function openChangelogModal(): void {
  void holdStoreOverlay("changelog");
  renderChangelogModal();
}

export function closeChangelogModal(): void {
  if (changelogRoot) changelogRoot.innerHTML = "";
  releaseStoreOverlay("changelog");
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
        ${renderGroup(undefined, rel.items)}
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

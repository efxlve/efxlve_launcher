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
  items?: ChangelogText[];
  added?: ChangelogText[];
  improved?: ChangelogText[];
  fixed?: ChangelogText[];
}

export const CHANGELOG_DATA: ChangelogRelease[] = [
  {
    version: "0.1.17",
    date: "2026-09-28",
    isCurrent: true,
    items: [
      {
        en: "GOG.COM support: connect your GOG account under Accounts, browse a unified library (All / Epic / GOG), and install, verify, import, uninstall or launch DRM-free GOG games.",
        tr: "GOG.COM desteği: GOG hesabınızı Hesaplar sayfasından bağlayın, birleşik kütüphaneyi (Tümü / Epic / GOG) görüntüleyin; GOG oyunlarını kurun, doğrulayın, içe aktarın, kaldırın veya DRM-free başlatın.",
      },
      {
        en: "GOG detail pages use official data: store description, studio, 1600px hero art, GamesDB covers, Windows requirements and the full achievement list with rarity and trophy tiers.",
        tr: "GOG detay sayfaları resmi verileri kullanır: mağaza açıklaması, stüdyo, 1600px hero görseli, GamesDB kapakları, Windows gereksinimleri ve enderlik/kupa seviyeleriyle tam başarım listesi.",
      },
      {
        en: "Multi-account switcher for both stores: switch Epic or GOG sessions in one click from Settings or the new sidebar account panel; saved sessions stay signed in.",
        tr: "İki mağaza için çoklu hesap değiştirici: Ayarlar'dan veya yeni kenar çubuğu hesap panelinden tek tıkla Epic ya da GOG oturumu değiştirin; kayıtlı oturumlar açık kalır.",
      },
      {
        en: "Cloud save backup: archive and upload saves to your own WebDAV server or Google Drive, list, restore or delete backups per game, and upload automatically when a game closes.",
        tr: "Bulut kayıt yedekleme: kayıtları kendi WebDAV sunucunuza veya Google Drive'a arşivleyip yükleyin; oyun başına yedekleri listeleyin, geri yükleyin veya silin ve oyun kapanınca otomatik yükleyin.",
      },
      {
        en: "Save folder handling: automatic save-folder detection for games without Epic cloud metadata, a manual folder picker, and local backup/restore from the Manage tab.",
        tr: "Kayıt klasörü yönetimi: Epic bulut verisi olmayan oyunlar için otomatik kayıt klasörü tespiti, elle klasör seçici ve Yönet sekmesinden yerel yedekleme/geri yükleme.",
      },
      {
        en: "Uninstall is now complete: Epic Launcher manifests and leftover folders are cleaned up, so the official launcher no longer offers a phantom repair and removed games leave the Updates list immediately.",
        tr: "Kaldırma artık eksiksiz: Epic Launcher manifestleri ve artık klasörler temizlenir; resmi başlatıcı hayalet onarım önermez ve kaldırılan oyunlar Güncellemeler listesinden anında çıkar.",
      },
      {
        en: "Notification center: a bell with an unread count and persistent history for downloads, updates, backups, cloud sync failures and launcher updates.",
        tr: "Bildirim merkezi: indirmeler, güncellemeler, yedekler, bulut eşitleme hataları ve başlatıcı güncellemeleri için okunmamış sayacı ve kalıcı geçmişi olan bir zil.",
      },
      {
        en: "Per-game update indicators can be dismissed from the bell button or the right-click menu and restored later; the sidebar badge and updates list follow immediately.",
        tr: "Oyun bazlı güncelleme göstergeleri zil düğmesinden veya sağ tık menüsünden susturulup sonradan geri getirilebilir; kenar çubuğu rozeti ve güncelleme listesi anında uyum sağlar.",
      },
      {
        en: "Library: the two conflicting highlight switches became one \"Highlight installed games\" setting; optional store badges under titles, titles under covers, and a compact play badge on installed covers.",
        tr: "Kütüphane: iki çelişkili vurgulama anahtarının yerini tek \"Yüklü oyunları öne çıkar\" ayarı aldı; başlık altında isteğe bağlı mağaza rozeti, kapak altı oyun adı ve yüklü kapaklarda kompakt oynatma rozeti.",
      },
      {
        en: "Settings panel rebuilt around an account card, download speed profiles, CDN selection, screenshot format and quality, and scheduled updates; the BETA pill opens a full changelog.",
        tr: "Ayarlar paneli hesap kartı, indirme hız profilleri, CDN seçimi, ekran görüntüsü formatı ve kalitesi ile zamanlanmış güncellemeler etrafında yeniden kuruldu; BETA hapı tam değişiklik günlüğünü açar.",
      },
      {
        en: "Launcher self-update: new versions appear in Settings > System, download silently in the background and install only when you ask; installation defers while a game download or a game session is running.",
        tr: "Başlatıcı otomatik güncelleme: yeni sürümler Ayarlar > Sistem'de görünür, arka planda sessizce indirilir ve yalnızca siz istediğinizde kurulur; oyun indirmesi veya oyun oturumu sürerken kurulum ertelenir.",
      },
      {
        en: "Sign-in and download hardening: the Epic Launcher import bridge maps the modern config folder automatically, and failed or timed-out downloads show clear messages instead of raw Python output.",
        tr: "Oturum açma ve indirme sağlamlaştırması: Epic Launcher içe aktarma köprüsü modern yapılandırma klasörünü otomatik eşler; başarısız veya zaman aşımına uğrayan indirmeler ham Python çıktısı yerine net mesajlar gösterir.",
      },
      {
        en: "All 15 languages are complete, including every GOG screen and message (1352 keys, Turkish and English in full parity).",
        tr: "GOG ekranları ve mesajları dahil 15 dilin tamamı eksiksiz (1352 anahtar, Türkçe ve İngilizce tam eşlik).",
      },
      {
        en: "Fixes: collections can be reordered again from the Collections menu, the library refresh button syncs both stores, and a failed automatic cloud upload is reported in the notification center.",
        tr: "Düzeltmeler: koleksiyonlar Koleksiyonlar menüsünden yeniden sıralanabilir, kütüphane yenile düğmesi iki mağazayı da eşitler ve başarısız otomatik bulut yüklemesi bildirim merkezinde raporlanır.",
      },
      {
        en: "Cleanup: the click router is split into eight domain handlers, the library filter cache invalidates on data revisions, and retired handlers, styles and translation keys were removed.",
        tr: "Temizlik: tıklama yönlendiricisi sekiz alan işleyicisine bölündü, kütüphane filtre önbelleği veri revizyonlarıyla geçersizleşir ve kaldırılan işleyiciler, stiller ve çeviri anahtarları temizlendi.",
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

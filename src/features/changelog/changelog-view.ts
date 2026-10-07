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
    version: "0.1.25",
    date: "2026-10-07",
    isCurrent: true,
    items: [
      {
        en: "The Ubisoft store's LOG IN works inside the store tab now: the page opened a popup the embedded view cannot show, so the click did nothing. The login continues on the overlay page and the store reloads signed in.",
        tr: "Ubisoft mağazasının LOG IN düğmesi artık mağaza sekmesinde çalışıyor: sayfa, gömülü görünümün gösteremediği bir açılır pencere açıyordu ve tıklama boşa gidiyordu. Giriş, overlay sayfasında devam ediyor ve mağaza giriş yapmış hâlde yenileniyor.",
      },
      {
        en: "The automatic cloud sync on game exit records and shows its time, so Last synced moves without pressing Sync; the manual run also clears its progress bar when it finishes.",
        tr: "Oyun çıkışındaki otomatik bulut eşitleme artık saatini kaydedip gösteriyor; Son eşitleme, Sync'e basmadan güncelleniyor. Elle eşitleme de bitince ilerleme çubuğunu temizliyor.",
      },
      {
        en: "A finished Steam transfer clears its row within seconds instead of sticking on Updating until the library is refreshed.",
        tr: "Biten Steam indirmesi satırını saniyeler içinde kaldırıyor; kütüphane yenilenene kadar Updating yazısında takılı kalmıyor.",
      },
      {
        en: "The Downloads tab follows Steam's layout: the installed-games list is gone, and a Completed section lists the last finished installs and updates from every store with a Play button — removable one by one or all at once.",
        tr: "İndirmeler sekmesi Steam düzenini izliyor: kurulu oyunlar listesi kaldırıldı; Tamamlananlar bölümü tüm mağazalardan son biten kurulum ve güncellemeleri Oyna düğmesiyle listeliyor — tek tek ya da tümü temizlenebiliyor.",
      },
      {
        en: "A lost Epic session no longer locks you out: saved accounts stay listed and can be switched back, the EGL session import is hidden when the launcher is not installed, and a failed import restores the previous session.",
        tr: "Kaybolan Epic oturumu artık kapıyı kilitlemiyor: kayıtlı hesaplar listelenip geri dönülebiliyor; Epic Games Launcher kurulu değilken oturum içe aktarma gizleniyor ve başarısız içe aktarma önceki oturumu geri yüklüyor.",
      },
      {
        en: "The storage manager reads as one ledger: hairline separators, a size column that lines up on every row, quiet icon actions and a smoother drive meter. Free space lost its misleading green.",
        tr: "Depolama Yöneticisi tek bir defter gibi okunuyor: ince ayırıcı çizgiler, her satırda hizalanan boyut kolonu, sakin ikon eylemleri ve daha akıcı sürücü ölçeği. Boş alan, yanıltıcı yeşilini kaybetti.",
      },
      {
        en: "Every library tab remembers its own sort order: All can stay on Title (A-Z) while Installed stays on Recently played.",
        tr: "Her kütüphane sekmesi kendi sıralamasını hatırlıyor: All, Başlık (A-Z)'de kalırken Installed, Son oynanan'da kalabiliyor.",
      },
    ],
    fixed: [
      {
        en: "Switching to a saved account whose session can no longer refresh says so instead of silently disconnecting again.",
        tr: "Yenilenemeyen bir kayıtlı oturuma geçerken sessizce tekrar düşmek yerine durum açıkça bildiriliyor.",
      },
      {
        en: "Completed entries the library cannot resolve are skipped instead of printing raw app ids.",
        tr: "Kütüphanenin çözemediği tamamlanan kayıtlar ham uygulama kimliği yazmak yerine atlanıyor.",
      },
      {
        en: "The library refresh button spins smoothly instead of ticking at eight frames a second.",
        tr: "Kütüphane yenileme düğmesi saniyede sekiz karelik tıkırtı yerine akıcı dönüyor.",
      },
    ],
  },
  {
    version: "0.1.24",
    date: "2026-10-07",
    items: [
      {
        en: "Epic cloud saves work end to end now: the sync passes the real save folder to Legendary, shows live progress file by file, and retries on a flaky connection instead of giving up.",
        tr: "Epic bulut kayıtları artık baştan sona çalışıyor: eşitleme gerçek kayıt klasörünü Legendary'ye iletiyor, dosya dosya canlı ilerleme gösteriyor ve bağlantı aksarsa pes etmek yerine yeniden deniyor.",
      },
      {
        en: "The Epic Games Launcher can be removed safely from Settings: your games, their .egstore manifests and Epic Online Services all stay, and the button hides itself when the launcher is not installed.",
        tr: "Epic Games Launcher Ayarlar'dan güvenle kaldırılabiliyor: oyunlarınız, .egstore manifestleri ve Epic Online Services yerinde kalıyor; launcher kurulu değilse buton kendini gizliyor.",
      },
      {
        en: "A path-MTU black hole is detected and fixed: the Manage panel warns when the network drops large packets and offers a one-click fix.",
        tr: "Path-MTU kara deliği algılanıp düzeltiliyor: ağ büyük paketleri düşürdüğünde Yönet paneli uyarıyor ve tek tıkla düzeltme sunuyor.",
      },
      {
        en: "The storage manager is redesigned with drive tabs, usage stats, search and store labels; its toolbar uses proper dropdowns and every column lines up.",
        tr: "Depolama yöneticisi sürücü sekmeleri, kullanım istatistikleri, arama ve mağaza etiketleriyle yenilendi; araç çubuğu düzgün açılır menüler kullanıyor ve tüm kolonlar hizalı.",
      },
      {
        en: "Riot's library lists only installed or played titles, records playtime from any launch path, and VALORANT gets its proper cover.",
        tr: "Riot kütüphanesi yalnızca kurulu ya da oynanmış oyunları listeliyor, oynanış süresini her başlatma yolundan kaydediyor ve VALORANT gerçek kapağına kavuşuyor.",
      },
      {
        en: "Sizes in the library, downloads and the game panel prefer the measured folder size, so installs the store under-reports — Fortnite showing a few hundred MB — now show their real size.",
        tr: "Kütüphanede, indirmelerde ve oyun panelinde gösterilen boyutlar artık ölçülen klasör boyutunu tercih ediyor; mağazanın eksik bildirdiği kurulumlar — birkaç yüz MB görünen Fortnite gibi — gerçek boyutunu gösteriyor.",
      },
      {
        en: "Hindi joins the 16 languages, and About links the website and Discord with their real marks.",
        tr: "Hintçe 16 dile katıldı; Hakkında sayfası siteyi ve Discord'u gerçek simgeleriyle bağlıyor.",
      },
    ],
    fixed: [
      {
        en: "A game started outside the launcher from a client-owned store (Steam, Xbox, EA, Ubisoft, Battle.net, Riot) shows as Running in every action and in the sidebar.",
        tr: "Steam, Xbox, EA, Ubisoft, Battle.net veya Riot istemcisinden launcher dışında başlatılan oyun artık tüm eylemlerde ve kenar çubuğunda Çalışıyor olarak görünüyor.",
      },
      {
        en: "Store components such as anti-cheat packages no longer appear as games in the Riot library.",
        tr: "Anti-cheat paketleri gibi mağaza bileşenleri artık Riot kütüphanesinde oyun olarak görünmüyor.",
      },
      {
        en: "Every Epic Games Launcher shortcut is removed — all-users Start Menu and the taskbar pin included — along with its own registry keys.",
        tr: "Epic Games Launcher'ın tüm kısayolları — tüm kullanıcılar Başlat Menüsü ve görev çubuğu sabitlemesi dâhil — kendi kayıt defteri anahtarlarıyla birlikte siliniyor.",
      },
      {
        en: "Steam cover art can be changed for uninstalled games too.",
        tr: "Steam kapak görseli kurulu olmayan oyunlar için de değiştirilebiliyor.",
      },
      {
        en: "Collection counts refresh right after adding or removing a game, and opening Settings from Downloads keeps the back navigation.",
        tr: "Koleksiyon sayıları oyun eklendikten veya çıkarıldıktan hemen sonra güncelleniyor; İndirmeler'den Ayarlar açıldığında geri gitme geçmişi korunuyor.",
      },
      {
        en: "Soft black is the default background for new installations, and the stores bar switches with a soft animation.",
        tr: "Yeni kurulumlarda varsayılan arka plan yumuşak siyah; mağazalar çubuğu yumuşak bir animasyonla geçiyor.",
      },
    ],
  },
  {
    version: "0.1.23",
    date: "2026-10-06",
    items: [
      {
        en: "The storage manager now covers every store: installed games from Epic, GOG, Amazon Games, Steam, Xbox, EA, Ubisoft, Battle.net and Riot are grouped by drive, and each folder's real size is measured instead of trusting store metadata. Move is offered for Epic and Amazon, and uninstall routes to the owning store's own flow.",
        tr: "Depolama yöneticisi artık tüm mağazaları kapsıyor: Epic, GOG, Amazon Games, Steam, Xbox, EA, Ubisoft, Battle.net ve Riot'taki yüklü oyunlar sürücülere göre gruplanıyor; mağaza verisine güvenmek yerine her klasörün gerçek boyutu ölçülüyor. Taşıma Epic ve Amazon için sunuluyor, kaldırma ise oyunun kendi mağazasının akışına yönlendiriliyor.",
      },
      {
        en: "Games started outside the launcher — from the Steam client, GOG Galaxy, Amazon, Xbox, EA, Ubisoft, Battle.net or Riot — now show as Running and land in Recently played.",
        tr: "Launcher dışından başlatılan oyunlar (Steam istemcisi, GOG Galaxy, Amazon, Xbox, EA, Ubisoft, Battle.net veya Riot) artık Çalışıyor olarak görünüyor ve Son oynananlar listesine ekleniyor.",
      },
    ],
    fixed: [
      {
        en: "The hide-achievements dialog follows the open profile tab instead of always listing Epic games.",
        tr: "Başarımları gizle penceresi artık açık olan profil sekmesini izliyor; her zaman Epic oyunlarını listelemiyor.",
      },
      {
        en: "Steam covers appear in the profile and TV profile without picking a cover by hand.",
        tr: "Steam kapakları profilde ve TV profilinde elle kapak seçmeden görünüyor.",
      },
    ],
  },
  {
    version: "0.1.22",
    date: "2026-10-05",
    items: [
      {
        en: "The stores bar is always logos-only now: every store shows its mark and only the open one keeps its full name. The setting was removed.",
        tr: "Mağazalar çubuğu artık her zaman yalnızca logolarla çalışır: her mağaza kendi simgesiyle görünür, yalnızca açık olanın adı tam yazılır. Ayar kaldırıldı.",
      },
      {
        en: "The library list spreads its columns out on wider windows, and the achievement bar now runs from the platform name to the percentage.",
        tr: "Kütüphane listesi geniş pencerelerde kolonlarını ferahlatır; başarım çubuğu artık platform adından yüzdeye kadar uzanır.",
      },
    ],
    fixed: [
      {
        en: "Disabling a store in Settings really removes it from the Stores bar now; the tabs stayed visible before.",
        tr: "Ayarlardan kapatılan mağaza artık Mağazalar çubuğundan gerçekten kalkıyor; önce sekmeler görünür kalıyordu.",
      },
      {
        en: "A VPN or DPI gateway that blocks Steam's token refresh no longer signs the account out; the session is kept and retried.",
        tr: "Steam'in token yenilemesini engelleyen bir VPN veya DPI ağ geçidi artık hesabı düşürmüyor; oturum korunup yeniden deneniyor.",
      },
      {
        en: "Amazon and Riot are properly capitalized in the library list instead of showing their raw ids.",
        tr: "Kütüphane listesinde Amazon ve Riot ham kimlikleri yerine doğru adlarıyla yazılıyor.",
      },
      {
        en: "Achievements of uninstalled games, completed sets included, are dimmed like the rest of the row.",
        tr: "Yüklü olmayan oyunların başarımları, tamamlanmış setler dahil, satırın geri kalanı gibi karartılıyor.",
      },
    ],
  },
  {
    version: "0.1.21",
    date: "2026-10-05",
    items: [
      {
        en: "Amazon Games (Prime Gaming) joins the launcher: sign in with Nile, browse your library and install, update, launch or uninstall your games.",
        tr: "Amazon Games (Prime Gaming) launcher'a katıldı: Nile ile oturum açın; kütüphanenizi gezin, oyunlarınızı kurun, güncelleyin, başlatın veya kaldırın.",
      },
      {
        en: "One Amazon card manages multiple accounts: connect several Amazon accounts and easily switch between them directly in Settings > Accounts.",
        tr: "Tek Amazon kartında çoklu hesap yönetimi: birden fazla Amazon hesabını bağlayın ve Ayarlar > Hesaplar üzerinden hesaplar arasında kolayca geçiş yapın.",
      },
      {
        en: "Amazon downloads stream speed, disk write, peak, ETA and the speed chart into the same card as Epic and GOG.",
        tr: "Amazon indirmeleri hızı, disk yazımını, zirve hızını, kalan süreyi ve hız grafiğini Epic ve GOG ile aynı kartta gösterir.",
      },
      {
        en: "The Amazon manage panel matches Epic: verify, move, desktop shortcut, save folder, local and cloud backup, launch arguments and environment variables.",
        tr: "Amazon yönetim paneli Epic ile aynı seviyede: doğrulama, taşıma, masaüstü kısayolu, kayıt klasörü, yerel ve bulut yedek, başlatma argümanları ve ortam değişkenleri.",
      },
      {
        en: "Amazon games show their real portrait covers, wide key art and their own catalog text; installs made outside Nile can be imported.",
        tr: "Amazon oyunları gerçek portre kapaklarını, geniş görselini ve kendi katalog metnini gösterir; Nile dışında yapılmış kurulumlar içe aktarılabilir.",
      },
      {
        en: "Amazon Games joins the profile hub, scheduled automatic updates and the storefront switcher, listed as Amazon Games.",
        tr: "Amazon Games profil merkezine, zamanlanmış otomatik güncellemelere ve mağaza sekmesine katıldı; artık Amazon Games adıyla listelenir.",
      },
      {
        en: "Settings > Launchers cleanly splits managed stores (Epic, GOG, Amazon Games) and delegated client stores (Steam, Xbox, EA, Ubisoft, Battle.net, Riot) with contextual guidance under each header.",
        tr: "Ayarlar > Başlatıcılar sayfası doğrudan yönetilen mağazaları (Epic, GOG, Amazon Games) ve istemcilerine devredilenleri (Steam, Xbox, EA, Ubisoft, Battle.net, Riot) net biçimde ayırır ve açıklamalarını başlıkların altına yerleştirir.",
      },
      {
        en: "The library store filter only lists stores that are connected or detected on this PC.",
        tr: "Kütüphane mağaza filtresi yalnızca bağlı veya bu bilgisayarda algılanan mağazaları listeler.",
      },
      {
        en: "TV Mode catches up: Amazon and companion-store games appear on the shelf, every storefront tab (Amazon Games included) opens in the store panel, and Amazon updates show in the downloads panel.",
        tr: "TV Modu güncellendi: Amazon ve yerleşik mağaza oyunları rafta görünür, Amazon Games dahil tüm mağaza sekmeleri mağaza panelinde açılır ve Amazon güncellemeleri indirmeler panelinde listelenir.",
      },
      {
        en: "Settings: the About, Launchers and Accounts sections now cover Amazon Games, and every account card lists what its store supports.",
        tr: "Ayarlar: Hakkında, Başlatıcılar ve Hesaplar bölümleri Amazon Games'i kapsıyor; her hesap kartı mağazasının neleri desteklediğini listeliyor.",
      },
    ],
    fixed: [
      {
        en: "The library filter bar keeps all tabs in a single row with mouse-wheel horizontal scrolling, and the collections menu stays pinned to the viewport without clipping.",
        tr: "Kütüphane filtre çubuğu yatay fare tekerleği kaydırmasıyla sekmeleri tek satırda tutar; koleksiyonlar menüsü taşma yapmadan ekrana sabitlenir.",
      },
      {
        en: "Spacing in Settings: info callouts and section headers (such as New Collection) now have clean breathing room and no longer touch list borders.",
        tr: "Ayarlar arayüz boşlukları: bilgi kutuları ve başlık butonları (Yeni Koleksiyon vb.) artık altlarındaki liste sınırlarına yapışmaz.",
      },
      {
        en: "TV Mode downloads stay inside the shell and allow installing companion-store games directly.",
        tr: "TV Modu indirmeleri arayüz içinde tutar ve yerleşik mağaza oyunlarının doğrudan kurulmasını sağlar.",
      },
      {
        en: "Settings > About features a clean, store-agnostic description, and translations across all 15 supported languages are fully synchronized and completed.",
        tr: "Ayarlar > Hakkında bölümü mağaza adlarından arındırılmış genel bir açıklamayla güncellendi; 15 dilin tamamındaki eksik çeviriler ve yer tutucular eşitlendi.",
      },
      {
        en: "The GOG account note no longer claims GOG Galaxy handles installing and removing games.",
        tr: "GOG hesap notu artık kurulum ve kaldırma işlerini GOG Galaxy'nin yaptığını söylemiyor.",
      },
      {
        en: "Amazon games no longer show Epic wording in the playtime editor, source notes or feature rows, and their save row says local instead of Epic cloud.",
        tr: "Amazon oyunları artık oynanış düzenleyicide, kaynak notlarında veya özellik satırlarında Epic ifadesi göstermez; kayıt satırı Epic bulutu yerine yerel kaydı söyler.",
      },
      {
        en: "The empty Favorites tab points back to the library instead of the store.",
        tr: "Boş Favoriler sekmesi mağaza yerine kütüphaneye yönlendirir.",
      },
      {
        en: "The Turkish controller section no longer says \"köprü\" and calls the pad a controller everywhere.",
        tr: "Türkçe kontrolcü bölümü artık \"köprü\" demiyor ve her yerde \"kontrolcü\" diyor.",
      },
      {
        en: "The Spanish profile chip no longer shows a TODO placeholder, and small wording fixes landed across locales.",
        tr: "İspanyolca profil rozeti artık TODO yer tutucusu göstermez; birkaç dilde küçük metin düzeltmeleri yapıldı.",
      },
      {
        en: "Discord Rich Presence no longer sticks to stale activity: the library count, TV Mode, accounts and connections that appear after Discord starts are all kept in sync.",
        tr: "Discord Rich Presence artık eski aktivitede takılı kalmaz; kütüphane sayısını, TV Modu'nu, hesapları ve Discord sonradan açıldığında kurulan bağlantıyı eşitler.",
      },
      {
        en: "The collections menu closes when the library scrolls or the window resizes, and the filter strip keeps its horizontal position across refreshes.",
        tr: "Koleksiyonlar menüsü kütüphane kaydırılınca veya pencere boyutlanınca kapanır; filtre şeridi yenilemelerde yatay konumunu korur.",
      },
      {
        en: "Amazon account changes (add, switch, remove, sign out) wait until a running download finishes, and a failed sign-in restores the previous account instead of leaving the card signed out.",
        tr: "Amazon hesap işlemleri (ekleme, değiştirme, kaldırma, çıkış) süren indirme bitene kadar bekler; başarısız oturum açma önceki hesabı geri yükler ve kartı bağlantısız bırakmaz.",
      },
      {
        en: "Amazon session loads no longer start the Nile CLI just to read the sign-in state, and account listings no longer recopy the whole library.",
        tr: "Amazon oturum yüklemeleri yalnızca oturum durumunu okumak için Nile CLI başlatmaz; hesap listeleme tüm kütüphaneyi yeniden kopyalamaz.",
      },
    ],
  },
  {
    version: "0.1.20",
    date: "2026-10-01",
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

/**
 * Changelog modal view.
 * Displays release history, newly added features, improvements, and bug fixes.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../core/constants";
import { changelogRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { overlayThemeStyle } from "../../core/overlay-theme";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { currentLanguage, t } from "../../i18n";
import { embeddedContentShown, holdStoreOverlay, releaseStoreOverlay } from "../store/store-view";

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
    version: "0.1.37",
    date: "2026-10-24",
    isCurrent: true,
    items: [
      {
        en: "Collections now show a 2x2 cover mosaic in the library dropdown, and the game picker loads 120 rows at a time with Show more instead of building the whole library up front.",
        tr: "Koleksiyonlar kitaplık menüsünde 2x2 kapak mozaiği gösteriyor; oyun seçici tüm kütüphaneyi baştan kurmak yerine 120 satır yükleyip Daha Fazla Göster ile devam ediyor.",
      },
      {
        en: "Settings > Appearance > Reduce motion and effects turns off animations, glass blur and hover lifts. Every page, button and feature stays available.",
        tr: "Ayarlar > Görünüm > Hareketi ve efektleri azalt, animasyonları, cam bulanıklığını ve hover hareketlerini kapatıyor. Tüm sayfalar, düğmeler ve özellikler kullanılabilir kalıyor.",
      },
      {
        en: "Smart collections group installed-but-unplayed, almost finished, playing, completed, on-hold and forgotten games automatically. The game page adds a status selector, and the library adds a random-game button.",
        tr: "Akıllı koleksiyonlar kurulu ama oynanmamış, neredeyse bitmiş, oynanıyor, tamamlanmış, beklemede ve unutulmuş oyunları otomatik grupluyor. Oyun sayfasına durum seçici, kütüphaneye rastgele oyun düğmesi eklendi.",
      },
      {
        en: "Settings > Appearance > Interface scale zooms the whole interface from 80% to 150%, which keeps the same features readable on small screens, TVs and low-resolution laptops.",
        tr: "Ayarlar > Görünüm > Arayüz ölçeği tüm arayüzü %80 ile %150 arasında büyütüp küçültüyor; küçük ekranlarda, TV'lerde ve düşük çözünürlüklü dizüstülerde aynı özellikler okunabilir kalıyor.",
      },
      {
        en: "Settings > System > PC check reports WebView2, hardware, backend, legendary, disk space and local storage, and copies the report to the clipboard. Nothing is uploaded.",
        tr: "Ayarlar > Sistem > Bilgisayar kontrolü WebView2, donanım, arka uç, legendary, disk alanı ve yerel depolamayı raporluyor; rapor panoya kopyalanıyor. Hiçbir şey yüklenmiyor.",
      },
    ],
    fixed: [
      {
        en: "A collection game's tick now changes immediately instead of waiting for the list to repaint.",
        tr: "Koleksiyondaki bir oyunun işareti artık liste yeniden çizilmesini beklemeden anında değişiyor.",
      },
      {
        en: "Long sessions no longer keep every decoded cover in memory, and Steam's running-state poll pauses while the launcher is hidden.",
        tr: "Uzun oturumlar artık çözülen her kapağı bellekte tutmuyor; launcher gizliyken Steam çalışma durumu kontrolü de duruyor.",
      },
    ],
  },
  {
    version: "0.1.36",
    date: "2026-10-22",
    items: [
      {
        en: "Build your own theme: name it, pick a background colour and an accent, add your own photo as a backdrop if you want one, and switch to it with one click. Saved themes stay on this PC.",
        tr: "Kendi temanı oluştur: isim ver, arka plan ve vurgu rengini seç, istersen kendi fotoğrafını arka plan olarak ekle ve tek tıkla geç. Kaydedilen temalar bu bilgisayarda kalır.",
      },
      {
        en: "Theme names now describe the palette directly: Neon Grid, Blades, Gloss, Violet and Blurple.",
        tr: "Tema adları artık paleti doğrudan anlatıyor: Neon Izgara, Blades, Parlak Cam, Mor ve Blurple.",
      },
      {
        en: "Every backdrop is original vector artwork. A theme with a photo turns its panels into glass, so the image shows through the whole shell.",
        tr: "Tüm arka planlar özgün vektör çizimler. Fotoğraflı bir temada paneller cama dönüşüyor, böylece görsel tüm arayüzün arkasında görünüyor.",
      },
    ],
    fixed: [
      {
        en: "Settings > About now states that themes are original, unofficial palettes with no game assets and no endorsement.",
        tr: "Ayarlar > Hakkında artık temaların özgün, resmî olmayan paletler olduğunu; oyun varlığı içermediğini ve onaylanmadığını belirtiyor.",
      },
      {
        en: "A repeated early crash now moves the WebView2 profile aside and retries with software rendering instead of closing again.",
        tr: "Tekrarlanan erken çöküşte WebView2 profili kenara alınıyor ve yazılım işleme ile yeniden deneniyor; launcher tekrar kapanıp kalmıyor.",
      },
      {
        en: "Steam's Running flag is re-checked periodically and when a game page opens, so a game started from the Steam client no longer looks closed.",
        tr: "Steam'in Running bilgisi düzenli olarak ve oyun sayfası açılırken yeniden kontrol ediliyor; Steam istemcisinden başlatılan oyun artık kapalı görünmüyor.",
      },
      {
        en: "A main window that starts hidden or minimized is now shown automatically. Launching the app again reveals the existing window instead of leaving an invisible background process.",
        tr: "Gizli veya küçültülmüş başlayan ana pencere artık otomatik gösteriliyor. Uygulamayı yeniden başlatmak, görünmez bir arka plan süreci bırakmak yerine mevcut pencereyi öne getiriyor.",
      },
    ],
  },
  {
    version: "0.1.34",
    date: "2026-10-22",
    items: [
      {
        en: "In-app feedback reports: Settings > About or Ctrl+K opens a dialog that creates a diagnostic zip with logs, system information and redacted settings, then opens a prefilled GitHub issue where you can attach it.",
        tr: "Uygulama içi geri bildirim raporları: Ayarlar > Hakkında veya Ctrl+K ile açılan pencere; loglar, sistem bilgisi ve gizlilik için temizlenmiş ayarlarla bir tanılama zip'i oluşturur, ardından dosyayı ekleyebileceğin hazır bir GitHub sorun kaydı açar.",
      },
      {
        en: "If the launcher did not exit cleanly, the next start offers the feedback dialog automatically so the previous session can be reported before it is forgotten.",
        tr: "Launcher düzgün kapanmadıysa bir sonraki açılışta geri bildirim penceresi otomatik açılır; böylece önceki oturum unutulmadan raporlanabilir.",
      },
      {
        en: "The Media tab now respects the \"Also scan the store folders\" switch: when it is off, only the selected screenshot folder is listed.",
        tr: "Medya sekmesi artık \"Mağaza klasörlerini de tara\" anahtarına uyuyor: kapalıyken yalnızca seçilen ekran görüntüsü klasörü listeleniyor.",
      },
      {
        en: "Achievement notification positions now include center top and center bottom alongside the four corners.",
        tr: "Başarım bildirimi konumlarına dört köşenin yanında üst orta ve alt orta da eklendi.",
      },
    ],
    fixed: [
      {
        en: "The Spotify receiver no longer starts automatically when the Music page opens. It waits for Start on this PC or the play button, so a failing audio backend cannot close the launcher during boot.",
        tr: "Spotify alıcısı Müzik sayfası açıldığında artık otomatik başlamıyor. \"Bu bilgisayarda başlat\" veya oynat düğmesini bekliyor; böylece sorunlu bir ses arka ucu launcher'ı açılış sırasında kapatamıyor.",
      },
    ],
  },
  {
    version: "0.1.33",
    date: "2026-10-21",
    items: [
      {
        en: "Custom games: add a game without a store account, search Steam for metadata and artwork, keep the executable optional, import a folder, and launch, stop and track playtime like any other library title.",
        tr: "Özel oyunlar: mağaza hesabı olmadan oyun ekle, Steam'den metadata ve kapak bul, çalıştırılabilir dosyayı isteğe bağlı bırak, klasör içe aktar; diğer kütüphane oyunları gibi başlat, durdur ve oynama süresini takip et.",
      },
      {
        en: "Custom game pages can be edited from the drawer or context menu, with custom artwork, metadata, profile details and a proper stop action.",
        tr: "Özel oyun sayfaları çekmece veya sağ tık menüsünden düzenlenebiliyor; özel kapak, metadata, profil bilgileri ve düzgün bir durdurma işlemi var.",
      },
      {
        en: "Achievements now work for emulated and custom games: local unlock files are matched with the public Steam schema, and the same live watcher updates the game page.",
        tr: "Başarımlar artık emülatör ve özel oyunlarda çalışıyor: yerel başarım dosyaları herkese açık Steam şemasıyla eşleştiriliyor ve aynı canlı izleyici oyun sayfasını güncelliyor.",
      },
      {
        en: "Achievement notifications are fully customizable: four screen corners, 3/5/8-second duration, volume, a custom sound file (WAV, MP3, OGG, FLAC, M4A or AAC), master/overlay switches and a test button.",
        tr: "Başarım bildirimleri tamamen özelleştirilebiliyor: dört ekran köşesi, 3/5/8 saniye süre, ses düzeyi, özel ses dosyası (WAV, MP3, OGG, FLAC, M4A veya AAC), ana/overlay anahtarları ve test düğmesi.",
      },
      {
        en: "Unlocked achievements appear in a native in-game card over the game, and the same notification settings control its position, duration and sound.",
        tr: "Açılan başarımlar oyunun üzerinde yerel bir kart olarak görünüyor; aynı bildirim ayarları konumunu, süresini ve sesini kontrol ediyor.",
      },
      {
        en: "Pick the launcher icon: classic, Gloss or your own image; the same icon appears in the title bar.",
        tr: "Launcher simgesini seç: klasik, Gloss veya kendi görselin; aynı simge başlık çubuğunda da görünüyor.",
      },
      {
        en: "The library toolbar is compact: Add Game and Import Folder are icon buttons, with shorter store and sort labels and a sort icon.",
        tr: "Kütüphane araç çubuğu sıkıştırıldı: Oyun Ekle ve Klasör İçe Aktar simge düğmeleri oldu; mağaza ve sıralama etiketleri kısaldı ve sıralama simgesi eklendi.",
      },
    ],
    fixed: [
      {
        en: "A game that was already running when the launcher opened no longer minimizes the window or triggers a new-session toast.",
        tr: "Launcher açıldığında zaten çalışan bir oyun artık pencereyi küçültmüyor veya yeni oturum bildirimi göstermiyor.",
      },
      {
        en: "Fullscreen mode can no longer take the launcher down when it is triggered automatically; a failed switch falls back to the normal window.",
        tr: "Tam ekran modu otomatik tetiklendiğinde launcher'ı kapatamıyor; başarısız bir geçiş normal pencereye geri dönüyor.",
      },
      {
        en: "Custom games no longer disappear when no store account is signed in, and duplicate saves no longer stack up.",
        tr: "Mağaza hesabı açık değilken özel oyunlar kaybolmuyor ve yinelenen kayıtlar birikmiyor.",
      },
      {
        en: "Emulator achievements are found in more save folders, and values such as 1.0 are read correctly.",
        tr: "Emülatör başarımları daha fazla kayıt klasöründe bulunuyor ve 1.0 gibi ondalık değerler doğru okunuyor.",
      },
      {
        en: "Custom games launched outside the launcher are tracked, keep their playtime and start the achievement watcher.",
        tr: "Launcher dışından başlatılan özel oyunlar takip ediliyor, oynama süreleri korunuyor ve başarım izleyicisi başlıyor.",
      },
      {
        en: "The collections menu uses the normal pointer again, and the launcher icon selector no longer shows native hover tooltips.",
        tr: "Koleksiyonlar menüsü tekrar normal fare imlecini kullanıyor ve launcher simgesi seçici artık yerel hover tooltip'i göstermiyor.",
      },
    ],
  },
  {
    version: "0.1.32",
    date: "2026-10-21",
    items: [
      {
        en: "White Mode and Gloss themes, with a full light-theme pass across the library, game pages, profile, notes, collections and settings.",
        tr: "White Mode ve Gloss temaları; kütüphane, oyun sayfaları, profil, notlar, koleksiyonlar ve ayarlarda tam açık tema geçişi.",
      },
      {
        en: "Full Screen Mode replaces TV Mode: the window covers the taskbar and keeps the controller-first console layout.",
        tr: "TV Modu'nun yerini Tam Ekran Modu aldı: pencere artık görev çubuğunu kaplıyor ve konsol düzeni kontrolcüyle kullanılmaya devam ediyor.",
      },
      {
        en: "Physical cases for every library game: four new case styles, a holographic 3D box effect, per-store covers and 2x Steam artwork.",
        tr: "Kütüphanedeki her oyun için fiziksel kutular: dört yeni kutu stili, holografik 3D kutu efekti, mağaza bazlı kapaklar ve 2x Steam görselleri.",
      },
      {
        en: "The game page is rebuilt around the player: a larger hero, one scores card, a facts/system tab, the last session, news and patch notes, community links and IGDB add-ons.",
        tr: "Oyun sayfası oyuncuya göre yeniden kuruldu: daha büyük bir hero, tek puan kartı, gerçekler/sistem sekmesi, son oturum, haberler ve yama notları, topluluk bağlantıları ve IGDB ek paketleri.",
      },
      {
        en: "The Media tab is now a studio: screenshot viewer and editor, clip playback, trimming and joining without re-encoding.",
        tr: "Medya sekmesi artık bir stüdyo: ekran görüntüsü görüntüleyici ve düzenleyici, klip oynatma, yeniden kodlamadan kesme ve birleştirme.",
      },
      {
        en: "The Steam store runs the real SteamDB and Augmented Steam Chrome extensions; install, update, disable or remove them from Settings > Stores. The TRY price converter stays.",
        tr: "Steam mağazası gerçek SteamDB ve Augmented Steam Chrome eklentilerini çalıştırıyor; Ayarlar > Mağazalar'dan kur, güncelle, devre dışı bırak veya kaldır. TL fiyat çevirici korunuyor.",
      },
      {
        en: "Compatibility now manages Wine/Proton runners, umu-launcher, DXVK and VKD3D: per-game runner, prefix and layer overrides, prefix preparation with progress, diagnostics and resumable downloads.",
        tr: "Uyumluluk artık Wine/Proton çalıştırıcılarını, umu-launcher'ı, DXVK ve VKD3D'yi yönetiyor: oyun bazlı çalıştırıcı, prefix ve katman seçimi, ilerlemeli prefix hazırlığı, tanılama ve devam eden indirmeler.",
      },
      {
        en: "Steam game pages show Valve's Steam Deck rating, the ProtonDB tier and the anti-cheat status; answers are cached for a day.",
        tr: "Steam oyun sayfaları Valve'ın Steam Deck derecesini, ProtonDB seviyesini ve anti-cheat durumunu gösteriyor; yanıtlar bir gün önbellekte kalıyor.",
      },
      {
        en: "Collections and smart views can be the default library tab, and Settings > Library lets you choose any tab as the startup view.",
        tr: "Koleksiyonlar ve akıllı görünümler varsayılan kütüphane sekmesi olabiliyor; Ayarlar > Kütüphane'den açılıştaki görünümü seçebiliyorsun.",
      },
      {
        en: "The in-game overlay got a layout reset, tiled widgets, a grouped Discord voice list, a cleaner first screen and a close button; hidden widgets stop polling and Spotify only starts when needed.",
        tr: "Oyun içi overlay'e düzen sıfırlama, döşenmiş widget'lar, sunucuya göre gruplanmış Discord ses listesi, daha temiz bir ilk ekran ve kapatma düğmesi geldi; gizli widget'lar yoklamayı bırakıyor, Spotify yalnızca gerektiğinde başlıyor.",
      },
      {
        en: "Settings > Stores now lets you reorder store tabs, explains which clients the launcher downloads itself, and the compatibility target picker works again.",
        tr: "Ayarlar > Mağazalar'da mağaza sekmelerini sıralayabiliyorsun; hangi istemcileri launcher'ın kendi indirdiği açıklanıyor ve uyumluluk hedef seçicisi yeniden çalışıyor.",
      },
      {
        en: "The launcher paints faster: cached Steam metadata, warm game pages, fewer full repaints, a faster sidebar and an image cache that Settings > System can clear.",
        tr: "Launcher daha hızlı açılıyor: önbelleklenmiş Steam verisi, önceden ısıtılan oyun sayfaları, daha az tam yeniden çizim, daha hızlı kenar çubuğu ve Ayarlar > Sistem'den temizlenebilen görsel önbelleği.",
      },
    ],
    fixed: [
      {
        en: "The back-to-top button no longer overlaps pagination controls.",
        tr: "Yukarı çık düğmesi artık sayfalama kontrollerinin üstüne binmiyor.",
      },
      {
        en: "The compatibility platform picker opens and reacts to the selected target.",
        tr: "Uyumluluk platform seçicisi açılıyor ve seçilen hedefe göre yenileniyor.",
      },
      {
        en: "GOGdl is prepared automatically for linked GOG accounts instead of showing as missing.",
        tr: "GOGdl, bağlı GOG hesapları için eksik görünmek yerine otomatik hazırlanıyor.",
      },
      {
        en: "Steam store extension widgets render correctly, and installed copies update with the launcher.",
        tr: "Steam mağaza eklentisi widget'ları doğru çiziliyor ve kurulu kopyalar launcher ile güncelleniyor.",
      },
      {
        en: "Light themes keep switches, store logos, collection fields, notes and profile cards readable.",
        tr: "Açık temalarda anahtarlar, mağaza logoları, koleksiyon alanları, notlar ve profil kartları okunabilir kalıyor.",
      },
      {
        en: "Edge no longer shows its autofill popup over the settings search field.",
        tr: "Edge, ayarlar arama alanının üstünde otomatik doldurma penceresini göstermiyor.",
      },
      {
        en: "Full screen mode covers the taskbar on multi-monitor setups.",
        tr: "Tam ekran modu çoklu monitör kurulumlarında görev çubuğunu kaplıyor.",
      },
      {
        en: "Malformed VDF files and corrupt clip sizes no longer take down the parser or leave a broken clip.",
        tr: "Bozuk VDF dosyaları ve hatalı klip boyutları artık ayrıştırıcıyı düşürmüyor veya bozuk klip bırakmıyor.",
      },
    ],
  },
  {
    version: "0.1.31",
    date: "2026-10-18",
    items: [
      {
        en: "Discord asks for permission once, not on a loop: the Rich Presence worker was requesting a Social SDK scope that the RPC pipe rejects, and it retried every 30 seconds after a decline.",
        tr: "Discord artık izni bir kez istiyor, döngüye girmiyor: Rich Presence işçisi RPC hattının reddettiği bir Social SDK kapsamı istiyordu ve reddedildikten sonra 30 saniyede bir tekrar deniyordu.",
      },
      {
        en: "The store's screenshots open inside the launcher instead of a browser tab.",
        tr: "Mağazanın ekran görüntüleri tarayıcı sekmesi yerine launcher içinde açılıyor.",
      },
      {
        en: "The total playtime in Manage names the stores behind it, so hours played through another store or Game Pass are no longer invisible.",
        tr: "Yönet'teki toplam oynama süresi hangi mağazalardan geldiğini yazıyor; başka bir mağazada ya da Game Pass'te geçen saatler artık görünmez değil.",
      },
      {
        en: "Settings > Screenshots lists every folder the gallery reads, and the whole Documents folder is no longer scanned — only Rockstar's own folder inside it.",
        tr: "Ayarlar > Ekran Görüntüleri galerinin okuduğu tüm klasörleri listeliyor; Belgeler klasörünün tamamı artık taranmıyor, yalnızca içindeki Rockstar klasörü.",
      },
      {
        en: "Long screenshot file names no longer run over the next card.",
        tr: "Uzun ekran görüntüsü dosya adları artık yanındaki kartın üstüne taşmıyor.",
      },
      {
        en: "Similar games link to the right IGDB page; the numeric id used to land on an empty search.",
        tr: "Benzer oyunlar doğru IGDB sayfasına gidiyor; eskiden sayısal kimlik boş bir arama sayfasına düşüyordu.",
      },
      {
        en: "The genre chips under a description no longer light up like buttons — they are facts, not actions.",
        tr: "Açıklamanın altındaki tür etiketleri artık düğme gibi parlamıyor; onlar bilgi, aksiyon değil.",
      },
      {
        en: "A crash now writes a report to logs\\crash.log instead of leaving nothing behind, so a report from a user is actionable.",
        tr: "Çökme artık logs\\crash.log dosyasına rapor yazıyor; kullanıcıdan gelen bir bildirim böylece tahminle değil veriyle incelenebiliyor.",
      },
    ],
    fixed: [
      {
        en: "The Discord authorization prompt no longer returns every 30 seconds after you decline it.",
        tr: "Discord izin penceresi reddettikten sonra artık 30 saniyede bir geri gelmiyor.",
      },
      {
        en: "Broken IGDB links on the similar-games row.",
        tr: "Benzer oyunlar satırındaki kırık IGDB bağlantıları.",
      },
      {
        en: "Screenshots from unrelated folders under Documents no longer appear in the gallery.",
        tr: "Belgeler altındaki ilgisiz klasörlerden gelen görüntüler artık galeride görünmüyor.",
      },
      {
        en: "Overlapping screenshot titles in the gallery.",
        tr: "Galeride üst üste binen ekran görüntüsü başlıkları.",
      },
    ],
  },
  {
    version: "0.1.30",
    date: "2026-10-15",
    items: [
      {
        en: "The game page reads its metadata from IGDB: description, genres, age rating, community score, screenshots and similar games come from the shared Efxlve server, so no Twitch key is needed. Your own credentials still work if you prefer them.",
        tr: "Oyun sayfası künyesini artık IGDB'den okuyor: açıklama, türler, yaş sınırı, topluluk puanı, ekran görüntüleri ve benzer oyunlar paylaşılan Efxlve sunucusundan geliyor; Twitch anahtarı gerekmiyor. İstersen kendi anahtarını girmeye devam edebilirsin.",
      },
      {
        en: "Scores live in one card: the IGDB community score sits next to OpenCritic and Metacritic instead of in a block of its own.",
        tr: "Puanlar tek kartta: IGDB topluluk puanı artık kendi bloğunda değil, OpenCritic ve Metacritic'in yanında.",
      },
      {
        en: "The Media tab holds the store's screenshots above your own gallery and clips, and the similar-games card closes the overview.",
        tr: "Medya sekmesi mağazanın ekran görüntülerini kendi galerinin ve kliplerinin üstünde tutuyor; benzer oyunlar kartı Genel Bakış'ı kapatıyor.",
      },
      {
        en: "The System tab leads with the facts of this copy: platform, installed size, build and EOS support.",
        tr: "Sistem sekmesi bu kopyanın bilgileriyle başlıyor: platform, yüklü boyut, build ve EOS desteği.",
      },
      {
        en: "The Manage panel is sectioned and searchable: the search opens from the icon next to the close button, and all nine stores share the same section order.",
        tr: "Yönet paneli bölümlere ayrıldı ve aranabilir: arama, kapatma düğmesinin yanındaki ikondan açılıyor ve dokuz mağazanın hepsi aynı bölüm sırasını kullanıyor.",
      },
      {
        en: "Covers and screenshots are cached on disk, so a game page you opened once opens again without waiting for the network. Settings > System shows the size and clears it.",
        tr: "Kapaklar ve ekran görüntüleri diske kaydediliyor; bir kez açtığın oyun sayfası ağ beklemeden açılıyor. Ayarlar > Sistem boyutu gösteriyor ve temizleyebiliyor.",
      },
      {
        en: "Long descriptions collapse behind a Read more button.",
        tr: "Uzun açıklamalar \"Devamını oku\" düğmesinin arkasına katlanıyor.",
      },
      {
        en: "Update rows show the version (10.2.0.7 to 10.2.1.2) instead of the build's file name.",
        tr: "Güncelleme satırları yapının dosya adı yerine sürümü gösteriyor (10.2.0.7 - 10.2.1.2).",
      },
      {
        en: "Two accounts can own the same game: the launcher plays your own copy instead of offering to switch accounts.",
        tr: "İki hesap aynı oyuna sahip olabiliyor: launcher artık hesap değiştirmeyi önermek yerine kendi kopyanı oynatıyor.",
      },
    ],
    fixed: [
      {
        en: "IGDB matching: a standalone remaster is found again, DLC chapters and empty duplicate entries no longer win, and store titles with curly apostrophes match.",
        tr: "IGDB eşleştirmesi: tek başına duran bir remaster yeniden bulunuyor, DLC bölümleri ve boş kopya kayıtları artık kazanmıyor, kıvrık kesme işaretli mağaza adları eşleşiyor.",
      },
      {
        en: "The hero line shows the PC release, not the console release of a remaster.",
        tr: "Başlık satırı bir remaster'ın konsol çıkışını değil, PC çıkışını gösteriyor.",
      },
      {
        en: "Age ratings are picked for your region and the rest sit behind a counter.",
        tr: "Yaş sınırı bölgene göre seçiliyor ve gerisi bir sayaç arkasında duruyor.",
      },
      {
        en: "The developer and the publisher no longer appear twice when both names are the same company.",
        tr: "Geliştirici ve yayıncı aynı şirket olduğunda artık iki kez görünmüyor.",
      },
      {
        en: "The Manage panel's search no longer floats in the header, and the grey plates that read as disabled are gone.",
        tr: "Yönet panelindeki arama artık başlıkta yüzmüyor; devre dışı gibi görünen gri plakalar kaldırıldı.",
      },
      {
        en: "The completed downloads list keeps its own action button (Play or Update).",
        tr: "Tamamlanan indirmeler listesi kendi aksiyon düğmesini koruyor (Oyna veya Güncelle).",
      },
      {
        en: "An open settings row no longer closes itself on a repaint.",
        tr: "Açık bir ayar satırı yeniden çizimde kendi kendine kapanmıyor.",
      },
    ],
  },
  {
    version: "0.1.29",
    date: "2026-10-11",
    items: [
      {
        en: "The library lists Steam family shared games: titles other members share appear next to your own, and the game page marks them with a Family sharing badge.",
        tr: "Kütüphane artık Steam aile paylaşımındaki oyunları da listeliyor: diğer üyelerin paylaştığı oyunlar kendi oyunlarının yanında görünüyor ve oyun sayfası onları \"Aile paylaşımı\" rozetiyle işaretliyor.",
      },
      {
        en: "The sidebar mini player is a proper card now — a larger cover, a play button in the launcher's white accent, a grab dot on the progress bar — and it shows the elapsed and the total time.",
        tr: "Kenar çubuğu mini oynatıcısı artık düzgün bir kart: daha büyük kapak, launcher'ın beyaz vurgusuyla oynat düğmesi, ilerleme çubuğunda tutma noktası — ve hem geçen hem toplam süreyi gösteriyor.",
      },
      {
        en: "Settings → Appearance can hide the sidebar player entirely.",
        tr: "Ayarlar → Görünüm, kenar çubuğu oynatıcısını tamamen gizleyebiliyor.",
      },
      {
        en: "The Spotify page keeps Back and Reload in the player's own bar, next to the logo, and the launcher header only keeps the Connect pairing hint.",
        tr: "Spotify sayfası geri ve yenile düğmelerini oynatıcı çubuğunda, logonun yanında tutuyor; launcher başlığında yalnızca Connect eşleştirme ipucu kalıyor.",
      },
      {
        en: "The embedded Spotify page hides the desktop app promos, and its right rail collapses when the promo was the only thing in it — the song and artist view still uses the rail.",
        tr: "Gömülü Spotify sayfası masaüstü uygulaması promolarını gizliyor; sağ sütunda promodan başka içerik yoksa sütun toplanıyor — şarkı ve sanatçı görünümü sütunu yine kullanıyor.",
      },
      {
        en: "HowLongToBeat and Metacritic find the game you are actually looking at: the release year counts, Metacritic is read from its own page, and a name that cannot be the same game yields no score instead of another title's.",
        tr: "HowLongToBeat ve Metacritic artık gerçekten baktığın oyunu buluyor: çıkış yılı hesaba katılıyor, Metacritic kendi sayfasından okunuyor ve aynı oyun olamayacak bir ad eşleşirse başka oyunun puanı yerine puan gösterilmiyor.",
      },
    ],
    fixed: [
      {
        en: "The overlay's \"Disable for this game\" toggle stays out of the desktop/launcher context, and Settings → Appearance restores every blocked title — a block can no longer lock the overlay away.",
        tr: "Arayüzün \"Bu oyun için açma\" anahtarı masaüstü/launcher bağlamında görünmüyor; Ayarlar → Görünüm engellenen tüm oyunları geri açıyor — bir engel arayüzü artık kilitleyemiyor.",
      },
      {
        en: "The notifications dropdown opens on the first click over the storefront and Spotify pages, follows the selected surface theme, and closes when the page changes.",
        tr: "Bildirim menüsü mağaza ve Spotify sayfalarında ilk tıklamada açılıyor, seçili yüzey temasını izliyor ve sayfa değişince kapanıyor.",
      },
      {
        en: "The changelog floats as a card over the storefront and Spotify pages, centered on the window, and its buttons answer to a single press.",
        tr: "Changelog, mağaza ve Spotify sayfalarının üzerinde pencereye ortalanmış bir kart olarak duruyor ve düğmeleri tek basışta çalışıyor.",
      },
      {
        en: "The Spotify page no longer pauses a track while reporting what is playing, and the sidebar player follows whichever engine is actually making sound.",
        tr: "Spotify sayfası çalan parçayı bildirirken müziği artık duraklatmıyor; kenar çubuğu oynatıcısı sesi gerçekten çıkaran motoru izliyor.",
      },
      {
        en: "The Spotify receiver warms up while the page is open, so songs start without the cold start, and the mini player reacts within a second.",
        tr: "Spotify alıcısı sayfa açıkken ısınıyor; şarkılar soğuk başlama beklemeden başlıyor ve mini oynatıcı bir saniye içinde tepki veriyor.",
      },
      {
        en: "The HowLongToBeat card keeps its rows compact when a value is missing.",
        tr: "HowLongToBeat kartı bir değer eksikken satırlarını kompakt tutuyor.",
      },
    ],
  },
  {
    version: "0.1.28",
    date: "2026-10-10",
    items: [
      {
        en: "The in-game overlay is here: Shift+Tab opens a panel over the game with live FPS, CPU, GPU and memory readings, achievements, screenshots and notes, Spotify and Discord tabs, plus controller and keyboard navigation. It now wears the launcher's own theme as well: flat surfaces and one white accent.",
        tr: "Oyun içi arayüz geldi: Shift+Tab oyun üzerinde canlı FPS, CPU, GPU ve bellek okumaları, başarımlar, ekran görüntüleri ve notlar, Spotify ve Discord sekmeleri, ayrıca oyun kolu ve klavye gezinmesi olan bir panel açıyor. Panel artık launcher'ın kendi temasını da giyiyor: düz yüzeyler ve tek beyaz vurgu.",
      },
      {
        en: "The game-start hint is a slim card in the top-right corner of the game's monitor: an icon disc, a bold title and one line, sliding in and out instead of the old banner.",
        tr: "Oyun başlangıç ipucu, oyunun monitörünün sağ üstünde ince bir kart: ikon diski, kalın bir başlık ve tek satır. Eski banner yerine kayarak girip çıkıyor.",
      },
      {
        en: "Spotify lives in the launcher: the Music page embeds the normal web player, a built-in receiver plays through your own account, and a sidebar mini player handles play/pause, skip, volume and timeline scrubbing while you use other pages.",
        tr: "Spotify artık launcher'ın içinde: Müzik sayfası normal web oynatıcıyı gömüyor, launcher'ın kendi alıcısı kendi hesabınla çalıyor ve başka sayfalardayken kenar çubuğu mini oynatıcısı oynat/duraklat, atla, ses ve zaman çizelgesini üstleniyor.",
      },
      {
        en: "Discord Rich Presence shows what the receiver plays: album art and a live time bar, and while a game runs the track joins the second line.",
        tr: "Discord Rich Presence alıcının çaldığını gösteriyor: albüm kapağı ve canlı zaman çubuğu; bir oyun açıkken parça ikinci satıra katılıyor.",
      },
      {
        en: "Rockstar's Epic titles (GTA III/VC/SA Definitive Edition, GTA V, RDR2) can start without the Epic Games Launcher: the launcher relays the start itself when Epic's client is missing, and says plainly when Rockstar still insists on it.",
        tr: "Rockstar'ın Epic oyunları (GTA III/VC/SA Definitive Edition, GTA V, RDR2) Epic Games Launcher olmadan başlatılabiliyor: Epic istemcisi kurulu değilse launcher başlatmayı kendisi aktarıyor, Rockstar yine de onu isterse bunu açıkça söylüyor.",
      },
      {
        en: "Settings can hide the Spotify and Discord pages, and the sidebar player steps aside by itself when it is idle or the window is small.",
        tr: "Ayarlar Spotify ve Discord sayfalarını gizleyebiliyor; kenar çubuğu oynatıcısı boştayken ya da pencere küçükken kendiliğinden çekiliyor.",
      },
      {
        en: "Settings → Launchers knows the Rockstar Games Launcher too: it is detected, offers its download when missing and an Open client button when it is installed.",
        tr: "Ayarlar → Başlatıcılar artık Rockstar Games Launcher'ı da tanıyor: algılanıyor, eksikse indirme bağlantısı, kuruluysa \"İstemciyi aç\" düğmesi sunuyor.",
      },
    ],
    fixed: [
      {
        en: "The Completed list showed the installed game's folder size after an update; it now reports the size of the transfer itself.",
        tr: "Completed listesi bir güncellemeden sonra kurulu oyunun klasör boyutunu gösteriyordu; artık transferin kendi boyutunu yazıyor.",
      },
      {
        en: "A Rockstar title that cannot be relayed says what is missing instead of dropping into Rockstar's \"please try reinstalling\" error, and the Epic Games Launcher is found by its registry entry too, so installs moved out of the default folder work.",
        tr: "Aktarılamayan bir Rockstar oyunu, Rockstar'ın \"please try reinstalling\" hatasına düşmek yerine neyin eksik olduğunu söylüyor; Epic Games Launcher varsayılan klasörden taşınmış olsa da kayıt defteri kaydından bulunuyor.",
      },
      {
        en: "The Spotify session token stays fresh and the playlist library no longer breaks on a single odd entry, so metadata and artwork keep working.",
        tr: "Spotify oturum anahtarı tazeleniyor ve çalma listesi kitaplığı tek bir bozuk kayıtta bozulmuyor; meta veri ve kapaklar çalışmaya devam ediyor.",
      },
      {
        en: "The overlay's empty readings and empty FPS graph read quietly, and the one-time Windows permission notice stays in the view that needs it.",
        tr: "Arayüzün boş okumaları ve boş FPS grafiği sakin görünüyor; tek seferlik Windows izni bildirimi yalnızca gereken görünümde kalıyor.",
      },
      {
        en: "The profile banner picker no longer stretches store logos, opens wider and pages its grid; the Storage Manager keeps one stable size.",
        tr: "Profil banner seçicisi mağaza logolarını artık esnetmiyor, daha geniş açılıyor ve ızgarasını sayfalıyor; Depolama Yöneticisi sabit boyutta kalıyor.",
      },
      {
        en: "The feature list read the whole GTA family as single- and multiplayer; the Definitive trilogy is single-player, while GTA V and the Red Dead titles keep their online mode.",
        tr: "Özellik listesi tüm GTA ailesini tek ve çok oyunculu sayıyordu; Definitive üçlemesi tek oyunculu, GTA V ve Red Dead oyunları ise çevrimiçi modunu koruyor.",
      },
      {
        en: "HowLongToBeat also finds games whose store title carries a version tag: \"Grand Theft Auto V Enhanced\" and \"... Legacy\" look up the GTA V entry instead of staying empty.",
        tr: "HowLongToBeat, mağaza adı sürüm etiketi taşıyan oyunları da buluyor: \"Grand Theft Auto V Enhanced\" ve \"... Legacy\" artık boş kalmak yerine GTA V kaydına bakıyor.",
      },
    ],
  },
  {
    version: "0.1.27",
    date: "2026-10-08",
    items: [
      {
        en: "Hide-games and hide-achievements dialogs label every copy with its storefront, so a title owned on several stores is easy to tell apart.",
        tr: "Oyun ve başarım gizleme pencereleri her kopyayı mağazasıyla etiketliyor; birden fazla mağazada olan oyunlar artık rahatça ayırt ediliyor.",
      },
      {
        en: "Multi-store games combine their playtime and last-played time: the storefront filter no longer shuffles the library, and Settings → Appearance can show each store copy as its own card instead.",
        tr: "Birden fazla mağazadaki oyunların oynama süresi ve son oynanma zamanı birleştirildi: mağaza filtresi artık kütüphaneyi yerinden oynatmıyor; Ayarlar → Görünüm'den her kopya ayrı kart olarak da gösterilebiliyor.",
      },
      {
        en: "The Steam download row shows a progress bar under its live text.",
        tr: "Steam indirme satırı, canlı metnin altında bir ilerleme çubuğu gösteriyor.",
      },
    ],
    fixed: [
      {
        en: "Xbox achievements and gamerscore load for the whole library in the background: library badges and the profile update without opening each game page first.",
        tr: "Xbox başarımları ve gamerscore tüm kütüphane için arka planda yükleniyor: kütüphane rozetleri ve profil, her oyun sayfasını açmadan güncelleniyor.",
      },
      {
        en: "The Steam download row no longer flashes its percentage and size, and a finished transfer leaves the list immediately instead of sitting on Calculating.",
        tr: "Steam indirme satırı artık yüzde ve boyutu yanıp sönmüyor; biten transfer \"Hesaplanıyor\"da takılmak yerine listeden hemen ayrılıyor.",
      },
      {
        en: "Update rows no longer show the installed game size as if it were the update size; a paused Steam update shows its real download total.",
        tr: "Güncelleme satırları artık kurulu oyun boyutunu güncelleme boyutu gibi göstermiyor; duraklatılmış Steam güncellemesi gerçek indirme toplamını gösteriyor.",
      },
      {
        en: "The Storage Manager modal keeps one stable size instead of resizing with its list.",
        tr: "Depolama Yöneticisi penceresi artık listesine göre boyut değiştirmiyor; sabit kalıyor.",
      },
      {
        en: "The Show button in the hidden-achievements list lines up with the row's badge column.",
        tr: "Gizli başarımlar listesindeki Göster düğmesi satırın rozet kolonuyla hizalanıyor.",
      },
    ],
  },
  {
    version: "0.1.26",
    date: "2026-10-08",
    items: [
      {
        en: "The profile page is rebuilt as an Xbox-style hub: a cinematic banner hero with your avatar, presence and a stat bar, store scope chips, a horizontal Recently Played row and achievements as a cover grid.",
        tr: "Profil sayfası Xbox tarzı bir merkez olarak yeniden inşa edildi: avatarınız, çevrimiçi durumunuz ve istatistik çubuğuyla sinematik bir banner, mağaza kapsamı çipleri, yatay Son Oynananlar satırı ve kapak ızgarası biçiminde başarımlar.",
      },
      {
        en: "Achievements switch between the cover grid and a rich list table: every row carries playtime under the title, the trophy count above its progress bar, plus XP, last-used and the completion badge in its own column.",
        tr: "Başarımlar kapak ızgarası ile zengin liste tablosu arasında geçiş yapıyor: her satırda oyun adının altında oynama süresi, ilerleme çubuğunun üstünde kupa sayısı; ayrıca XP, son kullanım ve tamamlanma rozeti kendi kolonunda.",
      },
      {
        en: "The profile banner can be picked from any game in your library, per store or account, and Amazon Games gets its own scope chip and account rows in the profile.",
        tr: "Profil banner'ı kütüphanenizdeki herhangi bir oyundan mağaza veya hesap bazında seçilebiliyor; Amazon Games de profilde kendi kapsam çipi ve hesap satırlarıyla yer alıyor.",
      },
      {
        en: "The game overview shows a HowLongToBeat card with main story, main + extra and completionist times in a clean vertical list.",
        tr: "Oyun genel bakışında ana hikâye, ana + ekstralar ve tamamlayıcı bitirme sürelerini sade bir dikey listede gösteren bir HowLongToBeat kartı var.",
      },
      {
        en: "The Xbox storefront is painted with the launcher's dark theme — cards, filters and dropdowns included — behind a short anti-flash veil while it loads.",
        tr: "Xbox mağazası kartlar, filtreler ve açılır menüler dahil launcher'ın koyu temasıyla boyanıyor; yüklenirken kısa bir beyaz-flaş perdesiyle örtülüyor.",
      },
    ],
    fixed: [
      {
        en: "The profile and the Xbox store stop reloading what did not change: typing in the profile or banner search no longer rebuilds the whole grid on every keystroke, and the store theme no longer stacks observers or re-covers an already painted page.",
        tr: "Profil ve Xbox mağazası değişmeyen şeyi yeniden yüklemiyor: profil veya banner aramasında yazmak artık her tuşta tüm ızgarayı yeniden kurmuyor; mağaza teması da gözlemci biriktirmiyor ve boyanmış sayfanın üstüne perdeyi tekrar indirmiyor.",
      },
      {
        en: "Opening the profile without a signed-in Epic session no longer sends a profile fetch and four store-summary calls that could only fail.",
        tr: "Epic oturumu yokken profil açmak artık yalnızca başarısız olabilecek bir profil isteği ve dört mağaza özeti çağrısı göndermiyor.",
      },
      {
        en: "The achievement list reads cleaner: playtime sits under the game title, the trophy count above its progress bar, and the completion percentage only in the last column.",
        tr: "Başarım listesi sadeleşti: oynama süresi oyun adının altında, kupa sayısı ilerleme çubuğunun üstünde ve tamamlanma yüzdesi yalnızca son kolonda.",
      },
    ],
  },
  {
    version: "0.1.25",
    date: "2026-10-07",
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
        en: "Resumable Upload Engine: large save archives (e.g. 250MB+ Neon Grid saves) upload reliably with Google Drive's resumable chunked protocol.",
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

/**
 * The storefront and the Spotify page are native children: there the card goes
 * into the same child host the notifications dropdown uses, so the page stays
 * visible behind it. Everywhere else the plain in-page modal is used.
 */
export function openChangelogModal(): void {
  if (embeddedContentShown()) {
    void presentChangelogOverlay();
    return;
  }
  void holdStoreOverlay("changelog");
  renderChangelogModal();
}

export function closeChangelogModal(): void {
  if (changelogRoot) changelogRoot.innerHTML = "";
  if (changelogOverlayOn) {
    changelogOverlayOn = false;
    // The host is shared with the notifications dropdown.
    if (isTauri) void invoke("hide_notif_overlay").catch(() => undefined);
  }
  releaseStoreOverlay("changelog");
}

/** True while the card floats in the child host instead of the DOM. */
let changelogOverlayOn = false;

/** Sizes the host to the card and centers it over the embedded page. */
async function presentChangelogOverlay(): Promise<void> {
  if (!isTauri) {
    void holdStoreOverlay("changelog");
    renderChangelogModal();
    return;
  }

  // Measure the real card first: the host is sized to it and carries the same
  // stylesheet, so both render at the same size.
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-4000px;top:0;width:720px;visibility:hidden;";
  holder.innerHTML = changelogModalHtml();
  document.body.appendChild(holder);
  const card = holder.querySelector<HTMLElement>(".changelog-dialog");
  const width = Math.min(card?.offsetWidth ?? 640, window.innerWidth - 16);
  const height = Math.min(card?.offsetHeight ?? 640, Math.round(window.innerHeight * 0.9));
  holder.remove();

  // Centered on the launcher window, exactly where the in-page modal sits.
  const x = Math.max(8, Math.round((window.innerWidth - width) / 2));
  const y = Math.max(8, Math.round((window.innerHeight - height) / 2));
  changelogOverlayOn = true;
  try {
    await invoke("show_notif_overlay", {
      x,
      y,
      width,
      height,
      html: overlayThemeStyle() + changelogModalHtml(),
    });
  } catch {
    // No child host available: fall back to the in-page modal.
    changelogOverlayOn = false;
    void holdStoreOverlay("changelog");
    renderChangelogModal();
  }
}

/** Clicking the page behind the card closes it, like any modal. */
if (isTauri) {
  void listen<{ act?: string }>("notif-overlay-act", (event) => {
    if (event.payload?.act === "overlay-close" && changelogOverlayOn) closeChangelogModal();
  });
}

/** The card markup: one source for the DOM modal and the child host. */
function changelogModalHtml(): string {
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

  return `
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

export function renderChangelogModal(): void {
  if (!changelogRoot) return;
  changelogRoot.innerHTML = changelogModalHtml();
}

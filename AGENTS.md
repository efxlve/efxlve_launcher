# AGENTS.md — Efxlve Launcher

> Bu dosya, bu projede çalışacak AI ajanları (ve insan geliştiriciler) içindir.
> Kısa tut, güncel tut: davranış değiştiren her karardan sonra ilgili bölümü güncelle.

## 1. Proje nedir?

Epic Games kütüphanesini yöneten **alternatif masaüstü launcher** (Windows odaklı).
`legendary` CLI'ı (GPL-3.0, harici binary) Rust backend ile sarar; arayüz Vite + TypeScript.
Epic Games Store'un kendisi gömülü webview ile uygulama içinden açılır.

## 2. Yığın ve sürümler

- **Tauri v2** (`tauri 2.x`, `features = ["unstable"]` — gömülü mağaza webview'i için şart, bkz. §7)
- **Rust stable** (MSVC toolchain, Windows) + **Node 20+**
- Frontend: **Vite 6 + TypeScript 5.6 (vanilla, framework yok)** + `lucide` (sadece statik header ikonları; dinamik içerikte inline SVG kullanılır)
- Backend crate'ler: `serde/serde_json`, `thiserror`, `tokio` (fs, io-util, process, rt, time), `reqwest` (rustls, stream), `url`
- Hedef platform: **Windows x86_64** (`custom-protocol` feature açık)

## 3. Komutlar

```powershell
npm.cmd run tauri dev      # ÖNERİLEN: tam uygulama (önce npm.cmd! bkz. §7)
npm.cmd run build          # tsc --noEmit && vite build (frontend doğrulama)
# Rust (PATH bayatsa $env:USERPROFILE\.cargo\bin'i başa ekle, bkz. §7):
cargo check                # hızlı Rust doğrulama
cargo test                 # birim testleri (şart: yeni parse/mantık → test ekle)
```

- `npm` yerine **`npm.cmd`** kullan (PowerShell execution policy `npm.ps1`'i engeller).
- Yeni Rust bağımlılığı eklediğinde `cargo check` + `cargo test` yeşil olmadan bitirme.
- Frontend değişikliği `tsc` hatasız geçmeli (`npm run build` bunu kapsar).

## 4. Mimari

```
src/
  main.ts      # TÜM UI mantığı (~1300 satır): view'lar, render, olay delegasyonu
  epic.ts      # Epic API katmanı: tipler (snake_case!), invoke sarmalayıcıları, kapak/açıklama seçimi
  styles.css   # Tek stil dosyası, CSS değişkenli tema (:root)
  index.html   # Üst bar + içerik + alt bar iskeleti
src-tauri/src/
  main.rs                  # Komut kayıtları (generate_handler), AppState, ayarlar, mağaza/klasör pencereleri
  legendary/
    mod.rs      # LegendaryError + friendly() + transient_reason() + NOT_AUTHENTICATED
    models.rs   # legendary --json şemaları (null-toleranslı, bkz. §7)
    client.rs   # subprocess koşturucu (timeout, stdout=JSON / stderr=log ayrımı)
    paths.rs    # binary çözümleme (ayar → app_data → yok)
    downloader.rs # legendary.exe oto-indirme (GitHub releases, progress event)
    skip.rs     # bozuk katalog öğesi otomatik atlama (stub metadata + skipped.json)
    cache.rs    # diskten anlık okuma: user.json, metadata/, installed.json
    commands.rs # Tauri komutları (setup/status/library/login + recovery döngüsü)
    transfers.rs# install/progress/queue/cancel/uninstall/launch
```

**Veri akışı ilkesi (Heroic'ten alındı):** arayüz ÖNCE diskten okunur (`epic_cached_library`),
ağ senkronu (`epic_list_games`) arka planda koşar; senkron patlarsa ekran kalır, not düşülür.
Asla tüm kütüphaneyi tek `list` çağrısına bağlama.

## 5. Tauri komutları (hepsi `main.ts`/`epic.ts` üzerinden çağrılır)

Kurulum/kimlik: `epic_setup_status`, `epic_ensure_binary`, `epic_status`,
`epic_login_with_code` (ham kod VEYA `{"authorizationCode":...}` JSON'u kabul eder),
`epic_import_egl`, `epic_logout`, `epic_get_settings`, `epic_set_alt_bin`, `epic_get_game_settings`, `epic_save_game_settings`, `epic_verify_game`, `epic_sync_saves`, `epic_create_desktop_shortcut`, `epic_get_playtimes`, `epic_set_playtime`
Kütüphane: `epic_cached_library`, `epic_list_games`, `epic_list_installed`,
`epic_list_skipped`, `epic_get_achievements_summary`, `epic_get_achievements`,
`epic_detect_egl_games`, `epic_sync_egl_installed`, `epic_get_game_dlcs`, `epic_get_install_options`, `epic_check_updates`,
`epic_get_collections`, `epic_save_collection`, `epic_delete_collection`, `epic_set_game_collections`, `epic_import_egl_collections`
Transfer: `epic_install_game`, `epic_install_with_options`, `epic_cancel_download`, `epic_uninstall_game`,
`epic_default_install_dir`, `epic_set_install_dir`, `epic_launch_game`, `epic_pause_download`, `epic_resume_download`, `epic_reorder_queue`, `epic_get_queue`
Pencere: `show_store_view`, `hide_store_view`, `open_folder`, `app_minimize`, `app_toggle_maximize`, `app_is_maximized`, `app_close`, `app_set_decorations`

**Event'ler (frontend dinler):** `download-progress {id, progress, done, speed, speedBytes, diskSpeed, diskBytes, eta, downloadedBytes, totalBytes}`,
`download-failed {id, message}`, `download-cancelled {id}`, `download-paused {id}`,
`verify-progress {id, current, total, percent, speed}`, `verify-complete {id, success, message}`,
`legendary-setup {state, progress, message}`, `legendary-library {state, attempt, message}`

## 6. Kanla öğrenilmiş kurallar (OKUMADAN KOD YAZMA)

1. **Tauri argümanları camelCase'tir!** Rust'ta `app_name: String` → JS'te `{ appName }`
   gönderilir. Tek kelimelik parametrelerde belli olmaz, çok kelimelide patlar
   (`missing required key appName`). Yeni komutta ÇOK KELİMELİ parametre varsa testi şart.
2. **legendary stdout/stderr ayrımı:** `--json` çıktılar **stdout**'a saf JSON olarak gelir;
   loglar ve **indirme ilerlemesi (`= Progress: NN%`, `Downloaded:`, `Download size:`) STDERR**'dedir.
   Progress parse EDERKEN stderr oku; boruları her zaman tüket (dolu boru süreci kilitler).
3. **`list`/`status --offline` bile metadata senkronu yapar** (core.py'deki retry yolu).
   Oturum kontrolü için subprocess YERİNE `user.json` varlığını + `displayName` oku.
4. **Epic 401'leri geçici sanma:** kaldırılmış katalog öğeleri KALICI 401 verir
   (anonim istek de 401 → token'la ilgili değil). `skip.rs` otomatik atlar:
   stderr'deki `namespace/<ns>/bulk/items?id=<item>` parse edilir, `assets.json`'dan
   app bulunur, stub metadata yazılır, `skipped.json`'a işlenir. Namespace'ler her
   zaman hex DEĞİLDİR (`rosemallow` gibi okunabilir adlar olur) — validation'ı dar tutma.
5. **`#[serde(default)]` null'ı kurtarmaz!** legendary `manifest_path: null` gibi açık
   null'lar gönderir → `deserialize_with = "null_string"` (models.rs) kullan.
   Yeni struct alanı eklerken GERÇEK çıktıyla + unit testle doğrula.
6. **`json!` içinde değişken anahtar literal olur!** `{ platform: asset }` →
   `"platform"` yazar. Değişken anahtar için `serde_json::Map` kur (skip.rs: `build_seed` + testi var).
7. **Modal içinde `onclick="stopPropagation()"` YASAK** — document-level delegation'a
   tıklamalar ulaşmaz, kutudaki tüm düğmeler ölür. Kapatma mantığı delegation içinde çözülür.
8. **Vite `target/`'ı izlemesin** (`vite.config.ts` → `server.watch.ignored`); yoksa
   Windows EBUSY ile dev sunucusu çöker.
9. **`user.json` anahtarları snake_case** (`account_id`, `displayName` karışık!).
   Token'ları ASLA loglama/sohbete yapıştırma (sadece anahtar adlarıyla konuş).
10. **Klasör açma = Rust'tan `explorer`** (opener `openPath` scope ister, her sürücüde çalışmaz).
11. **Gömülü mağaza = child webview** (`unstable` + `add_child`); iframe imkânsız
    (`X-Frame-Options: SAMEORIGIN`). Konumu sonradan değişmez → resize'da recreate.
    `add_child` takılmalara karşı `spawn_blocking` + 20 sn timeout ile çağrılır.
12. **Auth akışı:** `https://legendary.gl/epiclogin` → kullanıcı `authorizationCode`'u
    yapıştırır → `auth --code`. Alternatif: EGL'den `auth --import`.
13. **Kurulum bayrakları:** `-y install <app> --base-path <dir> --skip-dlcs --skip-sdl`
    (`-y` global bayrak EN BAŞTA; yoksa DLC sorusu süreci kilitler).
    MemoryError'da `--max-shared-memory 5000` ile bir kez tekrar dene.
14. **Tek aktif indirme + kuyruk** (`EpicDlState`); iptal PID üzerinden (`taskkill`/`kill`),
    yarım dosyalar legendary resume ile devam eder.
15. **Frontend render disiplini:** ilerleme event'inde tüm görünümü YENİDEN ÇİZME —
   sadece `[data-dlbtn]` ve `[data-dlbar]` düğme/çubuklarını güncelle (odak kaybı/kırpışma olur).
   Arama kutusu dinamik view içindeyse full render YAPMA (odak ölür).
16. **Epic Store URL yapısı & Yerleşik Mağaza:**
   Eski `/en-US/search?q=` adresi Epic tarafından genel kurumsal site aramasına yönlendirilir
   (`epicgames.com/site/search`). Doğrudan ürün sayfası linki `https://store.epicgames.com/p/<slug>`
   şeklindedir; slug başlığın alfanümerik normalize edilmesiyle (`toEpicSlug`) üretilir. Mağaza araması
   için ise `/browse?q=` kullanılır. Detay çekmecesindeki "Mağaza" butonu 3. parti harici tarayıcı yerine
   uygulamanın yerleşik child webview mağazasını açar (`openStoreUrl(url, "store")`).
17. **Kütüphane UI Mimarisi & Rozet Güvenliği:**
   - Kart hover katmanında aksiyon butonları (`.top`) daima **sağ üstte** toplanır; sol üstteki `.pbadge`
     durum rozetiyle ASLA çakışmaz.
   - S/M/L kart boyutu dinamiktir (`size-compact`, `size-normal`, `size-large`) ve `localStorage`
     (`efxlve-card-size`) üzerinden hatırlanır.
   - Detay görünümü sağdan kayan sinematik Drawer panelidir; teknik veriler `drawer-meta-grid` ile sunulur.
   - Windows varsayılan kalın beyaz scrollbar'ları engellenmiştir; tüm uygulamada ince (6px) yarı saydam koyu scrollbar, başarım listesinde ise altın vurgulu özel ince scrollbar kullanılır.
18. **Özel Çerçevesiz Başlık Çubuğu & Pencere Kontrolleri:**
   - Windows yerel başlık çubuğu `tauri.conf.json` içinde `"decorations": false` ile kaldırılmıştır.
   - Üst bar (`header#titlebar`) `-webkit-app-region: drag` ve `data-tauri-drag-region` ile taşınabilir;
     tüm interaktif düğmeler (`#nav button`, `.win-btn`) `-webkit-app-region: no-drag` ile korunur.
   - Pencere küçült, ekranı kapla/geri yükle ve kapat işlemleri Rust komutları (`app_minimize`,
     `app_toggle_maximize`, `app_close`) üzerinden güvenle yürütülür. Çift tıklama pencereyi büyütüp küçültür.
   - Gömülü çocuk webview (`storeRect`) konumu `y: titlebar.offsetHeight` formülüyle başlık çubuğuna tam oturur.
19. **"Son Oynanan" ve Hero Spotlight Disiplini:**
   - `pushRecent(appName)` SADECE oyun gerçekten başlatıldığında (`epicPlay`) çağrılır; detay çekmecesi
     açıldığında (`openEpicModal`) ASLA çağrılmaz.
   - Yalnızca gerçekten kurulu olan oyunlar (`s.installed`) "Son Oynanan" rozeti alabilir veya sıralamada öne geçebilir.
     Kütüphane her yüklendiğinde ve kaldırıldığında kurulu olmayan oyunlar `efxlve-recent` listesinden ayıklanır (`pruneRecent`).
   - Hero Spotlight afişi öncelik sırası: 1) Son oynanmış ve kurulu oyun (`Son Oynanan`), 2) Kurulu favori,
      3) **Günün Oyunu (`✨ Günün Oyunu`)** — tarih bazlı deterministik tohum ile kütüphaneden geniş afişli sürpriz oyun,
      4) Favori, 5) İlk oyun. Rozeti duruma göre `Son Oynanan`, `Günün Oyunu`, `Kurulu Oyun`, `Favori` veya `Öne Çıkan` olur.
20. **Başarımlar (Achievements) & Platin Kupa Mimarisi:**
    - 488+ oyunluk kütüphanede her oyun için tek tek ağ isteği atmak Epic hız sınırına takılır (429) ve açılışı kilitler.
    - `legendary`, sorgulanan başarımları `%USERPROFILE%\.config\legendary\achievements.json` içine namespace (sandboxId) bazlı kaydeder (`totalUnlocked`, `totalXP`, `playerAwards: [awardType: "PLATINUM"]`).
    - `epic_get_achievements_summary` (`scan_achievements_summary`), `metadata/*.json` dosyalarından oyun tanımlarını (`total_achievements`, `total_product_xp`) ve `achievements.json` dosyasından kullanıcının gerçek kilit açma verilerini diskten 0ms içinde haritalar.
    - `legendary achievements --json <app>` çıktısında doğrudan `achievements` adında bir anahtar YOKTUR; öğeler durumlarına göre `completed`, `in_progress`, `uninitiated` ve `hidden` dizileri altında döner. `GameAchievementsResponse.consolidate()` metodu bu dizileri birleştirerek `achievements` alanını doldurur ve toplamları garantiler.
    - `epic_get_achievements`, diskteki eski boş önbellekleri (`achievements: []` kalmış olanlar) geçersiz sayıp otomatik olarak taze veri çeker. Başarımı olmayan oyunlarda legendary'nin boş çıktısı (`No achievements found`) `supported: Some(false)` olarak zarifçe yakalanıp önbelleklenir ve UI'ın kilitlenmesi engellenir.
    - Platin Kupa (`is_platinum = (total_achievements > 0 && user_unlocked >= total_achievements) || has_platinum_award` veya demo önizleme):
      - Kütüphane araç çubuğunda `🏆 Platin` filtre çipi (sayı rozetli) ve sıralamada `Platin kupalılar` seçeneği.
      - Platin filtresi seçildiğinde altın ışıltılı özel kategori tebrik afişi (`.plat-category-banner`).
      - Portre kart çevresinde asil ve sabit sıcak altın hale (`box-shadow` aurası), periyodik zarif holografik ışık geçişi (`plat-shimmer-pass`, kartlar arası doğal sırayla parıldayan) ve hover anlık ışıma efekti.
      - Sağ üstte parlak altın kurdele rozet (`.platinum-ribbon` + minik ışıltı `✨` — hover sırasında aksiyon butonlarını engellememesi için `opacity: 0` ile kaybolur).
      - Detay çekmecesinde "Genel Bakış" ve "🏆 Başarımlar" sekmeleri, altın ilerleme çubuğu, kategori filtreleri (Tümü/Kazanılanlar/Kilitliler), nadirlik yüzdesi, XP hapları, doğrudan gömülü mağazada açan "Mağaza Başarımları" (`epicAchievementsUrl`) butonu ve test için anlık Platin Efekti Aç/Kapat toggle'ı yer alır.
21. **3. Parti Başlatıcılar (EA App, Ubisoft Connect vb.) ve Hile Koruması (Anti-Cheat):**
    - `legendary list` varsayılan olarak Origin/EA gibi 3. parti harici başlatıcılara devredilen oyunları listelemez. Bu oyunların katalogdan çekilmesi ve yerel önbelleğe (`metadata/*.json`) kaydedilmesi için `list -T --json` (`--third-party`) bayrağı zorunludur.
    - 3. parti oyunların başlatılması: `installed.json` içinde yer almasalar bile `legendary launch <app> --origin` (EA App protocol URI: `link2ea://...`) veya `--ubisoft` (`uplay://...`) bayraklarıyla doğrudan tetiklenir.
    - Detay çekmecesinde `customAttributes` ve bilinen oyun tanımları taranarak 3. parti başlatıcı (`EA App`, `Ubisoft Connect`, `Rockstar Games Launcher`) ve Hile Koruması (`BattlEye`, `Easy Anti-Cheat`, `Denuvo`, `Riot Vanguard`) rozet ve meta ızgarası kutucuğu olarak net bir şekilde sunulur.
22. **EA App / 3. Parti Oyunların Başarım (Achievements) Durumu:**
    - Epic Games Store'da 2021 öncesi çıkan veya harici başlatıcıya devredilen bazı EA oyunlarının (*Star Wars: Jedi Fallen Order*, *Star Wars Squadrons*, *Battlefront II* vb.) katalog metadata'sında (`metadata/<app>.json`) `"achievements": null` döner. Bu oyunların başarımları Epic Online Services (EOS) üzerinde kayıtlı DEĞİLDİR; doğrudan EA App / Origin hesabı üzerinden takip edilir.
    - `legendary achievements` komutu metadata içinde `achievements` nesnesi olmayan oyunlarda Python `AttributeError: 'NoneType' object has no attribute 'achievements'` hatası verir. `commands.rs` içindeki `epic_get_achievements` bu hatayı yakalar (`AttributeError` / `NoneType`) ve `supported: Some(false)` olarak ele alır.
    - Detay çekmecesinde 3. parti oyunda Epic başarımı bulunmadığında "Başarım Desteği Bulunmuyor" yerine `${partner.name} Başarımları` kartı gösterilir; başarımların EA App üzerinden takip edildiği belirtilerek doğrudan `${partner.name}'i Aç` eylemi verilir.
    - Epic başarımı tanımlanmış diğer EA oyunları (*Need for Speed™ Heat*, *Payback*, *Deluxe*, *Apex Legends* vb.) ise hem toplam XP hem de başarımlarıyla standart başarım arayüzünde sorunsuz çalışır.
23. **Gizli Başarımlar (Secret Achievements) ve Spoiler Koruması:**
    - `legendary achievements` CLI çıktısı uninitiated durumdaki bazı gizli başarımları yanlışlıkla `hidden: false` olarak sınıflandırabilir veya kilitli olanlarda başlık/açıklamayı boş string (`""`) döndürebilir.
    - `enrich_achievements_from_metadata` (Rust) ve `enrichAchievementsData` (Frontend JS) diskteki `%USERPROFILE%\.config\legendary\metadata\<app>.json` dosyasındaki `meta.achievements.achievements` kataloğunu tarayarak `hidden: true`, `is_base` bayraklarını düzeltir; boş olan `display_name`, `description`, `icon_link` alanlarını orijinal katalog verisiyle doldurur. İkili (dual) fallback mimarisi canlı çalışma ve dev ortamında anında düzeltmeyi garantiler.
    - Frontend'de kilitli gizli başarımlar varsayılan olarak `🔒 Gizli Başarım` şeklinde gizlenir ve spoiler korumasına alınır. Kullanıcı karta veya `[👁️ Göster]` butonuna tıkladığında gerçek başlık, açıklama ve ikon anında açılır; tekrar tıklanırsa geri gizlenebilir. Zaten kazanılmış gizli başarımlar ise açık gösterilir ve yanında `[Gizli]` etiketi taşır.
24. **Ana Oyun (Base Game) vs Ek Paketler (DLC), Platin Kupa & Kompakt Başarım UI:**
    - Epic Games Store kuralına göre Platin Kupa, oyunun sadece **Ana Oyun (Base Game)** başarımları (%100, genellikle 1000 XP) tamamlandığında hak edilir. DLC / Ek paket başarımlarının tamamlanmamış olması Platin Kupayı engellemez.
    - `models.rs` içindeki `consolidate()` metodu ve `commands.rs` içindeki `scan_achievements_summary` hem genel toplamı hem de `base_achievements` ve `base_unlocked` sayılarını tarar; `base_achievements > 0 && base_unlocked >= base_achievements` durumunda oyunu Platin Kupa olarak tesciller.
    - **Ultra-Kompakt & Duyarlı UI Tasarımı:**
      - Detay çekmecesindeki hantal çoklu kutular yerine ~55px'lik tek satır kompakt başlık kartı (`.ach-hero-compact`) kullanılır. Genel XP, mağaza linki, yenileme butonu ve tek satırda çift istatistik (`Genel: X/Y • 🎮 Ana Oyun: A/B`) yer alır.
      - Kapsam (`Tümü`, `🎮 Ana Oyun`, `📦 Ek Paketler`) ve Durum filtreleri (`Tümü`, `Kazanılanlar`, `Kilitliler`, `Gizli`) ince hap şeritleri (`.ach-scope-strip`, `.ach-status-strip`) olarak dizilir. `Ana Oyun` çipinde gereksiz kupa emojisi yer almaz.
      - Başarım listesi (`.ach-list`) sabit piksel yerine dinamik `max-height: calc(100vh - 275px)` ile 1080p ve dizüstü ekranlarına kusursuz uyum sağlar; dikey taşma engellenir. Test butonu arayüzden tamamen temizlenmiştir.
      - **Çekmece İçi Pürüzsüz Geçiş ve Oto-Yenilenme Disiplini:**
        - Detay çekmecesi ilk açıldığında ("Genel Bakış" sekmesi) arka planda otomatik `fetchAndRenderAchievements` ÇAĞRILMAZ. Ağ sorgusu yalnızca kullanıcı açıkça "🏆 Başarımlar" sekmesine tıkladığında veya yenileme istediğinde çalışır; böylece kullanıcının gözü önünde sayfanın kendi kendine yenilenmesi (spontaneous refresh) engellenir.
        - Sekmeler ve başarım filtreleri arasında geçiş yapılırken (`isInitialOpen = false`) tüm `overlay` ve `drawer` DOM'u asla yıkılıp baştan kurulmaz (`modalRoot.innerHTML` sıfırlanmaz). Yalnızca `#drawer-tab-content` ve buton durumları yerinde (in-place) güncellenir; liste kaydırma pozisyonu (`existingDrawer.scrollTop` ve `.ach-list.scrollTop`) korunur. Böylece anlık kapanıp açılma, kararma ve animasyon kırpışması tamamen engellenmiştir.
25. **Sistem Gereksinimleri (Hardware Specs) & Akamai CDN Entegrasyonu:**
    - Epic Games Store web sayfaları ve GraphQL sorguları bot/Cloudflare engeline takılabilir; buna karşın Akamai CDN üzerindeki ürün içerik API'si (`https://store-content-ipv4.ak.epicgames.com/api/tr-TR/content/products/<slug>` ve fallback `en-US`) engelsiz ve hızlıdır.
    - `generate_slug_candidates` motoru:
      - Unicode tırnak ve özel karakterleri (`’`, `‘`, `“`, `”`, `™`, `®`, `\u{00A0}` vb.) boşluğa çevirerek URL bozulmasını engeller.
      - `metadata/<app>.json` içindeki `FolderName` alanını tarar ve camelCase/harf-rakam geçişlerini (`RainbowSixSiege` -> `rainbow-six-siege`, `BusSimulator21` -> `bus-simulator-21`) ayırarak doğrudan doğru mağaza slug'ını türetir.
      - Yayıncı/seri ön eklerini ("Tom Clancy's", "Sid Meier's", "Marvel's", "Disney's", "EA SPORTS", "Star Wars", "Warhammer" vb.) temizler.
      - İki nokta (`:`) ve tire (` - `) sonrası alt başlıkları ("The Amulet of Chaos" vb.) ve edisyon takılarını ("Standard Edition", "Definitive Edition", "Next Stop" vb.) temizleyerek alternatif adaylar üretir.
    - Sistem gereksinimleri `epic_get_system_requirements` Tauri komutu ile çekilir; dönen sistemler (`Windows`, `Mac OS`), Minimum ve Önerilen donanım spesifikasyonları (OS, CPU, RAM, GPU, Depolama, DirectX, Ses, Ağ, Giriş/Hesap) ve desteklenen diller `%USERPROFILE%\.config\legendary\specs\<app_name>.json` içine yerel olarak önbelleklenir. Başarısız sorgularda kalıcı `supported: false` diske kilitlenmez ve `force_refresh` parametresi ile yeniden sorgulama desteklenir.
    - Detay çekmecesinde platform eşleme katı string eşitliği (`=== "windows"`) yerine esnek alt dize (`.includes("win")`, `.includes("mac")`) kontrolüyle yapılır; böylece "PC", "Mac OS", "macOS" gibi farklı platform adlandırmaları sorunsuz yakalanır. Donanım etiketleri "Windows OS", "Windows Processor" gibi prefix'leri de temizleyerek Türkçe başlıklarla sunulur. "Genel Bakış" meta ızgarasında doğrudan Sistem sekmesine zıplayan interaktif bir kısayol kutucuğu yer alır.
26. **Modernize Edilmiş Başarım UI Tasarımı:**
    - Kaba dikdörtgen kutular yerine yuvarlatılmış modern squircle başarım ikonları (`border-radius: 12px`, 44x44px), neon/altın vurgulu ışıltılı ilerleme çubuğu ve fırçalanmış cam arka planlı kompakt başlık kartı (`.ach-hero-compact`) uygulanmıştır.
    - Tier seviyeleri Türkçe adlandırılmıştır (`Bronz`, `Gümüş`, `Altın`, `Platin`) ve renkli minimal hap rozetler ile sunulur.
    - Tamamlanan başarılarda zarif yeşil halka onay ikonu (`.ach-check-circle`), kilitli gizli başarılarda ise spoiler korumalı gizlilik etiketi yer alır.
    - Filtre butonları (`.ach-scope-pill`, `.ach-status-pill`) segment hap kontrolü şeklinde modernleştirilmiştir.
27. **Epic Games Launcher (EGL) & 3. Parti Kurulu Oyunları Otomatik Algılama ve Eşitleme:**
    - Orijinal Epic Games Launcher tarafından kurulmuş oyunlar Windows'ta `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item` JSON manifestleri altında tutulur.
    - 3. parti başlatıcılara devredilen oyunlar (Ubisoft Connect: *Watch Dogs*, EA App vb.) ise oyun kataloğundaki `metadata/<app>.json` içinde yer alan `RegistryPath` ve `RegistryKey` customAttribute'ları taranarak Windows Registry üzerinden otomatik algılanır (`read_third_party_installed_games`).
    - `cache.rs::read_installed` kütüphane taranırken diskteki bu `.item` manifestlerini ve 3. parti Registry kurulumlarını otomatik birleştirir; yeni bulunan oyunları anında `%USERPROFILE%\.config\legendary\installed.json` kütüğüne kalıcı işler.
    - Bu sayede herhangi bir kullanıcı launcher'ı açtığında veya arkaplan senkronu (`epic_list_installed`) çalıştığında ek işlem yapmasına gerek kalmadan tüm oyunları (Cyberpunk 2077, RDR2, Spider-Man, GTA V, Dead by Daylight, Watch Dogs vb.) anında "Kurulu" olarak hazır listelenir.
    - Ayarlar (Settings) sayfasında yer alan EGL Entegrasyon paneli (`epic_detect_egl_games`, `epic_sync_egl_installed`) kullanıcının EGL kütüphanesini detaylı (oyun adı, boyut, dizin) görmesini sağlar.
28. **Oyun Yönetim Paneli, Steam Tarzı İndirme Merkezi, Eklenti/DLC & Seçici Kurulum Mimarisi:**
    - **Oyun Yönetim Paneli (`epic_get_game_settings`, `epic_save_game_settings`):**
      - Her oyunun ayarları `%USERPROFILE%\.config\legendary\game_settings\<app>.json` içinde saklanır (`launchParameters`, `autoUpdate`, `highPriority`, `cloudSavesEnabled`, `lastCloudSync`).
      - Başlatma parametreleri (`-dx11`, `-novid` vb.) `epicPlay` sırasında doğrudan legendary launch argüman listesine enjekte edilir.
      - Dosya Doğrulama: `legendary verify <app>` subprocess'i `verify-progress` olayları yayar, yüzdesi ve hızı panelde canlı işlenir. Yüksek frekanslı doğrulama olaylarında dialog DOM'u yeniden yıkılmaz (`renderManageModal()` çağrılmaz); `#manage-verify-fill`, `#manage-verify-count` ve `#manage-verify-speed` öğeleri yerinde (in-place) güncellenerek kırpışma ve `popIn` animasyonunun tetiklenmesi önlenir.
      - 0ms Anında Açılış: `openManageModal`, disk veya registry okumasını beklemeden mevcut kütüphane özetiyle modalı 0ms içinde anında açar; arka planda tamamlanan ayarlar dialogu bozmadan yerinde işlenir.
      - Bulut Senkronu (`legendary sync-saves <app>`) ve Masaüstü Kısayolu (Windows VBScript tabanlı `.lnk` oluşturma) panelden tek tıkla yürütülür.
    - **Steam Tarzı İndirme Merkezi (Download Hub):**
      - İndirme hızı ve disk yazma hızı regex ile parse edilerek `download-progress` event'i ile anlık aktarılır (`speedBytes`, `diskBytes`, `eta`, `downloadedBytes`, `totalBytes`).
      - HTML5 Canvas üzerinde Steam benzeri çift katmanlı neon bezier hız grafiği çizilir (cyan ağ hızı, green disk hızı, 60 saniyelik dinamik arabellek).
      - Kuyruk yönetimi (`epic_pause_download`, `epic_resume_download`, `epic_reorder_queue`) ile indirmeler duraklatılabilir, sırası değiştirilebilir veya iptal edilebilir.
    - **Eklenti & DLC Yönetimi (Add-ons Manager):**
      - Katalogdaki tüm `dlcItemList` doğrudan gösterilmez! Yalnızca kullanıcının hesabına ait (`entitlements.json`), indirilebilir asset'i olan (`assets.json`) veya kurulu (`installed.json` / EGL manifests) eklentiler listelenir (`is_owned`). Sahip olunmayan mağaza öğeleri kesinlikle elenir.
      - İndirilebilir paketler (`downloadable: true`, `Phantom Liberty`, `REDmod` vb.) için yükleme/kaldırma toggle switch'i sunulur (`epic_install_game`, `epic_uninstall_game`).
      - Hesaba tanımlı dahili paketler (`downloadable: false`, Dead by Daylight bölümleri, kozmetikler, in-game içerikler) için CLI indirme hatasını (`Could not find ... in list of available games`) engellemek amacıyla toggle yerine `✓ Hesapta Aktif` rozeti gösterilir.
      - "Bitmedi, dahası da var" mağaza kartı doğrudan Epic Store eklenti sayfasına yönlendirir.
    - **Seçici Kurulum Modalı (Selective Install Dialog):**
      - `legendary info <app> --offline --json` çıktısındaki manifest `tag_disk_size` ve `tag_download_size` verileri ayrıştırılır.
      - Ek diller (Türkçe, İngilizce, Almanca, Fransızca vb.) ve isteğe bağlı DLC paketleri akordeon checkbox listesi olarak sunulur.
      - Seçilen bileşenlere göre toplam indirilecek boyut ve gerekli disk alanı anlık güncellenir.
      - Kurulum `--install-tag` bayraklarıyla tetiklenir (`epic_install_with_options`).
    - **Güncelleme Motoru (Update Engine):**
      - `epic_check_updates`, `installed.json`'daki kurulu sürümü katalogdaki `build_version` ile kıyaslar.
      - Kütüphane kartlarında "⚡ Güncelleme" rozeti, `⚡ Güncellemeler (N)` filtre çipi ve detay panelinde "Güncellemeyi İndir" birincil butonu dinamik sunulur.
29. **Dosya Doğrulama (File Verification), EGL Manifest Entegrasyonu & Çok Katmanlı İlerleme:**
    - Orijinal Epic Games Launcher (EGL) tarafından kurulan oyunlar manifest dosyalarını `<install_path>\.egstore\*.manifest` dizininde saklar. `legendary verify` ise manifest dosyasını `%USERPROFILE%\.config\legendary\manifests\<app>_<platform>_<version>.manifest` konumunda arar. Manifest bulunamadığında CLI `CRITICAL: Manifest appears to be missing!` hatası verip kod 0 ile anında çıkar.
    - `cache.rs::ensure_egl_manifest` ve `commands.rs::epic_verify_game`, oyun doğrulandığında veya algılandığında `.egstore` içerisindeki `.manifest` dosyasını otomatik olarak legendary'nin beklediği adlandırma şablonuyla manifests klasörüne kopyalayarak EGL oyunlarının (Spider-Man, GTA V vb.) sorunsuz doğrulanmasını sağlar.
    - `legendary verify` iki farklı ilerleme formatı üretir: küçük dosyalarda `Verification progress: cur/total (pct%) [speed]`, dev arşiv dosyalarında (Cyberpunk, GTA V, Spider-Man vb.) ise `=> Verifying large file "<name>": pct% (cur/total MiB) [speed]`. Backend'deki `parse_verify_progress` her iki formatı ve 4096-bayt akış tamponu bölünmelerini destekler; ayrıştırılan detay (`detail`), hız (`speed`), dosya adı ve yüzdeyi `verify-progress` event'i ile UI'a anlık basar.
    - 3. parti başlatıcılara ait oyunlar (Watch Dogs vb.) Epic manifestine sahip olmadığından `installed.json` kütüğüne ASLA yazılmaz (yalnızca UI için runtime vektörüne eklenir); aksi takdirde Python `legendary.core.load_manifest` fonksiyonu `TypeError: 'NoneType' object is not subscriptable` ile çöker ve `list_installed` fonksiyonunu kilitler.
    - **Çift Backdrop Filter Stutter Önleme:** Detay çekmecesinden (Drawer) Yönet modalı açılırken (`act === "manage-game"`), alttaki çekmece `closeModal()` ile kapatılır. İki adet eş zamanlı `backdrop-filter: blur(8px)` katmanı WebView2'de GPU donmasına yol açtığından bu işlem performansı maksimize eder ve modalın 0ms'de anında açılmasını sağlar.
30. **Oynama Süresi Takibi (Playtime Tracker), Otomatik Çıkış Senkronizasyonu, Çevrimdışı Mod ve Kayıt Yedekleme:**
    - **Oynama Süresi & Canlı Durum (`playtime.rs`):** Süre kayıtları `%USERPROFILE%\.config\legendary\playtime.json` dosyasında tutulur (`total_seconds`, `session_count`, `last_played_timestamp`, `last_played`).
    - **Süreç İzleme (`transfers.rs::spawn_launched`):** `tokio::process::Command` ile başlatılan oyun süreci hemen terk edilmez (`child.wait()` dinlenir). Oyun açıldığında arayüze `game-status { id, running: true }` yayılır; butonlar parlak yeşil pulsing neon animasyonuna (`.btn.running`) bürünür. Oyun kapandığında süre hesaplanıp diskteki kütüğe eklenir, `game-status { id, running: false, sessionSeconds, totalSeconds }` yayılır ve kart/detay rozetleri anlık güncellenir.
    - **Otomatik Bulut Senkronu:** Oyunda `cloudSavesEnabled: true` ise oyun kapanışı algılandığı anda arka planda `legendary sync-saves <app>` çalıştırılır ve `cloud-sync-complete` bildirimi verilir.
    - **İndirme Ağ Profili / Worker Sınırı:** Legendary CLI bant genişliği ayarını `--max-workers` ile sağlar (`max`: 16, `balanced`: 4, `low`: 1). Ayarlardan veya indirmelerden değiştirilen profil `settings.json`'a kalıcı işlenir ve tüm `spawn_install` çağrılarına bayrak olarak aktarılır.
    - **Çevrimdışı Mod (Offline Mode):** Üst bardaki toggle butonu veya ayarlardan açılır; aktifken kütüphane ağ senkronuna gitmez, çevrimdışı oynanabilen oyunlar doğrudan `--offline` ile beklemesiz başlatılır.
    - **Kayıt Dosyaları & Yerel Yedekleme (`backup.rs`):** Oyunun `save_path` dizinindeki save dosyalarını `%USERPROFILE%\.config\legendary\backups\<app_name>\<backup_id>\` altına zaman damgalı arşivler; Yönet modalından tek tıkla yedek alma, listeleme, geri yükleme ve klasörü açma imkanı sunar.
31. **Tek ve Bütünleşik Detay Çekmecesi (All-in-One Drawer & Sade Arayüz Disiplini):**
    - Oyun detayında ayrı açılır pencereler (modal-in-modal popup karmaşası) kesinlikle yasaklanmıştır.
    - Oyun Yönetimi (`manage`), Eklentiler & DLC (`dlcs`), Başarımlar (`achievements`), Genel Bakış (`overview`) ve Sistem Gereksinimleri (`specs`) sekmeli tek bir genişletilmiş çekmece (`.drawer`, `width: 560px`, `activeDrawerTab`) içinde birleştirilmiştir.
    - **Kaydırılabilir & Animasyonlu Sekme Çubuğu (`.drawer-tabs`):**
      - Buton boyutları oyun bazında asla değişmez (`flex: 1` kaldırıldı; yerine `flex-shrink: 0`, doğal `padding: 8px 18px; border-radius: 999px;` hap butonlar getirildi).
      - Yatay kaydırılabilir şerit (`overflow-x: auto; scrollbar-width: none; scroll-behavior: smooth`), aktif sekmede mikro-ışık indikatörü (`.drawer-tab.active::after`) ve fare tekerleğiyle yatay kaydırma desteği eklendi.
    - **Akıcı İçerik Animasyonu (`.tab-content-enter`):**
      - Her sekme geçişinde `#drawer-tab-content` yumuşak bir yükselme ve opaklık geçişiyle (`translateY(12px) scale(0.995)`) ekrana akar; anlık kesintili görüntü (abrupt jump) tamamen engellendi.
    - **Sıfır Kayma & Kararlı Scroll Alanı (`scrollbar-gutter: stable`):**
      - `.drawer` ve `.ach-list` konteynerlarına `scrollbar-gutter: stable;` eklendi; içeriğe göre dikey kaydırma çubuğu çıktığında içeriğin sola "tak diye" zıplaması / kayması (layout shift) %100 önlendi.
    - **World-Class Başarımlar (Achievements) Arayüzü:**
      - **Hero Özet Kartı (`.ach-hero-compact`):** Tek satırda büyük ilerleme yüzdesi (`%82`), kupa sayısı (`47/57 Kupa Kazanıldı`), sağda zarif fırçalanmış XP kutusu (`1,225 / 1,500 XP`) ve kehribar/altın gradyan ilerleme çizgisi.
      - **Filtre Karmaşasına Son:** Mükerrer dizilen ve aynı `Tümü (57)` etiketini taşıyan çift satırlı filtreler kaldırılmış; üstte şık koyu segmented kapsam seçici (`.ach-scope-segment`: `Tüm İçerik | Ana Oyun | Ek Paketler`), altında ise kompakt durum çipleri (`.ach-status-chips`: `Tümü | Kazanılanlar | Kilitliler | Gizli`) ile temiz iki katmanlı hiyerarşi kurulmuştur.
      - **Asil Başarım Kartları (`.ach-card`):** Rozet ve neon hap karmaşası sonlandırılmış; 48x48px modern squircle ikon, beyaz kalın başlık, zarif satır içi metrikler (`🥉 Bronz • 16 Eyl 2026 • 💎 %6 (Nadir)`), sağda altın XP etiketi ve yeşil/gri durum rozetiyle PlayStation 5 ve Steam Deck kalitesinde karanlık tema estetiği sağlanmıştır.
    - Tüm doğrulama, bulut senkronizasyonu ve yedekleme eylemleri çekmece içindeki ilgili sekmeden canlı ilerler.
32. **Oynama Süresi Düzenleyici Geliştirmeleri, DLC Mülkiyet Filtresi & Üst Bar Akıcılığı:**
    - **Oynama Süresi Seçici ve Otomatik Eşleme:** Serbest metin girişi yerine kontrollü `<select id="pt-last-played-select">` açılır menüsü ("Belirtilmemiş", "Daha önce oynandı (Epic Games)", "Bugün", "Dün", "Bu hafta", "Bu ay", "Geçen ay", "6 ay önce", "1 yıl önce veya daha eski"). Kullanıcı saat/dakika girdiğinde veya hızlı sürelere (`+1 sa` vb.) bastığında son aktivite otomatik olarak "Daha önce oynandı (Epic Games)" seçilir. Süre sıfırlandığında veya "Belirtilmemiş" seçildiğinde diskteki `last_played` alanı `null` yapılarak temizlenir.
    - **Beyaz Tarayıcı Scrollbar & Sayı Çevirici (Spin-Button) Engellemesi:** `:root { color-scheme: dark; }` ve `input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none !important; }` kurallarıyla işletim sisteminin beyaz kontrolleri engellendi.
    - **Katalog Eklenti (DLC) Filtreleme:** Kullanıcının kütüphanesinde bulunmayan veya mağazadan kaldırılmış DLC'ler `epic_get_game_dlcs` içinde kullanıcının varlıkları (`entitlements.json`, `assets.json`) ile filtrelenerek indirmede oluşabilecek `ERROR: Could not find ... in list of available games` hatası önlendi.
    - **Üst Bar Kaydırma & Ok Animasyonları:** Navigasyon oklarının belirmesi/kaybolması `opacity` ve `transform` geçişleriyle yumuşatıldı; butonların kenarındaki kesilmeyi önlemek için gradyan maskeleme uygulandı ve sekme tıklamalarında zıplama yaşanmaması için scroll konteynerı stabilize edildi.
33. **Epic Games Kütüphane Koleksiyonları (Kategoriler) & EGL LevelDB İçe Aktarma Mimarisi:**
    - **Legendary Durumu & LevelDB Tersine Mühendislik:** `legendary` CLI'ı koleksiyon/kategori desteğine sahip değildir. Orijinal Epic Games Launcher (EGL) ise kullanıcının oluşturduğu özel kategorileri ("Online", "Hikaye", "Hikaye/Başarım Tamamlanan" vb.) `%LOCALAPPDATA%\EpicGamesLauncher\Saved\webcache_*\IndexedDB\https_launcher.store.epicgames.com_0.indexeddb.leveldb\*.log` Chromium LevelDB kütüğünde binary-serileştirilmiş olarak saklar.
    - **LevelDB Ayrıştırıcı (`collections.rs`):** Harici C++ LevelDB bağımlılığına gerek kalmaksızın saf Rust ile LevelDB binary log kayıtları taranır (`parse_leveldb_buffer`). Kütüklerdeki `collectionId"` UUID'leri, `name` UTF-8 / ASCII aralıkları ve `catalogId` / `sandbox` oyun referansları `%USERPROFILE%\.config\legendary\metadata\*.json` sözlüğü ile eşleştirilir. Slicing ve UTF-8 sınır paniklerine karşı tek baytlık ASCII izdüşümü (`if b.is_ascii() { b as char } else { ' ' }`) ile bellek güvenliği garanti edilir.
    - **Yerel Depolama & Otomatik Değişiklik Algılama (Auto-Sync):** Koleksiyonlar `%USERPROFILE%\.config\legendary\collections.json` dosyasında tutulur (`epic_get_collections`, `epic_save_collection`, `epic_delete_collection`, `epic_set_game_collections`, `epic_import_egl_collections`). `read_collections`, EGL LevelDB kütüğünün (`*.log`, `*.ldb`) son değiştirilme zamanı (`get_egl_leveldb_mtime`) ile yerel `collections.json` dosyasının zaman damgasını kıyaslar (<0.1ms). EGL'de yeni oyun eklendiğinde veya silindiğinde launcher açılışında veya kütüphane yenilenmesinde (`epic-refresh`) otomatik olarak EGL'den güncel veriyi çeker ve yerel koleksiyonlarla birleştirir.
    - **UI Entegrasyonu (Epic Games Launcher Tasarımı):**
      - Kütüphane başlığında modern EGL sekme çubuğu (`.collection-nav-bar`): "Tümü", "Favoriler", kullanıcının özel koleksiyonları ve `(+)` dairesel yeni kategori butonu.
      - Aktif sekmede EGL mavisi (`#0078f2`) taban çizgisi göstergesi (`::after`), inaktiflerde zarif açık gri, hover anında parlak beyaz geçiş. Özel koleksiyonların üzerine gelindiğinde düzenleme butonu (`⋮`).
      - Seçilen kategoriye göre kütüphane ızgarası, arama kutusu ve sayaç çipleri (Tüm Oyunlar, Kurulu, Favoriler, Platin, Güncellemeler) dinamik olarak filtrelenir.
      - Detay çekmecesinde ("Genel Bakış" sekmesi) oyunun dahil olduğu kategorileri gösteren tıklanabilir etiketler (`.drawer-col-chip`) ve tek tıkla açılan "Koleksiyonları Yönet" modalı.
      - Ayarlar sayfasında tek tıkla "EGL Koleksiyonlarını İçe Aktar" düğmesi.
34. **Koleksiyon Modalı Yeniden Tasarımı & Özel Emoji / Simge Seçici Mimarisi:**
    - **UI Revizyonu:** Kırmızı pencere kapatma butonu artefaktı yerine yuvarlatılmış minimal kapat butonu (`.col-modal-close`), 640px havadar obsidian/cam gövde (`.col-modal-card`), akıcı dikey kaydırma ve ince scrollbar.
    - **Özel Emoji / Simge Seçici:** Koleksiyonlara özel `emoji` desteği (Rust `GameCollection.emoji: Option<String>`, `collections.json`). 44x44px interaktif emoji avatar butonu, 32 popüler oyun emojisi (🎮, 📖, 🌐, 🏆, ⚔️, 🚗, 👻 vb.), hızlı şablon çipleri ("📖 Hikaye", "🌐 Online", "🏆 Platin Hedef" vb.), harici özel emoji yazma/yapıştırma ve simge temizleme.
    - **Gelişmiş Oyun Seçim Segmentleri & Canlı Sayaçlar:** `[ Tümü (514) ]`, `[ Seçilenler (80) ]`, `[ Yüklü ]` filtre sekmeleri ile koleksiyona dahil olan oyunları anında listeleme ve satırın tamamına tıklayarak seçebilme.
    - **Sistem Genelinde Kusursuz Yansıma:** Araç çubuğu açılır menüsünde (`.col-menu-emoji`), aktif filtre butonunda (`.col-pill-emoji`), Raflar (Shelves) başlığında (`.shelf-emoji`) ve detay çekmecesi etiketlerinde (`.col-chip-emoji`) kullanıcının seçtiği emojilerin yerinde ve şık gösterimi.

## 7. Test stratejisi

- `cargo test`: saf fonksiyonlar için GERÇEK veriyle test (stderr satırları, JSON örnekleri,
  URL parse). Örnekler `legendary::skip::tests`, `transfers::tests`, `models::tests`, `cache::tests`.
- Canlı doğrulama: sistemdeki `legendary` binary'si ile aynı argümanlar denenebilir
  (`-y install <küçük-oyun> --base-path <temp> --skip-dlcs --skip-sdl`), sonra
  `uninstall` ile temizlenir. Kimlik gerektiren işler kullanıcıya aittir (kod yapıştırma).
- Hata ayıklama: `fail()` her komut hatasının TAM stderr'ini
  `<app_data>/logs/legendary-error.log` dosyasına yazar — tahmin yürütme, dosyayı oku.
  legendary config: `%USERPROFILE%\.config\legendary` (assets.json, metadata/, user.json).

## 8. Durum ve yol haritası

Biten: Faz 0 (kurulum/auth/kütüphane) • Faz 1 (başlatma: online→offline fallback) •
Faz 2 (indirme: kuyruk/iptal/kaldırma/ilerleme) • Modern Kütüphane Deneyimi:
- Özel modern çerçevesiz pencere çubuğu (frameless titlebar + Windows stilinde simge, büyüt, kapat butonları)
- Gelişmiş "Son Oynanan" & akıllı Hero Spotlight önceliklendirmesi (yalnızca kurulu & gerçekten oynanmış oyunlar)
- Sinematik Hero Spotlight (son oynanan/öne çıkan dev afiş, hızlı başlat, canlı istatistikler)
- Hızlı filtre çipleri (Tüm Oyunlar, Kurulu, Favoriler, Güncellemeler) + Ctrl+F kısayolu
- S/M/L dinamik kart boyutu seçici (büyük poster desteği)
- Çakışmasız ambient glow'lu portre kartlar ve canlı taban indirme progress barı
- Sağdan kayan sinematik detay çekmecesi (Drawer) ve modern metadata ızgarası
- Dinamik katalog özeti & doğrudan yerleşik mağazada oyun sayfasını açma entegrasyonu
- Epic Games Başarım Sistemi & Platin Kupa (100% Tamamlama) Altın Parıltı / Shimmer Efekti
- Detay çekmecesinde sekmeli Başarımlar görünümü, rozetler, XP, nadirlik ve kilit filtreleri
- 3. parti başlatıcı entegrasyonu (`legendary list -T` ile EA App, Ubisoft Connect oyunları, `--origin`/`--ubisoft` ile doğrudan çalıştırma)
- Detay çekmecesinde ve meta ızgarasında 3. Parti Başlatıcı & Hile Önleme (Anti-Cheat) rozet ve bilgi alanları
- Gizli başarımların katalog metadatasından taranması ve tıklanabilir spoiler koruması (`[👁️ Göster]` / `[👁️ Gizle]`)
- Ana Oyun (Base Game) vs Ek Paketler (DLC) ayrımı, Platin Kupa kuralı (ana oyun tamamlanması) ve Kapsam filtreleri (`Tüm Paketler`, `🎮 Ana Oyun - 🏆 Platin`, `📦 Ek Paketler`)
- 1080p ve dizüstü monitörleri için optimize edilmiş ultra-kompakt Başarım Paneli (`.ach-hero-compact`, tek satır çift istatistik, dinamik `calc(100vh - 275px)` duyarlı liste), çift katmanlı gizli başarım onarımı (Rust + Frontend) ve test butonunun kaldırılması
- Detay çekmecesinde pürüzsüz yerinde (in-place) geçiş mimarisi, kaydırma pozisyonu koruması, "Ana Oyun" kupa emojisi temizliği ve Genel Bakış sekmesinde kendiliğinden oluşan refresh döngüsünün engellenmesi
- **Modernize Edilmiş Başarım UI:** Yuvarlatılmış squircle ikonlar, Türkçe tier hapları (Bronz, Gümüş, Altın, Platin), neon/altın degrade ilerleme çubuğu, yeşil onay rozetleri, yenilenmiş segment filtre butonları
- **Entegre Sistem Gereksinimleri:** Akamai CDN üzerinden engelsiz donanım spesifikasyonu çekme, yerel önbellekleme (`specs/`), Minimum & Önerilen karşılaştırma paneli, donanım ikonları (CPU, GPU, RAM, Depolama, OS), platform seçici ve dil desteği kartı
- **Epic Games Launcher (EGL) Kurulu Oyunları Otomatik Algılama & Eşitleme:** `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests` taranarak Cyberpunk 2077, RDR2 vb. resmi launcher oyunlarının anında kütüphanede 'Kurulu' olarak tanınması; Ayarlar sayfasında tek tıkla kalıcı eşitleme ve liste önizleme paneli
- **Oyun Yönetim Paneli (Game Properties / Manage Modal):** Dosya doğrulama (`verify`), otomatik güncelleme, öncelikli indirme, EOS bulut senkronizasyonu, masaüstü kısayolu, kurulum boyutu & kaldırma, gelişmiş başlatma parametreleri (`launchParameters`)
- **Steam Tarzı Gelişmiş İndirme Merkezi (Downloads Hub):** Canlı ağ ve disk hızı (MB/s), kalan süre (ETA), indirilen/toplam bayt, HTML5 Canvas 60 saniyelik çift bezier hız grafiği (cyan ağ, green disk), duraklat/devam et, kuyruk sıralaması (yukarı/aşağı/şimdi/kaldır) ve tamamlananlar geçmişi
- **Eklenti & DLC Yönetim Sayfası (Add-ons Manager):** Katalogdaki gerçek DLC'lerin filtrelenmesi, kapak resimleri, dosya boyutları, anlık kurulu durumları, tek tıkla eklenti kur/kaldır switch'leri, anahtar kelime araması ve Epic Store tanıtım banner'ı
- **Seçici Kurulum Modalı (Selective Install Dialog):** `legendary info --offline --json` manifestinden diller ve ek paketler ayrıştırma, akordeon seçim listesi, dinamik indirme ve disk boyutu hesaplayıcısı, `--install-tag` bayraklarıyla kurulum
- **Güncelleme Motoru (Update Engine):** `build_version` kıyasıyla güncelleme tespiti, `⚡ Güncellemeler (N)` kütüphane filtresi, kartlarda "⚡ Güncelleme" rozeti, kurulu oyunlarda dinamik "Güncelle" butonu ve tek tıkla güncelleme akışı
- **Dosya Doğrulama & Bütünlük Kontrolü (File Verification Engine):** `ensure_egl_manifest()` ile `.egstore` manifestlerinin otomatik bağlanması, büyük arşiv dosyaları (`=> Verifying large file`) için çok katmanlı canlı ilerleme ve MB/s hızı akışı, 3. parti manifest çökme koruması ve kırpışmasız yerinde (in-place) DOM güncellemesi
- **Ultra-Hızlı Yönetim Paneli:** Çift katmanlı GPU `backdrop-filter` kilitlenmesinin giderilmesi, 0ms anında modal açılışı, `will-change` donanım hızlandırması ve yerinde ayar senkronizasyonu
- **Oynama Süresi Takibi (Playtime Tracker) & Manuel Süre Düzenleme:** Canlı süreç izleme, yeşil neon pulsing buton (`Oynanıyor...`), oyun çıkışında otomatik bulut senkronizasyonu, kart ve detay çekmecesinde oynama süresi ve son oynanma tarihleri; Epic Games'in sunucu taraflı kapalı telemetri kısıtlaması bilgilendirme notları (`.playtime-sync-notice`), "Genel Bakış" ve "Yönet" sekmelerinden tek tıkla açılan "Oynama Süresini Düzenle" dialogu (`epic_set_playtime`, saat/dakika/hızlı çipler ve isteğe bağlı not) ve kesintisiz kümülatif süre biriktirme desteği
- **Çevrimdışı Mod (Offline Mode):** Üst bar anahtarı, ağ senkronu atlama ve beklemesiz `--offline` başlatma
- **İndirme Ağ Profili (Bandwidth / Worker Limiter):** Maksimum (16), Dengeli (4), Eko (1) worker seviyeleri ve ayarlar entegrasyonu
- **Kayıt Dosyaları & Yerel Yedekleme (Save Backup Manager):** Yönet menüsünde tek tıkla yerel kayıt yedeği alma, yedek geçmişi, geri yükleme ve yedek klasörünü açma desteği
- **Kütüphane Koleksiyonları & EGL Kategori Eşitleme (Collections / Categories):** EGL CEF LevelDB kütüğünden otomatik kategori çekme ("Online", "Hikaye" vb.), kütüphane üstünde modern fırçalanmış cam kapsül sekme şeridi (`.collection-nav-bar`), dinamik oyun sayaçları, yeni koleksiyon oluşturma / düzenleme / silme modalı ve oyun detay çekmecesinde interaktif kategori etiketleri (`.drawer-col-chip`)
- **Kütüphane UI Revizyonu, 8 GB RAM Optimizasyonu & İskelet (Skeleton Shimmer) Yükleme:**
  - 8 GB RAM ve düşük sistemlerde 500+ oyunu 60-120 FPS akıcılıkla çalıştırmak için `.pcard` ve `.prow` üzerine `content-visibility: auto; contain-intrinsic-size: 240px 320px; contain: layout paint style; transform: translateZ(0);` uygulanması, görsellere `loading="lazy" decoding="async"` ve CSS stagger delay'inin sadece ilk 24 kartla sınırlandırılması.
  - Kütüphane açılırken ve taranırken tam sayfa AAA standartlarında İskelet (Skeleton Shimmer) animasyonu (`renderSkeletonLibrary()`, `@keyframes skeletonShimmer`, `.skeleton-card`, `.skeleton-hero`, `.skeleton-toolbar`).
- **Aero Cinematic Kütüphane UI & Tek Satırlık Bütünleşik Araç Çubuğu:**
  - Sayfanın yarısını kaplayan hantal 400px'lik gri kutular ve çift katmanlı butonlar tamamen terk edilmiştir.
  - Hero Vitrini 150px'e indirilmiş ve tek tıkla gizlenebilir/açılabilir (`isHeroCollapsed`, `.lib-toggle-hero-btn`, `.hero-collapse-btn`) esnek yapıya kavuşturulmuştur.
  - Ağır `.lib-command-center` yerine doğrudan koyu tuval üzerinde süzülen tek satırlık **`.lib-unified-toolbar`** entegre edilmiştir (`[ Tümü ] [ Yüklü ] [ Favoriler ] [ Platin ] [ Koleksiyonlar ▾ ]` ve sağda Arama, Sıralama, Boyut, Görünüm).
  - Koleksiyonlar şık bir cam açılır menüye (`.col-dropdown-menu`) taşınarak uzun isimlerin (`Hikaye/Başarım Tamamlanan` vb.) düzeni bozması engellenmiş, seçildiğinde aktif sepet hapı (`[ 📁 Hikaye (80) ✕ ]`) olarak sunulmuştur.
  - Kart üzerindeki "Yüklü" rozeti (`.pbadge.ready`) 20px yüksekliğinde, gece siyahı zeminli, 1px zümrüt çerçeveli ve minik LED noktalı cerrahi bir konsol HUD etiketine dönüştürülerek karakter yüzlerini ve posterleri kapatması tamamen çözülmüştür.
- **Sıfır Emoji Disiplini (Zero Emoji Discipline) & Vektör İkon Mimarisi:**
  - Tüm arayüzdeki kaba sistem emojileri kaldırılmış, standart ve asil Lucide inline SVG ikonları (`icon(...)`) ile değiştirilmiştir.
  - Aktif filtre butonlarındaki göz alıcı beyaz parlamalar koyu cam ışıltısı (`rgba(255, 255, 255, 0.14)`) ile modernize edilmiştir.
  - Hero vitrini 175px'e optimize edilmiş, içindeki gereksiz istatistik kutucukları kaldırılarak poster sanatı ve oyun aksiyonları öne çıkarılmıştır.
- **Steam Tarzı "Raflar" (Shelves) Görünüm Modu:**
  - Kütüphane araç çubuğuna 3'lü görünüm seçici eklenmiştir (`[ ▦ Izgara ] [ ☷ Raflar ] [ ☰ Liste ]`).
  - Raflar modunda oyunlar akıllı yatay kategorilere ayrılır: "Son Oynananlar", "Favori Oyunlar", "Platin Kupalılar", "Yüklü Oyunlar", "Öne Çıkanlar" ve kullanıcı koleksiyonları.
  - Her raf akıcı yatay kaydırma parçasına (`.shelf-row-track`), pürüzsüz gezinme oklarına (`shelf-scroll`) ve raf başı kahraman kartına (`.shelf-hero-card`) sahiptir.
- **Kapak Hover Kartı & Canlı Mikro-HUD:**
  - Kartların üzerine gelindiğinde (hover) başlığın hemen altında cerrahi incelikte mikro bilgi hapları (`.pcard-micro-hud`) belirir: Oynama süresi (`⏱ 14 sa`), Başarım tamamlama oranı (`🏆 %75`) ve Platin kupa durumu.
  - Poster görselini engellemeden kullanıcının kütüphane ilerlemesini doğrudan kart üzerinden görmesini sağlar.
- **HowLongToBeat (HLTB) Entegrasyonu:**
  - `src-tauri/src/legendary/hltb.rs` modülü ile HowLongToBeat arama motoru taranır ve sonuçlar diskte `%USERPROFILE%\.config\legendary\hltb` altında yerel önbelleklenir.
  - Detay çekmecesinin "Genel Bakış" sekmesinde şık bir HLTB kartı (`.drawer-hltb-card`) belirir; "Ana Hikaye", "Ana + Ekstra" ve "%100 Bitirme" tahmini sürelerini saat bazında sunar.
- **Özel Kapak Değiştirme (Custom Cover Art):**
  - Kullanıcılar herhangi bir oyunun kartındaki veya detay çekmecesindeki "Kapağı Özelleştir" düğmesiyle özel kapak modalını (`openCustomCoverModal`) açabilir.
  - Doğrudan SteamGridDB / web görsel URL'si yapıştırabilir veya bilgisayardan yerel resim dosyası (`.png`, `.jpg`, `.webp`) seçebilir (`FileReader` ile yerel saklama).
  - Anında 2:3 oranlı önizleme, varsayılana sıfırlama ve `localStorage` üzerinde kalıcı saklama desteği mevcuttur.

## 9. Çalışma disiplini

- Kullanıcı Türkçe konuşur — yanıtlar ve UI metinleri Türkçe, kod yorumları kısa Türkçe.
- Kısa ve öz iletişim; gereksiz dosya oluşturma (yeni dosya = sadece açıkça gerekirse).
- `dist/`, `target/`, `node_modules/` commitlenmez (gitignore'lu).
- Commit/PR yalnızca açıkça istenirse.

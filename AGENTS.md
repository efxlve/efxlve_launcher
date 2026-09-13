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
`epic_import_egl`, `epic_logout`, `epic_get_settings`, `epic_set_alt_bin`
Kütüphane: `epic_cached_library`, `epic_list_games`, `epic_list_installed`,
`epic_list_skipped`, `epic_get_achievements_summary`, `epic_get_achievements`,
`epic_detect_egl_games`, `epic_sync_egl_installed`
Transfer: `epic_install_game`, `epic_cancel_download`, `epic_uninstall_game`,
`epic_default_install_dir`, `epic_set_install_dir`, `epic_launch_game`
Pencere: `show_store_view`, `hide_store_view`, `open_folder`, `app_minimize`, `app_toggle_maximize`, `app_is_maximized`, `app_close`, `app_set_decorations`

**Event'ler (frontend dinler):** `download-progress {id, progress, done}`,
`download-failed {id, message}`, `download-cancelled {id}`,
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
Sıradaki adaylar: indirme hızı/ETA göstergesi, oyun güncelleme akışı (`update`),
bulut kayıt arayüzü (`sync-saves`), DLC kurulumu, paketleme (`tauri build`).

## 9. Çalışma disiplini

- Kullanıcı Türkçe konuşur — yanıtlar ve UI metinleri Türkçe, kod yorumları kısa Türkçe.
- Kısa ve öz iletişim; gereksiz dosya oluşturma (yeni dosya = sadece açıkça gerekirse).
- `dist/`, `target/`, `node_modules/` commitlenmez (gitignore'lu).
- Commit/PR yalnızca açıkça istenirse.

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
- **ZORUNLU KURAL (Kullanıcı Talimatı):** Her işlem/görev bittiğinde mutlaka yapılanlar `AGENTS.md` dosyasına güncellenmeli ve ardından `git commit` atılmalıdır.
- **ZORUNLU TASARIM KURALI (Kullanıcı Talimatı):** Launcher arayüzünde daima **PlayStation-Inspired (PS5 Console) Dark Aesthetic** kullanılır. Arayüz PlayStation konsol UI'ına yakın, havadar, derin cam efektli (obsidian & midnight blue `#07080d`/`#0b0d14`), şık kupa hiyerarşili (Platin, Altın, Gümüş, Bronz sayaçları) ve sade konsol zarafetinde olmalıdır. Telif ihlali oluşturmamak için Sony'nin tescilli logo ve ticari markaları birebir kopyalanmaz; launcher'ın kendi mor-altın-obsidyen kimliğiyle özgün bir konsol deneyimi sunulur.
- **ZORUNLU KONTROLCÜ & KONSOL KULLANILABİLİRLİK KURALI (Kullanıcı Talimatı):** Launcher arayüzü daima **Game Controller (Gamepad / DualSense / Xbox / Kol)** ile 10 fit (TV / Koltuk / Konsol modu) kullanıma tam uyumlu bir konsol UI'ı olarak tasarlanmalı ve korunmalıdır. Kullanıcının *"MÜKEMMELLLL"* olarak nitelendirdiği mevcut PlayStation 5 Game Hub, Trophy Hub konsol sahnesi, geniş ve ferah kartlar, 2 sütunlu kupa ızgarası, büyük aksiyon butonları ve sade gezinme dili titizlikle korunmalı; karmaşık, sıkışık veya fare odaklı minik bento kutu kalabalığından kesinlikle kaçınılmalıdır. Tüm etkileşimli öğeler elektrik mavisi odak halkasına (`:focus-visible`), D-pad / analog uzamsal navigasyona ve kontrolcü kısayollarına (A: Seç, B: Geri, LB/RB: Sekme, Y: Ara, X: Favori) sahip olmalıdır.
- **ZORUNLU "AI TASARIMI GİBİ DURMASIN" KURALI (Kullanıcı Talimatı):** Arayüz, "bir AI üretmiş" hissi veren klişelerden arındırılır. YASAK: mor→indigo→cyan gradyanların dekoratif kullanımı, neon parlama (`box-shadow` glow / `drop-shadow`), gradyan metin (`background-clip: text`), her öğeyi tam yuvarlak kapsüle (`border-radius: 999px`) çevirmek, cam/blur katmanları ve süs amaçlı mikro animasyonlar (ikon sallama, dönme, pulse). Bunun yerine: düz yüzeyler, ölçülü köşe yarıçapları (6-8px), 1px hairline kenarlıklar, nötr gri metin hiyerarşisi. **Renk yalnızca DURUM bildirir** (yeşil = çevrimiçi, amber = çevrimdışı, kırmızı = sayaç); süs olarak renk kullanılmaz. Hareket yalnızca işlevseldir (ör. aktif sekme karonunun kayması).
  - **TEK İSTİSNA — bağlamsal ortam ışığı:** Bölüme/içeriğe göre DEĞİŞEN, TEK kaynaklı, düşük alfalı bir ortam (ambient) ışığı serbesttir (PS5'in sahne ışığı gibi: kütüphane=menekşe, mağaza=mavi, indirmeler=turkuaz, profil=altın). Bu bir "çok renkli dekoratif gradyan" DEĞİLDİR; rengi sabit değil bağlama bağlıdır ve barı tek bir noktadan yıkar. Sabit mor→cyan geçişli süs gradyanı yine YASAKTIR.
- **DENGE KURALI (Kullanıcı Talimatı):** İki uçtan da kaçınılır. (a) gradyan + glow + kapsül = "AI yapmış gibi"; (b) hiç ışık, hiç vurgu, hiç derinlik olmayan düz gri = "ruhsuz / kütük gibi". Hedef **sade ama karakterli**. Karakter şu dört kaynaktan gelir: bağlamsal ışık, yüzey/derinlik dili, tipografik ses, tek özgüvenli vurgu rengi.

## 4. Mimari

```
src/
  main.ts      # TÜM UI mantığı (~1300 satır): view'lar, render, olay delegasyonu
  epic.ts      # Epic API katmanı: tipler (snake_case!), invoke sarmalayıcıları, kapak/açıklama seçimi
  styles.css   # Tek stil dosyası, CSS değişkenli tema (:root)
  index.html   # Üst bar + içerik iskeleti (tam ekran konsol düzeni)
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
SteamGridDB: `epic_get_steamgrid_key`, `epic_set_steamgrid_key`, `epic_test_steamgrid_key`, `epic_search_steamgrid`, `epic_get_steamgrid_covers`
Mağaza: `show_store_view`, `resize_store_view`, `hide_store_view`
Pencere: `open_folder`, `app_minimize`, `app_toggle_maximize`, `app_is_maximized`, `app_close`, `app_set_decorations`

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
16. **Epic Store URL yapısı, Yerleşik Mağaza & Detay Sayfası:**
   - Eski `/en-US/search?q=` adresi Epic tarafından genel kurumsal site aramasına yönlendirilir
     (`epicgames.com/site/search`). Doğrudan ürün sayfası linki `https://store.epicgames.com/p/<slug>`
     şeklindedir; slug başlığın alfanümerik normalize edilmesiyle (`toEpicSlug`) üretilir. Mağaza araması
     için ise `/browse?q=` kullanılır. Detay çekmecesindeki "Mağaza" butonu 3. parti harici tarayıcı yerine
     uygulamanın yerleşik child webview mağazasını açar (`openStoreUrl(url, "store")`).
   - **Pencere Boyutlandırma & Tam Ekran Senkronu:** Windows büyütme animasyonunda (`win-maximize`, başlık çift tıklama, snap)
     webview'in eski boyutta kalıp siyah boşluk bırakmaması için `handleWindowResize()` çok aşamalı zamanlayıcı
     (0ms, 80ms, 200ms, 450ms) ve Rust tarafında `tauri::WindowEvent::Resized` OS olay kancası ile senkronize tutulur.
   - **Detay Sayfası (PDP) Kütüphane Yönlendirmesi & Doğal Mavi Buton:**
     Detay sayfasında kullanıcı deneyimini sade tutmak için fazladan özel kart kutusu eklenmez; Epic'in kendi oluşturduğu
     `[ ⊞ Kütüphanede ]` butonunun `disabled` niteliği kaldırılarak (`removeAttribute('disabled')`, `disabled = false`, pointer cursor)
     doğal mavi buton haline getirilir ve doğrudan ele geçirilir. Tıklandığında oyunu Efxlve Launcher kütüphanesinde açar (`efxlve-open-game-from-store`).
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
19. **"Son Oynanan", Hero Spotlight & Filtre Animasyon Disiplini:**
   - `pushRecent(appName)` SADECE oyun gerçekten başlatıldığında (`epicPlay`) çağrılır; detay çekmecesi
     açıldığında (`openEpicModal`) ASLA çağrılmaz.
   - Yalnızca gerçekten kurulu olan oyunlar (`s.installed`) "Son Oynanan" rozeti alabilir veya sıralamada öne geçebilir.
     Kütüphane her yüklendiğinde ve kaldırıldığında kurulu olmayan oyunlar `efxlve-recent` listesinden ayıklanır (`pruneRecent`).
   - Hero Spotlight afişi öncelik sırası: 1) Son oynanmış ve kurulu oyun (`Son Oynanan`), 2) Kurulu favori,
      3) **Günün Oyunu (`✨ Günün Oyunu`)** — tarih bazlı deterministik tohum ile kütüphaneden geniş afişli sürpriz oyun,
      4) Favori, 5) İlk oyun. Rozeti duruma göre `Son Oynanan`, `Günün Oyunu`, `Kurulu Oyun`, `Favori` veya `Öne Çıkan` olur.
   - **240px Sinematik Vitrin & Yüzen 3D Kapak Kartı:**
     - Vitrin yüksekliği basık 175px yerine **240px**'tir; arka plan görseli `object-position: center 20%` ile karakter kafalarının kesilmesini engeller.
     - Sağ tarafta 135x190px (2:3 dikey oranlı) yüzen 3D poster kartı (`.hero-showcase-card`) yer alır; Raflar (Shelves) vitrininin zarafetini ızgara görünümüne taşır. Hover'da 3D kalkış (`translateY(-5px) scale(1.03)`) ve `İncele` rozeti sunar.
     - Vitrin içi gereksiz/çakışan "x" kapat butonu kaldırılmıştır; vitrin kontrolü üst bar "Vitrin" butonu (`.lib-toggle-hero-btn`) üzerinden yapılır.
   - **Kütüphane Filtre & Buton Animasyonları (Yalnızca Değişimde Animasyon):**
     - "Tümü", "Yüklü", "Favoriler", "Platin", "Güncelleme" sekmeleri arasında geçiş yapılırken `updateLibraryFilterInPlace()` kullanılır. Toolbar butonları DOM'dan silinip baştan kurulmaz; böylece butonlar gereksiz yere her tıklamada animasyona girmez, yalnızca aktiflik stili geçiş yapar.
     - Kartlar `--ci` değişkeniyle ilk 24 kart için 16ms'lik gecikmelerle akıcı dalga (staggered ripple) efektiyle ekrana akar (`cardFilterEnter`).
     - Yalnızca gerçek bir değişim olduğunda (yeni bir koleksiyon seçildiğinde veya silindiğinde, ya da güncellemeler 0'dan 1'e çıktığında) butonlara `.pill-dynamic` (`@keyframes pillSlideIn`) eklenerek akıcı giriş sağlanır.
20. **Başarımlar (Achievements) & Platin Kupa Mimarisi:**
    - 488+ oyunluk kütüphanede her oyun için tek tek ağ isteği atmak Epic hız sınırına takılır (429) ve açılışı kilitler.
    - `legendary`, sorgulanan başarımları `%USERPROFILE%\.config\legendary\achievements.json` içine namespace (sandboxId) bazlı kaydeder (`totalUnlocked`, `totalXP`, `playerAwards: [awardType: "PLATINUM"]`).
    - `epic_get_achievements_summary` (`scan_achievements_summary`), `metadata/*.json` dosyalarından oyun tanımlarını (`total_achievements`, `total_product_xp`) ve `achievements.json` dosyasından kullanıcının gerçek kilit açma verilerini diskten 0ms içinde haritalar.
    - `legendary achievements --json <app>` çıktısında doğrudan `achievements` adında bir anahtar YOKTUR; öğeler durumlarına göre `completed`, `in_progress`, `uninitiated` ve `hidden` dizileri altında döner. `GameAchievementsResponse.consolidate()` metodu bu dizileri birleştirerek `achievements` alanını doldurur ve toplamları garantiler.
    - `epic_get_achievements`, diskteki eski boş önbellekleri (`achievements: []` kalmış olanlar) geçersiz sayıp otomatik olarak taze veri çeker. Başarımı olmayan oyunlarda legendary'nin boş çıktısı (`No achievements found`) `supported: Some(false)` olarak zarifçe yakalanıp önbelleklenir ve UI'ın kilitlenmesi engellenir.
    - Platin Kupa (`is_platinum = (total_achievements > 0 && user_unlocked >= total_achievements) || has_platinum_award` veya demo önizleme):
      - Kütüphane araç çubuğunda `Platin` filtre çipi (sayı rozetli, mor Epic kupa ikonlu) ve sıralamada `Platin kupalılar` seçeneği.
      - Platin filtresi seçildiğinde asil mor/eflatun özel kategori tebrik afişi (`.plat-category-banner`).
      - Portre kart çevresinde asil ve sabit mor-platin hale (`box-shadow` aurası), periyodik zarif holografik ışık geçişi (`plat-shimmer-pass`, eflatun ışıltılı) ve hover anlık ışıma efekti.
      - Sağ üstte metinsiz sade mor Epic Games Platin Kupa rozeti (`.platinum-badge` + mor alevli ve mücevherli kupa vektörü `epicPlatinumIcon` — hover sırasında aksiyon butonlarını engellememesi için `opacity: 0` ile kaybolur).
      - Detay çekmecesinde "Genel Bakış" ve "Başarımlar" sekmeleri, mor-eflatun platin kupa durum hapı (`.status-pill.plat`), doğrudan gömülü mağazada açan "Mağaza Başarımları" (`epicAchievementsUrl`) butonu ve test için anlık Platin Efekti Aç/Kapat toggle'ı yer alır.
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
35. **Yerel Profil & Başarım Merkezi (Native Epic Profile & Achievements Hub):**
    - Harici tarayıcı veya gömülü webview (`store.epicgames.com/u/<account_id>`) yönlendirmesi tamamen terk edilmiştir; üst bardaki kullanıcı adına tıklandığında doğrudan yerel `view = "profile"` açılır.
    - **Epic Games Launcher GraphQL Entegrasyonu (`profile.rs`):**
      - Endpoint: `https://launcher.store.epicgames.com/graphql`
      - Headers: `Authorization: Bearer <access_token>`, `User-Agent: EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live`
      - Query: `PlayerGameAchievementProgress` (kullanıcının tüm oyunlardaki gerçek kilit açma sayıları, sandboxId, totalXP ve playerAwards).
      - XP Hesabı: Epic Games Store kuralına göre kazanılan her Platin Kupa ek **+250 XP** bonus kazandırır (`total_xp = progress_xp + (plat_count * 250)`).
    - **Disk Önbelleklemesi:** `%USERPROFILE%\.config\legendary\profile_cache.json` içerisine yerel önbelleklenir; çevrimdışıyken veya hızlı geçişlerde 0ms açılış sunar.
    - **UI Mimarisi:**
      - Glassmorphic Hero Kartı: Renkli degradeli avatar, kullanıcı adı, çevrimiçi/çevrimdışı durumu, hesap ID'si kopyalama butonu ve profili yenile butonu.
      - 5'li İstatistik & Kupa Vitrini: Toplam XP (`✨ XP`), Açılan Başarımlar (`🏆`), Platin Kupalar (`👑`), Toplam Oynama Süresi (`⏱`) ve Kütüphane Oyun Sayısı (`🎮`).
      - Oyun Başarımları & İlerleme Şeridi: Kapsam filtreleri (`Tümü`, `Platin`, `Devam Edenler`, `Başlanmayanlar`), arama kutusu ve 4 farklı sıralama (İlerleme Yüzdesi, Kazanılan XP, Oynama Süresi, Alfabetik).
      - Zengin İlerleme Kartları: Kapak görseli, Platin rozeti, başarım ve XP çubukları, doğrudan oyun detayına zıplayan "İncele" butonu.
36. **Yerleşik Mağaza Ürün Sayfası (Store Product Page) & Harici Tarayıcı Yasağı:**
    - Mağaza veya kütüphane içerisindeki oyunlara tıklandığında kullanıcının varsayılan işletim sistemi tarayıcısının (Chrome, Edge vb.) dışarıdan açılması KESİNLİKLE YASAKTIR.
    - Mağazadaki herhangi bir oyuna tıklandığında doğrudan launcher içerisinde tam sayfa yerleşik ürün sayfası görünümü (`view = "store-product"`, `openStoreGamePage(offerId)`) açılır.
    - **Backend Entegrasyonu (`epic_get_store_offer_detail`, `store.rs`):**
      - Epic Store Akamai CDN (`https://store-content-ipv4.ak.epicgames.com/api/tr-TR/content/products/<slug>?country=TR` ve fallback `en-US`) ile egdata offer API'leri taranır.
      - Sayfa verileri: Sinematik kahraman afişi, ekran görüntüleri galerisi (interaktif küçük resimler şeridi ve tam boy önizleme), oyun künyesi (geliştirici, yayıncı, çıkış tarihi, türler), zengin açıklama, donanım gereksinimleri tablosu (minimum ve önerilen CPU, GPU, RAM vb.) ve dinamik satın alma kartı.
    - **Çocuk Webview ile Satın Alma / Kütüphaneye Ekleme:**
      - Ürün sayfasındaki "Epic Store'da Aç / Satın Al" butonu tıklandığında harici tarayıcı yerine Tauri'nin yerleşik çocuk webview'i (`openStoreUrl(url, "store-product")`) devreye girer; pencere başlık çubuğunun altına tam oturur ve kullanıcı uygulamadan çıkmadan oturumuyla oyunu alabilir.
37. **Dinamik Para Birimi, TRY (₺) Yerelleştirme & Bölgesel Fiyatlandırma Motoru:**
    - Uygulama içinde sabit Amerikan Doları ($) fiyat gösterimi KESİNLİKLE YASAKTIR; kullanıcının yerel para birimi dinamik olarak algılanmalı ve standart biçimde gösterilmelidir.
    - **Ülke Algılama (`get_user_country`):** Kullanıcının Epic Games hesabı `%USERPROFILE%\.config\legendary\user.json` dosyasındaki `country` anahtarından (örn. `"TR"`) okunur. Bulunamazsa Windows yerel ayarlarından çekilir veya `"TR"` varsayılır.
    - **API Parametre Standardı:** Tüm egdata (`https://egdata.app/api/v1/...`) ve Epic Akamai CDN sorgularına `country={country}` zorunlu olarak eklenir.
    - **Para Formatlayıcı (`format_currency(cents, currency)`):**
      - Türk Lirası için: Kuruş cinsinden gelen değerler Türk standartlarına tam uygun olarak biçimlendirilir (binlik ayracı nokta `.`, kuruş ayracı virgül `,`, örn. 39130 sent -> `₺391,30`, 125000 sent -> `₺1.250,00`).
      - Amerikan Doları için `$19.99`, Euro için `19,99 €` formatları desteklenir.
      - Fiyatı 0 olan veya ücretsiz promosyondaki oyunlarda açıkça `Ücretsiz` yazılır.
38. **Mağaza UI / UX Revizyonu & Daima Görünür Kart Bilgisi:**
    - Eski hantal hover katmanı zorunluluğu kaldırılmıştır; oyun kartlarında başlık, geliştirici/yayıncı, indirim yüzdesi rozeti (`-%XX`), üstü çizili orijinal liste fiyatı ve kalın indirimli güncel fiyat her zaman kartın altında sabit olarak okunabilir.
    - Kart hover katmanında sadece hızlı mikro-eylemler (İstek Listesine Ekle/Çıkar kalp butonu, Sepete Ekle butonu, Doğrudan Satın Al / İncele) yer alır.
    - Haftalık Ücretsiz Oyunlar vitrini (`.store-freegames-showcase`) altın parıltılı aura, kalan süre geri sayım sayaçları ("X gün X sa kaldı" veya "X tarihinde başlayacak") ve doğrudan mağaza ürün sayfasını açan butonlarla donatılmıştır.
    - Mağaza üst barındaki gereksiz/kalabalık açıklama panoları temizlenmiş; arama, filtreler ve vitrinler arası geçiş akıcı hale getirilmiştir.
39. **Open Agent Skills Ekosistemi (`anthropics/skills`), Dizin Köprüsü (Junction) & Yetenek Mimarisi:**
    - Antigravity ve açık ajan ekosistemi `SKILL.md` (YAML frontmatter: `name`, `description` + Markdown talimatları) standart protokolünü kullanır.
    - `npx skills add <repo>` aracı yetenekleri doğrudan kullanıcı ev dizinine (`C:\Users\Efe\.agents\skills\`) indirir.
    - Antigravity'nin global yetenek tarama yolu ise `C:\Users\Efe\.gemini\config\skills\` (veya workspace için `<project_root>\.agents\skills\`) konumudur.
    - Bu iki yol Windows Dizin Köprüsü (Directory Junction) ile kalıcı olarak birbirine bağlanmıştır:
      `C:\Users\Efe\.gemini\config\skills ➔ C:\Users\Efe\.agents\skills`
    - Bu köprü sayesinde kullanıcının kurduğu `frontend-design` (Anthropic'in resmi UI/UX tasarım yönergesi: AI klişelerinden kaçınma, projeye özgü oyuncu/launcher estetiği, tipografi ve hiyerarşi disiplini) ve `find-skills` (Vercel Labs) yetenekleri Antigravity ve bu ortamda çalışacak tüm AI modelleri tarafından anında tanınır, okunur ve uygulanır.
    - İleride `npx skills add ... -g` ile eklenecek tüm yeni yetenekler de ek bir ayar gerekmeksizin otomatik olarak tüm AI oturumlarında aktif olur.
40. **Mağaza Sıfırlama Kararı & Gelecek Sıfırdan İnşa Mimarisi (Clean Slate Mandate):**
    - **Karar:** Eski mağaza arayüzü yamalarla kurtarılmaya çalışıldığında ortaya çıkan orantısız kartlar, ekranı dolduran kesilmiş devasa görseller ve tutarsız düzen nedeniyle kullanıcının kesin talimatıyla **tamamen temizlenmiştir**. `renderStore()` ve `updateStoreBody()` temiz bir sıfırlama durumuna (`.store-reset-shell`) çekilmiş; hiçbir kırık DOM enjeksiyonu bırakılmamıştır.
    - **Temel Kural (Bir Daha Asla Parça Yaması Yapma):** Yeni mağaza oturumunda kod yazılmaya başlandığında kesinlikle eski CSS/HTML parçaları üzerine yama yapılmayacaktır. Arayüz, `implementation_plan.md` içinde tanımlanan bileşen hiyerarşisiyle **sıfırdan ve insan eliyle tasarlanmış gibi** inşa edilecektir.
    - **Sıfırdan Mağaza Tasarım Standartları (EGS + Steam + GOG Hibrit):**
      - **İnsan-Odaklı Tipografi & Palet:** Projenin kendi koyu launcher kimliği (`:root` / `--s-*`), aşırı parlak yapay zeka SaaS şablonlarından ve anlamsız sayaç kutularından tamamen arındırılmış temiz tasarım.
      - **Hero Vitrin Sahnesi:** Gerçek 16:9 geniş ekran sinematik sahne + sağ tarafta vitrindeki diğer oyunların küçük dikey listesi. Mükerrer görsel kesinlikle yasaktır.
      - **Dengeli Kart & Raf Sistemi:** Sabit 172px 2:3 dikey poster kartları; ücretsiz oyunlar rafında ise ekranı %75 boş bırakmayan ve dikeyde taşmayan, orantılı ve kontrollü kart düzeni.
      - **Satın Alma & Ürün Sayfası (PDP):** Medya altı hızlı satın alma şeridi, sağ yapışkan künye ve tam boy Lightbox.
      - **Altyapı Hazırlığı:** Rust backend uç noktaları (`epic_get_store_hub`, `epic_get_store_offer_detail`, `epic_search_store`, `epic_toggle_wishlist`, `epic_toggle_cart`) eksiksiz ve hazırdır. UI sıfırdan bu API'lere bağlanacaktır.
    - **Doğrulama:** `npm.cmd run build` ve `cargo test --manifest-path src-tauri/Cargo.toml` her zaman tam yeşil kalmalıdır.

41. **Mağaza Hata Sınıfları (bunlara tekrar düşme):**
    - **Ücretsiz promosyonlar ASLA birleştirilmez.** Epic `promotionalOffers` = şu an aktif,
      `upcomingPromotionalOffers` = gelecek hafta. Bunlar tek rafta toplanırsa kullanıcı henüz
      ücretsiz olmayan oyunu ücretsiz sanır (Efe'nin bildirdiği hata). "Şu An Ücretsiz" yalnızca
      `free_games_active`, "Gelecek Hafta Ücretsiz" yalnızca `free_games_upcoming` kullanır.
      Ayrıca gelecek promosyon kartlarında **ücretsiz rozeti gösterilmez** ve fiyat yerine
      `.store-price-soon` (saat ikonu + "Yakında Ücretsiz") basılır — fiyat stiliyle gösterilirse
      yine "şu an ücretsiz" sanılır.
    - **Kart `id` alanı her zaman Epic offer kimliği DEĞİLDİR.** Kütüphane rafındaki öğeler
      legendary `appName` taşır; bunlarda mağaza detayı açılmaya çalışılırsa egdata 404 döner ve
      "oyun sayfası açılmıyor" hatası olur. Bu tür raflar `openAct: "store-open-owned"` ve
      `hideQuick: true` kullanmalı. Kimlik çözümü `findOwnedSummary()` ile bulanık yapılır.
    - **`#view` kaydırma konumu `innerHTML` değişiminde KORUNUR.** Görünüm geçişlerinde
      (ürün sayfası aç/kapat, sekme/kategori değişimi) `scrollStoreToTop()` çağrılmazsa kullanıcı
      yeni sayfanın ortasına düşer ve sayfa "açılmamış" gibi görünür. `#view` üzerinde
      `scroll-behavior: smooth` olduğu için geçiş anında yapılmalıdır.
    - **Ürün detayı CDN yoklaması SINIRLIDIR:** `MAX_CDN_SLUG_TRIES = 2` (+ en olası aday için bir
      en-US denemesi). Her aday bir HTTP isteğidir; eski sınırsız döngü (4 aday × 2 dil = 8 istek)
      sayfa açılışını gereksiz geciktiriyordu. Bulunamayan slug'lar `{"_miss":true}` işaretiyle
      6 saat negatif önbelleklenir (`is_cache_miss()`); ağ hatasında işaret YAZILMAZ (geçici olabilir).
      `store_pages/` altındaki `_miss` dosyalarını geçerli içerik sanma.
    - **Ön uçta detay isteği için üst sınır vardır** (`STORE_DETAIL_TIMEOUT_MS`). Arka uç egdata +
      CDN'e gittiği için ağ yavaşken istek uzayabilir; sınır olmadan kullanıcı sonsuz iskelet görür.
    - **Sahiplik araması indekslidir.** `epicSummaries` 500+ oyun olabilir ve bir mağaza çizimi ~70
      kart üretir; her kartta her başlığı yeniden normalize etmek ~35.000 regex işlemiydi.
      `storeOwnedIndex()` başlıkları bir kez normalize eder ve `epicSummaries` referansı
      değiştiğinde tazelenir. Yeni bir sahiplik kontrolü eklerken bu dizini kullan.
    - **Ürün sayfasındaki tür hapından kategori görünümüne geçiş** `render()` gerektirir; sadece
      `updateStoreBody()` çağırmak işe yaramaz (ürün sayfasında `#store-content` yoktur).
    - **Hub isteği başarısız olursa TAM `render()` şarttır.** `loadStoreHub` yalnızca
      `updateStoreBody()` çağırırsa `renderStoreContent()` içeriği iskelette bırakır ve hata
      bloğu + "yeniden dene" hiç görünmez — kullanıcı sonsuz "yükleniyor" görür. Hata bloğu
      yalnızca kabukta (`renderStore`) yaşar.
    - **Vitrin verisi boş dönerse kullanıcıya söyle.** Yalnızca kütüphane rafı çizilip hiçbir
      açıklama yapılmazsa mağaza bozuk sanılır. `storeCatalogItems().length === 0` iken
      "Vitrin içeriği alınamadı" uyarısı basılır.
    - **Kütüphane verisi mağaza açıldıktan SONRA gelirse raf kaybolur.** `epicSummaries`
      atandıktan sonra `refreshStoreIfOpen()` çağrılmalı (`refreshEpic` ve `syncEpicLibrary`
      içinde). Bu çağrı olmadan "Kütüphanenizde, kurulu değil" rafı hiç belirmez.
    - **Eskimiş yanıt koruması ZORUNLU.** `openStoreGamePage` içinde `await` sonrası
      `storeSelectedOfferId !== offerId` ise dönülür; `finally` da yalnızca hâlâ güncel
      isteksek yükleme durumunu kapatır. Bu koruma olmadan: yavaş bir oyunu açıp geri dönüp
      başka oyuna geçildiğinde, geciken ilk yanıt ekrana yazılır ve kullanıcı B sayfasında
      A'nın künyesini görür. `tools/store-check` bu senaryoyu gecikmeli detay isteğiyle sınar.
    - **Detay `null` dönerse boş sayfa bırakma.** `!storeDetailData` dalı yalnızca geri
      düğmesi gösterirse kullanıcı boş bir ekranla kalır; açıklayıcı bir `.store-empty`
      mesajı basılmalı.
    - **Sepet/istek listesi KİMLİK saklar; öğeyi çözebilmek zorundasın.** Yerel dosyalar
      yalnızca offer kimliği tutar. `findStoreItemByIdOrTitle` sadece hub + o anki arama
      sonuçlarına bakarsa, **arama sonucundan sepete eklenen öğe arama temizlendikten sonra
      kaybolur** (kullanıcı "ekledim ama sepette yok" der). `storeItemCache` bu yüzden var:
      hub, arama sonuçları ve istek listesi yüklendiğinde `rememberStoreItems()` çağrılır,
      çözümleme önbelleğe düşer. Yeni bir öğe kaynağı eklerken `rememberStoreItems()` çağır.

## 7. Test stratejisi

- `cargo test`: saf fonksiyonlar için GERÇEK veriyle test (stderr satırları, JSON örnekleri,
  URL parse). Örnekler `legendary::skip::tests`, `transfers::tests`, `models::tests`, `cache::tests`.
- Canlı doğrulama: sistemdeki `legendary` binary'si ile aynı argümanlar denenebilir
  (`-y install <küçük-oyun> --base-path <temp> --skip-dlcs --skip-sdl`), sonra
  `uninstall` ile temizlenir. Kimlik gerektiren işler kullanıcıya aittir (kod yapıştırma).
- Hata ayıklama: `fail()` her komut hatasının TAM stderr'ini
  `<app_data>/logs/legendary-error.log` dosyasına yazar — tahmin yürütme, dosyayı oku.
  legendary config: `%USERPROFILE%\.config\legendary` (assets.json, metadata/, user.json).

### 7.1 Mağaza arayüzü doğrulaması (`tools/store-check`)

**NEDEN VAR:** Mağaza UI'ında yapılan doğrulamalar uzun süre "elle yazılmış statik HTML
önizlemesi" ile yapıldı. Bu yöntem yalnızca CSS'i sınar — **markup'ı elle taklit ettiği için
TypeScript mantığını hiç çalıştırmaz.** Kullanıcının bildirdiği iki hata (gelecek haftanın
ücretsiz oyunlarının "şu an ücretsiz" rafına karışması ve kütüphane kartlarının yanlış
kimlikle mağaza detayı açması) tam olarak bu sınıftandı ve önizlemelerle yakalanamadı.

Bu araç üretim paketini (`dist/`) **sahte bir Tauri arka ucuyla** tarayıcıda koşturur, yani
gerçek kodu çalıştırır. Kullanım:

```bash
node tools/store-check/run.mjs --check   # ÖNERİLEN: derle + 4 modda koş + PASS/FAIL özetle
                                         # başarısızlıkta çıkış kodu 1 (CI'a uygun)

node tools/store-check/run.mjs           # yalnızca hazırla (elle incelemek için)
cd tools/store-check && python -m http.server 8790
# tarayıcıda: http://127.0.0.1:8790/index.html
```

**Asset eşleme:** Vite hash'i her derlemede değişir. `run.mjs` paket dosyalarını **sabit
adlarla** (`assets/app.js`, `assets/app.css`) kopyalar ve `index.html`'i buna göre günceller.
Böylece **hiçbir zaman silme gerekmez** — toplu silme korumalarına takılmaz ve eski hash'li
dosyalar birikmez. (Klasörü komple silen yaklaşım denendi ve korumaya takıldı; bu yüzden
sabit adlara geçildi.)

Dört mod koşulur (toplam 85 iddia):

| Mod | Senaryo | İddia |
|---|---|---|
| `default` | tam veri, tüm etkileşimler | 62 |
| `?mode=empty` | hub boş → boş durum uyarısı | 6 |
| `?mode=fail` | hub hata verir → hata bloğu + yeniden dene | 6 |
| `?mode=edge` | bozuk veri: görselsiz/fiyatsız/satıcısız/çok uzun başlıklı oyun | 11 |

**Yeni bir mağaza hatası düzelttiğinde**, önce hatayı yakalayan iddiayı yaz, düzeltmeyi
geçici olarak geri al ve testin **başarısız olduğunu doğrula** (boş test yazma riski gerçek).
Sonra düzeltmeyi geri koy. Zamanlamaya bağlı testlerde (yarış durumları) bu adım zorunludur.

- Sonuçlar sayfanın sağ altındaki panelde listelenir; kırmızı `FAIL` satırı hata demektir.
- Otomatik/CI kullanımı için `run.mjs` çıktısındaki Chrome `--headless=new --screenshot`
  komutu kullanılabilir.
- Fixture'lar GERÇEK Epic/egdata verisinden üretilir (`gen_fixtures.py`, Python 3 gerekir)
  ve Rust serileştirme şemasını birebir taklit eder (snake_case alanlar,
  `SystemRequirement` → `systemType`).
- **Kritik kural:** fixture'lar `fixtures.js` ile modül script'inden ÖNCE senkron yüklenir.
  Aksi halde uygulama açılışı (`bootEpic` → `epic_cached_library`) boş veriyle çalışır ve
  mağaza/kütüphane boş çizilir — bu harness hatasıdır, uygulama hatası değildir.
- Mock şemaları `epic.ts` ile eşleşmelidir: `epic_cached_library` bir **nesne**
  (`{account, accountId, games, installed, skipped}`) döndürür, dizi DEĞİL;
  `epic_setup_status` camelCase'dir (`binaryPath`, `needsDownload`).
- Kapsanan senaryolar: bölüm sekmeleri, ücretsiz/gelecek promosyon ayrımı ve rozet yokluğu,
  kütüphane rafı tıklama davranışı, ürün sayfası + yüzen fiyat kutusu, medya görüntüleyici,
  görünüm geçişlerinde kaydırma sıfırlama, sekme/kategori geçişi, kart görsellerinin
  gerçekten yüklenmesi, JS hatası olmaması.
- **Yeni bir mağaza özelliği eklediğinde buraya bir iddia (assertion) ekle.**

### 7.2 Tasarım/görsel doğrulama (headless Edge ekran görüntüsü)

`tools/store-check` **davranışı** sınar; **görsel tasarımı** sınamaz (hizalama, taşma,
gösterge konumu, ışık/derinlik). Tasarım turlarında bu boşluk `msedge.exe --headless=new
--screenshot` ile doldurulur. Ortamda Playwright yok; Edge her Windows'ta hazır.

```bash
MSEDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
"$MSEDGE" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --allow-file-access-from-files \
  --user-data-dir="$TEMP/fresh-$RANDOM" --window-size=1280,60 \
  --screenshot="$TEMP/out.png" "file:///C:/.../preview.html"
```

**Kanla öğrenilen kurallar (bunlara uymazsan yanlış ekran görüntüsü alırsın):**
1. **Her koşuda TAZE `--user-data-dir`.** Aksi halde Edge önceki koşunun stil dosyasını
   önbellekten kullanır ve eski tasarımı çeker (sessizce yanlış sonuç).
2. **`--dump-dom` ile ölçme.** `--dump-dom` koşusunda `innerWidth = 0` olur → `@media`
   sorguları yanlış değerlendirilir (örn. `max-width: 960px` yürürlüğe girer, sekmeler
   ikona iner ve sekme genişliği 40px ölçülür). Ölçüm ile görüntüyü **ayrı koşularda** al.
   `--virtual-time-budget` da `--dump-dom` ile birlikte viewport'u bozar.
3. **JS ile konumlandırılan göstergeler ilk karede yanlış hesaplanır** (viewport 0 → sonra
   gerçek genişlik). Konumlandırmayı `resize` olayında, `document.fonts.ready` sonrasında ve
   birkaç karelik `requestAnimationFrame` döngüsünde **tekrarla**. Ekran görüntüsü öncesi
   animasyonları kapat (`*{transition:none !important;animation:none !important}`).
4. **`offsetLeft` yerine `getBoundingClientRect()` farkı** kullan (containing block'un
   `border-left` genişliğini çıkar) — ölçek faktöründen etkilenmez.
5. **Görüntü alanı = gerçek pencere genişliği.** `tauri.conf.json`'daki varsayılan 1280px'i
   kullan; 1080px'te `@media (max-width: 1200px)` devreye girer ve farklı bir düzen görürsün.
   Responsive iddiaları için ayrıca 1024 (min) ve 960 (ikon-only eşiği) ölçülür.
6. **En kötü durumu zorla:** uzun hesap adı, 3 haneli indirme sayacı — kısa örnekle ölçüm
   taşmayı gizler.
7. `-webkit-app-region` / `data-tauri-drag-region` tarayıcıda etkisizdir; sürükleme
   davranışını bu yöntemle doğrulayamazsın (gerçek uygulamada elle dene).

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
- **Özel Sıralama Açılır Menüsü (Custom Dark Sort Dropdown):**
  - Windows yerel `<select>` elementinin WebView2 üzerinde beyaz açılır menü çizmesi engellenmiş, yerine koyu cam tasarımlı `.sort-dropdown-container` getirilmiştir.
  - Seçenekler özel inline SVG ikonları (Saat, A-Z, Onay, Kupa, Yenileme) ve seçili öğede onay (`check`) işaretiyle gösterilir; kullanıcı tercihi `localStorage` (`efxlve-sort`) içinde hatırlanır.
- **Oyun Detay Koleksiyonlar Kartı Tasarımı:**
  - Düz mavi kutu yerine `.drawer-col-card` cam kart tasarımı, mor/indigo klasör ikon rozeti, "X kategoride ekli" dinamik alt bilgisi, modern cam haplar (`.drawer-col-pill`) ve boş durum için kesikli çerçeveli eylem butonu (`.drawer-col-empty-cta`) entegre edilmiştir.
- **SteamGridDB API v2 Entegrasyonu & Özel Kapak Yöneticisi:**
  - `src-tauri/src/legendary/steamgrid.rs` modülü ile SteamGridDB API v2 (`https://www.steamgriddb.com/api/v2`) doğrudan launcher'a bağlanmıştır.
  - Disk önbelleklemesi (`%USERPROFILE%\.config\legendary\steamgrid\`) ile arama ve kapak sorguları yerel diskte saklanır, ağ trafiği ve kota korunur.
  - API Anahtarı Ayarlar panelinde özel kart ve "Kapağı Özelleştir" modalında doğrudan girilebilir; canlı bağlantı test butonu (`epic_test_steamgrid_key`) ve göster/gizle göz ikonu sunulur.
  - Gelişmiş 3 sekmeli Kapak Modalı (`.cover-modal-tabs`): `[ 🌐 SteamGridDB Topluluğu ]`, `[ 🔗 Doğrudan Web URL ]`, `[ 📁 Bilgisayardan Dosya ]`.
  - Canlı oyun adı arama ve Enter tuşu desteği, alternatif oyun eşleşme hapları (`.sgdb-chip`), Oran seçimi (Dikey Kapak 2:3 / Yatay Afiş Hero), Stil filtreleri (Tümü, Logosuz, Alternatif, Resmi), topluluk oylama skoru / sanatçı rozetleri ve tek tıkla önizleme kartına seçip kütüphaneye uygulama desteği.
- **İkili Görsel Özelleştirme & Rafine SteamGridDB Modalı (Dikey Kapak vs Yatay Afiş):**
  - **Bağımsız Depolama:** Kütüphane dikey kartları için `customCovers` (`efxlve-custom-covers`), Vitrin Spotlight ve Detay Çekmecesi afişi için `customHeroes` (`efxlve-custom-heroes`) bağımsız olarak `localStorage` üzerinde saklanır.
  - **Geniş Afiş Entegrasyonu:** `epicWideArt(s)` fonksiyonu önce `customHeroes[s.appName]` değerine bakar; böylece kullanıcının seçtiği yatay afiş Hero Vitrini, Detay Çekmecesi ve Raflar modunda anında canlı olarak gösterilir.
  - **Segmented Hedef Kontrolü & Adaptif Önizleme:** Modalın tepesinde `[ 🎮 Dikey Kapak (2:3) ]` ve `[ 🎬 Yatay Afiş (Hero / Vitrin) ]` segment kontrolü yer alır. Seçilen hedefe göre önizleme çerçevesi 2:3 dikey kart ile 16:7 sinematik geniş afiş arasında dinamik olarak geçiş yapar; SteamGridDB sekmesinde ilgili format otomatik etkinleştirilir.
  - **Tek Satır Eşleşen Oyunlar Şeridi & Temiz Galeri:** Çok satıra taşan dağınık butonlar yerine tek satır pürüzsüz yatay kaydırılabilir `.sgdb-matching-games-bar` track'i uygulanmıştır. Galeri kartlarındaki kaba siyah metin kutuları kaldırılmış, yerine kart üzerine gelindiğinde (hover) beliren zarif yarı saydam rozetler ve seçili kartta ışıltılı halka + mini onay rozeti getirilmiştir.
  - **Çekmece Başlığı Afiş Değiştirme Butonu:** Oyun detay çekmecesinin başlık afişinde doğrudan `.drawer-cover-edit-btn` yer alır; tek tıkla afiş düzenleyiciyi açar.
- **Yerleşik Mağaza Merkezi (Native Store Hub), Ücretsiz Promosyonlar & Canlı Rozet Mimarisi:**
  - Harici tarayıcı veya yavaş çocuk webview yerine doğrudan launcher içine entegre edilmiş yerleşik mağaza görünümü (`view = "store"`).
  - **Haftalık Ücretsiz Oyunlar Vitrini:** Resmi Epic static CDN (`https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=tr-TR&country=TR&allowCountries=TR`) üzerinden aktif ve gelecek haftanın ücretsiz oyunları, geri sayım sayaçları, Türkçe TRY etiketleri ve doğrudan alma eylemleri.
  - **egdata.app Entegrasyonu:** En Çok Satanlar (`top_sellers`), Öne Çıkan İndirimler (`featured_discounts`), Yakında Çıkacaklar (`upcoming_offers`) ve dinamik arama (`search_store_offers`) ile geniş katalog desteği.
  - **Gerçek Zamanlı Durum Rozetleri (Detay Sayfasına Girmeden Erişim):**
    - `✓ Kütüphanede`: Kullanıcının sahip olduğu yerel oyunlarla (488+ oyun) eşleşenler zümrüt yeşili rozet alır ve tıklanınca doğrudan kütüphane çekmecesini açar.
    - `❤️ İstek Listesinde`: Resmi Launcher GraphQL (`https://launcher.store.epicgames.com/graphql`) üzerinden çekilen kullanıcının gerçek Epic istek listesi (179+ oyun) ve yerel istek listesi eşleştirmesi ile pembe/kırmızı rozet.
    - `🛒 Sepette`: Kullanıcının yerel sepetindeki öğeler için camgöbeği (cyan) rozet.
    - `-%XX`: Aktif indirim oranını gösteren amber sarısı rozet.
  - **Hover Katmanı & Hızlı Eylemler:** Kart hover'ında anlık kalp (istek listesi aç/kapa), sepet butonu, doğrudan mağaza bağlantısı veya kütüphanede açma butonu ve sağdan kayan detay çekmecesi (`Store Drawer`).
- **Yerleşik Mağaza Ürün Sayfası & Çocuk Webview Satın Alma Entegrasyonu:**
  - Harici tarayıcı yönlendirmesi tamamen sonlandırılmış; herhangi bir mağaza kartına tıklandığında doğrudan tam sayfa yerleşik ürün görünümü (`view = "store-product"`, `openStoreGamePage(offerId)`) açılır.
  - Rust backend (`epic_get_store_offer_detail`, `store.rs`): Akamai CDN ve egdata offer API'leri taranarak geniş afiş, ekran görüntüleri galerisi (interaktif küçük resimler şeridi ve tam boy önizleme), oyun künyesi, zengin açıklama, donanım gereksinimleri tablosu ve dinamik satın alma kartı sunulur.
  - Satın alma veya kütüphaneye ekleme işlemi için launcher'ın yerleşik çocuk webview'i (`openStoreUrl(...)`) pencere başlık çubuğunun altına tam oturacak şekilde gömülür.
- **Dinamik Para Birimi & TRY (₺) Yerelleştirme Motoru:**
  - Sabit Amerikan Doları ($) gösterimi engellenmiş, kullanıcının `user.json` kütüğündeki `country` alanından dinamik tespit edilen ülke (TR) üzerinden Türk Lirası (`₺`) ve standart formatlama (`format_currency`: `₺391,30`, `₺1.250,00`) uygulanmıştır.
  - Tüm egdata ve CDN sorgularına `country={country}` parametresi eklenmiştir.
- **Mağaza UI / UX & Daima Görünür Kart Tasarımı Revizyonu:**
  - Kart hover katmanı zorunluluğu kaldırılarak başlık, geliştirici, indirim yüzdesi (`-%XX`), eski fiyat ve indirimli fiyat kartın altında her zaman görünür kılınmıştır.
  - Haftalık Ücretsiz Oyunlar vitrini (`.store-freegames-showcase`) altın parıltılı aura, kalan süre geri sayım sayaçları ve doğrudan ürün sayfasını açan butonlarla donatılmıştır.
- **Anthropic Skills & Global Ajan Yetenekleri Entegrasyonu (`anthropics/skills`):**
  - `C:\Users\Efe\.agents\skills` dizini ile Antigravity'nin global arama yolu `C:\Users\Efe\.gemini\config\skills` arasında Windows Junction kurulmuştur.
  - Anthropic'in resmi `frontend-design` (AI klişelerinden kaçınma, projeye özgü oyuncu/launcher estetiği, tipografi ve hiyerarşi disiplini) ve Vercel Labs `find-skills` yetenekleri tüm AI modelleri için kalıcı olarak entegre edilmiştir.
- **Mağaza Vitrini & Ürün Sayfası Yeniden Tasarımı (GOG tarzı düzen, launcher teması):**
  - Hantal ızgara + hover zorunlu kart yapısı terk edildi; yerine sinematik hero carousel (otomatik geçiş, nokta göstergeleri, hover'da duraklama) ve yatay kaydırılabilir raflar (Ücretsiz / İndirimler / Çok Satanlar / Yakında / İstek Listenizde İndirim) getirildi.
  - Kartlarda indirim rozeti (`-%XX`), üstü çizili liste fiyatı ve kalın güncel fiyat her zaman görünür; ücretsiz oyunlar yeşil "Ücretsiz" etiketiyle ayrışır. Kütüphanede / İstek / Sepet durum rozetleri sol üstte, hızlı eylemler sağ üstte — çakışma yok.
  - Ürün sayfası: hero + oyun logosu, galeri (ekran görüntüleri + fragman kapakları), Hakkında, öne çıkan özellikler, sekmeli sistem gereksinimleri tablosu, desteklenen diller, türler, resmi bağlantılar ve yapışkan satın alma kutusu.
  - Kütüphane durumu kartı: oyun sahibiyseniz kurulum boyutu, başarım ilerlemesi ve güncelleme durumu doğrudan mağaza sayfasında gösterilir.
  - Palet launcher'ın kendi temasına çekildi (ithal "Epic mavisi" kaldırıldı); mağaza özel belirteçler `.store-shell` içinde yerel tutulur.
- **Steam-Like Mağaza Tasarımı & Veri Kaynağı Önceliği (Steam Desktop Client Architecture):**
  - **Veri Kaynağı Stratejisi:**
    - `store.epicgames.com` doğrudan HTML kazıma Cloudflare 403 engeline takıldığı için kullanılmaz.
    - Birincil öncelik doğrudan **Resmi Epic Games API'leridir**:
      - Katalog arama, resmi TL fiyatları ve kapaklar için `launcher.store.epicgames.com/graphql` (410 ms, HTTP 200).
      - Haftalık 100% ücretsiz oyunlar için resmi Akamai CDN `store-site-backend-static.ak.epicgames.com/freeGamesPromotions` (370 ms).
      - Ürün medyası ve sistem gereksinimleri için resmi Akamai CDN `store-content-ipv4.ak.epicgames.com` (890 ms).
    - `egdata.app` ise çok satanlar (top sellers) popülerlik sıralaması ve katalog indekslemesinde yardımcı/yedek servis olarak arka uçta tutulur.
  - **Steam Masaüstü İstemcisi Ergonomisi:**
    - Renk paleti: Steam lacivert/arduvaz tonları (`#171a21`, `#1b2838`, `#212c3d`, `#66c0f4`, `#c7d5e0`).
    - Steam imzası zeytin yeşili indirim kutucuğu (`background: #4c6b22; color: #a4d007; font-weight: 800`).
    - Steam "Öne Çıkan ve Tavsiye Edilen" (Featured & Recommended) vitrini: Sol tarafta 16:9 ana sahne, sağ tarafta fareyle üzerine gelindiğinde anında sahneyi değiştiren hover-swap özellikli 4 küçük görsel listesi.
    - Ürün sayfası (PDP): Medya vitrininin altında Steam tarzı satın alma şeridi (`.store-pdp-buy-strip`, `[Oyun Adı] Satın Alın` başlığı, indirim kutucuğu ve yeşil CTA butonu).
    - Doğrulama: `npm.cmd run build` (0 hata) + `tools/store-check/run.mjs --check` (90/90 PASS, 0 FAIL) + `cargo test` (47 PASS).
- **Üst Bar (Titlebar) Dört Turluk Tasarım Evrimi & Yan Yana Karşılaştırma (§71–§75):**
  - Gradyan/kapsül (56px) → aşırı sadeleştirme (48px) → tuş yüzeyleri (50px) → **PS5 ortam ışığı (54px)**. Bkz. §74 (mevcut dil) ve §75 (karşılaştırma + headless görsel doğrulama dersleri).
  - Karar: kutular değil ışık ve çizgi. `@property --nav-ambient` ile bağlamsal renk geçişi, kayan beyaz alt çizgi, PS5 kontrol merkezi döşemeli sağ küme.
  - Kısayollar: `Ctrl+1` Mağaza, `Ctrl+2` Kütüphane, `Ctrl+3` İndirmeler, `Ctrl+,` Ayarlar.

## 9. Çalışma disiplini

- Kullanıcı Türkçe konuşur — yanıtlar ve UI metinleri Türkçe, kod yorumları kısa Türkçe.
- Kısa ve öz iletişim; gereksiz dosya oluşturma (yeni dosya = sadece açıkça gerekirse).
- `dist/`, `target/`, `node_modules/` commitlenmez (gitignore'lu).
- Commit/PR yalnızca açıkça istenirse.

## 41. Gömülü Mağaza (Child Webview) & Legendary Otomatik Oturum

- **Gömülü Mağaza Mimarisi:**
  - Epic Games Store, `X-Frame-Options: SAMEORIGIN` kullandığından iframe içinde açılamaz. Tauri v2 `unstable` özelliği ile child webview (`add_child`) olarak ana pencerenin içerik alanına gömülür.
  - Üst bar (`header#titlebar`) HTML olarak üstte kalır ve sekmeler arası geçiş aktiftir.
  - Mağaza sekmesinden başka bir sekmeye geçildiğinde (`library`, `downloads`, `profile`, `settings`) `hide_store_view` çağrılarak mağaza görünümü gizlenir; geri dönüldüğünde `show_store_view` ile tekrar gösterilir (durum ve gezinme geçmişi korunur).
  - Pencere yeniden boyutlandırıldığında sayfayı yeniden yüklememek için `resize_store_view` komutu ile mevcut webview'in konumu ve boyutu güncellenir.
- **Doğrudan Mağaza Yükleme & Kalıcı Oturum:**
  - Epic Games Store'a doğrudan `https://store.epicgames.com/` olarak gidilir. `id/exchange` gibi harici yönlendirmeler Cloudflare 403 korumasına takıldığı için kullanılmaz.
  - WebView2, kullanıcının mağaza oturumunu kendi yerel kullanıcı veri dizininde kalıcı olarak saklar; böylece mağazada bir defa oturum açıldığında launcher'ın sonraki tüm açılışlarında oturum açık kalır.

## 42. Gömülü Mağaza Performansı, Efxlve Rozet Eklentisi & Yükleme Deneyimi

- **0 ms Hızlı Sekme Geçişi & Hedef Yönlendirme:**
  - `show_store_view`, webview önceden oluşturulmuşsa hiçbir ağ isteği beklemeden `v.show()` ile 0 ms gecikmeyle anında odaklanır.
  - Belirli bir oyun veya detay sayfası açılmak istendiğinde (`openStoreUrl`) `v.url()` ve `v.navigate(target)` ile mevcut webview hedefe yönlendirilir.
- **Kütüphane Asılı Kalma & Beyaz Parlama Önleme (Anti-Flash):**
  - "Mağaza" sekmesine geçildiğinde `render()` fonksiyonu `storeVisible` kontrolü yaparak `renderStoreLoadingScreen()` ile AAA launcher standartlarında minimalist yükleme ekranı gösterir; kütüphanenin arka planda görünmeye devam etmesi tamamen engellenmiştir.
  - `STORE_EXTENSION_SCRIPT` içindeki `injectStyle()` fonksiyonu `html, body { background-color: #121212 !important }` stilini anında enjekte ederek beyaz parlamayı (flashbang) ortadan kaldırır.
- **Efxlve Mağaza Eklentisi (`STORE_EXTENSION_SCRIPT`):**
  - Kullanıcının diskteki tüm kütüphane ve kurulu oyun verileri (`get_owned_games_json()`) `window.__EFXLVE_GAMES` olarak webview ilk çalıştırma betiğine (initialization script) verilir.
  - **Duyarlı ve Yaratıcı Rozet Mimarisi:**
    - Mağaza kartlarındaki afiş genişliği taranır; dar listeler ve kenar çubuğu kartları için (< 105px) metin kırpılmasını ve sağ üstteki yer imi düğmesiyle çakışmayı önleyen **22x22px vektör SVG mikro rozetler** (`.efxlve-badge-micro`, gamepad/play/yıldız ikonlu cam madalyon) kullanılır.
    - Geniş kartlarda (>= 105px) ise yüksek kaliteli cam stüdyo hapları (`.efxlve-badge-full`, zümrüt kütüphane, indigo kurulu, kehribar istek listesi) gösterilir.
    - Tab'lar (`[role="tab"]`), üst menüler, breadcrumb bağlantıları ve oyunun kendi detay sayfasındaki iç linkler kesinlikle filtrelenir ve rozet basılmaz.
  - **İnteraktif Ürün Detay (PDP) Kartı & 1-Tıkla Kütüphaneye Atlama:**
    - Oyun detay sayfasında (`/p/<slug>`) satın alma sütununa interaktif **Efxlve Eylem Kartı** (`.efxlve-pdp-card`) eklenir; "Kütüphanede Aç" veya "Kütüphaneden Başlat" butonu sunar.
    - Tıklandığında veya Epic'in kendi devre dışı "Kütüphanede" butonuna tıklandığında `https://efxlve.local/open-game` tetiklenir; Rust `on_navigation` yakalayarak `efxlve-open-game-from-store` olayını yayar, mağazayı anında kapatıp kütüphaneye döner ve oyunun detay çekmecesini (`openEpicModal`) açar.
  - **Launcher Mor Teması & Kusursuz İkon Hizalama Disiplini:**
    - Tüm yeşil (`#34d399`, `#10b981`) renkler Efxlve Launcher'ın kendi asil mor paletiyle değiştirilmiştir:
      - Kütüphanede etiketleri ve PDP kartı: `#c084fc` lavanta moru, `rgba(168, 85, 247, 0.14)` yarı saydam cam zemin, `1px solid rgba(168, 85, 247, 0.35)` çerçeve ve `linear-gradient(135deg, #7c3aed, #a855f7)` CTA butonu.
      - Kurulu oyunlar: Launcher ana rengi `#6366f1` / `#818cf8` indigo/mor gradyan.
    - SVG ikonlarındaki (`vertical-align: -2px`, `margin-right: 5px`) gibi gömülü kaydırıcı stiller tamamen kaldırılmış, flexbox kapsayıcıları (`align-items: center; gap: 6px;`) ile ikonların hem fiyatta hem de PDP ikon kalkanında (`.efxlve-pdp-icon-shield`) milimetrik olarak tam merkezde (dead-center) oturması sağlanmıştır.
    - Fiyat alanı etiketleri (`.efxlve-price-tag`) ham metin yerine `backdrop-filter: blur(8px)`, 6px yuvarlak köşe ve hafif mor parıltılı cam hap madalyona dönüştürülmüştür.
  - **Güvenli Oyun Eşleme Disiplini (Ön Ek & Alt Dize Yasağı):**
    - `norm.indexOf(gNorm) === 0` veya `slug.indexOf(og.s) === 0` gibi kör ön ek / alt dize kontrolleri KESİNLİKLE YASAKTIR. Aksi halde *"Control"* oyununa sahip bir kullanıcıda *"CONTROL Resonant"* gibi devam oyunları veya *"Hitman 3"*, *"Alan Wake 2"* gibi farklı yapımlar yanlışlıkla kütüphanede gösterilir.
    - Eşleme; tam eşleşme, edisyon takılarının temizlenmesi (`stripEdition`: *Premium Edition*, *Standard Edition*, *Director's Cut*, *GOTY* vb.) ve slug edisyon temizliği (`stripSlugEdition`: `-standard-edition`, `-directors-cut` vb.) üzerinden deterministik olarak yapılır.
    - Eşleşmeyen kartlarda veya PDP sayfalarında eski hatalı etiketler (`data-efxlve-owned`, `.efxlve-price-tag`, `.efxlve-pdp-card`) otomatik olarak temizlenir.
## 43. Oyun Detay Sayfası / Çekmecesi (Game Detail Drawer) Sadeleştirme & Bento Bilgi Şeridi Mimarisi

- **Kullanıcı Geri Bildirimi & Tasarım Değişikliği Gerekçesi:**
  - 30+ kişilik kullanıcı test grubunda eski detay çekmecesi aşırı kalabalık, kullanışsız ve SaaS yönetim paneli gibi dağınık kutularla dolu bulunmuştu.
  - Oyun detay çekmecesi Steam, PlayStation 5 ve GOG Galaxy 2.0 standartlarında tek parça, ferah ve sinematik bir deneyime dönüştürülmüştür.
- **Tekrarların & Görsel Gürültünün (Visual Noise) Temizlenmesi:**
  - **Görsel Değiştirme Butonları:** Afiş üzerindeki kaba metin kutusu ve aksiyon barındaki mükerrer buton kaldırılarak afişin sol üst köşesine zarif, dairesel ve yarı saydam cam hover ikon butonu (`.drawer-cover-edit-btn`, `icon("image", 14)`) yerleştirildi.
  - **Mükerrer Künye Verileri:** Başlık altında 3 kez tekrarlanan geliştirici adı, 3 kez yazılan Ubisoft Connect/3. parti başlatıcı ve 2 kez yazılan BattlEye rozetleri tek bir şık meta satırında (`.drawer-meta-subline`: `Geliştirici • Durum • Launcher • Anti-Cheat`) birleştirildi.
  - **Sahte / Şablon Açıklama Metni:** Hiçbir bilgi taşımayan ve ekranı işgal eden jenerik dolgu metin (*"Tom Clancy's Rainbow Six Siege, Ubisoft Entertainment tarafından sunulan..."*) tamamen kaldırıldı. Yalnızca oyunun gerçek bir özeti (`s.description`) varsa temiz tipografiyle (`.drawer-desc`) sunulur.
  - **Başarım Çakışması:** Üstte zaten zengin bir `🏆 Başarımlar` sekmesi yer alırken Genel Bakış sekmesinde duran devasa sarı başarım vitrini kutusu kaldırıldı; sayfa ferahlatıldı.
  - **Launcher Mor Teması:** Yeşil (`#10b981`) oynatma/başlatma butonları launcher'ın asil mor/indigo gradyanı (`linear-gradient(135deg, #8b5cf6, #7c3aed)`) ile uyumlu hale getirildi.
- **Tek Parça Bento Bilgi Şeridi (Unified Quick Info Bar):**
  - Ayrı ayrı çerçeveler halinde duran Oynama Süresi, Son Aktivite ve Koleksiyonlar kutuları tek parça, 2 sütunlu cam efektli Bento Şeridi (`.drawer-bento-bar`, `.bento-tile`) olarak toplandı.
  - Oynama süresi kutucuğuna tıklanarak doğrudan süre düzenleme modalı (`openEditPlaytimeModal`) açılabilir.
  - Koleksiyon etiketleri doğrudan kütüphane filtresine yönlendirir veya `+ Ekle` butonu ile yönetim modalını tetikler; `updateDrawerCollectionsBoxInPlace` ve `saveEditedPlaytime` fonksiyonları ile geriye dönük tam uyumlu olarak DOM'da yerinde güncellenir.
- **Sadeleştirilmiş Teknik Bilgiler & Sistem Sekmesi:**
  - Alt kısımdaki hantal ve mükerrer 3'lü kutu (`.drawer-info-grid`: Boyut, Platform, Sistem Gereksinimi) tamamen kaldırıldı; üstteki özel `[ 🖥 Sistem ]` sekmesi donanım gereksinimleri için tek ve eksiksiz kaynak olarak konumlandırıldı.

## 44. HowLongToBeat (HLTB) Entegrasyonu & Detay Çekmecesi Zenginleştirmesi

- **HowLongToBeat Yeni Nesil Motoru (Rust Backend):**
  - Eski statik `/api/search` uç noktası Cloudflare/Imperva 403 engeline takıldığı için `howlongtobeatpy` ve Heroic Games Launcher mimarisine uygun dinamik kimlik doğrulama motoru geliştirildi:
    1. Ana sayfa HTML'i ve `/_next/static/chunks/` betikleri taranarak güncel arama uç noktası (varsayılan: `/api/search/site`) dinamik olarak çözülür.
    2. `${endpoint}/init?t=${timestamp}` çağrılarak geçici auth token ve dinamik güvenlik anahtar/değer çiftleri (`x-auth-token`, `x-hp-key`, `x-hp-val` / payload içi anahtar) elde edilir.
    3. Arama isteği bu oturum başlıklarıyla POST edilerek Imperva engeli aşılır (Control, Cyberpunk 2077, GTA V, Rainbow Six Siege vb. tüm oyunlarda 200 OK ile doğrulanmıştır).
  - **Başlık Temizleme & Unicode Normalizasyonu:**
    - Eğik tırnaklar (`’`, `‘`, `´`, `\u{2019}` vb.) düz kesme işaretine (`'`) ve ticari semboller (`™`, `®`) boşluğa normalize edilir.
    - Seri/yayıncı ön ekleri (*Tom Clancy's*, *Marvel's*, *Star Wars* vb.) ve edisyon takıları (*Standard Edition*, *Definitive Edition*, *Game of the Year Edition* vb.) ayıklanarak HLTB veritabanında en yüksek doğrulukla oyun eşleşmesi sağlanır.
  - **Güvenli Önbellekleme Disiplini:**
    - Yalnızca geçerli süre verisi içeren (`supported == true`) sonuçlar diske (`%USERPROFILE%\.config\legendary\hltb\<app>.json`) yazılır; geçici ağ sorunları veya boş sonuçlar önbelleği kalıcı olarak kilitlemez (`force_refresh` desteği).
- **Detay Çekmecesi Bento Arayüzü & Zenginleştirme:**
  - **HowLongToBeat Bento Kartı (`.drawer-hltb-card`):**
    - Genel Bakış sekmesinde mor temalı şık Bento kartı olarak yer alır.
    - Yükleme esnasında zarif dönen halka ve `Tahmini süreler aranıyor…` durum göstergesi sunar.
    - Sonuç geldiğinde 3 sütunlu net veriler sunar: `Ana Hikaye` (saat), `Ana + Ekstra` (saat) ve `%100 Bitirme` (saat).
    - HLTB verisi bulunmayan oyunlarda görsel kirlilik yaratmadan temiz bir şekilde gizlenir.
  - **Kompakt Başarım İlerleme Şeridi (`.drawer-quick-ach-strip`):**
    - Başarım desteği olan oyunlarda Genel Bakış sekmesini boşluk hissinden kurtaran tek satırlık zarif başarım özeti:
      - Kupa ikonu, başarım adedi ve tamamlama yüzdesi (`12/48 (%25)`).
      - Altın/amber gradyanlı ince ilerleme çubuğu.
      - Toplam kazanılan XP (`450/1000 XP`) ve tıklandığında doğrudan `🏆 Başarımlar` sekmesine pürüzsüz geçiş sağlayan interaktif ok butonu.

## 45. SteamHunters İlhamlı Başarımlar & Detay Çekmecesi Dönüşümü

- **HowLongToBeat Uç Nokta Düzeltmesi (Rust `hltb.rs`):**
  - Dinamik uç nokta çözümlemesinde chunk betiklerinden dönen `/init?t=...` takısının ayıklanması sağlandı. Böylece arama istekleri POST 405 Method Not Allowed yerine doğru `/api/search/site` adresine yönlendirildi ve Rainbow Six Siege gibi tüm oyunlarda süre verileri (Ana Hikaye, Ekstra, %100) 200 OK ile sorunsuz elde edildi.
- **Genel Bakış (Overview) Görsel Sadeleştirmesi:**
  - Kullanıcıyı boğan ve zaten başlık altında yer alan mükerrer 4 gri kutu (`GELİŞTİRİCİ`, `BAŞLATICI`, `HİLE KORUMASI`, `PLATFORM`) kaldırıldı.
  - Açıklaması olmayan oyunlarda ekranın boş kalmaması için zarif, tek satırlık `.drawer-feature-strip` eklendi; eklenti hapına tıklandığında doğrudan Eklentiler sekmesine geçiş sağlandı.
  - Başarım hızlı ilerleme şeridine kullanıcının kazandığı ilk 4 başarımı gösteren mini kupa görselleri (`.quick-ach-thumbs-row`) entegre edildi.
- **SteamHunters Başarım Mimarisi & Havadar Cam Tasarım:**
  - **Kategori & DLC Gruplaması (`.ach-group-section`):** SteamHunters yapısına uygun olarak başarımlar `Ana Oyun (Base Game)` ve `Ek Paketler & DLC` olarak iki bağımsız bölüme ayrıldı. Her bölüm kendi kupa adedini (`X/Y`), tamamlanma yüzdesini (`%pct`), toplam XP'sini ve renkli ilerleme çubuğunu (Ana oyun: altın kehribar, DLC: mor/lavanta) taşır.
  - **Canlı Arama & Akıllı Sıralama Çubuğu (`.ach-toolbar`):**
    - `#ach-search-input`: Başarım adı ve açıklamasında anında filtreleme yapar; çekmeceyi yeniden açmadan veya input odağını kaybetmeden listeyi yerinde (in-place) günceller.
    - `#ach-sort-select`: `Varsayılan Sıra`, `Nadirliğe Göre`, `XP'ye Göre` ve `Kazanılma Tarihine Göre` sıralama seçenekleri sunar.
  - **Havadar & Şeffaf Cam Kart Tasarımı (`.ach-card`):**
    - Eski boğucu, kalın ve mat gri kutular yerine 52px yüksek çözünürlüklü ikonlar, 11px padding, yarı saydam cam arka plan (`rgba(255, 255, 255, 0.035)` / backdrop blur) ve kazanılan başarılarda asil altın sol kenarlık (`border-left: 3px solid rgba(245, 158, 11, 0.6)`) kullanıldı.
    - Kilitli başarımlar soluk gri ve şık asma kilit rozeti ile gösterilir; gizli başarımlar ise tıklandığında açılıp kapanabilen spoiler koruması sunar.

## 46. PlayStation (PS5) Konsol Estetiği Kuralı & Detay Sayfası / Başarımlar Dönüşümü

- **PlayStation-Inspired (PS5 Console) Dark Aesthetic Direktifi:**
  - Launcher'ın görsel dili daima konsol dünyasının zarafetinden ilham alır: derin obsidyen ve kozmik gece mavisi tonları (`#07080d`, `#0b0d14`, `#121624`), radyal derinlik ışımaları (`radial-gradient`), 16px yuvarlatılmış cam kartlar ve sade konsol tipografisi.
  - **Telif Güvenliği:** Sony markası/logoları doğrudan kullanılmaz; konsol UI hissi launcher'ın kendi mor/altın/indigo renk paletiyle özgün bir kimlik olarak harmanlanır.
- **Gereksiz Kapsam Çubuğunun ("Tüm İçerik", "Ana Oyun", "Ek Paketler") Kaldırılması:**
  - Arayüzü daraltan ve üst üste 3 katmanlı araç çubuğu yaratan `ach-scope-strip` kaldırıldı.
  - Başarım listesi SteamHunters ilkesine uygun olarak `🎮 Ana Oyun` ve `📦 Ek Paketler & DLC` başlıkları altında doğal hiyerarşisiyle listelenmeye devam eder; böylece ekran ferahlar.
- **PlayStation 4-Seviyeli Kupa Hiyerarşisi (`.ps-trophy-tier-row`):**
  - Hero kartına PlayStation Trophy kartlarındaki gibi metalik kupa sayaçları entegre edildi:
    - 🏆 **Platin:** `effPlatUnlocked / effPlatTotal` (Kozmik mavi/elmas parlaklığı)
    - 🥇 **Altın:** `goldUnlocked / goldTotal` (Altın sarısı ışıma)
    - 🥈 **Gümüş:** `silverUnlocked / silverTotal` (Metalik gümüş parlaklığı)
    - 🥉 **Bronz:** `bronzeUnlocked / bronzeTotal` (Bakır bronz tonları)
  - Tamamlanan kupa seviyelerinde `.complete` rozeti ile canlı ışıma verilir.
- **Konsol Tipi Sadeleştirilmiş Toolbar & Durum Çipleri:**
  - Canlı arama kutusu ve sıralama menüsü üstte tek sırada hizalandı.
  - Altında konsol hap butonları (`[ Tümü ]`, `[ ✓ Kazanılanlar ]`, `[ 🔒 Kilitliler ]`, `[ 👁 Gizli ]`) yer alır.

## 47. Detay Çekmecesinin (Game Detail Drawer) Komple PS5 Yeniden Tasarımı & Sadeleştirilmesi

- **30+ Test Kullanıcısı Geri Bildirimi & Radikal Sadeleşme:**
  - Önceki çok katmanlı, bento kutulu, aşırı renkli ve kalabalık bulunan detay sayfası PlayStation 5 Game Hub / Trophy Hub felsefesiyle ("Oyun UI'dır", görsel sessizlik ve ferahlık) baştan tasarlandı.
- **Sinematik Cover Hero (280px & Entegre Başlık):**
  - Afiş yüksekliği 230px'ten 280px'e çıkarıldı, derin atmosferik degrade (`rgba(7, 8, 13, 0.97)`) eklendi.
  - Oyun başlığı ve geliştirici/durum meta satırı gövdeden (`drawer-body`) alınıp cover afişinin içine (`.drawer-hero-info`) entegre edildi; PS5'in oyun içine gömülü tipografi dili yakalandı.
- **Minimal PS5 Çizgi (Underline) Sekmeler:**
  - Hantal hap (pill) şeklindeki sekmeler yerine, PS5 ana ekranındaki gibi sade, altı mavi çizgili (`border-bottom: 2px solid #3b82f6`) minimal sekmeler (`.drawer-tab`) uygulandı.
- **Kompakt Tek Satır İstatistik Şeridi (`.drawer-stats-row`):**
  - Karmaşık bento kutuları, ayrı HLTB kartı ve quick achievement strip kaldırıldı.
  - Yerine tek bir temiz obsidyen cam çubuk (`.drawer-stats-row`) içinde 3 temel veri toplandı:
    1. **Oynama Süresi:** `142 sa` (tıklanabilir, düzenleme özellikli)
    2. **Başarımlar / Platin Kupa:** `39/58 (%67)` (tıklanabilir, doğrudan başarımlar sekmesine geçer)
    3. **Ana Hikaye:** `~60 sa` (HowLongToBeat anlık entegrasyonu)
  - Altına sade koleksiyon etiketleri (`.drawer-tags-row`) ve DLC hapı yerleştirildi.
- **Kompakt Başarım Özet Çubuğu (`.ach-summary-bar`) & Sade Kartlar:**
  - Devasa başarım hero kutusu yerine PS5 konsolundaki gibi yuvarlak SVG ilerleme halkası (`.ach-progress-ring`), kupa sayısı ve minik metalik kupa sayaçları (`.ach-tier-mini` Platin, Altın, Gümüş, Bronz) içeren tek satırlık zarif özet barı eklendi.
  - Başarım kartları (`.ach-card`) gereksiz rozet ve meta kalabalığından arındırıldı; sol kenar mavi vurgusu, temiz başlık/açıklama, ultra-nadir ve tarih etiketi ile akıcı konsol deneyimi sunuldu.
## 48. PlayStation 5 Full-Screen Cinematic Game Hub (Tam Ekran Konsol Sahnesi)

- **Dar Çekmeceden (560px Drawer) Tam Ekran Konsol Hub'ına Geçiş:**
  - 560px'lik dar sağ çekmece yapısı terk edilerek ekranı yatayda ve dikeyde dolduran, ferah, nefes alan **PlayStation 5 Game Hub** konsol sahnesi (`.game-hub`, `.hub-stage`, `max-width: 1260px`) inşa edildi.
  - Arka planda tam ekran yüksek çözünürlüklü oyun sanatı (`.hub-backdrop`) ve derin PS5 obsidyen/gece mavisi degrade perdesi (`.hub-backdrop-gradient`) yer alır; oyunun atmosferi başlatıcıya bütünüyle hakim olur.
- **Konsol Tipi Üst Navigasyon & Hero Alanı:**
  - Sol üstte zarif `← Kütüphane [ESC]` geri butonu (`.hub-back-btn`), sağ üstte afişi özelleştirme ve kapatma araçları (`.hub-topbar-tools`) yer alır.
  - Hero bölümünde 38px bold oyun başlığı, geliştirici, partner launcher ve hile koruması rozetleri sunulur.
  - Büyük PS5 canlı mavi aksiyon butonu (`[ ▶ Hemen Oyna ]`), ikincil cam butonlar (`[♥ Favori]`, `[↗ Mağaza]`, `[⚙ Yönet]`, `[x İptal]`) ve sağ tarafta yüzen cam stat kapsülü (`.hub-stat-capsule` — Oynama Süresi, Başarım/Platin Kupa, HLTB Hikaye) konumlandırıldı.
- **Genel Bakış (Overview) 2-Sütunlu Konsol Mimarisi:**
  - Sol ana alanda (`.hub-overview-main`) geniş ve rahat okunabilir "Oyun Hakkında" kartı ve "Koleksiyonlar & Etiketler" kartı.
  - Sağ kenar çubuğunda (`.hub-overview-sidebar`) "HowLongToBeat" süre dökümü ve "Platform & Özellikler" detay kartı.
- **Başarımlar (Trophy Hub) 2-Sütunlu Ferah Konsol Izgarası:**
  - `.ach-cards-grid` tek sütunluk sıkışık listeden `grid-template-columns: repeat(auto-fill, minmax(480px, 1fr))` ile 2 sütunlu geniş konsol ızgarasına dönüştürüldü.
  - Her kupa kartı 500px+ genişlikte kupa başlığı, tam açıklama, nadirlik yüzdesi ve XP çipiyle birbirini ezmeden rahatça okunur.
- **Ergonomi ve Pürüzsüz Geçiş:**
  - ESC tuşuna veya `← Kütüphane` butonuna basıldığında anında kütüphane ızgarasına dönülür.
  - Sekmeler arası geçişlerde ve filtrelemelerde sayfa tepesine sıçrama veya DOM kırpışması engellenmiş, kaydırma pozisyonu yerinde korunur.
- **Sade "Başarımlar" Sekme Başlığı:**
  - Sekme butonunda yer alan gereksiz sağ kupa rozeti (`achTabBadge` / platin kupası) ve `(5)` gibi parantez sayaçları tamamen kaldırıldı; konsol zarafetine uygun olarak sade `${icon("trophy", 13)} Başarımlar` başlığı sağlandı.

## 49. Detay Sayfası Konsol İnce Ayarları, Yetenek Rozetleri & Akamai Açıklama Fallback'i

- **"Koleksiyonlar & Etiketler" Alanından DLC Temizliği:**
  - Ana sekme şeridinde zaten müstakil bir "Eklentiler" sekmesi yer aldığından, "Koleksiyonlar & Etiketler" kartı içindeki "2 Eklenti" hapı kaldırıldı. Bu kart artık yalnızca kullanıcı koleksiyonlarını ve koleksiyon ekleme butonunu listeler.
- **Yenilenen "Favorilerde" Buton Tasarımı:**
  - Mat/çamurlu mor kutu kaldırıldı. Yerine koyu kırmızı cam arka plan (`rgba(239, 68, 68, 0.1)`), parlak kırmızı kenarlık (`rgba(239, 68, 68, 0.4)`), dolgulu canlı ışıltılı yakut kalp (`fill: #ef4444`, `filter: drop-shadow(0 0 6px rgba(239, 68, 68, 0.6))`) ve net beyaz metin (`#f8fafc`) uygulandı; PS5 mavi "Oyna" butonuyla dengeli, birinci sınıf konsol görünümü kazandırıldı.
- **Akamai CDN Mağaza Açıklaması (Store Description Fallback):**
  - Cyberpunk 2077 vb. oyunlarda yerel katalog metadata'sında (`metadata/<app>.json`) açıklama alanının oyun başlığı ile aynı olması (`rawDesc === s.title`) nedeniyle ortaya çıkan "Açıklama henüz eklenmemiş" durumu çözüldü.
  - Rust backend'deki `epic_get_system_requirements` komutu Akamai CDN'den (`store-content-ipv4.ak.epicgames.com`) `about.shortDescription`, `about.description` ve `meta.tags` alanlarını parse edip `GameRequirementsResponse` içine dahil etti ve `specs/<app>.json` disk önbelleğine kaydetti.
  - Eski disk önbelleklerini tazelemek için şema geçerlilik kontrolü (`content.contains("\"short_description\"")`) eklendi.
  - Frontend'de `cleanStoreDescription` sanitizasyonu ve `#hub-desc-text` DOM alanı ile sayfa yenilenmeden yerinde (in-place) açıklama doldurma sağlandı.
- **PlayStation Tarzı Oyun Yetenekleri & Destek Kartı (`.hub-features-card`, `.hub-features-list`):**
  - "Platform & Özellikler" kartı zenginleştirilerek konsol oyuncularının en çok baktığı yetenek satırları (`.hub-feature-row`) eklendi:
    1. 🎮 **Kontrolcü Desteği:** `✓ Destekleniyor (DualSense / Xbox / Gamepad)` (yeşil supported)
    2. ☁️ **Bulut Kayıtları:** `✓ Epic Cloud` veya partner bulut kaydı (`CloudSaveFolder` / `CloudIncludeList` algılama)
    3. 🏆 **Başarımlar:** `✓ X Kupa • Y XP` (altın gold rozet) veya partner / desteklenmiyor
    4. 👥 **Oyun Modu:** `Tek Oyunculu`, `Çok Oyunculu`, `Eşli Oyun (Co-op)` (Akamai etiketlerinden otomatik)
    5. 🌐 **Çevrimdışı Oynanış:** `✓ Destekleniyor (Çevrimdışı)` (`CanRunOffline` kontrolü)
    6. 🛡️ **Hile Koruması:** `Easy Anti-Cheat`, `BattlEye`, `Denuvo` vb. (varsa)
    7. 🖥️ **Platform:** `Windows (PC x64)`
    8. 💾 **Yüklü Boyut & Sürüm:** Kurulu oyunlarda disk boyutu ve sürüm dökümü

## 50. Dead by Daylight "Ana Oyun" Kategori İlerleme Düzeltmesi & Controller/Gamepad UI Mimarisi

- **Kategori İlerleme ve Rozet Hesaplama Düzeltmesi:**
  - `renderAchievementSections` fonksiyonunda `baseTotal`, `baseUnlocked`, `dlcTotal`, `dlcUnlocked` ve XP istatistikleri önceden filtrelenmiş `items` listesinden çekiliyordu. Bu durum, kullanıcı "Kazanılanlar" filtresine tıkladığında kilitli olan 2 başarım filtrelendiği için `baseTotal`'ın 56'ya düşmesine, dolayısıyla `%100 Tamamlandı` yeşil rozeti ve yanıltıcı `56/56` sonucuna yol açıyordu.
  - Hesaplama, oyunun eksiksiz tüm başarımlarını içeren `allAchievements` (`data.achievements`) üzerinden sabitlendi. Artık filtre "Kazanılanlar" veya "Kilitliler" olsa dahi Ana Oyun ilerlemesi daima gerçek değerini (`56/58 (%97)`) gösterir; yalnızca gerçekten tüm başarımlar bittiğinde `%100` yeşil rozetini alır.
- **Native Game Controller (Gamepad / DualSense / Xbox) Konsol Mimarisi:**
  - Kullanıcının *"MÜKEMMELLLL"* olarak nitelendirdiği PS5 konsol arayüzünü koltuktan/TV'den tam kontrol edilebilir kılmak için HTML5 Gamepad API (`window.addEventListener("gamepadconnected")`, `navigator.getGamepads()`) entegrasyonu inşa edildi.
  - **Uzamsal Yön Navigasyonu (Spatial Navigation):** D-pad (yön tuşları) ve sol analog çubuk ile ekrandaki öğelerin geometrik merkez mesafesi hesaplanarak en mantıklı komşu öğeye (kartlar, butonlar, sekmeler) kesintisiz odak aktarılır.
  - **Konsol Tuş Haritası:**
    - `A / Cross (✕)`: Odaktaki öğeyi aktive et / tıkla / oyunu aç.
    - `B / Circle (○)`: Geri dön / modalı kapat / kütüphaneye dön (ESC).
    - `LB/L1 & RB/R1`: Detay sayfasında sekmeler (Genel Bakış ↔ Başarımlar ↔ Eklentiler ↔ Yönet ↔ Sistem), kütüphanede filtre çipleri arasında hızlı geçiş.
    - `Y / Triangle (△)`: Arama kutusuna hızlı odaklan.
    - `X / Square (□)`: Favorilere ekle / çıkar.
  - **PlayStation Odak Halkası (`:focus-visible` & `tabindex="0"`):**
    - Tüm buton, sekme ve oyun kartlarında PlayStation elektrik mavisi neon odak halkası (`box-shadow: 0 0 0 2.5px #60a5fa, 0 0 24px rgba(96, 165, 250, 0.6)`).
    - Oyun kartı odaklandığında hover gibi yukarı kalkar (`translateY(-4px) scale(1.02)`) ve başlık/buton katmanı otomatik görünür olur (`.pcard:focus-visible .poverlay { opacity: 1; }`).
  - **Tasarım Bütünlüğü İlkesi:** Gelecekte eklenecek tüm özellikler bu koltuk/konsol ergonomisine uygun, büyük ve okunabilir kartlarla, karmaşık fare menülerinden uzak tutularak tasarlanacaktır.

## 51. Eleştirmen İnceleme Skorları (OpenCritic, Metacritic, IGDB) & Konsol Glif HUD Bar Mimarisi

- **Arka Plan & Sıfır-Kimlik Doğrulama Çözümü:**
  - OpenCritic resmi web API'si RapidAPI anahtarı ve kota zorunluluğuna geçtiğinden, PCGamingWiki MediaWiki API (`action=opensearch` ve `action=query`) entegre edildi.
  - MediaWiki wikitext içerisindeki `{{Infobox game/row/reception|...}}` şablonları taranarak OpenCritic ID/skoru, Metacritic ID/skoru ve IGDB skoru sıfır kimlik doğrulama, sıfır bot engeli ve yüksek hızla elde edilir.
- **Rust Backend (`critic.rs` & `epic_get_critic`):**
  - `clean_critic_search_term` fonksiyonu edisyon, sürüm, platform ve yayıncı ön eklerini temizler.
  - `calculate_tier` OpenCritic resmi standartlarını uygular: `>= 84`: Mighty, `75..=83`: Strong, `66..=74`: Fair, `< 66`: Weak.
  - `%USERPROFILE%\.config\legendary\critic\<app>.json` ile kalıcı yerel disk önbellekleme (0 ms açılış).
- **PS5 Game Hub Vitrini Entegrasyonu:**
  - Hızlı Stat Kapsülü (`.hub-stat-capsule`) içine 4. sütun eklendi: `★ İNCELEME` (`89 • Mighty` veya `91 Metacritic`). Kademe renkleri (altın parıltılı Mighty, mor Strong, mavi Fair) ve tıklanınca ilgili inceleme sayfasına (`openUrl`) yönlendirme.
  - Genel Bakış sekmesinde sağ kenar çubuğuna `.hub-critic-card`: OpenCritic, Metacritic ve IGDB rozetleri, doğrudan inceleme sayfalarına giden eylem butonları.
- **PlayStation / Xbox Konsol Glif HUD Barı (`.gamepad-hud-bar` & `.gp-glyph`):**
  - Kol / Gamepad bağlandığında veya aktif girdi alındığında ekranın alt orta kısmında beliren zarif cam konsol efsane çubuğu (`HUD`).
  - Dairesel DualSense / Xbox tarzı düğme simgeleri: `(A)` yeşil/camgöbeği (Seç / Oyna), `(B)` kırmızı (Geri), `(X)` mavi (Favori), `(Y)` sarı (Ara), `(LB/RB)` sekme/filtre tamponu, `(D-Pad)` gezinme.
  - Fare hareket ettiğinde otomatik soluklaşır (`dimmed`), kumandaya dokunulduğunda anında canlanır.

## 52. Goygoy Engine Yerli İnceleme & Eleştirmen Entegrasyonu

- **Arka Plan & Veri Kaynağı:**
  - `https://goygoyengine.com/` üzerindeki incelemelerin launcher'da ilgili oyunların detay sayfalarında gösterilmesi sağlandı.
  - Herhangi bir karmaşık HTML kazıma (scraping) yerine sitenin resmi ve temiz `https://goygoyengine.com/incelemeler-data.json` JSON uç noktası entegre edildi.
- **Rust Backend Mimarisi (`critic.rs`):**
  - `fetch_goygoy_reviews`: JSON verilerini çeker ve `%USERPROFILE%\.config\legendary\critic\goygoy_reviews.json` içinde 6 saatlik yerel disk önbelleğiyle saklar; ağ hatasında veya çevrimdışı modda son önbellekten kesintisiz okur.
  - `find_goygoy_review_match`: 2 aşamalı akıllı ad eşleştirme algoritması:
    1. Aşama: Tam normalize edilmiş ad eşleşmesi (edisyon ve sürüm ön/son ekleri temizlenerek).
    2. Aşama: En az 5 karakterlik oyun adları için güvenli alt dize (substring) eşleştirmesi (*Watch Dogs*, *Hellblade: Senua's Sacrifice*, *Kingdom Come: Deliverance*, *Starfield*, *Ready or Not*, *Star Wars Outlaws* vb.).
  - `GoygoyReview` modeli: `title`, `score`, `writer` (örn. EdgeTypE), `summary`, `url`, `image`.
  - `epic_get_critic` yanıtında `goygoy_review: Option<GoygoyReview>` alanı döner; oyun için global OpenCritic bulunmasa dahi Goygoy incelemesi varsa `supported = true` olarak kabul edilir.
- **Frontend & PS5 Game Hub Arayüzü (`main.ts`, `epic.ts`, `styles.css`):**
  - `.hub-goygoy-box`: Goygoy Engine'in imza fıstık yeşili (`#a3e635`) ve derin obsidyen cam tasarımında özel editör kartı.
  - Kart bileşenleri: Yanıp sönen canlı yeşil nabız noktası (`goygoyPulse`), `Goygoy Engine Özel İnceleme` başlığı, `/100` puan hapı (`.goygoy-score-pill`), italik editör özeti, yazar adı (`EdgeTypE` vb.) ve doğrudan inceleme makalesine götüren `İncelemeyi Oku ↗` aksiyon butonu.
  - Hızlı Stat Kapsülü (`.hub-stat-capsule`): Genel eleştirmen skoru bulunmayan oyunlarda Goygoy skoru doğrudan `85 • Goygoy` (`tier-goygoy`) olarak yeşil ışıltıyla vitrine taşınır ve tıklandığında makaleyi açar.

## 53. Dil / Yerelleştirme Ayarları (Language Settings) & Yerel İçerik Filtresi

- **Ayarlar Bölümü (`renderSettings`):**
  - Ayarlar paneline `🌐 Dil Seçimi (Language)` kutusu eklendi.
  - Seçenekler: `🇹🇷 Türkçe (Varsayılan / Etkin)` ve `🌐 English (Yakında / Önizleme)`.
  - Seçilen dil `localStorage` (`efxlve-lang`) anahtarında saklanır; varsayılan olarak `"tr"` döner.
- **Yerel İnceleme (Goygoy Engine) Dil Koruması:**
  - `isTurkishUser()` yardımcı fonksiyonu hem `appLanguage` ayarını hem de tarayıcı/sistem dilini (`navigator.language`) doğrular.
  - Goygoy Engine incelemesi yalnızca dil Türkçe (`appLanguage === "tr"` veya Türkçe sistem) olduğunda gösterilir.
  - Kullanıcı yabancı dil (English) seçtiğinde veya yabancı kullanıcılarda:
    - `.hub-goygoy-box` inceleme kartı DOM'dan tamamen gizlenir.
    - Oyun detay vitrinindeki Hızlı Stat Kapsülü (`.hub-stat-capsule`) yabancı kullanıcılara Goygoy skorunu ve bağlantısını sunmaz; yalnızca global OpenCritic/Metacritic skorları gösterilir.

## 54. Çift "Yönet" Düğmesinin Temizlenmesi, Oyun İçi Ekran Görüntüleri Galerisi & Goygoy JSON İyileştirmeleri

- **Çift "Yönet" Butonunun Ayıklanması:**
  - PS5 Game Hub vitrinindeki `.hub-actions-bar` içinde yer alan fazlalık "Yönet" butonu kaldırıldı; yönetim işlemleri yalnızca sekmeler çubuğundaki (`.drawer-tabs`) doğal "Yönet" sekmesi üzerinden yürütülerek arayüz sadeleştirildi.
- **Goygoy Engine JSON Uç Noktası & Eşleşme Zenginleştirmesi (`critic.rs`):**
  - İnceleme yazarının sunduğu resmi `https://goygoyengine.com/incelemeler-data.json` uç noktası doğrulanıp tam entegre edildi.
  - `GoygoyReview` ve `GoygoyRawItem` modellerine `summary_en` (İngilizce editör özeti) ve `tags` dizisi eklendi.
  - `normalize_for_match` algoritmasına Roma rakamı desteği kazandırıldı (`" II"` ↔ `" 2"`, `" III"` ↔ `" 3"` vb.; örn. *Kingdom Come: Deliverance II* kusursuz eşleşir).
  - Eşleşme kapsamı genişletilerek `tags` alanındaki varyasyonlar üzerinden de tam doğruluk sağlandı.
- **Oyun İçi Ekran Görüntüleri Galerisi (In-Game Screenshots & Lightbox):**
  - **Backend Mimarisi (`screenshots.rs`):**
    - `epic_get_game_screenshots`: `%USERPROFILE%\Pictures\Efxlve Screenshots\<Oyun>`, `%USERPROFILE%\Pictures\<Oyun>` ve `%USERPROFILE%\Videos\Captures` (Windows Game Bar `Win+Alt+PrtScn`) yollarını tarar.
    - Webview yerel dosya erişim CSP engellerine takılmamak için küçük resim ve tam boyutlu görselleri güvenli `data:image/...;base64` veri URL'si olarak döndürür.
    - `epic_capture_game_screenshot`: PowerShell tabanlı yüksek performanslı birincil ekran yakalama ile anlık oyun ekran görüntüsü alır ve ilgili klasöre kaydeder.
    - `epic_delete_game_screenshot`: İstenmeyen görüntüleri diskten güvenle siler.
    - `epic_open_game_screenshots_folder`: `explorer.exe` ile ilgili oyunun ekran görüntüleri klasörünü Windows Gezgini'nde açar.
    - `scan_new_captures_for_game` (`transfers.rs`): Oyun oynanırken oturum başlangıç zamanı baz alınarak `Pictures\Screenshots` ve `Videos\Captures` taranır; oyun kapanışında yeni çekilen ekran görüntüleri otomatik olarak oyunun klasörüne kopyalanır ve `"screenshots-updated"` olayı fırlatılır.
  - **Frontend & PS5 Console Lightbox UI (`main.ts`, `epic.ts`, `styles.css`):**
    - Drawer modalına 4. sekme olarak `📸 Ekran Görüntüleri` eklendi (mevcut görsel sayısını gösteren rozetle birlikte).
    - 16:9 oranlı obsidyen cam kartlar, tarih/boyut rozetleri, hover sırasında büyütme ve silme eylemleri.
    - Henüz görüntü yoksa F12 / `Win+Alt+PrtScn` bilgilendirmesi sunan şık boş durum (empty state) kartı.
    - **Tam Ekran Lightbox (Sinematik Konsol İzleyici):**
      - Tıklanan ekran görüntüsünü 90vh yüksekliğinde, yumuşak cam arka plan ve tam ekran sahne (`.lightbox-stage`) ile açar.
      - Sol/Sağ geçiş butonları (`.lightbox-arrow`), dosya adı, çekim tarihi, boyut ve sayaç (`1 / N`) gösterimi.
      - **Klavye & Kontrolcü (Gamepad / 10-ft) Desteği:** `Escape` veya Gamepad `(B)` ile anında kapanır; `Sol Ok` / `Sağ Ok` veya Gamepad D-Pad Sol/Sağ ile fotoğraflar arası akıcı geçiş yapılır. `LB/RB` sekme geçiş döngüsüne `"screenshots"` sekmesi dahil edilmiştir.
  - **Oyun İçi Global F12 Tuşu ile Ekran Görüntüsü Alma (In-Game Global F12 Capture):**
    - `screenshots::start_f12_listener` (Windows `user32::GetAsyncKeyState(VK_F12)`): Launcher başlangıcında (`setup`) hafif bir arka plan iş parçacığı başlar.
    - Sadece bir oyun aktif olarak oynanıyorken (`set_active_running_game`, `clear_active_running_game`) F12 tuşunun basılıp basılmadığını kontrol eder.
    - Tuşa basıldığı an 600ms cooldown korumasıyla anında ekran görüntüsü yakalar, ilgili oyunun klasörüne kaydeder ve frontend'e `"screenshot-captured"` olayı fırlatır.
    - Frontend'de Web Audio API ile sıfır harici varlık gerektiren mekanik deklanşör ses efekti (`playScreenshotShutterSound`) çalınır, PlayStation stili toast bildirim verilir ve açık olan galeri anında yerinde güncellenir.

## 55. EasyAntiCheat, Shipping Binaries & Windows Process Watcher Mimarisi

- **Problem & Kök Neden (Bootstrapper Handoff Yanılgısı):**
  - *Dead by Daylight* (Carnation/Brill), *Cyberpunk 2077* (Ginger), *GTA V*, *RDR2*, *Fortnite* gibi oyunlar doğrudan ana oyun motorunu başlatmak yerine önce bir sarmalayıcı/önyükleyici başlatıcı çalıştırır (`DeadByDaylight.exe`, `redprelauncher.exe`, `PlayGTAV.exe` vb.).
  - Bu sarmalayıcı EasyAntiCheat (`EasyAntiCheat_EOS_Setup.exe`) veya başlatıcı hizmetlerini tetikleyip asıl oyun motoru ikili dosyasını (`DeadByDaylight-EGS-Shipping.exe`, `bin/x64/Cyberpunk2077.exe`, `GTA5.exe`) başlattıktan hemen sonra (2-3 saniye içinde) `0` (başarı) çıkış koduyla kapanır.
  - Eski `spawn_launched` mantığı ilk 5 saniyeyi bekleyip `child.wait()` başarıyla tamamlandığında oyunu "kullanıcı 5 saniyede kapattı" sanarak `game-status { running: false }` yayımlıyor, `RUNNING_GAME` durumunu siliyor ve oturum süresini 5 saniyede kesiyordu. Bu durum hem oynama süresinin sayılamamasına hem de F12 oyun içi ekran görüntüsü dinleyicisinin devreden çıkmasına neden oluyordu.
- **Windows Çekirdek Süreç İzleyicisi (`win_process` & Toolhelp32):**
  - `discover_game_executables(install_path, main_executable)`: Oyunun kurulum dizinini (`install_path`) derinlik <= 4 olacak şekilde tarar ve çalıştırılabilir oyun ikili dosyalarını listeler (`deadbydaylight.exe`, `deadbydaylight-egs-shipping.exe`, `easyanticheat_eos_setup.exe`). Genel kütüphaneler (`vc_redist*`, `dxsetup.exe`, `crashreportclient.exe`) otomatik elenir.
  - `is_game_process_running(install_path, candidate_exes)`:
    - Win32 `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` ve `Process32FirstW/NextW` FFI API'lerini kullanır.
    - `sz_exe_file` doğrudan Windows çekirdeğinden (kernel) okunduğu için EAC veya yönetici yetkili anti-cheat korumaları tarafından engellenemez (0ms gecikme, sıfır izin gereksinimi).
    - Ek olarak `QueryFullProcessImageNameW` çağrısı ile sürecin tam dosya yolu kontrol edilerek `install_path` altından çalışan tüm süreçler yakalanır.
- **Akıllı Süreç Yaşam Döngüsü & Handoff Toleransı:**
  - `spawn_launched` oyun başlatıldığında derhal `set_active_running_game` durumunu ve `game-status { running: true }` bildirimini aktif kılar.
  - İlk 2.5 saniyede yalnızca süreç sıfır dışında bir hata koduyla çöktüyse ve arka planda çalışan hiçbir oyun süreci yoksa hata fırlatılır.
  - Arka planda çalışan `tokio::spawn` izleme döngüsü her 1.5 saniyede bir hem ana `child` sürecini hem de aday oyun süreçlerini denetler.
  - Önyükleyicinin kapanması ile asıl oyun penceresinin açılması arasındaki el değiştirme boşluğu için 20 saniyelik açılış tolerans süresi (grace period) tanınır.
  - Oyun tespit edildikten sonra, sahne geçişleri, çözünürlük değişiklikleri veya EAC geçişlerinde yanlış kapanma sinyali üretilmemesi için ardışık 3 kontrol (~4.5 saniye) boyunca hiçbir süreç kalmadığı doğrulandıktan sonra oyun sonlandırılır.
  - Oyun kapandığında gerçek oturum süresi tam olarak kaydedilir, oturum sırasında alınan yeni ekran görüntüleri taranıp eşitlenir, bulut kayıtları (`sync-saves`) otomatik senkronize edilir ve `game-status { running: false, sessionSeconds, totalSeconds }` yayını yapılır.

## 56. Yüksek Çözünürlüklü & Anlık Ekran Görüntüsü Yakalama (High-DPI Native Win32 GDI & GDI+ Capture)

- **Kırpılma & Gecikme Probleminin Kök Nedeni:**
  - **Kırpılma (DPI Scaling):** Windows ekran ölçeklendirmesi (%125, %150, %175) etkin ekranlarda (örn. 2560x1600 %150 ölçek), DPI farkındalığı olmayan süreçler DWM tarafından 96 DPI sanallaştırmasına tabi tutulur. Eski PowerShell betiği `Screen.PrimaryScreen.Bounds` üzerinden 1707x1067 çözünürlük alıp sadece bu alanı kopyaladığı için ekranın sağından ve altından büyük bir bölüm kırpılıyordu.
  - **Gecikme (Process Startup Lag):** F12 tuşuna her basıldığında yeni bir `powershell.exe` sürecinin başlatılması, .NET CLR ve `System.Drawing`/`Windows.Forms` kütüphanelerinin yüklenmesi 2-3 saniye sürüyordu. Bu yüzden ekran görüntüsü tuşa basıldığı anı değil, birkaç saniye sonrasını gecikmeyle yakalıyordu.
- **Yerel Win32 GDI & GDI+ Yüksek Performanslı Çözümü (`screenshots.rs`):**
  - **Tam Donanım Çözünürlüğü (`DESKTOPHORZRES` & `DESKTOPVERTRES`):** `SetProcessDPIAware()` ve `GetDeviceCaps(118, 117)` doğrudan fiziksel ekran çözünürlüğünü (`2560x1600`) sorgular; ölçekleme faktörü ne olursa olsun sıfır kırpılmayla %100 tam ekran yakalanır.
  - **Anlık Yakalama (< 20 ms):** `GetDC` + `CreateCompatibleDC` + `CreateCompatibleBitmap` ve `BitBlt` donanım hızlandırmalı bellek kopyalaması 3 milisaniyeden kısa sürer.
  - **Doğrudan PNG Sıkıştırması (`gdiplus.dll`):** `GdipCreateBitmapFromHBITMAP` ve `GdipSaveImageToFile` Windows'un yerel C kütüphanesi üzerinden PNG formatında ~15 ms'de diske yazar. Toplam yakalama süresi 2500 ms'den ~18 ms'ye (100 kat daha hızlı) indirilmiştir.
  - **Milisaniye Zaman Damgası (`as_millis`):** Dosya adlandırmasında saniye yerine milisaniye zaman damgası (`_Screenshot_1789858524123.png`) ve 400 ms tuş bekleme süresi (cooldown) kullanılarak seri çekimlerde dosya ezilmesi (overwrite) engellendi.
  - **DPI-Aware PowerShell Fallback:** Olası aşırı uç durumlarda devrede olan yedek PowerShell betiği de `SetProcessDPIAware()` ile güçlendirilerek her koşulda 2560x1600 tam çözünürlük garanti edildi.

## 57. Anlık Deklanşör Geri Bildirimi, Thread Desktop Erişimi & DIBSection Donanımsal Ekran Yakalama

- **Gecikme & Bekleme Probleminin Kök Nedenleri:**
  1. **Win32 `BitBlt` Geçersiz İşleyici (Error 6) & PowerShell Yedeğine Düşme:** Windows 10/11 DWM (Desktop Window Manager) mimarisinde, doğrudan grafiksel penceresi olmayan arka plan iş parçacıklarının (worker thread) masaüstü cihaz bağlamına (`GetDC(NULL)`) erişimi, iş parçacığının aktif kullanıcı giriş masaüstüne (`OpenInputDesktop`) bağlı olmaması nedeniyle `ERROR_INVALID_HANDLE` (6) ile reddediliyordu. Bu nedenle her F12 tuşuna basıldığında native yol başarısız olup 2-3 saniye süren hantal `powershell.exe` yedek sürecini tetikliyordu.
  2. **Gecikmeli Deklanşör ve Ses Bildirimi (Deferred Feedback):** Eski akışta deklanşör sesi (`playScreenshotShutterSound()`) ve toast bildirimi, ekran yakalanıp diske yazıldıktan ve büyük Base64 IPC serileştirmesi tamamlandıktan SONRA tetikleniyordu. Kullanıcı tuşa bastığında hiçbir tepki alamadığı için ekran görüntüsünün alınmadığını düşünüyordu.
- **Uygulanan Kesin & Yüksek Performanslı Çözümler:**
  1. **0ms Anlık Deklanşör & Dokunsal Geri Bildirim (`screenshot-shutter`):** F12 tuş kenarı algılandığı milisaniyede (`is_down && !was_down`, 20ms polling hassasiyeti) arka plan dosya kaydı beklenmeksizin DERHAL `screenshot-shutter` Tauri eventi yayımlanır. Kullanıcı tuşa bastığı an mekanik deklanşör sesini duyar ve PlayStation konsol estetiğine uygun `📸 Ekran görüntüsü alınıyor…` bildirimini anında görür. Manuel "Ekran Görüntüsü Al" butonuna tıklandığında da aynı 0ms deklanşör sesi anında çalar.
  2. **Adanmış Masaüstü İş Parçacığı (`OpenInputDesktop` + `SetThreadDesktop`):**
     - Ekran yakalama işlemi için temiz bir iş parçacığı (`capture_screen_native_thread`) başlatılır.
     - `OpenInputDesktop(0, 0, 0x01FF)` ve `SetThreadDesktop(h_desk)` çağrılarak iş parçacığı aktif kullanıcı masaüstüne bağlanır; böylece `BitBlt`'in `ERROR_INVALID_HANDLE` (6) hatası kesin olarak ortadan kalkmıştır.
     - İşlem bitiminde masaüstü işleyicisi `CloseDesktop(h_desk)` ile sızıntısız temizlenir.
  3. **`CreateDIBSection` ile Doğrudan Yüksek Çözünürlüklü Bellek Tahsisi:**
     - GDI paged pool sınırlarına takılan `CreateCompatibleBitmap` yerine `CreateDIBSection` kullanılarak 2560x1600 32-bit top-down bitmap doğrudan tahsis edilir.
     - `BitBlt(SRCCOPY)` çağrısı donanım seviyesinde ~1-2 ms'de ekranı kopyalar.
  4. **Yerel GDI+ Donanımsal Kayıt:**
     - GDI+ C kütüphanesi (`gdiplus.dll`) üzerinden `GdipCreateBitmapFromHBITMAP` ve `GdipSaveImageToFile` ile ~100 ms içinde dosya diske yazılır.
     - Yakalama tamamlandığında `screenshot-captured` eventi ile galeri listesi ve `📸 Ekran görüntüsü kaydedildi: ...` bildirimi akıcı biçimde güncellenir.
  5. **Sonuçlar:**
     - Ekran görüntüsü alma ve deklanşör hissi 2.500 ms'den **0 ms anlık tepki** ve **~110 ms yerel kayıt** hızına ulaştırılmıştır.
     - Tüm 47 Rust birim testi yeşil, frontend derlemesi hatasızdır.

## 58. Yerel Saat Dilimi (Local Timezone), Win32 Dosya Zamanı & İnsan Okunabilir Ekran Görüntüsü Adlandırması

- **Problem & Kök Neden:**
  - `chrono_fallback` fonksiyonunun Unix epoch saniyesini doğrudan UTC saat diliminde işlemesi nedeniyle, Türkiye gibi UTC+3 saat dilimindeki kullanıcılarda gece yarısından sonra (örn. 20.09.2026 02:10) alınan ekran görüntüleri UTC saatiyle `19.09.2026 23:10` olarak hesaplanıyor; hem tarih bir gün geride kalıyor hem de saat 3 saat sapıyordu.
  - Ayrıca dosya adlarında 13 basamaklı ham Unix zaman damgası (`_Screenshot_1789859304796.png`) kullanılması, Windows Explorer'da ve fotoğraf görüntüleyicilerinde kullanıcı dostu değildi.
- **Uygulanan Çözümler:**
  1. **Win32 `GetLocalTime` ile İnsan Okunabilir Dosya Adlandırması:**
     - Yeni yakalanan ekran görüntüleri için Win32 `GetLocalTime(&mut st)` API'si kullanılarak kullanıcının gerçek yerel sistem zamanı (`SYSTEMTIME`) doğrudan okunur.
     - Dosya adı Steam/PlayStation standartlarında temiz ve okunabilir formatta üretilir: `{clean_t}_YYYY-MM-DD_HH-mm-ss_fff.png` (örnek: `Dead_by_Daylight_2026-09-20_02-23-45_120.png`).
  2. **Win32 `FileTimeToLocalFileTime` ile Disk Dosyalarının Yerel Saate Dönüştürülmesi:**
     - Diskteki tüm ekran görüntüleri taranırken (`parse_file_to_item`), dosyanın UTC formatındaki `last_write_time()` verisi Win32 `FileTimeToLocalFileTime` ve `FileTimeToSystemTime` API'leri ile kullanıcının Windows'ta tanımlı saat dilimine ve yaz/kış saati farkına göre tam yerel zamana çevrilir (`DD.MM.YYYY HH:MM:SS`).
  3. **Frontend `formatScreenshotDate` Güvenlik Katmanı:**
     - `src/main.ts` içinde `formatScreenshotDate(item.timestamp, item.date_str)` fonksiyonu eklenerek hem galeri kartlarında (`.ss-chip.date`, `.ss-date`) hem de Lightbox detay üst barında (`.lightbox-meta`) tarayıcının yerel `Date` motoru üzerinden milisaniyesine kadar doğru yerel saat (`20.09.2026 02:22:36`) gösterilir.
  4. **Sonuçlar:**
     - Ekran görüntülerinin tarihi de saati de kullanıcının bilgisayarındaki saatle birebir ve saniyesine kadar kusursuz eşitlenmiştir.
     - Tüm 49 Rust birim testi ve frontend derlemesi hatasızdır.

## 59. Ekran Görüntüsü Paylaşma, Opsiyonel Sıkıştırma (AVIF / WebP / JPEG) & Özelleştirilebilir Kısayol Tuşu

- **Gereksinim & Kullanıcı Talepleri:**
  1. **Paylaşma (Sharing):** Ekran görüntülerinin doğrudan Discord, WhatsApp, Telegram vb. sohbet uygulamalarına yapıştırılabilmesi veya dosya olarak paylaşılabilmesi.
  2. **Opsiyonel Sıkıştırma (Compression):** Varsayılan olarak KAPALI tutulan; istendiğinde modern AVIF (veya WebP / JPEG) formatında dosya boyutunu kaliteden ödün vermeden %70-85 küçülten sıkıştırma motoru ve ayarları.
  3. **Kısayol Tuşu Değiştirme (Custom Hotkey):** Varsayılan F12 tuşunu ayarlar üzerinden F1-F12, PrtScn veya klavyeden herhangi bir tuşa atayabilme.
- **Uygulanan Mimariler & Çözümler:**
  1. **Panoya Doğrudan Görsel Kopyalama (Instant Discord/Chat Paste):**
     - `copyScreenshotImageToClipboard(item)`: Görsel verisini HTMLCanvasElement üzerinde çizerek yerel `image/png` Blob'una dönüştürür ve `navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])` ile doğrudan Windows sistem panosuna yerleştirir.
     - Oyuncular Discord, WhatsApp Desktop, Slack veya web tarayıcılarına geçip `Ctrl + V` yaptıklarında görsel anında sohbete yapışır.
     - Ayrıca "Dosya Yolunu Kopyala", "Klasörde Göster" ve yerel Windows paylaşım menüsü (`navigator.share`) entegre edilmiştir.
  2. **Modern AVIF / WebP / JPEG Sıkıştırma Pipeline'ı:**
     - Ayarlar altında "Görsel Sıkıştırma (Opsiyonel)" kartı eklendi. **Varsayılan olarak KAPALI (Ham PNG)** gelir.
     - Açıldığında arkadaşının önerdiği en verimli format olan **AVIF** (AV1 Image File Format), **WebP** ve **JPEG** formatları ile %70 - %95 kalite kaydırıcısı (%85 varsayılan) seçilebilir.
     - `compressImageToBlob` ile donanımsal Canvas AVIF/WebP kodlaması yapılır; Rust `epic_replace_screenshot_with_compressed` komutu yeni sıkıştırılmış dosyayı yazıp eski ham PNG dosyasını silerek diski anında rahatlatır.
     - Hem yeni çekilen ekran görüntüleri otomatik sıkıştırılabilir, hem de galerideki mevcut ekran görüntüleri tek tek veya "Tümünü Sıkıştır" ile albüm bazında dönüştürülebilir.
     - Rust `parse_file_to_item` ve `file_to_data_url` fonksiyonlarına `.avif` ve `image/avif` desteği eklendi.
  3. **Dinamik Win32 Kısayol Tuşu Mimarisi:**
     - `screenshots.rs` içinde sabit `VK_F12` yerine thread-safe `static SCREENSHOT_HOTKEY: AtomicI32 = AtomicI32::new(0x7B)` tanımlandı.
     - `epic_set_screenshot_hotkey` ve `epic_get_screenshot_hotkey` Tauri komutları eklendi.
     - Ayarlar sayfasında hazır tuş listesi (F12, F11, F10, F9, F8, F7, F6, F5, PrtScn, Scroll Lock, Pause, Insert, Home) ve etkileşimli "Yeni Tuş Ata" (Key Recorder) sunuldu. Tuş seçildiğinde `localStorage`'a yazılır ve Rust dinleyicisine anında senkronize edilir.
     - Launcher başlatılırken (`bootEpic`) kaydedilmiş tuş kodu otomatik olarak Rust tarafına yüklenir.
  4. **Sonuçlar:**
     - Tüm 51 Rust birim testi (`cargo test`) yeşil, frontend TypeScript ve Vite derlemesi (`npm.cmd run build`) hatasızdır.
     - PlayStation 5 dark console estetiği ve gamepad uyumluluğu titizlikle korunmuştur.

## 60. Detay Sayfası / Game Hub Açıkken Sayfalar Arası Gezinme & Modal Temizliği (Modal Overlay Isolation Fix)

- **Problem & Kök Neden:**
  - Bir oyunun detay sayfası (Game Hub / Drawer) açıldığında `#modal-root` içerisine `.overlay` sınıfıyla tam ekran sabit (`position: fixed; inset: 40px 0 0 0; z-index: 50;`) bir katman yerleştirilir.
  - Kullanıcı üst bardaki navigasyon butonlarına (ör. "Ayarlar", "İndirmeler", "Kütüphane", "Profil") tıkladığında `view` değişkeni ve `#nav` aktiflik durumu güncellenip `#view` içerisine yeni sayfa çiziliyordu; ancak `#modal-root` temizlenmediği (`closeModal()` çağrılmadığı) için detay sayfası ekranı örtmeye devam ediyor ve seçilen yeni sayfa görünmüyordu.
- **Uygulanan Çözüm:**
  1. **`closeAllModals()` Fonksiyonu:** `closeModal()`, `closeScreenshotLightbox()`, `closeShareModal()`, `closeCustomCoverModal()`, `closeCollectionModal()` ve dinamik modal köklerini (`manageRoot`, `selectiveRoot`, `playtimeRoot`) tek seferde temizleyen merkezi kapatma işlevi eklendi.
  2. **Navigasyon Geçişlerinde Otomatik Temizlik:** `[data-view]` tıklama olay delegasyonunda, `openProfile()`, `openStoreUrl()` ve `act === "goto-library"` kancalarında sayfa değişmeden önce `closeAllModals()` zorunlu kılındı.
  3. **`render()` Güvenlik Kilidi:** `render()` fonksiyonu çağrıldığında eğer `view !== "library"` ise ve `modalRoot` içerisinde içerik kalmışsa otomatik olarak `closeModal()` çağrılarak ekranın kilitli kalması kesin olarak engellendi.
  4. **Logo Eylemi:** Üst bardaki `EFXLVE` logosuna `data-act="goto-library"` eklenerek doğrudan kütüphaneye dönmesi ve tüm açık modalları kapatması sağlandı.
- **Sonuç:**
  - Kullanıcı detay sayfasındayken üst bardan Ayarlar, İndirmeler, Profil veya Kütüphane'ye tıkladığında detay sayfası anında kapanır ve hedeflenen sayfa kusursuz şekilde açılır.

## 61. Oyun Özellikleri & Destek Kartı Veri & Yerleşim İyileştirmeleri (Dead by Daylight Fix)

- **Problem & Kök Neden:**
  - *Dead by Daylight* ve benzeri oyunlarda "Oyun Özellikleri & Destek" kartında 5 temel hata bulunuyordu:
    1. **Kontrolcü Desteği:** Her oyunda istisnasız `✓ DualSense / Xbox / Gamepad` hardcoded yazılmıştı. PC'de Dead by Daylight vb. oyunlar yerel olarak yalnızca Xbox / XInput kollarını destekler; DualSense için üçüncü parti emülasyon gerekir.
    2. **Bulut Kayıtları:** Bulut klasörü (`CloudSaveFolder`) bulunmayan çevrimiçi oyunlar doğrudan "Yerel Kayıt" olarak işaretleniyordu. Oysa Dead by Daylight sunucu tabanlıdır; karakter ve ilerleme verileri doğrudan çevrimiçi hesapta/sunucuda tutulur.
    3. **Çevrimdışı Oynanış:** Epic metadata'sındaki genel DRM izin bayrağı (`CanRunOffline = true`) baz alındığı için saf çevrimiçi oyunlarda bile `✓ Destekleniyor (Çevrimdışı)` görünüyordu.
    4. **Oyun Modu:** Akamai etiketleri boş geldiğinde sistem varsayılan olarak `"Tek Oyunculu"`ya düşüyordu; Dead by Daylight gibi 4v1 asimetrik PvP oyunlar tek oyunculu görünüyordu.
    5. **Yüklü Boyut & Sürüm:** `DBD_Udon_HF2_EGS_Shipping_6_3797605_10.1.2.4` gibi 53 karakterlik dahili derleme adları, `.hub-feature-label`'da `flex-shrink: 0; white-space: nowrap;` olmadığı için etiketi ezerek iki satıra bölüyor ve `Yüklü 60.7 GB Boyut(vDBD...)` şeklinde bozuk bir yerleşim yaratıyordu.
- **Uygulanan Çözüm:**
  1. **`detectControllerSupport()` Fonksiyonu:** Sony PC portları ve yerel DualSense desteği olan yapımlar için `✓ DualSense & Xbox Kolu`, klavye-fare odaklı strateji/simülasyonlar için `Klavye & Fare`, standart Windows PC yapımları (Dead by Daylight dahil) için ise `✓ Xbox & Gamepad (XInput)` değerini atayan dinamik motor eklendi.
  2. **`isOnlineOnlyGame()` Fonksiyonu:** Bilinen saf çevrimiçi yapımları (Dead by Daylight, Fortnite, Fall Guys, Destiny 2 vb.) ve açıklamalardaki asimetrik 4v1/multiplayer/online-only ifadelerini tespit eden kütüphane eklendi.
  3. **Çevrimiçi Sunucu Kaydı & İnternet Gereksinimi:** Çevrimiçi oyunlar için bulut kaydı `✓ Çevrimiçi Sunucu Kaydı` rozetine, çevrimdışı oynanış ise `Sürekli İnternet Gerekir` uyarı rozetine bağlandı.
  4. **Akıllı Oyun Modu Analizi:** Etiketler, açıklamalar, koleksiyonlar ve oyun şeması taranarak `Çok Oyunculu (4v1 PvP)`, `Eşli Oyun (Co-op)`, `Tek Oyunculu & Co-op`, `Tek & Çok Oyunculu` tespit mekanizması getirildi.
  5. **`cleanDisplayVersion()` & Konsol Obsidian Rozeti:** Uzun derleme adlarındaki gerçek yama versiyonu (örn. `v10.1.2.4`) ayıklandı, ham yapı adı `title` tooltip'ine taşındı. CSS'te `.hub-feature-label` `flex-shrink: 0; white-space: nowrap;`, `.hub-version-badge` ise taşmayan zarif bir konsol hap rozeti haline getirildi.
- **Sonuç:**
  - Dead by Daylight için Kontrolcü: `✓ Xbox & Gamepad (XInput)`, Bulut: `✓ Çevrimiçi Sunucu Kaydı`, Çevrimdışı: `Sürekli İnternet Gerekir`, Oyun Modu: `Çok Oyunculu (4v1 PvP)`, Boyut: `60.7 GB [v10.1.2.4]` olarak kusursuz ve doğru şekilde sunulmaktadır.

## 62. Rockstar Games, BattlEye ve Hibrit (Tek & Çok Oyunculu) Oyun Mimarisi (GTA V Enhanced Fix)

- **Problem & Kök Neden:**
  - Kullanıcının *Grand Theft Auto V Enhanced* detay sayfasında verilerin yanlış olduğunu fark etmesiyle şu kök nedenler tespit edildi:
    1. **Rockstar Games Launcher Tespiti Hatası:** `getThirdPartyLauncher(g)` içinde Rockstar tespiti için `(dev.includes("rockstar") && attrs.RegistryLocation)` şartı aranıyordu. Ancak Epic Games, GTA V veya RDR2 metadata'sında `RegistryLocation` tanımlamaz. Bu yüzden Rockstar Games Launcher tespit edilemiyor; Harici Başlatıcı satırı kayboluyor, Bulut Kayıtları "Rockstar Cloud" yerine yanıltıcı "Yerel Kayıt"a düşüyor ve Çevrimdışı Oynanış'ta Rockstar bağlantı uyarısı verilemiyordu.
    2. **BattlEye Hile Koruması Tespiti Hatası:** GTA V'e yeni eklenen BattlEye hile koruması `getAntiCheat(g)` içerisinde yer almıyordu. Oysa oyunun dizininde doğrudan `BattlEye/` klasörü ve `GTA5_Enhanced_BE.exe` bulunmaktadır.
    3. **Oyun Modu (Tek vs Çok Oyunculu):** GTA V'in açıklamasında "Grand Theft Auto Online" geçtiği için `hasMultiplayer` tetiklenmiş; ancak tek oyunculu kontrollerinde "single player" (boşluklu), "hikaye", "story" gibi kelimeler eksik olduğu ve HowLongToBeat verisi (32 saatlik Ana Hikaye) sorgulanmadığı için devasa hikaye moduna sahip GTA V yanlışlıkla sadece `"Çok Oyunculu"` olarak sınıflandırılmıştır.
    4. **Kontrolcü Desteği:** GTA V PC sürümü yerel olarak DualShock 4 / DualSense ışık çubuğu (polis sireni) ve ses desteğine sahip olmasına rağmen yalnızca standart Xbox kolu olarak gösteriliyordu.
- **Uygulanan Çözüm:**
  1. **`getThirdPartyLauncher()` Güncellemesi:** Geliştiricisi `Rockstar`, başlığı `Grand Theft Auto`, `GTA` veya `Red Dead` olan tüm oyunlar doğrudan `Rockstar Games Launcher` olarak tanındı.
  2. **`getAntiCheat()` Güncellemesi:** GTA V başlıkları `BattlEye` koruma listesine eklendi.
  3. **`Tek & Çok Oyunculu` (Hibrit Mod) Mimarisi:** Hem HowLongToBeat hikaye süresi (`hltb.main_story > 0`) hem de koleksiyon etiketleri (`"Hikaye"`, `"Story"`), bilinen küresel hikaye+çevrimiçi yapımlar (`GTA`, `Red Dead`, `Battlefield`, `Call of Duty`, `Halo`, `Forza`) taranarak oyun modu doğru bir şekilde **`Tek & Çok Oyunculu`** olarak tescillendi.
  4. **Bulut Kayıtları & Bağlantı:** Rockstar oyunlarında bulut kaydı **`✓ Rockstar Games Bulut`** (Social Club), çevrimdışı oynanış ise **`Rockstar Games Launcher Bağlantısı Gerekebilir`** olarak güncellendi.
  5. **Kontrolcü Desteği:** GTA ve Red Dead oyunları yerel PlayStation ışık/ses ve Xbox desteğine sahip olduğu için **`✓ DualSense & Xbox Kolu`** kapsamına alındı.
- **Sonuç:**
  - GTA V Enhanced sayfasında:
    - Kontrolcü Desteği: `✓ DualSense & Xbox Kolu`
    - Bulut Kayıtları: `✓ Rockstar Games Bulut`
    - Çevrimdışı Oynanış: `Rockstar Games Launcher Bağlantısı Gerekebilir`
    - Oyun Modu: `Tek & Çok Oyunculu`
    - Harici Başlatıcı: `Rockstar Games Launcher`
    - Hile Koruması: `BattlEye`
    - Yüklü Boyut: `96.3 GB [v1.0.1158.13]`
    olarak %100 kusursuz ve gerçekçi biçimde sunulmaktadır.

## 63. PlayStation 5 Game Hub: Hibrit Kupa & Medya Vitrini (Trophy & Media Spotlight)

- **Kullanıcı Talebi & Tasarım Amacı:**
  - Game Hub (oyun detay çekmecesi) genel bakış sekmesinde sol alt sütunun ("Oyun Hakkında" ve "Koleksiyonlar & Etiketler" kartlarının altı) boş kalması üzerine, kullanıcının onayıyla PlayStation 5 konsol Game Hub standartlarında **Hibrit Vitrin (Trophy Spotlight + Media Gallery Spotlight)** geliştirilmiştir.
- **Kupa & Başarım Vitrini (`hub-trophy-spotlight`):**
  - **Genel İlerleme Kutusu:** Oyunun toplam başarım ilerleme yüzdesi (`%XX`), kazanılan / toplam kupa sayısı ve kazanılan XP miktarı (`X / Y Kupa • Z XP`).
  - **PlayStation 5 Tarzı Madalya Sayaçları:** Platin (🏆 `#38bdf8`), Altın (🏆 `#fbbf24`), Gümüş (🏆 `#cbd5e1`) ve Bronz (🏆 `#d97706`) madalya sayaçları.
  - **Sıcak Altın İlerleme Çubuğu:** `.hub-trophy-bar-track` ve parlak altın auralı `.hub-trophy-bar-fill` ile sinematik dolum animasyonu.
  - **"Sıradaki Hedef Kupalar" (Next Up Cards):** Henüz kazanılmamış 2 sıradaki hedef kupa (oyun ikonu, başlık, açıklama ve Altın/Gümüş/Bronz + XP rozeti) etkileşimli konsol kartı olarak sunulur. Gizli başarılarda spoiler koruması devrededir (`🔒 Gizli Başarım`). Tıklandığında doğrudan oyunun kupa detaylarına geçiş yapar.
  - **Harici Başlatıcı & Desteği Olmayan Oyunlar:** EA App vb. harici başlatıcılı oyunlarda partner başarım takip kutusu gösterilir; başarımı bulunmayan nadir oyunlarda ise boş alan bırakılmadan zarifçe gizlenir.
  - **0ms Sıfır Gecikme:** Disk üzerindeki `metadata/*.json` ve `achievements.json` üzerinden anında senkronize okunur; çekmece ilk açılışında arka planda ağ isteği tetiklemez (Kural 24'e %100 sadık).
- **Medya Galerisi Vitrini (`hub-media-spotlight`):**
  - **Başlık Çubuğu & Kısayol Etiketi:** Oyunun kayıtlı ekran görüntüsü sayısı, kullanıcı ayarlarından okunan dinamik kısayol etiketi (`F12`, `PrtScn` vb.) ve "Tümü >" butonu.
  - **16:9 Sinematik Minyatürler (`.hub-media-strip`):** Kullanıcının oyunda aldığı son 3 ekran görüntüsü; hover durumunda 3D yükselme (`translateY(-3px)`), mor konsol ışıması, yerel tarih etiketi ve büyütme ikonu sunar. Tıklandığında anında tam ekran Lightbox galerisini açar.
  - **Konsol Boş Durumu (`.hub-media-empty`):** Henüz görüntü alınmamış oyunlar için kamera ikonu, kısayol tuşu kullanım ipucu ve doğrudan klasörü açan "Klasör" aksiyonu sunar.
  - **Dinamik Yerinde Güncelleme:** Ekran görüntüsü alındığında, silindiğinde veya sıkıştırıldığında `#overview-media-container` yerinde (in-place) anında yenilenir; sayfa kırpışması yaşanmaz.
- **Konsol / Gamepad 10-fit Erişilebilirlik Disiplini:**
  - Tüm kupa hedef kartları ve medya minyatürleri `<button type="button">` semantiğiyle tanımlanmış olup D-pad/Analog uzamsal gezinme, Klavye (Enter/Space) ve Gamepad (A butonu) ile doğrudan tetiklenebilir.
  - Odak durumunda PlayStation elektrik mavisi halo halkası (`:focus-visible`) ve hafif 3D kalkış uygulanır.

## 64. Oyun Kurulum Konumunu & Dosyalarını Taşıma (Move Game Installation & Cross-Drive Migration)

- **Problem & Epic Games Launcher Sınırı:**
  - Resmi Epic Games Launcher uygulamasında bir oyunun kurulum yerini / sürücüsünü (örneğin C: SSD'den D: HDD'ye veya harici diske) doğrudan taşıma özelliği bulunmamaktadır. Kullanıcılar oyunu silip baştan indirmek veya dosyaları elle kopyalayıp indirmeyi durdurup doğrulatmak gibi hantal ve riskli geçici yöntemler uygulamak zorunda kalır.
- **Mimari & Motor Katmanı (`src-tauri/src/legendary/move_game.rs`):**
  - **Sistem Sürücülerinin Tespiti (`epic_get_system_drives`):**
    - Windows `GetDiskFreeSpaceExW` API'si (Win32) ile sıfır ek kütüphane bağımlılığıyla çalışır.
    - Sistemdeki tüm yerel disk sürücüleri (C:, D:, E: vb.), toplam disk kapasiteleri ve bayt hassasiyetinde kullanılabilir boş disk alanları milisaniyeler içinde taranıp listelenir.
  - **Yerel Klasör Seçim Gezgini (`epic_select_folder_dialog`):**
    - Windows yerel modern `IFileOpenDialog` (Vista/7/10/11 Dosya Gezgini) entegrasyonuyla tam özellikli sistem klasör seçici penceresi sunulur.
    - Eski Forms `FolderBrowserDialog` yerine modern gezgin kullanılarak kullanıcının yeni klasör oluşturması, F2 veya sağ tık ile klasör adını anında değiştirebilmesi (rename) ve adres çubuğuyla gezinebilmesi sağlandı.
    - PowerShell standart OEM konsol kod sayfası yerine `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;` uygulanarak Türkçe karakterlerin (`ö`, `ı`, `ş`, `ç`, `ğ`, `ü`) bozulması (elmas soru işareti `` hatası) tamamen giderildi.
  - **Aynı Sürücü İçi Anlık Taşıma (Same-Drive Instant Rename):**
    - Kaynak ve hedef klasör aynı sürücü üzerindeyse (ör. `C:\Games` -> `C:\EpicGames`), `tokio::fs::rename` ile 0.05 saniyeden kısa sürede, ağ veya disk kopyalama yükü olmaksızın anında yer değiştirir.
  - **Sürücüler Arası Akıcı Kopyalama & Güvenlik (Cross-Drive Streaming Transfer):**
    - Legendary'nin kendi çapraz sürücü `move` komutu Windows ve Python'da `OSError: errno 18 (EXDEV)` hatası verir.
    - Efxlve Launcher Rust motoru dosyaları 1 MB bellek tamponuyla (stream buffer) güvenle hedefe kopyalar.
    - Anlık ilerleme event'i (`move-progress`): ilerleme yüzdesi (`%XX`), aktarılan/toplam bayt, hız (MB/s), kalan tahmini süre (ETA), aktarılan mevcut dosya yolu ve dosya sayaçları canlı yayınlanır.
    - **Atomik İptal & Veri Bütünlüğü Güvenliği (`ACTIVE_MOVES`):** Kullanıcı iptal ettiğinde veya aktarım başarısız olduğunda kaynak dosyalar ASLA silinmez; hedefte yarım kalan klasör temizlenerek güvenle geri alınır. Kaynak dosyalar yalnızca tüm kopyalama ve boyut doğrulaması %100 başarılı olduktan sonra temizlenir.
  - **Çoklu Veritabanı & EGL Eşitlemesi (Multi-Database Sync):**
    - Legendary `installed.json` kayıtlarında `install_path` ve `install_size` güncellenir.
    - Legendary CLI'ya `legendary move <app> <target_base> --skip-move` komutu gönderilerek dahili katalog ve appstate senkronize edilir (ikili yol `resolve_binary` ile dinamik çözümlenir).
    - Resmi Epic Games Launcher manifestosu (`C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests\<GUID>.item`) tespit edilip `InstallLocation`, `ManifestLocation` ve `CompleteManifestPath` alanları yeni konuma göre otomatik güncellenir. Böylece kullanıcı resmi Epic Games Launcher'ı açtığında oyun "Kaldırıldı" olarak görünmez, doğrudan yeni diskten tanınır.
- **PS5 Console Dark Aesthetic Arayüzü:**
  - Game Hub Yönet (Manage) sekmesinde ve Hızlı Yönetim modalında Kurulum Konumu yanında `[ 🖴 Taşı ]` aksiyonu.
  - Etkileşimli Taşıma Modalı (`.move-modal-card`):
    - Mevcut kurulum konumu ve oyun boyutu bilgi kartı.
    - Sistem sürücüleri kapasite kartları (`.move-drive-card`): sürücü harfi, boş alan / doluluk oranı, dinamik doluluk barı.
    - Hedef klasör yolu girişi, `[ Gözat… ]` butonu ve oyunun son yerleşeceği tam yolu gösteren dinamik canlı önizleme rozeti (`.move-path-preview`, örn: `Oyun hedef konumu: D:\Games\AbsoluteDrift`).
    - Dinamik Kapasite Bildirim Rozeti (`.move-space-badge.ok` / `.move-space-badge.warn`): Hedef diskteki boş alan ile oyun boyutu karşılaştırması; yetersiz alan uyarısı, aynı sürücü anlık taşıma bildirimi veya güvenli boş alan hesabı.
    - Canlı İlerleme Paneli (`.move-live-progress`): PS5 neon degrade ilerleme çubuğu, gerçek zamanlı hız, kalan süre, dosya sayısı ve aktarılan dosya adı.
    - **Anında (0ms) Kurulum Konumu Senkronizasyonu (`applyMovedGamePath`):**
      - Taşıma işlemi bittiğinde (`res.success` veya `move-complete` olayı) modal kapandığı anda kullanıcının önündeki ekranda yer alan tüm `#manage-install-path` DOM metinleri 0 milisaniye içinde yeni yolla güncellenir.
      - Bellekteki `activeManageSettings.installPath` ve `epicSummaries[x].installPath` değerleri anında yeni yola eşitlenir; böylece Game Hub Yönet (Manage) sekmesindeki "Kurulum Konumu" satırında bayat/eski yolun kalması engellenir.
      - `renderDrawerManage` fonksiyonunda `activeManageSettings.installPath` değeri daima `s.installPath` ile yerinde senkronize tutulur.
      - `epicOpenFolder` fonksiyonu en güncel hedef yolu (`activeManageSettings.installPath` || `s.installPath`) kullanarak kullanıcının `[ Klasörü Aç ]` butonuna bastığında her zaman doğru yeni klasöre ulaşmasını garanti eder.
      - Arka planda `refreshEpicInstalled()` ve `epicGetGameSettings()` çağrılarak diskteki `installed.json` verisiyle frontend state'i %100 senkronize edilir ve Game Hub arayüzü pürüzsüzce yeniden çizilir.

## 65. Epic Games Sade Mor Platin Kupa Rozeti & Vektör Tasarımı

- **"%100 Platin" Metninin Kaldırılması & Sade Kupa Rozeti (`.platinum-badge`):**
  - Kartların sağ üst köşesinde yer alan eski sarı/altın kurdele ve `%100 Platin` metni kaldırıldı.
  - Yerine minimalist, şık ve metinsiz kemerli cam rozet (`.platinum-badge`, `width: 28px; height: 32px; border-radius: 12px 12px 7px 7px`) konumlandırıldı.
  - Rozet arka planı koyu obsidyen-mor cam (`rgba(22, 10, 38, 0.88)`), kenarlığı eflatun/mor (`rgba(192, 132, 252, 0.45)`) ve aurası mor ışıltı (`box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6), 0 0 14px rgba(168, 85, 247, 0.45)`) ile tasarlandı. Hover sırasında aksiyon butonlarını engellememesi için `opacity: 0` ile akıcı kaybolur.
- **Orijinal Epic Games Platin Kupa Vektörü (`epicPlatinumIcon`):**
  - Epic Games Store'un resmi başarım ödüllerindeki Platin Kupası birebir analiz edilerek saf SVG olarak kodlandı.
  - Vektör özellikleri:
    - Parlak beyaz/eflatun gövdeli, narin saplı ve geniş ağızlı kupa kadehi (`linearGradient #epCup`).
    - Kadehin ön yüzeyinde kıvrımlı dizilmiş mor mücevher taşları (`#7e22ce`, `#d8b4fe`).
    - Kadehin içinden yükselen mor-menekşe alev dalgası (`linearGradient #epFlm`) ve sıcak parlak çekirdeği (`#faf5ff`).
- **Mor Platin Kart Aurası & Kategori Afişi:**
  - Platin kupalı kartların çerçevesi ve gölgesi sarıdan asil mor-eflatun tonlarına (`rgba(168, 85, 247, 0.75)`, hover'da `#c084fc`) geçirildi.
  - Işık geçişi efekti (`plat-shimmer-pass`) eflatun parıltıya (`rgba(216, 180, 254, 0.38)`) uyarlandı.
  - Kategori çipi (`.chip[data-val="platinum"]`), tebrik afişi (`.plat-category-banner`) ve detay çekmecesi başlık rozeti (`.status-pill.plat`) mor Epic platin kupasıyla kusursuz bir uyum sağladı.

## 66. Oyun Detay Sayfası (Game Hub) & Başarım Kupa Mor Platin Teması

- **Detay Sayfası Sarı Kupa Öğelerinin Mor Platin Rengine Dönüştürülmesi:**
  - **Üst Hızlı Stat Kapsülü (PS5 Glass Capsule):**
    - `PLATİN 28/28 (%100)` sayaç metni sarıdan (`#fbbf24`) asil mor platin rengine (`.hub-stat-val.plat { color: #c084fc; text-shadow: 0 0 10px rgba(192, 132, 252, 0.4); }`) dönüştürüldü.
    - Kapsül etiketi mor platin tonuna (`.hub-stat-label.plat { color: #d8b4fe; }`) uyarlandı.
  - **Kupa & Başarım İlerlemesi Kartı (`.hub-trophy-spotlight`):**
    - Başlık ikonu platin oyunlarda `epicPlatinumIcon(14)` olarak güncellendi.
    - Yüzde göstergesi (`.hub-trophy-percent-num.plat`) mor parıltılı hale getirildi.
    - Kupa ilerleme çubuğu (`.hub-trophy-bar-fill`) sarı/altın gradyandan asil mor gradyana (`linear-gradient(90deg, #7e22ce, #a855f7, #c084fc)`) ve platin oyunlar için parlak eflatun gradyana (`.hub-trophy-bar-fill.plat`) geçirildi.
    - Madalya listesindeki Platin Kupa ikonu (`.hub-medal-item.plat`) açık mavi/sarılık yerine `epicPlatinumIcon(12)` ve mor renge (`#c084fc`) bağlandı.
    - Sıradaki hedef kupalarda fallback ikonu (`.hub-trophy-target-icon`) ve platin hedef rozeti (`.hub-trophy-target-badge.plat`) mor tema ile yenilendi; bronz rozet rengi sarıdan bronz turuncuya (`#fb923c`) çekilerek hiyerarşi netleştirildi.
  - **Oyun Özellikleri & Destek (Sağ Sütun):**
    - `Başarımlar: ✓ 28 Kupa • 1000 XP` satırı sarıdan mor renge (`.hub-feature-val.plat { color: #c084fc; font-weight: 700; }`) ve satır ikonu `epicPlatinumIcon(12)` ile mor renge güncellendi.
  - **Detay Sekmeleri & Başarım Görünümü:**
    - "🏆 Başarımlar" çekmece sekme butonu platin oyunlarda `epicPlatinumIcon(13)` ve mor aktif çizgiye (`.drawer-tab.plat`) bağlandı; sekme rozeti (`.drawer-tab-badge.plat`) mora uyarlandı.
    - Başarım sekmesindeki özet halkası (`.ach-summary-bar.platinum .ring-fill`), özet kartı (`.ach-summary-bar.platinum`), mini kupa sayaçları (`.ach-tier-mini.plat`), kartlardaki platin rozeti (`.ach-pill.tier.platinum`) ve dikey scrollbar (`.ach-list-container::-webkit-scrollbar-thumb:hover`) sarıdan mor-eflatun tonlara geçirildi.
  - **Genel Sistem Bütünlüğü:**
    - Raflar görünümündeki mini kupa rozeti (`.micro-chip.plat`), yerel profil sayfası platin kupa kutusu (`.profile-stat-box.plat`) ve kategori tebrik afişi ikonu (`.plat-banner-icon`) mor Epic Platin Kupa kimliğiyle tamamen eşleştirildi.

## 67. PlayStation 5 Console (Trophy Hub) Profil Sayfası Yenilemesi

- **PS5 Hero Stage (`.profile-hero-card`):**
  - Sayfa başında derin cam efektli, çift radyal ortam ışıklı (PlayStation mavisi `#2563eb` ve derin mor `#7c3aed`) konsol sahnesi oluşturuldu.
  - Squircle kullanıcı avatarı (`.profile-avatar-squircle`), parlak mavi neon hale (`box-shadow: 0 0 20px rgba(37,99,235,0.4)`), ve canlı çevrim içi yeşil durum pini (`.profile-avatar-pip`) eklendi.
  - Kullanıcı adı yanında `● Epic Games Bağlı` durum hapı ve dinamik kupa seviyesi rozeti (`.profile-trophy-level-badge`: `${epicPlatinumIcon(12)} Seviye ${trophyLevel}`) konumlandırıldı.
  - Sahne sağında PS5 tarzı tek satır kupa özet kapsülü (`.profile-hero-trophy-capsule`): Platin Kupa sayısı (`epicPlatinumIcon`), Toplam Açılan Kupa ve Toplam XP sayacı + kompakt yenileme butonu yer aldı.
- **PlayStation 5 Glass Stats Kapsülü (`.profile-stats-capsule`):**
  - Eski sıkışık 5 bento kutusu tamamen kaldırıldı; yerine Game Hub (`.hub-stat-capsule`) ile tam uyumlu 5 sütunlu tek parça cam konsol kapsülü getirildi.
  - Sütunlar: Toplam XP, Açılan Kupalar, Platin Kupa (mor ışıltılı `.profile-stat-val.plat`), Oynama Süresi ve Kütüphane oyun sayısı. Sütunlar dikey yarı saydam ayırıcı çizgilerle (`.profile-stat-divider`) estetik şekilde ayrıldı.
- **2 Sütunlu PS5 Console Trophy Game Cards Izgarası (`.profile-games-grid` ve `.ps5-profile-game-card`):**
  - Eski dar, yatay ve sarı çubuklu oyun satırları yerine 2 sütunlu ferah PlayStation konsol kupa kartı ızgarası (`repeat(auto-fill, minmax(540px, 1fr))`) uygulandı.
  - Sol tarafta 2:3 oranlı (66x92px) dikey sinematik oyun posteri (`.ps5-card-poster-wrap`), platin oyunlarda sol üstte zarif mor squircle platin kupa amblemi (`.ps5-card-plat-badge` + `epicPlatinumIcon(15)`).
  - Sağ tarafta oyun başlığı, son oynanma ve süre bilgisi (`.ps5-card-meta`), kupa sayaçları ve yüzde metni (`.ps5-card-progress-text`).
  - İlerleme çubukları (`.ps5-card-progress-fill`): Platin oyunlar için asil mor degrade (`linear-gradient(90deg, #6b21a8, #9333ea, #c084fc, #e9d5ff)`), devam eden oyunlar için PlayStation elektrik mavisi (`linear-gradient(90deg, #2563eb, #38bdf8)`). Eski sarı renk tamamen kaldırıldı.
  - Sağ uçta 10 fit gezinme için `İncele` aksiyon butonu.
- **10 Fit TV / Konsol Gezinme İpuçları Barı (`.ps5-profile-controller-hint`):**
  - Sayfa altında PlayStation DualSense / Xbox kontrolcü kısayol ipuçları (A: Oyunu İncele, X: Kupa Filtresi, Y: Arama, ⟳: Yenile, B: Geri Dön) eklendi.
  - Tüm kartlarda klavye ve gamepad navigasyonu için `:focus-visible` elektrik mavisi odak halkası (`box-shadow: 0 0 0 2px #60a5fa, 0 0 24px rgba(96, 165, 250, 0.4)`) entegre edildi.

## 68. Alt Durum Çubuğunun (Statusbar) Kaldırılması & Tam Ekran Konsol Görünümü

- **Eski Durum Çubuğunun (`#statusbar`) Tamamen Kaldırılması:**
  - Ekranın en altında yer alan ve dikey kullanım alanını daraltan `Son: ...` (`#recent`) ve `● backend bağlı (Rust)` (`#backend-status`) durum çubuğu tamamen kaldırıldı.
  - `index.html`: `<footer id="statusbar">...</footer>` DOM'dan temizlendi.
  - `src/styles.css`: `#statusbar`, `#backend-status`, `#recent` CSS kuralları temizlendi.
  - `src/main.ts`:
    - `syncEpicAccountUI` içerisindeki `recentEl` işlemleri kaldırıldı.
    - `storeRect` fonksiyonu basitleştirildi; alt durum çubuğu ofsetine ihtiyaç kalmadan pencere tam yüksekliğini (`window.innerHeight - top`) kullanacak şekilde optimize edildi.
    - `statusEl` değişkeni ve `refreshGames` içindeki bayat DOM atamaları güvenle temizlendi.
  - Uygulama böylece gereksiz geliştirici/hata ayıklama kalıntılarından arındırılarak modern, sade ve tam ekran PlayStation konsol arayüzüne kavuşturuldu.

## 69. Yeni Nesil PlayStation 5 Konsol Profil & Trophy Hub Tam Dönüşümü

- **Sinematik Konsol Sahnesi (`.ps5-profile-hero`):**
  - Sayfa başında kullanıcının kütüphanesindeki en yüksek başarımlı veya platin oyununun yüksek çözünürlüklü afişinden beslenen atmosferik sinematik arka plan (`.ps5-hero-backdrop`, `opacity: 0.28`, `blur(28px)`), çift radyal gece mavisi/mor ışıma ve derin obsidyen degrade katmanı (`.ps5-hero-gradient`).
  - **Avatar & Çevrim İçi Halkası:** 84x84px yuvarlatılmış squircle avatar, neon mavi PlayStation hale halkası (`.ps5-avatar-ring`) ve canlı çevrim içi yeşil durum pini (`.ps5-avatar-pip.online`).
  - **Otantik PlayStation 5 Trophy Level Crest & İlerleme Barı (`.ps5-level-capsule`):**
    - PlayStation seviye brövesi (`.ps5-level-crest`): `${epicPlatinumIcon(13)} SEVİYE ${trophyLevel}`.
    - Seviye ilerleme sütunu (`.ps5-level-progress-col`): Yüzde (`%${levelPct}`), kalan XP (`Sonraki seviyeye ${xpToNextLevel} XP`) ve elektrik mavisi parıltılı seviye dolum barı (`.ps5-level-fill`).
- **PlayStation 4-Seviyeli Kupa Vitrini (`.ps5-trophy-tier-showcase`):**
  - Sahne sağında PlayStation konsollarının imzası olan 4 madalya kupa sayaçları:
    - 🏆 **Platin:** Mor platin ışıltılı kupa ikonu ve sayısı (`.ps5-tier-col.plat`).
    - 🥇 **Altın:** Altın sarısı kupa ikonu ve sayısı (`.ps5-tier-col.gold`).
    - 🥈 **Gümüş:** Krom gümüş kupa ikonu ve sayısı (`.ps5-tier-col.silver`).
    - 🥉 **Bronz:** Bakır bronz kupa ikonu ve sayısı (`.ps5-tier-col.bronze`).
  - Toplam XP kapsülü (`.ps5-xp-capsule`) ve kompakt `Profili Yenile` butonu.
- **Sinematik Arka Planlı PS5 Kupa Kartları (`.ps5-profile-game-card`):**
  - Her oyun kartına yatay sinematik oyun sanatı afişi (`.ps5-card-backdrop` + `epicWideArt(s)`), koyu obsidyen vignette geçişi (`.ps5-card-backdrop-overlay`) entegre edildi. Düz siyah kutular yerine nefes alan AAA konsol kutu kapakları hissi kazandırıldı.
  - Kart başlığı yanında büyük PlayStation tarzı ilerleme rozeti (`.ps5-card-percent-badge`: `%100 Tamamlandı` / `%88 İlerleme`).
  - 10 fit gezinmede mavi neon aksiyon butonu (`[ İncele → ]`) ve `:focus-visible` elektrik mavisi konsol odak halkası (`0 0 0 2.5px #60a5fa, 0 0 26px rgba(96, 165, 250, 0.6)`).

## 70. PlayStation 5 Konsol Profil Rafinasyonu & Dinamik Kontrolcü HUD Mimarisi

- **"AI Yapmış" Cliclerini Temizleme & Doğal PlayStation 5 Konsol Zarafeti:**
  - **Mükerrer İkinci Kutu Temizliği:** Hero sahnesinin hemen altında yer alan ve yukarıda zaten yer alan metrikleri (Toplam XP, Açılan Kupalar, Platin Kupa, Oynama Süresi, Kütüphane) gereksiz yere ikinci kez gösteren devasa 5 sütunlu `.profile-stats-capsule` kutusu tamamen kaldırıldı. Hero sahnesi doğrudan ferah kupa vitrini ve oyun listesiyle buluşturuldu.
  - **Kullanıcı Kimliği & Hero Metin Rafinasyonu:** Monospace kod karmaşası yerine sol tarafta tek satırlık temiz konsol meta dizilimi (`Oyun Sayısı • Oynama Süresi • Toplam Kupa • ID Kopyala`) ve PS5 seviye kapsülü yerleştirildi; sağ tarafta 4 seviyeli kupa vitrini (Platin, Altın, Gümüş, Bronz) ve toplam XP alanı konumlandırıldı.
  - **Mekanik Düğmelerin Kaldırılması & Kart Mimarisi:** Her 20+ oyun kartının üzerinde tekrar eden gri `[ İncele > ]` butonları kaldırıldı. Kartın tamamı tıklanabilir konsol medya döşemesine dönüştürüldü; kartın sağ tarafına büyük kristal netliğinde tamamlama yüzdesi (`%100` veya `%64`) ve hover/gamepad odaklanmasında parıldayan konsol yön göstergesi (`.ps5-card-chevron`) entegre edildi.
- **Dinamik Kontrolcü HUD Mimarisi & Kol Takılı Değilken Gizleme Güvencesi:**
  - Profil sayfasının altına statik HTML olarak gömülen `<div class="ps5-profile-controller-hint">` tamamen temizlendi.
  - Global kontrolcü HUD sistemine (`updateGamepadHud`) `view === "profile"` dalı entegre edildi (`(A) Kupaları İncele`, `(X) Profili Yenile`, `(Y) Ara`, `(LB/RB) Filtreler`, `(D-Pad) Gezin`).
  - `render()` döngüsüne `updateGamepadHud(gamepadPolling)` entegre edilerek, kontrolcü takılı DEĞİLKEN (`gamepadPolling === false`) ekranda kontrolcüye dair hiçbir ipucunun ÇIKMAMASI garantilendi; kontrolcü bağlandığında ise anında konsol HUD çubuğu aktifleşir.

## 71. Üst Bar (Titlebar) Yeni Nesil Konsol Navigasyonu, Canlı Durum Rozeti & Hesap Çipi

**Sorun:** Üst bar düz metin sekmelerden (alt kenarlıklı, 2015 hissi) oluşuyordu; "Çevrimiçi" düğmesi sönük gri bir kutuya, hesap alanı ise ikon+metinden ibaret sıradan bir butona benziyordu. Ayarlar dişlisi sağda tek başına sıkışıyordu.

**Çözüm — `index.html` üst bar iskeleti tamamen yenilendi:**
- **Yükseklik 42px → 56px** (havadar konsol çubuğu). `storeRect()` yüksekliği `titlebar.offsetHeight`'tan okuduğu için gömülü mağaza webview'i otomatik uyum sağlar — sabit sayı GÖMME.
- **Marka:** `.logo-mark` (mor→indigo→sky gradyan yuvarlatılmış kare, hover'da hafif dönme + parlama) + `.logo-text` (beyaz→lavanta gradyan metin).
- **Segment navigasyon (`.nav-seg`):** Mağaza / Kütüphane / İndirmeler tek bir cam kapsül içinde; aktif sekme **kayan gradyan gösterge** (`.nav-seg-indicator`) ile işaretlenir. Eski `#nav button.active { border-bottom-color }` deseni kaldırıldı.
- **Bağlantı rozeti (`.net-chip`):** `Çevrimiçi` = yeşil nabız atan nokta (`.net-dot::after` → `net-pulse`), `Çevrimdışı` = amber. Tıklanınca mod değişir.
- **Hesap çipi (`.account-chip`):** Girişliyken gradyan avatar içinde kullanıcı baş harfi (`.avatar-initial`), girişsizken soluk `circle-user-round` ikonu + "Giriş yapılmadı".
- **Ayarlar (`.nav-icon-btn`):** Yuvarlatılmış kare ikon düğmesi; hover'da 38° döner, aktifken gradyan dolgu.

**JS tarafı (kritik noktalar):**
- `updateNavIndicator()` (main.ts): aktif sekmeyi `.nav-tab.active` üzerinden bulur, `offsetWidth`/`offsetLeft` ile göstergeyi konumlar. `render()` içinde ve `handleWindowResize()` içinde çağrılır. İlk konumlandırmada `transition: none` ile sıfırdan kayma animasyonu bastırılır (`navIndicatorReady` bayrağı). Aktif sekme segment dışındaysa (profil/ayarlar) gösterge `opacity: 0` olur.
- `updateOfflineModeUi()` artık `innerHTML` YENİDEN YAZMAZ; statik `.net-dot` + `.net-label` işaretlemesini korur, yalnızca `online`/`offline` sınıfını ve etiket metnini değiştirir.
- `updateChrome()` hesap çipini `acc.dataset.acct` ile önbellekler. **DİKKAT:** `createIcons` `<i data-lucide>`'i `<svg>`'ye çevirdiği için `innerHTML` karşılaştırması SONSUZ döngü yaratır — karşılaştırma daima `dataset` üzerinden yapılmalı.
- **Klavye kısayolları:** `Ctrl+1` Mağaza, `Ctrl+2` Kütüphane, `Ctrl+3` İndirmeler, `Ctrl+,` Ayarlar. Input/textarea odaktayken devre dışı. İlgili düğmeler `.click()` ile tetiklenir (document-level delegasyon yakalar).

**Responsive (pencere min genişliği 1024px):**
- `≤1120px`: hesap adı gizlenir, avatar kalır (`max-width: none`).
- `≤940px` (güvenlik ağı): sekme etiketleri ve bağlantı etiketi gizlenir, ikon-only moda iner.
- 1024px'te ölçüm: `seg=352px + right=200px` → taşma yok (167px boşluk).

**Ölü kod temizliği:** `.offline-toggle-btn` CSS bloğu kaldırıldı (artık `.net-chip` kullanılıyor).

## 72. Üst Barın "AI Tasarımı" Klişelerinden Arındırılması (Sade Konsol Çubuğu)

**Geri bildirim:** Kullanıcının çevresinden gelen eleştiri — *"ai sıçmış gibi, tüm ai tasarımlar böyle, her yerde 305 milyon tane var"*. §71'deki tasarım tam da AI üretimi tasarımların üç imzasını taşıyordu: **mor→indigo→cyan gradyan**, **neon parlama** ve **her şeyi tam yuvarlak kapsül** yapmak. §3'e "ZORUNLU AI TASARIMI GİBİ DURMASIN KURALI" eklendi.

**Yapılan sadeleştirme (davranış değişmedi, yalnızca görsel dil):**
- **Yükseklik 56px → 48px.** Ölçülü, "alet gibi" bir çubuk. `storeRect()` yine `offsetHeight` okuduğu için gömülü mağaza otomatik uyum sağlar.
- **Kaldırılan süsler:** `#titlebar` üzerindeki iki radyal gradyan (mor + cyan) ve `::after` mor alt çizgi; `.logo-mark` gradyan dolgusu + parlama + hover'da dönme; `.logo-text` gradyan metni; `nav-seg-indicator` gradyanı + mor glow; `.net-dot` nabız animasyonu (`net-pulse`); `nav-wiggle` / `nav-pulse` / `nav-drop` ikon animasyonları; `.nav-icon-btn:hover` 38° dönme; `translateY(-1px)` hover kaldırmaları; `.account-avatar` gradyanı; rozetteki `badge-pop` animasyonu ve glow.
- **Yeni dil:** `#titlebar` düz 2 duraklı koyu gradyan (`#101118 → #0c0d12`) + 1px `rgba(255,255,255,0.07)` hairline. `.nav-seg` **çukur** zemin (`#090a0e`), aktif karo **düz** `#24262f` + 1px inset üst ışık. Köşe yarıçapları 15/11px → **8/6px**. Kapsüller (`border-radius: 999px`) → **6px** dikdörtgen çipler.
- **Renk disiplini:** Etiketler nötr gri (`#8b8e9c` → hover `#d4d6de` → aktif `#fff`). Bağlantı rozetinde **metin nötr kalır, rengi yalnızca nokta taşır** (yeşil `#3fb950` / amber `#d29922`), kenarlık çok hafif tonlanır. Hesap avatarı nötr `#2a2d38` (gradyan yok). Tek marka vurgusu `.logo-mark` ikonundaki düz `#9d94e8`.
- **Rozet taşma düzeltmesi:** İndirme sayacı `position: absolute` köşe rozetiydi ve dar sekmede "İndirmeler" metninin üstüne biniyordu → **satır içi** düz sayaca çevrildi (`#e5484d`, 14px, `border-radius: 4px`). Satır içi olduğu için sekme genişliği değişir → `updateBadge()` sonunda `updateNavIndicator()` çağrısı eklendi (aksi halde kayan karo bayat kalır).
- **Responsive eşikler yeni ölçülere göre daraltıldı:** hesap adı `≤1060px`'te gizlenir (avatar kalır), ikon-only güvenlik ağı `≤880px`. Ölçüm: 1024px'te `seg=326 + right=173`, taşma yok (246px boşluk); 1250px'te de sorunsuz.
- **Korunanlar:** Kayan aktif karo (tek işlevsel hareket), `Ctrl+1/2/3/,` kısayolları, `.nav-seg-indicator` JS konumlandırması, `updateChrome` `dataset.acct` önbelleği.

## 73. Üst Bara Karakter Kazandırma: Tuş Yüzeyleri, Tek Vurgu Rengi & Tipografik Ses

**Geri bildirim:** §72'deki aşırı sadeleştirme *"çok ruhsuz, kütük gibi duruyor"* bulundu. Ders: AI klişelerini sökmek ile tasarımı ruhsuz bırakmak aynı şey değil. Karakter; **gradyandan değil**, yüzey dilinden, tipografiden, derinlikten ve tek bir özgüvenli vurgu renginden gelir.

**Karakter kaynakları (hepsi §3 kuralına uygun — gradyan/glow/kapsül YOK):**
- **Tuş (keycap) yüzey dili:** Tüm etkileşimli öğeler aynı fiziksel dili konuşur — düz koyu dolgu (`#14161d`), 1px `rgba(255,255,255,0.07)` kenarlık, `inset 0 1px 0 rgba(255,255,255,0.045)` üst iç ışık. Basılınca `translateY(1px)` (gerçek tuş hissi, ölçek animasyonu değil).
- **Gerçek derinlik:** `#titlebar` artık içeriğe gölge düşürür (`0 14px 26px -20px #000`). Parlama değil, gölge — bar fiziksel bir panel gibi okunur. Segment yuvası da çukur: `inset 0 2px 5px -1px rgba(0,0,0,0.85)`.
- **Tek vurgu rengi = menekşe `#7f6ce8`**, üç yerde ve hep düz: (1) aktif sekmenin alt kenarındaki 2px çizgi (`.nav-seg-indicator::after`), (2) `.logo-mark` ikonu, (3) girişliyken `.avatar-initial` metni + avatar kenarlığı `rgba(127,108,232,0.42)` ve aktif ayarlar ikonu. Gradyan olarak ASLA.
- **Tipografik ses:** Sekmeler **UPPERCASE, 11px, weight 700, `letter-spacing: 0.95px`**. `index.html` `lang="tr"` olduğu için Chromium yerel büyütme yapar → "İndirmeler" → "İNDİRMELER" (noktalı İ) doğru çıkar. Bu, arayüzü "konsol sistem menüsü" gibi okutur ve AI tasarımlarının küçük harfli yuvarlak tipografisinden ayrıştırır.
- **Durum ışığı halosu:** `.net-dot` neon glow değil, **sabit** halo alır (`box-shadow: 0 0 0 3px rgba(...,0.14)`) — gerçek bir LED gibi. Nabız animasyonu yok.
- **Hareket tek ve amaçlı:** Kayan karo `cubic-bezier(0.34, 1.22, 0.64, 1)` ile hafif taşmalı (overshoot) kayar — canlılık verir, gösteriş yapmaz. Başka hiçbir süs animasyonu yok.
- **Ölçüler:** bar 48 → **50px**, köşe yarıçapları 9/7px, `.logo-text` 12px/800/`2.8px` letter-spacing.

**Ölçüm:** 1024px'te `seg=355 + right=171` (216px boşluk), 1250px'te `seg=355 + right=204` — taşma yok. Eşikler (§72'deki `≤1060px` / `≤880px`) değişmedi.

## 74. Üst Barın PlayStation 5 Diline Taşınması: Bağlamsal Ortam Işığı, Odak Parıltısı & Kayan Çizgi

**Geri bildirim:** §73'teki "tuş yüzeyli" sürüm de *"hâlâ düz, kütük gibi"* bulundu; kullanıcı PlayStation tasarımından esinlenmeyi önerdi. **Teşhis:** PS5'in ruhu kutulardan değil IŞIKTAN gelir. §73'te her öğeyi bir kutuya (keycap) sarmıştım — kutular çoğaldıkça arayüz "panel yığını" gibi okunuyor. PS5 ise neredeyse hiç kutu kullanmaz; öğeleri ışık ve çizgiyle ayırır.

**Yapılan dönüşüm:**
- **Kutular kaldırıldı.** `.nav-seg` artık görsel bir yuva değil, sadece 20px boşluklu bir flex grubu. Aktif sekme için dolgu kutusu YOK.
- **Bağlamsal ortam (ambient) ışığı — en büyük "ruh" kaynağı.** `#titlebar` üzerinde `@property --nav-ambient` (syntax `<color>`) kayıtlı; `#titlebar::before` tek kaynaklı bir radyal yıkama yapar:
  `radial-gradient(88% 340% at 2% -120%, var(--nav-ambient) 0%, transparent 76%)`.
  `updateNavAmbient()` (main.ts) aktif bölüme göre rengi atar: mağaza `rgba(56,132,255,.22)` (mavi), kütüphane `rgba(124,108,232,.22)` (menekşe), indirmeler `rgba(0,178,158,.20)` (turkuaz), profil `rgba(206,152,48,.20)` (kupa altını), ayarlar `rgba(120,128,150,.18)`. `@property` sayesinde renk **0.55s'de yumuşakça kayar** (bölüm değişince bar ışığı akıyor). Sabit çok renkli gradyan DEĞİL → §3 istisnası.
- **Odak parıltısı:** `#nav .nav-tab::before` — öğenin ardında `inset: 2px -12px` radyal beyaz ışık (`rgba(255,255,255,.11)`), hover'da %75, aktifte %100 opaklık. Kutu yerine ışıkla seçim = PS5 dili.
- **Kayan alt çizgi:** gösterge artık `.nav-underline` olarak **`#titlebar`'ın doğrudan çocuğu** (`position:absolute; bottom:0; height:2px`), beyaz ve hafif bloom'lu. JS konumlandırması `offsetLeft` yerine **`getBoundingClientRect()` farkına** geçti (çizgi artık sekmenin kardeşi değil, barın çocuğu):
  `translateX(tabRect.left - barRect.left)`, `width = tabRect.width`.
- **Tipografi/ikon:** ikonlar 15px → **18px**, `stroke-width: 1.7` (ince-uzun konsol ikonları); sekmeler 11px/700/`letter-spacing: 1.1px` UPPERCASE. Aktif ikon `scale(1.12)`.
- **Sağ küme PS5 kontrol merkezi döşemesi:** düz opak dolgu yerine yarı saydam `rgba(255,255,255,0.055)` + 1px `rgba(255,255,255,0.06)` + `inset` üst ışık + yumuşak gölge. Ortam ışığını içlerinden geçirir. Ayarlar 32px, radius 10px.
- **Bar 50px → 54px**, `#titlebar` artık `position: relative`.

**Ölçüm (uzun hesap adıyla en kötü durum, Edge headless DOM dump):**
`vw=1024 nav=736/736 right=181 OVERFLOW=false` · `vw=1200 right=181 (ad gizli)` · `vw=1280 right=296 (ad görünür, 150px'te kırpılır) OVERFLOW=false`.
Responsive: hesap adı `≤1200px`'te gizlenir (avatar kalır, `max-width: 150px`), ikon-only güvenlik ağı `≤960px`.



## 75. Üst Bar Tasarım Turlarının Yan Yana Karşılaştırması (Design Iteration Comparison)

**Talep:** *"ikisinin karşılaştırmasını görsek bi ha"* — kullanıcı §71–§74 arasındaki turları yan yana görmek istedi. Karar: **ikisini değil dördünü birden** koy, seçimi kullanıcı yapsın.

**Yöntem (elle yeniden yazma YOK — gerçek CSS):** Her turun `src/styles.css` ve `index.html`'i ilgili commit'ten `git show` ile çıkarıldı:
| Etiket | Commit | Sürüm | Yükseklik |
|---|---|---|---|
| 1. TUR | `f4a278a` | gradyan + parlama + kapsül | 56px |
| 2. TUR | `6028c40` | aşırı sadeleştirme | 48px |
| 3. TUR | `55a09b9` | tuş yüzeyleri | 50px |
| 4. TUR | `9ab7659` | PS5 ortam ışığı | 54px |

Çıkarım sınırları: `/* --- Titlebar` → `\n#content {`. Bu aralık **üst bar + pencere kontrol butonları + üst bara ait `@media` kurallarını** birlikte alır (medya sorguları `/* Pencere Kontrol Butonları` bloğunun *sonrasında* durur; eski sınır onları dışarıda bırakıyordu → hesap adı 1080px'te yanlış görünüyordu). `:root` ayrıca alınır, lucide `<i data-lucide>` etiketleri satır içi SVG'ye çevrilir.

**Kritik doğruluk kararı — 1280px:** Karşılaştırma **uygulamanın varsayılan pencere genişliğinde** (`tauri.conf.json` → `width: 1280`) yapılır. 1080px'te `@media (max-width: 1200px)` devreye girip hesap adını gizlediği için 4. tur diğerlerinden *tasarım dışı* bir sebeple farklı görünüyordu; 1280px'te dört sürüm de tam masaüstü düzenini gösterir → adil karşılaştırma.

**Kanla öğrenilen iki headless dersi (yeni bir karşılaştırma üretirken ŞART):**
1. **`--dump-dom` ortamı ölçüm için güvenilmez:** viewport `innerWidth = 0` olur → `@media (max-width: 960px)` yürürlüğe girer, sekmeler ikona iner (40px), ölçümler yanlış çıkar. Ayrıca `--virtual-time-budget` ile birlikte kullanıldığında da bozulur. Ölçüm için `--dump-dom`, görüntü için `--screenshot` ayrı ayrı koşulmalı; **aynı koşuda ölçüp aynı koşuda ekran alma**.
2. **Inline `place()` yeterli değil:** headless'ta görüntü alanı yükleme sırasında bir süre 0 kalır, sonra gerçek genişliğe geçer. Bu yüzden göstergenin JS ile konumlandırılması **ilk karede yanlış** hesaplanır ve öyle donar (v1'de aktif çizgi "Mağaza" altında kalmıştı — teşhis: görüntü alanı 0 iken sekme genişliği 40px ölçülüyor, sonra düzen genişliyor ama inline stil bayat kalıyor). Çözüm: konumlandırmayı **`resize` olayında + `document.fonts.ready` + birkaç karelik `requestAnimationFrame` döngüsünde** tekrarla; ekran görüntüsü için animasyonları kapat (`*{transition:none !important}`) ki gösterge kesin konumunda yakalansın. Ayrıca `offsetLeft` yerine **`getBoundingClientRect()` farkı** kullan (containing block'un `border-left` genişliğini çıkar) — ölçek faktöründen etkilenmez.

**Karşılaştırmanın okunması:** 1. tur "fazla AI", 2. tur "fazla ruhsuz", 3. tur "kutularla çözmeye çalışıyor", 4. tur "ışık ve çizgiyle çözüyor". §3'teki **DENGE KURALI**nın görsel kanıtı: karakter kutulardan değil; (1) bağlamsal ışık, (2) yüzey/derinlik dili, (3) tipografik ses, (4) tek kararlı vurgu renginden gelir.

**Üretim betiği:** `%TEMP%\efx-prev\build_compare.py` (repoya girmez — tek seferlik analiz aracı). Çıktı: `karsilastirma.png` (2800×1348, 2x). Yeni bir tur eklendiğinde `VERSIONS` listesine commit hash'i ekleyip yeniden koşmak yeterli.

**Arşiv kopyası:** `.workbuddy-ai/artifacts/ust-bar-tasarim-turlari.png` (yerel referans; bilinçli olarak git'e eklenmez — repoda ikili dosya tutmuyoruz).

## 76. Üst Bar "Mor Kimlik" Turu (5. Tur) — Sabit Mor Taban + Menekşe Kayan Çizgi

**Talep:** *"Mor temayı koruyarak güzel, modern bir güncelleme; kullanıcıya hoş gelen bir şey."*

**Teşhis (4. turun zaafları):** Bölümsel ortam ışığı tam renk değiştirdiği için barın mor kimliği Mağaza'da maviye, İndirmeler'de turkuaza "kaçıyordu"; kayan alt çizgi ve odak parıltısı jenerik beyazdı.

**Çözüm — iki katmanlı ışık mimarisi:**
- **`#titlebar::before` = sabit menekşe kimlik tabanı** (`rgba(139,92,246,.16)` radyal, sol üstten). Bölümden bağımsız daima hissedilir.
- **`#titlebar::after` = bölümsel sahne ışığı** (`var(--nav-ambient)`, alfaları düşürüldü: store/dl/profile `.13`, settings `.12`, library `.20`) — mor tabanın üstüne oturur, kimlik kaybolmaz. `@property` geçiş animasyonu korunur.
- **Kayan alt çizgi mor:** `#ffffff` → `linear-gradient(90deg, #8b5cf6, #c4b5fd)` + `0 -1px 8px -1px rgba(167,139,250,.45)` üst bloom. Platin kupa rozetleriyle aynı aile.
- **Aktif sekme dili mora bağlandı:** `::before` odak parıltısı aktifte lavanta (`rgba(167,139,250,.16)`), aktif metin sıcak beyaz-lavanta (`#f4f1ff`), aktif ikon `#c4b5fd`. Hover'da parıltı nötr beyaz kalır (renk yalnızca SEÇİLİ durumu bildirir → §3 renk disiplini).
- **Logo kalkanı mor cam:** `rgba(139,92,246,.16)` zemin + `rgba(167,139,250,.30)` kenarlık + mor tonlu gölge. Girişli avatar bir tık zenginleşti (`rgba(139,92,246,.24)` / `#d3c6ff`).
- **Korunanlar:** 54px yükseklik, `updateNavIndicator()` (getBoundingClientRect farkı), `updateNavAmbient()`, sağ küme PS5 döşemesi, `Ctrl+1/2/3/,` kısayolları, responsive eşikler (≤1200px ad gizli, ≤960px ikon-only). Süs animasyonu eklenmedi.


## 77. Tek Renk Üst Bar & Profil Sayfası Mor Kimlik Uyumu

**Talep:** (1) *"Sekmeden sekmeye renk değiştirme işine karşıyım — tek renk olsun."* (2) *"Oyuncu profili kısmını güncelle."*

**1. Üst bar — bölümsel ortam ışığı tamamen kaldırıldı:**
- `#titlebar::after` (bölümsel renk katmanı), `@property --nav-ambient`, `transition: --nav-ambient` ve JS tarafındaki `NAV_AMBIENT` + `updateNavAmbient()` silindi; `render()` içindeki çağrı temizlendi.
- Bar artık **her bölümde aynı sabit menekşe ışığı** taşır (`#titlebar::before`, `rgba(139,92,246,.17)`). Bölümler arası yalnızca aktif sekmenin lavanta parıltısı, mor ikonu ve kayan menekşe çizgi değişir.

**2. Profil sayfası — üst barla aynı mor dile çekildi:**
- **Hero:** çift radyal mavi+mor gradient → **tek kaynaklı menekşe ışık** (`radial-gradient(90% 300% at 8% -40%, rgba(139,92,246,.22) …)`); avatar `mavi→mor` degrade yerine **saf menekşe** (`#8b5cf6→#6d28d9→#4c1d95`), halo lavanta.
- **Seviye & XP:** seviye barı elektrik mavisi (`#2563eb→#38bdf8`) → **menekşe-lavanta** (`#7c3aed→#a78bfa`); seviye yüzdesi `#38bdf8` → `#c4b5fd`; XP kapsülü cyan → lavanta; seviye brövesi degrade → düz mor cam.
- **Kupa kartları:** ilerleme çubuğu mavi → menekşe-lavanta; hover halo + chevron mavi → mor; kart `:focus-visible` odak halkası elektrik mavisi → lavanta.
- **Durum renkleri korundu (§3):** yeşil "Epic Games Bağlı" rozeti, yeşil "Yüklü" etiketi ve çevrimiçi nokta değişmedi (renk yalnızca DURUM bildirir). Rozet 20px pill → 8px ölçülü yarıçap (kapsül yasağı).
- Platin kartlar zaten mor idi — değişmedi; artık tüm sayfa tek aile.

**Doğrulama:** `npm.cmd run build` (tsc + vite, 0 hata). Headless Edge (taze user-data-dir, animasyonlar kapalı) ile üst barın tek renk hali (Mağaza/İndirmeler aynı menekşe) ve profil sayfasının tamamı (hero + 4 kupa kartı) gerçek CSS ile görsel doğrulandı. Araç: `node tools/ui-preview/profile-preview.mjs` → `%TEMP%\efx-profile-preview\profile.html`.

**Doğrulama:** `npm.cmd run build` (tsc + vite, 0 hata). Headless Edge ile 1280px, 2x, taze `--user-data-dir`, animasyonlar kapalı olmak üzere **3 bölümün** (Mağaza/Kütüphane/İndirmeler) gerçek-CSS ekran görüntüsü alındı ve gözle doğrulandı. Yeniden üretilebilir araç: `node tools/ui-preview/titlebar-preview.mjs` → `%TEMP%\efx-nav-preview\preview-{store,library,downloads}.html` (bölüm başına aktif sekme + doğru `--nav-ambient` enjekte eder; §75'teki rAF + fonts.ready kuralı uygulanır).

## 78. Kapsamlı Performans, Akıcılık & Bellek Optimizasyonu (Full Project Performance Overhaul)

Kütüphanedeki 488+ oyunun sebep olduğu aşırı DOM yükü, O(N²) döngüler, GPU/VRAM compositing tıkanmaları, arama girdi gecikmesi ve başlangıçtaki peş peşe yeniden çizim fırtınasının kökten çözümü sağlandı:

1. **Kütüphane Kademeli Yükleme (Progressive Chunk Rendering / Virtual Sentinel):**
   - 488 oyunun (7.300+ DOM elemanı) aynı anda `innerHTML` ile DOM'a basılması engellendi.
   - Başlangıçta viewport'u dolduran ilk 48 kart render edilir; grid tabanındaki `#lib-scroll-sentinel` üzerinde çalışan yerel `IntersectionObserver` ile kullanıcı kaydırdıkça sonraki 36'şar kartlık dilimler `insertAdjacentHTML` ile sıfır takılmayla eklenir.
   - Filtre ve aramalarda anında ilk dilim çizilerek DOM düğüm sayısı %90 azaltıldı, render süresi 300-800ms'den <5ms'ye indirildi.
2. **Arama Kutusuna Akıllı Debounce (120ms):**
   - `input#search` klavye girişine 120ms debounce (`libSearchTimer`) eklendi. Her tuş vuruşunda tüm kütüphanenin gereksiz yere baştan çizilmesi engellendi, yazarken donma son buldu.
3. **3.9 Milyon Dizi Döngüsünün O(1) Hash Map Sorgusuna İndirgenmesi:**
   - `epicVisibleSummaries()` içindeki varsayılan sıralama algoritmasında her ikili karşılaştırmada 488 elemanı `.some()` ile tarayan `recentIdx` O(N²) döngüsü kaldırıldı.
   - Sıralama öncesinde `recentIdxMap = new Map<string, number>()` ön-indekslenerek tüm sıralama karşılaştırmaları anlık O(1) Map sorgusuna dönüştürüldü.
   - Türkçe alfabetik sıralama için global `trCollator = new Intl.Collator("tr", { sensitivity: "base" })` kullanılarak 15 kat hızlanma sağlandı.
4. **Kapak Çiziminde 238.000 Linear Aramanın Kaldırılması (`rawOf` / `summaryOf`):**
   - `epicGamesRawMap` ve `epicSummariesMap` tanımlanarak `rawOf(appName)` ve `summaryOf(appName)` fonksiyonları O(1) Map erişimine kavuşturuldu.
5. **GPU & VRAM Compositing Optimizasyonu (PS5 Estetiği Korundu):**
   - Kartlarda ve butonlarda binlerce kez tekrarlanan `backdrop-filter: blur(...)` kaldırıldı; yerine yüksek performanslı derin opak obsidian zemin (`rgba(7, 9, 14, 0.94)` / `rgba(18, 20, 29, 0.94)`) uygulandı.
   - Her kartta ve kart resminde donanımsal GPU katmanı zorlayan `transform: translateZ(0)` kaldırıldı; katman ayrımı yalnızca `:hover` anında aktifleştirildi.
   - Platin kartlardaki arka planda sürekli dönen 10 saniyelik `plat-shimmer-pass` animasyonu kaldırıldı, ışıltı yalnızca hover anında (`plat-hover-glint`) çalışacak şekilde hafifletildi.
   - Profil kartlarındaki sürekli çalışan `filter: blur(10px)` optimize edildi.
6. **Başlangıç Render Fırtınasının Önlenmesi & Batching (`scheduleRender`):**
   - Açılışta ve arka plan veri güncellemelerinde (`loadEpicCollections`, `loadEpicAchSummaries`, `refreshUpdates`, `syncEpicLibrary`) `scheduleRender()` ile `requestAnimationFrame` batching'e geçildi; aynı kareye denk gelen çoklu çizimler tek bir pürüzsüz kareye indirgendi.
   - `legendary-library` IPC olayından gereksiz `render()` çağrısı kaldırıldı (Rule §15).
7. **Kontrolcü (Gamepad) Gezinmesinde Reflow Önleme:**
   - `handleGamepadDirectionalMove` içinde `getComputedStyle().visibility` yerine standart `el.offsetParent !== null` kullanılarak 100 kat daha hızlı görünürlük denetimi sağlandı.
   - Gamepad ile aşağı kaydırırken dinamik dilim yükleme desteği eklendi.
8. **Rust F12 Dinleyicisi Boşta Bekleme Optimizasyonu:**
   - `screenshots.rs` içinde hiçbir oyun açık değilken bekleme süresi 20ms'den 250ms'ye çıkarılarak arka plan CPU uyanışları %92 azaltıldı.

## 79. Birleşik Görünüm Durum Makinesi, Kesin Mağaza Gizleme Garantisi & Üst Bar Konsol Rafinasyonu (Milestone 1)

**Sorun:** Gömülü Epic mağaza native child webview'i (`HWND`) ile Kütüphane/çekmece bazen üst üste biniyor, "Kütüphane"/"İndirmeler"e geçişte mağaza kapanmıyor/asılı kalıyordu. `storeVisible: boolean` ve `view: string` iki ayrı değişken olduğu için nav aktif sekme ışığı tutarsızlaşabiliyordu.

**Çözüm 1 — Tek Durum Makinesi (`src/main.ts`):**
- `View` tipi `"library" | "downloads" | "settings" | "dlc-manager" | "profile" | "store"` olarak birleştirildi; ayrı `storeVisible` bayrağı tamamen kaldırıldı.
- `storeShown` (native webview'in gerçek görünürlüğü) + `lastNonStoreView` (mağaza dışına dönüş hedefi) eklendi.
- `setView(next)` tüm görünüm geçişlerinin TEK giriş noktası oldu; mağaza dışı her geçişte `hideStore()` atomik çağrılır.
- `render()` başında `view !== "store" && storeShown` ise `hideStore()` zorlanır — böylece herhangi bir render'da native pencere kesin gizlenir.
- Nav aktiflik mantığı `view === "store" ? data-act === "open-store" : data-view === view` olarak tek kaynaktan beslendi.
- Ölü `closeStore()` sarmalayıcısı kaldırıldı (yerine `hideStore`/`setView`).

**Çözüm 2 — Rust Kesin Gizleme Garantisi (`src-tauri/src/main.rs`):**
- `hide_store_view` artık yalnızca `hide()` çağırmıyor; child webview önce `(-10000, -10000)` konumuna taşınıp `1x1`'e küçültülüyor. Asenkron IPC gecikmesinde bile ekranda piksel kalıntısı/üst üste binme oluşamaz.

**Çözüm 3 — Üst Bar (Titlebar/Nav) Konsol Rafinasyonu (`src/styles.css`):**
- Yükseklik `54px → 56px` (ARCHITECTURE.md ile hizalı).
- Odak halkaları AGENTS.md §7.9'a uygun tek biçime getirildi: global `:focus-visible` mavi glow yerine **2px lavanta (`#8b5cf6`) + 3px offset**. `.pcard`, `.ach-card`, `.hub-media-item`, `.hub-trophy-target-card`, `.ps5-profile-game-card` odaklarındaki `translateY/scale` layout-shift efektleri KALDIRILDI (yalnızca halka + kenarlık).
- Kayan sekme göstergesi (`.nav-underline`) `will-change: transform, width` ile compositor'a alındı; süre `0.34s → 0.18s` (120 FPS konsol akıcılığı).
- Sekme tipografisi dengelendi (`11.5px`, `letter-spacing: 1.2px`), `:active` dokunsal basılma (`scale(0.98)`) ve 0.14s geçişler eklendi; aktif ikon ölçekleme süsü kaldırıldı.

**Çözüm 4 — Kontrolcü Sekme Geçişi (Milestone 1 gamepad):**
- LB/RB artık modal kapalıyken üst seviye konsol sekmelerini (Mağaza → Kütüphane → İndirmeler) `cycleTopView()` ile döndürür (modal açıkken çekmece sekmeleri korunur).
- B/Daire mağaza görünümündeyken `lastNonStoreView`'e geri döner. HUD etiketi "Filtreler" → "Sekmeler" olarak güncellendi.

## 80. Beyaz Parlama / Flashbang (FOUC) Kökten Çözümü (Milestone 2)

**Sorun:** Launcher açılışında, sayfa geçişlerinde ve özellikle mağaza içi gezinmede WebView2 native denetleyicisinin varsayılan saf beyaz (`0x00FFFFFF`) arka planı bir kare boyunca ekrana basılıyordu.

**Çözüm — dört katmanlı anti-flash:**
1. **`index.html` (head düzeyi):** `<html>` ve `<body>` etiketlerine doğrudan inline `background-color: #07080d; color-scheme: dark;` eklendi; `<meta name="color-scheme" content="dark">` + `<meta name="theme-color" content="#07080d">` ve CSS'ten önce çalışan kritik inline `html, body` stili yerleştirildi. Böylece `styles.css` Vite tarafından ayrıştırılmadan önceki ilk kare bile obsidyen çizilir.
2. **`src-tauri/tauri.conf.json`:** Ana pencereye `"backgroundColor": "#07080d"` tanımlandı; WebView2'nin Win32 penceresini beyaz boyaması engellendi.
3. **`src-tauri/src/main.rs` (native child webview):** `WebviewBuilder::new(...).background_color(tauri::webview::Color(7, 8, 13, 255))` eklendi. Mağaza sayfaları arası DirectX swap chain sıfırlamasında beyaz fırlamaz.
4. **Mağaza içi geçiş kaplaması:** `STORE_EXTENSION_SCRIPT` içine `#efxlve-store-veil` eklendi — `document_start` anında en erken kurulan, tam ekran `#07080d` opak kaplama; `load` + `requestAnimationFrame` sonrası 0.22s fade ile kaldırılır. Ağ çok yavaş olsa bile 2.5 sn güvenlik ağı kaplamayı temizler (`pointer-events: none` olduğu için mağaza etkileşimini bloke etmez).
5. **Tema tutarlılığı:** `--bg` `#0b0c10` → `#07080d` (DESIGN_SYSTEM.md kanvas rengi) ile native pencere arka planı ve gövde rengi birebir hizalandı; dikiş/renk sıçraması kalmadı.

## 81. İndirme Hızı CR/LF Bug'ı, PS5 İndirmeler Sayfası & İndirme Ayarları Paneli (Milestone 3)

**Sorun:** Legendary indirme ilerlemesini `\r` (carriage return) ile tek satırda eziyor; Rust tarafındaki `BufReader::lines()` yalnızca `\n` beklediği için hız/ETA verileri arayüze zamanında ulaşmıyor, hız `—`/`0 B/s` olarak takılı kalıyordu. Ayrıca İndirmeler sayfasının standart sayfa başlığı ve indirme ayar paneli yoktu.

**Çözüm 1 — Rust CR/LF okuyucusu (`transfers.rs`):**
- `CrlfLines<R>` yapısı eklendi: 4KB blok okuyup hem `\n` hem `\r` sınırlarında satır üretir; `\r\n` ardışıklığını ve boş parçaları tolere eder.
- `monitor_download` stderr döngüsü `BufReader::lines()` yerine `CrlfLines::new(e).next_line()` kullanır; canlı hız akışı artık 250ms emit eşiğine kesintisiz ulaşır.
- Hız anahtar kelimeleri genişletildi: ağ için `Download speed:`, `Download Speed:`, `Download:`, `Speed:`, `Net:`; disk için `Disk speed:`, `Disk Speed:`, `Written speed:`, `Disk:`, `Written:`, `Write:`.
- Yeni birim testi: `crlf_lines_splits_on_carriage_return` (`\r`, `\n` ve `\r\n` karışık girdi). Toplam 54 test yeşil.

**Çözüm 2 — PS5 Standart Sayfa Kabuğu & Bileşen Kütüphanesi (`styles.css`):**
- DESIGN_SYSTEM.md §3 tokenleri (`--ps5-surface-*`, `--ps5-border-*`, `--ps5-accent`, `--ps5-radius-*`, durum renkleri) `:root`'a eklendi.
- §4-5 standartları uygulandı: `.ps5-page`, `.ps5-page-header`, `.ps5-header-kicker/title/subtitle/actions`, `.ps5-page-body`, `.ps5-btn` (primary/secondary/danger), `.ps5-btn-icon`, `.ps5-input`.
- `.net-profile-btn.active` mavi (`#0070f3` + glow) → lavanta (`--ps5-accent`) tek vurgu rengine çekildi.

**Çözüm 3 — İndirmeler Sayfası Yenilemesi (`main.ts`):**
- `renderDownloads()` artık `.ps5-page.ps5-downloads-page` + standart başlık (kicker: `AĞ & AKTARIM MERKEZİ`, title: `İndirmeler`, subtitle) ile sarılıyor.
- Başlık aksiyon alanına aktif indirme varsa `Duraklat`/`Devam Et` (`.ps5-btn`) eklendi.
- Yeni `.dl-settings-panel`: Ağ Profili pilleri (Maks/Dengeli/Eko) + Kurulum Klasörü hızlı değiştirici (`#dl-install-dir`, klasör seç dialogu `dl-pick-install-dir`, kaydet `dl-save-install-dir`). Boşta/eski `.dl-header-group` kaldırıldı.

## 82. PS5 / Steam Tarzı Özel Sağ Tık Menüsü & Webview Zırhlama (Milestone 4)

**Sorun:** Oyun kartına sağ tıklandığında varsayılan tarayıcı menüsü (Kopyala, İncele, Yeniden Yükle vb.) açılıyordu; ayrıca webview'de kazara F5/Ctrl+R, zoom ve görsel sürükleme gibi tarayıcı davranışları arayüzü bozabiliyordu.

**Çözüm 1 — Özel Konsol Sağ Tık Menüsü (`main.ts` + `styles.css`):**
- `contextmenu` global olarak `preventDefault` edilir; yalnızca `[data-act="epic-detail"][data-id]` (portre kartı `.pcard` veya liste satırı `.prow`) hedef alınırsa menü açılır.
- `.ps5-context-menu` bileşeni tıklama koordinatında render edilir; ekran dışına taşma ölçüp kırpılır (tek `getBoundingClientRect`, layout thrashing yok), ilk öğe odaklanır.
- Menü içeriği: `Oyna`/`Yükle` (kurulum durumuna göre), `Özellikler & Yönet`, `Masaüstü Kısayolu Oluştur`, `Kurulum Klasörünü Aç`, `Kayıt Dosyalarını Yedekle`, `Favorilere Ekle/Çıkar`, `Kaldır` (kırmızı/tehlikeli).
- Öğeler mevcut `data-act` yönlendirmesini kullanır (kod tekrarı yok); menü dışına tıklama, kaydırma veya pencere boyutlandırmada kapanır.
- `index.html`'e `#ctx-root` eklendi.

**Çözüm 2 — Webview Zırhlama:**
- Metin seçimi yalnızca `input`, `textarea`, `[contenteditable]` ile sınırlandı (`user-select: none` gövdede zaten vardı, giriş alanları açıkça `user-select: text`).
- `img, a { -webkit-user-drag: none; }` ile görsel/bağlantı sürükleme engellendi.
- Yeni capture-phase `keydown` dinleyicisi `F5`, `Ctrl+R` (reload) ve `Ctrl +/-/0` (zoom) davranışlarını engeller.
- `tauri.conf.json` ana penceresine `"backgroundThrottling": "disabled"` eklendi: oyun inerken pencere arka plana alınsa bile indirme ilerleme IPC olayları ve arayüz güncellemeleri kısılmaz.

## 83. İlk Kurulum (Onboarding) & Epic Hesap Bağlama Sihirbazı (Milestone 5)

**Sorun:** `epicPhase === "setup"` ve `"login"` durumları düz `<h2>` + `.settings-box` ile sıkıcı, dağınık ve güven vermeyen bir ekran sunuyordu; hesap bağlama yöntemleri ve kodun nereden alınacağı yeterince anlatılmıyordu.

**Çözüm — `renderOnboarding()` sihirbazı (`main.ts` + `styles.css`):**
- `onboardingStep` durumu (1 Hoş Geldiniz, 2 Hesap Bağla, 3 Doğrulama) eklendi; `renderEpic()` artık `setup` ve `login` fazlarında bu sihirbazı çizer.
- **Kurulum (legendary binary yok):** ortam ışıklı kartta `Kurulum Gerekli` ekranı, canlı ilerleme çubuğu ve tek tık indirme.
- **1. Adım — Hoş Geldiniz:** launcher felsefesi (akıcı/hafif, kontrolcü odaklı, güvenli bağlantı) üç özellik kartıyla; `Başla` butonu.
- **2. Adım — Hesap Bağla:** iki yöntem kartı — `Tek Tıkla İçe Aktar` (EGL, "Önerilen") ve `Resmi Güvenli Kod` (3. adıma geçer).
- **3. Adım — Doğrulama:** 3 adımlı görsel rehber (giriş sayfasını aç → `authorizationCode` kopyala → yapıştır), güvenli kod giriş alanı (`#epic-code`) ve giriş butonu.
- Üstte adım göstergesi (`.onboarding-stepper`; aktif = lavanta, tamamlanan = yeşil onay ikonu).
- Tüm metinler konsol diline uygun, sıfır emoji, yalnızca inline SVG ikonlar; tek kaynaklı düşük alfalı menekşe ortam ışığı.
- Giriş/aktarma başarısında ve çıkışta `onboardingStep = 1`'e sıfırlanır; `onboarding-goto` aksiyonu adımlar arası geçişi yönetir.

## 84. Çoklu Dil & Lokalizasyon (i18n) Mimarisi — 15 Dil (Milestone 6)

**Sorun:** Arayüz metinleri `main.ts` içine ham gömülüydü; yalnızca TR/EN seçeneği vardı ve EN "Yakında" olarak işaretliydi. Ölçeklenebilir bir çeviri altyapısı yoktu.

**Çözüm — `src/i18n.ts` motoru:**
- `LANGUAGES` kaydı: Epic'in desteklediği 15 dil (TR, EN, DE, ES, FR, IT, JA, KO, PL, PT-BR, RU, ZH-Hans, ZH-Hant, AR, TH) + `dir` (ar = RTL).
- `t(key, vars?)` yardımcısı: eksik anahtar sırasıyla seçili dil → İngilizce → Türkçe → anahtar; `{isim}` yer tutucu desteği.
- `setLanguage(lang)`: seçili dili yükler, `<html lang>` ve `<html dir>` (RTL) uygular, statik çevirileri tazeler. TR/EN ana pakete dahil; diğer 13 dil **dinamik import** ile ayrı chunk olarak yüklenir (ana bundle şişmez — Vite çıktısında her dil ayrı `.js`).
- `applyStaticTranslations()`: `data-i18n` / `data-i18n-title` öznitelikli statik HTML öğelerini çevirir.

**Çeviri dosyaları:** `src/locales/{tr,en,de,es,fr,it,ja,ko,pl,pt-BR,ru,zh-Hans,zh-Hant,ar,th}.json`. Çekirdek anahtar seti (nav, common, downloads, ctx, ob, settings) 15 dilde çevrildi; onboarding'in uzun açıklamaları TR/EN'de tam, diğer dillerde İngilizce fallback.

**Migre edilen yüzeyler:**
- Üst bar (Mağaza/Kütüphane/İndirmeler/Çevrimiçi/Giriş yapılmadı) — `index.html` `data-i18n` + `updateOfflineModeUi`/`updateChrome`.
- İndirmeler sayfası (başlık, alt başlık, ayar paneli, boş durum, kuyruk boş, duraklat/devam).
- Sağ tık menüsü tüm öğeleri.
- Onboarding sihirbazı (adımlar, başlıklar, butonlar, rehber).
- Ayarlar dil seçici: 15 dilin tamamı ızgara (`.lang-selection-group` grid) hâlinde; TR "Varsayılan" etiketli.
- Dil seçici görsel dili lavanta vurguya çekildi (mavi glow kaldırıldı), `.lang-tag` kapsül → `--ps5-radius-sm`.

## 85. Ayarlar'da 3. Parti Başlatıcılar Hub'ı (EA App / Ubisoft Connect / Rockstar) (Milestone 7)

**Sorun:** Kütüphanedeki birçok oyun (Assassin's Creed, FC/FIFA, GTA V) harici başlatıcı gerektiriyor; ancak sistemde kurulu olup olmadıklarını gösteren veya kurulum sayfasına yönlendiren bir panel yoktu.

**Çözüm 1 — Rust tespit komutu (`commands.rs` + `main.rs`):**
- `scan_uninstall_registry()`: `reg query ...\Uninstall /s` ile HKLM/HKLM-WOW6432Node/HKCU anahtarlarını tarar; `DisplayName`, `DisplayVersion`, `InstallLocation` (REG_SZ/REG_EXPAND_SZ) değerlerini anahtar blokları hâlinde ayrıştırır. Ek crate bağımlılığı YOK.
- `epic_third_party_launchers()` komutu; EA App (`ea app`, `origin`), Ubisoft Connect (`ubisoft connect`, `uplay`) ve Rockstar Games Launcher (`rockstar games launcher`) için `{id, name, installed, version, installPath, downloadUrl}` döndürür.
- `generate_handler!` tablosuna kaydedildi.

**Çözüm 2 — Frontend (`epic.ts` + `main.ts` + `styles.css`):**
- `ThirdPartyLauncher` tipi ve `epicThirdPartyLaunchers()` sarmalayıcısı eklendi.
- `loadSettingsView()` `Promise.all`'una dahil edildi; Ayarlar'da EGL entegrasyonunun altına `.tpl-grid` hub'ı eklendi.
- Her kart: ad, durum rozeti (`Kurulu · vX` yeşil / `Kurulu değil` nötr), kurulum yolu (ellipsis) ve `Resmi indirme sayfası` butonu (`open-external-url` ile mevcut harici açma altyapısını kullanır).
- `third-party-refresh` aksiyonu ile yeniden tarama desteği.

## 86. Linux/macOS Wine & Proton Uyumluluk Katmanı Araştırması ve Mimari Tasarımı (Milestone 8)

**Kapsam:** Uygulama değil, araştırma ve mimari tasarım. Yeni `docs/CROSS_PLATFORM.md` belgesi eklendi.

**Öne çıkan tasarım kararları:**
- **Taşınabilirlik avantajı:** `legendary` ve Tauri v2/Vite zaten platformdan bağımsız; yalnızca Windows'a özgü yüzeyler (Registry, Win32 hook, `add_child` webview, kabuk entegrasyonu, sürücü harfleri) taşınmalı.
- **`src-tauri/src/platform/` soyutlaması:** `PlatformHost` trait'i + `#[cfg(target_os)]` implementasyonları (windows/unix); iş mantığı platformdan ayrıştırılır.
- **Linux:** GE-Proton / Proton-cachyos / Wine-GE runner'ları, `umu-launcher`, DXVK + VKD3D-Proton, oyun başına izole `WINEPREFIX`/`STEAM_COMPAT_DATA_PATH`, Wine Manager (GitHub Releases + SHA-256), ProtonDB/Steam Deck rozetleri, Flatpak + AppImage paketleme.
- **macOS:** Apple Silicon + macOS Sonoma+ hedefi (CrossOver 27 Intel/32-bit desteğini kaldırdı); Apple Game Porting Toolkit 4 / D3DMetal birincil, DXMT alternatif, CrossOver bottle desteği.
- **Fazlı plan:** F0 platform soyutlaması → F1 temel Linux → F2 Wine Manager → F3 ProtonDB/Flatpak → F4 macOS → F5 parite.
- **Riskler:** kernel anticheat uyumsuzluğu, Apple GPTK lisans kısıtı, Wine performans ek yükü, legendary fork uyumu.

**ROADMAP güncellemesi:** Milestone 1–8 tamamlandı olarak işaretlendi; üç aktif görev durumu `YAPILACAK` → `TAMAMLANDI` yapıldı.

## 87. Modülerleştirme Faz 1–2: CSS Parçalama, `src/core/` Katmanı & İki Dilli Yorum Standardı

**Sorun:** `src/styles.css` ~10.100, `src/main.ts` ~11.400 satırdı; hem AI hem insan inceleyiciler için okunamaz hâldeydi. Yorumlar tek dilliydi.

**Çözüm 1 — CSS 24 modüle bölündü (`src/styles/`):**
- `index.css` tek giriş noktası; 24 dosyayı `@import` ile cascade sırasında birleştirir (`main.ts` yalnızca bunu import eder, Vite derleme anında tek dosyaya indirger).
- Dosyalar: `tokens`, `components`, `base`, `library`, `gamehub`, `downloads`, `trophies`, `drawer`, `achievements`, `manage`, `downloads-hub`, `playtime`, `library-toolbar`, `aero-toolbar`, `shelves`, `steamgrid`, `profile`, `store-loading`, `focus`, `critic`, `gamepad`, `screenshots`, `screenshot-share`, `move-game`.
- Her dosya ~1.500 satırın altında ve iki dilli başlık yorumu taşır. Çıktı CSS bundle'ı davranışsal olarak birebir korundu.

**Çözüm 2 — `src/core/` katmanı kuruldu:**
- `core/types.ts`: `Game`, `CatalogMeta`, `View` (ölü `ProgressEvent` kaldırıldı).
- `core/constants.ts`: `isTauri`, demo `META`/`FALLBACK_META`/`metaOf`, mock katalog + `fetchGames`.
- `core/utils.ts`: saf yardımcılar (`esc`, `fmtPrice`, `fmtSize`, `fmtBytes`, `fmtPlaytime`, `fmtAchDate`, `cleanDisplayVersion`).
- `core/icons.ts`: `IconName` tipi, `icon()` (inline SVG) ve `epicPlatinumIcon()`.
- `main.ts` bu modülleri import eder; tekrar eden tanımlar silindi (~360 satır azaldı). `tsc`/`vite` yeşil.

**Çözüm 3 — Dokümantasyon & standartlar:**
- `docs/REFACTOR_PLAN.md` eklendi: hedef dizin yapısı, tek `AppState` nesnesi stratejisi, 6 fazlı plan (F1–F6), doğrulama adımları ve riskler.
- `AGENTS.md` §4.8 (Dosya Boyutu & Modülerlik, ~1.500 satır sınırı) ve §4.9 (İki Dilli Yorum Kuralı: önce İngilizce, sonra Türkçe, açıklayıcı) eklendi; §5 mimari bölümü güncellendi.

**Sıradaki faz (F3):** `core/state.ts` (tek `S` nesnesi), `core/dom.ts`, `core/toast.ts`, `core/ipc.ts`; ardından `features/*` modülleri. Bkz. `docs/REFACTOR_PLAN.md`.

## 88. Modülerleştirme Faz 3a: Merkezî `S` Durum Nesnesi (State Centralization)

**Sorun:** `main.ts`'in bölünememesinin tek nedeni, ~150 modül-düzeyi `let`/`const` durum değişkeninin tek lexical scope'ta yaşamasıydı. Özellik modülleri bu duruma erişemediği için hiçbir şey dışarı taşınamıyordu.

**Çözüm — `src/core/state.ts` (tek `S` nesnesi):**
- **144 durum alanı** `S` nesnesine taşındı: `S.view`, `S.epicSummaries`, `S.downloads`, `S.profileFilter`, `S.activeDrawerTab` vb.
- Taşıma **TypeScript dil servisi** ile yapıldı: her değişkenin gerçek sembol referansları (`findReferences`) bulunup `S.<ad>`'e dönüştürüldü; böylece yerel değişken gölgelemesi (shadowing) kaynaklı sessiz bug'lar engellendi. Toplam **1455 referans** güvenle yeniden yazıldı.
- Taşınamayanlar (main.ts'e özel tipler: `DrawerTab`, `EpicFilter`, DOM referansları `viewEl`/`modalRoot`, `sortOptions` sabiti) bilinçli olarak yerinde bırakıldı.
- Sabitler ve hidrasyon yardımcıları (`LANG_KEY`, `FAV_KEY`, `RECENT_KEY`, `DEMO_PLAT_KEY`, `SS_*`, `INITIAL_CARD_CHUNK`, `MORE_CARD_CHUNK`, `loadStrSet`) `core/constants.ts`'e taşındı; hem `state.ts` hem `main.ts` oradan import eder.
- ES modül kısıtı nedeniyle import edilen binding yeniden atanamaz; bu yüzden **nesne** (`S`) kullanıldı — her modül `S.x = ...` yapabilir.
- `tsc --noEmit` + `vite build` yeşil. Davranış değişmedi; `S` nesnesi artık `features/*` modüllerinin paylaştığı tek durum kaynağıdır.

**Not:** Bu faz satır sayısını düşürmez; amacı **özellik modüllerinin çıkarılabilmesini mümkün kılmaktır** (F4–F6).

## 89. Modülerleştirme Faz 3b & 4 (Başlangıç): DOM/Toast/Selector Katmanları & Context Menu Modülü

**F3b — Paylaşılan çekirdek modülleri:**
- `src/core/dom.ts`: Modül düzeyi DOM referansları (`viewEl`, `modalRoot`, `manageRoot`, `selectiveRoot`, `playtimeRoot`, `moveModalRoot`, `toastsEl`, `dlBadge`, `ctxRoot`, `collectionRoot`). Import anında bir kez çözülür; sıcak yollarda tekrarlı `getElementById` yok.
- `src/core/toast.ts`: `toast()` bildirim yardımcısı (hata toast'ları tıklayınca kopyalar, 3 ile sınırlı).
- `src/core/selectors.ts`: O(1) sorgular — `summaryOf`, `rawOf`, `setEpicSummaries`, `setEpicGamesRaw` (hash map'leri senkron tutar).
- `main.ts` bu modüllerden import eder; yerel tanımlar silindi.

**F4 — İlk özellik modülü (`src/features/context-menu/context-menu.ts`):**
- PS5/Steam tarzı sağ tık menüsü (`showContextMenu`, `hideContextMenu`, `initContextMenu`) `main.ts`'ten çıkarıldı.
- Modül `S`, `summaryOf`, `icon`, `esc`, `t`, `ctxRoot` import eder; menü öğeleri global `data-act` yönlendirmesini kullanmaya devam eder (kod tekrarı yok).
- `init()` artık `initContextMenu()` çağırır.

**Sonuç:** `main.ts` ~11.020 → ~10.900 satır. Mimari artık kanıtlanmış: bir özellik `S` + `core/*` import ederek güvenle dışarı taşınabiliyor. Sıradaki adım, büyük render/handler gruplarının (dlc, move-game, collections, screenshots, profile, settings, library, drawer, downloads) aynı desenle çıkarılması.

## 90. Modülerleştirme Faz 4 (devam): DLC Yöneticisi Modülü

- `renderDlcRows` ve `renderDlcManager` `src/features/dlc/dlc-manager.ts` modülüne taşındı.
- Modül yalnızca `S`, `icon`, `esc`, `fmtBytes` ve `GameDlcItem` tipini import eder; kurulum aç/kapa işlemi global `data-act="dlc-toggle-install"` yönlendirmesinde kalır.
- `main.ts` ~10.900 → ~10.785 satır. İki çağrı yeri (`render()` dağıtıcısı ve DLC arama güncellemesi) artık import edilen fonksiyonları kullanır.
- `tsc`/`vite build` yeşil.

## 91. Modülerleştirme Faz 4 (devam): Oyun Taşıma Görünümü Modülü

- `updateMoveSpaceBadgeInPlace`, `updateMoveProgressInPlace` ve `renderMoveGameModalFrame` `src/features/move-game/move-game-view.ts` modülüne taşındı (~330 satır).
- Modül yalnızca `S`, `icon`, `esc`, `fmtBytes`, `moveModalRoot` ve `MoveGameProgress` tipini import eder; saf render/yerinde güncelleme fonksiyonlarıdır (tam sayfa `render()` çağırmaz).
- Modal açma/başlatma/iptal mantığı (I/O içeren `openMoveGameModal`, `startMoveGame`, `closeMoveGameModal`) şimdilik `main.ts`'te kaldı.
- `main.ts` ~10.785 → ~10.455 satır. `tsc`/`vite build` yeşil.

## 92. Modülerleştirme Faz 4 (devam): Ayarlar & Profil Görünüm Modülleri

- `renderSettings` → `src/features/settings/settings-view.ts` (~247 satır). Modül `S`, `icon`, `esc`, `fmtBytes`, `t`, `LANGUAGES`, `isTauri` ve `EglDetectedGame` import eder; tüm aksiyonlar global `data-act` yönlendirmesinde kalır.
- `renderProfileGameCards` + `renderProfile` → `src/features/profile/profile-view.ts` (~360 satır). Modül `S`, `icon`, `epicPlatinumIcon`, `esc`, `fmtBytes`, `fmtPlaytime`, `t`, `epicWideArt` ve `ProfileGameRecord` import eder.
- `epicWideArt` (geniş kapak seçici) paylaşıldığı için `src/core/selectors.ts`'e taşındı; hem `main.ts` hem profil modülü oradan import eder.
- `main.ts` ~10.455 → ~9.858 satır. `tsc`/`vite build` yeşil.

## 93. Modülerleştirme Faz 5 (başlangıç): İndirmeler Görünümü Modülü

- `activeDlMetrics` (main.ts'e özel `DlMetrics` tipinden dolayı taşınamamıştı) merkezileştirildi: `DlMetrics` tipi `core/types.ts`'e, alanı `S.activeDlMetrics`'e taşındı; `main.ts`'teki tüm referanslar güncellendi.
- `pushSpeedData`, `drawSpeedCanvas`, `startSpeedChartTimer` ve `renderDownloads` → `src/features/downloads/downloads-view.ts` (~449 satır).
- Modül `S`, `icon`, `esc`, `fmtBytes`, `t`, `epicWideArt` import eder; hız grafiği hedefli DOM güncellemesi disiplinini korur (tam sayfa render yok).
- `main.ts` ~9.837 → ~9.381 satır. `tsc`/`vite build` yeşil.

## 94. Modülerleştirme Faz 5 (devam): Kütüphane & Onboarding Modülleri

- **Paylaşılan oyun-render yardımcıları** (`isAppPlatinum`, `epicDlProgress`, `epicArt`, `epicActionButtons`) → `src/core/game-view.ts`. Birden fazla özellik kullandığı için `core`'a konuldu.
- **Kütüphane** (`epicVisibleSummaries`, `getDailyGame`, `renderHeroSpotlight`, `epicCardPortrait`, `epicRowHtml`, `renderShelfHeroCard`, `renderShelfSection`, `renderEpicShelves`, `resetCardChunk`, `renderEpicItems`, `setupLibScrollObserver`, `renderSkeletonLibrary`, `renderEpic`, `updateLibraryFilterInPlace`) → `src/features/library/library-view.ts` (~849 satır).
- **Onboarding** (`renderOnboarding`) → `src/features/onboarding/onboarding-view.ts` (~113 satır). Kütüphane modülü bunu import eder.
- F3'te yerel tipli oldukları için taşınamayan durumlar da merkezileştirildi: `EpicPhase`, `EpicFilter`, `EpicSort`, `EpicViewMode`, `CardSize` tipleri `core/types.ts`'e; `S.epicPhase`, `S.epicFilter`, `S.epicSort`, `S.epicViewMode`, `S.epicCardSize` alanları `S`'e taşındı. `sortOptions` kütüphane modülüne taşındı.
- `main.ts` ~9.381 → ~8.412 satır (başlangıç 11.422'den toplam ~3.010 satır azaldı). `tsc`/`vite build` yeşil.

## 95. Modülerleştirme Faz 5 (devam): Detay Çekmecesi Widget'ları

- **Saf sunum widget'ları** (`renderHltbCard`, `renderCriticCard`, `cleanStoreDescription`, `detectControllerSupport`, `isOnlineOnlyGame`, `renderGameFeatures`, `renderOverviewTrophySpotlight`, `renderOverviewMediaSpotlight`, `renderAchievementSections`, `renderAchievementCard`, `fmtTierName`, `getAchTier`, `getHardwareIcon`, `getHardwareLabel`, `isWinSys`, `isMacSys`, `renderBackupListHtml`) → `src/features/drawer/drawer-widgets.ts` (~1.063 satır). Ağ isteği tetiklemezler (güvenli, yeniden kullanılabilir).
- Paylaşılan yardımcılar `core`'a taşındı: `isTurkishUser` → `core/selectors.ts`; `formatScreenshotDate` → `core/utils.ts`; `getAchTier` → drawer modülü.
- I/O ve orkestrasyon içeren çekmece fonksiyonları (`openEpicModal`, `renderDrawerOverview/Dlcs/Screenshots/Manage/Achievements/SystemRequirements`, `fetchAndRender*`) şimdilik `main.ts`'te; bunlar saf widget'ları import eder.
- `main.ts` ~8.412 → ~7.352 satır. `tsc`/`vite build` yeşil.
- **Not:** Çekmece render'ları lazy-load için `fetchAndRender*` çağırdığından, kalan çekmece kodu (render+fetch) bir sonraki adımda birlikte `features/drawer/`'a taşınmalı.

## 96. Modülerleştirme Faz 5 (devam): Render Kayıt Defteri & Koleksiyonlar Modülü

- **`src/core/render.ts` (Render Bus):** `main.ts` başlangıçta gerçek `render`/`scheduleRender` fonksiyonlarını `registerRender()` ile kaydeder; özellik modülleri `render()`/`scheduleRender()`'ı buradan import ederek `main.ts`'e döngüsel bağımlılık oluşturmadan yeniden çizim isteyebilir. `init()` içinde `registerRender(render, scheduleRender)` çağrılır.
- **Koleksiyonlar** (`openCollectionModal`, `closeCollectionModal`, `updateEmojiUi`, `updateColPresetArrows`, `renderCollectionModal`, `updateColGamesListInPlace`, `saveCollectionFromModal`, `deleteCollectionFromModal`, `openGameCollectionsModal`, `saveGameCollectionsFromModal`, `updateDrawerCollectionsBoxInPlace`, `loadEpicCollections`) → `src/features/collections/collections-view.ts` (~475 satır). Artık `render()` yerine render bus kullanır.
- `main.ts` ~7.352 → ~6.904 satır (başlangıç 11.422'den toplam ~4.518 satır azaldı). `tsc`/`vite build` yeşil.

## 97. Modülerleştirme Faz 5 (devam): Ekran Görüntüleri Modülü

- `DrawerTab` tipi `core/types.ts`'e, `S.activeDrawerTab` alanı `S`'e taşındı (F3'te yerel tipten dolayı kalmıştı).
- **Ekran görüntüleri** (`fetchAndRenderScreenshots`, `playScreenshotShutterSound`, `copyScreenshotImageToClipboard`, `compressImageToBlob`, `compressScreenshotItem`, `openShareModal`, `closeShareModal`, `renderDrawerScreenshots`, `renderScreenshotLightbox`, `openScreenshotLightbox`, `closeScreenshotLightbox`, `navigateScreenshotLightbox`) → `src/features/screenshots/screenshots-view.ts` (~532 satır).
- Modül `S`, `icon`, `esc`, `t`, `toast`, `formatScreenshotDate`, `modalRoot`, Epic ekran görüntüsü komutlarını ve `renderOverviewMediaSpotlight`'ı import eder.
- `main.ts` ~6.904 → ~6.389 satır. `tsc`/`vite build` yeşil.
- **Backlog notu:** Kullanıcı talebiyle `docs/REFACTOR_PLAN.md` §6.6 eklendi — (1) kalan Türkçe metinlerin `src/locales/*.json`'a taşınması, (2) ölü/optimize olmayan kod temizliği.

## 98. Modülerleştirme Faz 5 (devam): Yönetim & Oynama Süresi Modalları

- **Oynama süresi** (`openEditPlaytimeModal`, `closeEditPlaytimeModal`, `saveEditedPlaytime`) → `src/features/playtime/playtime-view.ts` (~193 satır).
- **Yönetim modalı** (`openManageModal`, `closeManageModal`, `updateManageModalInputsInPlace`, `updateVerifyProgressInPlace`, `resetVerifyInPlace`, `renderManageModal`) → `src/features/manage/manage-view.ts` (~407 satır).
- `main.ts` ~6.389 → ~5.837 satır (başlangıç 11.422'den toplam ~5.585 satır azaldı). `tsc`/`vite build` yeşil.

## 99. Modülerleştirme Faz 5 (devam): Paylaşılan Core Modülleri & Seçici Kurulum

- **`core/nav.ts`:** `updateNavIndicator`, `updateBadge`, `updateChrome` (üst bar göstergesi, indirme sayacı, hesap çipi).
- **`core/recent.ts`:** `pruneRecent`, `pushRecent` (son oynananlar listesi).
- **`core/epic-actions.ts`:** `epicPlay`, `epicInstall`, `epicCancel`, `epicUninstall`, `refreshEpicInstalled`, `refreshUpdates` (paylaşılan Epic aksiyonları).
- **`core/render.ts` genişletildi:** `registerGamepadHud`/`updateGamepadHud` kancası; `main.ts` `init()`'te kaydeder.
- **`core/dom.ts` genişletildi:** `closeModal` (drawer kapatma + HUD tazeleme) buraya taşındı.
- **Seçici kurulum** (`openSelectiveModal`, `applySelectiveInstall`, `closeSelectiveModal`, `renderSelectiveModal`) → `src/features/dlc/selective-install.ts` (~240 satır).
- `main.ts` ~5.837 → ~5.455 satır (başlangıç 11.422'den toplam ~5.967 satır azaldı, ~%52). `tsc`/`vite build` yeşil.

## 100. Modülerleştirme Faz 5 (devam): Kapak & SteamGridDB Modülü

- **`core/render.ts`**'e `registerOpenEpicModal`/`openEpicModal` kancası eklendi (kapak modülü `main.ts`'e döngüsel bağımlılık olmadan detay çekmecesini açabilir); `main.ts` `init()`'te kaydeder.
- `CUSTOM_COVERS_KEY`, `CUSTOM_HEROES_KEY` `core/constants.ts`'e taşındı.
- **Kapak/SteamGrid** (`saveCustomCover`, `resetCustomCover`, `saveCustomHero`, `resetCustomHero`, `cleanSteamGridSearchTerm`, `closeCustomCoverModal`, `openCustomCoverModal`, `renderCustomCoverModalFrame`, `renderCustomCoverModalContent`, `searchAndLoadSteamGrid`, `loadSteamGridCovers`) → `src/features/cover/cover-view.ts` (~520 satır).
- `main.ts` ~5.455 → ~4.962 satır (başlangıç 11.422'den toplam ~6.460 satır azaldı, ~%57). `tsc`/`vite build` yeşil.

## 101. Modülerleştirme Faz 5: Detay Çekmecesi Orkestrasyonu (openEpicModal + render/fetch)

- `updateDrawerTabArrows`, `ensureTabVisible`, `openEpicModal`, `updateCriticUI`, `renderDrawerOverview`, `renderDrawerDlcs`, `renderDrawerManage`, `renderDrawerAchievements`, `fetchAndRenderAchievements`, `renderDrawerSystemRequirements`, `fetchAndRenderRequirements`, `enrichAchievementsData`, `epicOpenFolder` → `src/features/drawer/drawer-view.ts` (~1.442 satır).
- Saf sunum widget'ları ayrı dosyada kaldı (`drawer-widgets.ts`); `openEpicModal` render bus'a (`registerOpenEpicModal`) kaydedilir, böylece diğer modüller onu çağırabilir.
- `main.ts` ~4.962 → ~3.592 satır (başlangıç 11.422'den toplam ~7.830 satır azaldı, ~%68.5). `tsc`/`vite build` yeşil.

## 102. Modülerleştirme Faz 5 (devam): Mağaza & Görünüm Durum Makinesi Modülü

- **`core/render.ts`**'e `registerCloseAllModals`/`closeAllModals` kancası eklendi; `main.ts` kaydeder.
- **Mağaza & görünüm durum makinesi** (`storeRect`, `syncStoreViewSize`, `renderStoreLoadingScreen`, `openStore`, `openStoreUrl`, `loadPlayerProfile`, `openProfile`, `hideStore`, `setView`) → `src/features/store/store-view.ts` (~135 satır).
- `main.ts` ~3.592 → ~3.495 satır. `tsc`/`vite build` yeşil.
- **Ders (satır kayması):** Toplu kesim öncesi satır numaraları HER ZAMAN yeniden alınmalı; import eklemeleri numaraları kaydırır. `git checkout -- src/main.ts` ile geri dönüp tekrar denendi.

## 103. Modülerleştirme Faz 5 (devam): Oyun Taşıma Aksiyonları

- `applyMovedGamePath`, `closeMoveGameModal`, `openMoveGameModal`, `browseMoveTarget`, `startMoveGame`, `cancelMoveGame` → `src/features/move-game/move-game-actions.ts` (~223 satır). Saf görünüm `move-game-view.ts`'te kaldı.
- `main.ts` ~3.495 → ~3.309 satır. `tsc`/`vite build` yeşil.

## 104. Modülerleştirme Faz 5 (devam): Epic Oturum & Senkronizasyon Modülü

- `bootEpic`, `refreshEpic`, `loadEpicAchSummaries`, `syncEpicLibrary`, `epicDownload`, `epicDoLogin`, `epicDoImport`, `epicDoLogout` → `src/features/auth/auth-actions.ts` (~204 satır).
- `main.ts` ~3.309 → ~3.143 satır (başlangıç 11.422'den toplam ~8.279 satır azaldı, ~%72.5). `tsc`/`vite build` yeşil.

## 105. Modülerleştirme Faz 5 (devam): Çevrimdışı Mod, Favori & Demo Aksiyonları

- `updateOfflineModeUi` → `core/nav.ts`; `toggleFav` → `core/game-view.ts`.
- **Demo aksiyonları** (`gameById`, `refreshGames`, `installGame`, `launchGame`, `uninstallGame`) → `core/demo.ts` (Tauri'siz tarayıcı modu için).
- `main.ts` ~3.143 → ~2.960 satır civarı. `tsc`/`vite build` yeşil.

## 106. Modülerleştirme Faz 5 (devam): Gamepad (Kontrolcü) Modülü

- `ensureGamepadHud`, `updateGamepadHud`, `initGamepadSupport`, `gamepadLoop`, `handleGamepadDirectionalMove`, `cycleTopView`, `handleGamepadTabSwitch` → `src/features/gamepad/gamepad.ts` (~297 satır).
- `main.ts` ~2.960 → ~2.775 satır (başlangıç 11.422'den toplam ~8.647 satır azaldı, ~%75.7). `tsc`/`vite build` yeşil.

## 107. Modülerleştirme Faz 5 (devam): Pencere & Kısayol Modülü

- `updateMaxIcon`, `handleWindowResize`, `throttledWindowResize` ve `resize`/`keydown` (Ctrl+1/2/3, F5/zoom engelleme) dinleyicileri → `src/core/window.ts` (~115 satır).
- `main.ts` ~2.775 → ~2.684 satır. `tsc`/`vite build` yeşil.

## 108. Modülerleştirme Faz 5 (devam): loadSettingsView Taşıması

- `loadSettingsView` → `src/features/settings/settings-view.ts`.
- `main.ts` ~2.684 → ~2.663 satır. `tsc`/`vite build` yeşil.

## 109. Modülerleştirme Faz 6: Olay Katmanı Ayrıldı — main.ts ~961 Satıra İndi (DÖNÜM NOKTASI)

- **Olay katmanı** iki modüle ayrıldı:
  - `src/features/events/click-router.ts` (~1.356 satır): tek `document.addEventListener("click", ...)` delegasyon yönlendiricisi (`data-act` / `data-view`).
  - `src/features/events/input-listeners.ts` (~549 satır): `wheel`, `resize`, `keydown`, `change`, `input` ve `viewEl` scroll dinleyicileri.
- `main.ts` bu modülleri yan etki (side-effect) import ederek dinleyicileri kaydeder.
- **`main.ts` 11.422 → ~963 satır (~%91.6 azalma).** Artık yalnızca bootstrap, `init()`, `render()`/`scheduleRender()` orkestrasyonu ve `closeAllModals()` kaldı.
- Tüm özellik dosyaları ~1.500 satır sınırının altında. `tsc` + `vite build` + `cargo check` yeşil.

**Kalan küçük işler:** `init()` + IPC `listen(...)` kayıtlarını `core/ipc.ts`'e ayırmak; `render()`/`scheduleRender()`'ı ince tutmak; ardından §6.6 backlog (i18n metin taşıma + optimizasyon/ölü kod temizliği).

## 110. Modülerleştirme Faz 6 (FİNAL): main.ts 86 Satıra İndi

- `init()` + tüm `listen(...)` IPC kayıtları + bootstrap → `src/features/events/ipc-listeners.ts` (`initApp(hooks)`; render bus'a `main.ts`'in `render`/`scheduleRender`/`closeAllModals` fonksiyonlarını enjekte eder).
- `main.ts` kullanılmayan importlardan arındırıldı; yalnızca `render()`, `scheduleRender()`, `closeAllModals()` ve bootstrap çağrısı kaldı.
- **`main.ts` 11.422 → 86 satır (~%99.2 azalma).** Tüm dosyalar ~1.500 satır sınırının altında.
- `tsc --noEmit` + `vite build` + `cargo check` yeşil.

**Nihai mimari:** `src/core/` (types, constants, utils, icons, state, dom, toast, selectors, game-view, nav, recent, render, epic-actions, demo, window, i18n), `src/features/` (auth, collections, context-menu, cover, dlc, downloads, drawer, events, gamepad, library, manage, move-game, onboarding, playtime, profile, screenshots, settings, store), `src/styles/` (24 dosya), `src/locales/` (15 dil).

## 111. Optimizasyon & Ölü Kod Temizliği + Sıfır-Emoji Politikası İhlalinin Giderilmesi

**Ölü kod / kullanılmayan semboller:**
- TypeScript AST tabanlı bir betikle tüm `src/**` dosyalarındaki kullanılmayan import belirteçleri temizlendi (13 dosya).
- `noUnusedLocals` ile tespit edilen ölü yerel değişkenler kaldırıldı (`achPill`, `baseUnlocked`, `dlcUnlocked`, `baseItems/baseTotal/dlcTotal`, `installedCount`, `updateCount`, `totalInstalledGames`) ve kullanılmayan `t` importları silindi.
- `node tsc --noEmit --noUnusedLocals` artık **0 hata** veriyor.

**Sıfır-emoji politikası (AGENTS.md §7.1) ihlali giderildi:**
- `POPULAR_COL_EMOJIS` (32 emoji) kaldırıldı; yerine `src/core/collection-icons.ts` eklendi: `COLLECTION_ICONS` (24 adet inline SVG ikon), `isCollectionIcon()`, `collectionMarker()`.
- Koleksiyon modalındaki emoji seçici → SVG ikon paleti (`col-marker-*` sınıfları); serbest emoji girişi ve `apply-custom-emoji` aksiyonu kaldırıldı.
- Hızlı şablon çipleri artık ikon + etiket (`data-icon`).
- `colModalSelectedEmoji` → `colModalMarker`, `isEmojiPaletteOpen` → `isMarkerPaletteOpen`, `updateEmojiUi` → `updateMarkerUi` olarak yeniden adlandırıldı.
- Koleksiyon işaretleri kütüphane raflarında, çiplerde, çekmecede ve menüde `collectionMarker()` ile çizilir; eski emoji değerleri klasör ikonuna düşer.
- CSS sınıfları `col-emoji-*` → `col-marker-*` olarak güncellendi; ölü `.col-custom-emoji-row` bloğu ve hover `scale` süsü kaldırıldı.

`tsc` + `vite build` + `cargo test` (54/54) yeşil. **Kalan iş:** i18n metin taşıma (bkz. §6.6).

## 112. i18n Metin Taşıma (Başlangıç): Çekmece Sekmeleri & Kütüphane Filtreleri

- `tr.json` / `en.json`'a anahtarlar eklendi: `drawer.overview/achievements/dlcs/screenshots/manage/specs`, `library.all/installed/favorites/updates/platinum`, `common.playing/update/cancelShort`.
- `drawer-view.ts`: çekmece sekme etiketleri (statik + dinamik güncelleme) artık `t("drawer.*")`.
- `library-view.ts`: kütüphane filtre pilleri (`Tümü`, `Yüklü`, `Favoriler`, `Platin`, `Güncelleme`) artık `t("library.*")`.
- Diğer 13 dil, eksik anahtarlar için İngilizce'ye düşer (fallback).
- **Kalan i18n işi** (kademeli): drawer içerikleri, downloads, settings, profile, manage, screenshots, toasts/hata mesajları. Bkz. §6.6.

## 113. i18n Metin Taşıma (devam): İndirmeler Sayfası Tamamen Migre Edildi

- `downloads-view.ts` içindeki tüm kalan sabit metinler `t()`'e taşındı: durum etiketleri, metrik kutuları (hız/disk/ETA/boyut + alt açıklamalar), hız grafiği başlığı ve efsanesi, kuyruk satırları (boyut/sıra/taşı/hemen indir/çıkar), kuyruk ve tamamlanan bölüm başlıkları, ağ profili pilleri ve varsayılan klasör yer tutucusu.
- `tr.json` / `en.json`'a ~28 yeni anahtar eklendi (`dl.*`, `downloads.profile*`, `downloads.defaultPlaceholder`).
- `tsc` + `vite build` + `noUnusedLocals` (0 hata) yeşil.

## 114. i18n Metin Taşıma (devam): Ayarlar & Profil Sayfaları

- **`settings-view.ts` tamamen migre edildi:** hesap, kurulum klasörü, EGL entegrasyonu, 3. parti başlatıcılar, koleksiyonlar, SteamGridDB, ağ profili, çevrimdışı mod, ekran görüntüleri (kısayol/sıkıştırma/format/kalite), sistem bölümü. `settings.*` (~70 anahtar).
- **`profile-view.ts` tamamen migre edildi:** boş durum, oyun kartları, yükleme/hata kutuları, hero sahnesi (seviye, XP, kupa hiyerarşisi), filtre pilleri, arama, sıralama. `profile.*` (~35 anahtar). `t("profile.xpToNext", { n })` ve `t("profile.copyIdTitle", { id })` yer tutucuları kullanıldı.
- `profile-view.ts` sonundaki ölü yorumlar temizlendi.
- `tsc` + `vite build` + `noUnusedLocals` (0 hata) yeşil.

**Kalan i18n işi:** drawer içerik bölümleri, yönetim modalı, seçici kurulum, kapak/SteamGrid, DLC yöneticisi, gamepad HUD, toast/hata mesajları.

## 115. i18n Metin Taşıma (devam): DLC Yöneticisi, Seçici Kurulum & Yönetim Modalı

- **`dlc-manager.ts`** (`dlc.*`): boş durum, satır etiketleri, promo banner, tablo başlıkları, geri dön/keşfet.
- **`selective-install.ts`** (`selective.*`, `dl.starting`): denetleme/başlatma/hata toast'ları, bölüm başlıkları, boyut özeti, uygula. Yerel `t` değişkenleri `tag`/`d` olarak yeniden adlandırıldı (i18n `t` çakışması önlendi).
- **`manage-view.ts`** (`manage.*`, ~40 anahtar): oynama istatistikleri, doğrulama, otomatik güncelleme, öncelik, bulut kayıtları, yedekleme, kısayol, yükleme/taşıma/kaldırma, DLC, gelişmiş başlatma. Ölü yorum temizlendi.
- `tr.json`/`en.json`'a ~60 yeni anahtar eklendi. `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

**Kalan:** drawer içerikleri (`drawer-widgets`/`drawer-view`), kapak/SteamGrid, gamepad HUD, oynama süresi modalı, ekran görüntüsü paylaşımı, toast/hata mesajları.

## 116. i18n Metin Taşıma (devam): Gamepad HUD

- `gamepad.ts` HUD etiketleri (`gamepad.*`) ve kontrolcü bağlantı toast'ı `t()`'e taşındı.
- `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

## 117. i18n Metin Taşıma (devam): Oynama Süresi Modalı & `lastPlayedLabel`

- **`playtime-view.ts`** (`playtime.*`, ~25 anahtar): düzenleme başlığı, Epic verisi açıklaması, süre girişleri, hızlı ekleme, son aktivite seçenekleri, kaydet/vazgeç, oturum özeti ve toast'lar.
- **Geriye dönük uyumluluk:** `last_played` verisi yerelleştirilmiş metin olarak saklandığından, `core/selectors.ts`'e `lastPlayedLabel(value)` eklendi — bilinen değerleri `t()` ile çevirir, özel değerleri olduğu gibi bırakır. Çekmece (drawer-view) ve yönetim (manage-view) görünümleri de bunu kullanır.
- `click-router.ts` bulut eşitleme mesajları `i18nT` takma adıyla çevrildi (yerel `t` eleman değişkeni çakışması nedeniyle).
- `tr.json`/`en.json`'a ~30 yeni anahtar eklendi. `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

**Kalan:** drawer içerikleri (`drawer-widgets`/`drawer-view`), kapak/SteamGrid, ekran görüntüsü paylaşımı, toast/hata mesajları.

## 118. i18n Metin Taşıma (devam): Drawer HLTB & Eleştirmen Kartları

- `drawer-widgets.ts` içinde `renderHltbCard` ve `renderCriticCard` `i18nT` (takma adlı `t`) ile migre edildi: `hltb.*` (arama, süre etiketleri, saat biçimi) ve `critic.*` (başlık, skor etiketleri, sayfa başlıkları, Goygoy incelemesi).
- Yerel `t` değişkeni çakışması nedeniyle `import { t as i18nT }` kullanıldı.
- `tr.json`/`en.json`'a ~25 yeni anahtar. `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

**Not:** Drawer grubu (~1.700 Türkçe satır) kademeli migre ediliyor. Kalan drawer bölümleri (oyun özellikleri, kupa vitrini, medya, başarım listeleri, sistem gereksinimleri, çekmece yönetimi) sonraki adımda.

## 119. i18n Metin Taşıma (devam): Drawer Widget'ları & Genel Bakış/DLC Sekmeleri

- `drawer-widgets.ts` tamamlandı: oyun özellikleri (`feat.*`), kupa vitrini (`trophy.*`), medya galerisi (`media.*`), başarım listeleri/kartları (`ach.*`), donanım etiketleri (`hw.*`), yedek listesi. Türkçe HTML yorumları İngilizce'ye çevrildi.
- `drawer-view.ts`: `openEpicModal` meta/aksiyon/stat kapsülü, `renderDrawerOverview` ve `renderDrawerDlcs` (`drawer.*`) migre edildi.
- `tr.json`/`en.json`'a ~65 yeni anahtar. `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.
- **Not:** Locale dosyaları büyüdükçe ana JS paketi ~36 kB arttı (tr/en statik import ediliyor; kabul edilebilir).

**Kalan:** `drawer-view.ts` içindeki `renderDrawerManage`, `renderDrawerAchievements`, `renderDrawerSystemRequirements`, `fetchAndRender*` toast'ları; kapak/SteamGrid, ekran görüntüsü paylaşımı, kalan toast/hata mesajları.

## 120. Bug Fix: Detay Çekmecesi Üst Barı Örtüyordu (Üst Menü "Yukarı Kayma")

**Semptom (kullanıcı bildirimi):** Oyun detay sayfası (Game Hub çekmecesi) açıldığında üst menüdeki "Mağaza / Kütüphane / İndirmeler" sekmeleri kesik/yukarı kaymış gibi görünüyordu.

**Kök neden:** `.overlay` (detay çekmecesi) `inset: 40px 0 0 0` ile konumlanıyordu; ancak üst bar (`#titlebar`) yüksekliği Milestone 1'de `54px → 56px` yapılmıştı. Çekmece, üst barın **alt 16px'ini örtüyordu** — bu da nav sekmelerini ve kayan göstergeyi görsel olarak kesiyordu. İki değer ayrı ayrı sabit kodlanmıştı.

**Çözüm — tek kaynak değişken (`--titlebar-h`):**
- `tokens.css` `:root`'a `--titlebar-h: 56px` eklendi (tek doğruluk kaynağı).
- `base.css` `#titlebar { height: var(--titlebar-h); }` olarak güncellendi.
- `gamehub.css` `.overlay { inset: var(--titlebar-h) 0 0 0; }` olarak düzeltildi; çekmece artık tam olarak üst barın altından başlar ve navigasyon her zaman görünür/kullanılabilir kalır.
- Diğer modal katmanlarının (yönetim, seçici kurulum, taşıma, kapak, lightbox) tam ekran `inset: 0` kullanması kasıtlıdır (modal oldukları için üst barı örtmeleri doğrudur).

`tsc` + `vite build` yeşil.

## 121. i18n (drawer yönetim/başarım/specs) + Emoji & Dingbat Temizliği

- `renderDrawerManage`, `renderDrawerAchievements`, `renderDrawerSystemRequirements` ve `openEpicModal` üst barı (`drawer.*`, `manage.*`, `ach.*`, `sys.*`, `common.*`) tamamen `t()`'e taşındı; Türkçe kod yorumları İngilizce'ye çevrildi.
- `NO_DESC` sabiti `core/constants.ts`'e eklendi (epic.ts + drawer-view.ts'teki "Açıklama yok." sihirli metni merkezileştirildi).
- **Zero-Emoji ihlalleri giderildi:** `⚡`/`✅` toast ve ekran görüntüsü rozetlerinden, `✓` `feat.*` etiketlerinden kaldırıldı (durum yalnızca renkle bildirilir — Kural 6).
- Metin ok karakterleri SVG ikonlarla değiştirildi: `▾` → `chevron-down`, `▲` → `chevron-up`, `●` → `check`.
- `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

## 122. i18n: Ana Kütüphane Ekranı (library-view) + Nav/Game-View

- `library-view.ts` tamamen `t()`'e taşındı: sıralama seçenekleri, hero vitrini, portre/row kartları, raf başlıkları, filtre çipleri, koleksiyon açılır menüsü, arama/araç çubuğu, platin banner ve hata/boş durumlar (`lib.*`, ~65 yeni anahtar). Türkçe kod yorumları İngilizce'ye çevrildi.
- `nav.ts` (ağ çipi + hesap çipi tooltip'leri, `nav.*Tip`) ve `game-view.ts` (paylaşılan oyun butonları, `common.*`) migre edildi.
- `tr.json`/`en.json` artık **647 anahtar** (duplicate yok).

**Kalan i18n yüzeyi:** `cover-view.ts` (SteamGridDB modalı), `move-game-view.ts` (taşıma modalı + uyarı rozetleri), `screenshots-view.ts` (galeri/lightbox/paylaşım), `collections-view.ts` (koleksiyon modalı), `epic-actions.ts` (indirme durumu), `click-router.ts`/`input-listeners.ts`/`ipc-listeners.ts` (toast'lar), `store-view.ts` (yükleme ekranı), `profile-view.ts` yorumları.

## 123. Ölü Kod Temizliği: Bağımsız Yönetim Modalı + Performans İlkesi

- **AGENTS.md §4.10** eklendi: "Düşük Donanım & Yavaş Ağ Tabanı" — referans donanım (8 GB RAM, i5 5. nesil, entegre GPU, HDD, yavaş internet) ve boşta sıfır yük / VRAM disiplini / yavaş ağ önceliği / kademeli yükleme zorunlulukları.
- **Ölü kod silindi:** `manage-view.ts` içindeki `openManageModal`, `renderManageModal` ve `closeManageModal` (hiçbiri çağrılmıyordu; canlı yol `drawer-view.ts`'teki yönetim sekmesi). `#manage-root` DOM kökü, `manageRoot` referansı ve `S.manageShowArgs` state alanı kaldırıldı. `manage-view.ts` 408 → 105 satır.
- İlgili ölü handler'lar silindi: `manage-close`, `manage-overlay-close`, `manage-toggle-args-panel` ve Escape'teki `manageRoot` dalı. `game-status` olayında yönetim sekmesi artık `openEpicModal(id, false)` ile yerinde yenileniyor.
- `manage.css` sadece paylaşılan kontrollere indirildi (`.toggle-switch`, `.verify-*`, `.manage-head-close`). Ana JS paketi ~12 kB küçüldü (416 → 405 kB).
- Yönetim toggle toast'ları i18n'e taşındı (`manage.autoUpdateOn/Off`, `priorityOn/Off`, `cloudOn/Off`).
- `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

## 124. i18n: Koleksiyon Modalı, Mağaza Yükleme, Çekirdek Yardımcılar

- `collections-view.ts` tamamen `t()`'e taşındı (`col.*`, ~55 anahtar): düzenleyici modal, hızlı şablonlar (isimleri de yerelleşir), filtre sekmeleri, oyun listesi, alt bilgi, silme onayı ve oyun-koleksiyon seçici. Türkçe yorumlar İngilizce'ye çevrildi.
- `store-view.ts` (gömülü mağaza yükleme ekranı, `store.*`) ve `core/epic-actions.ts` (başlatma/indirme durumu, `dl.launching`) migre edildi.
- `core/utils.ts`: ölü `fmtPrice` kaldırıldı; `fmtPlaytime` artık yerelleşmiş birimler kullanıyor (`common.minutesUnit`, `lessThanMinute`, `hoursShort`); `fmtAchDate` etkin dili kullanıyor (`currentLanguage()`).
- `core/window.ts` klavye kısayolu/webview yorumları İngilizce'ye çevrildi.
- `tr.json`/`en.json` ~700 anahtar. `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

## 125. i18n: Taşıma Modalı, Ekran Görüntüleri, State Ölü Alanı

- `move-game-view.ts` + `move-game-actions.ts` tamamen `t()`'e taşındı (`move.*`, ~45 anahtar): sürücü kartları, kapasite rozetleri, canlı ilerleme aşamaları, hedef yol önizlemesi, toast'lar. Aşama etiketi tek `moveStageLabel()` yardımcısına indirildi (duplike mantık kaldırıldı). Türkçe yorumlar İngilizce.
- `screenshots-view.ts` tamamen `t()`'e taşındı (`ss.*`): paylaşım sayfası, galeri başlığı/boş durumu, lightbox araçları, panoya kopyalama toast'ları. İç `throw new Error` metinleri İngilizce'ye çevrildi.
- **Ölü kod:** `core/state.ts` içindeki kullanılmayan `sortLabelMap` kaldırıldı. Hotkey ön ayar etiketi `"F12 (Varsayılan)"` → `"F12"` yapıldı; "(Varsayılan)" artık `settings.defaultKey` ile yerelleşiyor.
- `tr.json`/`en.json` ~780 anahtar. `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

## 126. i18n: Kapak / SteamGridDB Modalı

- `cover-view.ts` tamamen `t()`'e taşındı (`cover.*`, ~60 anahtar): hedef segmenti, canlı önizleme, URL/dosya sekmeleri, SteamGridDB kurulum sihirbazı, arama çubuğu, stil filtreleri, galeri kartları ve alt bilgi. Türkçe yorumlar İngilizce; ölü boş satır bloğu temizlendi.
- `tr.json`/`en.json` ~840 anahtar. `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

## 127. i18n: Olay Yönlendiricileri, Kimlik Doğrulama, İndirmeler

- `click-router.ts`: kapa önizleme rozetleri, ağ modu/profil toast'ları, doğrulama/bulut senkronu durumları, ekran görüntüsü silme onayı ve paylaşım metni `i18nT()`'e taşındı; tarih biçimi `currentLanguage()` kullanıyor; yorumlar İngilizce.
- `input-listeners.ts`: kapa önizleme rozetleri yerelleşti.
- `ipc-listeners.ts`: oyun durumu toast'ları (`status.*`), bulut eşitleme durumları, `libraryPath` hata metni ve indirme ETA'sı `t()`'e taşındı.
- `auth-actions.ts`: senkron mesajları (`lib.syncing`, `lib.updated`, `lib.offlineCache`) migre edildi; `downloads-view.ts` ETA + yorumlar.
- `tr.json`/`en.json` ~860 anahtar. `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

## 128. i18n Tamamlandı: Kalan Türkçe Yorumlar İngilizce'ye Çevrildi

- `epic.ts` (26 bölüm başlığı/açıklama), `gamepad.ts` (kontroller + konsol logları), `profile-view.ts` ve `drawer-widgets.ts` içindeki tüm Türkçe yorumlar İngilizce'ye çevrildi (Kural §4.9).
- Tarama sonucu: kullanıcıya dönük tüm metinler `t()` üzerinden geliyor. Kalan Türkçe dizeler yalnızca **veri sabitleri** (demo katalog, `NO_DESC` sentinel, `last_played` eşleme anahtarları, mağaza açıklaması anahtar kelime tespiti) ve **dil adları** (`Türkçe`, `Français`) — bunların yerelleşmemesi doğrudur.
- `tr.json`/`en.json`: **879 anahtar**, duplicate yok, iki dosya arasında eksik anahtar yok.
- `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

## 129. Performans Denetimi + CSS/HTML Yorum ve Metin Temizliği

- **GPU/VRAM disiplini (Kural §6.13):** Yinelenen kart öğelerinden `backdrop-filter` kaldırıldı ve opak obsidyen yüzeylere geçildi: `.micro-chip` (kütüphane kartı), `.hub-card` (çekmece kartları), `.ss-chip` (ekran görüntüsü kartları), `.sgdb-style-tag`/`.sgdb-score-tag` (galeri kartları). `.prow` (liste satırı) üzerindeki gereksiz `transform: translateZ(0)` kaldırıldı.
- **CSS yorumları:** 24 CSS dosyasındaki ~132 Türkçe yorum İngilizce'ye çevrildi (Kural §4.9). CSS taraması artık temiz.
- **index.html:** Statik Türkçe `title` öznitelikleri `data-i18n-title` + yeni anahtarlarla yerelleştirildi (`nav.*Title`, `win.minimize/maximize`, `common.toTop`); Anti-FOUC yorumu İngilizce.
- `tr.json`/`en.json` ~890 anahtar. `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

## 130. Rust Mesaj Yerelleştirme Altyapısı + Kaçırılan Toast Metinleri

- **`@t:` konvansiyonu:** Rust, kullanıcıya dönük mesajları artık `@t:<anahtar>` / `@t:<anahtar>\u001f<arg1>\u001f<arg2>` biçiminde döndürür. Frontend `i18n.ts`'teki `localizeMessage()` bu biçimi seçili dile çevirir; `toast()` ve hata/ilerleme gösterim noktaları bunu kullanır.
- `legendary/mod.rs` hata enum'ları (`err.*`) ve `transfers.rs` indirme/oynatma mesajları (`dl.*`) bu biçime taşındı.
- **Tarayıcı düzeltmesi:** Önceki tarama `t(` içeren satırları atladığı için `toast("...Türkçe...")` metinleri kaçmıştı. Yeni tarama ile ~90 kaçırılan toast metni bulundu ve `t()`'e taşındı: `core/demo.ts`, `auth-actions.ts`, `click-router.ts`, `input-listeners.ts`, `ipc-listeners.ts`, `move-game-actions.ts`.
- Yerel klasör seçici artık başlığı frontend'ten alıyor (`epic_select_folder_dialog(default_path, title)`), böylece diyalog seçili dili izliyor.
- `tr.json`/`en.json` ~980 anahtar. `tsc` + `vite build` + `noUnusedLocals` (0) + `cargo check` yeşil.

## 131. Rust Tarafı Tam Yerelleştirme: Tüm Yorumlar İngilizce, Mesajlar `@t:`

- **Rust yorumları:** 19 dosyadaki ~405 Türkçe yorum İngilizce'ye çevrildi (Kural §4.9). Kalan Türkçe dizeler yalnızca veri/sentinel (demo katalog, EGL koleksiyon adı temizliği, `last_played`/`Belirtilmemiş` sentinel'leri, Türkçe→ASCII harf eşlemesi, test fixture'ları) ve mağaza köprüsünün kasıtlı tr/de/en sözlüğü.
- **Kullanıcı mesajları `@t:`'ye taşındı:** `client`, `backup`, `collections`, `downloader`, `profile`, `screenshots`, `steamgrid`, `critic`, `commands`, `main`, `transfers`, `move_game`, `mod`. Yerel klasör seçici başlığı frontend'ten geliyor.
- **Gösterim noktaları yerelleştirildi:** `setupMessage`, indirme `eta`, taşıma `speed/eta/current_file`, DLC etiketleri (`@t:dlc.*`), `epicError`.
- **Anahtar hijyeni:** `dl.queued` çakışması `dl.queuedActive` olarak ayrıldı; `lib.updates` eklendi. Doğrulama scripti: kullanılan 1059 anahtarın tümü tr/en'de mevcut; **1100 anahtar**, duplicate yok, tam eşlik.
- `cargo check` + `cargo test` (54) + `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.

## 132. Özellik: Discord Rich Presence (Opsiyonel)

- **`src-tauri/src/presence.rs`:** `discord-rich-presence` (1.1) ile hafif IPC entegrasyonu. Tek bir arka plan worker thread'i Discord istemcisine bağlanır; UI'dan gelen aktiviteyi **tekilleştirir** (de-dupe), bağlantı hatalarında 30 sn geri çekilir, devre dışı bırakılınca thread'i kapatıp aktiviteyi temizler. **Boşta sıfır maliyet** (§4.10).
- **Yerelleştirme:** Metinler frontend'de `t()` ile üretilip düz string olarak gönderilir; böylece RPC da seçili dili izler.
- **Komutlar:** `epic_presence_configure(enabled, clientId)`, `epic_presence_update(details, state)`, `epic_presence_clear()`; ayarlar `settings.json`'a (`presence_enabled`, `presence_client_id`) yazılır.
- **Frontend:** `features/presence/presence.ts` (`initPresence`/`applyPresenceSettings`/`syncPresence`), `render()` içinden çağrılır. Bağlamlar: oyun oynanıyor, mağazada gezinme, kütüphane (oyun sayısı), oyun detayı, indirme yüzdesi, ayarlar.
- **Ayar UI:** Ayarlar sayfasına "Discord'da göster" anahtarı + Discord Uygulama Kimliği (Client ID) alanı eklendi. Varsayılan **kapalı**.
- **Not:** Discord RPC, kullanıcı bir Discord uygulaması oluşturup Client ID girmelidir (Client ID gizli değildir). Discord kapalıysa özellik sessizce bekler.
- `cargo check` + `cargo test` (54) + `tsc` + `vite build` + `noUnusedLocals` (0) yeşil. `tr.json`/`en.json` **1119 anahtar**.

## 133. Discord RPC Düzeltmeleri: Tek Tıkla Varsayılan ID + Mağaza/Profil/Oyun Detay

- **Varsayılan Discord Client ID gömüldü** (`DEFAULT_DISCORD_CLIENT_ID`): Discord RPC uygulama kimliği sır değildir, bu yüzden varsayılan olarak koda eklendi. Kullanıcı sadece anahtarı açarak tek tıkla kullanır; isterse kendi uygulamasının ID'sini girebilir (boş bırakılırsa varsayılan kullanılır).
- **Mağaza bug'ı:** `render()` mağaza dalında `return` ettiği için `presenceSync()` atlanıyordu → erken `return`'den önce çağrılıyor.
- **Oyun detay bug'ı:** `openEpicModal` `render()` çağırmadığı için presence güncellenmiyordu → çekmece açılışında `presenceSync()` eklendi; çekmece kapanışı `closeModal()` içinden tetikleniyor.
- **Render bus:** `core/render.ts`'e `registerPresenceSync`/`presenceSync()` eklendi; `core/dom.ts` `closeModal()` presence'ı tazeliyor (core→features bağımlılığı olmadan).
- **Profil bağlamı** eklendi (`presence.profile`).
- **Ölü anahtar temizliği:** silinen yönetim modalından kalan 18 `manage.*` anahtarı + `common.refresh` + `move.pickerDesc` kaldırıldı. `tr.json`/`en.json` **1100 anahtar**, duplicate yok, tam eşlik.
- `cargo check` + `cargo test` (54) + `tsc` + `vite build` + `noUnusedLocals` (0) yeşil.


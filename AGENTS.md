# AGENTS.md — Efxlve Launcher

> Bu dosya, bu projede çalışacak AI ajanları (ve insan geliştiriciler) için **ana operasyonel rehberdir**.
> Kısa tut, güncel tut: kritik kuralları net koru, geçmiş sürüm detayları için `docs/CHANGELOG_INTERNAL.md` dosyasına başvur.
>
> **GÜNCEL DURUM (Hydra siyah/beyaz):** Arayüz **gerçek siyah** (`#000`) + beyaz vurgu. Oyun sayfası Hydra düzeninde (geniş hero, oynama satırı, iki kolon, sağda başarım/istatistik/HLTB). Tam ekran Login yok — launcher her zaman kabuğu açar; mağaza hesapları `Accounts` sayfasından bağlanır (GOG için yer). **Ctrl+K komut paleti** ve ayrı **TV Modu**. Kurallar: **`docs/DESIGN_SYSTEM.md`**. Tam `innerHTML` kütüphane yeniden çizimi bir bug'dır; kartlar ve liste satırları `data-lib-item` üzerinden yerinde yamalanır. Modülerleştirme **tamamlandı** — `main.ts` 11.422 → **113 satır** (yalnızca `render`/`scheduleRender`/`closeAllModals` + bootstrap). `click-router.ts` (~1.509), `legendary/commands.rs` (~2.500), `legendary/transfers.rs` (~1.750) ve `main.rs` (~1.600) henüz ~1.500 satır kuralının üzerinde; sorumluluk bazlı bölünmeleri backlog'da. Mimari: **`docs/REFACTOR_PLAN.md` §6.5**. **i18n tamamlandı** (Rust dahil, **1.241 anahtar**, tr/en tam eşlikli) ve ölü kod temizliği yapıldı (77 ölü anahtar + eski onboarding anahtarları silindi): **`docs/REFACTOR_PLAN.md` §6.6**. Yeni: **Discord Rich Presence (opsiyonel, varsayılan kapalı)** — `src-tauri/src/presence.rs`; **EOS Overlay tespiti** (Ayarlar'da sürüm + overlay desteği; overlay oyun sürecine enjekte edilir, launcher'a gömülemez) — `eos_overlay_status`; **oyun bazında "EOS Desteği" rozeti** — `epic_detect_eos`; **Epic arkadaş paneli** (salt-okunur, resmi olmayan Web API) — `legendary/friends.rs`; **"oyun oynarken indirmeleri duraklat"** (opsiyonel, varsayılan kapalı). Yeni: **bildirim merkezi** (`src/features/notifications/`); **ücretsiz haftalık oyunlar** rafı (`legendary/freegames.rs`); **oyun başına wrapper/ortam değişkenleri** (yönetim sekmesi); **stüdyo filtresi + gelişmiş arama** (`dev:`, `is:`); **sistem tepsisi + kapatınca tepsiye küçültme** (arka planda indirme); **otomatik save yedekleme** ve **zamanlanmış otomatik güncelleme** (Ayarlar); **"En Çok Oynadıklarınız"** (profil). Yeni: **launcher otomatik güncelleme** (Tauri updater + GitHub Releases `latest.json`, imzalı paketler; Ayarlar > Sistem kartı, açılışta + pencere odağında saatlik kontrollü kontrol, sessiz indirme, oyun indirmesi/oyun oturumu sürerken kurulumu erteleme) — `src/features/updates/update-manager.ts`, `.github/workflows/release.yml`; detaylı sürüm adımları için §10. Çalışma günlüğü: `docs/CHANGELOG_INTERNAL.md` §79–169.

---

## 1. Proje Nedir?

Epic Games kütüphanesini yöneten, yüksek performanslı, **PlayStation 5 konsol estetiğine sahip alternatif masaüstü launcher** (Windows x86_64).
`legendary` CLI'ı (GPL-3.0, harici binary) Rust backend ile sarar; arayüz Vite 6 + TypeScript (vanilla).
Epic Games Store'un kendisi gömülü webview (`add_child`) ile uygulama içinden açılır.

## 2. Teknoloji Yığını & Sürümler

- **Tauri v2** (`tauri 2.x`, `features = ["unstable"]` — gömülü mağaza child webview için şart)
- **Rust stable** (MSVC toolchain, Windows) + **Node 20+**
- **Frontend:** Vite 6 + TypeScript 5.6 (vanilla, framework yok) + `lucide` (statik header için; dinamik içerikte inline SVG kullanılır)
- **Backend:** `serde/serde_json`, `thiserror`, `tokio` (fs, io-util, process, rt, time), `reqwest` (rustls, stream), `url`
- **Hedef Platform:** Windows 10/11 x86_64 (`custom-protocol` açık)

## 3. Zorunlu Komutlar & Çalıştırma

```powershell
npm.cmd run tauri dev      # Tam uygulama geliştirme modu (Windows PowerShell için npm.cmd şart!)
npm.cmd run build          # tsc --noEmit && vite build (frontend tip kontrolü ve doğrulama)
cargo check                # Hızlı Rust backend doğrulama
cargo test                 # Rust birim testleri (yeni mantık/komut eklendiğinde test eklemek ŞART)
```

- **ÖNEMLİ:** PowerShell execution policy sebebiyle `npm` yerine daima **`npm.cmd`** kullanılır.
- PATH bayatsa `$env:USERPROFILE\.cargo\bin` başa eklenir.

## 4. Temel İş Akışı & Disiplin Kuralları

1. **ZORUNLU 1 NUMARALI ÖNCELİK: OPTİMİZASYON, AKICILIK & DÜŞÜK KAYNAK:** Bu projenin resmi Epic Launcher'a karşı en büyük varoluş sebebi **yüksek performans, 120 FPS akıcılık, sıfır takılma ve düşük bellek (RAM/VRAM) tüketimidir**. Her yeni özellik, ekran veya algoritma tasarlanırken 1 numaralı kıstas performanstır. 500+ oyunluk kütüphanede milisaniyelik gecikmelere, O(N²) döngülere, gereksiz DOM reflow/thrashing tetiklemelerine veya arka planda dönen CPU/GPU yüklerine ASLA izin verilmez.
2. **ZORUNLU TEMİZLİK & ARTIK KOD/DOSYA BIRAKMAMA (Dead Code Elimination):** Proje GitHub'da açık kaynak ve AI modelleri için her daim "temiz, hafif ve anlaşılır" kalmalıdır. Tek seferlik analiz araçları, test scriptleri (`tools/`, geçici `.mjs`/`.py` dosyaları), kaldırılan özelliklere ait ölü CSS'ler, kullanılmayan tipler veya atıl fonksiyonlar repoda ASLA bırakılmaz. İşi biten geçici her dosya derhal silinir.
3. **ZORUNLU KURAL (Kullanıcı Talimatı):** Her işlem/görev bittiğinde mutlaka yapılanlar `AGENTS.md` dosyasına özetlenmeli ve ardından `git commit` atılmalıdır.
4. **ZORUNLU TASARIM KURALI (Tek Tasarım Dili):** Masaüstü arayüzü **Hydra düzenidir**: sabit sol kenar çubuğu, ince pencere çubuğu, sade kapak ızgarası, tam sayfa oyun ekranı, **gerçek siyah** yüzeyler ve **tek vurgu rengi** (`--accent #ffffff`). Tüm token ve bileşenler **yalnızca** [`docs/DESIGN_SYSTEM.md`](./docs/DESIGN_SYSTEM.md) içinden gelir; ekran başına yeni buton/kart stili yazılmaz. Apple/PS5/Xbox/App Store taklidi yasaktır (kapalı beta "AI kokuyor" geri bildiriminin kök nedeni buydu). Tam ekran Login sayfası yoktur; her mağaza Hesaplar'dan bağlanır.
5. **KONTROLCÜ KURALI (Ayrı TV Modu):** Kumanda/koltuk deneyimi masaüstü arayüzüne karıştırılmaz; ayrı tam ekran **TV Modu**'nda yaşar (`src/features/gamepad/tv-mode.ts`, A: Seç, B: Geri, LB/RB: Raf). Masaüstü ekranları fare/klavye önceliklidir; yine de her etkileşimli öğe klavyeyle odaklanabilir ve `:focus-visible` vurgu halkası taşır.
6. **"AI TASARIMI GİBİ DURMASIN" KURALI:** YASAKLAR: Mor→indigo→cyan dekoratif gradyanlar, neon parlama (`box-shadow glow`), gradyan metin (`background-clip: text`), her öğeyi tam yuvarlak kapsüle (`999px`) çevirmek, cam/blur katmanlarının gereksiz tekrarı ve süs amaçlı mikro animasyonlar (ikon sallama, pulse). Renk yalnızca DURUM bildirir (yeşil = çevrimiçi, amber = çevrimdışı/güncelleme, kırmızı = sayaç/hata).
7. **DENGE KURALI:** Hedef **sade ama karakterli**. Karakter şu dört kaynaktan gelir: tek kaynaklı bağlamsal ışık, yüzey/derinlik dili, tipografik ses, tek özgüvenli vurgu rengi.
8. **DOSYA BOYUTU & MODÜLERLİK KURALI:** Hiçbir kaynak dosya **~1.500 satırı** geçmez. Geçen dosya sorumluluğu tek olan modüllere bölünür. Yeni özellikler doğrudan ilgili `src/features/<ad>/` modülüne yazılır; `main.ts` yalnızca bootstrap + ince orkestrasyon olacak şekilde küçültülür. Detaylı plan: [`docs/REFACTOR_PLAN.md`](./docs/REFACTOR_PLAN.md).
9. **İNGİLİZCE YORUM KURALI (English-Only Comments):** Tüm kod yorumları **yalnızca İngilizce** ve açıklayıcı yazılır (proje harici inceleyiciler, örn. Epic Games çalışanları, tarafından okunacaktır). Anlamsız/kopyala-yapıştır yorum yasaktır. Kod taşındıkça veya düzenlendikçe mevcut Türkçe yorumlar da İngilizce'ye çevrilir. Format:
   ```ts
   // Explain why this exists and any non-obvious tradeoff.
   ```
10. **DÜŞÜK DONANIM & YAVAŞ AĞ TABANI (Zorunlu Performans Sözleşmesi):** Efxlve Launcher'ın varlık sebebi, resmi Epic Games Launcher'ın "oyuncuyu düşünmeyen, optimizasyondan uzak kod yığını" olmasına karşı çıkmaktır. **Referans taban donanım: 8 GB RAM + Intel i5 (5. nesil) + entegre GPU + HDD + yavaş internet.** Bu taban donanımda launcher **akıcı** kalmalı; sadece bir indie oyun oynamak isteyen kullanıcı "bilgisayar can çekişiyor" hissini ASLA yaşamamalıdır. Zorunlu pratikler:
    - **Boşta sıfır yük:** Arka planda daimi çalışan `requestAnimationFrame` döngüsü, yoklama (polling) veya CSS animasyonu bırakılmaz. Döngüler yalnızca aktif etkileşim/gamepad bağlıyken çalışır ve iş bitince durur.
    - **Bellek/VRAM disiplini:** 500+ oyunluk kütüphanede tüm kapak görselleri DOM'a basılmaz (`loading="lazy"` + progressive chunk zorunlu). `backdrop-filter`, büyük gölge ve çok katmanlı blur düşük donanımda yasaktır (Kural §6.13).
    - **Yavaş ağ önceliği:** Arayüz daima disk önbelleğinden anında açılır; hiçbir ağ isteği UI'yi bloklayamaz. Görsel/varlık istekleri tembel ve iptal edilebilir olur; başarısız ağ UI'yi kilitlemez (Heroic Prensibi, §5).
    - **Kademeli yükleme:** İlk boyama (FCP) için kritik olmayan her şey (kupa özetleri, HLTB, eleştirmen skorları, DLC listesi, ekran görüntüleri) talep üzerine ve sekme açıldığında yüklenir.
    - **Görsel modernlikten ödün yok:** Bu optimizasyonlar UI kalitesini düşürmez; PS5 konsol estetiği, ferah kartlar ve akıcı geçişler korunur. Performans ve estetik birlikte zorunludur.

## 5. Mimari & Veri Akışı Prensibi

- **Heroic Prensibi:** Arayüz ÖNCE disk önbelleğinden anında okunur (`epic_cached_library`), ağ senkronu (`epic_list_games`) arka planda sessizce yürütülür. Ağ başarısız olsa bile arayüz kilitlenmez, önbellek korunur. Asla tüm kütüphaneyi tek `list` çağrısına bağlama.
- **Modüler Yapı (hedef mimari — [`docs/REFACTOR_PLAN.md`](./docs/REFACTOR_PLAN.md)):**
  - `src/core/`: `types.ts`, `constants.ts`, `utils.ts`, `icons.ts`, `i18n.ts`, `state.ts`, `dom.ts`, `toast.ts`, `render.ts`, `selectors.ts`, `game-view.ts`, `nav.ts`, `recent.ts`, `epic-actions.ts`, `collection-icons.ts`, `window.ts`; `epic.ts` (API/Invoke barrel) ✅.
 - `src/features/`: `library/`, `drawer/`, `profile/`, `downloads/`, `gamepad/` (+ `tv-mode.ts`), `palette/`, `store/`, `settings/`, `screenshots/`, `collections/`, `move-game/`, `dlc/`, `manage/`, `cover/`, `playtime/`, `onboarding/`, `context-menu/`, `events/` ✅.
 - `src/styles/`: 11 CSS + `index.css` (tokens, components, shell, library, game-page, downloads, settings, profile, modals, auth, tv-mode) ✅.
  - `src/locales/`: 15 dil JSON'u ✅.
  - `src-tauri/src/legendary/`: `cache`, `client`, `commands`, `downloader`, `models`, `move_game`, `playtime`, `profile`, `screenshots`, `skip`, `steamgrid`, `transfers`.

## 6. Kanla Öğrenilmiş Altın Kurallar (OKUMADAN KOD YAZMA)

1. **Tauri argümanları camelCase'tir!** Rust'ta `app_name: String` → JS'te `{ appName }` gönderilir. Çok kelimeli parametrelerde isim uyuşmazlığı sessizce patlar.
2. **legendary stdout/stderr ayrımı:** `--json` çıktılar **stdout**'a saf JSON olarak gelir; loglar ve **indirme ilerlemesi (`= Progress: NN%`, `Downloaded:`) STDERR**'dedir.
3. **`user.json` ile anında oturum kontrolü:** `list`/`status --offline` bile metadata senkronu yapar. Oturum kontrolü için subprocess yerine `user.json` varlığını + `displayName`'i diskten oku.
4. **Epic 401'leri geçici sanma:** Kaldırılmış katalog öğeleri KALICI 401 verir. `skip.rs` otomatik atlar (stub metadata + `skipped.json`).
5. **`#[serde(default)]` null'ı kurtarmaz!** legendary `manifest_path: null` gönderir → `deserialize_with = "null_string"` (models.rs) şarttır.
6. **Modal içinde `onclick="stopPropagation()"` YASAK:** Belge düzeyindeki event delegation'a tıklama ulaşmaz, kutudaki butonlar ölür.
7. **Gömülü Mağaza = Native Child Webview (`unstable` + `add_child`):** `X-Frame-Options` nedeniyle iframe imkansızdır. Pencere boyutlandığında Rust `tauri::WindowEvent::Resized` OS kancasıyla boyut senkronize edilir.
8. **Auth Akışı:** `https://legendary.gl/epiclogin` → `authorizationCode` → `auth --code` veya EGL'den `auth --import`.
9. **Kurulum Bayrakları:** `-y install <app> --base-path <dir> --skip-dlcs --skip-sdl` (`-y` daima en başta; yoksa DLC sorusu süreci kilitler).
10. **Frontend Render Disiplini (Rule 15):** İlerleme event'lerinde veya arka plan IPC mesajlarında tüm görünümü ASLA YENİDEN ÇİZME. Sadece ilgili buton (`[data-dlbtn]`) ve bar (`[data-dlbar]`) elemanlarını güncelle. Arama kutusu odaktayken full render yapma. Kütüphanede `game-status`, indirme bitiş/iptal, `refreshGameActionUi` ve ücretsiz oyun gelişi `viewEl.innerHTML = renderEpic()` çağırmaz — `patchLibraryCardDom` kullan.
11. **Progressive Chunk Rendering:** 488+ oyunluk kütüphanede 7.300+ DOM elemanını aynı anda basma. Başlangıçta ilk 48 kart çizilir, `#lib-scroll-sentinel` üzerinde çalışan `IntersectionObserver` ile kaydırdıkça sonraki 36'şar kart eklenir. Arama girdisi 120ms akıllı debounce ile korunur.
12. **Algoritmik O(1) Sorgu Zorunluluğu:** `epicSummaries` veya `epicGamesRaw` üzerinde her render'da linear `.find()` / `.some()` arama YAPMA. `epicSummariesMap` ve `epicGamesRawMap` hash map'leri ile `rawOf` ve `summaryOf` O(1) tutulur.
13. **GPU / VRAM Compositing Disiplini:** Yinelenen kartlarda `backdrop-filter: blur(...)` ve `transform: translateZ(0)` YASAKTIR. Koyu opak obsidian yüzeyler kullanılır; donanımsal katman ayrımı yalnızca `:hover` anında aktifleştirilir.
14. **Sıralama Performansı:** `list.sort` içinde `localeCompare` her adımda çağrılmaz; global `trCollator = new Intl.Collator("tr")` örneği kullanılır.
15. **Son Oynanan Disiplini:** `pushRecent(appName)` YALNIZCA oyun gerçekten başlatıldığında çağrılır; detay modalı açıldığında çağrılmaz.
16. **3. Parti Başlatıcılar (EA / Ubisoft):** `legendary list -T --json` (`--third-party`) bayrağı zorunludur. EA App oyunları `link2ea://` protokolüyle başlatılır.
17. **Sıfır Reflow / Layout Thrashing:** 170ms'lik gamepad döngüsünde veya scroll dinleyicilerinde `getBoundingClientRect()` ve `getComputedStyle()` ardışık çalıştırılamaz. Görünürlük kontrolünde `offsetParent !== null` gibi hafif yöntemler kullanılır.
18. **Ölü Kod & Artık Dosya Sıfır Toleransı:** Kaldırılan veya test edilen özelliklere ait tüm yardımcı script'ler (`tools/`), geçici dosyalar, ölü CSS sınıfları ve arayüz artıkları işi bittiğinde derhal silinir. "İleride lazım olur" diye repoda ölü kod tutulmaz.

## 7. Konsol Seviyesi Profesyonellik & Katı Yasaklar (Zero-Tolerance Invariants)

Bu kurallar, projenin **Steam, PlayStation 5 veya Xbox seviyesinde** bir konsol deneyimi sunması için tavizsizdir:

1. **SIFIR EMOJİ POLİTİKASI (Zero-Emoji Policy — KESİNLİKLE YASAK):**
   - Arayüzün hiçbir yerinde (bildirimler/toast'lar, butonlar, başlıklar, etiketler, sekmeler, dil seçenekleri, koleksiyonlar) işletim sistemi emojisi (`🇹🇷`, `🌐`, `🎮`, `⭐`, `🔥`, `🚀`, `📸`, `📋`, `✨`, `⌨️` vb.) KULLANILAMAZ.
   - Her zaman net, ölçeklenebilir inline SVG vektör ikonu (`icon("camera", 16)`, `icon("globe", 16)`) veya ISO dil kodları (`TR`, `EN`) temiz tipografiyle yazılır. Emojiler platformlar arasında (Win10 vs Win11) tutarsızdır ve konsol ciddiyetini bozar.
2. **SAYISAL TİTREME ENGELLEME (Tabular Nums Zorunluluğu):**
   - İndirme hızları (`MB/s`), disk hızları, yüzdeler (`%45`), oyun süreleri, kupa sayaçları, saat veya ETA sürelerinde `font-variant-numeric: tabular-nums` ZORUNLUDUR. Orantılı (proportional) sayılar genişlik değiştirdikçe butonları ve kartları titreterek (layout jitter) son derece kalitesiz gösterir.
3. **SIFIR METİN TAŞMASI (Strict Ellipsis & Line-Clamp):**
   - Hiçbir oyun başlığı, klasör yolu veya etiket bir kartın veya ızgaranın yüksekliğini rastgele genişletemez. Tek satırlık alanlarda `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;` şarttır. Açıklamalarda `-webkit-line-clamp: 2` ile maksimum 2 satır sınırı konur.
4. **TARAYICI VARSAYILANI SIFIR TOLERANSI (No Native Browser Elements):**
   - Webview varsayılanı mavi/siyah odak halkaları (`outline: auto`), beyaz sayı okları (`input[type="number"]`), gri ham butonlar, Windows sistem scrollbar'ı veya sistem açılır kutuları (`<select>`) KESİNLİKLE YASAKTIR. Her form bileşeni PS5 dark token'larını taşır.
5. **SOĞUKKANLI KONSOL DİLİ (Microcopy Discipline):**
   - Ünlem işaretli ("Hemen Oyna!", "Süper Fırsat!", "Yedeği Geri Yükle!"), abartılı veya laubali ifadeler ("Hata çıktı :(", "Oyun silindi gitti") YASAKTIR. Konsol düzeyinde net, profesyonel sistem dili kullanılır ("Oyna", "Kur", "Doğrulanıyor…", "Yetersiz disk alanı", "Ekran görüntüsü panoya kopyalandı").
6. **YASAKLI AI / OYUNCU KLİŞELERİ (No Rainbow / Neon Glitz):**
 - Buton/yüzey gradyanları, neon gölgeler (`box-shadow glow`), gradyan metinler (`background-clip: text`), `backdrop-filter`, her öğeyi 999px hap kapsüle çevirmek YASAKTIR. Tek vurgu rengi `--accent` (`#ffffff`); yeşil/amber/kırmızı yalnızca durum bildirir.
7. **DOKUNSAL GERİ BİLDİRİM & HIZ SINIRI (Tactile Micro-Feedback):**
   - Tıklanabilir tüm bileşenlerde `:active` anında hafif basılma (`transform: scale(0.98)`) olmalı; animasyon süreleri asla 120–150ms'yi aşmamalıdır (yavaş animasyonlar arayüzü hantal hissettirir).
8. **ZARİF BOŞ DURUMLAR (Empty State Elegance):**
   - Sayfa veya liste asla kuru/kırık bir metinle boş bırakılamaz. İlgili temanın 36-40px vektör ikonu (soluk ton), net bir başlık, yönlendirici kısa bir açıklama ve birincil yönlendirme butonu bulunmalıdır.
9. **ODAK HİJYENİ:**
 - Odak halkası 2px `--accent`, 2px `outline-offset`; odaklanıldığında kartı büyütüp (`transform: scale(1.1)`) yanındaki kartları kaydıran layout shift efektleri KESİNLİKLE KULLANILAMAZ (TV Modu dahil).
10. **KÜTÜPHANE = SESSİZ KAPAK DUVARI (Library Cover Wall):**
 - Varsayılan All görünümü portre kapak ızgarasıdır (kapak + tek satır başlık); alternatif olarak yoğun liste görünümü vardır. Cam ray, S/M/L hapı, istatistik kapsülü, sinematik Free Games/Recent rafları ve her karta **Kurulu** rozeti YASAKTIR; yüklü olmayan oyunlar rozet yerine hafif soluk kapakla ayrılır (Steam kuralı).
 - Rozet yalnızca Update / Running / indirme çubuğu içindir. Hover: tek birincil eylem. Cam, glow, kart lift/zoom yok. Kartlarda `contain: layout paint` kaldırılamaz (ölçülmüş performans kuralı).
    - Ücretsiz oyunlar bir filtre sekmesidir, ızgaranın üstünde raf değildir. Apple + PS5 + Steam dilini tek ekranda istiflemek "AI UI"dir; geri getirme.

---

## 8. Ek Dokümantasyon Referansları

- **Detaylı Sistem Mimarisi:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Yol Haritası & Aktif Görevler:** [`docs/ROADMAP.md`](./docs/ROADMAP.md)
- **Kod Tabanı & Sembol Haritası:** [`docs/CODEBASE_MAP.md`](./docs/CODEBASE_MAP.md)
- **PlayStation 5 Console Dark Tasarım Sistemi:** [`docs/DESIGN_SYSTEM.md`](./docs/DESIGN_SYSTEM.md)
- **Tauri IPC & Backend Komut Referansı:** [`docs/TAURI_IPC_REFERENCE.md`](./docs/TAURI_IPC_REFERENCE.md)
- **AI Geliştirici & Mental Model Rehberi:** [`docs/AI_DEVELOPER_GUIDE.md`](./docs/AI_DEVELOPER_GUIDE.md)
- **Tarihçe & Geçmiş Sürüm Günlükleri (Bölüm 1–78):** [`docs/CHANGELOG_INTERNAL.md`](./docs/CHANGELOG_INTERNAL.md)

## 9. Son Çalışma Özeti

- **Sürüm 0.1.3:** Hydra kabuğu, ikon, ayarlar ve bulut kayıt düzeltmeleri `v0.1.3` etiketiyle yayınlanır.
- **Kenar çubuğu:** oyun sayfası açıkken bölüm ve oyun aynı anda beyaz çizgi taşımaz. Çizgi yalnızca açık oyundadır.
- **Bulut kayıt:** oyun kapanınca `legendary -y sync-saves` gerçek ayardan çalışır (varsayılan açık). Eski kod hiç yazılmayan bir dosyaya bakıp senkronu atlıyordu. Kayıt klasörü olmayan oyunda yerel yedek bildirimi basılmaz.
- **Ayarlar > Hesap:** hesap satırı ile düğmeler ayrı. Liste üstte; Yeni hesap ve çıkış alt satırda. Oturum açıkken kenar çubuğu hâlâ profili açar.
- **Discord Rich Presence:** durum metninin yanında launcher ikonu, açık oyunun kapağı ve oynarken geçen süre gider. Discord kapalıysa worker sessizce bekler.
- **Ayarlar > Hakkında:** kimlik kartı uygulama ikonunu (`128x128@2x.png`) gösterir. Tanıtım metninden konsol ve PS5 ibaresi çıkarıldı. Gizlenen oyun yokken hayalet ikonu ve kısa bir espri gösterilir.
- **Ayarlar:** Discord Rich Presence varsayılan açık ve sabit uygulama kimliği kullanır; kimlik kutusu yok. Gezinme düğmeleri ayarı kaldırıldı. Oyun kapanınca kayıt yedeği varsayılan açık. Kurulu başlatıcı sürümündeki bozuk ayraç düzeltildi.
- **Ayarlar > İndirmeler:** CDN marka seçici kalktı. Satır "İndirme sunucusu": Otomatik veya "En hızlısını bul". Hız profili "En yüksek / Dengeli / Düşük"; worker sayısı arayüzde yok.
- **Uygulama ikonu:** siyah zemin, beyaz oyun kolu, hafif parlama. `src-tauri/icons` (ico, icns, png) paket ikon listesinden gelir. Görev çubuğu ve tepsi, `tauri dev` yeniden derlendikten sonra güncellenir.
- **Kısayol ve yedek:** yüklü olmayan oyunda sağ tık menüsünde masaüstü kısayolu yok. Yedekleme hataları `@t:` anahtarı yerine çevrilmiş metin gösterir.
- **Oyun gizleme:** kütüphane sağ tık ve Yönet sekmesinden gizlenir. Ayarlar > Gizlenen oyunlar listesinden geri açılır. Gizli oyunlar ızgara, arama ve kenar çubuğunda görünmez.
- **Kapak bilgisi:** ızgara kapaklarının sol üstünde süre ve başarım (`18/42`). Tamamlanan başarımlar beyaz rozet. Ayarlar > Görünüm’den kapanır, varsayılan açık.
- **Kütüphane sıralaması:** buton "Sırala" + seçili değer. Menü: Başlık (A-Z), Son oynanan, En çok oynanan, Başarımlar, Yüklü önce, Başlık (Z-A). Güncelleme ve platin sıralaması kalktı.
- **Kütüphane:** satırda 6 portre. Hover kapağı büyütür; beyaz kenar çizgisi yok, parlama çok hafif.
- **Kabuk:** kenar çubuğunun sağında ve sayfa başlığının altında ince beyaz kılavuz çizgisi. Alt durum çubuğu (indirme notu ve sürüm) yok.
- **Yönet:** kurulu olmayan oyunda yalnızca kapak değiştirme ve oynama süresi. Kayıt ve başlatma bölümleri kurulu oyunda. EA, Ubisoft ve Rockstar kayıtları kendi sistemlerini kullanır.
- **Oyun sayfası:** hero 440px. Oyun Hakkında metni sol kolonu doldurur. Üst çubukta ve hero'da yalnızca geri düğmesi var.
- **Açılış:** stil yüklenene kadar kabuk gizlenir. Kenar çubuğu "Son Oynananlar" başlığı 15px; liste 7 oyuna son oynananlarla, yetmezse rastgele yüklü oyunlarla dolar.
- **Oyun sayfası temizliği:** Kurulu rozeti, kupa ilerleme kutusu ve medya galerisi kaldırıldı. Koleksiyon etiketleri başlığın altına alındı. Hero 460px. Üst çubukta geri/ileri her zaman görünür; hero üzerindeki "Kütüphane Esc" kalktı.
- **Kütüphane başlığı sadeleşti:** büyük "Kütüphane" ve ikinci arama kutusu kaldırıldı; oyun sayısı üst çubukta. Güncelleme sekmesi kütüphaneden silindi; bekleyen güncellemeler İndirmeler sayfasında ve kenar çubuğu rozetinde.
- **Hydra siyah/beyaz + oyun sayfası + Login kaldırma:** `--bg #000`, `--accent #fff`. Oyun sayfası Hydra düzeni (geniş hero, oynama satırı, iki kolon, sağda başarım/istatistik/HLTB/kontrolcü). Tam ekran Login yok; Hesaplar sayfasında mağaza konektörleri (Epic + GOG yakında). Tek seferlik `page-in` / `fade-in` (boşta döngü yok, `prefers-reduced-motion` kapatır). `creationDate` IPC'de tutuluyor (yayın tarihi).
- **Tam UI yeniden tasarımı (kapalı beta "AI kokuyor / kullanışsız / yavaş" geri bildirimi):** Sorunun kökü tek tek renkler değil, her ekranın başka bir markayı taklit etmesiydi (PS5 profil, Apple üst bar, App Store indirmeler). Tek tasarım diline geçildi (`docs/DESIGN_SYSTEM.md` baştan yazıldı; `AGENTS.md` §4.4–4.6, §7.6, §7.9–7.10 güncellendi).
 - **İskelet:** `#titlebar` + orta sekme rayı kaldırıldı; sol kenar çubuğu (logo, Ctrl+K arama, Kütüphane/Mağaza/İndirmeler, kurulu oyunlar listesi, profil/bildirim/ayarlar) + 36px pencere çubuğu (geri/ileri, çevrimiçi, pencere düğmeleri). Kenar çubuğu oyun listesi yalnızca üyelik/durum imzası değişince yeniden çizilir.
 - **Mağaza webview:** konum artık kenar çubuğu/pencere çubuğu ofsetlerinden gelir; Rust `store_bounds` + `STORE_INSET_*` saklanır, gizli mağaza yeniden boyutlandırmada ekrana dönmez (2 yeni birim testi, 65/65).
 - **Kütüphane:** başlıklı kapak ızgarası, liste görünümü (başlık, stüdyo, süre, boyut, eylem), metin sekmeler, ortak boş/hata durumları; ölü raf/hero/kart boyutu/koleksiyon açılır menüsü durumu ve işleyicileri silindi.
 - **Oyun sayfası:** çekmece yerine kenar çubuğunun yanında tam sayfa (hero, tek büyük birincil eylem, satır içi istatistikler, metin sekmeler). "Yönet" sekmesi `features/manage`'e taşınıp liste satırlarıyla yeniden kuruldu; yerinde yenileme artık eylem çubuğunu da günceller; `.find()` aramaları `summaryOf` ile O(1).
 - **İndirmeler / Ayarlar / Profil / Giriş / modallar:** hepsi aynı bileşenlerde. İndirmelerdeki kopya ayar paneli Ayarlar'a yönlendirmeye dönüştü (hız birimi ve "oynarken duraklat" Ayarlar > İndirmeler'e taşındı). Profilde **uydurma Altın/Gümüş/Bronz sayıları kaldırıldı** (yalnızca gerçek toplamlar). Giriş ekranı: form paneli + hareketsiz arka plan. Tüm modallar tek ortak çerçevede (`modals.css`).
 - **Yeni:** Ctrl+K komut paleti (`features/palette/palette.ts`), ayrı TV Modu (`features/gamepad/tv-mode.ts`; A oyna, X detay, LB/RB raf, B çık; kumanda bağlanınca öneri).
 - **Ölü kod:** ulaşılamayan DLC yöneticisi görünümü, sekme/koleksiyon kaydırma okları, kalp animasyonu, zorunlu reflow'lu sekme animasyonu, 101 kullanılmayan çeviri anahtarı (1.274 → 1.173, tr/en tam eşlik).
 - **Ölçüm (500 oyunluk sahte kütüphane, aynı koşullar, 5 sn kaydırma):** eski 88 FPS / 50 kare >20ms / en kötü 111ms → yeni 174 FPS / 2 kare >20ms / en kötü 22ms. Boşta 3 sn: 0 rAF, 0 timer, 0 interval. JS paketi 548 → 476 KB.
 - Doğrulama: `npm.cmd run build`, `cargo test` (65/65).

- Kapalı beta sonrası kütüphane **sessiz Steam/Epic kapak duvarına** çekildi: düz metin filtreler (Tümü / Yüklü / Favoriler / Koleksiyonlar / Ücretsiz Oyunlar + Güncellemeler yalnızca count > 0), tek sayı (oyun adedi), sabit arama, tek sıralama. Apple cam ray, Ctrl+F rozeti, S/M/L ve istatistik kapsülü kaldırıldı.
- Kartlar dinlenme halinde yalnızca kapak; rozet yalnız Update/Running; hover başlık + tek eylem. Kurulu rozeti, micro-chip HUD, ikon kümesi, kart lift/glow yok.
- Varsayılan All üstündeki Free Games + Son Oynananlar rafları kaldırıldı; ücretsiz oyunlar filtre ızgarası. Titlebar `backdrop-filter` kaldırıldı (opak `#0a0c12`).
- Performans: `epicVisibleSummaries` + collator önbelleği; `patchLibraryCardDom` ile game-status / indirme bitiş / action UI; tam `renderEpic()` chunk'ı 48'e sıfırlar; gamepad ızgara index + boşta 80ms poll.
- Rockstar oyunlarında üçüncü parti launcher bilgisi gösterilmeye devam eder.
- Rockstar oyunlarının kurulum ve başlatma eylemleri Epic akışında tutulur; EA/Ubisoft gibi gerçek harici akışlar değişmez.
- Ortak kütüphane, drawer ve kurulum eylemi kararları `requiresThirdPartyLauncher` ile tek kurala bağlandı.
- Aktif indirme butonları yüzde durumunu gösterir, tıklanınca İndirmeler görünümüne geçer.
- Duraklatılan indirme süreci temizlendikten sonra devam ettirilir; eski süreç aktifken yeniden başlatma yarışı engellendi.
- Ağ hızı satırı eksik olduğunda indirilen byte farkından hız hesaplanır; güncelleme eylemi ana lavanta buton stilini kullanır.
- Aktif indirme varken pencere kapatma ve tepsi çıkışı uygulamayı sonlandırmaz; launcher tepsiye gizlenerek indirmeyi canlı tutar.
- Güncelleme eylemi, ana mor yerine dengeli amber/sarı ton kullanır.
- İndirme hızındaki kısa örnek sıçramaları minimum örnek aralığıyla bastırılır; UI/backend kimlik ayrışmasında iptal gerçek aktif sürece uygulanır.
- Aktif indirme isteği disk üzerinde saklanır; launcher yeniden açıldığında Legendary parçalı indirmeden otomatik devam eder.
- Aktif indirme kimliği yeniden bağlanmadan iptal istenirse bekleyen kayıt da temizlenir; İndirmeler görünümünde kurulu oyunlar rafı gösterilir.
- Ağ hızı satırı eksik olduğunda progress ve toplam byte farkından hız hesaplanır; disk hızındaki kısa örnek sıçramaları bastırılır.
- İptal edilen ve henüz kurulmamış oyunların partial kurulum klasörü temizlenir; mevcut kurulu oyun güncellemeleri korunur.
- Ücretsiz oyun rafı Epic'in resmi mevcut ve yaklaşan `freegames` promosyonlarını gösterir; mobil promosyonlar ve mobil-only oyunlar PC kütüphanesine alınmaz.
- Yaklaşan ücretsiz oyun pencereleri tüm promosyon gruplarından en erken gerçek başlangıç tarihini seçer; hesapta bulunan ücretsiz oyunlarda `Kur`/`Oyna` eylemi gösterilir.
- Yaklaşan ücretsiz oyunlarda `Kur`/`Oyna` ve `Detay` eylemleri, mağaza bağlantıları launcher içindeki Epic webview'a yönlendirilir.
- Mağaza sayfaları için başlık tahmini yerine Epic katalogundaki gerçek `pageSlug` kullanılır; fallback yalnızca metadata eksikse devreye girer.
- Mağaza sayfası slug eşleştirmesinde hem `catalogNs.mappings` hem doğrudan `offerMappings` biçimleri desteklenir; fallback yalnızca metadata eksikse arama sayfasına gider.
- Gelecek iş: hesap profili için `account switcher` desteği ekle.
- Gelecek iş: bildirim merkezini kapsamlı biçimde genişlet; oyun güncellemeleri, tamamlanan indirmeler, istek listesindeki indirimler ve ön siparişe açılan oyunlar için bildirimler ekle.
- Aktif indirme kimliği, generation ile izlenir; eski monitor yeni sürecin kuyruğunu/persistence kaydını bozamaz.
- Kuyruk öğeleri install tag ve install klasörünü korur; öncelikli indirme ve restart sonrası sıra metadata ile sürdürülür.
- DLC/otomatik güncelleme kuyruğa eklendikten sonra UI kuyruk durumu ve indirme badge'i backend ile yenilenir.
- Kod haritası (`docs/CODEBASE_MAP.md`) modüler mimariye (`src/core/`, `src/features/`, `src/styles/`, `src/locales/` ve yeni Rust backend modülleri) uygun şekilde senkronize edildi.
- Launcher genelindeki aksiyon butonları Cyberpunk detay sayfasındaki PS5 safir mavisi Oyna, buzlu obsidyen Kur, rafine altın Güncelle ve koyu safir Oynanıyor token'larına bağlandı.
- Kütüphane minimalist Konsol Hibriti (Grid + Shelves) olarak yeniden inşa edildi: Spotlight, List View, Studio filtresi ve görünüm değiştirici butonlar kaldırılarak ölü kodlar temizlendi; varsayılan görünümde üstte hızlı raflar (Ücretsiz Oyunlar + Son Oynananlar) ve hemen altında tam Kütüphane Izgarası birleştirildi; filtre/arama anında saf ızgaraya odaklanma sağlandı.
- Aksiyon butonları ("Kur" / "Install" ve "Güncelle" / "Update") baştan tasarlandı: Kur butonu saf porselen beyazı (`#ffffff`) ve tok tipografiyle net ve lüks bir Apple Arcade kontrastına kavuşturuldu; Güncelle butonu canlı elektrik amberi (`#f59e0b` → `#d97706` gradyan) ve ışıma ile Cyberpunk detay sayfasındaki safir mavisi Oyna butonuyla mükemmel bir uyum yakaladı.
- Kütüphane araç çubuğu Apple Precision tasarım diline dönüştürüldü: Dağınık tekil haplar yerine tek parça cam Segmented Rail (`.apple-segmented-rail`) `[ Tümü | Yüklü | Favoriler | Platin | Güncellemeler | Koleksiyonlar ]`, Apple Spotlight tarzı 40px arama kapsülü (`Ctrl+F` rozeti ile), Apple sıralama kapsülü ve Apple mini-segmented S/M/L boyut seçiciye geçildi.
- Ücretsiz Oyunlar (Free Games) rafı 16:9 sinematik afiş formatına dönüştürüldü: Alttaki kaba gri kutu ve sıkışık alanlar kaldırılarak görsel tam afişe yayıldı, alt sinematik vignette üstüne oyun başlığı, bitiş tarihi ve sahip olunan oyunlar için kompakt porselen Kur / safir Oyna butonu bindirildi.
- Son Oynananlar (Recently Played) rafına S / M / L boyut duyarlılığı kazandırıldı: Hardcoded 170px genişlik kaldırılarak `.shelf-section.size-compact` (145px / 270px hero), `.size-normal` (180px / 330px hero) ve `.size-large` (225px / 410px hero) sınıfları ile toolbar boyut seçicisine bağlandı.
- Koleksiyonlar (Collections) görünümü baştan aşağı Apple & Steam Klasör Galerisi Izgarasına dönüştürüldü: Yatay sonsuz kaydırma rafları kaldırılarak, her koleksiyon 2x2 oyun afişi kolajı, sayaç rozeti, ikon ve düzenleme butonu içeren lüks klasör kartı olarak tasarlandı; klasöre tıklandığında kütüphane ızgarasında Apple breadcrumb gezinmesiyle (`← Koleksiyonlar / Hikaye (69 Oyun)`) tüm oyunlar tam ekran listelenir.
- Buton renk hiyerarşisi konsol disiplinine göre hizalandı: Oyna butonu canlı zümrüt yeşili (`#10b981` → `#059669`) gradyan ve yeşil ışıma, Kur ve Güncelle butonları safir mavisi (`#2563eb` → `#1d4ed8`) gradyan ve beyaz metin, İndiriliyor butonu elektrik çivit mavisi (`#6366f1` → `#4f46e5`) olarak eşitlendi; detay sayfasındaki metin kontrastı düzeltildi.
- Ücretsiz Oyunlar rafında tarihin yanındaki mükerrer "soon" ibaresi temizlendi.
- Kütüphane "Tüm Oyunlar" başlık ikonu mavi renkten mor (`var(--primary, #8b5cf6)`) renge çevrildi.
- Apple arama kapsülü 245px (odakta 290px) genişliğe çıkarılarak yer tutucu metnin kesilmesi engellendi.
- Koleksiyon kartı hover durumundaki beyaz çizgi hatası düzeltildi: Asimetrik 2 satırlı ızgara yerine tüm kart kolajlarında dikey esnek poster şeritlerine geçildi, görsellerin yatayda kırpılması ve alttan beyaz taşması engellendi.
- Koleksiyon galerisi başlığındaki mükerrer mavi "+ Yeni Koleksiyon Oluştur" butonu kaldırıldı (ızgaradaki kart zaten bu işlevi görüyor).
- Kütüphane araç çubuğu Segmented Rail'de "Koleksiyonlar" sekmesi doğrudan "Tümü" sekmesinin sağına taşındı.
- Kütüphane arama yer tutucu metni hem İngilizce hem Türkçe için sadeleştirildi ("Search..." / "Ara...").
- Sıralama butonu ve açılır menüsü dinamik `getSortOptions()` fonksiyonuna bağlanarak dil değişimlerinde İngilizce/Türkçe senkronizasyonu sağlandı.
- Üst gezinme çubuğu (Store, Library, Downloads, Profile ve sağ kontroller) Apple Precision Frosted Glass tasarım diline dönüştürüldü: `index.html` içindeki eski geçici stil kalıntıları temizlendi, `#titlebar`, `.nav-seg`, `.nav-tab`, `.net-chip`, `.nav-icon-btn` ve download badge ince cam kapsül estetiğine kavuşturuldu.
- Üst gezinme çubuğuna opsiyonel İleri/Geri (Back/Forward) geçmiş gezinmesi eklendi: Varsayılan olarak kapalıdır (`false`), Ayarlar > Görünüm sekmesinden açılabilir. Görünümler (Store, Library, Downloads, Profile, Settings), oyun detay modalları, klavye (`Alt+Sol Ok` / `Alt+Sağ Ok`) ve fare yan butonları (3 ve 4) ile tam senkronize çalışır.
- Üst gezinme çubuğu Apple Tripartite (Üç Parçalı) mimariye dönüştürüldü: 56px başlık çubuğu yüksekliğine uygun 40px/32px segmented rail, 36px kontrol butonları, 13.5px yüksek kontrastlı tipografi ve 17px SVG ikonlarla okuma zorlukları giderildi. Sol tarafta logo ve opsiyonel ileri/geri butonları, merkezde yalnızca ana görünümler (`[ Mağaza | Kütüphane | İndirmeler ]`), sağ tarafta ise ağ durumu, bildirim merkezi, hesap profil kapsülü (`#account`), ayarlar ve pencere kontrolleri konumlandırıldı.
- Üst bar sağ kümesinde profil hapı (`#account`) doğrudan Çevrimiçi rozetinin sağına taşındı; Bildirim Zili ile Ayarlar butonu yan yana konumlandırıldı.
- İndirmeler sayfası otantik Apple (macOS App Store) tasarım diline dönüştürüldü:
  - Yapay zeka klişesi olan sahte istatistik kutuları, mükerrer butonlar ve neon ışıltılar tamamen kaldırıldı.
  - İndirme olmadığında ferah, merkezlenmiş, sakin Apple Boş Durum (`.apple-idle-hero`, 60px cam indirme ikonu, net tipografi ve saf porselen "Kütüphaneyi Aç" butonu) uygulandı.
  - Alttaki kaba kart ızgarası yerine, macOS App Store Güncellemeler standardında tek parça zarif Apple Gruplanmış Liste (`.apple-grouped-list`, saç teli inceliğinde ayraçlar, 38x50px posterler, kompakt Apple hap "Oyna" butonu) ile güncel/kurulu oyunlar listelendi.
- İndirme iptali sırasında diske inen kısmi kurulum dosyalarının silinmeme sorunu çözüldü (`transfers.rs`): Legendary'nin `customAttributes.FolderName` ve temizlenmiş `title` katalog isimlerine göre klasör adlandırması yapması tespit edildi; `cleanup_partial_install` katalog meta verilerini tarayacak, mevcut kurulu oyunların güncellemelerine dokunmayacak ve Windows dosya kilidi gecikmelerine karşı geri çekilme (retry) döngüsüyle temizlik yapacak şekilde güçlendirildi.
- İndirmeler sayfası başlığındaki mükerrer "Duraklat" butonu kaldırıldı; indirme kartındaki ana kontrol tekil bırakıldı.
- İndirme tamamlandığında, iptal edildiğinde veya başarısız olduğunda canlı hız grafiğinin ekranda kalması engellendi; hız geçmişi temizlendi, grafik yalnızca aktif indirme varken gösterilecek şekilde bağlandı ve arka plan sayaçları boşta sıfır yük kuralına uygun olarak durduruldu.
- İndirmeler sayfasına "Güncellemeler" (`updatesSection`) bölümü eklendi: Güncellemesi mevcut kurulu oyunlar (örn. GTA V) sürüm bilgisi (`installedVersion → latestVersion`), boyut ve doğrudan indirmeyi başlatan kehribar "Güncelle" butonuyla Apple gruplanmış listesinde listelendi.
- İndirmeler boş durumundaki (idle state) "Kütüphaneye Git" butonu aşırı parlak beyaz yerine PS5 konsol estetiğine uygun buzlu lavanta cam stiline dönüştürüldü.
- Ubisoft ve EA App oyunları için (Watch Dogs vb.) Depolama Yöneticisi ve Oyun Çekmecesi "Yönet" sekmesinde dosya taşıma ("Taşı") özelliği devre dışı bırakıldı; taşımaların oyunun kendi başlatıcısı üzerinden yapılması gerektiğini açıklayan bilgilendirici uyarı ve bildirimler eklendi.
- İndirmeler görünümündeki oyun afişleri/küçük resimleri 38x50px orijinal keskin boyutuna geri getirildi; düşük çözünürlüklü katalog ikonlarının bulanık/pikselli görünmesi engellendi.
- Üst gezinme çubuğundaki bildirim zili rozetindeki kırmızı alarm rengi kaldırıldı; yerine zarif ve sakin safir mavisi bir nokta (`#3b82f6` mavi nokta) yerleştirildi.
- İndirmeler listesindeki oyun satırlarına (afiş ve başlık) tıklanabilirlik kazandırılarak doğrudan oyun detay çekmecesini açması sağlandı.
- Oyun detay çekmecesi başlığında güncellemesi olan oyunlarda aynı anda hem "Kurulu" hem "Güncelleme Mevcut" yazması engellendi; yalnızca "Güncelleme Mevcut" rozeti gösterilecek şekilde temizlendi ve şimşek (`zap`) ikonu yerine konsol güncelleme ikonu (`refresh`) getirildi.
- İndirmeler görünümünden mükerrer "Son Tamamlananlar" bölümü kaldırıldı; indirilen veya güncellenen oyunlar doğrudan "SON YÜKLENENLER & GÜNCELLENENLER" rafının en üstüne eklenecek şekilde sadeleştirildi.
- İndirmeler sayfası "SON YÜKLENENLER & GÜNCELLENENLER" rafında güncellemesi olan oyunlarda (örn. GTA V) "Oyna" yerine kehribar "Güncelle" butonu ve güncelleme etiketi bağlandı.
- Profil görünümüne geçişte arkadaş listesinin boş kalması/yüklenmeme hatası giderildi: Router seviyesinde otomatik profil hidrasyonu (`loadFriends`) bağlandı ve önceki ağ hatalarında yeniden denemeyi engelleyen durum temizlendi.
- Profil sayfası Xbox PC App ve Steam Profil mimarisi esas alınarak baştan sona yeniden tasarlandı (İki Kolonlu Gamer Profili):
  - Sol Ana Kolon (~%68): Steam tarzı "Öne Çıkan Oyun Vitrini" (`.profile-featured-showcase`, arka plan afişi, oynama süresi, kupa ilerleme çubuğu, çevirisi eklenen "Detaylar" butonu) ve Xbox tarzı "Başarılar & Oyun İlerlemesi" (`.xbox-games-list`, kompakt posterler, kupa/XP dökümleri, yatay ilerleme çizgisi, Apple Segmented Rail ve `nowrap` arama/sıralama araçları).
  - Sağ Kenar Çubuğu (~%32): Xbox tarzı 3x3 kare afişli "Son Oynananlar" (`.xbox-recent-grid`, büyüteç hover efekti, tek tıkla çekmece açma) ve kompakt kenar çubuğu "Arkadaşlar" salonu (`.profile-friends-card`, dairesel harf avatarları, favori yıldızları, platform rozetleri, kaydırılabilir liste ve skeleton shimmer). Mükerrer olan "Kütüphane Özeti" kartı tamamen kaldırılarak arayüz sadeleştirildi.
  - Profil Hero Başlığı Steam & PS5 seviyesinde ferah ve prestijli konsol sahnesine dönüştürüldü: Aşırı sıkıştırılmış 100px şerit yerine ~200px geniş ve atmosferik sahne (`min-height: 200px`, `padding: 28px 32px`, en çok oynanan oyunun arka plan görseli) uygulandı; 82px büyük dairesel avatar, 26px tok kullanıcı adı, çevrimiçi rozeti, 3'lü alt metin (oyun sayısı, süre, toplam XP ve ID kopyalama butonu); sağ tarafta ise Seviye rozeti + XP ilerleme rayı, yenileme butonu ve 4 kademeli (Platin, Altın, Gümüş, Bronz) buzlu cam kupa tepsisi gözü yormayan net bir hiyerarşiyle konumlandırıldı.
- Profil kenar çubuğundaki Arkadaş Listesi ("Arkadaşlar") dikey olarak uzatıldı: Kütüphane Özeti'nin silinmesiyle oluşan boşluk dengelendi; liste yüksekliği 250px'den 520px'e (`min-height: 380px; max-height: 520px;`) çıkarıldı, satır ve avatar boyutları (34px) rahatlatılarak 10-12 arkadaşın rahatça listelenmesi sağlandı, skeleton yükleme sayısı 8'e güncellendi.
- `src/styles/profile.css` dosya boyutu disiplini korundu: Arkadaş listesi stilleri bağımsız `src/styles/friends.css` modülüne taşındı (`profile.css` 1460 satır, `friends.css` 174 satır; <= 1500 satır kuralı sağlandı).
- İkincil butonların (`apple-pill-btn.secondary`) istenmeyen kehribar/altın sarısı rengi PS5 buzlu lavanta/obsidyen cam stiline dönüştürüldü; "Profili Yenile", "Detaylar" ve "Arkadaş Yenile" butonları sakinleştirildi.
- Profil Hero seviye ve kupa alanı tek parça, mimari olarak simetrik ve düzenli **Gamer Prestij Kartı** (`.ps5-gamer-card`) olarak baştan inşa edildi: 38px seviye amblemi, tok seviye başlığı, anlık XP dökümü (`765 / 1.000 XP`), tam genişlikte pürüzsüz XP ilerleme rayı, üst köşede sabit yenileme butonu ve alt bölümde dikey ayraçlarla eşit dağıtılmış 4 kademeli (Platin, Altın, Gümüş, Bronz) kupa sütunları birleştirilerek dağınık/uyumsuz yerleşim tamamen giderildi.
- Hesap bazlı **Yerel Profil Fotoğrafı (Avatar)** desteği eklendi (`src/features/profile/profile-avatar.ts`): Kullanıcı avatara tıkladığında yerel dosya seçici açılır, seçilen görsel hafif ve hızlı 256x256 WebP formatına kırpılarak optimize edilir; sadece o anki Epic Games hesabına özel olarak (`S.customAvatars[accountId]`) yerel diskte saklanır, profil sahnesinde ve üst başlık çubuğu hesap çipinde (`#account`) anında gösterilir; mevcut fotoğrafı değiştirme veya varsayılana sıfırlama modalı eklendi.
- Üst başlık çubuğu (`#account`) butonundaki profil fotoğrafı senkronizasyonu tamamlandı (`src/core/nav.ts`, `src/core/state.ts`, `src/styles/base.css`): Çoklu hesap kimlikleri (`account_id`, `epicAccountId`, `epicAccount`) ile uyumlu `getCustomAvatar()` çözücüsü eklendi; dairesel 24px taşma koruması ve `object-fit: cover` ile piksellenme/sığmama hataları giderildi.
- Ayarlar (Settings) sekmesi baştan aşağı **macOS Sequoia & PlayStation 5 Console Dark** mimarisine dönüştürüldü (`src/features/settings/settings-view.ts`, `src/styles/settings.css`):
  - Sol kenar çubuğuna entegre **Mini Hesap Kartı** (`.settings-sidebar-account`): Kullanıcı profil avatarı, Epic Games kullanıcı adı ve canlı yeşil çevrimiçi noktasıyla zenginleştirildi.
  - Kategori Gezinme Squircles (`.settings-nav-icon`): Her kategori için özel vurgu rengi (mor, mavi, yeşil, sarı, turuncu, kırmızı, safir) ve alt açıklama metinleri (`subKey`) eklendi.
  - **Hesap (Account) Yönetim Kartı**: 60px dairesel avatar, yerel fotoğraf düzenleme overlay'i, tek tıkla kopyalanabilir Epic Hesap Kimliği çipi, 3 metrikli istatistik ızgarası (Kütüphane boyutu, Başarımlar, Toplam Oyun Süresi) ve ayrılmış kırmızı "Tehlikeli Bölge" oturum kapatma kartı.
  - **İndirmeler & Ağ (Downloads) 3 Sütunlu PS5 Hız Kartları**: Düz haplar yerine Azami Hız (Limitsiz), Dengeli (15 MB/s) ve Düşük Bant Genişliği (5 MB/s) seçeneklerini içeren interaktif, gecikme ve bant genişliği detaylı konsol kartları; kurulum dizini seçici ve CDN/önbellek bakım araçları.
- Ayarlar "Hakkında" (About) paneline resmi e-posta adresi eklendi (`mailto:hi@efxlve.com`):
  - `src/core/icons.ts` modülüne yeni `mail` SVG vektör ikonu eklendi (sıfır emoji kuralı korundu).
  - Vitrin kartı altına 4'lü Apple bağlantı kapsülleri yerleştirildi: E-posta (`hi@efxlve.com`), X (`https://x.com/efxlve`), GitHub (`https://github.com/efxlve/efxlve_launcher`) ve Resmi Web Sitesi (`https://efxlve.com/efxlve_launcher`).
- Oturum açılmamış / çıkış yapılmış durumda launcher tamamen tek bir ekrana (saf Login görünümüne) kilitlendi:
  - `body.auth-mode` devredeyken üst gezinme çubuğundaki tüm sekmeler (`#nav`), geçmiş butonları (`#nav-history-group`), indirme/bildirim sayaçları ve gezinme çizgisi `display: none !important` ile tamamen gizlendi; pencere başlığında yalnızca logo, sürükleme alanı ve pencere kontrol butonları bırakıldı.
  - Mağaza, kütüphane, indirmeler, profil ve ayarlar görünümlerine fare tıklamaları, fare ileri/geri yan butonları (3 ve 4), klavye kısayolları (`Ctrl+1`, `Ctrl+2`, `Ctrl+3`, `Ctrl+,`) ve gamepad gezinmesi (LB/RB) tamamen kilitlendi.
  - Giriş ekranı kullanıcının geri bildirimleri doğrultusunda baştan aşağı yeniden inşa edildi (`src/styles/auth.css`, `src/features/onboarding/onboarding-view.ts`):
    - Arka plana **3D açılı / perspektifli, GPU hızlandırmalı, 4 sütunlu sonsuz kayan oyun afişi duvarı** (`.auth-game-wall`, Cyberpunk 2077, GTA V, Alan Wake 2, Death Stranding vb. 16 popüler oyun afişiyle akıcı marquee animasyonu) ve derin sinematik vignette bindirildi.
    - Sağdaki gereksiz dikey kaydırma çubuğu kaldırıldı (`overflow: hidden !important`).
    - Yanıltıcı/yersiz olan "Playstation" ve "Resmi" ibareleri tamamen temizlendi; launcher felsefesine uygun olarak "GELİŞMİŞ ALTERNATİF BAŞLATICI" ve "Epic Games kütüphaneniz için optimize edilmiş, modern ve bağımsız masaüstü deneyimi" konumlandırması getirildi.
    - "Koltuk" ibaresi ve kafa karıştıran mükerrer butonlar kaldırıldı; üstte tek büyük "Epic Games ile Giriş Yap" safir butonu, hemen altında input + "Yapıştır" + "Giriş" oku içeren tek parça Apple tarzı giriş kapsülü ve en altta sessiz EGL aktarım linki konumlandırıldı.
    - Bilgisayarda Epic Games Launcher kurulu olmadığında fırlatılan ham Python hatası (`ValueError: EGS AppData path does not exist`) yakalanarak anlaşılır ve kibar bir bildirim mesajına dönüştürüldü (`cleanAuthError`).
  - Giriş yapıldığında veya oturum aktarıldığında devreye giren **Sinematik Kademeli Yükleme Ekranı (Progressive Loading Sequence)** uygulandı (`runProgressiveAuth`, `updateAuthProgressUi`): 4 aşamalı (Kimlik Doğrulama → Kütüphane & Oyun Dizini → Başarımlar & Kupalar → Konsol Başlatma) canlı yüzde sayacı, ışıldayan dönen konsol halkası, aşama onay tikleri ve DOM reflow'suz akıcı 120 FPS geçiş ile ana kütüphaneye yumuşak geçiş sağlandı.
- Kullanıcının eklediği yüksek çözünürlüklü ve sinematik `login_background.webp` görseli düzenli bir şekilde `src/assets/login_background.webp` dizinine taşındı; repo kökündeki yinelenen dosya temizlendi (Dead Code / Artık Dosya Sıfır Toleransı).
- Giriş ekranı arka planı, 16 farklı CDN görseli çeken DOM sütunları yerine yerel 172 KB'lık `login_background.webp` görseline bağlandı; 26 saniyelik sinematik yavaş nefes alma/Ken-Burns animasyonu (`authBgBreathe`), çift kademeli koyu obsidyen vignette ve yumuşak aurora ışımalarıyla lüks bir konsol sahnesine dönüştürüldü. Tamamen çevrimdışı çalışabilirlik, sıfır DOM yükü ve sıfır kaydırma çubuğu sağlandı.
- Epic Games Launcher açık olmasına rağmen aktarımın hata vermesinin (`ValueError: EGS AppData path does not exist`) teknik nedeni teşhis edildi ve Rust backend'e otomatik köprü entegre edildi (`src-tauri/src/legendary/commands.rs`): Modern EGL'nin `GameUserSettings.ini` dosyasını `Saved\Config\WindowsEditor` altına yazması ve Legendary'nin `Windows` klasörünü araması sebebiyle oluşan hata, `epic_import_egl` içinde otomatik dizin/yapılandırma köprüsü (`WindowsEditor` → `Windows`) kurularak kalıcı olarak çözüldü. Artık bilgisayarında Epic Games Launcher açık olan kullanıcılar tek tıkla şifresiz oturum aktarabiliyor.
- Giriş ekranına yeni kullanıcılar için kristal netliğinde **3 Adımlı Hızlı Başlangıç Rehberi** (`.auth-guide-box`) eklendi:
  - Adım 1: Resmi Girişi Açın (Tarayıcıda Epic Games hesabınızla oturum açın)
- Giriş ekranı (Login) başlığındaki "EFXLVE" ibaresi kullanıcının isteği doğrultusunda "Efxlve Launcher" olarak güncellendi (`src/features/onboarding/onboarding-view.ts`).
- **Tek Tıkla Epic Games Hesap Değiştirici (Account Switcher)** mimarisi ve arayüzü inşa edildi (`src-tauri/src/legendary/accounts.rs`, `src/features/auth/account-switcher.ts`, `src/features/settings/settings-view.ts`, `src/styles/settings.css`):
  - **Backend Oturum Yönetimi:** `%USERPROFILE%\.config\legendary\accounts\<account_id>\` dizininde her hesabın kimlik bilgileri (`user.json`) ve kütüphane anlık görüntüsü (`efxlve_library_snapshot.json`) izole şekilde arşivlenir; `accounts_meta.json` ile kayıtlı hesaplar, son kullanım zamanları ve aktiflik durumu takip edilir.
  - **Otomatik Arşivleme:** Web üzerinden (`epic_login_with_code`) veya açık EGL oturumundan (`epic_import_egl`) giriş yapıldığında yeni oturum anında hesap değiştirici kasasına arşivlenir.
  - **Tek Tıkla Geçiş (`epic_switch_account`):** Kullanıcı şifre veya kod girmeden anında farklı bir hesaba geçebilir; hedef oturum `user.json` konumuna yerleştirilir, kütüphane önbellek sızıntısı engellenir ve ön yüz anında yeni hesabın kütüphanesi ve profiliyle yeniden hidrate edilir.
  - **Hesap Yönetimi Arayüzü (Ayarlar → Hesap):** Kullanıcının kayıtlı tüm hesaplarını dairesel avatarları, Epic kullanıcı adları, kırpılmış hesap ID'leri, canlı çevrimiçi noktası ve "Aktif Hesap" rozetiyle listeleyen PS5 konsol kartı (`.account-switcher-group`); aktif olmayan hesaplar için "Bu Hesaba Geç" butonu ve çöp kutusu kaldırma eylemi; yeni bir hesabı mevcut hesabı silmeden bağlamak için "+ Yeni Hesap Ekle" butonu yerleştirildi.
  - **Sıfır Emoji ve Tam i18n:** TR ve EN dil dosyalarına gerekli tüm çeviriler eklendi, SVG vektör ikonları kullanıldı, TypeScript ve Rust birim testleri (61/61) eksiksiz doğrulandı.
- **Hesap Ekleme İptali tamamlandı:** "Yeni Hesap Ekle" ile giriş ekranına geçen kullanıcı artık kartın sol üstündeki `data-act="auth-cancel"` ("Aktif Hesaba Dön") butonuyla aktif oturumuna dönebilir; `S.lastNonAuthView` ile önceki görünüm korunur, `auth.returnToAccount` bildirimi gösterilir ve işlem sürerken buton kilitlenir (`onboarding-view.ts`, `account-switcher.ts`, `auth.css`).
- **i18n boşlukları kapatıldı:** Ayarlar'da ham anahtar olarak görünen `common.browse`, `downloads.clearCache/findCdn/resetCdn`, `profile.copyAccountId` referansları mevcut doğru anahtarlara (`common.browse`, `downloads.cacheClear`, `downloads.cdnFind`, `downloads.cdnReset`, `profile.copyId`) bağlandı; `profile.statusSynced`, `dl.noPending` (Rust `@t:`) dahil 8 yeni anahtar eklendi.
- **Sabit Türkçe metinler ve yorumlar temizlendi:** Giriş ekranındaki "BAŞLANGIÇ KURULUMU"/"BAŞLATILIYOR"/"Kaynak:" metinleri `auth.setupChip`/`auth.launchingChip`/`auth.sourceNote` anahtarlarına taşındı; `auth-actions.ts` ve `profile-view.ts` içindeki Türkçe yorumlar İngilizce'ye çevrildi; `NO_DESC` sentinel değeri dil-nötr (`__no_description__`) yapıldı.
- **Ölü i18n anahtarları silindi:** Kaldırılan özelliklerden kalan 77 anahtar `tr.json`/`en.json`'dan (13 ikincil dilde 4'er `ob.*` anahtarıyla birlikte) temizlendi; anahtar sayısı 1.277 → **1.208** (tr/en tam eşlik).
- **Doküman senkronu:** `docs/CODEBASE_MAP.md` gerçek dosya yapısıyla yeniden yazıldı (auth/account-switcher, accounts.rs, 21 Rust modülü, 22 feature, 29 CSS); `docs/TAURI_IPC_REFERENCE.md` eksik 20 komutla tamamlandı (98/98 kayıtlı komut dokümante); `docs/REFACTOR_PLAN.md` sayaçları güncellendi. Doğrulama: `npm.cmd run build`, `cargo check`, `cargo test` (61/61) yeşil.
- **Launcher otomatik güncelleme sistemi kuruldu (Steam-like + Epic kontrol deseni):** `tauri-plugin-updater` + `tauri-plugin-process` eklendi; `tauri.conf.json`'a `createUpdaterArtifacts: true` ve GitHub Releases `latest.json` endpoint'i + public key yazıldı; `capabilities/default.json`'a `updater:default` + `process:allow-restart` eklendi; `.github/workflows/release.yml` (tag → imzalı build + release, platform matrix'i Linux/macOS için hazır) oluşturuldu.
  - **Akış:** Açılışta 12 sn sonra tek seferlik kontrol + pencere odağa geldiğinde saatte en fazla 1 kontrol (boşta polling yok) + Ayarlar'dan elle kontrol; yeni sürüm varsa arka planda sessizce indirilir; **kurulum yalnızca kullanıcı onayıyla** ("Yeniden Başlat ve Güncelle" veya hazır bildirimine tıklayarak) yapılır ve **aktif oyun indirmesi / oyun oturumu sürerken ertelenir** (launcher yeniden başlarken indirmeyi öldürmemek için).
  - **UI:** Ayarlar > Sistem'te "Uygulama Güncellemeleri" kartı (mevcut sürüm, durum, ilerleme çubuğu, Kontrol Et / İndir / Yeniden Başlat ve Güncelle, otomatik güncelleme anahtarı); hazır bildirimi tıklanınca kurulum başlar; sürüm bilgisi artık `getVersion()` ile dinamik.
  - **İmzalama:** `~/.tauri/efxlve.key` (parolalı) + public key `tauri.conf.json`'da; parola `~/.tauri/efxlve.key.password.txt` (repoda değil). İlk üretimde parolasız anahtarın CLI'yı interaktif parola isteminde kilitlediği tespit edildi → parolalı anahtara geçildi. Doğrulama: `npm.cmd run tauri build` → MSI + NSIS `.sig` üretimi, `cargo test` (61/61), i18n eşlik (1233/1233).
- **Aksiyon butonu anında güncellenir:** İndirme başladığı anda "Yükle/Güncelle" butonu "İndiriliyor"a döner (`refreshGameActionUi`, `core/game-view.ts`): kütüphane ızgarası yeniden çizilir ve açık oyun çekmecesi `openEpicModal(app, false)` ile yerinde yenilenir; eskiden buton yalnızca çekmece yeniden açılınca güncelleniyordu.
- **"Yükleme Konumunu Seç" diyaloğu (Epic tarzı) eklendi** (`src/features/install/install-dialog.ts`, `#install-root`): kapak + başlık, indirme/gerekli depolama boyutu, klasör yolu + "Göz At" (native seçici), canlı "Dosya yolu" önizlemesi (`customAttributes.FolderName` ile), "otomatik güncelle" ve "kısayol oluştur" onay kutuları, İptal/Yükle. Opsiyonel dil/DLC varsa seçici kurulum modalı seçilen klasörle zincirlenir (`S.selectiveInstallDir`); kurulu oyunlarda (güncelleme/onarım) diyalog atlanır ve doğrudan kurulur. Kısayol isteği kurulum bitince yerine getirilir (`S.pendingShortcutApps` + `download-progress done`).
- **Ayarlar kenar çubuğundaki mor "aktif bölüm" noktası** (`.settings-nav-indicator`) hem işaretlemeden hem CSS'ten kaldırıldı.
- **Build düzeltmesi:** `ipc-listeners.ts`'te eksik olan `epicGetAutoDesktopShortcut` importu eklendi (tsc `TS2552` hatası, önceki commit'ten kalma).
- Doğrulama: `npm.cmd run build`, `cargo check`, `cargo test` (63/63), i18n eşlik (1249/1249).
- **Ağ profili değerleri tekilleştirildi:** Ayarlar sayfasındaki hız kartları backend'den farklı worker sayıları gösteriyordu (16/4/1); gerçek değerler **32/8/2** (`transfers.rs::get_worker_count_arg`) olarak düzeltildi. İndirmeler sayfası, Ayarlar ve profil bildirimi artık tek anahtar setini (`settings.netMax/Balanced/Low`) kullanıyor; kopya `downloads.profile*` ve `net.profile*` anahtarları ile ölü `settings.netFindCdnDesc`/`downloads.cdnNoData` anahtarları silindi (1249 → 1241).
- **Windows Konsol / CMD Penceresi Yanıp Sönmesi Kalıcı Olarak Engellendi (`CREATE_NO_WINDOW`):**
  - Launcher kullanılırken arka planda çalışan `legendary`, `powershell`, `reg` veya `taskkill` komutlarının Windows üzerinde siyah CMD pencereleri açarak kullanıcı deneyimini bozması teşhis edildi.
  - Rust backend'de süreç başlatan tüm noktalara (`client.rs::run_with_timeout`, `transfers.rs` indirme/doğrulama/kuyruk/başlatma/bulut senkronizasyonu, `commands.rs` kayıt defteri/doğrulama/sync-saves, `downloader.rs` sürüm sorgusu, `move_game.rs` klasör seçici/taşıma, `screenshots.rs` ekran görüntüsü ve `main.rs` EOS overlay kontrolü) Windows `CREATE_NO_WINDOW (0x08000000)` oluşturma bayrağı entegre edildi.
- **İndirme Hata Yönetimi & Epic GraphQL 429 İstek Sınırı İyileştirmesi:**
  - Kullanıcının karşılaştığı `HTTPError: 429 Client Error: Too Many Requests` ve `PYI-*:ERROR` gibi ham Python traceback yığınlarının doğrudan UI'ye yansıması sorunu çözüldü (`transfers.rs`, `tr.json`, `en.json`).
  - `short_error` ayrıştırıcısı akıllı hale getirildi: HTTP 429 rate limit, yetersiz disk alanı, paket/metaveri bulunamaması, ağ kopması ve oturum zaman aşımı gibi durumlar tespit edilerek konsol disiplinine uygun kibar ve net yerelleştirilmiş bildirimlere dönüştürüldü (`@t:dl.rateLimited`, `@t:dl.diskFull`, `@t:dl.itemNotFound` vb.).
  - PyInstaller iç çökme satırları ve Python dosya yolu artıkları temizlendi.
- **İndirme Zaman Aşımı (ReadTimeoutError) & Zincirleme İstisna Temizliği:**
  - Kullanıcının karşılaştığı `TimeoutError: The read operation timed out ... urllib3.exceptions.ReadTimeoutError` ve zincirleme Python istisnaları (`The above exception was the direct cause...`) ele alındı (`transfers.rs`, `tr.json`, `en.json`).
  - Epic Games sunucularındaki geçici ağ gecikmeleri veya yoğunluktan kaynaklanan okuma zaman aşımları (`timeout`, `timed out`, `readtimeouterror`) otomatik olarak yakalanıp 3 saniyelik beklemenin ardından tek seferlik otomatik yeniden deneme (auto-retry) döngüsüne bağlandı.
  - Hatanın kalıcı olması durumunda ham Python ve `urllib3` hata dökümleri yerine konsol disiplinine uygun temiz bildirim (`@t:dl.timeoutError` — "Epic Games sunucusu yanıt vermedi (Zaman aşımı). Lütfen internet bağlantınızı kontrol edip tekrar deneyin.") gösterilmesi sağlandı. Doğrulama: `npm.cmd run build` ve `cargo test` (61/61) hatasız tamamlandı.
- **İndirme CDN Ayarı & "CDN Listesi Bulunamadı" Hatası Kalıcı Olarak Çözüldü:**
  - Yeni kurulumlarda veya kütüphanesinde önbelleğe alınmış manifest bulunmayan kullanıcılarda "En hızlısını bul" tıklandığında `base_urls` listesi boş olduğu için `downloads.cdnNoData` ("CDN listesi bulunamadı") hatası vermesi engellendi.
  - Rust backend'e (`commands.rs::build_cdn_targets`, `epic_measure_cdns`) Epic Games'in 3 kanonik CDN uç noktası (`egdownload.fastly-edge.com`, `epicgames-download1.akamaized.net`, `egs-cloudfront-chunks.epicgamescdn.com`) varsayılan hedef olarak entegre edildi; sıfır oyunlu hesaplarda bile TTFB gecikme ölçümü kusursuz çalışır hale getirildi (birim testleri eklendi, 63/63 test yeşil).
  - İndirmeler sayfası ve Ayarlar > İndirmeler paneline Apple/PS5 Segmented Rail (`.cdn-pills`, `[ Otomatik | Akamai | Fastly | CloudFront ]`) ve "En hızlısını bul" butonu eklendi; tek tıkla elle CDN seçebilme veya otomatik gecikme testine göre en düşük pingli CDN'e geçiş sağlandı. Doğrulama: `npm.cmd run build` ve `cargo test` (63/63) hatasız.
- **Kullanıcı Geri Bildirimleri & 6 Kritik İyileştirme Tamamlandı:**
  - **Uygulama Güncelleme Kontrol Butonu:** Elle kontrol sonrasında güncelleme yoksa butonun "güncelleme kontrol ediliyor" durumunda asılı kalması giderildi; `scheduleRender()` tetiklenerek durum anında `idle` haline sıfırlandı (`update-manager.ts`).
  - **MS Edge / Chromium Varsayılan Sağ Tık Menüsü Engellendi:** Launcher genelinde (`context-menu.ts`) ve gömülü Mağaza child webview'inde (`main.rs` `STORE_EXTENSION_SCRIPT`) `contextmenu` olayına `preventDefault()` eklenerek tarayıcı menüsü tamamen kapatıldı; oyun kartlarındaki özel konsol menüsü korundu.
  - **Koleksiyonların Açılışta Kaybolması Giderildi:** `CachedLibrary` yapısına `collections` eklendi; başlatma anında disk önbelleğinden anında okunarak UI'ye yüklendi (`commands.rs`, `auth-actions.ts`). `read_collections_raw` fonksiyonunda ANSI/Windows kodlamalarında dosyanın çökmesini engellemek için `from_utf8_lossy` ile tam tolerans sağlandı (`collections.rs`).
  - **Otomatik Masaüstü Kısayolu Oluşturma & Ayarlar Seçeneği:** İndirme tamamlandığında (`monitor_download`) oyun için otomatik masaüstü kısayolu oluşturulması sağlandı (`transfers.rs`). Ayarlar > İndirmeler sekmesine açma/kapatma anahtarı yerleştirildi (`settings-view.ts`, `click-router.ts`, `commands.rs`); kullanıcı tercihi backend ve localStorage ile kalıcı hale getirildi.
  - **Kütüphane Sıralaması & Doğal Dil Collation:** Sabit Türkçe collator (`tr`) yerine aktif dile duyarlı `getCollator(lang, { sensitivity: "base", numeric: true })` yapısına geçildi; İngilizce ve diğer dillerde 'I'/'ı' dönüşüm hatası giderildi, "Doom 2" ve "Doom 10" gibi seriler doğal sayısal sıralamaya kavuşturuldu. Varsayılan sıralama geçmiş, oynama süresi, kurulu olma ve ada göre optimize edildi (`library-view.ts`).
  - **Epic Mağazası Oturumu & WebView2 İzolasyonu:** Launcher kimlik doğrulama belirteci (OAuth2 CLI) ile Mağaza web görünümü (sandboxed Chromium çerez havuzu) ayrımı netleştirildi; kullanıcı mağazada bir defa giriş yaptığında WebView2 oturumunun kalıcı kalması korundu.
- **Oyun taşıma:** disk listesi A’dan Z’ye gerçek sürücüleri sayar. Aynı diskte yeniden adlandırma yer kontrolü yapmaz; başka diske kopyada kota 0 diye “yer yok” denmez.
- **Oyun sayfası:** koleksiyon etiketleri Oyun Hakkında’nın üstünde. Seçim penceresi alta taşmıyor; tik yalnızca seçili satırda görünür.
- **Kütüphane listesi:** satır ve kapak büyütüldü; başarım sütunu var. Sağdaki düğmeler dar ve aynı genişlikte; Yükle grimsi. Yüklü olmayan Epic oyunları gri; EA ve Ubisoft renkli kalır.
- **Oyun sayfası kayması:** sekme içeriği kısalıp uzayınca sağ çubuk yer ayırır; sayfa yana kaymaz (`scrollbar-gutter: stable`).
- **Ekran görüntüsü:** yalnızca oyunun kendi penceresi öndeyken alınır; oyun arka plandayken launcher'dan çekim yok. Aynı anda tek çekim ve tek sıkıştırma (`screenshots.rs`, `screenshots-view.ts`).
- **Yönet penceresi:** oyun sayfasındaki Yönet düğmesi sekmeyi değiştirmez; ayarlar ayrı bir pencerede açılır (`manage-view.ts`).
- **İndirme hızı 0 B/s:** Bazı legendary sürümleri hızı `Download\t15 MiB/s` diye yazar, bazıları yalnızca `Downloaded:` / `Written:` sayacı basar. `Written: 72 MiB` birikimli boyut hız sanılıyordu (disk yüksek, ağ 0). Hız biriminde `/s` şart; sekme ve iki nokta üst üste aynı anahtarla okunur. Hız satırı yoksa hız, indirilen ve diske yazılan bayt farkından hesaplanır. Ara örnekler son gerçek hızı sıfırlamaz (`transfers.rs`, `ipc-listeners.ts`).

---

## 10. Sürüm Çıkarma (Release) & Otomatik Güncelleme

**Tek seferlik kurulum (GitHub):** Repo Secrets'a eklenir: `TAURI_SIGNING_PRIVATE_KEY` = `~/.tauri/efxlve.key` dosya içeriği; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = `~/.tauri/efxlve.key.password.txt` içeriği. **Anahtar/parola kaybolursa mevcut kullanıcılar bir daha güncelleme alamaz** — güvenli yedek şart.

**Her sürümde yapılacaklar:**
1. `src-tauri/tauri.conf.json` **ve** `src-tauri/Cargo.toml` içindeki `version` artırılır (örn. `0.1.1`).
2. Commit + tag push: `git tag v0.1.1` → `git push origin v0.1.1` (workflow `v*` etiketiyle tetiklenir).
3. GitHub Actions imzalı build alır, release'i yayınlar (`releaseDraft: false`) ve `latest.json` üretir. Kurulu istemciler bir sonraki açılışta/odaklanmada güncellemeyi görür.

**Kurallar & tuzaklar:**
- **Repo ve release'ler public kalmalıdır:** updater `latest.json` ve paketleri kimlik doğrulamasız indirir; private repoda release asset'leri 404 döner (ilk kurulumda repo private olduğu için tespit edildi, public yapıldı).
- tauri-action, `latest.json` içinde `api.github.com/.../releases/assets/<id>` URL'leri üretir; Tauri updater indirme isteğinde `Accept: application/octet-stream` gönderdiği için bu URL'ler gerçek paketi indirir (kaynak koduyla doğrulandı). Elle müdahale gerekmez.
- Kurulumlar **NSIS `setup.exe`** ile yapılmalıdır; varsayılan `windows-x86_64` anahtarı NSIS paketine işaret eder (`updaterJsonPreferNsis: true`). MSI ile kurulan bir uygulamayı updater NSIS ile güncellemeye çalışırsa kurulum kaydı karışabilir.
- `tauri dev` ve elle taşınan exe **kendini güncellemez**; yalnızca kurulum paketiyle (NSIS/MSI) kurulmuş uygulama güncellenir. İlk updater'lı sürüm "bootstrap"tır.
- Release taslak (draft) kalırsa `/releases/latest/download/latest.json` görünmez; yayınlanmalıdır.
- Yerel imzalı build için: `$env:TAURI_SIGNING_PRIVATE_KEY` + `$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ortam değişkenleri şart (parolasız anahtar CLI'yı interaktif istemde kilitler; anahtar mutlaka parolalı üretilir).
- Yeni platform (Linux/macOS) eklendiğinde `.github/workflows/release.yml` matrix'inde ilgili satırlar açılır; `latest.json` platform bazlı (`windows-x86_64`, `linux-x86_64`, `darwin-aarch64`) otomatik birleştirilir.

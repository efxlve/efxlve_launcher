# AGENTS.md — Efxlve Launcher

> Bu dosya, bu projede çalışacak AI ajanları (ve insan geliştiriciler) için **ana operasyonel rehberdir**.
> Kısa tut, güncel tut: kritik kuralları net koru, geçmiş sürüm detayları için `docs/CHANGELOG_INTERNAL.md` dosyasına başvur.

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
4. **ZORUNLU TASARIM KURALI:** Launcher arayüzünde daima **PlayStation-Inspired (PS5 Console) Dark Aesthetic** kullanılır (obsidian & midnight blue `#07080d`/`#0b0d14`, mor-altın-obsidyen kimliği, ferah kupa hiyerarşisi: Platin, Altın, Gümüş, Bronz sayaçları). Telif ihlali oluşturmamak için Sony tescilli logoları kopyalanmaz.
5. **ZORUNLU KONTROLCÜ & KONSOL KURALI:** Arayüz daima **Game Controller (Gamepad / DualSense / Xbox)** ile 10 fit (TV / Koltuk / Konsol modu) kullanıma tam uyumlu tasarlanmalıdır. Geniş ferah kartlar, 2 sütunlu kupa ızgarası, büyük butonlar, `:focus-visible` lavanta/mavi odak halkaları ve kontrolcü kısayolları (A: Seç, B: Geri, LB/RB: Sekmeler, Y: Ara, X: Favori) titizlikle korunur.
6. **"AI TASARIMI GİBİ DURMASIN" KURALI:** YASAKLAR: Mor→indigo→cyan dekoratif gradyanlar, neon parlama (`box-shadow glow`), gradyan metin (`background-clip: text`), her öğeyi tam yuvarlak kapsüle (`999px`) çevirmek, cam/blur katmanlarının gereksiz tekrarı ve süs amaçlı mikro animasyonlar (ikon sallama, pulse). Renk yalnızca DURUM bildirir (yeşil = çevrimiçi, amber = çevrimdışı/güncelleme, kırmızı = sayaç/hata).
7. **DENGE KURALI:** Hedef **sade ama karakterli**. Karakter şu dört kaynaktan gelir: tek kaynaklı bağlamsal ışık, yüzey/derinlik dili, tipografik ses, tek özgüvenli vurgu rengi.

## 5. Mimari & Veri Akışı Prensibi

- **Heroic Prensibi:** Arayüz ÖNCE disk önbelleğinden anında okunur (`epic_cached_library`), ağ senkronu (`epic_list_games`) arka planda sessizce yürütülür. Ağ başarısız olsa bile arayüz kilitlenmez, önbellek korunur. Asla tüm kütüphaneyi tek `list` çağrısına bağlama.
- **Modüler Yapı (`master_refactor_plan.md`):**
  - `src/core/`: `epic.ts` (API/Invoke), durum (state), olaylar (events) ve yardımcılar (utils).
  - `src/features/`: `library/`, `drawer/`, `profile/`, `downloads/`, `gamepad/`, `store/`, `settings/`.
  - `src/styles/`: Parçalanmış modüler CSS (`theme.css`, `pcard.css`, `drawer.css`, vb.).
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
10. **Frontend Render Disiplini (Rule 15):** İlerleme event'lerinde veya arka plan IPC mesajlarında tüm görünümü ASLA YENİDEN ÇİZME. Sadece ilgili buton (`[data-dlbtn]`) ve bar (`[data-dlbar]`) elemanlarını güncelle. Arama kutusu odaktayken full render yapma.
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
   - Mor→cyan gradyanlar, sarkan neon gölgeler (`box-shadow glow`), gradyan metinler (`background-clip: text`), her öğeyi 999px hap kapsüle çevirmek YASAKTIR. Konsol estetiği sakin, tok, lüks obsidyen ve tek lavanta vurgu rengidir (`#8b5cf6`).
7. **DOKUNSAL GERİ BİLDİRİM & HIZ SINIRI (Tactile Micro-Feedback):**
   - Tıklanabilir tüm bileşenlerde `:active` anında hafif basılma (`transform: scale(0.98)`) olmalı; animasyon süreleri asla 120–150ms'yi aşmamalıdır (yavaş animasyonlar arayüzü hantal hissettirir).
8. **ZARİF BOŞ DURUMLAR (Empty State Elegance):**
   - Sayfa veya liste asla kuru/kırık bir metinle boş bırakılamaz. İlgili temanın 36-40px vektör ikonu (soluk ton), net bir başlık, yönlendirici kısa bir açıklama ve birincil yönlendirme butonu bulunmalıdır.
9. **10-FOOT KOLTUK & GAMEPAD ODAK HİJYENİ:**
   - Gamepad ile gezinirken odak halkası 2px lavanta (`#8b5cf6`), 3px `outline-offset` ile belirgin olmalı; odaklanıldığında kartı büyütüp (`transform: scale(1.1)`) yanındaki kartları kaydıran veya titreten layout shift efektleri KESİNLİKLE KULLANILAMAZ.

---

## 8. Ek Dokümantasyon Referansları

- **Detaylı Sistem Mimarisi:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Kod Tabanı & Sembol Haritası:** [`docs/CODEBASE_MAP.md`](./docs/CODEBASE_MAP.md)
- **PlayStation 5 Console Dark Tasarım Sistemi:** [`docs/DESIGN_SYSTEM.md`](./docs/DESIGN_SYSTEM.md)
- **Tauri IPC & Backend Komut Referansı:** [`docs/TAURI_IPC_REFERENCE.md`](./docs/TAURI_IPC_REFERENCE.md)
- **AI Geliştirici & Mental Model Rehberi:** [`docs/AI_DEVELOPER_GUIDE.md`](./docs/AI_DEVELOPER_GUIDE.md)
- **Tarihçe & Geçmiş Sürüm Günlükleri (Bölüm 1–78):** [`docs/CHANGELOG_INTERNAL.md`](./docs/CHANGELOG_INTERNAL.md)



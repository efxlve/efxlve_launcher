# AGENTS.md — Efxlve Launcher

> Bu dosya, bu projede çalışacak AI ajanları (ve insan geliştiriciler) için **ana operasyonel rehberdir**.
> Kısa tut, güncel tut: kritik kuralları net koru, geçmiş sürüm detayları için `docs/CHANGELOG_INTERNAL.md` dosyasına başvur.
>
> **GÜNCEL DURUM:** Modülerleştirme **tamamlandı** — `main.ts` 11.422 → **86 satır** (yalnızca `render`/`scheduleRender`/`closeAllModals` + bootstrap). Tüm özellik dosyaları ~1.500 satır altında. Mimari: **`docs/REFACTOR_PLAN.md` §6.5**. **i18n tamamlandı** (Rust dahil, 1122 anahtar, tr/en tam eşlikli) ve ölü kod temizliği yapıldı: **`docs/REFACTOR_PLAN.md` §6.6**. Yeni: **Discord Rich Presence (opsiyonel, varsayılan kapalı)** — `src-tauri/src/presence.rs`; **EOS Overlay tespiti** (Ayarlar'da sürüm + overlay desteği; overlay oyun sürecine enjekte edilir, launcher'a gömülemez) — `eos_overlay_status`; **oyun bazında "EOS Desteği" rozeti** — `epic_detect_eos`; **Epic arkadaş paneli** (salt-okunur, resmi olmayan Web API) — `legendary/friends.rs`; **"oyun oynarken indirmeleri duraklat"** (opsiyonel, varsayılan kapalı). Yeni: **bildirim merkezi** (`src/features/notifications/`); **ücretsiz haftalık oyunlar** rafı (`legendary/freegames.rs`); **oyun başına wrapper/ortam değişkenleri** (yönetim sekmesi); **stüdyo filtresi + gelişmiş arama** (`dev:`, `is:`); **sistem tepsisi + kapatınca tepsiye küçültme** (arka planda indirme); **otomatik save yedekleme** ve **zamanlanmış otomatik güncelleme** (Ayarlar); **"En Çok Oynadıklarınız"** (profil). Çalışma günlüğü: `docs/CHANGELOG_INTERNAL.md` §79–156.

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
  - `src/features/`: `library/`, `drawer/`, `profile/`, `downloads/`, `gamepad/`, `store/`, `settings/`, `screenshots/`, `collections/`, `move-game/`, `dlc/`, `manage/`, `cover/`, `playtime/`, `onboarding/`, `context-menu/`, `events/` ✅.
  - `src/styles/`: 24 parçalanmış modüler CSS + `index.css` (tek giriş noktası) ✅.
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
- **Yol Haritası & Aktif Görevler:** [`docs/ROADMAP.md`](./docs/ROADMAP.md)
- **Kod Tabanı & Sembol Haritası:** [`docs/CODEBASE_MAP.md`](./docs/CODEBASE_MAP.md)
- **PlayStation 5 Console Dark Tasarım Sistemi:** [`docs/DESIGN_SYSTEM.md`](./docs/DESIGN_SYSTEM.md)
- **Tauri IPC & Backend Komut Referansı:** [`docs/TAURI_IPC_REFERENCE.md`](./docs/TAURI_IPC_REFERENCE.md)
- **AI Geliştirici & Mental Model Rehberi:** [`docs/AI_DEVELOPER_GUIDE.md`](./docs/AI_DEVELOPER_GUIDE.md)
- **Tarihçe & Geçmiş Sürüm Günlükleri (Bölüm 1–78):** [`docs/CHANGELOG_INTERNAL.md`](./docs/CHANGELOG_INTERNAL.md)

## 9. Son Çalışma Özeti

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

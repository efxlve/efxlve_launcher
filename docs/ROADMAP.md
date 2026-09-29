# ROADMAP.md — Efxlve Launcher Planlanan Geliştirmeler & Görev Listesi

> **Amaç:** Projede tespit edilen hataların, kullanıcı geri bildirimlerinin ve planlanan tasarım/mimari yeniliklerin merkezi kayıt ve takip dokümanıdır.

---

## 1. Öncelikli Aktif Görev (Kullanıcı Bildirimi)

### 📌 Üst Menü ("Mağaza", "Kütüphane") Webview Çakışma Bug'ı ve Üst Navigasyon UI Yenilemesi

- **Durum:** ✅ `TAMAMLANDI` (Milestone 1 — bkz. CHANGELOG_INTERNAL.md §79)
- **Etkilenen Dosyalar:**
  - `src/main.ts` (Titlebar render, `#nav`, `openStore`, `closeStore`, `updateNavIndicator`, click router)
  - `src/styles.css` (`.ps5-top-bar`, `#nav`, `.nav-indicator`, `.store-loading-screen`)
  - `src-tauri/src/main.rs` (`show_store_view`, `hide_store_view`, `resize_store_view`, `store_views`)

#### A. Gözlemlenen Hata ve Semptomlar
1. **İç İçe Girme / Üst Üste Binme:** Gömülü Epic Games Store native child webview'i ile Kütüphane / Oyun Detay çekmecesi bazen aynı anda ekranda açık kalarak üst üste biniyor (HWND z-order çakışması).
2. **Kapanmama / Açık Kalma:** "Kütüphane" veya "İndirmeler" sekmesine tıklandığında bazen mağaza penceresi kapanmıyor veya gizleme IPC çağrısı gecikerek arayüzün arkasında/önünde asılı kalıyor.
3. **Nav Göstergesi & Durum Karışıklığı:** `storeVisible` değişkeni ile `view` ("library", "downloads", "profile" vb.) birbirinden bağımsız iki değişken olarak yönetildiği için menüdeki aktif sekme ışığı ve tıklama durumları tutarsızlaşabiliyor.
4. **Üst Menü UI İhtiyacı:** Mevcut üst başlık çubuğu (`#titlebar` / `#nav`) henüz tam olarak PS5 konsol kalitesinde değil; daha göze hoş gelen, konsol odaklı, lüks obsidyen detaylara sahip şık bir arayüze güncellenmesi gerekiyor.

#### B. Teknik Kök Neden Analizi (Root Cause)
- **Tauri Native Child Webview Mimarisi:** Windows üzerinde `window.add_child` ile açılan webview, standart bir HTML DOM elemanı değildir; doğrudan OS düzeyinde çalışan bir alt penceredir (`HWND`). DOM katmanındaki CSS `z-index` veya `opacity` kuralları bu native pencereyi etkileyemez.
- **Asenkron IPC Gecikmesi:** `closeStore()` fonksiyonu `invoke("hide_store_view")` çağrısını asenkron tetikler. Cevap dönene kadar kullanıcı başka bir butona tıkladığında veya DOM yeniden çizildiğinde native pencere gizlenemeden görünür kalabilir.
- **Çift Durum (Split State) Problemi:** `storeVisible: boolean` ve `view: string` durumlarının ayrı olması, menünün hangi sekmede olduğunu takip etmeyi zorlaştırmaktadır.

#### C. Planlanan Çözüm Adımları
1. **Birleşik Görünüm Durum Makinesi (Single State Machine):**  
   - `storeVisible` ayrı bir bayrak olmaktan çıkarılacak; tekil durum `view: "library" | "store" | "downloads" | "profile" | "settings"` olarak birleştirilecek.
   - Her görünüm değişiminde veya modal açılışında mağaza durumu atomik olarak kontrol edilecek.
2. **Rust Tarafında Kesin Gizleme Garantisi:**  
   - `hide_store_view` çağrıldığında yalnızca `hide()` çağrılmakla yetinilmeyecek; pencere koordinatları geçici olarak ekran dışına (`-10000, -10000`) taşınacak veya boyutu sıfırlanarak ekran üzerinde piksel kalıntısı bırakması %100 engellenecek.
3. **Üst Menü (Titlebar & Nav) PS5 Konsol Yeniden Tasarımı:**  
   - Sekme butonları (`MAĞAZA`, `KÜTÜPHANE`, `İNDİRMELER`) daha dengeli tipografi, konsol ikonları ve zarif odak halkalarıyla yenilenecek.
   - Kayan sekme göstergesi (`nav-indicator`) akıcı, 120 FPS konsol animasyonuna kavuşturulacak.
   - Gamepad kısayolları (LB / RB ile sekmeler arası anında geçiş) daha belirgin ve tactile hale getirilecek.

---

### 📌 Beyaz Parlama / Flashbang (FOUC) Sorunu — Launcher ve Mağazada Aniden Ekranın Beyaz Olması

- **Durum:** ✅ `TAMAMLANDI` (Milestone 2 — bkz. CHANGELOG_INTERNAL.md §80)
- **Etkilenen Dosyalar:**
  - `src-tauri/tauri.conf.json` (Ana pencere arka plan rengi / transparent ayarı)
  - `index.html` (Critical inline background & color-scheme eksikliği)
  - `src-tauri/src/main.rs` (`WebviewBuilder` child webview varsayılan native arka plan rengi)
  - `src/styles.css` (`html, body` ilk render anti-flicker kuralları)

#### A. Gözlemlenen Hata ve Semptomlar
1. **Aniden Ekranın Beyaz Olması (Flashbang):** Launcher açılırken, sayfalar arası geçiş yapılırken veya pencere boyutu değiştirilirken anlık olarak ekran bembeyaz parlayıp (flashback / white flicker) gözü alıyor.
2. **Özellikle Mağazada Şiddetlenmesi:** "Mağaza"ya tıklandığında veya mağaza içinde bir oyun sayfasına yönlenirken, Chromium render motoru DOM ve harici web içeriği yüklenene kadar tüm ekranı saf beyaz (`#FFFFFF`) ile temizliyor.
3. **Kullanıcı Deneyimini Baltalaması:** Koyu obsidyen PlayStation konsol estetiğine sahip bir launcher'da bu tarz anlık beyaz parlamalar hem profesyonelliği zedeliyor hem de gece kullanımında rahatsız ediyor.

#### B. Teknik Kök Neden Analizi (Root Cause)
1. **WebView2 Native Controller Varsayılanı:** Windows üzerinde Microsoft Edge WebView2 motoru (`ICoreWebView2Controller`), işletim sistemi düzeyinde varsayılan olarak saf beyaz (`COLORREF 0x00FFFFFF`) arka planla başlatılır.
2. **Tauri Konfigürasyon Eksikliği:** `tauri.conf.json` dosyasındaki pencere tanımında `"backgroundColor": "#07080d"` veya native transparent parametresi tanımlanmadığı için pencere oluştuğu milisaniyede WebView2 beyaz arka planı ekrana basar.
3. **HTML Inline Kritik Stil Eksikliği:** `index.html` dosyasında `<html>` ve `<body>` üzerinde doğrudan inline `style="background-color: #07080d; color-scheme: dark;"` bulunmadığı için CSS dosyası (`styles.css`) Vite tarafından ayrıştırılana kadarki ilk karede FOUC (Flash of Unstyled Content) oluşur.
4. **Gömülü Mağaza Webview'i:** `WebviewBuilder::new(...)` ile oluşturulan child webview için native arka plan rengi belirtilmemiştir. Mağazadaki her sayfa geçişinde Chromium DirectX swap chain'i sıfırlarken beyaz arka plan fırlar.

#### C. Planlanan Çözüm Adımları
1. **`index.html` ve Head Düzeyinde Anti-Flash:**  
   - `<html>` ve `<body>` etiketlerine doğrudan inline `style="background-color: #07080d; color-scheme: dark;"` eklenecek.
   - `<head>` içine `<meta name="color-scheme" content="dark">` yerleştirilerek CSS yüklenmeden önce bile tarayıcının saf obsidyen siyahı çizmesi sağlanacak.
2. **`tauri.conf.json` Pencere Ayarları:**  
   - Pencere ayarlarına native dark background tanımlanarak WebView2'nin Win32 penceresini beyazla boyaması engellenecek.
3. **Rust WebviewBuilder Arka Planı:**  
   - `src-tauri/src/main.rs` içinde `WebviewBuilder` oluşturulurken `.transparent(true)` veya Windows controller seviyesinde `default_background_color: [7, 8, 13, 255]` tanımlanacak.
4. **Mağaza Sayfa Geçişlerinde Karartma Maskesi:**  
   - `STORE_EXTENSION_SCRIPT` içindeki CSS'in `document_start` anında enjekte edilmesi ve ilk boyama gerçekleşene kadar sayfanın `#07080d` opak kaplamayla tutulup hazır olduğunda yumuşak (fade-in) gösterilmesi.

---

### 📌 İndirme Hızı Görünmeme Bug'ı & İndirme Sayfası / Ayarları Yenilemesi

- **Durum:** ✅ `TAMAMLANDI` (Milestone 3 — bkz. CHANGELOG_INTERNAL.md §81)
- **Etkilenen Dosyalar:**
  - `src-tauri/src/legendary/transfers.rs` (`parse_speed`, stderr okuma döngüsü)
  - `src/main.ts` (`renderDownloads`, `activeDlMetrics`)
  - `src/styles.css` (`.dl-page`, `.dl-stat-tile`)

#### A. Gözlemlenen Hata ve Semptomlar
1. **İndirme Hızının Görünmemesi:** Aktif bir oyun indirilirken indirme hızı kutusunda anlık hız gösterilmiyor veya `—` / `0 B/s` olarak takılı kalıyor.
2. **İndirme Ayarlarının Eksikliği:** Kullanıcının bant genişliğini sınırlama (hız limiti), eşzamanlı indirme sayısı, indirme dizini ve indirme worker profilini doğrudan İndirmeler sayfasından yönetebileceği bir ayar paneli bulunmuyor.

#### B. Teknik Kök Neden Analizi
- **Legendary CLI Stderr Çıktı Biçimi:** Legendary indirme sürecinde terminal ilerlemesini satır sonu (`\n`) yerine carriage return (`\r`) ile tek satırda ezerek günceller (`sys.stderr.write("\r= Progress: ...")`). Rust tarafında `BufReader::lines()` satır sonu gelene kadar beklediği için hız verileri IPC üzerinden arayüze zamanında veya hiç aktarılamayabiliyor.
- **Hız Deseni (Regex/Prefix) Uyuşmazlığı:** `parse_speed` fonksiyonunda aranan anahtar kelimeler (`Download:`, `Download speed:`) Legendary'nin farklı sürümlerinde değişkenlik gösterebiliyor.

#### C. Planlanan Çözüm Adımları
1. **Rust İlerleme Okuyucusunun Sağlamlaştırılması:** `transfers.rs` içerisindeki stderr okuyucu hem `\n` hem de `\r` (CR) karakterlerine duyarlı hale getirilecek; hız desenleri genişletilecek.
2. **Gelişmiş İndirme Ayarları Paneli:**
   - Hız Sınırlama (Bandwidth Throttling / Limitsiz / 10 MB/s / 25 MB/s vb.).
   - İndirme dizini hızlı değiştirici.
   - İndirme profili (Düşük / Dengeli / Maksimum CPU-Ağ performansı).

---

## 2. Planlanan Yeni Özellikler & Fonksiyonel Geliştirmeler

### 📌 2.1. Özel Konsol Sağ Tık Menüsü (Steam / PS5 Context Menu)
- **Açıklama:** Kullanıcı oyun kartına veya satırına sağ tıkladığında varsayılan tarayıcı menüsü (Kopyala, Yapıştır, İncele vb.) yerine Steam / konsol benzeri zengin, odaklı bir aksiyon menüsü açılacak.
- **Menü İçeriği:**
  - `Oyna` / `Başlat` (Kuruluysa) veya `Yükle` (Kurulu değilse)
  - `Özellikler & Yönet` (Yönetim modalını açar)
  - `Masaüstü Kısayolu Oluştur`
  - `Kurulum Klasörünü Aç` (Explorer)
  - `Kayıt Dosyalarını Yedekle`
  - `Favorilere Ekle / Çıkar`
  - `Kaldır` (Kırmızı / Tehlikeli aksiyon)
- **Teknik Çözüm:** `window.addEventListener("contextmenu", e => e.preventDefault())` ile global varsayılan tarayıcı menüsü engellenecek; tıklandığı koordinatta şık bir `.ps5-context-menu` bileşeni render edilecek.

---

### 📌 2.2. Tarayıcı / Webview Zırhlama & Olası Sorunları Önceden Engelleme (Webview Hardening)
- **Açıklama:** Kullanıcının bir webview / tarayıcı kullandığını hissettiren veya arayüzü bozabilecek tüm Chromium davranışlarının proaktif olarak engellenmesi.
- **Engellenecek Unsurlar:**
  1. **Metin Seçimi:** Metin alanları (`input`, `textarea`) hariç tüm arayüzde `user-select: none` kuralı zorunlu tutulacak.
  2. **Görsel Sürükleme:** Afişlerin veya ikonların fareyle masaüstüne sürüklenip arayüzün kaymasını önlemek için `-webkit-user-drag: none`.
  3. **Kazara Sayfa Yenileme (Reload Traps):** Kullanıcının yanlışlıkla `F5` veya `Ctrl+R` basarak uygulamayı sıfırlaması klavye dinleyicisinde engellenecek.
  4. **Pinch-to-Zoom / Ölçek Bozulması:** `Ctrl +` veya dokunmatik fareyle arayüzün zoom yapıp bozulması engellenecek.
  5. **Arka Plan Güç Kısma (Background Throttling):** Oyun inerken launcher simge durumuna küçültüldüğünde Windows'un indirme hızını kısmasını engellemek için WebView2 ayarlarında arka plan aktivitesi korunacak.

---

### 📌 2.3. İlk Kurulum (Onboarding) & Epic Games Giriş Sihirbazı
- **Açıklama:** Launcher'ı ilk kez indiren veya henüz oturum açmamış kullanıcılar için sinematik, güven veren bir karşılama ekranı.
- **İçerik & Adımlar:**
  - **1. Adım: Hoş Geldiniz:** Efxlve Launcher'ın felsefesi (PlayStation konsol estetiği, yüksek performans, bağımsız kütüphane).
  - **2. Adım: Hesap Bağlama Seçenekleri:**
    - *Yöntem A (1-Tıkla İçe Aktar):* Bilgisayarda resmi Epic Games Launcher kuruluysa tek tıkla şifresiz içe aktarma (`epic_import_egl`).
    - *Yöntem B (Resmi Güvenli Kod):* `https://legendary.gl/epiclogin` üzerinden resmi Epic Games yetkilendirme kodunun alınıp yapıştırılması (`epic_login_with_code`).
  - **3. Adım: Görsel Rehber:** Yetkilendirme kodunun nereden kopyalanacağını gösteren adım adım mini infografik.

---

### 📌 2.4. Çoklu Dil & Lokalizasyon (i18n) Mimarisi
- **Açıklama:** Epic Games Store'un resmi olarak desteklediği **tüm dillerin** (16+ dil) launcher'a eklenmesi.
- **Desteklenecek Diller:**  
  Türkçe (TR), English (EN), Deutsch (DE), Español (ES), Français (FR), Italiano (IT), 日本語 (JA), 한국어 (KO), Polski (PL), Português - Brasil (PT-BR), Русский (RU), 简体中文 (ZH-Hans), 繁體中文 (ZH-Hant), العربية (AR), ไทย (TH).
- **Mimari Disiplin:**
  - Kod tabanı modüllere parçalanırken tüm arayüz metinleri `src/locales/{lang}.json` dosyalarına taşınacak.
  - Bileşenlerde `t("play")`, `t("install")` gibi dinamik çeviri yardımcıları kullanılacak.
  - Asla kod içine harici ham metin gömülmeyecek.

---

### 📌 2.5. İlk Kurulum Bağımlılık Yöneticisi (Setup Wizard & Binary Downloader)
- **Açıklama:** Launcher ilk çalıştırıldığında sistemde `legendary.exe` binary'si veya gerekli C++ çalışma zamanı (Visual C++ Redistributable) eksikse kullanıcının manuel uğraşmasına gerek kalmadan otomatik çözülecek.
- **Özellikler:**
  - `legendary.exe` github release üzerinden en güncel sürümün otomatik indirilmesi ve SHA-256 doğrulamasının yapılması.
  - İndirme sürecini gösteren konsol ilerleme çubuğu.

---

### 📌 2.6. Ayarlar'da 3. Parti Başlatıcılar Kolaylık Hub'ı (Ubisoft, EA, Rockstar)
- **Açıklama:** Epic Games kütüphanesindeki birçok oyun (Assassin's Creed, FIFA/FC, GTA V) harici başlatıcı gerektirir. Ayarlar sayfasına özel bir entegrasyon paneli eklenecek.
- **Özellikler:**
  - **EA App:** Sistemde kurulu mu? (Kuruluysa sürüm bilgisi; değilse 1-tıkla resmi kurulum dosyasını indirme butonu).
  - **Ubisoft Connect:** Sistemde kurulu mu? (Kuruluysa durum; değilse resmi yükleyiciyi indirme butonu).
  - **Rockstar Games Launcher:** Sistemde kurulu mu? (Kuruluysa durum; değilse resmi yükleyici butonu).

---

## 3. Uzun Vadeli Platform Genişlemesi (Cross-Platform)

### 📌 3.1. Linux ve macOS / Wine & Proton Entegrasyonu (Heroic Launcher Modeli)
- **Açıklama:** Tıpkı Heroic Games Launcher gibi, Linux ve macOS kullanıcılarının Epic Games kütüphanelerindeki Windows oyunlarını doğrudan çalıştırabilmesi.
- **Bileşenler:**
  - **Linux:** Proton (Valve), Wine-GE, DXVK (DirectX -> Vulkan) ve VKD3D entegrasyonu.
  - **macOS:** Apple Game Porting Toolkit (GPTK) ve CrossOver / Wine uyumluluk katmanı köprüsü.
  - **Prefix Yöneticisi:** Her oyun için bağımsız `WINEPREFIX` oluşturma, DXVK açıp kapama ve FSR ayarları.

---

## 4. Gelecek Adımlar (Next Milestones)

- [x] **Milestone 1:** Üst menü (Titlebar / Nav) PS5 UI yenilemesi ve Mağaza/Kütüphane webview durum makinesi refactor'ü. → CHANGELOG §79
- [x] **Milestone 2:** Beyaz parlama (flashbang / FOUC) sorununun `tauri.conf.json`, `index.html` ve Rust `WebviewBuilder` seviyesinde kökten çözülmesi. → CHANGELOG §80
- [x] **Milestone 3:** İndirme hızı veri akışı bug'ının (`transfers.rs` CR/LF) çözülmesi, İndirme sayfası PS5 UI yenilemesi ve indirme ayarları paneli. → CHANGELOG §81
- [x] **Milestone 4:** Steam/PS5 tarzı özel sağ tık menüsü (Context Menu) ve tarayıcı zırhlama (Webview Hardening). → CHANGELOG §82
- [x] **Milestone 5:** İlk kurulum (Onboarding) ve Epic Games hesap bağlama sihirbazı. → CHANGELOG §83
- [x] **Milestone 6:** Çoklu dil (i18n) mimarisi (15 dil desteği) ve modüler parçalama. → CHANGELOG §84
- [x] **Milestone 7:** Ayarlar'da 3. parti başlatıcılar hub'ı (EA, Ubisoft, Rockstar). → CHANGELOG §85
- [x] **Milestone 8:** Linux/macOS Wine & Proton uyumluluk katmanı araştırması ve mimari tasarımı. → [`CROSS_PLATFORM.md`](./CROSS_PLATFORM.md)

---

## 5. İsteğe Bağlı Backlog (Sonra Yapılacak)

Kullanıcı talebiyle not alındı; zorunlu değil, öncelik sırasına göre ele alınacak:

1. **Diğer 13 dilin tam çevirisi:** Şu an `de/es/fr/it/ja/ko/pl/pt-BR/ru/th/zh-Hans/zh-Hant/ar` dosyalarında yalnızca 45 çekirdek anahtar var; gerisi İngilizce'ye düşüyor. Tam çeviri ~13 × 1100 anahtar (büyük iş, kalite riski; insan/AI çeviri turu gerekir).
2. **Discord Rich Presence görseli:** ✅ Tamamlandı — launcher ikonu ve oyun kapağı `large_image` / `small_image` olarak gider; oyundayken süre sayacı da eklenir.
3. **Cross-platform (Linux/macOS Wine/Proton):** Yalnızca araştırma/araştırma dokümanı mevcut ([`CROSS_PLATFORM.md`](./CROSS_PLATFORM.md)); gerçek implementasyon ayrı bir proje büyüklüğünde (Proton/DXVK/VKD3D, GPTK, prefix yöneticisi).
4. **Discord RPC ek bağlamlar:** İsteğe bağlı olarak kupa/başarım ilerlemesi gibi daha zengin durum metinleri.
5. **EOS Social Overlay — uygulandı (tespit + rozet):** Epic'in EOS Overlay'i **oyun sürecine enjekte edilir** (Shift+F3) ve sistem geneline Epic Games Launcher tarafından kurulur; launcher webview'ine gömülemez. Ayarlar'da **tespit + sürüm + overlay desteği** kartı (`eos_overlay_status`), oyun detayında **"EOS Desteği" rozeti** (`epic_detect_eos`, sınırlı derinlikte tarama + oyun başına önbellek) eklendi. Otomatik kurulum, Epic'in redistributable'ı bir `productId` gerektirdiği ve uygulama-başına yapıldığı için kapsam dışıdır.
6. **Epic arkadaş listesi — uygulandı (salt-okunur, resmi olmayan API):** Profil sayfasında arkadaş ızgarası (`epic_friends`); görünen ad + platform rozetleri (Steam/PSN/Xbox). legendary `user.json` token'ı kullanılır. Çevrimiçi durum bu token ile alınamıyor (presence servisi 403); ileride EOS SDK gerekir.
7. **İndirme davranışları (Faz C):** ✅ Tamamlandı — "oyun oynarken indirmeleri duraklat" ve **zamanlanmış otomatik güncelleme** (tek zamanlı `setTimeout`, idle polling yok) uygulandı.
8. **Kütüphane Vurgulama Ayarları Sadeleştirmesi (Dim vs Contrast Titles UX Yeniden Tasarımı):** ✅ `TAMAMLANDI` — İki ayrı bağımsız switch tek bir akıllı ve dengeli konsol ayarı altında birleştirildi: "Yüklü oyunları öne çıkar" (`highlightInstalled`, `HIGHLIGHT_INSTALLED_KEY`, varsayılan AÇIK). Kurulu olmayan oyunların hem kapakları hem başlıkları senkronize biçimde soluklaşarak yüklü oyunlar belirginleşir; hover ile ikisi birden anında canlanır. Geriye dönük uyumluluk ve 15 dilli yerelleştirme tamamlandı.

### Tamamlanan ek özellikler (kullanıcı talebiyle bu turda eklendi)

- **Bildirim merkezi** (`src/features/notifications/`): zil + okunmamış rozeti, kalıcı geçmiş, indirme/güncelleme/yedek olayları.
- **Oyun başına başlatma seçenekleri**: wrapper + ortam değişkenleri (yönetim sekmesi).
- **Stüdyo filtresi + gelişmiş arama** (`dev:`, `is:`).
- **Sistem tepsisi + kapatınca tepsiye küçültme** (arka planda indirme).
- **Oyun kapanınca otomatik save yedekleme**.
- **"En Çok Oynadıklarınız"** (profil, oyun süresi istatistikleri).

> ⚠️ **Karar (28.09.2026):** Yukarıdaki "Ücretsiz haftalık oyunlar rafı" maddesi artık geçerli değil —
> `src-tauri/src/legendary/freegames.rs` ve `src/features/freegames/freegames.ts` sırasıyla `16523bb` /
> `20e5cc5` ile silinmiş durumda ve **geri getirilmeyecek** (kullanıcı kararı). Kalan tüm izler
> (ölü `open-free-game` dalı, `epicStorePageUrl` yardımcısı, doküman referansları) temizlendi.
> TV Modu ise v0.1.17'de geri getirildi: `src/features/gamepad/tv-mode.ts` + `src/styles/tv-mode.css`.

---

## 6. v0.1.17 Öncesi/Sonrası Kapsamlı Denetim ve Öncelikli Backlog (28.09.2026)

> Bu bölüm, v0.1.16 → HEAD arasındaki **42 commit / 95 dosya / +13.006 −1.535** satırlık değişim
> üzerinde yapılan tam kod denetiminin (frontend + Rust + i18n + CSS + doküman) sonucudur.
> Her madde kanıt satırı içerir; işaretlenenler sırayla ele alınmalıdır.
>
> **Denetim anındaki doğrulamalar:** `npm.cmd run build` ✅ (tsc + vite, 0 hata) · `cargo test`
> **120/120** ✅ (3 canlı test ignored) · `git status` temiz.

### 6.1. Release blocker — v0.1.17 çıkış hazırlığı (AGENTS.md §4.11 + §10)

| # | İş | Kanıt / Konum |
|---|---|---|
| R1 | Sürüm numarası 3 dosyada güncellenmeli: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (hepsi hâlâ `0.1.16`) | `package.json`, `Cargo.toml:3`, `tauri.conf.json` |
| R2 | `CHANGELOG_DATA` içine `0.1.17` girdisi eklenmeli, `isCurrent` ona taşınmalı (en üstteki kayıt hâlâ `0.1.16`) | `src/features/changelog/changelog-view.ts` (ilk kayıt) |
| R3 | Pencere çubuğundaki sabit `v0.1.16` metni ve `S.appVersion` fallback'i güncellenmeli (boot'ta `getVersion()` ezer ama ilk kare yanlış) | `index.html:21`, `src/core/state.ts:328` |
| R4 | **`dl.executableNotFound` anahtarı 15 dilin HİÇBİRİNDE yok** → GOG oyunu başlatılamadığında kullanıcı ham anahtar görür | Rust: `src-tauri/src/gogdl/launcher.rs:20`; `t()` fallback zinciri `src/i18n.ts:91` |
| R5 | 13 dilde 14 anahtar eksik (`gog.webLogin`, `gog.pastePlaceholder`, `gog.syncing`, `gog.syncComplete`, `gog.syncFailed`, `gog.guideStep1..3Title/Desc`, `source.all`, `source.epic`, `filter.source`) → mağaza dropdown'u ve GOG kartı bu dillerde İngilizce kalır | `src/locales/{ar,de,es,fr,it,ja,ko,pl,pt-BR,ru,th,zh-Hans,zh-Hant}.json` |
| R6 | `docs/CHANGELOG_INTERNAL.md` **§173'te bitiyor**; GOG entegrasyonu, bulut yedekleme, hesap değiştirici, ayarlar/profil yeniden tasarımı, 0.1.17'nin tamamı iç günlüğe yazılmadı | `docs/CHANGELOG_INTERNAL.md` son satırlar |
| R7 | `tauri.conf.json` sürümü + `.github/workflows/release.yml` ile imzalı build; tag `v0.1.17` push; `latest.json` doğrulaması | AGENTS.md §10 |
| R8 | Windows kurulumu NSIS `setup.exe` ile yapılmalı notu README/sürüm notlarında hatırlatılmalı | AGENTS.md §10 |

### 6.2. Yüksek öncelik — mantık hataları

| # | Bulgu | Kanıt |
|---|---|---|
| B1 | **Bulut otomatik yedeği görünmez:** `trigger_auto_sync_on_exit` üç kez `cloud-backup-status` event'i yayıyor ama frontend'de bu kanalı dinleyen kimse yok → oyundan çıkışta otomatik yedek başarısız olsa bile kullanıcı hiçbir bildirim/toast görmez. `ipc-listeners.ts`'e listener + `pushNotification` bağlanmalı (veya event kaldırılmalı) | `src-tauri/src/cloud_backup/manager.rs:317-365`; dinleyici yok |
| B2 | **Koleksiyon sürükle-sıralama kırık:** `initCollectionTabs()` hâlâ `.lib-col-add` elemanını arıyor; dropdown dönüşümünden sonra bu eleman hiç üretilmiyor → sürükleme hiçbir şey yapmıyor, üstelik 5px'ten fazla kayan tıklamalar `consumeCollectionDragClick()` ile yutuluyor (koleksiyon seçilemiyor). Ya drag tamamen kaldırılmalı ya `.col-dropdown-list` içinde yeniden yazılmalı | `src/features/library/library-view.ts:747-798` (özellikle 771), `click-router.ts:401` |
| B3 | **Kütüphane görünürlük önbelleği bayatlayabilir:** `visibleSignature()` `.size` sayaçları kullanıyor (`epicFav.size`, `availableUpdates.size`, `playtimeMap.size`, `epicAchSummaries` anahtar sayısı) ve `epicCollections` içeriğini / `demoPlatinumApps`'i hiç içermiyor. Bir favoriyi bırakıp başkasını eklemek, koleksiyona oyun eklemek/çıkarmak veya demo platin değiştirmek liste güncellenmeden kalabilir → sayaç yerine revizyon numarası (`libraryDataRev`) ve koleksiyon değişiminde `invalidateLibraryVisibleCache()` çağrısı | `src/features/library/library-view.ts:96-116`; çağrı yalnız `gog-auth-actions.ts:108` + `drawer-view.ts:702` |
| B4 | **GOG yenileme butonu yok:** `gog-refresh` handler'ı var ama hiçbir şablon üretmiyor; kütüphane yenile butonu yalnız Epic'i senkronluyor (`syncEpicLibrary`). GOG kullanıcısı kütüphanesini elle yenileyemiyor | `src/features/events/handlers/auth-handlers.ts:130`; `library-view.ts:653` (`epic-refresh`) |
| B5 | **`prevent-modal-close` üç farklı görünümde kullanılıyor ama cover handler'ında yakalanıyor** (kapak, ekran görüntüsü taşıma, depolama). Doğru yer paylaşılan router olmalı; bugün yalnız "sıra şansı" ile çalışıyor | `cover-handlers.ts:57`, `cover-view.ts:158`, `screenshots-view.ts:583`, `storage-view.ts:112` |
| B6 | **Profil ID kopyalama handler'ı ölü** (`copy-account-id`) — buton kaldırıldı; `click-router.ts:305-313` silinmeli (veya Hesap kartına yeniden bağlanmalı) | `click-router.ts:305`; emisyon yok |
| B7 | **Presence varsayılanı çelişkili:** kod varsayılanı AÇIK (`st.presence_enabled ?? true`, state `presenceEnabled: true`) ama AGENTS.md "varsayılan kapalı" diyor. Karar verilip biri düzeltilmeli (öneri: kapalı) | `src/features/presence/presence.ts:39`, `src/core/state.ts:267`, `src-tauri/src/main.rs:46` |
| B8 | **`updateStatusBar()` tamamen ölü:** alt durum çubuğu DOM'dan kaldırıldı (`#statusbar-dl-text`, `#statusbar-version` index.html'de yok) — fonksiyon her render'da boşuna çalışıyor | `src/core/nav.ts:70-95`; `index.html`'de eleman yok |
| B9 | **Geri/İleri gezinme UI'ı yok:** `#nav-history-group`, `#nav-forward-btn`, `#gp-nav-back/forward` DOM'da yok; `nav-history-back/forward` act'leri ve `nav.historyForward` ayarı kaldırılmış. `updateNavHistoryUi()` yarısı ölü; sadece `Alt+Sol/Sağ` ve fare 3/4 tuşları çalışıyor. Karar: UI geri gelsin mi, kod mu temizlensin | `src/core/nav.ts:553-580`; `index.html:62` (yalnız `nav-back-btn`) |
| B10 | **Ekran görüntüsü alma butonu yok:** `capture-screenshot` handler'ı hiç üretilmiyor; yalnız global kısayol (varsayılan F12) ile çekim var. Buton bilinçli kaldırıldıysa handler + `ss.captureTip`/`ss.captureNow` ölü anahtarları silinmeli | `screenshot-handlers.ts:34`; `click-router`/şablonlarda emisyon yok |
| B11 | ✅ **TAMAMLANDI (28.09.2026, kullanıcı kararı: "tamamen sil"):** "özel legendary binary" özelliği kaldırıldı — `epic_set_alt_bin` komutu, `alt_legendary_bin` ayarı, `SetupStatus/E EpicSettings.alt_bin` alanları, `resolve_binary`/`ensure_binary` override parametreleri ve `dl.altBinaryFailed` anahtarı (15 dil) silindi. Tek yol: otomatik indirilen `%APPDATA%\com.efxlve.launcher\bin\legendary.exe` | `legendary/paths.rs`, `legendary/downloader.rs`, `legendary/commands.rs`, `gogdl/paths.rs` |
| B12 | **Drop-in `data-act` doğrulaması:** 16 handler dalı artık hiçbir şablon tarafından üretilmiyor (detay §6.4/D1) — bunlar "ölü buton" değil "ölü kod"dur; ama aralarında kaldırılan özelliklerin kalıntıları var | §6.4/D1 listesi |

### 6.3. Orta öncelik — optimizasyon ve sağlamlaştırma

| # | Bulgu | Kanıt / Öneri |
|---|---|---|
| O1 | Ana JS paketi **570,36 KB** (v0.1.16'da 476 KB) — Vite `>500 kB` uyarısı veriyor. GOG/cloud-backup/presence/screenshots gibi seyrek kullanılan modüller dinamik `import()` ile bölünmeli (AGENTS §10: düşük donanım + yavaş ağ) | `npm run build` çıktısı; `vite.config.ts` |
| O2 | Kütüphane dizilerinde **~30 adet O(N) `.find()/.some()/.filter()`** var (AGENTS §6.12 ihlali adayları). Sıcak yollar öncelikli: `input-listeners.ts:362,439`, `ipc-listeners.ts:304,326,410,431,518,528,555`, `screenshot-handlers.ts` (6 adet), `drawer-handlers.ts:81,134,139` → `summaryOf()` / `libraryItemOf()` O(1) haritalarına çevrilmeli; modal açılışları gibi soğuk yollar bırakılabilir | grep: `S.epicSummaries.(find|some|filter)` |
| O3 | `epicVisibleSummaries()` önbellek imzası **her çağrıda** `[...S.hiddenGames].sort().join(",")` + 8 string birleştirme yapıyor; scroll chunk'larında ve her render'da O(n log n) ek maliyet. Revizyon sayaçlarıyla (fav/updates/playtime/ach için tek `bump`) sabit maliyete indirilmeli | `library-view.ts:99-116` |
| O4 | Bildirim paneli açıkken her `render()` panelin `innerHTML`'ini yeniden kuruyor (indirme ilerlemesi gibi sık render'larda). `S.notifOpen` paneli için imza kontrolü eklenmeli | `src/features/notifications/notifications.ts:144-189`, `main.ts:97` |
| O5 | `pendingUpdateCount()` + `updateSidebarGames()` her `updateBadge()` çağrısında tüm oyunları tarıyor; sidebar için imza kontrolü var ama rozet için yok — sayaçlar tek geçişte hesaplanabilir | `src/core/nav.ts:34-45, 59-67` |
| O6 | `getCollator()` içinde `S.trCollator` yan etki olarak atanıyor; profil/kütüphane sıralamaları için tek kaynak olmalı (şu an çalışıyor, dokümante edilmeli) | `library-view.ts:73-87` |
| O7 | Rust: async gövdelerde küçük `std::fs::read_to_string` çağrıları var (düşük risk). Yoğun dosyalarda `tokio::fs`'e taşınabilir | `commands.rs:595,1088,1290`, `profile.rs:631-660`, `library_playtime.rs:87` |
| O8 | `gogdl/transfers.rs` içinde 5 adet `GOG_DL_STATE.lock().unwrap()` — mutex zehirlenmesi panic üretir; `unwrap_or_else(|e| e.into_inner())` veya `map_err` tercih edilmeli | `gogdl/transfers.rs:229,292,356,423,447` |
| O9 | `legendary/transfers.rs:2630-2692` test bloğunda `unwrap()`lar var (test olduğu için kabul; üretim kodu değil) — denetimde karışmaması için not | aynı dosya |
| O10 | "Aynı İngilizce metin" sayıları: `de` 105, `fr` 83, `it` 76, `pt-BR` 76, `pl` 73 — çeviri turu planlanmalı (ROADMAP §5.1 ile birleşir) | i18n denetimi |

### 6.4. Ölü kod temizliği (AGENTS §4.2 sıfır tolerans)

| # | Bulgu | Kanıt |
|---|---|---|
| D1 | **Emisyonu olmayan handler dalları** (silinecek veya yeniden bağlanacak): `copy-account-id`, `nav-history-back`, `nav-history-forward`, `open-free-game`, `epic-filter`, `open-collection`, `back-to-collections`, `play`, `stop`, `cancel`, `install`, `uninstall`, `dl-reset-cdn`, `dl-save-install-dir`, `gog-refresh`, `ach-scope`, `toggle-demo-platinum`, `open-dlc-manager`, `capture-screenshot`, `reset-custom-cover` | `click-router.ts:238,245,252,305,382,443,451,491-494`; `downloads-handlers.ts:211,302`; `auth-handlers.ts:130`; `drawer-handlers.ts:29,196,220`; `screenshot-handlers.ts:34`; `cover-handlers.ts:290` |
| D2 | **Kullanılmayan export'lar (gerçek ölü fonksiyonlar):** `libraryCoverPlayBtn` (game-view.ts:75 — sadece alias), `recordNavHistory` (render.ts:49), `getAllLibraryItems`, `fmtSize` (utils.ts), `mergeEpicServerPlaytimes`, `getRecentInstalls`, `NavHistoryItem`, `GameVersion`, `GogSetupStatus`, `matchSystemLanguage`, `applyStaticTranslations`, `NotifInput`/`hideAchievementIds`/`saveCustomAvatar`/`cleanSteamGridSearchTerm`/`checkEosOnce`/`isPaletteOpen`/`unreadCount`/`renderChrome` vb. (106 aday; çoğu "yalnız kendi dosyasında kullanılan gereksiz export") | `%TEMP%\audit-exports.mjs` çıktısı |
| D3 | **tsc `--noUnusedLocals` 8 gerçek bulgu:** `nav.ts(12) canonicalGameTitle`, `state.ts(51) GameSource`, `cloud-backup-actions.ts(21) CloudBackupProvider`, `cloud-backup-view.ts(8) fmtBytes`, `drawer-widgets.ts(15) formatScreenshotDate`, `drawer-widgets.ts(17) EpicAchievementSummary`, `auth-handlers.ts(44) t`, `gamepad.ts(92) e` | `npx tsc --noEmit --noUnusedLocals` |
| D4 | **65 ölü i18n anahtarı** (ör. `settings.dimUninstalledTitle/Desc`, `settings.contrastTitlesTitle/Desc`, `col.preset*` 14 adet, `nav.epicStore/gogStore`, `drawer.statistics/options`, `ss.captureTip/captureNow`, `nav.switchAccounts`, `accounts.soon` …) — `localStorage` migration anahtarları kodda kalacak, sadece çeviriler silinecek | i18n denetimi (en.json 1.357 anahtar) |
| D5 | **Ölü CSS blokları (~40 aday):** `components.css`: `ps5-btn*`, `apple-segmented-rail`, `apple-segment`, `apple-search-box`, `toggle-switch/slider`, `modal-overlay`, `ctx-menu`, `tpl-*` (13 adet); `game-page.css`: `gp-back`, `hub-card-link`; `library.css`: `pcard-meta`, `lib-col-add` (21-27); `settings.css`: `settings-danger`; `shell.css`: `sb-games-empty`; `modals.css`: `col-quick-btn`, `col-marker-clear-btn`, `col-label`, `col-quick-label`; `accounts.css`: `acc-card-soon` | CSS denetimi (`kind-*`, `tier-*`, `apple-pill-btn` dinamik olduğu için korunacak) |
| D6 | ✅ **KAPANDI (28.09.2026):** `epic_set_alt_bin` silindi (B11); `epic_status`, `epic_capture_game_screenshot`, `epic_get_screenshot_hotkey`, `cloud_backup_get_sync_status` ve `CloudSyncStatus` modeli kaldırıldı; ayrıca `epic_get_settings` çift kaydı düzeltildi → **141 komut / 141 kayıt / 0 çağrısız** | `main.rs` generate_handler |
| D7 | **Rust `#[allow(dead_code)]` 8 nokta** (gogdl modelleri, paths, playtime, profile) — GOG API uyumluluğu için tutulanlar belgelenmeli, gerisi silinmeli | `gogdl/mod.rs:18`, `gogdl/models.rs:31,44,106`, `gogdl/paths.rs:8`, `legendary/playtime.rs:57`, `legendary/profile.rs:106` |
| D8 | `src/styles/tv-mode.css` ve `src/features/gamepad/tv-mode.ts` silinmiş ama `docs/CODEBASE_MAP.md:55,59` hâlâ listeliyor (bkz. §6.6) | `CODEBASE_MAP.md` |

### 6.5. Eksik / yarım özellikler

| # | Bulgu | Kanıt / Öneri |
|---|---|---|
| E1 | ✅ **KARAR (28.09.2026): geri getirilmeyecek.** Ücretsiz haftalık oyunlar tamamen kaldırıldı; kalan izler (ölü `open-free-game` dalı, `epicStorePageUrl`) temizlendi ve dokümanlar güncellendi | `git log -- '*freegames*'`; emisyon taraması: 0 |
| E2 | ✅ **GERİ GETİRİLDİ (28.09.2026):** TV Modu `src/features/gamepad/tv-mode.ts` + `src/styles/tv-mode.css` ile yeniden yazıldı (Epic + GOG birleşik raflar, A/B/X/LB-RB/D-Pad, klavye ve fare desteği). Giriş noktaları: Ayarlar > Görünüm satırı, Ctrl+K komutu ve kumanda bağlanınca çıkan öneri. AGENTS.md/CODEBASE_MAP/DESIGN_SYSTEM senkron | `tv-mode.ts`, `settings-view.ts`, `palette.ts`, `gamepad.ts` |
| E3 | **Geri/İleri UI'ı yok** (B9) — geri butonu `#nav-back-btn` tek başına duruyor; ileri butonu yok. İleri gitme sadece `Alt+Sağ` / fare 4 ile mümkün ve keşfedilebilir değil | `index.html:62` |
| E4 | **Ekran görüntüsü alma** yalnız F12 ile; UI'da ipucu yok (ölü `ss.captureTip` anahtarı bunun kanıtı). Oyun sayfasına "Ekran görüntüsü al" butonu (oyun çalışırken) geri getirilebilir | D2/D4 |
| E5 | **GOG tarafında `dl.freeGames` benzeri içerik yok**; GOG "in library" / claim akışı desteği yok (yalnız sahip olunanlar listelenir) — GOG planına eklenebilir | `docs/GOG_SUPPORT_PLAN.md` |
| E6 | **Bildirim merkezi kapsamı:** güncelleme/indirme/bulut/hata var; AGENTS'ın "gelecek iş" notundaki **istek listesi indirimi**, **ön siparişe açılan oyun** ve **arkadaş çevrimiçi** bildirimleri yok | `docs/ROADMAP.md` §5 gelecek iş notları |
| E7 | **EOS Overlay otomatik kurulum** kapsam dışı bırakılmış (bilinçli) — README/AGENTS'ta "tespit + rozet" olarak kalmalı; kullanıcıya kurulum yönlendirmesi Ayarlar'dan yapılabiliyor mu kontrol edilmeli | `src-tauri/src/eos.rs`, `features/eos/eos-install.ts` |
| E8 | ✅ **TAMAMLANDI (28.09.2026, ilk faz):** GOG Galaxy kurulu oyun tespiti + içe aktarma + senkron. `gogdl/galaxy.rs`: registry taraması (`HKLM\...\WOW6432Node\GOG.com\Games`, 64-bit görünüm ve `HKCU`), klasör doğrulaması, `.info` tercihli kayıt; komutlar `gog_detect_galaxy_games` / `gog_sync_galaxy_installed`; Ayarlar > Entegrasyonlar'da GOG Galaxy kartı (tara/içe aktar + bulunan oyun listesi). **Kaldırma senkronu:** `gog_uninstall_game` artık Galaxy registry anahtarını da siler (Epic `.item` temizliğinin eşdeğeri). **Güncelleme senkronu:** gogdl kurulum/güncelleme bitince `sync_galaxy_version` registry'deki `version`/`buildId` alanlarını günceller → Galaxy aynı güncellemeyi tekrar önermez (best effort; HKLM için yönetici gerekir). Kalan: Galaxy'nin kendi SQLite veritabanını (galaxy-2.0.db) yazma riski değerlendirilmedi (Galaxy açıkken önerilmez); `goggame-<id>.info` üzerinden `.info` senkronu ayrıca izlenebilir | `src-tauri/src/gogdl/galaxy.rs`, `gogdl/transfers.rs`, `settings-view.ts`, `auth-handlers.ts` |

### 6.6. Doküman senkronu (yanlış bilgi veren dosyalar)

| # | Sorun | Kanıt |
|---|---|---|
| S1 | `AGENTS.md` §1/§9: "**1.241 anahtar**" → gerçek en.json **1.357 anahtar** (tr ile tam eşit) | i18n denetimi |
| S2 | `AGENTS.md` §1/§9: `legendary/freegames.rs`, TV Modu (`gamepad/tv-mode.ts`), EOS/RPC varsayılanları → koddan farklı (B7, E1, E2) | aynı |
| S3 | `docs/CODEBASE_MAP.md` (25.09): silinmiş `freegames/`, `tv-mode.ts` listeliyor; `cloud_backup/`, `updates/`, `notifications/`, `accounts/`, `install/`, `storage/`, `presence/`, `changelog/`, `eos/` modülleri eksik olabilir | `CODEBASE_MAP.md:55,59` |
| S4 | `docs/TAURI_IPC_REFERENCE.md`: "**98 komut**" → gerçek **143 komut** (143/143 kayıtlı) | `TAURI_IPC_REFERENCE.md:4` |
| S5 | `docs/REFACTOR_PLAN.md` §6.5: `main.ts 113 satır` → **116**, `click-router 662` → **640**, `commands.rs ~3.060` → **3.060** (doğru), `transfers.rs ~2.700` → **2.700** (doğru), `main.rs ~1.969` → **1.969** (doğru); ayrıca "F5/F6 planlandı" yazıyor ama AGENTS "modülerleştirme tamamlandı" diyor | `REFACTOR_PLAN.md:139-168` |
| S6 | `docs/ROADMAP.md` §5 "tamamlandı" işaretli Free Games maddesi + `legendary/freegames.rs` referansı artık yanlış | aynı dosya |

### 6.7. Bilinen riskler / izlenmesi gerekenler (düşük öncelik)

- **`S.downloads` Map'i:** rozet için her taramada tüm aktif indirmeler dolaşılıyor; 500 oyunluk kütüphanede ölçüldü, sorun değil.
- **`gogdl` manifest/`api_client` dosyaları** 641 satır — 1.500 limitine yakın; GOG büyürse bölünmeli (`gogdl/api_client.rs`, `gogdl/transfers.rs` 678).
- **`legendary/profile.rs` 1.060**, `screenshots.rs` 1.353, `move_game.rs` 961, `eos.rs` 942 — limitin altında ama izlenmeli.
- **`dist/` klasörü repoda değil** (doğru); build çıktıları commit edilmemeli.
- **`presence` LAUNCHER_ICON** sabit bir commit hash'ine (`@b371b6b`) bağlı — commit geçmişi değişirse (force-push/rebase) Discord görseli kırılır; tag veya `main` kullanılmalı. Kanıt: `src/features/presence/presence.ts:16-17`.

---

### 6.8. Uygulama Durumu — 28.09.2026 (Sürüm 0.1.17 Hazırlığı + Kritik Hatalar)

> Kapsam: §6.1 (R1-R6) + §6.2 (B1-B10) uygulandı. Doğrulama: `npm.cmd run build` ✅,
> `cargo test` **120/120** ✅, i18n 15/15 tam parite, IPC 143/143 komut + 0 ölü olay.

**Tamamlananlar:**
- ✅ **R1/R3** — Sürüm **0.1.17**: `package.json`, `package-lock.json`, `Cargo.toml`, `tauri.conf.json`, `index.html` hapı, `state.ts` fallback'i.
- ✅ **R2** — `CHANGELOG_DATA` 0.1.17 kaydı (TR/EN 15 madde) + `isCurrent` taşındı.
- ✅ **R4/R5** — `dl.executableNotFound` 15 dile; 13 dildeki 14 eksik GOG/filtre anahtarı çevrildi; ölü `statusbar.*` + `ss.capture*` anahtarları silindi → **1.352 anahtar, tam parite**.
- ✅ **R6** — `docs/CHANGELOG_INTERNAL.md` **§174** (0.1.17 kapsamı + denetim düzeltmeleri) yazıldı.
- ✅ **B1** — `cloud-backup-status` ölü olayı kaldırıldı; otomatik bulut yüklemesi `cloud-sync-complete` yayıyor, hata toast + bildirim merkezine düşüyor.
- ✅ **B2** — Koleksiyon sürükle-sıralama dikey dropdown listesine uyarlandı; hayalet `.lib-col-add` bağımlılığı ve CSS'i silindi; sürükleme tıklaması doğru dalda (`select-col-filter`) yutuluyor.
- ✅ **B3** — `visibleSignature()` yalnız `libraryDataRev` temelli; tüm ilgili yazarlar (fav, gizleme, güncelleme, süre, başarım, koleksiyon, demo platin) rev bump'lıyor.
- ✅ **B4** — Kütüphane yenile düğmesi iki mağazayı da eşitliyor; ölü `gog-refresh` dalı silindi.
- ✅ **B5** — `prevent-modal-close` paylaşılan yönlendiriciye taşındı (kapak handler'ından çıkarıldı).
- ✅ **B6** — Hesaplar sayfasına kopyalanabilir Hesap ID çipi eklendi; `copy-account-id` handler'ı yeniden canlı.
- ✅ **B7** — Discord Presence varsayılanı kapalı (opt-in) olarak dokümanla eşitlendi.
- ✅ **B8** — Ölü `updateStatusBar()` kaldırıldı; pencere sürüm hapı `updatePageHeader()`'a taşındı.
- ✅ **B9** — `nav-history-back/forward` ölü dalları silindi, `updateNavHistoryUi()` yalnız gerçek geri düğmesini yönetiyor.
- ✅ **B10** — Ölü `capture-screenshot` handler'ı ve ona bağlı ölü anahtarlar kaldırıldı.
- ✅ **D3** — `tsc --noUnusedLocals` 8 bulgu temizlendi (0 hata).

**Açık kalanlar (sonraki tur):**
- ✅ **B11 (kapalı, 28.09.2026):** "özel legendary binary" özelliği kullanıcı kararıyla **tamamen kaldırıldı** (komut + ayar alanı + `resolve_binary`/`ensure_binary` override'ları + `dl.altBinaryFailed` anahtarı).
- 🚧 **§6.4/D1-D2, D8** — Kalan ölü handler dalları (`epic-filter` kaldırıldı; `copy-account-id`, `capture-screenshot`, `gog-refresh`, `nav-history-*` artık canlı/silindi) ve kalan ~50 "gereksiz export" (yalnız kendi dosyasında kullanılan semboller). 28.09.2026 turunda **14 ölü dal, ölü CSS blokları ve 12 ölü fonksiyon** temizlendi.
- 🚧 **§6.3/O1-O10** — Paket bölme (vite `vendor`/`icons` ayrıldı; derin bölme handler seviyesinde dinamik import gerektirir), Rust dosya bölünmeleri (`commands.rs` 3.060, `transfers.rs` 2.703, `main.rs` 1.969, `screenshots.rs` 1.353).
- 🚧 **§6.6/S3-S5** — ✅ CODEBASE_MAP yeniden yazıldı, ✅ IPC_REFERENCE 143 komut + tam dizin, ✅ REFACTOR_PLAN sayaçları güncellendi.
- 🚧 **R7/R8** — İmzalı build + `v0.1.17` tag push + `latest.json` doğrulaması (kullanıcı onayı/secrets gerekir).

### 6.9. 28.09.2026 ikinci tur (kullanıcı geri bildirimleri + ölü kod + optimizasyon)

- **Epic güncelleme tekrarı düzeltildi:** legendary kurulum/güncelleme sonrası EGL `.item` manifestindeki `AppVersionString`/`InstallSize` senkronlanıyor (`cache.rs::sync_egl_manifest_version`, `transfers.rs` başarı dalında); resmi Epic Launcher artık aynı güncellemeyi tekrar önermiyor. Birim testi eklendi (124 test).
- **"Oyun hakkında" sırası düzeltildi:** Wikipedia fallback'i artık mağaza verisi (Epic requirements/description, GOG details) **tamamlanmadan** başlamıyor; kısa süreliğine wiki metni görünüp mağaza metniyle değiştirilmesi engellendi (`storeAboutSettled` + `maybeLoadWikiAbout`).
- **Bulut yedekleme UI tamamlandı:** Yönet sekmesindeki bulut satırına "en son yedek" bilgisi + **Buluttan Geri Yükle** ve **Bulut Yedeğini Sil** düğmeleri eklendi (backend zaten hazırdı, erişilemiyordu). `cloud.latestBackup` anahtarı 15 dile eklendi.
- **TV Modu geri getirildi** (§6.5/E2).
- **Ölü kod temizliği:** `copy-account-id` yeniden canlandı (hesap ID çipi), `capture-screenshot`/`gog-refresh`/`epic-filter`/`open-collection`/`back-to-collections`/`play`/`stop`/`cancel`/`install`/`uninstall`/`dl-reset-cdn`/`dl-save-install-dir`/`ach-scope`/`toggle-demo-platinum`/`open-dlc-manager`/`reset-custom-cover`/`nav-history-*`/`open-free-game` dalları silindi; `activeAchScope` state alanı kaldırıldı; `epicStorePageUrl`, `epicStoreSearch` (kullanılmıyorsa), `fmtSize`, `getAllLibraryItems`, `libraryCoverPlayBtn`, `recordNavHistory`, `setLibraryPageSize`, `epicStatus`, `cloudBackupGetSyncStatus`, `gogSetupStatus`, `epicCaptureGameScreenshot`, `epicGetScreenshotHotkey` kaldırıldı.
- **Optimizasyon:** ~30 `S.epicSummaries.find/some` çağrısı O(1) `summaryOf()`'a çevrildi; bildirim paneli imza korumalı hale getirildi; `vite.config.ts` vendor/icons chunk ayrımı + İngilizce yorumlar; `gogdl` mutex kilitleri zehirlenmeye dayanıklı (`unwrap_or_else(|e| e.into_inner())`).
- **Doküman senkronu:** CODEBASE_MAP yeniden yazıldı (28 feature, 44 Rust dosyası, 1.361 anahtar), IPC_REFERENCE 143 komut + üretilen tam dizin + `cloud-sync-complete`/`screenshots-updated` olayları, REFACTOR_PLAN sayaçları; `open-free-game`/freegames referansları temizlendi.
- **i18n:** 1.361 anahtar, 15 dil tam parite (TV Modu 8 anahtar + bulut 1 anahtar eklendi).

### 6.20. 28.09.2026 on üçüncü tur (v0.1.17 sürüm hazırlığı)

- **Masaüstü kısayolu başlatma hatası (kullanıcı/arkadaş bildirimi):** "Kısayoldan TLOU 2 açtım; oyun açılmaya başlıyor ama hemen kapanıyor, launcher içinden açınca sorun yok."
  - **Kök neden:** `epic_create_desktop_shortcut`, `.lnk` hedefini **oyunun exe'sine** yazıyordu. Bu yol `legendary launch`'ın sağladığı argümanları/ortamı atladığı için Epic oyunları (özellikle DRM/entitlement kontrolü yapanlar) açılıp kapanıyordu.
  - **Düzeltme:** Kısayol artık launcher'ı hedefliyor: `TargetPath = <launcher exe>`, `Arguments = --launch "<app>"`, `IconLocation = <oyun exe>,0`. Launcher açılışta `--launch` argümanını `parse_launch_arg` ile ayrıştırıp `PendingLaunch` state'ine koyuyor; önyükleme bitince arayüz `epic_take_pending_launch` ile alıp **normal oynatma hattından** (`epicPlay`) başlatıyor. Böylece oynanış süresi/oturum takibi ve hata mesajları da aynı yoldan geçiyor.
  - **Test:** `parse_launch_arg` birim testleri (her iki biçim, boş/eksik değer, `--launcher` yanlış eşleşmemesi).
  - **Bilinçli sınırlama:** `tauri-plugin-single-instance` eklenmedi; updater'ın yeniden başlatma akışıyla yarışıp güncellemeyi düşürme riski nedeniyle ertelendi. Launcher zaten açıkken kısayol ikinci bir pencere açar (oyun yine doğru başlar).
- **TV Modu butonu gizlendi (kullanıcı isteği):** Ayarlar > Görünüm'deki "Open TV Mode" satırı kaldırıldı; `settings.tvModeTitle`/`settings.tvModeDesc` anahtarları silindi. TV Modu'na Ctrl+K komutu ve kumanda bağlanma önerisi ile erişim sürüyor.
- **Güvenlik/açık taraması:** API anahtarı/token/secret/private key/`.env`/`.key`/`.pem`/`credentials.json` **yok**; oturumda kullanılan tüm kimlik değerleri repoda bulunamadı; git geçmişi temiz; kişisel veri/yerel yol yok. (GOG istemci bilgileri gogdl'ın herkese açık istemci kimlikleri; updater `pubkey` açık anahtar.)
- **Changelog:** 0.1.17 girdisi 9 maddeye indirildi, anahtar sayısı 1305 yapıldı, "More bugs added." esprisi eklendi.
- **Doğrulama:** `cargo check` 0 uyarı, `cargo test` **126** (+3 ignored), `npm.cmd run build` ✅, `tsc --noUnusedLocals` 0 hata, i18n 15/15 parite (1.305), IPC **142**.

### 6.19. 28.09.2026 on ikinci tur (arkadaş özelliklerinin tamamen kaldırılması)

- **Kullanıcı kararı:** "Arkadaşlar hakkında (Epic + GOG + EOS SDK) bunların hepsini silelim. Bir işe yaramıyorlar. Bir temizlik yapalım, sonra Discord ile uğraşalım." Ayrıca: "Güvenlik açığı oluşturacak çok iş yaptık gibi."
- **Silindi:** `src/features/friends/` (Arkadaşlar sayfası), `src/styles/friends.css` (+`index.css` importu), kenar çubuğu girdisi, `View` tipi `"friends"`, Ctrl+K komutu, click-router dalları (`friends-filter`, `friends-accept`, `friends-decline`, `friends-search-clear`, `refresh-friends`), input-listener (`friends-search`), `legendary/friends.rs` (+4 komut ve 3 canlı test), `gogdl` arkadaş komutları (`gog_friends`, `gog_friends_presence`), `GogFriend` modeli, `fetch_gog_friends`/`parse_gog_friends`/`fetch_presence`/`parse_presence` + testleri, `epic.ts`/`gog.ts` arkadaş tipleri, tüm arkadaş state alanları, 26 `friends.*` i18n anahtarı.
- **Korundu:** **GOG presence kalp atışı** (`gogdl/presence.rs`, `send_presence`; kullanıcı "Galaxy'de çevrimiçi görünmek" özelliğini ayrıca istemişti), Discord Rich Presence, EOS overlay tespiti + oyun bazlı EOS rozeti.
- **Güvenlik notu:** Epic hesabında **yazma** yapan tek özellik (arkadaş kabul/çıkarma) ve `chat.gog.com` üzerinden kişi verisi okuma kaldırıldı; EOS kimlik dosyası zaten silinmişti. Geriye kalan tek yazma işlemi kendi GOG durumumuzu bildiren kalp atışı.
- **Sıradaki adım:** Discord entegrasyonu (Social SDK: arkadaş listesi + presence + DM) — kullanıcı onayı sonrası ayrı tur.
- **Doğrulama:** `cargo check` 0 uyarı, `cargo test` **124** (+3 ignored), `npm.cmd run build` ✅, `tsc --noUnusedLocals` 0 hata, i18n **1.307 anahtar** 15/15 parite, 0 ölü anahtar, IPC **141** komut.

### 6.18. 28.09.2026 on birinci tur (EOS SDK denemesi: ürün kapsamlı sosyal grafik)

- **Amaç:** Kullanıcının arkadaşının önerisiyle Epic'te **canlı** çevrimiçi durumu EOS SDK ile almak (REST yolları tükendiği için).
- **Yapılanlar:** Dev Portal ürününden **EOS C SDK v1.19.2.1** indirildi (`src-tauri/vendor/eos-sdk/`, gitignore'da); `libloading` ile çalışma anında yüklenen FFI yazıldı (v1.19.2.1 başlıklarından birebir: `EOS_Platform_Options` API 15, `EOS_Auth_Credentials` API 4, `EOS_Presence_*` API 1/3, tüm fonksiyonlar DLL'den export, `__stdcall` → `extern "system"`). Akış: `EOS_Initialize` → `EOS_Platform_Create` (ürün kimlikleri) → `EOS_Auth_Login` (`EOS_LCT_ExchangeCode`, `basic_profile|friends_list|presence`) → `EOS_Presence_QueryPresence` + `CopyPresence` (+ `EOS_Connect_Login`, `EOS_Friends_QueryFriends`).
- **Sonuç (çalıştı ama işe yaramadı):** Giriş başarılı, **kendi presence'ımız `online`** döndü ✓. Ancak: `EOS_Friends_QueryFriends` **0 kayıt**, 18 Epic arkadaşının tamamı `EOS_NotFound`, `EOS_Connect_Login` (`EOS_ECT_EPIC_ID_TOKEN` → `EOS_InvalidUser`, `EOS_ECT_EPIC` → `ExternalTokenValidationFailed`). Yani **EOS sosyal grafiği ürün kapsamlı**; Epic genelindeki arkadaş durumu yalnızca Epic'in kendi ürününde (EGS launcher) görünür. Üçüncü taraf ürünle bu veri **alınamaz** — SDK dahil.
- **Karar (kullanıcı onaylı geri alma):** `eos_sdk/`, `eos_social.rs`, `libloading`, 10 i18n anahtarı ve komut kayıtları silindi; `%APPDATA%\…\eos\credentials.json` (client secret) temizlendi. Epic tarafı **son görülme + arkadaşlık istekleri** ile kalıyor; GOG tarafı canlı durum + kalp atışı ile çalışmaya devam ediyor.
- **Kalıcı bilgi:** Bu araştırma tekrar edilmesin diye tüm uç sonuçları (403/401/404/400, `client_missing_application_id`, `SCOPE_CONSENT`, `EOS_NotFound`) yukarıda ve §6.17'de kayıtlı.

### 6.17. 28.09.2026 onuncu tur (sosyal özellikler: canlı presence + arkadaşlık istekleri)

- **Karar (kullanıcı):** "İleride değil şimdi ekle. Bu 2 mağazanın sosyal özelliklerini olabildiğince çalışır hale getirelim."
- **GOG — canlı çevrimiçi durumu (doğrulandı):** `GET https://presence.gog.com/statuses?user_id=id1,id2,...` (Bearer; 250 id/istek) yalnız **şu an çevrimiçi** kullanıcıları döndürüyor → `gogdl/api_client.rs::fetch_presence` + `parse_presence` + `gogdl::commands::gog_friends_presence` (IPC 147). Ayrıca `chat.gog.com/users/{id}/invitations` ucu çalışıyor ama kabul akışı belgelenmediği için kapsam dışı.
- **Epic — son görülme + istekler (doğrulandı):** `GET https://presence-public-service-prod.ol.epicgames.com/presence/api/v1/_/{accountId}/last-online` tek istekle tüm arkadaşlar için `{ "<accountId>": [{ "last_online": "…" }] }` döndürüyor → `epic_friends_presence` (hafif yenileme) ve `epic_friends` yanıtına `lastOnline`. `friends/api/v1/{accountId}/summary` ayrıca `incoming` (gelen istekler), `outgoing`, `suggested`, `blocklist` veriyor → `EpicFriendsData.incoming`. Eylemler: `POST`/`DELETE /friends/api/v1/{accountId}/friends/{friendId}` → `epic_friend_accept` / `epic_friend_remove`.
- **Sınır (dürüst not):** Epic'te **canlı** çevrimiçi durumu bu token'la okunamıyor (presence servisi `GET .../presence/*` çağrılarına 403/405 veriyor; EOS overlay gerekiyor). Bu yüzden Epic satırlarında yeşil nokta yok; "Son görülme" gösteriliyor. GOG'da yeşil nokta gerçek presence verisinden geliyor.
- **Arayüz:** `friends-view.ts` — aktifler önce sıralama (çevrimiçi → son görülme → ad), **Aktif** filtresi (yeşil/15 dk), satır metası `alias · Şu an çevrimiçi | Son görülme: 3 sa önce · N ortak arkadaş`, üstte `{count} arkadaş · {count} çevrimiçi · Güncellendi: …`, gelen istekler kartı (Kabul Et / Yoksay). Presence 60 sn'de bir yalnız sayfa açıkken yenileniyor; çıkışta zamanlayıcı kendini durduruyor, pencere gizliyken istek atılmıyor. `relativeTime()` artık `core/utils.ts`'te (bildirim merkezi de kullanıyor).
- **i18n:** 12 yeni anahtar × 15 dil (`friends.filterActive/onlineNow/lastSeen/mutual/requestsTitle/accept/decline/actionFailed/accepted/declined/onlineCount/updated`), ölü `friends.note` silindi → **1.331 anahtar** tam parite.
- **Test:** `cargo test` **135** (4 yeni: 2 GOG presence, 1 Epic last-online, 1 gelen istek sıralama), `tsc --noUnusedLocals` 0 hata, IPC **147**.
- **Hata düzeltmesi (kullanıcı bildirimi "Epic arkadaşları görünmüyor"):** `loadFriendsView`, `loadFriends`'i çağırmadan önce `S.friendsLoading = true` yapıyordu; `loadFriends`'in ilk koruması (`if (S.friendsLoading && !force && !replace) return;`) bu yüzden hemen dönüyor ve **Epic listesi hiç çekilmiyordu** (GOG tarafı kendi fetch'ini yaptığı için yalnız GOG arkadaşı görünüyordu). Bayrak yönetimi tamamen `loadFriends`'e bırakıldı. Ayrıca hata satırı artık `rows.length === 0` koşuluna bağlı değil: bir mağaza hata verse bile diğer mağazanın satırları varken görünüyor (yeni `friends.errorTitle` + "Tekrar Dene"; liste boşsa boş durum yerine hata bloğu). i18n **1.332 anahtar**.
- **Canlı doğrulama (kullanıcı izniyle, `#[ignore]` testler):** `live_fetch_friends` → **18 arkadaş + 5 gelen istek** (isim + son görülme); `live_friend_action_probe` → geçersiz id'de POST/DELETE 404 (yol ve yetki doğru; 401/403 değil); `live_friend_accept_and_remove` → en yeni istek kabul edildi (**18→19 arkadaş**, istek **5→4**), sonra kaldırıldı (**19→18**) → Kabul Et / Yoksay / Arkadaştan Çıkar yolları uçtan uca çalışıyor. Bu üç test `cargo test -- --ignored` ile tekrar çalıştırılabilir.

#### 6.17.1. GOG'da çevrimiçi görünme (ikinci tur)

- **Kullanıcı bildirimi:** "Arkadaşımın dediğine göre ne Epic'te ne GOG'da açık görünüyorum." — Launcher hiç presence sinyali göndermiyordu.
- **Çözüm (`gogdl/presence.rs`):** Resmî Galaxy istemcisi gibi `POST https://presence.gog.com/users/{id}/status` kalp atışı (4 dk aralık; yalnız GOG oturumu varken; 401'de token yenile + tekrar dene). Uygulama kapanışında `RunEvent::Exit` → `DELETE .../status` (3 sn timeout). Böylece launcher açıkken arkadaşlar seni GOG'da **çevrimiçi** görür; çökme/öldürme durumunda sunucu durumu kendiliğinden düşürür. Canlı test: `live_presence_heartbeat` → heartbeat sonrası `GET /statuses` hesabı online listeliyor.
- **Not (dürüstlük):** `version=…` gövdesi servis tarafından 400 ile reddediliyor (yalnız boş gövde 204 dönüyor) — bu yüzden kalp atışı gövdesiz gönderiliyor.
- **Epic tarafı (kapsam dışı, kanıtlı):** Canlı Epic presence'ı ne okunabiliyor (`/friends/presence` 403, `scope=presence` ile yenilenen token bile) ne yazılabiliyor (PATCH 400 / DELETE 403); resmî launcher bunu EOS SDK ile yapıyor. Arayüz Epic için yalnız "son görülme" gösteriyor ve bunu tek satır notla açıklıyor (`friends.epicNote`).

### 6.16. 28.09.2026 dokuzuncu tur (arkadaşlar tek sayfada: Epic + GOG birleşik liste)

- **Karar (kullanıcı):** Profildeki arkadaş listesi kaldırılır, sol menüye ayrı **Arkadaşlar** sayfası eklenir; Epic + GOG arkadaşları bir arada listelenir. Epic'in Steam/PSN/Xbox platform çipleri istenmiyor. "Aktif olanları listeleyelim" isteği için: **çevrimiçi durum** Epic tarafında (launcher token'ı presence servisinden 403 alır) ve GOG tarafında (yalnız websocket) API ile alınamıyor → sayfa herkesi ada göre listeler, altında tek satırlık dürüst not durur ("Çevrimiçi durum henüz mağaza API'leri tarafından paylaşılmıyor."). Presence ileride EOS SDK / GOG sohbet soketiyle eklenebilir; görünüm buna hazır.
- **Profil temizliği:** `profile-view.ts` içindeki `renderFriendsSection` + `platformLabel` (Steam/PSN/Xbox) tamamen silindi; `openProfile()` ve click-router profil dalı artık `loadFriends` çağırmıyor, `refresh-profile` yalnız profili tazeliyor. Eski `.friends-list/.friend-row/.friend-plats` CSS'i `profile.css`'ten çıkarıldı.
- **Yeni görünüm:** `View` tipine `"friends"`; sol menüde İndirmeler ile Ayarlar arasına `<button class="sb-item" data-view="friends">` (lucide `users` ikonu; `createIcons` kaydı); Ctrl+K komutu (`friends.title`); `main.ts` render dalı; `nav.ts` başlık haritası. Sayfa `friends-view.ts`: `[Tümü | Epic Games | GOG.COM]` sekmeleri, `friends-search` (yerinde yama → odak korunur), yenile düğmesi (`refresh-friends` → iki mağaza paralel), sayaç + not satırı, `list`/`row` bileşen dilinde satırlar (36px yuvarlak avatar veya baş harf, ad, alias, sağda `EPIC`/`GOG` jetonu).
- **Backend (GOG arkadaşları):** `gogdl/api_client.rs` → `fetch_gog_friends(user_id, access_token)` (`GET https://chat.gog.com/users/{id}/friends`, Bearer) + test edilebilir `parse_gog_friends` (boş id/ad atlanır, `//` avatar → `https:`, id sayı ya da metin, ada göre sıralama). `gogdl/commands.rs::gog_friends` 401/403'te token yeniler ve yeniden dener → **IPC 143**. Frontend `gogFriends()` (`src/gog.ts`) + `S.gogFriends/gogFriendsLoading/gogFriendsError/friendsFilter/friendsQuery`.
- **Hata dayanıklılığı:** `loadFriendsView` iki mağazayı `Promise.allSettled` ile çeker; biri düşerse diğerinin listesi korunur ve hata yalnız liste boşken gösterilir.
- **i18n:** 7 yeni anahtar × 15 dil (`friends.loading/search/count/note/emptyHint/connectTitle/connectDesc`) → **1.320 anahtar**, tam parite.
- **Test:** `test_parse_gog_friends_maps_and_sorts`, `test_parse_gog_friends_empty_payload` → `cargo test` **131**; `npm.cmd run build` ✅, `tsc --noUnusedLocals` 0 hata.

### 6.15. 28.09.2026 sekizinci tur (Genel Bakış başlığında mağaza↔hesap eşleştirmesi)

- **Genel Bakış alt satırı yeniden düzenlendi:** Önceden üç ayrı parça gibi duran `EPIC GAMES  GOG.COM  Efxlve (Epic) · Efxlve (GOG)` satırı yerine her mağaza **kendi hesabıyla eşleştirilmiş** tek okunur dizi kullanılıyor: **`Epic Games (Efxlve)` · `GOG.COM (Efxlve)`**. Mağaza adı vurgulu (`--text-2`, 600), hesap adı parantez içinde soluk (`--text-3`), aralarında sakin bir `·` ayracı. Çevrimdışı modda Epic çiftinin yanında amber nokta (tooltip: Çevrimdışı Mod) görünür. Hesap adı bilinmiyorsa yalnız mağaza adı yazılır. Hesap görünümünde (başlık zaten hesap adı) jeton + durum düzeni korunur. Kullanılmayan `.profile-sub-note` ve `.profile-token-sep` CSS'i silindi.

### 6.14. 28.09.2026 yedinci tur (inaktif profil için "uykuda hesap" ekranı)

- **İnaktif hesap sayfası artık boş değil:** Pasif bir hesap seçildiğinde sayfa tamamen siyah kalmak yerine uygulamanın **standart gruplanmış liste dili** (etiket solda, değer sağda, saç teli ayraçlar) kullanılıyor: kilit ikonu + net başlık + "veriler yalnızca aktif hesapta" açıklaması, ardından **arşivdeki oyun sayısı**, **son kullanım** (göreli zaman) ve **mağaza** satırları, en altta sağa yaslı tek **"Bu Hesaba Geç"** birincil butonu. Üst başlıkta istatistik/paragraf yığını yerine sadece kimlik + mağaza jetonu + durum kalıyor.
- **Arşiv oyun sayısı verisi (Rust):** `legacy::accounts.rs` her hesabın `efxlve_library_snapshot.json` dosyasından oyun sayısını bir kez okuyup `accounts_meta.json`'a yazıyor (`snapshot_game_count`); `archive_active_sidecars` arşivleme anında sayıyı tazeliyor, `list_saved_accounts` eksikse dolduruyor. Birim testi mevcut hesap testine eklendi (`game_count == Some(1)`).
- **i18n:** 4 yeni anahtar × 15 dil (`profile.dormantTitle`, `profile.archivedGames`, `profile.lastUsed`, `profile.store`) → **1.313 anahtar**, tam parite. "Son kullanım" göreli zamanı mevcut `notif.secondsAgo/hoursAgo/daysAgo` anahtarlarını yeniden kullanır (yeni anahtar yok).

### 6.13. 28.09.2026 altıncı tur (avatar keşfedilebilirliği + hesap ID gizleme + profil başlığı sadeleşmesi)

- **Profil fotoğrafı artık keşfedilebilir:** Avatarın sağ altına **her zaman görünen kamera rozeti** (`.avatar-edit-btn` + `.avatar-edit-badge`) eklendi; hover/focus'ta rozet beyaz (`--accent`) dolguya dönüyor, imleç pointer, `:focus-visible` halkası var. Aynı desen **Ayarlar > Hesap** satırlarındaki avatarlara da uygulandı — satırdaki fotoğrafa tıklamak o hesabın fotoğrafını değiştirir (yeni buton/anahtar gerekmedi).
- **Hesap ID'si artık gösterilmiyor:** Ayarlar > Hesap satırlarındaki kopyalanabilir ID çipi kaldırıldı; ölü kalan `copy-account-id` dalı, `profile.copyIdTitle` ve `profile.accountIdCopied` anahtarları (15 dil) silindi.
- **Profil başlığı sadeleşti:** Yeşil "Epic Games / GOG.COM / Connected" hapları yerine **sakin tipografik mağaza jetonları** (`profile-token`, 11px büyük harf + harf aralığı) ve **nokta + durum** göstergesi (`profile-status`; yeşil = bağlı, amber = aktif değil/çevrimdışı) kullanılıyor. Genel Bakış'ta jetonlar `·` ile ayrılır, yanında bağlı hesap adları notu kalır.
- **Doğrulama:** `npm.cmd run build` ✅, tsc 0 hata, i18n **1.309 anahtar** 15/15 parite, 0 ölü anahtar, 0 ölü CSS adayı (dinamik sınıflar hariç).
- **Kullanıcı kararı (aynı gün):** Profil başlığında **jeton + nokta/durum** görünümü ve hesap sayfasında **satır avatarı + kamera rozeti** onaylandı; ek "Netflix tarzı hesap balonları" şeridi **kapsam dışı** bırakıldı.

### 6.12. 28.09.2026 beşinci tur (profil "Genel Bakış" + avatar sistemi + switcher butonu)

- **Profil "Genel Bakış" sekmesi:** Aktif hesapların birleşik profili artık çip satırının ilk öğesi (kullanıcı geri bildirimiyle adı **"Genel Bakış"**; önerilen ad kullanılmadı). Başlıkta tüm aktif mağazaların çipleri + hesap adları notu (`Efxlve (Epic) · Efxlve (GOG)`), istatistikler iki mağazanın toplamı, oyun listesi birleşik (Epic + GOG). Yan kartlara **Bağlı Hesaplar** eklendi: her hesabın adı, mağazası, aktif noktası; pasif hesapta tek tıkla **Bu Hesaba Geç**, aktifte "Profili gör". Varsayılan seçim: tek aktif hesap → o hesabın profili, birden fazla aktif → Genel Bakış. 4 yeni anahtar × 15 dil (1.311 anahtar, tam parite).
- **Avatar sistemi ayrıştırıldı:** Fotoğraflar artık ad alanlı anahtarlarla saklanıyor — `global` (birleşik profil), `epic:<accountId>`, `gog:<userId>`. Eski `default` anahtarı tek seferlik göçle `global`e taşınıyor; eski çıplak id kayıtları okunmaya devam ediyor. Böylece **her hesap yalnızca kendi fotoğrafını** gösteriyor (önceki fallback zinciri tüm hesaplara aynı fotoğrafı yayıyordu) ve **birleşik profilin kendine ait bir fotoğrafı** var. Sol üstteki hesap çipi (kenar çubuğu) artık birleşik profilin fotoğrafını gösteriyor. Detaylı tasarım ve kurallar: **§7.6**.
- **Sidebar hesap değiştirici butonu:** `users` (arkadaşlar gibi duran) ikon yerine yeni **`arrow-left-right`** ikonu eklendi ve butona **"Hesap Değiştir"** etiketi konuldu; sağda bağlı hesap sayısı rozeti duruyor. Popover'da alttaki "Hesapları Yönet" butonu kaldırıldı, başlıktaki **dişli (Ayarlar > Hesaplar) en üst sağa** geri kondu.

### 6.11. 28.09.2026 dördüncü tur (GOG Galaxy oynanış süresi + sidebar/profil yenilemesi)

- **GOG Galaxy oynanış süresi içe aktarıldı (`gogdl/galaxy_playtime.rs`):** GOG'nin **public playtime API'si yok** (doğrulandı: `gameplay.gog.com` yalnızca başarım uçları veriyor, `content-system` build listesi veriyor, profil sayfası HTML döndürüyor ve playtime gömülü değil). Süreler Galaxy'nin yerel SQLite veritabanında: `%ProgramData%\GOG.com\Galaxy\storage\galaxy-2.0.db` → `GameTimes(userId, releaseKey, minutesInGame)`, anahtarlar `gog_<ürünId>_<sürüm>` biçiminde. Modül dosyayı **salt-okunur** açar (rusqlite, `bundled`), oturum açık GOG kullanıcı kimliğine göre filtreler ve aynı oyun için en büyük değeri tutar. Komut: `gog_sync_playtime(user_id)`. Frontend `syncGogPlaytime()` ile `S.playtimeMap`'e `gog::<id>` anahtarıyla yazar (yerel değeri asla düşürmez); açılışta ve GOG oturumu bitince çağrılır. Birim testi: release key → ürün id ayrıştırma.
- **Ek not:** Galaxy'nin `LastPlayedDates` tablosu (son oynanma tarihi) ileride "son oynananlar" sıralaması için kullanılabilir (şema çıkarıldı, kapsam dışı bırakıldı).
- **Sidebar hesap değiştirici sadeleştirildi:** tek bir hesabın adı/avatarı çoklu hesapta belirsizlik yaratıyordu → buton artık **yalnızca ikon** (+1'den fazla hesap varsa küçük sayaç); popover içeriği (platform bazlı liste, aktif işareti, hesap ekleme) korunuyor. Kullanılmayan `.sb-switcher-avatar*` ve `.sb-switcher-info/name/stores/caret` CSS'i silindi.
- **Mükerrer buton kaldırıldı:** hesap popover'ında hem başlıktaki dişli hem alttaki "Hesapları Yönet" aynı işi yapıyordu → başlıktaki dişli kaldırıldı.
- **Profil hesap-merkezli yeniden tasarlandı (`profile-view.ts` + `profile.css`):** çoklu Epic + GOG hesapları için üstte **hesap çipleri** (avatar + ad + platform rozeti + aktif noktası; `+` → Hesaplar sayfası), altında seçilen hesabın kimliği (platform + aktif çipleri). İstatistikler (oyun, süre, kupa, platin, XP) artık **seçili ve aktif** hesaba ait; süre mağaza bazında ayrıştırılır (GOG toplamına Epic saati karışmaz). Pasif hesap seçilirse "veriler yalnızca aktif hesapta yüklenir" açıklaması + tek tıkla **Bu Hesaba Geç** (mevcut `account-switch`/`gog-account-switch` akışları yeniden kullanılır). Yeni yan kart: **Mağaza Bazında Kütüphane**; arkadaşlar yalnız Epic profilinde gösterilir. 4 yeni anahtar × 15 dil (1.307 anahtar, tam parite); hesap geçişinde profil seçimi aktif hesaba döner.
- **Ek düzeltme (kodlama):** `main.rs` içindeki gömülü mağaza betiğinde çift kodlanmış (mojibake) Türkçe/Almanca etiketler (`Kütüphanede`, `Yüklü`, `İstek Listesinde`, `sürüm`, `ücretsiz`, `Başlat`, `In Bibliothek öffnen`, `[₺$€£]`) onarıldı — Türkçe kullanıcılar gömülü mağazada bozuk metin görüyordu. Not: depo genelinde mojibake taraması artık 0.

### 6.10. 28.09.2026 üçüncü tur (GOG entegrasyonu tamamlanması + komut temizliği)

- **GOG güncelleme tespiti eklendi (kütüphanede `updateAvailable` artık GOG için de çalışıyor):** yeni `gogdl/updates.rs` — kurulu `buildId` (`goggame-<id>.info`) ile content-system public build listesi (`content-system.gog.com/products/<id>/os/windows/builds?generation=2`, auth gerekmez) karşılaştırılır. 6 saatlik disk önbelleği (`gog_updates.json`), batch başına 4 paralel istek, `gog_check_updates(force)` komutu. Kurulum/güncelleme sonrası `store_installed_build` ile önbellek tazelenir. Frontend: `refreshGogUpdates()` sonucu `S.gogUpdates` + `LibraryItem.updateAvailable` alanına yazılır; **kart eylemi "Güncelle"ye döner**, İndirmeler > Güncellemeler listesi ve kenar çubuğu rozeti GOG'u da sayar, sürüm satırı `kurulu build → yeni build` gösterir. 2 yeni birim testi.
- **GOG "Güncelle" bug'ı düzeltildi:** kurulu bir GOG oyununda Güncelle/Kur'a basınca kurulum diyaloğu açılıyor ve oyunu **başka bir klasöre** kurma riski vardı; artık Epic'teki gibi mevcut kurulum klasörü kullanılır (diyalog atlanır, yerinde güncelleme).
- **Komut temizliği (D6 kapandı):** `epic_status`, `epic_capture_game_screenshot`, `epic_get_screenshot_hotkey`, `cloud_backup_get_sync_status` + `CloudSyncStatus` modeli (Rust+TS) kaldırıldı. Ayrıca **`epic_get_settings` `generate_handler!` içinde iki kez kayıtlıydı** (kopya) — düzeltildi. Sonuç: **141 komut, 141 kayıt, 0 çağrısız komut, 0 ölü olay**.
- **Testler:** 128 (121 + 3 ignored + 2 galaxy + 2 updates → toplam 128; canlı 3 test ignored).
- **Bulunan ek not:** `gogdl/transfers.rs` içindeki sabit Türkçe kullanıcı mesajları `@t:` anahtarlarına çevrildi (GOG doğrulama/kaldırma/içe aktarma akışları artık 15 dilde).



---

## 7. v0.1.18 — Hesap Paylaşımı / Birleşik Kütüphane (Steam Aile Paylaşımı Modeli)

> **Kullanıcı isteği (28.09.2026):** "Hem kendi Epic hesabım hem arkadaşımın hesabı açık olsun; hangi hesapta olursam olayım **iki hesabın bütün oyunlarını** görüntüleyebilmeliyim. Oyun detay sayfasında oyun kime aitse **tek butonla o hesaba geçilebilmeli**; başarımlar ve oyun saati de o hesaba göre gelmeli. Aynısı GOG için de geçerli."
> **Karar:** Ağır iş — **0.1.18'e planlandı**. Aşağıdaki spec uygulama sırasında referans alınacak.

### 7.1. Neden bu kadar iş?
- Epic/GOG oyunları **yalnızca sahibi olan hesapla başlatılabilir** (yetki kontrolü sunucuda). Bu yüzden "tüm hesapların oyunlarını gör" + "tek tıkla sahibine geç" ikilisi zorunludur; oyunu başka hesapla oynatmak teknik olarak mümkün değildir.
- Başarım ve oynanış süresi verileri **hesap bazlıdır**; şu an tek global önbellek (`achievements_cache.json`, `playtime.json`) kullanılıyor → hesap bazlı ayrıştırma gerekir.

### 7.2. Hazır altyapı (mevcut kod, yeniden kullanılacak)
- `legendary/accounts.rs`: her kayıtlı hesap için `user.json` + **`efxlve_library_snapshot.json`** arşivi (`%USERPROFILE%\.config\legendary\accounts\<account_id>\`). Birleşik kütüphane indeksi bu anlık görüntülerden **ağ olmadan** kurulabilir.
- `epic_switch_account` / `gog_switch_account`: tek tıkla hesap geçişi zaten çalışıyor (kabuk kararır, kütüphane anında hidrasyon).
- `gogdl/accounts.rs`: GOG için aynı arşiv modeli.
- `S.savedAccounts` / `S.gogSavedAccounts`, `updateSidebarAccountSwitcher` ve `accounts-view.ts` hesap listeleri.

### 7.3. Uygulama planı (fazlar) — **v1 uygulandı (29.09.2026)**
> **Durum:** 1-2-3-4 numaralı adımların v1'i tamamlandı (`shared_library.rs` + `shared_library_index`, kütüphane birleşik modu + sahip etiketi + "Hesaba Geç" eylemi, detay sayfası sahip çipi + geçiş). Kalanlar: hesap bazlı başarım/süre ayrımı, `account:` arama operatörü, koleksiyon/favori ayrıntıları.
1. **Hesap bazlı veri ayrımı (ön koşul):**
   - Başarım önbelleği: `achievements_cache.json` → `accounts/<account_id>/achievements_cache.json` (göç: mevcut dosya aktif hesaba taşınır).
   - Oynanış süresi: `playtime.json` kayıtlarına `account_id` eklenir (göç: mevcut kayıtlar aktif hesaba yazılır) veya dosya hesap klasörüne taşınır.
   - Başarım özeti (`epic_get_achievements_summary`) ve `S.epicAchSummaries` hesap değişiminde zaten sıfırlanıyor; yeni modelde "görüntülenen hesap" parametresi alır.
2. **Birleşik indeks (Rust):** `epic_shared_library_index()` komutu: kayıtlı tüm hesapların snapshot'larını okur, `{ gameKey: { accountId, displayName, source, ownedAt } }` döndürür, diskte `shared_index.json` olarak önbelleklenir (TTL + hesap listesi imzası). Ağ erişimi yok.
3. **Kütüphane (frontend):**
   - Yeni ayar: **"Tüm hesapların oyunlarını göster"** (varsayılan kapalı). Açıkken `epicVisibleSummaries()` birleşik indeksi de kapsar; sahibi aktif hesap olmayan oyunlar kartta hafif bir **sahip rozeti** (mevcut mağaza rozeti stilinde, `account.displayName`) taşır ve kartın eylemi **"Hesaba Geç"** olur.
   - Aktif hesabın sahip olduğu oyunlarda davranış aynen bugünkü gibi.
4. **Oyun detay sayfası:** başlık altında `Sahibi: <hesap>` çipi + **"Bu Hesaba Geç"** butonu (`epic_switch_account`/`gog_switch_account` → oturum değişir, sayfa yeniden hidrasyonla açılır, oyun artık oynanabilir). Başarım/oynanış süresi sekmesi geçiş sonrası sahibinin verilerini gösterir.
5. **Koleksiyonlar / arama / filtreler:** birleşik modda mağaza + hesap filtreleri (örn. `account:<ad>` arama operatörü); gizleme ve favoriler hesap bazlı mı global mi olacağı kararı (öneri: global, oyun anahtarı bazlı).
6. **i18n:** ~12-15 yeni anahtar × 15 dil (`account.owner`, `account.switchTo`, `settings.sharedLibrary*` vb.).
7. **Testler:** snapshot okuma indeksi, hesap bazlı başarım/süre ayrımı, geçiş sonrası hidrasyon, gizli/favori etkileşimi.

### 7.4. Riskler / dikkat
- **Kapak/veri tutarlılığı:** aynı oyun iki hesapta varsa tek kart gösterilir; sahibi "kurulu olan hesap → ilk sahip" sırasıyla seçilir (mevcut `canonicalGameTitle` dedupe mantığı genişletilir).
- **Kurulum yolu çakışması:** iki hesap aynı oyunu kurduysa tek kurulum paylaşılır; kaldırma yalnızca kurulu hesabın kaydını etkiler.
- **Gizlilik:** hesapların e-posta/kimlik bilgisi hiçbir yerde gösterilmez (mevcut kural), yalnızca görünen ad ve avatar.
- **Performans:** indeks tamamen diskten okunur; 500+ oyun × 2-3 hesap için O(N) tek geçiş, ağ yok, önbellekli. Kütüphane render'ı birleşik modda da O(1) haritalarla çalışmalı.
- **Kapsam dışı (ilk sürüm):** aynı anda iki hesabın oyununu *çalıştırma* (imkânsız), hesap bazlı ayrı kurulum klasörleri, bulut kayıt paylaşımı.

### 7.5. Tahmini iş büyüklüğü
**L (3-5 geliştirme günü):** Rust tarafı ~1 gün (indeks + hesap bazlı önbellek göçü), frontend ~1.5 gün (kütüphane/detay/filtreler), i18n + testler + doküman ~1 gün.

### 7.6. Avatar sistemi (detaylı plan — 28.09.2026'da büyük ölçüde uygulandı)

**Amaç:** Her hesabın kendi fotoğrafı, birleşik profilin kendine ait fotoğrafı; hiçbir fotoğraf başka bir hesaba sızmaz.

**Anahtar şeması (`localStorage: CUSTOM_AVATARS_KEY`):**
| Anahtar | Kullanıldığı yer | Not |
|---|---|---|
| `global` | Birleşik **Genel Bakış** profili + sol üst kenar çubuğu hesap çipi | Eski `default` anahtarı tek seferlik göçle buraya taşınır |
| `epic:<accountId>` | Epic hesap profili, hesap çipi, hesap popover'ı | Eski çıplak `<accountId>` kayıtları okunmaya devam eder (alias) |
| `gog:<userId>` | GOG hesap profili, hesap çipi, hesap popover'ı | Aynı alias kuralı |

**Kurallar:**
1. `avatarFor(key)` **yalnızca** o anahtarın fotoğrafını döndürür (+ aynı hesabın eski çıplak id kaydı). Başka hesabın fotoğrafına fallback YOKTUR (eski zincir kaldırıldı).
2. Yazma/silme tek anahtara dokunur; `saveCustomAvatar` yalnızca ilgili anahtarı ve onun legacy alias'ını günceller. Bir hesabın fotoğrafını silmek diğerlerini etkilemez.
3. Fotoğraf yoksa: hesap çiplerinde baş harf, birleşik profilde ve kenar çubuğunda nötr `gamepad-2` işareti gösterilir (başka hesabın yüzü asla).
4. Yükleme akışı tek: 256×256 merkez kırpma + WebP (0.88). Yeni anahtar türü eklenirse `avatarKeyFor()` genişletilir.

**Gelecek (0.1.18 ile):**
- Hesap değiştirme sonrası avatar önbelleği: aynı hesabın fotoğrafı tüm yüzeylerde (çip, popover, profil, TV Modu) tek kaynaktan okunur — mevcut `updateChrome()` + `render()` akışı bunu zaten sağlıyor; yeni yüzey eklendiğinde `avatarFor` kullanılmalı.
- Platformdan gelen gerçek avatarlar (Epic GraphQL profil fotoğrafı / GOG avatar URL'i) isteğe bağlı: `platformAvatar` ayrı bir alanda tutulup `avatarFor` sırası **yerel yükleme → platform avatarı → baş harf/işaret** olacak şekilde genişletilebilir. Ağ isteği UI'yi bloklamamalı (mevcut görsel disiplini).
- Dışa/içe aktarma: avatarların `.efxlveprofile` benzeri tek dosyada yedeklenmesi (kullanıcı isteğine bağlı).

---

## 8. Discord Social SDK Entegrasyonu (Plan + Fizibilite — 29.09.2026)

**Karar bekleniyor (kullanıcı onayı):** Arkadaş özellikleri (Epic/GOG) kaldırıldıktan sonra Discord, launcher'ın sosyal katmanı olarak planlandı. Bu bölüm fizibilite bulgularını ve uygulama planını kaydeder.

### 8.1. Fizibilite sonucu: **UYGULANABİLİR**

| Kriter | Durum | Kanıt / not |
|---|---|---|
| Resmî SDK var mı? | ✅ | **Discord Social SDK** (ücretsiz, tüm geliştiricilere açık) |
| Windows x64 | ✅ | Generally Available |
| **Sunucu (backend) gerekli mi?** | ❌ Gerekmiyor | Discord uygulamasında **Public Client** açılıp `Client::GetToken` + PKCE kullanılıyor; token yenileme `Client::RefreshToken` ile istemcide |
| Tarayıcı/redirect akışı | ✅ SDK hallediyor | Redirect `http://127.0.0.1/callback` portalda kayıtlı olmalı; SDK "redirects automatically handles" — bizim loopback sunucusu yazmamıza gerek yok |
| Arkadaş listesi + canlı durum | ✅ | Unified Friends List (`openid` + `sdk.social_layer_presence`); presence: online/idle/dnd/offline + "playing X" |
| DM (sohbet) | ✅ (ek kapsam) | `sdk.social_layer` (communication scopes) — lobi/ses/kanal da aynı kapsamda |
| Kurulum paketine gömme hakkı | ✅ | SDK Terms §2.a: "distribute the Discord Social SDK **as integrated into your Application**" (tek başına dağıtım yasak) |
| "Oyun" şartı | ⚠️ Düşük risk | Şartlar "Application" diyor (oyunla sınırlı değil); portalda SDK'yı etkinleştirmek için kısa bir form dolduruluyor, Discord gerekirse entegrasyonu inceleyebilir |
| API dili | ⚠️ C++20 | `discordpp.h` (header-implemented) + `discord_partner_sdk.dll`; Rust için ya DLL'in C API'si (varsa) doğrudan bağlanır ya da küçük bir C++ shim (VS 2022 mevcut) |
| DLL boyutu | ❓ | İndirilince ölçülecek (tahmin 10-40 MB, ses/WebRTC içeriyor) |
| Tick ihtiyacı | ⚠️ | `discordpp::RunCallbacks()` düzenli çağrılmalı; plan: SDK yalnız **bağlıyken** ve **düşük frekansta** (≈4 Hz) tick edilir, Discord sayfası kapalıyken durdurulur → "boşta sıfır yük" korunur |

### 8.2. Ne kazanıyoruz (hedeflerimiz)

1. **Arkadaş listesi**: Discord arkadaşları, avatarları, çevrimiçi/boşta/rahatsız etme/çevrimdışı durumları, "şu an X oynuyor".
2. **Canlı güncelleme**: SDK olay gönderir (polling gerekmez).
3. **Sohbet (opsiyonel, 2. faz)**: birebir DM paneli (mesaj geçmişi + gönderme).
4. **Unified Friends**: Discord tarafında Steam/Epic hesabı bağlıysa oyun-içi kimlikler de listelenebilir.
5. **Rich Presence**: zaten IPC ile var (`src-tauri/src/presence.rs`, varsayılan kapalı) — SDK'ya geçmek zorunlu değil; ikisi birlikte yaşayabilir.

### 8.3. Uygulama planı (fazlar)

**Faz 0 — Portal (kullanıcı, ~15-30 dk):**
1. Discord Developer Portal'da **Team** + **Application** oluştur (ad: `Efxlve Launcher`).
2. OAuth2 sekmesinde **redirect**: `http://127.0.0.1/callback` + **Public Client** açık.
3. Sol menü → **Discord Social SDK → Getting Started** formunu doldur ve **Submit** (SDK bu uygulama için etkinleştirilir).
4. **Downloads** sekmesinden C++ SDK zip'ini indir → `src-tauri/vendor/discord-sdk/` altına çıkar (gitignore'da).
5. Bana **Application ID**'yi ver.

**Faz 1 — SDK'yı kanıtla (ben, yarım gün):** DLL'i yükle, `Client` oluştur, `AddLogCallback` + `SetStatusChangedCallback` ile durum izle, `Authorize` + `GetToken` ile giriş yap ve **arkadaş sayısını** oku. (EOS'taki gibi izole canlı test; bu kez veri gerçekten var.)

**Faz 2 — Rust altyapısı (1-1.5 gün):** `src-tauri/src/discord/` modülü — FFI (C API varsa doğrudan; yoksa `cc` ile derlenen ince C++ shim), token saklama/yenileme (`<appdata>/discord/token.json`), arkadaş listesi + presence olayları, düşük frekanslı tick, `discord_status/connect/disconnect/friends` komutları.

**Faz 3 — Arayüz (1 gün):** Arkadaşlar sayfasını **Discord odaklı** yeniden kur (liste + durum noktaları + "şu an oynuyor" + arama), Ayarlar > Entegrasyonlar'a "Discord" kartı (Bağlan / Bağlantıyı Kes / durum), i18n (15 dil).

**Faz 4 — (opsiyonel) DM paneli:** arkadaşa tıkla → sağda sohbet paneli (mesaj geçmişi + gönder). Communication scopes gerektirir.

### 8.4. Riskler ve önlemler

| Risk | Önlem |
|---|---|
| Portal formu / entegrasyon incelemesi reddedilebilir | Formu doğru doldur (alternatif oyun başlatıcı, 13+), gerekirse Discord ile iletişim; SDK yoksa uygulama bugünkü gibi çalışmaya devam eder (graceful degradation) |
| SDK Discord tarafından kaldırılabilir/limitlenebilir | Özellik tamamen opsiyonel; DLL yoksa/bağlantı düşerse arkadaş sayfası boş durum gösterir, çökme yok |
| Tick döngüsü performans kuralını ihlal eder | Yalnız Discord görünümü açıkken ≈4 Hz tick; sayfa kapanınca `RunCallbacks` durur |
| Token güvenliği | Token'lar `<appdata>/discord/` altında, repoya asla girmez; `discord_partner_sdk.dll` gitignore'da |
| "Oyun değil" itirazı | Şartlar "Application" diyor; launcher zaten bir uygulama. Gerekirse SDK'yı yalnız sosyal katman için kullan |

### 8.5. Tahmini iş büyüklüğü

**M (2-3 geliştirme günü):** Faz 0 kullanıcıda ~30 dk; Faz 1 yarım gün; Faz 2 ~1.5 gün; Faz 3 ~1 gün; Faz 4 (DM) ayrıca ~1 gün. DLL boyutu netleşince kurulum paketi etkisi raporlanır.

---

## 9. Steam Entegrasyonu (Araştırma + Plan - 29.09.2026)

### 9.1. Araştırma sorusu: Steam istemcisi olmadan olur mu?

**Kısa cevap: Oyunları başlatmak için hayır; veriyi göstermek için evet.**

- Steam oyunlarının çoğu **Steamworks DRM** (`steam_api64.dll`) taşır: oyun açılırken Steam istemcisinin açık ve oturum açmış olmasını şart koşar. İstemci yoksa oyun "Steam is not running" diyerek kapanır.
- DRM'siz (Steamworks'siz) oyunlar doğrudan `.exe` ile başlatılabilir; ama bu azınlıktır ve oyun bazında güvenilir bir liste yok.
- **Depo indirme** (SteamKit2 / DepotDownloader yaklaşımı) teknik olarak mümkündür ama: (a) Steam hesabıyla oturum + depo anahtarı gerektirir, (b) DRM/ToS açısından gri alandır, (c) devasa bir iştir. **Yapılmayacak.**
- **Karar (kullanıcı talimatı doğrultusunda): Launcher'lı entegrasyon.** Steam kuruluysa algıla, kütüphaneyi oku, `steam://` protokolleriyle başlat/kur/kaldır/doğrula. Steam kurulu değilse kart "Steam kurulu değil" der ve resmi indirme bağlantısını verir.

### 9.2. Veri kaynakları (hepsi yerel, ağsız — ağ yalnız kapak/açıklama için)

| Veri | Kaynak |
|---|---|
| Steam kurulum yolu | `HKCU\Software\Valve\Steam` → `SteamPath`; `HKLM\SOFTWARE\WOW6432Node\Valve\Steam` → `InstallPath` (controller.rs bunu zaten okuyor ✓) |
| Kütüphane klasörleri | `<steam>\steamapps\libraryfolders.vdf` (`libraryfolders` sözlüğündeki her `path`) |
| Kurulu oyunlar | her kitaplıkta `steamapps\appmanifest_<appid>.acf` → `appid`, `name`, `installdir`, `SizeOnDisk`, `StateFlags`, `buildid`, `LastUpdated` |
| Oynanış süresi | `<steam>\userdata\<id>\config\localconfig.vdf` → `Software/Valve/Steam/apps/<appid>/Playtime` (dakika) + `LastPlayed` |
| Kullanıcı | `userdata\<id>` klasörleri + `config\loginusers.vdf` (`PersonaName`, `AccountID`, `MostRecent`) |
| Kapak / hero | Steam CDN (anahtarsız): `cdn.cloudflare.steamstatic.com/steam/apps/<appid>/library_600x900.jpg`, `header.jpg`, `library_hero.jpg` |
| Açıklama / gereksinimler | `store.steampowered.com/api/appdetails?appids=<id>&l=<dil>` (anahtarsız; ~200 istek/5 dk → **disk önbelleği şart**) |
| Başarımlar | `api.steampowered.com/ISteamUserStats/GetPlayerAchievements` → **Web API anahtarı + herkese açık profil** ister (Ayarlar'a opsiyonel anahtar alanı) |

### 9.3. Eylem protokolleri (dosya işlemi bizde yok)

- Başlat: `steam://rungameid/<appid>` (Steam kapalıysa açılır, oyun sıraya girer)
- Kur: `steam://install/<appid>` · Kaldır: `steam://uninstall/<appid>` · Doğrula: `steam://validate/<appid>`
- Mağaza sayfası: `https://store.steampowered.com/app/<appid>` (launcher içindeki mağaza görünümünde Steam sekmesi yoksa harici tarayıcı)
- Bizim tarafımızda **dosya silme/taşıma/doğrulama yok**; bunlar Steam'in kendi bakım akışına bırakılır (kullanıcıyı yanlış yönlendirmemek için arayüzde "Steam'de açar" dili kullanılır).

### 9.4. Uygulama planı (fazlar)

- **Faz 1 — Algılama + kart (yarım gün) — ✅ uygulandı (29.09.2026):** `src-tauri/src/steam.rs`: `steam_status`, `steam_list_installed`, `steam_launch_game` komutları (KeyValues/VDF ayrıştırıcı + birim testleri, `libraryfolders.vdf` ve `appmanifest_*.acf`, kitaplık klasörü ve app id tekilleştirme, `steam://rungameid/<id>` ile başlatma, sayısal olmayan id reddi); Ayarlar > Entegrasyonlar'a **Steam** kartı (kurulum yolu, kurulu oyun sayısı, ilk 60 oyun + boyut/durum, "Steam'de başlat", yeniden tara). Ortak `winreg.rs` yardımcısı eklendi (kontrolcü + Steam aynı kayıt defteri okuyucusunu kullanıyor). Ağ yok, 15 dil. Canlı doğrulama: bu makinede Steam bulundu, **3 oyun** (CS2, GTA V Enhanced, Steamworks Redistributables) doğru okundu.
- **Faz 2 — Kütüphane entegrasyonu (1 gün) — ✅ uygulandı (29.09.2026):** `SourceFilter`'a `"steam"`, anahtarlar `steam::<appid>`, `steamSummaries`/`steamSummariesMap` + `rebuildAllGamesMap`/`summaryOf`/`libraryItemOf`/`epicWideArt`/`gameStoresLabel`/`totalLibraryGamesCount`/`gameVersionsOf` (sürüm değiştirici), kütüphane mağaza menüsünde **Steam** seçeneği, kapak/hero Steam CDN'den (`library_600x900.jpg` / `library_hero.jpg`), **oynanış süresi** `steam_sync_playtime` ile `localconfig.vdf`'den (yerel değeri asla düşürmez), eylemler `steam://` (oyna/güncelle/doğrula/kaldır) — kart, liste, sağ tık menüsü, oyun sayfası ve **Yönet sekmesi** (Steam panosu: klasör, doğrula, kaldır, kapağı değiştir, süre) Steam'e devrediyor. Detay sayfası `appdetails`'ten açıklama + geliştirici + hero + **sistem gereksinimleri** (HTML satırlara düzleştirilir, 6 saat disk önbelleği). Koleksiyon/favori/gizleme/arama/sıralama anahtar tabanlı olduğu için otomatik çalışıyor.
  - **Bilinçli kapsam kararı:** Steam oyunları **İndirmeler görünümüne ve indirme rozetine girmez** (burası launcher'ın kendi indirme hattı); Steam güncellemeleri kartta ve kütüphane "Güncellemeler" filtresinde görünür ve tıklanınca Steam'e devredilir.
- **Faz 3 — Derinlik (1 gün) — ✅ uygulandı (29.09.2026):** **Başarımlar** (isteğe bağlı Steam Web API anahtarı; Ayarlar > Entegrasyonlar'da anahtar satırı + Steam'in geliştirici sayfası bağlantısı): SteamID64 `loginusers.vdf`'den çözülür, şema (ad/açıklama/ikon) + oyuncunun açtıkları + **global açılma oranları** (nadirlik) birleştirilir; nadirlik **altın/gümüş/bronz** kademelerine eşlenir, tam set "tamamlandı" sayılır, 1 saatlik disk önbelleği vardır; kütüphane kapakları için **özet komutu** yalnız diskten okur (ağ yok). **DLC sekmesi** artık ek içerik sayısını ve mağaza bağlantısını gösterir (adlar için içerik başına istek gerekirdi). Sistem gereksinimleri/açıklama/hero Faz 2'de geldi.
  - **Bilinçli sınırlar:** Steam'de XP yok (profil seviyesine katkı 0); oyun sayfasının Ekran Görüntüleri sekmesi bizim kendi çekimlerimiz için kalır (Steam'in `userdata/760` arşivi gösterilmez); herkese açık olmayan profillerde Steam başarım paylaşmaz (arayüz boş durum gösterir, ayar kartı nedeni açıklar); Steam Mağazası launcher içine gömülmez (bağlantı tarayıcıda açılır).
- **Faz 4 (opsiyonel/riskli):** Steam dışı oyunları Steam'e ekleme (`shortcuts.vdf` yazımı) — dosya biçimi kırılgan, yalnız rehber olarak önerilir; Steam Aile Paylaşımı görünürlüğü.

### 9.5. Riskler ve önlemler

| Risk | Önlem |
|---|---|
| `appdetails` hız sınırı (HTTP 429) | 6 saatlik disk önbelleği; istek yalnız sekme açıldığında ve oyun başına bir kez |
| `localconfig.vdf` büyük (MB) | Yalnız ihtiyaç anında oku, özeti kendi önbelleğimize yaz (GOG Galaxy oynanış süresi deseniyle aynı) |
| Steam kapalıyken `steam://` gecikir | Başlatma Steam'e bırakılır; arayüz "Steam açılıyor" bilgisini gösterir, launcher bloklanmaz |
| Steamworks DRM | Kaldırma/taşıma/doğrulama Steam'e bırakılır; launcher yalnız protokol çağırır |
| `libraryfolders.vdf` biçimi sürüm değiştirir | Basit anahtar/değer ayrıştırıcı + bilinmeyen biçimde boş liste (çökme yok), birim testi |

---

## 10. EA / Ubisoft / Xbox Entegrasyonları (Araştırma + Plan - 29.09.2026)

Kullanıcı talimatı: "Launcher'sız yapabilirsen yap; yapamazsan Launcher'lı ekle." Üçünün de durumu aynı: **lisans doğrulaması kendi istemcilerinde**, bu yüzden **launcher'lı** entegrasyon.

### 10.1. EA App

- **Launcher'sız: Hayır.** EA oyunları `EADesktop.exe` + `EABackgroundService` ile lisans doğrular; istemci kapalıysa oyun açılmaz.
- Algılama: `HKLM\SOFTWARE\WOW6432Node\Electronic Arts\EA Games\<oyun>` → `Install Dir`; ayrıca EA App'in `installerdata` klasöründeki `*.mfst` dosyaları (ürün kimliği + dil).
- Eylemler: başlat `link2ea://launchgame/<id>` (launcher zaten EA oyunlarını bu protokolle başlatıyor ✓); kur/kaldır/onar EA App'e bırakılır.
- Kütüphane: mevcut `third_party` altyapısı + `requiresThirdPartyLauncher` yeniden kullanılır; kapak için SteamGridDB anahtarı veya EA CDN'i.

### 10.2. Ubisoft Connect

- **Launcher'sız: Hayır.** Oyunlar Connect ile lisans doğrular.
- Algılama: `HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>` → `InstallDir`; `HKCU\Software\Ubisoft\...` tamamlayıcı.
- Eylemler: başlat `uplay://launch/<id>/0`; kur/kaldır/doğrula Connect'e bırakılır.
- Kütüphane: EA ile aynı desen.

### 10.3. Xbox (Microsoft Store / PC Game Pass)

- **Launcher'sız: Hayır.** Oyunlar MSIX paketi + **Gaming Services** DRM'i ile çalışır; çalıştırma yalnız `explorer.exe shell:appsFolder\<PackageFamilyName>!<AppId>` ile ve Gaming Services arka planda açıkken olur.
- Algılama: `C:\XboxGames\*\Content\MicrosoftGame.config` (hızlı, dosya tabanlı) + `HKLM\SOFTWARE\Microsoft\GamingServices` sürümü; PowerShell `Get-AppxPackage` **yalnız kullanıcı isterse** (yavaş; `CREATE_NO_WINDOW`).
- Eylemler: başlat (yukarıdaki `shell:appsFolder`), kur/kaldır Microsoft Store'a bırakılır.
- Sınır: Xbox oynanış süresi/başarım verisi için resmî yerel API yok → yalnız algılama + kütüphane + başlatma.

### 10.4. Ortak karar ve sıralama

- Üçü de **launcher'lı** olur; öncelik **EA → Ubisoft → Xbox** (algılama kolaylığı ve kullanıcı talebi sırası).
- Her biri için ortak desen: algılama (registry/dosya, ağsız) → Ayarlar > Entegrasyonlar kartı → "Kütüphaneye Aktar" → kapak → başlatma protokolü → "X uygulamasında aç" eylemleri → 15 dil. Bizim tarafımızda **dosya işlemi yok**.
- Mevcut `ThirdPartyLauncher` + `requiresThirdPartyLauncher` altyapısı genişletilir (EA/Ubisoft zaten tanınıyor).

### 10.5. Uygulama durumu

- **Faz 1 — algılama + kart + başlatma ✅ uygulandı (29.09.2026):** `src-tauri/src/external_stores.rs` (ağsız):
  - **EA:** `HKLM\...\Electronic Arts\EA Games\*` alt anahtarları → `Install Dir`; kimlik olarak `__Installer\installerdata.xml` içindeki `content id` tercih edilir (yoksa anahtar adı). İstemci yolu (`EADesktop.exe`) kayıt defterinden okunur ve kimlik çözülemezse EA App açılır. Başlatma: `link2ea://launchgame/<id>`.
  - **Ubisoft:** `HKLM\...\Ubisoft\Launcher\Installs\<id>` (ve `HKCU` eşdeğeri) → `InstallDir`; başlık klasör adından (`Watch_Dogs` → "Watch Dogs"). **Var olmayan klasörler atlanır** (bayat kayıtlar). Başlatma: `uplay://launch/<id>/0`.
  - **Xbox:** `C:\XboxGames\*\Content\MicrosoftGame.config` (büyük/küçük harf duyarsız) → başlık `DefaultDisplayName`'den; paket kimliği `<Identity Name>`'den. Paket aile adı **tek PowerShell çağrısıyla** (`Get-AppxPackage`, `$_.Name` sözdizimi şart) çözülür → `shell:appsFolder\<PFN>!App` ile başlatılır; çözülemezse kart "başlatılamaz" gösterir.
  - Arayüz: Ayarlar > Entegrasyonlar'da **EA App / Ubisoft Connect / Xbox** kartları (bulunan oyun sayısı, liste, satır başına "Oyna", "Yeniden Tara") + `src/external-stores.ts`. 9 yeni anahtar × 15 dil.
  - **Canlı doğrulama:** EA istemcisi bulundu (0 oyun — bu makinede EA'ya ait oyun yok), Ubisoft'ta **bayat kayıt doğru şekilde atlandı**, Xbox'ta **4 oyun** kimlikleriyle çözüldü (Minecraft for Windows / Launcher / Java Edition, No Man's Sky).
- **Faz 2 (plan):** bu oyunları kütüphaneye kaynak olarak ekleme (kapak, süre, favori/koleksiyon/gizleme) — Steam'deki `steam::<id>` deseninin `ea::` / `ubisoft::` / `xbox::` karşılığı; Xbox'ta süre/başarım verisi yerel API'de yok.

---

## 11. Epic Tarzı "Yükleme Seçenekleri" Diyaloğu (29.09.2026)

Mevcut `src/features/dlc/selective-install.ts` zaten çalışıyor: zorunlu ana oyun satırı, dil etiketleri, ek paketler, DLC'ler, satır başına boyut, toplam indirme/disk. Epic'in Fortnite diyaloğuna yaklaştırmak için yapılacaklar:

1. Başlığa oyun kapağı (küçük portre) + başlık + "Yükleme Seçenekleri".
2. **Yüklü DLC'ler** listede "Yüklü" rozetiyle, işaretli ve kilitli gösterilir (gizlenmez).
3. Bölüm başlıklarına **"Tümünü seç" / "Temizle"** küçük eylemleri.
4. Zorunlu satırlarda kilit ikonu (`lock`) ve "Gerekli" etiketi.
5. Toplam satırında "N öğe seçili" sayacı + indirme/disk toplamları.
6. Alt bilgi notu: "İsteğe bağlı içerik sonradan Yönet > Dosyaları Doğrula akışından değiştirilebilir."
7. Dil etiketleri ve ek paketler varsayılan olarak **kapalı** başlar (yalnız oyunun varsayılan dili iner) — Epic de böyle davranır.

---

## 12. Kontrolcü Desteği (Steam Input Benzeri)

### 12.1. Faz 1 — uygulandı (29.09.2026)

- Kumanda ailesi algılama (`controllerKind`: PlayStation / Xbox / Switch / genel), HUD gliflerinin otomatik değişmesi (✕ ○ □ △ ve L1/R1), Ayarlar > **Kontrolcü** bölümü (bağlı kumandalar, XInput köprüsü durumu, resmî ViGEmBus/DS4Windows bağlantıları), PlayStation kumandası bağlanınca tek seferlik bilgilendirme bildirimi (tıklayınca ilgili ayar bölümü açılır).
- Rust: `controller_support_status` — ViGEmBus servisi (`HKLM\SYSTEM\CurrentControlSet\Services\ViGEmBus`) ve Steam kurulum yolu kayıt defterinden okunur (ağ yok).

### 12.2. Faz 2 — plan: yerleşik sanal gamepad (ViGEmBus)

- Sorun: Windows DualSense/DualShock'u **DirectInput** aygıtı olarak gösterir; yalnız XInput okuyan oyunlar (Dead by Daylight vb.) onları hiç görmez. Steam bunu **ViGEmBus** çekirdek sürücüsü + Steam Input eşlemesiyle çözer.
- Yapılabilir yol: kullanıcı ViGEmBus'u bir kez kurar (imzalı, açık kaynak, Nefarius); launcher `vigem-client` (Rust) ile **sanal Xbox 360 kolu** oluşturur; DualSense girdisi HID'den okunup eşlenir (tuşlar + analog çubuklar + tetikler + ölü bölge). Bu, DS4Windows'un çekirdeğidir ve **tamamen kullanıcı modunda** çalışır (çekirdek sürücü yazmayız).
- Maliyet/riskler: yeni bağımlılıklar (`vigem-client` + HID okuma), eşleme kalitesi (ölü bölge/eksen tersliği), performans (yalnız oyun oturumu sürerken çalışır, boşta durur), sürücü kurulumu gerektirmesi.
- Hafif alternatif: kullanıcı oyunu Steam'e "Steam dışı oyun" olarak ekleyip Steam Input'u açar; launcher bunu tek tıkla yapmayı **önerebilir** (`shortcuts.vdf` yazımı riskli → yalnız rehber + bağlantı).
- **Karar:** Faz 2 backlog'a alındı; Faz 1 kullanıcıya doğru yolu (ViGEmBus + DS4Windows veya Steam Input) gösteriyor ve köprüyü algılıyor.

---

## 13. Steam Hesap Girişi (B planı — Galaxy eşdeğeri, kullanıcı kararı 29.09.2026)

**Neden:** GOG Galaxy'in Steam eklentisi Steam'in gerçek auth akışını kullanır (SteamKit'ten ilham alan yeni akış, PR #171) ve **sahip olunan tüm oyunları** okur. Bizim mevcut okuma yalnızca **kurulu** oyunları verir (yerel manifest'ler), bu yüzden kullanıcının diğer Steam oyunları görünmüyor. Kullanıcı kararı: **tam çalışan + tam güvenli** hesap girişi uygulanacak.

**Durum (29.09.2026): Faz 1 uygulandı.** `steam_auth.rs` + DPAPI + `GetOwnedGames` + Hesaplar sayfası giriş akışı tamam; kütüphanede kurulu olmayan Steam oyunları da "Kur" eylemiyle listeleniyor. Canlı doğrulama: RSA anahtarı çekildi ve `BeginAuthSessionViaCredentials` isteği Steam tarafından kabul edildi (yanlış parola → `eresult 5`); tam giriş kullanıcının kendi hesabı ve Steam Guard koduyla yapılacak. Kalan bilinçli işler: hesap bazlı başarım/süre ayrımı, çoklu Steam hesabı, QR ile giriş ve Steam ekran görüntüleri.

### 13.1. Rust auth çekirdeği (`src-tauri/src/steam_auth.rs`)

`IAuthenticationService` (HTTPS POST, `api.steampowered.com`):

1. `GetPasswordRSAPublicKey/v1` — `account_name` → `publickey_mod` + `publickey_exp` + `timestamp`.
2. Parola **RSA PKCS#1 v1.5** ile şifrelenir (`rsa` crate, saf Rust) → `BeginAuthSessionViaCredentials/v1` (`remember_login`, `persistence`, `website_id="Community"`, `platform_type=2`, `device_details`).
   - **Uygulama notu (canlı doğrulandı):** iç içe `device_details` mesajı form alanı olarak gönderilince Steam **HTTP 400** veriyor; bu yüzden istek SteamKit'in yaptığı gibi `input_protobuf_encoded` (base64 protobuf) olarak gönderilir (modüldeki küçük protobuf yazıcı; alan numaraları `steammessages_auth.steamclient.proto` ile birebir). **Ayrıca her istek `?format=json` ile gönderilmelidir:** aksi halde Steam yanıtı **ikili protobuf** (`application/octet-stream`) döner ve JSON ayrıştırıcısı başarılı girişi hataya çevirir (kullanıcı bildirimi: "Steam refused" — Guard onaylanmış olmasına rağmen). `request_id` ham bayt olduğu için poll/guard/generate çağrıları da protobuf gövdesiyle gider.
   - Yanıt: `client_id`, `request_id`, `steamid`, `allowed_confirmations[]`, `interval`.
3. Onay: cihaz kodu gerekiyorsa `UpdateAuthSessionWithSteamGuardCode/v1` (client_id, steamid, code, code_type=3); ardından `PollAuthSessionStatus/v1` (`client_id`, `request_id`) → `refresh_token` + `access_token`.
4. Erişim token'ı: `login.steampowered.com/jwt/finalizelogin` (`nonce=refresh_token`, `sessionid`, `redir`) → `transfer_info` içindeki `steamcommunity.com/login/settoken` aktarımı `steamLoginSecure=<steamid>||<access_token>` çerezini kurar; web erişim token'ı buradan alınır (canlı doğrulandı: finalizelogin geçersiz token'da yapısal JSON hatası döndürüyor). **Not:** Steam'in 30.04.2025 değişikliğiyle `GenerateAccessTokenForApp` WebBrowser yenileme token'larını `AccessDenied` ile reddediyor; bu çağrı yalnızca yedek yol olarak koda bırakıldı.

Komutlar: `steam_login_begin`, `steam_login_code`, `steam_login_status`, `steam_logout`, `steam_owned_games`.

### 13.2. Güvenlik (tam koruma)

- **Parola asla saklanmaz**: yalnız istek gövdesinde kullanılır, sonra `zeroize` ile bellekten silinir; log'a/toast'a/hata mesajına yazılmaz.
- **Refresh token DPAPI ile şifrelenir** (`CryptProtectData`/`CryptUnprotectData`, crypt32 FFI; Windows kullanıcı hesabına bağlı) → `<appdata>/steam/auth.bin`. Kopyalansa başka makinede/kullanıcıda açılamaz.
- "Bu cihazda oturumu koru" kapalıysa token yalnız bellekte tutulur (süreç kapanınca gider).
- Yalnız HTTPS + 12 sn zaman aşımı; hata eşlemesi sade ("parola hatalı", "Steam Guard kodu geçersiz", "çok fazla deneme, sonra tekrar dene"), ham yanıt gösterilmez.
- `access_token` yalnız sorgu parametresi olarak (Steam'in kendi istemcileri gibi) ve asla diske yazılmaz.

### 13.3. Sahip olunan tüm oyunlar

- `IPlayerService/GetOwnedGames/v1?access_token=…&steamid=…&include_appinfo=1&include_played_free_games=1` → tüm kütüphane (ad, appid, `playtime_forever` dakika, `img_icon_url`). **Not:** erişim token'ıyla `steamid` zorunludur; yoksa API HTTP 400 "Missing required routing parameter" döndürür (canlı doğrulandı).
- **Başarımlar anahtarsız:** Steam istemcisinin yerel `appcache/stats` ikili KeyValues dosyaları okunur (şema + açılma zamanları); Web API anahtarı yalnızca yerel şeması olmayan oyunlar için yedek. `ISteamUserStats` uçları erişim token'ını kabul etmiyor ("Required parameter 'key' is missing", canlı doğrulandı).
- Kütüphanede **kurulu olmayanlar** da listelenir: `installed=false`, kapak Steam CDN'den, eylem **Kur** → `steam://install/<id>`; kurulu olanlar mevcut akışı korur (başlat/doğrula/kaldır).
- Oynanış süresi API'den (yerel `localconfig` değerini asla düşürmez), `playtime_2weeks` eklenebilir.

### 13.4. Arayüz

- Hesaplar sayfasındaki Steam kartı: **"Steam'e Giriş Yap"** → kullanıcı adı → parola → **Steam Guard** adımları; Steam mobil onay sunduğunda varsayılan görünüm tek dokunuşlu onay bekleme ekranıdır ("Kodu kullan" ile kod alanı açılır), yalnız kod/yalnız e-posta guard'ında kod alanı doğrudan gösterilir. Giriş yapılmışsa hesap adı + oyun sayısı + "Çıkış Yap".
- Oyun sayfasındaki **mağaza seçici** (açılır liste): Epic/GOG/Steam sürümleri arasında geçiş yapar; algılanan **EA App / Ubisoft Connect / XBOX** kurulumları kendi istemcilerinde başlatılır (başlık eşleşmesi kanonik ada göre; tarama yalnız oyun sayfası açılınca ve oturum başına bir kez). "Tümü" görünümünde aynı oyun tek kartta kalır (versiyonlar bu seçiciyle erişilir).
- İstemciden algılanan durum ayrı satır olarak kalır (istemci kurulu olmasa da hesap girişi kütüphaneyi getirir).
- Ayarlar'daki Web API anahtarı satırı **alternatif** olarak kalır (giriş istemeyenler başarımlar için kullanır).

### 13.5. Doğrulama

- Birim testleri: RSA şifreleme vektörü, DPAPI round-trip, token yenileme yolu, hata eşlemesi, `GetOwnedGames` ayrıştırma (fixture JSON).
- Canlı testler `#[ignore]`: gerçek hesapla giriş (kullanıcı Steam Guard kodunu verir), sahip olunan oyun sayısı, token yenileme.
- 15 dil, IPC referansı, ROADMAP/AGENTS güncellemesi, sürüm notu.




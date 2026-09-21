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
2. **Discord Rich Presence görseli:** Discord uygulamasına "large image" asset yükleyip `activity::Assets::new().large_image(...)` ile logo/kapak gösterimi eklemek (uygulama simgesi dışında).
3. **Cross-platform (Linux/macOS Wine/Proton):** Yalnızca araştırma/araştırma dokümanı mevcut ([`CROSS_PLATFORM.md`](./CROSS_PLATFORM.md)); gerçek implementasyon ayrı bir proje büyüklüğünde (Proton/DXVK/VKD3D, GPTK, prefix yöneticisi).
4. **Discord RPC ek bağlamlar:** İsteğe bağlı olarak kupa/başarım ilerlemesi gibi daha zengin durum metinleri.



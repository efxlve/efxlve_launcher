# ROADMAP.md — Efxlve Launcher Planlanan Geliştirmeler & Görev Listesi

> **Amaç:** Projede tespit edilen hataların, kullanıcı geri bildirimlerinin ve planlanan tasarım/mimari yeniliklerin merkezi kayıt ve takip dokümanıdır.

---

## 1. Öncelikli Aktif Görev (Kullanıcı Bildirimi)

### 📌 Üst Menü ("Mağaza", "Kütüphane") Webview Çakışma Bug'ı ve Üst Navigasyon UI Yenilemesi

- **Durum:** 📋 `YAPILACAK` (Kullanıcı talimatı: *Şimdilik kod değişikliği yapma, not al; sonraki adımda uygulanacak.*)
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

- **Durum:** 📋 `YAPILACAK` (Kullanıcı talimatı: *Not al; sonraki adımda uygulanacak.*)
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

## 2. Gelecek Adımlar (Next Milestones)

- [ ] **Milestone 1:** Üst menü (Titlebar / Nav) PS5 UI yenilemesi ve Mağaza/Kütüphane webview durum makinesi refactor'ü.
- [ ] **Milestone 2:** Beyaz parlama (flashbang / FOUC) sorununun `tauri.conf.json`, `index.html` ve Rust `WebviewBuilder` seviyesinde kökten çözülmesi.
- [ ] **Milestone 3:** `docs/DESIGN_SYSTEM.md` standartlarının **Ayarlar** (Settings) ve **İndirmeler** (Downloads) sayfalarına eksiksiz uygulanması.
- [ ] **Milestone 4:** `master_refactor_plan.md` doğrultusunda 11.000 satırlık `src/main.ts` dosyasının `src/features/` modüllerine bölünmesi.


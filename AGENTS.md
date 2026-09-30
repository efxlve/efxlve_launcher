# AGENTS.md — Efxlve Launcher

> Bu dosya, projede çalışan yapay zeka ajanları (Antigravity, Cursor / Claude) ve geliştiriciler için **tek operasyonel gerçektir**.
> Geçmiş sürüm kayıtları ve detaylı geliştirme günlükleri için `docs/CHANGELOG_INTERNAL.md` dosyasına bakın.

---

## 1. Proje Vizyonu: "Universal Gaming Hub"

Efxlve Launcher; Epic Games, GOG ve Steam gibi dağınık mağaza ve başlatıcıları arka planda gereksiz kılan; ultra hızlı, düşük bellek tüketen, konsol sadeliğinde birleşik bir **Masaüstü Oyun Merkezi (Universal Gaming Hub)**'dir (Windows x86_64).

- **Felsefe:** GOG Galaxy gibi hantal olmayan, Playnite gibi karmaşık eklenti ayarı gerektirmeyen, kutudan çıktığı gibi 120 FPS akıcılıkta çalışan, "gerçek siyah" PS5/Hydra konsol estetiğine sahip native bir deneyim sunmak.
- **Backend:** `legendary` CLI (GPL-3.0) ve `gogdl` gibi harici araçları Rust ile sarar, gömülü mağazaları native WebView2 child pencereleri (`add_child`) ile açar, yerel Steam manifest/VDF dosyalarını okur.
- **Frontend:** Vanilla TypeScript + Vite (Framework veya Virtual DOM kütüphanesi yoktur; saf DOM manipülasyonu ve O(1) hash map indeksleri kullanılır).

---

## 2. Teknoloji Yığını & Zorunlu Komutlar

- **Tauri v2** (`features = ["unstable"]` — gömülü mağaza child webview'ları için zorunludur)
- **Rust stable** (MSVC toolchain, Windows) + **Node 20+**
- **Frontend:** Vite 6 + TypeScript 5.6 (vanilla) + inline SVG ikonlar
- **Backend:** `serde`, `tokio`, `reqwest`, `thiserror`

```powershell
npm.cmd run tauri dev      # Geliştirme modu (Windows PowerShell'de DAİMA npm.cmd kullanılır)
npm.cmd run build          # Tip denetimi ve bundle (tsc --noEmit && vite build)
cargo check                # Hızlı Rust backend doğrulaması
cargo test                 # Rust birim testleri (yeni mantık/parser eklendiğinde test zorunludur)
```

---

## 3. Katı Kurallar & Sıfır Tolerans (Zero-Tolerance Invariants)

1. **PERFORMANS & HAFİFLİK (1 Numaralı Öncelik):**
   - 500+ oyunluk kütüphanede asla O(N²) arama yapılmaz; `rawOf` ve `summaryOf` hash map'leri O(1) tutulur.
   - Boşta çalışan `requestAnimationFrame`, periyodik polling veya CSS animasyonu bırakılamaz.
   - Heroic Prensibi: Arayüz ÖNCE yerel disk önbelleğinden anında açılır; ağ senkronizasyonu arka planda sessizce yürütülür. Ağ kesilse bile arayüz kilitlenmez.
   - Render disiplini: İlerleme veya IPC olaylarında tüm görünüm ASLA yeniden çizilmez (`innerHTML = ...` yasaktır). İlgili DOM öğeleri yerinde (`patchLibraryCardDom`, `data-dlbtn`) güncellenir.
2. **SIFIR EMOJİ POLİTİKASI (Kesinlikle Yasak):**
   - Arayüzün hiçbir yerinde (butonlar, bildirimler, etiketler, sekmeler, dil seçenekleri) işletim sistemi emojisi (`🎮`, `🚀`, `✨`, `⭐`, `🇹🇷` vb.) KULLANILAMAZ. Her zaman inline SVG ikon (`icon("name", 16)`) veya ISO dil kodu (`TR`, `EN`) kullanılır.
3. **TASARIM DİLİ (Hydra / PS5 Console Dark):**
   - **Gerçek siyah** yüzeyler (`#000000`), 1px hairline sınırlar ve tek beyaz vurgu rengi (`--accent #ffffff`).
   - Renk yalnızca DURUM bildirir (yeşil: online, amber: update/beklemede, kırmızı: hata/sayaç). Süs amaçlı renk kullanımı yasaktır.
   - YASAKLAR: Neon gölgeler (`box-shadow glow`), gradyan metinler (`background-clip: text`), dekoratif mor/cyan gradyanlar, `backdrop-filter: blur` ve her öğeyi 999px kapsüle çevirmek yasaktır.
4. **HYDRA ARAYÜZ SADELİĞİ & ART-FIRST FELSEFESİ (Aşırı Kalabalıklaşma Yasağı):**
   - **Kapak Hijyeni (Art-First):** Kütüphanedeki kapakların üzerine asla sabit oynama süresi veya kupa rozetleri yığılmaz. Kapaklar temiz birer posterdir; detaylar yalnızca hover durumunda veya detay sayfasında gösterilir.
   - **Sıfır Veri Tekrarı:** Aynı sayfada aynı veri (örn. HLTB süresi veya inceleme puanı) asla birden fazla yerde gösterilemez.
   - **Sinematik Oyun Sayfası:** Oyun detay sayfası bir veritabanı veya bento kutu çöplüğü değildir. Geniş hero görseli, net birincil eylem (`Oyna`/`Yükle`) ve ferah bir içerik akışına sahip olmalıdır.
5. **KONTROLCÜ, TV MODU & STEAM INPUT VİZYONU:**
   - **10-ft TV Modu (`tv-mode.ts`):** PC TV'ye bağlandığında klavye/fareye gerek kalmadan PlayStation/Xbox konsol dashboard'u gibi çalışır (A: Seç, B: Geri, LB/RB: Raf geçişi).
   - **Virtual Controller Bridge (Steam Input Eşdeğeri):** Epic ve GOG oyunlarında native DualSense/DualShock desteği olmayan oyunlar (örn: Dead by Daylight) için kontrolcüyü sanal XInput'a (Xbox 360) çeviren native köprü vizyonu hedeflenir.
6. **SAYISAL TİTREME ENGELLEME (Tabular Nums):**
   - İndirme hızları (`MB/s`), disk hızları, yüzdeler (`%45`), oyun süreleri ve kupa sayaçlarında `font-variant-numeric: tabular-nums` zorunludur.
7. **MODÜLERLİK & DOSYA BOYUTU LİMİTİ:**
   - Kaynak dosyaların tek amaca odaklanması hedeflenir. Dev, tek parça monolit dosyalar yazılmaz; sorumluluklar `src/features/<ad>/` veya `src/core/` altında mantıklı modüllere ayrılır.
8. **İNGİLİZCE KOD YORUMLARI:**
   - Tüm kod yorumları yalnızca İngilizce yazılır (harici ve açık kaynak denetçiler için).
9. **COMMIT KURALI:**
   - Git commit'leri ve push işlemleri **yalnızca kullanıcı açıkça talep ettiğinde** yapılır. Commit mesajları standart İngilizce emir kipiyle (`feat: ...`, `fix: ...`, `refactor: ...`) yazılır.
10. **GÖMÜLÜ MAĞAZA ALTIN KURALI:**
   - `WebviewBuilder::additional_browser_args(...)` çağrısı WebView2 alt pencerelerini sessizce bozar; asla kullanılmaz.

---

## 4. Temel Dizin & Mimari Haritası

- `src/core/`: Uygulama çekirdeği (state, türler, i18n, pencere yönetimi, navigasyon, toast, API çağrıları).
- `src/features/`: Modüler işlevler:
  - `library/`: Oyun kartları, kütüphane ızgarası/listesi, filtreleme, sanal sentinel yükleme.
  - `store/`: Gömülü mağazalar (Epic, GOG, Steam).
  - `downloads/`: İndirme kuyruğu, hız hesaplama, transfer yöneticisi.
  - `settings/`: Sistem, hesaplar, indirme, bulut yedekleme, görünüm ayarları.
  - `profile/`: Oyuncu istatistikleri, en çok oynananlar, kupa özeti.
  - `gamepad/`: Kontrolcü dinleyicisi ve 10 fit TV Modu (`tv-mode.ts`).
  - `palette/`: Hızlı komut paleti (Ctrl+K).
  - `notifications/`: Bildirim merkezi ve geçmişi.
- `src-tauri/src/`:
  - `legendary/`: Epic Games istemci/CLI yönetimi, indirme kuyruğu, transferler, önbellek.
  - `gogdl/`: GOG Galaxy / gogdl CLI entegrasyonu, oturum ve presence.
  - `steam*.rs`: Steam oturum yönetimi (QR/credentials), DPAPI mühürlü kasa, kütüphane/başarım parser'ları.
  - `main.rs`: Tauri IPC komut eşlemeleri (`generate_handler!`), pencere yaşam döngüsü.
- `docs/`:
  - `DESIGN_SYSTEM.md`: Renk token'ları, tipografi, buton ve kart sözleşmeleri.
  - `ROADMAP.md`: Aktif görevler, eksik özellikler ve faz planı.
  - `TAURI_IPC_REFERENCE.md`: Frontend ve Rust arasındaki 165+ IPC komutunun tam listesi.
  - `CHANGELOG_INTERNAL.md`: Projenin geçmiş sürüm ve sprint günlükleri.

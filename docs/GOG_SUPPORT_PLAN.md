# GOG.COM Desteği — Kapsamlı Araştırma & Uygulama Planı

> **Tarih:** 2026-09-27
> **Durum:** Araştırma Tamamlandı — Uygulama Bekliyor
> **Hedef:** Efxlve Launcher'a GOG.com kütüphane yönetimi, kurulum, güncelleme ve başlatma desteği eklemek.

---

## İçindekiler

1. [Araştırma Sonuçları](#1-araştırma-sonuçları)
2. [Mimari Karar: heroic-gogdl vs Native Rust](#2-mimari-karar-heroic-gogdl-vs-native-rust)
3. [Mevcut Mimari Analizi & Etki Haritası](#3-mevcut-mimari-analizi--etki-haritası)
4. [Aşamalı Uygulama Planı (Fazlar)](#4-aşamalı-uygulama-planı-fazlar)
5. [Detaylı Teknik Spesifikasyonlar](#5-detaylı-teknik-spesifikasyonlar)
6. [Tip Sistemi Dönüşüm Planı](#6-tip-sistemi-dönüşüm-planı)
7. [i18n — Yeni Çeviri Anahtarları](#7-i18n--yeni-çeviri-anahtarları)
8. [Bilinen Sorunlar & Risk Analizi](#8-bilinen-sorunlar--risk-analizi)
9. [Performans Sözleşmesi](#9-performans-sözleşmesi)
10. [Dosya Yapısı Planı](#10-dosya-yapısı-planı)
11. [Çalışma Takvimi Tahmini](#11-çalışma-takvimi-tahmini)

---

## 1. Araştırma Sonuçları

### 1.1 heroic-gogdl Nedir?

| Özellik | Detay |
|---------|-------|
| **Repo** | [Heroic-Games-Launcher/heroic-gogdl](https://github.com/Heroic-Games-Launcher/heroic-gogdl) |
| **Dil** | Python 3.8+ |
| **Lisans** | GPL-3.0 (legendary ile aynı) |
| **Amaç** | GOG Galaxy resmi olmayan API üzerinden oyun yönetimi |
| **Dağıtım** | PyInstaller ile tek `.exe` olarak paketlenebilir |
| **Kullanım** | Heroic Games Launcher'ın GOG backend'i |

### 1.2 heroic-gogdl Komutları

> [!CAUTION]
> **KRİTİK KEŞİF:** heroic-gogdl `list` veya `library` komutu **İÇERMEZ**. Kendi README'sinde açıkça belirtilir: *"This is not a user friendly CLI, it's meant to be used by some other application."* gogdl **sadece ağır işlemler** (indirme, kurulum, güncelleme, onarım, başlatma, cloud save senkronu) için kullanılır. **Kütüphane listesi, kapak görselleri ve metadata** GOG Galaxy REST API'lerinden doğrudan çekilmelidir.

```
gogdl --auth-config-path <path> <komut> [seçenekler]
```

| Komut | Açıklama | Çıktı |
|-------|----------|-------|
| `auth` | OAuth2 token alışverişi ve yenileme | stdout → JSON (`{access_token, refresh_token, ...}`) |
| `info <id>` | İndirme/disk boyutu, build'ler, DLC'ler | stdout → JSON (`{download_size, disk_size, ...}`) |
| `download <id> --path <dir>` | Oyun indirme/kurulum (xdelta3 delta destekli) | stderr → ilerleme; stdout → sonuç |
| `update <id>` | Delta güncelleme | stderr → ilerleme |
| `repair <id>` | Chunk doğrulama & onarım | stderr → ilerleme |
| `launch <path> <id>` | Oyun başlatma (`goggame-<id>.info`'dan) | Süreç yönetimi |
| `import <path>` | Mevcut kurulumu tanıma | stdout → JSON (`{appName, title, buildId, ...}`) |
| `save-sync <path> <id>` | Çift yönlü bulut kayıt senkronu | stdout → timestamp; stderr → log |
| `save-clear <path> <id>` | Bulut kayıtları temizleme | stderr → log |
| `redist --ids <ids>` | Ön gereksinimler (VCRedist, DirectX) | İndirme |
| `lang-match <lang>` | GOG dil kodu eşleştirme | stdout → JSON |
| ~~`list`~~ | **YOK — gogdl kütüphane listeleme yapmaz** | — |

### 1.3 Hibrit Mimari: gogdl CLI + GOG Galaxy REST API

Heroic'in mimarisi **hibrit**tir. Bu Efxlve için de geçerli olacak:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Efxlve Launcher (Rust Backend)                                     │
│                                                                     │
│  ┌─── Doğrudan REST API (reqwest) ────────────────────────────────┐ │
│  │  • Kütüphane listesi (galaxy-library.gog.com)                  │ │
│  │  • Kapak görselleri (gamesdb.gog.com)                          │ │
│  │  • Ürün detayları (api.gog.com)                                │ │
│  │  • Başarımlar (gameplay.gog.com)                                │ │
│  │  • Oynanış süresi (gameplay.gog.com)                            │ │
│  │  • Token yenileme (auth.gog.com)                               │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─── gogdl CLI (subprocess) ─────────────────────────────────────┐ │
│  │  • İndirme / kurulum / güncelleme / onarım                     │ │
│  │  • Oyun başlatma                                                │ │
│  │  • Cloud save senkronu                                          │ │
│  │  • Delta patching (xdelta3)                                     │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.4 GOG Galaxy REST API — Tam Endpoint Referansı

| Servis | Base URL | Amaç | Auth |
|--------|----------|-------|------|
| **Auth** | `https://auth.gog.com` | OAuth2 login, token exchange/refresh | Hayır (code exchange) |
| **User Profile** | `https://users.gog.com` | Kullanıcı adı, avatar, hesap detayları | `Bearer token` |
| **Galaxy Library** | `https://galaxy-library.gog.com` | Sahip olunan oyunlar, lisans sertifikaları | `Bearer token` |
| **GamesDB** | `https://gamesdb.gog.com` | HD dikey kapaklar, logolar, arka planlar | `Bearer token` + `X-GOG-Library-Cert` |
| **Catalog API** | `https://api.gog.com/products/{id}` | Ürün verileri, dil listesi, çevrimdışı kurucular | Opsiyonel |
| **Games API v2** | `https://api.gog.com/v2/games/{id}` | Sistem gereksinimleri, mağaza metadata | Hayır |
| **Content System** | `https://content-system.gog.com` | Build'ler, depot manifesto, chunk indirme | `Bearer token` / CDN |
| **Cloud Storage** | `https://cloudstorage.gog.com` | Oyun kayıt dosyası senkronu | `Bearer token` |
| **Gameplay** | `https://gameplay.gog.com` | Başarımlar ve oynanış süresi oturumları | `Bearer token` |
| **Remote Config** | `https://remote-config.gog.com` | Cloud save yolları (oyun bazında `clientId`) | Hayır |
| **Images** | `https://images.gog.com` | Kapak görselleri (URL template formatı) | Hayır |

### 1.5 Önemli OAuth2 Kimlik Bilgileri (Reverse-Engineered)

```
Client ID:     46899977096215655
Client Secret: 9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9
Redirect URI:  https://embed.gog.com/on_login_success?origin=client
```

> [!WARNING]
> Bu kimlik bilgileri GOG Galaxy istemcisinin reverse-engineering'inden elde edilmiştir. Resmi olmayan API kullanımıdır. Rate limiting (~200 istek/saat/IP) uygulanır. Agresif önbellekleme ve ETag desteği şarttır.

### 1.6 GOG vs Epic — Özellik Fark Tablosu

| Özellik | Epic (legendary) | GOG (gogdl + Galaxy API) |
|---------|-------------------|---------------------------|
| Auth yöntemi | Auth code → CLI | OAuth2 → browser redirect → CLI |
| Kütüphane listesi | `legendary list --json` (CLI) | **REST API** (`galaxy-library.gog.com`) |
| İndirme ilerlemesi | stderr (`= Progress:`) | stderr (aynı format — `= Progress:`) |
| Bulut kayıt | Destekli | **Destekli** (`cloudstorage.gog.com` + `gogdl save-sync`) |
| Başarımlar/Kupalar | Epic API ile | **Destekli** (`gameplay.gog.com`) |
| Oynanış süresi API | Epic sunucudan | **Destekli** (`gameplay.gog.com` session POST) |
| DRM | Var (EOS) | **DRM-Free** |
| DLC yönetimi | `--skip-dlcs` | Ayrı ürün / `--with-dlcs` flag |
| Multiplayer | EOS üzerinden | Galaxy SDK gerekir (Comet emulatörü var) |
| Cover CDN | Epic metadata keyImages | `gamesdb.gog.com` + `images.gog.com` (URL template) |
| Kapak formatı | Dikey (`DieselGameBoxTall`) | **Dikey mevcut** (`vertical_cover.url_format`) |
| 3. parti launcher | EA, Ubisoft, Rockstar | Nadiren |
| Delta güncelleme | Var | Var (xdelta3) |

---

## 2. Mimari Karar: heroic-gogdl vs Native Rust

### Seçenek A: heroic-gogdl (CLI Wrapper) — ÖNERİLEN (Faz 1)

```
┌─────────────────────────────────────────────┐
│  Efxlve Launcher (Tauri v2)                 │
│  ┌───────────────┐  ┌───────────────┐       │
│  │ legendary/    │  │ gogdl/        │       │
│  │ (Epic CLI)    │  │ (GOG CLI)     │       │
│  │ Rust wrapper  │  │ Rust wrapper  │       │
│  └───────┬───────┘  └───────┬───────┘       │
│          │                  │               │
│  ┌───────▼───────┐  ┌───────▼───────┐       │
│  │ legendary.exe │  │ gogdl.exe     │       │
│  │ (Python bin)  │  │ (Python bin)  │       │
│  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────┘
```

**Avantajları:**
- legendary ile aynı entegrasyon kalıbı — yatırımı tekrar kullanır
- Heroic'te battle-tested, bilinen edge case'ler çözülmüş
- Geliştirme süresi kısa (~2-3 hafta çekirdek)
- İndirme, delta güncelleme, onarım zaten dahil

**Dezavantajları:**
- Python runtime bağımlılığı (PyInstaller ile ~20-30 MB ek binary)
- Process spawn overhead (her komut ~100-200ms)
- stderr parsing legendary'den farklı olabilir
- Bağımlı proje — gogdl geliştiricileri bırakırsa destek durur

### Seçenek B: Native Rust GOG Client (Faz 2 — Gelecek)

**Avantajları:**
- Sıfır dış bağımlılık, küçük binary
- Tauri state entegrasyonu, doğal hata yönetimi
- Daha iyi performans (tokio async, tek süreç)

**Dezavantajları:**
- **Büyük geliştirme yatırımı:** indirme yöneticisi, manifest parser, delta patching, dosya doğrulama kendi yazılacak
- GOG API reverse-engineering riski
- 3-6 ay geliştirme süresi

### Karar

> **Faz 1:** heroic-gogdl CLI wrapper (legendary kalıbı)
> **Faz 2 (opsiyonel):** API'ler stabilize olduktan sonra native Rust istemciye geçiş

---

## 3. Mevcut Mimari Analizi & Etki Haritası

### 3.1 Değişecek Dosyalar (Backend — Rust)

| Dosya | Değişiklik | Etki |
|-------|-----------|------|
| `src-tauri/src/main.rs` | Yeni `gogdl` modül kaydı, GOG komutlarının `invoke_handler`'a eklenmesi | Orta |
| `src-tauri/src/legendary/mod.rs` | Değişmez — Epic'e özel kalır | Yok |
| **YENİ** `src-tauri/src/gogdl/mod.rs` | GOG modül root, `GogError` tipi, binary resolution | Yeni |
| **YENİ** `src-tauri/src/gogdl/commands.rs` | Tauri komutları: `gog_auth`, `gog_list_games`, `gog_launch`, `gog_info` | Yeni |
| **YENİ** `src-tauri/src/gogdl/models.rs` | `GogGame`, `GogInstalled`, `GogLibrary` serde modelleri | Yeni |
| **YENİ** `src-tauri/src/gogdl/api_client.rs` | **REST API istemcisi**: galaxy-library, gamesdb, users, gameplay (reqwest) | Yeni |
| **YENİ** `src-tauri/src/gogdl/transfers.rs` | İndirme kuyruğu & ilerleme takibi (gogdl CLI subprocess) | Yeni |
| **YENİ** `src-tauri/src/gogdl/cache.rs` | Disk cache (library JSON, cover URLs, ETag'ler) | Yeni |
| **YENİ** `src-tauri/src/gogdl/achievements.rs` | GOG başarımlar (`gameplay.gog.com`) | Yeni |
| **YENİ** `src-tauri/src/gogdl/playtime.rs` | GOG oynanış süresi oturumları (`gameplay.gog.com`) | Yeni |
| `src-tauri/tauri.conf.json` | Yeni IPC izinleri, event isimleri | Düşük |
| `Cargo.toml` | Yeni bağımlılık yok (mevcut tokio, serde, reqwest yeterli) | Düşük |

### 3.2 Değişecek Dosyalar (Frontend — TypeScript)

| Dosya | Değişiklik | Etki |
|-------|-----------|------|
| `src/epic.ts` | **Değişmez** — Epic'e özel barrel olarak kalır | Yok |
| **YENİ** `src/gog.ts` | GOG API barrel (`invoke` wrapperları, GOG tipleri) | Yeni |
| `src/core/types.ts` | `GameSource` union tipi ekle, `View` ve `EpicFilter`'a GOG seçenekleri | Orta |
| `src/core/state.ts` | `gogSummaries`, `gogSummariesMap`, `gogAccount`, `gogPhase` state alanları | Orta |
| `src/core/render.ts` | GOG oyunlarını birleşik render'a dahil etme | Yüksek |
| `src/core/nav.ts` | Kenar çubuğuna GOG hesap durumu bilgisi | Düşük |
| `src/core/selectors.ts` | GOG oyunlarını filtreleme sorgularına dahil etme | Orta |
| `src/features/library/library-render.ts` | Birleşik kütüphane kartları: source badge, GOG cover URL çözümü | Yüksek |
| `src/features/library/library-toolbar.ts` | Source filtre sekmesi (All / Epic / GOG) | Orta |
| `src/features/accounts/accounts-view.ts` | GOG hesap bağlama/çıkış UI'sı | Orta |
| `src/features/drawer/` | GOG oyun detay sayfası (başarım/bulut kayıt olmadan) | Orta |
| `src/features/downloads/` | GOG indirme kartları & ilerleme | Orta |
| `src/features/auth/` | GOG OAuth2 auth akışı | Yeni |
| `src/features/settings/` | GOG kurulum dizini, hesap yönetimi | Düşük |
| `src/features/install/` | GOG kurulum diyalogu (dil, platform seçimi) | Orta |
| `src/styles/` | Minimal — mevcut token sistemi yeterli | Düşük |
| `src/locales/*.json` | ~80-100 yeni çeviri anahtarı (tr + en) | Orta |

### 3.3 Değişmeyecek / Minimum Etkilenecek Alanlar

- **TV Modu** — `src/features/gamepad/` — GOG oyunlar da navigate edilebilir olmalı ama yapısal değişiklik yok
- **Komut Paleti** — `src/features/palette/` — GOG oyunlar zaten birleşik listeden gelir
- **Bildirimler** — `src/features/notifications/` — Mevcut altyapı GOG'u da destekler
- **Ekran Görüntüleri** — `src/features/screenshots/` — Oyun kaynağından bağımsız
- **Discord Presence** — `src/presence.rs` — GOG oyunlarında da çalışmalı
- **SteamGridDB** — `src/legendary/steamgrid.rs` — GOG oyunlar için de kapak çekilebilir
- **Koleksiyonlar** — `src/features/collections/` — Source-agnostic, `app_name` + `source` ile çalışır

---

## 4. Aşamalı Uygulama Planı (Fazlar)

### Faz 0: Altyapı Hazırlığı (3-4 gün)

> [!IMPORTANT]
> Mevcut Epic-specific yapıları source-agnostic hale getirmek — **sıfır kırılma** ile.

1. **`GameSource` union tipi ekle** (`types.ts`):
   ```typescript
   export type GameSource = "epic" | "gog";
   ```

2. **Birleşik `LibraryItem` arayüzü oluştur:**
   ```typescript
   export interface LibraryItem {
     id: string;           // app_name (Epic) veya game_id (GOG)
     source: GameSource;
     title: string;
     developer: string | null;
     is_installed: boolean;
     install_path: string | null;
     install_size: number | null;
     cover_url: string | null;
     portrait_url: string | null;
   }
   ```

3. **State'e `allGames` birleşik Map ekle:**
   ```typescript
   // Epic ve GOG'dan gelen tüm oyunlar burada birleşir
   allGamesMap: new Map<string, LibraryItem>()
   ```
   > Key formatı: `epic::<app_name>` veya `gog::<game_id>` — çakışma riski sıfır.

4. **Kütüphane render'ını `LibraryItem` üzerinden çalışacak şekilde refactor et** — Hâlâ sadece Epic verisinden beslenecek ama arayüz artık kaynak-agnostik.

5. **`data-lib-item` attribute'unu `data-source` ile zenginleştir:**
   ```html
   <div class="lib-card" data-lib-item="Fortnite" data-source="epic">
   ```

### Faz 1: gogdl Binary Entegrasyonu (3-4 gün)

1. **gogdl binary çözümleme & otomatik indirme:**
   - `src-tauri/src/gogdl/mod.rs` → binary path, auto-download (legendary ile aynı kalıp)
   - GitHub Releases'dan son sürüm `.exe` indirme
   - `%LOCALAPPDATA%\efxlve\gogdl\gogdl.exe` konumu

2. **`src-tauri/src/gogdl/commands.rs` — Temel komutlar:**
   ```rust
   #[tauri::command]
   async fn gog_setup_status(...) -> Result<GogSetupStatus, String>
   
   #[tauri::command]
   async fn gog_auth_status(...) -> Result<GogAuthStatus, String>
   
   #[tauri::command]
   async fn gog_auth_code(code: String, ...) -> Result<(), String>
   
   #[tauri::command]
   async fn gog_logout(...) -> Result<(), String>
   
   #[tauri::command]
   async fn gog_list_games(...) -> Result<Vec<GogGameSummary>, String>
   
   #[tauri::command]
   async fn gog_cached_library(...) -> Result<GogCachedLibrary, String>
   
   #[tauri::command]
   async fn gog_game_info(game_id: String, ...) -> Result<GogGameInfo, String>
   ```

3. **`src-tauri/src/gogdl/models.rs` — Serde modelleri:**
   ```rust
   #[derive(Serialize, Deserialize)]
   pub struct GogGameSummary {
       pub game_id: String,
       pub title: String,
       pub developer: Option<String>,
       pub is_installed: bool,
       pub install_path: Option<String>,
       pub install_size: Option<u64>,
       pub cover_url: Option<String>,
       pub platforms: Vec<String>,
       pub available_languages: Vec<String>,
   }
   ```

4. **`main.rs`'e kayıt:**
   ```rust
   mod gogdl;
   // invoke_handler'a gog_* komutlarını ekle
   ```

### Faz 2: GOG Authentication (2-3 gün)

1. **OAuth2 akışı:**
   ```
   User → GOG Login Page (browser/webview)
         → Redirect URI ile auth code
         → gogdl auth --code <code>
         → auth.json yazılır
   ```

2. **Login URL:**
   ```
   https://auth.gog.com/auth?client_id=<GALAXY_CLIENT_ID>&redirect_uri=https://embed.gog.com/on_login_success&response_type=code&layout=client2
   ```

3. **Accounts sayfasına GOG bağlantısı:**
   - Mevcut `accounts-view.ts`'e GOG bölümü
   - "GOG Hesabı Bağla" butonu → webview/tarayıcıda login → code yakalama
   - Bağlı hesap gösterimi (kullanıcı adı, oyun sayısı)

4. **Token yönetimi:**
   - `auth.json` diskte tutulur
   - Token yenileme gogdl tarafından otomatik yapılır
   - Expired token → UI'da "Yeniden giriş yap" bildirimi

> [!CAUTION]
> **Zorluk:** GOG login sayfası CAPTCHA içerebilir. Tauri child webview ile login açmak ideal çözüm ama `X-Frame-Options` engelleyebilir. Alternatif: harici tarayıcıda açıp redirect URI'den code yakalamak (localhost callback sunucusu veya custom protocol handler).

### Faz 3: GOG Kütüphane Entegrasyonu (4-5 gün)

1. **Cache-first mimari (Heroic Prensibi):**
   ```
   Uygulama açılır
     → gog_cached_library() → disk cache'den anında yükle
     → gog_list_games() → arka planda ağ senkronu
     → Fark varsa → patchLibraryCardDom() ile yerinde güncelle
   ```

2. **Birleşik kütüphane:**
   - Library toolbar'a "Source" filtresi: All | Epic | GOG
   - Arama, sıralama ve filtreler GOG oyunlarda da çalışır
   - `dev:` ve `is:` gelişmiş arama GOG'u destekler (`is:gog`, `is:epic`)

3. **Cover art çözümü:**
   ```typescript
   // GOG cover URL pattern
   function gogCover(game: GogGame): string | null {
     // https://images.gog.com/<hash>_product_card_v2_mobile_slider_639.jpg
     // veya https://images.gog.com/<hash>.png
     return game.cover_url || null;
   }
   
   function gogPortrait(game: GogGame): string | null {
     // GOG portre kapak olmayabilir → kare/yatay kırpma gerekebilir
     return game.vertical_cover_url || game.cover_url || null;
   }
   ```

4. **Kütüphane kartı render — kaynak ayrımı:**
   - Kart yapısı aynı — `LibraryItem` üzerinden
   - GOG kartlarında küçük kaynak ikonu (sol üst, 12px, soluk): GOG logosu SVG
   - Epic kartlarında ikon gösterilmez (varsayılan kaynak)
   - Alternatif: Her iki kaynakta da ikon göstermek — **kullanıcı tercihi**

### Faz 4: İndirme & Kurulum (4-5 gün)

1. **GOG kurulum diyalogu:**
   - Dil seçimi (GOG oyunlar çok dilli, kurulum dili seçilir)
   - Platform: Windows (tek hedef şimdilik)
   - Hedef dizin seçimi
   - DLC yok — GOG DLC'leri ayrı ürün olarak gelir

2. **İndirme kuyruğu:**
   - Mevcut `DownloadItem` arayüzüne `source: GameSource` ekle
   - GOG ve Epic indirmeleri aynı kuyrukta, sıralı
   - İlerleme takibi: gogdl stderr parsing (legendary'ye benzer)

3. **Güncelleme kontrolü:**
   - `gog_check_updates()` → mevcut versiyon vs sunucu versiyonu
   - Güncelleme bildirimi → indirme kuyruğuna ekleme

4. **Oyun taşıma:**
   - `move-game` modülü GOG'u da desteklemeli
   - GOG oyunları DRM-free → dosya taşıma daha basit

### Faz 5: Oyun Başlatma & İzleme (2-3 gün)

1. **Başlatma:**
   ```rust
   // GOG oyunlar DRM-free → doğrudan exe çalıştırılabilir
   // VEYA gogdl launch <game_id> kullanılabilir
   gog_launch(game_id: String, ...) -> Result<(), String>
   ```

2. **Süreç izleme:**
   - Mevcut `runningGames` Set'ine GOG oyunları da eklenir
   - Key: `gog::<game_id>` formatı
   - Oynanış süresi takibi: `playtime.rs` mantığı GOG'a da uygulanır

3. **Discord Rich Presence:**
   - GOG oyunları da presence gösterir
   - Game title + elapsed time

4. **Ekran görüntüsü:**
   - Mevcut hotkey sistemi GOG oyunlarda da çalışır (kaynak bağımsız)

### Faz 6: Detay Sayfası (Drawer) (3-4 gün)

1. **GOG oyun drawer'ı:**
   - Hero banner: GOG'dan geniş görsel (galaxy_background veya screenshot)
   - Başlık, geliştirici, boyut, platform
   - Açıklama: GOG API'den veya Wikipedia fallback

2. **Sekmeler (GOG kısıtlamaları):**

   | Sekme | Epic | GOG | Not |
   |-------|------|-----|-----|
   | Overview | Var | Var | GOG açıklaması farklı format |
   | Achievements | Var | **Yok** | GOG API başarım desteklemiyor |
   | DLCs | Var | **Kısıtlı** | GOG DLC'ler ayrı ürün |
   | Screenshots | Var | Var | Kaynak bağımsız |
   | Manage | Var | Var | Wrapper/env, dizin, kaldırma |
   | Specs | Var | **Var** | GOG API'den gereksinimler |

3. **HLTB & Critic:**
   - HowLongToBeat → oyun başlığı ile arama (kaynak bağımsız)
   - OpenCritic → aynı

### Faz 7: İmport, Repair & Kaldırma (1-2 gün)

1. **Import:** `gogdl import <game_id> <path>` — mevcut GOG kurulumunu tanıma
2. **Repair:** `gogdl repair <game_id>` — dosya doğrulama
3. **Kaldırma:** Dizin silme (DRM-free = basit uninstall)

---

## 5. Detaylı Teknik Spesifikasyonlar

### 5.1 gogdl stderr İlerleme Parsing

> [!NOTE]
> heroic-gogdl'nin stderr formatı legendary'den farklıdır. Heroic kaynak kodundan parse kalıpları:

```
# Olası format (Heroic referans):
[gogdl] INFO: Downloading file 1/50: game.bin
[gogdl] INFO: Progress: 45.2% (1.5 GB / 3.3 GB), Speed: 25.4 MB/s, ETA: 00:02:30
```

Rust tarafında parsing:
```rust
fn parse_gog_progress(line: &str) -> Option<GogProgress> {
    if let Some(caps) = GOG_PROGRESS_RE.captures(line) {
        Some(GogProgress {
            percent: caps["pct"].parse().ok()?,
            downloaded: caps["dl"].to_string(),
            total: caps["total"].to_string(),
            speed: caps["speed"].to_string(),
            eta: caps["eta"].to_string(),
        })
    } else {
        None
    }
}
```

### 5.2 Auth Code Yakalama Stratejileri

**Strateji 1: Custom Protocol Handler (Önerilen)**
```
efxlve://gog-auth?code=XXXX
```
- Tauri `deep-link` plugin'i ile yakalanır
- GOG redirect_uri olarak kaydedilir
- En temiz çözüm

**Strateji 2: Localhost HTTP Sunucu**
```rust
// Geçici localhost sunucu → redirect_uri = http://localhost:PORT/callback
// Code yakalandıktan sonra sunucu kapanır
```

**Strateji 3: Manuel Kod Girişi**
- Kullanıcı login sayfasından kodu kopyalar
- Launcher'a yapıştırır (legendary ile aynı pattern)
- En basit, en güvenilir

> **Karar:** Strateji 3 (Manuel) ile başla — legendary ile tutarlı, kanıtlanmış. Custom protocol (Strateji 1) Faz 2'de eklenebilir.

### 5.3 GOG Login URL

```
https://auth.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code&layout=client2
```

> GOG Galaxy client_id: `46899977096215655` (reverse-engineered, Heroic kullanımı)

### 5.4 GOG Cover URL Çözümü

```typescript
// GOG API product response'ından:
// images.logo  → yatay logo
// images.logo2x → yatay logo @2x
// images.icon → kare ikon
// images.sidebarIcon → küçük ikon
// images.sidebarIcon2x → küçük ikon @2x
// images.menuNotificationAv → avatar
// images.background → arka plan (1920px)
// screenshots → ekran görüntüleri

// KAPAK görseli için:
// https://images.gog.com/<hash>_product_card_v2_mobile_slider_639.jpg
// https://images.gog.com/<hash>_product_tile_256_2x.jpg
// https://images.gog.com/<hash>_196.jpg (kare, küçük)
// https://images.gog.com/<hash>_ggvgm.jpg (dikey kapak — nadir)
```

> [!WARNING]
> **Portre kapak sorunu:** GOG, Epic gibi sistematik dikey kapak (`DieselGameBoxTall`) sağlamaz. Çoğu oyunda sadece yatay/kare görsel vardır. Çözüm seçenekleri:
> 1. SteamGridDB'den dikey kapak çek (mevcut altyapı var)
> 2. Yatay görseli CSS `object-fit: cover` ile kart formatına sığdır
> 3. GOG oyunlar için farklı kart boyutu (önerilmez — tutarsız)
>
> **Önerilen:** SteamGridDB otomatik fallback + yatay görseli `object-fit: cover` ile crop

---

## 6. Tip Sistemi Dönüşüm Planı

### 6.1 Yeni Tipler (`src/gog.ts`)

```typescript
// GOG-specific types
export interface GogGame {
  game_id: string;
  title: string;
  slug: string;
  developer: string | null;
  publisher: string | null;
  cover_url: string | null;
  background_url: string | null;
  icon_url: string | null;
  platforms: string[];
  languages: string[];
  genre: string | null;
  release_date: string | null;
}

export interface GogInstalled {
  game_id: string;
  title: string;
  install_path: string;
  version: string;
  install_size: number;
  platform: string;
  language: string;
}

export interface GogCachedLibrary {
  account: string | null;
  games: GogGame[];
  installed: GogInstalled[];
}

export interface GogSetupStatus {
  binary_path: string | null;
  version: string | null;
  needs_download: boolean;
}

export interface GogAuthStatus {
  logged_in: boolean;
  username: string | null;
  user_id: string | null;
}
```

### 6.2 Birleşik Tip Değişiklikleri (`src/core/types.ts`)

```typescript
// YENİ
export type GameSource = "epic" | "gog";

// DEĞİŞEN
export type View = "library" | "downloads" | "settings" | "profile" | "store" | "accounts";
// Store gog.com da destekleyecek mi? → Faz 2'de değerlendirilecek

// DEĞİŞEN — filtre genişletme
export type SourceFilter = "all" | "epic" | "gog";
// EpicFilter kendi başına kalır, kaynak filtresi ayrı

// YENİ
export interface LibraryItem {
  id: string;
  source: GameSource;
  title: string;
  developer: string | null;
  is_installed: boolean;
  install_path: string | null;
  install_size: number | null;
  cover_url: string | null;
  portrait_url: string | null;
  version: string | null;
  cloud_saves: boolean;
  has_achievements: boolean;
}
```

### 6.3 State Değişiklikleri (`src/core/state.ts`)

```typescript
// Eklenecek alanlar
gogPhase: "checking" as GogPhase,
gogAccount: "",
gogAccountId: null as string | null,
gogSummaries: [] as GogGameSummary[],
gogSummariesMap: new Map() as Map<string, GogGameSummary>,
gogGamesRaw: [] as GogGame[],
gogGamesRawMap: new Map() as Map<string, GogGame>,
gogSyncing: false,
gogSyncNote: "",
gogError: "",
gogBooted: false,
gogDefaultDir: "",
sourceFilter: "all" as SourceFilter,
```

### 6.4 O(1) Lookup Kuralı (Altın Kural §12)

```typescript
// Epic: epicSummariesMap.get(appName)
// GOG:  gogSummariesMap.get(gameId)
// Birleşik: allGamesMap.get("epic::Fortnite") veya allGamesMap.get("gog::1207658691")
```

---

## 7. i18n — Yeni Çeviri Anahtarları

Yaklaşık 80-100 yeni anahtar gerekecek. Örnekler:

```json
{
  "gog.connectAccount": "Connect GOG Account",
  "gog.disconnect": "Disconnect",
  "gog.loginPrompt": "Sign in to your GOG account to access your library",
  "gog.loginUrl": "Open GOG Login Page",
  "gog.enterCode": "Enter authorization code",
  "gog.authenticating": "Authenticating...",
  "gog.syncing": "Syncing GOG library...",
  "gog.syncComplete": "GOG library synced",
  "gog.syncFailed": "GOG sync failed",
  "gog.noGames": "No GOG games found",
  "gog.drmFree": "DRM-Free",
  "gog.selectLanguage": "Installation Language",
  "gog.importing": "Importing existing installation...",
  "gog.repairing": "Verifying game files...",
  "gog.repairComplete": "Verification complete",
  "gog.noAchievements": "GOG games do not support achievements through this launcher",
  "gog.noCloudSaves": "Cloud saves are not available for GOG games",
  "source.all": "All",
  "source.epic": "Epic",
  "source.gog": "GOG",
  "filter.source": "Source"
}
```

> tr/en tam eşlikli tutulacak (mevcut i18n kuralı).

---

## 8. Bilinen Sorunlar & Risk Analizi

### 8.1 Kritik Riskler

| Risk | Etki | Olasılık | Azaltma |
|------|------|----------|---------|
| **GOG API breaking change** | Kütüphane/auth bozulur | Orta | gogdl güncellemesine bağımlılık; API cache-first |
| **gogdl projesi terk edilir** | GOG desteği kaldırılır | Düşük | Faz 2'de native Rust client'a geçiş planı |
| **CAPTCHA login engellemesi** | Auth çalışmaz | Orta | Manuel kod girişi (CAPTCHA sonrası) |
| **Portre kapak eksikliği** | Kütüphane tutarsız görünür | Yüksek | SteamGridDB fallback + crop |
| **Python runtime boyutu** | Binary +25 MB | Kesin | Kabul edilebilir — legendary zaten Python |
| **GOG oyun ID çakışması** | Library key collision | Çok düşük | `gog::` prefix ile namespace ayrımı |

### 8.2 Bilinen Kısıtlamalar

1. **Başarımlar mevcut ama sınırlı** — `gameplay.gog.com` üzerinden başarım verileri çekilebilir. Ancak tüm GOG oyunları başarım desteklemiyor (sadece Galaxy SDK entegreli oyunlar). Başarım sekmesi kaynak bazlı koşullu gösterilmeli.

2. **Bulut kayıt mevcut** — `gogdl save-sync` + `cloudstorage.gog.com` ile çift yönlü senkron yapılabilir. `remote-config.gog.com` üzerinden oyun bazında kayıt yolları alınır. Ancak tüm oyunlar desteklemiyor.

3. **Oynanış süresi sunucu destekli** — `gameplay.gog.com` üzerinden oturum POST'u ile süre kaydedilir ve çekilir. Epic'tekine benzer şekilde hem sunucu hem yerel süre birleştirilebilir.

4. **DLC yönetimi farklı** — GOG'da DLC'ler ayrı ürün olarak veya `--with-dlcs` flag ile kurulur. Epic'teki `--skip-dlcs` mekanizmasından farklı. DLC sekmesi farklı çalışacak.

5. **Çevrimdışı mod** — GOG oyunlar DRM-free olduğu için çevrimdışı başlatma sorunsuz çalışır. Ancak kütüphane senkronu ve başarım takibi ağ gerektirir.

6. **Rate limiting** — `api.gog.com/products/*` → ~200 istek/saat/IP. Büyük kütüphanelerde metadata çekimi yavaş olabilir. ETag HTTP 304 caching şart.

7. **EOS Overlay yok** — GOG oyunlar Epic Online Services overlay'ini desteklemez. EOS rozeti/tespiti devre dışı.

8. **Galaxy multiplayer yok** — GOG Galaxy SDK multiplayer servisleri `gogdl` ile çalışmaz. Comet emulatörü opsiyonel entegrasyon olarak Faz 2'de değerlendirilebilir.

9. **PyInstaller anti-virus tetiklemesi** — `gogdl.exe` PyInstaller ile paketlendiğinde `%TEMP%\_MEIxxxx` klasörüne açılır ve bazı antivirüsler tarafından taranabilir/bloke edilebilir.

### 8.3 Edge Case'ler

1. **Aynı oyun hem Epic hem GOG'da** — Örn. The Witcher 3 her iki mağazada. Kütüphanede iki kart olarak görünmeli, farklı `id` ve `source` ile. Birleştirme yapılmaz.

2. **GOG Galaxy zaten kuruluysa** — İmport özelliği ile mevcut GOG Galaxy kurulumları tanınabilir. Ama GOG Galaxy ile eş zamanlı çalışma sorun yaratabilir (kilit dosyaları).

3. **Hesap geçişi** — Birden fazla GOG hesabı desteklenmeli mi? Faz 1'de tek hesap yeterli. Multi-account Faz 2'de değerlendirilecek.

4. **Linux/macOS GOG oyunları** — Efxlve sadece Windows hedefliyor. GOG'un çok platformlu oyunlarında sadece Windows installer'ı kullanılacak.

---

## 9. Performans Sözleşmesi

GOG entegrasyonu projenin **performans sözleşmesini** (AGENTS.md §4.1, §4.10, §6.11-17) ihlal etmemelidir:

| Kural | Uygulama |
|-------|----------|
| **O(1) lookup** | `gogSummariesMap` + `allGamesMap` hash map'leri |
| **Progressive rendering** | Birleşik kütüphanede chunk boyutu korunur (48 + 36n) |
| **Lazy cover loading** | `loading="lazy"` GOG kapaklar için de zorunlu |
| **Cache-first** | `gog_cached_library()` → disk anında; ağ arka planda |
| **Sıfır boşta yük** | GOG polling/yoklama döngüsü yok |
| **DOM patch** | `patchLibraryCardDom` GOG kartları için de geçerli |
| **`contain: layout paint`** | GOG kartlarında da zorunlu |
| **Tabular nums** | GOG indirme hızları, boyutları |
| **Render disiplini** | GOG senkronu sırasında full innerHTML yasak |

> Birleşik kütüphanede 500 Epic + 200 GOG = 700 oyun senaryosu test edilmeli. FCP < 200ms hedefi korunmalı.

---

## 10. Dosya Yapısı Planı

```
src-tauri/src/
├── legendary/         # Epic Games (mevcut, değişmez)
│   ├── mod.rs
│   ├── commands.rs
│   ├── models.rs
│   ├── transfers.rs
│   ├── cache.rs
│   ├── downloader.rs
│   └── ...
├── gogdl/             # GOG Games (YENİ)
│   ├── mod.rs         # GogError, binary resolution, constants
│   ├── commands.rs    # Tauri IPC commands (~800-1000 satır)
│   ├── models.rs      # Serde models (~200-300 satır)
│   ├── api_client.rs  # REST API istemcisi: library, covers, users (~600-800 satır)
│   ├── transfers.rs   # Download queue & progress via gogdl CLI (~500-700 satır)
│   ├── cache.rs       # Disk cache + ETag management (~200-300 satır)
│   ├── achievements.rs # GOG achievements via gameplay.gog.com (~300 satır)
│   └── playtime.rs    # GOG playtime sessions (~200 satır)
├── main.rs            # + gogdl modül kaydı
├── eos.rs
└── presence.rs

src/
├── epic.ts            # Epic API barrel (mevcut, değişmez)
├── gog.ts             # GOG API barrel (YENİ, ~300-400 satır)
├── core/
│   ├── types.ts       # + GameSource, SourceFilter, LibraryItem
│   ├── state.ts       # + gog* state alanları
│   ├── selectors.ts   # + GOG filtreleme
│   └── render.ts      # Birleşik render orchestration
├── features/
│   ├── library/
│   │   ├── library-render.ts  # Birleşik kart render
│   │   └── library-toolbar.ts # + Source filtre sekmesi
│   ├── accounts/
│   │   └── accounts-view.ts   # + GOG hesap bölümü
│   ├── auth/
│   │   └── gog-auth.ts        # GOG OAuth2 akışı (YENİ)
│   ├── downloads/
│   │   └── ...                # + GOG download kartları
│   ├── drawer/
│   │   └── ...                # GOG drawer uyarlamaları
│   ├── install/
│   │   └── ...                # + GOG kurulum diyalogu
│   └── settings/
│       └── ...                # + GOG dizin & hesap ayarları
└── locales/
    ├── tr.json                # + ~80-100 gog.* anahtarları
    └── en.json                # + ~80-100 gog.* anahtarları
```

---

## 11. Çalışma Takvimi Tahmini

| Faz | İçerik | Tahmini Süre | Kümülatif |
|-----|--------|-------------|-----------|
| **Faz 0** | Altyapı: tip sistemi, source-agnostic refactor | 3-4 gün | 3-4 gün |
| **Faz 1** | gogdl binary: setup, commands, models | 3-4 gün | 6-8 gün |
| **Faz 2** | Authentication: OAuth2, accounts UI | 2-3 gün | 8-11 gün |
| **Faz 3** | Kütüphane: birleşik render, cover, filtre | 4-5 gün | 12-16 gün |
| **Faz 4** | İndirme & Kurulum: queue, progress, install dialog | 4-5 gün | 16-21 gün |
| **Faz 5** | Başlatma & İzleme: launch, playtime, presence | 2-3 gün | 18-24 gün |
| **Faz 6** | Detay sayfası: drawer, HLTB, manage | 3-4 gün | 21-28 gün |
| **Faz 7** | Import, Repair, Kaldırma | 1-2 gün | 22-30 gün |
| **Test & Polish** | Edge case'ler, performans testi, i18n | 3-5 gün | **25-35 gün** |

> **Toplam: ~5-7 hafta** (tam zamanlı geliştirme)

---

## Sonraki Adımlar

1. [ ] Bu planı gözden geçir ve onay ver
2. [ ] Faz 0'ı başlat: `GameSource` ve `LibraryItem` tiplerini ekle
3. [ ] gogdl binary'sini GitHub'dan indirip Windows'ta test et
4. [ ] gogdl CLI komutlarını elle çalıştırıp stderr formatını doğrula
5. [ ] Rust `gogdl/` modülünü oluştur (skeleton)

> [!TIP]
> Faz 0 (tip sistemi refactoru) mevcut Epic işlevselliğini **hiç bozmadan** yapılabilir ve yapılmalıdır. Bu, geri kalan fazlar için sağlam bir temel oluşturur.

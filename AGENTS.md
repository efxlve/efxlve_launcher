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
`epic_list_skipped`
Transfer: `epic_install_game`, `epic_cancel_download`, `epic_uninstall_game`,
`epic_default_install_dir`, `epic_set_install_dir`, `epic_launch_game`
Pencere: `show_store_view`, `hide_store_view`, `open_folder`

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
- Sinematik Hero Spotlight (son oynanan/öne çıkan dev afiş, hızlı başlat, canlı istatistikler)
- Hızlı filtre çipleri (Tüm Oyunlar, Kurulu, Favoriler, Güncellemeler) + Ctrl+F kısayolu
- S/M/L dinamik kart boyutu seçici (büyük poster desteği)
- Çakışmasız ambient glow'lu portre kartlar ve canlı taban indirme progress barı
- Sağdan kayan sinematik detay çekmecesi (Drawer) ve modern metadata ızgarası
- Gömülü webview mağaza entegrasyonu (doğrudan oyunun `/p/<slug>` mağaza sayfasını launcher içinde açma)
Sıradaki adaylar: indirme hızı/ETA göstergesi, oyun güncelleme akışı (`update`),
bulut kayıt arayüzü (`sync-saves`), DLC kurulumu, EGL içe aktarma UI'ı, paketleme (`tauri build`).

## 9. Çalışma disiplini

- Kullanıcı Türkçe konuşur — yanıtlar ve UI metinleri Türkçe, kod yorumları kısa Türkçe.
- Kısa ve öz iletişim; gereksiz dosya oluşturma (yeni dosya = sadece açıkça gerekirse).
- `dist/`, `target/`, `node_modules/` commitlenmez (gitignore'lu).
- Commit/PR yalnızca açıkça istenirse.

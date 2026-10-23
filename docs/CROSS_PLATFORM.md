# CROSS_PLATFORM.md — Efxlve Launcher Linux & macOS Uyumluluk Katmanı (Araştırma & Mimari Tasarım)

> **Durum:** Çekirdek katman, mağaza CLI'ları, uyumluluk araçları ve başlatma zinciri uygulandı (2026-10-23).
> Linux/macOS paketleme ve gerçek donanım doğrulaması açık.
> **Amaç:** Heroic Games Launcher modelini referans alarak Efxlve Launcher'ın Windows dışına
> taşınma stratejisini, Wine/Proton/D3DMetal katmanlarını ve platform soyutlamasını tanımlamak.

---

## 1. Neden Mümkün? (Mevcut Mimarinin Getirdiği Avantaj)

Efxlve Launcher zaten iki büyük taşınabilirlik avantajına sahiptir:

1. **`legendary` CLI platformdan bağımsızdır.** Epic kimlik doğrulama, katalog, manifest,
   indirme ve bulut kayıt işlemleri Python tabanlı `legendary` ile yürütülür; Linux/macOS
   için resmi binary mevcuttur. Rust backend yalnızca süreç sarıcıdır (`client.rs`,
   `transfers.rs`), dolayısıyla bu katman büyük ölçüde yeniden kullanılabilir.
   Epic'in Ekim 2026'da yayımladığı Linux önizleme istemcisi ayrı bir uygulamadır;
   bu launcher Epic kurulumlarını yine `legendary` üzerinden yönetir ve resmi
   istemcinin kurulu olmasını gerektirmez. Heroic de aynı yaklaşımı kullanır.
2. **Tauri v2 + Vite/TypeScript frontend platformdan bağımsızdır.** Arayüz, oyun kolu
   navigasyonu, tema ve render disiplini değişmeden çalışır.

**Taşınması gereken Windows'a özgü yüzeyler:**
- Windows Registry taramaları (`cache.rs` EGL algılama, `commands.rs` 3. parti başlatıcı hub'ı).
- Düşük seviyeli klavye kancası ile ekran görüntüsü (`screenshots.rs` — Win32 `SetWindowsHookEx`).
- Gömülü Epic Mağaza native child webview'i (`main.rs` `add_child`; Windows'ta `HWND` tabanlı).
- `explorer` / `link2ea://` / `.lnk` kısayolu gibi Windows kabuk entegrasyonları.
- Sürücü listeleme (`move_game.rs` — Windows sürücü harfleri).

---

## 2. Ortak Mimari: Platform Soyutlama Katmanı

Önerilen yaklaşım, mevcut `src-tauri/src/legendary/` modüllerinin yanına bir
`src-tauri/src/platform/` modülü eklemektir. Derleme zamanında `#[cfg(target_os = "...")]`
ile platforma özgü implementasyon seçilir; iş mantığı `trait` üzerinden konuşur.

```rust
// platform/mod.rs
pub trait PlatformHost {
    /// Varsayılan oyun kurulum kökü (Win: %USERPROFILE%\Games, Linux: ~/Games, macOS: ~/Games).
    fn default_install_dir(&self) -> PathBuf;
    /// Sistem sürücüleri / bağlı birimler (Win: C:, D:; Linux/macOS: mount noktaları).
    fn system_drives(&self) -> Vec<SystemDriveInfo>;
    /// Klasörü dosya yöneticisinde açar (explorer / xdg-open / open).
    fn reveal_in_file_manager(&self, path: &Path) -> Result<()>;
    /// Ekran görüntüsü yakalama kancası (Win: Win32 hook; Linux: XDG portal; macOS: screencapture).
    fn install_screenshot_hook(&self, hotkey: u32) -> Result<()>;
    /// Harici başlatıcı protokolleri (Win: link2ea://, uplay://; diğer: yok / wine ile).
    fn launch_third_party(&self, protocol: &str, app_name: &str) -> Result<()>;
}
```

`cfg` ile iki implementasyon: `platform/windows.rs` (mevcut davranış korunur) ve
`platform/unix.rs` (Linux + macOS ortak payda; macOS'a özgü dallar ayrıca `cfg(target_os = "macos")`).

---

## 3. Linux Mimarisi (Wine / Proton / umu)

Heroic modeli: `legendary launch <app> --no-wine --wrapper "<runner> run"`.

### 3.1. Çalıştırıcı (Runner) Katmanı
| Bileşen | Rol |
|---|---|
| **GE-Proton** (`proton-ge-custom`) | Önerilen varsayılan; Valve Proton + GloriousEggroll yamaları (medya codec, anticheat uyumu). |
| **Proton-cachyos** | Alternatif performans odaklı runner. |
| **Wine-GE / Wine-Lutris** | Steam dışı, saf Wine gerektiren senaryolar. |
| **umu-launcher** | Steam Runtime dışında Proton'u çalıştıran standart başlatıcı (`STEAM_COMPAT_*` ortamını yönetir). Modern Heroic varsayılanı. |
| **DXVK** | DirectX 9/10/11 → Vulkan çevirisi. |
| **VKD3D-Proton** | DirectX 12 → Vulkan çevirisi. |
| **Gamescope / GameMode** | Kapsayıcı compositor / CPU governor optimizasyonu (Steam Deck dostu). |

### 3.2. Prefix Yöneticisi (Her Oyun İçin İzole `WINEPREFIX`)
- Oyun başına `~/Games/Heroic/Prefixes/<AppName>` altında prefix oluşturulur.
- Proton için `STEAM_COMPAT_DATA_PATH=<prefix>`, `STEAM_COMPAT_CLIENT_INSTALL_PATH`
  ve `STEAM_COMPAT_APP_ID=0` ortam değişkenleri ayarlanır.
- DXVK/VKD3D aç-kapa, FSR/Sharpness, `nvidiaPrime`, `useGameMode` ve `WINEDLLOVERRIDES`
  gibi ayarlar oyun bazlı `GameLocalSettings` şemasına eklenir (mevcut yapı genişletilir).
- Winetricks / protontricks eşdeğeri işlemler prefix içinde runner'ın kendi `wine` binary'siyle koşturulur.

### 3.3. Wine Manager (Runner İndirme & Yönetim)
- Runner'lar `~/.config/efxlve/tools/{wine,proton}` altına indirilir.
- Heroic'in aradığı bilinen konumlar da taranır: `~/.steam/root/compatibilitytools.d`,
  `~/.steam/steam/steamapps/common`, `~/.local/share/lutris/runners/wine`, `/usr/share/steam`.
- GitHub Releases üzerinden GE-Proton / Wine-GE indirme + SHA-256 doğrulaması
  (`downloader.rs` altyapısı yeniden kullanılır).

### 3.4. Uyumluluk Bilgisi
- **ProtonDB** API/rozet entegrasyonu: oyun detay çekmecesinde uyumluluk seviyesi.
- **Steam Deck Verified** durumu (varsa) gösterilir.
- Anticheat uyarısı: Wine/Proton altında ban riski taşıyan oyunlar için bilgilendirme
  (Heroic FAQ'de olduğu gibi).

### 3.5. Paketleme
- **Flatpak** (`com.efxlve.launcher`) — Steam Deck ve immutable distrolar için birincil.
- **AppImage** — dağıtımdan bağımsız taşınabilir paket.
- `.deb` / `.rpm` / AUR ikincil.

---

## 4. macOS Mimarisi (Apple Silicon Odaklı)

> **Kritik gerçek (2026):** CrossOver 27 ile Intel Mac ve 32-bit bottle desteği kaldırıldı;
> ekosistem **Apple Silicon (M1+)** ve **macOS Sonoma+** üzerine yoğunlaştı. Tasarım bu
> hedefe göre yapılmalıdır.

| Katman | Seçenek | Not |
|---|---|---|
| **Birincil (ücretsiz)** | **Apple Game Porting Toolkit 4** (D3DMetal) + Wine (Gcenx build) | DirectX 11/12 → Metal; Apple lisansı ticari dağıtımı sınırlar, kullanıcı tarafından kurulur. |
| **Alternatif** | **DXMT** (D3D → Metal, açık kaynak) | CrossOver'sız ücretsiz yığınlarda yaygın. |
| **Ticari** | **CrossOver** bottle yönetimi | Heroic `wineCrossoverBottle` modeline benzer. |
| **Runner** | Wine-Crossover, Wine-Staging, GPTK | Heroic'in macOS Wine Manager eşdeğeri. |

- Prefix: CrossOver bottle veya `WINEPREFIX` (Mac sürümüne göre).
- MetalFX / D3DMetal DLL override'ları prefix bazlı yönetilir.
- Rosetta 2 yalnızca x86_64 yardımcı süreçler için; oyunlar Apple Silicon native Wine altında çalışır.

---

## 5. Platforma Özgü Yüzeylerin Eşlenmesi

| Windows Özelliği | Linux Karşılığı | macOS Karşılığı |
|---|---|---|
| Registry EGL/launcher taraması | `legendary` config + `~/.steam` taraması | CrossOver bottle / `~/Library` taraması |
| Win32 F12 klavye kancası | XDG Desktop Portal `GlobalShortcuts` veya `evdev` | `screencapture` + global hotkey (CGEventTap) |
| Native child webview mağaza | Tauri child webview (WebKitGTK) | Tauri child webview (WKWebView) |
| `explorer` / `.lnk` kısayolu | `xdg-open`, `.desktop` dosyası | `open`, `.app`/alias |
| `link2ea://`, `uplay://` | Wine registry handler veya native launcher | CrossOver bottle handler |
| Sürücü harfleri | `lsblk` / mount noktaları | `/Volumes` taraması |
| `--max-workers`, `--max-shared-memory` | Aynı legendary bayrakları geçerli | Aynı legendary bayrakları geçerli |

---

## 6. Fazlı Uygulama Planı

| Faz | Kapsam | Çıktı | Durum |
|---|---|---|---|
| **F0** | `platform/` soyutlaması + `cfg` iskeleti; Windows davranışı birebir korunur. | Derleme her 3 platformda yeşil. | `cfg` modülleri ve Unix stub'ları ile uygulandı. |
| **F1** | Linux'ta `legendary` + saf Wine ile oyun başlatma; prefix yönetimi; `xdg-open`. | Linux'ta temel kütüphane/oyun. | Uygulandı; donanım doğrulaması açık. |
| **F2** | Wine Manager (GE-Proton/Wine-GE indirme), DXVK/VKD3D otomatik kurulum, umu entegrasyonu. | Heroic seviyesi Linux deneyimi. | Araç yöneticisi ve katman kopyalama uygulandı. |
| **F3** | ProtonDB rozetleri, Gamescope/GameMode, Flatpak + AppImage paketleme. | Steam Deck uyumlu dağıtım. | ProtonDB/Deck rozetleri var; paketleme açık. |
| **F4** | macOS Apple Silicon: GPTK/DXMT runner yönetimi, CrossOver bottle desteği. | macOS'ta oyun başlatma. | Araç zinciri uygulandı; imzalama ve donanım doğrulaması açık. |
| **F5** | Platformlar arası ekran görüntüsü kancası ve kabuk entegrasyonları. | Özellik paritesi. | Windows'ta çalışıyor; diğer platformlarda gizleniyor. |

---

## 7. Riskler & Kısıtlar

- **Anticheat:** Kernel seviyesi anticheat (EAC/BattlEye) Wine/Proton altında çoğu oyunda
  çalışmaz; kullanıcı bilgilendirilmelidir.
- **Apple lisansı:** GPTK/D3DMetal ticari yeniden dağıtıma kapalıdır; launcher yalnızca
  kullanıcının kendi kurulumunu yönetir, binary'yi paketlemez.
- **Performans hedefi korunur:** Wine/Proton çevirisi CPU/GPU yükü ekler; arayüz tarafındaki
  düşük kaynak/120 FPS disiplini (AGENTS.md) platformdan bağımsız olarak aynen geçerlidir.
- **legendary fork:** Heroic kendi fork'unu kullanır; upstream sürümüyle uyumluluk izlenmelidir.

---

## 8. Uygulanan ilk katman (2026-10-19)

Bu bölüm tasarımın hangi parçalarının kodda olduğunu söyler; Linux/macOS
paketinin çıktığı anlamına gelmez.

### 8.1 Platforma göre mağaza CLI'ları
- `legendary/paths.rs` ve `gogdl/paths.rs` artık işletim sistemi + mimariye göre
  doğru release asset'ini seçiyor (Windows x64/ARM64, Linux x64/ARM64, macOS
  x64/ARM64). İndirilen dosya Unix'te çalıştırılabilir işaretleniyor.
- Unix'te kullanıcının kendi kurduğu `legendary` (PATH, `~/.local/bin`,
  `/usr/local/bin`, Homebrew) bulunursa indirme atlanır. Sürüm `legendary -V`
  ile doğrulanır; bozuksa indirilen kopya kullanılır. Bu, GitHub erişimi
  kapalıyken veya dağıtım paketi zaten legendary getiriyorsa devreye girer.
- Nile ve Comet zaten tüm platformlar için pinlenmiş asset'lere sahipti; davranış
  değişmedi.

### 8.2 Uyumluluk araç yöneticisi
`src-tauri/src/compat/` üç işe ayrıldı:

| Dosya | İş |
|---|---|
| `catalog.rs` | 16 araçlık katalog, platform/asset eşlemesi, arşiv türü |
| `install.rs` | GitHub sürüm kontrolü (6 saat önbellek), indirme, SHA-256, arşiv açma, klasör kaydı, kaldırma, IPC |
| `launch.rs` | Wine/Proton/umu wrapper'ı, `WINEPREFIX`, `STEAM_COMPAT_*`, `PROTONPATH`, `GAMEID`, `STORE` |

- Araçlar `<app_data>/compat/<os>-<arch>/<tool>/<tag>` altına iner; her kurulum
  `manifest.json` taşır. `.tar.gz`, `.tar.xz`, `.tar.zst`, `.tar` ve düz dosya
  destekleniyor. Arşiv yolları `..`/kök dizin kontrolünden geçiyor.
- GitHub asset'inin `digest` alanı varsa SHA-256 doğrulanır; ayrıca indirilen
  boyut ilan edilen boyutla karşılaştırılır.
- Yarım kalan indirmeler `.part` olarak saklanır ve sonraki denemede HTTP Range
  ile kaldığı yerden sürer; tamamlanmış parça yeniden indirilmeden doğrulanıp
  kullanılır. Sunucu Range'i yok sayarsa baştan başlanır. Araç kaldırılınca
  yarım parçalar da silinir.
- Büyük indirmeler `compat-progress` olayıyla yüzde/indirme bilgisi yayınlar,
  iptal edilebilir. Aynı araç için ikinci indirme reddedilir.
- Windows'tan `linux-x86_64`, `linux-aarch64`, `macos-x86_64` veya
  `macos-aarch64` hedefi seçilebilir; bu, paketleme öncesi araç ağacını
  hazırlamak için. Başlatma her zaman çalışan platformun ağacını kullanır.

### 8.3 Başlatma zinciri
- Epic: `legendary launch --wrapper "<runner> [run]"` + ortam değişkenleri.
- GOG: oyun exe'si seçilen wrapper'ın arkasından başlatılır.
- Amazon: `nile launch --no-wine --wrapper "<runner> [run]"` + ortam.
- Öncelik: oyunun kendi `wrapper` ayarı → uyumluluk yöneticisinin seçimi →
  (Windows'ta) Epic relay. umu-launcher kuruluysa ve açıksa Proton yerine o
  kullanılır. Varsayılan olarak her oyun `<prefix>/<appName>` altında kendi
  prefix'ini alır; oyun sayfasından tam bir klasör seçilirse o kullanılır.
- DXVK ve VKD3D-Proton, Compatibility sayfasından açılırsa gerçek Wine prefix'ine
  bir kez kopyalanır (`system32`/`syswow64`) ve `WINEDLLOVERRIDES` başlatmada
  ayarlanır. Proton prefix'i `compatdata/pfx` içinde tuttuğu için kopyalama
  oraya yapılır; düz Wine ve umu kökü kullanır. Prefix henüz `wineboot`
  tarafından kurulmadıysa (`system.reg` yok) katmanlar o açılışta yazılmaz,
  böylece Proton'un ilk kurulumu DLL'leri ezmez; katmanlar sonraki açılışta
  uygulanır. Varsayılan kapalıdır; oyun başına `env_vars` ile ezilebilir.
- Açık bir seçim yoksa launcher önce kendi indirdiği, sonra sistemde bulduğu ilk
  çalıştırıcıyı (Steam `compatibilitytools.d`, Lutris, sistem Wine) kullanır.
  "Kapalı" seçimi artık gerçekten kapalıdır: `compat_runner_enabled = false`,
  açık bir oyun istisnası yoksa başlatma wrapper'ını tamamen atlar.
  umu-launcher da yalnız launcher'ın indirdiği kopyadan değil, sistemde bulunan
  `umu-run` üzerinden de çalışabilir.
- Oyun sayfasının Sistem sekmesinde o oyuna özel bir çalıştırıcı, DXVK/VKD3D
  anahtarları ve tam prefix klasörü seçilebilir; seçim
  `<app_data>/compat/games.json` içinde tutulur ve genel ayarı yalnız o oyun
  için ezer. Açık bir oyun seçimi global kapalı anahtarını da aşar; böylece tek
  bir oyun için uyumluluk açık bırakılabilir. Katman seçimi genel seçimle aynı
  hale gelince kayıt silinir ve oyun yine genel ayarı devralır. Prefix alanı
  boşsa genel kök ve oyun adı kullanılır; doluysa klasör olduğu gibi alınır,
  böylece Steam `compatdata` gibi var olan bir prefix yeniden kullanılabilir.
  "Aç" düğmesi oyunun prefix'ini dosya yöneticisinde açar; prefix kurulmuşsa
  Proton'un gerçek `pfx` klasörü, değilse compatdata kökü açılır. Aynı satırdaki
  durum yazısı prefix'in hazır olup olmadığını gösterir. "Tanılamayı kopyala"
  düğmesi çalıştırıcı, prefix, Wine kökü ve katman yollarını kimlik bilgisi
  içermeyen düz metin olarak panoya verir; Linux/macOS hata bildirimleri için.
  Settings → Uyumluluk sayfasındaki "Tanılamayı kopyala" düğmesi de platform,
  hedef, araç klasörü, yönetilen sürümler, algılanan sistem çalıştırıcıları ve
  başlatma ayarlarını aynı biçimde kopyalar.
- Oyun sayfasındaki "Prefix'i hazırla" düğmesi `compat_prepare_prefix`
  komutunu çağırır: seçili çalıştırıcıyla `wineboot -u` çalışır, ilerleme
  `compat-prefix-progress` olayıyla gelir, 180 saniyede zaman aşımına uğrar ve
  sonra katmanları gerçek prefix'e kopyalar. Aynı hazırlık, katman açık bir oyun
  normal yoldan başlatılırken de oyun başlamadan önce çalışır; böylece ilk
  açılış katmanları alır. Katman yoksa bu bekleme atlanır, Wine/Proton prefix'i
  normal açılışta kurar. Bir hazırlık hatası oyunu engellemez; sonraki açılış
  yeniden dener. Başlatma bildirimi hazırlık boyunca açık kalır ve geçen
  saniyeleri gösterir; hata olursa yeniden "Başlatılıyor…" metnine döner.
- Windows'ta `launch_spec` ve `compat_prepare_prefix` başlatma yapmaz; mevcut
  Windows yolu birebir korunur ve hazırlama komutu açık bir hata döndürür.

Steam oyun sayfasının "bu bilgisayardaki kopya" kartında ProtonDB topluluk
derecesi görünür (Steam uygulama kimliğiyle). Yanıt uygulama başına bir gün
diskte cache'lenir; ağ hatasında eski kopya, o da yoksa satır hiç gösterilmez.
Satır ProtonDB sayfasına gider. Aynı kartta Are We Anti-Cheat Yet? durumu da
görünür: tek `games.json` dosyası günde bir kez indirilip uygulama kimliğine
göre aranıyor; durum, hile koruması adları ve oyun sayfası bağlantısı gösteriliyor.
Steam kimliğinin yanı sıra Epic katalog ad alanı (`storeIds.epic.namespace`)
eşleşen 73 oyun da kapsanıyor. Kayıt yoksa veya kaynak ulaşılamıyorsa satır
gizli kalıyor. Valve'nin kendi Steam
Deck uyumluluk raporu da aynı kartta gösteriliyor: `resolved_category` 1
desteklenmiyor, 2 oynanabilir, 3 doğrulanmış anlamına geliyor; yanıt uygulama
başına günlük cache'leniyor.

### 8.4 Arayüz
Settings → Uyumluluk: hedef platform seçici, mağaza CLI'ları, çalıştırıcılar,
çalışma zamanları, çeviri katmanları ve yardımcılar; sürüm/boyut, kurulu sürüm,
sistemde bulunan kopyalar, indir/kaldır/güncelle ve canlı ilerleme. Altta bu
bilgisayar için varsayılan çalıştırıcı, sürüm, prefix klasörü ve umu anahtarı.
Çalıştırıcı listesi launcher'ın indirdiği sürümlerin yanında Steam
`compatibilitytools.d`, Lutris ve sistem Wine kopyalarını da gösterir; seçilen
klasör `compat_runner_path` olarak saklanır ve başlatmada launcher'ın kendi
kopyasından önce gelir. Sayfa ayrıca araç klasörünün gerçek boyutunu gösterir ve
yarım kalan indirme/extraction parçalarını tek düğmeyle temizler.

### 8.5 Kalan işler
- Flatpak/AppImage/.deb/.rpm paketleme ve macOS `.app`/notarization.
- GPTK/D3DMetal lisansı: binary paketlenmez, kullanıcı kendi kurulumunu yönetir.
- Linux/macOS'ta gerçek donanım doğrulaması: oyun başlatma, Proton prefix'i,
  Steam kütüphanesi ve mağaza webview'leri.
- macOS'ta imzalama/notarization ve Apple Silicon native runner doğrulaması.
  Overlay'in saydam penceresi `macos-private-api` özelliğini kullanır; bu özel
  API Mac App Store dağıtımını engeller, doğrudan indirme etkilenmez.
- Steam `compatdata` ağacındaki prefix'ler kayıt algılamaya dahil değil; Steam
  Proton'uyla başlatılan bir oyunun klasörü Manage'den seçilmeli.
- Ekran görüntüsü kancası, klip kaydı, FPS/HUD ve görev çubuğu rozeti için
  platform implementasyonları (bugün Windows'ta çalışır, diğerlerinde gizlenir).
- `wine-crossover` yalnızca algılanır (Gcenx/winecx deposu 404); `vulkan-helper-rs`
  kaynak-only olduğu için indirilmez.

### 8.6 Windows dışındaki bugünkü davranış

Bu bölüm kodun Linux/macOS'ta ne yaptığını söyler; paket çıktığı anlamına gelmez.

- **Mağaza CLI'ları:** `legendary`, `gogdl`, Nile ve Comet işletim sistemi +
  mimariye göre indirilir; Unix'te `0o755` izni verilir. Unix'te sistemde kurulu
  bir `legendary` varsa önce o denenir. Eksik platform için indirme, çalıştırma
  yerine açık hata döndürür.
- **Oyun başlatma:** Epic, GOG, Amazon ve özel oyunlar `compat::launch_spec`
  üzerinden Wine/Proton/umu wrapper'ına verilir. Windows'ta wrapper atlanır.
- **Süreç takibi:** Linux/macOS'ta `sysinfo` ile kurulum klasörü/EXE adı
  eşleştirilir; GOG ve Steam PID kontrolleri `kill -0` kullanır. Bu, oyun
  oturumu ve overlay bağlamının Windows'suz çalışması içindir.
- **Dosya seçiciler:** Linux'ta `zenity`/`kdialog`, macOS'ta `osascript`; yoksa
  mevcut değer korunur. Windows PowerShell seçicisi değişmedi.
- **Steam:** Kayıt defteri yerine `~/.steam/steam`, `~/.local/share/Steam`,
  Flatpak (`~/.var/app/com.valvesoftware.Steam/...`), Snap
  (`~/snap/steam/...`) ve `~/Library/Application Support/Steam` aranır.
  `steam.pid` hem istemci klasöründe hem bir üst dizinde okunur; dosya yoksa
  süreç adına bakılır. `steam://` açma `xdg-open` / `open` ile yapılır.
- **Overlay:** Panel Tauri webview olarak açılır; launcher açıldığından itibaren
  üst çubuktaki düğme ve tepsi menüsüyle kullanılabilir. Shift+Tab global
  kısayolu, HUD/FPS katmanı, ekran görüntüsü ve klip sekmeleri Windows'a özgüdür.
  Linux/macOS'ta bu sekmeler gizlenir; panel, performans, notlar, başarımlar,
  tarayıcı sayfaları açılır. Spotify sekmesi (`librespot` Connect alıcısı) ve
  Discord sosyal sekmesi (Social SDK / RPC) Windows'a özgü olduğu için Unix'te
  gizlenir; Spotify web oynatıcısı ve Discord web istemcisi launcher
  sayfalarında çalışmaya devam eder. Müzik kartı ve sekme kısayolları da
  yalnızca Windows'ta çizilir.
- **Mağaza webview'leri:** Tauri child webview kullanılır. WebView2'ye özgü
  Chrome eklentisi katmanı Windows'ta açılır; diğer platformlarda mağaza sayfası
  eklentisiz açılır, para birimi betiği çalışmaya devam eder.
- **Windows'a özgü ve gizlenen yüzeyler:** Controller bridge (ViGEm), görev
  çubuğu rozeti, EOS/Epic relay, `.lnk` kısayolları, kayıt defteri taramaları ve
  sürücü harfi hedefi kuran oyun taşıma. Unix'te taşıma düğmesi gizlenir;
  `get_system_drives` gerçek bağlama noktalarını ve kapasitelerini döndürür.
- **Steam oturumu:** Windows token'ı DPAPI ile mühürler. Unix'te DPAPI yok; token
  `0600` izinli dosyaya düz yazılır ve yalnız geçerli kullanıcı okuyabilir.
  Anahtar zinciri (Secret Service / Keychain) açık iş olarak TODO.md'de.
- **Kayıt klasörü:** `detect_save_path` platforma göre arar. Linux'ta
  `$XDG_DATA_HOME` (varsayılan `~/.local/share`), `~/.config/unity3d`,
  `~/Documents`, `~/Saved Games`; macOS'ta bunlara ek olarak
  `~/Library/Application Support`. Ardından `~/Games/Efxlve/Prefixes` altındaki
  her prefix'in `pfx/drive_c/users/<user>/` ağacında `AppData/Local`,
  `AppData/LocalLow`, `Documents` ve `Saved Games` taranır. Steam'in kendi
  `compatdata` ağacı taranmaz; Steam Proton'uyla başlatılan oyun için klasör
  Manage'den seçilir.

## 9. Referanslar

- Heroic Games Launcher — https://heroicgameslauncher.com (GPL-3.0)
- GE-Proton — https://github.com/GloriousEggroll/proton-ge-custom
- umu-launcher — https://github.com/Open-Wine-Components/umu-launcher
- DXVK — https://github.com/doitsujin/dxvk
- VKD3D-Proton — https://github.com/HansKristian-Work/vkd3d-proton
- Apple Game Porting Toolkit — https://developer.apple.com/games/game-porting-toolkit
- Gcenx GPTK build — https://github.com/Gcenx/game-porting-toolkit
- ProtonDB — https://www.protondb.com

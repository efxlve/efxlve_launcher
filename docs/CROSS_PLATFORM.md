# CROSS_PLATFORM.md — Efxlve Launcher Linux & macOS Uyumluluk Katmanı (Araştırma & Mimari Tasarım)

> **Durum:** 📐 TASARIM (Milestone 8). Bu belge uygulama planı değil, mimari yol haritasıdır.
> **Amaç:** Heroic Games Launcher modelini referans alarak Efxlve Launcher'ın Windows dışına
> taşınma stratejisini, Wine/Proton/D3DMetal katmanlarını ve platform soyutlamasını tanımlamak.

---

## 1. Neden Mümkün? (Mevcut Mimarinin Getirdiği Avantaj)

Efxlve Launcher zaten iki büyük taşınabilirlik avantajına sahiptir:

1. **`legendary` CLI platformdan bağımsızdır.** Epic kimlik doğrulama, katalog, manifest,
   indirme ve bulut kayıt işlemleri Python tabanlı `legendary` ile yürütülür; Linux/macOS
   için resmi binary mevcuttur. Rust backend yalnızca süreç sarıcıdır (`client.rs`,
   `transfers.rs`), dolayısıyla bu katman büyük ölçüde yeniden kullanılabilir.
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

| Faz | Kapsam | Çıktı |
|---|---|---|
| **F0** | `platform/` soyutlaması + `cfg` iskeleti; Windows davranışı birebir korunur. | Derleme her 3 platformda yeşil. |
| **F1** | Linux'ta `legendary` + saf Wine ile oyun başlatma; prefix yönetimi; `xdg-open`. | Linux'ta temel kütüphane/oyun. |
| **F2** | Wine Manager (GE-Proton/Wine-GE indirme), DXVK/VKD3D otomatik kurulum, umu entegrasyonu. | Heroic seviyesi Linux deneyimi. |
| **F3** | ProtonDB rozetleri, Gamescope/GameMode, Flatpak + AppImage paketleme. | Steam Deck uyumlu dağıtım. |
| **F4** | macOS Apple Silicon: GPTK/DXMT runner yönetimi, CrossOver bottle desteği. | macOS'ta oyun başlatma. |
| **F5** | Platformlar arası ekran görüntüsü kancası ve kabuk entegrasyonları. | Özellik paritesi. |

---

## 7. Riskler & Kısıtlar

- **Anticheat:** Kernel seviyesi anticheat (EAC/BattlEye) Wine/Proton altında çoğu oyunda
  çalışmaz; kullanıcı bilgilendirilmelidir.
- **Apple lisansı:** GPTK/D3DMetal ticari yeniden dağıtıma kapalıdır; launcher yalnızca
  kullanıcının kendi kurulumunu yönetir, binary'yi paketlemez.
- **Performans hedefi korunur:** Wine/Proton çevirisi CPU/GPU yükü ekler; arayüz tarafındaki
  düşük kaynak/120 FPS disiplini (AGENTS.md §4.1) platformdan bağımsız olarak aynen geçerlidir.
- **legendary fork:** Heroic kendi fork'unu kullanır; upstream sürümüyle uyumluluk izlenmelidir.

---

## 8. Referanslar

- Heroic Games Launcher — https://heroicgameslauncher.com (GPL-3.0)
- GE-Proton — https://github.com/GloriousEggroll/proton-ge-custom
- umu-launcher — https://github.com/Open-Wine-Components/umu-launcher
- DXVK — https://github.com/doitsujin/dxvk
- VKD3D-Proton — https://github.com/HansKristian-Work/vkd3d-proton
- Apple Game Porting Toolkit — https://developer.apple.com/games/game-porting-toolkit
- Gcenx GPTK build — https://github.com/Gcenx/game-porting-toolkit
- ProtonDB — https://www.protondb.com

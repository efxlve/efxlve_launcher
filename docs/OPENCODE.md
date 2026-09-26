# Efxlve — kısa kurallar

OpenCode bu dosyayı ve `docs/OPENCODE_MAP.md` dosyasını kök `opencode.jsonc` içindeki `instructions` ile her oturuma ekler. Kaynak gerçek `AGENTS.md` §1–7 ve `docs/DESIGN_SYSTEM.md`. `AGENTS.md` §9 geçmiş kayıttır; oradan tasarım veya davranış çıkarma. Çelişkide bu dosya, harita ve `docs/DESIGN_SYSTEM.md` geçerlidir.

`AGENTS.md` §4.3’teki “iş bitince commit at” satırı bu oturumlarda geçersizdir. Commit yalnızca kullanıcı açıkça isterse.

## Şimdi (0.1.12)

Sürüm repoda **0.1.12** (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`).

- **0.1.12** (`v0.1.12`): kütüphanede isteğe bağlı sayfalama (24/48/96) ve kapak altı oyun adı; ekran görüntüsü klasörü seçilebilir, değiştirirken mevcut görüntüler onayla taşınır, "Klasörü aç" düğmesi; görsel sıkıştırma varsayılan açık (AVIF, destek yoksa WebP).
- **0.1.10:** çoklu oyun gizleme, başarım satırı gizleme, başarım başlığı = kütüphane oyun adı, kütüphanede Yüklü filtresi, Ayarlar’da gizli oyunlar (kapak, geliştirici, Detay, Seçilenleri göster; satır yalnızca seçer).
- **0.1.11** (`bc7d6cc`, etiket `v0.1.11`): EOS zorunlu; resmi kurucu Ayarlar’dan açılır; bildirimde Yoksay yok; zil, EOS kurulana kadar amber nokta; SteamGridDB kart boşluğu düzeltildi; indirme devamı kısmi dosyayı tutar; mağaza araması child webview’ı kenara alır, kapanışta bir kez geri getirir. Kurucu: `Efxlve.Launcher_0.1.11_x64-setup.exe`. `latest.json` buna bakar. `tauri dev` kendini güncellemez. MSI’yi yok say.

## İlk kurulum

Bunlar bu deponun dışında, bir kez yapılır. API anahtarını bu repoya yazma.

1. OpenCode 1.18 veya üstünü kur. DeepSeek sağlayıcısı yerleşiktir.
2. `opencode` aç. `/connect` → DeepSeek → API anahtarını yapıştır. Anahtar `~/.local/share/opencode/auth.json` içine yazılır. İstersen kullanıcı ortam değişkeni `DEEPSEEK_API_KEY` kullan. Değeri buraya koyma.
3. İsteğe bağlı global paket (orchestrator, skill, izinler): `https://github.com/znlgis/my-opencode-deepseek-config` deposunu klonla, kökünden `.\scripts\sync-config.ps1` çalıştır. Kopya `%USERPROFILE%\.config\opencode` altına gider.
4. Bu depoda `OPENCODE_CONFIG_DIR` tanımlama. O klasör en son yüklenir ve buradaki Flash ajanlarını ezer.
5. Bu depoda `opencode` aç. Model `deepseek/deepseek-flash` olmalı. Paketin varsayılanı Pro’dur; bu projenin config’i onu ezer.
6. Paket, arka plan alt ajan için `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` ister. Bu projede şart değil. Kapalıysa alt ajanı önde çalıştır.

## Düzenlemeden önce

1. Dosyayı `docs/OPENCODE_MAP.md` ile bul. Tahmin etme.
2. O dosyayı ve çağıranını oku.
3. `AGENTS.md` §9’dan tasarım alma. Tasarım `docs/DESIGN_SYSTEM.md` içindedir.
4. Dört büyük dosyaya satır ekleme: `click-router.ts`, `commands.rs`, `transfers.rs`, `main.rs`.
5. JS `invoke` argümanı camelCase.
6. Kütüphane ilerlemesinde `innerHTML` yok. Kartı yama.
7. Yeni çeviri anahtarını 15 dil dosyasına birden yaz.
8. Kod yorumu İngilizce.
9. Bitince `npm.cmd run build`. Rust değiştiyse `cargo test`.
10. Commit, push ve tag yok. Kullanıcı istemedikçe.

## Çalıştırma ve git

- Windows x86_64, Tauri 2 launcher.
- PowerShell’de `npm.cmd` kullan. `npm` kullanma.
- Komutları depo kökünden çalıştır: `C:\Users\Efe\Desktop\efxlve_launcher`.
- Frontend: `npm.cmd run build`. Rust: `cargo check`, mantık değişince `cargo test`. PATH bayatsa `$env:USERPROFILE\.cargo\bin` ekle.
- `git config` değiştirme. Force-push yok. Geçmişi yeniden yazma (`reset --hard`, rebase, amend yok).
- Commit, push ve tag yalnızca kullanıcı açıkça isterse.
- Secret, `dist/`, `src-tauri/target/` commit etme.

## Tasarım

- Hydra: gerçek siyah `#000`, tek vurgu beyaz. Token yalnızca `docs/DESIGN_SYSTEM.md` ve `src/styles/tokens.css`.
- PS5, Apple, Xbox veya App Store klonu yapma. Yeni sınıf adına `ps5-` / `apple-` / `xbox-` koyma.
- Arayüzde işletim sistemi emojisi yok. Gradyan, glow, `backdrop-filter`, `999px` hap yok.
- `window.confirm` yok. Onay launcher penceresinde.
- Hız, yüzde, süre ve sayaçta `font-variant-numeric: tabular-nums`.

## Performans

- Taban donanım: 8 GB RAM, eski i5, entegre GPU, HDD, yavaş ağ.
- Boşta `requestAnimationFrame`, polling veya süren CSS animasyonu bırakma.
- İlerleme, indirme veya durum olayında kütüphaneyi `innerHTML` ile yeniden çizme. Kartı yerinde yama (`patchLibraryCardDom`).
- Kütüphane aramasında `.find()` / `.some()` yok. `epicSummariesMap` ve `epicGamesRawMap` ile O(1).
- Kapaklar tembel ve parça parça (ilk 48, sonra 36). Ağ isteği arayüzü kilitlemez.
- Kaynak dosya ~1500 satırı geçmesin. `src/features/events/click-router.ts`, `src-tauri/src/legendary/commands.rs`, `src-tauri/src/legendary/transfers.rs`, `src-tauri/src/main.rs` zaten üstünde; bu dosyaları büyütme, yeni kodu ayrı modüle yaz. `core` `features` import etmez.

## Tauri, legendary, mağaza

- JS `invoke` argümanları camelCase (`appName`, `installDir`).
- legendary JSON stdout’tadır. İlerleme (`Progress`, `Downloaded`) stderr’dedir.
- Oturum kontrolü `user.json` iledir. Bunun için `list` çalıştırma.
- Yardımcı süreçlerde `CREATE_NO_WINDOW`. EOS kurucusunun kendi penceresi görünür kalır.
- Mağaza native child webview’dır, iframe değil. `z-index` onu örtmez. Arama webview’ı kenara alır; arama bir kez kapanınca mağaza bir kez geri gelir.

## İndirme

- Kısmi klasörü yalnızca hiç kurulmamış bir oyunun açık iptali siler.
- Çökme, hata, zaman aşımı, duraklatma ve launcher’ın yeniden açılması aynı klasörden devam eder. Devam kaydını silme.

## EOS

- Epic Online Services zorunludur. Yoksa açılış bildirimi (Yoksay yok), Ayarlar’dan resmi kurucu, kenar çubuğu zilinde amber nokta. Liste temizlense de uyarı EOS kurulana kadar geri gelir.
- EOS yok diye uygulamayı tamamen kilitleme.

## Gizleme ve başarımlar

- Gizli oyun satırına tıklamak satırı seçer. Oyun sayfasını yalnızca Detay açar.
- Başarım başlığı kütüphanedeki oyun adıdır. Content, Artbook veya benzeri sonek ekleme.

## Geri getirme

- `egl-sync --export-only` ekleme.
- Rockstar oyununu `Play*.exe` ile doğrudan başlatma. Epic kaydı varsa başlatma Epic üzerinden gider.
- TV Modu yayınlanmadı (coming soon). Varmış gibi yazma veya genişletme.

## Sürüm

Sürüm artırırken yalnızca şunları değiştir: `package.json`, `package-lock.json` (kökteki iki `version` alanı), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` içinde yalnızca `efxlve-launcher` paketi. Kullanıcı istemeden sürüm artırma.

## Dil

- `src/locales/` altındaki 15 dil dosyası anahtar eşliğinde kalsın. Anahtarı tek dile ekleme.
- Kod yorumları yalnızca İngilizce.

## Okuma

- Dosya haritası: `docs/OPENCODE_MAP.md` (bu turda da yüklü)
- Tasarım ve yasaklar: `docs/DESIGN_SYSTEM.md`
- Dosya boyutu ve `core` / `features` yönü: `docs/REFACTOR_PLAN.md` §1 ve §6.5
- Geçmiş gerekirse: `AGENTS.md` §9 ve `docs/CHANGELOG_INTERNAL.md`

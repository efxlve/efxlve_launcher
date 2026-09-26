# Efxlve — dosya haritası

Her turda yüklenir. Davranış kuralları `docs/OPENCODE.md`. Tasarım `docs/DESIGN_SYSTEM.md`. `AGENTS.md` §9 geçmiş kayıttır.

## Kod nerede

- `src/main.ts` — render, `scheduleRender`, `closeAllModals`, bootstrap. Büyütme.
- `src/core/` — durum, DOM, i18n, render bus, IPC sarmalayıcıları. `features` import etmez.
- `src/features/<ad>/` — ekranlar ve olaylar.
- `src/styles/` — görünüm. Renk ve yarıçap `tokens.css` içinden. Yeni buton stili yazma.
- `src/locales/` — 15 dosya, anahtarlar eş: `tr`, `en`, `de`, `es`, `fr`, `it`, `pl`, `pt-BR`, `ru`, `ar`, `ja`, `ko`, `th`, `zh-Hans`, `zh-Hant`. Motor `src/core/i18n.ts`.
- `src-tauri/src/main.rs` — pencere ve mağaza child webview (`store_bounds`). Büyütme.
- `src-tauri/src/eos.rs` — EOS tespiti ve kurucu.
- `src-tauri/src/legendary/` — Epic / legendary. `mod.rs` modül listesidir.

## Hata nereye

- Kütüphane ızgarası, filtre, gizleme: `src/features/library/` (`library-view.ts`, `hide-games.ts`).
- Oyun sayfası: `src/features/drawer/` (`drawer-view.ts`). Yönet penceresi: `src/features/manage/`.
- Ayarlar: `src/features/settings/settings-view.ts`.
- İndirme ekranı: `src/features/downloads/`. Kurulum diyaloğu: `src/features/install/`.
- İndirme süreci, devam, kısmi klasör: `src-tauri/src/legendary/transfers.rs` ve `download_resume.rs`. Bu iki dosyadan `transfers.rs` büyütülmez.
- Mağaza: `src/features/store/store-view.ts` ve `main.rs` içindeki `store_bounds`. Child webview’dır. `z-index` örtmez. Arama kenara alır; bir kapanış bir kez geri getirir.
- EOS: `src/features/eos/eos-install.ts` ve `src-tauri/src/eos.rs`. Kurucu penceresi görünür kalır.
- Çeviri: 15 locale JSON’un hepsi. Tek dile anahtar ekleme.
- Tıklama: `src/features/events/click-router.ts`. Büyütme. Yeni işi ilgili `features` modülüne yaz.
- IPC olayları: `src/features/events/ipc-listeners.ts`.
- Hesap değiştirme: `src/features/auth/`. Bildirim: `src/features/notifications/`. Launcher güncellemesi: `src/features/updates/`.

## Legendary

- `commands.rs` — IPC komutları. Büyütme.
- `transfers.rs` — indirme ve kuyruk. Büyütme.
- `download_resume.rs` — devam kaydı. Çökme, zaman aşımı, duraklatma ve yeniden açılış aynı klasörden sürer.
- `client.rs` — legendary süreci. `CREATE_NO_WINDOW`.
- `accounts.rs` — hesap kasası. `cache.rs` — disk önbelleği. Oturum `user.json`.

## İlk komut

PowerShell, depo kökü `C:\Users\Efe\Desktop\efxlve_launcher`:

- `npm.cmd run build`
- `cargo check`
- Mantık değişince `cargo test`
- `cargo` yoksa PATH’e `$env:USERPROFILE\.cargo\bin` ekle.

## Dokunma

- TV Modu yayınlanmadı. `src/features/gamepad/gamepad.ts` masaüstü kumanda ipucudur. TV modu diye genişletme.
- `egl-sync --export-only` çağırma.
- Rockstar `Play*.exe` sapını doğrudan açma. Epic kaydı varsa başlatma Epic üzerinden gider.

# GOG Entegrasyonu Canlı Geliştirme Durumu (AI Handover & Progress Tracker)

> **Son Güncelleme:** 2026-09-27
> **Aktif Faz:** Faz 0 (Altyapı & Tip Sistemi)
> **Amaç:** Token bitişi veya AI model değişimi durumunda görevi devralacak modelin kaldığı yeri tam olarak bilmesini ve sıfır kayıpla devam etmesini sağlamak.

---

## 1. Faz İlerleme Tablosu

| Faz | Tanım | Durum | Doğrulama |
|-----|-------|-------|-----------|
| **Faz 0** | Tip Sistemi, State & O(1) Seçiciler | ✅ Tamamlandı | `npm.cmd run build` (başarılı) |
| **Faz 1** | Rust `gogdl` Backend İskeleti & REST İstemcisi | ✅ Tamamlandı | `cargo check` + `cargo test` (107 test geçti) |
| **Faz 2** | GOG Auth & Accounts Sayfası | ✅ Tamamlandı | `npm.cmd run build` (başarılı) |
| **Faz 3** | Kütüphane Görünümü & Birleşik Render | ✅ Tamamlandı | `npm.cmd run build` (başarılı) |
| **Faz 4** | İndirme & Kurulum Yönetimi | ✅ Tamamlandı | `cargo check` + `npm.cmd run build` |
| **Faz 5** | Başlatma, Süre Takibi & Oyun Drawer'ı | 🔄 Sıradaki | `npm.cmd run build` |
| **Faz 6** | Sağ Tık, Toplu Gizleme & Koleksiyonlar | ⏳ Bekliyor | `npm.cmd run build` |
| **Faz 7** | Import, Repair & Kaldırma | ⏳ Bekliyor | `cargo check` |

---

## 2. Son Yapılan İşlemler Günlüğü

- [x] Detaylı mimari araştırma ve uygulama planı hazırlandı (`docs/GOG_SUPPORT_PLAN.md`).
- [x] Kütüphane, UI bileşenleri ve devir protokolü plana eklendi.
- [x] Faz 0: `src/core/types.ts` içine `GameSource`, `SourceFilter`, `GogPhase` ve `LibraryItem` eklendi.
- [x] Faz 0: `src/core/state.ts` içine GOG ve multi-source state alanları (`allGamesMap`, `gogSummaries` vb.) eklendi.
- [x] Faz 0: `src/core/selectors.ts` içine `epicToLibraryItem()`, `rebuildAllGamesMap()`, `libraryItemOf()`, `getAllLibraryItems()` ve `setGogSummaries()` eklendi.
- [x] Faz 0 doğrulaması: `npm.cmd run build` ve `cargo check` sıfır hata ile geçti.
- [x] Faz 1: `src-tauri/src/gogdl/` modülü oluşturuldu (`mod.rs`, `models.rs`, `paths.rs`, `cache.rs`, `api_client.rs`, `commands.rs`).
- [x] Faz 1: GOG Galaxy REST API istemcisi (`exchange_auth_code`, `refresh_tokens`, `get_user_profile`, `fetch_user_library`) eklendi.
- [x] Faz 1: `src-tauri/src/main.rs` içine `mod gogdl;` ve 6 yeni Tauri IPC komutu kaydedildi.
- [x] Faz 1: `src/gog.ts` frontend API barrel modülü eklendi.
- [x] Faz 1 doğrulaması: `cargo check` (0 warning), `cargo test` (107 test geçti), `npm.cmd run build` (başarılı).
- [x] Faz 2: `src/features/accounts/accounts-view.ts` içindeki `gogCard()` aktif kart ve giriş formuna dönüştürüldü.
- [x] Faz 2: `src/features/auth/gog-auth-actions.ts` oluşturuldu (`gogLoginWithCode`, `syncGogLibrary`, `gogLogoutAction`, `initGogSession`).
- [x] Faz 2: `src/features/events/click-router.ts` içine `gog-open-login`, `gog-do-login`, `gog-paste`, `gog-logout`, `gog-refresh` bağlandı.
- [x] Faz 2: `src/features/events/ipc-listeners.ts` içine açılışta oturum tespiti ve önbellekten hızlı kütüphane hidrasyonu (`initGogSession`) eklendi.
- [x] Faz 2: `tr.json` ve `en.json` dillerine tüm `gog.*` ve `source.*` metinleri eklendi.
- [x] Faz 2 doğrulaması: `npm.cmd run build` ve `cargo check` sıfır hata ile geçti.
- [x] Faz 3: `src/features/library/library-view.ts` içinde `studioOf`, `parseQuery`, `visibleSignature`, `epicVisibleSummaries` GOG oyunlarını birleştirdi.
- [x] Faz 3: Kütüphane kartlarına ve satırlarına `data-source` eklendi; araç çubuğuna `All | Epic | GOG` kaynak filtresi segmenti entegre edildi.
- [x] Faz 3: `syncLibraryHeadingCount` toplam oyun sayısını her iki mağaza toplamı olarak güncelledi.
- [x] Faz 3: `src/features/events/click-router.ts` içine `source-filter` click eylemi bağlandı.
- [x] Faz 3 doğrulaması: `npm.cmd run build` (başarılı).
- [x] Faz 4: `src-tauri/src/gogdl/paths.rs` içine `ensure_binary` (GitHub Releases üzerinden gogdl.exe otomatik indirme) ve `installed_json_path` eklendi.
- [x] Faz 4: `src-tauri/src/gogdl/cache.rs` içine gogdl uyumlu `46899977096215655` auth map yapısı ve `load_installed_games`/`save_installed_games` eklendi.
- [x] Faz 4: `src-tauri/src/gogdl/transfers.rs` oluşturuldu: `gogdl download` süreci, CRLF/CR stderr akışı parser (`= Progress:`, `ETA:`, `+ Download`, `+ Disk`), 250ms rAF-dostu IPC emit, iptal ve `goggame-<id>.info` tespiti ile yerel kayıt.
- [x] Faz 4: `src-tauri/src/gogdl/commands.rs` içinde `gog_cached_library` ve `gog_list_games` yerel kurulum durumlarını (`installed.json`) birleştirecek şekilde zenginleştirildi.
- [x] Faz 4: `src/core/selectors.ts` (`summaryOf`) ve `src/core/game-view.ts` (`patchLibraryCardDom`) GOG oyunları için tam destek kazandı.
- [x] Faz 4: `src/features/install/install-dialog.ts` ve `src/features/events/click-router.ts` GOG oyunlarını `gogInstallGame` ve `gogCancelDownload` komutlarına bağladı.
- [x] Faz 4 doğrulaması: `cargo check` (0 hata, 0 uyarı), `cargo test` (107 test geçti), `npm.cmd run build` (sıfır hata).

---

## 3. Devralan AI İçin Hızlı Başlangıç Notları

1. **Komutlar:**
   - Frontend tip kontrolü: `npm.cmd run build`
   - Rust tip kontrolü: `cargo check`
   - Dev ortamı: `npm.cmd run tauri dev`
2. **Kural Hatırlatıcısı:**
   - Asla `npm` değil, daima `npm.cmd`.
   - Asla emoji kullanma (`icon(...)` SVG kullan).
   - Kartlarda `contain: layout paint` koru.
   - İlerleme anında kütüphaneyi asla tam innerHTML ile çizme (`patchLibraryCardDom` kullan).
3. **Mevcut Git Dalı:** `main` (temiz working tree tutulmalı).

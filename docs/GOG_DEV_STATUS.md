# GOG Entegrasyonu Canlı Geliştirme Durumu (AI Handover & Progress Tracker)

> **Son Güncelleme:** 2026-09-27
> **Aktif Faz:** Faz 0 (Altyapı & Tip Sistemi)
> **Amaç:** Token bitişi veya AI model değişimi durumunda görevi devralacak modelin kaldığı yeri tam olarak bilmesini ve sıfır kayıpla devam etmesini sağlamak.

---

## 1. Faz İlerleme Tablosu

| Faz | Tanım | Durum | Doğrulama |
|-----|-------|-------|-----------|
| **Faz 0** | Tip Sistemi, State & O(1) Seçiciler | ✅ Tamamlandı | `npm.cmd run build` (başarılı) |
| **Faz 1** | Rust `gogdl` Backend İskeleti & REST İstemcisi | 🔄 Başlatılıyor | `cargo check` |
| **Faz 2** | GOG Auth & Accounts Sayfası | ⏳ Bekliyor | `npm.cmd run build` |
| **Faz 3** | Kütüphane Görünümü & Birleşik Render | ⏳ Bekliyor | `npm.cmd run build` |
| **Faz 4** | İndirme & Kurulum Yönetimi | ⏳ Bekliyor | `cargo check` + `npm.cmd run build` |
| **Faz 5** | Başlatma, Süre Takibi & Oyun Drawer'ı | ⏳ Bekliyor | `npm.cmd run build` |
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

# REFACTOR_PLAN.md — Efxlve Launcher Modularization Plan

> **Amaç / Purpose:** Projeyi AI ve insan geliştiricilerin rahatça okuyabileceği,
> küçük ve sorumluluğu tek olan modüllere bölmek.
> Split the project into small, single-responsibility modules that are easy for
> both AI agents and human reviewers (including external reviewers) to read.

---

## 1. Neden? / Why?

Eski yapı "her şey tek dosyada" idi:

| Dosya | Eski satır | Durum |
|---|---|---|
| `src/styles.css` | ~10.100 | ✅ 24 modüle bölündü (`src/styles/`) |
| `src/main.ts` | ~11.400 | 🚧 Faz 3'te bölünüyor |
| `src/epic.ts` | ~1.030 | ✅ Kabul edilebilir (barrel olarak korunuyor) |

**Kural / Rule:** Hiçbir kaynak dosya **~1.500 satırı** geçmemelidir. Geçiyorsa
sorumluluğu tek olan modüllere ayrılmalıdır.

---

## 2. Comment Convention / Yorum Standardı

All code comments must be **English-only** and explanatory. This keeps the
project readable for external reviewers (e.g. Epic Games staff) and for
contributors who do not speak Turkish. Existing Turkish comments are converted
to English as files are touched or refactored.

```ts
/**
 * Resolve the cached cover for a game, falling back to official key art.
 * Order: custom user cover -> SteamGrid cache -> Epic DieselGameBox.
 */
```

```ts
// Cache the value to avoid an O(n) lookup on every render.
```

**Forbidden:** Non-English, meaningless or copy-pasted comments.

---

## 3. Hedef Dizin Yapısı / Target Structure

```
src/
├── main.ts                     # Yalnızca bootstrap + init() (~<150 satır hedefi)
├── i18n.ts                     # Çeviri motoru (mevcut)
├── core/                       # Durum, IPC, yardımcılar (paylaşılan çekirdek)
│   ├── types.ts                # ✅ Alan tipleri
│   ├── constants.ts            # ✅ Sabitler + demo katalog
│   ├── utils.ts                # ✅ Saf biçimlendirme/temizleme
│   ├── icons.ts                # ✅ SVG ikon sistemi
│   ├── state.ts                # 🚧 Tek paylaşılan `AppState` nesnesi
│   ├── dom.ts                  # 🚧 viewEl, modalRoot, toasts... referansları
│   ├── ipc.ts                  # 🚧 Tauri olay dinleyicileri + invoke sarmalayıcıları
│   └── toast.ts                # 🚧 toast bildirimleri
├── features/
│   ├── library/                # Kütüphane: hero, raflar, grid, filtre
│   ├── drawer/                 # Oyun detay çekmecesi + sekmeler
│   ├── downloads/              # İndirme merkezi + kuyruk + hız grafiği
│   ├── profile/                # Profil & kupa merkezi
│   ├── settings/               # Ayarlar + 3. parti hub + dil
│   ├── store/                  # Gömülü mağaza webview köprüsü
│   ├── gamepad/                # Kontrolcü navigasyonu + HUD
│   ├── screenshots/            # Galeri + lightbox + paylaşım
│   ├── collections/            # Koleksiyon modalları
│   ├── move-game/              # Sürücüler arası taşıma
│   ├── dlc/                    # DLC yöneticisi + seçici kurulum
│   └── context-menu/           # Sağ tık menüsü
└── styles/                     # ✅ 24 modüler CSS dosyası + index.css
```

---

## 4. Durum Yönetimi Stratejisi / State Management

`main.ts`'in bölünememesinin tek nedeni, yüzlerce modül-düzeyi `let`/`const`
değişkeninin tek bir lexical scope'ta yaşamasıdır. Çözüm:

1. **Tek `AppState` nesnesi** (`src/core/state.ts`):
   ```ts
   export const S = {
     view: "library" as View,
     epicSummaries: [] as EpicSummary[],
     // ... tüm paylaşılan durum
   };
   ```
   Nesne olduğu için her modül `S.view = "downloads"` yapabilir (import edilen
   binding yeniden atanamaz; nesne alanı atanabilir).
2. **Erişimciler** durumu mantıksal gruplara ayırır: `S.library`, `S.downloads`,
   `S.profile`, `S.screenshots`... Böylece `S.downloads.queue` gibi okunur olur.
3. **O(1) harita'lar** (`epicSummariesMap`, `epicGamesRawMap`) state içinde tutulur;
   `summaryOf` / `rawOf` erişimcileri `core/state.ts`'ten export edilir.
4. **Döngüsel bağımlılık yok:** `features/*` → `core/*` tek yönlü akar.
   `core/*` hiçbir `features/*` modülünü import etmez.

**Kritik güvenlik notu:** Yeniden adlandırma mekanik olarak (regex) YAPILMAZ.
Her özellik tek tek taşınır, `npm.cmd run build` (tsc) yeşil olmadan sonraki
adıma geçilmez. Yerel değişken gölgelemesi (shadowing) her adımda elle kontrol edilir.

---

## 5. Fazlar / Phases

| Faz | Kapsam | Durum |
|---|---|---|
| **F1** | CSS'i 24 modüle böl (`src/styles/`). | ✅ Tamamlandı |
| **F2** | `core/types.ts`, `core/constants.ts`, `core/utils.ts`, `core/icons.ts` çıkar. | ✅ Tamamlandı |
| **F3a** | `core/state.ts` (tek `S` nesnesi) + `core/dom.ts` + `core/toast.ts`; `main.ts` referanslarını `S.*`'e taşı (bölüm bölüm, tsc doğrulamalı). | 🚧 Planlandı |
| **F3b** | `core/ipc.ts`: `listen(...)` olay kayıtları ve download-progress hedefli DOM güncellemeleri. | 🚧 Planlandı |
| **F4** | `features/context-menu`, `features/gamepad`, `features/screenshots` çıkar (durum sahipliği ile). | 🚧 Planlandı |
| **F5** | `features/library`, `features/drawer`, `features/downloads`, `features/profile`, `features/settings` çıkar. | 🚧 Planlandı |
| **F6** | `features/collections`, `features/move-game`, `features/dlc`, `features/store` çıkar; `main.ts` yalnızca bootstrap kalır. | 🚧 Planlandı |

---

## 6. Doğrulama / Verification (her fazda zorunlu)

```powershell
npm.cmd run build     # tsc --noEmit + vite build
cargo test            # Rust tarafı bozulmadı mı
```

- AGENTS.md kuralı: her faz sonunda `docs/CHANGELOG_INTERNAL.md`'ye özet + `git commit`.
- `AGENTS.md` §4.2 (ölü kod sıfır tolerans): taşıma sonrası eski tanımlar silinir.

---

## 7. Bilinen Riskler / Known Risks

- **Gölgeleme (shadowing):** `view`, `query`, `games`, `downloads` gibi isimler
  bazı fonksiyonlarda yerel değişken olabilir. `S.*` taşıması sırasında her
  kullanım elle doğrulanır; tsc + manuel gözden geçirme şarttır.
- **Circular imports:** `core` asla `features`'ı import etmez kuralı korunur.
- **Performans:** Refactor davranışı DEĞİŞTİRMEZ; O(1) harita'lar ve hedefli DOM
  mutasyonu disiplini (AGENTS.md §6) aynen korunur.

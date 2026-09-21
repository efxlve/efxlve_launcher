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
| **F3a** | `core/state.ts` (tek `S` nesnesi); `main.ts` referanslarını `S.*`'e taşı (TS dil servisi ile, tsc doğrulamalı). | ✅ Tamamlandı |
| **F3b** | `core/dom.ts` ✅ + `core/toast.ts` ✅ + `core/selectors.ts` ✅; `core/ipc.ts` (olay kayıtları) 🚧. | 🟡 Kısmi |
| **F4** | `features/context-menu` ✅, `features/dlc` ✅, `features/move-game` ✅ (view), `features/settings` ✅, `features/profile` ✅; `features/gamepad` 🚧, `features/screenshots` 🚧, `features/collections` 🚧. | 🟡 Devam ediyor |
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

## 6.5. Handoff / Current Status (Devir Teslim)

> Bu bölüm, farklı bir AI ajanı veya geliştirici devraldığında kaldığı yerden
> devam edebilmesi için güncel durumu özetler. **Her faz sonunda güncelle.**

**Son güncelleme:** Modülerleştirme Faz 5 (kısmi). Tüm işler commit'li, `npm.cmd run build` + `cargo check` yeşil. `main.ts` **11.422 → ~6.904 satır**.

**Tamamlanan yapı:**
```
src/
├── main.ts                 ~6.904 satır  (hedef: bootstrap + init)
├── i18n.ts                 15 dilli çeviri motoru
├── core/
│   ├── types.ts            Game, View, EpicPhase, EpicFilter/Sort/ViewMode, CardSize, DlMetrics
│   ├── constants.ts        isTauri, demo katalog, localStorage anahtarları, loadStrSet
│   ├── utils.ts            esc, fmt*, cleanDisplayVersion, formatScreenshotDate
│   ├── icons.ts            icon(), epicPlatinumIcon()
│   ├── state.ts            S (tek paylaşılan durum nesnesi)
│   ├── dom.ts              DOM kök referansları
│   ├── toast.ts            toast()
│   ├── selectors.ts        summaryOf, rawOf, epicWideArt, isTurkishUser, setEpicSummaries/Raw
│   ├── game-view.ts        isAppPlatinum, epicDlProgress, epicArt, epicActionButtons
│   └── render.ts           render bus (registerRender; main.ts kaydeder)
├── features/
│   ├── context-menu/context-menu.ts
│   ├── library/library-view.ts
│   ├── onboarding/onboarding-view.ts
│   ├── drawer/drawer-widgets.ts
│   ├── downloads/downloads-view.ts
│   ├── dlc/dlc-manager.ts
│   ├── move-game/move-game-view.ts
│   ├── settings/settings-view.ts
│   ├── profile/profile-view.ts
│   └── collections/collections-view.ts
├── styles/                 24 modül CSS + index.css
└── locales/                15 dil JSON
```

**`main.ts`'te kalan iş (öncelik sırasıyla):**
1. `features/drawer/` (kalan) — `openEpicModal`, `renderDrawerOverview/Dlcs/Screenshots/Manage/Achievements/SystemRequirements`, `fetchAndRenderScreenshots/Achievements/Requirements`, `updateCriticUI`, ekran görüntüsü lightbox/paylaşım. Bunlar lazy-load fetch'i tetiklediği için render+fetch birlikte taşınmalı; `openEpicModal` bağımlılıkları (updateGamepadHud, closeModal, ensureTabVisible) için callback/core'a taşıma gerekir.
2. `features/screenshots/` — galeri, lightbox, paylaşım/sıkıştırma (screenshot fonksiyonları).
3. `features/dlc/` (seçici kurulum) — `openSelectiveModal`, `applySelectiveInstall`, `renderSelectiveModal`.
4. `features/steamgrid/` + özel kapak modalı.
5. `features/gamepad/` — `gamepadLoop`, `handleGamepadDirectionalMove`, `updateGamepadHud`, `handleGamepadTabSwitch` (birçok main fonksiyonuna bağlı; en son).
6. `core/ipc.ts` — `listen(...)` kayıtları (download-progress, game-status, screenshot-captured, move-game-progress, verify-*, legendary-*).
7. **Olay delegasyonu router'ı** (~1.700 satır `document.addEventListener("click", ...)`) — `act → handler` kayıt defterine bölünmeli. En büyük kazanç ama en riskli adım.
8. `main.ts` yalnızca `init()` + bootstrap kalana kadar devam.

**Kanıtlanmış desen:** Yeni modül `import { S } from "../../core/state"` + `core/*` import eder; `core` asla `features`'ı import etmez (döngüsel bağımlılık yok). `render()`/`scheduleRender()` gerektiren modüller `core/render.ts`'ten import eder. Saf render fonksiyonları kolayca taşınır.

**Yöntem notu (F3a):** Durum taşıma, TypeScript dil servisi (`findReferences`) ile yapıldı; mekanik regex KULLANILMADI (yerel gölgeleme riski). Geçici betikler `%TEMP%\opencode\` altındaydı, repoda tutulmadı.

**DİKKAT (satır kayması):** Toplu kesim betikleri çalıştırılmadan önce hedef fonksiyon satır numaraları YENİDEN alınmalı (import eklemeleri numaraları kaydırır). Aksi hâlde fonksiyon gövdesi/başlığı yanlış kesilir ve `tsc` sözdizimi hatası verir; `git checkout -- src/main.ts` ile geri dönüp tekrar denenmelidir.

---

## 7. Bilinen Riskler / Known Risks

- **Gölgeleme (shadowing):** `view`, `query`, `games`, `downloads` gibi isimler
  bazı fonksiyonlarda yerel değişken olabilir. `S.*` taşıması sırasında her
  kullanım elle doğrulanır; tsc + manuel gözden geçirme şarttır.
- **Circular imports:** `core` asla `features`'ı import etmez kuralı korunur.
- **Performans:** Refactor davranışı DEĞİŞTİRMEZ; O(1) harita'lar ve hedefli DOM
  mutasyonu disiplini (AGENTS.md §6) aynen korunur.

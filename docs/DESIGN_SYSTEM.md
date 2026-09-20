# DESIGN_SYSTEM.md — PlayStation 5 Console Dark Design System

> **Primary Audience:** AI Agents, UI Engineers & Designers.  
> **Mission:** Transform Efxlve Launcher from an inconsistent, fragmented multi-page UI into a world-class, **PlayStation 5 Console Dark** desktop gaming interface that feels cohesive, tactile, and uncompromisingly professional.

---

## 1. Problem Statement: Why Does the Current UI Feel Inconsistent?

The launcher currently suffers from **visual fragmentation**:
1. **Divergent Page Shells:**  
   - *Settings* uses plain HTML headings (`<h2>Ayarlar</h2><p class="subtitle">`) and floating grey boxes (`.settings-box`).
   - *Profile* uses an ultra-cinematic PS5 hero scene with dynamic backdrops, custom avatar rings, and a 4-tier trophy counter.
   - *Downloads* opens with no page header at all, immediately dumping the user into an active hero card or canvas graph.
   - *Library* alternates between a huge Hero Spotlight, horizontal shelves, and a portrait poster grid.
2. **Conflicting Design Tokens:**  
   - Border radii are scattered without a scale: some elements use `4px`, others `6px`, `8px`, `10px`, `12px`, `14px`, `16px`, or full `999px` pills.
   - Accent colors fight each other: Indigo (`#6366f1`), Cyan (`#00e5ff`), Electric Blue (`#38bdf8`), Purple (`#a855f7`), and Green (`#10b981`) are used interchangeably for primary actions.
   - Button heights range haphazardly: `26px`, `30px`, `34px`, `38px`, `44px`.
3. **Lack of a Unified Component Library:**  
   - Cards, tabs, badges, inputs, and toggles are re-styled in ad-hoc CSS blocks throughout `styles.css` (10,500 lines) instead of consuming shared design tokens.

---

## 2. Core Design Philosophy

1. **PlayStation 5 Console Dark Aesthetic:**  
   - Pure obsidian & midnight navy backgrounds (`#07080d`, `#0b0d14`).
   - Layered surfaces using subtle brightness steps (`#0e1017` → `#151822` → `#1c202d`).
   - High-contrast, crystal-clear typography with crisp hierarchy.
2. **Strictly Anti-Generic AI Tropes:**  
   - **NO** purple-to-cyan decorative gradients.
   - **NO** blurry neon box-shadow glows around standard buttons or cards.
   - **NO** gradient text fills (`background-clip: text`).
   - **NO** turning every single badge into a `999px` oval capsule.
   - **NO** gratuitous micro-animations (e.g. shaking icons, pulsing elements).
3. **Purpose-Driven Color (State Only):**  
   - Color is never decoration; color communicates **state**:
     - **Accent / Interaction:** Electric Lavender / PlayStation Purple (`#8b5cf6`).
     - **Active / Success / Online:** Emerald Green (`#10b981`).
     - **Warning / Updating / Paused:** Warm Amber (`#f59e0b`).
     - **Destructive / Error / Cancel:** Crimson Red (`#ef4444`).
4. **10-Foot Console / Gamepad Ergonomics:**  
   - Every interactive element must be easily navigable via Gamepad (DualSense / Xbox).
   - Minimum click/focus target: `34x34px`.
   - Distinct, zero-latency `:focus-visible` ring.

---

## 3. Design Tokens Specification

### 3.1. Color & Elevation Surfaces

```css
:root {
  /* Canvas & Viewport */
  --ps5-bg: #07080d;               /* Deep Obsidian base */
  --ps5-bg-subtle: #0b0d14;        /* Secondary background */

  /* Surface Elevation Hierarchy */
  --ps5-surface-1: #0e1017;        /* Page content panels, large cards */
  --ps5-surface-2: #151822;        /* Inner cards, stat tiles, inputs */
  --ps5-surface-3: #1c202d;        /* Hovered elements, active pills */
  --ps5-surface-overlay: rgba(7, 8, 13, 0.88); /* Modal backdrop */

  /* Borders & Dividers */
  --ps5-border-subtle: rgba(255, 255, 255, 0.06);
  --ps5-border-default: rgba(255, 255, 255, 0.10);
  --ps5-border-focused: rgba(167, 139, 250, 0.50);

  /* Primary Interactive Accent */
  --ps5-accent: #8b5cf6;           /* Electric Lavender / PS Violet */
  --ps5-accent-hover: #9d75f7;
  --ps5-accent-active: #7c3aed;
  --ps5-accent-tint: rgba(139, 92, 246, 0.12);

  /* Semantic Status */
  --ps5-status-online: #10b981;
  --ps5-status-online-tint: rgba(16, 185, 129, 0.12);
  --ps5-status-warn: #f59e0b;
  --ps5-status-warn-tint: rgba(245, 158, 11, 0.12);
  --ps5-status-err: #ef4444;
  --ps5-status-err-tint: rgba(239, 68, 68, 0.12);

  /* Typography Colors */
  --ps5-text-primary: #ffffff;
  --ps5-text-secondary: #94a3b8;   /* Slate 400 */
  --ps5-text-muted: #64748b;       /* Slate 500 */
  --ps5-text-disabled: #475569;    /* Slate 600 */
}
```

### 3.2. Border Radius Scale

All components must strictly adhere to this 4-step radius scale. Arbitrary values (like `5px`, `7px`, `13px`, `22px`) are prohibited:

| Token | Value | Applied To |
|---|---|---|
| `--ps5-radius-sm` | `6px` | Badges, tags, tooltips, mini progress bars |
| `--ps5-radius-md` | `10px` | Standard buttons, icon buttons, text inputs, dropdowns |
| `--ps5-radius-lg` | `14px` | Game cards, stat tiles, settings boxes, drawer sections |
| `--ps5-radius-xl` | `20px` | Hero banners, dialog modals, full drawers |

### 3.3. Typography Scale

Font family: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.  
Numbers in stats, timers, and download metrics **must** use `font-variant-numeric: tabular-nums` to prevent layout jitter during updates.

| Token | Size | Weight | Line Height | Use Case |
|---|---|---|---|---|
| `--ps5-font-hero` | `28px` | `800` (Bold) | `1.2` | Hero game titles, level headline |
| `--ps5-font-title` | `22px` | `700` (Semi) | `1.3` | Standard page headers |
| `--ps5-font-section` | `16px` | `600` (Medium)| `1.4` | Shelf headers, box titles, modal tabs |
| `--ps5-font-body` | `13px` | `400` (Regular)| `1.5` | Descriptions, setting labels, game info |
| `--ps5-font-meta` | `12px` | `500` (Medium)| `1.4` | Card subtitles, badges, tags |
| `--ps5-font-caption`| `11px` | `400` (Regular)| `1.3` | Footers, fine print, ETA timestamps |

---

## 4. Standard Page Shell Pattern

To eliminate cross-page visual fragmentation, **every primary page (Library, Downloads, Profile, Settings)** must use the standardized page shell structure:

```html
<div class="ps5-page ps5-page-[page-name]">
  <!-- 1. Standard Page Header -->
  <header class="ps5-page-header">
    <div class="ps5-header-main">
      <div class="ps5-header-kicker">
        ${icon("settings", 14)} <span>SİSTEM YAPILANDIRMASI</span>
      </div>
      <h1 class="ps5-header-title">Ayarlar</h1>
      <p class="ps5-header-subtitle">
        Launcher davranışı, depolama konumları ve hesap tercihleri.
      </p>
    </div>

    <!-- Right-aligned action slot: search, filter pills, refresh, or primary CTA -->
    <div class="ps5-header-actions">
      <!-- Standardized actions -->
    </div>
  </header>

  <!-- 2. Standard Page Body -->
  <main class="ps5-page-body">
    <!-- Grid, Shelves, or Master-Detail content -->
  </main>
</div>
```

### CSS Specification for Header Shell:

```css
.ps5-page {
  padding: 32px 40px;
  max-width: 1680px;
  margin: 0 auto;
  min-height: calc(100vh - 64px);
}

.ps5-page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 28px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--ps5-border-subtle);
  gap: 24px;
}

.ps5-header-kicker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ps5-accent);
  margin-bottom: 6px;
}

.ps5-header-title {
  font-size: var(--ps5-font-title);
  font-weight: 800;
  color: var(--ps5-text-primary);
  margin: 0 0 4px 0;
  letter-spacing: -0.02em;
}

.ps5-header-subtitle {
  font-size: var(--ps5-font-body);
  color: var(--ps5-text-secondary);
  margin: 0;
  max-width: 600px;
}

.ps5-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
```

---

## 5. Component Standards & Blueprints

### 5.1. Button System

All buttons must strictly adhere to these 4 classes and fixed dimensions:

| Type | Class | Height | Background | Border | Text |
|---|---|---|---|---|---|
| **Primary Action** | `.ps5-btn.primary` | `38px` | `--ps5-accent` (`#8b5cf6`) | None | White, 600 weight |
| **Secondary / Ghost** | `.ps5-btn.secondary` | `38px` | `--ps5-surface-2` | `--ps5-border-default` | `--ps5-text-primary` |
| **Destructive** | `.ps5-btn.danger` | `38px` | `rgba(239, 68, 68, 0.12)` | `rgba(239, 68, 68, 0.3)` | `#ef4444` |
| **Squircle IconBtn** | `.ps5-btn-icon` | `36x36px` | `--ps5-surface-2` | `--ps5-border-default` | Center SVG icon (16px) |

```css
.ps5-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 38px;
  padding: 0 16px;
  font-size: 13px;
  font-weight: 600;
  border-radius: var(--ps5-radius-md);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  user-select: none;
  white-space: nowrap;
}

.ps5-btn.primary {
  background: var(--ps5-accent);
  color: #ffffff;
  border: none;
}
.ps5-btn.primary:hover {
  background: var(--ps5-accent-hover);
}

.ps5-btn.secondary {
  background: var(--ps5-surface-2);
  color: var(--ps5-text-primary);
  border: 1px solid var(--ps5-border-default);
}
.ps5-btn.secondary:hover {
  background: var(--ps5-surface-3);
  border-color: rgba(255, 255, 255, 0.18);
}

.ps5-btn-icon {
  width: 36px;
  height: 36px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--ps5-radius-md);
  background: var(--ps5-surface-2);
  border: 1px solid var(--ps5-border-default);
  color: var(--ps5-text-secondary);
  cursor: pointer;
}
.ps5-btn-icon:hover {
  background: var(--ps5-surface-3);
  color: var(--ps5-text-primary);
}
```

### 5.2. Form Inputs & Selects

```css
.ps5-input,
.ps5-select {
  height: 38px;
  background: var(--ps5-surface-2);
  border: 1px solid var(--ps5-border-default);
  border-radius: var(--ps5-radius-md);
  color: var(--ps5-text-primary);
  padding: 0 12px;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s ease;
}

.ps5-input:focus,
.ps5-select:focus {
  border-color: var(--ps5-accent);
}
```

### 5.3. Status Badges & Pills

```css
.ps5-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: var(--ps5-radius-sm);
  background: var(--ps5-surface-2);
  color: var(--ps5-text-secondary);
  border: 1px solid var(--ps5-border-subtle);
}

.ps5-badge.online {
  background: var(--ps5-status-online-tint);
  color: var(--ps5-status-online);
  border-color: rgba(16, 185, 129, 0.25);
}

.ps5-badge.updating {
  background: var(--ps5-status-warn-tint);
  color: var(--ps5-status-warn);
  border-color: rgba(245, 158, 11, 0.25);
}
```

### 5.4. Gamepad Focus Ring

```css
*:focus-visible {
  outline: 2px solid var(--ps5-accent) !important;
  outline-offset: 3px !important;
}

/* NO scaling transform on focus to prevent reflow jitter */
.ps5-btn:focus-visible,
.pcard:focus-visible,
.ps5-card:focus-visible {
  border-color: var(--ps5-accent) !important;
}
```

---

## 6. Page-by-Page Inconsistency Audit & Fix Blueprint

### 6.1. Settings View (`renderSettings`)

- **Current State:**  
  Renders raw `<h2>Ayarlar</h2><p class="subtitle">` followed by floating `.settings-box` cards with disparate button shapes (`.btn.ghost`, `.btn.danger`).
- **Target Design System Transformation:**
  - Wrap in `<div class="ps5-page ps5-settings-page">`.
  - Add standard `.ps5-page-header`:
    - Kicker: `SİSTEM YAPILANDIRMASI`
    - Title: `Ayarlar`
    - Subtitle: `Epic Games hesabı, indirme profilleri, depolama ve donanım tercihleri.`
    - Actions slot: Reset Defaults or Version Badge.
  - Convert `.settings-box` to `.ps5-settings-card` with `var(--ps5-surface-1)` background, `var(--ps5-radius-lg)`, and unified row layouts.
  - Standardize all action buttons to `.ps5-btn.secondary` and `.ps5-btn.primary`.

### 6.2. Downloads View (`renderDownloads`)

- **Current State:**  
  Has NO page header. Jumps directly into either `.dl-active-hero` or an empty state box. Uses legacy buttons (`.btn.primary.small`, `.btn.ghost.small`) and inconsistent green/cyan speed text colors.
- **Target Design System Transformation:**
  - Wrap in `<div class="ps5-page ps5-downloads-page">`.
  - Add standard `.ps5-page-header`:
    - Kicker: `AĞ & AKTARIM MERKEZİ`
    - Title: `İndirmeler`
    - Subtitle: `Aktif kurulumlar, indirme kuyruğu ve anlık disk yazma performansı.`
    - Actions slot: Queue Controls (Tümünü Duraklat / Devam Et button: `.ps5-btn.secondary`).
  - Standardize stat tiles to `.ps5-surface-2` with `var(--ps5-radius-md)`.
  - Retain live canvas chart but style legend and borders strictly with design system tokens.

### 6.3. Profile View (`renderProfile`)

- **Current State:**  
  The PS5 Trophy showcase is already visually impressive, but its outer container lacks the standard page shell alignment, and the trophy game cards use idiosyncratic badge styling.
- **Target Design System Transformation:**
  - Unify outer container margins with `--ps5-page` standards.
  - Standardize the profile header search and filter pills (`Tümü`, `Platin`, `Devam Eden`) with the standard `.ps5-badge` and `.ps5-btn.secondary` tokens.
  - Align card border-radius to `var(--ps5-radius-lg)`.

### 6.4. Library View (`renderEpic`)

- **Current State:**  
  Contains multiple toolbar variations, custom filter pills, and mixed button styles.
- **Target Design System Transformation:**
  - Standardize library filter bar (All, Installed, Favorites, Collections) to use `.ps5-filter-pill` with `var(--ps5-surface-2)` and active state `var(--ps5-accent)`.
  - Standardize search input with `.ps5-input`.
  - Standardize game card action buttons (Play, Install, Manage) using `.ps5-btn`.

---

## 7. Konsol Seviyesi Profesyonellik Standartları & Katı Yasaklar (Zero-Tolerance Invariants)

Steam, PlayStation 5 OS ve Xbox Dashboard seviyesinde bir masaüstü konsol deneyimi sunmak için aşağıdaki kurallar **tavizsizdir**:

### 7.1. SIFIR EMOJİ POLİTİKASI (Zero-Emoji Policy)
- **KESİNLİKLE YASAK:** Arayüzde hiçbir buton, bildirim (`toast`), başlık, etiket, sekme, dil seçimi veya koleksiyon etiketinde işletim sistemi emojisi (`🇹🇷`, `🌐`, `🎮`, `⭐`, `🔥`, `🚀`, `📸`, `📋`, `✨`, `⌨️` vb.) KULLANILAMAZ.
- **Neden?** Emojiler Windows 10, Windows 11 veya Linux'ta farklı renk, boyut ve biçimde çizilir. Arayüzü ucuz bir mobil sohbet uygulaması veya amatör web sitesi gibi gösterir. Konsol işletim sistemlerinde asla ham işletim sistemi emojisi görülmez.
- **Standart:**
  - İkon gerekiyorsa: Her zaman tek tip stroke kalınlığına sahip Lucide / inline SVG ikonu (`icon("camera", 16)`, `icon("globe", 16)`).
  - Dil seçimi gerekiyorsa: Bayrak emojisi yerine temiz tipografiyle ISO dil kodları (`TR`, `EN`) veya `.ps5-lang-pill` kullanılır.

### 7.2. SAYISAL TİTREME ENGELLEME (Tabular Numbers Zorunluluğu)
- **KESİNLİKLE YASAK:** Canlı akan indirme hızları (`18.4 MB/s`), disk yazma hızları, yüzdeler (`%45`), oyun süreleri (`14 sa 20 dk`), kupa sayaçları, saat veya ETA sürelerinde orantılı (proportional) font kullanılamaz.
- **Neden?** Standart fontlarda `1` sayısı ile `8` sayısının piksel genişliği farklıdır. Sayı değiştikçe metin kutuları, butonlar ve sayaçlar sürekli titrer (layout jitter / shake).
- **Standart:** Tüm dinamik sayısal verilerde CSS kuralı zorunludur:
  ```css
  font-variant-numeric: tabular-nums;
  ```

### 7.3. SIFIR METİN TAŞMASI (Strict Ellipsis & Line-Clamp)
- **KESİNLİKLE YASAK:** Hiçbir oyun başlığı, klasör yolu veya etiket bir kartın veya ızgaranın yüksekliğini rastgele genişletip hizada bozulmaya yol açamaz.
- **Standart:**
  - Tek satırlık alanlar:
    ```css
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    ```
  - Çok satırlık açıklamalar:
    ```css
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    ```

### 7.4. TARAYICI VARSAYILANI SIFIR TOLERANSI (No Native Browser Elements)
- **KESİNLİKLE YASAK:** Webview varsayılanı mavi/siyah odak halkaları (`outline: auto`), beyaz sayı değiştirici oklar (`input[type="number"]::-webkit-inner-spin-button`), gri ham butonlar (`<button>`), Windows sistem kaydırma çubuğu veya sistem açılır kutuları (`<select>`) KESİNLİKLE YASAKTIR.
- **Standart:** Her form elemanı özel PS5 surface (`--ps5-surface-2`), 10px köşe yuvarlama (`--ps5-radius-md`) ve lavanta odak halkası taşımalıdır.

### 7.5. SOĞUKKANLI KONSOL DİLİ (Microcopy Discipline)
- **KESİNLİKLE YASAK:** Ünlem işaretli ("Hemen Oyna!", "Süper Fırsat!", "Yedeği Geri Yükle!"), çocuksu veya laubali arayüz metinleri ("Hata çıktı :(", "Oyun silindi gitti", "Harika seçim!") YASAKTIR.
- **Standart:** PlayStation ve Steam gibi soğukkanlı, net, kısa ve profesyonel sistem dili kullanılır:
  - `"Oyna"`, `"Yükle"`, `"Doğrula"`, `"Kaldır"`, `"İptal"`
  - `"Bütünlük doğrulanıyor…"`, `"Yetersiz disk alanı"`, `"Ekran görüntüsü panoya kopyalandı"`

### 7.6. DOKUNSAL GERİ BİLDİRİM & HIZ SINIRI (Tactile Micro-Feedback)
- **KESİNLİKLE YASAK:** Tıklandığında hiçbir tepki vermeyen ölü butonlar veya 250ms'den uzun süren hantal CSS animasyonları.
- **Standart:** Tıklanabilir tüm elemanlar `:active` anında hafifçe ezilmelidir (`transform: scale(0.98)`). Geçiş animasyonları asla 120–150ms'yi aşmamalıdır (`transition: all 0.15s cubic-bezier(0.2, 0, 0, 1)`).

### 7.7. ZARİF BOŞ DURUMLAR (Empty State Elegance)
- **KESİNLİKLE YASAK:** Bir sayfa veya liste asla kırık ya da kuru bir "Kayıt yok" yazısıyla boş bırakılamaz.
- **Standart:** 36-40px soluk vektör ikonu, net bir başlık ("İndirme Kuyruğu Boş"), yönlendirici kısa bir açıklama ve birincil yönlendirme butonu (`.ps5-btn.primary` -> "Kütüphaneye Git").

---

## 8. Quality Checklist for Future UI Changes

Before submitting any UI modification, verify:
- [ ] Are all raw OS emojis eliminated? (Only inline SVG vector icons or ISO codes allowed).
- [ ] Do dynamic numbers, timers, and speeds use `font-variant-numeric: tabular-nums`?
- [ ] Are long titles and paths truncated with strict `text-overflow: ellipsis`?
- [ ] Does this page use `.ps5-page-header` with kicker, title, and subtitle?
- [ ] Are all surfaces using `--ps5-surface-1`, `--ps5-surface-2`, or `--ps5-surface-3`?
- [ ] Are all border-radii strictly `6px`, `10px`, `14px`, or `20px`?
- [ ] Are buttons using `.ps5-btn.primary`, `.secondary`, `.danger`, or `.ps5-btn-icon`?
- [ ] Are there zero decorative neon glow effects or rainbow gradients?
- [ ] Does Gamepad navigation outline the element with the 2px lavender focus ring without layout shifting?


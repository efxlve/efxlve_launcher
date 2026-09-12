# efxlve_launcher 🎮

Tauri v2 (Rust + Vite/TS) ile yazılmış örnek **oyun mağazası launcher** uygulaması.

## Gereksinimler

- Rust stable (rustup ile) + Windows'ta **MSVC (VS C++ Build Tools)**
- Node.js 20+ ve npm
- WebView2 Runtime (Windows 11'de hazır gelir)

## Çalıştırma

```powershell
npm install
npm run tauri dev     # masaüstü uygulamayı başlat
```

Sadece arayüzü tarayıcıda denemek için (Rust'sız demo modu):

```powershell
npm run dev           # http://localhost:1420
```

Paketleme:

```powershell
npm run tauri build
```

## Özellikler (demo)

- 🛒 Mağaza: oyun listesi, arama, detay penceresi
- ⬇️ İndirmeler: Rust'tan `download-progress` event'i ile canlı ilerleme çubuğu
- 📚 Kütüphane: kurulu oyunlar, `library.json` ile kalıcı saklama (`app_data` altında)
- ▶️ Oyna / Kaldır aksiyonları (`launch_game`, `uninstall_game` komutları)

## Proje yapısı

- `src/` — Vite + TypeScript arayüz (`main.ts`, `styles.css`)
- `src-tauri/` — Rust backend (`src/main.rs`, `tauri.conf.json`)


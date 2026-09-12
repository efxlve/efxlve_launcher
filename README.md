# Efxlve Launcher 🎮

Epic Games kütüphaneni yöneten **alternatif masaüstü launcher** (Tauri v2 + Rust + TypeScript).
Epic hesabına giriş yap, oyunlarını listele, indir, başlat — hepsi Epic Games Store
görünümünde, tek uygulamada.

> Motor: açık kaynak [`legendary`](https://github.com/legendary-gl/legendary) CLI
> (GPL-3.0, uygulama ilk çalışmada otomatik indirir). Mimari ilham: Heroic Games Launcher.

## Özellikler

- ⚡ **Epic girişi:** kod-yapıştır ile login veya kurulu Epic Launcher'dan oturum aktarma
- 📚 **Kütüphane:** gerçek kapak görselleri, arama, sıralama, favoriler, kurulu/güncelleme rozetleri
- ⬇️ **İndirme:** kuyruk, canlı ilerleme, iptal, kaldırma, kurulum klasörü ayarı
- ▶️ **Başlatma:** online (sahiplik bileti) → offline fallback
- 🛒 **Gömülü mağaza + profil:** `store.epicgames.com` uygulama içinden açılır
- 🛡️ **Sağlam senkron:** bozuk katalog öğeleri otomatik atlanır, arayüz her zaman önbellekten beslenir

## Gereksinimler

- Windows 10/11 x64 (WebView2 Runtime — Windows 11'de hazır gelir)
- Geliştirme için: Rust stable + MSVC (VS C++ Build Tools), Node.js 20+

## Çalıştırma

```powershell
npm.cmd install
npm.cmd run tauri dev
```

Sadece arayüz (Rust'sız demo modu): `npm.cmd run dev` → http://localhost:1420

## Proje yapısı

- `src/` — Vite + TypeScript arayüz (`main.ts`, `epic.ts`, `styles.css`)
- `src-tauri/src/legendary/` — Rust backend: `client` (CLI sarmalayıcı), `models`,
  `cache` (diskten okuma), `downloader` (binary oto-indirme), `skip` (bozuk öğe
  atlama), `transfers` (indir/kaldır/başlat), `commands` (Tauri komutları)

Ayrıntılı geliştirici kılavuzu için: **[AGENTS.md](./AGENTS.md)**

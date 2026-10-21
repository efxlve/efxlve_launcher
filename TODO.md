# TODO

Open work only, newest first. Delete an item when it lands. A task should fit one
commit with `npm.cmd run build` (plus `cargo test` when Rust changes).

## 1. Owner checks (need the real app window)

- **Overlay:** the connected Discord state with a real account, and a final
  in-game visual pass with real artwork. The panel, widget layout, clock, media
  and clip polling were already verified in the browser harness; the hidden
  window, hotkey and native HUD still need a real game.
- **Themes / TV:** look at the TV home shell and game hub at 1920 px with real
  poster art. Decide whether the TV profile and the embedded storefront need the
  same command-bar / stage pass.
- **Game page:** the hero with real artwork, and the `...` menu opened by hand.
  Its markup and open/close behaviour were verified in the browser harness only.
- **Transparency:** `tauri.conf.json` keeps a frameless transparent window, so
  the compositor pays for alpha every frame (idle ~11% of one core). Choose
  between disabling transparency while unfocused and a "solid background"
  switch in Settings → Appearance for low-end PCs.

## 2. Performance

- **Bundle split:** lazy-load the rare views (TV mode, store, Discord) behind
  dynamic imports. This is roughly 100-150 kB off a cold start, but it touches
  the core render switch and only pays off on low-end machines.
- **GPU recorder:** the MJPEG/GDI path cannot hold 60/120 fps; a full 2560x1600
  GDI read costs 26-46 ms per frame. A second recorder using Desktop Duplication
  (DXGI) into a staging texture plus Media Foundation H.264 would lift the
  ceiling. Keep MJPEG as the fallback for machines without a hardware encoder.
  Settings already disables the 60/120 buttons (`CLIP_FPS_SUPPORTED`); recorded
  files carry the measured frame rate so picture and sound stay the same length.
- **Startup:** `epicGetNetworkProfile` and the CDN/shortcut prefetch are still
  awaited on the boot path (~50 ms). Not worth another pass unless a slow start
  shows up again.

## 3. Features

- **Compressed clip for sharing:** Discord accepts 8 MB, which a full-quality
  clip passes in a second or two. The share path already cuts the chosen range
  into the temp folder and shows its weight; re-encoding the frames smaller is
  the real answer and belongs with the GPU encoder above.
- **IGDB credentials:** the proxy at `efxlve.com/api/igdb` is the default, and it
  is the only path most users need. Add a power-user way back to own
  `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` now that the settings row is visible.
- **Linux/macOS packaging:** the compatibility layer shipped (`src-tauri/src/compat/`),
  but Flatpak/AppImage/`.deb`/AUR and macOS `.app`/notarization are open. Real
  Linux/macOS hardware still has to confirm the Proton/umu prefix layout. The
  screenshot hook, embedded store webview and drive scan still need platform
  implementations. `wine-crossover` stays detection-only until a maintained
  release source exists.
- **Discord native friends list:** optional Phase 4 after the embedded webview.
  The Social SDK is approved and the app is activated; cost is roughly 2-3 days
  plus DLL packaging. The webview path stays the primary surface.

## 4. Community confirmations

- **Berke:** the Discord consent fix shipped in 0.1.31 (RPC scope list plus
  stop-on-decline). Ask him to try it and report.
- **Gyro:** his crash is still unexplained. The 0.1.32 revert is the prime
  suspect fix and has shipped; ask for the Windows Event Log entry — the
  "faulting module name" — to settle it. `logs\crash.log` catches panics from
  0.1.31 on.
- **hidaaan:** the screenshot scan switch (`SCREENSHOT_SCAN_ALL`, off means the
  chosen folder only) shipped. Confirm it at the next release.

# TODO

Open work only. Delete the item when it lands.

## Sidebar resize flashes the library

Opening a game page and then dragging the sidebar resize handle (or collapsing and
expanding the rail) paints the library view for a frame before the game page
returns. The view layer must stay on the open page while the width animates; a
resize step must not trigger a library render or clear the page surface.

Repro: open any game page, then shrink and grow the left sidebar.

## Game page has no right scrollbar

The game page scrolls but no vertical scrollbar paints on the right edge. Check
the `.overlay` scroll container in `src/styles/game-page.css` (stable gutter) and
the per-theme scrollbar tokens before changing the overflow.

## Linux/macOS: packaging and validation

- Tagged releases still publish Windows only. The manual **Package** workflow
  builds unsigned Linux (.deb/.rpm/AppImage) and macOS (.app/.dmg) artifacts;
  Flatpak, signing and notarization are still open.
- Real-hardware pass for game launch, Proton prefix preparation, Steam library
  detection, store webviews and path case sensitivity.
- A Unix global overlay hotkey; today the overlay opens from the launcher header
  and tray. Wayland compositors may also ignore the panel's position and
  always-on-top request, which needs a layer-shell path.
- Screen capture, clips, HUD/FPS and taskbar badges remain Windows-only and are
  hidden on Unix.

## GPU recorder: 60/120 fps

The MJPEG/GDI recorder cannot hold the rates the settings offer. Measured on the
dev machine on 2026-10-18:

| Step | Cost |
|---|---|
| GDI screen read (`BitBlt`), full 2560x1600 | 26-46 ms |
| The same read at 384x240 output | 29 ms — the cost is the screen, not the frame |
| GDI+ JPEG encode | 5-15 ms |

So the ceiling is ~20 fps at native size and ~26 fps at 720p, whatever the user
asks for. The 60 and 120 buttons in Settings are therefore disabled
(`CLIP_FPS_SUPPORTED` in `src/features/screenshots/ss-settings.ts`) and
`clipFps()` falls back to 30. The AVI header carries the measured frame rate, so
picture and sound stay the same length.

Getting to 60/120 means a second recorder beside the current one:

- Read frames on the GPU: Desktop Duplication API (DXGI) or Windows Graphics
  Capture, into a staging texture. The read stops costing CPU time per frame.
- Encode with the hardware encoder: Media Foundation H.264 (the OS picks NVENC,
  QuickSync or AMF) instead of one JPEG per frame.
- Keep the MJPEG writer as the fallback: no codec licence, plays everywhere, and
  it is the only path on machines without a hardware encoder.
- The clip list, the settings rows and the overlay widget stay as they are; only
  the recorder behind them changes.

Files: `src-tauri/src/legendary/clip_recorder.rs`,
`src-tauri/src/legendary/clip_audio.rs`,
`src/features/screenshots/ss-settings.ts`.

## Ghost mode field pass

Pinned widgets now stay over the game as a click-through HUD when the panel
closes (`src-tauri/src/overlay/ghost.rs`). Validate on a borderless game and a
multi-monitor setup: the pinned card keeps its place, clicks reach the game,
Shift+Tab restores the panel, a pinned music card keeps updating, and the ghost
tears down when the game exits. Then hide inert controls (music transport,
filter chips) while click-through and add a per-widget ghost opacity.

## HUD 2.0 field pass

The native HUD and the Performance tab now show 1% / 0.1% frame-time lows from
the ETW ring (`src-tauri/src/overlay/metrics/etw.rs`). Validate against
PresentMon on a 60 Hz and a high-refresh title: the 1% low should appear after
~2 s, the 0.1% after ~17 s, and both should track PresentMon within ~2%. Then
add temperatures and package power (NVML/ADLX/PDH) and the 60 Hz frame-time
graph.

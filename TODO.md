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
tears down when the game exits. Then add a per-widget ghost opacity.

## HUD 2.0 field pass

The native HUD and the Performance tab now show 1% / 0.1% frame-time lows from
the ETW ring (`src-tauri/src/overlay/metrics/etw.rs`). Validate against
PresentMon on a 60 Hz and a high-refresh title: the 1% low should appear after
~2 s, the 0.1% after ~17 s, and both should track PresentMon within ~2%. The
Performance tab also plots the last 1024 frame times as a frametime graph.
Validate the HUD appearance modes on a real game: minimal/compact/full, all four
corners on a multi-monitor and scaled display, and the text color over a bright
scene. Then validate CPU/GPU temperatures and GPU power on NVIDIA and AMD
machines (the CPU zone is vendor-neutral; NVML only loads on NVIDIA) and add
CPU package power (RAPL/ADLX). Validate the graph against PresentMon's frametime
trace.

## Audio mixer field pass

The Audio tab now lists the master bus and every session on the default output
endpoint (`src-tauri/src/overlay/audio.rs`). Validate on a real game and a
browser: per-app volume and mute, system sounds, a device switch, and a session
that starts or stops while the tab is open. Then add the output-device picker,
named mix presets, session icons, controller focus order, and translations for
the eight new keys (English values are in place for the other locales).

## Crosshair field pass

The Settings tab now draws a native, click-through crosshair over the game
(`src-tauri/src/overlay/crosshair.rs`). Validate on a borderless game: the
reticle sits at the monitor centre, Ctrl+Shift+X toggles it, the outline stays
readable on bright scenes, and it disappears when the game exits. Then add a
per-game profile, a configurable hotkey, and translations for the 21 new keys
(English values are in place for the other locales).

## Achievement tracker field pass

The Tracker widget now pins up to three locked achievements and keeps them in
ghost mode (`src/features/overlay/overlay.ts`). Validate on a real game: track
from the achievement detail, pin the tracker, close the panel, and confirm the
progress bar survives; unlock one and confirm it repaints. Then add live
progress polling while pinned, per-game tracker presets, and translations for
the seven new keys (English values are in place for the other locales).

## Notes image field pass

The overlay note editor now accepts a pasted image: it is resized and
JPEG-compressed, stored in the note's `images` array, and rendered by the
preview in the overlay, the launcher Notes page and the game drawer
(`src/features/notes/`). Validate with a real screenshot and a map, then add
file-backed storage for large images, an image remove/replace action, and
translations for the three new keys.

## Browser PiP field pass

The browser's PiP button shrinks the window to a 16:9 corner player and keeps it
when the panel closes (`src-tauri/src/overlay/browser.rs`,
`src/features/overlay/browser-window.ts`). Validate on a borderless game and a
multi-monitor/DPI setup: the player lands top-right, the page fills the frame,
the PiP bar restores and closes, the game keeps focus after close, and the
browser reopens at full size. Then add a click-through toggle, a direct "send
this tab to PiP" action, and translations for the two new keys.

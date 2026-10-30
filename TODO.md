# TODO

Open work only. Delete the item when it lands.

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

## GPU recorder field pass

Rates above 30 fps now record through DXGI Desktop Duplication and Media
Foundation H.264 + AAC into an MP4 (`clip_dxgi.rs`, `clip_mf.rs`); 15/30 fps keep
the MJPEG AVI writer as the fallback. Validate on a real game at 60 and 120:
the file opens with picture and sound in sync, the measured rate in the log is
close to the requested rate, and the game keeps its frame rate. MP4 clips now get
a Media Foundation thumbnail, frame grab and duration; trim/join stay AVI-only
and are hidden for MP4 (the backend rejects them with a clear message).

Files: `src-tauri/src/legendary/clip_recorder.rs`,
`src-tauri/src/legendary/clip_audio.rs`,
`src/features/screenshots/ss-settings.ts`.

## Ghost mode field pass

Pinned widgets now stay over the game as a click-through HUD when the panel
closes (`src-tauri/src/overlay/ghost.rs`). Validate on a borderless game and a
multi-monitor setup: the pinned card keeps its place, clicks reach the game,
Shift+Tab restores the panel, a pinned music card keeps updating, and the ghost
tears down when the game exits.

## HUD 2.0 field pass

The native HUD and the Performance tab now show 1% / 0.1% frame-time lows from
the ETW ring (`src-tauri/src/overlay/metrics/etw.rs`). Validate against
PresentMon on a 60 Hz and a high-refresh title: the 1% low should appear after
~2 s, the 0.1% after ~17 s, and both should track PresentMon within ~2%. The
Performance tab also plots the last 1024 frame times as a frametime graph.
Validate the HUD appearance modes on a real game: minimal/compact/full, all four
corners on a multi-monitor and scaled display, and the text color over a bright
scene. Then validate CPU/GPU temperatures and CPU/GPU power on NVIDIA and AMD
machines (CPU temperature is vendor-neutral, CPU power uses the Windows Power
Meter counter when the firmware exposes a processor/package instance, and NVML
only loads on NVIDIA). Validate the graph against PresentMon's frametime trace.

## Audio mixer field pass

The Audio tab now lists the master bus and every session on the default output
endpoint (`src-tauri/src/overlay/audio.rs`). Validate on a real game and a
browser: per-app volume and mute, system sounds, a device switch, and a session
that starts or stops while the tab is open. Then add controller focus order.

## Crosshair field pass

The Settings tab now draws a native, click-through crosshair over the game
(`src-tauri/src/overlay/crosshair.rs`). Validate on a borderless game: the
reticle sits at the monitor centre, the configured hotkey toggles it, the outline
stays readable on bright scenes, and it disappears when the game exits. Then do
the field pass on exclusive fullscreen and validate the per-game profile.

## Achievement tracker field pass

The Tracker widget now pins up to three locked achievements and keeps them in
ghost mode (`src/features/overlay/overlay.ts`). Validate on a real game: track
from the achievement detail, pin the tracker, close the panel, and confirm the
progress bar survives; unlock one and confirm it repaints. Then add per-game
tracker presets.

## Notes image field pass

The overlay note editor now accepts a pasted image: it is resized and
JPEG-compressed, stored in the note's `images` array, and rendered by the
preview in the overlay, the launcher Notes page and the game drawer
(`src/features/notes/`). Validate with a real screenshot and a map. Pasted images
are now written under `<app data>/note-images` and the note stores their paths;
data URLs in an older notes file migrate on the next read.

## Browser PiP field pass

The browser's PiP button shrinks the window to a 16:9 corner player and keeps it
when the panel closes (`src-tauri/src/overlay/browser.rs`,
`src/features/overlay/browser-window.ts`). Validate on a borderless game and a
multi-monitor/DPI setup: the player lands in the selected corner (top-right by
default), the corner button moves it, the page fills the frame, the PiP bar
restores and closes, the game keeps focus after close, and the browser reopens
at full size. Then add a direct "send this tab to PiP" action.

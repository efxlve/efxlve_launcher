# TODO

Open work only. Delete the item when it lands.

## Linux/macOS: packaging and validation

- Tagged releases still publish Windows only. The manual **Package** workflow
  builds unsigned Linux (.deb/.rpm/AppImage) and macOS (.app/.dmg) artifacts, and
  now also builds an unsigned Flatpak bundle; Flatpak signing/publishing and macOS
  signing/notarization are still open.
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
close to the requested rate, and the game keeps its frame rate. MP4 clips get a
Media Foundation thumbnail, frame grab and duration; trim and join re-encode
through Media Foundation (AVI trimming still copies chunks).

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
that starts or stops while the tab is open.

## Crosshair field pass

The Settings tab now draws a native, click-through crosshair over the game
(`src-tauri/src/overlay/crosshair.rs`). Validate on a borderless game: the
reticle sits at the monitor centre, the configured hotkey toggles it, the outline
stays readable on bright scenes, and it disappears when the game exits. Then do
the field pass on exclusive fullscreen and validate the per-game profile.

## Achievement tracker field pass

The Achievements widget now contains the tracked section and pins up to three
locked achievements; pinning the widget keeps that section as a compact ghost
HUD (`src/features/overlay/overlay.ts`). Validate on a real game: track from the
achievement detail, pin the Achievements widget, close the panel, and confirm the
progress bar survives; unlock one and confirm it disappears from the tracked set.
The list filters by all, unlocked, locked, near and hidden, with hidden rows inline.
Then add per-game tracker presets.

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

## Ubisoft direct install

`src-tauri/src/companion/ubi_direct/` now owns the Demux ownership/manifest
query, the CDN download with resume/reconnect, per-slice verify/repair, the MIT
Uplay R1/R2 shim and the direct launch. Rayman Origins (R1 x86) and the
launcher's Play path are validated without the Connect client; its verify pass
reports 201/201 files clean. The install dialog now offers **direct** or
**Ubisoft Connect** per game. Assassin's Creed Chronicles China installs
(3.6 GB) but crashes at startup with both tested R1 shims (0xc0000005);
PCGamingWiki lists it as requiring Ubisoft Connect DRM, so it stays on the
client. Open work:

- R2 (`upc_r2_loader`) is implemented and unit-tested but not validated on a
  real R2 title; the user's R2 catalogue starts at large titles (Far Cry 5 /
  AC Origins class).
- Updates are still absent: verify/repair compares the installed files with the
  current manifest, but no latest-manifest/version check marks an update.
- The R1 shim records unlocks in `upc.json` only for IDs present in the
  achievement list built from the Connect cache. Rayman Origins has no cached
  schema, so it records nothing until a schema source is added. UbiSlot and the
  local spool are the reference.
- Ubisoft saves are local folders. `companion/ubi_direct/saves.rs` resolves the
  shim, Connect and Documents layouts for the existing cloud providers; the
  Ludusavi manifest is still open for titles outside those layouts.
- Online/anti-cheat titles (R6/BattlEye) and Connect-only DRM titles stay on the
  client. Do not attempt to bypass BattlEye or Denuvo.
- Orbit R2 (`ubiorbitapi_r2_loader`) titles still need the Connect client.

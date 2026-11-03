# TODO

Open work only. Delete the item when it lands.

## EA direct launch and content

- Mirror's Edge Catalyst launches through the in-process LSX server
  (`src-tauri/src/companion/ea_lsx.rs`): challenge, config, profile, game info,
  entitlements and presence are answered, and the activation `.dlf` is written
  under `ProgramData`. Use it as the reference title for the remaining handlers.
- EA anti-cheat titles (Battlefield, FC) stay on the EA App. Javelin rejects a
  stopped background service with `EC:10701`; do not attempt to bypass it.
  Direct install, update and repair also refuse those titles. The only supported
  improvement is an EA App runtime the launcher starts and closes itself.
- Non-EAAC installs, updates and repairs run through the content service:
  `ea_content.rs` resolves the live build, reads the ZIP central directory,
  streams entries with CRC checks, resumes from verified files and reports
  progress; `ea_install.rs` selects the install, update or repair touchup
  parameters. The install dialog, Downloads row and Manage check/verify/repair
  actions are wired. Pre-DiP packages with the `<executable>` touchup block
  (Dead Space 2) use the same installer; disc-only packages (`__Installer/DISK1`
  or no manifest) go to the EA App.
- A direct launch failure for a launcher-owned install now reports the error
  instead of silently opening the EA App, which could download a second copy.
  EAAC and EA App-installed legacy titles still use the EA App fallback.
- DiP titles that still carry `Core/activation.exe` are experimental: they use
  EA's official license service, and fall back to the EA App on failure.
- Pre-DiP launch uses the `executePathOverride` from EA's `legacyOffers`.
  Dead Space 2 resolves and starts, but on this machine the game stops at
  "Could not initialize display hardware" (a graphics issue, not a license
  rejection). Its 16.9 GB content package also carries the `<executable>`
  touchup, but a live pre-DiP install is still pending; Mirror's Edge is a
  disc-only package.
- Direct installs default to `<home>/Games/EA`, matching Epic, GOG and Amazon;
  the old `.config/efxlve/ea-games` folder stays visible. Existing EA App
  installs under Program Files update through a one-shot elevated copy of the
  launcher (`--ea-content-worker`); Windows shows a UAC prompt. Over-the-shoulder
  elevation with a separate administrator account is not supported because that
  copy would not see the user's EA session.
- Approving a real UAC prompt for a Program Files update is still a manual pass.
  The shell launch, process wait and exit-code path are covered without
  elevation.
- A full DiP package install with touchup registration and launch still needs a
  small title or a faster link. The owned catalog has no small DiP game: A Way
  Out is 21.9 GB and Mirror's Edge ships the legacy `__Installer/DISK1` layout.
- `touchup.exe` registers a direct install with the EA App. The elevated worker
  runs it with the same rights as the EA App installer; without elevation the
  files stay playable through the launcher's own scan, but the EA App may not
  list the copy.
- `downloadUrl.syncUrl` differential updates are open; today the full package is
  read and unchanged files are skipped by size+CRC.
- Direct uninstall reads `<uninstall><path>` from the local installer manifest,
  resolves the registry `UninstallString` (including the 32-bit view) and runs
  the game's `Cleanup.exe`. A launcher-owned folder without a registry record is
  removed directly. Program Files uninstallers may still need an elevated
  launcher.
- Legacy launch protocols (Dead Space 2, BFBC2) still hand off to the EA App.

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
Uplay R1/R2 shim and the direct launch. Rayman Origins (R1 x86) and
Anno 1404 History Edition (R1 x64, adopted from a client install) both launch
without the Connect process; Rayman's verify pass reports 201/201 files clean.
The install dialog now offers **direct** or **Ubisoft Connect** per game, and a
catalog-only row resolves its numeric product id so the client opens that game's
install page instead of its default window. Assassin's Creed Chronicles China
installs (3.6 GB) but crashes at startup with both tested R1 shims
(0xc0000005); PCGamingWiki lists it as requiring Ubisoft Connect DRM, so it
stays on the client. Open work:

- R2 (`upc_r2_loader`) is implemented and unit-tested but not validated on a
  real R2 title. A live manifest inventory found `uplay_r1_loader*` in every
  installed single-player candidate (Far Cry 3/4, Watch Dogs 1/2, AC Unity,
  AC China/India/Russia, Splinter Cell, The Crew 2, Rayman). Ghost Recon Future
  Soldier is the one single-player title that also imports
  `ubiorbitapi_r2_loader.dll`; For Honor and Rainbow Six Siege are the online
  R2 titles. No installed R2 target exists, and the online ones are not used
  for shim validation.
- An existing Connect install can be adopted from Manage without moving or
  re-downloading it, moved to a library folder (the record and both registry
  families are updated), and released back with its official loaders restored.
  Adoption falls back to the local `uplay_install.manifest`/`state` when the
  session is offline, so a signed-out user can still leave the client. A
  successful online install or adopt also writes `efxlve_install.json` beside
  the game; re-adopt and verify can then run entirely offline. Anno
  1404 History Edition was adopted, moved to `C:\Users\Efe\Games\Ubisoft`, and
  launched directly with no Connect process. Online titles (R6, For Honor)
  still need the client if they are played again.
- A CDN edge that drops a slice body no longer aborts a multi-gigabyte install:
  the installer re-signs the remaining slice window and continues, and a run
  aborts only after repeated failures at the same point.
- Update checking compares the recorded CDN manifest id with the manifest
  ownership reports now, and Manage offers Check for updates. Applying an
  update reuses verify/repair: changed files are re-downloaded whole, not
  patched slice by slice. A launch also checks in the background once the game
  is already starting and raises a toast when a newer manifest exists.
- The R1 shim records unlocks in `upc.json` only for IDs present in the
  achievement list built from the Connect cache. Rayman Origins has no cached
  schema, so it records nothing until a schema source is added. UbiSlot and the
  local spool are the reference.
- Ubisoft saves are local folders. `companion/ubi_direct/saves.rs` resolves the
  shim, Connect and Documents layouts for the existing cloud providers; the
  Documents scan folds punctuation and accepts the short store spelling
  (`Watch_Dogs 2`, `Rainbow Six - Siege`). The first direct launch imports
  classic Connect slots (`548` header) into `Saves/<uplay|product id>`, never
  overwriting a direct save; newer Connect slots (`36` header) use a different
  payload and stay with the client. Manage also offers **Import Connect saves**
  for a direct install, so the copy can run before the first launch. Cloud slot
  metadata is readable from
  `/v1/profiles/<id>/entities?name=upcCloudSaveUplayId_<id>` (slot sizes and
  MD5s), but the payload is a signed S3 URL the client obtains, so direct import
  reads the slots the client has already synced locally. The Ludusavi manifest
  is still open for titles outside those layouts.
- Online/anti-cheat titles (R6/BattlEye) and Connect-only DRM titles stay on the
  client. Do not attempt to bypass BattlEye or Denuvo. Direct adopt and launch
  both check the title and install folder before the shim is deployed and
  refuse the title with a clear message.
- Orbit R2 (`ubiorbitapi_r2_loader`) titles still need the Connect client.

# TODO

Open work only. Delete the item when it lands.

## Cloud saves: next steps

- Steam `compatdata` prefixes in save discovery: the launcher's own Wine/Proton
  prefixes are scanned, but a game launched through Steam's Proton keeps its
  saves under Steam's `compatdata` tree and still needs the folder picked by
  hand.
- Retention and scheduled local-only backups; prune old timestamps.
- Bulk “back up all installed games” with a progress list.
- Conflict detection before restore (local/remote timestamp + hash); the
  pre-restore snapshot already makes a wrong restore recoverable.
- Auto-sync failure toast and a background queue.
- Move provider credentials from plain JSON into the OS keychain.
- Move the Linux/macOS Steam token out of the `0600` file and into the OS
  keychain (Secret Service / Keychain); Windows already uses DPAPI.

Details: `docs/CLOUD_SAVES.md`.

## Linux/macOS: packaging and validation

- AppImage/Flatpak/.deb/.rpm and macOS `.app` + notarization; no Unix installer
  is attached to a release yet.
- Real-hardware pass for game launch, Proton prefix preparation, Steam library
  detection, store webviews and path case sensitivity.
- A Unix global overlay hotkey; today the overlay opens from the launcher header
  and tray.
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

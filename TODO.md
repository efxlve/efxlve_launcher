# TODO

Open work only. Delete the item when it lands.

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

## Overlay: split the 5,722-line panel

`src/features/overlay/overlay.ts` holds the panel shell, the widget geometry and
every widget renderer in one file, and `overlay.css` is 4,880 lines. Both are
past the ceiling in [AGENTS.md](./AGENTS.md#layout-rules).

Cut the widget layer first, because the panel only calls into it: position, size,
pinning, drag, resize, clamping and z-order (`defaultWidgets` through
`initWidgetResizing`) move to `src/features/overlay/widgets.ts`. The panel keeps
the tab list, gamepad navigation and `renderWidgetContent`.

Then one file per widget renderer (performance, achievements, screenshots, music,
notes, Discord) and one stylesheet per widget group.

`src/features/settings/settings-view.ts` (2,487) and
`src/features/drawer/drawer-view.ts` (2,464) are over the ceiling too and need the
same treatment.

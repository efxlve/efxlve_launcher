# In-Game Overlay — Product & Technical Roadmap

Status: v1 shipped (Shift+Tab panel, native performance HUD, screenshots, notes,
achievements, Spotify + SMTC music, Discord status). Controller-first navigation is in.
ETW FPS is API-agnostic but needs the Windows "Performance Log Users" permission:
the overlay offers a one-time enable action and explains the sign-out. Discord
voice read/write still waits on the Discord app review noted below.
Target platform: Windows first (Linux/macOS later) · Owner: core team

A Steam-like overlay hosted by Efxlve Launcher: one hotkey opens a panel over any
running game with screenshots, notes, achievements, performance stats, music and
Discord — **without DLL injection**. This document captures the research, the chosen
architecture, the feature scope and the phased plan.

---

## 1. Goal & non-goals

**Goal:** a functional in-game interface (default `Shift+Tab`) that shows, over the game:

- performance HUD: FPS, frame-time graph, CPU, GPU, RAM/VRAM (toggles)
- screenshots: capture, gallery, open folder
- notes: per-game notes, autosaved
- achievements: the game's tracked set (existing data)
- music: Spotify/any player via Windows media controls
- Discord: presence + voice channel widget
- quick actions: store page, manage, session playtime, exit overlay

**Non-goals (v1):** DLL injection / API hooking, drawing inside the game's swapchain,
voice chat of our own, streaming/recording, Linux/macOS (design keeps them possible).

---

## 2. Research findings

### 2.1 How Steam's overlay works

Steam injects `GameOverlayRenderer64.dll` into the game process and hooks the present
path (`IDXGISwapChain::Present`, D3D 8–12, OpenGL, Vulkan), then draws into the swap
chain and captures input with its own hooks. It is deeply integrated (and
anti-cheat-whitelisted) but it is exactly the class of technique that costs a small
project stability, anti-cheat risk, and per-API maintenance. It is also not silent:
users complain about the injected DLL even when the overlay is disabled.

**Conclusion:** do not inject. A third-party launcher cannot be Steam.

### 2.2 External overlay — the model that fits us

An external overlay is a layered, topmost, transparent window placed over the game
window by the compositor (DWM). Windows flags: `WS_EX_LAYERED` (+ `WS_EX_TRANSPARENT`
for click-through, `WS_EX_NOACTIVATE`, `WS_EX_TOOLWINDOW`). This is the Crosshair X /
Xbox Game Bar / Overwolf model: no injection, no memory access, the game and the
anti-cheat simply see another window.

- Anti-cheat: BattlEye's FAQ says non-cheat overlays are "generally supported unless
  desired otherwise by the game developers"; tools that avoid injection/hooking state
  they run across EAC/BattlEye/VAC without ban reports. No guarantee exists — ship a
  per-game opt-out and a small curated blocklist for games that reject overlays.
- **Windows ↔ WebView2 constraint (critical):** per-pixel transparent WebView2 and
  click-through do not reliably combine — click-through via `WS_EX_TRANSPARENT` is not
  enough (WebView2 child windows take the clicks), and toggling layered attributes
  breaks per-pixel transparency (white sheet). Tauri has no native per-pixel
  click-through (`setIgnoreCursorEvents` ignores the whole window; feature request
  #13070 closed as duplicate).
  **Design consequence:** two separate surfaces (see §3).
- Exclusive fullscreen: a topmost window generally does not composite over true
  exclusive fullscreen. Borderless/windowed works. Document this and let the overlay
  tell the user when it cannot show.

### 2.3 Performance metrics without hooking

- **FPS / frame time:** read the OS present events over ETW (the PresentMon approach:
  `Microsoft-Windows-DxgKrnl`). Intel's PresentMon v2.6 (service + SDK) proves the
  method and adds GPU Busy. In Rust, `ferrisetw` gives a safe ETW consumer API.
  Fallback: bundle/consume the PresentMon service if our minimal consumer proves
  fragile.
  - **Which event:** `Microsoft-Windows-DxgKrnl` task 107 "Present", event **184**
    (version 1, Performance channel). It is the *kernel* present that ends every
    present path, so one counter covers **Direct3D 9/11/12, Vulkan and OpenGL**
    titles; PresentMon itself needs extra providers (DXGI, D3D9) only for richer
    per-frame analysis. Present counts are summed over all of the game's processes
    because some titles present from a child process.
  - **Windows permission:** only administrators, LocalSystem services and members of
    the "Performance Log Users" group (SID `S-1-5-32-559`) may control ETW sessions
    (`StartTraceW` → ERROR_ACCESS_DENIED otherwise); `EnableTraceEx2` documents the
    same rule. A *private logger* session does **not** work for kernel providers (it
    is file-based and meant for in-process providers), so there is no unprivileged
    ETW path. The overlay therefore shows a one-time **Enable** action that adds the
    current user to the group through a UAC prompt; Windows applies it on the next
    sign-in, and until then FPS reads "—" while every other metric works.
  - **Multi-API notes:** the panel and HUD are ordinary topmost windows, so they
    composite over borderless/windowed games on any API; exclusive fullscreen
    (DXGI `SetFullscreenState`, Vulkan `VK_EXT_full_screen_exclusive`) is the only
    mode they cannot paint over. Present counting is unaffected by the swap effect
    (flip model/blit) because event 184 fires at the kernel present.
- **CPU / RAM:** `sysinfo` (system + per-process).
- **GPU utilization / VRAM:** Windows GPU performance counters via PDH —
  `\GPU Engine(*)\Utilization Percentage` and `\GPU Process Memory(*)\Local Usage`,
  filtered by the game's PID (vendor-agnostic, no driver dependency). API-agnostic
  too: the counters live in the kernel mode driver, so Vulkan/OpenGL titles report
  like DirectX titles. On hybrid systems the same pid has one VRAM instance per
  adapter; the largest is the render adapter.
- **Temps / power (optional):** NVML for NVIDIA (`nvml-wrapper`); AMD/Intel via PDH
  and vendor SDKs later. Never required for the HUD to work.

### 2.4 Music — Spotify Web API with per-user apps, SMTC as fallback

Spotify caps development-mode apps at **5 authenticated users** and reserves extended
quota for organizations with 250k+ MAU (May 2025 policy), so a launcher cannot ship
one Client ID for everyone. The integration therefore asks each user to create their
own free Spotify app once (Developer Dashboard) and paste its Client ID: the launcher
runs Authorization Code + **PKCE** over the loopback redirect
`http://127.0.0.1:8899/callback` (Spotify allows dynamic ports for loopback literals)
and stores the refresh token under the app data dir. Control goes through the Web API
(`/v1/me/player*`) on whatever Spotify Connect device the user already has — no audio
stack, no librespot dependency, no shared client secret.

Playback control needs **Premium**; free accounts can still see what is playing.
`spotifast` (librespot-based) was reviewed as a reference; its separate playback
approval is only needed when a client plays audio itself, which a launcher does not.

An easier path exists for releases: register one app, build with
`EFXLVE_SPOTIFY_CLIENT_ID` and users skip the setup entirely (development mode
allows 5 authenticated users, so this suits the author and a few testers; Spotify
grants more only to organizations). spotifast ships a community-shared client ID
(shared with spotify-player/ncspot) for the same reason — this project does not use
someone else's app. Without any setup, the SMTC fallback still controls the desktop
Spotify client through Windows media keys.

**Fallback: Windows SMTC** (`GlobalSystemMediaTransportControlsSessionManager`) keeps
working when Spotify is not connected and covers every other player (browsers, local
files). The launcher's Spotify page and the overlay Spotify tab show Spotify when
connected and SMTC otherwise.

**Playback inside the launcher (librespot):** the launcher can also run a Spotify
Connect receiver through librespot, so it plays audio itself instead of only
controlling other devices — the same model spotifast uses. Pairing is one browser
approval against Spotify's own desktop client (`streaming` scope, no developer app),
the device appears as "Efxlve Launcher" in every Spotify client, and the Web API
controls it like any other device. Spotify requires Premium for librespot playback.

### 2.5 Discord — presence + voice read

- Rich Presence is already implemented in the launcher (`presence.rs`,
  `discord-rich-presence` crate). The overlay can show and toggle it.
- Voice: the Discord desktop client exposes a local RPC (IPC pipe). With the `rpc`
  OAuth scope, `GET_SELECTED_VOICE_CHANNEL` returns the current channel/participants
  and voice events report who is speaking — this is the model the open-source
  "Overlayed" app uses. Write operations (mute/deafen) need `rpc.voice.write`, which is
  **partner-only**; treat those buttons as "if approved".
- The new Discord Social SDK is for games embedding Discord voice into their own
  players — not for a launcher controlling the Discord client. RPC is the right path.

### 2.6 What already exists in this codebase

| Piece | Where | Reuse for the overlay |
|---|---|---|
| Global hotkey polling (`GetAsyncKeyState`) | `src-tauri/src/legendary/screenshots.rs` | Same pattern for `Shift+Tab`; configurable VK, per-game gating |
| Running game + foreground window detection | `legendary::transfers::launch`, `companion` | Overlay gating, per-game context, window rect for positioning |
| Screenshot capture pipeline + F12 | `screenshots.rs`, `src/features/screenshots/` | Gallery and capture button |
| Achievement summaries/data | `epic-commands`, achievement views | Achievements tab |
| Playtime and session tracking | playtime modules | Home tab session stats |
| Discord Rich Presence worker | `src-tauri/src/presence.rs` | Presence row; extend with an RPC reader thread |
| Design tokens + icon set | `docs/DESIGN_SYSTEM.md`, Lucide | Overlay visual language |
| Toast/notification bus | `src/core/toast`, notifications | In-overlay notices |

---

## 3. Chosen architecture

**Two surfaces, one data pipeline; no injection.**

1. **Overlay panel (interactive)** — a second Tauri WebView2 window (`label:
   "overlay"`): transparent, undecorated, always-on-top, skip-taskbar, hidden by
   default, sized to the monitor that hosts the game window (positioned over the game
   rect). `Shift+Tab` shows and focuses it; `Esc`/`Shift+Tab` hides it and returns
   focus to the game. Because it is hidden when inactive, the WebView2
   transparency/click-through conflict never applies.
2. **Always-on mini HUD (optional, later)** — FPS/CPU/GPU corner readout.
   If a transparent WebView proves unreliable in the click-through case, draw this
   one **natively in Rust** (a small layered GDI/Direct2D window: `WS_EX_LAYERED |
   WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE`). Text + a frame-time graph
   is cheap to draw and this window never needs input.
3. **Metrics worker (Rust)** — one thread samples at 1 Hz while (a game is running)
   AND (overlay enabled): FPS/frame time (ETW), CPU/RAM (`sysinfo`), GPU/VRAM (PDH
   for the game PID). Emits `overlay-metrics` events; sampling stops completely when
   idle (the launcher stays zero-cost when nothing is on screen).
4. **Input & hotkeys** — continue the polling pattern (no low-level hooks); hotkey and
   HUD toggles stay configurable and skip themselves while the overlay is open.
5. **Frontend** — new Vite entry `overlay.html` + `src/features/overlay/` so the main
   launcher bundle does not grow. Reuse tokens, icons, i18n and the existing event
   bus. New IPC commands live in `src-tauri/src/overlay/` (metrics, window control,
   media) and follow `docs/agent/ipc-index.md` naming; store-specific data keeps
   coming from the existing commands.
6. **Per-game behavior** — overlay enabled by default for library games; a per-game
   "disable overlay" switch, plus a small blocklist for titles that reject external
   overlays (anti-cheat policies, known conflicts).

### Overlay panel layout (v1 sketch)

Left rail with Steam-like sections; content on the right; footer with hotkey hints.

- **Home** — cover, session time, quick actions (store page, manage, favorite),
  performance summary (toggle-able).
- **Performance** — FPS + 1% lows, frame-time graph, CPU, GPU, RAM, VRAM; HUD on/off.
- **Screenshots** — latest captures, capture button, open folder, share.
- **Notes** — per-game notes, autosave, markdown-lite.
- **Achievements** — tracked set, unlock progress, recent unlocks.
- **Music** — SMTC session: artwork, title/artist, transport controls, source picker.
- **Discord** — presence status/toggle; voice channel + participants + speaking
  indicator; "open in Discord".
- **Settings** — hotkeys, HUD widgets, opacity/scale, per-game opt-out.

---

## 4. Milestones

### M0 — Feasibility spike (2–3 days)

- Transparent Tauri overlay window over a running game: show/hide, focus behavior,
  DPI/multi-monitor, Windows 10 and 11, and the exclusive-fullscreen result recorded.
- Minimal ETW consumer (`ferrisetw`) for present events of one PID: FPS + frame time.
- **Gate:** if our ETW consumer is unreliable, fall back to shipping the PresentMon
  service binaries and reading their stream.
- **Gate:** if the transparent WebView misbehaves over games, keep the WebView panel
  and plan the native HUD for M2.

### M1 — Overlay shell

- `overlay` window (config + capabilities), hotkey service (configurable, default
  `Shift+Tab`), show/hide/focus-return, `Esc` close, game gating via the existing
  running-game detection, per-game disable, blocklist file.
- Acceptance: `Shift+Tab` paints the panel over a borderless game in ≤150 ms; `Esc`
  returns focus; no overlay for disabled titles; no measurable idle cost.

### M2 — Performance HUD

- Metrics worker + `Performance` tab (FPS, frame-time graph, CPU, RAM, GPU, VRAM).
- Optional always-on mini HUD (native window if the WebView path fails validation).
- Acceptance: <0.5% CPU while active; numbers stay within ~2% of PresentMon for the
  same run; sampling fully stops when the game exits.

### M3 — Screenshots & Notes

- Screenshot gallery (reuse capture pipeline), capture button with the F12 hint, open
  folder, share; per-game notes with autosave in app data, editable in the overlay.
- Acceptance: a capture taken with F12 appears in the open overlay instantly; notes
  survive restarts and are per game.

### M4 — Achievements & game context

- Achievements tab from existing summaries (per store), progress and recent unlocks;
  Home tab session/playtime; quick actions routed through existing commands.
- Acceptance: the overlay shows the same numbers as the game page for a running title.

### M5 — Music & Discord

- Music tab via SMTC (artwork, transport, source picker).
- Discord tab: presence toggle + RPC voice read (`rpc` scope); mute/deafen only if
  Discord grants `rpc.voice.write`.
- Acceptance: Spotify playing on the desktop shows the correct track and responds to
  play/pause/next; the voice widget matches the Discord client's channel state.

### M6 — Polish

- Per-game overlay profiles, opacity/scale, gamepad navigation (reuse TV-mode focus
  patterns), 16-locale strings, docs, blocklist curation, HDR/color notes.

---

## 5. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Anti-cheat reactions to an external overlay | Low (no injection) | Per-game opt-out + blocklist; never inject/hook; document the model |
| Transparent WebView2 + click-through limitation | High (known) | Two-surface design: hidden panel for input, native mini-HUD for always-on |
| Exclusive fullscreen renders no overlay | Medium | Detect and inform; recommend borderless; not a v1 blocker |
| Focus stealing pauses some games | Medium | v1 takes focus (Game Bar model); per-game note; later explore `WS_EX_NOACTIVATE` + keyboard hook |
| ETW consumer complexity (FPS) | Medium | M0 spike; PresentMon service fallback |
| ETW session control needs admin/Performance Log Users | High (Windows rule) | One-time in-overlay "Enable" action (UAC) that adds the user to the group; clear sign-out hint; other metrics unaffected |
| GPU counters missing on some systems (old drivers, hybrid GPUs) | Medium | PDH per-PID with LUID matching; hide fields that have no data |
| Discord partner scopes for voice write | Medium | Read-only voice widget first; mute/deafen marked "if approved" |
| Spotify API restrictions | Solved | Use SMTC, not the Web API |
| HDR overlay looks washed out | Low/Medium | Document; SDR overlay over HDR is a later refinement |
| Overlay overhead on low-end PCs | Low | 1 Hz sampling, stop when idle, HUD off by default |

---

## 6. Open questions

1. Default hotkey: `Shift+Tab` matches Steam but collides when Steam's overlay is also
   enabled. Ship `Shift+Tab` with a conflict hint, or pick `Ctrl+Shift+Tab`?
2. Should the overlay work for games that are not in the library (unknown process), or
   only for tracked titles?
3. Always-on mini HUD default: off (on-demand) vs on for every game?
4. Blocklist model: ship a curated list, let testers contribute, or user-only opt-out?
5. Do we surface overlay metrics history (session graph) or live-only in v1?

---

## 7. References

- Steam overlay: partner docs (hooks D3D 7–12, OpenGL, Metal, Vulkan) —
  <https://partner.steamgames.com/doc/features/overlay>
- Steam overlay rendering internals — <https://aixxe.net/2017/09/steam-overlay-rendering>
- How in-game overlays work (present hooks, injection) —
  <https://fredemmott.com/blog/2022/05/31/in-game-overlays.html>
- Layered + click-through overlay window —
  <https://stackoverflow.com/questions/79748514/overlay-window-with-transparent-click-through-background>
- WebView2 transparency + click-through conflict (Wails #6088) —
  <https://github.com/wailsapp/wails/issues/6088>
- Tauri per-pixel click-through request (closed as duplicate) —
  <https://github.com/tauri-apps/tauri/issues/13070>
- BattlEye FAQ (non-cheat overlays generally supported) —
  <https://www.battleye.com/support/faq>
- External overlay without injection (Crosshair X anti-cheat notes) —
  <https://centerpointgaming.com/is-crosshair-x-safe.html>
- Intel PresentMon (ETW frame metrics, GPU Busy) —
  <https://github.com/GameTechDev/PresentMon>
- FerrisETW (Rust ETW consumer) — <https://github.com/n4r1b/ferrisetw>
- Windows GPU performance counters (PDH GPU Engine / GPU Process Memory) —
  <https://learn.microsoft.com/en-us/windows/win32/perfctrs/using-the-gpu-performance-counters>
- ETW session control permissions (StartTraceW → ERROR_ACCESS_DENIED) —
  <https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-starttracew>
- EnableTraceEx2 (keyword semantics, provider-enable permissions) —
  <https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-enabletraceex2>
- Private logger sessions (in-process/file-based; not for kernel providers) —
  <https://learn.microsoft.com/en-us/windows/win32/etw/configuring-and-starting-a-private-logger-session>
- Spotify Web API 2026 restrictions —
  <https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security>
- Windows media controls for Rust (`windows::Media::Control`, SMTC) —
  <https://microsoft.github.io/windows-docs-rs/doc/windows/Media/Control/index.html>
- Discord RPC commands/scopes (`GET_SELECTED_VOICE_CHANNEL`, `rpc`, `rpc.voice.*`) —
  <https://docs.discord.food/topics/rpc>,
  <https://docs.discord.com/developers/topics/oauth2>
- Discord Social SDK overview — <https://discord.com/developers/social-sdk>

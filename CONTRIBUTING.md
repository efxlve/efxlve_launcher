# Contributing

Efxlve Launcher is an open-source Epic Games launcher for Windows. The interface is TypeScript. The native side is Rust on Tauri 2. Installs and launches go through the `legendary` CLI.

Issues and pull requests are welcome. Read this file and [docs/DESIGN_SYSTEM.md](./docs/DESIGN_SYSTEM.md) before changing the interface. If an AI assistant writes the patch, it should follow [AGENTS.md](./AGENTS.md).

## Look and behavior

The app has one visual language. Do not restyle a screen to resemble another product.

- Background is true black (`#000`). The accent is white. Green, amber, and red mean status, not decoration.
- No decorative gradients, neon glow, gradient text, or glass blur on repeated cards.
- Do not turn every control into a full pill. Radius comes from the shared tokens.
- No emoji in the interface. Use the existing SVG icons, or add one in `src/core/icons.ts`.
- One line of text stays one line. Truncate with ellipsis. Descriptions clamp to two lines.
- Speeds, sizes, percentages, and durations use tabular numbers.
- Every control is keyboard-focusable and shows a visible focus ring. Do not scale a card on focus.
- The desktop UI is for a mouse and keyboard. Gamepad navigation belongs in TV Mode.
- New screens use the components in `src/styles/`. Do not invent a second button or card style.
- Copy is short and plain. No hype, no exclamation marks.

## Code

- Comments are English and explain why something exists.
- New interface work goes in `src/features/<name>/`. `src/main.ts` stays a thin bootstrap.
- Keep a source file under about 1,500 lines. Split it by responsibility when it grows past that.
- User-facing strings go through `src/locales/`. English and Turkish must both have the key. Other languages fall back to English until they are filled in.
- Tauri arguments are camelCase on the JavaScript side (`appName`, not `app_name`).
- Do not redraw the whole library when one card changes. Patch the card.
- On PowerShell, run npm as `npm.cmd`.

## Checks

```powershell
npm.cmd run build
cargo check
cargo test
```

`npm.cmd run build` must pass. New Rust behavior needs a unit test.

## Pull requests

Use a short commit message that says why the change exists. `feat:`, `fix:`, `perf:`, `refactor:`, and `docs:` are fine. One concern per pull request is easier to review.

Do not commit secrets, signing keys, or local launcher config.

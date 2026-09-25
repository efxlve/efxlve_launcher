# Contributing

Efxlve Launcher is an open-source Epic Games launcher for Windows. The interface is TypeScript. The native side is Rust on Tauri 2. Installs and launches go through the `legendary` CLI.

Issues and pull requests are welcome. Read this file and [docs/DESIGN_SYSTEM.md](./docs/DESIGN_SYSTEM.md) before changing the interface. If an AI assistant writes the patch, it should follow [AGENTS.md](./AGENTS.md).

The screenshots in the README are real windows of the app, stored in `docs/screenshots/`. Replace one when the screen it shows has changed. Do not add a mockup, a cropped marketing frame, or a shot that includes an account id.

## Look and behavior

The app has one visual language. A new screen uses the components already in `src/styles/`. Do not restyle one page so it resembles a different product.

- Background is true black (`#000`). The accent is white. Green, amber, and red mean status, not decoration.
- No decorative gradients, neon glow, gradient text, or glass blur on repeated cards.
- Do not turn every control into a full pill. Radius comes from the shared tokens.
- No emoji in the interface. Use the existing SVG icons, or add one in `src/core/icons.ts`.
- One line of text stays one line. Truncate with ellipsis. Descriptions clamp to two lines.
- Speeds, sizes, percentages, and durations use tabular numbers so a changing value does not shove the row sideways.
- Every control is keyboard-focusable and shows a visible focus ring. Do not scale a card on focus.
- The desktop UI is for a mouse and keyboard. A full-screen TV Mode for a controller is coming soon. Do not add a second controller layout on the desktop screens, and do not document TV Mode as something the app already has.
- Copy is short and plain. No hype, no exclamation marks.
- Confirmations use the launcher's own dialog. Do not call `window.confirm` or `window.alert`. WebView2 shows those as a browser box titled with the page address.

## Code

- Comments are English and explain why something exists.
- New interface work goes in `src/features/<name>/`. `src/main.ts` stays a thin bootstrap.
- Keep a source file under about 1,500 lines. Split it by responsibility when it grows past that.
- User-facing strings go through `src/locales/`. Add the key to every locale file. English is the source text. Turkish is a real translation. The other thirteen languages get a translation in the same change, so the catalogs stay aligned. If a key is missing at runtime, the UI falls back to English, then Turkish, then the key itself.
- Tauri arguments are camelCase on the JavaScript side (`appName`, not `app_name`). A mismatch fails quietly.
- Do not redraw the whole library when one card changes. Patch the card. Progress events update the button and the bar, not the grid.
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

Do not commit secrets, signing keys, account ids, or local launcher config. The updater signing key never goes in the repo.

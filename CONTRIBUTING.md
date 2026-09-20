# Contributing to Efxlve Launcher

Thank you for your interest in contributing to **Efxlve Launcher**!

Efxlve Launcher is an open-source alternative launcher for Epic Games on Windows, built with **Tauri v2 + Rust + Vanilla TypeScript**.

---

## 🎨 Design Guidelines & Aesthetics

Before submitting any frontend changes, please review our core aesthetic principles:

1. **PlayStation 5 Console Dark Aesthetic:**
   - Keep the dark, spacious obsidian and midnight blue atmosphere (`#07080d`, `#0b0d14`).
   - Clean, readable typography and subtle hairline borders (`rgba(255, 255, 255, 0.08)`).
   - High-contrast trophy counters (Platinum, Gold, Silver, Bronze).
2. **No "Generic AI Design" Clichés:**
   - **Prohibited:** Decorative purple→indigo→cyan gradients, neon box-shadow glows, gradient text (`background-clip: text`), and turning every button into a pill capsule (`border-radius: 999px`).
   - **Color signifies STATE only:** Green = Online / Ready, Amber = Updating / Offline, Red = Error / Destructive.
3. **10-Foot Controller Accessibility:**
   - Every interactive UI element must be navigable via Gamepad (Xbox / DualSense).
   - Provide clean `:focus-visible` focus rings (lavender / light blue).
   - Avoid mouse-only dropdowns or cramped layouts.

---

## 💻 Development Workflow

### Commands
Always use `npm.cmd` on Windows PowerShell to avoid execution policy errors:

```powershell
npm.cmd run tauri dev      # Recommended: full desktop app
npm.cmd run build          # Validate TypeScript and Vite build (zero errors required)
cargo check                # Fast Rust validation
cargo test                 # Rust unit tests (mandatory for new logic)
```

### Pull Request Guidelines
1. **TypeScript strictness:** Ensure `npm.cmd run build` passes with zero errors.
2. **Rust tests:** Any new IPC commands, CLI argument parser, or cache logic must include automated tests in `cargo test`.
3. **Commit convention:** Use semantic commits (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`).

---

## 📜 AI Agent Guidelines
If you are an AI assistant helping a contributor, please read **[AGENTS.md](./AGENTS.md)** first. It contains critical operational invariants (camelCase Tauri parameters, stdout vs stderr handling, null serialization, and render disciplines).

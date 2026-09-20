# Architecture & Technical Design — Efxlve Launcher

This document describes the high-level architecture, subsystem boundaries, data flow pipelines, and design decisions of the **Efxlve Launcher**.

---

## 1. High-Level System Architecture

Efxlve Launcher is built on **Tauri v2**, combining a lightweight native **Rust** backend with a modern, frameworkless **Vite + TypeScript** frontend.

```mermaid
graph TD
    subgraph Frontend ["Frontend (Vite + TypeScript)"]
        UI[PlayStation 5 Console Dark UI]
        Router[View Router - Library / Downloads / Profile / Settings]
        PChunk[Progressive Chunk Renderer & Virtual Sentinel]
        GamepadMgr[10-ft Gamepad Navigation & HUD]
        State[In-Memory Reactive State]
    end

    subgraph IPC ["Tauri v2 IPC Layer"]
        Invoker[tauri::invoke]
        Events[tauri::emit & listen]
    end

    subgraph Backend ["Rust Backend (src-tauri)"]
        Cmds[Legendary Tauri Commands]
        Transfers[Download Queue & Process Runner]
        Screenshots[In-Game F12 Hook & WebP/AVIF Compressor]
        CacheMgr[Local Cache & Manifest Reader]
    end

    subgraph External ["External Services & Binaries"]
        LegendaryCLI["legendary CLI (Python/GPL-3.0)"]
        EpicAPI["Epic Online Services (EOS) & GraphQL"]
        SteamGrid["SteamGridDB API"]
        StoreWV["Native Child Webview (store.epicgames.com)"]
    end

    UI --> Router
    Router --> PChunk
    Router --> GamepadMgr
    UI --> State
    State <--> Invoker
    Events --> State

    Invoker --> Cmds
    Cmds --> CacheMgr
    Cmds --> Transfers
    Cmds --> Screenshots

    Transfers --> LegendaryCLI
    Cmds --> LegendaryCLI
    Cmds --> EpicAPI
    Cmds --> SteamGrid
    Cmds --> StoreWV
    LegendaryCLI --> Events
    Transfers --> Events
```

---

## 2. Core Data Flow: "Cache-First, Async Network Sync" (Heroic Model)

To guarantee instantaneous startup (<100ms) with zero network blocking:
1. **Stage 1 (Immediate Disk Hydration):** On launch, `epic_cached_library` reads local `%USERPROFILE%\.config\legendary\` files (`user.json`, `installed.json`, `metadata/*.json`, `skipped.json`) directly from NVMe/SSD into memory. The entire library renders immediately.
2. **Stage 2 (Silent Background Sync):** `syncEpicLibrary(false)` runs asynchronously via `tokio`. It queries `legendary list`, downloads updated manifests, and updates local state without interrupting the user.
3. **Stage 3 (Progressive Reactive Updates):** As achievements (`epic_get_achievements_summary`) and available game updates (`epic_check_updates`) resolve in the background, `scheduleRender()` batches these updates on `requestAnimationFrame` boundaries without jarring full re-renders.

```mermaid
sequenceDiagram
    participant UI as Webview Frontend
    participant Rust as Tauri Rust Backend
    participant Disk as Local Legendary Config
    participant Epic as Epic Games API

    UI->>Rust: epic_cached_library()
    Rust->>Disk: Read user.json, installed.json, metadata/
    Disk-->>Rust: Cached data
    Rust-->>UI: CachedLibrary (instant)
    UI->>UI: Render First 48 Cards (<5ms)

    par Background Sync
        UI->>Rust: syncEpicLibrary(false)
        Rust->>Epic: Check catalog & ownership
        Epic-->>Rust: Fresh metadata
        Rust->>Disk: Write updated caches
        Rust-->>UI: Updated library data
        UI->>UI: scheduleRender() (smooth batching)
    end
```

---

## 3. Key Subsystems & Design Invariants

### 3.1 Progressive Chunk Rendering (Virtual Sentinel)
- Managing 488+ games in a flat DOM would create **7,300+ DOM nodes**, consuming hundreds of megabytes of RAM and locking up during CSS filter/sort changes.
- Instead, the library employs **Progressive Chunking**:
  - The initial viewport renders **48 cards**.
  - A 24px invisible `#lib-scroll-sentinel` is placed at the grid bottom.
  - A native `IntersectionObserver` detects when the user scrolls near the end and seamlessly appends chunks of **36 cards** via `sentinel.insertAdjacentHTML("beforebegin", ...)`.
  - Search keystrokes are protected by a **120ms debounce**, guaranteeing snappy input feedback.

### 3.2 10-Foot Gamepad Navigation
- Supports Xbox, DualSense (PS5), and generic DirectInput controllers via the standard Web Gamepad API.
- Polling runs at requestAnimationFrame cadence with deadzone handling (axes: ±0.55).
- Spatial navigation calculates candidate directional vectors with zero forced layout thrashing using `el.offsetParent !== null` rather than expensive `getComputedStyle()`.
- When navigating down near the boundary, dynamic chunk loading is automatically invoked, providing seamless infinite controller scrolling.

### 3.3 Embedded Child Webview (Epic Games Store)
- Epic Games Store uses `X-Frame-Options: SAMEORIGIN`, precluding iframe embedding.
- Tauri's native `add_child` API embeds a child webview covering the main viewport below the 56px titlebar.
- OS resize synchronization is managed through the native Windows `tauri::WindowEvent::Resized` event hook to eliminate black borders during window snapping or maximizing.

### 3.4 Hardware-Accelerated Screenshot & Performance Pipeline
- In-game screenshot capture runs through a dedicated low-priority background thread in `src-tauri/src/legendary/screenshots.rs`.
- When no game is running, thread wakeups sleep for 250ms (reducing idle CPU consumption by 92%).
- Screenshots can be converted to compressed WebP/AVIF asynchronously off the UI thread.

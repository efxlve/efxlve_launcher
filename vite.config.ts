import { defineConfig } from "vite";

// Tauri-friendly Vite setup: the dev server keeps the fixed port 1420.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Keep cargo's target/ out of the watcher (Windows EBUSY).
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM ? "chrome105" : "esnext",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Measured with the 0.1.17 tree: ~570 kB minified / ~158 kB gzip in one entry
    // chunk. The remaining mass is our own feature code (core API wrappers, drawer
    // and event handlers), so a deeper split needs dynamic imports at the handler
    // level — tracked in ROADMAP 6.3. Keep the limit honest instead of silencing it.
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      input: {
        main: "index.html",
        // The in-game overlay is its own webview entry so the launcher bundle
        // does not carry it (see docs/OVERLAY_ROADMAP.md).
        overlay: "overlay.html",
      },
      output: {
        // Split third-party code out of the app chunk: it stays cacheable between
        // updates and keeps the entry smaller on the low-end reference hardware.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("lucide")) return "icons";
          return "vendor";
        },
      },
    },
  },
});

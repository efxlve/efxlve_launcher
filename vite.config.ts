import { defineConfig } from "vite";

// Tauri ile uyumlu Vite ayarı: dev sunucusu sabit 1420 portunda çalışır.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // cargo'nun target/ çıktılarını izleyip çökmemesi için (Windows EBUSY)
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM ? "chrome105" : "esnext",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});

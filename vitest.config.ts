import { defineConfig } from "vitest/config";

// Unit tests for the framework-free core. The DOM is real enough for
// `localStorage` and `navigator`, which `core/state.ts` reads at import time.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});

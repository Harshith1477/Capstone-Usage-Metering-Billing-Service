import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});

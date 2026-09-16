import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    hookTimeout: 30000,
    testTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});

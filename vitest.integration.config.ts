import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/__tests__/integration/**/*.test.ts"],
    testTimeout: 30_000, // Docker startup + NATS warmup
    hookTimeout: 60_000, // beforeAll Docker setup
    globals: true,
    // No jsdom — integration tests run in Node
  },
});

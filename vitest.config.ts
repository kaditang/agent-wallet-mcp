import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    // Tests share the in-memory STORE in sign-store; run sequentially so they
    // don't trample each other's stash.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 10_000,
  },
})

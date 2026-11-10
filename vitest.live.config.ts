import { defineConfig } from 'vitest/config'

/** Tests that talk to Polygon mainnet and the CoW order book. Run with `npm run live`. */
export default defineConfig({
  test: { include: ['tests/live/**/*.test.ts'], testTimeout: 60_000, fileParallelism: false },
})

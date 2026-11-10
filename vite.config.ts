import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: false },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 5000,
    sequence: { shuffle: true },
    coverage: {
      provider: 'v8',
      include: ['src/core/**'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 90, branches: 80 },
    },
  },
})

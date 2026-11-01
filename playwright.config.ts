import { defineConfig } from '@playwright/test'

// E2E drives the unfused dev build (out/main/index.js) via _electron; run `npm run build` first.
export default defineConfig({
  testDir: 'tests',
  testMatch: ['e2e/**/*.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results'
})

import { defineConfig } from '@playwright/test'

// `npm run test:soak` (kept out of the default config so `npm test` stays fast). Run `npm run build` first.
export default defineConfig({
  testDir: 'tests/soak',
  testMatch: ['**/*.spec.ts'],
  timeout: 15 * 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results'
})

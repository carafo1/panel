/**
 * Browser end-to-end tests for the main customer flows (tests/e2e).
 *
 *   E2E_BUILD=1 bun run test:e2e   first run: production build, then tests
 *   bun run test:e2e               later runs reuse the build in .next
 *
 * The panel runs against a throwaway SQLite database seeded by
 * tests/e2e/seed.ts, with every third-party credential blanked and all server
 * work simulated (see tests/e2e/env.ts and tests/e2e/start-server.ts).
 * One worker: the specs share one seeded customer and one server.
 */
import { defineConfig, devices } from '@playwright/test'
import { BASE_URL, CUSTOMER_STATE } from './tests/e2e/fixtures'

const CI = !!process.env.CI

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  // A retry would hide a real intermittent failure; investigate instead.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['github']]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: CUSTOMER_STATE,
      },
    },
  ],
  webServer: {
    command: 'bun tests/e2e/start-server.ts',
    // The status page renders server-side and touches the database, so a
    // 200 here means the app is really serving (there is no /api/health).
    url: `${BASE_URL}/status`,
    // A local `next build` (E2E_BUILD=1) can take several minutes.
    timeout: (process.env.E2E_BUILD === '1' ? 15 : 3) * 60_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})

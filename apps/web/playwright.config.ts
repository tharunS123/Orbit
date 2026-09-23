import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the local stack (`pnpm db:start`, then `pnpm dev:web` — or let
 * Playwright start the web server). A setup project signs up a fresh throwaway user through the
 * real signup form; specs reuse its session.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.E2E_BASE_URL ? undefined : { command: 'pnpm dev', url: baseURL, reuseExistingServer: true, timeout: 120_000 },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/user.json' }, dependencies: ['setup'], testIgnore: /auth\.setup\.ts/ },
  ],
});

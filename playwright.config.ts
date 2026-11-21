import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests.
 *
 * - "web" drives the production build in Chromium at 2x screen density, so any
 *   export that depended on the display would be caught.
 * - "desktop" drives the same build inside the Electron shell.
 *
 * Run `pnpm test:e2e`. Set PW_CHANNEL=chrome to use an installed Google Chrome
 * instead of Playwright's own Chromium.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'web', testMatch: /web\..*\.spec\.ts$/ },
    { name: 'desktop', testMatch: /desktop\..*\.spec\.ts$/ },
  ],
});

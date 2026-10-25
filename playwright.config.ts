import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: real browsers at phone and laptop sizes, against the Worker running locally on the real Workers
 * runtime (`wrangler dev`), backed by Postgres. Needs the dev database (docs/DATABASE.md) and DEV_LOGIN on.
 */
export default defineConfig({
  testDir: 'packages/web/tests',
  testMatch: '**/*.e2e.ts',
  outputDir: 'test-results',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    // 127.0.0.1 rather than localhost: the app skips the service worker on "localhost" during development,
    // and these tests want the real thing.
    baseURL: 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    { name: 'laptop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'npx wrangler dev --port 8787 --ip 127.0.0.1',
    cwd: 'packages/api',
    url: 'http://127.0.0.1:8787/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

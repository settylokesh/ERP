import { defineConfig } from '@playwright/test';

// Runs the built web app served by the API against a fresh in-memory database loaded with the sample-company fixture.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4100',
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: [
    {
      // Sample company for the business-flow tests.
      command: 'cd ../server && PORT=4100 npx tsx test/e2e-server.ts',
      url: 'http://localhost:4100/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // A brand-new, empty installation for the first-run setup test.
      command: 'cd ../server && DB_FILE=:memory: PORT=4101 SETUP_TOKEN=E2E-SETUP-CODE npx tsx src/index.ts',
      url: 'http://localhost:4101/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});

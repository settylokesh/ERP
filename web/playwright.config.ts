import { defineConfig } from '@playwright/test';

// Runs the built web app served by the API against a fresh in-memory demo database.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4100',
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: 'cd ../server && DB_FILE=:memory: PORT=4100 npx tsx src/index.ts',
    url: 'http://localhost:4100/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

// End-to-end tests: the real app in a real browser.
// Uses an installed browser instead of downloading one: Microsoft Edge on Windows, Chrome elsewhere.
// Override with PW_CHANNEL=chrome / msedge, or PW_CHANNEL=chromium after `npx playwright install chromium`.
import { defineConfig } from '@playwright/test';

const PORT = 5174; // separate from the usual 5173, so tests never touch a running app or its data
const channel = process.env.PW_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chrome');

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...(channel === 'chromium' ? {} : { channel }),
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: 'node server.js',
    url: `http://localhost:${PORT}/api/config`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

import { defineConfig } from '@playwright/test';

const port = process.env.OVERFLOWLENS_TEST_PORT ?? '4173';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL, browserName: 'chromium' },
  webServer: {
    command: `npm run preview -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});

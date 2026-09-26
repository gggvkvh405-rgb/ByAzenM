import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3000' },
  webServer: {
    command: 'node server/index.js',
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: true,
    timeout: 30000
  }
});

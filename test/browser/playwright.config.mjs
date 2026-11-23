import { defineConfig, devices } from '@playwright/test';

const port = 4196;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  timeout: 120000,
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:' + port },
  projects: [
    { name: 'chromium', testMatch: 'chromium.spec.mjs', use: { ...devices['Desktop Chrome'],
      launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } } },
    { name: 'webkit', testMatch: 'webkit.spec.mjs', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: { command: 'node server.mjs ' + port, url: 'http://127.0.0.1:' + port + '/stitched/audio.m3u8' },
});

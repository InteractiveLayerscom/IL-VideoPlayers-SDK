import { defineConfig, devices } from '@playwright/test';

// IL_BROWSER_PORT runs a second checkout's tests beside another one already serving on 4196.
const port = Number(process.env.IL_BROWSER_PORT) || 4196;
// The opt-in run over a real MediaTailor stream: only with IL_STITCHED_REAL_URL (its session-initialising master) and
// IL_STITCHED_REAL_PLAN (the plan IL built for it). The page is opened on localhost, the origin the test bucket's CORS
// rule allows.
const real = process.env.IL_STITCHED_REAL_URL ? [
  { name: 'mediatailor-chromium', testMatch: 'mediatailor-chromium.spec.mjs', use: { ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:' + port, launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } } },
  { name: 'mediatailor-webkit', testMatch: 'mediatailor-webkit.spec.mjs', use: { ...devices['Desktop Safari'],
    baseURL: 'http://localhost:' + port } },
] : [];

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
    ...real,
  ],
  webServer: { command: 'node server.mjs ' + port, url: 'http://127.0.0.1:' + port + '/stitched/audio.m3u8' },
});

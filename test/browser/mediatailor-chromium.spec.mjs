import { realProductChecks } from './stitched-checks.mjs';

// hls.js, Shaka and Video.js (VHS) in Chromium over a real MediaTailor session (opt-in, see playwright.config.mjs).
for (const player of ['hls', 'shaka', 'videojs']) realProductChecks(player);

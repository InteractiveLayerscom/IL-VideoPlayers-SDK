import { realProductChecks } from './stitched-checks.mjs';

// WebKit's own HLS over a real MediaTailor session, through its explicit session (opt-in, see playwright.config.mjs).
realProductChecks('native');

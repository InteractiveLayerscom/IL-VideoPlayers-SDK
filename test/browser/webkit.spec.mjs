import { containerChecks, renditionChecks, stitchedChecks } from './stitched-checks.mjs';

// WebKit's own HLS (Safari's engine, as Playwright builds it for macOS).
stitchedChecks('native');
renditionChecks('native', { failsClosed: true });
containerChecks('native');

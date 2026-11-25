import { fontChecks } from './fonts-checks.mjs';
import { containerChecks, productChecks, renditionChecks, stitchedChecks } from './stitched-checks.mjs';

fontChecks();

// WebKit's own HLS (Safari's engine, as Playwright builds it for macOS).
stitchedChecks('native');
renditionChecks('native', { failsClosed: true });
containerChecks('native');
productChecks('native');

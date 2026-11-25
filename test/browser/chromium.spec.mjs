import { fontChecks } from './fonts-checks.mjs';
import { hostBreakChecks } from './host-break-checks.mjs';
import { containerChecks, productChecks, plainChecks, renditionChecks, stitchedChecks } from './stitched-checks.mjs';

fontChecks();
hostBreakChecks();

// Media Source players: hls.js, Shaka and Video.js (VHS) in Chromium.
for (const player of ['hls', 'shaka', 'videojs']) {
  stitchedChecks(player);
  renditionChecks(player);
  containerChecks(player);
  productChecks(player);
}
// hls.js and Shaka on their own, over the playlists IL serves.
for (const player of ['hls', 'shaka']) for (const stream of ['master', 'multi']) plainChecks(player, stream);

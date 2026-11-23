import { containerChecks, plainChecks, renditionChecks, stitchedChecks } from './stitched-checks.mjs';

// Media Source players: hls.js, Shaka and Video.js (VHS) in Chromium.
for (const player of ['hls', 'shaka', 'videojs']) {
  stitchedChecks(player);
  renditionChecks(player);
  containerChecks(player);
}
// hls.js and Shaka on their own, over the playlists IL serves.
for (const player of ['hls', 'shaka']) for (const stream of ['master', 'multi']) plainChecks(player, stream);

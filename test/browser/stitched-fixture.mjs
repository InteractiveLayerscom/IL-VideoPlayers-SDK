// Stitched HLS streams as MediaTailor personalizes them, made with ffmpeg for the browser tests.
// Content (30 s): each 2 s segment shows its number plus one in binary as four black or white vertical bands
// (band k white when bit k is set), so a frame tells which content segment is on screen whatever the browser's
// color conversion; its sound is a 440 Hz tone. Ads: flat red with a 1000 Hz tone. Stream (master.m3u8):
// pre-roll 0–4, content 0–14 at 4–18, mid-roll 18–22, content 14–30 at 22–38. Content segments carry the PDT IL
// writes (pdt_origin + content start) and the #EXT-X-ASSET marker MediaTailor keeps; ad segments sit between
// discontinuities without PDT, wrapped in the DATERANGE and CUE-OUT / CUE-OUT-CONT / CUE-IN lines MediaTailor
// writes when ad markers are on. As in a real MediaTailor session, the playlist opens with a discontinuity before the
// pre-roll, and master.m3u8 names its variant relative to itself in another directory (session/v.m3u8), as
// MediaTailor's `../../../manifest/…/0.m3u8` does: a variant URI resolved against the wrong base names nothing.
// - multi.m3u8: two renditions of one session whose ads differ in length (4.0 s and 4.2 s each), as when
//   MediaTailor transcodes an ad per rendition.
// - audio.m3u8: video without sound plus a separate audio rendition (EXT-X-MEDIA), both stitched.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ORIGIN = '2000-01-01T00:00:00.000Z';
const BANDS = "geq=lum='16+219*mod(floor((floor(T/2)+1)/pow(2,floor(X/40))),2)':cb=128:cr=128";

function ffmpeg(dir, args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { cwd: dir });
}

const video = ['-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p', '-g', '25',
  '-keyint_min', '25', '-sc_threshold', '0'];
const audio = ['-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '64k'];
// `mode`: 'ts' (one file per segment), 'single' (one MPEG-TS file, #EXT-X-BYTERANGE per segment) or 'fmp4'
// (fragmented MP4 with its #EXT-X-MAP initialization segment).
const hls = (time, pattern, name, mode) => ['-f', 'hls', '-hls_time', String(time), '-hls_playlist_type', 'vod',
  ...(mode === 'single' ? ['-hls_flags', 'single_file'] : []),
  ...(mode === 'fmp4' ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', name.replace('.m3u8', '-init.mp4')] : []),
  '-hls_segment_filename', pattern, name];

// Encodes one part: `picture` (a lavfi color or null) through `filter`, `tone` (Hz or null), seconds, segment length.
// Returns its segments ({ extinf, tags, uri }: `tags` are the lines between #EXTINF and the URI, a byte range) and
// its #EXT-X-MAP line, if any.
function part(dir, { picture, filter, tone, seconds, length, pattern, name, mode = 'ts' }) {
  const inputs = [];
  if (picture) inputs.push('-f', 'lavfi', '-i', `${picture}:s=160x90:r=25:d=${seconds}`);
  if (tone) inputs.push('-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=48000:duration=${seconds}`);
  ffmpeg(dir, [...inputs, ...(filter ? ['-vf', filter] : []), ...(picture ? video : ['-vn']), ...(tone ? audio : ['-an']), '-t', String(seconds),
    ...hls(length, mode === 'single' ? pattern.replace(/-%02d/, '') : pattern.replace('.ts', mode === 'fmp4' ? '.m4s' : '.ts'), name, mode)]);
  const lines = readFileSync(join(dir, name), 'utf8').split('\n');
  const segments = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXTINF:')) return;
    let j = i + 1;
    const tags = [];
    while (lines[j]?.startsWith('#')) tags.push(lines[j++]);
    segments.push({ extinf: line, tags, uri: lines[j] });
  });
  segments.map = lines.find((line) => line.startsWith('#EXT-X-MAP:')) ?? null;
  return segments;
}

// A stitched media playlist from content segments and the ad pod's segments.
function stitch(content, ad, tag = '', prefix = '') {
  const pdt = (seconds) => new Date(Date.parse(ORIGIN) + seconds * 1000).toISOString();
  const length = (segment) => Number.parseFloat(segment.extinf.slice(8));
  const podLength = ad.reduce((sum, segment) => sum + length(segment), 0).toFixed(3);
  const out = ['#EXTM3U', `#EXT-X-VERSION:${content.map ? 7 : 4}`, '#EXT-X-TARGETDURATION:3', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-DISCONTINUITY-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  const pod = (id, at) => {
    if (ad.map) out.push(ad.map);
    out.push(`#EXT-X-DATERANGE:ID="${id}",START-DATE="${pdt(at)}",DURATION=${podLength}`, `#EXT-X-CUE-OUT:${podLength}`);
    let elapsed = 0;
    ad.forEach((segment, i) => {
      if (i) out.push(`#EXT-X-CUE-OUT-CONT:ElapsedTime=${elapsed.toFixed(3)},Duration=${podLength}`);
      out.push(segment.extinf, ...segment.tags, prefix + segment.uri);
      elapsed += length(segment);
    });
    out.push('#EXT-X-CUE-IN');
  };
  let at = 0;
  const play = (from, to, marker) => {
    if (content.map) out.push(content.map);
    content.slice(from, to).forEach((segment, i) => {
      out.push('#EXT-X-PROGRAM-DATE-TIME:' + pdt(at));
      if (!i && marker) out.push(`#EXT-X-ASSET:IL_ASSET=asset-1,IL_CUE=${at},IL_BREAK=${marker},IL_POS=midroll`);
      out.push(segment.extinf, ...segment.tags, prefix + segment.uri + tag);
      at += length(segment);
    });
  };
  out.push('#EXT-X-DISCONTINUITY');
  pod('pre', -4);
  out.push('#EXT-X-DISCONTINUITY');
  play(0, 7, null);
  out.push('#EXT-X-DISCONTINUITY');
  pod('mid', 14);
  out.push('#EXT-X-DISCONTINUITY');
  play(7, 15, 2);
  out.push('#EXT-X-ENDLIST', '');
  return out.join('\n');
}

const CODECS = 'avc1.42e01e,mp4a.40.2';

export function makeStitched(dir) {
  if (existsSync(join(dir, 'session', 'v.m3u8'))) return dir;
  mkdirSync(join(dir, 'session'), { recursive: true });
  const content = part(dir, { picture: 'color=c=black', filter: BANDS,
    tone: 440, seconds: 30, length: 2, pattern: 'c-%02d.ts', name: 'content.m3u8' });
  const ad = part(dir, { picture: 'color=c=red', tone: 1000, seconds: 4, length: 2, pattern: 'a-%02d.ts', name: 'ad.m3u8' });
  const longer = part(dir, { picture: 'color=c=red', tone: 1000, seconds: 4.2, length: 2.1, pattern: 'b-%02d.ts', name: 'ad-long.m3u8' });
  writeFileSync(join(dir, 'v.m3u8'), stitch(content, ad));
  // Each rendition has its own content segment URIs, as real renditions do (here the same files).
  writeFileSync(join(dir, 'v-long.m3u8'), stitch(content, longer, '?rendition=long'));
  writeFileSync(join(dir, 'session', 'v.m3u8'), stitch(content, ad, '', '../'));
  writeFileSync(join(dir, 'master.m3u8'),
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,CODECS="${CODECS}"\nsession/v.m3u8\n`);
  writeFileSync(join(dir, 'multi.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n' +
    `#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,CODECS="${CODECS}"\nv.m3u8\n` +
    `#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=160x90,CODECS="${CODECS}"\nv-long.m3u8\n`);
  const silentContent = part(dir, { picture: 'color=c=black', filter: BANDS,
    tone: null, seconds: 30, length: 2, pattern: 'cv-%02d.ts', name: 'content-video.m3u8' });
  const silentAd = part(dir, { picture: 'color=c=red', tone: null, seconds: 4, length: 2, pattern: 'av-%02d.ts', name: 'ad-video.m3u8' });
  const soundContent = part(dir, { picture: null, tone: 440, seconds: 30, length: 2, pattern: 'ca-%02d.ts', name: 'content-audio.m3u8' });
  const soundAd = part(dir, { picture: null, tone: 1000, seconds: 4, length: 2, pattern: 'aa-%02d.ts', name: 'ad-audio.m3u8' });
  writeFileSync(join(dir, 'video-only.m3u8'), stitch(silentContent, silentAd));
  writeFileSync(join(dir, 'audio-only.m3u8'), stitch(soundContent, soundAd));
  writeFileSync(join(dir, 'audio.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="main",DEFAULT=YES,AUTOSELECT=YES,URI="audio-only.m3u8"\n' +
    `#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,CODECS="${CODECS}",AUDIO="aud"\nvideo-only.m3u8\n`);
  // The same stream as one MPEG-TS file per part with byte ranges, and as fragmented MP4.
  for (const mode of ['single', 'fmp4']) {
    const tagged = part(dir, { picture: 'color=c=black', filter: BANDS, tone: 440, seconds: 30, length: 2,
      pattern: `${mode}-c-%02d.ts`, name: `${mode}-content.m3u8`, mode });
    const tagAd = part(dir, { picture: 'color=c=red', tone: 1000, seconds: 4, length: 2, pattern: `${mode}-a-%02d.ts`,
      name: `${mode}-ad.m3u8`, mode });
    writeFileSync(join(dir, `${mode}-v.m3u8`), stitch(tagged, tagAd));
    writeFileSync(join(dir, `${mode === 'single' ? 'ranges' : 'fmp4'}.m3u8`), `#EXTM3U\n#EXT-X-VERSION:${mode === 'fmp4' ? 7 : 4}\n` +
      `#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,CODECS="${CODECS}"\n${mode}-v.m3u8\n`);
  }
  return dir;
}

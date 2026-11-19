// Generates an 18-second test card with two static creative assets on the publisher's own origin.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [folder, address] = process.argv.slice(2);
if (!folder || !address)
  throw new Error(
    'Uso: node examples/make-hls.mjs DIRECTORIO_VACIO https://origen.example/prueba/',
  );
const origin = new URL(address);
if (
  origin.protocol !== 'https:' ||
  !origin.pathname.endsWith('/') ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash
) {
  throw new Error('Configurá la URL HTTPS del directorio con barra final');
}
const dir = resolve(folder);
await mkdir(dir, { recursive: true });
if ((await readdir(dir)).length) throw new Error('El directorio de salida debe estar vacío');
function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { cwd: dir });
}
ffmpeg([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=512x288:rate=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=44100',
  '-t',
  '18',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-g',
  '48',
  '-sc_threshold',
  '0',
  '-c:a',
  'aac',
  '-f',
  'hls',
  '-hls_time',
  '2',
  '-hls_playlist_type',
  'vod',
  '-hls_flags',
  'independent_segments',
  '-hls_segment_filename',
  'seg-%02d.ts',
  'base.m3u8',
]);
ffmpeg([
  '-f',
  'lavfi',
  '-i',
  'color=0x11888a:size=720x108',
  '-vf',
  'drawbox=x=12:y=12:w=60:h=84:color=white:t=fill',
  '-frames:v',
  '1',
  'super.png',
]);
ffmpeg([
  '-f',
  'lavfi',
  '-i',
  'color=0x163135:size=960x540',
  '-vf',
  'drawbox=x=720:y=0:w=240:h=540:color=0x16958f:t=fill,drawbox=x=0:y=405:w=960:h=135:color=0xdd8741:t=fill',
  '-frames:v',
  '1',
  'l.jpg',
]);

const epoch = Date.now();
const date = (offset) => new Date(epoch + offset * 1000).toISOString();
const cues = [
  { id: 'super-1', format: 'super', start: 3, end: 7, asset: 'super.png', mime: 'image/png' },
  { id: 'l-1', format: 'l', start: 10, end: 15, asset: 'l.jpg', mime: 'image/jpeg' },
];
const base = await readFile(join(dir, 'base.m3u8'), 'utf8');
for (const native of [false, true]) {
  const tags = ['#EXT-X-PROGRAM-DATE-TIME:' + date(0)];
  for (const c of cues) {
    const attrs = [
      'ID="' + c.id + '"',
      'CLASS="' + (native ? 'com.apple.hls.interstitial' : 'com.interactivelayers.overlay') + '"',
      'START-DATE="' + date(c.start) + '"',
      'DURATION=' + (c.end - c.start),
      'X-ASSET-URI="' + new URL(c.asset, origin).href + '"',
      'X-ASSET-MIMETYPE="' + c.mime + '"',
    ];
    if (native) {
      attrs.push('X-OVERLAY-ID="' + c.id + '"', 'X-VIEWPORT="1920x1080"');
      if (c.format === 'l') attrs.push('X-DEPTH=-1', 'X-SQUEEZECURRENT=0.75');
      else attrs.push('X-OVERLAY-POSITION="240x756"', 'X-OVERLAY-SIZE="1440x216"');
    } else attrs.push('X-IL-FORMAT="' + c.format + '"');
    tags.push('#EXT-X-DATERANGE:' + attrs.join(','));
  }
  await writeFile(
    join(dir, native ? 'shaka-native.m3u8' : 'il.m3u8'),
    base.replace('#EXTINF:', tags.join('\n') + '\n#EXTINF:'),
  );
}
console.log('Prueba local de 18 s lista en ' + dir);

// Serves the SDK (web/, node_modules/, test/browser/) and the stitched fixture on 127.0.0.1 only.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { makeStitched } from './stitched-fixture.mjs';

const root = resolve(import.meta.dirname, '../..');
const fixture = makeStitched(process.env.IL_STITCHED_FIXTURE || resolve(tmpdir(), 'il-sdk-stitched-fixture'));
const types = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'application/javascript', '.js': 'application/javascript',
  '.css': 'text/css', '.woff2': 'font/woff2', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const stitched = url.pathname.startsWith('/stitched/');
  const base = stitched ? fixture : root;
  const path = resolve(base, '.' + (stitched ? url.pathname.slice('/stitched'.length) : url.pathname));
  if (!path.startsWith(base + sep)) return res.writeHead(404).end();
  try {
    const { size } = statSync(path);
    // Byte ranges, for the single-file playlists (#EXT-X-BYTERANGE).
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end) return res.writeHead(416, { 'Content-Range': 'bytes */' + size }).end();
    res.writeHead(match ? 206 : 200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream',
      'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    createReadStream(path, { start, end }).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
}).listen(Number(process.argv[2]), '127.0.0.1');

// The content clocks fail closed: what does not look like IL's clock, or cannot be placed, is never content.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hlsContentClock, nativeHlsContentClock, parseMediaPlaylist, shakaContentClock, videoJsContentClock,
} from '../web/ads.mjs';
import { layoutSegments } from '../web/content-clock.mjs';

const ORIGIN = '2000-01-01T00:00:00.000Z';
const at = (seconds, origin = ORIGIN) => new Date(Date.parse(origin) + seconds * 1000).toISOString();
const plan = (extra = {}) => ({ timeline: { kind: 'stitched', pdt_origin: ORIGIN }, duration: 60, ...extra });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// A playlist from [duration, content second | null (ad) | ISO PDT] items.
function playlist(items) {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:VOD'];
  let n = 0;
  let wasAd = null;
  for (const [duration, content] of items) {
    const ad = content === null;
    if (wasAd !== null && ad !== wasAd) lines.push('#EXT-X-DISCONTINUITY');
    wasAd = ad;
    if (!ad) lines.push('#EXT-X-PROGRAM-DATE-TIME:' + (typeof content === 'string' ? content : at(content)));
    lines.push(`#EXTINF:${duration.toFixed(3)},`, `s${n++}.ts`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
// Pre-roll 4, content 0–10, mid-roll 4, content 10–20.
const STANDARD = [[2, null], [2, null], [5, 0], [5, 5], [2, null], [2, null], [5, 10], [5, 15]];
// The same session in another rendition, its ads 0.2 s longer each.
const LONGER = [[2.1, null], [2.1, null], [5, 0], [5, 5], [2.1, null], [2.1, null], [5, 10], [5, 15]];
// Another rendition whose mid-roll alone is 0.2 s longer.
const MID_LONGER = [[2, null], [2, null], [5, 0], [5, 5], [2.1, null], [2.1, null], [5, 10], [5, 15]];

function shaka(texts, variants = null) {
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, playbackRate: 1, buffered: { length: 0 } });
  const filters = new Set();
  const network = { registerResponseFilter: (fn) => filters.add(fn), unregisterResponseFilter: (fn) => filters.delete(fn) };
  const events = [];
  const player = Object.assign(new EventTarget(), {
    active: 'https://s.example/v0.m3u8',
    getNetworkingEngine: () => network, getMediaElement: () => video, getManifest: () => null,
    getVariantTracks: () => (variants ?? [player.active]).map((uri) => ({ active: uri === player.active, originalVideoId: uri })),
  });
  const clock = shakaContentClock({ player, plan: plan(), onEvent: (event) => events.push(event) });
  for (const [uri, text] of Object.entries(texts))
    for (const fn of filters) fn(0, { uri, originalUri: uri, data: new TextEncoder().encode(text).buffer });
  const read = (t, rate = 1) => {
    Object.assign(video, { currentTime: t, playbackRate: rate });
    return clock.time();
  };
  // A segment download, with the request context Shaka gives: its placement, first byte and stream (null: none).
  const segment = (uri, startTime, endTime, { startByte = 0, type = 'video' } = {}) => {
    const context = { segment: { startTime, endTime, startByte }, ...(type ? { stream: { type } } : {}) };
    for (const fn of filters) fn(1, { uri, originalUri: uri }, context);
  };
  return { clock, video, player, read, events, segment };
}

test('a PDT before the origin (a publisher clock from 1999) or past the video is never content', () => {
  const before = layoutSegments(parseMediaPlaylist(playlist([[5, at(0, '1999-06-01T00:00:00Z')], [5, at(5, '1999-06-01T00:00:00Z')]])),
    { origin: Date.parse(ORIGIN), duration: 60 });
  assert.deepEqual(before.map((s) => s.kind), ['unknown', 'unknown']);
  const past = layoutSegments(parseMediaPlaylist(playlist([[5, 50], [5, 55], [5, 60]])), { origin: Date.parse(ORIGIN), duration: 60 });
  assert.deepEqual(past.map((s) => s.kind), ['content', 'content', 'unknown']);
  const s = shaka({ 'https://s.example/v0.m3u8': playlist([[5, at(0, '1999-06-01T00:00:00Z')], [5, at(5, '1999-06-01T00:00:00Z')]]) });
  assert.equal(s.read(3), null);
});

test('an ad segment that carries a PDT breaks the contiguity of content, and the whole playlist is unknown', () => {
  // The mid-roll's segments carry PDTs continuing the content (as if extrapolated): content 10 then appears twice.
  const items = [[5, 0], [5, 5], [2, 10], [2, 12], [5, 10], [5, 15]];
  const layout = layoutSegments(parseMediaPlaylist(playlist(items)), { origin: Date.parse(ORIGIN), duration: 60 });
  assert.ok(layout.every((segment) => segment.kind === 'unknown'));
  const s = shaka({ 'https://s.example/v0.m3u8': playlist(items) });
  for (const t of [1, 6, 11, 13, 16, 21]) assert.equal(s.read(t), null, `at ${t}`);
  // A gap in content is refused too.
  const gap = layoutSegments(parseMediaPlaylist(playlist([[5, 0], [5, 7]])), { origin: Date.parse(ORIGIN), duration: 60 });
  assert.ok(gap.every((segment) => segment.kind === 'unknown'));
});

test('a content sliver under half a second between two ads is never drawn on, at any rate', () => {
  const s = shaka({ 'https://s.example/v0.m3u8': playlist([[5, 0], [2, null], [0.4, 5], [2, null], [5, 5.4]]) });
  for (let t = 7; t < 7.4; t += 0.02) {
    assert.equal(s.read(t), null, `at ${t}`);
    assert.equal(s.read(t, 2), null, `at ${t}, rate 2`);
  }
  assert.ok(s.read(2) != null && s.read(12) != null);
});

test('every segment within the margins is checked, not two points: a short ad between them is seen', () => {
  // A 0.1 s ad 0.15 s after `t`: both old probe points (t − 0.25, t + 0.5) fall on content.
  const s = shaka({ 'https://s.example/v0.m3u8': playlist([[5, 0], [0.1, null], [5, 5]]) });
  assert.equal(s.read(4.85), null);
  // At rate 3 the lead covers 1.5 s of stream.
  assert.ok(s.read(3.3) != null);
  assert.equal(s.read(3.6, 3), null);
});

test('Shaka: one layout per playlist URI, the active variant from where its buffer ends, audio only in the ad check', () => {
  const s = shaka({
    'https://s.example/v0.m3u8': playlist(STANDARD),
    'https://s.example/v1.m3u8': playlist(LONGER),
    'https://s.example/audio.m3u8': playlist(STANDARD),
  });
  assert.equal(s.read(9), 5);
  // A switch to the longer rendition mid-ad: Shaka appends it after what is buffered (to 20 s).
  s.video.currentTime = 17;
  s.video.buffered = { length: 1, start: () => 0, end: () => 20 };
  s.player.active = 'https://s.example/v1.m3u8';
  s.player.dispatchEvent(new Event('adaptation'));
  assert.equal(s.read(17), null);
  assert.ok(Math.abs(s.read(19.5) - 11.5) < 1e-9, 'before 20 s, still the first rendition');
  assert.ok(Math.abs(s.read(26) - 17.6) < 1e-9, 'after 20 s, the longer one');
  // Around the first rendition's mid-roll end (18) the longer one is still in its ad: null in both.
  assert.equal(s.read(18.3), null);
  // A seek out of the buffer: the active variant from then on.
  s.video.buffered = { length: 0 };
  s.video.currentTime = 8;
  s.video.dispatchEvent(new Event('seeking'));
  assert.ok(Math.abs(s.read(8) - 3.8) < 1e-9);
});

test('Shaka created after the playlists went by says so once and stays null', () => {
  const s = shaka({ 'https://s.example/audio.m3u8': playlist(STANDARD) });
  assert.equal(s.read(6), null);
  assert.equal(s.read(7), null);
  assert.deepEqual(s.events, [{ type: 'clock_playlist_missing' }]);
});

test('hls.js: the level of the fragment on screen, and every loaded level clear of ads', () => {
  const frags = (items) => {
    let start = 0;
    return items.map(([duration, content], i) => {
      const frag = { start, duration, sn: i, rawProgramDateTime: content === null ? null : at(content) };
      start += duration;
      return frag;
    });
  };
  const levels = [{ details: { fragments: frags(STANDARD) } }, { details: { fragments: frags(LONGER) } }];
  levels[0].details.fragments.forEach((frag) => { frag.level = 0; });
  levels[1].details.fragments.forEach((frag) => { frag.level = 1; });
  const handlers = new Map();
  const hls = { levels, currentLevel: 1, on: (name, fn) => handlers.set(name, fn), off() {} };
  const video = { currentTime: 0, playbackRate: 1 };
  const clock = hlsContentClock({ hls, video, plan: plan() });
  // hls.js already loads level 1, but the fragment on screen is level 0's.
  handlers.get('hlsFragChanged')(null, { frag: levels[0].details.fragments[6] });
  video.currentTime = 19;
  assert.ok(Math.abs(clock.time() - 11) < 1e-9);
  // Level 1's mid-roll runs to 18.4: right after level 0's (18) both must be clear.
  handlers.get('hlsFragChanged')(null, { frag: levels[0].details.fragments[6] });
  video.currentTime = 18.3;
  assert.equal(clock.time(), null);
});

test('Video.js: the rendition VHS loaded for that moment, and no full rescan per call', () => {
  const make = (items) => parseMediaPlaylist(playlist(items)).map((s) => {
    const segment = { duration: s.duration, uri: 'x.ts' };
    if (Number.isFinite(s.pdt)) segment.dateTimeString = new Date(s.pdt).toISOString();
    return segment;
  });
  const a = { segments: make(STANDARD) };
  const b = { segments: make(LONGER) };
  let reads = 0;
  for (const segment of [...a.segments, ...b.segments]) {
    const value = segment.dateTimeString;
    if (value) Object.defineProperty(segment, 'dateTimeString', { get: () => { reads++; return value; } });
  }
  // VHS switched to b, but the content at 22–23 s was loaded from a (it carries a's timing).
  a.segments[6].start = 18;
  a.segments[6].end = 23;
  const state = { time: 22, media: b };
  const player = {
    currentTime: () => state.time, playbackRate: () => 1,
    tech: () => ({ vhs: { playlists: { media: () => state.media, main: { playlists: [a, b] } } } }),
  };
  const clock = videoJsContentClock({ player, plan: plan() });
  assert.ok(Math.abs(clock.time() - 14) < 1e-9, 'read in a, where it came from');
  state.time = 26;
  assert.ok(Math.abs(clock.time() - 17.6) < 1e-9, 'not loaded from a: read in b');
  const before = reads;
  for (let i = 0; i < 1000; i++) clock.time();
  assert.equal(reads, before, 'layouts are kept between calls');
});

test('Safari: only a MediaTailor session manifest, unless the host says it is one', () => {
  const video = { currentTime: 0, playbackRate: 1 };
  for (const playlistUrl of ['https://cdn.example/master.m3u8', 'https://x.mediatailor.us-east-1.amazonaws.com/v1/master/a/b/c.m3u8',
    'http://x.mediatailor.us-east-1.amazonaws.com/v1/master/a/b/c.m3u8?aws.sessionId=1'])
    assert.throws(() => nativeHlsContentClock({ video, plan: plan(), playlistUrl, fetchImpl: async () => ({}) }), /session manifest/);
  assert.doesNotThrow(() => nativeHlsContentClock({ video, plan: plan(), fetchImpl: async () => ({ ok: false }),
    playlistUrl: 'https://abc.mediatailor.us-east-1.amazonaws.com/v1/master/h/cfg/index.m3u8?aws.sessionId=s1' }));
  assert.doesNotThrow(() => nativeHlsContentClock({ video, plan: plan(), fetchImpl: async () => ({ ok: false }),
    playlistUrl: 'https://cdn.example/master.m3u8', sessionManifest: true }));
});

test('Safari: where the variants disagree, or one cannot be read, nothing is known', async () => {
  const video = { currentTime: 0, playbackRate: 1 };
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv0.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nv1.m3u8\n';
  const texts = { 'https://s.example/m.m3u8': master, 'https://s.example/v0.m3u8': playlist(STANDARD),
    'https://s.example/v1.m3u8': playlist(MID_LONGER) };
  const clock = nativeHlsContentClock({ video, plan: plan(), playlistUrl: 'https://s.example/m.m3u8', sessionManifest: true,
    fetchImpl: async (url) => ({ ok: true, text: async () => texts[url] }) });
  await flush();
  await flush();
  video.currentTime = 6;
  assert.equal(clock.time(), 2, 'before the mid-roll both agree');
  video.currentTime = 26;
  assert.equal(clock.time(), null, 'after the mid-roll they are 0.2 s apart');
  delete texts['https://s.example/v1.m3u8'];
  const broken = nativeHlsContentClock({ video, plan: plan(), playlistUrl: 'https://s.example/m.m3u8', sessionManifest: true,
    fetchImpl: async (url) => (texts[url] ? { ok: true, text: async () => texts[url] } : { ok: false, status: 404 }) });
  await flush();
  await flush();
  video.currentTime = 6;
  assert.equal(broken.time(), null);
});

test('Shaka: a moment is read in the rendition whose segment was last downloaded for it', () => {
  const longer = playlist(LONGER).replace(/^s(\d+)\.ts$/gm, 'long/s$1.ts');
  const s = shaka({ 'https://s.example/v0.m3u8': playlist(STANDARD), 'https://s.example/v1.m3u8': longer });
  // The active variant is v0, but the segments on screen came from v1, placed by Shaka at 22.5–27.5 and 27.5–32.5
  // (where it aligned them, not where either playlist's #EXTINF sum puts them).
  s.segment('https://s.example/long/s6.ts', 17.5, 22.5);
  s.segment('https://s.example/long/s7.ts', 22.5, 27.5);
  assert.ok(Math.abs(s.read(26) - 18.5) < 1e-9);
  // A later download of v0's s7 placed at 23.3–28.3: the newest wins.
  s.segment('https://s.example/s7.ts', 23.3, 28.3);
  assert.ok(Math.abs(s.read(26) - 17.7) < 1e-9);
  // Downloads that end inside the margins: the active variant's playlist decides (v0: content 19.9).
  assert.ok(Math.abs(s.read(27.9) - 19.9) < 1e-9);
  // ... and an ad nearby in any playlist still says null (v1's pre-roll runs to 4.2).
  assert.equal(s.read(4.1), null);
});


// Single-file HLS: every segment is the same file, told apart by #EXT-X-BYTERANGE.
function byteRanges(items, file = 'all.ts') {
  let offset = 0;
  return playlist(items).replace(/^(#EXTINF:[^\n]*)\ns\d+\.ts$/gm, (_, extinf) => {
    const size = 1000;
    const line = `#EXT-X-BYTERANGE:${size}@${offset}\n${extinf}\n${file}`;
    offset += size;
    return line;
  });
}

test('a single-file playlist lays out each byte range, and Shaka places each download by URI and first byte', () => {
  const items = [[4, null], [5, 0], [5, 5], [5, 10]];
  const segments = parseMediaPlaylist(byteRanges(items));
  assert.deepEqual(segments.map((s) => [s.uri, s.byteStart]), [['all.ts', 0], ['all.ts', 1000], ['all.ts', 2000], ['all.ts', 3000]]);
  // A range without @offset follows the previous one of that file.
  assert.deepEqual(parseMediaPlaylist('#EXTM3U\n#EXT-X-BYTERANGE:10@5\n#EXTINF:1,\na.ts\n#EXT-X-BYTERANGE:20\n#EXTINF:1,\na.ts\n')
    .map((s) => s.byteStart), [5, 15]);
  const s = shaka({ 'https://s.example/v0.m3u8': byteRanges(items) });
  s.segment('https://s.example/all.ts', 0, 4, { startByte: 0 });
  s.segment('https://s.example/all.ts', 4, 9, { startByte: 1000 });
  s.segment('https://s.example/all.ts', 9, 14, { startByte: 2000 });
  s.segment('https://s.example/all.ts', 14, 19, { startByte: 3000 });
  assert.equal(s.read(6), 2);
  assert.equal(s.read(11), 7);
  assert.equal(s.read(16), 12);
  assert.equal(s.read(2), null);
});

test('Shaka records only video downloads: an audio or subtitle boundary never says content over a video ad', () => {
  const audio = playlist(LONGER).replace(/^s(\d+)\.ts$/gm, 'a/s$1.ts');
  const s = shaka({ 'https://s.example/v0.m3u8': playlist(STANDARD), 'https://s.example/audio.m3u8': audio },
    ['https://s.example/v0.m3u8']);
  // Video: the mid-roll at 14–18. An audio segment named in the audio playlist claims content there.
  s.segment('https://s.example/s4.ts', 14, 16);
  s.segment('https://s.example/s5.ts', 16, 18);
  s.segment('https://s.example/a/s6.ts', 14, 20, { type: 'audio' });
  s.segment('https://s.example/a/s7.ts', 13, 19, { type: 'text' });
  assert.equal(s.read(16), null);
  // Without a stream in the context, only a segment of a video playlist counts.
  s.segment('https://s.example/a/s6.ts', 14, 19, { type: null });
  assert.equal(s.read(16), null);
});

test('a segment named twice in a playlist is not placed from downloads: the playlist path decides', () => {
  const text = playlist([[5, 0], [5, 5]]).replace('s1.ts', 's0.ts');
  const s = shaka({ 'https://s.example/v0.m3u8': text });
  s.segment('https://s.example/s0.ts', 0, 5);
  s.segment('https://s.example/s0.ts', 5, 10);
  assert.equal(s.read(7), 7);
});

test('each clock says once why a playlist shows nothing', async () => {
  const gap = playlist([[5, 0], [5, 7]]);
  const early = playlist([[5, at(0, '1999-06-01T00:00:00Z')]]);
  const s = shaka({ 'https://s.example/v0.m3u8': gap, 'https://s.example/v1.m3u8': early, 'https://s.example/v2.m3u8': gap });
  assert.deepEqual(s.events, [{ type: 'clock_unknown', reason: 'pdt_not_contiguous' }, { type: 'clock_unknown', reason: 'pdt_out_of_range' }]);
  const events = [];
  const clock = nativeHlsContentClock({ video: { currentTime: 3, playbackRate: 1 }, plan: plan(), playlistUrl: 'https://s.example/p.m3u8',
    sessionManifest: true, onEvent: (event) => events.push(event), fetchImpl: async () => ({ ok: true, text: async () => gap }) });
  await flush();
  await flush();
  assert.equal(clock.time(), null);
  assert.deepEqual(events, [{ type: 'clock_unknown', reason: 'pdt_not_contiguous' }]);
});

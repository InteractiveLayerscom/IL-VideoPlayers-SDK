import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachAds, hlsContentClock, nativeHlsContentClock, parseMediaPlaylist, shakaContentClock, videoJsContentClock } from '../web/ads.mjs';
import { attachHtmlVideo } from '../web/index.mjs';

globalThis.DOMParser = new JSDOM('').window.DOMParser;

// A stitched ad on screen closes a product the viewer kept from the content; buffering or an unknown position does not.
// Stream: pre-roll ad 0-10, content 0-30 at 10-40, mid-roll ad 40-50, content 30-60 at 50-80 (5 s segments).

const ORIGIN = '2000-01-01T00:00:00.000Z';
const pdt = (seconds) => new Date(Date.parse(ORIGIN) + seconds * 1000).toISOString();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const inAdTruth = (t) => (t >= 0 && t < 10) || (t >= 40 && t < 50);

function playlist() {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  const ad = (name) => { for (let i = 0; i < 2; i++) lines.push('#EXTINF:5.0,', `https://ads.example/${name}/${i}.ts`); };
  const content = (from, to) => { for (let s = from; s < to; s += 5) lines.push('#EXT-X-PROGRAM-DATE-TIME:' + pdt(s), '#EXTINF:5.0,', `https://cdn.example/c/${s / 5}.ts`); };
  ad('pre'); lines.push('#EXT-X-DISCONTINUITY');
  content(0, 30); lines.push('#EXT-X-DISCONTINUITY');
  ad('mid'); lines.push('#EXT-X-DISCONTINUITY');
  content(30, 60);
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
const plan = () => ({ version: 1, expires_at: new Date(Date.now() + 3600000).toISOString(), page_url: 'https://publisher.example/v',
  timeline: { kind: 'stitched', pdt_origin: ORIGIN, breaks: [0, 30] }, cuts: [] });

function fragments() {
  const list = [];
  let cc = -1;   // hls.js's continuity counter: one value per run between discontinuities
  const add = (from, to, contentStart) => {
    cc++;
    for (let t = from; t < to; t += 5) list.push({ start: t, duration: 5, cc, rawProgramDateTime: contentStart == null ? null : pdt(contentStart + t - from) });
  };
  add(0, 10, null); add(10, 40, 0); add(40, 50, null); add(50, 80, 30);
  return list;
}

const VARIANT = 'https://session.example/v.m3u8';
const factories = {
  hls() {
    const details = { fragments: fragments() };
    const hls = { details, levels: [{ details }], currentLevel: 0, on() {}, off() {} };
    const video = new EventTarget();
    Object.assign(video, { currentTime: 0, playbackRate: 1 });
    return { clock: hlsContentClock({ hls, video, plan: plan() }), set: (t) => { video.currentTime = t; } };
  },
  shaka() {
    const video = new EventTarget();
    Object.assign(video, { currentTime: 0, playbackRate: 1, buffered: { length: 0 } });
    const filters = new Set();
    const network = { registerResponseFilter: (fn) => filters.add(fn), unregisterResponseFilter: (fn) => filters.delete(fn) };
    const player = Object.assign(new EventTarget(), { getNetworkingEngine: () => network, getMediaElement: () => video, getManifest: () => null,
      getVariantTracks: () => [{ active: true, originalVideoId: VARIANT }] });
    const clock = shakaContentClock({ player, plan: plan() });
    const data = new TextEncoder().encode(playlist()).buffer;
    for (const fn of filters) fn(0, { uri: VARIANT, originalUri: VARIANT, data });
    return { clock, set: (t) => { video.currentTime = t; } };
  },
  videojs() {
    const segments = [];
    let start = 0;
    let lastRun = 0;
    for (const s of parseMediaPlaylist(playlist())) {
      segments.push({ duration: s.duration, uri: 'x.ts', ...(s.run !== lastRun ? { discontinuity: true } : {}), ...(Number.isFinite(s.pdt) ? { dateTimeString: new Date(s.pdt).toISOString() } : {}) });
      start += s.duration;
      lastRun = s.run;
    }
    const state = { time: 0 };
    const player = { currentTime: () => state.time, playbackRate: () => 1, tech: () => ({ vhs: { playlists: { media: () => ({ segments }) } } }) };
    return { clock: videoJsContentClock({ player, plan: plan() }), set: (t) => { state.time = t; } };
  },
  async native() {
    const video = new EventTarget();
    Object.assign(video, { currentTime: 0, playbackRate: 1 });
    const clock = nativeHlsContentClock({ video, plan: plan(), playlistUrl: VARIANT, sessionManifest: true,
      fetchImpl: async () => ({ ok: true, text: async () => playlist() }) });
    await flush();
    return { clock, set: (t) => { video.currentTime = t; } };
  },
};

for (const name of Object.keys(factories)) {
  test(`${name} clock: inAd() is true on an ad segment, and only there`, async () => {
    const { clock, set } = await factories[name]();
    for (const t of [2, 8, 12, 25, 39.9, 40, 45, 49.9, 50.1, 60, 79]) {
      set(t);
      assert.equal(clock.inAd(), inAdTruth(t), `at ${t}`);
    }
    // Near an ad the content time is withheld (a margin), but that is not an ad: the picture still is content.
    set(39.8);
    assert.equal(clock.time(), null, 'the margin withholds the time');
    assert.equal(clock.inAd(), false, 'and the picture is not an ad');
    for (const t of [NaN, undefined, -5, 500]) {
      set(t);
      assert.equal(clock.inAd(), false, `an unknown position (${t}) is not an ad`);
    }
    clock.destroy?.();
  });
}

test('hls clock: nothing loaded yet is not an ad', () => {
  const hls = { levels: [], currentLevel: -1, on() {}, off() {} };
  const video = new EventTarget();
  Object.assign(video, { currentTime: 45, playbackRate: 1 });
  const clock = hlsContentClock({ hls, video, plan: plan() });
  assert.equal(clock.inAd(), false);
  assert.equal(clock.time(), null);
});

function sessionOnClock(t) {
  const { window } = new JSDOM('<main><video></video></main>', { pretendToBeVisual: true });
  const doc = window.document, stage = doc.querySelector('main'), video = stage.querySelector('video');
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, left: 0, top: 0, right: 300, bottom: 40 });
  const hls = { details: { fragments: fragments() }, levels: [{ details: { fragments: fragments() } }], currentLevel: 0, on() {}, off() {} };
  const clock = hlsContentClock({ hls, video, plan: plan() });
  const state = { ready: 4 };
  Object.defineProperties(video, { readyState: { get: () => state.ready }, paused: { value: false }, ended: { value: false }, seeking: { value: false },
    currentTime: { value: 0, writable: true }, playbackRate: { value: 1 } });
  const sdk = attachHtmlVideo({ video, stage, programTime: clock.programTime, inAd: clock.inAd, interval: false, commerce: { locale: 'en' },
    fetchImpl: async () => ({ ok: true, status: 204 }) });
  const offer = { id: 'p', imageUrl: 'https://ads.example/p.jpg', title: 'Producto', price: '100.00', currency: 'USD', locale: 'en',
    handoffUrl: 'https://ads.example/h', viewUrl: 'https://ads.example/v', variants: [{ id: 'v1', label: 'M', price: '100.00' }] };
  sdk.addCue({ id: 'a', format: 'super', start: 15000, end: 28000, products: [offer],
    scene: { format: 'super', width: 1440, height: 216, durationMs: 13000,
      layers: [{ id: 'card', type: 'rect', x: 0, y: 0, width: 1440, height: 216, fill: '#151923', productIndex: 0, action: 'product' }] } });
  const at = (seconds) => { video.currentTime = seconds; sdk.tick(); };
  t.after(() => { sdk.destroy(); window.close(); });
  return { sdk, doc, video, state, at, clock, window };
}

test('real session on a real stitched clock: a product kept from the content closes when the playhead enters an ad, not on buffering', (t) => {
  const r = sessionOnClock(t);
  r.at(30);                                          // content second 20, inside the cue
  const tile = r.doc.querySelector('.il-scene-action');
  tile.focus();
  tile.click();
  assert.ok(r.doc.querySelector('.il-commerce-panel:not([hidden])'));
  r.at(55);                                          // content second 35: the window ended, the panel is kept
  assert.ok(r.doc.querySelector('.il-commerce-panel:not([hidden])'), 'window ended: kept');
  r.at(NaN);                                         // position unknown
  assert.ok(r.doc.querySelector('.il-commerce-panel:not([hidden])'), 'unknown position: kept');
  r.state.ready = 1;                                 // buffering
  r.at(55);
  assert.ok(r.doc.querySelector('.il-commerce-panel:not([hidden])'), 'buffering: kept');
  r.state.ready = 4;
  r.at(45);                                          // the mid-roll ad is on screen
  assert.equal(r.doc.querySelector('.il-commerce'), null, 'a stitched ad closes it');
  r.sdk.destroy();
  r.window.close();
});

test('attachAds on a stitched plan closes a kept product when the clock says an ad is on screen', async (t) => {
  const video = new EventTarget();
  Object.assign(video, { currentTime: 30, paused: false, ended: false, playbackRate: 1 });
  const hls = { details: { fragments: fragments() }, levels: [{ details: { fragments: fragments() } }], currentLevel: 0, on() {}, off() {} };
  const clock = hlsContentClock({ hls, video, plan: plan() });
  const closed = [];
  const session = { clock: clock.programTime, commerce: undefined, addCue: () => true, removeCue: () => true, closeProduct: (...args) => closed.push(args) };
  const ads = attachAds({ session, video, plan: plan(), clock, fetchImpl: async () => ({ ok: true }), planOrigin: 'https://console.example' });
  t.after(() => ads.destroy());
  const at = async (t) => { video.currentTime = t; video.dispatchEvent(new Event('timeupdate')); await flush(); };
  await at(30);
  await at(NaN);
  assert.deepEqual(closed, [], 'content and an unknown position close nothing');
  await at(45);
  assert.ok(closed.length >= 1, 'an ad on screen closes the kept product');
  ads.destroy();
});

// An origin that writes the program date only on the first segment after a discontinuity (HLS allows it): the rest of
// that content is undated, so its time is unknown, but it is not an ad. Only a run with no dated segment is an ad pod.
function sparsePlaylist() {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  const ad = (name) => { for (let i = 0; i < 2; i++) lines.push('#EXTINF:5.0,', `https://ads.example/${name}/${i}.ts`); };
  const content = (from, to) => {
    for (let s = from; s < to; s += 5) {
      if (s === from) lines.push('#EXT-X-PROGRAM-DATE-TIME:' + pdt(s));   // dated only at the start of the run
      lines.push('#EXTINF:5.0,', `https://cdn.example/c/${s / 5}.ts`);
    }
  };
  ad('pre'); lines.push('#EXT-X-DISCONTINUITY');
  content(0, 30); lines.push('#EXT-X-DISCONTINUITY');
  ad('mid'); lines.push('#EXT-X-DISCONTINUITY');
  content(30, 60);
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
const sparseFactories = {
  hls() {
    const list = fragments().map((frag, i, all) => ({ ...frag, rawProgramDateTime: frag.rawProgramDateTime && (i === 0 || all[i - 1].cc !== frag.cc) ? frag.rawProgramDateTime : null }));
    const hls = { details: { fragments: list }, levels: [{ details: { fragments: list } }], currentLevel: 0, on() {}, off() {} };
    const video = new EventTarget();
    Object.assign(video, { currentTime: 0, playbackRate: 1 });
    return { clock: hlsContentClock({ hls, video, plan: plan() }), set: (t) => { video.currentTime = t; } };
  },
  shaka() {
    const video = new EventTarget();
    Object.assign(video, { currentTime: 0, playbackRate: 1, buffered: { length: 0 } });
    const filters = new Set();
    const network = { registerResponseFilter: (fn) => filters.add(fn), unregisterResponseFilter: (fn) => filters.delete(fn) };
    const player = Object.assign(new EventTarget(), { getNetworkingEngine: () => network, getMediaElement: () => video, getManifest: () => null,
      getVariantTracks: () => [{ active: true, originalVideoId: VARIANT }] });
    const clock = shakaContentClock({ player, plan: plan() });
    const data = new TextEncoder().encode(sparsePlaylist()).buffer;
    for (const fn of filters) fn(0, { uri: VARIANT, originalUri: VARIANT, data });
    return { clock, set: (t) => { video.currentTime = t; } };
  },
  videojs() {
    const segments = [];
    let lastRun = 0;
    for (const s of parseMediaPlaylist(sparsePlaylist())) {
      segments.push({ duration: s.duration, uri: 'x.ts', ...(s.run !== lastRun ? { discontinuity: true } : {}), ...(Number.isFinite(s.pdt) ? { dateTimeString: new Date(s.pdt).toISOString() } : {}) });
      lastRun = s.run;
    }
    const state = { time: 0 };
    const player = { currentTime: () => state.time, playbackRate: () => 1, tech: () => ({ vhs: { playlists: { media: () => ({ segments }) } } }) };
    return { clock: videoJsContentClock({ player, plan: plan() }), set: (t) => { state.time = t; } };
  },
  async native() {
    const video = new EventTarget();
    Object.assign(video, { currentTime: 0, playbackRate: 1 });
    const clock = nativeHlsContentClock({ video, plan: plan(), playlistUrl: VARIANT, sessionManifest: true,
      fetchImpl: async () => ({ ok: true, text: async () => sparsePlaylist() }) });
    await flush();
    return { clock, set: (t) => { video.currentTime = t; } };
  },
};

for (const name of Object.keys(sparseFactories)) {
  test(`${name} clock: a playlist dated only at discontinuities is content in its content runs (inAd false) and an ad in its ad runs`, async () => {
    const { clock, set } = await sparseFactories[name]();
    for (const t of [12, 17, 25, 33, 55, 60, 75]) {
      set(t);
      assert.equal(clock.inAd(), false, `content (undated after its first segment) at ${t}`);
    }
    // Safari's native clock takes no playlist whose dates are not contiguous (no segment of it is content then), so it cannot
    // tell an ad pod either: a missed close, never a wrong one.
    for (const t of [2, 8, 45]) {
      set(t);
      assert.equal(clock.inAd(), name !== 'native', `an ad pod at ${t}`);
    }
    clock.destroy?.();
  });
}

test('native clock: variants that disagree about an ad leave inAd() false (a missed close, never a wrong one)', async () => {
  // Variant 2 has no pre-roll and a shorter mid-roll, so at some moments one says ad and the other content.
  const second = (() => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    for (let s = 0; s < 30; s += 5) lines.push('#EXT-X-PROGRAM-DATE-TIME:' + pdt(s), '#EXTINF:5.0,', `https://cdn.example/b/${s / 5}.ts`);
    lines.push('#EXT-X-DISCONTINUITY');
    for (let i = 0; i < 2; i++) lines.push('#EXTINF:5.0,', `https://ads.example/mid/${i}.ts`);
    lines.push('#EXT-X-DISCONTINUITY');
    for (let s = 30; s < 60; s += 5) lines.push('#EXT-X-PROGRAM-DATE-TIME:' + pdt(s), '#EXTINF:5.0,', `https://cdn.example/b/${s / 5 + 10}.ts`);
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
  })();
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nv2.m3u8\n';
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, playbackRate: 1 });
  const clock = nativeHlsContentClock({ video, plan: plan(), playlistUrl: 'https://session.example/master.m3u8', sessionManifest: true,
    fetchImpl: async (url) => ({ ok: true, text: async () => (String(url).endsWith('master.m3u8') ? master : String(url).endsWith('v1.m3u8') ? playlist() : second) }) });
  await flush();
  video.currentTime = 45;                              // variant 1: the mid-roll (40-50); variant 2: content
  assert.equal(clock.inAd(), false);
  video.currentTime = 8;                               // variant 1: the pre-roll; variant 2: content
  assert.equal(clock.inAd(), false);
  clock.destroy?.();
});

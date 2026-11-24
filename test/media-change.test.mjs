import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachAvPlay, attachHtmlVideo, attachVideoJs } from '../web/index.mjs';
import { attachShaka } from '../web/shaka.mjs';

// When a product the viewer opened is closed because the media changed: automatically where the SDK can know, and by the
// host's closeProduct() where it cannot (hls.js on a plain <video>, AVPlay).

const offer = { id: 'p', imageUrl: 'https://ads.example/p.jpg', title: 'Producto', price: '100.00', currency: 'USD', locale: 'en',
  handoffUrl: 'https://ads.example/h', viewUrl: 'https://ads.example/v', variants: [{ id: 'v1', label: 'M', price: '100.00' }] };
const banner = (start = 1000, end = 8000) => ({ id: 'a', format: 'super', start, end, products: [offer],
  scene: { format: 'super', width: 1440, height: 216, durationMs: end - start,
    layers: [{ id: 'card', type: 'rect', x: 0, y: 0, width: 1440, height: 216, fill: '#151923', productIndex: 0, action: 'product' }] } });
const fetchImpl = async () => ({ ok: true, status: 204 });
// Registered with the test, so a failed assertion still stops the session's timers and the shop's poll.
const track = (t, sdk, d) => { t.after(() => { sdk.destroy(); d?.window.close(); }); return sdk; };

function dom(html = '<div id="s"><div id="shell"><video></video></div><div id="c"></div><div id="v"></div></div>') {
  const { window } = new JSDOM(html, { pretendToBeVisual: true });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, left: 0, top: 0, right: 300, bottom: 40 });
  const doc = window.document, video = doc.querySelector('video');
  const state = { time: 5, src: '' };
  if (video) Object.defineProperties(video, { readyState: { get: () => 4 }, paused: { value: false }, ended: { value: false }, seeking: { value: false },
    currentSrc: { get: () => state.src }, currentTime: { get: () => state.time, set: (v) => { state.time = v; } } });
  return { window, doc, video, state, stage: doc.querySelector('#s') };
}
const open = (d, sdk) => {
  sdk.addCue(banner());
  sdk.tick();
  const tile = d.doc.querySelector('.il-scene-action');
  tile.focus();
  tile.click();
};
const panelOpen = (d) => !!d.doc.querySelector('.il-commerce-panel:not([hidden]), .il-tv-shop');

test('HTML5: a different file closes the product when it starts to load; the same file again, and a blob recovery, do not', (t) => {
  const d = dom();
  const sdk = track(t, attachHtmlVideo({ video: d.video, stage: d.stage, timeline: 'media', interval: false, commerce: { locale: 'en' }, fetchImpl }), d);
  d.state.src = 'https://cdn.example/a.mp4';
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  open(d, sdk);
  assert.ok(panelOpen(d));
  d.video.dispatchEvent(new d.window.Event('emptied'));
  assert.ok(panelOpen(d), 'emptied alone decides nothing');
  d.video.dispatchEvent(new d.window.Event('loadstart'));   // load() again on the same file (a retry after an error)
  assert.ok(panelOpen(d), 'the same file again is not new content');
  d.video.dispatchEvent(new d.window.Event('emptied'));
  d.state.src = 'https://cdn.example/b.mp4';
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  assert.equal(panelOpen(d), false, 'a different file replaces the old one');
  sdk.destroy();

  const mse = dom();
  const player = track(t, attachHtmlVideo({ video: mse.video, stage: mse.stage, timeline: 'media', interval: false, commerce: { locale: 'en' }, fetchImpl }), mse);
  mse.state.src = 'blob:https://page.example/1234';
  mse.video.dispatchEvent(new mse.window.Event('loadstart'));
  open(mse, player);
  assert.ok(panelOpen(mse));
  mse.video.dispatchEvent(new mse.window.Event('emptied'));
  mse.state.src = 'blob:https://page.example/5678';  // the player attached its Media Source again, same content
  mse.video.dispatchEvent(new mse.window.Event('loadstart'));
  assert.ok(panelOpen(mse), 'an error recovery is not a new media');
  player.closeProduct();
  assert.equal(panelOpen(mse), false, 'the host says the media changed');
  player.destroy();
});

test('Video.js: a new source() closes the product; VHS attaching its blob again does not', (t) => {
  const d = dom();
  const handlers = {};
  let source = 'https://cdn.example/a.m3u8';
  const player = { el: () => d.doc.querySelector('#shell'), one() {}, off(name, fn) { handlers[name]?.delete(fn); },
    on(name, fn) { (handlers[name] ??= new Set()).add(fn); }, currentSource: () => ({ src: source }) };
  const sdk = track(t, attachVideoJs({ player, stage: d.stage, timeline: 'media', interval: false, commerce: { locale: 'en' }, fetchImpl }), d);
  d.state.src = 'blob:https://page.example/1';
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  open(d, sdk);
  assert.ok(panelOpen(d));
  for (const fn of handlers.sourceset) fn({ type: 'sourceset', src: 'blob:https://page.example/2' });
  d.video.dispatchEvent(new d.window.Event('emptied'));
  assert.ok(panelOpen(d), 'same player source: a recovery, not new content');
  source = 'https://cdn.example/b.m3u8';
  for (const fn of handlers.sourceset) fn({ type: 'sourceset', src: 'blob:https://page.example/3' });
  assert.equal(panelOpen(d), false, 'another source');
  sdk.destroy();
  assert.equal(handlers.sourceset.size, 0, 'listeners are removed');
});

function shakaRig(t) {
  const d = dom();
  const manager = { setContainers() {}, addCustomInterstitial() {}, getCurrentAd: () => null, addEventListener() {}, removeEventListener() {} };
  const player = Object.assign(new EventTarget(), { getAdManager: () => manager, getMediaElement: () => d.video, getPlayheadTimeAsDate: () => null,
    getNetworkingEngine: () => ({ registerResponseFilter() {}, unregisterResponseFilter() {} }) });
  const sdk = attachShaka({ player, clientContainer: d.doc.querySelector('#c'), serverContainer: d.doc.querySelector('#v'), stage: d.stage,
    timeline: 'media', interval: false, commerce: { locale: 'en' }, fetchImpl });
  track(t, sdk, d);
  return { d, player, sdk };
}

test('Shaka: loading (load() called) closes the product; a recovered MediaSource and the element\'s emptied do not', (t) => {
  const { d, player, sdk } = shakaRig(t);
  open(d, sdk);
  assert.ok(panelOpen(d));
  player.dispatchEvent(new Event('mediasourcerecovered'));
  d.video.dispatchEvent(new d.window.Event('emptied'));
  assert.ok(panelOpen(d), 'recovery of the same content');
  player.dispatchEvent(new Event('loading'));
  assert.equal(panelOpen(d), false, 'a new load');
  sdk.destroy();
});

test('Shaka host: an open panel is kept at its cue\'s end, and released when the session is destroyed', (t) => {
  const { d, sdk } = shakaRig(t);
  open(d, sdk);
  d.state.time = 9;                                   // the window (1 s to 8 s) is over
  sdk.tick();
  assert.equal(d.doc.querySelector('.il-scene'), null, 'the Super is gone');
  assert.ok(panelOpen(d), 'the panel is kept');
  sdk.destroy();
  assert.equal(d.doc.querySelector('.il-commerce'), null, 'destroy releases it');
  d.window.close();
});

test('AVPlay (no <video>, no media event): the host calls closeProduct() when it opens other content', (t) => {
  const d = dom('<main id="s"><div id="shell"></div></main>');
  let now = 5000;
  const sdk = track(t, attachAvPlay({ stage: d.stage, surface: d.doc.querySelector('#shell'), programTime: () => now, interval: false,
    avplay: { getState: () => 'PLAYING', setDisplayRect() {} }, getDisplayRect: () => ({ x: 0, y: 0, width: 1280, height: 720 }),
    commerce: { locale: 'en' }, fetchImpl }), d);
  sdk.addCue(banner());
  sdk.tick();
  const tile = d.doc.querySelector('.il-scene-action');
  tile.focus();
  tile.click();
  assert.ok(d.doc.querySelector('.il-tv-shop'));
  now = 9000;
  sdk.tick();
  assert.ok(d.doc.querySelector('.il-tv-shop'), 'kept after the cue');
  sdk.closeProduct();
  assert.equal(d.doc.querySelector('.il-tv-shop'), null);
  sdk.destroy();
});

test('hls.js on a plain <video>: detachMedia then a file closes the product (the element is already empty when the file loads)', (t) => {
  const d = dom();
  const sdk = track(t, attachHtmlVideo({ video: d.video, stage: d.stage, timeline: 'media', interval: false, commerce: { locale: 'en' }, fetchImpl }), d);
  d.state.src = 'blob:https://page.example/hls';
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  open(d, sdk);
  assert.ok(panelOpen(d));
  d.state.src = '';
  d.video.dispatchEvent(new d.window.Event('emptied'));   // hls.detachMedia(): src cleared, load()
  assert.ok(panelOpen(d), 'the blob going away alone is not yet a change');
  d.state.src = 'https://cdn.example/movie.mp4';
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  assert.equal(panelOpen(d), false, 'the file that loads next is other content');
});

test('hls.js on a plain <video>: detach and attach again (a recovery) keeps the product', (t) => {
  const d = dom();
  const sdk = track(t, attachHtmlVideo({ video: d.video, stage: d.stage, timeline: 'media', interval: false, commerce: { locale: 'en' }, fetchImpl }), d);
  d.state.src = 'blob:https://page.example/1';
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  open(d, sdk);
  d.state.src = '';
  d.video.dispatchEvent(new d.window.Event('emptied'));
  d.state.src = 'blob:https://page.example/2';
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  assert.ok(panelOpen(d));
});

// hls.js: `hlsManifestLoading` comes only from loadSource(); recoverMediaError() does not send it.
function fakeHls(url) {
  const handlers = new Map();
  return {
    url, levels: [], currentLevel: -1,
    on(name, fn) { (handlers.get(name) ?? handlers.set(name, new Set()).get(name)).add(fn); },
    off(name, fn) { handlers.get(name)?.delete(fn); },
    loadSource(next) { this.url = new URL(next, 'https://page.example/').href; for (const fn of handlers.get('hlsManifestLoading') ?? []) fn('hlsManifestLoading', { url: next }); },
    size() { return [...handlers.values()].reduce((n, set) => n + set.size, 0); },
  };
}
const stitched = () => ({ version: 1, expires_at: new Date(Date.now() + 3600000).toISOString(), page_url: 'https://publisher.example/v',
  timeline: { kind: 'stitched', pdt_origin: '2000-01-01T00:00:00.000Z', breaks: [] }, cuts: [] });

test('hls.js clock: loadSource() with another URL closes the product; the first load, the same URL again and a recovery do not', async (t) => {
  const { hlsContentClock, attachAds } = await import('../web/ads.mjs');
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, playbackRate: 1 });
  const hls = fakeHls(undefined);
  const clock = hlsContentClock({ hls, video, plan: stitched() });
  let changes = 0;
  const stop = clock.onMediaChange(() => changes++);
  hls.loadSource('https://cdn.example/a.m3u8');
  assert.equal(changes, 0, 'the first load');
  hls.loadSource('https://cdn.example/a.m3u8');
  assert.equal(changes, 0, 'the same URL again');
  // recoverMediaError() / swapAudioCodec(): detach and attach, no hlsManifestLoading, so nothing happens here.
  hls.loadSource('https://cdn.example/b.m3u8');
  assert.equal(changes, 1, 'another URL');
  stop();
  hls.loadSource('https://cdn.example/c.m3u8');
  assert.equal(changes, 1, 'a stopped listener hears nothing');

  const second = fakeHls('https://cdn.example/x.m3u8');
  const clock2 = hlsContentClock({ hls: second, video, plan: stitched() });
  const closed = [];
  const session = { clock: clock2.programTime, commerce: undefined, addCue: () => true, removeCue: () => true, closeProduct: (...args) => closed.push(args) };
  const ads = attachAds({ session, video, plan: stitched(), clock: clock2, fetchImpl: async () => ({ ok: true }), planOrigin: 'https://console.example' });
  t.after(() => ads.destroy());
  second.loadSource('https://cdn.example/x.m3u8');
  assert.deepEqual(closed.filter((args) => args.length === 0), [], 'the URL hls.js already had is not a change');
  second.loadSource('https://cdn.example/y.m3u8');
  assert.equal(closed.filter((args) => args.length === 0).length, 1, 'attachAds closes the product when the host loads other content');
  ads.destroy();
  second.loadSource('https://cdn.example/z.m3u8');
  assert.equal(closed.filter((args) => args.length === 0).length, 1, 'a destroyed module hears nothing');
  clock2.destroy();
  assert.equal(second.size(), 0, 'destroying the clock removes its hls.js listeners');
});

test('HTML5: a source removed and nothing loaded after leaves the panel until the viewer or the host closes it', (t) => {
  const d = dom();
  const sdk = track(t, attachHtmlVideo({ video: d.video, stage: d.stage, timeline: 'media', interval: false, commerce: { locale: 'en' }, fetchImpl }), d);
  d.state.src = 'https://cdn.example/a.mp4';
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  open(d, sdk);
  d.state.src = '';
  d.video.dispatchEvent(new d.window.Event('emptied'));
  assert.ok(panelOpen(d), 'no new source ever started to load: nothing new is on screen');
  sdk.closeProduct();
  assert.equal(panelOpen(d), false);
});

test('Video.js on an MP4: load() again on the same file keeps the product, another file closes it', (t) => {
  const d = dom();
  const handlers = {};
  let source = 'https://cdn.example/a.mp4';
  const player = { el: () => d.doc.querySelector('#shell'), one() {}, off(name, fn) { handlers[name]?.delete(fn); },
    on(name, fn) { (handlers[name] ??= new Set()).add(fn); }, currentSource: () => ({ src: source }) };
  const sdk = track(t, attachVideoJs({ player, stage: d.stage, timeline: 'media', interval: false, commerce: { locale: 'en' }, fetchImpl }), d);
  d.state.src = source;
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  open(d, sdk);
  assert.ok(panelOpen(d));
  // A retry after an error: the element is emptied and starts the same file again, and Video.js says sourceset for it.
  d.video.dispatchEvent(new d.window.Event('emptied'));
  for (const fn of handlers.sourceset) fn({ type: 'sourceset', src: source });
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  assert.ok(panelOpen(d), 'the same MP4 again');
  source = 'https://cdn.example/b.mp4';
  d.state.src = source;
  d.video.dispatchEvent(new d.window.Event('emptied'));
  for (const fn of handlers.sourceset) fn({ type: 'sourceset', src: source });
  d.video.dispatchEvent(new d.window.Event('loadstart'));
  assert.equal(panelOpen(d), false, 'another MP4');
});

test('a session host can pass hlsContentClock\'s onMediaChange itself, without attachAds', async (t) => {
  const { hlsContentClock } = await import('../web/ads.mjs');
  const d = dom();
  const hls = fakeHls('https://cdn.example/a.m3u8');
  const clock = hlsContentClock({ hls, video: d.video, plan: stitched() });
  const sdk = track(t, attachHtmlVideo({ video: d.video, stage: d.stage, timeline: 'media', interval: false, commerce: { locale: 'en' }, fetchImpl,
    onMediaChange: clock.onMediaChange }), d);
  open(d, sdk);
  assert.ok(panelOpen(d));
  hls.loadSource('https://cdn.example/a.m3u8');
  assert.ok(panelOpen(d), 'the same URL again');
  hls.loadSource('https://cdn.example/a.m3u8?token=2');
  assert.equal(panelOpen(d), false, 'a URL that differs only in its query string is another source');
  sdk.destroy();
  hls.loadSource('https://cdn.example/other.m3u8');   // a destroyed session is not listening any more
  clock.destroy();
});

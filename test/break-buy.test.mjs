import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { attachAds } from '../web/ads.mjs';
import { createSession } from '../web/session.mjs';
import { normalizeCue } from '../web/cues.mjs';
import { JSDOM } from 'jsdom';
import { attachHtmlVideo } from '../web/index.mjs';

const DLV = 'D'.repeat(43);
const offer = { id: 'p', title: 'Delantal', price: '100.00', currency: 'USD', handoffUrl: 'https://ads.example/commerce/offer/d',
  viewUrl: 'https://ads.example/commerce/view/d', variants: [{ id: 'v1', label: 'M', price: '100.00' }] };
const pacing = { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0 };
const planWith = (commerce = {}) => ({ version: 1, asset_id: 'a', duration: 60, expires_at: new Date(Date.now() + 3600000).toISOString(),
  cuts: [{ id: 'mid-1', at: 3, position: 'midroll', requests: [{ provider: 'iadserver',
    tag_url: 'https://ads.iadserver.com/gampad/ads?tag=shop&output=vast' }] }],
  commerce: { kind: 'scene_product', url: 'https://il.example/il-player/scene-product?grant=g', session: 'abc',
    break_url: 'https://il.example/il-player/break-product?project=p&asset=a&grant=g', lead_ms: 1000, pacing, windows: [], ...commerce } });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const adEvent = (id, creative = 'cr1') => ({ getAd: () => ({ getAdId: () => id, getCreativeId: () => creative }) });

// Whatever a failed assertion leaves running (the module's timers, the held-product poll) is stopped after each test.
const cleanups = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); });

async function rig({ plan = planWith(), answer, sessionId, muted = false, volume = 0.6, customPlayback = false, held = new Set() } = {}) {
  const listeners = {};
  const volumes = [];
  const manager = { addEventListener(type, fn) { (listeners[type] ??= []).push(fn); }, init() {}, start() { volumes.push('start'); }, destroy() {}, resize() {},
    setVolume(value) { volumes.push(value); }, isCustomPlaybackUsed: () => customPlayback };
  const Type = Object.fromEntries(['CONTENT_PAUSE_REQUESTED', 'CONTENT_RESUME_REQUESTED', 'STARTED', 'COMPLETE', 'SKIPPED', 'USER_CLOSE',
    'ALL_ADS_COMPLETED'].map((name) => [name, name]));
  const previous = globalThis.google;
  let loaded;
  globalThis.google = { ima: {
    AdEvent: { Type }, AdErrorEvent: { Type: { AD_ERROR: 'AD_ERROR' } }, AdsManagerLoadedEvent: { Type: { ADS_MANAGER_LOADED: 'LOADED' } },
    ViewMode: { NORMAL: 'normal' }, AdDisplayContainer: class { initialize() {} destroy() {} },
    AdsLoader: class { addEventListener(type, fn) { if (type === 'LOADED') loaded = fn; } requestAds() { loaded({ getAdsManager: () => manager }); } destroy() {} },
    AdsRequest: class {},
  } };
  const video = new EventTarget();
  let plays = 0;
  Object.assign(video, { muted, volume, currentTime: 3, paused: false, ended: false, clientWidth: 640, clientHeight: 360, pause() {}, play: async () => { plays++; } });
  const linear = [], adds = [], removed = [], asked = [];
  const events = [], eventObjects = [];
  const session = { commerce: { locale: 'es' }, sceneFeatures: [], holding: (id) => held.has(id),
    setLinearAd(value, identity) { linear.push([value, identity]); },
    addCue(cue) { adds.push(cue); return true; }, removeCue(id) { removed.push(id); return true; } };
  const fetchImpl = async (url) => {
    asked.push(new URL(String(url)));
    const q = asked.at(-1).searchParams;
    const body = answer ? answer(q) : { id: q.get('delivery'), format: 'midroll', linearCreativeId: q.get('creative'), start: 3000, end: 63000, commerce: offer };
    return { status: body ? 200 : 204, ok: true, json: async () => body };
  };
  const ads = attachAds({ session, video, plan, fetchImpl, planOrigin: 'https://il.example', linear: 'ima', adContainer: {},
    loadScript: async () => {}, sessionId, onEvent: (event) => { events.push(event.type); eventObjects.push(event); } });
  ads.start();
  await flush();
  const fire = async (type, event = {}) => { for (const fn of listeners[type] ?? []) fn(event); await flush(); };
  await fire('CONTENT_PAUSE_REQUESTED');
  const done = () => { ads.destroy(); globalThis.google = previous; };
  cleanups.push(done);
  return { ads, session, fire, linear, adds, removed, asked, video, volumes, held, events, eventObjects, plays: () => plays, done };
}

test('a shop-linked ad asks IL once with its identity, shows the card and takes it away when it ends', async () => {
  const r = await rig();
  await r.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  assert.deepEqual(r.linear.at(-1), [true, { creativeId: 'cr1', deliveryId: DLV }]);
  assert.equal(r.asked.length, 1);
  const q = r.asked[0].searchParams;
  assert.deepEqual([q.get('cut'), q.get('tag'), q.get('creative'), q.get('delivery'), q.get('grant')], ['mid-1', 'shop', 'cr1', DLV, 'g']);
  assert.equal(r.adds[0].id, DLV);
  await r.fire('COMPLETE');
  assert.deepEqual(r.removed, [DLV]);
  assert.deepEqual(r.linear.at(-1), [true, undefined]);
  await r.fire('CONTENT_RESUME_REQUESTED');
  assert.deepEqual(r.linear.at(-1), [false, undefined]);
  r.done();
});

for (const type of ['SKIPPED', 'USER_CLOSE']) test(`${type} takes the card away`, async () => {
  const r = await rig();
  await r.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  await r.fire(type);
  assert.deepEqual(r.removed, [DLV]);
  r.done();
});

test('a spot without a shop link, or of another position, asks nothing', async () => {
  for (const id of ['plain', `il-shop-preroll-${DLV}`]) {
    const r = await rig();
    await r.fire('STARTED', adEvent(id));
    assert.equal(r.asked.length, 0, id);
    assert.equal(r.adds.length, 0, id);
    r.done();
  }
});

test('the product of another delivery is dropped', async () => {
  const r = await rig({ answer: () => ({ id: 'E'.repeat(43), format: 'midroll', linearCreativeId: 'cr1', start: 1, end: 2, commerce: offer }) });
  await r.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  assert.equal(r.adds.length, 0);
  r.done();
});

test('an answer arriving after the ad ended is not shown', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = await rig({ answer: (q) => ({ id: q.get('delivery'), format: 'midroll', linearCreativeId: 'cr1', start: 1, end: 2, commerce: offer }) });
  r.ads; void gate; release();
  await r.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  await r.fire('COMPLETE');
  const count = r.adds.length;
  await flush();
  assert.equal(r.adds.length, count);
  r.done();
});

test('a host with its own view id gets the ad without the card, and a plan without break_url is as before', async () => {
  const own = await rig({ sessionId: 'host-view' });
  await own.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  assert.equal(own.asked.length, 0);
  own.done();
  const old = await rig({ plan: planWith({ break_url: undefined }) });
  await old.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  assert.equal(old.asked.length, 0);
  assert.equal(old.linear.filter(([, identity]) => identity).length, 0);
  old.done();
});

test('a holdUntil on the card is ignored: the graphic ends with its window and nothing times the open panel out', () => {
  let time = 5000, open = true;
  const shown = [];
  const renderer = { show(cue) { shown.push(cue.id); }, hide() { shown.length = 0; }, visible: () => true, holding: () => open };
  const session = createSession({ clock: () => time, playing: () => true, renderer, interval: false, commerce: {}, fetchImpl: async () => ({}) });
  session.addCue({ id: 'c', format: 'super', start: 1000, end: 8000, holdUntil: 9000, imageUrl: 'https://a.example/a.png', mimeType: 'image/png', commerce: offer });
  session.tick();
  assert.deepEqual(shown, ['c']);
  time = 8000; session.tick();
  assert.deepEqual(shown, [], 'the graphic is gone exactly at its end');
  assert.equal(session.holding('c'), true, 'the open panel is not the session\'s to close');
  time = 99999999; session.tick();
  assert.equal(session.holding('c'), true, 'and no time limit takes it');
  session.destroy();
});

test('gap_after_seconds counts from the end of a banner longer than its window', async () => {
  const scene = { format: 'super', width: 100, height: 20, durationMs: 12000,
    layers: [{ id: 'b', type: 'rect', x: 0, y: 0, width: 10, height: 10, action: 'product', productIndex: 0, fill: '#112233' }] };
  const product = { ...offer, imageUrl: 'https://a.example/a.jpg' };
  const plan = { ...planWith({ break_url: undefined, pacing: { ...pacing, gap_after_seconds: 5 },
    windows: [{ id: 'm1', start_ms: 10000, end_ms: 12000 }, { id: 'm2', start_ms: 24000, end_ms: 30000 }] }), cuts: [] };
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: false, ended: false });
  const asked = [];
  const session = { commerce: { locale: 'es' }, sceneFeatures: [], addCue: () => true, removeCue: () => true };
  const fetchImpl = async (url) => {
    const id = new URL(String(url)).searchParams.get('window');
    if (!id) return { ok: true, status: 204 };
    asked.push(id);
    return { status: 200, ok: true, json: async () => ({ id: 'd' + id, format: 'super', start: 10000, end: 22000, window: id, scene, products: [product] }) };
  };
  const ads = attachAds({ session, video, plan, fetchImpl, planOrigin: 'https://il.example' });
  const at = async (s) => { video.currentTime = s; video.dispatchEvent(new Event('playing')); await flush(); };
  await at(10);
  await at(24);   // 2 s after the banner ended, 12 s after its window: the 5 s gap has not passed
  assert.deepEqual(asked, ['m1']);
  ads.destroy();
});

test('the ad follows the content volume from before it starts, while it plays, and stops following on destroy', async () => {
  const r = await rig({ muted: true });
  assert.deepEqual(r.volumes.slice(0, 2), [0, 'start']);
  r.video.muted = false;
  r.video.dispatchEvent(new Event('volumechange'));
  assert.equal(r.volumes.at(-1), 0.6);
  r.video.volume = 0.25;
  r.video.dispatchEvent(new Event('volumechange'));
  assert.equal(r.volumes.at(-1), 0.25);
  r.video.muted = true;
  r.video.dispatchEvent(new Event('volumechange'));
  assert.equal(r.volumes.at(-1), 0);
  const count = r.volumes.length;
  r.done();
  r.video.dispatchEvent(new Event('volumechange'));
  assert.equal(r.volumes.length, count);
});

test('with custom playback the shared element keeps the viewer volume', async () => {
  const r = await rig({ muted: true, customPlayback: true });
  r.video.dispatchEvent(new Event('volumechange'));
  assert.deepEqual(r.volumes, ['start']);
  r.done();
});

test('a plan that still carries holdUntil is simply ignored', () => {
  const base = { id: 'c', format: 'super', start: 1, end: 10, imageUrl: 'https://a.example/a.png', mimeType: 'image/png', commerce: offer };
  for (const holdUntil of [20, 5, Infinity, 'x']) assert.equal('holdUntil' in normalizeCue({ ...base, holdUntil }), false);
});

function bannerHost(layers) {
  const { window } = new JSDOM('<div id="s"><video></video></div>', { pretendToBeVisual: true });
  const doc = window.document, stage = doc.querySelector('#s'), video = doc.querySelector('video');
  Object.defineProperties(video, { currentTime: { value: 5 }, readyState: { value: 4 }, seeking: { value: false }, ended: { value: false }, paused: { value: false } });
  const sdk = attachHtmlVideo({ video, stage, timeline: 'media', interval: false, commerce: { locale: 'es' } });
  sdk.addCue({ id: 'd', format: 'super', start: 0, end: 10000, commerce: undefined, products: [{ ...offer, imageUrl: 'https://a.example/a.jpg' }],
    scene: { format: 'super', width: 1440, height: 216, durationMs: 10000, layers } });
  return { sdk, doc };
}
const card = { id: 'card', type: 'rect', x: 86, y: 26, width: 1267, height: 164, fill: '#151923', productIndex: 0, action: 'product' };
const title = { id: 'title', type: 'text', x: 492, y: 39, width: 848, height: 64, text: 'Sartén', binding: 'title', productIndex: 0 };

test('a product card with no button of its own shows a Comprar control and the click opens the product', () => {
  const r = bannerHost([card, title]);
  const chip = r.doc.querySelector('[data-layer-id="card"] .il-scene-buy');
  assert.equal(chip.textContent, 'Comprar');
  assert.equal(r.doc.querySelector('.il-scene-action').getAttribute('aria-label'), 'Comprar: Delantal');
  r.doc.querySelector('.il-scene-action').click();
  assert.ok(r.doc.querySelector('.il-commerce-buy'));
  r.sdk.destroy();
});

test('a template with its own button gets no second one', () => {
  const r = bannerHost([{ ...card, action: undefined }, title, { id: 'cta', type: 'rect', x: 1100, y: 100, width: 200, height: 60, fill: '#fff', action: 'product', productIndex: 0 }]);
  assert.equal(r.doc.querySelector('.il-scene-buy'), null);
  r.sdk.destroy();
});

test('a card with an inner action, a CTA layer or painted Comprar gets no chip', () => {
  for (const inner of [{ action: 'link', url: 'https://a.example/' }, { name: 'CTA' }, { text: 'Comprar ahora' }]) {
    const r = bannerHost([card, { id: 'x', type: 'text', x: 1100, y: 100, width: 200, height: 60, text: 'Oferta', ...inner }]);
    assert.equal(r.doc.querySelector('.il-scene-buy'), null, JSON.stringify(inner));
    r.sdk.destroy();
  }
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('an open product outlives the end of its ad: the break waits for the viewer, then content resumes', async () => {
  const r = await rig();
  await r.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  r.held.add(DLV);                                  // the viewer opened the product
  await r.fire('COMPLETE');
  await r.fire('CONTENT_RESUME_REQUESTED');
  assert.deepEqual(r.removed, []);                  // the card stays
  assert.deepEqual(r.events.slice(-2), ['break_end', 'content_held']);   // the break ends on time, held
  assert.equal(r.eventObjects.find((event) => event.type === 'break_end').held, true);
  assert.deepEqual(r.linear.at(-1), [false, undefined]);
  const plays = r.plays();
  await wait(300);
  assert.equal(r.plays(), plays);                   // nothing resumes while the viewer chooses
  r.held.delete(DLV);                               // closed
  await wait(300);
  assert.deepEqual(r.removed, [DLV]);
  assert.equal(r.events.filter((type) => type === 'break_end').length, 1);
  assert.equal(r.events.at(-1), 'content_released');
  assert.ok(r.plays() > plays);
  assert.equal(r.asked.length, 1);                  // no second request
  r.done();
});

test('a product never opened changes nothing: the card goes and the break ends at once', async () => {
  const r = await rig();
  await r.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  await r.fire('COMPLETE');
  await r.fire('CONTENT_RESUME_REQUESTED');
  assert.deepEqual(r.removed, [DLV]);
  assert.equal(r.events.filter((type) => type === 'break_end').length, 1);
  assert.ok(!r.events.includes('content_held') && r.eventObjects.find((event) => event.type === 'break_end').held === undefined);
  r.done();
});

test('a skipped ad keeps an open product, and in a pod it stays over the next ad', async () => {
  const r = await rig();
  await r.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  r.held.add(DLV);
  await r.fire('SKIPPED');
  assert.deepEqual(r.removed, []);
  const other = 'F'.repeat(43);
  await r.fire('STARTED', adEvent(`il-shop-midroll-${other}`));   // the next ad of the pod, with its own shop
  assert.deepEqual(r.removed, []);
  assert.equal(r.adds.at(-1).id, other);
  await r.fire('COMPLETE');
  assert.deepEqual(r.removed, [other]);            // the second card was never opened
  await r.fire('CONTENT_RESUME_REQUESTED');
  assert.deepEqual(r.events.slice(-2), ['break_end', 'content_held']);
  r.held.delete(DLV);
  await wait(300);
  assert.ok(r.removed.includes(DLV) && r.events.at(-1) === 'content_released');
  r.done();
});

test('destroy releases a held product', async () => {
  const r = await rig();
  await r.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  r.held.add(DLV);
  await r.fire('CONTENT_RESUME_REQUESTED');
  assert.equal(r.events.at(-1), 'content_held');
  r.done();
  assert.ok(r.removed.includes(DLV));
});

test('a host that plays the content itself ends the wait without a second resume, and the panel stays', async () => {
  const closed = [];
  const r = await rig();
  r.session.closeProduct = (id) => closed.push(id);
  await r.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  r.held.add(DLV);
  await r.fire('CONTENT_RESUME_REQUESTED');
  const plays = r.plays();
  closed.length = 0;
  r.video.dispatchEvent(new Event('play'));
  assert.equal(r.events.at(-1), 'content_released');
  assert.deepEqual(closed, [], 'the panel is not closed by the content moving on');
  assert.ok(!r.removed.includes(DLV));
  r.held.delete(DLV);                                // the viewer closes it later
  await wait(300);
  assert.equal(r.plays(), plays, 'no second resume');
  r.done();
});

test('a later break drops the deferred end of an earlier held product and is never closed by it', async () => {
  const r = await rig();
  await r.fire('STARTED', adEvent(`il-shop-midroll-${DLV}`));
  r.held.add(DLV);
  await r.fire('CONTENT_RESUME_REQUESTED');
  await r.fire('CONTENT_PAUSE_REQUESTED');           // the next break starts while the panel is still open
  assert.ok(r.removed.includes(DLV) && r.events.includes('content_released'));
  const ends = r.events.filter((type) => type === 'break_end').length;
  const plays = r.plays();
  r.held.delete(DLV);
  await wait(300);
  assert.equal(r.events.filter((type) => type === 'break_end').length, ends);   // nothing closed the new break
  assert.equal(r.plays(), plays);
  assert.deepEqual(r.linear.at(-1), [true, undefined]);
  r.done();
});


test('the real session ends a midroll\'s graphic with its break; an open panel is kept by the renderer and closes on a new break', () => {
  let open = false;
  const shown = [], released = [];
  const renderer = { show(cue) { shown.push(cue.id); }, hide() { shown.length = 0; }, visible: () => true, holding: () => open,
    release: (...args) => { released.push(args); open = false; } };
  const session = createSession({ clock: () => 3000, playing: () => true, renderer, interval: false, commerce: {}, scenes: true,
    fetchImpl: async () => ({}) });
  session.addCue({ id: DLV, format: 'midroll', linearCreativeId: 'cr1', start: 0, end: Number.MAX_SAFE_INTEGER, commerce: offer });
  session.setLinearAd(true, { creativeId: 'cr1', deliveryId: DLV });
  assert.deepEqual(shown, [DLV]);
  assert.deepEqual(released, [[undefined, DLV]], 'a break starting closes what was kept, but never this ad\'s own panel');
  released.length = 0;
  open = true;
  session.setLinearAd(false);
  assert.deepEqual(shown, [], 'the graphic ends with the break');
  assert.deepEqual(released, [], 'the end of a break keeps the open panel');
  session.setLinearAd(true, { creativeId: 'cr9', deliveryId: 'E'.repeat(43) });
  assert.deepEqual(released, [[undefined, 'E'.repeat(43)]], 'the next break closes it, unless it is the ad now playing');
  session.destroy();
});

function heldPanel(handoffStatus = 201) {
  const { window } = new JSDOM('<div id="s"><video></video></div>', { pretendToBeVisual: true });
  const doc = window.document, stage = doc.querySelector('#s'), video = doc.querySelector('video');
  Object.defineProperties(video, { currentTime: { value: 3 }, readyState: { value: 4 }, seeking: { value: false }, ended: { value: false }, paused: { value: true } });
  const fetchImpl = async (url, init) => init?.method === 'POST'
    ? { ok: handoffStatus < 300, status: handoffStatus, json: async () => ({ continueUrl: 'https://shop.example/c' }) } : { ok: true, status: 204 };
  const sdk = attachHtmlVideo({ video, stage, timeline: 'media', interval: false, commerce: { locale: 'es' }, fetchImpl });
  sdk.addCue({ id: DLV, format: 'midroll', linearCreativeId: 'cr1', start: 0, end: Number.MAX_SAFE_INTEGER, commerce: offer });
  sdk.setLinearAd(true, { creativeId: 'cr1', deliveryId: DLV });
  doc.querySelector('.il-commerce > button').click();
  sdk.setLinearAd(false);                             // the ad ended with the panel open
  return { sdk, doc, window };
}

for (const [name, close] of [['Escape', (doc, window) => doc.querySelector('.il-commerce').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
  ['back (remote)', (doc, window) => doc.querySelector('.il-commerce').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'GoBack', bubbles: true }))],
  ['Close', (doc) => doc.querySelector('.il-commerce-close').click()]]) {
  test(`a held panel closed with ${name} leaves, so the held content can resume`, () => {
    const r = heldPanel();
    assert.ok(r.doc.querySelector('.il-commerce-panel:not([hidden])'));
    assert.equal(r.sdk.holding(DLV), true);
    close(r.doc, r.window);
    r.sdk.tick();
    assert.equal(r.sdk.holding(DLV), false);
    assert.equal(r.doc.querySelector('.il-commerce-panel:not([hidden])'), null);
    r.sdk.destroy();
  });
}

test('an expired offer in a held panel says so plainly and keeps the panel', async () => {
  const r = heldPanel(404);
  r.doc.querySelector('.il-commerce-buy').click();
  await flush();
  assert.equal(r.doc.querySelector('.il-commerce-result').textContent, 'Esta oferta ya no está disponible.');
  assert.equal(r.sdk.holding(DLV), true);
  r.sdk.destroy();
});

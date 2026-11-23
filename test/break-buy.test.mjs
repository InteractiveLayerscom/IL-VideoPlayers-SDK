import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAds } from '../web/ads.mjs';
import { createSession } from '../web/session.mjs';
import { normalizeCue } from '../web/cues.mjs';

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

async function rig({ plan = planWith(), answer, sessionId, muted = false, volume = 0.6, customPlayback = false } = {}) {
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
  Object.assign(video, { muted, volume, currentTime: 3, paused: false, ended: false, clientWidth: 640, clientHeight: 360, pause() {}, play: async () => {} });
  const linear = [], adds = [], removed = [], asked = [];
  const session = { commerce: { locale: 'es' }, sceneFeatures: [],
    setLinearAd(value, identity) { linear.push([value, identity]); },
    addCue(cue) { adds.push(cue); return true; }, removeCue(id) { removed.push(id); return true; } };
  const fetchImpl = async (url) => {
    asked.push(new URL(String(url)));
    const q = asked.at(-1).searchParams;
    const body = answer ? answer(q) : { id: q.get('delivery'), format: 'midroll', linearCreativeId: q.get('creative'), start: 3000, end: 63000, commerce: offer };
    return { status: body ? 200 : 204, ok: true, json: async () => body };
  };
  const ads = attachAds({ session, video, plan, fetchImpl, planOrigin: 'https://il.example', linear: 'ima', adContainer: {},
    loadScript: async () => {}, sessionId });
  ads.start();
  await flush();
  const fire = async (type, event = {}) => { for (const fn of listeners[type] ?? []) fn(event); await flush(); };
  await fire('CONTENT_PAUSE_REQUESTED');
  return { ads, fire, linear, adds, removed, asked, video, volumes, done() { ads.destroy(); globalThis.google = previous; } };
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

test('holdUntil: an open card leaves at the verified limit; a paused viewer keeps it', () => {
  let time = 5000, open = true;
  const shown = [];
  const renderer = { show(cue) { shown.push(cue.id); }, hide() { shown.length = 0; }, visible: () => true, holding: () => open };
  const session = createSession({ clock: () => time, playing: () => true, renderer, interval: false, commerce: {}, fetchImpl: async () => ({}) });
  session.addCue({ id: 'c', format: 'super', start: 1000, end: 8000, holdUntil: 9000, imageUrl: 'https://a.example/a.png', mimeType: 'image/png', commerce: offer });
  session.tick();
  time = 8500; session.tick();
  assert.deepEqual(shown, ['c']);
  session.tick();   // paused: content time does not move
  assert.deepEqual(shown, ['c']);
  time = 9000; session.tick();
  assert.deepEqual(shown, []);
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

test('normalizeCue keeps a valid holdUntil only', () => {
  const base = { id: 'c', format: 'super', start: 1, end: 10, imageUrl: 'https://a.example/a.png', mimeType: 'image/png', commerce: offer };
  assert.equal(normalizeCue({ ...base, holdUntil: 20 }).holdUntil, 20);
  assert.equal(normalizeCue({ ...base, holdUntil: 5 }).holdUntil, undefined);
  assert.equal(normalizeCue({ ...base, holdUntil: Infinity }).holdUntil, undefined);
});

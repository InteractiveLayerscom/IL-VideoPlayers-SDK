import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachAds } from '../web/ads.mjs';
import { attachHtmlVideo } from '../web/index.mjs';

// The IMA event sequence of a shop-linked ad, through the real ads module and a real session (break-buy.test.mjs runs the
// same module against a fake session, which cannot see what the session does with the panel).

const A = 'A'.repeat(43), B = 'B'.repeat(43);
const offer = (id) => ({ id: 'p' + id[0], title: 'Producto ' + id[0], price: '100.00', currency: 'USD', locale: 'en',
  handoffUrl: 'https://ads.example/commerce/offer/' + id[0], viewUrl: 'https://ads.example/view/' + id[0],
  variants: [{ id: 'v1', label: 'M', price: '100.00' }, { id: 'v2', label: 'L', price: '100.00' }] });
const pacing = { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0 };
const plan = { version: 1, asset_id: 'a', duration: 60, expires_at: new Date(Date.now() + 3600000).toISOString(),
  cuts: [{ id: 'mid-1', at: 3, position: 'midroll', requests: [{ provider: 'iadserver', tag_url: 'https://ads.iadserver.com/gampad/ads?tag=shop&output=vast' }] }],
  commerce: { kind: 'scene_product', url: 'https://il.example/il-player/scene-product?grant=g', session: 'abc',
    break_url: 'https://il.example/il-player/break-product?project=p&asset=a&grant=g', lead_ms: 1000, pacing, windows: [] } };
const adEvent = (id, creative = 'cr1') => ({ getAd: () => ({ getAdId: () => id, getCreativeId: () => creative }) });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

async function rig(t) {
  const listeners = {};
  const manager = { addEventListener(type, fn) { (listeners[type] ??= []).push(fn); }, init() {}, start() {}, destroy() {}, resize() {},
    setVolume() {}, isCustomPlaybackUsed: () => false };
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
  const { window } = new JSDOM('<main><video></video><div id="ads"></div></main>', { pretendToBeVisual: true });
  const doc = window.document, stage = doc.querySelector('main'), video = stage.querySelector('video');
  const state = { plays: 0, paused: false };
  Object.defineProperties(video, { readyState: { get: () => 4 }, paused: { get: () => state.paused }, ended: { value: false },
    currentTime: { value: 3, writable: true }, clientWidth: { value: 640 }, clientHeight: { value: 360 } });
  video.play = () => { state.plays++; state.paused = false; return Promise.resolve(); };
  video.pause = () => { state.paused = true; };
  const fetchImpl = async (url) => {
    const text = String(url);
    if (!text.startsWith('https://il.example/il-player/break-product')) return { ok: true, status: 204 };
    const q = new URL(text).searchParams;
    const delivery = q.get('delivery');
    const body = { id: delivery, format: 'midroll', linearCreativeId: q.get('creative'), start: 3000, end: 63000, commerce: offer(delivery) };
    return { status: 200, ok: true, json: async () => body };
  };
  const events = [];
  const session = attachHtmlVideo({ video, stage, timeline: 'media', interval: false, commerce: { locale: 'en' }, fetchImpl });
  const ads = attachAds({ session, video, plan, fetchImpl, planOrigin: 'https://il.example', linear: 'ima', adContainer: doc.querySelector('#ads'),
    loadScript: async () => {}, onEvent: (event) => events.push(event.type) });
  ads.start();
  await flush();
  const fire = async (type, event = {}) => { for (const fn of listeners[type] ?? []) fn(event); await flush(); session.tick(); };
  await fire('CONTENT_PAUSE_REQUESTED');
  const opener = () => doc.querySelector('.il-commerce > button');
  const panel = () => doc.querySelector('.il-commerce-panel:not([hidden])');
  const title = () => panel()?.querySelector('.il-commerce-title')?.textContent;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    ads.destroy();
    session.destroy();
    window.close();
    globalThis.google = previous;
  };
  // Registered with the test, so a failed assertion still stops the timers (the session's, the shop's poll).
  t.after(done);
  return { ads, session, window, doc, fire, state, events, opener, panel, title, done };
}

test('a mid-roll\'s panel survives its ad: STARTED, open, COMPLETE, CONTENT_RESUME_REQUESTED; content resumes only when the viewer closes it', async (t) => {
  const r = await rig(t);
  await r.fire('STARTED', adEvent(`il-shop-midroll-${A}`));
  assert.equal(r.opener().textContent, 'Buy');
  r.opener().click();
  assert.equal(r.title(), 'Producto A');
  await r.fire('COMPLETE');
  assert.equal(r.title(), 'Producto A', 'the ad ended: the panel did not');
  await r.fire('CONTENT_RESUME_REQUESTED');
  assert.equal(r.title(), 'Producto A', 'nor did the end of the break');
  assert.deepEqual(r.events.slice(-2), ['break_end', 'content_held']);
  const plays = r.state.plays;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(r.state.plays, plays, 'content waits while the viewer chooses');
  r.doc.querySelector('.il-commerce-close').click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(r.doc.querySelector('.il-commerce'), null);
  assert.equal(r.events.at(-1), 'content_released');
  assert.ok(r.state.plays > plays, 'closing it resumes the content');
  r.done();
});

test('in a pod, ad A\'s panel survives A\'s COMPLETE and closes when ad B STARTS (with or without a shop)', async (t) => {
  for (const next of [adEvent(`il-shop-midroll-${B}`, 'cr2'), adEvent('plain-ad', 'cr3')]) {
    const r = await rig(t);
    await r.fire('STARTED', adEvent(`il-shop-midroll-${A}`));
    r.opener().click();
    await r.fire('COMPLETE');
    assert.equal(r.title(), 'Producto A', 'survives the end of its own ad');
    await r.fire('STARTED', next);
    assert.equal(r.panel(), null, 'the next ad of the break closes the previous ad\'s product');
    r.done();
  }
});

test('the content playing under a held panel does not close it (the host or the viewer pressing play)', async (t) => {
  const r = await rig(t);
  await r.fire('STARTED', adEvent(`il-shop-midroll-${A}`));
  r.opener().click();
  await r.fire('COMPLETE');
  await r.fire('CONTENT_RESUME_REQUESTED');
  r.state.paused = true;
  r.doc.querySelector('video').dispatchEvent(new r.window.Event('play'));
  await flush();
  assert.equal(r.events.at(-1), 'content_released', 'the wait ended');
  assert.equal(r.title(), 'Producto A', 'the panel did not');
  const plays = r.state.plays;
  r.doc.querySelector('.il-commerce-close').click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(r.state.plays, plays, 'no second resume');
  r.done();
});

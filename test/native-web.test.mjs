// The app route, version 2 plans and host-driven breaks of web/ads.mjs, against the shared native fixtures.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { attachAds, attachAppAds, graphicTag, loadAppPlan, loadPlan, planUrl, vastIdentity } from '../web/ads.mjs';

globalThis.DOMParser = new JSDOM('').window.DOMParser;

// The fixtures come from IL's test console on http://localhost:8000; the SDK only takes HTTPS, so the tests serve
// the same bodies from an HTTPS console origin (the files themselves stay untouched).
const CONSOLE = 'https://console.example';
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/native/${name}`, import.meta.url), 'utf8')
  .replaceAll('http://localhost:8000', CONSOLE));
const NOW = Date.parse('2026-11-02T16:00:00Z');
const PROJECT = 'proj_8e4cb338d66e4ec6bc6b99fd21f651f6';
const ASSET = 'asset-40edc822d6f24974a9af51695a88184b';
const APP = 'tizen:AbCdEfGhIj.ILDemo';
const DLV = 'D'.repeat(43);
const STABLE = fixture('break-request-stable.json');
const grantOf = (href) => new URL(href).searchParams.get('grant');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve)); };
const superVast = '<VAST version="3.0"><Ad id="g"><InLine><Impression>https://pixel.example/i</Impression><Creatives><Creative id="1"><NonLinearAds><NonLinear width="720" height="108"><StaticResource creativeType="image/png">https://creative.example/a.png</StaticResource></NonLinear></NonLinearAds></Creative></Creatives></InLine></Ad></VAST>';
const linearVast = (adId, creativeId = 'cr1') => `<VAST version="4.0"><Ad id="${adId}"><InLine><Creatives><Creative id="${creativeId}"><Linear><Duration>00:00:15</Duration><MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1280">https://c.example/ad.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`;

const cleanups = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); });

function frozenClock(t, apis = ['Date']) {
  t.mock.timers.enable({ apis, now: NOW });
}

// A session that renders commerce, a video double and a fetch double that answers IL's routes and GAM.
function rig({ plan, product = (url) => (url.pathname.endsWith('/break-product') ? fixture('break-product-card.json') : null), planOrigin = CONSOLE, start = 0 } = {}) {
  const video = new EventTarget();
  Object.assign(video, { currentTime: start, paused: true, ended: false, played: { length: 0 }, pause() {}, play: async () => {} });
  const linear = [], added = [], removed = [], asked = [], graphics = [], events = [];
  const held = new Set();
  const session = {
    commerce: { locale: 'es' }, sceneFeatures: null, holding: (id) => held.has(id),
    setLinearAd(value, identity) { linear.push([value, identity]); },
    addCue(cue) { added.push(cue); return true; },
    removeCue(id) { removed.push(id); return true; },
    closeProduct() {},
  };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'pubads.g.doubleclick.net') {
      graphics.push(url);
      return { ok: true, status: 200, text: async () => superVast };
    }
    if (url.origin === CONSOLE) {
      asked.push(url);
      const body = product(url);
      return { ok: true, status: body ? 200 : 204, json: async () => body };
    }
    return { ok: true, status: 200 };
  };
  const ads = attachAds({ session, video, plan, fetchImpl, planOrigin, onEvent: (event) => events.push(event) });
  cleanups.push(() => ads.destroy());
  const at = async (seconds, type = 'timeupdate') => {
    video.currentTime = seconds;
    video.paused = false;
    video.dispatchEvent(new Event(type));
    await flush();
  };
  return { ads, session, video, linear, added, removed, asked, graphics, events, held, at };
}

// --- A. The app route ---------------------------------------------------------------------------------------------

test('planUrl builds the app route with app= and renew=, and keeps the page route unchanged', () => {
  assert.equal(planUrl({ origin: CONSOLE, project: PROJECT, asset: ASSET }),
    `${CONSOLE}/il-player/ad-plan?project=${PROJECT}&asset=${ASSET}`);
  assert.equal(planUrl({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP }),
    `${CONSOLE}/il-player/app-plan?project=${PROJECT}&asset=${ASSET}&app=tizen%3AAbCdEfGhIj.ILDemo`);
  assert.equal(planUrl({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: 'android:com.example.tv', renew: 'a.b+c' }),
    `${CONSOLE}/il-player/app-plan?project=${PROJECT}&asset=${ASSET}&app=android%3Acom.example.tv&renew=a.b%2Bc`);
  for (const app of ['tizen:short.App', 'tizen:', 'web:x.y', 'android:com', 'roku:abc', '', `apple:${'a.'.repeat(80)}b`]) {
    assert.throws(() => planUrl({ origin: CONSOLE, project: PROJECT, asset: ASSET, app }), TypeError, app);
  }
  assert.doesNotThrow(() => planUrl({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: 'roku:dev' }));
});

test('loadAppPlan requests exactly the app route without credentials and returns v1 and v2 plans', async (t) => {
  frozenClock(t);
  for (const name of ['app-plan-v1.json', 'app-plan-v2.json']) {
    const seen = [];
    const plan = await loadAppPlan({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP,
      fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(fixture(name))); } });
    assert.equal(plan.version, name.includes('v2') ? 2 : 1);
    assert.equal(seen[0].url, `${CONSOLE}/il-player/app-plan?project=${PROJECT}&asset=${ASSET}&app=tizen%3AAbCdEfGhIj.ILDemo`);
    assert.equal(seen[0].init.credentials, 'omit');
    assert.equal(seen[0].init.redirect, 'error');
    assert.ok(seen[0].init.signal);
  }
});

test('loadAppPlan: 204 and 404 play without ads and report the exact app= value; timeout and network too', async (t) => {
  for (const status of [204, 404]) {
    const events = [];
    const plan = await loadAppPlan({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, onEvent: (e) => events.push(e),
      fetchImpl: async () => new Response(null, { status }) });
    assert.equal(plan, null);
    assert.deepEqual(events, [{ type: 'plan_unavailable', app: APP, status, reason: `http_${status}` }]);
  }
  const events = [];
  const network = await loadAppPlan({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, onEvent: (e) => events.push(e),
    fetchImpl: async () => { throw new TypeError('offline'); } });
  assert.equal(network, null);
  assert.deepEqual(events, [{ type: 'plan_unavailable', app: APP, status: 0, reason: 'network' }]);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = [];
  const pending = loadAppPlan({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, onEvent: (e) => slow.push(e),
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  t.mock.timers.tick(3999);
  await flush();
  assert.deepEqual(slow, []);
  t.mock.timers.tick(1);
  assert.equal(await pending, null);
  assert.deepEqual(slow, [{ type: 'plan_unavailable', app: APP, status: 0, reason: 'timeout' }]);
});

// --- B. Version 2 -------------------------------------------------------------------------------------------------

test('version 2 is accepted only with the native GAM contract and an expiry at most 120 s ahead', async (t) => {
  frozenClock(t);
  const v2 = fixture('app-plan-v2.json');
  const cases = [
    [v2, true],
    [{ ...v2, native_gam: { contract: 'something-else' } }, false],
    [{ ...v2, native_gam: undefined }, false],
    [{ ...v2, expires_at: new Date(NOW + 120001).toISOString() }, false],
    [{ ...v2, expires_at: new Date(NOW - 1).toISOString() }, false],
    [fixture('app-plan-v1.json'), true],
  ];
  for (const [plan, ok] of cases) {
    const loaded = await loadPlan(`${CONSOLE}/il-player/app-plan?project=p&asset=a&app=${APP}`, { fetchImpl: async () => new Response(JSON.stringify(plan)) });
    assert.equal(!!loaded, ok, JSON.stringify(plan.native_gam) + plan.expires_at);
    const r = rig({ plan });
    assert.equal(r.ads.cuts.length > 0, ok);
  }
});

test('a version 2 plan stops at its expiry and emits plan_expired', async (t) => {
  frozenClock(t, ['Date', 'setTimeout']);
  const r = rig({ plan: fixture('app-plan-v2.json') });
  t.mock.timers.tick(119999);
  assert.ok(!r.events.some((e) => e.type === 'plan_expired'));
  t.mock.timers.tick(1);
  assert.deepEqual(r.events.filter((e) => e.type === 'plan_expired'), [{ type: 'plan_expired' }]);
});

// A renewed v2 plan of the same view: a new grant and a new expiry, the same session.
function renewedV2(from, now) {
  const plan = structuredClone(from);
  const swap = (href) => href.replace(/grant=[^&]+/, 'grant=renewed-grant');
  plan.commerce.url = swap(plan.commerce.url);
  plan.commerce.break_url = swap(plan.commerce.break_url);
  plan.expires_at = new Date(now + 120000).toISOString();
  return plan;
}

test('replacePlan keeps what was shown and the commerce session, and uses the new grant and expiry', async (t) => {
  frozenClock(t, ['Date', 'setTimeout']);
  const v2 = fixture('app-plan-v2.json');
  const card = fixture('scene-product-card.json');
  const r = rig({ plan: v2, product: (url) => (url.pathname.endsWith('/scene-product') ? { ...card, start: 0, end: 9000 } : null) });
  await r.at(1, 'playing');
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].searchParams.get('window'), 'p1');
  assert.equal(r.added.length, 1);
  t.mock.timers.tick(100000);
  assert.equal(r.ads.replacePlan(renewedV2(v2, Date.now())), true);
  // Nothing replayed, nothing removed, nothing asked twice.
  await r.at(2);
  assert.equal(r.asked.length, 1);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.removed, []);
  // The old expiry no longer applies; the new one does.
  t.mock.timers.tick(30000);
  assert.ok(!r.events.some((e) => e.type === 'plan_expired'));
  // The next product goes out with the renewed grant.
  await r.at(46);
  assert.equal(r.asked.at(-1).searchParams.get('window'), 'm1');
  assert.equal(grantOf(r.asked.at(-1).href), 'renewed-grant');
  t.mock.timers.tick(90000);
  assert.ok(r.events.some((e) => e.type === 'plan_expired'));
});

test('replacePlan refuses another video or an invalid plan; a v1 answer to v2 is adopted and v2 over v1 gets an expiry', async (t) => {
  frozenClock(t, ['Date', 'setTimeout']);
  const v2 = fixture('app-plan-v2.json');
  const r = rig({ plan: v2 });
  assert.equal(r.ads.replacePlan({ ...renewedV2(v2, NOW), asset_version: 'other' }), false);
  assert.equal(r.ads.replacePlan({ ...renewedV2(v2, NOW), native_gam: undefined }), false);
  assert.equal(r.ads.replacePlan(fixture('app-plan-v1.json')), true);
  t.mock.timers.tick(200000);
  assert.ok(!r.events.some((e) => e.type === 'plan_expired'), 'a version 1 plan has no short expiry');
  const v1 = rig({ plan: fixture('app-plan-v1.json') });
  assert.equal(v1.ads.replacePlan(renewedV2(v2, Date.now())), true);
  t.mock.timers.tick(120000);
  assert.ok(v1.events.some((e) => e.type === 'plan_expired'));
});

test('attachAppAds renews a version 2 plan 20 s before expiry with renew=<grant> and swaps it in', async (t) => {
  frozenClock(t, ['Date', 'setTimeout']);
  const v2 = fixture('app-plan-v2.json');
  const urls = [];
  const events = [];
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: true, pause() {}, play: async () => {} });
  const session = { commerce: { locale: 'es' }, setLinearAd() {}, addCue: () => true, removeCue: () => true, closeProduct() {} };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/il-player/app-plan') {
      urls.push(url);
      return new Response(JSON.stringify(url.searchParams.get('renew') ? renewedV2(v2, Date.now()) : v2));
    }
    return new Response(null, { status: 204 });
  };
  const ads = await attachAppAds({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, session, video, fetchImpl, onEvent: (e) => events.push(e) });
  cleanups.push(() => ads.destroy());
  assert.ok(ads.cuts.length > 0);
  t.mock.timers.tick(99999);
  await flush();
  assert.equal(urls.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get('renew'), grantOf(v2.commerce.url));
  assert.equal(urls[1].searchParams.get('app'), APP);
  t.mock.timers.tick(25000);
  assert.ok(!events.some((e) => e.type === 'plan_expired'));
  // It keeps renewing the renewed plan.
  t.mock.timers.tick(75000);
  await flush();
  assert.equal(urls.length, 3);
  assert.equal(urls[2].searchParams.get('renew'), 'renewed-grant');
  ads.destroy();
  t.mock.timers.tick(200000);
  await flush();
  assert.equal(urls.length, 3);
});

test('attachAppAds without a plan returns the inert module', async () => {
  const ads = await attachAppAds({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, session: {}, video: new EventTarget(),
    fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.deepEqual(ads.cuts, []);
  assert.equal(ads.replacePlan({}), false);
});

// C (Buy through break_url with a plan cut id, for an ad IMA plays) is test/break-buy.test.mjs; on AVPlay,
// test/avplay-native.test.mjs. Below, the at-<ms> cut of host-driven breaks.

// --- D. Host-driven breaks ----------------------------------------------------------------------------------------

test('a host plan requests no video ad; a reported ad gets its break card with cut=at-<ms> per the README rules', async (t) => {
  frozenClock(t);
  const r = rig({ plan: fixture('host-plan.json') });
  assert.deepEqual(r.ads.cuts, []);
  assert.ok(!r.ads.vmap().includes('AdBreak'));
  // The fixture's per-break tag carries the backend's correlator; the tag is read from it as given.
  assert.ok(new URL(STABLE.ad_tag_url).searchParams.has('correlator'));
  r.ads.breakStarted(58);
  assert.deepEqual(r.linear.at(-1), [true, undefined]);
  r.ads.setBreakAd({ tagUrl: STABLE.ad_tag_url, adId: `il-shop-midroll-${DLV}`, creativeId: 'cr1' });
  await flush();
  assert.equal(r.asked.length, 1);
  const host = fixture('host-plan.json');
  assert.equal(r.asked[0].href, `${host.commerce.break_url}&cut=at-58000&tag=T_mid&creative=cr1&delivery=${DLV}&locale=es`);
  assert.deepEqual(r.linear.at(-1), [true, { creativeId: 'cr1', deliveryId: DLV }]);
  assert.equal(r.added.at(-1).id, DLV);
  assert.equal(r.added.at(-1).format, 'midroll');
  r.ads.clearBreakAd();
  assert.deepEqual(r.removed, [DLV]);
  r.ads.breakEnded();
  assert.deepEqual(r.linear.at(-1), [false, undefined]);
});

test('a pre-roll is at-0, the raw VAST works instead of the ids, and an ad without il-shop- asks nothing', async (t) => {
  frozenClock(t);
  const r = rig({ plan: fixture('host-plan.json'), product: (url) => ({ ...fixture('break-product-card.json'), start: 0 }) });
  r.ads.setBreakAd({ at: 0, tagUrl: STABLE.ad_tag_url.replace('T_mid', 'T_pre'), vastXml: linearVast(`il-shop-preroll-${DLV}`) });
  await flush();
  assert.equal(r.asked.length, 1);
  const q = r.asked[0].searchParams;
  assert.deepEqual([q.get('cut'), q.get('tag'), q.get('creative'), q.get('delivery')], ['at-0', 'T_pre', 'cr1', DLV]);
  r.ads.clearBreakAd();
  for (const ad of [{ adId: 'plain-ad', creativeId: 'cr1' }, { adId: `il-shop-preroll-${DLV}`, creativeId: 'cr1' },
    { vastXml: linearVast('nope') }, { adId: `il-shop-midroll-${DLV}` }]) {
    r.ads.breakEnded();
    r.ads.breakStarted(58);
    r.ads.setBreakAd({ tagUrl: STABLE.ad_tag_url, ...ad });
    await flush();
  }
  // A GAM tag has no iADServer tag: no product either.
  r.ads.setBreakAd({ tagUrl: fixture('break-request-gam.json').ad_tag_url, adId: `il-shop-midroll-${DLV}`, creativeId: 'cr1' });
  await flush();
  assert.equal(r.asked.length, 1);
});

test('nothing of IL is drawn during a reported break; graphics resume after breakEnded', async (t) => {
  frozenClock(t);
  const r = rig({ plan: fixture('host-plan.json'), start: 10 });
  r.ads.breakStarted(10);
  await r.at(16, 'playing');
  await r.at(17);
  assert.equal(r.graphics.length, 0);
  r.ads.breakEnded();
  await r.at(18);
  assert.equal(r.graphics.length, 1);
  assert.equal(new URLSearchParams(r.graphics[0].searchParams.get('cust_params')).get('ilayers_context') != null, true);
});

test('setBreaks keeps the plan clearance around the host breaks', async (t) => {
  frozenClock(t);
  const plan = fixture('host-plan.json');
  plan.scenes.pacing.cut_clearance_seconds = 5;
  const r = rig({ plan });
  // p2 is 15-24 s: a break at 20 s leaves 15-15 (too short) after clearance, so nothing is asked there.
  r.ads.setBreaks([20]);
  await r.at(14, 'playing');
  await r.at(16);
  assert.equal(r.graphics.length, 0);
  r.ads.setBreaks([]);
  await r.at(17);
  assert.equal(r.graphics.length, 1);
});

test('a host that reports nothing gets scene graphics by content time and no Buy', async (t) => {
  frozenClock(t);
  const r = rig({ plan: fixture('host-plan.json') });
  await r.at(1, 'playing');
  await r.at(16);
  assert.ok(r.graphics.length >= 1);
  assert.ok(!r.asked.some((url) => url.pathname.endsWith('/break-product')));
  r.ads.setBreakAd({ tagUrl: STABLE.ad_tag_url, adId: `il-shop-midroll-${DLV}`, creativeId: 'cr1' });
  await flush();
  assert.ok(!r.asked.some((url) => url.pathname.endsWith('/break-product')), 'no ad without a reported break');
});

test('an open product outlives the reported ad and the break', async (t) => {
  frozenClock(t);
  const r = rig({ plan: fixture('host-plan.json') });
  r.ads.breakStarted(58);
  r.ads.setBreakAd({ tagUrl: STABLE.ad_tag_url, adId: `il-shop-midroll-${DLV}`, creativeId: 'cr1' });
  await flush();
  r.held.add(DLV);
  r.ads.clearBreakAd();
  r.ads.breakEnded();
  assert.deepEqual(r.removed, []);
  r.held.delete(DLV);
});

test('vastIdentity reads Ad@id and the linear Creative@id, and nothing from a bad document', () => {
  assert.deepEqual(vastIdentity(linearVast(`il-shop-midroll-${DLV}`, 'c9')), { adId: `il-shop-midroll-${DLV}`, creativeId: 'c9' });
  assert.deepEqual(vastIdentity('<nope/>'), {});
  assert.deepEqual(vastIdentity('<!DOCTYPE x><VAST/>'), {});
});

test('the existing page-route plan and setBreakActive keep working', async (t) => {
  frozenClock(t);
  const plan = await loadPlan(planUrl({ origin: CONSOLE, project: PROJECT, asset: ASSET }),
    { fetchImpl: async () => new Response(JSON.stringify(fixture('app-plan-v1.json'))) });
  assert.equal(plan.version, 1);
  const r = rig({ plan: fixture('host-plan.json'), start: 10 });
  r.ads.setBreakActive(true);
  await r.at(16, 'playing');
  assert.equal(r.graphics.length, 0);
  assert.deepEqual(r.linear, []);
  r.ads.setBreakActive(false);
  await r.at(17);
  assert.equal(r.graphics.length, 1);
});

// --- Review rules shared by every platform -----------------------------------------------------------------------

test('host mode: clearance applies around the positions the host reports with breakStarted, none without reports', async (t) => {
  frozenClock(t);
  const plan = () => { const p = fixture('host-plan.json'); p.scenes.pacing.cut_clearance_seconds = 5; return p; };
  // Nothing reported: p2 (15-24 s) is asked normally.
  const free = rig({ plan: plan() });
  await free.at(14, 'playing');
  assert.equal(free.graphics.length, 1);
  // A break reported at 20 s: p2 shrinks to 15-15 and is never asked, even after the break ends.
  const r = rig({ plan: plan() });
  r.ads.breakStarted(20);
  r.ads.breakEnded();
  await r.at(14, 'playing');
  await r.at(16);
  assert.equal(r.graphics.length, 0);
});

test('a host break that never ends is closed by the guard after 120 s with break_error, and graphics resume', async (t) => {
  frozenClock(t, ['Date', 'setTimeout']);
  const r = rig({ plan: fixture('host-plan.json'), start: 10 });
  r.ads.breakStarted(10);
  await r.at(16, 'playing');
  assert.equal(r.graphics.length, 0);
  t.mock.timers.tick(119999);
  assert.ok(!r.events.some((e) => e.type === 'break_error'));
  t.mock.timers.tick(1);
  assert.deepEqual(r.events.filter((e) => e.type === 'break_error'), [{ type: 'break_error', cut: 'at-10000' }]);
  assert.deepEqual(r.linear.at(-1), [false, undefined]);
  await r.at(17);
  assert.equal(r.graphics.length, 1);
});

test('destroy, expiry and replacement during a host break never touch the host player', async (t) => {
  frozenClock(t, ['Date', 'setTimeout']);
  const v2 = fixture('app-plan-v2.json');
  for (const action of ['destroy', 'replace', 'expire']) {
    const r = rig({ plan: v2 });
    const touched = [];
    r.video.play = () => { touched.push('play'); };
    r.video.pause = () => { touched.push('pause'); };
    r.video.paused = false;
    r.ads.breakStarted(58);
    if (action === 'destroy') r.ads.destroy();
    if (action === 'expire') t.mock.timers.tick(120000);
    if (action === 'replace') assert.equal(r.ads.replacePlan(renewedV2(v2, Date.now())), true);
    assert.deepEqual(touched, [], action);
    assert.equal(r.video.currentTime, 0, action);
    if (action !== 'replace') assert.deepEqual(r.linear.at(-1), [false, undefined], action);
  }
});

test('at-<ms> rounds to the nearest millisecond; a negative or non-finite position is refused with one event', async (t) => {
  frozenClock(t);
  const r = rig({ plan: fixture('host-plan.json') });
  r.ads.setBreakAd({ at: 58.0006, tagUrl: STABLE.ad_tag_url, adId: `il-shop-midroll-${DLV}`, creativeId: 'cr1' });
  await flush();
  assert.equal(r.asked.at(-1).searchParams.get('cut'), 'at-58001');
  r.ads.breakEnded();
  for (const at of [-1, NaN, Infinity]) r.ads.breakStarted(at);
  r.ads.setBreakAd({ at: -0.5, tagUrl: STABLE.ad_tag_url, adId: `il-shop-midroll-${DLV}`, creativeId: 'cr1' });
  await flush();
  assert.equal(r.events.filter((e) => e.type === 'break_refused').length, 4);
  assert.deepEqual(r.events.find((e) => e.type === 'break_refused'), { type: 'break_refused', reason: 'position' });
  assert.equal(r.asked.filter((u) => u.pathname.endsWith('/break-product')).length, 1);
});

test('a host with another session id gets buy_unavailable once instead of a silent missing Buy', async (t) => {
  frozenClock(t);
  const events = [];
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: true });
  const session = { commerce: { locale: 'es' }, setLinearAd() {}, addCue: () => true, removeCue: () => true, closeProduct() {} };
  const fetchImpl = async () => ({ ok: true, status: 204 });
  const ads = attachAds({ session, video, plan: fixture('host-plan.json'), fetchImpl, planOrigin: CONSOLE, sessionId: 'host-view', onEvent: (e) => events.push(e) });
  cleanups.push(() => ads.destroy());
  ads.breakStarted(58);
  ads.setBreakAd({ tagUrl: STABLE.ad_tag_url, adId: `il-shop-midroll-${DLV}`, creativeId: 'cr1' });
  assert.deepEqual(events.filter((e) => e.type === 'buy_unavailable'), [{ type: 'buy_unavailable', reason: 'session' }]);
  // A plan without break_url has no Buy to miss: nothing said.
  const quiet = [];
  const plan = fixture('host-plan.json');
  delete plan.commerce.break_url;
  const other = attachAds({ session, video, plan, fetchImpl, planOrigin: CONSOLE, sessionId: 'host-view', onEvent: (e) => quiet.push(e) });
  cleanups.push(() => other.destroy());
  assert.equal(quiet.filter((e) => e.type === 'buy_unavailable').length, 0);
});

test('no grant, renew value or commerce URL reaches anything a host can observe (load, renewal, scene and break card)', async (t) => {
  frozenClock(t, ['Date', 'setTimeout']);
  const v2 = fixture('app-plan-v2.json');
  const secrets = [grantOf(v2.commerce.url), 'renewed-grant', 'renew=', '/il-player/scene-product', '/il-player/break-product'];
  const events = [];
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: true, played: { length: 0 }, pause() {}, play: async () => {} });
  const session = { commerce: { locale: 'es' }, sceneFeatures: null, holding: () => false, setLinearAd() {}, addCue: () => true, removeCue: () => true, closeProduct() {} };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/il-player/app-plan') {
      if (url.searchParams.get('renew')) return new Response(JSON.stringify(renewedV2(v2, Date.now())));
      return new Response(JSON.stringify(v2));
    }
    if (url.pathname === '/il-player/scene-product') return new Response(JSON.stringify({ ...fixture('scene-product-card.json'), start: 0, end: 9000 }));
    if (url.pathname === '/il-player/break-product') return new Response(JSON.stringify(fixture('break-product-card.json')));
    if (url.hostname === 'pubads.g.doubleclick.net') return new Response(superVast);
    return new Response(null, { status: 204 });
  };
  const ads = await attachAppAds({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, session, video, fetchImpl, onEvent: (e) => events.push(e) });
  cleanups.push(() => ads.destroy());
  video.currentTime = 1; video.paused = false; video.dispatchEvent(new Event('playing'));
  await flush();
  ads.breakStarted(58);
  ads.setBreakAd({ tagUrl: STABLE.ad_tag_url, adId: `il-shop-midroll-${DLV}`, creativeId: 'cr1' });
  await flush();
  t.mock.timers.tick(100000);
  await flush();
  assert.ok(events.some((e) => e.type === 'plan_renewed' && e.version === 2));
  assert.ok(events.some((e) => e.type === 'request'));
  const observed = JSON.stringify(events) + JSON.stringify(Object.entries(ads).map(([k, v]) => [k, typeof v === 'function' ? '' : v]));
  for (const secret of secrets) assert.ok(!observed.includes(secret), secret);
});

test('attachAppAds: a v1 answer to a v2 renewal is adopted and stops renewals; a v2 plan swapped into a v1 view starts them', async (t) => {
  frozenClock(t, ['Date', 'setTimeout']);
  const v2 = fixture('app-plan-v2.json');
  const urls = [];
  const events = [];
  let answerV1 = true;
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: true });
  const session = { setLinearAd() {}, addCue: () => true, removeCue: () => true, closeProduct() {} };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== '/il-player/app-plan') return new Response(null, { status: 204 });
    urls.push(url);
    return new Response(JSON.stringify(url.searchParams.get('renew') && answerV1 ? fixture('app-plan-v1.json') : v2));
  };
  const ads = await attachAppAds({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, session, video, fetchImpl, onEvent: (e) => events.push(e) });
  cleanups.push(() => ads.destroy());
  t.mock.timers.tick(100000);
  await flush();
  assert.deepEqual(events.filter((e) => e.type === 'plan_renewed'), [{ type: 'plan_renewed', version: 1 }]);
  t.mock.timers.tick(600000);
  await flush();
  assert.equal(urls.length, 2, 'no renewal after a version 1 answer');
  answerV1 = false;
  assert.equal(ads.replacePlan(renewedV2(v2, Date.now())), true);
  t.mock.timers.tick(100000);
  await flush();
  assert.equal(urls.length, 3);
  assert.equal(urls[2].searchParams.get('renew'), 'renewed-grant');
});

test('plan_unavailable: a refused application id is app_id, an unbuildable URL is request, both with the app value', async () => {
  const events = [];
  assert.equal(await loadAppPlan({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: 'tizen:bad', onEvent: (e) => events.push(e), fetchImpl: async () => assert.fail('no request') }), null);
  assert.equal(await loadAppPlan({ origin: 'http://insecure.example', project: PROJECT, asset: ASSET, app: APP, onEvent: (e) => events.push(e), fetchImpl: async () => assert.fail('no request') }), null);
  assert.deepEqual(events, [
    { type: 'plan_unavailable', app: 'tizen:bad', status: 0, reason: 'app_id' },
    { type: 'plan_unavailable', app: APP, status: 0, reason: 'request' },
  ]);
});

test('app route only: msid and an from appParams go on GAM requests unless the tag has them; the page route is unchanged', async (t) => {
  frozenClock(t);
  const v1 = fixture('app-plan-v1.json');
  const graphics = [];
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: true, played: { length: 0 } });
  const session = { setLinearAd() {}, addCue: () => true, removeCue: () => true, closeProduct() {} };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/il-player/app-plan') return new Response(JSON.stringify(v1));
    if (url.hostname === 'pubads.g.doubleclick.net') { graphics.push(url); return new Response(superVast); }
    return new Response(null, { status: 204 });
  };
  const ads = await attachAppAds({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, session, video, fetchImpl,
    appParams: { msid: 'com.example.ildemo.tizen', an: 'IL Demo' } });
  cleanups.push(() => ads.destroy());
  const gamCut = ads.cuts.flatMap((cut) => cut.requests).find((request) => request.provider === 'gam');
  assert.equal(new URL(gamCut.tagUrl).searchParams.get('msid'), 'com.example.ildemo.tizen');
  assert.equal(new URL(gamCut.tagUrl).searchParams.get('an'), 'IL Demo');
  assert.ok(ads.cuts.flatMap((cut) => cut.requests).filter((r) => r.provider === 'iadserver').every((r) => !new URL(r.tagUrl).searchParams.has('msid')));
  video.currentTime = 11; video.paused = false; video.dispatchEvent(new Event('playing'));
  await flush();
  assert.equal(graphics[0]?.searchParams.get('an'), 'IL Demo');
  // A tag that already carries msid keeps its own.
  const own = structuredClone(v1);
  own.scenes.graphics[0].tag_url += '&msid=tag.own';
  const r = rig({ plan: own });
  const kept = new URL(graphicTag(own.scenes.graphics[0].tag_url, 'super', {}, undefined, { msid: 'x.y', an: 'Z' }));
  assert.deepEqual([kept.searchParams.get('msid'), kept.searchParams.get('an')], ['tag.own', 'Z']);
  // The page route (no appParams) adds nothing.
  assert.ok(r.ads.cuts.flatMap((cut) => cut.requests).every((request) => !new URL(request.tagUrl).searchParams.has('msid') && !new URL(request.tagUrl).searchParams.has('an')));
  await r.at(11, 'playing');
  assert.ok(r.graphics.every((url) => url.searchParams.get('msid') === 'tag.own' && !url.searchParams.has('an')));
});

// Renewal answers per attempt: 'fail' (204) or 'ok' (a renewed v2).
async function renewalRig(t, answers) {
  frozenClock(t, ['Date', 'setTimeout']);
  const v2 = fixture('app-plan-v2.json');
  const events = [];
  let renewals = 0;
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: true });
  const session = { setLinearAd() {}, addCue: () => true, removeCue: () => true, closeProduct() {} };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== '/il-player/app-plan') return new Response(null, { status: 204 });
    if (!url.searchParams.get('renew')) return new Response(JSON.stringify(v2));
    return answers[renewals++] === 'ok' ? new Response(JSON.stringify(renewedV2(v2, Date.now()))) : new Response(null, { status: 204 });
  };
  const ads = await attachAppAds({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, session, video, fetchImpl, onEvent: (e) => events.push(e) });
  cleanups.push(() => ads.destroy());
  return { events, renewals: () => renewals };
}

test('renewal: a failed first attempt is retried at -12 s and succeeds without plan_renew_failed', async (t) => {
  const r = await renewalRig(t, ['fail', 'ok']);
  t.mock.timers.tick(100000);
  await flush();
  assert.equal(r.renewals(), 1);
  t.mock.timers.tick(8000);
  await flush();
  assert.equal(r.renewals(), 2);
  assert.deepEqual(r.events.filter((e) => e.type === 'plan_renewed'), [{ type: 'plan_renewed', version: 2 }]);
  assert.ok(!r.events.some((e) => e.type === 'plan_renew_failed'));
  t.mock.timers.tick(30000);
  assert.ok(!r.events.some((e) => e.type === 'plan_expired'));
});

test('renewal: three failed attempts (-20, -12, -5 s) give one plan_renew_failed with the last reason, then plan_expired', async (t) => {
  const r = await renewalRig(t, ['fail', 'fail', 'fail']);
  for (const step of [100000, 8000, 7000]) {
    t.mock.timers.tick(step);
    await flush();
  }
  assert.equal(r.renewals(), 3);
  assert.deepEqual(r.events.filter((e) => e.type === 'plan_renew_failed'), [{ type: 'plan_renew_failed', reason: 'http_204' }]);
  assert.ok(!r.events.some((e) => e.type === 'plan_expired'));
  t.mock.timers.tick(5000);
  assert.deepEqual(r.events.filter((e) => e.type === 'plan_expired'), [{ type: 'plan_expired' }]);
});

test('appParams on a plan that did not come from the app route add nothing', async (t) => {
  frozenClock(t);
  const graphics = [];
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: true, played: { length: 0 } });
  const session = { setLinearAd() {}, addCue: () => true, removeCue: () => true, closeProduct() {} };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/il-player/ad-plan') return new Response(JSON.stringify(fixture('app-plan-v1.json')));
    if (url.hostname === 'pubads.g.doubleclick.net') { graphics.push(url); return new Response(superVast); }
    return new Response(null, { status: 204 });
  };
  for (const plan of [fixture('app-plan-v1.json'), await loadPlan(planUrl({ origin: CONSOLE, project: PROJECT, asset: ASSET }), { fetchImpl })]) {
    const ads = attachAds({ session, video, plan, fetchImpl, planOrigin: CONSOLE, appParams: { msid: 'x.y', an: 'Z' } });
    cleanups.push(() => ads.destroy());
    assert.ok(ads.cuts.flatMap((cut) => cut.requests).every((r) => !new URL(r.tagUrl).searchParams.has('msid') && !new URL(r.tagUrl).searchParams.has('an')));
  }
  video.currentTime = 11; video.paused = false; video.dispatchEvent(new Event('playing'));
  await flush();
  assert.ok(graphics.length > 0);
  assert.ok(graphics.every((url) => !url.searchParams.has('msid') && !url.searchParams.has('an')));
});

test('vastIdentity prefers the inline Ad over a wrapper in the same document', () => {
  const xml = `<VAST version="4.0"><Ad id="wrapper-1"><Wrapper><VASTAdTagURI>https://a.example/v</VASTAdTagURI></Wrapper></Ad><Ad id="il-shop-midroll-${DLV}"><InLine><Creatives><Creative id="cr1"><Linear/></Creative></Creatives></InLine></Ad></VAST>`;
  assert.deepEqual(vastIdentity(xml), { adId: `il-shop-midroll-${DLV}`, creativeId: 'cr1' });
});

test('setBreakAd with another at keeps the open break: same cut, no second break', async (t) => {
  frozenClock(t, ['Date', 'setTimeout']);
  const r = rig({ plan: fixture('host-plan.json') });
  r.ads.breakStarted(58);
  const linearBefore = r.linear.length;
  r.ads.setBreakAd({ at: 60, tagUrl: STABLE.ad_tag_url, adId: `il-shop-midroll-${DLV}`, creativeId: 'cr1' });
  await flush();
  assert.equal(r.asked.at(-1).searchParams.get('cut'), 'at-58000');
  assert.deepEqual(r.linear.slice(linearBefore).map(([on]) => on), [true]);
  // The guard is the one of the open break: it fires once, 120 s after breakStarted.
  t.mock.timers.tick(120000);
  assert.deepEqual(r.events.filter((e) => e.type === 'break_error'), [{ type: 'break_error', cut: 'at-58000' }]);
});

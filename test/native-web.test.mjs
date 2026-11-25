// The app route, version 2 plans and host-driven breaks of web/ads.mjs, against the shared native fixtures.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { attachAds, attachAppAds, loadAppPlan, loadPlan, planUrl, vastIdentity } from '../web/ads.mjs';

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
    assert.deepEqual(events, [{ type: 'plan_unavailable', app: APP, status }]);
  }
  const events = [];
  const network = await loadAppPlan({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, onEvent: (e) => events.push(e),
    fetchImpl: async () => { throw new TypeError('offline'); } });
  assert.equal(network, null);
  assert.deepEqual(events, [{ type: 'plan_unavailable', app: APP, status: null, reason: 'network' }]);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = [];
  const pending = loadAppPlan({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: APP, onEvent: (e) => slow.push(e),
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  t.mock.timers.tick(3999);
  await flush();
  assert.deepEqual(slow, []);
  t.mock.timers.tick(1);
  assert.equal(await pending, null);
  assert.deepEqual(slow, [{ type: 'plan_unavailable', app: APP, status: null, reason: 'timeout' }]);
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

test('replacePlan refuses another video, a version 1 plan and a plan without the contract', async (t) => {
  frozenClock(t);
  const v2 = fixture('app-plan-v2.json');
  const r = rig({ plan: v2 });
  assert.equal(r.ads.replacePlan({ ...renewedV2(v2, NOW), asset_version: 'other' }), false);
  assert.equal(r.ads.replacePlan(fixture('app-plan-v1.json')), false);
  assert.equal(r.ads.replacePlan({ ...renewedV2(v2, NOW), native_gam: undefined }), false);
  const v1 = rig({ plan: fixture('app-plan-v1.json') });
  assert.equal(v1.ads.replacePlan(renewedV2(v2, NOW)), false);
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

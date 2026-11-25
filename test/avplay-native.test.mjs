// Samsung AVPlay: Buy during a break through commerce.break_url, host-driven breaks and the Tizen app route,
// with the AVPlay double and the shared native fixtures. Nothing here runs on a TV or a TV emulator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { attachAvPlayAds, attachAvPlayAppAds, tizenAppId } from '../web/avplay-ads.mjs';

const { DOMParser } = new JSDOM('').window;
globalThis.DOMParser = DOMParser;
const CONSOLE = 'https://console.example';
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/native/${name}`, import.meta.url), 'utf8')
  .replaceAll('http://localhost:8000', CONSOLE));
const NOW = Date.parse('2026-11-02T16:00:00Z');
const DLV = 'D'.repeat(43);
const PROJECT = 'proj_8e4cb338d66e4ec6bc6b99fd21f651f6';
const ASSET = 'asset-40edc822d6f24974a9af51695a88184b';
const STABLE = fixture('break-request-stable.json');
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
const linearVast = (adId, creativeId = 'cr1', extension = '') => `<VAST version="4.0"><Ad id="${adId}"><InLine><Impression>https://t.example/i</Impression><Creatives><Creative id="${creativeId}"><Linear>
  <Duration>00:00:15</Duration><MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1280">https://c.example/ad.mp4</MediaFile></MediaFiles>
  </Linear></Creative></Creatives>${extension}</InLine></Ad></VAST>`;

function device() {
  const player = {
    state: 'IDLE', time: 0, listener: null, url: null, calls: [],
    getState: () => player.state,
    getCurrentTime: () => player.time,
    open(url) { player.url = url; player.state = 'IDLE'; player.calls.push(`open ${url}`); },
    close() { player.state = 'NONE'; player.calls.push('close'); },
    setListener(value) { player.listener = value; },
    setDisplayRect() {},
    prepareAsync(ok) { player.state = 'READY'; ok(); },
    play() { player.state = 'PLAYING'; },
    pause() { player.state = 'PAUSED'; },
    seekTo(ms, ok) { player.time = ms; ok(); },
  };
  return player;
}

function rig(t, { plan, vast = () => linearVast(`il-shop-preroll-${DLV}`), card = () => ({ ...fixture('break-product-card-page.json') }) } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const avplay = device();
  const linear = [], added = [], removed = [], asked = [], tags = [], events = [];
  const session = { commerce: { locale: 'es' }, holding: () => false, closeProduct() {},
    setLinearAd(value, identity) { linear.push([value, identity]); },
    addCue(cue) { added.push(cue); return true; }, removeCue(id) { removed.push(id); return true; } };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/gampad/ads') {
      tags.push(url);
      return { ok: true, status: 200, text: async () => vast(url) };
    }
    if (url.origin === CONSOLE) {
      asked.push(url);
      const body = card(url);
      return { ok: true, status: body ? 200 : 204, json: async () => body };
    }
    return { ok: true, status: 200 };
  };
  const sdk = attachAvPlayAds({ avplay, session, plan, contentUrl: 'https://v.example/c.m3u8', planOrigin: CONSOLE,
    getDisplayRect: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), fetchImpl, onEvent: (e) => events.push(e),
    Parser: DOMParser, tickMs: 100000 });
  t.after(() => sdk.destroy());
  return { avplay, sdk, linear, added, removed, asked, tags, events };
}

test('a reader-owned pre-roll gets Buy through break_url with the plan cut id and the ids of the VAST it fetched', async (t) => {
  const plan = fixture('app-plan-v1.json');
  const r = rig(t, { plan });
  const done = r.sdk.start();
  await flush();
  assert.equal(r.avplay.url, 'https://c.example/ad.mp4');
  r.avplay.listener.oncurrentplaytime(500);
  await flush();
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].href, `${plan.commerce.break_url}&cut=pre&tag=T_pre&creative=cr1&delivery=${DLV}&locale=es`);
  assert.deepEqual(r.linear.at(-1), [true, { creativeId: 'cr1', deliveryId: DLV }]);
  assert.equal(r.added.at(-1).id, DLV);
  r.avplay.listener.onstreamcompleted();
  await done;
  assert.deepEqual(r.removed, [DLV]);
  assert.deepEqual(r.linear.at(-1), [false, undefined]);
});

test('an ad without the il-shop- id asks IL for nothing', async (t) => {
  const r = rig(t, { plan: fixture('app-plan-v1.json'), vast: () => linearVast('plain-ad') });
  const done = r.sdk.start();
  await flush();
  r.avplay.listener.oncurrentplaytime(500);
  await flush();
  r.avplay.listener.onstreamcompleted();
  await done;
  assert.equal(r.asked.length, 0);
});

test('a plan without break_url keeps the session-feed identity of the iADServerShop extension', async (t) => {
  const plan = fixture('app-plan-v1.json');
  delete plan.commerce.break_url;
  const extension = `<Extensions><Extension type="iADServerShop"><Shop creativeId="cx" deliveryId="${DLV}"/></Extension></Extensions>`;
  const r = rig(t, { plan, vast: () => linearVast(`il-shop-preroll-${DLV}`, 'cr1', extension) });
  const done = r.sdk.start();
  await flush();
  r.avplay.listener.oncurrentplaytime(500);
  await flush();
  r.avplay.listener.onstreamcompleted();
  await done;
  assert.equal(r.asked.length, 0);
  assert.ok(r.linear.some(([on, identity]) => on && identity?.creativeId === 'cx'));
});

test('host-driven on AVPlay: a host plan plays no ad itself; a reported break and VAST get the at-<ms> card', async (t) => {
  const host = fixture('host-plan.json');
  const r = rig(t, { plan: host, card: (url) => (url.pathname.endsWith('/break-product') ? fixture('break-product-card.json') : null) });
  r.avplay.state = 'PLAYING';
  await r.sdk.start();
  r.avplay.time = 58000;
  r.sdk.tick();
  await flush();
  // Only scene graphics are asked (GAM); no video ad is fetched or opened on AVPlay.
  assert.ok(r.tags.every((url) => url.hostname === 'pubads.g.doubleclick.net' && url.searchParams.get('cust_params').includes('il_format')));
  assert.ok(!r.avplay.calls.some((call) => call.startsWith('open ')));
  assert.deepEqual(r.sdk.cuts, []);
  r.sdk.breakStarted(58);
  r.sdk.setBreakAd({ tagUrl: STABLE.ad_tag_url, vastXml: linearVast(`il-shop-midroll-${DLV}`) });
  await flush();
  const breakCards = r.asked.filter((url) => url.pathname === '/il-player/break-product');
  assert.equal(breakCards.length, 1);
  assert.equal(breakCards[0].href, `${host.commerce.break_url}&cut=at-58000&tag=T_mid&creative=cr1&delivery=${DLV}&locale=es`);
  assert.equal(r.added.at(-1).id, DLV);
  r.sdk.clearBreakAd();
  r.sdk.breakEnded();
  assert.deepEqual(r.removed, [DLV]);
  assert.deepEqual(r.linear.at(-1), [false, undefined]);
});

test('tizenAppId reads the application id; attachAvPlayAppAds builds the app route and plays without ads on 404', async (t) => {
  const tizen = { application: { getCurrentApplication: () => ({ appInfo: { id: 'AbCdEfGhIj.ILDemo' } }) } };
  assert.equal(tizenAppId(tizen), 'AbCdEfGhIj.ILDemo');
  assert.equal(tizenAppId(undefined), null);
  const previous = globalThis.tizen;
  globalThis.tizen = tizen;
  t.after(() => { globalThis.tizen = previous; });
  const urls = [];
  const events = [];
  const result = await attachAvPlayAppAds({ origin: CONSOLE, project: PROJECT, asset: ASSET, avplay: device(), session: {},
    getDisplayRect: () => ({}), onEvent: (e) => events.push(e),
    fetchImpl: async (url) => { urls.push(url); return new Response(null, { status: 404 }); } });
  assert.equal(result, null);
  assert.equal(urls[0], `${CONSOLE}/il-player/app-plan?project=${PROJECT}&asset=${ASSET}&app=tizen%3AAbCdEfGhIj.ILDemo`);
  assert.deepEqual(events, [{ type: 'plan_unavailable', app: 'tizen:AbCdEfGhIj.ILDemo', status: 404 }]);
});

test('attachAvPlayAppAds attaches a loaded plan and renews a version 2 plan with renew=<grant>', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const v2 = fixture('app-plan-v2.json');
  const urls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/il-player/app-plan') {
      urls.push(url);
      const plan = structuredClone(v2);
      if (url.searchParams.get('renew')) plan.expires_at = new Date(Date.now() + 120000).toISOString();
      return new Response(JSON.stringify(plan));
    }
    return new Response(null, { status: 204 });
  };
  const sdk = await attachAvPlayAppAds({ origin: CONSOLE, project: PROJECT, asset: ASSET, app: 'tizen:AbCdEfGhIj.ILDemo', avplay: device(),
    session: { setLinearAd() {}, addCue: () => true, removeCue: () => true }, getDisplayRect: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    fetchImpl, Parser: DOMParser, tickMs: 1e9 });
  t.after(() => sdk.destroy());
  assert.ok(sdk.cuts.length > 0);
  t.mock.timers.tick(100000);
  await flush();
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get('renew'), new URL(v2.commerce.url).searchParams.get('grant'));
  assert.ok(sdk.cuts.length > 0);
});

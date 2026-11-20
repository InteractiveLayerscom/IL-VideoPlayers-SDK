import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachAds, loadPlan, parseGraphicVast, planUrl, usableWindows } from '../web/ads.mjs';
import { normalizeCue } from '../web/cues.mjs';

globalThis.DOMParser = new JSDOM('').window.DOMParser;

const TAG = 'https://pubads.g.doubleclick.net/gampad/ads?iu=/123/site/graphic&env=vp&gdfp_req=1&output=vast&cust_params=il_format%3Dsuper%26campaign%3D42&sz=640x360';
const inline = (format = 'super') => `<VAST version="3.0"><Ad id="ad"><InLine><AdTitle>Campaign</AdTitle><Impression>https://pixel.invalid/impression</Impression><Creatives><Creative id="123"><NonLinearAds><TrackingEvents><Tracking event="creativeView">https://pixel.invalid/view</Tracking></TrackingEvents><NonLinear width="${format === 'super' ? 720 : 960}" height="${format === 'super' ? 108 : 540}"><StaticResource creativeType="image/png">https://creative.invalid/art.png</StaticResource><NonLinearClickThrough>https://landing.invalid/</NonLinearClickThrough><NonLinearClickTracking>https://pixel.invalid/click</NonLinearClickTracking></NonLinear></NonLinearAds></Creative></Creatives></InLine></Ad></VAST>`;

function makePlan({ formats = ['super', 'l_shape', 'overlay_300x250'], pacing = {}, windows, cuts, graphics, ...rest } = {}) {
  return {
    version: 1, asset_id: 'a', asset_version: 'v', duration: 300, revision: 'r',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    page_url: 'https://publisher.example/video',
    cuts: cuts ?? [{ id: 'pre', at: 0, position: 'preroll', tag_url: TAG, contextual: false }],
    scenes: {
      formats,
      pacing: { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0, ...pacing },
      graphics: graphics ?? [{ format: 'super', tag_url: TAG }, { format: 'l_shape', tag_url: TAG.replace('super', 'l_shape') }],
      overlay: { ad_unit: '/123/site/overlay', size: [300, 250] },
      windows: windows ?? [{ id: 'p17', start_ms: 41200, end_ms: 52900, targeting: { ilayers_context: 'cocina' } }],
    },
    ...rest,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options = {}) {
  const { answer = (format) => inline(format), pageUrl, start = 0 } = options;
  const plan = 'plan' in options ? options.plan : makePlan();
  const video = new EventTarget();
  video.currentTime = start;
  video.paused = true;
  const requests = [], pixels = [], events = [], added = [], removed = [];
  const session = {
    addCue(cue, hooks) { added.push({ cue, hooks }); return true; },
    removeCue(id) { removed.push(id); return true; },
  };
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/gampad/ads')) {
      requests.push({ url: new URL(url), init });
      const format = new URLSearchParams(new URL(url).searchParams.get('cust_params')).get('il_format');
      return { ok: true, text: async () => answer(format) };
    }
    pixels.push({ url, init });
    return { ok: true };
  };
  const ads = attachAds({ session, video, plan, pageUrl, fetchImpl, onEvent: (event) => events.push(event) });
  const at = async (seconds, type = 'timeupdate') => {
    video.currentTime = seconds;
    video.paused = false;
    video.dispatchEvent(new Event(type));
    await flush();
  };
  return { video, ads, requests, pixels, events, added, removed, at };
}

test('nothing is requested without a valid, current plan', async () => {
  for (const plan of [undefined, null, {}, { ...makePlan(), version: 2 }, makePlan({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    { ...makePlan(), expires_at: undefined }, { ...makePlan(), scenes: undefined }]) {
    const h = harness({ plan, start: 45 });
    await h.at(45);
    assert.equal(h.requests.length, 0);
    assert.equal(h.added.length, 0);
    h.ads.destroy();
  }
});

test('nothing is requested after destroy', async () => {
  const h = harness();
  await h.at(10);
  h.ads.destroy();
  await h.at(40);
  await h.at(45);
  assert.equal(h.requests.length, 0);
});

test('requests about four seconds ahead with merged targeting, a fresh correlator and the page URL', async () => {
  const h = harness();
  await h.at(37);
  assert.equal(h.requests.length, 0);
  await h.at(37.3);
  assert.equal(h.requests.length, 1);
  const { url, init } = h.requests[0];
  assert.equal(url.origin + url.pathname, 'https://pubads.g.doubleclick.net/gampad/ads');
  assert.equal(url.searchParams.get('iu'), '/123/site/graphic');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(url.searchParams.get('cust_params'))),
    { il_format: 'super', campaign: '42', ilayers_context: 'cocina' });
  assert.match(url.searchParams.get('correlator'), /^\d{13,}$/);
  assert.equal(url.searchParams.get('url'), 'https://publisher.example/video');
  assert.equal(url.searchParams.get('description_url'), 'https://publisher.example/video');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal);
  assert.deepEqual(h.events.slice(0, 2).map((e) => e.type), ['request', 'fill']);
  assert.deepEqual(h.events[0], { type: 'request', format: 'super', window: 'p17' });
  h.ads.destroy();
});

test('pageUrl overrides the plan and window keys win over the tag', async () => {
  const plan = makePlan({ windows: [{ id: 'w', start_ms: 10000, end_ms: 20000, targeting: { campaign: '7', topics: ['a', 'b'], il_format: 'x' } }] });
  const h = harness({ plan, pageUrl: 'https://other.example/page' });
  await h.at(9);
  const { url } = h.requests[0];
  assert.equal(url.searchParams.get('url'), 'https://other.example/page');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(url.searchParams.get('cust_params'))),
    { il_format: 'super', campaign: '7', topics: 'a,b' });
  h.ads.destroy();
});

test('correlators differ between requests', async () => {
  const plan = makePlan({ windows: [{ id: 'a', start_ms: 10000, end_ms: 15000 }, { id: 'b', start_ms: 50000, end_ms: 55000 }] });
  const h = harness({ plan, answer: () => '<VAST version="3.0"/>' });
  await h.at(10);
  await h.at(50);
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.requests[0].url.searchParams.get('correlator'), h.requests[1].url.searchParams.get('correlator'));
  h.ads.destroy();
});

test('a fill becomes a super cue over the usable window with its click-through', async () => {
  const h = harness();
  await h.at(38);
  assert.equal(h.added.length, 1);
  const { cue } = h.added[0];
  assert.deepEqual(cue, { id: 'il-ads-p17', format: 'super', start: 41200, end: 52900,
    imageUrl: 'https://creative.invalid/art.png', mimeType: 'image/png', clickUrl: 'https://landing.invalid/' });
  assert.equal(normalizeCue(cue).clickUrl, 'https://landing.invalid/');
  h.ads.destroy();
});

test('l_shape maps to the SDK format l', async () => {
  const h = harness({ plan: makePlan({ formats: ['l_shape'] }) });
  await h.at(42);
  assert.equal(h.added[0].cue.format, 'l');
  assert.equal(new URLSearchParams(h.requests[0].url.searchParams.get('cust_params')).get('il_format'), 'l_shape');
  h.ads.destroy();
});

test('impression and creativeView fire once on visibility, click tracking on click', async () => {
  const h = harness();
  await h.at(42);
  const { cue, hooks } = h.added[0];
  assert.equal(h.pixels.length, 0);
  hooks.onVisible(cue);
  hooks.onVisible(cue);
  assert.deepEqual(h.pixels.map((p) => p.url), ['https://pixel.invalid/impression', 'https://pixel.invalid/view']);
  assert.deepEqual(h.pixels[0].init, { mode: 'no-cors', credentials: 'omit', keepalive: true });
  hooks.onClick(cue);
  assert.equal(h.pixels.at(-1).url, 'https://pixel.invalid/click');
  assert.deepEqual(h.events.map((e) => e.type), ['request', 'fill', 'impression', 'click']);
  h.ads.destroy();
});

test('the cue is removed when the window ends and on destroy', async () => {
  const h = harness();
  await h.at(42);
  await h.at(52.8);
  assert.deepEqual(h.removed, []);
  await h.at(53);
  assert.deepEqual(h.removed, ['il-ads-p17']);
  const other = harness();
  await other.at(42);
  other.ads.destroy();
  assert.deepEqual(other.removed, ['il-ads-p17']);
});

test('rejected answers add no cue and report an error; empty VAST is a no fill', async () => {
  const xml = inline();
  for (const bad of [xml.replaceAll('InLine', 'Wrapper'), xml.replaceAll('NonLinearAds', 'Linear'), xml.replace('<StaticResource', '<HTMLResource').replace('</StaticResource>', '</HTMLResource>'),
    xml.replace('<StaticResource creativeType="image/png">https://creative.invalid/art.png</StaticResource>', '<IFrameResource>https://creative.invalid/x.html</IFrameResource>'),
    xml.replace('https://creative.invalid', 'http://creative.invalid'), xml.replace('720', '300').replace('108', '250'), inline('l_shape'), 'not xml']) {
    const h = harness({ answer: () => bad });
    await h.at(42);
    assert.equal(h.requests.length, 1);
    assert.equal(h.added.length, 0);
    assert.equal(h.pixels.length, 0);
    assert.equal(h.events.at(-1).type, 'error');
    h.ads.destroy();
  }
  const empty = harness({ answer: () => '<VAST version="4.0"/>' });
  await empty.at(42);
  assert.equal(empty.added.length, 0);
  assert.equal(empty.events.at(-1).type, 'no_fill');
});

test('VAST reader ports the demo rejections', () => {
  const xml = inline();
  for (const bad of [xml.replace('image/png', 'text/html'), xml.replace('<Creatives>', '<ViewableImpression/><Creatives>'),
    xml.replace('width="720"', 'minSuggestedDuration="00:00:07" width="720"'), xml.replace('width="720"', 'apiFramework="VPAID" width="720"'),
    xml.replace('<NonLinearClickThrough>https://landing.invalid/</NonLinearClickThrough>', ''), '<VAST/>'.replace('VAST', 'NotVast'),
    '<!DOCTYPE x><VAST/>'])
    assert.throws(() => parseGraphicVast(bad, 'super', 4500));
  assert.throws(() => parseGraphicVast(xml, 'l_shape', 5000));
  const art = parseGraphicVast(xml.replace('image/png', 'image/jpeg').replace('creativeView', 'complete').replace('</TrackingEvents>', '<Tracking event="creativeView">https://pixel.invalid/v2</Tracking></TrackingEvents>'), 'super', 5000);
  assert.deepEqual(art, { imageUrl: 'https://creative.invalid/art.png', mimeType: 'image/jpeg',
    impressions: ['https://pixel.invalid/impression', 'https://pixel.invalid/v2'], clickUrl: 'https://landing.invalid/', clickTracking: ['https://pixel.invalid/click'] });
  assert.equal(parseGraphicVast(xml.replace('width="720"', 'minSuggestedDuration="00:00:04" width="720"'), 'super', 4500).mimeType, 'image/png');
  assert.equal(parseGraphicVast('<VAST version="3.0"></VAST>', 'super', 4500), null);
});

test('min_seconds and max_seconds shape the usable window', async () => {
  const short = makePlan({ windows: [{ id: 's', start_ms: 10000, end_ms: 11000 }, { id: 'ok', start_ms: 50000, end_ms: 70000 }], pacing: { max_seconds: 8 } });
  assert.deepEqual(usableWindows(short).map(({ id, start, end }) => [id, start, end]), [['ok', 50000, 58000]]);
  const h = harness({ plan: short });
  await h.at(10.2);
  assert.equal(h.requests.length, 0);
  await h.at(47);
  assert.equal(h.added[0].cue.end, 58000);
  h.ads.destroy();
});

test('landing inside a window requests at once only with min_seconds left', async () => {
  const late = harness({ start: 50 });
  await late.at(50, 'playing');
  assert.equal(late.requests.length, 1);
  late.ads.destroy();
  const tooLate = harness({ start: 52 });
  await tooLate.at(52);
  assert.equal(tooLate.requests.length, 0);
  tooLate.ads.destroy();
});

test('cut_clearance_seconds trims before a break and delays a start after one', () => {
  const plan = makePlan({
    cuts: [{ id: 'm1', at: 20, position: 'midroll' }, { id: 'm2', at: 60, position: 'midroll' }],
    pacing: { cut_clearance_seconds: 3 },
    windows: [{ id: 'before', start_ms: 10000, end_ms: 19000 }, { id: 'after', start_ms: 21000, end_ms: 30000 },
      { id: 'gone', start_ms: 56000, end_ms: 58000 }],
  });
  assert.deepEqual(usableWindows(plan).map(({ id, start, end }) => [id, start, end]),
    [['before', 10000, 17000], ['after', 23000, 30000]]);
  const none = makePlan({ cuts: [{ id: 'm1', at: 20 }], windows: [{ id: 'x', start_ms: 10000, end_ms: 19000 }] });
  assert.deepEqual(usableWindows(none).map(({ end }) => end), [19000]);
});

test('pacing: 30 seconds between starts, gap after and max_per_video', async () => {
  const windows = [{ id: 'a', start_ms: 10000, end_ms: 20000 }, { id: 'b', start_ms: 30000, end_ms: 35000 },
    { id: 'c', start_ms: 41000, end_ms: 45000 }, { id: 'd', start_ms: 80000, end_ms: 85000 }];
  const h = harness({ plan: makePlan({ windows }) });
  for (const t of [10, 30, 41, 80]) await h.at(t);
  assert.deepEqual(h.added.map((a) => a.cue.id), ['il-ads-a', 'il-ads-c', 'il-ads-d']);
  h.ads.destroy();
  const gap = harness({ plan: makePlan({ windows, pacing: { gap_after_seconds: 30 } }) });
  for (const t of [10, 30, 41, 80]) await gap.at(t);
  assert.deepEqual(gap.added.map((a) => a.cue.id), ['il-ads-a', 'il-ads-d']);
  gap.ads.destroy();
  const capped = harness({ plan: makePlan({ windows, pacing: { max_per_video: 1 } }) });
  for (const t of [10, 30, 41, 80]) await capped.at(t);
  assert.deepEqual(capped.added.map((a) => a.cue.id), ['il-ads-a']);
  assert.equal(capped.requests.length, 1);
  capped.ads.destroy();
});

test('formats rotate over the servable ones, counting fills, ignoring overlay_300x250', async () => {
  const windows = [{ id: 'a', start_ms: 10000, end_ms: 15000 }, { id: 'b', start_ms: 50000, end_ms: 55000 },
    { id: 'c', start_ms: 90000, end_ms: 95000 }, { id: 'd', start_ms: 130000, end_ms: 135000 }];
  let calls = 0;
  const h = harness({ plan: makePlan({ windows, formats: ['overlay_300x250', 'super', 'l_shape'] }),
    answer: (format) => (++calls === 2 ? '<VAST version="3.0"/>' : inline(format)) });
  for (const t of [10, 50, 90, 130]) await h.at(t);
  assert.deepEqual(h.requests.map((r) => new URLSearchParams(r.url.searchParams.get('cust_params')).get('il_format')),
    ['super', 'l_shape', 'l_shape', 'super']);
  assert.deepEqual(h.added.map((a) => a.cue.format), ['super', 'l', 'super']);
  h.ads.destroy();
});

test('a format without a tag or with a non-GAM tag is not served', async () => {
  const h = harness({ plan: makePlan({ graphics: [{ format: 'super', tag_url: 'https://fake.example/gampad/ads?iu=/1/x' }, { format: 'l_shape', tag_url: TAG }] }) });
  await h.at(42);
  assert.equal(h.added[0].cue.format, 'l');
  h.ads.destroy();
  const none = harness({ plan: makePlan({ graphics: [{ format: 'overlay_300x250', tag_url: TAG }] }) });
  await none.at(42);
  assert.equal(none.requests.length, 0);
  none.ads.destroy();
});

test('a window is attempted once, even after seeking back', async () => {
  const h = harness({ answer: () => '<VAST version="3.0"/>' });
  await h.at(42);
  await h.at(10, 'seeked');
  await h.at(42, 'seeked');
  assert.equal(h.requests.length, 1);
  h.ads.destroy();
});

test('destroy aborts a pending request and no cue is added', async () => {
  const video = new EventTarget();
  video.currentTime = 42;
  video.paused = false;
  let signal, release;
  const added = [];
  const ads = attachAds({ session: { addCue: (c) => added.push(c), removeCue() {} }, video, plan: makePlan(),
    fetchImpl: (url, init) => { signal = init.signal; return new Promise((r) => { release = r; }); } });
  assert.ok(signal);
  ads.destroy();
  assert.equal(signal.aborted, true);
  release({ ok: true, text: async () => inline() });
  await flush();
  assert.equal(added.length, 0);
});

const MID = TAG + '&vpos=midroll';
const breakPlan = (extra = {}) => makePlan({ cuts: [
  { id: 'pre', at: 0, position: 'preroll', tag_url: TAG, contextual: false },
  { id: 'mid-1', at: 59.0, position: 'midroll', tag_url: MID, contextual: true },
  { id: 'bad', at: 90, position: 'midroll', tag_url: 'https://evil.example/gampad/ads?iu=/1' }], ...extra });

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
    fire(type, event = {}) { for (const fn of listeners.get(type) ?? []) fn(event); },
  };
}

function fakeIma() {
  const made = { loaders: [], managers: [], displays: [], requests: [] };
  globalThis.google = { ima: {
    AdDisplayContainer: class { constructor(el, video) { Object.assign(this, { el, video, initialized: 0 }); made.displays.push(this); }
      initialize() { this.initialized++; } destroy() { this.destroyed = true; } },
    AdsLoader: class { constructor(display) { Object.assign(this, eventTarget(), { display }); made.loaders.push(this); }
      requestAds(request) { made.requests.push(request); } contentComplete() { this.completed = true; } destroy() { this.destroyed = true; } },
    AdsRequest: class {},
    AdsManagerLoadedEvent: { Type: { ADS_MANAGER_LOADED: 'loaded' } },
    AdErrorEvent: { Type: { AD_ERROR: 'adError' } },
    AdEvent: { Type: { CONTENT_PAUSE_REQUESTED: 'pause', CONTENT_RESUME_REQUESTED: 'resume', ALL_ADS_COMPLETED: 'allDone',
      AD_BREAK_FETCH_ERROR: 'fetchError', LOG: 'log' } },
    ViewMode: { NORMAL: 'normal' },
  } };
  made.load = (loader = made.loaders.at(-1)) => {
    const manager = Object.assign(eventTarget(), { init() { this.inited = true; }, start() { this.started = true; }, destroy() { this.destroyed = true; },
      resize(w, h) { this.sizes = [...(this.sizes ?? []), [w, h]]; } });
    made.managers.push(manager);
    loader.fire('loaded', { getAdsManager: () => manager });
    return manager;
  };
  return made;
}

function breakRig({ plan = breakPlan(), start = 0, ...rest } = {}) {
  const video = new EventTarget();
  Object.assign(video, { currentTime: start, paused: true, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } });
  const linearStates = [], events = [], scripts = [];
  const session = { addCue() { return true; }, removeCue() {}, setLinearAd(value) { linearStates.push(value); } };
  const ads = attachAds({ session, video, plan, adContainer: {}, fetchImpl: async () => ({ ok: true, text: async () => '<VAST version="3.0"/>' }),
    loadScript: async (src) => { scripts.push(src); }, onEvent: (e) => events.push(e), ...rest });
  return { ads, video, linearStates, events, scripts };
}

const parseXml = (xml) => new globalThis.DOMParser().parseFromString(xml, 'application/xml');

test('cuts list GAM breaks in order with the page URL; other tags are dropped', () => {
  const { ads } = breakRig();
  assert.deepEqual(ads.cuts.map(({ id, at, position }) => [id, at, position]), [['pre', 0, 'preroll'], ['mid-1', 59, 'midroll']]);
  const tag = new URL(ads.cuts[1].tagUrl);
  assert.equal(tag.searchParams.get('vpos'), 'midroll');
  assert.equal(tag.searchParams.get('url'), 'https://publisher.example/video');
  assert.equal(tag.searchParams.get('description_url'), 'https://publisher.example/video');
  assert.equal(tag.searchParams.get('correlator'), null);
  ads.destroy();
});

test('vmap() has one linear AdBreak per cut with a CDATA tag and a fresh correlator', () => {
  const { ads } = breakRig();
  const xml = ads.vmap();
  const doc = parseXml(xml);
  assert.equal(doc.getElementsByTagName('parsererror').length, 0);
  assert.equal(doc.documentElement.getAttribute('version'), '1.0');
  const breaks = Array.from(doc.getElementsByTagName('vmap:AdBreak'));
  assert.deepEqual(breaks.map((b) => [b.getAttribute('timeOffset'), b.getAttribute('breakType'), b.getAttribute('breakId')]),
    [['start', 'linear', 'pre'], ['00:00:59.000', 'linear', 'mid-1']]);
  const uri = breaks[1].getElementsByTagName('vmap:AdTagURI')[0];
  assert.equal(uri.getAttribute('templateType'), 'vast3');
  assert.match(xml, /<vmap:AdTagURI templateType="vast3"><!\[CDATA\[https:\/\/pubads/);
  const tag = new URL(uri.textContent);
  assert.equal(tag.searchParams.get('vpos'), 'midroll');
  assert.equal(tag.searchParams.get('url'), 'https://publisher.example/video');
  assert.match(tag.searchParams.get('correlator'), /^\d{13,}$/);
  const again = new URL(parseXml(ads.vmap()).getElementsByTagName('vmap:AdTagURI')[1].textContent);
  assert.notEqual(again.searchParams.get('correlator'), tag.searchParams.get('correlator'));
  ads.destroy();
});

test('an invalid plan or no cuts gives an empty VMAP; a plan with only cuts is accepted', () => {
  for (const plan of [null, makePlan({ cuts: [] })]) {
    const { ads } = breakRig({ plan });
    assert.deepEqual(ads.cuts, []);
    const doc = parseXml(ads.vmap());
    assert.equal(doc.getElementsByTagName('parsererror').length, 0);
    assert.equal(doc.documentElement.localName, 'VMAP');
    assert.equal(doc.getElementsByTagName('vmap:AdBreak').length, 0);
    ads.setBreaks([10]);
    ads.start();
    ads.destroy();
  }
  const { scenes, ...cutsOnly } = breakPlan();
  const { ads } = breakRig({ plan: cutsOnly });
  assert.equal(ads.cuts.length, 2);
  ads.destroy();
});

test('setBreaks replaces plan cuts for the clearance of scene graphics', async () => {
  const plan = makePlan({ cuts: [], pacing: { cut_clearance_seconds: 3 }, windows: [{ id: 'w', start_ms: 10000, end_ms: 19000 }] });
  const h = harness({ plan });
  h.ads.setBreaks([20]);
  await h.at(9);
  assert.equal(h.added[0].cue.end, 17000);
  h.ads.destroy();
  const cleared = harness({ plan: makePlan({ cuts: [{ id: 'm', at: 20, tag_url: TAG }], pacing: { cut_clearance_seconds: 3 },
    windows: [{ id: 'w', start_ms: 10000, end_ms: 19000 }] }) });
  cleared.ads.setBreaks([]);
  await cleared.at(9);
  assert.equal(cleared.added[0].cue.end, 19000);
  cleared.ads.destroy();
});

test('nothing of IMA is loaded without linear: ima, and start() does nothing', async () => {
  const made = fakeIma();
  const { ads, scripts } = breakRig();
  ads.start();
  await flush();
  assert.deepEqual(scripts, []);
  assert.equal(made.displays.length, 0);
  ads.destroy();
});

test('linear: ima requests the VMAP with the page URL and plays breaks over the content', async () => {
  const made = fakeIma();
  const { ads, video, linearStates, events, scripts } = breakRig({ linear: 'ima' });
  await flush();
  assert.deepEqual(scripts, ['https://imasdk.googleapis.com/js/sdkloader/ima3.js']);
  assert.equal(made.requests.length, 1);
  assert.equal(made.requests[0].adsResponse.match(/<vmap:AdBreak /g).length, 2);
  assert.equal(made.requests[0].pageUrl, 'https://publisher.example/video');
  ads.start();
  ads.start();
  assert.equal(made.displays[0].initialized, 1);
  const manager = made.load();
  assert.equal(manager.started, true);
  video.paused = false;
  manager.fire('pause', { getAd: () => ({ getAdPodInfo: () => ({ getTimeOffset: () => 0 }) }) });
  assert.equal(video.paused, true);
  assert.deepEqual(linearStates, [true]);
  manager.fire('resume', {});
  assert.deepEqual(linearStates, [true, false]);
  assert.equal(video.paused, false);
  video.currentTime = 59.2;
  manager.fire('pause', {});
  manager.fire('adError', { getError: () => 'boom' });
  assert.deepEqual(linearStates, [true, false, true, false]);
  assert.equal(video.paused, false);
  assert.deepEqual(events.filter((e) => e.cut).map((e) => [e.type, e.cut]),
    [['break_start', 'pre'], ['break_end', 'pre'], ['break_start', 'mid-1'], ['break_error', 'mid-1']]);
  video.dispatchEvent(new Event('ended'));
  assert.equal(made.loaders[0].completed, true);
  ads.destroy();
  assert.equal(manager.destroyed, true);
  assert.equal(made.loaders[0].destroyed, true);
});

test('a loader error keeps the content going and destroy during a break releases it', async () => {
  const made = fakeIma();
  const first = breakRig({ linear: 'ima' });
  await flush();
  first.ads.start();
  made.loaders[0].fire('adError', { getError: () => 'no ads' });
  assert.equal(first.events.at(-1).type, 'break_error');
  assert.deepEqual(first.linearStates, []);
  first.ads.destroy();
  const second = breakRig({ linear: 'ima' });
  await flush();
  second.ads.start();
  const manager = made.load();
  manager.fire('pause', {});
  second.ads.destroy();
  assert.deepEqual(second.linearStates, [true, false]);
  assert.equal(manager.destroyed, true);
});

function fakeGpt({ hostReady = false, hostInitialLoadOff = false, queued = false, legacy = false } = {}) {
  const service = Object.assign(eventTarget(), {
    initialLoadDisabled: hostInitialLoadOff, refreshed: [], values: {}, fetches: 0,
    disableInitialLoad() { this.initialLoadDisabled = true; made.calls.push('legacy:disableInitialLoad'); },
    isInitialLoadDisabled() { return this.initialLoadDisabled; },
    set(key, value) { this.values[key] = value; },
    refresh(slots) { this.refreshed.push(...slots); this.fetches++; },
  });
  const made = { service, slots: [], destroyed: [], displayed: [], enabled: 0, calls: [] };
  const queue = [];
  made.arrive = () => { tag.cmd = { push: (fn) => fn() }; for (const fn of queue.splice(0)) fn(); };
  const tag = globalThis.googletag = {
    cmd: queued ? queue : { push: (fn) => fn() },
    pubadsReady: hostReady,
    pubads: () => service,
    enableServices() { made.enabled++; made.calls.push('enableServices'); },
    defineSlot(unit, size, id) {
      const slot = { unit, size, id, targeting: {}, services: [], addService(s) { this.services.push(s); return this; },
        setTargeting(key, value) { made.calls.push('legacy:setTargeting'); this.targeting[key] = value; return this; },
        ...(legacy ? {} : { setConfig(config) { Object.assign(this.targeting, config.targeting); } }) };
      made.slots.push(slot);
      return slot;
    },
    display(id) {
      made.displayed.push(id);
      if ((hostReady || made.enabled) && !service.initialLoadDisabled) service.fetches++;
    },
    destroySlots(slots) { made.destroyed.push(...slots); return true; },
    ...(legacy ? {} : { setConfig(config) {
      if (config.disableInitialLoad) { service.initialLoadDisabled = true; made.calls.push('setConfig:disableInitialLoad'); }
    } }),
  };
  made.render = (isEmpty = false, slot = made.slots.at(-1)) => service.fire('slotRenderEnded', { slot, isEmpty });
  return made;
}

function makeStage(width = 960, height = 540) {
  const { document } = new JSDOM('<div id="stage"></div>').window;
  const stage = document.getElementById('stage');
  Object.defineProperty(stage, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(stage, 'clientHeight', { value: height, configurable: true });
  return stage;
}

function overlayRig({ formats = ['overlay_300x250'], windows, stage = makeStage(), linear, answer = (format) => inline(format), start = 0,
  gptOptions, loadScript } = {}) {
  const gpt = fakeGpt(gptOptions);
  const made = linear ? fakeIma() : null;
  const video = new EventTarget();
  Object.assign(video, { currentTime: start, paused: true, pause() {}, play() { return Promise.resolve(); } });
  const events = [], scripts = [], added = [];
  const plan = makePlan({ formats, windows, cuts: linear ? undefined : [] });
  const ads = attachAds({ session: { addCue(cue) { added.push(cue); return true; }, removeCue() {}, setLinearAd() {} }, video, plan, stage, linear,
    adContainer: linear ? {} : undefined, loadScript: loadScript ?? (async (src) => { scripts.push(src); }), onEvent: (e) => events.push(e),
    fetchImpl: async (url) => ({ ok: true, text: async () => answer(new URLSearchParams(new URL(url).searchParams.get('cust_params')).get('il_format')) }) });
  const at = async (seconds) => {
    video.currentTime = seconds;
    video.paused = false;
    video.dispatchEvent(new Event('timeupdate'));
    await flush();
  };
  const box = () => stage?.querySelector('[data-il-ads-overlay]');
  return { ads, gpt, made, stage, events, scripts, added, at, box };
}

const GPT_URL = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';

test('nothing of GPT is loaded without an overlay unit or the overlay format', async () => {
  const gpt = fakeGpt();
  for (const plan of [makePlan({ formats: ['super', 'overlay_300x250'], cuts: [] }), makePlan({ formats: ['super'], cuts: [] })]) {
    if (plan.scenes.formats.length === 2) plan.scenes.overlay = { ad_unit: 'overlay', size: [300, 250] };
    const scripts = [];
    const video = new EventTarget();
    video.currentTime = 42;
    const ads = attachAds({ session: { addCue: () => true, removeCue() {} }, video, plan, stage: makeStage(), loadScript: async (src) => { scripts.push(src); },
      fetchImpl: async () => ({ ok: true, text: async () => '<VAST version="3.0"/>' }) });
    video.dispatchEvent(new Event('timeupdate'));
    await flush();
    assert.deepEqual(scripts, []);
    ads.destroy();
  }
  assert.equal(gpt.slots.length, 0);
});

test('the overlay defines one 300x250 slot with window targeting, il_format and page_url', async () => {
  const r = overlayRig();
  await r.at(37.3);
  assert.deepEqual(r.scripts, [GPT_URL]);
  assert.equal(r.gpt.service.initialLoadDisabled, true);
  assert.equal(r.gpt.slots.length, 1);
  const [slot] = r.gpt.slots;
  assert.equal(slot.unit, '/123/site/overlay');
  assert.deepEqual(slot.size, [300, 250]);
  assert.equal(slot.id, r.box().id);
  assert.deepEqual(slot.targeting, { ilayers_context: 'cocina', il_format: 'overlay_300x250' });
  assert.equal(r.gpt.service.values.page_url, 'https://publisher.example/video');
  assert.deepEqual(r.gpt.service.refreshed, [slot]);
  assert.deepEqual(r.events[0], { type: 'request', format: 'overlay_300x250', window: 'p17' });
  const { style } = r.box();
  assert.deepEqual([style.position, style.right, style.bottom, style.width, style.height], ['absolute', '12px', '58px', '300px', '250px']);
  r.ads.destroy();
});

test('the overlay shows only after a non-empty render, during the window, and goes at its end', async () => {
  const r = overlayRig();
  await r.at(37.3);
  assert.equal(r.box().style.display, 'none');
  r.gpt.render(false);
  await r.at(38);
  assert.equal(r.box().style.display, 'none');
  assert.equal(r.events.at(-1).type, 'fill');
  await r.at(41.2);
  assert.equal(r.box().style.display, 'block');
  r.gpt.service.fire('impressionViewable', { slot: r.gpt.slots[0] });
  assert.equal(r.events.at(-1).type, 'impression');
  await r.at(52.9);
  assert.equal(r.box().style.display, 'none');
  assert.deepEqual(r.gpt.destroyed, [r.gpt.slots[0]]);
  r.ads.destroy();
});

test('an empty slot is a no fill and destroy hides the overlay and destroys the slot', async () => {
  const empty = overlayRig();
  await empty.at(42);
  empty.gpt.render(true);
  await empty.at(43);
  assert.equal(empty.events.at(-1).type, 'no_fill');
  assert.equal(empty.box().style.display, 'none');
  assert.deepEqual(empty.gpt.destroyed, [empty.gpt.slots[0]]);
  empty.ads.destroy();
  const r = overlayRig();
  await r.at(42);
  r.gpt.render(false);
  await r.at(43);
  assert.equal(r.box().style.display, 'block');
  r.ads.destroy();
  assert.equal(r.box(), null);
  assert.deepEqual(r.gpt.destroyed, [r.gpt.slots[0]]);
});

test('no overlay container on a missing or small stage', async () => {
  for (const stage of [null, makeStage(639, 360), makeStage(640, 359)]) {
    const r = overlayRig({ stage });
    await r.at(42);
    assert.deepEqual(r.scripts, []);
    assert.equal(r.gpt.slots.length, 0);
    if (stage) assert.equal(stage.children.length, 0);
    r.ads.destroy();
  }
});

test('the overlay joins the rotation with super and l_shape', async () => {
  const windows = [{ id: 'a', start_ms: 10000, end_ms: 15000 }, { id: 'b', start_ms: 50000, end_ms: 55000 },
    { id: 'c', start_ms: 90000, end_ms: 95000 }, { id: 'd', start_ms: 130000, end_ms: 135000 }];
  const r = overlayRig({ windows, formats: ['super', 'overlay_300x250', 'l_shape'] });
  for (const t of [10, 50, 90, 130]) {
    await r.at(t);
    if (r.gpt.slots.length && r.events.at(-1).type === 'request') r.gpt.render(false);
    await r.at(t + 0.5);
  }
  assert.deepEqual(r.events.filter((e) => e.type === 'request').map((e) => e.format), ['super', 'overlay_300x250', 'l_shape', 'super']);
  assert.deepEqual(r.added.map((c) => c.format), ['super', 'l', 'super']);
  assert.equal(r.gpt.slots.length, 1);
  r.ads.destroy();
});

test('the overlay hides when a video ad break starts', async () => {
  const r = overlayRig({ linear: 'ima' });
  await flush();
  await r.at(42);
  r.gpt.render(false);
  await r.at(43);
  assert.equal(r.box().style.display, 'block');
  r.ads.start();
  const manager = r.made.load();
  manager.fire('pause', {});
  assert.equal(r.box().style.display, 'none');
  await r.at(43.5);
  assert.equal(r.box().style.display, 'none');
  manager.fire('resume', {});
  await r.at(44);
  assert.equal(r.box().style.display, 'block');
  r.ads.destroy();
});

const ticks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('our own GPT setup disables initial load, sets page_url and fetches the slot once', async () => {
  const r = overlayRig();
  await r.at(42);
  assert.deepEqual(r.gpt.calls, ['setConfig:disableInitialLoad', 'enableServices']);
  assert.equal(r.gpt.service.values.page_url, 'https://publisher.example/video');
  assert.equal(r.gpt.service.fetches, 1);
  assert.equal(r.gpt.service.refreshed.length, 1);
  r.ads.destroy();
});

test('a page that already enabled GPT keeps its setup and the slot is fetched once', async () => {
  for (const hostInitialLoadOff of [false, true]) {
    const r = overlayRig({ gptOptions: { hostReady: true, hostInitialLoadOff } });
    await r.at(42);
    assert.deepEqual(r.gpt.calls, []);
    assert.equal(r.gpt.service.values.page_url, undefined);
    assert.equal(r.gpt.displayed.length, 1);
    assert.equal(r.gpt.service.fetches, 1);
    assert.equal(r.gpt.service.refreshed.length, hostInitialLoadOff ? 1 : 0);
    assert.deepEqual(r.gpt.slots[0].targeting, { ilayers_context: 'cocina', il_format: 'overlay_300x250' });
    r.ads.destroy();
  }
});

test('destroy while gpt.js is loading leaves nothing behind when it arrives', async () => {
  const r = overlayRig({ gptOptions: { queued: true } });
  await r.at(42);
  assert.equal(r.events.at(-1).type, 'request');
  r.ads.destroy();
  r.gpt.arrive();
  await ticks();
  assert.equal(r.gpt.slots.length, 0);
  assert.equal(r.gpt.enabled, 0);
  assert.equal(r.stage.children.length, 0);
  assert.equal(r.events.at(-1).type, 'request');
});

test('a stage laid out after attach gets its overlay', async () => {
  const stage = makeStage(0, 0);
  let size = [0, 0];
  Object.defineProperty(stage, 'clientWidth', { get: () => size[0] });
  Object.defineProperty(stage, 'clientHeight', { get: () => size[1] });
  const r = overlayRig({ stage });
  size = [960, 540];
  await r.at(42);
  assert.equal(r.gpt.slots.length, 1);
  r.ads.destroy();
});

test('setBreakActive hides the overlay and holds scene requests', async () => {
  const h = harness();
  h.ads.setBreakActive(true);
  await h.at(42);
  assert.equal(h.requests.length, 0);
  h.ads.setBreakActive(false);
  await flush();
  assert.equal(h.requests.length, 1);
  h.ads.destroy();
  const r = overlayRig();
  await r.at(42);
  r.gpt.render(false);
  await r.at(43);
  r.ads.setBreakActive(true);
  assert.equal(r.box().style.display, 'none');
  await r.at(44);
  assert.equal(r.box().style.display, 'none');
  r.ads.setBreakActive(false);
  assert.equal(r.box().style.display, 'block');
  r.ads.destroy();
});

test('the content ended event is ignored while a break plays in the same video', async () => {
  const made = fakeIma();
  const { ads, video } = breakRig({ linear: 'ima' });
  await flush();
  ads.start();
  const manager = made.load();
  manager.fire('pause', {});
  video.dispatchEvent(new Event('ended'));
  assert.equal(made.loaders[0].completed, undefined);
  manager.fire('resume', {});
  video.dispatchEvent(new Event('ended'));
  assert.equal(made.loaders[0].completed, true);
  ads.destroy();
});

test('an ad error on the manager resumes the content', async () => {
  const made = fakeIma();
  const { ads, video, linearStates, events } = breakRig({ linear: 'ima' });
  await flush();
  ads.start();
  const manager = made.load();
  manager.fire('pause', {});
  assert.equal(video.paused, true);
  manager.fire('adError', {});
  assert.equal(video.paused, false);
  assert.deepEqual(linearStates, [true, false]);
  assert.deepEqual(events.map((e) => e.type), ['break_start', 'break_error']);
  ads.destroy();
});

test('IMA joining late skips the pre-roll but keeps the mid-roll', async () => {
  const made = fakeIma();
  const { ads } = breakRig({ linear: 'ima', start: 30 });
  await flush();
  const xml = made.requests[0].adsResponse;
  assert.equal(xml.match(/<vmap:AdBreak /g).length, 1);
  assert.doesNotMatch(xml, /timeOffset="start"/);
  ads.destroy();
});

test('IMA not loaded 8 seconds after start() is given up; destroy while loading leaves nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const made = fakeIma();
  const late = deferred();
  const { ads, events, linearStates } = breakRig({ linear: 'ima', loadScript: () => late.promise });
  ads.start();
  t.mock.timers.tick(7999);
  assert.deepEqual(events, []);
  t.mock.timers.tick(1);
  assert.deepEqual(events.map((e) => e.type), ['break_error']);
  late.resolve();
  await ticks();
  assert.equal(made.displays.length, 0);
  assert.deepEqual(linearStates, []);
  ads.destroy();
  const pending = deferred();
  const gone = breakRig({ linear: 'ima', loadScript: () => pending.promise });
  gone.ads.destroy();
  pending.resolve();
  await ticks();
  assert.equal(made.displays.length, 0);
  assert.equal(made.loaders.length, 0);
});

test('a break that never ends is released after 120 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const made = fakeIma();
  const { ads, video, linearStates, events } = breakRig({ linear: 'ima' });
  await ticks();
  ads.start();
  const manager = made.load();
  manager.fire('pause', {});
  t.mock.timers.tick(119999);
  assert.deepEqual(linearStates, [true]);
  t.mock.timers.tick(1);
  assert.deepEqual(linearStates, [true, false]);
  assert.equal(video.paused, false);
  assert.equal(events.at(-1).type, 'break_error');
  ads.destroy();
});

test('ALL_ADS_COMPLETED destroys the manager; resizes reach it until destroy', async () => {
  const observers = [];
  globalThis.ResizeObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe(el) { this.el = el; } disconnect() { this.off = true; } };
  try {
    const made = fakeIma();
    const { ads, video } = breakRig({ linear: 'ima' });
    await flush();
    ads.start();
    const manager = made.load();
    assert.equal(observers[0].el, video);
    observers[0].fn();
    assert.deepEqual(manager.sizes, [[640, 360]]);
    manager.fire('allDone', {});
    assert.equal(manager.destroyed, true);
    ads.destroy();
    assert.equal(observers[0].off, true);
  } finally {
    delete globalThis.ResizeObserver;
  }
});

test('planUrl builds and encodes the plan endpoint', () => {
  assert.equal(planUrl({ origin: 'https://console.interactivelayers.com', project: 'p 1', asset: 'a&b/c' }),
    'https://console.interactivelayers.com/il-player/ad-plan?project=p%201&asset=a%26b%2Fc');
  assert.equal(planUrl({ origin: 'https://console.interactivelayers.com/', project: 'p', asset: 'a' }),
    'https://console.interactivelayers.com/il-player/ad-plan?project=p&asset=a');
});

test('planUrl rejects a bad origin, project or asset', () => {
  const ok = { origin: 'https://console.interactivelayers.com', project: 'p', asset: 'a' };
  for (const origin of ['http://console.interactivelayers.com', 'console.interactivelayers.com', 'https://x.example/path', '', undefined]) {
    assert.throws(() => planUrl({ ...ok, origin }), TypeError);
  }
  for (const project of ['', undefined, 5]) assert.throws(() => planUrl({ ...ok, project }), TypeError);
  for (const asset of ['', undefined, null]) assert.throws(() => planUrl({ ...ok, asset }), TypeError);
  assert.throws(() => planUrl(), TypeError);
});

const PLAN_URL = 'https://console.interactivelayers.com/il-player/ad-plan?project=p&asset=a';
const answer = (status, body) => async () => new Response(body, { status });

test('loadPlan returns the plan on 200', async () => {
  const plan = makePlan();
  assert.deepEqual(await loadPlan(PLAN_URL, { fetchImpl: answer(200, JSON.stringify(plan)) }), plan);
});

test('loadPlan returns null for no plan, errors and malformed bodies', async () => {
  const bad = [answer(204, null), answer(404, '{}'), answer(500, '{}'), answer(200, 'not json'),
    answer(200, JSON.stringify({ version: 2 })), answer(200, '[]'), answer(200, 'null'),
    async () => { throw new TypeError('network'); }];
  for (const fetchImpl of bad) assert.equal(await loadPlan(PLAN_URL, { fetchImpl }), null);
});

test('loadPlan refuses a non-https URL without fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('{"version":1}'); };
  assert.equal(await loadPlan(PLAN_URL.replace('https:', 'http:'), { fetchImpl }), null);
  assert.equal(await loadPlan('nope', { fetchImpl }), null);
  assert.equal(calls, 0);
});

test('loadPlan sends a credential-less GET that does not follow redirects', async () => {
  const signal = new AbortController().signal;
  let seen;
  await loadPlan(PLAN_URL, { signal, fetchImpl: async (url, init) => { seen = { url, init }; return new Response('{"version":1}'); } });
  assert.equal(seen.url, PLAN_URL);
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.signal, signal);
});

test('GPT uses setConfig when it has it and the old calls only without it', async () => {
  const r = overlayRig();
  await r.at(42);
  assert.deepEqual(r.gpt.calls, ['setConfig:disableInitialLoad', 'enableServices']);
  assert.deepEqual(r.gpt.slots[0].targeting, { ilayers_context: 'cocina', il_format: 'overlay_300x250' });
  assert.equal(r.gpt.service.fetches, 1);
  r.ads.destroy();
  const old = overlayRig({ gptOptions: { legacy: true } });
  await old.at(42);
  assert.deepEqual(old.gpt.calls, ['legacy:disableInitialLoad', 'enableServices', 'legacy:setTargeting', 'legacy:setTargeting']);
  assert.deepEqual(old.gpt.slots[0].targeting, { ilayers_context: 'cocina', il_format: 'overlay_300x250' });
  assert.equal(old.gpt.service.fetches, 1);
  old.ads.destroy();
  const host = overlayRig({ gptOptions: { hostReady: true } });
  await host.at(42);
  assert.deepEqual(host.gpt.calls, []);
  assert.equal(host.gpt.service.fetches, 1);
  host.ads.destroy();
});

test('nothing is requested before the viewer starts playback', async () => {
  const h = harness({ start: 40 });
  await flush();
  h.video.dispatchEvent(new Event('timeupdate'));
  await flush();
  assert.equal(h.requests.length, 0);
  h.video.paused = false;
  h.video.dispatchEvent(new Event('playing'));
  await flush();
  assert.equal(h.requests.length, 1);
  h.ads.destroy();
  const r = overlayRig({ start: 40 });
  await flush();
  assert.deepEqual(r.scripts, []);
  r.ads.destroy();
});

test('after playback has started, seeking while paused prepares the next window', async () => {
  const h = harness();
  await h.at(5, 'playing');
  h.video.paused = true;
  h.video.currentTime = 40;
  h.video.dispatchEvent(new Event('seeked'));
  await flush();
  assert.equal(h.requests.length, 1);
  h.ads.destroy();
});

test('a break IMA cannot fetch reports break_error once, with its cut', async () => {
  const made = fakeIma();
  const { ads, video, linearStates, events } = breakRig({ linear: 'ima' });
  await flush();
  ads.start();
  const manager = made.load();
  manager.fire('fetchError', {});
  manager.fire('fetchError', {});
  manager.fire('log', { getAdData: () => ({ adError: { getMessage: () => 'empty' } }) });
  assert.deepEqual(events.map((e) => [e.type, e.cut]), [['break_error', 'pre']]);
  manager.fire('log', { getAdData: () => ({ message: 'just a log' }) });
  assert.equal(events.length, 1);
  video.currentTime = 59.2;
  video.dispatchEvent(new Event('playing'));
  manager.fire('pause', {});
  manager.fire('log', { getAdData: () => ({ adError: {} }) });
  manager.fire('fetchError', {});
  assert.deepEqual(linearStates, [true]);
  assert.deepEqual(events.map((e) => e.type), ['break_error', 'break_start']);
  manager.fire('resume', {});
  video.currentTime = 120;
  ads.destroy();
});

test('a mid-roll fetch failure after playback names the mid-roll', async () => {
  const made = fakeIma();
  const { ads, video, events } = breakRig({ linear: 'ima' });
  await flush();
  ads.start();
  const manager = made.load();
  video.paused = false;
  video.dispatchEvent(new Event('playing'));
  video.currentTime = 59.1;
  manager.fire('log', { getAdData: () => ({ adError: {} }) });
  assert.deepEqual(events.map((e) => [e.type, e.cut]), [['break_error', 'mid-1']]);
  ads.destroy();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachAds, parseGraphicVast, usableWindows } from '../web/ads.mjs';
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
  await flush();
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
    AdEvent: { Type: { CONTENT_PAUSE_REQUESTED: 'pause', CONTENT_RESUME_REQUESTED: 'resume' } },
    ViewMode: { NORMAL: 'normal' },
  } };
  made.load = (loader = made.loaders.at(-1)) => {
    const manager = Object.assign(eventTarget(), { init() { this.inited = true; }, start() { this.started = true; }, destroy() { this.destroyed = true; } });
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

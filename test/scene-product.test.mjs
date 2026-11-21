import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachAds, hlsContentClock, loadPlan } from '../web/ads.mjs';
import { attachHtmlVideo, normalizeCue } from '../web/index.mjs';

globalThis.DOMParser = new JSDOM('').window.DOMParser;

const ROUTE = 'https://console.example/il-player/scene-product';
// As the backend signs it: project, asset and a grant the player must pass through untouched.
const SIGNED = ROUTE + '?project=p1&asset=a&grant=x.y%2Bz~';
const TAG = 'https://pubads.g.doubleclick.net/gampad/ads?iu=/123/site/graphic&env=vp&output=vast&cust_params=il_format%3Dsuper';
const IAD = 'https://ads.iadserver.com/gampad/ads?tag=t&output=vast&vid=a&cue_seconds=0';
const VAST = '<VAST version="3.0"><Ad id="ad"><InLine><AdTitle>C</AdTitle><Impression>https://pixel.invalid/i</Impression><Creatives><Creative><NonLinearAds><NonLinear width="720" height="108"><StaticResource creativeType="image/png">https://creative.invalid/a.png</StaticResource></NonLinear></NonLinearAds></Creative></Creatives></InLine></Ad></VAST>';
const PACING = { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0 };

// The card of docs/scene-product.md (section 3), with its optional parts.
const card = (overrides = {}) => ({
  id: 'dlv_1', format: 'super', start: 50000, end: 58000, window: 'm1',
  imageUrl: 'https://cdn.iadserver.com/apron.jpg', mimeType: 'image/jpeg',
  impressionUrl: 'https://ads.iadserver.com/events/dlv_1/impression',
  brand: { accent: '#aa2200', background: '#ffffff', logoUrl: 'https://cdn.iadserver.com/logo.png' },
  commerce: {
    id: 'gid://shopify/Product/100', title: 'Delantal', price: '100.00', previousPrice: '125.00', currency: 'USD',
    vendor: 'Cocina', description: 'De lino', imageUrl: 'https://cdn.iadserver.com/apron.jpg', images: ['https://cdn.iadserver.com/apron.jpg'],
    locale: 'es',
    variants: [{ id: 'gid://shopify/ProductVariant/101', label: 'Black / M', price: '100.00', previousPrice: '125.00',
      availableForSale: true, imageUrl: 'https://cdn.iadserver.com/apron-black.jpg', selectedOptions: [{ name: 'Color', value: 'Black' }] }],
    handoffUrl: 'https://ads.iadserver.com/commerce/offer/dlv_1',
    viewUrl: 'https://ads.iadserver.com/events/dlv_1/creativeView',
  },
  ...overrides,
});

function makePlan({ windows = [{ id: 'm1', start_ms: 50000, end_ms: 58000 }], pacing = {}, scenes, cuts = [], commerce = {}, ...rest } = {}) {
  return {
    version: 1, asset_id: 'a', asset_version: 'v', duration: 300,
    expires_at: new Date(Date.now() + 3600000).toISOString(), page_url: 'https://publisher.example/v',
    cuts,
    ...(scenes ? { scenes } : {}),
    commerce: { kind: 'scene_product', url: SIGNED, lead_ms: 5000, pacing: { ...PACING, ...pacing }, windows, ...commerce },
    ...rest,
  };
}
const graphicScenes = (windows, pacing = {}) => ({
  formats: ['super'], pacing: { ...PACING, ...pacing }, graphics: [{ format: 'super', tag_url: TAG }], windows,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rig({ plan = makePlan(), answer = () => ({ status: 200, body: card() }), commerce = { locale: 'es' }, session: extra, ...options } = {}) {
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: false, ended: false });
  const routes = [], graphics = [], pixels = [], events = [];
  const onScreen = new Map();
  const adds = [];
  const session = {
    commerce,
    addCue(cue, hooks) { adds.push({ cue, hooks }); onScreen.set(cue.id, { cue, hooks }); return true; },
    removeCue(id) { onScreen.delete(id); return true; },
    ...extra,
  };
  const fetchImpl = async (url, init) => {
    const text = String(url);
    if (text.startsWith(ROUTE)) {
      routes.push({ url: new URL(text), href: text, init });
      const reply = await answer(new URL(text), init);
      return { status: reply.status, ok: reply.status < 300, json: async () => reply.body };
    }
    if (text.includes('/gampad/ads')) {
      graphics.push(text);
      return { ok: true, text: async () => VAST };
    }
    pixels.push(text);
    return { ok: true };
  };
  const ads = attachAds({ session, video, plan, fetchImpl, planOrigin: 'https://console.example', onEvent: (e) => events.push(e), ...options });
  const at = async (seconds, type = 'timeupdate') => {
    video.currentTime = seconds;
    video.dispatchEvent(new Event(type));
    await flush();
    await flush();
  };
  return { video, ads, routes, graphics, pixels, events, onScreen, adds, at };
}

test('asks the opaque route lead_ms before the window with only the window and the locale', async () => {
  const plan = makePlan({ cuts: [{ id: 'pre', at: 0, position: 'preroll', requests: [{ provider: 'iadserver', tag_url: IAD }] }] });
  const r = rig({ plan });
  await r.at(44.9);
  assert.equal(r.routes.length, 0);
  await r.at(45);
  assert.equal(r.routes.length, 1);
  const { url, init } = r.routes[0];
  assert.equal(url.origin + url.pathname, ROUTE);
  assert.equal(r.routes[0].href, `${SIGNED}&window=m1&locale=es`);
  assert.deepEqual([init.credentials, init.cache, init.redirect], ['omit', 'no-store', 'error']);
  assert.deepEqual(r.events.slice(0, 2), [{ type: 'request', format: 'scene_product', window: 'm1' },
    { type: 'fill', format: 'scene_product', window: 'm1' }]);
  r.ads.destroy();
});

test('the host sessionId stays the break sid; commerce.session replaces only the random one', async () => {
  const cuts = [{ id: 'pre', at: 0, position: 'preroll', requests: [{ provider: 'iadserver', tag_url: IAD }] }];
  const sidOf = (r) => new URL(r.ads.cuts[0].tagUrl).searchParams.get('sid');
  const session = '9f1c0000000000000000000000000abc';
  const plain = makePlan({ cuts });
  delete plain.commerce;
  for (const [plan, sessionId, expected] of [
    [makePlan({ cuts, commerce: { session } }), 'host-view', 'host-view'],
    [makePlan({ cuts, commerce: { session } }), undefined, session],
    [makePlan({ cuts, commerce: { session: 'has spaces' } }), undefined, /^[a-f0-9]{32}$/],
    [makePlan({ cuts, commerce: { kind: 'other', session } }), undefined, /^[a-f0-9]{32}$/],
    [plain, undefined, /^[a-f0-9]{32}$/],
    [plain, 'host-view', 'host-view']]) {
    const r = rig({ plan, sessionId });
    if (typeof expected === 'string') assert.equal(sidOf(r), expected);
    else assert.match(sidOf(r), expected);
    r.ads.destroy();
  }
});

test('commerce.url must be on the origin of the plan: loaded, the page\'s own, or the one the host states', async () => {
  const served = (plan) => async (url) => ({ status: 200, text: async () => JSON.stringify(plan) });
  const run = async (plan, options = {}) => {
    const r = rig({ plan, planOrigin: undefined, ...options });
    await r.at(50);
    const asked = r.routes.length;
    r.ads.destroy();
    return asked;
  };
  // Loaded with loadPlan: its own origin only.
  assert.equal(await run(await loadPlan('https://console.example/il-player/ad-plan?project=p&asset=a', { fetchImpl: served(makePlan()) })), 1);
  assert.equal(await run(await loadPlan('https://other.example/il-player/ad-plan?project=p&asset=a', { fetchImpl: served(makePlan()) })), 0);
  // A loaded plan does not take a stated origin instead of the one it came from.
  assert.equal(await run(await loadPlan('https://other.example/x', { fetchImpl: served(makePlan()) }), { planOrigin: 'https://console.example' }), 0);
  // Handed in: the stated origin, or the page's own.
  assert.equal(await run(makePlan(), { planOrigin: 'https://console.example' }), 1);
  assert.equal(await run(makePlan(), { planOrigin: 'https://elsewhere.example' }), 0);
  assert.equal(await run(makePlan()), 0);
  globalThis.location = { origin: 'https://console.example' };
  try {
    assert.equal(await run(makePlan()), 1);
  } finally {
    delete globalThis.location;
  }
  // The plan itself stays: its graphics are still served when commerce is refused.
  const plan = makePlan({ scenes: graphicScenes([{ id: 'm1', start_ms: 50000, end_ms: 58000 }]) });
  const r = rig({ plan, planOrigin: undefined });
  for (const t of [45, 46, 47, 50]) await r.at(t);
  assert.deepEqual([r.routes.length, r.graphics.length], [0, 1]);
  r.ads.destroy();
});

test('loadPlan resolves a relative URL against the page; without a page it refuses it, as on main', async () => {
  const asked = [];
  const served = async (url) => {
    asked.push(url);
    return { status: 200, text: async () => JSON.stringify(makePlan()) };
  };
  // No page: the relative URL is refused before any request, exactly as a241327 did.
  assert.equal(await loadPlan('/il-player/ad-plan?project=p&asset=a', { fetchImpl: served }), null);
  assert.deepEqual(asked, []);
  // On the page: resolved against it, the plan is returned and its commerce.url on the page's origin accepted.
  globalThis.location = { href: 'https://console.example/embed/x', origin: 'https://console.example' };
  try {
    const plan = await loadPlan('/il-player/ad-plan?project=p&asset=a', { fetchImpl: served });
    assert.equal(asked.at(-1), 'https://console.example/il-player/ad-plan?project=p&asset=a');
    assert.equal(plan?.version, 1);
    const r = rig({ plan, planOrigin: undefined });
    await r.at(50);
    assert.equal(r.routes.length, 1);
    r.ads.destroy();
  } finally {
    delete globalThis.location;
  }
  // An absolute URL is requested exactly as given.
  const absolute = 'https://console.example/il-player/ad-plan?project=p&asset=a';
  assert.equal((await loadPlan(absolute, { fetchImpl: served }))?.version, 1);
  assert.equal(asked.at(-1), absolute);
  assert.equal(await loadPlan('http://console.example/il-player/ad-plan', { fetchImpl: served }), null);
});

test('a 204 is for its window only: the next window is still asked once (an expired grant degrades quietly)', async () => {
  const windows = [{ id: 'm1', start_ms: 50000, end_ms: 58000 }, { id: 'm2', start_ms: 100000, end_ms: 108000 }];
  const r = rig({ plan: makePlan({ windows }), answer: () => ({ status: 204 }) });
  for (let t = 44; t <= 108; t += 1) await r.at(t);
  assert.deepEqual(r.routes.map((route) => route.url.searchParams.get('window')), ['m1', 'm2']);
  r.ads.destroy();
});

test('a second attachAds, or a re-attach, does not fire the impression of the same delivery again', async () => {
  const id = 'dlv_twice';
  const first = rig({ answer: () => ({ status: 200, body: card({ id }) }) });
  await first.at(51);
  first.adds[0].hooks.onVisible();
  first.ads.destroy();
  const second = rig({ answer: () => ({ status: 200, body: card({ id }) }) });
  await second.at(51);
  assert.equal(second.routes.length, 1, 'the window is asked again and gives the same delivery');
  second.adds[0].hooks.onVisible();
  assert.deepEqual([first.pixels.length, second.pixels.length], [1, 0]);
  assert.equal(second.events.filter((e) => e.type === 'impression').length, 0);
  second.ads.destroy();
});

test('card images and brand colours are filtered by the SDK itself, whatever the server sends', async () => {
  const bad = card({ id: 'dlv_filter', brand: { accent: 'red;background:url(x)', background: '#12345', foreground: '#ABCDEF', logoUrl: 'http://cdn.example/l.png' },
    commerce: { ...card().commerce, imageUrl: 'http://cdn.example/a.jpg', images: ['https://cdn.example/ok.jpg', 'javascript:x', 'http://cdn.example/b.jpg'],
      variants: [{ ...card().commerce.variants[0], imageUrl: 'data:image/png;base64,AA' }] } });
  assert.equal(normalizeCue({ ...bad, imageUrl: 'http://cdn.example/apron.jpg' }), null);
  const cue = normalizeCue(bad);
  assert.equal(cue.commerce.imageUrl, undefined);
  assert.deepEqual(cue.commerce.images, ['https://cdn.example/ok.jpg']);
  assert.equal(cue.commerce.variants[0].imageUrl, undefined);
  assert.deepEqual(cue.brand, { foreground: '#ABCDEF' });
});

test('commerce.url is opaque with or without a query string; an old project option is ignored', async () => {
  const r = rig({ project: 'ignored' });
  await r.at(50);
  assert.equal(r.routes[0].href, SIGNED + '&window=m1&locale=es');
  r.ads.destroy();
  for (const [url, expected] of [[ROUTE, ROUTE + '?window=m1&locale=es'], [ROUTE + '?', ROUTE + '?window=m1&locale=es'],
    [SIGNED + '#frag', SIGNED + '&window=m1&locale=es#frag']]) {
    const bare = rig({ plan: makePlan({ commerce: { url } }) });
    await bare.at(50);
    assert.equal(bare.routes[0].href, expected);
    bare.ads.destroy();
  }
});

test('one request per window, whatever the seeks; a seek into the window asks at once', async () => {
  const r = rig({ answer: () => ({ status: 204 }) });
  await r.at(53, 'seeked');
  assert.equal(r.routes.length, 1);
  for (const t of [54, 30, 46, 52, 57, 20, 51]) await r.at(t, 'seeked');
  assert.equal(r.routes.length, 1);
  assert.equal(r.adds.length, 0);
  r.ads.destroy();
});

test('204, 429, a server error, a bad card and a timeout show nothing and never ask again', async (t) => {
  for (const answer of [() => ({ status: 204 }), () => ({ status: 429 }), () => ({ status: 500 }),
    () => ({ status: 200, body: card({ window: 'other' }) }), () => ({ status: 200, body: card({ commerce: undefined }) })]) {
    const r = rig({ answer });
    await r.at(46);
    await r.at(52);
    assert.equal(r.routes.length, 1);
    assert.equal(r.adds.length, 0);
    r.ads.destroy();
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig({ answer: (url, init) => new Promise((resolve, fail) => init.signal.addEventListener('abort', () => fail(new Error('abort')))) });
  r.video.currentTime = 46;
  r.video.dispatchEvent(new Event('timeupdate'));
  t.mock.timers.tick(6000);
  t.mock.timers.reset();
  await flush();
  await r.at(52);
  assert.equal(r.routes.length, 1);
  assert.equal(r.adds.length, 0);
  assert.equal(r.events.at(-1).type, 'error');
  r.ads.destroy();
});

test('the card is the contract cue, clipped to the window, shown until its end and fired once', async () => {
  const r = rig({ answer: () => ({ status: 200, body: card({ end: 70000 }) }) });
  await r.at(45);
  const [{ cue, hooks }] = r.adds;
  assert.equal(cue.id, 'dlv_1');
  assert.deepEqual([cue.start, cue.end, cue.format], [50000, 58000, 'super']);
  assert.equal(cue.commerce.handoffUrl, 'https://ads.iadserver.com/commerce/offer/dlv_1');
  hooks.onVisible();
  hooks.onVisible();
  await r.at(57.9);
  assert.ok(r.onScreen.has('dlv_1'));
  await r.at(58);
  assert.equal(r.onScreen.size, 0);
  assert.deepEqual(r.pixels, ['https://ads.iadserver.com/events/dlv_1/impression']);
  assert.equal(r.events.filter((e) => e.type === 'impression').length, 1);
  r.ads.destroy();
});

test('hidden during a video break and after the content ends, back with the same hooks if its time remains', async () => {
  const r = rig();
  await r.at(51);
  const first = r.adds[0].hooks;
  r.ads.setBreakActive(true);
  assert.equal(r.onScreen.size, 0);
  await r.at(52);
  assert.equal(r.onScreen.size, 0);
  r.ads.setBreakActive(false);
  assert.equal(r.onScreen.get('dlv_1').hooks, first);
  r.video.ended = true;
  await r.at(53, 'ended');
  assert.equal(r.onScreen.size, 0);
  r.ads.destroy();
});

test('a product wins its window over the Super; a 204 leaves the window to the Super', async () => {
  const windows = [{ id: 'm1', start_ms: 50000, end_ms: 58000 }];
  const won = rig({ plan: makePlan({ scenes: graphicScenes(windows) }) });
  for (const t of [44, 45, 46, 47, 50, 52]) await won.at(t);
  assert.equal(won.routes.length, 1);
  assert.deepEqual(won.graphics, []);
  assert.deepEqual([...won.onScreen.keys()], ['dlv_1']);
  won.ads.destroy();

  const free = rig({ plan: makePlan({ scenes: graphicScenes(windows) }), answer: () => ({ status: 204 }) });
  for (const t of [44, 45, 46, 47, 50]) await free.at(t);
  assert.equal(free.graphics.length, 1);
  assert.deepEqual([...free.onScreen.keys()], ['il-ads-m1']);
  free.ads.destroy();
});

test('pacing counts products and graphics together', async () => {
  // A Super at 20 s blocks a product 20 s later (30 s between starts), and max_per_video counts both.
  const scenes = graphicScenes([{ id: 'g', start_ms: 20000, end_ms: 28000 }]);
  const near = rig({ plan: makePlan({ scenes, windows: [{ id: 'm1', start_ms: 40000, end_ms: 48000 }] }) });
  for (let t = 15; t <= 48; t += 1) await near.at(t);
  assert.equal(near.graphics.length, 1);
  assert.equal(near.routes.length, 0);
  near.ads.destroy();

  const capped = rig({ plan: makePlan({ scenes: graphicScenes([{ id: 'g', start_ms: 100000, end_ms: 108000 }], { max_per_video: 1 }),
    pacing: { max_per_video: 1 } }) });
  for (let t = 44; t <= 110; t += 1) await capped.at(t);
  assert.equal(capped.routes.length, 1);
  assert.equal(capped.graphics.length, 0);
  capped.ads.destroy();
});

test('overlapping product windows: one card at a time, and the 30 s spacing between starts holds', async () => {
  // Overlapping windows: m2 is due while the m1 card (to 58 s) is still on.
  const windows = [{ id: 'm1', start_ms: 50000, end_ms: 58000 }, { id: 'm2', start_ms: 55000, end_ms: 65000 }];
  const r = rig({ plan: makePlan({ windows, pacing: {} }), answer: (url) => {
    const id = url.searchParams.get('window');
    return { status: 200, body: card({ id: 'dlv_' + id, window: id, start: id === 'm1' ? 50000 : 55000, end: id === 'm1' ? 58000 : 65000 }) };
  } });
  await r.at(50);
  await r.at(56);
  assert.equal(r.routes.length, 1);
  await r.at(58.5);
  assert.equal(r.onScreen.has('dlv_m1'), false);
  assert.equal(r.routes.length, 1, 'm2 starts 5 s after m1: the 30 s spacing between starts keeps it off');
  r.ads.destroy();
});

test('without commerce on the session, nothing about the product is asked', async () => {
  for (const options of [{ commerce: null }]) {
    const r = rig(options);
    await r.at(50);
    assert.equal(r.routes.length, 0);
    r.ads.destroy();
  }
});

test('a plan with only commerce is valid; one without commerce changes nothing; an unknown kind is ignored', async () => {
  const only = rig({ plan: makePlan() });
  await only.at(50);
  assert.equal(only.routes.length, 1);
  only.ads.destroy();
  for (const commerce of [undefined, { kind: 'other' }, { url: 'http://insecure.example/x' }, { lead_ms: -1 }]) {
    const plan = makePlan({ scenes: graphicScenes([{ id: 'm1', start_ms: 50000, end_ms: 58000 }]) });
    if (commerce === undefined) delete plan.commerce;
    else Object.assign(plan.commerce, commerce);
    const r = rig({ plan });
    for (const t of [45, 46, 47, 50]) await r.at(t);
    assert.equal(r.routes.length, 0);
    assert.equal(r.graphics.length, 1);
    r.ads.destroy();
  }
});

test('under a stitched clock the card follows content time and is never on during an ad', async () => {
  // Stream: content 0–40 at 0–40, ad 40–50, content 40–80 at 50–90. The window is content 36–44.
  const ORIGIN = '2000-01-01T00:00:00.000Z';
  const frags = [];
  for (let t = 0; t < 90; t += 5) {
    const ad = t >= 40 && t < 50;
    const contentStart = t < 40 ? t : t - 10;
    frags.push({ start: t, duration: 5, rawProgramDateTime: ad ? null : new Date(Date.parse(ORIGIN) + contentStart * 1000).toISOString() });
  }
  const hls = { levels: [{ details: { fragments: frags } }], currentLevel: 0, on() {}, off() {} };
  const plan = makePlan({ windows: [{ id: 'm1', start_ms: 36000, end_ms: 44000 }], timeline: { kind: 'stitched', pdt_origin: ORIGIN } });
  const video = { currentTime: 0, playbackRate: 1 };
  const clock = hlsContentClock({ hls, video, plan });
  const r = rig({ plan, clock, session: { clock: clock.programTime },
    answer: () => ({ status: 200, body: card({ window: 'm1', start: 36000, end: 44000 }) }) });
  Object.defineProperty(video, 'currentTime', { get: () => r.video.currentTime });
  let seen = false;
  for (let step = 300; step <= 600; step++) {
    const t = step / 10;
    await r.at(t);
    const inAd = t >= 40 && t < 50;
    if (inAd) assert.equal(r.onScreen.size, 0, `card over an ad at ${t}`);
    seen ||= r.onScreen.size > 0;
  }
  assert.ok(seen);
  assert.equal(r.routes.length, 1);
  assert.equal(r.onScreen.size, 0, 'gone after content 44 s (stream 54 s)');
  r.ads.destroy();
});

test('in the page, the card fires its impression once, viewUrl once on opening and the hand-off on Buy; embedded it adds the QR', async () => {
  for (const embedded of [false, true]) {
    // Embedded: the player page lives in an iframe of the publisher's page.
    const outer = new JSDOM(embedded ? '<iframe></iframe>' : '<main><video></video></main>', { pretendToBeVisual: true }).window;
    const window = embedded ? outer.document.querySelector('iframe').contentWindow : outer;
    if (embedded) window.document.body.innerHTML = '<main><video></video></main>';
    assert.equal(window.self !== window.top, embedded);
    const stage = window.document.querySelector('main');
    const video = stage.querySelector('video');
    let time = 0;
    Object.defineProperties(video, { paused: { value: false }, readyState: { value: 4 },
      currentTime: { get: () => time, set: (v) => { time = v; } } });
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? 'GET', body: init.body });
      if (url.startsWith(ROUTE)) return { status: 200, ok: true, json: async () => card({ id: 'dlv_page_' + embedded }) };
      if (url.endsWith('/commerce/offer/dlv_1'))
        return { ok: true, status: 201, json: async () => ({ continueUrl: 'https://shop.example/checkout', qrImageUrl: 'https://ads.iadserver.com/qr.png' }) };
      return { ok: true };
    };
    const session = attachHtmlVideo({ video, stage, timeline: 'media', interval: false, commerce: { locale: 'es' }, fetchImpl });
    assert.deepEqual(session.commerce, { locale: 'es' });
    const ads = attachAds({ session, video, plan: makePlan(), fetchImpl, planOrigin: 'https://console.example' });
    time = 45;
    video.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    time = 51;
    video.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    await flush();
    // JSDOM lays nothing out: the creative is made to look loaded and on screen, as a browser would report it.
    for (const img of stage.querySelectorAll('img')) {
      Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 720 } });
      img.getBoundingClientRect = () => ({ width: 720, height: 108 });
      Object.assign(img.style, { visibility: 'visible', opacity: '1' }); // JSDOM computes neither.
      img.dispatchEvent(new window.Event('load'));
    }
    session.tick();
    session.tick();
    const button = (text) => [...stage.querySelectorAll('button')].find((el) => el.textContent === text);
    button('Ver producto').click();
    button('Comprar').click();
    await flush();
    await flush();
    const count = (suffix, method = 'GET') => calls.filter((c) => c.url.endsWith(suffix) && c.method === method).length;
    assert.equal(count('/events/dlv_1/impression'), 1);
    assert.equal(count('/events/dlv_1/creativeView'), 1);
    assert.equal(count('/commerce/offer/dlv_1', 'POST'), 1);
    assert.equal(JSON.parse(calls.find((c) => c.method === 'POST').body).variantId, 'gid://shopify/ProductVariant/101');
    const link = stage.querySelector('.il-commerce-result a');
    assert.equal(link.href, 'https://shop.example/checkout');
    assert.equal(link.target, '_blank');
    assert.equal(!!stage.querySelector('.il-commerce-result img[src="https://ads.iadserver.com/qr.png"]'), embedded);
    ads.destroy();
    session.destroy();
    window.close();
  }
});

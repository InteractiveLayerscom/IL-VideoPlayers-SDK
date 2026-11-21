import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachAds } from '../web/ads.mjs';
import { attachHtmlVideo } from '../web/index.mjs';

// A product card at the pace of a person: pauses, an open detail, a window that ends while choosing.

const ROUTE = 'https://console.example/il-player/scene-product?grant=g';
const card = (id = 'dlv_h') => ({
  id, format: 'super', start: 1000, end: 8000, window: 'm1',
  imageUrl: 'https://cdn.example/apron.png', mimeType: 'image/png',
  impressionUrl: `https://ads.iadserver.com/events/${id}/impression`,
  commerce: {
    title: 'Apron', price: '100.00', currency: 'USD', locale: 'en',
    variants: [{ id: 'v1', label: 'Black', price: '100.00' }, { id: 'v2', label: 'White', price: '100.00' }],
    handoffUrl: `https://ads.iadserver.com/commerce/offer/${id}`,
    viewUrl: `https://ads.iadserver.com/events/${id}/creativeView`,
  },
});
const plan = (extra = {}) => ({
  version: 1, asset_id: 'a', cuts: [], expires_at: new Date(Date.now() + 3600000).toISOString(),
  commerce: { kind: 'scene_product', url: ROUTE, lead_ms: 5000,
    pacing: { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0 },
    windows: [{ id: 'm1', start_ms: 1000, end_ms: 8000 }] },
  ...extra,
});
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

function player({ pauseOnOpen = false, handoff = () => ({ status: 201, body: { continueUrl: 'https://shop.example/checkout' } }),
  id = 'dlv_h', planned = plan() } = {}) {
  const { window } = new JSDOM('<main><video></video></main>', { pretendToBeVisual: true });
  const stage = window.document.querySelector('main');
  const video = stage.querySelector('video');
  const state = { time: 0, paused: true, ended: false, plays: 0, pauses: 0 };
  const fire = (type) => video.dispatchEvent(new window.Event(type));
  Object.defineProperties(video, {
    readyState: { get: () => 4 },
    paused: { get: () => state.paused },
    ended: { get: () => state.ended },
    currentTime: { get: () => state.time, set: (value) => { state.time = value; } },
  });
  // Like a browser: the state changes at once, the event follows.
  video.play = () => { state.plays++; state.paused = false; queueMicrotask(() => fire('play')); return Promise.resolve(); };
  video.pause = () => { state.pauses++; state.paused = true; queueMicrotask(() => fire('pause')); };
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.startsWith(ROUTE)) return { status: 200, ok: true, json: async () => card(id) };
    if (url.includes('/commerce/offer/')) {
      const reply = handoff();
      return { status: reply.status, ok: reply.status < 300, json: async () => reply.body };
    }
    return { ok: true };
  };
  const session = attachHtmlVideo({ video, stage, timeline: 'media', interval: false, fetchImpl,
    commerce: { locale: 'en', ...(pauseOnOpen ? { pauseOnOpen: true } : {}) } });
  const ads = attachAds({ session, video, plan: planned, fetchImpl, planOrigin: 'https://console.example' });
  const layout = () => {
    for (const img of stage.querySelectorAll('img')) {
      if (img.dataset.laidOut) continue;
      img.dataset.laidOut = '1';
      Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 720 } });
      img.getBoundingClientRect = () => ({ width: 720, height: 108 });
      Object.assign(img.style, { visibility: 'visible', opacity: '1' });
      img.dispatchEvent(new window.Event('load'));
    }
  };
  const tick = async () => {
    await flush();
    layout();
    session.tick();
    await flush();
  };
  const at = async (seconds) => {
    state.time = seconds;
    fire('timeupdate');
    await tick();
  };
  const button = (text) => [...stage.querySelectorAll('button')].find((el) => el.textContent === text && !el.closest('[hidden]'));
  const play = async () => { await video.play(); await tick(); };
  const pause = async () => { video.pause(); await tick(); };
  const count = (part, method = 'GET') => calls.filter((c) => c.url.includes(part) && c.method === method).length;
  return { window, stage, video, state, session, ads, at, tick, play, pause, button, count, calls,
    close() { ads.destroy(); session.destroy(); window.close(); } };
}

async function cardOnScreen(p, at = 2) {
  await p.play();
  await p.at(at);
  assert.ok(p.button('View product'), 'the card is on screen');
}

test('pausing with the card closed keeps it on screen; the impression is still once', async () => {
  const p = player({ id: 'dlv_pause' });
  await cardOnScreen(p);
  await p.pause();
  for (let i = 0; i < 5; i++) await p.tick();
  assert.ok(p.button('View product'), 'still there while paused');
  await p.play();
  await p.at(3);
  assert.ok(p.button('View product'));
  assert.equal(p.count('/events/dlv_pause/impression'), 1);
  p.close();
});

test('opening the detail and then pausing keeps the detail open with the choice made', async () => {
  const p = player({ id: 'dlv_open_pause' });
  await cardOnScreen(p);
  p.button('View product').click();
  p.button('White').click();
  await p.pause();
  for (let i = 0; i < 5; i++) await p.tick();
  assert.ok(p.button('Buy'), 'the detail is still open');
  assert.equal(p.button('White').getAttribute('aria-pressed'), 'true');
  assert.equal(p.count('/creativeView'), 1);
  p.close();
});

test('an open detail outlasts the window until the viewer closes it, then the card goes', async () => {
  const p = player({ id: 'dlv_outlast' });
  await cardOnScreen(p, 6);
  p.button('View product').click();
  for (const t of [8, 9, 12, 20]) await p.at(t);
  assert.ok(p.button('Buy'), 'still choosing after the window ended');
  p.button('Buy').click();
  await p.tick();
  assert.equal(p.stage.querySelector('.il-commerce-result a')?.href, 'https://shop.example/checkout');
  p.stage.querySelector('.il-commerce-close').click();
  await p.tick();
  await p.at(21);
  assert.equal(p.stage.querySelector('.il-commerce'), null, 'closed after the window: gone');
  assert.equal(p.count('scene-product'), 1, 'counted and asked once');
  p.close();
});

test('closing the detail inside the window leaves the closed card until the window ends', async () => {
  const p = player({ id: 'dlv_close_inside' });
  await cardOnScreen(p, 3);
  p.button('View product').click();
  p.stage.querySelector('.il-commerce-close').click();
  await p.at(4);
  assert.ok(p.button('View product'));
  await p.at(8);
  assert.equal(p.stage.querySelector('.il-commerce'), null);
  p.close();
});

test('a break hides the open card; after it the card is back closed while its window lasts, gone after', async () => {
  for (const [resumeAt, expected] of [[5, true], [9, false]]) {
    const p = player({ id: 'dlv_break_' + resumeAt });
    await cardOnScreen(p, 3);
    p.button('View product').click();
    p.ads.setBreakActive(true);
    await p.tick();
    assert.equal(p.stage.querySelector('.il-commerce'), null, 'nothing during the break');
    await p.at(resumeAt);
    p.ads.setBreakActive(false);
    await p.at(resumeAt);
    assert.equal(!!p.button('View product'), expected);
    assert.equal(p.button('Buy'), undefined, 'never reopened on its own');
    p.close();
  }
  // The same with the session's own linear flag (IMA in the content video).
  const p = player({ id: 'dlv_linear' });
  await cardOnScreen(p, 3);
  p.button('View product').click();
  p.session.setLinearAd(true);
  await p.tick();
  assert.equal(p.stage.querySelector('.il-commerce'), null);
  p.session.setLinearAd(false);
  await p.at(4);
  assert.ok(p.button('View product'));
  p.close();
});

test('pauseOnOpen off: opening never touches playback', async () => {
  const p = player({ id: 'dlv_noop' });
  await cardOnScreen(p);
  const before = { ...p.state };
  p.button('View product').click();
  await p.tick();
  p.stage.querySelector('.il-commerce-close').click();
  await p.tick();
  assert.deepEqual([p.state.plays, p.state.pauses, p.state.paused], [before.plays, before.pauses, false]);
  p.close();
});

test('pauseOnOpen: opening pauses, closing resumes only the SDK\'s own pause', async () => {
  const p = player({ id: 'dlv_poo', pauseOnOpen: true });
  await cardOnScreen(p);
  p.button('View product').click();
  await p.tick();
  assert.equal(p.state.paused, true, 'paused while choosing');
  p.stage.querySelector('.il-commerce-close').click();
  await p.tick();
  assert.equal(p.state.paused, false, 'resumed on close');
  p.close();
});

test('pauseOnOpen: a viewer who plays or pauses while the detail is open is not overruled', async () => {
  const played = player({ id: 'dlv_viewer_play', pauseOnOpen: true });
  await cardOnScreen(played);
  played.button('View product').click();
  await played.tick();
  await played.play();
  await played.pause();
  played.stage.querySelector('.il-commerce-close').click();
  await played.tick();
  assert.equal(played.state.paused, true, 'the viewer paused last: stays paused');
  played.close();

  const already = player({ id: 'dlv_already', pauseOnOpen: true });
  await cardOnScreen(already);
  await already.pause();
  already.button('View product').click();
  await already.tick();
  const plays = already.state.plays;
  already.stage.querySelector('.il-commerce-close').click();
  await already.tick();
  assert.deepEqual([already.state.paused, already.state.plays], [true, plays], 'paused by the viewer before: not resumed');
  already.close();

  const resumed = player({ id: 'dlv_resumed', pauseOnOpen: true });
  await cardOnScreen(resumed);
  resumed.button('View product').click();
  await resumed.tick();
  await resumed.play();
  resumed.stage.querySelector('.il-commerce-close').click();
  await resumed.tick();
  assert.equal(resumed.state.paused, false, 'the viewer played: playback goes on, nothing paused it again');
  resumed.close();
});

test('pauseOnOpen: after the purchase page is handed over the video stays paused', async () => {
  const p = player({ id: 'dlv_checkout', pauseOnOpen: true });
  await cardOnScreen(p);
  p.button('View product').click();
  p.button('Buy').click();
  await p.tick();
  assert.ok(p.stage.querySelector('.il-commerce-result a'));
  p.stage.querySelector('.il-commerce-close').click();
  await p.tick();
  assert.equal(p.state.paused, true);
  p.close();
});

test('a hand-off refused because the offer expired says so instead of «try again»', async () => {
  const p = player({ id: 'dlv_gone', handoff: () => ({ status: 404, body: { error: 'offer_unavailable' } }) });
  await cardOnScreen(p);
  p.button('View product').click();
  p.button('Buy').click();
  await p.tick();
  assert.equal(p.stage.querySelector('.il-commerce-result').textContent, 'This offer is no longer available.');
  p.close();
  const busy = player({ id: 'dlv_busy', handoff: () => ({ status: 503, body: {} }) });
  await cardOnScreen(busy);
  busy.button('View product').click();
  busy.button('Buy').click();
  await busy.tick();
  assert.equal(busy.stage.querySelector('.il-commerce-result').textContent, 'Could not prepare the cart. Try again.');
  busy.close();
});

test('the content ending takes the card away, open or not', async () => {
  const p = player({ id: 'dlv_ended' });
  await cardOnScreen(p, 3);
  p.button('View product').click();
  p.state.ended = true;
  p.state.paused = true;
  p.video.dispatchEvent(new p.window.Event('ended'));
  await p.tick();
  assert.equal(p.stage.querySelector('.il-commerce'), null);
  p.close();
});

test('a plain Super still leaves on pause and comes back on play, as before', async () => {
  const { window } = new JSDOM('<main><video></video></main>', { pretendToBeVisual: true });
  const stage = window.document.querySelector('main');
  const video = stage.querySelector('video');
  let paused = false;
  Object.defineProperties(video, { readyState: { get: () => 4 }, paused: { get: () => paused }, currentTime: { value: 2, writable: true } });
  const session = attachHtmlVideo({ video, stage, timeline: 'media', interval: false, commerce: { locale: 'en' } });
  session.addCue({ id: 'plain', format: 'super', start: 1000, end: 8000, imageUrl: 'https://cdn.example/s.png' });
  assert.ok(stage.querySelector('img'));
  paused = true;
  session.tick();
  assert.equal(stage.querySelector('img'), null, 'gone while paused');
  paused = false;
  session.tick();
  assert.ok(stage.querySelector('img'));
  session.destroy();
  window.close();
});

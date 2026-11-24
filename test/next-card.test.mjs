import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachAds } from '../web/ads.mjs';
import { attachHtmlVideo } from '../web/index.mjs';

// A product panel the viewer opened stays after its window; the plan's next window must still be asked for, drawn behind it
// and there for the viewer when they close the panel. Real session, real ads module, a plan with two product windows.

const ROUTE = 'https://console.example/il-player/scene-product?grant=g';
const PACING = { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0 };
const card = (id) => ({
  id, format: 'super', holdUntil: 600000, imageUrl: 'https://cdn.example/apron.png', mimeType: 'image/png',
  impressionUrl: `https://ads.iadserver.com/events/${id}/impression`,
  commerce: { title: 'Apron ' + id, price: '100.00', currency: 'USD', locale: 'en',
    variants: [{ id: 'v1', label: 'Black', price: '100.00' }, { id: 'v2', label: 'White', price: '100.00' }],
    handoffUrl: `https://ads.iadserver.com/commerce/offer/${id}`, viewUrl: `https://ads.iadserver.com/events/${id}/creativeView` },
});
const plan = (windows) => ({ version: 1, asset_id: 'a', cuts: [], expires_at: new Date(Date.now() + 3600000).toISOString(),
  commerce: { kind: 'scene_product', url: ROUTE, lead_ms: 5000, pacing: PACING, windows } });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// Deliveries are counted once per module, so each test has ids of its own.
let sequence = 0;
function player(t, windows) {
  const prefix = 'dlv' + (++sequence) + '_';
  const planned = plan(windows);
  const { window } = new JSDOM('<main><video></video></main>', { pretendToBeVisual: true });
  const stage = window.document.querySelector('main');
  const video = stage.querySelector('video');
  const state = { time: 0, paused: true };
  Object.defineProperties(video, { readyState: { get: () => 4 }, paused: { get: () => state.paused }, ended: { value: false },
    currentTime: { get: () => state.time, set: (value) => { state.time = value; } } });
  video.play = () => { state.paused = false; return Promise.resolve(); };
  video.pause = () => { state.paused = true; };
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.startsWith(ROUTE)) {
      const id = new URL(url).searchParams.get('window');
      const span = planned.commerce.windows.find((w) => w.id === id);
      return { status: 200, ok: true, json: async () => ({ ...card(prefix + id), window: id, start: span.start_ms, end: span.end_ms }) };
    }
    return { ok: true, status: 204 };
  };
  const session = attachHtmlVideo({ video, stage, timeline: 'media', interval: false, fetchImpl, commerce: { locale: 'en' } });
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
  const at = async (seconds) => {
    state.time = seconds;
    video.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    layout();
    session.tick();
    await flush();
  };
  let finished = false;
  const done = () => { if (finished) return; finished = true; ads.destroy(); session.destroy(); window.close(); };
  t.after(done);
  const button = (text) => [...stage.querySelectorAll('button')].find((el) => el.textContent === text && !el.closest('[hidden]') && el.closest('.il-commerce')?.style.display !== 'none');
  const asked = (id) => calls.filter((c) => c.url.startsWith(ROUTE) && c.url.includes('window=' + id)).length;
  const count = (part) => calls.filter((c) => c.url.includes(part.replace('dlv_', prefix)) && c.method === 'GET').length;
  return { window, doc: window.document, stage, state, session, ads, at, button, asked, count, play: async () => { await video.play(); await at(state.time); } };
}

// Start the playback and open the first window's product, with a variant chosen (so the panel's state can be checked later).
async function openFirst(p) {
  await p.play();
  await p.at(2);
  p.button('View product').click();
  p.button('White').click();
  p.button('White').focus();
  assert.ok(p.button('Buy'), 'the first product is open');
}

const spaced = [{ id: 'm1', start_ms: 1000, end_ms: 8000 }, { id: 'm2', start_ms: 40000, end_ms: 50000 }];

test('the next window is asked for at its lead time while a panel is kept open, and its card waits behind the panel', async (t) => {
  const p = player(t, spaced);
  await openFirst(p);
  for (const seconds of [9, 20, 34]) await p.at(seconds);
  assert.equal(p.asked('m2'), 0, 'not before its lead time (5 s before 40 s)');
  await p.at(35.5);
  assert.equal(p.asked('m2'), 1, 'asked at its lead time, with the panel still open');
  await p.at(41);
  assert.equal(p.stage.querySelectorAll('.il-commerce').length, 2, 'its card is mounted next to the kept panel');
  assert.ok(p.button('Buy'), 'the kept panel is still on top');
  assert.equal(p.button('White').getAttribute('aria-pressed'), 'true', 'with its variant choice');
  assert.equal(p.doc.activeElement, p.button('White'), 'and its focus');
  assert.equal(p.button('View product'), undefined, 'the second card\'s button waits behind it');
  assert.equal(p.count('/events/dlv_m2/impression'), 1, 'the second ad\'s impression is counted once, when it is really on screen');
  assert.equal(p.asked('m2'), 1);
});

test('after the viewer closes the kept panel the card of the window now on screen is there and takes focus', async (t) => {
  const p = player(t, spaced);
  await openFirst(p);
  await p.at(36);
  await p.at(42);
  p.stage.querySelector('.il-commerce-close').click();
  await p.at(43);
  const view = p.button('View product');
  assert.ok(view, 'the second window\'s card');
  assert.equal(p.doc.activeElement, view, 'it takes focus');
  assert.equal(p.count('/events/dlv_m2/impression'), 1, 'one impression for the window');
  view.click();
  assert.ok(p.button('Buy'), 'opening its product works');
  assert.equal(p.stage.querySelectorAll('.il-commerce').length, 1, 'and nothing else is left open');
  assert.equal(p.asked('m2'), 1);
});

test('a seek into the next window with the panel open: asked at once and drawn behind the panel', async (t) => {
  const p = player(t, spaced);
  await openFirst(p);
  await p.at(42);                                    // the viewer jumped from 2 s into the second window
  assert.equal(p.asked('m2'), 1, 'asked');
  await p.at(42.5);
  assert.ok(p.button('Buy'), 'the kept panel is still on top, with its choice');
  assert.equal(p.button('White').getAttribute('aria-pressed'), 'true');
  assert.equal(p.stage.querySelectorAll('.il-commerce').length, 2);
  assert.equal(p.count('/events/dlv_m2/impression'), 1);
  p.stage.querySelector('.il-commerce-close').click();
  await p.at(43);
  assert.ok(p.button('View product'), 'the second window\'s card after Close');
  assert.equal(p.asked('m2'), 1);
});

test('windows less than 30 s apart: the second is never asked for (the plan\'s pacing, with or without a panel)', async (t) => {
  const close = [{ id: 'm1', start_ms: 1000, end_ms: 8000 }, { id: 'm2', start_ms: 9000, end_ms: 16000 }];
  const open = player(t, close);
  await openFirst(open);
  for (const seconds of [8.5, 10, 12, 20]) await open.at(seconds);
  assert.equal(open.asked('m2'), 0, 'with the panel open');
  const plain = player(t, close);
  await plain.play();
  await plain.at(2);
  for (const seconds of [8.5, 10, 12, 20]) await plain.at(seconds);
  assert.equal(plain.asked('m2'), 0, 'with no panel at all: the pacing rule (30 s between starts), not the panel');
});

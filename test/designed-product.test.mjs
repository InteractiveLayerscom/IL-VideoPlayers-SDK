import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAds } from '../web/ads.mjs';
import { createSession } from '../web/session.mjs';

const ROUTE = 'https://console.example/il-player/scene-product?project=p&asset=a&grant=g';
const offer = {
  id: 'gid://shopify/Product/1', title: 'Delantal', price: '100.00', currency: 'USD', locale: 'es',
  imageUrl: 'https://cdn.example/a.jpg', handoffUrl: 'https://ads.example/commerce/offer/d?product=0',
  viewUrl: 'https://ads.example/commerce/view/d?product=0',
  variants: [{ id: 'v1', label: 'M', price: '100.00' }],
};
const designed = {
  id: 'd', format: 'super', start: 50000, end: 62000, window: 'm1', impressionUrl: 'https://ads.example/events/d/impression',
  scene: { format: 'super', width: 100, height: 20, durationMs: 12000,
    layers: [{ id: 'buy', type: 'rect', x: 0, y: 0, width: 10, height: 10, action: 'product', productIndex: 0, fill: '#112233' }] },
  products: [offer],
};
const plain = { id: 'c', format: 'super', start: 50000, end: 58000, window: 'm1', imageUrl: 'https://cdn.example/a.jpg',
  mimeType: 'image/jpeg', impressionUrl: 'https://ads.example/events/c/impression', commerce: offer };
const plan = {
  version: 1, asset_id: 'a', asset_version: 'v', duration: 300, expires_at: new Date(Date.now() + 3600000).toISOString(), cuts: [],
  commerce: { kind: 'scene_product', url: ROUTE, lead_ms: 5000, windows: [{ id: 'm1', start_ms: 50000, end_ms: 58000 }],
    pacing: { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0 } },
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rig(body, sceneFeatures) {
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: false, ended: false });
  const routes = [], beacons = [], adds = [], onScreen = new Map();
  const session = {
    commerce: { locale: 'es' }, sceneFeatures,
    addCue(cue, hooks) { adds.push(cue); onScreen.set(cue.id, hooks); return true; },
    removeCue(id) { onScreen.delete(id); return true; },
  };
  const fetchImpl = async (url) => {
    const text = String(url);
    if (!text.startsWith('https://console.example/')) { beacons.push(text); return { ok: true, status: 204 }; }
    routes.push(new URL(text));
    return { status: 200, ok: true, json: async () => body };
  };
  const ads = attachAds({ session, video, plan, fetchImpl, planOrigin: 'https://console.example' });
  const at = async (seconds) => {
    video.currentTime = seconds;
    video.dispatchEvent(new Event('timeupdate'));
    await flush(); await flush();
  };
  return { ads, at, routes, beacons, adds, onScreen, video };
}

test('a scene session asks for the banner and it lasts to the end IL returned', async () => {
  const r = rig(designed, ['media-mask', 'rich-style']);
  r.video.dispatchEvent(new Event('playing'));
  await r.at(50);
  assert.equal(r.routes[0].searchParams.get('scene'), '1');
  assert.equal(r.routes[0].searchParams.get('scene_features'), 'media-mask,rich-style');
  assert.equal(r.adds[0].end, 62000);
  await r.at(60);
  assert.ok(r.onScreen.has('d'));
  await r.at(62);
  assert.ok(!r.onScreen.has('d'));
  r.ads.destroy();
});

test('seeking back shows the banner again with one request and one impression', async () => {
  const r = rig(designed, []);
  r.video.dispatchEvent(new Event('playing'));
  await r.at(50);
  r.onScreen.get('d').onVisible();
  await r.at(70);
  assert.ok(!r.onScreen.has('d'));
  await r.at(55);
  assert.ok(r.onScreen.has('d'));
  r.onScreen.get('d').onVisible();
  assert.equal(r.routes.length, 1);
  assert.equal(r.beacons.filter((url) => url.endsWith('/impression')).length, 1);
  r.ads.destroy();
});

test('a session without scenes gets the plain card, and seeking back shows it again with one request and one impression', async () => {
  const r = rig(plain, null);
  r.video.dispatchEvent(new Event('playing'));
  await r.at(50);
  assert.ok(!r.routes[0].searchParams.has('scene'));
  assert.equal(r.adds[0].end, 58000);
  r.onScreen.get('c').onVisible();
  await r.at(58);
  assert.ok(!r.onScreen.has('c'));
  await r.at(45);
  assert.ok(!r.onScreen.has('c'));    // before its window it stays away
  await r.at(55);
  assert.ok(r.onScreen.has('c'));
  r.onScreen.get('c').onVisible();
  assert.equal(r.adds.length, 2);
  assert.equal(r.routes.length, 1);
  assert.equal(r.beacons.filter((url) => url.endsWith('/impression')).length, 1);
  r.ads.destroy();
});

test('a designed banner ends at its end even while its product view is open: the panel is the renderer\'s to keep', () => {
  let time = 50000, open = false, hidden = 0;
  const session = createSession({
    clock: () => time, playing: () => true, presenting: () => true, interval: false, scenes: true,
    renderer: { show() {}, hide() { hidden += 1; }, visible: () => true, holding: () => open },
  });
  session.addCue(designed, {});
  open = true;
  time = 70000;
  session.tick();
  assert.equal(hidden, 1, 'the graphic is drawn exactly for its window');
  assert.equal(session.holding('d'), true);
  session.destroy();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachShaka } from '../web/shaka.mjs';

const offer = { title: 'Delantal', price: '100.00', currency: 'USD', handoffUrl: 'https://ads.example/o',
  variants: [{ id: 'v1', label: 'M', price: '100.00' }] };

// Shaka's surface as the adapter uses it, so these run the SDK's code whatever the Node version.
function rig(options) {
  const { window } = new JSDOM('<div id="s"><video></video><div id="c"></div><div id="v"></div></div>', { pretendToBeVisual: true });
  const doc = window.document;
  const video = doc.querySelector('video');
  let time = 5, paused = false, plays = 0;
  Object.defineProperties(video, {
    currentTime: { get: () => time, set: (v) => { time = v; } },
    readyState: { get: () => 4 }, seeking: { get: () => false }, ended: { get: () => false },
    paused: { get: () => paused },
  });
  video.pause = () => { paused = true; video.dispatchEvent(new window.Event('pause')); };
  video.play = async () => { plays++; paused = false; video.dispatchEvent(new window.Event('play')); };
  const manager = { setContainers() {}, addCustomInterstitial() {}, getCurrentAd: () => null, addEventListener() {}, removeEventListener() {} };
  const player = { getAdManager: () => manager, getMediaElement: () => video, getPlayheadTimeAsDate: () => null,
    getNetworkingEngine: () => ({ registerResponseFilter() {}, unregisterResponseFilter() {} }) };
  const sdk = attachShaka({ player, clientContainer: doc.querySelector('#c'), serverContainer: doc.querySelector('#v'),
    stage: doc.querySelector('#s'), interval: false, fetchImpl: async () => ({ ok: true, status: 204 }), ...options });
  return { sdk, doc, window, video, plays: () => plays, paused: () => paused, set: (v) => { time = v; } };
}
const midroll = { id: 'd', format: 'midroll', linearCreativeId: 'c', start: 0, end: Number.MAX_SAFE_INTEGER, commerce: offer };

test("Shaka with timeline: 'media' reads the clock in video milliseconds", () => {
  const r = rig({ timeline: 'media', commerce: { locale: 'es' } });
  assert.equal(r.sdk.clock(), 5000);
  r.set(7.25);
  assert.equal(r.sdk.clock(), 7250);
  r.sdk.destroy();
});

test('Shaka without it keeps the program clock', () => {
  const r = rig({ commerce: { locale: 'es' } });
  assert.equal(r.sdk.clock(), null);
  r.sdk.destroy();
});

test('Shaka pauseOnOpen pauses on opening and resumes its own pause on closing', () => {
  const r = rig({ timeline: 'media', commerce: { locale: 'es', pauseOnOpen: true } });
  r.sdk.addCue({ ...midroll, id: 'x' });
  r.sdk.setLinearAd(true, { creativeId: 'c', deliveryId: 'x' });
  const open = r.doc.querySelector('.il-commerce > button');
  open.click();
  assert.equal(r.paused(), false, 'an ad is never paused from the card');
  r.doc.querySelector('.il-commerce-close').click();
  r.sdk.setLinearAd(false);
  r.sdk.removeCue('x');
  r.sdk.addCue({ id: 'card', format: 'overlay', start: 0, end: 60000, commerce: offer,
    scene: { format: 'overlay', width: 100, height: 100, durationMs: 60000,
      layers: [{ id: 'b', type: 'rect', x: 0, y: 0, width: 10, height: 10, fill: '#112233', action: 'product', productIndex: 0 }] },
    products: [{ ...offer, id: 'p', imageUrl: 'https://a.example/a.jpg' }] });
  const action = r.doc.querySelector('.il-scene-action');
  assert.ok(action);
  action.click();
  assert.equal(r.paused(), true);
  r.doc.querySelector('.il-commerce-close').click();
  assert.equal(r.paused(), false);
  assert.equal(r.plays(), 1);
  r.sdk.destroy();
});

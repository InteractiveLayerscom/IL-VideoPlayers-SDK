import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachHtmlVideo, attachShaka, normalizeCue } from '../web/index.mjs';

const cue = {
  id: 'offer', format: 'overlay', start: 1000, end: 31000, imageUrl: 'https://ads.example/boots.png',
  commerce: {
    title: 'Botines', price: '45.50', currency: 'USD', locale: 'es',
    variants: [{ id: '42', label: 'Talle 42', price: '45.50' }, { id: '43', label: 'Talle 43', price: '47' }],
    handoffUrl: 'https://ads.example/handoff',
    viewUrl: 'https://ads.example/view',
  },
};

test('validates commerce destinations while keeping a playable legacy creative', () => {
  assert.deepEqual(normalizeCue(cue)?.commerce, cue.commerce);
  for (const handoffUrl of ['javascript:alert(1)', 'http://ads.example/handoff', 'https://user@ads.example/handoff']) {
    const invalid = { ...cue, commerce: { ...cue.commerce, handoffUrl } };
    assert.equal(normalizeCue(invalid), null);
    assert.equal(normalizeCue({ ...invalid, format: 'super' })?.commerce, undefined);
  }
});

test('a TV sends one localized offer request, chooses a variant, and removes the QR on teardown', async () => {
  const { window } = new JSDOM('<main><video></video></main>', { pretendToBeVisual: true });
  const stage = window.document.querySelector('main');
  const video = stage.querySelector('video');
  Object.defineProperties(video, { paused: { value: false }, readyState: { value: 4 } });
  let now = 1000;
  const requests = [];
  const sdk = attachHtmlVideo({
    video, stage, programTime: () => now, interval: false, sessionId: 'tv-test',
    eventsUrl: 'https://ads.example/cues', commerce: { locale: 'es', country: 'AR', tv: true },
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      const body = url.pathname === '/cues' ? [cue] :
        { continueUrl: 'https://ads.example/continue', qrImageUrl: 'https://ads.example/qr.png' };
      return { ok: true, json: async () => body };
    },
  });
  const pending = () => new Promise(resolve => setImmediate(resolve));
  sdk.tick();
  await pending();
  assert.equal(requests[0].url.searchParams.get('commerce'), '1');
  assert.equal(requests[0].url.searchParams.get('locale'), 'es');
  assert.equal(requests[0].url.searchParams.get('country'), 'AR');
  stage.querySelector('img').dispatchEvent(new window.Event('load'));
  const button = text => [...stage.querySelectorAll('button')].find(el => el.textContent === text);
  button('Ver producto').click();
  const choice = button('Talle 42');
  assert.equal(window.document.activeElement, choice);
  choice.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(window.document.activeElement, button('Talle 43'));
  button('Talle 43').click();
  button('Mostrar código QR').click();
  await pending();
  assert.equal(requests.filter(({ url }) => url.pathname === '/view').length, 1);
  assert.deepEqual(JSON.parse(requests.find(({ url }) => url.pathname === '/handoff').options.body),
    { variantId: '43' });
  assert.equal(stage.querySelector('img[alt="Escaneá el código con tu celular"]')?.src, 'https://ads.example/qr.png');
  now = 31000;
  sdk.tick();
  assert.equal(stage.querySelector('.il-commerce'), null);
  sdk.destroy();
  window.close();
});

test('Shaka connects web checkout to the displayed offer and restores it after a linear break', async () => {
  const { window } = new JSDOM('<main><video></video><div id="client"></div><div id="server"></div></main>', {
    pretendToBeVisual: true,
  });
  const doc = window.document;
  const video = doc.querySelector('video');
  const client = doc.querySelector('#client');
  Object.defineProperties(video, { paused: { value: false }, readyState: { value: 4 } });
  const manager = new window.EventTarget();
  let currentAd;
  manager.setContainers = () => {};
  manager.getCurrentAd = () => currentAd;
  manager.addCustomInterstitial = ad => {
    currentAd = { getAdId: () => ad.id, isLinear: () => false };
    const img = doc.createElement('img');
    img.src = ad.uri;
    img.style.cssText = 'display:block;visibility:visible;opacity:1';
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } });
    img.getBoundingClientRect = () => ({ width: 100, height: 100 });
    client.appendChild(img);
  };
  const network = { registerResponseFilter() {}, unregisterResponseFilter() {} };
  const sdk = attachShaka({
    player: { getAdManager: () => manager, getMediaElement: () => video, getNetworkingEngine: () => network },
    clientContainer: client, serverContainer: doc.querySelector('#server'),
    programTime: () => 2000, eventsUrl: 'https://ads.example/cues', sessionId: 'web-test', interval: false,
    commerce: { locale: 'pt-BR' },
    fetchImpl: async input => {
      const pathname = new URL(input).pathname;
      const body = pathname === '/cues' ? [cue] : { continueUrl: 'https://ads.example/continue' };
      return { ok: true, json: async () => body };
    },
  });
  const pending = () => new Promise(resolve => setImmediate(resolve));
  sdk.tick();
  await pending();
  const button = text => [...doc.querySelectorAll('button')].find(el => el.textContent === text);
  button('Ver produto').click();
  button('Comprar').click();
  await pending();
  assert.equal(doc.querySelector('a')?.href, 'https://ads.example/continue');
  assert.equal(doc.querySelector('a')?.textContent, 'Continuar para Shopify');
  sdk.setLinearAd(true);
  assert.equal(doc.querySelector('.il-commerce'), null);
  sdk.setLinearAd(false);
  assert.ok(button('Ver produto'));
  sdk.destroy();
  window.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { attachHtmlVideo, attachVideoJs, attachAvPlay, attachShaka, normalizeCue } from '../web/index.mjs';

const scene = JSON.parse(readFileSync(new URL('./fixtures/creative-scene.json', import.meta.url)));
const settle = () => new Promise(resolve => setImmediate(resolve));

test('normalizes a scene without fallback art and preserves sparse offer indices', () => {
  const cue = normalizeCue({ ...scene, products: [null, scene.products[1]] });
  assert.equal(cue?.scene.layers.length, 7);
  assert.equal(cue?.products[1].id, 'cap');
  assert.equal(cue?.products[0], null);
  assert.equal(normalizeCue({ ...scene, scene: { ...scene.scene, format: 'super' } }), null);
});

test('a refreshed cue revokes its secondary audio without replacing the scene or recounting it', async () => {
  const { window } = new JSDOM('<main><video></video></main>', { pretendToBeVisual: true });
  const stage = window.document.querySelector('main');
  const program = stage.querySelector('video');
  Object.defineProperties(program, { paused: { value: false }, readyState: { value: 4 } });
  window.HTMLMediaElement.prototype.pause = () => {};
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.load = () => {};
  let allowed = true;
  const impressions = [];
  const sdk = attachHtmlVideo({ stage, video: program, programTime: () => 1500, interval: false, refreshMs: 0,
    eventsUrl: 'https://ads.example/cues', sessionId: 'updated-consent', secondaryVideoAudio: true,
    onVisible: cue => impressions.push(cue.id), fetchImpl: async () => {
      const cue = structuredClone(scene);
      cue.scene.layers.find(layer => layer.id === 'brand-video').audio = allowed;
      return { ok: true, json: async () => [cue] };
    },
  });
  try {
    sdk.tick();
    await settle();
    const root = stage.querySelector('.il-scene');
    root.getBoundingClientRect = () => ({ width: 1920, height: 1080 });
    const video = root.querySelector('video');
    assert.equal(video.muted, false);
    allowed = false;
    sdk.tick();
    await settle();
    assert.equal(video.muted, true);
    assert.equal(root.querySelector('video'), video);
    assert.deepEqual(impressions, [scene.id]);
    allowed = true;
    sdk.tick();
    await settle();
    assert.equal(video.muted, true);
  } finally {
    sdk.destroy();
    window.close();
  }
});

for (const kind of ['HTML5', 'Video.js', 'AVPlay', 'Shaka']) {
  test(kind + ' negotiates, presents and tears down a declarative scene', async () => {
    const { window } = new JSDOM('<main><div id="shell"><video></video></div><div id="client"></div><div id="server"></div></main>', { pretendToBeVisual: true });
    const doc = window.document;
    const stage = doc.querySelector('main');
    const shell = doc.querySelector('#shell');
    const video = doc.querySelector('video');
    let paused = false;
    Object.defineProperties(video, { paused: { get: () => paused }, readyState: { value: 4 } });
    // jsdom does not decode video. Drive the decoder error through the real media event.
    window.HTMLMediaElement.prototype.pause = () => {};
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.HTMLMediaElement.prototype.load = () => {};
    let now = 1500;
    const observed = [];
    const requests = [];
    const config = {
      stage, programTime: () => now, interval: false, sessionId: 'scene-session',
      eventsUrl: 'https://ads.example/cues?scene=0&scene_features=audio', commerce: { locale: 'en', tv: true },
      secondaryVideoAudio: kind === 'Shaka',
      onVisible: cue => observed.push(cue.id),
      fetchImpl: async (input, options) => {
        const url = new URL(input);
        requests.push([url, options]);
        return { ok: true, json: async () => url.pathname === '/cues' ? [scene] :
          { continueUrl: 'https://ads.example/next', qrImageUrl: 'https://ads.example/qr.png' } };
      },
    };
    let sdk;
    if (kind === 'HTML5') sdk = attachHtmlVideo({ ...config, video });
    else if (kind === 'Video.js') sdk = attachVideoJs({ ...config, player: { el: () => shell, one() {}, off() {} } });
    else if (kind === 'AVPlay') sdk = attachAvPlay({
      ...config, surface: shell,
      avplay: { getState: () => paused ? 'PAUSED' : 'PLAYING', setDisplayRect: () => assert.fail('overlay layout must retain the video rectangle') },
      getDisplayRect: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    });
    else {
      const manager = new window.EventTarget();
      manager.setContainers = () => {};
      manager.getCurrentAd = () => null;
      manager.addCustomInterstitial = () => assert.fail('a scene is rendered by the scene compositor');
      sdk = attachShaka({
        ...config,
        player: {
          getAdManager: () => manager, getMediaElement: () => video,
          getNetworkingEngine: () => ({ registerResponseFilter() {}, unregisterResponseFilter() {} }),
        },
        clientContainer: doc.querySelector('#client'), serverContainer: doc.querySelector('#server'),
      });
    }
    try {
      sdk.tick();
      await settle();
      assert.equal(requests[0][0].searchParams.get('scene'), '1');
      const features = ['media-mask', 'media-crop', 'rich-style'];
      if (kind !== 'AVPlay') features.push('video');
      if (kind === 'Shaka') features.push('audio');
      assert.deepEqual(requests[0][0].searchParams.get('scene_features')?.split(','), features);
      const root = stage.querySelector('.il-scene');
      assert.ok(root);
      assert.match(root.style.clipPath, /75% 75%/);
      assert.equal(video.style.width, '');
      const layer = id => root.querySelector('[data-layer-id="' + id + '"]');
      assert.equal(layer('headline').style.left, '79.166667%');
      assert.equal(layer('headline').style.top, '38.888889%');
      assert.equal(layer('headline').style.opacity, '0.875');
      const heading = layer('headline').firstElementChild;
      assert.equal(heading.style.fontWeight, '700');
      assert.equal(heading.style.fontStyle, 'italic');
      assert.equal(heading.style.webkitLineClamp, '2');
      root.getBoundingClientRect = () => ({ width: 1920, height: 1080 });
      sdk.tick();
      sdk.tick();
      assert.deepEqual(observed, ['runtime-creative']);
      const secondary = layer('brand-video').querySelector('video');
      assert.equal(layer('brand-video').style.borderRadius, '50%');
      assert.equal(layer('brand-video').querySelector('img').style.transform, 'translate(50%, -25%) scale(2)');
      if (kind === 'AVPlay') assert.equal(secondary, null);
      else {
        assert.equal(secondary.muted, kind !== 'Shaka');
        assert.equal(secondary.style.transform, 'translate(50%, -25%) scale(2)');
        secondary.dispatchEvent(new window.Event('error'));
      }
      assert.equal(layer('brand-video').querySelector('img').src, 'https://ads.example/poster.png');
      assert.equal(layer('second-image').querySelector('img').src, 'https://ads.example/cap.png');
      assert.equal(layer('second-price').textContent, '16,00 US$');

      const first = root.querySelector('button[aria-label="Botines"]');
      const second = root.querySelector('button[aria-label="Gorra"]');
      first.focus();
      first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      assert.equal(doc.activeElement, second);
      second.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const panel = stage.querySelector('.il-tv-shop');
      assert.equal(panel.querySelector('h2').textContent, 'Gorra');
      assert.equal(panel.querySelector('.il-tv-hero').src, 'https://ads.example/cap.png');
      assert.equal(panel.querySelector('.il-tv-logo').src, 'https://ads.example/logo.png');
      const button = label => [...panel.querySelectorAll('button')].find(button => button.textContent === label);
      button('Choose options').click();
      button('Verde').click();
      button('Add to cart').click();
      button('Continue to QR').click();
      await settle();
      assert.deepEqual(requests.slice(1).map(([url]) => url.pathname), ['/cap/view', '/cap/cart']);
      assert.deepEqual(JSON.parse(requests.at(-1)[1].body), { variantId: 'green' });
      for (let i = 0; i < 4; i++) panel.querySelector('button[aria-label="Back"]').click();
      assert.equal(doc.activeElement, second);

      paused = true;
      sdk.tick();
      assert.equal(stage.querySelector('.il-scene'), root);
      paused = false;
      now = 4100;
      sdk.tick();
      assert.equal(layer('headline').style.visibility, 'hidden');
      sdk.setLinearAd(true);
      assert.equal(stage.querySelector('.il-scene'), null);
      sdk.setLinearAd(false);
      assert.ok(stage.querySelector('.il-scene'));
      now = scene.end;
      sdk.tick();
      assert.equal(stage.querySelector('.il-scene'), null);
      assert.deepEqual(observed, ['runtime-creative']);
    } finally {
      sdk.destroy();
      window.close();
    }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import { attachShaka } from '../web/shaka.mjs';

const require = createRequire(import.meta.url);
const origin = Date.parse('2026-11-19T12:00:00Z');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Shaka 5.3.5 draws a static L, then a super, on its own AdManager with the original video', async () => {
  const dom = new JSDOM(
    '<main><video></video><div id="client"></div><div id="server"></div></main>',
    {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
    },
  );
  const win = dom.window;
  win.TextDecoder = TextDecoder;
  win.TextEncoder = TextEncoder;
  win.eval(readFileSync(require.resolve('shaka-player/dist/shaka-player.compiled.js'), 'utf8'));
  const player = new win.shaka.Player();
  const video = win.document.querySelector('video'),
    client = win.document.querySelector('#client');
  Object.defineProperties(video, {
    readyState: { get: () => 4 },
    paused: { get: () => false },
    duration: { get: () => 60 },
  });
  let controller;
  try {
    await player.attach(video);
    controller = attachShaka({
      player,
      clientContainer: client,
      serverContainer: win.document.querySelector('#server'),
      programTime: () => origin + Math.round(video.currentTime * 1000),
      interval: false,
      sessionId: 'local',
    });
    controller.updateManifest(
      '#EXTM3U\n' +
        '#EXT-X-DATERANGE:ID="L",CLASS="com.interactivelayers.overlay",START-DATE="2026-11-19T12:00:02Z",DURATION=4,X-IL-FORMAT="l",X-ASSET-URI="https://assets.invalid/l.png"\n' +
        '#EXT-X-DATERANGE:ID="S",CLASS="com.interactivelayers.overlay",START-DATE="2026-11-19T12:00:09Z",DURATION=3,X-IL-FORMAT="super",X-ASSET-URI="https://assets.invalid/s.png"',
    );
    async function advance(time) {
      video.currentTime = time;
      video.dispatchEvent(new win.Event('timeupdate'));
      controller.tick();
      await wait(45);
    }
    for (const time of [1, 2, 2.1, 2.2]) await advance(time);
    assert.equal(player.getAdManager().getCurrentAd()?.getAdId(), 'il/L');
    assert.match(video.style.transform, /scaleX\(0.75\)/);
    assert.ok(client.querySelector('img[src$="l.png"]'));
    controller.setLinearAd(true);
    assert.ok(client.querySelector('img[data-il-hold]'));
    assert.equal(video.hasAttribute('data-il-unsqueeze'), true);
    controller.setLinearAd(false);
    assert.equal(client.querySelector('img[data-il-hold]'), null);
    assert.equal(video.hasAttribute('data-il-unsqueeze'), false);
    await advance(7);
    assert.equal(video.style.transform, '');
    assert.equal(client.querySelector('img'), null);
    for (const time of [9, 9.1, 9.2]) await advance(time);
    assert.equal(player.getAdManager().getCurrentAd()?.getAdId(), 'il/S');
    assert.equal(client.querySelector('img[src$="s.png"]').style.top, '70%');
    assert.equal(video.style.transform, '');
    assert.equal(player.getMediaElement(), video);
    await advance(13);
    assert.equal(client.querySelector('img'), null);
    // Shaka's HLS parser supplies these frames to its public AdManager. Exercise
    // the separate native overlay path without registering any new IL custom ad.
    const attributes = {
      ID: 'shaka-l',
      'X-OVERLAY-ID': 'shaka-l',
      'X-DEPTH': '-1',
      'X-SQUEEZECURRENT': '0.75',
      'X-ASSET-URI': 'https://assets.invalid/native.jpg',
      'X-ASSET-MIMETYPE': 'image/jpeg',
    };
    await player
      .getAdManager()
      .onHLSMetadata({
        type: 'com.apple.hls.interstitial',
        startTime: 15,
        endTime: 18,
        values: Object.entries(attributes).map(([key, data]) => ({ key, data })),
      });
    for (const time of [15, 15.1, 15.2]) await advance(time);
    assert.equal(player.getAdManager().getCurrentAd()?.getAdId(), 'shaka-l');
    assert.ok(client.querySelector('img[src*="native.jpg"]'));
    assert.match(video.style.transform, /scaleX\(0.75\)/);
    await advance(19);
    assert.equal(video.style.transform, '');
  } finally {
    await player.unload();
    controller?.destroy();
    await player.destroy();
    win.close();
  }
});

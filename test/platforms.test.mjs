import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachHtmlVideo, attachVideoJs, attachAvPlay } from '../web/index.mjs';

function host() {
  const { window } = new JSDOM('<main><div id="shell"><video></video></div></main>', {
    pretendToBeVisual: true,
  });
  const stage = window.document.querySelector('main');
  const shell = window.document.querySelector('#shell');
  const video = stage.querySelector('video');
  Object.defineProperties(video, { paused: { get: () => false }, readyState: { get: () => 4 } });
  return { window, stage, shell, video };
}
const line =
  '#EXT-X-DATERANGE:ID="one",CLASS="com.interactivelayers.overlay",START-DATE="2026-11-19T12:00:00Z",DURATION=5,X-IL-FORMAT="l",X-ASSET-URI="https://example.org/creative.png"';
const start = Date.parse('2026-11-19T12:00:00Z');
for (const kind of ['HTML5', 'Video.js', 'AVPlay'])
  test(kind + ' uses the same surface and restores existing layout and callback state', () => {
    const { window, stage, shell, video } = host();
    const surface = kind === 'HTML5' ? video : shell;
    surface.style.width = '98%';
    const rectangles = [];
    let now = start;
    const config = { stage, programTime: () => now, interval: false, sessionId: 'local' };
    let adapter;
    if (kind === 'HTML5') adapter = attachHtmlVideo({ ...config, video });
    else if (kind === 'Video.js')
      adapter = attachVideoJs({ ...config, player: { el: () => shell, one() {}, off() {} } });
    else
      adapter = attachAvPlay({
        ...config,
        surface,
        avplay: { getState: () => 'PLAYING', setDisplayRect: (...p) => rectangles.push(p) },
        getDisplayRect: () => ({ x: 20, y: 42, width: 1280, height: 720 }),
      });
    adapter.updateManifest(line);
    const pending = stage.querySelector('img');
    assert.ok(pending);
    assert.equal(surface.style.width, '98%');
    for (const image of stage.querySelectorAll('img'))
      image.dispatchEvent(new window.Event('load'));
    assert.equal(surface.style.width, '75%');
    if (kind === 'AVPlay') assert.deepEqual(rectangles.at(-1), [20, 42, 960, 540]);
    adapter.setLinearAd(true);
    assert.equal(surface.style.width, '98%');
    if (kind === 'AVPlay') assert.deepEqual(rectangles.at(-1), [20, 42, 1280, 720]);
    adapter.setLinearAd(false);
    const stale = stage.querySelector('img');
    now += 5000;
    adapter.tick();
    stale.dispatchEvent(new window.Event('load'));
    assert.equal(surface.style.width, '98%');
    assert.equal(stage.querySelector('img'), null);
    adapter.destroy();
    window.close();
  });

test('Video.js reads a measured program date from its VHS tech', () => {
  const { window, stage, shell } = host();
  const player = {
    el: () => shell,
    one() {},
    off() {},
    currentTime: () => 2,
    tech: () => ({
      vhs: {
        convertToProgramTime(seconds, cb) {
          assert.equal(seconds, 2);
          cb(null, { programDateTime: new Date(start).toISOString() });
        },
      },
    }),
  };
  const sdk = attachVideoJs({ player, stage, interval: false });
  sdk.updateManifest(line);
  assert.equal(stage.querySelectorAll('img').length, 2);
  sdk.destroy();
  window.close();
});

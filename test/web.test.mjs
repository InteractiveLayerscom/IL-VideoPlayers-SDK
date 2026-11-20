import test from 'node:test';
import assert from 'node:assert/strict';
import { readDateRanges, normalizeCue } from '../web/cues.mjs';
import { createSession } from '../web/session.mjs';
import { asInterstitial } from '../web/shaka.mjs';

const epoch = Date.parse('2026-11-19T12:00:00Z');
const cue = {
  id: 'tur-1',
  format: 'super',
  start: epoch,
  end: epoch + 5000,
  imageUrl: 'https://assets.example/art.png?q=1,2',
};
const cueLine =
  '#EXT-X-DATERANGE:ID="tur-1",CLASS="com.interactivelayers.overlay",START-DATE="2026-11-19T09:00:00-03:00",DURATION=5,X-IL-FORMAT="super",X-ASSET-URI="https://assets.example/art.png?q=1,2"';

test('accepts the same graphic from its media playlist and session JSON', () => {
  assert.deepEqual(readDateRanges('#EXTM3U\n' + cueLine), [normalizeCue(cue)]);
  assert.equal(readDateRanges(cueLine)[0].start, epoch);
  assert.equal(readDateRanges(cueLine)[0].imageUrl, cue.imageUrl);
  assert.equal(
    readDateRanges(cueLine.replace('DURATION=5', 'END-DATE="2026-11-19T12:00:05Z"'))[0].end,
    epoch + 5000,
  );
});

test('ignores cue-outs, Apple linear interstitials, unsafe resources and broken timing', () => {
  for (const line of [
    '#EXT-X-CUE-OUT:15',
    cueLine.replace('com.interactivelayers.overlay', 'com.apple.hls.interstitial'),
    cueLine.replace('DURATION=5', 'DURATION=0'),
    cueLine.replace('DURATION=5', 'DURATION=5,END-DATE="2026-11-19T12:01:00Z"'),
    cueLine.replace('-03:00', ''),
    cueLine.replace('https:', 'data:'),
    cueLine.replace('https://', 'https://user@'),
    cueLine + ',X-IL-FORMAT="l"',
    cueLine + ',X-ASSET-MIMETYPE="text/html"',
  ]) {
    assert.deepEqual(readDateRanges(line), []);
  }
  assert.equal(normalizeCue({ ...cue, start: String(epoch) }), null);
});

function setup(options = {}) {
  let now = epoch,
    playing = true,
    shown = false;
  const events = [];
  const session = createSession({
    sessionId: 'test-session',
    clock: () => now,
    playing: () => playing,
    interval: false,
    renderer: {
      show(c) {
        events.push(c.id);
      },
      hide() {
        events.push('hide');
      },
      visible() {
        return shown;
      },
    },
    onVisible: (c) => events.push('visible:' + c.id),
    ...options,
  });
  return {
    session,
    events,
    time: (t) => (now = t),
    play: (p) => (playing = p),
    shown: (v) => (shown = v),
  };
}

test('requests, refreshes and replays a cue, restores full screen, counts after visible only once', () => {
  const { session, events, time, shown, play } = setup();
  session.updateManifest(cueLine);
  session.tick();
  session.tick();
  assert.deepEqual(events, ['tur-1']);
  shown(true);
  session.tick();
  session.tick();
  session.setLinearAd(true);
  session.tick();
  session.setLinearAd(false);
  play(false);
  session.tick();
  play(true);
  session.tick();
  time(epoch + 5000);
  session.tick();
  session.destroy();
  session.tick();
  assert.deepEqual(events, ['tur-1', 'visible:tur-1', 'hide', 'tur-1', 'hide', 'tur-1', 'hide']);
});

test('reads session JSON for the playhead, ignores a late response after detach and never opens a second decision path', async () => {
  let finish;
  const requests = [];
  const { session, events } = setup({
    eventsUrl: 'https://pilot.example/events',
    fetchImpl: (url) => {
      requests.push(new URL(url));
      return new Promise((resolve) => (finish = resolve));
    },
  });
  session.updateManifest(cueLine);
  session.tick();
  session.tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('sid'), 'test-session');
  assert.equal(requests[0].searchParams.get('time'), String(epoch));
  session.destroy();
  finish({ ok: true, json: async () => [cue] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
});

test('maps UTC milliseconds to media seconds and delegates geometry to the native Shaka interstitial', () => {
  const item = asInterstitial(normalizeCue({ ...cue, format: 'l' }), epoch + 1000, 208);
  assert.equal(item.startTime, 207);
  assert.equal(item.endTime, 212);
  assert.equal(item.displayOnBackground, true);
  assert.equal(item.currentVideo.size.x, 1440);
  assert.equal(item.currentVideo.size.y, 810);
  assert.equal(item.overlay.size.x, 1920);
  assert.equal(item.tracking, null);
  assert.equal(item.timelineRange, true);
  const banner = asInterstitial(normalizeCue(cue), epoch, 207);
  assert.equal(banner.currentVideo, null);
  assert.equal(banner.overlay.topLeft.y, 756);
});

test('a pinned cue survives a feed refresh that returns no cues and the clean-up of old cues', async () => {
  const { session, events, time } = setup({
    eventsUrl: 'https://pilot.example/events',
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  assert.equal(session.addCue(cue), true);
  session.tick();
  await new Promise((resolve) => setImmediate(resolve));
  session.tick();
  assert.deepEqual(events, ['tur-1']);
  time(epoch + 5000 + 200000);
  session.tick();
  time(epoch + 1000);
  session.tick();
  assert.deepEqual(events, ['tur-1', 'hide', 'tur-1']);
  session.destroy();
});

test('addCue rejects an invalid cue and removeCue hides a pinned cue once', () => {
  const { session, events } = setup();
  assert.equal(session.addCue({ ...cue, end: cue.start }), false);
  session.tick();
  assert.deepEqual(events, []);
  session.addCue(cue);
  session.tick();
  assert.equal(session.removeCue('tur-1'), true);
  assert.equal(session.removeCue('tur-1'), false);
  session.tick();
  assert.deepEqual(events, ['tur-1', 'hide']);
});

test('a pinned cue reports its own visibility once and every time it stops being presented', () => {
  const { session, events, time, shown } = setup();
  const log = [];
  session.addCue(cue, {
    onVisible: (c) => log.push('visible:' + c.id),
    onHidden: (c) => log.push('hidden:' + c.id),
  });
  shown(true);
  session.tick();
  time(epoch + 6000);
  session.tick();
  time(epoch + 1000);
  session.tick();
  session.setLinearAd(true);
  session.setLinearAd(false);
  session.removeCue('tur-1');
  assert.deepEqual(log, ['visible:tur-1', 'hidden:tur-1', 'hidden:tur-1', 'hidden:tur-1']);
  assert.equal(events.includes('visible:tur-1'), false);
});

test('the media timeline places cues in milliseconds from the start of a plain video', async () => {
  const { attachHtmlVideo } = await import('../web/index.mjs');
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM('<main><video></video></main>', { pretendToBeVisual: true });
  const stage = window.document.querySelector('main');
  const video = stage.querySelector('video');
  let currentTime = 6;
  Object.defineProperties(video, {
    paused: { value: false }, readyState: { value: 4 }, currentTime: { get: () => currentTime },
  });
  const sdk = attachHtmlVideo({ video, stage, timeline: 'media', interval: false });
  sdk.addCue({ ...cue, start: 5000, end: 9000 });
  assert.ok(stage.querySelector('img'));
  currentTime = 10;
  sdk.tick();
  assert.equal(stage.querySelector('img'), null);
  sdk.destroy();
  window.close();
});

test('a cue with an https clickUrl gets a link over its graphic only', async () => {
  const { attachHtmlVideo } = await import('../web/index.mjs');
  const { JSDOM } = await import('jsdom');
  const clickUrl = 'https://brand.example/landing';
  assert.equal(normalizeCue({ ...cue, clickUrl }).clickUrl, clickUrl);
  assert.equal('clickUrl' in normalizeCue({ ...cue, clickUrl: 'javascript:alert(1)' }), false);
  assert.equal('clickUrl' in normalizeCue({ ...cue, clickUrl: '/landing' }), false);
  const { window } = new JSDOM('<main><video></video></main>', { pretendToBeVisual: true });
  const stage = window.document.querySelector('main');
  const video = stage.querySelector('video');
  Object.defineProperties(video, { paused: { value: false }, readyState: { value: 4 } });
  const clicks = [];
  const sdk = attachHtmlVideo({ video, stage, programTime: () => epoch, interval: false });
  sdk.addCue({ ...cue, clickUrl }, { onClick: (c) => clicks.push(c.id) });
  const link = stage.querySelector('a');
  assert.equal(link.href, clickUrl);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.parentElement.style.height, '20%');
  stage.addEventListener('click', (event) => event.preventDefault());
  link.click();
  assert.deepEqual(clicks, ['tur-1']);
  sdk.removeCue('tur-1');
  sdk.addCue({ ...cue, id: 'plain' });
  assert.ok(stage.querySelector('img'));
  assert.equal(stage.querySelector('a'), null);
  sdk.destroy();
  window.close();
});

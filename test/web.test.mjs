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

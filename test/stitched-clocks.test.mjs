import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  attachAds, nativeHlsContentClock, parseMediaPlaylist, shakaContentClock, videoJsContentClock,
} from '../web/ads.mjs';

globalThis.DOMParser = new JSDOM('').window.DOMParser;

const ORIGIN = '2000-01-01T00:00:00.000Z';
const TAG = 'https://pubads.g.doubleclick.net/gampad/ads?iu=/123/site/graphic&env=vp&output=vast&cust_params=il_format%3Dsuper';
const VAST = '<VAST version="3.0"><Ad id="ad"><InLine><AdTitle>C</AdTitle><Impression>https://pixel.invalid/i</Impression><Creatives><Creative><NonLinearAds><NonLinear width="720" height="108"><StaticResource creativeType="image/png">https://creative.invalid/a.png</StaticResource></NonLinear></NonLinearAds></Creative></Creatives></InLine></Ad></VAST>';
const pdt = (seconds) => new Date(Date.parse(ORIGIN) + seconds * 1000).toISOString();

// Stream as MediaTailor personalizes it: pre-roll ad 0–10, content 0–30 at 10–40, mid-roll 40–50, content 30–60
// at 50–80 (5 s segments). Content segments keep the PDT IL wrote and the #EXT-X-ASSET marker MediaTailor keeps;
// ad segments sit between discontinuities, without PDT, here also inside CUE-OUT/CUE-IN and a DATERANGE, as
// MediaTailor writes them with ad markers turned on.
function playlist({ markers = true } = {}) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-DISCONTINUITY-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  const ad = (name, at) => {
    if (markers) lines.push(`#EXT-X-DATERANGE:ID="${name}",START-DATE="${pdt(at)}",DURATION=10.0`, '#EXT-X-CUE-OUT:10.000');
    for (let i = 0; i < 2; i++) {
      if (markers && i) lines.push('#EXT-X-CUE-OUT-CONT:ElapsedTime=5.000,Duration=10.000');
      lines.push('#EXTINF:5.0,', `https://ads.example/${name}/${i}.ts`);
    }
    if (markers) lines.push('#EXT-X-CUE-IN');
  };
  const content = (from, to, asset) => {
    for (let s = from; s < to; s += 5) {
      lines.push('#EXT-X-PROGRAM-DATE-TIME:' + pdt(s));
      if (s === from && asset) lines.push(`#EXT-X-ASSET:IL_ASSET=a,IL_CUE=${from},IL_BREAK=1,IL_POS=midroll`);
      lines.push('#EXTINF:5.0,', `https://cdn.example/c/${s / 5}.ts`);
    }
  };
  ad('pre', -10);
  lines.push('#EXT-X-DISCONTINUITY');
  content(0, 30, false);
  lines.push('#EXT-X-DISCONTINUITY');
  ad('mid', 30);
  lines.push('#EXT-X-DISCONTINUITY');
  content(30, 60, true);
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
const truth = (t) => (t >= 10 && t < 40 ? t - 10 : t >= 50 && t < 80 ? t - 20 : null);
// The clock's margins: 0.25 s after an ad, 0.5 s before one (at rate 1).
const masked = (t) => (t >= 10 && t < 10.25) || (t >= 39.5 && t < 40) || (t >= 50 && t < 50.25);
const unsure = (t) => [10.25, 39.5, 50.25].some((edge) => Math.abs(t - edge) < 0.01);

function stitchedPlan({ windows } = {}) {
  return {
    version: 1, expires_at: new Date(Date.now() + 3600000).toISOString(), page_url: 'https://publisher.example/v',
    timeline: { kind: 'stitched', pdt_origin: ORIGIN, breaks: [0, 30] }, cuts: [],
    scenes: {
      formats: ['super'],
      pacing: { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0 },
      graphics: [{ format: 'super', tag_url: TAG }],
      windows: windows ?? [{ id: 'w', start_ms: 20000, end_ms: 35000 }],
    },
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Shaka: a networking engine whose response filters see what Shaka downloads.
const VARIANT = 'https://session.example/v.m3u8';
function fakeShaka({ loaded = false } = {}) {
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, paused: false, playbackRate: 1, buffered: { length: 0 } });
  const filters = new Set();
  const network = {
    registerResponseFilter: (fn) => filters.add(fn),
    unregisterResponseFilter: (fn) => filters.delete(fn),
  };
  const player = Object.assign(new EventTarget(), {
    active: VARIANT,
    getNetworkingEngine: () => network, getMediaElement: () => video, getManifest: () => (loaded ? {} : null),
    getVariantTracks: () => [{ active: true, originalVideoId: player.active }],
  });
  return {
    video, filters, player,
    download(text, type = 0, uri = VARIANT) {
      const data = new TextEncoder().encode(text).buffer;
      for (const fn of filters) fn(type, { uri: uri + '?redirected', originalUri: uri, data });
    },
  };
}

// Video.js: VHS's parsed media playlist, as m3u8-parser leaves it (programDateTime extrapolated everywhere).
function fakeVideoJs(text = playlist()) {
  const segments = [];
  let start = 0;
  for (const s of parseMediaPlaylist(text)) {
    segments.push({ duration: s.duration, uri: 'x.ts', programDateTime: Date.parse(ORIGIN) + (start - 10) * 1000,
      ...(Number.isFinite(s.pdt) ? { dateTimeString: new Date(s.pdt).toISOString(), dateTimeObject: new Date(s.pdt) } : {}) });
    start += s.duration;
  }
  const media = { segments };
  const state = { time: 0, rate: 1, vhs: { playlists: { media: () => media } } };
  return {
    state, media,
    player: { currentTime: () => state.time, playbackRate: () => state.rate, tech: () => ({ vhs: state.vhs }) },
  };
}

const factories = {
  shaka() {
    const s = fakeShaka();
    const clock = shakaContentClock({ player: s.player, plan: stitchedPlan() });
    s.download(playlist());
    return { clock, set: (t, rate = 1) => Object.assign(s.video, { currentTime: t, playbackRate: rate }), video: s.video };
  },
  videojs() {
    const v = fakeVideoJs();
    const clock = videoJsContentClock({ player: v.player, plan: stitchedPlan() });
    return { clock, set: (t, rate = 1) => Object.assign(v.state, { time: t, rate }) };
  },
  async native() {
    const video = new EventTarget();
    Object.assign(video, { currentTime: 0, paused: false, playbackRate: 1 });
    const clock = nativeHlsContentClock({ video, plan: stitchedPlan(), playlistUrl: 'https://session.example/v.m3u8', sessionManifest: true,
      fetchImpl: async () => ({ ok: true, text: async () => playlist() }) });
    await flush();
    return { clock, set: (t, rate = 1) => Object.assign(video, { currentTime: t, playbackRate: rate }), video };
  },
};

test('a MediaTailor playlist lays out in stream time, and only a segment with its own PDT is content', () => {
  const segments = parseMediaPlaylist(playlist());
  assert.equal(segments.length, 16);
  assert.deepEqual(segments.map((s) => s.start), Array.from({ length: 16 }, (_, i) => i * 5));
  const content = segments.map((s) => (Number.isFinite(s.pdt) ? (s.pdt - Date.parse(ORIGIN)) / 1000 : null));
  assert.deepEqual(content, [null, null, 0, 5, 10, 15, 20, 25, null, null, 30, 35, 40, 45, 50, 55]);
  // Without MediaTailor's ad markers, the same layout.
  assert.deepEqual(parseMediaPlaylist(playlist({ markers: false })), segments);
  // CRLF, a bad duration and a PDT with no segment after it.
  assert.deepEqual(parseMediaPlaylist('#EXTM3U\r\n#EXTINF:2,\r\na.ts\r\n#EXTINF:x,\r\nb.ts\r\n#EXT-X-PROGRAM-DATE-TIME:2000-01-01T00:00:00Z\r\n')
    .map((s) => [s.start, s.duration]), [[0, 2]]);
});

for (const [name, make] of Object.entries(factories)) {
  test(`the ${name} clock reads content time from the written PDT and null over ads`, async () => {
    const { clock, set } = await make();
    const read = (t, rate) => {
      set(t, rate);
      return clock.time();
    };
    for (let t = 0; t < 80; t += 0.1) {
      const got = read(t);
      if (unsure(t)) continue;
      if (truth(t) == null || masked(t)) assert.equal(got, null, `${name} at ${t}`);
      else assert.ok(Math.abs(got - truth(t)) < 1e-9, `${name} at ${t}: ${got}`);
    }
    // Ahead of an ad the margin is half a second of wall time, wider at a faster rate.
    assert.ok(read(39.4) != null);
    assert.equal(read(39.1, 2), null);
    assert.ok(read(38.9, 2) != null);
    // Seeks both ways, and the content second in milliseconds for the session.
    for (const t of [70, 12, 60, 44, 33, 5, 51.7]) {
      const got = read(t);
      if (truth(t) == null || masked(t)) assert.equal(got, null);
      else assert.ok(Math.abs(got - truth(t)) < 1e-9);
    }
    set(22.5);
    assert.equal(clock.programTime(), 12500);
    set(45);
    assert.equal(clock.programTime(), null);
    clock.destroy();
    set(22.5);
    assert.equal(clock.time(), null);
  });

  test(`the ${name} clock refuses a plan that is not stitched`, () => {
    for (const plan of [{}, { timeline: { kind: 'stitched' } }, { timeline: { kind: 'other', pdt_origin: ORIGIN } }]) {
      const s = fakeShaka();
      const v = fakeVideoJs();
      const build = {
        shaka: () => shakaContentClock({ player: s.player, plan }),
        videojs: () => videoJsContentClock({ player: v.player, plan }),
        native: () => nativeHlsContentClock({ video: s.video, plan, playlistUrl: 'https://x.example/p.m3u8' }),
      }[name];
      assert.throws(build, TypeError);
    }
  });
}

test('the Shaka clock knows nothing before a media playlist, ignores the master, notifies, and lets go', () => {
  const s = fakeShaka();
  const clock = shakaContentClock({ player: s.player, plan: stitchedPlan() });
  s.video.currentTime = 22;
  assert.equal(clock.time(), null);
  let changes = 0;
  clock.onChange(() => changes++);
  s.download('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n');
  s.download(playlist(), 1); // a segment, not a playlist
  assert.equal(changes, 0);
  s.download(playlist().replace(/#EXT-X-PROGRAM-DATE-TIME:.*\n/g, '')); // a playlist without the clock: all ads
  assert.equal(clock.time(), null);
  assert.equal(changes, 1);
  s.download(playlist());
  assert.equal(changes, 2);
  assert.equal(clock.time(), 12);
  clock.destroy();
  assert.equal(s.filters.size, 0);
});

test('the Shaka clock must be created before load: afterwards the playlists are gone', () => {
  const s = fakeShaka({ loaded: true });
  assert.throws(() => shakaContentClock({ player: s.player, plan: stitchedPlan() }), /before player\.load/);
  assert.throws(() => shakaContentClock({ player: {}, plan: stitchedPlan() }), TypeError);
});

test('the Video.js clock never uses the extrapolated programDateTime, follows VHS timing, and is null without VHS', () => {
  const v = fakeVideoJs();
  const clock = videoJsContentClock({ player: v.player, plan: stitchedPlan() });
  v.state.time = 2;
  assert.equal(clock.time(), null, 'the pre-roll has an extrapolated programDateTime, and it is still an ad');
  v.state.time = 52;
  assert.equal(clock.time(), 32);
  // VHS timed the mid-roll 0.2 s longer: the content after it starts later in stream time.
  v.media.segments.forEach((segment, i) => { segment.start = i * 5 + (i >= 10 ? 0.2 : 0); });
  v.state.time = 52.2;
  assert.ok(Math.abs(clock.time() - 32) < 1e-9);
  v.state.vhs = undefined; // Safari's native HLS under Video.js
  assert.equal(clock.time(), null);
});

test('the native clock follows a master to its variants, omits credentials, and stays null when the fetch fails', async () => {
  const video = { currentTime: 22, playbackRate: 1 };
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push([url, init.credentials]);
    return url.endsWith('master.m3u8')
      ? { ok: true, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/1.m3u8?aws.sessionId=s\n#EXT-X-STREAM-INF:BANDWIDTH=2\nv/2.m3u8\n' }
      : { ok: true, text: async () => playlist() };
  };
  const clock = nativeHlsContentClock({ video, plan: stitchedPlan(), playlistUrl: 'https://session.example/s/master.m3u8',
    sessionManifest: true, fetchImpl });
  let changes = 0;
  clock.onChange(() => changes++);
  assert.equal(clock.time(), null);
  await flush();
  await flush();
  // Every variant is read: which one Safari shows cannot be known.
  assert.deepEqual(asked, [['https://session.example/s/master.m3u8', 'omit'], ['https://session.example/s/v/1.m3u8?aws.sessionId=s', 'omit'],
    ['https://session.example/s/v/2.m3u8', 'omit']]);
  assert.equal(changes, 1);
  assert.equal(clock.time(), 12);
  const failing = nativeHlsContentClock({ video, plan: stitchedPlan(), playlistUrl: 'https://session.example/p.m3u8',
    sessionManifest: true, fetchImpl: async () => ({ ok: false, status: 404 }) });
  await flush();
  assert.equal(failing.time(), null);
});

// The ads module over each clock: a window that straddles the mid-roll hides during the ad and comes back.
for (const name of ['shaka', 'native']) {
  test(`attachAds over the ${name} clock: never a graphic over an ad, one request, and shown on both sides`, async () => {
    const { clock, video } = await factories[name]();
    const onScreen = new Map();
    const calls = [];
    const session = {
      clock: clock.programTime,
      addCue(cue, hooks) { calls.push({ cue, hooks }); onScreen.set(cue.id, cue); return true; },
      removeCue(id) { onScreen.delete(id); return true; },
    };
    const requests = [];
    const ads = attachAds({ session, video, plan: stitchedPlan(), clock,
      fetchImpl: async (url) => { requests.push(String(url)); return { ok: true, text: async () => VAST }; } });
    for (let step = 0; step <= 800; step++) {
      video.currentTime = step / 10;
      video.dispatchEvent(new Event('timeupdate'));
      await flush();
      if (truth(video.currentTime) == null) assert.equal(onScreen.size, 0, `graphic over an ad at ${video.currentTime}`);
    }
    // Seek back into the window (a replay of that part) and pause there: never a second request or a second cue,
    // and whatever is on screen sits at the planned content seconds.
    video.currentTime = 32;
    video.dispatchEvent(new Event('seeked'));
    await flush();
    video.paused = true;
    video.dispatchEvent(new Event('pause'));
    await flush();
    assert.ok([...onScreen.values()].every((cue) => cue.id === 'il-ads-w' && cue.start === 20000 && cue.end === 35000));
    assert.equal(requests.length, 1);
    const adds = calls.filter((call) => call.cue.id === 'il-ads-w');
    assert.ok(adds.length >= 2 && adds.every((call) => call.hooks === adds[0].hooks), 'the impression is measured once');
    assert.deepEqual([adds[0].cue.start, adds[0].cue.end], [20000, 35000]);
    ads.destroy();
  });
}

test('a page loaded in the middle of an ad draws nothing until content, then the window as planned', async () => {
  const { clock, video } = await factories.shaka();
  video.currentTime = 44; // mid-roll, before anything was drawn
  const onScreen = new Map();
  const session = {
    clock: clock.programTime,
    addCue(cue) { onScreen.set(cue.id, cue); return true; },
    removeCue(id) { onScreen.delete(id); return true; },
  };
  const ads = attachAds({ session, video, plan: stitchedPlan(), clock,
    fetchImpl: async () => ({ ok: true, text: async () => VAST }) });
  for (let t = 44; t < 50; t += 0.2) {
    video.currentTime = t;
    video.dispatchEvent(new Event('timeupdate'));
    await flush();
    assert.equal(onScreen.size, 0);
  }
  video.currentTime = 51;
  video.dispatchEvent(new Event('timeupdate'));
  await flush();
  await flush();
  assert.equal(onScreen.get('il-ads-w')?.end, 35000, 'content 31 s is inside the window 20–35 s');
  ads.destroy();
});

// MediaTailor's master names its variants relative to the master, in another directory; Shaka keeps that relative URI
// as the track's originalVideoId. Resolved against the media playlist's own URL it named nothing, so the clock never
// found the active variant (`clock_playlist_missing`) and nothing was drawn with Shaka on a real MediaTailor stream.
test('the Shaka clock finds a variant the master names relative to itself in another directory', () => {
  const s = fakeShaka();
  const master = 'https://mt.example/v1/master/h/cfg/master.m3u8';
  const media = 'https://mt.example/v1/manifest/h/cfg/session/0.m3u8';
  s.player.active = '../../../manifest/h/cfg/session/0.m3u8';
  const events = [];
  const clock = shakaContentClock({ player: s.player, plan: stitchedPlan(), onEvent: (e) => events.push(e) });
  s.download(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n${s.player.active}\n`, 0, master);
  s.download(playlist(), 0, media);
  s.video.currentTime = 22;
  assert.equal(clock.time(), 12);
  assert.deepEqual(events.filter((e) => e.type === 'clock_playlist_missing'), []);
  clock.destroy();
});

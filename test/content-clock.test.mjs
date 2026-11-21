import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachAds, hlsContentClock, usableWindows, videoClock } from '../web/ads.mjs';

globalThis.DOMParser = new JSDOM('').window.DOMParser;

const ORIGIN = '2000-01-01T00:00:00.000Z';
const TAG = 'https://pubads.g.doubleclick.net/gampad/ads?iu=/123/site/graphic&env=vp&output=vast&cust_params=il_format%3Dsuper';
const VAST = '<VAST version="3.0"><Ad id="ad"><InLine><AdTitle>C</AdTitle><Impression>https://pixel.invalid/i</Impression><Creatives><Creative><NonLinearAds><NonLinear width="720" height="108"><StaticResource creativeType="image/png">https://creative.invalid/a.png</StaticResource></NonLinear></NonLinearAds></Creative></Creatives></InLine></Ad></VAST>';
const pdt = (seconds) => new Date(Date.parse(ORIGIN) + seconds * 1000).toISOString();

// Stream: pre-roll ad 0–10, content 0–30 at 10–40, mid-roll ad 40–50, content 30–60 at 50–80 (5 s fragments).
function fragments() {
  const list = [];
  const add = (from, to, contentStart) => {
    for (let t = from; t < to; t += 5)
      list.push({ start: t, duration: 5, rawProgramDateTime: contentStart == null ? null : pdt(contentStart + t - from),
        // hls.js extrapolates this through ads; the clock must ignore it.
        programDateTime: Date.parse(ORIGIN) + (t - 10) * 1000 });
  };
  add(0, 10, null);
  add(10, 40, 0);
  add(40, 50, null);
  add(50, 80, 30);
  return list;
}
const truth = (t) => (t >= 10 && t < 40 ? t - 10 : t >= 50 && t < 80 ? t - 20 : null);

function fakeHls({ loaded = true } = {}) {
  const handlers = new Map();
  const details = { fragments: fragments() };
  return {
    details,
    levels: [{ details: loaded ? details : undefined }],
    currentLevel: loaded ? 0 : -1,
    on(name, fn) { (handlers.get(name) ?? handlers.set(name, new Set()).get(name)).add(fn); },
    off(name, fn) { handlers.get(name)?.delete(fn); },
    emit(name, data) { for (const fn of handlers.get(name) ?? []) fn(name, data); },
    count() { return [...handlers.values()].reduce((n, set) => n + set.size, 0); },
  };
}

function stitchedPlan({ windows, pacing = {}, timeline = {}, cuts = [], ...rest } = {}) {
  return {
    version: 1, expires_at: new Date(Date.now() + 3600000).toISOString(), page_url: 'https://publisher.example/v',
    timeline: { kind: 'stitched', pdt_origin: ORIGIN, ...timeline },
    cuts,
    scenes: {
      formats: ['super'],
      pacing: { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0, ...pacing },
      graphics: [{ format: 'super', tag_url: TAG }],
      windows: windows ?? [{ id: 'w', start_ms: 20000, end_ms: 35000 }],
    },
    ...rest,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rig({ plan = stitchedPlan(), withClock = true, sessionClock, ...options } = {}) {
  const video = new EventTarget();
  video.currentTime = 0;
  video.paused = false;
  video.playbackRate = 1;
  const hls = fakeHls();
  const clock = withClock ? hlsContentClock({ hls, video, plan }) : undefined;
  const onScreen = new Map();
  const calls = [];
  const session = {
    // Like attachHtmlVideo: the clock the session renders from.
    clock: sessionClock ?? clock?.programTime,
    addCue(cue, hooks) { calls.push({ cue, hooks }); onScreen.set(cue.id, cue); return true; },
    removeCue(id) { onScreen.delete(id); return true; },
  };
  const requests = [];
  const scripts = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return { ok: true, text: async () => VAST };
  };
  const ads = attachAds({ session, video, plan, fetchImpl, clock, loadScript: async (src) => { scripts.push(src); }, ...options });
  const at = async (t, type = 'timeupdate') => {
    video.currentTime = t;
    video.dispatchEvent(new Event(type));
    await flush();
  };
  return { video, hls, clock, ads, onScreen, calls, requests, scripts, at };
}

test('the default clock is the video position, never in an ad', () => {
  const video = { currentTime: 12.345 };
  const clock = videoClock(video);
  assert.equal(clock.time(), 12.345);
  assert.equal(clock.programTime(), 12345);
  video.currentTime = undefined;
  assert.equal(clock.time(), 0);
});

test('the hls clock reads content time from the raw program date time, and null over ads', () => {
  const video = { currentTime: 0 };
  const hls = fakeHls();
  const clock = hlsContentClock({ hls, video, plan: stitchedPlan() });
  const read = (t) => {
    video.currentTime = t;
    return clock.time();
  };
  // Pre-roll, content, mid-roll, content, read without any fragment event.
  for (const t of [0, 3, 9.9]) assert.equal(read(t), null, `pre-roll ${t}`);
  for (const t of [10.5, 12, 22.5, 39.3]) assert.ok(Math.abs(read(t) - truth(t)) < 1e-9, `content ${t}`);
  for (const t of [40, 44, 49.9]) assert.equal(read(t), null, `mid-roll ${t}`);
  for (const t of [50.5, 66, 79]) assert.ok(Math.abs(read(t) - truth(t)) < 1e-9, `content ${t}`);
  // Within a quarter second of an ad fragment the picture counts as the ad.
  assert.equal(read(10.1), null);
  assert.equal(read(39.8), null);
  // Ahead of an ad the margin is half a second of wall time, wider at a faster rate.
  assert.equal(read(39.6), null);
  assert.ok(read(39.4) != null);
  video.playbackRate = 2;
  assert.equal(read(39.1), null);
  assert.ok(read(38.9) != null);
  video.playbackRate = 1;
  assert.equal(read(50.2), null);
  assert.equal(clock.programTime(), null);
  video.currentTime = 22.5;
  assert.equal(clock.programTime(), 12500);
});

test('the hls clock follows seeks both ways and a stale fragment event', () => {
  const video = { currentTime: 0 };
  const hls = fakeHls();
  const clock = hlsContentClock({ hls, video, plan: stitchedPlan() });
  hls.emit('hlsFragChanged', { frag: hls.details.fragments[3] }); // 15–20
  for (const t of [70, 12, 60, 44, 33, 5, 51]) {
    video.currentTime = t;
    const expected = truth(t);
    const got = clock.time();
    if (expected == null || [10, 40, 50].some((edge) => Math.abs(t - edge) < 0.5)) assert.equal(got, null, `seek ${t}`);
    else assert.ok(Math.abs(got - expected) < 1e-9, `seek ${t}: ${got}`);
  }
});

test('the hls clock answers at the first frames from LEVEL_LOADED alone, and from nothing says null', () => {
  const video = { currentTime: 12 };
  const hls = fakeHls({ loaded: false });
  const clock = hlsContentClock({ hls, video, plan: stitchedPlan() });
  assert.equal(clock.time(), null);
  hls.emit('hlsLevelLoaded', { details: hls.details });
  assert.equal(clock.time(), 2);
});

test('a fragment change while paused on a boundary notifies, and the boundary is the ad', () => {
  const video = { currentTime: 40 };
  const hls = fakeHls();
  const clock = hlsContentClock({ hls, video, plan: stitchedPlan() });
  let changes = 0;
  const stop = clock.onChange(() => changes++);
  hls.emit('hlsFragChanged', { frag: hls.details.fragments[7] }); // content 35–40, stale
  assert.equal(clock.time(), null);
  hls.emit('hlsFragChanged', { frag: hls.details.fragments[8] }); // ad 40–45
  assert.equal(changes, 2);
  stop();
  clock.destroy();
  assert.equal(hls.count(), 0);
  assert.equal(clock.time(), null);
});

test('the hls clock refuses a plan that is not stitched or has no origin', () => {
  const video = { currentTime: 0 };
  for (const plan of [{}, { timeline: { kind: 'stitched' } }, { timeline: { kind: 'other', pdt_origin: ORIGIN } },
    { timeline: { kind: 'stitched', pdt_origin: 'yesterday' } }])
    assert.throws(() => hlsContentClock({ hls: fakeHls(), video, plan }), TypeError);
});

test('a window that straddles a mid-roll hides during the ad and resumes after, within its length', async () => {
  const r = rig();
  let shownContent = 0;
  let last = null;
  for (let step = 0; step <= 800; step++) {
    const t = step / 10;
    await r.at(t);
    // Visible as the session decides it: pinned, and the session's clock (programTime) inside the cue.
    const cue = r.onScreen.get('il-ads-w');
    const time = r.clock.programTime();
    if (cue) assert.notEqual(truth(t), null, `graphic pinned over an ad at ${t}`);
    const present = !!cue && time != null && cue.start <= time && time < cue.end;
    const content = r.clock.time();
    if (present && last != null && content != null) shownContent += content - last;
    last = present ? content : null;
  }
  assert.equal(r.requests.length, 1);
  // Content 20–35 is stream 30–40 then 50–55: shown on both sides of the ad.
  const adds = r.calls.filter((call) => call.cue.id === 'il-ads-w');
  assert.equal(adds.length, 2);
  assert.equal(adds[0].hooks, adds[1].hooks, 'the same hooks, so the impression is measured once');
  assert.deepEqual([adds[0].cue.start, adds[0].cue.end], [20000, 35000]);
  assert.ok(shownContent <= 15 + 1e-9 && shownContent > 13, `shown ${shownContent}`);
  assert.equal(r.onScreen.size, 0);
  r.ads.destroy();
});

test('cut clearance uses the plan\'s break times in content seconds', async () => {
  const plan = stitchedPlan({ pacing: { cut_clearance_seconds: 2 }, timeline: { breaks: [0, 30] } });
  assert.deepEqual(usableWindows(plan).map((w) => [w.start, w.end]), [[20000, 28000]]);
  const r = rig({ plan });
  for (let t = 25; t <= 60; t += 0.5) {
    await r.at(t);
    if (r.clock.time() == null || r.clock.time() >= 28) assert.equal(r.onScreen.size, 0, `at ${t}`);
  }
  r.ads.destroy();
});

test('a random walk of plays and seeks never leaves a graphic over an ad fragment', async () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const windows = [{ id: 'a', start_ms: 1000, end_ms: 9000 }, { id: 'b', start_ms: 26000, end_ms: 34000 },
    { id: 'c', start_ms: 45000, end_ms: 58000 }];
  const r = rig({ plan: stitchedPlan({ windows }) });
  let t = 0;
  for (let step = 0; step < 1500; step++) {
    const jump = random();
    if (jump < 0.05) {
      t = random() * 80;
      await r.at(t, 'seeking');
      await r.at(t, 'seeked');
    } else {
      t = Math.min(79.9, t + 0.1 + random() * 0.4);
      if (jump < 0.08) {
        const frag = r.hls.details.fragments.find((f) => f.start <= t && t < f.start + f.duration);
        r.video.currentTime = t;
        r.hls.emit('hlsFragChanged', { frag });
        await flush();
      } else await r.at(t);
    }
    if (truth(r.video.currentTime) == null) assert.equal(r.onScreen.size, 0, `graphic over an ad at ${r.video.currentTime}`);
  }
  assert.ok(r.calls.length > 0, 'graphics were drawn on content');
  r.ads.destroy();
});

test('a stitched plan never loads IMA or asks for a break, even with linear and cuts passed by mistake', async () => {
  const cuts = [{ id: 'pre', at: 0, position: 'preroll', tag_url: TAG }, { id: 'mid', at: 30, position: 'midroll', tag_url: TAG }];
  const r = rig({ plan: stitchedPlan({ cuts }), linear: 'ima', adContainer: {} });
  assert.deepEqual(r.ads.cuts, []);
  assert.doesNotMatch(r.ads.vmap(), /AdBreak/);
  r.ads.start();
  for (let t = 0; t < 80; t += 1) await r.at(t);
  r.ads.start();
  assert.deepEqual(r.scripts, []);
  assert.ok(r.requests.every((url) => url.includes('il_format%3Dsuper')), 'only the scene graphic is requested');
  r.ads.destroy();
});

test('a stitched plan without a content clock, or an unknown timeline, stays inert', async () => {
  for (const options of [{ withClock: false }, { withClock: false, plan: stitchedPlan({ timeline: { kind: 'live' } }) },
    { withClock: false, plan: stitchedPlan({ timeline: { breaks: ['x'] } }) }]) {
    const r = rig({ ...options, linear: 'ima', adContainer: {} });
    for (let t = 0; t < 80; t += 2) await r.at(t);
    r.ads.start();
    assert.deepEqual([r.requests, r.scripts, r.calls.length, r.ads.cuts], [[], [], 0, []]);
    r.ads.destroy();
  }
});

function fakeGpt() {
  const listeners = new Map();
  const service = {
    initialLoadDisabled: false,
    addEventListener(name, fn) { (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn); },
    removeEventListener() {},
    isInitialLoadDisabled() { return this.initialLoadDisabled; },
    refresh() {},
  };
  const made = { slots: [], rendered: new Set() };
  globalThis.googletag = {
    cmd: { push: (fn) => fn() },
    pubadsReady: false,
    pubads: () => service,
    enableServices() {},
    setConfig(config) { if (config.disableInitialLoad) service.initialLoadDisabled = true; },
    getConfig: () => ({ disableInitialLoad: service.initialLoadDisabled }),
    defineSlot(unit, size, id) {
      const slot = { id, addService() { return this; }, setConfig() {} };
      made.slots.push(slot);
      return slot;
    },
    display() {},
    destroySlots() { return true; },
  };
  made.renderPending = () => {
    for (const slot of made.slots) {
      if (made.rendered.has(slot)) continue;
      made.rendered.add(slot);
      for (const fn of listeners.get('slotRenderEnded') ?? []) fn({ slot, isEmpty: false });
    }
  };
  return made;
}

function makeStage() {
  const { document } = new JSDOM('<div id="stage"></div>').window;
  const stage = document.getElementById('stage');
  Object.defineProperty(stage, 'clientWidth', { value: 960 });
  Object.defineProperty(stage, 'clientHeight', { value: 540 });
  return stage;
}

// Wall time in 60 fps frames: the video advances by its rate, frame callbacks run every frame,
// and timeupdate arrives only every `eventEvery` frames (a busy main thread when large).
async function playFrames(r, { rate, eventEvery, from = 20, to = 60, onFrame }) {
  const frameQueue = [];
  r.video.requestVideoFrameCallback = (fn) => frameQueue.push(fn);
  r.video.cancelVideoFrameCallback = () => {};
  r.video.playbackRate = rate;
  r.video.currentTime = from;
  for (let frame = 0; r.video.currentTime < to; frame++) {
    r.video.currentTime += rate / 60;
    for (const fn of frameQueue.splice(0)) fn();
    if (frame % eventEvery === 0) {
      r.video.dispatchEvent(new Event('timeupdate'));
      await flush();
    }
    onFrame();
  }
}

for (const rate of [1, 1.5, 2]) {
  for (const eventEvery of [15, 60]) {
    test(`at rate ${rate} with events every ${eventEvery} frames neither the overlay nor a cue is ever on screen in an ad`, async () => {
      const gpt = fakeGpt();
      const stage = makeStage();
      const plan = stitchedPlan({ windows: [{ id: 'o', start_ms: 20000, end_ms: 35000 }, { id: 's', start_ms: 51000, end_ms: 59000 }] });
      plan.scenes.formats = ['overlay_300x250', 'super'];
      plan.scenes.overlay = { ad_unit: '/123/site/overlay', size: [300, 250] };
      plan.scenes.pacing.max_seconds = null;
      const r = rig({ plan, stage });
      let overlaySeen = false;
      let cueSeen = false;
      await playFrames(r, { rate, eventEvery, from: 5, to: 80, onFrame() {
        gpt.renderPending();
        const box = stage.querySelector('[data-il-ads-overlay]');
        const overlayOn = box?.style.display === 'block';
        overlaySeen ||= overlayOn;
        cueSeen ||= r.onScreen.size > 0;
        if (truth(r.video.currentTime) == null) {
          assert.equal(overlayOn, false, `overlay over an ad at ${r.video.currentTime}`);
          assert.equal(r.onScreen.size, 0, `cue over an ad at ${r.video.currentTime}`);
        }
      } });
      assert.ok(overlaySeen, 'the overlay showed on content');
      assert.ok(cueSeen, 'the super showed on content');
      r.ads.destroy();
      delete globalThis.googletag;
    });
  }
}

test('a stitched plan with a session on another clock draws nothing and says why', async () => {
  const events = [];
  const r = rig({ sessionClock: () => 0, onEvent: (event) => events.push(event) });
  for (let t = 0; t < 80; t += 1) await r.at(t);
  assert.deepEqual([r.requests, r.calls.length], [[], 0]);
  assert.deepEqual(events, [{ type: 'clock_mismatch' }]);
  r.ads.destroy();
});

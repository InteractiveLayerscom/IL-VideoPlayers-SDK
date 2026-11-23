// The checks every player must pass over the stitched fixture (see stitched-fixture.mjs), from real frames.
import { expect, test } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
// How far the clock may be from the content segment on screen: a frame is sampled at its presentation, the
// clock reads currentTime a moment later.
const SLACK = 0.35;
const RECENT_SEEK_MS = 250;
// How far past a window's edge (in content) the graphic may still be seen: two frames at 25 fps.
const EDGE = 0.09;

// What a sampled frame shows: an ad (red), a content segment (its bands), or nothing to judge (black before the
// first frame, a band not clearly black or white).
export function picture({ r, g, b, bands }) {
  if (r > 150 && g < 90 && b < 90) return { ad: true };
  let code = 0;
  for (const [k, [br, bg, bb]] of bands.entries()) {
    if (Math.max(br, bg, bb) - Math.min(br, bg, bb) > 40) return {};
    if (br > 170) code += 2 ** k;
    else if (br > 70) return {};
  }
  return code >= 1 && code <= 15 ? { segment: code - 1 } : {};
}

export function judge(samples, slack = SLACK) {
  let ad = 0;
  let content = 0;
  const shown = new Set();
  for (const s of samples) {
    const p = picture(s);
    // While seeking and just after, a browser may still hand over the frame from before the seek (WebKit does for
    // a few frames): then only the rule that matters most is checked, no graphic over an ad picture.
    if (s.seeking || s.sinceSeek < RECENT_SEEK_MS) {
      if (p.ad) expect(s.graphic, `graphic over an ad frame at ${s.t}`).toBe(false);
      continue;
    }
    if (p.ad) {
      ad++;
      expect(s.clock, `clock over an ad frame at ${s.t}`).toBeNull();
      expect(s.graphic, `graphic over an ad frame at ${s.t}`).toBe(false);
    } else if (p.segment != null) {
      content++;
      if (s.clock != null) {
        expect(s.clock, `clock at ${s.t} over content segment ${p.segment}`).toBeGreaterThanOrEqual(2 * p.segment - slack);
        expect(s.clock, `clock at ${s.t} over content segment ${p.segment}`).toBeLessThanOrEqual(2 * p.segment + 2 + slack);
      }
      if (s.graphic) {
        // The window is content 10–20 s: segments 5 to 9, give or take EDGE over content (never over an ad).
        const late = p.segment === 10 && s.clock != null && s.clock < 20 + EDGE;
        const early = p.segment === 4 && s.clock != null && s.clock > 10 - EDGE;
        if (!late && !early) {
          expect(p.segment, `graphic at ${s.t} over content segment ${p.segment}`).toBeGreaterThanOrEqual(5);
          expect(p.segment, `graphic at ${s.t} over content segment ${p.segment}`).toBeLessThanOrEqual(9);
        }
        shown.add(p.segment);
      }
    }
    expect(s.images, `one graphic at most at ${s.t}`).toBeLessThanOrEqual(1);
  }
  return { ad, content, shown };
}

async function open(page, player, query = '') {
  await page.route('https://creative.test/**', (route) => route.fulfill({ contentType: 'image/png', body: png }));
  await page.goto('/test/browser/stitched.html?player=' + player + query);
  await page.waitForFunction(() => window.harnessReady === true);
  await page.waitForFunction(() => window.harness.ready());
}

async function playUntil(page, t) {
  await page.evaluate(() => window.harness.play());
  await page.waitForFunction((end) => window.harness.time() >= end || window.harness.ended(), t, { timeout: 90000 });
}

// VAST requests to the graphic's tag, and impressions measured.
const counts = (page) => page.evaluate(() => ({
  requests: window.harness.requests.filter(({ url }) => url.startsWith('https://pubads.g.doubleclick.net/')).length,
  impressions: window.harness.requests.filter(({ url }) => url === 'https://creative.test/i').length,
}));

export function stitchedChecks(player) {
  test(`${player}: played through, never a graphic over an ad, content time from the frames, one request`, async ({ page }) => {
    await open(page, player);
    await playUntil(page, 37.6);
    const samples = await page.evaluate(() => window.harness.samples);
    const result = judge(samples);
    expect(result.ad, 'ad frames sampled').toBeGreaterThan(120);
    expect(result.content, 'content frames sampled').toBeGreaterThan(600);
    // Shown on both sides of the mid-roll (content 14 s: segment 7 starts after it).
    expect([...result.shown].some((segment) => segment < 7)).toBe(true);
    expect([...result.shown].some((segment) => segment >= 7)).toBe(true);
    expect(await counts(page)).toEqual({ requests: 1, impressions: 1 });
  });

  test(`${player}: loaded in the middle of an ad, then pause, seeks and a replay never misplace or repeat it`, async ({ page }) => {
    await open(page, player);
    // The page starts in the mid-roll (stream 19 s) before anything was drawn.
    await page.evaluate(() => window.harness.seek(19));
    await playUntil(page, 25);
    await page.evaluate(() => window.harness.pause());
    await page.waitForTimeout(800);
    await page.evaluate(() => window.harness.sample());
    const paused = await page.evaluate(() => window.harness.samples.at(-1));
    // Paused on content 17 s, inside the window: the clock holds its place (the session hides graphics in pause).
    expect(Math.abs(paused.clock - (paused.t - 8))).toBeLessThan(SLACK);
    // Played again, the same graphic comes back, inside its window.
    await playUntil(page, 26.5);
    await page.waitForFunction(() => {
      const last = window.harness.samples.at(-1);
      return last.t >= 26.5 && !last.paused;
    });
    // The last frame sampled as presented (a frame drawn by hand right after resuming can be blank in WebKit).
    const resumed = await page.evaluate(() => window.harness.samples.at(-1));
    expect(resumed.graphic).toBe(true);
    expect(picture(resumed).segment).toBe(9);
    // Seek into the pre-roll and back into content past the window, then replay from the start.
    await page.evaluate(() => window.harness.seek(1));
    await playUntil(page, 6);
    await page.evaluate(() => window.harness.seek(30));
    await playUntil(page, 33);
    await page.evaluate(() => window.harness.seek(0));
    await playUntil(page, 28.5);
    const result = judge(await page.evaluate(() => window.harness.samples));
    expect(result.ad).toBeGreaterThan(60);
    expect(result.shown.size).toBeGreaterThan(0);
    // One request and one impression for the one window, however often its content plays.
    expect(await counts(page)).toEqual({ requests: 1, impressions: 1 });
  });
}

// Two renditions whose ads differ in length (4.0 s and 4.2 s each), with a switch in the middle of the mid-roll;
// then a stream whose audio is a separate rendition, stitched too.
// `failsClosed`: Safari's clock, which cannot know the rendition on screen, answers nowhere the renditions disagree
// (here everywhere: the pre-roll already differs), so it must show nothing at all rather than misplace it.
export function renditionChecks(player, { failsClosed = false } = {}) {
  test(`${player}: renditions with different ad lengths and a switch mid-ad never put a graphic on an ad`, async ({ page }) => {
    await open(page, player, '&stream=multi');
    await playUntil(page, 19);
    await page.evaluate(() => window.harness.switchRendition());
    await playUntil(page, 37.8);
    // Where the player splices one rendition into the other, a frame can come from the segment replacing the one
    // the clock reads: content time may then be off by the renditions' ad-length difference (0.4 s here), never
    // more, and never over an ad.
    const result = judge(await page.evaluate(() => window.harness.samples), SLACK + 0.4);
    expect(result.ad).toBeGreaterThan(120);
    if (failsClosed) expect(result.shown.size).toBe(0);
    else expect(result.shown.size).toBeGreaterThan(0);
    // Failing closed, the window never opens: nothing is asked.
    expect(await counts(page)).toEqual(failsClosed ? { requests: 0, impressions: 0 } : { requests: 1, impressions: 1 });
  });

  test(`${player}: a separate audio rendition is never taken for the video's timeline`, async ({ page }) => {
    await open(page, player, '&stream=audio');
    await playUntil(page, 37.6);
    const result = judge(await page.evaluate(() => window.harness.samples));
    expect(result.ad).toBeGreaterThan(120);
    expect([...result.shown].some((segment) => segment < 7)).toBe(true);
    expect([...result.shown].some((segment) => segment >= 7)).toBe(true);
    expect(await counts(page)).toEqual({ requests: 1, impressions: 1 });
    expect(await page.evaluate(() => window.harness.events.filter((event) => event.type !== 'error' || event.fatal !== false)))
      .toEqual([]);
  });
}

// The player alone, without the IL SDK, over the PDT playlists IL serves: it must play them as any stitched stream,
// with no stall and with sound and picture together after each ad.
export function plainChecks(player, stream) {
  test(`${player} without the IL SDK plays the ${stream} PDT playlists with no stall or drift`, async ({ page }) => {
    await page.goto(`/test/browser/stitched.html?player=${player}&plain=1&stream=${stream}`);
    await page.waitForFunction(() => window.harnessReady === true && window.harness.ready());
    await page.evaluate(() => window.resumeAudio());
    await playUntil(page, 37.5);
    const samples = await page.evaluate(() => window.harness.samples);
    // No fatal error. hls.js reports a non-fatal `bufferSeekOverHole` when it steps over the few milliseconds of
    // audio padding at a discontinuity; stalls are what `waiting` and the wall-time check below catch.
    expect(await page.evaluate(() => window.harness.events.filter((event) => event.fatal !== false))).toEqual([]);
    expect(await page.evaluate(() => window.harness.waiting())).toBe(0);
    // Real time: from the first content frame to the end, no more than a second of extra wall time.
    const first = samples.find((s) => s.t >= 4.5);
    const last = samples.at(-1);
    expect((last.wall - first.wall) / 1000).toBeLessThan(last.t - first.t + 1);
    // Sound follows picture, away from the 0.3 s around each boundary (4, 18, 22 s and the longer rendition's).
    const edges = stream === 'multi' ? [4, 4.2, 18, 18.2, 22, 22.4] : [4, 18, 22];
    let heard = 0;
    for (const s of samples) {
      if (s.t < 0.5 || edges.some((edge) => Math.abs(s.t - edge) < 0.3) || !s.tone) continue;
      const p = picture(s);
      if (!p.ad && p.segment == null) continue;
      heard++;
      expect(s.tone, `sound at ${s.t}`).toBe(p.ad ? 'ad' : 'content');
    }
    expect(heard).toBeGreaterThan(400);
  });
}

// The same checks over single-file MPEG-TS (#EXT-X-BYTERANGE) and fragmented MP4 (#EXT-X-MAP) playlists.
export function containerChecks(player) {
  for (const stream of ['ranges', 'fmp4']) {
    test(`${player}: ${stream} playlists, never a graphic over an ad, content time from the frames, one request`, async ({ page }) => {
      await open(page, player, '&stream=' + stream);
      await playUntil(page, 37.6);
      const result = judge(await page.evaluate(() => window.harness.samples));
      expect(result.ad).toBeGreaterThan(120);
      expect([...result.shown].some((segment) => segment < 7)).toBe(true);
      expect([...result.shown].some((segment) => segment >= 7)).toBe(true);
      expect(await counts(page)).toEqual({ requests: 1, impressions: 1 });
    });
  }
}

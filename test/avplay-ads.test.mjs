import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachAvPlayAds, fetchLinearAd } from '../web/avplay-ads.mjs';

const { DOMParser } = new JSDOM('').window;
const GAM = 'https://pubads.g.doubleclick.net/gampad/ads?iu=/1/a';
const IAD = 'https://ads.iadserver.com/gampad/ads?tag=t';
const linear = (shop = '') => `<VAST version="4.0"><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><Linear>
  <Duration>00:00:20</Duration><TrackingEvents><Tracking event="start">https://t.example/s</Tracking><Tracking event="midpoint">https://t.example/m</Tracking><Tracking event="complete">https://t.example/c</Tracking></TrackingEvents>
  <MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="3840">https://c.example/4k.mp4</MediaFile><MediaFile delivery="progressive" type="video/mp4" width="1280">https://c.example/ad.mp4</MediaFile></MediaFiles>
  </Linear></Creative></Creatives>${shop}</InLine></Ad></VAST>`;
const EMPTY = '<VAST version="4.0"></VAST>';
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };

function device() {
  const calls = [];
  const player = {
    state: 'IDLE', time: 0, listener: null, url: null, calls,
    getState: () => player.state,
    getCurrentTime: () => player.time,
    open(url) { player.url = url; player.state = 'IDLE'; calls.push(`open ${url}`); },
    close() { player.state = 'NONE'; calls.push('close'); },
    setListener(value) { player.listener = value; },
    setDisplayRect(...rect) { calls.push(`rect ${rect.join(',')}`); },
    prepareAsync(ok) { player.state = 'READY'; ok(); },
    play() { player.state = 'PLAYING'; calls.push('play'); },
    pause() { player.state = 'PAUSED'; calls.push('pause'); },
    seekTo(ms, ok) { player.time = ms; calls.push(`seek ${ms}`); ok(); },
  };
  return player;
}

function rig(answers, cuts, options = {}, planExtra = {}) {
  const avplay = device();
  const fetched = [];
  const linearStates = [];
  const session = { addCue: () => true, removeCue: () => true, setLinearAd: (on, identity) => linearStates.push([on, identity]) };
  const fetchImpl = async (url) => {
    fetched.push(String(url));
    const key = Object.keys(answers).find((tag) => new URL(tag).origin === new URL(url).origin);
    return key ? { ok: true, status: 200, text: async () => answers[key] } : { ok: true, status: 200, text: async () => '' };
  };
  const events = [];
  const plan = { version: 1, expires_at: new Date(Date.now() + 60000).toISOString(), cuts, ...planExtra };
  const hostListener = { onstreamcompleted() {} };
  const sdk = attachAvPlayAds({ avplay, session, plan, contentUrl: 'https://v.example/c.m3u8', listener: hostListener,
    getDisplayRect: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), fetchImpl, onEvent: (e) => events.push(e),
    Parser: DOMParser, tickMs: 100000, ...options });
  return { avplay, fetched, linearStates, sdk, events, hostListener };
}
const types = (events) => events.map((event) => event.type);

test('a pre-roll falls through to the next request and leaves content to the host', async (t) => {
  const r = rig({ [IAD]: EMPTY, [GAM]: linear() }, [{ id: 'pre', at: 0, requests: [{ provider: 'iadserver', tag_url: IAD }, { provider: 'gam', tag_url: GAM }] }]);
  t.after(() => r.sdk.destroy());
  const done = r.sdk.start();
  await flush();
  assert.equal(r.avplay.url, 'https://c.example/ad.mp4');
  assert.ok(r.fetched[0].startsWith(IAD) && r.fetched[0].includes('correlator='));
  r.avplay.listener.oncurrentplaytime(10000);
  r.avplay.listener.onstreamcompleted();
  await done;
  assert.deepEqual(types(r.events), ['break_start', 'break_request', 'break_no_fill', 'break_request', 'break_end']);
  assert.equal(r.fetched.filter((url) => url === 'https://t.example/i').length, 1);
  for (const pixel of ['s', 'm', 'c']) assert.ok(r.fetched.includes(`https://t.example/${pixel}`));
  assert.ok(!r.avplay.calls.includes('open https://v.example/c.m3u8'));
  assert.deepEqual(r.linearStates.at(-1), [false, undefined]);
});

test('a mid-roll reopens content where it stopped', async (t) => {
  const r = rig({ [GAM]: linear() }, [{ id: 'mid', at: 30, requests: [{ provider: 'gam', tag_url: GAM }] }]);
  t.after(() => r.sdk.destroy());
  r.avplay.state = 'PLAYING';
  r.avplay.time = 5000;
  await r.sdk.start();
  r.sdk.tick();
  assert.deepEqual(r.events, []);
  r.avplay.time = 30400;
  r.sdk.tick();
  await flush();
  assert.equal(r.avplay.url, 'https://c.example/ad.mp4');
  r.avplay.listener.onstreamcompleted();
  await flush();
  assert.equal(r.avplay.url, 'https://v.example/c.m3u8');
  assert.equal(r.avplay.listener, r.hostListener);
  assert.deepEqual(r.avplay.calls.slice(-2), ['seek 30400', 'play']);
  r.sdk.tick();
  assert.equal(types(r.events).filter((type) => type === 'break_start').length, 1);
});

test('no fill keeps the content loaded and resumes it', async (t) => {
  const r = rig({ [GAM]: EMPTY }, [{ id: 'mid', at: 30, requests: [{ provider: 'gam', tag_url: GAM }] }]);
  t.after(() => r.sdk.destroy());
  r.avplay.state = 'PLAYING';
  r.avplay.time = 1500;
  await r.sdk.start();
  r.avplay.time = 30100;
  r.sdk.tick();
  await flush();
  assert.equal(types(r.events).at(-1), 'break_error');
  assert.ok(!r.avplay.calls.includes('close'));
  assert.equal(r.avplay.state, 'PLAYING');
});

test('a seek past breaks plays no backlog', async (t) => {
  const r = rig({ [GAM]: linear() }, [{ id: 'a', at: 30, tag_url: GAM }, { id: 'b', at: 60, tag_url: GAM }]);
  t.after(() => r.sdk.destroy());
  r.avplay.state = 'PLAYING';
  r.avplay.time = 2000;
  await r.sdk.start();
  r.avplay.time = 90000;
  r.sdk.tick();
  await flush();
  assert.deepEqual(r.events, []);
});

test('the spot identity reaches the session for Buy during the break', async (t) => {
  const shop = '<Extensions><Extension type="iADServerShop"><Shop deliveryId="d1" creativeId="c1"/></Extension></Extensions>';
  const commerce = { kind: 'scene_product', url: 'https://il.example/p', lead_ms: 1000, session: 's1', pacing: { min_seconds: 5 }, windows: [] };
  const r = rig({ [GAM]: linear(shop) }, [{ id: 'pre', at: 0, tag_url: GAM }], { planOrigin: 'https://il.example' }, { commerce });
  t.after(() => r.sdk.destroy());
  const done = r.sdk.start();
  await flush();
  assert.deepEqual(r.linearStates.at(-1), [true, undefined], 'nothing before the first frame');
  assert.ok(!r.fetched.includes('https://t.example/i'), 'no impression before the first frame');
  r.avplay.listener.oncurrentplaytime(0);
  assert.deepEqual(r.linearStates.at(-1), [true, { creativeId: 'c1', deliveryId: 'd1' }]);
  assert.equal(r.fetched.filter((url) => url === 'https://t.example/i').length, 1);
  r.avplay.listener.onstreamcompleted();
  await done;
});

test('no Buy during a break when the host sid is not the plan session', async (t) => {
  const shop = '<Extensions><Extension type="iADServerShop"><Shop deliveryId="d1" creativeId="c1"/></Extension></Extensions>';
  const commerce = { kind: 'scene_product', url: 'https://il.example/p', lead_ms: 1000, session: 'plan-s', pacing: { min_seconds: 5 }, windows: [] };
  const r = rig({ [GAM]: linear(shop) }, [{ id: 'pre', at: 0, tag_url: GAM }], { planOrigin: 'https://il.example', sessionId: 'host-s' }, { commerce });
  t.after(() => r.sdk.destroy());
  const done = r.sdk.start();
  await flush();
  r.avplay.listener.oncurrentplaytime(0);
  assert.deepEqual(r.linearStates.at(-1), [true, undefined]);
  r.avplay.listener.onstreamcompleted();
  await done;
});

test('destroy during an ad closes AVPlay instead of leaving the ad playing', async () => {
  const r = rig({ [GAM]: linear() }, [{ id: 'pre', at: 0, tag_url: GAM }]);
  const done = r.sdk.start();
  await flush();
  r.avplay.listener.oncurrentplaytime(0);
  r.sdk.destroy();
  await done;
  assert.equal(r.avplay.calls.at(-1), 'close');
  assert.deepEqual(r.linearStates.at(-1), [false, undefined]);
});

test('the host reopens its own content after a mid-roll', async (t) => {
  const reopened = [];
  const r = rig({ [GAM]: linear() }, [{ id: 'mid', at: 30, tag_url: GAM }], { reopenContent: async (ms) => { reopened.push(ms); } });
  t.after(() => r.sdk.destroy());
  r.avplay.state = 'PLAYING';
  r.avplay.time = 1000;
  await r.sdk.start();
  r.avplay.time = 30400;
  r.sdk.tick();
  await flush();
  r.avplay.listener.oncurrentplaytime(0);
  r.avplay.listener.onstreamcompleted();
  await flush();
  assert.deepEqual(reopened, [30400]);
  assert.ok(!r.avplay.calls.includes('open https://v.example/c.m3u8'));
});

test('a host reopen that never settles is reported as resume_blocked', async (t) => {
  const r = rig({ [GAM]: linear() }, [{ id: 'mid', at: 30, tag_url: GAM }], { reopenContent: () => new Promise(() => {}) });
  t.after(() => r.sdk.destroy());
  r.avplay.state = 'PLAYING';
  r.avplay.time = 1000;
  await r.sdk.start();
  const timers = t.mock.timers;
  timers.enable({ apis: ['setTimeout', 'setInterval'] });
  r.avplay.time = 30400;
  r.sdk.tick();
  await flush();
  r.avplay.listener.oncurrentplaytime(0);
  r.avplay.listener.onstreamcompleted();
  await flush();
  timers.tick(15000);
  await flush();
  timers.reset();
  assert.deepEqual(types(r.events).slice(-2), ['break_end', 'resume_blocked']);
});

test('a VAST declaring an hour holds the content at most 180 s', async (t) => {
  const hour = linear().replace('00:00:20', '01:00:00');
  const r = rig({ [GAM]: hour }, [{ id: 'pre', at: 0, tag_url: GAM }], { isVisible: () => true });
  t.after(() => r.sdk.destroy());
  const timers = t.mock.timers;
  timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const done = r.sdk.start();
  await flush();
  r.avplay.listener.oncurrentplaytime(0);
  timers.tick(179500);
  await flush();
  assert.equal(r.events.filter((e) => e.type === 'break_error').length, 0);
  timers.tick(1000);
  await flush();
  timers.reset();
  await done;
  assert.equal(types(r.events).at(-1), 'break_error');
});

test('an ad that never prepares does not hold the break', async (t) => {
  const r = rig({ [GAM]: linear() }, [{ id: 'pre', at: 0, tag_url: GAM }]);
  t.after(() => r.sdk.destroy());
  r.avplay.prepareAsync = () => {};
  const timers = t.mock.timers;
  timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const done = r.sdk.start();
  await flush();
  timers.tick(8000);
  await flush();
  timers.reset();
  await done;
  assert.equal(types(r.events).at(-1), 'break_error');
});

test('an ad dragged to its end is not complete and the host consent reaches the request', async (t) => {
  const consent = { gdpr: 1, gdpr_consent: 'CPtc', us_privacy: '1YNN', gpp: 'DBABMA~x', gpp_sid: '2,7' };
  const r = rig({ [GAM]: linear() }, [{ id: 'pre', at: 0, tag_url: GAM }], { consent });
  t.after(() => r.sdk.destroy());
  const done = r.sdk.start();
  await flush();
  const asked = new URL(r.fetched[0]);
  for (const [key, value] of Object.entries(consent)) assert.equal(asked.searchParams.get(key), String(value));
  r.avplay.listener.oncurrentplaytime(0);
  r.avplay.listener.oncurrentplaytime(19500);
  r.avplay.listener.onstreamcompleted();
  await done;
  assert.ok(!r.fetched.includes('https://t.example/c'));
  assert.ok(!r.fetched.includes('https://t.example/m'));
  assert.equal(types(r.events).at(-1), 'break_error');
});

test('the ad watchdog counts visible time and follows the ad length', async (t) => {
  let visible = false;
  const r = rig({ [GAM]: linear() }, [{ id: 'pre', at: 0, tag_url: GAM }], { isVisible: () => visible });
  t.after(() => r.sdk.destroy());
  const timers = t.mock.timers;
  timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const done = r.sdk.start();
  await flush();
  r.avplay.listener.oncurrentplaytime(0);
  timers.tick(300000);
  await flush();
  assert.equal(r.events.filter((e) => e.type === 'break_error').length, 0, 'five hidden minutes do not end the ad');
  visible = true;
  timers.tick(49500);
  await flush();
  assert.equal(r.events.filter((e) => e.type === 'break_error').length, 0, 'a 20 s ad has 50 s');
  timers.tick(1000);
  await flush();
  timers.reset();
  await done;
  assert.equal(types(r.events).at(-1), 'break_error');
});

test('a wrapper is followed and non-HTTPS media is refused', async () => {
  const wrapper = '<VAST version="4.0"><Ad><Wrapper><Impression>https://t.example/w</Impression><VASTAdTagURI><![CDATA[https://next.example/v]]></VASTAdTagURI></Wrapper></Ad></VAST>';
  const replies = { 'https://first.example/v': wrapper, 'https://next.example/v': linear() };
  const fetchImpl = async (url) => ({ ok: true, text: async () => replies[url] });
  const ad = await fetchLinearAd('https://first.example/v', { fetchImpl, Parser: DOMParser });
  assert.deepEqual(ad.impressions, ['https://t.example/w', 'https://t.example/i']);
  const plain = linear().replaceAll('https://c.example', 'http://c.example');
  assert.equal(await fetchLinearAd('https://x.example/', { fetchImpl: async () => ({ ok: true, text: async () => plain }), Parser: DOMParser }), null);
});

function planRig(extra, reply) {
  globalThis.DOMParser = DOMParser;
  const avplay = device();
  avplay.state = 'PLAYING';
  const cues = [];
  const removed = [];
  const fetched = [];
  const session = {
    commerce: { locale: 'es' },
    addCue: (item, hooks) => { cues.push({ item, hooks }); return true; },
    removeCue: (id) => { removed.push(id); return true; },
    setLinearAd() {},
  };
  const fetchImpl = async (url) => { fetched.push(String(url)); return reply(String(url)); };
  const events = [];
  const plan = { version: 1, expires_at: new Date(Date.now() + 60000).toISOString(), ...extra };
  const sdk = attachAvPlayAds({ avplay, session, plan, contentUrl: 'https://v.example/c.m3u8', planOrigin: 'https://il.example',
    getDisplayRect: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), fetchImpl, onEvent: (e) => events.push(e),
    Parser: DOMParser, tickMs: 100000 });
  return { avplay, cues, removed, fetched, events, sdk };
}
const window10 = { id: 'w1', start_ms: 10000, end_ms: 25000 };
const superVast = `<VAST version="4.0"><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><NonLinearAds>
  <NonLinear width="600" height="90"><StaticResource creativeType="image/png">https://c.example/s.png</StaticResource></NonLinear>
  </NonLinearAds></Creative></Creatives></InLine></Ad></VAST>`;
const scenes = { formats: ['super'], graphics: [{ format: 'super', tag_url: GAM }], pacing: { min_seconds: 5 }, windows: [window10] };

test('a plan graphic is drawn once on AVPlay and counted once', async (t) => {
  const r = planRig({ scenes }, () => ({ ok: true, status: 200, text: async () => superVast }));
  t.after(() => r.sdk.destroy());
  await r.sdk.start();
  r.avplay.time = 7000;
  r.sdk.tick();
  await flush();
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].item.format, 'super');
  r.cues[0].hooks.onVisible();
  r.cues[0].hooks.onVisible();
  assert.equal(r.fetched.filter((url) => url === 'https://t.example/i').length, 1);
  r.avplay.time = 26000;
  r.sdk.tick();
  assert.deepEqual(r.removed, ['il-ads-w1']);
});

test('a scene product wins its window on AVPlay and carries Buy', async (t) => {
  const card = { id: 'card-1', window: 'w1', format: 'overlay', start: 0, end: 99000, imageUrl: 'https://c.example/p.jpg',
    commerce: { title: 'Botines', price: '50', currency: 'USD', locale: 'es', handoffUrl: 'https://il.example/h', variants: [{ id: '42', label: '42' }] } };
  const r = planRig({ scenes, commerce: { kind: 'scene_product', url: 'https://il.example/p?g=1', lead_ms: 1000, pacing: { min_seconds: 5 }, windows: [window10] } },
    (url) => url.startsWith('https://il.example/') ? { ok: true, status: 200, json: async () => card } : { ok: true, status: 200, text: async () => superVast });
  t.after(() => r.sdk.destroy());
  await r.sdk.start();
  r.avplay.time = 9500;
  r.sdk.tick();
  await flush();
  assert.ok(r.fetched[0].startsWith('https://il.example/p?g=1&window=w1&locale='));
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].item.id, 'card-1');
  assert.ok(r.cues[0].item.commerce);
  assert.ok(!r.fetched.some((url) => url.includes('doubleclick')));
});

test('AVPlay refuses native GAM v2 plans until its own scheduler supports expiry', async (t) => {
  const r = planRig({ version: 2, native_gam: { contract: 'native-gam-plan-v1' },
    cuts: [{ id: 'mid', at: 60, tag_url: GAM, position: 'midroll' }] }, () => ({ ok: true, text: async () => linear() }));
  t.after(() => r.sdk.destroy());
  await r.sdk.start();
  r.avplay.time=60000;
  r.sdk.tick();
  await flush();
  assert.equal(r.fetched.length, 0);
});

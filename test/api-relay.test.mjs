import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../examples/api-relay.mjs';

const FIXTURES = new URL('./fixtures/native/', import.meta.url).pathname;

async function listen(options) {
  const lines = [];
  const server = createRelay({ log: (line) => lines.push(line), ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, headers: res.headers, body: json, text };
  };
  return { server, base, call, lines, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('fixtures mode answers the playback, both breaks and the app routes, and logs every request line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-static-'));
  await writeFile(join(dir, 'clip.mp4'), 'not really a video');
  const r = await listen({ fixtures: FIXTURES, staticDir: dir, publicOrigin: 'https://relay.test' });
  try {
    const playback = await r.call('POST', '/playback', { asset_id: 'asset-40edc822d6f24974a9af51695a88184b' });
    assert.equal(playback.status, 200);
    assert.equal(playback.body.playback_id, 'playback-46071ee5ad2d4b9f997a7407937c2ca7');
    assert.deepEqual(playback.body.plan.cuts, []);
    assert.ok(playback.body.plan.commerce.url.startsWith('https://relay.test/il-player/scene-product?'));
    assert.equal(playback.headers.get('access-control-allow-origin'), '*');

    const stable = await r.call('POST', '/break', { playback_id: playback.body.playback_id, cue_seconds: 58 });
    assert.equal(stable.body.provider, 'iadserver');
    assert.equal(new URL(stable.body.ad_tag_url).searchParams.get('tag'), 'T_mid');
    assert.equal(stable.body.opportunity_id, 'opp-fixture-58000');
    const gam = await r.call('POST', '/break', { playback_id: playback.body.playback_id, cue_seconds: 178 });
    assert.equal(gam.body.provider, 'gam');
    const next = await r.call('POST', '/break/next', { playback_id: playback.body.playback_id, opportunity_id: stable.body.opportunity_id, after_step: 0 });
    assert.equal(next.status, 204);
    assert.equal((await r.call('POST', '/event', { playback_id: playback.body.playback_id, type: 'impression' })).status, 200);

    const v1 = await r.call('GET', '/il-player/app-plan?project=p&asset=a&app=tizen:AbCdEfGhIj.Demo');
    assert.equal(v1.body.version, 1);
    assert.equal((await r.call('GET', '/il-player/app-plan?project=p&asset=a&app=tizen:AbCdEfGhIj.Demo&v=2')).body.version, 2);
    const renewed = await r.call('GET', '/il-player/app-plan?project=p&asset=a&app=tizen:AbCdEfGhIj.Demo&renew=g');
    assert.equal(renewed.body.commerce.session, '178311e8ffa4791646c0d0f6c728aa73');
    assert.equal((await r.call('GET', '/il-player/scene-product?x=1&window=p1&locale=es')).body.id, 'dlv_fixture_0001');
    assert.equal((await r.call('GET', '/il-player/break-product?x=1&cut=at-58000')).body.format, 'midroll');
    const clip = await r.call('GET', '/clip.mp4');
    assert.equal(clip.text, 'not really a video');
    assert.equal(clip.headers.get('content-type'), 'video/mp4');
    assert.equal((await r.call('GET', '/../package.json')).status, 404);

    assert.ok(r.lines.some((line) => line.endsWith('POST /break')));
    assert.ok(r.lines.some((line) => line.endsWith('GET /il-player/app-plan?project=p&asset=a&app=tizen:AbCdEfGhIj.Demo&renew=g')));
  } finally {
    await r.close();
  }
});

test('--v2 serves the version 2 plan by default', async () => {
  const r = await listen({ fixtures: FIXTURES, v2: true });
  try {
    const plan = await r.call('GET', '/il-player/app-plan?project=p&asset=a&app=tizen:AbCdEfGhIj.Demo');
    assert.equal(plan.body.version, 2);
    // Without --public-origin the fixture origin becomes the relay's own.
    assert.ok(plan.body.commerce.url.startsWith(`${r.base}/il-player/scene-product?`));
  } finally {
    await r.close();
  }
});

test('bad bodies get 400 and unknown routes 404', async () => {
  const r = await listen({ fixtures: FIXTURES });
  try {
    assert.equal((await r.call('POST', '/playback', {})).status, 400);
    assert.equal((await r.call('POST', '/break', { playback_id: 'p', cue_seconds: -1 })).status, 400);
    assert.equal((await r.call('POST', '/break/next', { playback_id: 'p', opportunity_id: 'o', after_step: 'x' })).status, 400);
    assert.equal((await fetch(r.base + '/playback', { method: 'POST', body: '[' })).status, 400);
    assert.equal((await r.call('GET', '/nope')).status, 404);
    assert.equal((await fetch(r.base + '/break', { method: 'OPTIONS' })).status, 204);
  } finally {
    await r.close();
  }
});

test('live mode calls IL with the key, creates the playback with graphics and never leaks the key', async () => {
  const calls = [];
  const reply = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, key: init.headers['X-API-Key'], body: init.body ? JSON.parse(init.body) : undefined });
    if (u.pathname === '/v1/vod/playbacks') return reply(201, { playback_id: 'pb1', graphics: true });
    if (u.pathname === '/v1/vod/playbacks/pb1/plan') return reply(204);
    if (u.pathname === '/v1/vod/playbacks/pb1/opportunities') return reply(201, { opportunity_id: 'op1' });
    if (u.pathname === '/v1/vod/playbacks/pb1/opportunities/op1/request') return reply(200, { ad_tag_url: 'https://ads.iadserver.com/gampad/ads?tag=T', step: 0, steps_left: 1 });
    if (u.pathname === '/v1/vod/playbacks/pb1/opportunities/op1/next') return reply(200, { ad_tag_url: 'https://pubads.g.doubleclick.net/gampad/ads?iu=x', step: 1 });
    if (u.pathname === '/v1/vod/playbacks/pb1/events') return reply(202, { accepted: true });
    if (u.pathname === '/v1/vod/playbacks/bad/plan') return reply(500, { detail: 'boom' });
    return reply(404, { detail: 'no' });
  };
  const r = await listen({ base: 'https://console.test', apiKey: 'secret-key', fetchImpl });
  try {
    const playback = await r.call('POST', '/playback', { asset_id: 'asset-1', channel_id: 'ch-1' });
    assert.deepEqual(playback.body, { playback_id: 'pb1', plan: null });
    const brk = await r.call('POST', '/break', { playback_id: 'pb1', cue_seconds: 58 });
    assert.equal(brk.body.opportunity_id, 'op1');
    assert.equal(brk.body.step, 0);
    const next = await r.call('POST', '/break/next', { playback_id: 'pb1', opportunity_id: 'op1', after_step: 0 });
    assert.equal(next.body.step, 1);
    assert.equal((await r.call('POST', '/event', { playback_id: 'pb1', type: 'ad_started', cue_seconds: 58 })).status, 200);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
      'POST /v1/vod/playbacks', 'GET /v1/vod/playbacks/pb1/plan', 'POST /v1/vod/playbacks/pb1/opportunities',
      'POST /v1/vod/playbacks/pb1/opportunities/op1/request', 'POST /v1/vod/playbacks/pb1/opportunities/op1/next',
      'POST /v1/vod/playbacks/pb1/events']);
    assert.ok(calls.every((c) => c.key === 'secret-key'));
    assert.deepEqual(calls[0].body, { asset_id: 'asset-1', graphics: true, channel_id: 'ch-1' });
    assert.deepEqual(calls[2].body, { cue_seconds: 58 });
    assert.deepEqual(calls[4].body, { after_step: 0 });
    assert.deepEqual(calls[5].body, { type: 'ad_started', cue_seconds: 58 });
    assert.ok(!JSON.stringify([playback, brk, next]).includes('secret-key'));
    assert.ok(!r.lines.join('\n').includes('secret-key'));
    // The fixtures-only routes do not exist against a real backend.
    assert.equal((await r.call('GET', '/il-player/app-plan?project=p')).status, 404);
  } finally {
    await r.close();
  }
});

test('an upstream error comes back with its status, an unreachable backend as 502', async () => {
  const r = await listen({ base: 'https://console.test', apiKey: 'k', fetchImpl: async () => new Response('{"detail":"x"}', { status: 401 }) });
  const down = await listen({ base: 'https://console.test', apiKey: 'k', fetchImpl: async () => { throw new TypeError('down'); } });
  try {
    assert.equal((await r.call('POST', '/playback', { asset_id: 'a' })).status, 401);
    assert.equal((await down.call('POST', '/playback', { asset_id: 'a' })).status, 502);
  } finally {
    await r.close();
    await down.close();
  }
});

test('the relay refuses to start without a backend or fixtures', () => {
  assert.throws(() => createRelay({}), /IL_API_BASE/);
});

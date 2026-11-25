#!/usr/bin/env node
// Example relay: plays the CUSTOMER'S BACKEND for an app that uses IL's per-break API. The API key lives only here,
// in the environment; the app never sees it. Dependency-free, Node >= 20. For local demos and tests, not production.
//
// Usage
//   IL_API_BASE=https://console.example IL_API_KEY=... PORT=8787 node examples/api-relay.mjs
//   node examples/api-relay.mjs --fixtures test/fixtures/native [--static <dir>] [--v2] [--public-origin <origin>]
//
// Endpoints (JSON in and out, permissive CORS for local demos)
//   POST /playback   { "asset_id", "channel_id"? }  -> POST /v1/vod/playbacks (graphics: true), then
//                    GET /v1/vod/playbacks/{id}/plan -> { "playback_id", "plan": <object, or null on 204> }
//   POST /break      { "playback_id", "cue_seconds" } -> POST .../opportunities, then .../opportunities/{oid}/request
//                    -> the per-break answer plus "opportunity_id"
//   POST /break/next { "playback_id", "opportunity_id", "after_step" } -> POST .../opportunities/{oid}/next
//   POST /event      { "playback_id", ...event } -> POST .../events (passthrough of the rest of the body)
// Fixtures mode only
//   GET /il-player/app-plan?...   app-plan-v1.json (app-plan-v2.json with ?v=2 or --v2; renew=... -> app-plan-renewed.json)
//   GET /il-player/scene-product  scene-product-card.json      GET /il-player/break-product  break-product-card.json
//   GET /<file>                   static files from --static <dir> (a test video)
//   Every request line is logged to stdout: it is the evidence the example apps use.
//   The fixtures name IL's test console `http://localhost:8000`; the relay rewrites that origin in every answer to
//   --public-origin <origin> (default: http://<Host of the request>), so product requests come back to the relay. The
//   SDKs only take HTTPS plan and product URLs: put the relay behind a locally trusted HTTPS origin, or Buy stays off.
// Upstream errors come back as { "error", "status" } with the upstream status (502 when the backend is unreachable).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = { '.json': 'application/json', '.mp4': 'video/mp4', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.vtt': 'text/vtt' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type' };
const MAX_BODY = 65536;

function send(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'Cache-Control': 'no-store', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers });
  res.end(text);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // falls through to the 400 below
  }
  throw Object.assign(new Error('body must be a JSON object'), { status: 400 });
}

const id = (value, name) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) {
    throw Object.assign(new Error(`${name} must be an id`), { status: 400 });
  }
  return encodeURIComponent(value);
};
const seconds = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw Object.assign(new Error('cue_seconds must be a number >= 0'), { status: 400 });
  }
  return value;
};

// The real backend: IL's public API with X-API-Key.
function liveBackend({ base, apiKey, fetchImpl = globalThis.fetch }) {
  const root = new URL(base);
  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(new URL(path, root), {
        method,
        headers: { 'X-API-Key': apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
      });
    } catch {
      throw Object.assign(new Error('backend unreachable'), { status: 502 });
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(`backend answered ${response.status}`), { status: response.status });
    return text ? JSON.parse(text) : null;
  }
  return {
    async playback({ asset_id, channel_id }) {
      const body = { asset_id, graphics: true, ...(channel_id ? { channel_id } : {}) };
      const created = await call('POST', '/v1/vod/playbacks', body);
      const playbackId = created?.playback_id;
      const plan = await call('GET', `/v1/vod/playbacks/${id(playbackId, 'playback_id')}/plan`);
      return { playback_id: playbackId, plan };
    },
    async break({ playback_id, cue_seconds }) {
      const pid = id(playback_id, 'playback_id');
      const opportunity = await call('POST', `/v1/vod/playbacks/${pid}/opportunities`, { cue_seconds });
      const oid = id(opportunity?.opportunity_id, 'opportunity_id');
      const answer = await call('POST', `/v1/vod/playbacks/${pid}/opportunities/${oid}/request`);
      return { ...answer, opportunity_id: opportunity.opportunity_id };
    },
    next({ playback_id, opportunity_id, after_step }) {
      return call('POST', `/v1/vod/playbacks/${id(playback_id, 'playback_id')}/opportunities/${id(opportunity_id, 'opportunity_id')}/next`,
        { after_step });
    },
    event({ playback_id, ...event }) {
      return call('POST', `/v1/vod/playbacks/${id(playback_id, 'playback_id')}/events`, event);
    },
  };
}

// Offline: the shared fixture files answer, no backend and no key.
const FIXTURE_ORIGIN = 'http://localhost:8000';
function fixtureBackend(dir) {
  let origin = FIXTURE_ORIGIN;
  const load = async (name) => JSON.parse((await readFile(join(dir, name), 'utf8')).replaceAll(FIXTURE_ORIGIN, origin));
  return {
    async playback() {
      const created = await load('playback-created.json');
      return { playback_id: created.playback_id, plan: await load('host-plan.json') };
    },
    async break({ cue_seconds }) {
      const answer = await load(cue_seconds === 58 ? 'break-request-stable.json' : 'break-request-gam.json');
      return { ...answer, opportunity_id: `opp-fixture-${Math.round(cue_seconds * 1000)}` };
    },
    // The fixtures have no second step: the walk ends there, as when steps_left is 0.
    async next() {
      return null;
    },
    async event() {
      return { accepted: true };
    },
    load,
    setOrigin(value) {
      origin = value;
    },
  };
}

async function serveStatic(res, root, pathname) {
  const file = normalize(join(root, decodeURIComponent(pathname)));
  if (file !== root && !file.startsWith(root + sep)) return send(res, 404, { error: 'not found' });
  try {
    if (!(await stat(file)).isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { ...CORS, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

export function createRelay({ base, apiKey, fixtures, staticDir, v2 = false, publicOrigin, fetchImpl, log = (line) => console.log(line) } = {}) {
  if (!fixtures && (!base || !apiKey)) throw new Error('Set IL_API_BASE and IL_API_KEY, or pass --fixtures <dir>');
  const backend = fixtures ? fixtureBackend(resolve(fixtures)) : liveBackend({ base, apiKey, fetchImpl });
  const root = staticDir ? resolve(staticDir) : null;
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://relay.local');
    // The request line only: never headers, never the key.
    log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search}`);
    if (fixtures) backend.setOrigin(publicOrigin ?? `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (req.method === 'OPTIONS') return send(res, 204);
      if (req.method === 'POST' && url.pathname === '/playback') {
        const body = await readJson(req);
        id(body.asset_id, 'asset_id');
        if (body.channel_id != null) id(body.channel_id, 'channel_id');
        return send(res, 200, await backend.playback(body));
      }
      if (req.method === 'POST' && url.pathname === '/break') {
        const body = await readJson(req);
        id(body.playback_id, 'playback_id');
        return send(res, 200, await backend.break({ playback_id: body.playback_id, cue_seconds: seconds(body.cue_seconds) }));
      }
      if (req.method === 'POST' && url.pathname === '/break/next') {
        const body = await readJson(req);
        id(body.playback_id, 'playback_id');
        id(body.opportunity_id, 'opportunity_id');
        if (!Number.isInteger(body.after_step) || body.after_step < 0) throw Object.assign(new Error('after_step must be an integer'), { status: 400 });
        const answer = await backend.next(body);
        return answer == null ? send(res, 204) : send(res, 200, answer);
      }
      if (req.method === 'POST' && url.pathname === '/event') {
        const body = await readJson(req);
        id(body.playback_id, 'playback_id');
        const answer = await backend.event(body);
        return answer == null ? send(res, 204) : send(res, 200, answer);
      }
      if (fixtures && req.method === 'GET') {
        // The routes IL's console serves to an app directly; here they come from the fixture files.
        const fixtureHeaders = { 'X-Content-Type-Options': 'nosniff' };
        if (url.pathname === '/il-player/app-plan') {
          const name = url.searchParams.get('renew') ? 'app-plan-renewed.json'
            : v2 || url.searchParams.get('v') === '2' ? 'app-plan-v2.json' : 'app-plan-v1.json';
          return send(res, 200, await backend.load(name), fixtureHeaders);
        }
        if (url.pathname === '/il-player/scene-product') return send(res, 200, await backend.load('scene-product-card.json'), fixtureHeaders);
        if (url.pathname === '/il-player/break-product') return send(res, 200, await backend.load('break-product-card.json'), fixtureHeaders);
        if (root) return serveStatic(res, root, url.pathname);
      }
      send(res, 404, { error: 'not found' });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      send(res, status, { error: status === 500 ? 'relay error' : error.message, status });
    }
  });
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const server = createRelay({
    base: process.env.IL_API_BASE,
    apiKey: process.env.IL_API_KEY,
    fixtures: argument(args, '--fixtures'),
    staticDir: argument(args, '--static'),
    v2: args.includes('--v2'),
    publicOrigin: argument(args, '--public-origin'),
  });
  const port = Number(process.env.PORT) || 8787;
  server.listen(port, () => console.log(`relay listening on http://localhost:${port}${argument(args, '--fixtures') ? ' (fixtures)' : ''}`));
}

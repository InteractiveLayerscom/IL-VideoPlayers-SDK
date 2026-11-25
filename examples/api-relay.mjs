#!/usr/bin/env node
// Example relay: plays the CUSTOMER'S BACKEND for an app that uses IL's per-break API. The API key lives only here,
// in the environment; the app never sees it. Dependency-free, Node >= 20. For local demos and tests, not production.
//
// Usage
//   IL_API_BASE=https://console.example IL_API_KEY=... PORT=8787 node examples/api-relay.mjs
//   node examples/api-relay.mjs --fixtures test/fixtures/native [--static <dir>] [--v2] [--public-base https://host:port]
//                                [--cert cert.pem --key key.pem]   (HTTPS with a locally trusted certificate)
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
//   Every request line is logged to stdout (it is the evidence the example apps use), with `grant` and `renew`
//   values replaced by `REDACTED`.
//   Served copies are adjusted, the files stay byte-identical: `expires_at` becomes now + 15 min (v1 app plan, host
//   plan) or now + 120 s (v2 plan and its renewal), and the origin of `commerce.url` / `commerce.break_url` becomes
//   --public-base (default: the scheme this relay serves + the request's Host). The SDKs only take HTTPS product URLs
//   on the plan's origin, so serve HTTPS with --cert/--key (a locally trusted certificate) for Buy to show. The grants
//   inside those URLs are the fixtures' own and long expired: fixtures mode answers the product routes itself and
//   never checks them.
// Upstream errors come back as { "error", "status" } with the upstream status (502 when the backend is unreachable).
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
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
const FIXTURE_MINUTES = 15;
// The served copy of a fixture plan: a live expiry and product URLs on this relay.
function servedPlan(plan, base, lifetimeMs) {
  const copy = structuredClone(plan);
  if (copy && typeof copy === 'object' && 'expires_at' in copy) copy.expires_at = new Date(Date.now() + lifetimeMs).toISOString();
  for (const key of ['url', 'break_url']) {
    if (typeof copy?.commerce?.[key] !== 'string') continue;
    const url = new URL(copy.commerce[key]);
    copy.commerce[key] = base + url.pathname + url.search;
  }
  return copy;
}

function fixtureBackend(dir) {
  let base = 'http://localhost';
  const load = async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'));
  const plan = async (name, lifetimeMs = FIXTURE_MINUTES * 60000) => servedPlan(await load(name), base, lifetimeMs);
  return {
    async playback() {
      const created = await load('playback-created.json');
      return { playback_id: created.playback_id, plan: await plan('host-plan.json') };
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
    plan,
    setBase(value) {
      base = value.replace(/\/+$/, '');
    },
  };
}

// The request line without grant or renew values.
export function redact(pathAndQuery) {
  return pathAndQuery.replace(/([?&](?:grant|renew)=)[^&#]*/g, '$1REDACTED');
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

export function createRelay({ base, apiKey, fixtures, staticDir, v2 = false, publicBase, cert, key, fetchImpl, log = (line) => console.log(line) } = {}) {
  if (!fixtures && (!base || !apiKey)) throw new Error('Set IL_API_BASE and IL_API_KEY, or pass --fixtures <dir>');
  const backend = fixtures ? fixtureBackend(resolve(fixtures)) : liveBackend({ base, apiKey, fetchImpl });
  const root = staticDir ? resolve(staticDir) : null;
  const tls = cert && key ? { cert, key } : null;
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://relay.local');
    // The request line only: never headers, never the key.
    log(`${new Date().toISOString()} ${req.method} ${redact(url.pathname + url.search)}`);
    if (fixtures) backend.setBase(publicBase ?? `${tls ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`);
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
          const wantsV2 = v2 || url.searchParams.get('v') === '2';
          // A renewal of a v2 view stays v2 (the fixture of a renewal is the v1 one): a fresh 120 s approval.
          const name = url.searchParams.get('renew') && !wantsV2 ? 'app-plan-renewed.json' : wantsV2 ? 'app-plan-v2.json' : 'app-plan-v1.json';
          return send(res, 200, await backend.plan(name, wantsV2 ? 120000 : FIXTURE_MINUTES * 60000), fixtureHeaders);
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
  };
  return tls ? createHttpsServer(tls, handler) : createServer(handler);
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
    publicBase: argument(args, '--public-base'),
    cert: argument(args, '--cert') ? readFileSync(argument(args, '--cert')) : undefined,
    key: argument(args, '--key') ? readFileSync(argument(args, '--key')) : undefined,
  });
  const port = Number(process.env.PORT) || 8787;
  server.listen(port, () => console.log(`relay listening on ${argument(args, '--cert') ? 'https' : 'http'}://localhost:${port}${argument(args, '--fixtures') ? ' (fixtures)' : ''}`));
}

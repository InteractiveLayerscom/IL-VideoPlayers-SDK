// Optional ads module. Hosts import it only when the backend returned an ad plan,
// so a player without a plan never loads ad-server code.
import { videoClock } from './content-clock.mjs';
import { commerceLocale } from './commerce.mjs';
import { normalizeCue } from './cues.mjs';

export {
  hlsContentClock, nativeHlsContentClock, parseMediaPlaylist, shakaContentClock, videoClock, videoJsContentClock,
} from './content-clock.mjs';

export const PREPARE_MS = 4000;
const REQUEST_TIMEOUT_MS = 4000;
const MIN_START_SPACING_MS = 30000;
const SDK_FORMATS = { super: 'super', l_shape: 'l' };
// The SDK's Super uses 75% x 20% of a 16:9 surface; L uses a full 16:9 canvas.
const SHAPES = { super: 20 / 3, l_shape: 16 / 9 };
const VIDEO_EVENTS = ['playing', 'pause', 'timeupdate', 'seeking', 'seeked', 'ended'];

const IMA_URL = 'https://imasdk.googleapis.com/js/sdkloader/ima3.js';
const GPT_URL = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';
const OVERLAY = 'overlay_300x250';
const IMA_LOAD_TIMEOUT_MS = 8000;
const BREAK_WATCHDOG_MS = 120000;
// Ordered requests per break: how early a mid-roll is asked, how long one attempt may take,
// how long content may stay paused without an ad, and how much content may play past a due break.
const WALK_LEAD_MS = 8000;
const ATTEMPT_MS = 5000;
const HOLD_MS = 8000;
const LATE_MS = 2000;
const MAX_REQUESTS = 3;
const OVERLAY_UNIT = /^\/\d+(\/[^\s/]+)*$/;
// Below this the 300x250 box would cover most of the picture.
const MIN_STAGE = [640, 360];
const PRODUCT = 'scene_product';
// IL's route waits up to 4 s for iADServer; the rest is the network.
const PRODUCT_TIMEOUT_MS = 6000;
const SID = /^[A-Za-z0-9_.:-]{1,128}$/;
// iADServer names a shop-linked ad `il-shop-<position>-<delivery id>` (VAST Ad@id, which IMA exposes).
const SHOP_AD = /^il-shop-(preroll|midroll)-([A-Za-z0-9_-]{43})$/;
// Where each plan returned by loadPlan came from, without a visible field on the plan.
const planOrigins = new WeakMap();
// Delivery ids whose impression this page already fired: a re-attach or a second attachAds asking the same
// window with the same sid gets the same delivery back and must not count it twice.
const measuredDeliveries = new Set();

const ms = (seconds) => Math.round(seconds * 1000);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const inert = Object.freeze({ cuts: Object.freeze([]), vmap: () => buildVmap([]), setBreaks() {}, setBreakActive() {}, start() {}, destroy() {} });

// One fresh value per ad request, so ad servers never treat two requests as one page view.
const correlator = () => String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');

// Kept in memory for one attachAds call only; iADServer groups the requests of a view by it.
function randomId() {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function reject(reason) {
  throw new Error(reason);
}

const scripts = new Map();
// Google's scripts are loaded once per page, and only when a plan needs them.
function loadScriptOnce(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, fail) => {
      const doc = globalThis.document;
      if (!doc) return fail(new Error('script_unavailable'));
      const script = doc.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scripts.delete(src);
        fail(new Error('script_blocked'));
      };
      doc.head.append(script);
    }));
  }
  return scripts.get(src);
}

const pacingValid = (pacing) => isNumber(pacing?.min_seconds) &&
  (pacing.max_seconds == null || isNumber(pacing.max_seconds)) &&
  (pacing.gap_after_seconds == null || isNumber(pacing.gap_after_seconds)) &&
  (pacing.cut_clearance_seconds == null || isNumber(pacing.cut_clearance_seconds)) &&
  (pacing.max_per_video == null || Number.isInteger(pacing.max_per_video));

// The scene product. A `commerce` part this module cannot read is ignored, not the whole plan.
function readCommerce(commerce) {
  if (commerce?.kind !== PRODUCT || !Number.isSafeInteger(commerce.lead_ms) || commerce.lead_ms < 0 ||
      !pacingValid(commerce.pacing) || !Array.isArray(commerce.windows)) return null;
  try {
    const url = new URL(commerce.url);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
  } catch {
    return null;
  }
  return commerce;
}

function readPlan(plan, now) {
  const scenes = plan?.scenes;
  const expires = typeof plan?.expires_at === 'string' ? Date.parse(plan.expires_at) : NaN;
  if (![1, 2].includes(plan?.version) || !(expires > now)) return null;
  if (plan.version === 2 && (plan.native_gam?.contract !== 'native-gam-plan-v1' || expires - now > 120000)) return null;
  // A timeline this module does not know could put graphics over ads: no plan rather than a wrong one.
  if (plan.timeline != null && !stitchedTimeline(plan.timeline)) return null;
  if (scenes == null) return Array.isArray(plan.cuts) || readCommerce(plan.commerce) ? plan : null;
  if (!Array.isArray(scenes?.formats) || !Array.isArray(scenes.windows) || !pacingValid(scenes.pacing)) return null;
  return plan;
}

// The stream carries server-stitched ads; scene windows and `breaks` are content seconds.
function stitchedTimeline(timeline) {
  return timeline?.kind === 'stitched' && typeof timeline.pdt_origin === 'string' &&
    Number.isFinite(Date.parse(timeline.pdt_origin)) &&
    (timeline.breaks == null || (Array.isArray(timeline.breaks) && timeline.breaks.every((at) => isNumber(at) && at >= 0)));
}

export function graphicTagAllowed(tagUrl) {
  try {
    const url = new URL(tagUrl);
    return url.origin === 'https://pubads.g.doubleclick.net' && url.pathname === '/gampad/ads' &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

// Video breaks may also go to iADServer; scene graphics stay GAM-only (graphicTagAllowed).
export function cutRequestAllowed(provider, tagUrl) {
  if (provider === 'gam') return graphicTagAllowed(tagUrl);
  if (provider !== 'iadserver') return false;
  try {
    const url = new URL(tagUrl);
    return url.origin === 'https://ads.iadserver.com' && url.pathname === '/gampad/ads' &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

// Formats this slice can serve, in plan order, each with its GAM tag.
export function servableFormats(scenes) {
  const tags = new Map();
  for (const graphic of Array.isArray(scenes?.graphics) ? scenes.graphics : []) {
    if (Object.hasOwn(SHAPES, graphic?.format) && !tags.has(graphic.format) && graphicTagAllowed(graphic.tag_url))
      tags.set(graphic.format, graphic.tag_url);
  }
  return [...new Set(scenes.formats)].filter((format) => tags.has(format))
    .map((format) => ({ format, tagUrl: tags.get(format) }));
}

// The part of each window where a graphic may show, clear of ad breaks.
export function usableWindows(plan, part = plan.scenes) {
  const { pacing, windows } = part;
  const clearance = ms(pacing.cut_clearance_seconds ?? 0);
  const stitched = plan.timeline?.kind === 'stitched';
  const breaks = (stitched ? (plan.timeline.breaks ?? []).map((at) => ({ at })) : Array.isArray(plan.cuts) ? plan.cuts : [])
    .map((cut) => cut?.at).filter(isNumber).map(ms);
  const usable = [];
  for (const window of windows) {
    if (typeof window?.id !== 'string' || !Number.isSafeInteger(window.start_ms) || !Number.isSafeInteger(window.end_ms)) continue;
    let start = window.start_ms;
    let end = pacing.max_seconds == null ? window.end_ms : Math.min(window.end_ms, start + ms(pacing.max_seconds));
    if (clearance) {
      for (const cut of breaks) {
        if (cut <= start && start < cut + clearance) start = cut + clearance;
        else if (start < cut && cut < end + clearance) end = Math.min(end, cut - clearance);
      }
    }
    if (end - start >= ms(pacing.min_seconds)) usable.push({ id: window.id, start, end, targeting: window.targeting });
  }
  return usable.sort((a, b) => a.start - b.start);
}

// Pacing is checked against every graphic already shown, wherever a seek put it.
export function pacingAllows(window, shown, pacing) {
  if (shown.length >= (pacing.max_per_video ?? Infinity)) return false;
  const gap = ms(pacing.gap_after_seconds ?? 0);
  return shown.every((other) => other.start <= window.start
    ? window.start - other.start >= MIN_START_SPACING_MS && window.start >= other.end + gap
    : other.start - window.start >= MIN_START_SPACING_MS && other.start >= window.end + gap);
}

export function graphicTag(tagUrl, format, targeting, pageUrl) {
  if (!graphicTagAllowed(tagUrl)) reject('invalid_graphic_tag');
  const url = new URL(tagUrl);
  const params = new URLSearchParams(url.searchParams.get('cust_params') || '');
  for (const [key, value] of Object.entries(targeting && typeof targeting === 'object' ? targeting : {}))
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  params.set('il_format', format);
  url.searchParams.set('cust_params', params.toString());
  url.searchParams.set('correlator', correlator());
  if (pageUrl) {
    url.searchParams.set('url', pageUrl);
    url.searchParams.set('description_url', pageUrl);
  }
  return url.href;
}

// Appends to an opaque signed URL without parsing or re-encoding what is already there.
function withParams(href, extra) {
  const [base, fragment] = href.split(/#(.*)/s);
  return base + (!base.includes('?') ? '?' : /[?&]$/.test(base) ? '' : '&') + extra + (fragment != null ? '#' + fragment : '');
}

function requestTag(provider, tagUrl, pageUrl, sid) {
  const url = new URL(tagUrl);
  if (provider === 'gam' && pageUrl) {
    url.searchParams.set('url', pageUrl);
    url.searchParams.set('description_url', pageUrl);
  }
  if (provider === 'iadserver' && sid) url.searchParams.set('sid', sid);
  return url.href;
}

// The plan's video breaks, in time order, for any ad player. Each keeps its allowed requests in
// plan order; a plan without `requests` has one GAM request per cut, from `tag_url`.
export function planCuts(cuts, pageUrl, sid) {
  return (Array.isArray(cuts) ? cuts : [])
    .filter((cut) => typeof cut?.id === 'string' && isNumber(cut.at) && cut.at >= 0)
    .map((cut) => {
      const source = Array.isArray(cut.requests) ? cut.requests : [{ provider: 'gam', tag_url: cut.tag_url }];
      const requests = source.filter((entry) => cutRequestAllowed(entry?.provider, entry?.tag_url)).slice(0, MAX_REQUESTS)
        .map((entry) => Object.freeze({ provider: entry.provider, tagUrl: requestTag(entry.provider, entry.tag_url, pageUrl, sid) }));
      return requests.length
        ? { id: cut.id, at: cut.at, position: cut.position, tagUrl: requests[0].tagUrl, requests: Object.freeze(requests) }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

const pad = (value, size) => String(value).padStart(size, '0');
function timeOffset(seconds) {
  if (seconds === 0) return 'start';
  const total = ms(seconds);
  return `${pad(Math.floor(total / 3600000), 2)}:${pad(Math.floor(total / 60000) % 60, 2)}:` +
    `${pad(Math.floor(total / 1000) % 60, 2)}.${pad(total % 1000, 3)}`;
}
const attribute = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

// VMAP 1.0 with one linear break per cut; every call carries a fresh correlator.
export function buildVmap(cuts) {
  const breaks = cuts.map((cut) => {
    const url = new URL(cut.tagUrl);
    url.searchParams.set('correlator', correlator());
    const tag = url.href.replaceAll(']]>', ']]]]><![CDATA[>');
    return `<vmap:AdBreak timeOffset="${timeOffset(cut.at)}" breakType="linear" breakId="${attribute(cut.id)}">` +
      `<vmap:AdSource id="${attribute(cut.id)}" allowMultipleAds="true" followRedirects="true">` +
      `<vmap:AdTagURI templateType="vast3"><![CDATA[${tag}]]></vmap:AdTagURI></vmap:AdSource></vmap:AdBreak>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0">${breaks.join('')}</vmap:VMAP>`;
}

function httpsUrl(value) {
  if (!value || /[\s[\]{}<>"]/.test(value)) reject('unsupported_vast_url');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) reject('unsupported_vast_url');
  return url.href;
}

const children = (el, tag) => Array.from(el.children).filter((child) => child.localName === tag);
function one(el, tag) {
  const matches = children(el, tag);
  if (matches.length !== 1) reject('unsupported_vast_structure');
  return matches[0];
}
const urlsOf = (el, tag) => children(el, tag).map((node) => httpsUrl(node.textContent.trim()));

// Returns null for an empty VAST (no fill) and throws for anything this renderer cannot draw.
export function parseGraphicVast(xml, format, availableMs, Parser = globalThis.DOMParser) {
  if (!Object.hasOwn(SHAPES, format) || typeof xml !== 'string' || xml.length > 262144 || /<!DOCTYPE/i.test(xml))
    reject('invalid_graphic_vast');
  const doc = new Parser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (root.localName !== 'VAST' || doc.getElementsByTagName('parsererror').length) reject('invalid_graphic_vast');
  if (!children(root, 'Ad').length) return null;
  const ad = one(root, 'Ad');
  // Wrapper chains, verification scripts, interactive resources and viewability vendors
  // require execution contracts that this static image renderer does not provide.
  if (ad.querySelector('Wrapper, AdVerifications, ViewableImpression, InteractiveCreativeFile, AdParameters, Icon, CompanionAds, Linear, HTMLResource, IFrameResource'))
    reject('unsupported_graphic_vast');
  const inline = one(ad, 'InLine');
  const creative = one(one(inline, 'Creatives'), 'Creative');
  const container = one(creative, 'NonLinearAds');
  const nonLinear = one(container, 'NonLinear');
  const resource = one(nonLinear, 'StaticResource');
  const mimeType = resource.getAttribute('creativeType')?.toLowerCase();
  const width = Number(nonLinear.getAttribute('width'));
  const height = Number(nonLinear.getAttribute('height'));
  if (!['image/png', 'image/jpeg'].includes(mimeType) || !(width > 0 && height > 0) ||
      Math.abs(width / height / SHAPES[format] - 1) > 0.02 || nonLinear.hasAttribute('apiFramework'))
    reject('incompatible_graphic');
  const duration = nonLinear.getAttribute('minSuggestedDuration');
  if (duration) {
    const match = /^(\d{2}):([0-5]\d):([0-5]\d(?:\.\d{1,3})?)$/.exec(duration);
    if (!match) reject('unsupported_duration');
    const minimumMs = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
    if (minimumMs > availableMs) reject('insufficient_window');
  }
  const views = children(container, 'TrackingEvents').flatMap((list) => children(list, 'Tracking'))
    .filter((tracking) => tracking.getAttribute('event') === 'creativeView')
    .map((tracking) => httpsUrl(tracking.textContent.trim()));
  const clicks = urlsOf(nonLinear, 'NonLinearClickThrough');
  const clickTracking = urlsOf(nonLinear, 'NonLinearClickTracking');
  if (clicks.length > 1 || (clickTracking.length && !clicks.length)) reject('unsupported_click');
  return {
    imageUrl: httpsUrl(resource.textContent.trim()),
    mimeType,
    impressions: [...urlsOf(inline, 'Impression'), ...views],
    clickUrl: clicks[0] ?? null,
    clickTracking,
  };
}

export function planUrl({ origin, project, asset } = {}) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError('origin must be an https origin');
  }
  if (parsed.protocol !== 'https:' || (parsed.origin !== origin && parsed.origin + '/' !== origin)) {
    throw new TypeError('origin must be an https origin');
  }
  for (const [name, value] of [['project', project], ['asset', asset]]) {
    if (typeof value !== 'string' || !value) throw new TypeError(name + ' must be a non-empty string');
  }
  return `${parsed.origin}/il-player/ad-plan?project=${encodeURIComponent(project)}&asset=${encodeURIComponent(asset)}`;
}

export async function loadPlan(url, { fetchImpl = globalThis.fetch, signal } = {}) {
  try {
    // A relative URL is resolved against the page; without a page it is refused, as before.
    const resolved = new URL(url, globalThis.location?.href);
    if (resolved.protocol !== 'https:' || typeof fetchImpl !== 'function') return null;
    // An absolute URL is requested exactly as given.
    const target = URL.canParse?.(url) ?? /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : resolved.href;
    const response = await fetchImpl(target, { method: 'GET', credentials: 'omit', redirect: 'error', signal });
    if (response.status !== 200) return null;
    const plan = JSON.parse(await response.text());
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.version !== 1) return null;
    // Remembering where it came from never costs the plan: without it the page-origin / planOrigin rule applies.
    try {
      planOrigins.set(plan, resolved.origin);
    } catch {
      // A plan object a WeakMap refuses keeps the handed-in rule.
    }
    return plan;
  } catch {
    return null;
  }
}

export function attachAds({
  session, video, plan, pageUrl, fetchImpl = globalThis.fetch, onEvent,
  stage, linear, adContainer, loadScript = loadScriptOnce, sessionId, clock, planOrigin,
} = {}) {
  const valid = session && video && typeof fetchImpl === 'function' ? readPlan(plan, Date.now()) : null;
  if (!valid) return inert;
  const native = valid.version === 2;
  let expiryTimer;
  // Stitched: the ads are already in the stream. Nothing here requests or plays a video break, whatever
  // the host passed, and without a content clock the video position is stream time: no graphics either.
  const stitched = valid.timeline?.kind === 'stitched';
  if (stitched && typeof clock?.time !== 'function') return inert;
  // Cues are drawn by the session from its own clock: under a stitched plan it must be this clock,
  // or they would show by stream time. Said once through onEvent, then nothing is drawn.
  if (stitched && (typeof clock.programTime !== 'function' || session.clock !== clock.programTime)) {
    try {
      onEvent?.({ type: 'clock_mismatch' });
    } catch {
      // Diagnostics must never break playback.
    }
    return inert;
  }
  const content = typeof clock?.time === 'function' ? clock : videoClock(video);
  const page = pageUrl ?? valid.page_url;
  // commerce.url must be on the origin the plan came from: the one loadPlan fetched it from or, for a plan the
  // host obtained itself, the page's origin or the `planOrigin` the host states. Otherwise `commerce` is ignored.
  const origins = planOrigins.has(plan) ? [planOrigins.get(plan)] : [globalThis.location?.origin, planOrigin];
  const shop = (() => {
    const commerce = readCommerce(valid.commerce);
    try {
      return commerce && origins.includes(new URL(commerce.url).origin) ? commerce : null;
    } catch {
      return null;
    }
  })();
  // A host that keeps its own view id keeps it on the iADServer requests (its frequency caps per viewer);
  // otherwise the plan's commerce.session is the sid, so breaks and products share one session.
  const sid = typeof sessionId === 'string' && sessionId ? sessionId
    : typeof shop?.session === 'string' && SID.test(shop.session) ? shop.session : randomId();
  const cuts = Object.freeze(stitched ? [] : planCuts(valid.cuts, page, sid).map(Object.freeze));
  // The Buy button during an ad: IL's grant names the view's session, and iADServer ties the delivery to that session,
  // so a host with its own view id gets the ad without the card.
  const breakUrl = (() => {
    if (!shop || !session.commerce || sid !== shop.session || typeof shop.break_url !== 'string') return null;
    try {
      const url = new URL(shop.break_url);
      return url.protocol === 'https:' && !url.username && !url.password && url.origin === new URL(shop.url).origin
        ? shop.break_url : null;
    } catch {
      return null;
    }
  })();
  // kept: the card of an ad that ended while its product was open; deferred: the end of the break, run once it closes.
  const breakShop = { token: 0, id: null, abort: null, spot: false, kept: null, deferred: null, poll: null };
  const scenes = valid.scenes;
  const unit = scenes?.overlay?.ad_unit;
  const overlayServable = !!scenes && scenes.formats.includes(OVERLAY) && typeof unit === 'string' && OVERLAY_UNIT.test(unit) &&
    !!stage?.ownerDocument;
  const graphics = scenes ? servableFormats(scenes) : [];
  // The overlay takes its place in plan order among the scene graphics.
  const formats = !overlayServable ? graphics : [...new Set(scenes.formats)]
    .flatMap((format) => format === OVERLAY ? [{ format }] : graphics.filter((graphic) => graphic.format === format));
  // The stage is measured when a window is due, so a stage laid out after attach still counts.
  const servableNow = () => overlayServable && stage.clientWidth >= MIN_STAGE[0] && stage.clientHeight >= MIN_STAGE[1]
    ? formats : graphics;
  let hostBreak = false;
  // Re-attaching to a video that already played keeps the latch. A resume position alone is not playback.
  let played = (Number(video.played?.length) || 0) > 0;
  const failedCuts = new Set();
  const startedCuts = new Set();
  // A stitched ad on screen (content time unknown) counts as a break.
  const breakOn = () => inBreak || hostBreak || now() == null;
  const overlay = { node: null, gpt: null, ready: null, slot: null, pending: null, live: null, viewed: false };
  let windows = scenes ? usableWindows(valid) : [];
  // The scene product needs a session that renders commerce (attachHtmlVideo({ commerce })); without it nothing
  // about it is requested.
  const shopOn = !!shop && !!session.commerce;
  const shopWindows = shopOn ? usableWindows(valid, shop) : [];
  const shopIds = new Set(shopOn ? shop.windows.map((window) => window?.id) : []);
  // Per window: 'pending', 'filled' or 'empty' (204, 429, error or timeout: free for a graphic).
  const products = new Map();
  let productController = null;
  const pendingWindows = new Set();
  // Pacing counts graphics and products shown, and the ones being asked for.
  const committed = () => [...shown, ...pendingWindows];
  const pacing = scenes?.pacing;
  const minMs = scenes ? ms(pacing.min_seconds) : 0;
  const attempted = new Set();
  const shown = [];
  const cues = new Map();
  let controller = null;
  let disposed = false;
  let inBreak = false;
  let nativePausedContent = false;
  const ima = { sdk: null, display: null, loader: null, manager: null, started: false, running: false, cut: null,
    gaveUp: false, loadTimer: null, watchdog: null, observer: null };
  // With a cut of several requests the module schedules the breaks and asks them in order;
  // every other plan keeps IMA's ad rules (one VMAP) exactly as before.
  const useIma = !stitched && linear === 'ima' && cuts.length > 0 && !!adContainer;
  const waterfall = useIma && (native || cuts.some((cut) => cut.requests.length > 1));
  // token: bumped by every attempt, cancel and settle, so late IMA answers are recognised as stale.
  const wf = { cut: null, index: 0, token: 0, phase: 'idle', timer: null, holdTimer: null, dueAt: null, started: false,
    held: false, ownPause: false, adComing: false, holdSpent: false, begun: false,
    viewerPaused: false };
  const settledCuts = new Set();

  const emit = (type, format, window) => {
    try {
      onEvent?.({ type, format, window: window.id });
    } catch {
      // Diagnostics must never break playback.
    }
  };
  const beacon = (url) => {
    try {
      void Promise.resolve(fetchImpl(url, { mode: 'no-cors', credentials: 'omit', keepalive: true })).catch(() => {});
    } catch {
      // A failed pixel never affects playback.
    }
  };
  // Content milliseconds, or null while a stitched ad plays (or the position cannot be told).
  const now = () => {
    let seconds;
    try {
      seconds = content.time();
    } catch {
      seconds = null;
    }
    return isNumber(seconds) ? ms(seconds) : null;
  };

  function draw(window, format, ad) {
    const id = 'il-ads-' + window.id;
    let measured = false;
    const item = {
      id,
      format: SDK_FORMATS[format],
      start: window.start,
      end: window.end,
      imageUrl: ad.imageUrl,
      mimeType: ad.mimeType,
      ...(ad.clickUrl ? { clickUrl: ad.clickUrl } : {}),
    };
    const hooks = {
      onVisible() {
        if (measured || disposed) return;
        measured = true;
        for (const url of ad.impressions) beacon(url);
        emit('impression', format, window);
      },
      onClick() {
        for (const url of ad.clickTracking) beacon(url);
        emit('click', format, window);
      },
    };
    // Filled while a stitched ad plays: it waits off the session until content is back.
    const waiting = now() == null;
    if (waiting || session.addCue(item, hooks)) cues.set(id, { end: window.end, item, hooks, onScreen: !waiting });
    watch();
  }

  const onRender = (event) => {
    if (overlay.pending && event?.slot === overlay.pending.slot) overlay.pending.resolve(event);
  };
  const onViewable = (event) => {
    if (disposed || !overlay.live || event?.slot !== overlay.live.slot || overlay.viewed) return;
    overlay.viewed = true;
    emit('impression', OVERLAY, overlay.live.window);
  };
  // Every GPT call goes through the documented command queue, so a page that already
  // uses GPT keeps its own setup; page-wide settings are touched only when we enable services.
  const gptQueue = (fn) => {
    const tag = (globalThis.googletag ??= { cmd: [] });
    tag.cmd ??= [];
    tag.cmd.push(fn);
  };
  function setUpGpt() {
    overlay.ready ??= new Promise((resolve, fail) => {
      gptQueue(() => {
        try {
          if (disposed) reject('disposed');
          const gpt = globalThis.googletag;
          const service = gpt.pubads();
          const own = !gpt.pubadsReady;
          const node = stage.ownerDocument.createElement('div');
          node.id = 'il-ads-overlay-' + Math.random().toString(36).slice(2, 10);
          node.dataset.ilAdsOverlay = '';
          Object.assign(node.style, { position: 'absolute', right: '12px', bottom: 'calc(var(--il-safe-bottom, 46px) + 12px)', width: '300px', height: '250px', zIndex: '2', display: 'none' });
          stage.append(node);
          overlay.node = node;
          if (own) {
            // GPT deprecated the per-service calls in favour of setConfig; the old ones stay for a GPT without it.
            if (typeof gpt.setConfig === 'function') {
              gpt.setConfig({ disableInitialLoad: true, ...(page ? { adsenseAttributes: { page_url: page } } : {}) });
            } else {
              service.disableInitialLoad();
              if (page) service.set('page_url', page);
            }
          }
          service.addEventListener('slotRenderEnded', onRender);
          service.addEventListener('impressionViewable', onViewable);
          if (own) gpt.enableServices();
          overlay.gpt = gpt;
          resolve(gpt);
        } catch (error) {
          fail(error);
        }
      });
      Promise.resolve().then(() => loadScript(GPT_URL)).catch(fail);
    });
    return overlay.ready;
  }
  function dropSlot() {
    const slot = overlay.slot;
    if (slot) {
      gptQueue(() => {
        try {
          overlay.gpt.destroySlots([slot]);
        } catch {
          // GPT may already be gone.
        }
      });
    }
    overlay.slot = overlay.live = null;
    if (overlay.node) overlay.node.style.display = 'none';
  }
  // Visible only during the usable part of its window and never during a video break.
  function updateOverlay(time) {
    if (!overlay.live) return;
    if (time != null && time >= overlay.live.window.end) return dropSlot();
    overlay.node.style.display = time != null && !breakOn() && time >= overlay.live.window.start ? 'block' : 'none';
  }

  async function requestOverlay(window) {
    const abort = new AbortController();
    controller = abort;
    const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      emit('request', OVERLAY, window);
      const gpt = await setUpGpt();
      if (disposed || expired() || abort.signal.aborted) reject('aborted');
      const event = await new Promise((resolve, fail) => {
        abort.signal.addEventListener('abort', () => fail(new Error('timeout')));
        gptQueue(() => {
          try {
            if (disposed || expired() || abort.signal.aborted) reject('aborted');
            const service = gpt.pubads();
            const slot = gpt.defineSlot(unit, [300, 250], overlay.node.id);
            if (!slot) reject('slot_unavailable');
            overlay.slot = slot;
            slot.addService(service);
            const targeting = {};
            for (const [key, value] of Object.entries(window.targeting && typeof window.targeting === 'object' ? window.targeting : {}))
              targeting[key] = Array.isArray(value) ? value.map(String) : String(value);
            targeting.il_format = OVERLAY;
            if (typeof slot.setConfig === 'function') slot.setConfig({ targeting });
            else for (const [key, value] of Object.entries(targeting)) slot.setTargeting(key, value);
            overlay.pending = { slot, resolve };
            // display() fetches unless initial load is off; then refresh() is the one fetch.
            gpt.display(overlay.node.id);
            const answer = typeof gpt.getConfig === 'function' ? gpt.getConfig('disableInitialLoad') : undefined;
            // A host may have turned initial load off through the old API, which getConfig does not report.
            const initialLoadOff = typeof answer?.disableInitialLoad === 'boolean' ? answer.disableInitialLoad
              : typeof answer === 'boolean' ? answer : Boolean(service.isInitialLoadDisabled?.());
            if (initialLoadOff) service.refresh([slot]);
          } catch (error) {
            fail(error);
          }
        });
      });
      if (disposed) return;
      if (event.isEmpty) {
        dropSlot();
        return emit('no_fill', OVERLAY, window);
      }
      if (now() != null && now() >= window.end) return dropSlot();
      shown.push(window);
      overlay.live = { window, slot: overlay.slot };
      overlay.viewed = false;
      emit('fill', OVERLAY, window);
      updateOverlay(now());
      watch();
    } catch {
      if (disposed) return;
      dropSlot();
      emit('error', OVERLAY, window);
    } finally {
      overlay.pending = null;
      clearTimeout(timeout);
      if (controller === abort) controller = null;
    }
  }

  async function request(window) {
    attempted.add(window.id);
    pendingWindows.add(window);
    try {
      await requestGraphic(window);
    } finally {
      pendingWindows.delete(window);
    }
  }

  async function requestGraphic(window) {
    const list = servableNow();
    const { format, tagUrl } = list[shown.length % list.length];
    if (format === OVERLAY) return requestOverlay(window);
    const abort = new AbortController();
    controller = abort;
    const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = graphicTag(tagUrl, format, window.targeting, page);
      emit('request', format, window);
      const res = await fetchImpl(url, { signal: abort.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      if (!res.ok) reject('graphic_vast_http_error');
      const ad = parseGraphicVast(await res.text(), format, window.end - Math.max(window.start, now() ?? window.start));
      if (disposed || expired() || abort.signal.aborted) return;
      if (!ad) return emit('no_fill', format, window);
      if (now() != null && now() >= window.end) return;
      shown.push(window);
      emit('fill', format, window);
      draw(window, format, ad);
    } catch {
      if (!disposed) emit('error', format, window);
    } finally {
      clearTimeout(timeout);
      if (controller === abort) controller = null;
    }
  }

  // Until the product of a window is settled the graphic waits, unless no product request can come any more.
  function productAwaited(window, time) {
    if (products.has(window.id)) return products.get(window.id) !== 'empty';
    const product = shopWindows.find((entry) => entry.id === window.id);
    return !!product && time < product.end && product.end - Math.max(product.start, time) >= ms(shop.pacing.min_seconds) &&
      pacingAllows(product, committed(), shop.pacing);
  }

  async function requestProduct(window) {
    products.set(window.id, 'pending');
    pendingWindows.add(window);
    const abort = new AbortController();
    productController = abort;
    const timeout = setTimeout(() => abort.abort(), PRODUCT_TIMEOUT_MS);
    let outcome = 'empty';
    try {
      // commerce.url is opaque (project, asset and a signed grant naming the session): only `window` and `locale`
      // are appended, without parsing or re-encoding what is already there.
      const extra = new URLSearchParams({ window: window.id,
        locale: commerceLocale(session.commerce.locale ?? globalThis.navigator?.language) });
      // A session that draws scenes asks for the banner designed in the ad server; IL answers the plain card otherwise.
      if (session.sceneFeatures) {
        extra.set('scene', '1');
        if (session.sceneFeatures.length) extra.set('scene_features', session.sceneFeatures.join(','));
      }
      const href = withParams(shop.url, extra);
      emit('request', PRODUCT, window);
      const res = await fetchImpl(href, { signal: abort.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      if (disposed || expired() || abort.signal.aborted) reject('aborted');
      // 204 (no product) and 429 (rate limit) are the same answer: nothing in this window.
      if (res.status !== 200) return emit('no_fill', PRODUCT, window);
      const card = await res.json();
      if (disposed || expired() || abort.signal.aborted) reject('aborted');
      const start = Math.max(window.start, Number(card?.start));
      // A designed banner lasts what its creative says, up to the end IL verified; a plain card stays in its window.
      const designed = !!session.sceneFeatures && !!card?.scene;
      const end = designed ? Number(card?.end) : Math.min(window.end, Number(card?.end));
      const item = { ...card, start, end };
      const cue = card && (card.window == null || card.window === window.id) ? normalizeCue(item) : null;
      if (!(cue?.commerce || (designed && cue?.scene && cue.products.some(Boolean))) || cue.format === 'midroll') reject('invalid_product');
      outcome = 'filled';
      // The gap after a product counts from the end of what is on screen, a banner longer than its window included.
      shown.push({ ...window, end: Math.max(window.end, cue.end) });
      emit('fill', PRODUCT, window);
      drawProduct(window, item, cue);
    } catch {
      if (!disposed) emit('error', PRODUCT, window);
    } finally {
      clearTimeout(timeout);
      pendingWindows.delete(window);
      if (productController === abort) productController = null;
      if (!disposed) {
        products.set(window.id, outcome);
        // A window left free for a graphic is looked at again without waiting for the next video event.
        if (outcome === 'empty') sync();
      }
    }
  }

  // The card goes through the session's commerce rendering (Buy, viewUrl, hand-off); the impression is fired
  // here, once per card, when the session reports it visible.
  function drawProduct(window, item, cue) {
    let measured = false;
    const hooks = {
      onVisible() {
        if (measured || disposed) return;
        measured = true;
        if (measuredDeliveries.has(cue.id)) return;
        measuredDeliveries.add(cue.id);
        if (cue.impressionUrl) beacon(cue.impressionUrl);
        emit('impression', PRODUCT, window);
      },
      onClick() {
        emit('click', PRODUCT, window);
      },
    };
    const visible = productVisible(now());
    // Every product, plain card or designed banner, stays known for this view after its end: seeking back shows it
    // again without asking, without a second delivery and without counting it twice.
    if (!visible || session.addCue(item, hooks)) cues.set(cue.id, { start: cue.start, end: cue.end, item, hooks, onScreen: visible, product: true, replay: true });
    watch();
  }
  // A product card is off during any video break and once the content has ended; it comes back while its time remains.
  const productVisible = (time) => time != null && !inBreak && !hostBreak && video.ended !== true;
  // A product stays known after its end, so seeking back shows it again without asking or counting twice.
  const productLive = (time) => [...cues.values()].some((cue) => cue.product &&
    (!cue.replay || cue.onScreen || (time >= cue.start - shop.lead_ms && time < cue.end)));

  function sync(event) {
    if (disposed || expired()) return;
    if (native && event?.type === 'seeking') {
      controller?.abort();
      controller = null;
      productController?.abort();
      productController = null;
      cancelAttempt();
      settleBehind();
      dropSlot();
      for (const [id, cue] of cues) if (cue.onScreen) session.removeCue(id);
      cues.clear();
      return;
    }
    // A stitched ad starting is a new ad break: it closes the product kept from the content.
    if (stitched && clock.inAd?.()) session.closeProduct?.();
    // No ad server is asked before the viewer has started playback in this session.
    // An ad playing in the content <video> (iOS custom playback) is not content playback.
    const time = now();
    if (!inBreak && time != null && (event?.type === 'playing' || video.paused === false)) played = true;
    for (const [id, cue] of cues) {
      // During a stitched ad every graphic leaves the session at once and comes back with the content.
      // A graphic lasts exactly its window; a product the viewer opened is kept by the session after it (and a new
      // break closes it there).
      if (time == null || (cue.product && time < cue.end && !productVisible(time))) {
        if (cue.onScreen) session.removeCue(id);
        cue.onScreen = false;
      } else if (time >= cue.end) {
        if (!cue.replay) cues.delete(id);
        if (cue.onScreen) session.removeCue(id);
        cue.onScreen = false;
      } else if (cue.replay && time < cue.start) {
        if (cue.onScreen) session.removeCue(id);
        cue.onScreen = false;
      } else if (!cue.onScreen) cue.onScreen = session.addCue(cue.item, cue.hooks);
    }
    updateOverlay(time);
    watch();
    if (time == null) return;
    schedule(time / 1000);
    // Nothing new is asked while a product held from a break is open over the paused content.
    if (!played || breakOn() || breakShop.deferred) return;
    // One product request at a time and one card at a time, asked `lead_ms` ahead.
    if (shopOn && !productController && !productLive(time)) {
      const product = shopWindows.find((window) => !products.has(window.id) &&
        window.start - shop.lead_ms <= time && time < window.end &&
        window.end - Math.max(window.start, time) >= ms(shop.pacing.min_seconds) && pacingAllows(window, committed(), shop.pacing));
      if (product) void requestProduct(product);
    }
    // The single overlay slot is not reused while it still holds a creative.
    if (controller || overlay.live || !servableNow().length) return;
    if ([...cues.values()].some((cue) => cue.replay && cue.start <= time && time < cue.end)) return;
    // A window with a product waits for its answer; a product (200) wins over the graphics in that window.
    const next = windows.find((window) => !attempted.has(window.id) &&
      window.start - PREPARE_MS <= time && time < window.end &&
      window.end - Math.max(window.start, time) >= minMs && pacingAllows(window, shopOn ? committed() : shown, pacing) &&
      !(shopIds.has(window.id) && productAwaited(window, time)));
    if (next) void request(next);
  }

  const emitBreak = (type, cut, extra) => {
    try {
      onEvent?.({ type, cut: cut?.id ?? null, ...extra });
    } catch {
      // Diagnostics must never break playback.
    }
  };
  const resume = () => {
    try {
      void Promise.resolve(video.play?.()).catch(() => {});
    } catch {
      // The host can still start playback itself.
    }
  };
  // IMA reports the pod's time offset; fall back to the last cut before the playhead.
  function cutOf(event) {
    let offset;
    try {
      offset = event?.getAd?.()?.getAdPodInfo?.()?.getTimeOffset?.();
    } catch {
      offset = undefined;
    }
    if (isNumber(offset) && offset >= 0) {
      const match = cuts.find((cut) => Math.abs(cut.at - offset) < 1);
      if (match) return match;
    }
    const time = Number(video.currentTime) || 0;
    return cuts.filter((cut) => cut.at <= time + 1).at(-1) ?? cuts[0] ?? null;
  }
  const podCut = (event) => {
    let offset;
    try {
      offset = event?.getAd?.()?.getAdPodInfo?.()?.getTimeOffset?.();
    } catch {
      offset = undefined;
    }
    return isNumber(offset) && offset >= 0 ? cuts.find((cut) => Math.abs(cut.at - offset) < 1) ?? null : null;
  };
  // A failure without an ad: IMA prefetches a break before its time and only plays breaks
  // later than the latest one that started or failed.
  function failedCut(event) {
    const fromAd = podCut(event);
    if (fromAd) return fromAd;
    if (!played && cuts[0]?.at === 0) return cuts[0];
    let settled = -1;
    cuts.forEach((cut, index) => {
      if (startedCuts.has(cut.id) || failedCuts.has(cut.id)) settled = index;
    });
    const candidates = cuts.slice(settled + 1);
    const time = Number(video.currentTime) || 0;
    return candidates.filter((cut) => cut.at <= time + 1).at(-1) ?? candidates[0] ?? null;
  }
  function clearBreakShop() {
    breakShop.token++;
    breakShop.abort?.abort();
    breakShop.abort = null;
    // A viewer who opened the product keeps it when the ad ends: the purchase is not taken away mid-choice.
    if (breakShop.id && !disposed && session.holding?.(breakShop.id)) keepOpen(breakShop.id);
    else if (breakShop.id) session.removeCue(breakShop.id);
    breakShop.id = null;
  }
  function keepOpen(id) {
    if (breakShop.kept && breakShop.kept !== id) {
      session.removeCue(breakShop.kept);
      session.closeProduct?.(breakShop.kept);
    }
    breakShop.kept = id;
    breakShop.poll ??= setInterval(checkKept, 250);
  }
  // Once the viewer closes the product (or goes back), its card goes and the content held for it resumes.
  function checkKept() {
    if (!disposed && breakShop.kept && session.holding?.(breakShop.kept)) return;
    releaseHeld(true);
  }
  // The end of the held time: by the viewer closing the product (resume), or by a new break (no resume: the new break
  // owns the content). The content playing under the panel only ends the wait (hostPlayed).
  function releaseHeld(resumeContent) {
    clearInterval(breakShop.poll);
    breakShop.poll = null;
    video.removeEventListener('play', hostPlayed);
    if (breakShop.kept) {
      session.removeCue(breakShop.kept);
      session.closeProduct?.(breakShop.kept);
    }
    breakShop.kept = null;
    const deferred = breakShop.deferred;
    breakShop.deferred = null;
    if (!deferred || disposed) return;
    emitBreak('content_released', deferred.cut);
    if (resumeContent) deferred.resume();
  }
  // The content moving on under the held panel (the host or the viewer pressed play) only ends the wait: nothing is
  // resumed twice, and the panel stays until the viewer closes it.
  function hostPlayed() {
    const deferred = breakShop.deferred;
    if (!deferred) return;
    breakShop.deferred = null;
    video.removeEventListener('play', hostPlayed);
    emitBreak('content_released', deferred.cut);
  }
  // The break ends on time: its event, the session leaving the break. Only resuming the content waits for a product
  // the viewer has open; the host is told (`held` on the event, then `content_held` and `content_released`).
  function finishBreak(type, cut, resumeContent) {
    clearBreakShop();
    const held = !disposed && !!breakShop.kept;
    emitBreak(type, cut, held ? { held: true } : undefined);
    const wasOpen = endBreak();
    if (!held) return resumeContent(wasOpen);
    breakShop.deferred = { cut, resume: () => resumeContent(wasOpen) };
    emitBreak('content_held', cut);
    video.addEventListener('play', hostPlayed);
  }
  // One ad of the break started: the session is told which, and the card of exactly this delivery is asked for.
  async function shopAdStarted(event, cut, request) {
    clearBreakShop();
    if (disposed || !inBreak) return;
    let identity = null;
    let tag = null;
    try {
      const ad = event?.getAd?.();
      const match = SHOP_AD.exec(ad?.getAdId?.() ?? '');
      const creativeId = ad?.getCreativeId?.();
      tag = request?.provider === 'iadserver' ? new URL(request.tagUrl).searchParams.get('tag') : null;
      if (breakUrl && match && match[1] === cut?.position && tag && typeof creativeId === 'string' && creativeId)
        identity = { creativeId, deliveryId: match[2] };
    } catch {
      identity = null;
    }
    // Each ad of a break closes the product kept from the one before, never its own.
    session.closeProduct?.(undefined, identity?.deliveryId);
    // A spot without a shop changes nothing unless the one before it had one.
    if (identity || breakShop.spot) session.setLinearAd(true, identity ?? undefined);
    breakShop.spot = !!identity;
    if (!identity) return;
    const token = breakShop.token;
    const abort = new AbortController();
    breakShop.abort = abort;
    const timeout = setTimeout(() => abort.abort(), PRODUCT_TIMEOUT_MS);
    try {
      const extra = new URLSearchParams({ cut: cut.id, tag, creative: identity.creativeId, delivery: identity.deliveryId,
        locale: commerceLocale(session.commerce.locale ?? globalThis.navigator?.language) });
      const res = await fetchImpl(withParams(breakUrl, extra), { signal: abort.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      if (res.status !== 200) return;
      const card = await res.json();
      if (disposed || token !== breakShop.token || card?.id !== identity.deliveryId ||
          card?.linearCreativeId !== identity.creativeId || card?.format !== 'midroll') return;
      // The ad decides how long it lasts: the card follows it, whatever the clock of the paused content says.
      if (session.addCue({ ...card, start: 0, end: Number.MAX_SAFE_INTEGER })) breakShop.id = identity.deliveryId;
    } catch {
      // Without the card the ad simply plays.
    } finally {
      clearTimeout(timeout);
      if (breakShop.abort === abort) breakShop.abort = null;
    }
  }
  function shopAdEnded() {
    clearBreakShop();
    if (!disposed && inBreak && breakShop.spot) session.setLinearAd(true);
    breakShop.spot = false;
  }
  function watchShopAds(manager, sdk, started) {
    // Each ad of a pod starts at the viewer's current volume.
    manager.addEventListener(sdk.AdEvent.Type.STARTED, syncAdVolume);
    for (const name of ['COMPLETE', 'SKIPPED', 'USER_CLOSE']) {
      if (sdk.AdEvent.Type[name]) manager.addEventListener(sdk.AdEvent.Type[name], shopAdEnded);
    }
    manager.addEventListener(sdk.AdEvent.Type.STARTED, started);
  }
  function endBreak() {
    clearBreakShop();
    breakShop.spot = false;
    clearTimeout(ima.watchdog);
    if (!inBreak) return false;
    inBreak = false;
    stage?.classList?.remove('il-ad-playing');
    session.setLinearAd(false);
    return true;
  }
  // IMA plays in its own element, which does not follow the content's volume. With custom playback the ad uses the
  // content element itself, whose volume is already the viewer's and must not be overwritten.
  function syncAdVolume() {
    try {
      if (ima.manager && !ima.manager.isCustomPlaybackUsed?.()) ima.manager.setVolume?.(video.muted ? 0 : video.volume);
    } catch {
      // A manager that refuses the volume keeps playing.
    }
  }
  function startManager() {
    if (!ima.manager || !ima.started || ima.running) return;
    ima.running = true;
    try {
      ima.manager.init(video.clientWidth || 640, video.clientHeight || 360, ima.sdk.ViewMode.NORMAL);
      syncAdVolume();
      ima.manager.start();
    } catch {
      emitBreak('break_error', null);
      if (endBreak()) resume();
    }
  }
  function adError() {
    if (disposed) return;
    const playing = inBreak;
    const cut = playing ? ima.cut ?? cutOf(null) : failedCut(null);
    ima.cut = null;
    if (playing) {
      if (cut) failedCuts.add(cut.id);
      return finishBreak('break_error', cut, (wasOpen) => {
        if (wasOpen) resume();
      });
    }
    if (!cut || failedCuts.has(cut.id)) return;
    failedCuts.add(cut.id);
    emitBreak('break_error', cut);
  }
  // With ad rules IMA reports a break it could not fetch, or an empty one, without AD_ERROR.
  function breakFailed(event) {
    if (disposed || inBreak) return;
    const cut = failedCut(event);
    if (!cut || failedCuts.has(cut.id)) return;
    failedCuts.add(cut.id);
    emitBreak('break_error', cut);
  }
  // An ad played in the same <video> also fires `ended`; only the content's end counts.
  const contentEnded = () => {
    if (inBreak) return;
    ima.loader?.contentComplete?.();
    // A cut in the last seconds may be dropped here; the backend does not produce post-rolls.
    if (wf.cut && wf.phase !== 'running') cancelAttempt();
  };
  const resized = () => {
    try {
      ima.manager?.resize(video.clientWidth || 640, video.clientHeight || 360, ima.sdk.ViewMode.NORMAL);
    } catch {
      // A failed resize leaves the ad at its previous size.
    }
  };
  function destroyManager() {
    try {
      ima.manager?.destroy?.();
    } catch {
      // Tearing down IMA must not throw into the host.
    }
    ima.manager = null;
  }

  const emitWalk = (type, cut, index) => {
    try {
      onEvent?.({ type, cut: cut.id, provider: cut.requests[index].provider, attempt: index + 1 });
    } catch {
      // Diagnostics must never break playback.
    }
  };
  function clearWalkTimers() {
    clearTimeout(wf.timer);
    clearTimeout(wf.holdTimer);
    wf.timer = wf.holdTimer = null;
  }
  // The single exit of a break in the walk: one break_end or break_error, then content resumes.
  function settle(type) {
    const cut = wf.cut;
    if (!cut) return;
    settledCuts.add(cut.id);
    clearWalkTimers();
    wf.token++;
    wf.cut = null;
    wf.phase = 'idle';
    // A pause event of the module's own that never arrived must not swallow the viewer's next pause.
    wf.ownPause = false;
    const held = wf.held;
    wf.held = false;
    destroyManager();
    // Content resumes only if a break was open or the module itself held it for the pre-roll.
    const viewerPaused = wf.viewerPaused;
    wf.viewerPaused = false;
    // A viewer who paused while the module held the content is not overruled when the break ends.
    finishBreak(type, cut, (wasOpen) => {
      if ((wasOpen && !viewerPaused) || held) resumeWalk(cut);
    });
  }
  // The module's resume runs outside a gesture; a refused play() is reported so the host can show its control.
  function resumeWalk(cut) {
    const blocked = () => {
      if (!disposed) emitBreak('resume_blocked', cut);
    };
    try {
      void Promise.resolve(video.play?.()).catch(blocked);
    } catch {
      blocked();
    }
  }
  // The 8 s cap is for content held with no ad on its way: an ad IMA is starting keeps its attempt guard,
  // and a spent budget only ends the break once that ad fails.
  function armHold(cut) {
    if (wf.holdTimer) return;
    wf.holdTimer = setTimeout(() => {
      if (disposed || wf.cut !== cut || wf.started) return;
      if (wf.adComing) wf.holdSpent = true;
      else settle('break_error');
    }, HOLD_MS);
  }
  // The pause the module causes is told apart from the viewer's, which ends the module's hold.
  function walkPaused() {
    if (wf.ownPause) wf.ownPause = false;
    else if (!inBreak && wf.held) {
      wf.held = false;
      wf.viewerPaused = true;
    }
  }
  // Every cut already behind the playhead when the view joins is settled without an event.
  function settleBehind() {
    const time = Number(video.currentTime) || 0;
    if (time > 1) for (const cut of cuts) if (cut.at <= time) settledCuts.add(cut.id);
  }
  // A host that plays right after start() would run content under the pre-roll's requests.
  function holdPreroll(cut) {
    if (video.paused === false) {
      wf.held = true;
      wf.viewerPaused = false;
      wf.ownPause = true;
      video.pause?.();
    }
    if (wf.held) armHold(cut);
  }
  // Drops an attempt that has not started playing, without settling its cut.
  function cancelAttempt() {
    wf.ownPause = false;
    const cut = wf.cut;
    clearWalkTimers();
    wf.token++;
    wf.cut = null;
    wf.phase = 'idle';
    destroyManager();
    if (wf.held) {
      wf.held = false;
      resumeWalk(cut);
    }
  }
  function ask(cut, index) {
    if (expired()) return;
    const token = ++wf.token;
    Object.assign(wf, { cut, index, phase: 'asking' });
    clearTimeout(wf.timer);
    emitWalk('break_request', cut, index);
    const request = new ima.sdk.AdsRequest();
    const url = new URL(cut.requests[index].tagUrl);
    url.searchParams.set('correlator', correlator());
    request.adTagUrl = url.href;
    if (page) request.pageUrl = page;
    request.vastLoadTimeout = ATTEMPT_MS;
    request.linearAdSlotWidth = video.clientWidth || 640;
    request.linearAdSlotHeight = video.clientHeight || 360;
    request.nonLinearAdSlotWidth = request.linearAdSlotWidth;
    request.nonLinearAdSlotHeight = 150;
    wf.timer = setTimeout(() => attemptFailed(token), ATTEMPT_MS);
    try {
      ima.loader.requestAds(request, { token });
    } catch {
      attemptFailed(token);
    }
  }
  // An empty answer, an error, a hung attempt or a resume before the ad started.
  function attemptFailed(token) {
    if (disposed || token !== wf.token || !wf.cut) return;
    const { cut, index } = wf;
    if (wf.started || index + 1 >= cut.requests.length) {
      if (!wf.started) emitWalk('break_no_fill', cut, index);
      return settle('break_error');
    }
    emitWalk('break_no_fill', cut, index);
    wf.adComing = false;
    if (wf.holdSpent) return settle('break_error');
    destroyManager();
    // Content stays paused if IMA already paused it; the hold timer keeps running.
    ask(cut, index + 1);
  }
  function play() {
    if (expired()) return;
    const token = wf.token;
    wf.phase = 'running';
    clearTimeout(wf.timer);
    wf.timer = setTimeout(() => attemptFailed(token), ATTEMPT_MS);
    try {
      ima.manager.init(video.clientWidth || 640, video.clientHeight || 360, ima.sdk.ViewMode.NORMAL);
      syncAdVolume();
      ima.manager.start();
    } catch {
      attemptFailed(token);
    }
  }
  function beginBreak(cut) {
    if (inBreak) return;
    // A product still held from an earlier break gives way: its deferred end never touches this one.
    if (breakShop.deferred || breakShop.kept) releaseHeld(false);
    nativePausedContent = video.paused === false;
    video.pause?.();
    inBreak = true;
    stage?.classList?.add('il-ad-playing');
    updateOverlay(now());
    session.setLinearAd(true);
    emitBreak('break_start', cut);
    clearTimeout(ima.watchdog);
    ima.watchdog = setTimeout(() => {
      if (!disposed && inBreak) settle('break_error');
    }, BREAK_WATCHDOG_MS);
  }
  // Picks the break to ask for: the last unsettled one already due (the pre-roll is due at start()),
  // otherwise the next one within the lead once content has played.
  function schedule(time) {
    if (!waterfall || disposed || !ima.loader || !ima.started || inBreak || wf.phase === 'running') return;
    const due = cuts.filter((cut) => !settledCuts.has(cut.id) && cut.at <= time);
    for (const cut of due.slice(0, -1)) settledCuts.add(cut.id);
    const target = due.at(-1) ??
      (played ? cuts.find((cut) => !settledCuts.has(cut.id) && cut.at > time && ms(cut.at - time) <= WALK_LEAD_MS) : null) ?? null;
    if (wf.cut && wf.cut !== target) cancelAttempt();
    if (!target) return;
    if (!wf.cut) {
      Object.assign(wf, { dueAt: null, started: false, adComing: false, holdSpent: false, viewerPaused: false });
      ask(target, 0);
    }
    if (target.at > time) return;
    wf.dueAt ??= time;
    if (target.at === 0) holdPreroll(target);
    if (wf.phase === 'loaded') play();
    else if (target.at === 0) return;
    else if (ms(time - wf.dueAt) > LATE_MS) settle('break_error');
  }
  function walkLoaded(event) {
    const token = event.getUserRequestContext?.()?.token;
    const manager = event.getAdsManager(video);
    if (disposed || expired() || token !== wf.token || wf.phase !== 'asking') {
      try {
        manager?.destroy?.();
      } catch {
        // A late manager is simply dropped.
      }
      return;
    }
    destroyManager();
    ima.manager = manager;
    const sdk = ima.sdk;
    const fail = () => attemptFailed(token);
    manager.addEventListener(sdk.AdErrorEvent.Type.AD_ERROR, fail);
    manager.addEventListener(sdk.AdEvent.Type.CONTENT_PAUSE_REQUESTED, () => {
      if (disposed || token !== wf.token) return;
      const cut = wf.cut;
      beginBreak(cut);
      if (wf.started) return;
      // An ad was found and is starting: it gets the attempt guard to STARTED.
      wf.adComing = true;
      clearTimeout(wf.timer);
      wf.timer = setTimeout(() => attemptFailed(token), ATTEMPT_MS);
      armHold(cut);
    });
    manager.addEventListener(sdk.AdEvent.Type.STARTED, () => {
      if (disposed || token !== wf.token) return;
      wf.started = true;
      clearTimeout(wf.timer);
      clearTimeout(wf.holdTimer);
    });
    watchShopAds(manager, sdk, (event) => {
      if (!disposed && token === wf.token) void shopAdStarted(event, wf.cut, wf.cut?.requests[wf.index]);
    });
    if (sdk.AdEvent.Type.ALL_ADS_COMPLETED) manager.addEventListener(sdk.AdEvent.Type.ALL_ADS_COMPLETED, () => {
      if (ima.manager === manager) destroyManager();
    });
    manager.addEventListener(sdk.AdEvent.Type.CONTENT_RESUME_REQUESTED, () => {
      if (disposed || token !== wf.token) return;
      if (!wf.started) return fail();
      settle('break_end');
    });
    clearTimeout(wf.timer);
    wf.phase = 'loaded';
    if (wf.dueAt != null) play();
  }

  async function setUpIma() {
    try {
      await loadScript(IMA_URL);
      const sdk = globalThis.google?.ima;
      if (disposed || expired() || ima.gaveUp) return;
      if (!sdk) reject('ima_unavailable');
      clearTimeout(ima.loadTimer);
      ima.sdk = sdk;
      // Joining late: a pre-roll would interrupt content already under way.
      const playable = (Number(video.currentTime) || 0) > 1 ? cuts.filter((cut) => cut.at > 0) : cuts;
      if (!playable.length) return;
      ima.display = new sdk.AdDisplayContainer(adContainer, video);
      if (ima.started) ima.display.initialize();
      ima.loader = new sdk.AdsLoader(ima.display);
      if (waterfall) {
        // Nothing is requested before start(); the pre-roll of a late join is settled silently.
        settleBehind();
        ima.loader.addEventListener(sdk.AdErrorEvent.Type.AD_ERROR, (event) => {
          const context = event?.getUserRequestContext?.();
          // Without a context the error cannot be matched; the attempt guard covers a lost answer.
          if (context) attemptFailed(context.token);
        });
        ima.loader.addEventListener(sdk.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, walkLoaded);
        video.addEventListener('ended', contentEnded);
        if (typeof globalThis.ResizeObserver === 'function') {
          ima.observer = new globalThis.ResizeObserver(resized);
          ima.observer.observe(video);
        }
        schedule(Number(video.currentTime) || 0);
        return;
      }
      ima.loader.addEventListener(sdk.AdErrorEvent.Type.AD_ERROR, adError);
      ima.loader.addEventListener(sdk.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, (event) => {
        if (disposed) return;
        const manager = event.getAdsManager(video);
        ima.manager = manager;
        manager.addEventListener(sdk.AdErrorEvent.Type.AD_ERROR, adError);
        manager.addEventListener(sdk.AdEvent.Type.CONTENT_PAUSE_REQUESTED, (e) => {
          if (disposed) return;
          if (breakShop.deferred || breakShop.kept) releaseHeld(false);
          stage?.classList?.add('il-ad-playing');
          ima.cut = cutOf(e);
          if (ima.cut) startedCuts.add(ima.cut.id);
          video.pause?.();
          inBreak = true;
          updateOverlay(now());
          session.setLinearAd(true);
          emitBreak('break_start', ima.cut);
          clearTimeout(ima.watchdog);
          ima.watchdog = setTimeout(() => {
            if (!disposed && inBreak) adError();
          }, BREAK_WATCHDOG_MS);
        });
        watchShopAds(manager, sdk, (event) => {
          if (!disposed) void shopAdStarted(event, ima.cut, ima.cut?.requests[0]);
        });
        if (sdk.AdEvent.Type.AD_BREAK_FETCH_ERROR) manager.addEventListener(sdk.AdEvent.Type.AD_BREAK_FETCH_ERROR, breakFailed);
        if (sdk.AdEvent.Type.LOG) manager.addEventListener(sdk.AdEvent.Type.LOG, (e) => {
          let data;
          try {
            data = e?.getAdData?.();
          } catch {
            data = null;
          }
          if (data?.adError) breakFailed(e);
        });
        if (sdk.AdEvent.Type.ALL_ADS_COMPLETED) manager.addEventListener(sdk.AdEvent.Type.ALL_ADS_COMPLETED, () => {
          if (ima.manager === manager) destroyManager();
        });
        manager.addEventListener(sdk.AdEvent.Type.CONTENT_RESUME_REQUESTED, () => {
          if (disposed) return;
          const cut = ima.cut;
          ima.cut = null;
          finishBreak('break_end', cut, () => resume());
        });
        startManager();
      });
      video.addEventListener('ended', contentEnded);
      if (typeof globalThis.ResizeObserver === 'function') {
        ima.observer = new globalThis.ResizeObserver(resized);
        ima.observer.observe(video);
      }
      const request = new sdk.AdsRequest();
      request.adsResponse = buildVmap(playable);
      if (page) request.pageUrl = page;
      request.linearAdSlotWidth = video.clientWidth || 640;
      request.linearAdSlotHeight = video.clientHeight || 360;
      request.nonLinearAdSlotWidth = request.linearAdSlotWidth;
      request.nonLinearAdSlotHeight = 150;
      ima.loader.requestAds(request);
    } catch {
      // Without IMA the content simply plays without breaks.
      if (!disposed) emitBreak('break_error', null);
    }
  }

  // With a stitched clock, while anything the module drew is on screen it is re-checked on every frame
  // (video frames where the browser reports them), not only on video events, so an ad never shows under it.
  const frames = { id: null, video: false };
  const drawing = () => overlay.live || [...cues.values()].some((cue) => cue.onScreen);
  function guard() {
    frames.id = null;
    if (disposed) return;
    // An ad on screen, or the end of what is showing, is acted on in this frame rather than at the next video event.
    const time = now();
    const ends = [...cues.values()].filter((cue) => cue.onScreen).map((cue) => cue.end);
    if (overlay.live) ends.push(overlay.live.window.end);
    if (time == null || time >= Math.min(...ends)) sync();
    watch();
  }
  function watch() {
    if (!stitched || disposed || frames.id != null || !drawing()) return;
    if (typeof video.requestVideoFrameCallback === 'function' && video.paused === false) {
      frames.video = true;
      frames.id = video.requestVideoFrameCallback(guard);
    } else if (typeof globalThis.requestAnimationFrame === 'function') {
      frames.video = false;
      frames.id = globalThis.requestAnimationFrame(guard);
    }
  }
  function unwatchFrames() {
    if (frames.id == null) return;
    if (frames.video) video.cancelVideoFrameCallback?.(frames.id);
    else globalThis.cancelAnimationFrame?.(frames.id);
    frames.id = null;
  }

  for (const name of VIDEO_EVENTS) video.addEventListener(name, sync);
  // A clock that knows when the fragment changes (an ad starting while paused, say) re-checks at once.
  const unwatch = typeof content.onChange === 'function' ? content.onChange(() => sync()) : null;
  // Other content loaded into the host's hls.js closes a product kept from the old content.
  const unwatchMedia = typeof content.onMediaChange === 'function' ? content.onMediaChange(() => session.closeProduct?.()) : null;
  // A hidden page gets no frame callbacks, so a stitched ad can start under a card kept on it. visibilitychange is
  // dispatched in the task that makes the page visible, before its next rendering (and before any frame callback),
  // so the check run here removes the card before a frame over the ad can be painted.
  const visibilityTarget = stitched ? video.ownerDocument ?? stage?.ownerDocument ?? globalThis.document : null;
  const onVisibility = () => {
    if (!disposed) sync();
  };
  visibilityTarget?.addEventListener?.('visibilitychange', onVisibility);
  if (waterfall) {
    settleBehind();
    // `play` comes before `playing`, so the pre-roll hold pauses before any content is heard.
    video.addEventListener('play', sync);
    video.addEventListener('pause', walkPaused);
  }
  if (useIma) video.addEventListener('volumechange', syncAdVolume);
  if (useIma) void setUpIma();
  function expired() {
    if (!native || Date.now() < Date.parse(valid.expires_at)) return false;
    if (!disposed) {
      const resumeContent = inBreak && nativePausedContent && !wf.viewerPaused;
      api.destroy();
      if (resumeContent) resumeWalk(null);
      try { onEvent?.({ type: 'plan_expired' }); } catch { /* diagnostics cannot interrupt playback */ }
    }
    return true;
  }
  const api = {
    cuts,
    // Native revisions are requested just in time. A VMAP would retain future tags past expiry.
    vmap: () => buildVmap(native ? [] : cuts),
    setBreaks(seconds) {
      if (disposed || !scenes || !Array.isArray(seconds)) return;
      windows = usableWindows({ scenes, cuts: seconds.filter(isNumber).map((at) => ({ at })) });
      sync();
    },
    setBreakActive(active) {
      if (disposed) return;
      // A new break closes a product the viewer kept from before (see session.setLinearAd).
      if (active && !hostBreak) session.closeProduct?.();
      hostBreak = Boolean(active);
      updateOverlay(now());
      sync();
    },
    start() {
      if (disposed || expired() || !useIma || ima.started) return;
      ima.started = true;
      if (!ima.sdk) {
        ima.loadTimer = setTimeout(() => {
          if (disposed || ima.sdk) return;
          ima.gaveUp = true;
          emitBreak('break_error', null);
        }, IMA_LOAD_TIMEOUT_MS);
      }
      // IMA needs this inside the viewer's play gesture.
      try {
        ima.display?.initialize();
      } catch {
        // A failed initialisation surfaces later as an ad error.
      }
      if (waterfall) {
        // Cuts at or behind a resume position set before the first start() are a late join.
        if (!wf.begun) settleBehind();
        wf.begun = true;
        schedule(Number(video.currentTime) || 0);
      }
      else startManager();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      clearTimeout(expiryTimer);
      breakShop.deferred = null;
      releaseHeld(false);
      clearWalkTimers();
      wf.token++;
      // The host loses the module: content the module was holding is given back, without an event.
      if (wf.held) {
        wf.held = false;
        resume();
      }
      video.removeEventListener('play', sync);
      video.removeEventListener('pause', walkPaused);
      video.removeEventListener('volumechange', syncAdVolume);
      for (const name of VIDEO_EVENTS) video.removeEventListener(name, sync);
      if (typeof unwatch === 'function') unwatch();
      if (typeof unwatchMedia === 'function') unwatchMedia();
      unwatchFrames();
      visibilityTarget?.removeEventListener?.('visibilitychange', onVisibility);
      video.removeEventListener('ended', contentEnded);
      clearTimeout(ima.loadTimer);
      ima.observer?.disconnect();
      for (const part of [ima.manager, ima.loader, ima.display]) {
        try {
          part?.destroy?.();
        } catch {
          // Tearing down IMA must not throw into the host.
        }
      }
      ima.manager = ima.loader = ima.display = null;
      endBreak();
      dropSlot();
      overlay.node?.remove();
      if (overlay.gpt) {
        gptQueue(() => {
          try {
            overlay.gpt.pubads().removeEventListener?.('slotRenderEnded', onRender);
            overlay.gpt.pubads().removeEventListener?.('impressionViewable', onViewable);
          } catch {
            // GPT may already be gone.
          }
        });
      }
      controller?.abort();
      controller = null;
      productController?.abort();
      productController = null;
      for (const [id, cue] of cues) if (cue.onScreen) session.removeCue(id);
      cues.clear();
    },
  };
  if (native) {
    expiryTimer = setTimeout(expired, Math.max(0, Date.parse(valid.expires_at) - Date.now()));
    expiryTimer.unref?.();
  }
  sync();
  return api;
}

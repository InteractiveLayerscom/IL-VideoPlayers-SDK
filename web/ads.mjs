// Optional ads module. Hosts import it only when the backend returned an ad plan,
// so a player without a plan never loads ad-server code.

export const PREPARE_MS = 4000;
const REQUEST_TIMEOUT_MS = 4000;
const MIN_START_SPACING_MS = 30000;
const SDK_FORMATS = { super: 'super', l_shape: 'l' };
// The SDK's Super uses 75% x 20% of a 16:9 surface; L uses a full 16:9 canvas.
const SHAPES = { super: 20 / 3, l_shape: 16 / 9 };
const VIDEO_EVENTS = ['playing', 'pause', 'timeupdate', 'seeking', 'seeked', 'ended'];

const inert = Object.freeze({ destroy() {} });
const ms = (seconds) => Math.round(seconds * 1000);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function reject(reason) {
  throw new Error(reason);
}

function readPlan(plan, now) {
  const scenes = plan?.scenes;
  const pacing = scenes?.pacing;
  const expires = typeof plan?.expires_at === 'string' ? Date.parse(plan.expires_at) : NaN;
  if (
    plan?.version !== 1 ||
    !(expires > now) ||
    !Array.isArray(scenes?.formats) ||
    !Array.isArray(scenes.windows) ||
    !isNumber(pacing?.min_seconds) ||
    (pacing.max_seconds != null && !isNumber(pacing.max_seconds)) ||
    (pacing.gap_after_seconds != null && !isNumber(pacing.gap_after_seconds)) ||
    (pacing.cut_clearance_seconds != null && !isNumber(pacing.cut_clearance_seconds)) ||
    (pacing.max_per_video != null && !Number.isInteger(pacing.max_per_video))
  )
    return null;
  return plan;
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
export function usableWindows(plan) {
  const { pacing, windows } = plan.scenes;
  const clearance = ms(pacing.cut_clearance_seconds ?? 0);
  const breaks = (Array.isArray(plan.cuts) ? plan.cuts : []).map((cut) => cut?.at).filter(isNumber).map(ms);
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
  url.searchParams.set('correlator', String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0'));
  if (pageUrl) {
    url.searchParams.set('url', pageUrl);
    url.searchParams.set('description_url', pageUrl);
  }
  return url.href;
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

export function attachAds({ session, video, plan, pageUrl, fetchImpl = globalThis.fetch, onEvent } = {}) {
  const valid = session && video && typeof fetchImpl === 'function' ? readPlan(plan, Date.now()) : null;
  if (!valid) return inert;
  const formats = servableFormats(valid.scenes);
  const windows = usableWindows(valid);
  const { pacing } = valid.scenes;
  const minMs = ms(pacing.min_seconds);
  const page = pageUrl ?? valid.page_url;
  const attempted = new Set();
  const shown = [];
  const cues = new Map();
  let controller = null;
  let disposed = false;

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
  const now = () => Math.round((Number(video.currentTime) || 0) * 1000);

  function draw(window, format, ad) {
    const id = 'il-ads-' + window.id;
    let measured = false;
    const added = session.addCue({
      id,
      format: SDK_FORMATS[format],
      start: window.start,
      end: window.end,
      imageUrl: ad.imageUrl,
      mimeType: ad.mimeType,
      ...(ad.clickUrl ? { clickUrl: ad.clickUrl } : {}),
    }, {
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
    });
    if (added) cues.set(id, window.end);
  }

  async function request(window) {
    attempted.add(window.id);
    const { format, tagUrl } = formats[shown.length % formats.length];
    const abort = new AbortController();
    controller = abort;
    const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = graphicTag(tagUrl, format, window.targeting, page);
      emit('request', format, window);
      const res = await fetchImpl(url, { signal: abort.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      if (!res.ok) reject('graphic_vast_http_error');
      const ad = parseGraphicVast(await res.text(), format, window.end - Math.max(window.start, now()));
      if (disposed || abort.signal.aborted) return;
      if (!ad) return emit('no_fill', format, window);
      if (now() >= window.end) return;
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

  function sync() {
    if (disposed) return;
    const time = now();
    for (const [id, end] of cues) {
      if (time < end) continue;
      cues.delete(id);
      session.removeCue(id);
    }
    if (controller || !formats.length) return;
    const next = windows.find((window) => !attempted.has(window.id) &&
      window.start - PREPARE_MS <= time && time < window.end &&
      window.end - Math.max(window.start, time) >= minMs && pacingAllows(window, shown, pacing));
    if (next) void request(next);
  }

  for (const name of VIDEO_EVENTS) video.addEventListener(name, sync);
  sync();
  return {
    destroy() {
      if (disposed) return;
      disposed = true;
      for (const name of VIDEO_EVENTS) video.removeEventListener(name, sync);
      controller?.abort();
      controller = null;
      for (const id of cues.keys()) session.removeCue(id);
      cues.clear();
    },
  };
}

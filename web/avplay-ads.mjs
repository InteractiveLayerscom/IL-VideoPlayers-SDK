// IL's ad plan on Samsung AVPlay. Graphics, products and pacing are web/ads.mjs through a video-shaped
// view of AVPlay; this file adds what IMA does on the web: ordered requests per break and linear playback.
import { attachAds } from './ads.mjs';

const ATTEMPT_MS = 5000;
const HOLD_MS = 8000;
const LATE_MS = 2000;
const BREAK_WATCHDOG_MS = 120000;
const MAX_WRAPPERS = 3;
const TICK_MS = 250;
const PREPARE_MS = 8000;
const REOPEN_MS = 15000;
// No ad holds the content longer than this, whatever its VAST declares.
const AD_CAP_MS = 180000;
const WATCH_STEP_MS = 500;
const SCRUB_MARGIN_MS = 1500;
const QUARTILES = [['firstQuartile', 0.25], ['midpoint', 0.5], ['thirdQuartile', 0.75]];

const https = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
};
const named = (node, tag) => Array.from(node.getElementsByTagName(tag));
const texts = (node, tag) => named(node, tag).map((el) => https(el.textContent.trim())).filter(Boolean);

function trackingOf(node) {
  const events = {};
  for (const el of named(node, 'Tracking')) {
    const url = https(el.textContent.trim());
    const event = el.getAttribute('event');
    if (url && event) (events[event] ??= []).push(url);
  }
  return events;
}

function seconds(value) {
  const match = /^(\d{2}):([0-5]\d):([0-5]\d(?:\.\d{1,3})?)$/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

// The MP4 a TV decoder can open: progressive, HTTPS, the widest offered up to 1080p.
function mediaOf(linear) {
  const files = named(linear, 'MediaFile')
    .filter((el) => el.getAttribute('delivery') === 'progressive' && el.getAttribute('type')?.toLowerCase() === 'video/mp4')
    .map((el) => ({ url: https(el.textContent.trim()), width: Number(el.getAttribute('width')) || 0 }))
    .filter((file) => file.url && file.width <= 1920)
    .sort((a, b) => b.width - a.width);
  return files[0]?.url ?? null;
}

// Follows wrappers and returns the first playable linear ad, or null when the answer has none.
export async function fetchLinearAd(tagUrl, { fetchImpl, Parser, signal }) {
  const collected = { impressions: [], tracking: {} };
  let url = tagUrl;
  for (let hop = 0; hop <= MAX_WRAPPERS; hop++) {
    const response = await fetchImpl(url, { signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) return null;
    const xml = await response.text();
    if (typeof xml !== 'string' || xml.length > 262144 || /<!DOCTYPE/i.test(xml)) return null;
    const doc = new Parser().parseFromString(xml, 'application/xml');
    if (doc.documentElement.localName !== 'VAST' || doc.getElementsByTagName('parsererror').length) return null;
    const ad = named(doc, 'Ad')[0];
    if (!ad) return null;
    collected.impressions.push(...texts(ad, 'Impression'));
    for (const [event, urls] of Object.entries(trackingOf(ad))) (collected.tracking[event] ??= []).push(...urls);
    const wrapper = named(ad, 'Wrapper')[0];
    if (wrapper) {
      url = https(named(wrapper, 'VASTAdTagURI')[0]?.textContent.trim());
      if (!url) return null;
      continue;
    }
    const linear = named(ad, 'Linear')[0];
    const mediaUrl = linear && mediaOf(linear);
    if (!mediaUrl) return null;
    const shop = named(ad, 'Extension').find((el) => el.getAttribute('type') === 'iADServerShop');
    const node = shop && named(shop, 'Shop')[0];
    const identity = node?.getAttribute('creativeId') && node.getAttribute('deliveryId')
      ? { creativeId: node.getAttribute('creativeId'), deliveryId: node.getAttribute('deliveryId') } : null;
    return { ...collected, mediaUrl, duration: seconds(named(linear, 'Duration')[0]?.textContent), identity };
  }
  return null;
}

const CONSENT_KEYS = ['gdpr', 'gdpr_consent', 'us_privacy', 'gpp', 'gpp_sid'];

// Buy during a break, as web/ads.mjs decides it: IL's grant names the plan's session, so only when the sid
// (the host's view id, else that session) is the plan's session, on the plan's origin.
function breakShopAllowed(plan, planOrigin, sessionId) {
  const shopSession = plan?.commerce?.session;
  if (typeof shopSession !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(shopSession)) return false;
  try {
    if (new URL(plan.commerce.url).origin !== new URL(planOrigin).origin) return false;
  } catch {
    return false;
  }
  return (typeof sessionId === 'string' && sessionId ? sessionId : shopSession) === shopSession;
}

// `reopenContent(resumeAtMs)`: the host opens its content again after an ad (DRM, streaming properties,
// subtitles), prepares it and seeks; without it the SDK reopens `contentUrl`. `consent`: the TCF, US Privacy and GPP
// values ({ gdpr, gdpr_consent, us_privacy, gpp, gpp_sid }) the host's CMP holds, added to each break request.
export function attachAvPlayAds({
  avplay, session, plan, contentUrl, listener, getDisplayRect, pageUrl, fetchImpl = globalThis.fetch, onEvent,
  stage, clock, planOrigin, sessionId, Parser = globalThis.DOMParser, tickMs = TICK_MS, reopenContent, consent,
  isVisible = () => globalThis.document?.visibilityState !== 'hidden',
} = {}) {
  if (!avplay || !session || typeof getDisplayRect !== 'function') throw new Error('Provide avplay, the session and getDisplayRect');
  // This adapter owns a separate scheduler and has not implemented native plan renewal/expiry.
  if (plan?.version === 2) plan = null;
  const breakShop = breakShopAllowed(plan, planOrigin, sessionId);
  const handlers = new Map();
  let inBreak = false;
  let ended = false;
  let resumeAt = 0;
  const live = () => ['PLAYING', 'PAUSED'].includes(avplay.getState());
  const video = {
    get currentTime() {
      if (inBreak) return resumeAt / 1000;
      try {
        return live() ? avplay.getCurrentTime() / 1000 : 0;
      } catch {
        return 0;
      }
    },
    get paused() { return inBreak || avplay.getState() !== 'PLAYING'; },
    get ended() { return ended; },
    addEventListener(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
    },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
    play() { avplay.play(); },
    pause() { avplay.pause(); },
  };
  const dispatch = (type) => {
    for (const fn of [...(handlers.get(type) ?? [])]) fn({ type });
  };
  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {
      // Diagnostics must never break playback.
    }
  };
  const beacon = (urls) => {
    for (const url of urls ?? []) {
      try {
        void Promise.resolve(fetchImpl(url, { mode: 'no-cors', credentials: 'omit', keepalive: true })).catch(() => {});
      } catch {
        // A failed pixel never affects playback.
      }
    }
  };
  const ads = attachAds({ session, video, plan, pageUrl, fetchImpl, onEvent, stage, clock, planOrigin, sessionId });
  const cuts = ads.cuts;
  const settled = new Set();
  let disposed = false;
  let started = false;
  let timer = null;
  let abort = null;
  let finishAd = null;

  const applyRect = () => {
    const rect = getDisplayRect();
    avplay.setDisplayRect(rect.x, rect.y, rect.width, rect.height);
  };
  // A media file that never prepares fails here instead of holding the break.
  const prepare = () => new Promise((resolve, fail) => {
    const timeout = setTimeout(() => fail(new Error('prepare_timeout')), PREPARE_MS);
    avplay.prepareAsync(() => { clearTimeout(timeout); resolve(); }, (error) => { clearTimeout(timeout); fail(error); });
  });

  // One linear ad on the only AVPlay instance. Resolves true when it ran to its end without being dragged there.
  async function playAd(ad) {
    avplay.close();
    avplay.open(ad.mediaUrl);
    const fired = new Set();
    let watch;
    let counted = false;
    let scrubbed = false;
    let last = null;
    const finished = new Promise((resolve) => {
      finishAd = resolve;
      // Visible time only, up to the VAST duration plus 30 s (120 s when it has none).
      const limit = Math.min(ad.duration > 0 ? ad.duration * 1000 + 30000 : BREAK_WATCHDOG_MS, AD_CAP_MS);
      let used = 0;
      watch = setInterval(() => {
        if (isVisible()) used += WATCH_STEP_MS;
        if (used >= limit) resolve(false);
      }, WATCH_STEP_MS);
      avplay.setListener({
        oncurrentplaytime(ms) {
          // The first frame: impression, start and the Buy identity.
          if (!counted) {
            counted = true;
            beacon(ad.impressions);
            beacon(ad.tracking.start);
            session.setLinearAd(true, breakShop ? ad.identity ?? undefined : undefined);
          }
          const now = Date.now();
          if (last && ms - last.ms > now - last.at + SCRUB_MARGIN_MS) scrubbed = true;
          last = { ms, at: now };
          if (!(ad.duration > 0) || scrubbed) return;
          for (const [event, share] of QUARTILES) {
            if (ms / 1000 >= ad.duration * share && !fired.has(event)) {
              fired.add(event);
              beacon(ad.tracking[event]);
            }
          }
        },
        onstreamcompleted: () => resolve(true),
        onerror: () => resolve(false),
      });
    });
    try {
      applyRect();
      await prepare();
      if (disposed) return false;
      avplay.play();
      const complete = (await finished) && counted && !scrubbed;
      if (complete) beacon(ad.tracking.complete);
      return complete;
    } catch {
      return false;
    } finally {
      clearInterval(watch);
      finishAd = null;
    }
  }

  // After an ad the content is opened again where it stopped: by the host when it knows how (DRM, properties,
  // subtitles), otherwise from `contentUrl`.
  async function restoreContent() {
    avplay.close();
    if (typeof reopenContent === 'function') {
      // A host promise that never settles is reported as resume_blocked instead of holding the break.
      let timeout;
      try {
        await Promise.race([
          Promise.resolve().then(() => reopenContent(resumeAt)),
          new Promise((_, fail) => { timeout = setTimeout(() => fail(new Error('reopen_timeout')), REOPEN_MS); }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      return;
    }
    avplay.open(contentUrl);
    if (listener) avplay.setListener(listener);
    applyRect();
    await prepare();
    if (disposed) return;
    if (resumeAt > 0) await new Promise((resolve, fail) => avplay.seekTo(resumeAt, resolve, fail));
    avplay.play();
  }

  async function runBreak(cut, preroll) {
    settled.add(cut.id);
    const wasPlaying = avplay.getState() === 'PLAYING';
    resumeAt = live() ? avplay.getCurrentTime() : 0;
    if (wasPlaying) avplay.pause();
    inBreak = true;
    ads.setBreakActive(true);
    session.setLinearAd(true);
    emit({ type: 'break_start', cut: cut.id });
    const deadline = Date.now() + HOLD_MS;
    let ad = null;
    for (let index = 0; index < cut.requests.length && !ad && !disposed && Date.now() < deadline; index++) {
      const { provider, tagUrl } = cut.requests[index];
      emit({ type: 'break_request', cut: cut.id, provider, attempt: index + 1 });
      abort = new AbortController();
      const guard = setTimeout(() => abort.abort(), Math.min(ATTEMPT_MS, deadline - Date.now()));
      try {
        const url = new URL(tagUrl);
        url.searchParams.set('correlator', String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0'));
        for (const key of CONSENT_KEYS) {
          const value = consent?.[key];
          if ((typeof value === 'string' && value) || Number.isFinite(value)) url.searchParams.set(key, String(value));
        }
        ad = await fetchLinearAd(url.href, { fetchImpl, Parser, signal: abort.signal });
      } catch {
        ad = null;
      } finally {
        clearTimeout(guard);
      }
      if (!ad && !disposed) emit({ type: 'break_no_fill', cut: cut.id, provider, attempt: index + 1 });
    }
    if (disposed) return;
    const opened = !!ad;
    const complete = ad ? await playAd(ad) : false;
    if (disposed) return;
    let blocked = false;
    try {
      // The ad leaves AVPlay before graphics are allowed back.
      // A pre-roll before the first frame leaves opening the content to the host, once start() resolves.
      if (opened && (!preroll || wasPlaying)) await restoreContent();
      else if (opened && preroll) avplay.close();
      else if (wasPlaying) avplay.play();
    } catch {
      blocked = true;
    }
    if (disposed) return;
    session.setLinearAd(false);
    inBreak = false;
    ads.setBreakActive(false);
    emit({ type: complete ? 'break_end' : 'break_error', cut: cut.id });
    if (blocked) emit({ type: 'resume_blocked', cut: cut.id });
  }

  function tick() {
    if (disposed || inBreak) return;
    dispatch('timeupdate');
    if (!started || avplay.getState() !== 'PLAYING') return;
    const time = avplay.getCurrentTime();
    const due = cuts.filter((cut) => !settled.has(cut.id) && cut.at * 1000 <= time);
    for (const cut of due.slice(0, -1)) settled.add(cut.id);
    const cut = due.at(-1);
    if (!cut) return;
    if (cut.at > 0 && time - cut.at * 1000 > LATE_MS) settled.add(cut.id);
    else void runBreak(cut, false);
  }

  timer = setInterval(tick, tickMs);
  return {
    ads,
    cuts,
    // Call before opening content, or with it open. Resolves when the host may play.
    async start() {
      if (disposed || started) return;
      started = true;
      const position = live() ? avplay.getCurrentTime() : 0;
      let preroll = null;
      for (const cut of cuts) {
        if (cut.at === 0 && position <= 1000) preroll = cut;
        else if (cut.at * 1000 <= position) settled.add(cut.id);
      }
      if (preroll) await runBreak(preroll, true);
    },
    // The host's onstreamcompleted for the content.
    contentEnded() {
      ended = true;
      dispatch('ended');
    },
    tick,
    destroy() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      abort?.abort();
      finishAd?.(false);
      if (inBreak) {
        inBreak = false;
        session.setLinearAd(false);
        // The ad stops with the SDK: AVPlay is left closed for the host to open its content.
        try {
          avplay.stop?.();
          avplay.close();
        } catch {
          // A player already closed stays closed.
        }
      }
      ads.destroy();
    },
  };
}

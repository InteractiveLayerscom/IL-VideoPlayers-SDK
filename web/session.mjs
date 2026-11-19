import { commerceLocale } from './commerce.mjs';
import { normalizeCue, readDateRanges } from './cues.mjs';

export function createSession({
  clock,
  playing,
  renderer,
  eventsUrl,
  playlistUrl,
  sessionId,
  commerce,
  fetchImpl = globalThis.fetch,
  interval = 200,
  onVisible,
  refreshMs = eventsUrl ? 750 : 1500,
}) {
  if (eventsUrl && playlistUrl) throw new Error('Choose one source of graphics per session');
  if (eventsUrl && !sessionId) {
    if (globalThis.crypto?.randomUUID) sessionId = globalThis.crypto.randomUUID();
    else if (globalThis.crypto?.getRandomValues) {
      sessionId = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (n) =>
        n.toString(16).padStart(2, '0'),
      ).join('');
    } else throw new Error('Provide a playback session ID on this device');
  }
  const cues = new Map();
  const measured = new Set();
  let current = null,
    disposed = false,
    inBreak = false,
    pending,
    nextRead = 0,
    timer;

  function merge(items) {
    for (const cue of items) if (cue) cues.set(cue.id, cue);
  }

  function manifest(text) {
    if (!disposed && !eventsUrl) merge(readDateRanges(text));
  }

  async function refresh(time) {
    const controller = new AbortController();
    pending = controller;
    try {
      const url = new URL(eventsUrl || playlistUrl, globalThis.location?.href);
      if (eventsUrl) {
        url.searchParams.set('time', String(time));
        url.searchParams.set('sid', sessionId);
        if (commerce) {
          url.searchParams.set('commerce', '1');
          url.searchParams.set('locale', commerceLocale(commerce.locale));
          if (/^[A-Z]{2}$/.test(commerce.country)) url.searchParams.set('country', commerce.country);
        }
      }
      const res = await fetchImpl(url, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!res.ok) throw new Error('Cue source unavailable');
      const data = eventsUrl ? await res.json() : await res.text();
      if (disposed) return;
      if (eventsUrl) {
        cues.clear();
        if (Array.isArray(data)) merge(data.map(normalizeCue).filter(cue => commerce || !cue?.commerce));
      } else manifest(data);
    } catch {
      if (eventsUrl && !disposed) cues.clear();
    } finally {
      pending = null;
      // A slow response must not start a second request on this same tick.
      nextRead = Date.now() + refreshMs;
      if (!disposed) render(clock());
    }
  }

  function render(time) {
    const canShow = Number.isSafeInteger(time) && !inBreak && playing();
    let active = null;
    for (const [id, cue] of cues) {
      if (Number.isFinite(time) && cue.end < time - 120000) cues.delete(id);
      else if (!active && canShow && cue.start <= time && time < cue.end) active = cue;
    }
    if (active?.id !== current?.id) {
      if (current) renderer.hide();
      current = active;
      if (active)
        renderer.show(active, time, () => {
          const now = clock();
          return (
            !disposed &&
            !inBreak &&
            current?.id === active.id &&
            playing() &&
            Number.isSafeInteger(now) &&
            active.start <= now &&
            now < active.end
          );
        });
    }
    if (active && renderer.visible(active) && !measured.has(active.id)) {
      measured.add(active.id);
      if (onVisible) onVisible(active);
      else if (active.impressionUrl) {
        void fetchImpl(active.impressionUrl, {
          method: 'GET',
          mode: 'no-cors',
          credentials: 'omit',
          keepalive: true,
        }).catch(() => {});
      }
    }
  }

  function tick() {
    if (disposed) return;
    const time = clock();
    render(time);
    if (
      Number.isSafeInteger(time) &&
      playing() &&
      !inBreak &&
      !pending &&
      (eventsUrl || playlistUrl) &&
      Date.now() >= nextRead
    )
      void refresh(time);
  }

  if (interval !== false) timer = setInterval(tick, interval);
  return {
    tick,
    updateManifest(text) {
      manifest(text);
      tick();
    },
    setLinearAd(value) {
      inBreak = Boolean(value);
      tick();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      pending?.abort();
      if (current) renderer.hide();
      renderer.destroy?.();
      cues.clear();
      measured.clear();
      current = null;
    },
  };
}

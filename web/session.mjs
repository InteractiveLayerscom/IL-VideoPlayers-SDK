import { commerceLocale } from './commerce.mjs';
import { normalizeCue, readDateRanges } from './cues.mjs';

export function createSession({
  clock,
  playing,
  presenting = playing,
  presentingSpot = presenting,
  scenes = false,
  sceneFeatures = [],
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
    spot = null,
    pending,
    nextRead = 0,
    timer;

  function merge(items) {
    for (const cue of items) if (cue) cues.set(cue.id, cue);
  }

  function playhead() {
    const time = clock();
    return spot && !Number.isSafeInteger(time) ? Date.now() : time;
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
        url.searchParams.delete('scene_features');
        if (scenes) {
          url.searchParams.set('scene', '1');
          if (sceneFeatures.length) url.searchParams.set('scene_features', sceneFeatures.join(','));
        } else url.searchParams.delete('scene');
        for (const key of ['shop_midroll', 'midroll_creative_id', 'midroll_delivery_id']) url.searchParams.delete(key);
        if (spot && scenes && commerce) {
          url.searchParams.set('shop_midroll', '1');
          url.searchParams.set('midroll_creative_id', spot.creativeId);
          url.searchParams.set('midroll_delivery_id', spot.deliveryId);
        }
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
      if (disposed || controller.signal.aborted) return;
      if (eventsUrl) {
        cues.clear();
        if (Array.isArray(data)) merge(data.map(row =>
          normalizeCue(scenes ? row : { ...row, scene: undefined }),
        ).filter(cue => cue && (commerce || !cue.commerce || cue.scene)));
      } else manifest(data);
    } catch {
      if (eventsUrl && !disposed && !controller.signal.aborted) cues.clear();
    } finally {
      if (pending !== controller) return;
      pending = null;
      // A slow response must not start a second request on this same tick.
      nextRead = Date.now() + refreshMs;
      if (!disposed) render(playhead());
    }
  }

  function render(time) {
    function canShow(cue) {
      if (!Number.isSafeInteger(time)) return false;
      if (cue.format === 'midroll') return inBreak && !!spot && cue.id === spot.deliveryId && cue.linearCreativeId === spot.creativeId && presentingSpot();
      return !inBreak && (cue.scene ? presenting() : playing());
    }
    let active = null;
    for (const [id, cue] of cues) {
      if (Number.isFinite(time) && cue.end < time - 120000) cues.delete(id);
      else if (!active && canShow(cue) && cue.start <= time && time < cue.end) active = cue;
    }
    if (active?.id !== current?.id) {
      if (current) renderer.hide();
      current = active;
      if (active)
        renderer.show(active, time, () => {
          const now = playhead();
          return (
            !disposed &&
            canShow(active) &&
            current?.id === active.id &&
            Number.isSafeInteger(now) &&
            active.start <= now &&
            now < active.end
          );
        });
    } else if (active && current !== active) {
      renderer.applyAudioPermissions?.(active);
      current = active;
    }
    if (active) renderer.update?.(time);
    if (active && active.format !== 'midroll' && renderer.visible(active) && !measured.has(active.id)) {
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
    const time = playhead();
    render(time);
    if (
      Number.isSafeInteger(time) &&
      (inBreak ? spot && presentingSpot() : playing()) &&
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
    setLinearAd(value, identity) {
      const valid = id => typeof id === 'string' && !!id.trim() && id.length <= 256;
      const next = value && valid(identity?.creativeId) && valid(identity?.deliveryId) ? identity : null;
      if (inBreak !== Boolean(value) || spot?.creativeId !== next?.creativeId || spot?.deliveryId !== next?.deliveryId) {
        pending?.abort();
        pending = null;
        nextRead = 0;
        for (const [id, cue] of cues) if (cue.format === 'midroll') cues.delete(id);
      }
      inBreak = Boolean(value);
      spot = next ? { creativeId:next.creativeId, deliveryId:next.deliveryId } : null;
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

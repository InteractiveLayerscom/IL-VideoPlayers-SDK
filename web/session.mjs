import { commerceLocale } from './commerce.mjs';
import { normalizeCue, readDateRanges } from './cues.mjs';

export function createSession({
  clock,
  playing,
  presenting = playing,
  presentingSpot = presenting,
  presentingCard = presenting,
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
  inAd,
  onMediaChange,
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
  // Cues placed by the host stay until removeCue or destroy.
  const pinned = new Map();
  const measured = new Set();
  let current = null,
    currentHooks = null,
    disposed = false,
    inBreak = false,
    spot = null,
    pending,
    nextRead = 0,
    timer;

  function merge(items) {
    for (const cue of items) if (cue) cues.set(cue.id, cue);
  }

  // Only a linked mid-roll falls back to wall time; for every other cue a non-numeric clock means
  // «present nothing» (a stitched ad on screen), never a time of 0.
  function playhead() {
    const time = clock();
    return spot && !Number.isSafeInteger(time) ? Date.now() : time;
  }
  const contentKnown = () => Number.isSafeInteger(clock());

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

  // The graphic of a cue lasts exactly its window. A product the viewer opened is another matter: its panel is kept by
  // the renderer after the graphic goes, until the viewer closes it (see commerce.mjs).

  function render(time) {
    function canShow(cue) {
      if (!Number.isSafeInteger(time)) return false;
      if (cue.format === 'midroll') return inBreak && !!spot && cue.id === spot.deliveryId && cue.linearCreativeId === spot.creativeId && presentingSpot();
      // A card with a Buy button, like an interactive scene, stays while the viewer pauses to look at it;
      // a plain graphic shows only during playback.
      if (cue.commerce && !cue.scene) return !inBreak && contentKnown() && presentingCard();
      return !inBreak && contentKnown() && (cue.scene ? presenting() : playing());
    }
    const due = cue => cue.start <= time && time < cue.end;
    let active = null;
    for (const { cue } of pinned.values()) {
      if (!active && canShow(cue) && due(cue)) active = cue;
    }
    for (const [id, cue] of cues) {
      if (Number.isFinite(time) && cue.end < time - 120000) cues.delete(id);
      else if (!active && canShow(cue) && due(cue)) active = cue;
    }
    const hooks = active && pinned.get(active.id)?.cue === active ? pinned.get(active.id).hooks : null;
    if (active?.id !== current?.id) {
      if (current) conceal();
      current = active;
      currentHooks = hooks;
      if (active)
        renderer.show(active, time, () => {
          const now = playhead();
          return (
            !disposed &&
            canShow(active) &&
            current?.id === active.id &&
            Number.isSafeInteger(now) &&
            active.start <= now && now < active.end
          );
        }, hooks?.onClick);
    } else if (active && current !== active) {
      renderer.applyAudioPermissions?.(active);
      current = active;
      currentHooks = hooks;
    }
    if (active) renderer.update?.(time);
    if (active && active.format !== 'midroll' && renderer.visible(active) && !measured.has(active.id)) {
      measured.add(active.id);
      if (hooks?.onVisible) hooks.onVisible(active);
      else if (onVisible) onVisible(active);
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

  function conceal() {
    const [cue, hooks] = [current, currentHooks];
    renderer.hide();
    current = currentHooks = null;
    hooks?.onHidden?.(cue);
  }

  function tick() {
    if (disposed) return;
    // The player left the page: nothing is left to look at. A server-inserted ad on screen (the host's stitched clock
    // says so; buffering or an unknown position is not an ad) closes a product kept from the content.
    if (renderer.detached?.() || inAd?.()) renderer.release?.();
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

  // The host's way to say other content was loaded (hlsContentClock's `onMediaChange`): a kept product closes.
  const stopMedia = typeof onMediaChange === 'function' ? onMediaChange(() => renderer.release?.()) : null;
  if (interval !== false) timer = setInterval(tick, interval);
  return {
    tick,
    // The clock the cues are rendered from; the ads module checks a stitched plan uses the same one.
    clock,
    // What a designed product banner may use; null when this session cannot draw scenes.
    sceneFeatures: scenes ? sceneFeatures : null,
    // Whether the product of the card with this id is open: in its window, or kept after it.
    holding: id => !!renderer.holding?.({ id }),
    // Closes the open product (of this card only, when an id is given; never the one of `except`): the host's way to say
    // the media changed or another ad started.
    closeProduct(id, except) {
      renderer.release?.(id, except);
    },
    addCue(item, { onVisible, onHidden, onClick } = {}) {
      const cue = normalizeCue(item);
      if (!cue || disposed) return false;
      if (current?.id === cue.id && currentHooks) conceal();
      pinned.set(cue.id, { cue, hooks: { onVisible, onHidden, onClick } });
      tick();
      return true;
    },
    removeCue(id) {
      if (!pinned.has(id)) return false;
      if (current?.id === id && currentHooks) conceal();
      pinned.delete(id);
      tick();
      return true;
    },
    // Replaces every cue with this list (a host that pushes cues instead of serving them) and renders at once.
    setCues(list) {
      if (disposed) return false;
      cues.clear();
      if (Array.isArray(list)) merge(list.map(normalizeCue));
      tick();
      return true;
    },
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
        // A new break, or another ad with its own identity, closes the product kept from before (never the ad now
        // playing's own). The end of a break, and an ad's identity merely cleared inside a break, keep it.
        if ((value && !inBreak) || (next && next.deliveryId !== spot?.deliveryId)) renderer.release?.(undefined, next?.deliveryId);
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
      if (current) conceal();
      if (typeof stopMedia === 'function') stopMedia();
      renderer.release?.();
      renderer.destroy?.();
      cues.clear();
      pinned.clear();
      measured.clear();
      current = null;
    },
  };
}

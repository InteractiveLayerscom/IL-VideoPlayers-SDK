// Content clocks for the ads module. A clock answers one question at any moment:
// how far into the content the picture is, in seconds, or null when no graphic may be drawn
// (an ad is playing, or the position cannot be told). Scene windows are content time.

// Today's behaviour: the video position is content time and there is never an ad in the stream.
export function videoClock(video) {
  const time = () => Number(video?.currentTime) || 0;
  return Object.freeze({ kind: 'video', time, programTime: () => Math.round(time() * 1000) });
}

// How far from an ad fragment the picture counts as the ad, in seconds: hls.js fragment starts
// can be about 0.1 s off the media actually shown, and a graphic over an ad is the worse error.
const AD_EDGE_SECONDS = 0.25;
// hls.js event names (Hls.Events.FRAG_CHANGED, LEVEL_LOADED, LEVEL_UPDATED).
const FRAG_CHANGED = 'hlsFragChanged';
const LEVEL_EVENTS = ['hlsLevelLoaded', 'hlsLevelUpdated'];

// A stream stitched on the server (MediaTailor): IL writes #EXT-X-PROGRAM-DATE-TIME on every content
// segment as `pdt_origin` plus the segment's content start; ad segments carry none. hls.js keeps the
// written value in `frag.rawProgramDateTime` (null on an ad fragment); `frag.programDateTime` and
// `hls.playingDate` are extrapolated through ads and are never used here.
export function hlsContentClock({ hls, video, plan, edge = AD_EDGE_SECONDS } = {}) {
  const origin = Date.parse(plan?.timeline?.pdt_origin);
  if (!hls || typeof hls.on !== 'function' || !video || plan?.timeline?.kind !== 'stitched' || !Number.isFinite(origin))
    throw new TypeError('hlsContentClock needs hls, video and a stitched plan with timeline.pdt_origin');
  let details = null;
  let current = null;
  let disposed = false;
  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A listener must not break the others.
      }
    }
  };
  const onLevel = (_, data) => {
    if (Array.isArray(data?.details?.fragments)) details = data.details;
  };
  const onFrag = (_, data) => {
    current = data?.frag ?? null;
    notify();
  };
  for (const name of LEVEL_EVENTS) hls.on(name, onLevel);
  hls.on(FRAG_CHANGED, onFrag);

  const contains = (frag, t) => frag && Number.isFinite(frag.start) && Number.isFinite(frag.duration) &&
    frag.start <= t && t < frag.start + frag.duration;
  // Read on demand, so the first frames, seeks and a fragment change while paused need no event.
  function fragmentAt(t) {
    if (contains(current, t)) return current;
    let list;
    try {
      list = hls.levels?.[hls.currentLevel]?.details?.fragments;
    } catch {
      list = null;
    }
    for (const source of [list, details?.fragments]) {
      if (!Array.isArray(source)) continue;
      const found = source.find((frag) => contains(frag, t));
      if (found) return found;
    }
    return null;
  }
  const contentPdt = (frag) => typeof frag?.rawProgramDateTime === 'string' ? Date.parse(frag.rawProgramDateTime) : NaN;
  const isAd = (frag) => !Number.isFinite(contentPdt(frag));

  function time() {
    if (disposed) return null;
    const t = Number(video.currentTime);
    if (!Number.isFinite(t)) return null;
    const frag = fragmentAt(t);
    if (!frag || isAd(frag)) return null;
    for (const near of [t - edge, t + edge]) {
      const other = near >= 0 ? fragmentAt(near) : null;
      if (other && other !== frag && isAd(other)) return null;
    }
    return Math.max(0, (contentPdt(frag) - origin) / 1000 + (t - frag.start));
  }
  return Object.freeze({
    kind: 'stitched',
    time,
    // For the session's programTime: content milliseconds, null while an ad plays.
    programTime() {
      const seconds = time();
      return seconds == null ? null : Math.round(seconds * 1000);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      for (const name of LEVEL_EVENTS) hls.off?.(name, onLevel);
      hls.off?.(FRAG_CHANGED, onFrag);
    },
  });
}

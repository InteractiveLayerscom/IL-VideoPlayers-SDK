// Content clocks for the ads module. A clock answers one question at any moment:
// how far into the content the picture is, in seconds, or null when no graphic may be drawn
// (an ad is playing, or the position cannot be told). Scene windows are content time.

// Today's behaviour: the video position is content time and there is never an ad in the stream.
export function videoClock(video) {
  const time = () => Number(video?.currentTime) || 0;
  return Object.freeze({ kind: 'video', time, programTime: () => Math.round(time() * 1000) });
}

// How far from an ad segment the picture counts as the ad, in seconds of wall time: a player's segment
// starts can be about 0.1 s off the media actually shown, and a graphic over an ad is the worse error.
// Ahead of an ad the margin is wider and scales with the playback rate, so a late check still hides
// the graphic before the ad's first frame.
const AD_EDGE_SECONDS = 0.25;
const AD_LEAD_SECONDS = 0.5;
// How far content PDTs may be from where the layout puts them: IL writes milliseconds, playlists round
// #EXTINF to the millisecond.
const PDT_TOLERANCE = 0.05;
// Two renditions of one session that disagree on the content second by more than this cannot both be right.
const RENDITION_TOLERANCE = 0.1;
// hls.js event names (Hls.Events.FRAG_CHANGED, LEVEL_LOADED, LEVEL_UPDATED).
const FRAG_CHANGED = 'hlsFragChanged';
const LEVEL_EVENTS = ['hlsLevelLoaded', 'hlsLevelUpdated'];
const MANIFEST_LOADING = 'hlsManifestLoading';
// shaka.net.NetworkingEngine.RequestType.MANIFEST: HLS media playlists come through it too.
const SHAKA_MANIFEST = 0;
const SHAKA_SEGMENT = 1;
// Variant playlists Safari's clock reads from a session master.
const MAX_VARIANTS = 8;

// A stream stitched on the server (MediaTailor): IL writes #EXT-X-PROGRAM-DATE-TIME on every content
// segment as `pdt_origin` plus the segment's content start; ad segments carry none. Every clock below
// reads that written value per segment, never a value a player extrapolates through the ads.
function stitchedPlan(plan, name) {
  const origin = Date.parse(plan?.timeline?.pdt_origin);
  if (plan?.timeline?.kind !== 'stitched' || !Number.isFinite(origin))
    throw new TypeError(`${name} needs a stitched plan with timeline.pdt_origin`);
  const duration = Number(plan.duration);
  return { origin, duration: Number.isFinite(duration) && duration > 0 ? duration : Infinity };
}

// The segments of an HLS media playlist in stream time (the sum of #EXTINF from the first segment, as a
// player lays out a VOD), each with the #EXT-X-PROGRAM-DATE-TIME written right before it or NaN, its URI and,
// with #EXT-X-BYTERANGE (single-file HLS: every segment the same URI), the first byte of its range, else null.
// A PDT counts only for its own segment: an ad segment after a content one stays an ad.
export function parseMediaPlaylist(text) {
  const segments = [];
  const ends = new Map();   // URI -> the byte after its last range, for a range without @offset
  let start = 0;
  let duration = null;
  let pdt = NaN;
  let range = null;
  let run = 0;   // segments between two #EXT-X-DISCONTINUITY tags are one run
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '#EXT-X-DISCONTINUITY') run++;
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
    else if (line.startsWith('#EXTINF:')) duration = Number.parseFloat(line.slice(8));
    else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const [length, offset] = line.slice(17).split('@').map(Number);
      range = { length, offset };
    } else if (line && !line.startsWith('#')) {
      let byteStart = null;
      if (range && Number.isFinite(range.length)) {
        byteStart = Number.isFinite(range.offset) ? range.offset : ends.get(line) ?? 0;
        ends.set(line, byteStart + range.length);
      }
      if (Number.isFinite(duration) && duration > 0) {
        segments.push(Object.freeze({ start, duration, pdt, uri: line, byteStart, run }));
        start += duration;
      }
      duration = null;
      pdt = NaN;
      range = null;
    }
  }
  return segments;
}

// What each segment is, judged once per playlist: content (its content second), an ad (no PDT) or unknown.
// A PDT before the origin or past the plan's duration is not IL's clock: that segment is unknown. Content
// PDTs must follow each other without gap or overlap (an ad does not consume content); if they do not, an
// ad may be carrying a PDT, and the whole playlist is unknown rather than wrong. `layout.unknown` names why
// any of it is unknown: 'pdt_out_of_range' or 'pdt_not_contiguous' (the clocks report it once, see `reporter`).
export function layoutSegments(segments, { origin, duration = Infinity }) {
  // A run holding any dated segment is content (some of it of unknown time); only a run with none is an ad pod, as MediaTailor
  // writes one between discontinuities. A layout that says nothing about runs counts as one run.
  const datedRuns = new Set(segments.filter((segment) => Number.isFinite(segment.pdt)).map((segment) => segment.run ?? 0));
  let out = segments.map(({ start, duration: length, pdt, uri, byteStart = null, run = 0 }) => {
    if (!Number.isFinite(pdt)) return { start, end: start + length, kind: 'ad', pod: !datedRuns.has(run), uri, byteStart };
    const content = (pdt - origin) / 1000;
    const plausible = content >= -PDT_TOLERANCE && content + length <= duration + PDT_TOLERANCE;
    return { start, end: start + length, kind: plausible ? 'content' : 'unknown', content, length, uri, byteStart };
  });
  let unknown = out.some((segment) => segment.kind === 'unknown') ? 'pdt_out_of_range' : null;
  let previous = null;
  for (const segment of out) {
    if (segment.kind !== 'content') continue;
    if (previous && Math.abs(segment.content - (previous.content + previous.length)) > PDT_TOLERANCE) {
      // The content is unknown; an undated segment stays what it is (its run decides whether it is an ad pod), which never lends a time.
      out = out.map((item) => (item.kind === 'ad' ? item : { ...item, kind: 'unknown' }));
      unknown = 'pdt_not_contiguous';
      break;
    }
    previous = segment;
  }
  out.unknown = unknown;
  return out;
}

// Says once per reason, through `onEvent({ type: 'clock_unknown', reason })`, why a playlist shows nothing.
function reporter(onEvent) {
  const said = new Set();
  return (layout) => {
    if (!layout?.unknown || said.has(layout.unknown)) return layout;
    said.add(layout.unknown);
    try {
      onEvent?.({ type: 'clock_unknown', reason: layout.unknown });
    } catch {
      // Diagnostics must never break playback.
    }
    return layout;
  };
}

// Index of the segment holding stream second `t`, or -1 (binary search: layouts are in stream order).
function indexAt(layout, t) {
  let low = 0;
  let high = layout.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (t < layout[mid].start) high = mid - 1;
    else if (t >= layout[mid].end) low = mid + 1;
    else return mid;
  }
  return -1;
}

// Whether every moment of [from, to] in this layout is content (an ad, an unknown segment or no segment
// anywhere in it says no), walking each segment that overlaps it.
function allContent(layout, from, to) {
  let i = indexAt(layout, Math.max(0, from));
  if (i < 0) return false;
  let reached = layout[i].start;
  for (; i < layout.length && layout[i].start <= to; i++) {
    if (layout[i].kind !== 'content' || layout[i].start > reached + 1e-6) return false;
    reached = layout[i].end;
  }
  return reached > to || i === layout.length;
}

// What a segment is for `inAd()`: an ad only when it is undated AND in a run of undated segments (an ad pod). An undated
// segment among dated ones is content whose time is unknown, which may never close anything.
export function segmentKind(segment) {
  if (!segment) return null;
  return segment.kind === 'ad' && segment.pod === false ? 'unknown' : segment.kind;
}

// What the segment holding stream second `t` is: 'content', 'ad', 'unknown', or null when none holds it.
function kindAt(layout, t) {
  const i = layout ? indexAt(layout, t) : -1;
  return i < 0 ? null : segmentKind(layout[i]);
}

// Content second at stream second `t` in one layout, or null near an ad.
function contentAt(layout, t, from, to) {
  const i = layout ? indexAt(layout, t) : -1;
  if (i < 0 || !allContent(layout, from, to)) return null;
  const segment = layout[i];
  return Math.max(0, segment.content + (t - segment.start));
}

// The clock over the player: `resolve(t, from, to)` gives the content second at stream second `t`, null when
// any of [from, to] may be an ad. `position()` and `rate()` read the player now, so the first frames, seeks
// and pauses need no event.
function segmentClock({ resolve, kind, position, rate, edge, lead, onDestroy }) {
  let disposed = false;
  const listeners = new Set();
  function time() {
    if (disposed) return null;
    const t = Number(position());
    if (!Number.isFinite(t)) return null;
    const r = Number(rate());
    const scale = Number.isFinite(r) && r > 1 ? r : 1;
    const value = resolve(t, t - edge * scale, t + Math.max(edge, lead) * scale);
    return Number.isFinite(value) ? value : null;
  }
  return {
    kind: 'stitched',
    time,
    // Whether the picture is an ad right now: the segment on screen is one without a program date. Unlike a null `time()`,
    // it is false while the position is unknown, nothing is loaded yet or the player is buffering.
    inAd() {
      if (disposed) return false;
      const t = Number(position());
      return Number.isFinite(t) && kind?.(t) === 'ad';
    },
    // For the session's programTime: content milliseconds, null while an ad plays.
    programTime() {
      const seconds = time();
      return seconds == null ? null : Math.round(seconds * 1000);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify() {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A listener must not break the others.
        }
      }
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      onDestroy?.();
    },
  };
}
// The public clock: `notify` stays inside the module.
const publicClock = ({ notify, ...clock }) => Object.freeze(clock);
// Any of these layouts has an ad, an unknown segment or a hole in [from, to].
const adInAny = (layouts, from, to) => layouts.some((layout) => !allContent(layout, from, to));

// hls.js keeps the written value in `frag.rawProgramDateTime` (null on an ad fragment); `frag.programDateTime`
// and `hls.playingDate` are extrapolated through ads and are never used here. The layout is the level of the
// fragment on screen (FRAG_CHANGED), else hls.js's current level, else the last level loaded; every loaded
// level must also be clear of ads around the moment, so a level switch never puts a graphic on an ad.
export function hlsContentClock({ hls, video, plan, edge = AD_EDGE_SECONDS, lead = AD_LEAD_SECONDS, onEvent } = {}) {
  if (!hls || typeof hls.on !== 'function' || !video)
    throw new TypeError('hlsContentClock needs hls, video and a stitched plan with timeline.pdt_origin');
  const bounds = stitchedPlan(plan, 'hlsContentClock');
  const report = reporter(onEvent);
  const layouts = new WeakMap();
  let details = null;
  let current = null;
  const layoutOf = (fragments) => {
    if (!Array.isArray(fragments) || !fragments.length) return null;
    if (!layouts.has(fragments)) {
      layouts.set(fragments, report(layoutSegments(fragments.map((frag) => ({
        start: frag.start, duration: frag.duration, run: frag.cc,
        pdt: typeof frag.rawProgramDateTime === 'string' ? Date.parse(frag.rawProgramDateTime) : NaN,
      })), bounds)));
    }
    return layouts.get(fragments);
  };
  const levelFragments = (level) => {
    try {
      return hls.levels?.[level]?.details?.fragments;
    } catch {
      return null;
    }
  };
  const layoutFor = (t) => {
    const playing = current && current.start <= t && t < current.start + current.duration
      ? layoutOf(levelFragments(current.level)) : null;
    return playing ?? layoutOf(levelFragments(hls.currentLevel)) ?? layoutOf(details?.fragments);
  };
  function resolve(t, from, to) {
    const layout = layoutFor(t);
    const value = contentAt(layout, t, from, to);
    if (value == null) return null;
    const loaded = (Array.isArray(hls.levels) ? hls.levels.map((_, i) => layoutOf(levelFragments(i))) : []).filter(Boolean);
    return adInAny(loaded, from, to) ? null : value;
  }
  const onLevel = (_, data) => {
    if (Array.isArray(data?.details?.fragments)) details = data.details;
  };
  const onFrag = (_, data) => {
    current = data?.frag ?? null;
    clock.notify();
  };
  // hls.js says `hlsManifestLoading` only from loadSource(), which is the host loading content; its own error recovery
  // (recoverMediaError, swapAudioCodec) detaches and attaches the media without it. Another URL than the one last seen is
  // other content; the first load and the same URL again are not a change.
  const absolute = (url) => {
    try {
      return new URL(url, globalThis.location?.href).href;
    } catch {
      return null;
    }
  };
  let lastSource = (() => {
    try {
      return hls.url ? absolute(hls.url) : null;
    } catch {
      return null;
    }
  })();
  const mediaListeners = new Set();
  const onManifestLoading = (_, data) => {
    const next = absolute(data?.url);
    const changed = lastSource != null && next != null && next !== lastSource;
    lastSource = next ?? lastSource;
    if (!changed) return;
    for (const listener of mediaListeners) {
      try {
        listener();
      } catch {
        // A listener must not break the others.
      }
    }
  };
  const clock = segmentClock({
    resolve, kind: (t) => kindAt(layoutFor(t), t), edge, lead,
    position: () => video.currentTime,
    rate: () => video.playbackRate,
    onDestroy() {
      for (const name of LEVEL_EVENTS) hls.off?.(name, onLevel);
      hls.off?.(FRAG_CHANGED, onFrag);
      hls.off?.(MANIFEST_LOADING, onManifestLoading);
      mediaListeners.clear();
    },
  });
  for (const name of LEVEL_EVENTS) hls.on(name, onLevel);
  hls.on(FRAG_CHANGED, onFrag);
  hls.on(MANIFEST_LOADING, onManifestLoading);
  // Calls `listener` when the host loads other content into this hls.js; returns the way to stop.
  clock.onMediaChange = (listener) => {
    mediaListeners.add(listener);
    return () => mediaListeners.delete(listener);
  };
  return publicClock(clock);
}

// Shaka corrects each segment's PDT into one continuous timeline, so the ads cannot be told apart in its
// manifest. The clock reads the media playlists Shaka itself downloads (a response filter sees the exact
// bytes, so MediaTailor's session is never asked again), one layout per playlist URI. A moment is read from the
// segment last downloaded for it, where Shaka placed it (request context) and as the playlist naming it says;
// failing that, in the active video variant's playlist: from a switch on, at the end of what was already buffered (where Shaka appends the new
// variant), or at once after a seek out of the buffer. Audio and subtitle playlists only take part in the
// ad check, which every downloaded playlist must pass. Create it after player.attach(video) and before
// player.load(): the playlists of a video on demand are downloaded once. Created later (or after
// player.preload()), the active variant's playlist is missing: the clock stays null and says so once
// through `onEvent({ type: 'clock_playlist_missing' })`.
export function shakaContentClock({ player, video = player?.getMediaElement?.(), plan, edge = AD_EDGE_SECONDS,
  lead = AD_LEAD_SECONDS, onEvent } = {}) {
  const network = player?.getNetworkingEngine?.();
  if (typeof network?.registerResponseFilter !== 'function' || !video)
    throw new TypeError('shakaContentClock needs a Shaka player attached to a video and a stitched plan with timeline.pdt_origin');
  const bounds = stitchedPlan(plan, 'shakaContentClock');
  const report = reporter(onEvent);
  // Per playlist URI, its segments by resolved URI and first byte (`uri|byte`, byte empty without a range).
  // A key named twice is dropped: such a download cannot be placed and falls back to the playlist path.
  const indexes = new Map();
  if (player.getManifest?.())
    throw new TypeError('shakaContentClock must be created before player.load(): the playlists are read as Shaka downloads them');
  const layouts = new Map();
  const decoder = new TextDecoder();
  let switches = null;   // [{ from, uris }] in stream order, the active video variant from `from` on
  let missingSaid = false;
  const activeUris = () => {
    try {
      const track = player.getVariantTracks?.().find((item) => item.active);
      return String(track?.originalVideoId ?? '').split(',').filter(Boolean);
    } catch {
      return [];
    }
  };
  const bufferEnd = () => {
    const t = video.currentTime;
    for (let i = 0; i < (video.buffered?.length ?? 0); i++)
      if (video.buffered.start(i) <= t + 0.1 && t <= video.buffered.end(i)) return video.buffered.end(i);
    return t;
  };
  const inBuffer = (t) => {
    for (let i = 0; i < (video.buffered?.length ?? 0); i++)
      if (video.buffered.start(i) <= t && t <= video.buffered.end(i)) return true;
    return false;
  };
  const onSwitch = () => {
    const uris = activeUris();
    if (!uris.length) return;
    if (!switches) switches = [{ from: -Infinity, uris }];
    else switches.push({ from: bufferEnd(), uris });
    clock.notify();
  };
  const onSeeking = () => {
    if (switches && !inBuffer(video.currentTime)) switches = [{ from: -Infinity, uris: activeUris() }];
  };
  // Segments Shaka downloaded, newest last: where Shaka placed each on its own timeline (it aligns renditions by
  // their PDTs, not by the sum of #EXTINF), and what it is in the playlist that names it.
  const downloads = [];
  // Only video: an audio or subtitle segment's boundaries say nothing about the picture.
  const onSegment = (uri, reference, stream) => {
    const start = Number(reference?.startTime);
    const end = Number(reference?.endTime);
    if (!Number.isFinite(start) || !(end > start) || (stream?.type && stream.type !== 'video')) return;
    const byte = Number(reference?.startByte);
    const keys = [`${uri}|${Number.isFinite(byte) ? byte : ''}`];
    if (byte === 0) keys.push(`${uri}|`);   // Shaka gives 0 for a segment that has no range
    for (const [playlist, index] of indexes) {
      if (!stream && !videoPlaylist(playlist)) continue;
      const segment = keys.map((key) => index.get(key)).find(Boolean);
      if (segment) {
        downloads.push({ start, end, segment });
        if (downloads.length > 2000) downloads.shift();
        return;
      }
    }
  };
  // From downloads alone: the content second at `t`, null near an ad, undefined when they do not cover [from, to].
  const fromDownloads = (t, from, to) => {
    const at = (moment) => downloads.findLast((item) => item.start <= moment && moment < item.end);
    const here = at(t);
    if (!here) return undefined;
    for (let moment = Math.max(0, from); moment <= to; ) {
      const item = at(moment);
      if (!item) return moment >= to - 1e-6 ? null : undefined;
      if (item.segment.kind !== 'content') return null;
      moment = item.end;
    }
    return here.segment.kind === 'content' ? Math.max(0, here.segment.content + (t - here.start)) : null;
  };
  const filter = (type, response, context) => {
    if (type === SHAKA_SEGMENT) return onSegment(response?.originalUri ?? response?.uri, context?.segment, context?.stream);
    if (type !== SHAKA_MANIFEST || !response?.data) return;
    let text;
    try {
      text = decoder.decode(response.data);
    } catch {
      return;
    }
    if (!text.includes('#EXTINF')) return;
    const uri = response.originalUri ?? response.uri;
    const layout = report(layoutSegments(parseMediaPlaylist(text), bounds));
    layouts.set(uri, layout);
    const index = new Map();
    const twice = new Set();
    for (const segment of layout) {
      let key;
      try {
        key = `${new URL(segment.uri, uri).href}|${segment.byteStart ?? ''}`;
      } catch {
        continue;
      }
      if (index.has(key)) twice.add(key);
      index.set(key, segment);
    }
    for (const key of twice) index.delete(key);
    indexes.set(uri, index);
    clock.notify();
  };
  // Shaka names a variant by the playlist URIs as the master writes them (often relative): a downloaded
  // playlist is that variant's when the written URI, resolved against the playlist's own URL, is that URL.
  const named = (written, uri) => {
    try {
      return new URL(written, uri).href === uri;
    } catch {
      return false;
    }
  };
  // A downloaded playlist is a video one when some variant names it as its video.
  const videoPlaylist = (uri) => {
    try {
      return (player.getVariantTracks?.() ?? []).some((track) =>
        String(track.originalVideoId ?? '').split(',').some((written) => named(written, uri)));
    } catch {
      return false;
    }
  };
  // The layout of the active video variant's playlist at `t`, if it has been downloaded.
  const activeLayout = (t) => {
    if (!switches) onSwitch();
    if (!switches) return null;
    let uris = switches[0].uris;
    for (const item of switches) if (item.from <= t) uris = item.uris;
    return uris.map((written) => [...layouts.keys()].find((uri) => named(written, uri)))
      .filter(Boolean).map((uri) => layouts.get(uri))[0];
  };
  function resolve(t, from, to) {
    if (!switches) onSwitch();
    if (!switches) return null;
    const layout = activeLayout(t);
    if (!layout) {
      if (!missingSaid && layouts.size) {
        missingSaid = true;
        try {
          onEvent?.({ type: 'clock_playlist_missing' });
        } catch {
          // Diagnostics must never break playback.
        }
      }
      return null;
    }
    // What is on screen is the segment last downloaded for that moment: read where Shaka placed it, as the playlist
    // naming it says (each rendition has its own segment URIs). Only where downloads do not cover the margins does
    // the active variant's playlist decide, and then every playlist must be clear of ads.
    const downloaded = fromDownloads(t, from, to);
    if (downloaded !== undefined) return downloaded;
    const value = contentAt(layout, t, from, to);
    return value == null || adInAny([...layouts.values()], from, to) ? null : value;
  }
  // What is on screen is the segment last downloaded for that moment, else the active variant's playlist says.
  const kindOfMoment = (t) => {
    const here = downloads.findLast((item) => item.start <= t && t < item.end);
    return here ? segmentKind(here.segment) : kindAt(activeLayout(t), t);
  };
  const clock = segmentClock({
    resolve, kind: kindOfMoment, edge, lead,
    position: () => video.currentTime,
    rate: () => video.playbackRate,
    onDestroy: () => {
      network.unregisterResponseFilter?.(filter);
      for (const name of ['adaptation', 'variantchanged']) player.removeEventListener?.(name, onSwitch);
      video.removeEventListener?.('seeking', onSeeking);
    },
  });
  network.registerResponseFilter(filter);
  for (const name of ['adaptation', 'variantchanged']) player.addEventListener?.(name, onSwitch);
  video.addEventListener?.('seeking', onSeeking);
  return publicClock(clock);
}

// Video.js (VHS) parses each playlist with m3u8-parser: `segment.dateTimeString` is the PDT written on that
// segment, while `programDateTime` is extrapolated and never used. The layout used is the one whose segment
// at that moment VHS actually loaded (it then carries `start`), so after a rendition switch the picture is
// read in the rendition it came from; else the current playlist, laid out from its durations. Every video
// playlist VHS has loaded must also be clear of ads around the moment. Under Safari's native HLS Video.js
// has no VHS: null.
export function videoJsContentClock({ player, plan, edge = AD_EDGE_SECONDS, lead = AD_LEAD_SECONDS, onEvent } = {}) {
  if (typeof player?.currentTime !== 'function' || typeof player?.tech !== 'function')
    throw new TypeError('videoJsContentClock needs a Video.js player and a stitched plan with timeline.pdt_origin');
  const bounds = stitchedPlan(plan, 'videoJsContentClock');
  const report = reporter(onEvent);
  const layouts = new WeakMap();
  const layoutOf = (list) => {
    let layout = layouts.get(list);
    if (!layout) {
      let start = 0;
      let run = 0;
      layout = report(layoutSegments(list.map((segment) => {
        const at = Number.isFinite(segment.start) ? segment.start : start;
        start = at + segment.duration;
        if (segment.discontinuity) run++;
        return { start: at, duration: segment.duration, run,
          pdt: typeof segment.dateTimeString === 'string' ? Date.parse(segment.dateTimeString) : NaN };
      }), bounds));
      layouts.set(list, layout);
    }
    return layout;
  };
  // A layout, laid out again only when VHS has timed the segment at `t` differently since.
  const fresh = (list, t) => {
    let layout = layoutOf(list);
    const i = indexAt(layout, t);
    if (i >= 0 && Number.isFinite(list[i].start) && list[i].start !== layout[i].start) {
      layouts.delete(list);
      layout = layoutOf(list);
    }
    return layout;
  };
  function playlists() {
    try {
      const vhs = player.tech({ IWillNotUseThisInPlugins: true })?.vhs;
      const media = vhs?.playlists?.media?.();
      const all = (vhs?.playlists?.main?.playlists ?? []).filter((item) => Array.isArray(item?.segments) && item.segments.length);
      return { media: Array.isArray(media?.segments) ? media : null, all };
    } catch {
      return { media: null, all: [] };
    }
  }
  function resolve(t, from, to) {
    const { media, all } = playlists();
    if (!media) return null;
    const candidates = [media, ...all.filter((item) => item !== media)];
    const loaded = candidates.find((item) => {
      const i = indexAt(fresh(item.segments, t), t);
      return i >= 0 && Number.isFinite(item.segments[i].start);
    });
    const value = contentAt(fresh((loaded ?? media).segments, t), t, from, to);
    return value == null || adInAny(candidates.map((item) => fresh(item.segments, t)), from, to) ? null : value;
  }
  // The segment the layout used for `t` holds, as in resolve.
  function kindOfMoment(t) {
    const { media, all } = playlists();
    if (!media) return null;
    const candidates = [media, ...all.filter((item) => item !== media)];
    const loaded = candidates.find((item) => {
      const i = indexAt(fresh(item.segments, t), t);
      return i >= 0 && Number.isFinite(item.segments[i].start);
    });
    return kindAt(fresh((loaded ?? media).segments, t), t);
  }
  return publicClock(segmentClock({
    resolve, kind: kindOfMoment, edge, lead,
    position: () => player.currentTime(),
    rate: () => player.playbackRate(),
  }));
}

// A MediaTailor session manifest: on a MediaTailor host and naming its session.
function isSessionUrl(url) {
  try {
    const parsed = new URL(url, globalThis.location?.href);
    return parsed.protocol === 'https:' && /\.mediatailor\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname) &&
      parsed.searchParams.has('aws.sessionId');
  } catch {
    return false;
  }
}

// Safari plays HLS itself and shows no segment to the page (`video.getStartDate()` is only the first PDT). The
// clock reads the playlists of the same MediaTailor session from `playlistUrl` and lays them out in stream
// time. It must be the session's own manifest (explicit session initialization: the `manifestUrl` MediaTailor
// returns, which carries `aws.sessionId`): another request to the playback URL opens a second session, with
// other ads, and counts its requests to the publisher. Any other URL is refused unless the host states it is
// that session's manifest with `sessionManifest: true` (a CDN in front of MediaTailor, a test stream).
// Which variant Safari shows cannot be known: every variant of a master is read (up to MAX_VARIANTS), and the
// clock answers only where all of them agree on the content second and none has an ad nearby; if one cannot
// be read, it stays null.
export function nativeHlsContentClock({ video, plan, playlistUrl, fetchImpl = globalThis.fetch, sessionManifest = false,
  edge = AD_EDGE_SECONDS, lead = AD_LEAD_SECONDS, onEvent } = {}) {
  if (!video || typeof playlistUrl !== 'string' || typeof fetchImpl !== 'function')
    throw new TypeError('nativeHlsContentClock needs video, playlistUrl and a stitched plan with timeline.pdt_origin');
  const bounds = stitchedPlan(plan, 'nativeHlsContentClock');
  const report = reporter(onEvent);
  if (sessionManifest !== true && !isSessionUrl(playlistUrl))
    throw new TypeError('nativeHlsContentClock needs the MediaTailor session manifest (aws.sessionId); ' +
      'pass sessionManifest: true only for that same session behind another host');
  let layouts = null;
  let disposed = false;
  function resolve(t, from, to) {
    if (!layouts) return null;
    const values = layouts.map((layout) => contentAt(layout, t, from, to));
    if (values.some((value) => value == null)) return null;
    return values.every((value) => Math.abs(value - values[0]) <= RENDITION_TOLERANCE) ? values[0] : null;
  }
  // Which variant Safari shows cannot be known: it is an ad only where every variant says so.
  const kindOfMoment = (t) => (layouts?.length && layouts.every((layout) => kindAt(layout, t) === 'ad') ? 'ad' : null);
  const clock = segmentClock({
    resolve, kind: kindOfMoment, edge, lead,
    position: () => video.currentTime,
    rate: () => video.playbackRate,
    onDestroy: () => {
      disposed = true;
    },
  });
  const get = async (url) => {
    const response = await fetchImpl(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`playlist ${response.status}`);
    return response.text();
  };
  (async () => {
    const url = new URL(playlistUrl, globalThis.location?.href).href;
    const text = await get(url);
    let texts = [text];
    if (text.includes('#EXT-X-STREAM-INF')) {
      const lines = text.split(/\r?\n/).map((line) => line.trim());
      const uris = [];
      lines.forEach((line, i) => {
        if (!line.startsWith('#EXT-X-STREAM-INF')) return;
        const uri = lines.slice(i + 1).find((next) => next && !next.startsWith('#'));
        if (uri && !uris.includes(uri)) uris.push(uri);
      });
      if (!uris.length) return;
      texts = await Promise.all(uris.slice(0, MAX_VARIANTS).map((uri) => get(new URL(uri, url).href)));
    }
    const parsed = texts.map((item) => report(layoutSegments(parseMediaPlaylist(item), bounds)));
    if (!disposed && parsed.every((layout) => layout.some((segment) => segment.kind === 'content'))) {
      layouts = parsed;
      clock.notify();
    }
  })().catch(() => {
    // No playlist, no content time: the clock stays null and nothing is drawn.
  });
  return publicClock(clock);
}

import { applySafeArea, commerceSurface } from './commerce.mjs';
import { sceneRenderer, sceneSupported, sceneFeatures } from './scene.mjs';
import { createSession } from './session.mjs';
import { bandRenderer } from './bands.mjs';
import { listenToVideo, nativeProgramTime } from './video.mjs';

const resized = {
  position: 'absolute',
  left: '0',
  top: '0',
  right: 'auto',
  bottom: 'auto',
  width: '75%',
  height: '75%',
};

function renderer(stage, surface, avplay, getDisplayRect, commerce, options) {
  let originalStyles,
    originalRect;
  function squeeze(shrink) {
    if (!shrink) {
      if (originalStyles) {
        for (const [key, value, priority] of originalStyles)
          surface.style.setProperty(key, value, priority);
        originalStyles = null;
      }
      if (originalRect) {
        const { x, y, width, height } = originalRect;
        originalRect = null;
        // The host reapplies its base rectangle when preparing a new AVPlay asset.
        if (['READY', 'PLAYING', 'PAUSED'].includes(avplay.getState())) {
          try { avplay.setDisplayRect(x, y, width, height); } catch {}
        }
      }
      return true;
    }
    if (originalStyles) return true;
    if (avplay) {
      const rect = getDisplayRect();
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
          rect.width <= 0 || rect.height <= 0) return false;
      try {
        avplay.setDisplayRect(rect.x, rect.y, Math.round(rect.width * 0.75), Math.round(rect.height * 0.75));
      } catch { return false; }
      originalRect = { ...rect };
    }
    originalStyles = Object.keys(resized).map(key => [
      key, surface.style.getPropertyValue(key), surface.style.getPropertyPriority(key),
    ]);
    Object.assign(surface.style, resized);
    return true;
  }

  const scenes = sceneRenderer(stage, commerce, { ...options, squeeze });

  const bands = bandRenderer(stage, commerce, { squeeze, fail: () => hide() });

  function hide() {
    scenes.hide();
    commerce.retire();
    bands.hide();
    squeeze(false);
  }

  function show(cue, time, stillActive, onClick) {
    if (cue.format === 'midroll') { commerce.show(cue, stillActive); return; }
    if (cue.scene) {
      scenes.show(cue, time, stillActive);
      return;
    }
    bands.show(cue, stillActive, onClick);
  }
  return {
    show,
    hide,
    update: scenes.update,
    applyAudioPermissions: scenes.applyAudioPermissions,
    holding: cue => commerce.isOpen(cue),
    release: (id, except) => commerce.release(id, except),
    detached: () => !stage.isConnected,
    visible: cue => cue.scene ? scenes.visible() : bands.visible(),
  };
}

function attach({ stage, surface, squeezed = surface, video, avplay, getDisplayRect, programTime, ...source }) {
  if (!stage || !surface || stage === surface || !stage.contains(surface)) {
    throw new Error('The stage must contain the existing video surface');
  }
  const presenting = avplay
    ? () => ['PLAYING', 'PAUSED'].includes(avplay.getState()) && !stage.ownerDocument.hidden
    : () => !video.ended && !video.seeking && video.readyState >= 2 && !stage.ownerDocument.hidden;
  const playing = () => presenting() && (avplay ? avplay.getState() === 'PLAYING' : !video.paused);
  const clock = programTime ?? (source.timeline === 'media' && video
    ? () => Math.round(video.currentTime * 1000)
    : () => nativeProgramTime(video));
  if (source.commerce) applySafeArea(stage, source.insets, () => {
    const bar = surface.querySelector?.('.vjs-control-bar');
    return bar ? Math.round(bar.getBoundingClientRect().height) || 30 : video?.controls ? 48 : 0;
  });
  const pausing = video && source.commerce?.pauseOnOpen === true ? pauseOnOpen(video) : undefined;
  const commerce = commerceSurface(stage, source.commerce, source.fetchImpl, pausing);
  const allowVideo = source.secondaryVideo ?? !avplay;
  const allowAudio = allowVideo && source.secondaryVideoAudio === true;
  const window = stage.ownerDocument.defaultView;
  const session = createSession({
    ...source,
    playing,
    presenting,
    // During an ad the content may not have loaded yet (a pre-roll): only the page and the element's state count.
    presentingSpot: avplay ? presenting : () => !video.ended && !video.seeking && !stage.ownerDocument.hidden,
    // A card with a Buy button survives a hidden page (another tab): it is not visible, so nothing is counted,
    // and the viewer finds it as they left it.
    presentingCard: avplay ? presenting
      : () => !video.ended && !video.seeking && video.readyState >= 2,
    scenes: sceneSupported(window),
    sceneFeatures: sceneFeatures(window, allowVideo, allowAudio),
    clock,
    renderer: renderer(stage, squeezed, avplay, getDisplayRect, commerce, {
      clock, moving: playing, tv: Boolean(avplay || source.commerce?.tv),
      allowVideo, allowAudio, animate: source.interval !== false,
    }),
  });
  // listenToVideo also ticks on visibilitychange, so a page shown again re-reads the clock before it is painted.
  // AVPlay has no <video>: the same tick is wired to the document here.
  const doc = stage.ownerDocument;
  const unlisten = video ? listenToVideo(video, session.tick) : () => doc.removeEventListener('visibilitychange', session.tick);
  if (!video) doc.addEventListener('visibilitychange', session.tick);
  // A new source closes a product kept from the old one. `emptied` only says the element was reset (a new source, but also
  // load() again on the same file after an error, or a Media Source player detaching and attaching its `blob:` source to
  // recover), so it decides nothing: the next `loadstart` does, by comparing the new `currentSrc` with the one before the
  // reset. A different file or HLS URL closes the panel; the same one, or one `blob:` URL for another (recovery), does not.
  // If nothing ever loads after the reset (the source was removed), there is nothing new on screen and the panel stays until
  // the viewer closes it or the host calls closeProduct(). hls.js on a plain element and AVPlay have no event of their own
  // for new content (see the README): the host calls closeProduct() there; Video.js and Shaka say so through the player.
  let elementSrc = video?.currentSrc || '';
  let beforeReset = null;   // the source the element had when it was emptied, until the next one starts to load
  const loaded = () => {
    const next = video.currentSrc || '';
    const before = beforeReset ?? elementSrc;
    const blob = (url) => /^blob:/.test(url);
    if (before && next && next !== before && !(blob(before) && blob(next))) session.closeProduct();
    beforeReset = null;
    elementSrc = next;
  };
  const mediaChanged = () => {
    if (elementSrc) beforeReset = elementSrc;
    elementSrc = '';
  };
  video?.addEventListener('loadstart', loaded);
  video?.addEventListener('emptied', mediaChanged);
  return {
    ...session,
    // The ads module asks for scene products only when this session renders commerce.
    commerce: commerce.enabled ? source.commerce : undefined,
    destroy() {
      unlisten();
      video?.removeEventListener('loadstart', loaded);
      video?.removeEventListener('emptied', mediaChanged);
      pausing?.dispose();
      session.destroy();
    },
  };
}

// commerce.pauseOnOpen: opening a product's detail pauses the video, so nothing (a break included) moves under a
// viewer who is choosing. Closing it resumes only a pause the SDK made, if no one played or paused since; once the
// purchase page or QR is handed over the video stays paused.
export function pauseOnOpen(video) {
  let ours = false;
  let expected = false;
  const changed = () => {
    if (expected) expected = false;
    else ours = false;
  };
  video.addEventListener('play', changed);
  video.addEventListener('pause', changed);
  return {
    opened(cue) {
      // During an ad the player of the ad owns the element (the same one on iOS): it is never paused from here.
      if (cue?.format === 'midroll' || video.paused !== false) return;
      ours = true;
      expected = true;
      video.pause?.();
      // A pause that fires no event (already pausing) must not swallow the viewer's next one.
      if (video.paused !== true) expected = false;
    },
    closed(byViewer) {
      const resume = ours && byViewer && video.paused === true && !video.ended;
      ours = false;
      if (!resume) return;
      expected = true;
      try {
        void Promise.resolve(video.play?.()).catch(() => { expected = false; });
      } catch {
        expected = false;
      }
    },
    checkout() {
      ours = false;
    },
    dispose() {
      video.removeEventListener('play', changed);
      video.removeEventListener('pause', changed);
    },
  };
}

export function attachHtmlVideo({ video, stage = video.parentElement, ...options }) {
  return attach({ ...options, stage, surface: video, video });
}

export function attachVideoJs({ player, stage, ...options }) {
  const surface = player.el();
  const video = surface.querySelector('video');
  if (!video) throw new Error('A Video.js HTML5 video tech is required');
  const programTime =
    options.programTime ??
    (options.timeline === 'media' ? undefined : () => {
      const vhs = player.tech?.({ IWillNotUseThisInPlugins: true })?.vhs;
      if (!vhs?.convertToProgramTime) return nativeProgramTime(video);
      let utc = null;
      vhs.convertToProgramTime(player.currentTime(), (error, value) => {
        if (!error && value?.programDateTime) utc = Date.parse(value.programDateTime);
      });
      return Number.isFinite(utc) ? utc : null;
    });
  const session = attach({
    ...options,
    programTime,
    stage: stage ?? surface.parentElement,
    surface,
    // The L shrinks the picture only: the player's control bar keeps its width.
    squeezed: video,
    video,
  });
  player.one('dispose', session.destroy);
  // Video.js knows when the viewer's source changes, whatever the element is playing: a new `src()` changes
  // `currentSource()`, while VHS re-attaching its blob (a recovery) does not.
  let current = player.currentSource?.().src;
  const sourceChanged = () => {
    const next = player.currentSource?.().src;
    if (current && next && next !== current) session.closeProduct();
    current = next || current;
  };
  player.on?.('sourceset', sourceChanged);
  player.on?.('loadstart', sourceChanged);
  return {
    ...session,
    destroy() {
      player.off('dispose', session.destroy);
      player.off?.('sourceset', sourceChanged);
      player.off?.('loadstart', sourceChanged);
      session.destroy();
    },
  };
}

export function attachAvPlay({ avplay, getDisplayRect, programTime, ...options }) {
  if (typeof getDisplayRect !== 'function' || typeof programTime !== 'function') {
    throw new Error('Provide the original AVPlay display rectangle and the UTC playhead');
  }
  const commerce = options.commerce ? { ...options.commerce, tv: true } : undefined;
  return attach({ ...options, commerce, avplay, getDisplayRect, programTime });
}

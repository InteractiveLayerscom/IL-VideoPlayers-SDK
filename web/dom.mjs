import { commerceSurface } from './commerce.mjs';
import { sceneRenderer, sceneSupported, sceneFeatures } from './scene.mjs';
import { createSession } from './session.mjs';
import { imageVisible, listenToVideo, nativeProgramTime } from './video.mjs';

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
  const doc = stage.ownerDocument;
  let layer,
    images = [],
    originalStyles,
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

  function hide() {
    scenes.hide();
    commerce.hide();
    layer?.remove();
    layer = null;
    images = [];
    squeeze(false);
  }

  function show(cue, time, stillActive) {
    if (cue.format === 'midroll') { commerce.show(cue, stillActive); return; }
    if (cue.scene) {
      scenes.show(cue, time, stillActive);
      return;
    }
    const root = doc.createElement('div');
    Object.assign(root.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
      visibility: 'hidden',
      zIndex: '1',
    });
    root.setAttribute('aria-hidden', 'true');
    layer = root;
    const l = cue.format === 'l';
    // Crop a single canvas into margins. A JPEG can be fully opaque, including on a hardware video plane.
    const bands = l
      ? [
          ['75%', '0', '25%', '75%', '-300%', '0', '400%', '133.333334%'],
          ['0', '75%', '100%', '25%', '0', '-300%', '100%', '400%'],
        ]
      : cue.format === 'overlay'
        ? [['64%', '10%', '30%', '32%', '0', '0', '100%', '100%']]
        : [['12.5%', '70%', '75%', '20%', '0', '0', '100%', '100%']];
    let ready = 0;
    function loaded() {
      if (root !== layer || !stillActive() || ++ready !== bands.length) return;
      if (l && !squeeze(true)) return;
      root.style.visibility = 'visible';
      commerce.show(cue, stillActive);
    }
    for (const [left, top, width, height, x, y, w, h] of bands) {
      const band = doc.createElement('div');
      Object.assign(band.style, {
        position: 'absolute',
        left,
        top,
        width,
        height,
        overflow: 'hidden',
      });
      const img = doc.createElement('img');
      img.alt = '';
      Object.assign(img.style, {
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        maxWidth: 'none',
        maxHeight: 'none',
        objectFit: 'contain',
      });
      img.addEventListener('load', loaded, { once: true });
      img.addEventListener(
        'error',
        () => {
          if (root === layer) hide();
        },
        { once: true },
      );
      band.appendChild(img);
      root.appendChild(band);
      images.push(img);
      img.src = cue.imageUrl;
    }
    stage.appendChild(root);
  }
  return {
    show,
    hide,
    update: scenes.update,
    applyAudioPermissions: scenes.applyAudioPermissions,
    visible: cue => cue.scene ? scenes.visible() :
      layer?.style.visibility === 'visible' && images.length > 0 && images.every(imageVisible),
  };
}

function attach({ stage, surface, video, avplay, getDisplayRect, programTime, ...source }) {
  if (!stage || !surface || stage === surface || !stage.contains(surface)) {
    throw new Error('The stage must contain the existing video surface');
  }
  const presenting = avplay
    ? () => ['PLAYING', 'PAUSED'].includes(avplay.getState()) && !stage.ownerDocument.hidden
    : () => !video.ended && !video.seeking && video.readyState >= 2 && !stage.ownerDocument.hidden;
  const playing = () => presenting() && (avplay ? avplay.getState() === 'PLAYING' : !video.paused);
  const clock = programTime ?? (() => nativeProgramTime(video));
  const commerce = commerceSurface(stage, source.commerce, source.fetchImpl);
  const allowVideo = source.secondaryVideo ?? !avplay;
  const allowAudio = allowVideo && source.secondaryVideoAudio === true;
  const window = stage.ownerDocument.defaultView;
  const session = createSession({
    ...source,
    playing,
    presenting,
    scenes: sceneSupported(window),
    sceneFeatures: sceneFeatures(window, allowVideo, allowAudio),
    clock,
    renderer: renderer(stage, surface, avplay, getDisplayRect, commerce, {
      clock, moving: playing, tv: Boolean(avplay || source.commerce?.tv),
      allowVideo, allowAudio, animate: source.interval !== false,
    }),
  });
  const unlisten = video ? listenToVideo(video, session.tick) : () => {};
  return {
    ...session,
    destroy() {
      unlisten();
      session.destroy();
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
    (() => {
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
    video,
  });
  player.one('dispose', session.destroy);
  return {
    ...session,
    destroy() {
      player.off('dispose', session.destroy);
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

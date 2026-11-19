import { commerceSurface } from './commerce.mjs';
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

function renderer(stage, surface, avplay, getDisplayRect, commerce) {
  const doc = stage.ownerDocument;
  let layer,
    images = [],
    originalStyles,
    originalRect;
  function hide() {
    commerce.hide();
    layer?.remove();
    layer = null;
    images = [];
    if (originalStyles) {
      for (const [key, value, priority] of originalStyles)
        surface.style.setProperty(key, value, priority);
      originalStyles = null;
    }
    if (originalRect) {
      const { x, y, width, height } = originalRect;
      originalRect = null;
      // STOPPED/IDLE does not accept a rectangle. The app reapplies its base rect when preparing a new asset.
      if (['READY', 'PLAYING', 'PAUSED'].includes(avplay.getState()))
        avplay.setDisplayRect(x, y, width, height);
    }
  }

  function show(cue, time, stillActive) {
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
      if (l) {
        if (avplay) {
          const rect = getDisplayRect();
          if (
            !rect ||
            ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
            rect.width <= 0 ||
            rect.height <= 0
          )
            return;
          try {
            avplay.setDisplayRect(
              rect.x,
              rect.y,
              Math.round(rect.width * 0.75),
              Math.round(rect.height * 0.75),
            );
          } catch {
            return;
          }
          originalRect = { ...rect };
        }
        originalStyles = Object.keys(resized).map((key) => [
          key,
          surface.style.getPropertyValue(key),
          surface.style.getPropertyPriority(key),
        ]);
        Object.assign(surface.style, resized);
      }
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
    visible: () =>
      layer?.style.visibility === 'visible' && images.length > 0 && images.every(imageVisible),
  };
}

function attach({ stage, surface, video, avplay, getDisplayRect, programTime, ...source }) {
  if (!stage || !surface || stage === surface || !stage.contains(surface)) {
    throw new Error('The stage must contain the existing video surface');
  }
  const playing = avplay
    ? () => avplay.getState() === 'PLAYING' && !stage.ownerDocument.hidden
    : () =>
        !video.paused &&
        !video.ended &&
        !video.seeking &&
        video.readyState >= 2 &&
        !stage.ownerDocument.hidden;
  const clock = programTime ?? (() => nativeProgramTime(video));
  const session = createSession({
    ...source,
    playing,
    clock,
    renderer: renderer(stage, surface, avplay, getDisplayRect, commerceSurface(stage, source.commerce, source.fetchImpl)),
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

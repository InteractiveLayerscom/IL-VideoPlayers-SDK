import { imageVisible } from './video.mjs';

// Still-image graphics (Super, overlay, L) drawn as cropped bands of one canvas. `squeeze` shrinks the video for an L
// and is injected, so this runs on a page without a video surface too. `fail` runs when an image does not load.
export function bandRenderer(stage, commerce, { squeeze, fail, hidden } = {}) {
  const doc = stage.ownerDocument;
  let layer,
    images = [];
  function hide() {
    layer?.remove();
    layer = null;
    images = [];
  }
  function show(cue, stillActive, onClick) {
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
      if (l && !(squeeze?.(true) ?? false)) return;
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
          if (root === layer) (fail ?? hide)();
        },
        { once: true },
      );
      band.appendChild(img);
      if (cue.clickUrl) {
        // Only the graphic's bands take clicks; the root keeps letting them through to the video.
        const link = doc.createElement('a');
        link.href = cue.clickUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        // The graphic layer is hidden from assistive technology, so the link stays out of the tab order.
        link.tabIndex = -1;
        Object.assign(link.style, { position: 'absolute', inset: '0', pointerEvents: 'auto' });
        link.addEventListener('click', () => onClick?.(cue));
        band.appendChild(link);
      }
      root.appendChild(band);
      images.push(img);
      img.src = cue.imageUrl;
    }
    stage.appendChild(root);
  }
  return {
    show,
    hide,
    visible: () => layer?.style.visibility === 'visible' && images.length > 0 && images.every(image => imageVisible(image, hidden)),
  };
}

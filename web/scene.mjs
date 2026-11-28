import { isHttps } from './commerce.mjs';
import { accentInk } from './tv-shop.mjs';

const types = new Set(['rect', 'ellipse', 'line', 'text', 'image', 'video', 'group', 'product']);
const properties = ['x', 'y', 'scale', 'rotation', 'opacity'];
const easing = {
  linear: t => t,
  'ease-in': t => t * t,
  'ease-out': t => 1 - (1 - t) ** 2,
  'ease-in-out': t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2,
};

export function normalizeScene(value, format) {
  if (!value || value.format !== format ||
      ![value.width, value.height, value.durationMs].every(n => Number.isFinite(n) && n > 0) ||
      !Array.isArray(value.layers) || !value.layers.length || value.layers.length > 512) return null;
  const layers = value.layers.filter(layer => layer && !layer.hidden && types.has(layer.type) &&
    typeof layer.id === 'string' && [layer.x, layer.y, layer.width, layer.height].every(Number.isFinite) &&
    layer.width >= 0 && layer.height >= 0).map(layer => ({
    ...layer,
    keyframes: Array.isArray(layer.keyframes) ? layer.keyframes.filter(frame => frame &&
      Number.isFinite(frame.timeMs) && frame.timeMs >= 0).sort((a, b) => a.timeMs - b.timeMs) : [],
  }));
  return layers.length ? {
    format, width: value.width, height: value.height, durationMs: value.durationMs, layers,
  } : null;
}

function getFrame(layer, time) {
  const values = {
    x: layer.x, y: layer.y, scale: 1,
    rotation: Number.isFinite(layer.rotation) ? layer.rotation : 0,
    opacity: Number.isFinite(layer.opacity) ? layer.opacity : 1,
  };
  for (const name of properties) {
    let start = 0;
    for (const keyframe of layer.keyframes) {
      const next = keyframe[name];
      if (!Number.isFinite(next)) continue;
      if (time < keyframe.timeMs) {
        const progress = (time - start) / (keyframe.timeMs - start);
        const curve = Object.prototype.hasOwnProperty.call(easing, keyframe.easing) ? easing[keyframe.easing] : easing.linear;
        values[name] += (next - values[name]) * curve(progress);
        break;
      }
      values[name] = next;
      start = keyframe.timeMs;
    }
  }
  return values;
}

function hexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value);
}

function rgbaTransparent(value) {
  return /^rgba\(.*,[ ]*0\)$/.test(value);
}

function cssColor(value) {
  return typeof value === 'string' ? value : '';
}

const place = {
  l: ['0', '0', '100%', '100%'],
  super: ['12.5%', '70%', '75%', '20%'],
  overlay: ['64%', '10%', '30%', '32%'],
};
const lMask = 'polygon(75% 0, 100% 0, 100% 100%, 0 100%, 0 75%, 75% 75%)';
const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

// A layer whose font list starts with Montserrat (quotes and case ignored; "Montserrat Alternates" is another family)
// gets the SDK's own face first. Any other value is left as it is.
export function sceneFontFamily(value) {
  if (typeof value !== 'string') return '';
  const first = value.split(',', 1)[0].trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  return first.toLowerCase() === 'montserrat' ? "'IL Montserrat', " + value : value;
}

export function sceneSupported(window) {
  return window.CSS?.supports?.('clip-path', lMask) ?? true;
}

export function sceneFeatures(window, allowVideo, allowAudio) {
  const features = ['media-mask', 'media-crop'];
  const supports = window.CSS?.supports?.bind(window.CSS);
  if (!supports || (supports('background-image', 'linear-gradient(90deg, #000, #fff)') &&
      supports('box-shadow', '0 0 1px #000') && supports('-webkit-line-clamp', '2'))) features.push('rich-style');
  if (allowVideo) {
    features.push('video');
    if (allowAudio) features.push('audio');
  }
  return features;
}

const pct = (position, size) => Number((100 * position / size).toFixed(6)) + '%';

function mediaRadius(layer) {
  if (layer.mask === 'rect') return 0;
  const radius = layer.radius ?? (layer.mask === 'rounded' ? 12 : 0);
  return Math.min(radius, layer.width / 2, layer.height / 2);
}

function mediaTransform(crop) {
  if (!crop || ![crop.x, crop.y, crop.zoom].every(Number.isFinite)) return '';
  const zoom = Math.min(4, Math.max(1, crop.zoom));
  const shift = value => Math.min(1, Math.max(-1, value)) * (zoom - 1) * 50;
  return 'translate(' + shift(crop.x) + '%, ' + shift(crop.y) + '%) scale(' + zoom + ')';
}

function makeMedia(doc, layer, allowVideo, allowAudio, imageUrl) {
  const image = doc.createElement('img');
  const source = layer.type === 'video' ? layer.poster : imageUrl;
  let imageReady = false;
  let video;
  let playing = false;
  let videoReady = false;
  const fit = ['contain', 'fill'].includes(layer.fit) ? layer.fit : 'cover';
  const style = { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: fit,
    transform: mediaTransform(layer.mediaCrop) };
  image.alt = typeof layer.alt === 'string' ? layer.alt : '';
  image.referrerPolicy = 'no-referrer';
  image.draggable = false;
  Object.assign(image.style, style);
  if (isHttps(source)) {
    image.addEventListener('load', () => { imageReady = true; }, { once: true });
    image.addEventListener('error', () => { imageReady = false; image.hidden = true; }, { once: true });
    image.src = source;
  } else image.hidden = true;
  function stopVideo() {
    if (!video) return;
    video.pause();
    video.remove();
    video.removeAttribute('src');
    video.load();
    video = null;
    videoReady = false;
    if (isHttps(source)) image.hidden = false;
  }
  if (layer.type === 'video' && allowVideo && isHttps(layer.src)) {
    video = doc.createElement('video');
    video.preload = 'auto';
    video.muted = !(allowAudio && layer.audio === true);
    video.defaultMuted = video.muted;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    Object.assign(video.style, style, { visibility: 'hidden' });
    video.addEventListener('loadeddata', () => {
      if (!video) return;
      videoReady = true;
      video.style.visibility = 'inherit';
      image.hidden = true;
    }, { once: true });
    video.addEventListener('error', stopVideo, { once: true });
    video.src = layer.src;
  }
  return {
    appendTo(node) {
      node.appendChild(image);
      if (video) node.appendChild(video);
    },
    mute() {
      if (video) video.defaultMuted = video.muted = true;
    },
    update(active, moving, time) {
      if (!video) return;
      const start = (layer.trimStartMs ?? 0) / 1000;
      const end = Number.isFinite(layer.trimEndMs) ? layer.trimEndMs / 1000 : video.duration;
      const elapsed = Math.max(0, time - (layer.startMs ?? 0)) / 1000;
      const length = end - start;
      const ended = length > 0 && !layer.loop && elapsed >= length;
      const position = start + (length > 0 ? layer.loop ? elapsed % length : Math.min(elapsed, length) : elapsed);
      if (active && video.readyState >= 1 && Math.abs(video.currentTime - position) > 0.22)
        video.currentTime = position;
      const shouldPlay = active && moving && !ended;
      if (shouldPlay === playing) return;
      playing = shouldPlay;
      if (playing) {
        const attempt = video;
        function onBlocked() {
          if (attempt !== video || !playing) return;
          if (attempt.muted) return stopVideo();
          // Autoplay permission can change after negotiation. Keep showing the creative.
          attempt.muted = true;
          play();
        }
        function play() {
          try { attempt.play()?.catch(onBlocked); }
          catch { onBlocked(); }
        }
        play();
      } else video.pause();
    },
    visible: () => imageReady || image.complete && image.naturalWidth > 0 || videoReady,
    dispose() {
      stopVideo();
      image.removeAttribute('src');
    },
  };
}

const PAINTED_CTA = /\b(comprar|buy|shop now|ver producto|view product|ver produto)\b/i;
const CTA_NAME = /\b(cta|bot[oó]n|button|bot[aã]o)\b/i;
const insideCard = (layer, card) => layer !== card && layer.x >= card.x && layer.y >= card.y &&
  layer.x + layer.width <= card.x + card.width && layer.y + layer.height <= card.y + card.height;

// A product card whose whole surface is the action shows nothing that says so: it gets a visible Buy control. Not when
// something inside it is already a button: a layer with its own action, a CTA by name, or painted words like «Comprar».
function wantsBuyChip(card, scene, products, commerce) {
  if (!commerce.enabled || card.action !== 'product' || !products[card.productIndex]) return false;
  const inner = scene.layers.filter(layer => insideCard(layer, card));
  return inner.length > 0 && !inner.some(layer => layer.action || (!layer.binding && (
    PAINTED_CTA.test(layer.text ?? '') || CTA_NAME.test(layer.name ?? ''))));
}

function makeBuyChip(doc, label, brand) {
  const accent = brand?.accent ?? '#ffffff';
  const chip = doc.createElement('span');
  chip.className = 'il-scene-buy';
  chip.textContent = label;
  chip.setAttribute('aria-hidden', 'true');
  Object.assign(chip.style, { position: 'absolute', display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', pointerEvents: 'none', whiteSpace: 'nowrap', fontWeight: '700', lineHeight: '1', zIndex: '1',
    fontFamily: 'system-ui, sans-serif', backgroundColor: accent, color: accentInk(accent) });
  return chip;
}

// Text that reads as a price, bound or painted: «$100», «USD 10.0», «16,00 US$», «R$ 9,90».
const PRICE_TEXT = /(?:[$€£¥]|\b(?:USD|EUR|ARS|BRL|MXN|CLP|COP|US\$|R\$))\s?\d|\d[\d.,]*\s?(?:[$€£¥]|\b(?:USD|EUR|ARS|BRL|MXN|CLP|COP)\b|US\$|R\$)/i;
const CHIP_MIN_WIDTH = 44;
const CHIP_MIN_FONT = 10;

// Sized from its own label, in a corner of the card where it covers no price, and no other text if it can. It shrinks
// to fit; when it cannot fit whole without touching the price it is left out, and the whole card stays the button.
function placeBuyChip(chip, card, texts) {
  const width = card.clientWidth, height = card.clientHeight;
  chip.style.display = 'none';
  if (!width || !height) return;
  const box = card.getBoundingClientRect();
  const drawn = texts.map(({ text, price }) => {
    const range = card.ownerDocument.createRange();
    range.selectNodeContents(text);
    const rect = range.getBoundingClientRect();
    return { price: price || PRICE_TEXT.test(text.textContent), left: rect.left - box.left, right: rect.right - box.left,
      top: rect.top - box.top, bottom: rect.bottom - box.top };
  }).filter(rect => rect.right > rect.left);
  const prices = drawn.filter(rect => rect.price);
  for (let font = Math.max(CHIP_MIN_FONT, Math.min(18, height * 0.2)); font >= CHIP_MIN_FONT; font -= 2) {
    Object.assign(chip.style, { display: 'flex', fontSize: font + 'px', width: 'auto', height: 'auto',
      padding: '0 ' + font * 0.7 + 'px', borderRadius: font * 0.4 + 'px' });
    const chipWidth = Math.max(CHIP_MIN_WIDTH, Math.ceil(chip.scrollWidth));
    const chipHeight = Math.ceil(font * 2);
    const margin = Math.max(2, Math.round(height * 0.06));
    chip.style.display = 'none';
    if (chipWidth > width - 2 * margin || chipHeight > height - 2 * margin) continue;
    const right = width - chipWidth - margin, below = height - chipHeight - margin;
    // The right side first; on a small card, where the text fills it, over the picture on the left.
    const spots = [[right, below], [right, margin], [right, (height - chipHeight) / 2], [margin, below], [margin, margin]];
    const clear = rects => ([x, y]) => !rects.some(rect => rect.left < x + chipWidth && rect.right > x &&
      rect.top < y + chipHeight && rect.bottom > y);
    const spot = spots.find(clear(drawn)) ?? spots.find(clear(prices));
    if (!spot) continue;
    Object.assign(chip.style, { display: 'flex', left: spot[0] + 'px', top: spot[1] + 'px', width: chipWidth + 'px',
      height: chipHeight + 'px' });
    return;
  }
}

// All web hosts share the same scene and controls. Legacy stills retain their original path.
export function sceneRenderer(stage, commerce, { squeeze, clock, moving, tv, allowVideo, allowAudio, animate, hidden }) {
  const doc = stage.ownerDocument;
  const win = doc.defaultView;
  let current;
  // The first control of the scene on screen: where focus goes when a product kept past its ad is closed.
  commerce.setFocusTarget?.(() => current?.entries.find(entry => entry.action && entry.visible)?.action ?? null);

  function hide() {
    if (!current) return;
    // An open product stays when its scene goes: only a closed card goes with it.
    commerce.retire(current.originalFocus);
    win.cancelAnimationFrame?.(current.frame);
    current.observer?.disconnect();
    for (const entry of current.entries) entry.media?.dispose();
    current.root.remove();
    current.floats?.remove();
    if (current.squeezed) squeeze(false);
    if (current.originalFocus?.isConnected && doc.activeElement === doc.body)
      current.originalFocus.focus();
    current = null;
  }

  function show(cue, time, stillActive) {
    hide();
    const { scene, products } = cue;
    const root = doc.createElement('div');
    const [left, top, width, height] = place[scene.format];
    const l = scene.format === 'l';
    root.className = 'il-scene';
    Object.assign(root.style, {
      position: 'absolute', left, top, width, height, overflow: 'hidden',
      pointerEvents: 'none', zIndex: '1', ...(l ? { clipPath: lMask } : {}),
    });

    const entries = [];
    for (const layer of scene.layers) {
      const offer = Number.isInteger(layer.productIndex) ? products[layer.productIndex] : null;
      const node = doc.createElement('div');
      node.dataset.layerId = layer.id;
      const elliptical = layer.type === 'ellipse' || layer.mask === 'ellipse';
      const radius = mediaRadius(layer);
      Object.assign(node.style, {
        position: 'absolute', boxSizing: 'border-box', overflow: 'hidden',
        width: pct(layer.width, scene.width), height: pct(layer.height, scene.height),
        borderRadius: elliptical ? '50%' : pct(radius, layer.width || 1),
      });
      let media, textContent, line, draw = false;
      if (layer.type === 'text' && layer.binding !== 'image') {
        let text = layer.text ?? '';
        if (layer.binding === 'title') text = offer?.title ?? '';
        if (layer.binding === 'price') text = offer ? new Intl.NumberFormat(offer.locale, {
          style: 'currency', currency: offer.currency,
        }).format(Number(offer.price)) : '';
        textContent = doc.createElement('div');
        textContent.textContent = text;
        Object.assign(textContent.style, {
          color: cssColor(layer.fill) || '#fff', fontFamily: sceneFontFamily(layer.fontFamily),
          fontStyle: layer.fontStyle === 'italic' ? 'italic' : 'normal',
          fontWeight: Number.isFinite(Number(layer.fontWeight)) ? String(layer.fontWeight) : '',
          lineHeight: String(Number.isFinite(layer.lineHeight) && layer.lineHeight > 0 ? layer.lineHeight : 1.1),
          textAlign: ['left', 'center', 'right'].includes(layer.textAlign) ? layer.textAlign : 'left',
          whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
        });
        if (Number.isInteger(layer.maxLines) && layer.maxLines > 0) Object.assign(textContent.style, {
          display: '-webkit-box', webkitBoxOrient: 'vertical', webkitLineClamp: String(layer.maxLines), overflow: 'hidden',
        });
        node.appendChild(textContent);
        draw = Boolean(text);
      } else if (layer.type === 'image' || layer.type === 'video' || layer.binding === 'image') {
        media = makeMedia(doc, layer, allowVideo, allowAudio, layer.binding === 'image' ? offer?.imageUrl : layer.src);
        media.appendTo(node);
      } else if (layer.type === 'line') {
        const color = cssColor(layer.stroke || layer.fill) || '#fff';
        line = doc.createElement('div');
        Object.assign(line.style, { position: 'absolute', left: '0', right: '0', top: '50%',
          transform: 'translateY(-50%)', backgroundColor: color });
        node.appendChild(line);
        if (layer.arrow) {
          const arrow = doc.createElement('div');
          Object.assign(arrow.style, { position: 'absolute', right: '0', top: '0',
            width: '10%', height: '100%', backgroundColor: color, clipPath: 'polygon(0 0, 100% 50%, 0 100%)' });
          node.appendChild(arrow);
        }
        draw = true;
      } else {
        node.style.backgroundColor = cssColor(layer.fill);
        const { gradient } = layer;
        if (gradient && hexColor(gradient.from) && hexColor(gradient.to) && Number.isFinite(gradient.angle))
          node.style.backgroundImage = 'linear-gradient(' + gradient.angle + 'deg,' + gradient.from + ',' + gradient.to + ')';
        const color = node.style.backgroundColor;
        draw = Boolean(node.style.backgroundImage || color && color !== 'transparent' && !rgbaTransparent(color));
      }
      if (layer.type !== 'line' && layer.stroke && layer.strokeWidth > 0) {
        node.style.borderColor = cssColor(layer.stroke);
        node.style.borderStyle = 'solid';
        draw ||= Boolean(node.style.borderColor && !rgbaTransparent(node.style.borderColor));
      }
      let action, buyChip;
      if ((offer && (layer.action === 'product' || layer.type === 'product') && commerce.enabled) ||
          (layer.action === 'link' && isHttps(layer.url))) {
        const product = layer.action !== 'link';
        action = doc.createElement(product ? 'button' : 'a');
        action.className = 'il-scene-action';
        Object.assign(action.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
          boxSizing: 'border-box', pointerEvents: 'auto', background: 'transparent', padding: '0', border: 'none' });
        if (product) {
          action.type = 'button';
          const chipped = wantsBuyChip(layer, scene, products, commerce);
          action.setAttribute('aria-label', chipped ? `${commerce.buyLabel(offer)}: ${offer.title}` : offer.title);
          if (chipped) buyChip = makeBuyChip(doc, commerce.buyLabel(offer), cue.brand);
          action.addEventListener('click', () => {
            if (stillActive()) commerce.open(cue, offer, action, stillActive);
          });
        } else {
          action.href = layer.url;
          action.rel = 'noopener noreferrer';
          action.target = '_blank';
          action.setAttribute('aria-label', layer.name || layer.text || new URL(layer.url).hostname);
        }
        node.appendChild(action);
        if (buyChip) node.appendChild(buyChip);
      }
      const entry = { layer, node, media, action, draw, textContent, line, buyChip };
      action?.addEventListener('keydown', event => {
        if (tv && (event.key === 'Enter' || event.key === 'OK')) {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) action.click();
          return;
        }
        const direction = directions[event.key];
        if (!direction) return;
        const candidates = entries.filter(other => other !== entry && other.action && other.visible)
          .map(other => {
            const dx = (other.position.x + other.layer.width / 2 - entry.position.x - layer.width / 2) / scene.width;
            const dy = (other.position.y + other.layer.height / 2 - entry.position.y - layer.height / 2) / scene.height;
            return { other, forward: direction[0] * dx + direction[1] * dy,
              across: Math.abs(direction[1] * dx + direction[0] * dy) };
          }).filter(item => item.forward > 0)
          .sort((a, b) => (a.forward + 2 * a.across) - (b.forward + 2 * b.across));
        candidates[0]?.other.action.focus();
        event.preventDefault();
        event.stopPropagation();
      });
      entries.push(entry);
      root.appendChild(node);
    }
    stage.appendChild(root);
    current = { root, entries, originalFocus: doc.activeElement };
    // A web font arriving later changes the label's width: the chips are placed again.
    doc.fonts?.ready?.then(() => {
      if (current?.root !== root) return;
      for (const entry of entries) entry.chipSize = null;
      update(clock());
    }).catch?.(() => {});
    // Whatever sits under the host's controls could not be pressed. A Super or overlay moves up whole, so nothing of it
    // is clipped; in an L, whose bands are fixed, the button moves up with the layers drawn on it.
    current.liftActions = () => {
      let safe = 0;
      try {
        safe = parseFloat(win.getComputedStyle(stage).getPropertyValue('--il-safe-bottom')) || 0;
      } catch {
        safe = 0;
      }
      if (!l) {
        const over = Math.max(0, root.offsetTop + root.clientHeight - (stage.clientHeight - safe));
        root.style.translate = safe && over ? `0 ${-over}px` : '';
        return;
      }
      const scale = root.clientHeight / scene.height;
      for (const entry of entries) {
        if (!entry.action) continue;
        const { x, y, width, height } = entry.layer;
        const lift = safe && scale ? Math.max(0, (y + height) * scale - (root.clientHeight - safe)) : 0;
        for (const other of entries) {
          const on = other === entry || (!other.action && other.layer.x >= x && other.layer.y >= y &&
            other.layer.x + other.layer.width <= x + width && other.layer.y + other.layer.height <= y + height);
          if (on) other.node.style.translate = lift ? `0 ${-lift}px` : '';
          // Lifted out of the L's bands, it would be cut by their mask: it moves to an unmasked twin of the scene.
          if (on && lift && l && other.node.parentNode === root) {
            if (!current.floats) {
              current.floats = doc.createElement('div');
              current.floats.className = 'il-scene-floats';
              Object.assign(current.floats.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none', zIndex: '1' });
              stage.appendChild(current.floats);
            }
            current.floats.appendChild(other.node);
          }
        }
      }
    };
    if (win.ResizeObserver) {
      current.observer = new win.ResizeObserver(() => update(clock()));
      current.observer.observe(root);
    }
    update(time);
    if (animate && win.requestAnimationFrame) {
      function frame() {
        if (!current || current.root !== root) return;
        if (stillActive()) {
          update(clock());
          current.frame = win.requestAnimationFrame(frame);
        }
      }
      current.frame = win.requestAnimationFrame(frame);
    }

    function update(now) {
      if (!current || current.root !== root) return;
      const elapsed = Math.min(scene.durationMs, Math.max(0, now - cue.start));
      const movingNow = moving();
      current.liftActions();
      const fontRatio = root.clientWidth / scene.width;
      let hasArtwork = false;
      for (const entry of entries) {
        const { layer, node, media, action, draw, textContent, line } = entry;
        const position = getFrame(layer, elapsed);
        const { x, y, opacity, rotation, scale } = position;
        const withinTime = elapsed >= (layer.startMs ?? 0) && elapsed < (layer.endMs ?? Infinity);
        const active = withinTime && opacity > 0 && scale > 0;
        entry.position = position;
        node.style.left = pct(x, scene.width);
        node.style.top = pct(y, scene.height);
        node.style.opacity = String(Math.min(1, Math.max(0, opacity)));
        node.style.transform = 'rotate(' + rotation + 'deg) scale(' + scale + ')';
        node.style.visibility = active ? 'visible' : 'hidden';
        if (fontRatio) {
          if (textContent) {
            textContent.style.fontSize = Math.max(1, (layer.fontSize ?? 24) * fontRatio) + 'px';
            textContent.style.letterSpacing = ((layer.letterSpacing ?? 0) * fontRatio) + 'px';
          }
          if (layer.type !== 'ellipse' && layer.mask !== 'ellipse')
            node.style.borderRadius = (mediaRadius(layer) * fontRatio) + 'px';
          if (line) line.style.height = Math.max(1, (layer.strokeWidth ?? 1) * fontRatio) + 'px';
          else if (layer.strokeWidth > 0) node.style.borderWidth = (layer.strokeWidth * fontRatio) + 'px';
          if (layer.shadow && [layer.shadow.x, layer.shadow.y, layer.shadow.blur].every(Number.isFinite) &&
              hexColor(layer.shadow.color)) {
            const { x, y, blur, color } = layer.shadow;
            node.style.boxShadow = [x, y, Math.max(0, blur)].map(n => n * fontRatio + 'px').join(' ') + ' ' + color;
          }
        }
        media?.update(active, movingNow, elapsed);
        // Approximate clipping bounds in scene coordinates, including rotated/scaled layers.
        const angle = rotation * Math.PI / 180;
        const radiusX = (Math.abs(layer.width * Math.cos(angle)) + Math.abs(layer.height * Math.sin(angle))) * scale / 2;
        const radiusY = (Math.abs(layer.width * Math.sin(angle)) + Math.abs(layer.height * Math.cos(angle))) * scale / 2;
        const centerX = x + layer.width / 2;
        const centerY = y + layer.height / 2;
        const inFrame = centerX + radiusX > 0 && centerY + radiusY > 0 &&
          centerX - radiusX < scene.width && centerY - radiusY < scene.height;
        const inBand = !l || centerX + radiusX > scene.width * 0.75 || centerY + radiusY > scene.height * 0.75;
        entry.visible = active && inFrame && inBand;
        if (action) {
          action.tabIndex = entry.visible ? 0 : -1;
          action.style.pointerEvents = entry.visible ? 'auto' : 'none';
        }
        if (entry.visible && (draw || media?.visible())) hasArtwork = true;
      }
      if (hasArtwork && l && cue.layout !== 'overlay' && !current.squeezed) {
        if (!squeeze(true)) hasArtwork = false;
        else current.squeezed = true;
      }
      if (!hasArtwork && current.squeezed) {
        squeeze(false);
        current.squeezed = false;
      }
      root.style.display = hasArtwork ? '' : 'none';
      for (const entry of entries) {
        if (!entry.buyChip || !root.clientWidth) continue;
        const inner = entries.filter(other => other.textContent && insideCard(other.layer, entry.layer));
        // Placed again when the card's size, its texts or where they are drawn change.
        const size = [entry.node.clientWidth, entry.node.clientHeight, ...inner.map(other => [other.textContent.textContent,
          other.textContent.style.fontSize, other.node.style.left, other.node.style.top].join(' '))].join('|');
        if (entry.chipSize === size) continue;
        entry.chipSize = size;
        placeBuyChip(entry.buyChip, entry.node, inner.map(other => ({ text: other.textContent,
          price: /price/i.test(other.layer.binding ?? '') })));
      }
      if (current.floats) current.floats.style.display = root.style.display;
      if (tv && hasArtwork && !current.didFocus) {
        const first = entries.find(entry => entry.action && entry.visible);
        if (first) {
          current.didFocus = true;
          first.action.focus();
        }
      }
      current.visible = hasArtwork;
    }
    current.update = update;
  }

  return {
    show, hide,
    applyAudioPermissions(cue) {
      if (!allowAudio || !current) return;
      const audible = new Set(cue.scene?.layers.filter(layer => layer.audio === true).map(layer => layer.id));
      for (const entry of current.entries) if (!audible.has(entry.layer.id)) entry.media?.mute();
    },
    update(time) { current?.update?.(time); },
    visible() {
      if (!current?.visible || !current.root.isConnected || (hidden ? hidden() : doc.hidden)) return false;
      const rect = current.root.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 ||
          rect.left >= win.innerWidth || rect.top >= win.innerHeight) return false;
      for (let node = current.root; node; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0) return false;
      }
      return true;
    },
  };
}

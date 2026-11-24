import { accentInk, brandSurface, openTVShop } from './tv-shop.mjs';

export function isHttps(value) {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function commerceLocale(locale) {
  const language = typeof locale === 'string' ? locale.toLowerCase().split('-')[0] : '';
  if (language === 'pt') return 'pt-BR';
  return language === 'es' ? 'es' : 'en';
}

function validText(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

function decimal(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  return typeof value === 'string' && /^\d{1,12}(?:\.\d{1,6})?$/.test(value) ? value : null;
}

export function normalizeCommerce(value) {
  if (!value || !validText(value.title, 256) || !isHttps(value.handoffUrl) ||
      !/^[A-Z]{3}$/.test(value.currency) || !Array.isArray(value.variants) ||
      value.variants.length === 0 || value.variants.length > 2048) return null;
  const price = decimal(value.price);
  if (price === null) return null;
  const ids = new Set();
  const variants = [];
  for (const variant of value.variants) {
    if (!variant || !validText(variant.id, 128) || !validText(variant.label, 2048) ||
        ids.has(variant.id)) return null;
    const amount = variant.price == null ? price : decimal(variant.price);
    if (amount === null) return null;
    ids.add(variant.id);
    const selectedOptions = Array.isArray(variant.selectedOptions) && variant.selectedOptions.length <= 3 &&
      variant.selectedOptions.every(pair => pair && validText(pair.name, 512) && validText(pair.value, 512))
      ? variant.selectedOptions.map(({name, value}) => ({name, value})) : [];
    variants.push({ id: variant.id, label: variant.label, price: amount,
      ...(selectedOptions.length ? { selectedOptions } : {}),
      ...(decimal(variant.previousPrice) ? { previousPrice: decimal(variant.previousPrice) } : {}),
      ...(typeof variant.availableForSale === 'boolean' ? { availableForSale: variant.availableForSale } : {}),
      ...(isHttps(variant.imageUrl) ? { imageUrl: variant.imageUrl } : {}),
    });
  }
  return {
    title: value.title, currency: value.currency, price, variants,
    locale: commerceLocale(value.locale), handoffUrl: value.handoffUrl,
    ...(validText(value.vendor, 255) ? { vendor: value.vendor } : {}),
    ...(validText(value.description, 5000) ? { description: value.description } : {}),
    ...(isHttps(value.imageUrl) ? { imageUrl: value.imageUrl } : {}),
    ...(Array.isArray(value.images) ? { images: [...new Set(value.images.filter(isHttps))] } : {}),
    ...(decimal(value.previousPrice) ? { previousPrice: decimal(value.previousPrice) } : {}),
    ...(isHttps(value.viewUrl) ? { viewUrl: value.viewUrl } : {}),
  };
}

export function normalizeBrand(value) {
  if (!value || typeof value !== 'object') return null;
  const brand = {};
  if (isHttps(value.logoUrl)) brand.logoUrl = value.logoUrl;
  for (const key of ['accent', 'background', 'foreground'])
    if (typeof value[key] === 'string' && /^#[0-9a-f]{6}$/i.test(value[key])) brand[key] = value[key];
  return Object.keys(brand).length ? brand : null;
}


const copy = {
  en: ['View product', 'Product', 'Variant', 'Buy', 'Scan with your phone', 'Continue to Shopify',
    'Close', 'Preparing your cart…', 'Could not prepare the cart. Try again.', 'This offer is no longer available.'],
  es: ['Ver producto', 'Producto', 'Variante', 'Comprar', 'Escaneá el código con tu celular', 'Continuar a Shopify',
    'Cerrar', 'Preparando tu carrito…', 'No se pudo preparar el carrito. Intentá de nuevo.', 'Esta oferta ya no está disponible.'],
  'pt-BR': ['Ver produto', 'Produto', 'Variante', 'Comprar', 'Escaneie com seu celular', 'Continuar para Shopify',
    'Fechar', 'Preparando seu carrinho…', 'Não foi possível preparar o carrinho. Tente novamente.', 'Esta oferta não está mais disponível.'],
};

// How much of the bottom of the stage the host's controls take. `insets.bottom` wins, then a --il-safe-bottom the host's
// CSS sets, then what the adapter knows of its own controls.
export function applySafeArea(stage, insets, known) {
  const bottom = Number.isFinite(insets?.bottom) && insets.bottom >= 0 ? insets.bottom : null;
  let declared = '';
  try {
    declared = stage.ownerDocument.defaultView.getComputedStyle(stage).getPropertyValue('--il-safe-bottom').trim();
  } catch {
    declared = '';
  }
  const value = bottom ?? (declared ? null : known());
  if (value != null) stage.style?.setProperty?.('--il-safe-bottom', value + 'px');
}

// `hooks` lets the adapter follow the viewer: opened() when the detail opens, closed(byViewer) when it closes
// (byViewer false when the card is taken away, by a break or the end of the session) and checkout() once the
// purchase page or its QR is handed over.
//
// A card whose detail the viewer opened is theirs: it stays when its ad ends (the graphic goes, the open panel is kept
// as `held`) until the viewer closes it, they open another product, or release() is called (a new break, the media
// changing, the session ending). Another ad appearing meanwhile does not move it.
export function commerceSurface(stage, options, fetchImpl = globalThis.fetch, hooks = {}) {
  const doc = stage.ownerDocument;
  if (options) stage.classList?.add('il-stage');
  const embedded = () => {
    try {
      return doc.defaultView.self !== doc.defaultView.top;
    } catch {
      return true;
    }
  };
  const viewed = new Set();
  // The card of the cue on screen (its opener, or its open detail) and an open detail whose cue is gone.
  let root;
  let held;
  // Where focus goes when a held panel closes and its ad is gone: the first control of the ad on screen, if any.
  let focusTarget = () => null;

  const notify = (name, ...args) => {
    try {
      hooks[name]?.(...args);
    } catch {
      // The adapter's bookkeeping never breaks the card.
    }
  };

  function clearHeld() {
    held = null;
    root?.suspend(false);
  }

  // The cue's graphic is going away (its window ended, another ad replaced it). An open detail stays, held; a closed
  // card goes with its ad. `focusBack` is where focus was before the ad took it.
  function retire(focusBack) {
    const was = root;
    root = null;
    if (!was) return;
    if (!was.isOpen()) return was.dispose();
    if (held && held !== was) {
      const old = held;
      held = null;
      old.dispose();
      notify('closed', false);
    }
    if (focusBack?.isConnected) was.focusBack = focusBack;
    was.orphan();
    held = was;
  }

  // Closes what is open, for one cue or for all (but the card of `except`, the ad now playing): the viewer opened
  // another product, a new break began, the media changed, or the session ended.
  function release(id, except) {
    for (const which of ['root', 'held']) {
      const card = which === 'root' ? root : held;
      if (!card || (id != null && card.cue.id !== id) || (except != null && card.cue.id === except)) continue;
      if (which === 'root') root = null;
      else held = null;
      const open = card.isOpen();
      card.dispose();
      if (open) notify('closed', false);
    }
    root?.suspend(!!held);
  }

  // A card the viewer closed (or a held panel) is gone: the ad's button that waited behind a held panel is shown again,
  // and only then is focus settled, so the first control of the ad now on screen can take it. `ours` says focus was the
  // SDK's to move; an element the host focused meanwhile stays focused.
  function closedByViewer(card, { wasHeld, ours, orphaned, trigger, isActive, fallback }) {
    if (card === root) root = null;
    if (wasHeld) held = null;
    card.dispose(false);
    if (wasHeld) root?.suspend(false);
    notify('closed', true);
    if (!ours) return;
    if (!orphaned && isActive() && trigger?.isConnected) trigger.focus();
    else (focusTarget() ?? card.focusBack ?? fallback)?.focus?.();
  }

  // Focus belongs to the SDK only while it is inside the card or on nothing: an element the host focused meanwhile stays.
  const ownsFocus = (node) => {
    const active = doc.activeElement;
    return !active || active === doc.body || Boolean(node?.contains(active));
  };

  // The detail is open for this cue, in its window or kept after it.
  const isOpen = cue => (!!root && root.cue.id === cue.id && root.isOpen()) || (!!held && held.cue.id === cue.id && held.isOpen());

  function show(cue, isActive) {
    if (!options || !cue.commerce || root?.cue === cue) return;
    // The cue's own detail, kept while its graphic was away (a seek, a pause on a scene): it is the card again.
    if (held?.cue.id === cue.id) {
      root = held;
      held = null;
      root.adopt(isActive);
      return;
    }
    mount(cue, cue.commerce, isActive);
    // Another product is open on top: this ad's button waits behind it.
    if (held) root?.suspend(true);
  }

  function openOffer(cue, offer, trigger, isActive) {
    if (options && isActive()) mount(cue, offer, isActive, trigger);
  }

  function trackView(cue, offer) {
    const key = JSON.stringify([cue.id, offer.id ?? null]);
    if (offer.viewUrl && !viewed.has(key)) {
      viewed.add(key);
      void fetchImpl(offer.viewUrl, {mode:'no-cors', credentials:'omit', keepalive:true}).catch(() => {});
    }
  }
  async function handoff(offer, variant, signal) {
    const response = await fetchImpl(offer.handoffUrl, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({variantId:variant.id}),
      signal, credentials:'omit', cache:'no-store', redirect:'error',
    });
    // iADServer answers 404 once the delivery has expired (minutes after it was served) or the variant is gone.
    if (!response.ok) throw Object.assign(new Error('Cart unavailable'), { gone: response.status === 404 });
    const data = await response.json();
    if (!isHttps(data.continueUrl)) throw new Error('Invalid checkout destination');
    return data;
  }
  function mountTV(cue, offer, isActive, trigger, locale) {
    const activeBefore = trigger ?? doc.activeElement;
    const opener = doc.createElement('button');
    opener.type = 'button';
    opener.className = 'il-commerce il-commerce--' + cue.format + ' il-tv-shop-trigger';
    opener.textContent = copy[locale][cue.format === 'midroll' ? 3 : 0];
    let flow;
    // Once its ad is gone the open shop belongs to the viewer: it is live for as long as it is the one held.
    let orphaned = false;
    const alive = () => (orphaned ? held === tvRoot : isActive());
    function launch() {
      if (!isActive() || flow) return;
      opener.hidden = true;
      trackView(cue, offer);
      notify('opened', cue);
      flow = openTVShop(stage, {
        offer: { ...offer, imageUrl: offer.imageUrl ?? offer.images?.[0] ?? (cue.format !== 'midroll' ? cue.imageUrl : undefined) },
        locale, brand:cue.brand,
        onClose() {
          const ours = ownsFocus(stage.querySelector('.il-tv-shop'));
          if (trigger || orphaned) {
            closedByViewer(tvRoot, { wasHeld: held === tvRoot, ours, orphaned, trigger, isActive, fallback: activeBefore });
            flow = null;
            return;
          }
          flow.dispose(); flow = null; opener.hidden = false; if (ours) opener.focus();
          notify('closed', true);
        },
        async prepareCheckout(variant, signal) {
          if (!alive()) throw new Error('Offer expired');
          const reply = await handoff(offer, variant, signal);
          if (!alive() || !isHttps(reply.qrImageUrl)) throw new Error('Invalid QR');
          notify('checkout');
          return reply.qrImageUrl;
        },
      });
    }
    const tvRoot = {cue, focusBack: null, isOpen: () => Boolean(flow),
      focusable: () => (flow || opener.hidden ? null : opener),
      suspend(flag) { if (!flow) opener.hidden = flag; },
      orphan() { orphaned = true; opener.remove(); },
      adopt(next) {
        isActive = next;
        orphaned = false;
        if (!opener.isConnected && !trigger) stage.appendChild(opener);
      },
      dispose(restore = true) {
        const ownsTheFocus = doc.activeElement === opener || Boolean(flow);
        flow?.dispose(); opener.remove();
        if (restore && ownsTheFocus && activeBefore?.isConnected) activeBefore.focus();
      }};
    root = tvRoot;
    if (trigger) launch();
    else {
      opener.addEventListener('click', launch);
      opener.addEventListener('keydown', event => {
        if (event.key !== 'OK' && event.key !== 'Enter') return;
        event.preventDefault(); event.stopPropagation(); if (!event.repeat) launch();
      });
      stage.appendChild(opener);
      if (!held) opener.focus();
    }
  }

  function mount(cue, offer, isActive, trigger) {
    // The viewer opening a product replaces whatever product was open; an ad's own button only replaces its predecessor.
    if (trigger) release();
    else retire();
    const locale = commerceLocale(options.locale ?? offer.locale);
    if (options.tv) return mountTV(cue, offer, isActive, trigger, locale);
    const [view, productText, variantText, buy, scanText, continueText, closeText, loading, errorText, goneText] = copy[locale];
    const money = new Intl.NumberFormat(locale, { style: 'currency', currency: offer.currency });
    const previousFocus = trigger ?? doc.activeElement;
    const shell = doc.createElement('div');
    shell.className = 'il-commerce il-commerce--' + cue.format;
    let request;
    // Variants iADServer answered 404 for (the delivery expired, or the variant is gone): each stays off, another is still tried.
    const goneVariants = new Set();
    // Once its ad is gone the open panel belongs to the viewer: it is live for as long as it is the one held.
    let orphaned = false;
    const alive = () => (orphaned ? held === shellRoot : isActive());
    let variant = offer.variants.find(v => v.availableForSale !== false) ?? offer.variants[0];
    function button(label, action) {
      const el = doc.createElement('button');
      el.type = 'button';
      el.textContent = label;
      el.addEventListener('click', action);
      return el;
    }
    const open = button(cue.format === 'midroll' ? buy : view, openPanel);
    const panel = doc.createElement('div');
    panel.className = 'il-commerce-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', offer.title);
    const header = doc.createElement('div');
    header.className = 'il-commerce-header';
    const heading = doc.createElement('span');
    heading.textContent = productText;
    const close = button('', closePanel);
    close.className = 'il-commerce-close';
    close.setAttribute('aria-label', closeText);
    close.title = closeText;
    header.append(heading, close);
    const title = doc.createElement('strong');
    title.className = 'il-commerce-title';
    title.textContent = offer.title;
    const summary = doc.createElement('div');
    summary.className = 'il-commerce-summary';
    const cover = offer.imageUrl || offer.images?.[0] || (cue.format !== 'midroll' ? cue.imageUrl : null);
    const photo = doc.createElement('img');
    photo.alt = '';
    const price = doc.createElement('span');
    price.className = 'il-commerce-price';
    summary.appendChild(price);
    const caption = doc.createElement('span');
    caption.className = 'il-commerce-caption';
    caption.textContent = variantText;
    const choices = doc.createElement('div');
    choices.className = 'il-commerce-variants';
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', variantText);
    const checkout = button(buy, proceed);
    checkout.className = 'il-commerce-buy';
    const result = doc.createElement('div');
    result.className = 'il-commerce-result';
    result.setAttribute('aria-live', 'polite');
    result.tabIndex = -1;
    // Surface and text are always set together, so no subset of the brand leaves the text unreadable.
    const surface = brandSurface(cue.brand);
    shell.style.setProperty('--il-commerce-background', surface.background);
    shell.style.setProperty('--il-commerce-foreground', surface.foreground);
    if (cue.brand) {
      const { logoUrl, accent } = cue.brand;
      if (accent) {
        shell.style.setProperty('--il-commerce-accent', accent);
        shell.style.setProperty('--il-commerce-accent-ink', accentInk(accent));
      }
      if (logoUrl) {
        const logo = doc.createElement('img');
        logo.className = 'il-commerce-logo';
        logo.src = logoUrl;
        logo.alt = '';
        header.prepend(logo);
      }
    }
    panel.append(header, title, summary, caption, choices, checkout, result);
    if (!trigger) shell.appendChild(open);
    shell.appendChild(panel);
    const buttons = offer.variants.map(choice => button(choice.label, () => {
      request?.abort();
      request = null;
      variant = choice;
      result.replaceChildren();
      // A variant that already answered 404 says so again, and stays off.
      if (goneVariants.has(choice)) result.textContent = goneText;
      updateChoice();
    }));
    choices.append(...buttons);

    function updateChoice() {
      const photoUrl = variant.imageUrl || cover;
      if (photoUrl) {
        if (photo.getAttribute('src') !== photoUrl) photo.src = photoUrl;
        if (!photo.parentNode) summary.prepend(photo);
      } else {
        photo.remove();
        photo.removeAttribute('src');
      }
      price.textContent = money.format(Number(variant.price));
      buttons.forEach((element, index) => {
        element.disabled = offer.variants[index].availableForSale === false;
        element.setAttribute('aria-pressed', String(offer.variants[index] === variant));
      });
      checkout.disabled = variant.availableForSale === false || goneVariants.has(variant);
      checkout.setAttribute('aria-disabled', String(Boolean(request) || checkout.disabled));
    }

    function openPanel() {
      if (!isActive()) return;
      panel.hidden = false;
      open.hidden = true;
      shell.classList.add('il-commerce--open');
      // The panel opens at the top, so the viewer sees what they are buying. Focus stays on the chosen variant
      // when it is in view; in a panel too short for that it starts on Close, and the arrows go down from there.
      const chosen = buttons[offer.variants.indexOf(variant)];
      chosen.focus({ preventScroll: true });
      panel.scrollTop = 0;
      const row = choices.getBoundingClientRect();
      const box = chosen.getBoundingClientRect();
      if (box.left < row.left || box.right > row.right) choices.scrollLeft += box.left - row.left - 4;
      // A sold-out variant is disabled and cannot take focus, which would leave Escape and the arrows with nothing.
      if (chosen.disabled || chosen.getBoundingClientRect().bottom > panel.getBoundingClientRect().bottom) close.focus({ preventScroll: true });
      trackView(cue, offer);
      notify('opened', cue);
    }

    // The result is the last thing in the panel: when the panel scrolls, it is brought into view inside it
    // (never the page around the player).
    // After a hand-off the link comes first: as much of the QR below it as fits, but never the link out of view
    // (on a phone the link is the way to buy).
    function reveal() {
      panel.scrollTop = panel.scrollHeight;
      const link = result.querySelector('a');
      if (!link) return;
      const top = link.getBoundingClientRect().top - panel.getBoundingClientRect().top;
      if (top < 0) panel.scrollTop += top - 4;
    }

    function closePanel() {
      if (trigger || orphaned) {
        closedByViewer(shellRoot, { wasHeld: held === shellRoot, ours: ownsFocus(shell), orphaned, trigger, isActive, fallback: previousFocus });
        return;
      }
      request?.abort();
      request = null;
      result.replaceChildren();
      shell.classList.remove('il-commerce--done');
      updateChoice();
      panel.hidden = true;
      shell.classList.remove('il-commerce--open');
      open.hidden = false;
      open.focus();
      notify('closed', true);
    }

    async function proceed() {
      if (request || !alive()) return;
      const current = new AbortController();
      request = current;
      updateChoice();
      result.textContent = loading;
      try {
        const reply = await handoff(offer, variant, current.signal);
        if (request !== current || current.signal.aborted || !alive()) return;
        notify('checkout');
        if (options.navigate) {
          options.navigate(reply.continueUrl);
          result.replaceChildren();
        } else {
          const link = doc.createElement('a');
          link.href = reply.continueUrl;
          link.textContent = continueText;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          // Once the purchase is handed over, the choice gives way to one line, so the link and the whole QR fit.
          const chosen = doc.createElement('span');
          chosen.className = 'il-commerce-chosen';
          chosen.textContent = `${variant.label} · ${money.format(Number(variant.price))}`;
          result.replaceChildren(chosen, link);
          // Inside an iframe the page may be sandboxed without allow-popups, where the link opens nothing.
          // The QR of the same hand-off (the TV path) still lets the viewer finish on a phone.
          if (embedded() && isHttps(reply.qrImageUrl)) {
            const box = doc.createElement('span');
            box.className = 'il-commerce-qr';
            const qr = doc.createElement('img');
            // The image arrives after the panel was scrolled: bring the result into view again when it does.
            qr.addEventListener('load', () => reveal());
            qr.src = reply.qrImageUrl;
            qr.alt = scanText;
            const caption = doc.createElement('span');
            caption.textContent = scanText;
            box.append(qr, caption);
            result.append(box);
          }
          shell.classList.add('il-commerce--done');
          link.focus({ preventScroll: true });
          reveal();
        }
      } catch (error) {
        if (request === current && !current.signal.aborted && alive()) {
          if (error?.gone) goneVariants.add(variant);
          result.textContent = error?.gone ? goneText : errorText;
          reveal();
        }
      } finally {
        if (request === current) {
          request = null;
          updateChoice();
          // Buy just turned off under the viewer's finger: focus goes to a control that works.
          const lost = doc.activeElement === checkout || doc.activeElement === doc.body || !doc.activeElement;
          if (checkout.disabled && lost && alive()) {
            const chosen = buttons[offer.variants.indexOf(variant)];
            (chosen && !chosen.disabled ? chosen : close).focus({ preventScroll: true });
          }
        }
      }
    }

    shell.addEventListener('keydown', event => {
      if (['Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(event.key) || event.keyCode === 10009 || event.keyCode === 461) {
        if (panel.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        closePanel();
        return;
      }
      if (panel.hidden || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const active = doc.activeElement;
      const index = buttons.indexOf(active);
      const selected = buttons[offer.variants.indexOf(variant)];
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const step = event.key === 'ArrowLeft' ? -1 : 1;
        if (index >= 0) buttons[(index + step + buttons.length) % buttons.length].focus();
      } else if (event.key === 'ArrowUp') {
        if (result.contains(active)) checkout.focus();
        else if (active === checkout) selected.focus();
        else close.focus();
      } else if (active === close) selected.focus();
      else if (index >= 0) checkout.focus();
      else if (active === checkout && result.hasChildNodes()) (result.querySelector('a') || result).focus();
      event.preventDefault();
      event.stopPropagation();
    });
    const shellRoot = { cue, focusBack: null, isOpen: () => !panel.hidden,
      focusable: () => (panel.hidden && !open.hidden && shell.style.display !== 'none' ? open : null),
      suspend(flag) { shell.style.display = flag ? 'none' : ''; },
      orphan() { orphaned = true; },
      adopt(next) { isActive = next; orphaned = false; },
      dispose(restore = true) {
        request?.abort();
        const restoreFocus = restore && shell.contains(doc.activeElement);
        shell.remove();
        if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
      } };
    root = shellRoot;
    updateChoice();
    stage.appendChild(shell);
    if (trigger) openPanel();
  }
  const buyLabel = offer => copy[commerceLocale(options?.locale ?? offer?.locale)][3];
  // The control the viewer would reach first on the card now on screen (a closed card's button).
  focusTarget = () => root?.focusable?.() ?? null;
  return { show, retire, hide: () => release(), release, open: openOffer, isOpen, buyLabel, enabled: Boolean(options),
    // The scene on screen, if any, offers its own first control; the surface falls back to a closed card's button.
    setFocusTarget(find) { focusTarget = () => find?.() ?? root?.focusable?.() ?? null; } };
}

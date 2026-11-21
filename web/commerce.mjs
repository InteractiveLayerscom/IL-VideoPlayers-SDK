import { accentInk, openTVShop } from './tv-shop.mjs';

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
    'Close', 'Preparing your cart…', 'Could not prepare the cart. Try again.'],
  es: ['Ver producto', 'Producto', 'Variante', 'Comprar', 'Escaneá el código con tu celular', 'Continuar a Shopify',
    'Cerrar', 'Preparando tu carrito…', 'No se pudo preparar el carrito. Intentá de nuevo.'],
  'pt-BR': ['Ver produto', 'Produto', 'Variante', 'Comprar', 'Escaneie com seu celular', 'Continuar para Shopify',
    'Fechar', 'Preparando seu carrinho…', 'Não foi possível preparar o carrinho. Tente novamente.'],
};

export function commerceSurface(stage, options, fetchImpl = globalThis.fetch) {
  const doc = stage.ownerDocument;
  const embedded = () => {
    try {
      return doc.defaultView.self !== doc.defaultView.top;
    } catch {
      return true;
    }
  };
  const viewed = new Set();
  let root;

  function hide() {
    root?.dispose();
    root = null;
  }

  function show(cue, isActive) {
    if (!options || !cue.commerce || root?.cue === cue) return;
    mount(cue, cue.commerce, isActive);
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
    if (!response.ok) throw new Error('Cart unavailable');
    const data = await response.json();
    if (!isHttps(data.continueUrl)) throw new Error('Invalid checkout destination');
    return data;
  }
  function mountTV(cue, offer, isActive, trigger, locale) {
    const activeBefore = trigger ?? doc.activeElement;
    const opener = doc.createElement('button');
    opener.type = 'button';
    opener.className = 'il-commerce il-tv-shop-trigger';
    opener.textContent = copy[locale][cue.format === 'midroll' ? 3 : 0];
    let flow;
    function launch() {
      if (!isActive() || flow) return;
      opener.hidden = true;
      trackView(cue, offer);
      flow = openTVShop(stage, {
        offer: { ...offer, imageUrl: offer.imageUrl ?? offer.images?.[0] ?? (cue.format !== 'midroll' ? cue.imageUrl : undefined) },
        locale, brand:cue.brand,
        onClose() {
          if (trigger) { hide(); if (isActive() && trigger.isConnected) trigger.focus(); }
          else { flow.dispose(); flow = null; opener.hidden = false; opener.focus(); }
        },
        async prepareCheckout(variant, signal) {
          if (!isActive()) throw new Error('Offer expired');
          const reply = await handoff(offer, variant, signal);
          if (!isActive() || !isHttps(reply.qrImageUrl)) throw new Error('Invalid QR');
          return reply.qrImageUrl;
        },
      });
    }
    root = {cue, dispose() {
      const ownsFocus = doc.activeElement === opener || Boolean(flow);
      flow?.dispose(); opener.remove();
      if (ownsFocus && activeBefore?.isConnected) activeBefore.focus();
    }};
    if (trigger) launch();
    else {
      opener.addEventListener('click', launch);
      opener.addEventListener('keydown', event => {
        if (event.key !== 'OK' && event.key !== 'Enter') return;
        event.preventDefault(); event.stopPropagation(); if (!event.repeat) launch();
      });
      stage.appendChild(opener); opener.focus();
    }
  }

  function mount(cue, offer, isActive, trigger) {
    hide();
    const locale = commerceLocale(options.locale ?? offer.locale);
    if (options.tv) return mountTV(cue, offer, isActive, trigger, locale);
    const [view, productText, variantText, buy, scanText, continueText, closeText, loading, errorText] = copy[locale];
    const money = new Intl.NumberFormat(locale, { style: 'currency', currency: offer.currency });
    const previousFocus = trigger ?? doc.activeElement;
    const shell = doc.createElement('div');
    shell.className = 'il-commerce il-commerce--' + cue.format;
    let request;
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
    if (cue.brand) {
      const { logoUrl, accent, background, foreground } = cue.brand;
      if (accent) {
        shell.style.setProperty('--il-commerce-accent', accent);
        shell.style.setProperty('--il-commerce-accent-ink', accentInk(accent));
      }
      if (background) shell.style.setProperty('--il-commerce-background', background);
      if (foreground) shell.style.setProperty('--il-commerce-foreground', foreground);
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
      checkout.disabled = variant.availableForSale === false;
      checkout.setAttribute('aria-disabled', String(Boolean(request) || checkout.disabled));
    }

    function openPanel() {
      if (!isActive()) return;
      panel.hidden = false;
      open.hidden = true;
      shell.classList.add('il-commerce--open');
      buttons[offer.variants.indexOf(variant)].focus();
      trackView(cue, offer);
    }

    function closePanel() {
      if (trigger) {
        hide();
        if (isActive() && trigger.isConnected) trigger.focus();
        return;
      }
      request?.abort();
      request = null;
      result.replaceChildren();
      updateChoice();
      panel.hidden = true;
      shell.classList.remove('il-commerce--open');
      open.hidden = false;
      open.focus();
    }

    async function proceed() {
      if (request || !isActive()) return;
      const current = new AbortController();
      request = current;
      updateChoice();
      result.textContent = loading;
      try {
        const reply = await handoff(offer, variant, current.signal);
        if (request !== current || current.signal.aborted || !isActive()) return;
        if (options.navigate) {
          options.navigate(reply.continueUrl);
          result.replaceChildren();
        } else {
          const link = doc.createElement('a');
          link.href = reply.continueUrl;
          link.textContent = continueText;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          result.replaceChildren(link);
          // Inside an iframe the page may be sandboxed without allow-popups, where the link opens nothing.
          // The QR of the same hand-off (the TV path) still lets the viewer finish on a phone.
          if (embedded() && isHttps(reply.qrImageUrl)) {
            const qr = doc.createElement('img');
            qr.src = reply.qrImageUrl;
            qr.alt = scanText;
            const caption = doc.createElement('span');
            caption.textContent = scanText;
            result.append(qr, caption);
          }
          link.focus();
        }
      } catch {
        if (request === current && !current.signal.aborted && isActive()) result.textContent = errorText;
      } finally {
        if (request === current) {
          request = null;
          updateChoice();
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
    root = { cue, dispose() {
      request?.abort();
      const restoreFocus = shell.contains(doc.activeElement);
      shell.remove();
      if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
    } };
    updateChoice();
    stage.appendChild(shell);
    if (trigger) openPanel();
  }
  return { show, hide, open: openOffer, enabled: Boolean(options) };
}

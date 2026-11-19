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
      value.variants.length === 0 || value.variants.length > 100) return null;
  const price = decimal(value.price);
  if (price === null) return null;
  const ids = new Set();
  const variants = [];
  for (const variant of value.variants) {
    if (!variant || !validText(variant.id, 128) || !validText(variant.label, 160) ||
        ids.has(variant.id)) return null;
    const amount = variant.price == null ? price : decimal(variant.price);
    if (amount === null) return null;
    ids.add(variant.id);
    variants.push({ id: variant.id, label: variant.label, price: amount });
  }
  return {
    title: value.title, currency: value.currency, price, variants,
    locale: commerceLocale(value.locale), handoffUrl: value.handoffUrl,
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

function accentInk(hex) {
  const [r, g, b] = [1, 3, 5].map(start => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#000' : '#fff';
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

  function mount(cue, offer, isActive, trigger) {
    hide();
    const locale = commerceLocale(options.locale ?? offer.locale);
    const [view, productText, variantText, buy, scan, continueText, closeText, loading, errorText] = copy[locale];
    const money = new Intl.NumberFormat(locale, { style: 'currency', currency: offer.currency });
    const previousFocus = trigger ?? doc.activeElement;
    const shell = doc.createElement('div');
    shell.className = 'il-commerce il-commerce--' + cue.format;
    let request;
    let variant = offer.variants[0];
    function button(label, action) {
      const el = doc.createElement('button');
      el.type = 'button';
      el.textContent = label;
      el.addEventListener('click', action);
      return el;
    }
    const open = button(view, openPanel);
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
    const photoUrl = offer.imageUrl || cue.imageUrl;
    if (photoUrl) {
      const photo = doc.createElement('img');
      photo.src = photoUrl;
      photo.alt = '';
      summary.appendChild(photo);
    }
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
      if (options.tv) checkout.focus();
    }));
    choices.append(...buttons);

    function updateChoice() {
      price.textContent = money.format(Number(variant.price));
      buttons.forEach((element, index) => {
        element.setAttribute('aria-pressed', String(offer.variants[index] === variant));
      });
      checkout.setAttribute('aria-disabled', String(Boolean(request)));
    }

    function openPanel() {
      if (!isActive()) return;
      panel.hidden = false;
      open.hidden = true;
      shell.classList.add('il-commerce--open');
      buttons[offer.variants.indexOf(variant)].focus();
      const key = JSON.stringify([cue.id, offer.id ?? null]);
      if (offer.viewUrl && !viewed.has(key)) {
        viewed.add(key);
        void fetchImpl(offer.viewUrl, {
          mode: 'no-cors', credentials: 'omit', keepalive: true, redirect: 'error',
        }).catch(() => {});
      }
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
        const response = await fetchImpl(offer.handoffUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variantId: variant.id }), signal: current.signal,
          credentials: 'omit', cache: 'no-store', redirect: 'error',
        });
        if (!response.ok) throw new Error('Cart unavailable');
        const handoff = await response.json();
        if (request !== current || current.signal.aborted || !isActive()) return;
        if (!isHttps(handoff.continueUrl)) throw new Error('Invalid checkout destination');
        if (options.tv) {
          if (!isHttps(handoff.qrImageUrl)) throw new Error('Invalid QR destination');
          const qr = doc.createElement('img');
          qr.alt = scan;
          qr.src = handoff.qrImageUrl;
          qr.referrerPolicy = 'no-referrer';
          qr.addEventListener('error', () => { if (qr.parentNode === result) result.textContent = errorText; });
          result.replaceChildren(qr, doc.createTextNode(scan));
          result.focus();
        } else if (options.navigate) {
          options.navigate(handoff.continueUrl);
          result.replaceChildren();
        } else {
          const link = doc.createElement('a');
          link.href = handoff.continueUrl;
          link.textContent = continueText;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          result.replaceChildren(link);
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
      if (options.tv && (event.key === 'Enter' || event.key === 'OK') &&
          doc.activeElement?.matches('button:not([disabled])')) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) doc.activeElement.click();
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
    else if (options.tv) open.focus();
  }
  return { show, hide, open: openOffer, enabled: Boolean(options) };
}

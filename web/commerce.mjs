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

const copy = {
  en: ['View product', 'Show QR code', 'Buy', 'Scan with your phone', 'Continue to Shopify',
    'Close', 'Preparing your cart…', 'Could not prepare the cart. Try again.'],
  es: ['Ver producto', 'Mostrar código QR', 'Comprar', 'Escaneá el código con tu celular', 'Continuar a Shopify',
    'Cerrar', 'Preparando tu carrito…', 'No se pudo preparar el carrito. Intentá de nuevo.'],
  'pt-BR': ['Ver produto', 'Mostrar código QR', 'Comprar', 'Escaneie com seu celular', 'Continuar para Shopify',
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
    hide();
    const offer = cue.commerce;
    const locale = commerceLocale(options.locale ?? offer.locale);
    const [view, showQR, buy, scan, continueText, closeText, loading, errorText] = copy[locale];
    const money = new Intl.NumberFormat(locale, { style: 'currency', currency: offer.currency });
    const previousFocus = doc.activeElement;
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
    const summary = doc.createElement('div');
    summary.className = 'il-commerce-summary';
    const photo = doc.createElement('img');
    photo.src = cue.imageUrl;
    photo.alt = '';
    const title = doc.createElement('strong');
    title.textContent = offer.title;
    const price = doc.createElement('span');
    summary.append(photo, title, price);
    const choices = doc.createElement('div');
    choices.className = 'il-commerce-variants';
    const checkout = button(options.tv ? showQR : buy, proceed);
    const result = doc.createElement('div');
    result.className = 'il-commerce-result';
    result.setAttribute('aria-live', 'polite');
    const close = button(closeText, closePanel);
    panel.append(summary, choices, checkout, close, result);
    shell.append(open, panel);
    const buttons = offer.variants.map(choice => button(choice.label, () => {
      request?.abort();
      request = null;
      variant = choice;
      result.replaceChildren();
      updateChoice();
    }));
    choices.append(...buttons);

    function updateChoice() {
      price.textContent = money.format(Number(variant.price));
      buttons.forEach((element, index) => {
        element.setAttribute('aria-pressed', String(offer.variants[index] === variant));
      });
      checkout.disabled = Boolean(request);
    }

    function openPanel() {
      if (!isActive()) return;
      panel.hidden = false;
      open.hidden = true;
      buttons[0].focus();
      if (offer.viewUrl && !viewed.has(cue.id)) {
        viewed.add(cue.id);
        void fetchImpl(offer.viewUrl, {
          mode: 'no-cors', credentials: 'omit', keepalive: true, redirect: 'error',
        }).catch(() => {});
      }
    }

    function closePanel() {
      request?.abort();
      request = null;
      result.replaceChildren();
      updateChoice();
      panel.hidden = true;
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
      const focusable = [...panel.querySelectorAll('button:not([disabled]), a[href]')];
      const current = focusable.indexOf(doc.activeElement);
      const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      focusable[(current + step + focusable.length) % focusable.length]?.focus();
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
    if (options.tv) open.focus();
  }
  return { show, hide };
}

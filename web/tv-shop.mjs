// Shared by the player adapters and the creative editor's Smart TV simulator.
const labels = {
  es: {
    from:'Desde', intro:'Producto', detail:'Detalles', photos:'Fotos', cart:'Tu carrito', payment:'Pago con Shopify',
    options:'Elegir opciones', details:'Ver detalles', add:'Agregar al carrito', checkout:'Continuar con el QR',
    total:'Total', unit:'1 unidad', gallery:'Ver fotos', enlarge:'Ampliar foto', prev:'Anterior', next:'Siguiente',
    scan:'Escaneá para pagar en Shopify', back:'Volver', loading:'Preparando tu carrito…',
    failed:'No se pudo preparar el carrito.', gone:'Esta oferta ya no está disponible.', retry:'Reintentar', soldOut:'Sin stock', variant:'Variante',
  },
  en: {
    from:'From', intro:'Product', detail:'Details', photos:'Photos', cart:'Your cart', payment:'Shopify checkout',
    options:'Choose options', details:'View details', add:'Add to cart', checkout:'Continue to QR',
    total:'Total', unit:'1 item', gallery:'View photos', enlarge:'Enlarge photo', prev:'Previous', next:'Next',
    scan:'Scan to pay on Shopify', back:'Back', loading:'Preparing your cart…',
    failed:'Could not prepare the cart.', gone:'This offer is no longer available.', retry:'Retry', soldOut:'Out of stock', variant:'Variant',
  },
  pt: {
    from:'A partir de', intro:'Produto', detail:'Detalhes', photos:'Fotos', cart:'Seu carrinho', payment:'Pagamento na Shopify',
    options:'Escolher opções', details:'Ver detalhes', add:'Adicionar ao carrinho', checkout:'Continuar com o QR',
    total:'Total', unit:'1 unidade', gallery:'Ver fotos', enlarge:'Ampliar foto', prev:'Anterior', next:'Próxima',
    scan:'Escaneie para pagar na Shopify', back:'Voltar', loading:'Preparando seu carrinho…',
    failed:'Não foi possível preparar o carrinho.', gone:'Esta oferta não está mais disponível.', retry:'Tentar novamente', soldOut:'Sem estoque', variant:'Variante',
  },
};

// WCAG relative luminance of a #rrggbb colour.
export function luminance(hex) {
  if (/^#[0-9a-f]{3}$/i.test(hex)) hex = '#' + [...hex.slice(1)].map(digit => digit + digit).join('');
  const [r, g, b] = [1, 3, 5].map(start => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

export function accentInk(hex) {
  return luminance(hex) > 0.179 ? '#000' : '#fff';
}

const CARD_BACKGROUND = '#202020';
const CARD_FOREGROUND = '#ffffff';
const LIGHT_BACKGROUND = '#f7f7f7';
const READABLE = 4.5;

// The card's surface and text from any subset of the brand: a missing colour is derived from the other, and a
// foreground that does not reach 4.5:1 on the background gives way to the ink derived from it.
export function brandSurface(brand) {
  const hex = value => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null);
  let background = hex(brand?.background);
  let foreground = hex(brand?.foreground);
  if (!background && foreground) {
    background = contrast(foreground, CARD_BACKGROUND) >= contrast(foreground, LIGHT_BACKGROUND)
      ? CARD_BACKGROUND : LIGHT_BACKGROUND;
  }
  background ??= CARD_BACKGROUND;
  if (!foreground || contrast(foreground, background) < READABLE)
    foreground = brand?.foreground || brand?.background ? accentInk(background) : CARD_FOREGROUND;
  return { background, foreground };
}

export function productOptions(variants) {
  const axes = new Map();
  const combinations = new Set();
  for (const item of variants) {
    const options = item.selectedOptions;
    if (!options?.length || new Set(options.map(o => o.name)).size !== options.length) return [];
    if (axes.size && (options.length !== axes.size || options.some(o => !axes.has(o.name)))) return [];
    for (const { name, value } of options) {
      if (!axes.has(name)) axes.set(name, new Set());
      axes.get(name).add(value);
    }
    const signature = JSON.stringify([...axes.keys()].map(name => options.find(pair => pair.name === name).value));
    if (combinations.has(signature)) return [];
    combinations.add(signature);
  }
  return [...axes].map(([name, values]) => ({ name, values: [...values] }));
}

export function openTVShop(stage, { offer, brand = {}, locale = 'en', onClose, prepareCheckout }) {
  const doc = stage.ownerDocument;
  const focusRoot = stage.getRootNode();
  brand = brand ?? {};
  const copy = labels[locale.toLowerCase().split('-')[0]] ?? labels.en;
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: offer.currency || 'USD' });
  const variants = offer.variants;
  let selected = variants.find(v => v.availableForSale !== false) ?? variants[0];
  const axes = productOptions(variants);
  const photos = [...new Set([offer.imageUrl, ...(offer.images ?? []), ...variants.map(v => v.imageUrl)].filter(Boolean))];
  const availableVariants = variants.filter(v => v.availableForSale !== false);
  const amounts = availableVariants.map(variant => Number(variant.price));
  const lowestPrice = Math.min(...amounts);
  const hasPriceRange = amounts.length > 1 && Math.max(...amounts) > lowestPrice;
  const optionSummary = productOptions(availableVariants).filter(axis => axis.values.length > 1);
  const selectedPhoto = () => selected?.imageUrl || offer.imageUrl || offer.images?.[0];
  const galleryLabel = photos.length > 1 ? copy.gallery : copy.enlarge;
  let index = 0, galleryOrigin = 'detail', galleryOpener = 'gallery';
  let page = 'intro', qr = '', error = false, pending, disposed = false;
  // iADServer answered 404 for these variants: the delivery expired or the variant is gone. Each is off for good; another
  // variant is still tried, and any other failure still allows another try.
  const goneVariants = new Set();
  const previous = focusRoot.activeElement;
  const root = node('div', 'il-tv-shop');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', offer.title);
  const surface = brandSurface(brand);
  for (const key of ['background', 'foreground']) root.style.setProperty('--shop-' + key, surface[key]);
  stage.appendChild(root);

  function node(tag, cls, value) {
    const element = doc.createElement(tag);
    if (cls) element.className = cls;
    if (value != null) element.textContent = value;
    return element;
  }
  function photo(url, cls, alt = '') {
    const img = node('img', cls);
    img.alt = alt;
    img.referrerPolicy = 'no-referrer';
    img.src = url;
    return img;
  }
  function button(text, action, key, cls, aria) {
    const btn = node('button', cls, text);
    btn.type = 'button';
    btn.dataset.shopKey = key;
    if (aria) btn.setAttribute('aria-label', aria);
    btn.addEventListener('click', action);
    return btn;
  }
  function row(...children) {
    const group = node('div', 'il-tv-row');
    group.append(...children);
    return group;
  }
  const price = () => money.format(Number(selected?.price ?? offer.price));
  function stopRequest() {
    pending?.abort();
    pending = undefined;
  }
  function go(step, focusKey) {
    stopRequest();
    page = step;
    qr = '';
    error = false;
    render(focusKey);
  }
  function close() { onClose(); }
  function back() {
    if (page === 'intro') close();
    else if (page === 'detail') go('intro', 'detail');
    else if (page === 'gallery') go(galleryOrigin, galleryOpener);
    else if (page === 'cart') go('detail', 'cart');
    else go('cart', 'finish');
  }
  function focusKey(key) {
    const controls = [...root.querySelectorAll('button:not(:disabled)')];
    (controls.find(el => el.dataset.shopKey === key) ?? controls[0])?.focus();
  }
  function selectVariant(item, key) {
    selected = item;
    render(key);
  }
  function openGallery(event) {
    galleryOrigin = page;
    galleryOpener = event.currentTarget.dataset.shopKey;
    index = Math.max(0, photos.indexOf(selectedPhoto()));
    go('gallery');
  }
  function changePhoto(step) {
    if (photos.length < 2) return;
    index = (index + step + photos.length) % photos.length;
    root.querySelector('.il-tv-feature').src = photos[index];
    root.querySelector('.il-tv-counter').textContent = (index + 1) + ' / ' + photos.length;
    focusKey(step < 0 ? 'prev' : 'next');
  }
  function renderViewer(key) {
    const viewer = node('section', 'il-tv-viewer');
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-label', copy.photos + ' · ' + offer.title);
    const toolbar = node('header', 'il-tv-viewer-toolbar');
    toolbar.append(button('‹', back, 'back', 'il-tv-back', copy.back), node('h2', '', offer.title));
    viewer.append(toolbar, photo(photos[index], 'il-tv-feature', offer.title));
    if (photos.length > 1) {
      const counter = node('span', 'il-tv-counter', (index + 1) + ' / ' + photos.length);
      counter.setAttribute('aria-live', 'polite');
      toolbar.append(counter);
      viewer.append(button('‹', () => changePhoto(-1), 'prev', 'il-tv-gallery-arrow', copy.prev),
        button('›', () => changePhoto(1), 'next', 'il-tv-gallery-arrow', copy.next));
    }
    root.replaceChildren(viewer);
    focusKey(key ?? (photos.length > 1 ? 'next' : 'back'));
  }
  function addOptions(body) {
    if (variants.length === 1 && variants[0].label === 'Default Title') return;
    if (!axes.length) {
      body.append(node('h4', '', copy.variant));
      const group = row();
      variants.forEach((v, i) => {
        const key = 'variant-' + i;
        const choice = button(v.label, () => selectVariant(v, key), key);
        choice.disabled = v.availableForSale === false;
        choice.setAttribute('aria-pressed', String(v === selected));
        group.append(choice);
      });
      body.append(group);
      return;
    }
    const valueOf = (v, name) => v?.selectedOptions?.find(pair => pair.name === name)?.value;
    let prefix = availableVariants;
    axes.forEach(({ name, values }, axisIndex) => {
      body.append(node('h4', '', name));
      const group = row();
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', name);
      const candidates = new Map();
      const scores = new Map();
      for (const item of prefix) {
        const value = valueOf(item, name);
        const score = item.selectedOptions.reduce((n, pair) => n + Number(valueOf(selected, pair.name) === pair.value), 0);
        if (!scores.has(value) || scores.get(value) < score) { candidates.set(value, item); scores.set(value, score); }
      }
      values.forEach((value, i) => {
        const key = 'axis-' + axisIndex + '-' + i;
        const match = candidates.get(value);
        const choice = button(value, () => selectVariant(match, key), key);
        choice.disabled = !match;
        choice.setAttribute('aria-pressed', String(valueOf(selected, name) === value));
        group.append(choice);
      });
      body.append(group);
      prefix = prefix.filter(item => valueOf(item, name) === valueOf(selected, name));
    });
  }
  async function checkout() {
    if (pending || !selected || selected.availableForSale === false || goneVariants.has(selected)) return;
    const controller = new AbortController();
    pending = controller;
    page = 'qr'; qr = ''; error = false;
    render('back');
    try {
      const url = await prepareCheckout(selected, controller.signal);
      if (disposed || controller.signal.aborted || pending !== controller) return;
      if (!url) throw new Error('Missing QR');
      qr = url;
    } catch (reason) {
      if (disposed || controller.signal.aborted || pending !== controller) return;
      error = true;
      if (reason?.gone === true) goneVariants.add(selected);
    }
    pending = undefined;
    render(error && !goneVariants.has(selected) ? 'retry' : 'back');
  }
  function render(key) {
    root.dataset.page = page;
    if (page === 'gallery') { renderViewer(key); return; }
    const pane = node('section', 'il-tv-sheet');
    root.replaceChildren(pane);
    const header = node('header', 'il-tv-header');
    const headings = {intro:copy.intro, detail:copy.detail, cart:copy.cart, qr:copy.payment};
    header.append(button('‹', back, 'back', 'il-tv-back', copy.back), node('h3', '', headings[page]));
    if (brand.logoUrl) header.append(photo(brand.logoUrl, 'il-tv-logo'));
    const body = node('div', 'il-tv-body');
    const footer = node('footer', 'il-tv-footer');
    pane.append(header, body, footer);

    const available = !!selected && selected.availableForSale !== false;
    function mainButton(title, action, id, enabled = true) {
      const control = button(title, action, id, 'il-tv-primary');
      control.disabled = !enabled;
      return control;
    }
    function showPrice(parent) {
      const prices = node('div', 'il-tv-prices');
      if (page === 'intro' && hasPriceRange) {
        prices.append(node('span', 'il-tv-from', copy.from), node('strong', 'il-tv-price', money.format(lowestPrice)));
        parent.append(prices);
        return;
      }
      prices.append(node('strong', 'il-tv-price', price()));
      const baseBefore = selected === availableVariants[0] && Number(offer.price) === Number(selected?.price) ? offer.previousPrice : undefined;
      const priceBefore = selected?.previousPrice ?? baseBefore;
      if (Number(priceBefore) > Number(selected?.price ?? offer.price)) {
        prices.append(node('del', '', money.format(Number(priceBefore))));
      }
      parent.append(prices);
    }
    function showHero(parent, key, caption) {
      const url = selectedPhoto();
      if (!url) return;
      const view = button('', openGallery, key, 'il-tv-gallery-open', caption);
      const art = node('div', 'il-tv-art');
      const backdrop = photo(url, 'il-tv-art-backdrop');
      backdrop.setAttribute('aria-hidden', 'true');
      art.append(backdrop, photo(url, 'il-tv-hero', offer.title));
      view.append(art, node('span', '', caption));
      parent.append(view);
    }
    function showItem() {
      const line = node('div', 'il-tv-line');
      if (selectedPhoto()) line.append(photo(selectedPhoto(), 'il-tv-thumb'));
      const detail = node('div');
      detail.append(node('strong', '', offer.title));
      if (selected?.label && selected.label !== 'Default Title') detail.append(node('p', '', selected.label));
      detail.append(node('small', '', copy.unit));
      line.append(detail);
      body.append(line);
    }
    if (page === 'intro') {
      showHero(body, 'hero', copy.enlarge);
      const info = node('div', 'il-tv-intro-info');
      if (offer.vendor) info.append(node('span', 'il-tv-vendor', offer.vendor));
      info.append(node('h2', '', offer.title));
      showPrice(info);
      if (offer.description) info.append(node('p', 'il-tv-description', offer.description));
      if (optionSummary.length) {
        const facts = node('dl', 'il-tv-facts');
        for (const {name, values} of optionSummary) {
          const text = values.slice(0, 3).join(' · ') + (values.length > 3 ? '  +' + (values.length - 3) : '');
          facts.append(node('dt', '', name), node('dd', '', text));
        }
        info.append(facts);
      }
      body.append(info);
      const nextStep = availableVariants.length > 1 ? copy.options : copy.details;
      const actions = row(mainButton(available ? nextStep : copy.soldOut, () => go('detail'), 'detail', available));
      actions.classList.add('il-tv-actions');
      if (photos.length) actions.append(button(galleryLabel, openGallery, 'gallery', 'il-tv-secondary'));
      footer.append(actions);
    } else if (page === 'detail') {
      if (selectedPhoto()) showHero(body, 'gallery', galleryLabel);
      else if (photos.length) body.append(button(galleryLabel, openGallery, 'gallery', 'il-tv-secondary'));
      body.append(node('h2', '', offer.title));
      showPrice(body);
      addOptions(body);
      footer.append(mainButton(available ? copy.add : copy.soldOut, () => go('cart'), 'cart', available));
    } else if (page === 'cart') {
      showItem();
      const sum = node('div', 'il-tv-total');
      sum.append(node('strong', '', copy.total), node('strong', '', price()));
      if (goneVariants.has(selected)) {
        const status = node('div', 'il-tv-status');
        status.setAttribute('aria-live', 'polite');
        status.append(node('p', '', copy.gone));
        body.append(status);
      }
      footer.append(sum, mainButton(copy.checkout, checkout, 'finish', !goneVariants.has(selected)));
    } else {
      showItem();
      const sum = node('div', 'il-tv-total');
      sum.append(node('strong', '', copy.total), node('strong', '', price()));
      body.append(sum);
      const status = node('div', 'il-tv-status');
      status.setAttribute('aria-live', 'polite');
      if (qr) {
        const img = photo(qr, 'il-tv-qr', copy.scan);
        img.addEventListener('error', () => { if (img.isConnected) { qr = ''; error = true; render('retry'); } }, {once: true});
        status.append(img, node('p', '', copy.scan));
      } else status.append(node('p', '', error ? (goneVariants.has(selected) ? copy.gone : copy.failed) : copy.loading));
      body.append(status);
      if (error && !goneVariants.has(selected)) footer.append(mainButton(copy.retry, checkout, 'retry'));
    }
    const selection = pane.querySelector('[aria-pressed="true"]:not(:disabled)')?.dataset.shopKey;
    focusKey(key ?? ({intro:'detail', detail:selection ?? 'cart', cart:'finish', qr:'back'})[page]);
  }
  function move(direction) {
    if (page === 'gallery') {
      if (direction === 'ArrowLeft' || direction === 'ArrowRight') changePhoto(direction === 'ArrowLeft' ? -1 : 1);
      else focusKey(direction === 'ArrowDown' && photos.length > 1 ? 'next' : 'back');
      return;
    }
    const buttons = [...root.querySelectorAll('button:not(:disabled)')];
    const rows = [];
    for (const btn of buttons) {
      const row = btn.closest('.il-tv-row') ?? btn;
      if (rows[rows.length - 1]?.id !== row) rows.push({id:row, items:[]});
      rows[rows.length - 1].items.push(btn);
    }
    if (!rows.length) return;
    const ri = Math.max(0,rows.findIndex(row => row.items.includes(focusRoot.activeElement)));
    const active = rows[ri].items;
    if (direction === 'ArrowLeft' || direction === 'ArrowRight') {
      const ci = Math.max(0,active.indexOf(focusRoot.activeElement));
      active[(ci + (direction === 'ArrowLeft' ? -1 : 1) + active.length) % active.length].focus();
    } else {
      const next = rows[(ri + (direction === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length].items;
      (next.find(btn => btn.getAttribute('aria-pressed') === 'true') ?? next[0]).focus();
    }
  }
  function ok() { if (root.contains(focusRoot.activeElement)) focusRoot.activeElement.click(); }
  root.addEventListener('keydown', event => {
    if (event.key.startsWith('Arrow')) move(event.key);
    else if (['Escape','Backspace','GoBack','BrowserBack'].includes(event.key) || [461,10009].includes(event.keyCode)) { if (!event.repeat) back(); }
    else if (event.key === 'OK' || event.key === 'Enter') { if (!event.repeat) ok(); }
    else return;
    event.preventDefault(); event.stopPropagation();
  });
  render();
  return { move, ok, back, dispose() {
    disposed = true; stopRequest();
    const restore = root.contains(focusRoot.activeElement);
    root.remove();
    if (restore && previous?.isConnected) previous.focus({preventScroll:true});
  } };
}

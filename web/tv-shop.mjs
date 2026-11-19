// Shared by the player adapters and the creative editor's Smart TV simulator.
const labels = {
  es: ['Añadir producto', 'Añadir al carrito', 'Carrito de compras', 'Finalizar compra', 'Total', '1 unidad', 'Ver galería de fotos', 'Salir', 'Anterior', 'Siguiente', 'Escaneá y finalizá la compra', 'Volver', 'Preparando tu carrito…', 'No se pudo preparar el carrito.', 'Reintentar', 'Sin stock', 'Variante', 'Oferta'],
  en: ['Add product', 'Add to cart', 'Shopping cart', 'Checkout', 'Total', '1 item', 'View photo gallery', 'Exit', 'Previous', 'Next', 'Scan to complete your purchase', 'Back', 'Preparing your cart…', 'Could not prepare the cart.', 'Retry', 'Out of stock', 'Variant', 'Offer'],
  pt: ['Adicionar produto', 'Adicionar ao carrinho', 'Carrinho de compras', 'Finalizar compra', 'Total', '1 unidade', 'Ver galeria de fotos', 'Sair', 'Anterior', 'Próxima', 'Escaneie e finalize a compra', 'Voltar', 'Preparando seu carrinho…', 'Não foi possível preparar o carrinho.', 'Tentar novamente', 'Sem estoque', 'Variante', 'Oferta'],
};

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
  const [addProduct, addCart, cartTitle, finish, total, unit, galleryTitle, exit, prev, next, scan, backLabel, loading, failed, retry, soldOut, variantLabel, promo] =
    labels[locale.toLowerCase().split('-')[0]] ?? labels.en;
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: offer.currency || 'USD' });
  const variants = offer.variants;
  let selected = variants.find(v => v.availableForSale !== false) ?? variants[0];
  const axes = productOptions(variants);
  const photos = [...new Set([offer.imageUrl, ...(offer.images ?? []), ...variants.map(v => v.imageUrl)].filter(Boolean))];
  let index = Math.max(0, photos.indexOf(selected?.imageUrl));
  let page = 'intro', qr = '', error = false, pending, disposed = false;
  const previous = focusRoot.activeElement;
  const root = node('div', 'il-tv-shop');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', offer.title);
  for (const key of ['background', 'foreground', 'accent']) {
    if (/^#[0-9a-f]{6}$/i.test(brand[key])) root.style.setProperty('--shop-' + key, brand[key]);
  }
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
    else if (page === 'gallery') go('detail', 'gallery');
    else if (page === 'cart') go('detail', 'cart');
    else go('cart', 'finish');
  }
  function focusKey(key) {
    const controls = [...root.querySelectorAll('button:not(:disabled)')];
    (controls.find(el => el.dataset.shopKey === key) ?? controls[0])?.focus();
  }
  function selectVariant(item, key) {
    selected = item;
    if (item.imageUrl) index = Math.max(0, photos.indexOf(item.imageUrl));
    render(key);
  }
  function changePhoto(step) {
    index = (index + step + photos.length) % photos.length;
    render(step < 0 ? 'prev' : 'next');
  }
  function addOptions(body) {
    const available = variants.filter(v => v.availableForSale !== false);
    if (variants.length === 1 && variants[0].label === 'Default Title') return;
    if (!axes.length) {
      body.append(node('h4', '', variantLabel));
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
    let prefix = available;
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
    if (pending || !selected || selected.availableForSale === false) return;
    const controller = new AbortController();
    pending = controller;
    page = 'qr'; qr = ''; error = false;
    render('back');
    try {
      const url = await prepareCheckout(selected, controller.signal);
      if (disposed || controller.signal.aborted || pending !== controller) return;
      if (!url) throw new Error('Missing QR');
      qr = url;
    } catch {
      if (disposed || controller.signal.aborted || pending !== controller) return;
      error = true;
    }
    pending = undefined;
    render(error ? 'retry' : 'back');
  }
  function render(key) {
    const pane = node('section', 'il-tv-sheet');
    root.dataset.page = page;
    root.replaceChildren(pane);
    const header = node('header', 'il-tv-header');
    header.append(button('‹', back, 'back', 'il-tv-back', backLabel));
    const heading = node('h3', '', page === 'cart' || page === 'qr' ? cartTitle : page === 'detail' ? offer.title : '');
    if (heading.textContent) header.append(heading);
    if (brand.logoUrl) header.append(photo(brand.logoUrl, 'il-tv-logo'));
    const body = node('div', 'il-tv-body');
    const footer = node('footer', 'il-tv-footer');
    pane.append(header, body, footer);
    function primary(title, action, id, enabled = true) {
      const control = button(title, action, id, 'il-tv-primary');
      control.disabled = !enabled;
      footer.append(control);
    }
    function hero() { if (photos[index]) body.append(photo(photos[index], 'il-tv-hero', offer.title)); }
    const available = !!selected && selected.availableForSale !== false;
    if (page === 'intro') {
      hero();
      const info = node('div', 'il-tv-intro-info');
      if (Number(offer.previousPrice) > Number(selected?.price ?? offer.price)) info.append(node('small', '', promo));
      info.append(node('h2', '', offer.title));
      if (Number(offer.previousPrice) > Number(selected?.price ?? offer.price)) info.append(node('del', '', money.format(Number(offer.previousPrice))));
      info.append(node('strong', 'il-tv-price', price()));
      body.append(info);
      primary(available ? addProduct : soldOut, () => go('detail'), 'detail', available);
    } else if (page === 'detail') {
      if (photos.length > 1) {
        const view = button('', () => go('gallery'), 'gallery', 'il-tv-gallery-open');
        view.append(photo(photos[index], 'il-tv-hero', offer.title), node('span', '', galleryTitle));
        body.append(view);
      } else hero();
      body.append(node('strong', 'il-tv-price', price()));
      if (offer.description) body.append(node('p', '', offer.description));
      addOptions(body);
      primary(available ? addCart : soldOut, () => go('cart'), 'cart', available);
    } else if (page === 'gallery') {
      header.firstChild.textContent = '‹ ' + exit;
      const slides = node('div', 'il-tv-slides');
      const slide = offset => photo(photos[(index + offset + photos.length) % photos.length], offset ? 'il-tv-side' : 'il-tv-feature', offset ? '' : offer.title);
      slides.append(button('‹', () => changePhoto(-1), 'prev', 'il-tv-gallery-arrow', prev), slide(-1), slide(0), slide(1), button('›', () => changePhoto(1), 'next', 'il-tv-gallery-arrow', next));
      body.append(slides);
      footer.append(node('small', '', (index + 1) + ' / ' + photos.length), node('h2', '', offer.title), node('strong', '', price()));
      if (offer.description) footer.append(node('p', '', offer.description));
    } else if (page === 'cart') {
      const line = node('div', 'il-tv-line');
      if (photos[index]) line.append(photo(photos[index], 'il-tv-thumb'));
      const detail = node('div');
      detail.append(node('strong', '', offer.title), node('p', '', selected?.label));
      line.append(detail, node('small', '', unit)); body.append(line);
      if (brand.logoUrl) body.append(photo(brand.logoUrl, 'il-tv-cart-logo'));
      const sum = node('div', 'il-tv-total');
      sum.append(node('strong', '', total), node('strong', '', price()));
      footer.append(sum); primary(finish, checkout, 'finish');
    } else {
      hero(); body.append(node('h2', '', offer.title), node('strong', '', price() + ' · ' + (selected?.label ?? '')));
      const status = node('div', 'il-tv-status');
      status.setAttribute('aria-live', 'polite');
      if (qr) {
        const img = photo(qr, 'il-tv-qr', scan);
        img.addEventListener('error', () => { if (img.isConnected) { qr = ''; error = true; render('retry'); } }, {once: true});
        status.append(img, node('p', '', scan));
      } else status.append(node('p', '', error ? failed : loading));
      footer.append(status);
      if (error) primary(retry, checkout, 'retry');
    }
    const selection = pane.querySelector('[aria-pressed="true"]:not(:disabled)')?.dataset.shopKey;
    focusKey(key ?? ({intro:'detail', detail:selection ?? 'cart', cart:'finish', gallery:'next', qr:'back'})[page]);
  }
  function move(direction) {
    if (page === 'gallery' && ['ArrowLeft','ArrowRight'].includes(direction)) { changePhoto(direction === 'ArrowLeft' ? -1 : 1); return; }
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

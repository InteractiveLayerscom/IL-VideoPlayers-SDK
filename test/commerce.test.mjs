import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { commerceSurface } from '../web/commerce.mjs';
import { productOptions } from '../web/tv-shop.mjs';
import { attachHtmlVideo, attachShaka, normalizeCue } from '../web/index.mjs';

const cue = {
  id: 'offer', format: 'overlay', start: 1000, end: 31000, imageUrl: 'https://ads.example/boots.png',
  commerce: {
    title: 'Botines', price: '45.50', currency: 'USD', locale: 'es',
    variants: [{ id: '42', label: 'Talle 42', price: '45.50' }, { id: '43', label: 'Talle 43', price: '47' }],
    handoffUrl: 'https://ads.example/handoff',
    viewUrl: 'https://ads.example/view',
  },
};

test('accepts long Shopify option labels and falls back to SKU selection for duplicate combinations', () => {
  const value = 'ñ'.repeat(220);
  const variant = { id: 'A', label: value + ' / M', selectedOptions: [{name:'Color', value}, {name:'Talle', value:'M'}] };
  const normalized = normalizeCue({ ...cue, commerce:{ ...cue.commerce, variants:[variant] } }).commerce.variants;
  assert.deepEqual(productOptions(normalized), [{name:'Color', values:[value]}, {name:'Talle', values:['M']}]);
  assert.deepEqual(productOptions([...normalized, {...normalized[0], id:'B'}]), []);
});

test('validates commerce destinations while keeping a playable legacy creative', () => {
  assert.deepEqual(normalizeCue(cue)?.commerce, cue.commerce);
  for (const handoffUrl of ['javascript:alert(1)', 'http://ads.example/handoff', 'https://user@ads.example/handoff']) {
    const invalid = { ...cue, commerce: { ...cue.commerce, handoffUrl } };
    assert.equal(normalizeCue(invalid), null);
    assert.equal(normalizeCue({ ...invalid, format: 'super' })?.commerce, undefined);
  }
});

test('a TV sends one localized offer request, chooses a variant, and removes the QR on teardown', async () => {
  const { window } = new JSDOM('<main><video></video></main>', { pretendToBeVisual: true });
  const stage = window.document.querySelector('main');
  const video = stage.querySelector('video');
  Object.defineProperties(video, { paused: { value: false }, readyState: { value: 4 } });
  let now = 1000;
  const requests = [];
  const sdk = attachHtmlVideo({
    video, stage, programTime: () => now, interval: false, sessionId: 'tv-test',
    eventsUrl: 'https://ads.example/cues', commerce: { locale: 'es', country: 'AR', tv: true },
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      const body = url.pathname === '/cues' ? [cue] :
        { continueUrl: 'https://ads.example/continue', qrImageUrl: 'https://ads.example/qr.png' };
      return { ok: true, json: async () => body };
    },
  });
  const pending = () => new Promise(resolve => setImmediate(resolve));
  sdk.tick();
  await pending();
  assert.equal(requests[0].url.searchParams.get('commerce'), '1');
  assert.equal(requests[0].url.searchParams.get('locale'), 'es');
  assert.equal(requests[0].url.searchParams.get('country'), 'AR');
  stage.querySelector('img').dispatchEvent(new window.Event('load'));
  const button = text => [...stage.querySelectorAll('button')].find(el => el.textContent === text);
  button('Ver producto').click();
  button('Elegir opciones').click();
  const choice = button('Talle 42');
  assert.equal(window.document.activeElement, choice);
  choice.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(window.document.activeElement, button('Talle 43'));
  const key = value => window.document.activeElement.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: value, bubbles: true }));
  key('Enter');
  assert.equal(button('Talle 43').getAttribute('aria-pressed'), 'true');
  assert.equal(stage.querySelector('.il-tv-price').textContent,
    new Intl.NumberFormat('es', { style: 'currency', currency: 'USD' }).format(47));
  key('ArrowDown');
  assert.equal(window.document.activeElement, button('Agregar al carrito'));
  key('Enter');
  assert.equal(requests.filter(({url}) => url.pathname === '/handoff').length, 0);
  assert.equal(window.document.activeElement, button('Continuar con el QR'));
  key('Enter');
  await pending();
  assert.equal(requests.filter(({ url }) => url.pathname === '/view').length, 1);
  assert.deepEqual(JSON.parse(requests.find(({ url }) => url.pathname === '/handoff').options.body),
    { variantId: '43' });
  assert.equal(stage.querySelector('img[alt="Escaneá para pagar en Shopify"]')?.src, 'https://ads.example/qr.png');
  key('Escape');
  assert.equal(window.document.activeElement, button('Continuar con el QR'));
  key('Escape');
  assert.equal(button('Talle 43').getAttribute('aria-pressed'), 'true');
  key('Escape');
  key('Escape');
  assert.equal(window.document.activeElement, button('Ver producto'));
  assert.equal(stage.querySelector('.il-tv-qr'), null);
  now = 31000;
  sdk.tick();
  assert.equal(stage.querySelector('.il-commerce'), null);
  sdk.destroy();
  window.close();
});

test('Shaka connects web checkout to the displayed offer and restores it after a linear break', async () => {
  const { window } = new JSDOM('<main><video></video><div id="client"></div><div id="server"></div></main>', {
    pretendToBeVisual: true,
  });
  const doc = window.document;
  const video = doc.querySelector('video');
  const client = doc.querySelector('#client');
  Object.defineProperties(video, { paused: { value: false }, readyState: { value: 4 } });
  const manager = new window.EventTarget();
  let currentAd;
  manager.setContainers = () => {};
  manager.getCurrentAd = () => currentAd;
  manager.addCustomInterstitial = ad => {
    currentAd = { getAdId: () => ad.id, isLinear: () => false };
    const img = doc.createElement('img');
    img.src = ad.uri;
    img.style.cssText = 'display:block;visibility:visible;opacity:1';
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } });
    img.getBoundingClientRect = () => ({ width: 100, height: 100 });
    client.appendChild(img);
  };
  const network = { registerResponseFilter() {}, unregisterResponseFilter() {} };
  const sdk = attachShaka({
    player: { getAdManager: () => manager, getMediaElement: () => video, getNetworkingEngine: () => network },
    clientContainer: client, serverContainer: doc.querySelector('#server'),
    programTime: () => 2000, eventsUrl: 'https://ads.example/cues', sessionId: 'web-test', interval: false,
    commerce: { locale: 'pt-BR' },
    fetchImpl: async input => {
      const pathname = new URL(input).pathname;
      const body = pathname === '/cues' ? [cue] : { continueUrl: 'https://ads.example/continue' };
      return { ok: true, json: async () => body };
    },
  });
  const pending = () => new Promise(resolve => setImmediate(resolve));
  sdk.tick();
  await pending();
  const button = text => [...doc.querySelectorAll('button')].find(el => el.textContent === text);
  button('Ver produto').click();
  button('Comprar').click();
  await pending();
  assert.equal(doc.querySelector('a')?.href, 'https://ads.example/continue');
  assert.equal(doc.querySelector('a')?.textContent, 'Continuar para Shopify');
  sdk.setLinearAd(true);
  assert.equal(doc.querySelector('.il-commerce'), null);
  sdk.setLinearAd(false);
  assert.ok(button('Ver produto'));
  sdk.destroy();
  window.close();
});

test('a TV can buy the last of 100 variants and ignores a previous cart reply', async () => {
  const { window } = new JSDOM('<main><button>Product</button></main>', { pretendToBeVisual: true });
  const doc = window.document;
  const stage = doc.querySelector('main');
  const trigger = stage.querySelector('button');
  const requests = [];
  const variants = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), label: 'Option ' + i, price: String(i + 1),
  }));
  const offer = { ...cue.commerce, variants, viewUrl: undefined };
  const surface = commerceSurface(stage, { tv: true, locale: 'en' }, (_, options) =>
    new Promise(resolve => requests.push({ options, resolve })));
  const press = key => doc.activeElement.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const reply = id => ({ ok: true, json: async () => ({
    continueUrl: 'https://shop.example/continue', qrImageUrl: 'https://shop.example/qr/' + id,
  }) });
  try {
    surface.open(cue, offer, trigger, () => true);
    press('Enter'); // Intro → details
    press('ArrowDown'); press('Enter'); // Add to cart
    press('Enter'); // Checkout
    assert.equal(requests.length, 1);
    press('Escape'); press('Escape'); // Cancel request and return to details
    assert.equal(requests[0].options.signal.aborted, true);
    press('ArrowUp'); press('ArrowLeft');
    assert.equal(doc.activeElement.textContent, 'Option 99');
    press('Enter'); press('ArrowDown'); press('Enter'); press('Enter');
    assert.deepEqual(JSON.parse(requests[1].options.body), { variantId: '99' });
    requests[0].resolve(reply(0));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stage.querySelector('.il-tv-qr'), null);
    requests[1].resolve(reply(99));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stage.querySelector('.il-tv-qr').src, 'https://shop.example/qr/99');
    for (let i = 0; i < 4; i++) press('Backspace');
    assert.equal(doc.activeElement, trigger);
  } finally {
    surface.hide();
    window.close();
  }
});

test('TV shows only valid Shopify combinations, photo gallery and the selected SKU price', async () => {
  const {window} = new JSDOM('<main><button>Shop</button></main>', {pretendToBeVisual:true});
  const doc = window.document;
  const stage = doc.querySelector('main');
  const variant = (id, color, size, price, availableForSale = true) => ({id, label:color + ' / ' + size, price,
    availableForSale, selectedOptions:[{name:'Color',value:color},{name:'Size',value:size}]});
  const product = {...cue.commerce, imageUrl:cue.imageUrl, images:['https://ads.example/side.png'], description:'Canvas',
    viewUrl:undefined, variants:[variant('b-s','Blue','S','12'),variant('b-m','Blue','M','13'),variant('t-m','Tan','M','15'),variant('t-l','Tan','L','16',false)]};
  product.vendor = 'Andén';
  product.variants[2].previousPrice = '19';
  const tanPhoto = 'https://ads.example/tan.png';
  product.variants[2].imageUrl = tanPhoto;
  const posted = [];
  const shop = commerceSurface(stage,{tv:true,locale:'en'},async (_, options) => {
    posted.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({continueUrl:'https://shop.example/continue',qrImageUrl:'https://ads.example/qr'})};
  });
  const btn = value => [...stage.querySelectorAll('button')].find(el => el.textContent === value || el.getAttribute('aria-label') === value);
  shop.open(cue, product, stage.querySelector('button'), () => true);
  assert.equal(stage.querySelector('.il-tv-intro-info h2').textContent, product.title);
  assert.equal(stage.querySelector('.il-tv-from').textContent, 'From');
  assert.match(stage.querySelector('.il-tv-price').textContent, /12/);
  assert.equal(stage.querySelector('.il-tv-vendor').textContent, 'Andén');
  assert.equal(stage.querySelector('.il-tv-description').textContent, 'Canvas');
  assert.match(stage.querySelector('.il-tv-facts').textContent, /ColorBlue · Tan/);
  btn('View photos').click();
  assert.equal(stage.querySelector('[role="dialog"] .il-tv-feature').src, cue.imageUrl);
  assert.equal(stage.querySelector('.il-tv-sheet'), null);
  btn('Back').click();
  assert.equal(doc.activeElement.textContent, 'View photos');
  assert.equal(stage.querySelector('.il-tv-shop').dataset.page, 'intro');
  btn('Choose options').click(); btn('View photos').click(); btn('Next').click();
  assert.equal(stage.querySelector('.il-tv-feature').src, product.images[0]);
  btn('Back').click();
  assert.equal(stage.querySelector('.il-tv-hero').src, product.imageUrl);
  btn('Tan').click();
  assert.equal(stage.querySelector('.il-tv-hero').src, tanPhoto);
  btn('View photos').click();
  assert.equal(stage.querySelector('.il-tv-feature').src, tanPhoto);
  btn('Next').click(); btn('Back').click();
  assert.equal(stage.querySelector('.il-tv-hero').src, tanPhoto);
  btn('Blue').click();
  assert.equal(stage.querySelector('.il-tv-hero').src, product.imageUrl);
  btn('Tan').click();
  assert.equal(btn('S').disabled,true); assert.equal(btn('L').disabled,true); assert.equal(btn('M').getAttribute('aria-pressed'),'true');
  assert.match(stage.querySelector('.il-tv-price').textContent,/15/);
  assert.match(stage.querySelector('.il-tv-prices del').textContent,/19/);
  btn('Add to cart').click(); assert.deepEqual(posted,[]);
  assert.equal(stage.querySelector('.il-tv-thumb').src, tanPhoto);
  btn('Continue to QR').click();
  assert.equal(stage.querySelector('.il-tv-thumb').src, tanPhoto);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(posted,[{variantId:'t-m'}]);
  shop.hide(); window.close();
});

test('even a single TV product photo can be enlarged and Back returns focus to its opener', () => {
  const {window} = new JSDOM('<main><button>Shop</button></main>', {pretendToBeVisual:true});
  const doc = window.document, stage = doc.querySelector('main');
  const shop = commerceSurface(stage, {tv:true,locale:'en'});
  shop.open(cue, {...cue.commerce, imageUrl:cue.imageUrl, viewUrl:undefined}, stage.querySelector('button'), () => true);
  const get = key => stage.querySelector('[data-shop-key="' + key + '"]');
  for (const opener of ['hero', 'gallery']) {
    get(opener).click();
    assert.equal(stage.querySelector('[role="dialog"] img').src, cue.imageUrl);
    assert.equal(get('next'), null);
    assert.equal(get('prev'), null);
    assert.equal(doc.activeElement, get('back'));
    doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}));
    doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    assert.equal(doc.activeElement, get(opener));
  }
  get('detail').click();
  get('gallery').click(); get('back').click();
  assert.equal(doc.activeElement, get('gallery'));
  shop.hide(); window.close();
});

test('TV shopping actions stay white with dark text for a red brand, including focus', () => {
  const {window} = new JSDOM('<main><button>Shop</button></main>', {pretendToBeVisual:true});
  const doc = window.document, stage = doc.querySelector('main');
  const style = doc.createElement('style');
  style.textContent = readFileSync(new URL('../web/tv-shop.css', import.meta.url), 'utf8');
  doc.head.append(style);
  const shop = commerceSurface(stage, {tv:true,locale:'en'});
  shop.open({...cue, brand:{accent:'#ff0022'}}, {...cue.commerce, viewUrl:undefined}, stage.querySelector('button'), () => true);
  for (const key of ['detail', 'cart', 'finish']) {
    const action = stage.querySelector('[data-shop-key="' + key + '"]');
    action.focus();
    const appearance = window.getComputedStyle(action);
    assert.equal(appearance.backgroundColor, 'rgb(255, 255, 255)');
    assert.equal(appearance.color, 'rgb(20, 20, 20)');
    if (key !== 'finish') action.click();
  }
  shop.hide(); window.close();
});

test('a linked midroll requests only its live VAST delivery, draws no MP4 as image, and leaves VAST in charge of impressions', async () => {
  const {window} = new JSDOM('<main><video></video></main>', {pretendToBeVisual:true});
  const stage=window.document.querySelector('main'), video=stage.querySelector('video');
  Object.defineProperties(video,{paused:{value:false},readyState:{value:4}});
  const urls=[], measured=[];
  const linear = {...cue,id:'delivery',linearCreativeId:'creative',format:'midroll',imageUrl:undefined,
    commerce:{...cue.commerce,imageUrl:cue.imageUrl}};
  const sdk=attachHtmlVideo({stage,video,programTime:()=>1900,interval:false,refreshMs:0,sessionId:'viewer',
    commerce:{tv:true,locale:'es'},eventsUrl:'https://ads.example/tag?start=1000&end=31000',onVisible:item=>measured.push(item),
    fetchImpl:async input=>{urls.push(new URL(input));return {ok:true,json:async()=>[linear]};}});
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  sdk.setLinearAd(true); await settle(); assert.equal(urls.length,0);
  sdk.setLinearAd(true,{creativeId:'creative',deliveryId:'other'}); await settle(); assert.equal(stage.querySelector('.il-tv-shop-trigger'),null);
  sdk.setLinearAd(true,{creativeId:'creative',deliveryId:'delivery'}); await settle();
  assert.equal(urls.at(-1).searchParams.get('midroll_delivery_id'),'delivery');
  stage.querySelector('.il-tv-shop-trigger').click();
  assert.equal(stage.querySelector('.il-tv-hero').src,cue.imageUrl); assert.deepEqual(measured,[]);
  sdk.setLinearAd(false); await settle(); assert.equal(stage.querySelector('.il-tv-shop'),null);
  assert.equal(urls.at(-1).searchParams.has('midroll_delivery_id'),false);
  sdk.destroy(); window.close();
});

test('web product window follows the selected SKU photo, falling back to the product cover', () => {
  const {window} = new JSDOM('<main><button>Shop</button></main>');
  const stage = window.document.querySelector('main');
  const cover = 'https://ads.example/cover.png', sand = 'https://ads.example/sand.png';
  const product = {...cue.commerce, imageUrl:cover, viewUrl:undefined, variants:[
    {id:'sand-s', label:'Sand S', price:'12', imageUrl:sand},
    {id:'sand-m', label:'Sand M', price:'13', imageUrl:sand},
    {id:'plain', label:'Plain', price:'10'},
  ]};
  const shop = commerceSurface(stage, {locale:'en'});
  shop.open(cue, product, stage.querySelector('button'), () => true);
  const image = () => stage.querySelector('.il-commerce-summary img');
  const choose = name => [...stage.querySelectorAll('button')].find(el => el.textContent === name).click();
  assert.equal(image().src, sand);
  choose('Sand M'); assert.equal(image().src, sand);
  choose('Plain'); assert.equal(image().src, cover);
  choose('Sand S'); assert.equal(image().src, sand);
  shop.hide(); window.close();
});

test('the browser shows Comprar over the confirmed linear spot', () => {
  const {window} = new JSDOM('<main></main>');
  const stage = window.document.querySelector('main');
  const surface = commerceSurface(stage, {locale: 'es'});
  surface.show({...cue, format: 'midroll'}, () => true);
  assert.equal(stage.querySelector('button').textContent, 'Comprar');
  surface.hide();
  window.close();
});

test('the hand-off reply is opened only over https: no link for another scheme, no QR image unless https', async () => {
  const outer = new JSDOM('<iframe></iframe>').window;
  const window = outer.document.querySelector('iframe').contentWindow;
  window.document.body.innerHTML = '<main><button>Shop</button></main>';
  const stage = window.document.querySelector('main');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const replies = [
    { continueUrl: 'javascript:alert(1)', qrImageUrl: 'https://ads.example/qr.png', link: false, qr: false },
    { continueUrl: 'http://shop.example/checkout', qrImageUrl: 'https://ads.example/qr.png', link: false, qr: false },
    { continueUrl: 'https://shop.example/checkout', qrImageUrl: 'data:image/png;base64,AAAA', link: true, qr: false },
    { continueUrl: 'https://shop.example/checkout', qrImageUrl: 'https://ads.example/qr.png', link: true, qr: true },
  ];
  for (const reply of replies) {
    const shop = commerceSurface(stage, { locale: 'en' }, async () => ({ ok: true, json: async () => reply }));
    shop.open(cue, cue.commerce, stage.querySelector('button'), () => true);
    [...stage.querySelectorAll('button')].find(el => el.textContent === 'Buy').click();
    await settle();
    const result = stage.querySelector('.il-commerce-result');
    assert.equal(!!result.querySelector('a'), reply.link, reply.continueUrl);
    if (reply.link) assert.equal(result.querySelector('a').href, 'https://shop.example/checkout');
    else assert.equal(result.textContent, 'Could not prepare the cart. Try again.');
    assert.equal(!!result.querySelector('img'), reply.qr, reply.qrImageUrl);
    shop.hide();
  }
  outer.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
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
  button('Añadir producto').click();
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
  assert.equal(window.document.activeElement, button('Añadir al carrito'));
  key('Enter');
  assert.equal(requests.filter(({url}) => url.pathname === '/handoff').length, 0);
  assert.equal(window.document.activeElement, button('Finalizar compra'));
  key('Enter');
  await pending();
  assert.equal(requests.filter(({ url }) => url.pathname === '/view').length, 1);
  assert.deepEqual(JSON.parse(requests.find(({ url }) => url.pathname === '/handoff').options.body),
    { variantId: '43' });
  assert.equal(stage.querySelector('img[alt="Escaneá y finalizá la compra"]')?.src, 'https://ads.example/qr.png');
  key('Escape');
  assert.equal(window.document.activeElement, button('Finalizar compra'));
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
  const posted = [];
  const shop = commerceSurface(stage,{tv:true,locale:'en'},async (_, options) => {
    posted.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({continueUrl:'https://shop.example/continue',qrImageUrl:'https://ads.example/qr'})};
  });
  const btn = value => [...stage.querySelectorAll('button')].find(el => el.textContent === value || el.getAttribute('aria-label') === value);
  shop.open(cue, product, stage.querySelector('button'), () => true);
  btn('Add product').click(); btn('View photo gallery').click(); btn('Next').click();
  assert.equal(stage.querySelector('.il-tv-feature').src, product.images[0]);
  btn('Back').click(); btn('Tan').click();
  assert.equal(btn('S').disabled,true); assert.equal(btn('L').disabled,true); assert.equal(btn('M').getAttribute('aria-pressed'),'true');
  assert.match(stage.querySelector('.il-tv-price').textContent,/15/);
  btn('Add to cart').click(); assert.deepEqual(posted,[]); btn('Checkout').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(posted,[{variantId:'t-m'}]);
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

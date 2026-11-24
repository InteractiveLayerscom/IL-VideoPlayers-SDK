import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachHtmlVideo } from '../web/index.mjs';

// The owner's rule: the Super lasts as long as its ad; the shopping panel, once the viewer opens it, stays open after the
// ad disappears until the viewer closes it. Each test below names one rule.

const offerFor = (id) => ({ id: 'p-' + id, imageUrl: 'https://ads.example/p.jpg', title: 'Producto ' + id, price: '100.00', currency: 'USD', locale: 'en',
  handoffUrl: `https://ads.example/commerce/offer/${id}`, viewUrl: `https://ads.example/view/${id}`,
  variants: [{ id: 'v1', label: 'M', price: '100.00' }, { id: 'v2', label: 'L', price: '100.00' }] });
const layers = [{ id: 'card', type: 'rect', x: 0, y: 0, width: 1440, height: 216, fill: '#151923', productIndex: 0, action: 'product' }];
// A designed Super whose card opens the product; its window is [start, end) in milliseconds.
const banner = (id, start, end) => ({ id, format: 'super', start, end, impressionUrl: `https://ads.example/events/${id}/impression`,
  products: [offerFor(id)], scene: { format: 'super', width: 1440, height: 216, durationMs: end - start, layers } });
const midroll = (id, creative) => ({ id, format: 'midroll', linearCreativeId: creative, start: 0, end: Number.MAX_SAFE_INTEGER, commerce: offerFor(id) });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function host(t, { eventsUrl, answer, tv = false, handoff = 201 } = {}) {
  const { window } = new JSDOM('<div id="s"><button id="host">host page button</button><button id="other">another</button><video></video></div>',
    { pretendToBeVisual: true });
  const doc = window.document, stage = doc.querySelector('#s'), video = doc.querySelector('video');
  // Layout: jsdom has none, so a scene would never count as visible.
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, left: 0, top: 0, right: 300, bottom: 40 });
  const state = { time: 0, paused: false, ended: false, ready: 4, seeking: false, pauses: 0, src: '' };
  Object.defineProperties(video, {
    currentTime: { get: () => state.time, set: (value) => { state.time = value; } },
    readyState: { get: () => state.ready }, paused: { get: () => state.paused }, ended: { get: () => state.ended },
    seeking: { get: () => state.seeking }, currentSrc: { get: () => state.src },
  });
  video.pause = () => { state.pauses++; state.paused = true; };
  video.play = () => { state.paused = false; return Promise.resolve(); };
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET' });
    if (eventsUrl && url.startsWith(eventsUrl)) return { ok: true, json: async () => answer() };
    if (url.includes('/commerce/offer/')) {
      const status = typeof handoff === 'function' ? handoff(JSON.parse(init.body).variantId) : handoff;
      return { ok: status < 300, status, json: async () => ({ continueUrl: 'https://shop.example/c', qrImageUrl: 'https://ads.example/qr.png' }) };
    }
    return { ok: true, status: 204 };
  };
  const sdk = attachHtmlVideo({ video, stage, timeline: 'media', interval: false, refreshMs: 0, commerce: { locale: 'en', ...(tv ? { tv: true } : {}) }, fetchImpl,
    ...(eventsUrl ? { eventsUrl, sessionId: 'viewer' } : {}) });
  const at = async (seconds) => {
    state.time = seconds;
    sdk.tick();
    await flush();
    sdk.tick();
  };
  const count = (part, method = 'GET') => calls.filter((c) => c.url.includes(part) && c.method === method).length;
  const panel = () => doc.querySelector('.il-commerce-panel:not([hidden])');
  const title = () => panel()?.querySelector('.il-commerce-title')?.textContent;
  const tile = () => doc.querySelector('.il-scene-action');
  const openTile = () => { tile().focus(); tile().click(); };
  const close = () => doc.querySelector('.il-commerce-close').click();
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    sdk.destroy();
    window.close();
  };
  // Registered with the test, so a failed assertion still stops the session's timers.
  t.after(done);
  return { window, doc, stage, video, state, sdk, at, count, panel, title, tile, openTile, close, calls, done };
}

test('rule 1: the Super is drawn exactly for its window, whatever the panel does', async (t) => {
  const h = host(t);
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(0.5);
  assert.equal(h.doc.querySelector('.il-scene'), null, 'not before its window');
  await h.at(5);
  assert.ok(h.doc.querySelector('.il-scene'));
  h.openTile();
  assert.equal(h.title(), 'Producto a');
  await h.at(7.9);
  assert.ok(h.doc.querySelector('.il-scene'), 'open panel or not, the Super lasts to the end of its window');
  await h.at(8);
  assert.equal(h.doc.querySelector('.il-scene'), null, 'and no longer: the open panel does not keep it');
  assert.equal(h.title(), 'Producto a', 'the panel is still there');
  h.done();
});

test('rule 2: a panel the viewer opened stays after its ad ends, with no time limit', async (t) => {
  const h = host(t);
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(5);
  h.openTile();
  h.panel().querySelector('.il-commerce-variants button:nth-child(2)').click();
  for (const seconds of [9, 30, 68, 200, 3600]) {
    await h.at(seconds);
    assert.equal(h.title(), 'Producto a', `still open at ${seconds} s`);
  }
  assert.equal(h.panel().querySelector('.il-commerce-variants button:nth-child(2)').getAttribute('aria-pressed'), 'true', 'with the choice made');
  h.done();
});

test('rule 3: it closes when the viewer closes it (Close, Escape)', async (t) => {
  for (const how of ['Close', 'Escape']) {
    const h = host(t);
    h.sdk.addCue(banner('a', 1000, 8000));
    await h.at(5);
    h.openTile();
    await h.at(9);
    if (how === 'Close') h.close();
    else h.doc.querySelector('.il-commerce').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(h.doc.querySelector('.il-commerce'), null, how);
    h.done();
  }
});

test('rule 3: it closes when the viewer opens another product', async (t) => {
  const h = host(t);
  h.sdk.addCue(banner('a', 1000, 8000));
  h.sdk.addCue(banner('b', 7000, 30000));
  await h.at(5);
  h.openTile();
  await h.at(10);
  assert.equal(h.title(), 'Producto a', 'the ad behind appeared; the panel stayed');
  h.openTile();                                      // the viewer opens the product of the ad now on screen
  assert.equal(h.title(), 'Producto b');
  assert.equal(h.doc.querySelectorAll('.il-commerce').length, 1, 'the first one is closed');
  h.done();
});

test('rule 3: it closes when a new ad break starts, but not the panel of the ad that is playing; each new ad of a break closes the previous one', async (t) => {
  const A = 'A'.repeat(43), B = 'B'.repeat(43);
  const h = host(t);
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(5);
  h.openTile();
  h.sdk.setLinearAd(true);
  assert.equal(h.doc.querySelector('.il-commerce'), null, 'a break closes the product kept from content');
  h.sdk.setLinearAd(false);

  h.sdk.addCue(midroll(A, 'cr'));
  h.sdk.addCue(midroll(B, 'cr'));
  h.sdk.setLinearAd(true, { creativeId: 'cr', deliveryId: A });
  h.doc.querySelector('.il-commerce > button').click();
  assert.equal(h.title(), 'Producto ' + A);
  h.sdk.setLinearAd(true, { creativeId: 'cr', deliveryId: A });
  assert.equal(h.title(), 'Producto ' + A, 'the ad that is playing keeps its panel');
  h.sdk.setLinearAd(false);
  assert.equal(h.title(), 'Producto ' + A, 'the end of the break keeps it');
  h.sdk.setLinearAd(true, { creativeId: 'cr', deliveryId: B });
  assert.equal(h.doc.querySelector('.il-commerce-panel:not([hidden])'), null, 'the next ad of a break closes the previous ad\'s product');
  h.done();
});

test('rule 3: it closes when the media changes', async (t) => {
  const h = host(t);
  h.state.src = 'https://cdn.example/a.mp4';
  h.video.dispatchEvent(new h.window.Event('loadstart'));
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(5);
  h.openTile();
  await h.at(9);
  assert.ok(h.panel());
  h.video.dispatchEvent(new h.window.Event('emptied'));
  h.state.src = 'https://cdn.example/b.mp4';
  h.video.dispatchEvent(new h.window.Event('loadstart'));
  assert.equal(h.doc.querySelector('.il-commerce'), null);
  h.done();
});

test('rule 3: it closes when the session is destroyed, and when the player\'s element leaves the page', async (t) => {
  const gone = host(t);
  gone.sdk.addCue(banner('a', 1000, 8000));
  await gone.at(5);
  gone.openTile();
  await gone.at(9);
  gone.sdk.destroy();
  assert.equal(gone.stage.querySelector('.il-commerce'), null, 'destroy');
  gone.window.close();

  const left = host(t);
  left.sdk.addCue(banner('a', 1000, 8000));
  await left.at(5);
  left.openTile();
  await left.at(9);
  const panel = left.stage.querySelector('.il-commerce');
  left.stage.remove();
  left.sdk.tick();
  assert.equal(panel.isConnected, false);
  assert.equal(left.stage.querySelector('.il-commerce'), null, 'the element left the page');
  left.done();
});

test('rule 4: it does not close on pause, buffering or a seek', async (t) => {
  const h = host(t);
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(5);
  h.openTile();
  await h.at(9);
  h.state.paused = true;
  h.video.dispatchEvent(new h.window.Event('pause'));
  await h.at(9);
  assert.equal(h.title(), 'Producto a', 'pause');
  h.state.paused = false;
  h.state.ready = 1;
  h.video.dispatchEvent(new h.window.Event('waiting'));
  await h.at(9);
  assert.equal(h.title(), 'Producto a', 'buffering');
  h.state.ready = 4;
  h.state.seeking = true;
  h.video.dispatchEvent(new h.window.Event('seeking'));
  await h.at(0.2);
  h.state.seeking = false;
  h.video.dispatchEvent(new h.window.Event('seeked'));
  await h.at(60);
  assert.equal(h.title(), 'Producto a', 'seek back and forward');
  await h.at(5);
  assert.equal(h.title(), 'Producto a', 'seek back into its own window');
  assert.equal(h.doc.querySelectorAll('.il-commerce').length, 1, 'one panel, not two');
  h.done();
});

test('rule 4: it does not close when another ad appears behind it, and the viewer keeps their place in it', async (t) => {
  const h = host(t);
  h.sdk.addCue(banner('a', 1000, 8000));
  h.sdk.addCue(banner('b', 7000, 30000));
  await h.at(5);
  h.openTile();
  const open = h.panel();
  open.querySelector('.il-commerce-variants button:nth-child(2)').click();
  open.querySelector('.il-commerce-variants button:nth-child(2)').focus();
  await h.at(10);
  assert.equal(h.panel(), open, 'the same panel, on top');
  assert.equal(h.doc.querySelectorAll('.il-scene').length, 1, 'the new ad is drawn behind');
  assert.equal(h.doc.activeElement, open.querySelector('.il-commerce-variants button:nth-child(2)'), 'focus stays where the viewer left it');
  assert.equal(open.querySelector('.il-commerce-variants button:nth-child(2)').getAttribute('aria-pressed'), 'true');
  h.done();
});

test('rule 4: it does not close when a feed poll drops its cue', async (t) => {
  let rows = [banner('a', 1000, 60000)];
  const h = host(t, { eventsUrl: 'https://ads.example/cues', answer: () => rows });
  await h.at(5);
  await h.at(5.1);
  h.openTile();
  assert.equal(h.title(), 'Producto a');
  rows = [];
  await h.at(6);
  await h.at(6.1);
  assert.equal(h.doc.querySelector('.il-scene'), null, 'the dropped cue\'s graphic is gone');
  assert.equal(h.title(), 'Producto a', 'the open panel is not');
  h.done();
});

test('rule 5: the ad\'s impression and the product view are counted once, whatever the panel does', async (t) => {
  const h = host(t);
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(5);
  await h.at(5.2);
  h.openTile();
  h.close();
  h.openTile();
  await h.at(9);
  h.close();
  await h.at(6);
  await h.at(9);
  assert.equal(h.count('/events/a/impression'), 1, 'impression');
  assert.equal(h.count('/view/a'), 1, 'view');
  h.done();
});

test('rule 6: closing a kept panel whose scene is gone focuses the first control of the ad now on screen', async (t) => {
  const h = host(t);
  h.sdk.addCue(banner('a', 1000, 8000));
  h.sdk.addCue(banner('b', 7000, 30000));
  await h.at(5);
  h.openTile();
  await h.at(10);
  const next = h.tile();
  assert.ok(next && next.isConnected, 'the second ad\'s control');
  h.close();
  assert.equal(h.doc.activeElement, next);
  h.done();
});

test('rule 6: with no ad on screen, focus goes back to where it was before the ad took it', async (t) => {
  const h = host(t);
  h.doc.querySelector('#host').focus();
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(5);
  h.openTile();
  await h.at(9);
  assert.equal(h.doc.querySelector('.il-scene'), null);
  h.close();
  assert.equal(h.doc.activeElement, h.doc.querySelector('#host'));
  h.done();
});

test('rule 6: focus the host page moved meanwhile is never taken away', async (t) => {
  const h = host(t);
  h.doc.querySelector('#host').focus();
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(5);
  h.openTile();
  await h.at(9);
  h.doc.querySelector('#other').focus();
  h.close();
  assert.equal(h.doc.activeElement, h.doc.querySelector('#other'));
  h.done();
});

test('TV shop: the same rules (the Super ends with its window, the open shop stays, Back closes it, focus goes to the ad now on screen)', async (t) => {
  const h = host(t, { tv: true });
  h.sdk.addCue(banner('a', 1000, 8000));
  h.sdk.addCue(banner('b', 7000, 30000));
  await h.at(5);
  h.openTile();
  assert.ok(h.doc.querySelector('.il-tv-shop'));
  await h.at(9);
  assert.equal(h.doc.querySelectorAll('.il-scene').length, 1, 'only the new ad\'s Super is drawn');
  assert.ok(h.doc.querySelector('.il-tv-shop'), 'the shop the viewer opened stays');
  await h.at(20);
  assert.ok(h.doc.querySelector('.il-tv-shop'), 'and keeps staying while the ad behind it runs');
  const next = h.tile();
  h.doc.querySelector('.il-tv-shop').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'GoBack', bubbles: true }));
  assert.equal(h.doc.querySelector('.il-tv-shop'), null, 'Back closes it');
  assert.equal(h.doc.activeElement, next, 'focus goes to the first control of the ad on screen');
  h.done();
});

test('TV shop: a new break closes it', async (t) => {
  const h = host(t, { tv: true });
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(5);
  h.openTile();
  await h.at(9);
  assert.ok(h.doc.querySelector('.il-tv-shop'));
  h.sdk.setLinearAd(true);
  assert.equal(h.doc.querySelector('.il-tv-shop'), null);
  h.done();
});

test('Buy after the delivery expired: the web panel says so and stays usable; the TV shop says so, offers no retry and closes with Back', async (t) => {
  const web = host(t, { handoff: 404 });
  web.sdk.addCue(banner('a', 1000, 8000));
  await web.at(5);
  web.openTile();
  web.doc.querySelector('.il-commerce-buy').click();
  await flush();
  assert.equal(web.doc.querySelector('.il-commerce-result').textContent, 'This offer is no longer available.');
  web.close();
  assert.equal(web.doc.querySelector('.il-commerce'), null, 'and it closes');
  web.done();

  const tv = host(t, { tv: true, handoff: 404 });
  tv.sdk.addCue(banner('a', 1000, 8000));
  await tv.at(5);
  tv.openTile();
  for (const key of ['detail', 'cart', 'finish']) tv.doc.querySelector(`[data-shop-key="${key}"]`)?.click();
  await flush();
  await flush();
  assert.equal(tv.doc.querySelector('.il-tv-status')?.textContent, 'This offer is no longer available.');
  assert.equal(tv.doc.querySelector('[data-shop-key="retry"]'), null, 'retrying cannot help');
  for (let i = 0; i < 6 && tv.doc.querySelector('.il-tv-shop'); i++)
    tv.doc.querySelector('.il-tv-shop').dispatchEvent(new tv.window.KeyboardEvent('keydown', { key: 'GoBack', bubbles: true }));
  assert.equal(tv.doc.querySelector('.il-tv-shop'), null, 'the remote closes it');
  tv.done();
});

const posts = (h) => h.calls.filter((c) => c.method === 'POST' && c.url.includes('/commerce/offer/')).length;
const settle = async () => { await flush(); await flush(); };

test('web card: a 404 turns Buy off for that variant only; another variant tries again; a 500 still allows a retry', async (t) => {
  const h = host(t, { handoff: (variant) => (variant === 'v1' ? 404 : 201) });
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(5);
  h.openTile();
  const buy = () => h.doc.querySelector('.il-commerce-buy');
  const choose = (n) => h.panel().querySelector(`.il-commerce-variants button:nth-child(${n})`).click();
  buy().focus();
  buy().click();
  await settle();
  assert.equal(h.doc.querySelector('.il-commerce-result').textContent, 'This offer is no longer available.');
  assert.equal(buy().disabled, true, 'Buy is off for the variant that answered 404');
  assert.notEqual(h.doc.activeElement, h.doc.body, 'focus is not lost');
  assert.ok(h.panel().contains(h.doc.activeElement) && !h.doc.activeElement.disabled, 'focus is on a control that works');
  buy().click();
  await settle();
  assert.equal(posts(h), 1, 'no pressing it again to fail again');
  choose(2);
  assert.equal(buy().disabled, false, 'another variant: Buy is on and the message is gone');
  assert.equal(h.doc.querySelector('.il-commerce-result').textContent, '');
  buy().click();
  await settle();
  assert.equal(h.doc.querySelector('.il-commerce-result a')?.href, 'https://shop.example/c', 'its checkout continues');
  choose(1);
  assert.equal(buy().disabled, true, 'back on the first variant it is still off');
  assert.equal(h.doc.querySelector('.il-commerce-result').textContent, 'This offer is no longer available.');
  h.close();
  assert.equal(h.doc.querySelector('.il-commerce'), null, 'the panel closes');
  h.done();

  const all = host(t, { handoff: 404 });
  all.sdk.addCue(banner('a', 1000, 8000));
  await all.at(5);
  all.openTile();
  const press = async () => { all.doc.querySelector('.il-commerce-buy').click(); await settle(); };
  await press();
  all.panel().querySelector('.il-commerce-variants button:nth-child(2)').click();
  await press();
  assert.equal(all.doc.querySelector('.il-commerce-buy').disabled, true, 'the second variant, also 404, is off too');
  assert.equal(posts(all), 2);
  all.done();

  const flaky = host(t, { handoff: 500 });
  flaky.sdk.addCue(banner('a', 1000, 8000));
  await flaky.at(5);
  flaky.openTile();
  for (let i = 0; i < 2; i++) { flaky.doc.querySelector('.il-commerce-buy').click(); await settle(); }
  assert.equal(posts(flaky), 2, 'a 500 allows another try');
  assert.equal(flaky.doc.querySelector('.il-commerce-buy').disabled, false);
  assert.equal(flaky.doc.querySelector('.il-commerce-result').textContent, 'Could not prepare the cart. Try again.');
  flaky.done();
});

test('TV shop: a 404 turns the checkout off for that variant only; another variant tries again; a 500 still allows a retry', async (t) => {
  const keys = (h, name) => h.doc.querySelector(`[data-shop-key="${name}"]`);
  const back = (h) => h.doc.querySelector('.il-tv-shop').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'GoBack', bubbles: true }));
  const variantButton = (h, label) => [...h.doc.querySelectorAll('.il-tv-shop button')].find((b) => b.textContent.trim() === label);
  const h = host(t, { tv: true, handoff: (variant) => (variant === 'v1' ? 404 : 201) });
  h.sdk.addCue(banner('a', 1000, 8000));
  await h.at(5);
  h.openTile();
  keys(h, 'detail').click();
  keys(h, 'cart').click();
  keys(h, 'finish').click();
  await settle();
  assert.equal(h.doc.querySelector('.il-tv-status').textContent, 'This offer is no longer available.');
  assert.equal(keys(h, 'retry'), null, 'no retry for a 404');
  assert.notEqual(h.doc.activeElement, h.doc.body, 'focus is not lost');
  back(h);                                           // the cart of the same variant
  assert.equal(keys(h, 'finish').disabled, true, 'checkout is off for that variant');
  assert.equal(h.doc.querySelector('.il-tv-status').textContent, 'This offer is no longer available.');
  assert.ok(h.doc.activeElement && h.doc.activeElement !== h.doc.body && !h.doc.activeElement.disabled, 'focus is on a control that works');
  back(h);                                           // the options
  variantButton(h, 'L').click();
  keys(h, 'cart').click();
  assert.equal(keys(h, 'finish').disabled, false, 'another variant: checkout is on');
  keys(h, 'finish').click();
  await settle();
  assert.ok(h.doc.querySelector('.il-tv-qr'), 'its checkout continues');
  back(h); back(h);
  variantButton(h, 'M').click();
  keys(h, 'cart').click();
  assert.equal(keys(h, 'finish').disabled, true, 'back on the first variant it is still off');
  assert.equal(posts(h), 2);
  h.done();

  const flaky = host(t, { tv: true, handoff: 500 });
  flaky.sdk.addCue(banner('a', 1000, 8000));
  await flaky.at(5);
  flaky.openTile();
  for (const key of ['detail', 'cart', 'finish']) keys(flaky, key).click();
  await settle();
  assert.ok(keys(flaky, 'retry'), 'a 500 offers a retry');
  keys(flaky, 'retry').click();
  await settle();
  assert.equal(posts(flaky), 2);
  flaky.done();
});

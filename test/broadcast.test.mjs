import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { attachBroadcast } from '../web/index.mjs';

const scene = JSON.parse(readFileSync(new URL('./fixtures/creative-scene.json', import.meta.url)));
const settle = () => new Promise(resolve => setImmediate(resolve));
const image = 'https://ads.example/super.png';

function setup(options = {}) {
  const { window } = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const stage = window.document.querySelector('main');
  window.HTMLMediaElement.prototype.pause = () => {};
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.load = () => {};
  let now = 0;
  const sdk = attachBroadcast({ stage, clock: () => now, interval: false, ...options });
  // jsdom never loads images: mark them loaded with a size, then tick.
  const load = () => {
    for (const img of stage.querySelectorAll('img')) {
      Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 10 } });
      img.style.opacity = '1';
      img.getBoundingClientRect = () => ({ width: 10, height: 10, right: 10, bottom: 10, left: 0, top: 0 });
      img.dispatchEvent(new window.Event('load'));
    }
  };
  return { window, stage, sdk, load, at: time => { now = time; } };
}
const superCue = { id: 'super-1', format: 'super', start: 1000, end: 3000, imageUrl: image };

test('setCues shows a super at its time and hides it at its end', () => {
  const { stage, sdk, load, at } = setup();
  try {
    at(500);
    sdk.setCues([superCue]);
    assert.equal(stage.querySelectorAll('img').length, 0);
    at(1500);
    sdk.setCues([superCue]);
    load();
    assert.equal(stage.querySelectorAll('img').length, 1);
    assert.equal(stage.querySelector('img').src, image);
    assert.equal(stage.firstElementChild.style.visibility, 'visible');
    at(3000);
    sdk.setCues([superCue]);
    assert.equal(stage.querySelectorAll('img').length, 0);
  } finally { sdk.destroy(); }
});

test('setCues([]) clears what is on screen at once', () => {
  const { stage, sdk, load, at } = setup();
  try {
    at(1500);
    sdk.setCues([superCue]);
    load();
    assert.equal(stage.querySelectorAll('img').length, 1);
    sdk.setCues([]);
    assert.equal(stage.childElementCount, 0);
  } finally { sdk.destroy(); }
});

test('a scene cue renders through the scene renderer, and an L scene is an overlay', async () => {
  const { window, stage, sdk, at } = setup();
  try {
    at(1500);
    sdk.setCues([structuredClone(scene)]);
    await settle();
    const root = stage.querySelector('.il-scene');
    assert.ok(root);
    root.getBoundingClientRect = () => ({ width: 1920, height: 1080, right: 1920, bottom: 1080, left: 0, top: 0 });
    assert.notEqual(root.style.display, 'none');
    assert.equal(window.document.querySelector('main').style.width, '');
  } finally { sdk.destroy(); }
});

test('onVisible fires once per cue id, even when hidden is reported by the page', () => {
  const seen = [];
  const { sdk, load, at } = setup({ onVisible: cue => seen.push(cue.id) });
  try {
    at(1500);
    sdk.setCues([superCue]);
    load();
    sdk.setCues([superCue]);
    sdk.setCues([superCue, { ...superCue, id: 'super-2', imageUrl: image + '?2' }]);
    assert.deepEqual(seen, ['super-1']);
  } finally { sdk.destroy(); }
});

test('hidden is injectable: a hidden page counts nothing', () => {
  const seen = [];
  const { sdk, load, at } = setup({ hidden: () => true, onVisible: cue => seen.push(cue.id) });
  try {
    at(1500);
    sdk.setCues([superCue]);
    load();
    sdk.setCues([superCue]);
    assert.deepEqual(seen, []);
  } finally { sdk.destroy(); }
});

test('an l cue without a scene is not shown', () => {
  const { stage, sdk, load, at } = setup();
  try {
    at(1500);
    assert.equal(sdk.setCues([{ id: 'l-1', format: 'l', start: 1000, end: 3000, imageUrl: image }]), true);
    load();
    assert.equal(stage.childElementCount, 0);
  } finally { sdk.destroy(); }
});

test('destroy leaves the stage empty and later calls do nothing', () => {
  const { stage, sdk, load, at } = setup();
  at(1500);
  sdk.setCues([superCue]);
  load();
  sdk.destroy();
  assert.equal(stage.childElementCount, 0);
  assert.equal(sdk.setCues([superCue]), false);
  assert.equal(stage.childElementCount, 0);
});

test('without onVisible the impressionUrl is requested once', async () => {
  const { window } = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const stage = window.document.querySelector('main');
  const urls = [];
  // attachBroadcast has no fetch option: the beacon goes through the global fetch.
  const original = globalThis.fetch;
  globalThis.fetch = async url => { urls.push(String(url)); return {}; };
  const sdk = attachBroadcast({ stage, clock: () => 1500, interval: false });
  try {
    sdk.setCues([{ ...superCue, impressionUrl: 'https://ads.example/imp' }]);
    for (const img of stage.querySelectorAll('img')) {
      Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 10 } });
      img.style.opacity = '1';
      img.getBoundingClientRect = () => ({ width: 10, height: 10 });
      img.dispatchEvent(new window.Event('load'));
    }
    sdk.setCues([{ ...superCue, impressionUrl: 'https://ads.example/imp' }]);
    sdk.setCues([{ ...superCue, impressionUrl: 'https://ads.example/imp' }]);
    assert.deepEqual(urls, ['https://ads.example/imp']);
  } finally { sdk.destroy(); globalThis.fetch = original; }
});

// One player over a stitched fixture, the SDK's content clock and ads module, and a frame sampler:
// for every presented frame, what the picture is (from its bands or red), what the clock says and whether
// the SDK's graphic is visible. ?player=hls|shaka|videojs|native &stream=master|multi|audio
// With &plain=1 the player plays the stream without the IL SDK, unmuted, and each sample also records which
// tone is sounding (440 Hz content, 1000 Hz ads), to check picture and sound stay together after the ads.
// With &product=1 (or 2) the plan has no graphics but a scene product (`commerce`) in one window before (or after) the
// mid-roll, and each sample also records whether the product card and its open panel are visible.
// With &src=<master URL>&plan=<plan JSON path> it plays an external stitched stream (a real MediaTailor session) with
// the plan IL built for it instead of the local fixture; with &product=1 the plan gets a scene product in the two
// windows of REAL_WINDOWS, both in one load.
import { attachHtmlVideo, attachVideoJs } from '/web/index.mjs';
import { attachAds, hlsContentClock, nativeHlsContentClock, shakaContentClock, videoJsContentClock } from '/web/ads.mjs';

const params = new URLSearchParams(location.search);
const kind = params.get('player');
const plain = params.get('plain') === '1';
const productMode = ['1', '2'].includes(params.get('product'));
const real = params.has('src');
let src = real ? params.get('src') : new URL(`/stitched/${params.get('stream') || 'master'}.m3u8`, location.href).href;
// Safari's clock needs the explicit session (its manifest can be read again without opening another session): the
// page asks MediaTailor for one, as a publisher's page does, and plays its manifestUrl.
if (real && params.get('player') === 'native') {
  const res = await fetch(src.replace('/v1/master/', '/v1/session/'), { method: 'POST', body: '{}',
    headers: { 'Content-Type': 'application/json' } });
  src = new URL((await res.json()).manifestUrl, src).href;
}
const TAG = 'https://pubads.g.doubleclick.net/gampad/ads?iu=/123/site/graphic&env=vp&output=vast&cust_params=il_format%3Dsuper';
const CREATIVE = 'https://creative.test/super.png';
const VAST = `<VAST version="3.0"><Ad id="ad"><InLine><AdTitle>C</AdTitle><Impression>https://creative.test/i</Impression><Creatives><Creative><NonLinearAds><NonLinear width="720" height="108"><StaticResource creativeType="image/png">${CREATIVE}</StaticResource></NonLinear></NonLinearAds></Creative></Creatives></InLine></Ad></VAST>`;
// The window straddles the mid-roll (content 14): content 10–20 is stream 14–18 and 22–28.
let plan = {
  version: 1, expires_at: new Date(Date.now() + 3600000).toISOString(), page_url: 'https://publisher.example/v', duration: 30,
  timeline: { kind: 'stitched', pdt_origin: '2000-01-01T00:00:00.000Z', breaks: [0, 14] }, cuts: [],
  scenes: {
    formats: ['super'],
    pacing: { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0 },
    graphics: [{ format: 'super', tag_url: TAG }],
    windows: [{ id: 'w', start_ms: 10000, end_ms: 20000 }],
  },
};
// The scene product: content 6–11 s (stream 10–15, before the mid-roll) or 16–21 s (stream 24–29, after it), one per
// page: the SDK leaves 30 s between the starts of two windows and the fixture's content lasts 30 s. The plan comes
// from the host (not loadPlan), so commerce.url must be on the `planOrigin` it states.
const PLAN_ORIGIN = 'https://console.test';
const PRODUCT_ROUTE = PLAN_ORIGIN + '/il-player/scene-product';
// On the real stream (300 s of content, the mid-roll at content 60): content 40–50 s before it and 70–78 s after it,
// 30 s apart as the SDK requires between window starts.
const REAL_WINDOWS = [{ id: 'w1', start_ms: 40000, end_ms: 50000 }, { id: 'w2', start_ms: 70000, end_ms: 78000 }];
const PRODUCT_WINDOWS = real ? REAL_WINDOWS
  : [{ id: 'w1', start_ms: 6000, end_ms: 11000 }, { id: 'w2', start_ms: 16000, end_ms: 21000 }];
if (real) {
  // The plan as IL built it; only its expiry is moved forward (a saved plan has expired) for this page.
  plan = await (await fetch(params.get('plan'))).json();
  plan.expires_at = new Date(Date.now() + 3600000).toISOString();
}
if (productMode) {
  if (!real) delete plan.scenes;
  plan.commerce = { kind: 'scene_product', url: PRODUCT_ROUTE + '?project=p1&asset=a&grant=x.y', lead_ms: 2000,
    pacing: { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0 },
    windows: real ? REAL_WINDOWS : [PRODUCT_WINDOWS[Number(params.get('product')) - 1]] };
}
// The card IL answers for a window (docs/scene-product.md, section 3).
const productCard = (id) => {
  const { start_ms: start, end_ms: end } = PRODUCT_WINDOWS.find((window) => window.id === id);
  return { id: 'dlv_' + id, format: 'super', start, end, window: id, imageUrl: 'https://creative.test/product.png',
    mimeType: 'image/png', impressionUrl: 'https://creative.test/impression/' + id,
    commerce: { id: 'gid://shopify/Product/100', title: 'Delantal', price: '100.00', currency: 'USD', locale: 'en',
      variants: [{ id: 'gid://shopify/ProductVariant/101', label: 'M', price: '100.00', availableForSale: true }],
      handoffUrl: 'https://creative.test/handoff/' + id, viewUrl: 'https://creative.test/view/' + id } };
};
const requests = [];
const segments = [];
const events = [];
const fetchImpl = async (url) => {
  requests.push({ url: String(url), t: video.currentTime, clock: clock?.time() ?? null });
  if (String(url).startsWith(PRODUCT_ROUTE)) {
    const card = productCard(new URL(url).searchParams.get('window'));
    return { ok: true, status: 200, json: async () => card };
  }
  return { ok: true, text: async () => VAST };
};
const loadScript = (url) => new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = url;
  script.onload = resolve;
  script.onerror = reject;
  document.head.append(script);
});

const stage = document.querySelector('#stage');
let video = document.querySelector('#video');
if (plain) video.muted = false;
// Safari plays the real stream itself: without CORS mode its frames would taint the canvas the sampler reads.
if (real) video.crossOrigin = 'anonymous';
let clock = null;
let session;
// The session renders commerce only for the product page; the graphics checks keep a session without it.
const commerce = productMode ? { locale: 'en' } : undefined;
// Switches to the second rendition (`multi`) at once, as an ABR decision would.
let switchRendition = () => {};
if (kind === 'hls') {
  const { default: Hls } = await import('/node_modules/hls.js/dist/hls.mjs');
  const hls = new Hls();
  if (!plain) clock = hlsContentClock({ hls, video, plan });
  hls.loadSource(src);
  hls.attachMedia(video);
  switchRendition = () => { hls.nextLevel = 1; };
  hls.on(Hls.Events.ERROR, (_, data) => events.push({ type: 'error', fatal: data.fatal, details: data.details }));
} else if (kind === 'shaka') {
  await loadScript('/node_modules/shaka-player/dist/shaka-player.compiled.js');
  window.shaka.polyfill.installAll();
  const player = new window.shaka.Player();
  await player.attach(video);
  // Where Shaka placed each segment it downloaded, to explain a failure.
  player.getNetworkingEngine().registerResponseFilter((type, response, context) => {
    if (type === 1 && context?.segment) segments.push({ uri: response.originalUri, start: context.segment.startTime,
      end: context.segment.endTime });
  });
  if (!plain) clock = shakaContentClock({ player, plan, onEvent: (event) => events.push(event) });
  player.addEventListener('error', (event) => events.push({ type: 'error', code: event.detail?.code }));
  await player.load(src);
  switchRendition = () => {
    player.configure({ abr: { enabled: false } });
    const track = player.getVariantTracks().find((item) => !item.active);
    if (track) player.selectVariantTrack(track, false);
  };
} else if (kind === 'videojs') {
  await loadScript('/node_modules/video.js/dist/video.min.js');
  video.classList.add('video-js');
  const player = window.videojs(video, { html5: { vhs: { overrideNative: true } }, muted: !plain });
  if (!plain) clock = videoJsContentClock({ player, plan });
  player.src({ src, type: 'application/x-mpegURL' });
  video = player.tech({ IWillNotUseThisInPlugins: true }).el();
  if (!plain) session = attachVideoJs({ player, stage, programTime: clock.programTime, commerce });
  switchRendition = () => {
    const vhs = player.tech({ IWillNotUseThisInPlugins: true }).vhs;
    vhs.representations().forEach((rep, i) => rep.enabled(i === 1));
  };
} else if (kind === 'native') {
  if (!video.canPlayType('application/vnd.apple.mpegurl')) throw new Error('no native HLS');
  // A fixture stands for the session's own manifest: with MediaTailor this is the explicit session's manifestUrl.
  if (!plain) clock = nativeHlsContentClock({ video, plan, playlistUrl: src, sessionManifest: !real,
    onEvent: (event) => events.push(event) });
  video.src = src;
}
let ads = null;
if (!plain) {
  session ??= attachHtmlVideo({ video, stage, programTime: clock.programTime, commerce });
  ads = attachAds({ session, video, stage, plan, clock, fetchImpl, planOrigin: PLAN_ORIGIN });
}

// Which tone sounds now: 'content', 'ad' or null (silence, or neither clearly).
let tone = () => null;
if (plain) {
  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 4096;
  audio.createMediaElementSource(video).connect(analyser);
  analyser.connect(audio.destination);
  const bins = new Float32Array(analyser.frequencyBinCount);
  const level = (hz) => {
    const bin = Math.round(hz / (audio.sampleRate / analyser.fftSize));
    return Math.max(bins[bin - 1], bins[bin], bins[bin + 1]);
  };
  tone = () => {
    analyser.getFloatFrequencyData(bins);
    const content = level(440);
    const ad = level(1000);
    if (Math.max(content, ad) < -70) return null;
    return content > ad + 15 ? 'content' : ad > content + 15 ? 'ad' : null;
  };
  window.resumeAudio = () => audio.resume();
}

const canvas = document.createElement('canvas');
canvas.width = 16;
canvas.height = 9;
const context = canvas.getContext('2d', { willReadFrequently: true });
const samples = [];
let seekedAt = -Infinity;
video.addEventListener('seeked', () => {
  seekedAt = performance.now();
});
let waiting = 0;
video.addEventListener('waiting', () => {
  if (video.currentTime > 0.5 && !video.seeking) waiting++;
});
const creatives = () => [...stage.querySelectorAll('img')].filter((img) => img.src === CREATIVE);
const graphicVisible = () => creatives().some((img) => img.complete && img.naturalWidth > 0 &&
  img.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && img.getBoundingClientRect().width > 0);
const shown = (element) => !!element && element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
  element.getBoundingClientRect().width > 0;
const productVisible = () => [...stage.querySelectorAll('.il-commerce')].some(shown);
const panelVisible = () => [...stage.querySelectorAll('.il-commerce-panel')].some(shown);
function sample(metadata) {
  context.drawImage(video, 0, 0, 16, 9);
  const data = context.getImageData(0, 0, 16, 9).data;
  const at = (x, y) => [...data.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 3)];
  const [r, g, b] = at(8, 4);
  // The four bands of a content frame (see stitched-fixture.mjs), each read at its center.
  const bands = [2, 6, 10, 14].map((x) => at(x, 4));
  // Four points of the top row, for the real stream's pictures (the test pattern's bars, or the ad's light slide).
  const top = [1, 4, 6, 8].map((x) => at(x, 1));
  samples.push({ t: video.currentTime, media: metadata?.mediaTime ?? null, r, g, b, bands, top, rate: video.playbackRate, clock: clock ? clock.time() : null, graphic: graphicVisible(),
    images: creatives().length, product: productVisible(), panel: panelVisible(),
    products: stage.querySelectorAll('.il-commerce').length, panels: stage.querySelectorAll('.il-commerce-panel').length, hidden: document.visibilityState === 'hidden',
    paused: video.paused, seeking: video.seeking, sinceSeek: performance.now() - seekedAt,
    tone: tone(), wall: performance.now() });
}
function onFrame(now, metadata) {
  sample(metadata);
  // The product is read again once every frame callback of this rendering step has run (the SDK's own included),
  // in an animation frame callback of the same step: what is painted with this frame.
  if (productMode) {
    const entry = samples.at(-1);
    requestAnimationFrame(() => Object.assign(entry, { product: productVisible(), panel: panelVisible(),
      products: stage.querySelectorAll('.il-commerce').length }));
  }
  arm();
}
// WebKit can drop a pending frame callback when a seek starts about when it was registered: re-arm after a seek or a resume
// (cancelling the one that may still be pending, so there is never more than one chain).
let frameHandle;
const arm = () => { frameHandle = video.requestVideoFrameCallback(onFrame); };
for (const name of ['seeked', 'playing']) video.addEventListener(name, () => { video.cancelVideoFrameCallback(frameHandle); arm(); });
arm();

window.harness = {
  requests, samples, sample, events, segments,
  ready: () => video.readyState >= 1,
  async seek(t) {
    video.currentTime = t;
    await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
  },
  play: () => video.play(),
  pause: () => video.pause(),
  time: () => video.currentTime,
  ended: () => video.ended,
  duration: () => video.duration,
  waiting: () => waiting,
  switchRendition: () => switchRendition(),
  setRate: (rate) => { video.playbackRate = rate; },
  destroy: () => ads?.destroy(),
  // Opens the detail of the product card on screen, as the viewer's click on its button.
  openProduct() {
    const button = stage.querySelector('.il-commerce > button');
    if (!button || !shown(button)) return false;
    button.click();
    return panelVisible();
  },
  // The page hidden (another tab) or shown again. Playwright's pages are always visible, so the document's
  // visibility is stood in for and its visibilitychange dispatched, as the browser does when a tab changes.
  setHidden(hidden) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  },
};
window.harnessReady = true;

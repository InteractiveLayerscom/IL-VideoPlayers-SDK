// One player over a stitched fixture, the SDK's content clock and ads module, and a frame sampler:
// for every presented frame, what the picture is (from its bands or red), what the clock says and whether
// the SDK's graphic is visible. ?player=hls|shaka|videojs|native &stream=master|multi|audio
// With &plain=1 the player plays the stream without the IL SDK, unmuted, and each sample also records which
// tone is sounding (440 Hz content, 1000 Hz ads), to check picture and sound stay together after the ads.
import { attachHtmlVideo, attachVideoJs } from '/web/index.mjs';
import { attachAds, hlsContentClock, nativeHlsContentClock, shakaContentClock, videoJsContentClock } from '/web/ads.mjs';

const params = new URLSearchParams(location.search);
const kind = params.get('player');
const plain = params.get('plain') === '1';
const src = new URL(`/stitched/${params.get('stream') || 'master'}.m3u8`, location.href).href;
const TAG = 'https://pubads.g.doubleclick.net/gampad/ads?iu=/123/site/graphic&env=vp&output=vast&cust_params=il_format%3Dsuper';
const CREATIVE = 'https://creative.test/super.png';
const VAST = `<VAST version="3.0"><Ad id="ad"><InLine><AdTitle>C</AdTitle><Impression>https://creative.test/i</Impression><Creatives><Creative><NonLinearAds><NonLinear width="720" height="108"><StaticResource creativeType="image/png">${CREATIVE}</StaticResource></NonLinear></NonLinearAds></Creative></Creatives></InLine></Ad></VAST>`;
// The window straddles the mid-roll (content 14): content 10–20 is stream 14–18 and 22–28.
const plan = {
  version: 1, expires_at: new Date(Date.now() + 3600000).toISOString(), page_url: 'https://publisher.example/v', duration: 30,
  timeline: { kind: 'stitched', pdt_origin: '2000-01-01T00:00:00.000Z', breaks: [0, 14] }, cuts: [],
  scenes: {
    formats: ['super'],
    pacing: { min_seconds: 1.5, max_seconds: null, gap_after_seconds: 0, max_per_video: null, cut_clearance_seconds: 0 },
    graphics: [{ format: 'super', tag_url: TAG }],
    windows: [{ id: 'w', start_ms: 10000, end_ms: 20000 }],
  },
};
const requests = [];
const segments = [];
const events = [];
const fetchImpl = async (url) => {
  requests.push({ url: String(url), t: video.currentTime, clock: clock?.time() ?? null });
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
let clock = null;
let session;
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
  if (!plain) session = attachVideoJs({ player, stage, programTime: clock.programTime });
  switchRendition = () => {
    const vhs = player.tech({ IWillNotUseThisInPlugins: true }).vhs;
    vhs.representations().forEach((rep, i) => rep.enabled(i === 1));
  };
} else if (kind === 'native') {
  if (!video.canPlayType('application/vnd.apple.mpegurl')) throw new Error('no native HLS');
  // A fixture stands for the session's own manifest: with MediaTailor this is the explicit session's manifestUrl.
  if (!plain) clock = nativeHlsContentClock({ video, plan, playlistUrl: src, sessionManifest: true });
  video.src = src;
}
let ads = null;
if (!plain) {
  session ??= attachHtmlVideo({ video, stage, programTime: clock.programTime });
  ads = attachAds({ session, video, stage, plan, clock, fetchImpl });
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
function sample() {
  context.drawImage(video, 0, 0, 16, 9);
  const data = context.getImageData(0, 0, 16, 9).data;
  const at = (x, y) => [...data.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 3)];
  const [r, g, b] = at(8, 4);
  // The four bands of a content frame (see stitched-fixture.mjs), each read at its center.
  const bands = [2, 6, 10, 14].map((x) => at(x, 4));
  samples.push({ t: video.currentTime, r, g, b, bands, clock: clock ? clock.time() : null, graphic: graphicVisible(),
    images: creatives().length, paused: video.paused, seeking: video.seeking, sinceSeek: performance.now() - seekedAt,
    tone: tone(), wall: performance.now() });
}
function onFrame() {
  sample();
  video.requestVideoFrameCallback(onFrame);
}
video.requestVideoFrameCallback(onFrame);

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
  destroy: () => ads?.destroy(),
};
window.harnessReady = true;

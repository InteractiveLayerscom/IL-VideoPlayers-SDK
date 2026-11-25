// Two ways to show IL on a Samsung TV with AVPlay:
//   'load': the SDK requests the plan from IL's app route (app=tizen:<application id>) and plays the plan's breaks.
//   'host': the app's backend (examples/api-relay.mjs) creates the playback and asks each break from IL's per-break
//           API; the app plays the ad itself on AVPlay and reports the break and the ad, and the SDK draws Buy.
import { attachAvPlay } from './sdk/index.mjs';
import { attachAvPlayAds, attachAvPlayAppAds, fetchLinearAd } from './sdk/avplay-ads.mjs';

const config = window.IL_EXAMPLE;
const avplay = window.webapis.avplay;
const stage = document.querySelector('#stage');
const log = (line) => { document.querySelector('#log').textContent += line + '\n'; };
const rect = () => ({ x: 0, y: 0, width: 1920, height: 1080 });
const onEvent = (event) => log(JSON.stringify(event));
// Video on demand: the session's clock is the content position in milliseconds.
const session = attachAvPlay({ avplay, stage, surface: document.querySelector('#av'), getDisplayRect: rect,
  programTime: () => avplay.getCurrentTime(), commerce: { locale: 'es' } });

function openContent(listener) {
  avplay.open(config.contentUrl);
  avplay.setListener(listener);
  avplay.setDisplayRect(0, 0, 1920, 1080);
  return new Promise((resolve, reject) => avplay.prepareAsync(resolve, reject));
}

async function loadMode() {
  const listener = { onstreamcompleted: () => sdk?.contentEnded() };
  const sdk = await attachAvPlayAppAds({ origin: config.consoleOrigin, project: config.project, asset: config.asset,
    avplay, session, contentUrl: config.contentUrl, listener, getDisplayRect: rect, stage, onEvent });
  if (!sdk) log('no plan: playing without ads');
  await sdk?.start();
  await openContent(listener);
  avplay.play();
  // The pre-roll and mid-rolls run inside the SDK; it calls tick() on its own timer.
}

async function relay(path, body) {
  const res = await fetch(config.relayUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function hostMode() {
  const { playback_id: playbackId, plan } = await relay('/playback', { asset_id: config.asset });
  const breaks = [58, 178];
  const sdk = attachAvPlayAds({ avplay, session, plan, planOrigin: config.consoleOrigin, contentUrl: config.contentUrl,
    getDisplayRect: rect, stage, onEvent });
  sdk.setBreaks(breaks);
  const listener = { onstreamcompleted: () => sdk.contentEnded() };
  await openContent(listener);
  avplay.play();
  const played = new Set();
  setInterval(async () => {
    const at = breaks.find((cue) => !played.has(cue) && avplay.getCurrentTime() >= cue * 1000);
    if (at == null) return;
    played.add(at);
    const resumeAt = avplay.getCurrentTime();
    // One step of the per-break walk: the answer's ad tag; /break/next with after_step when it is empty.
    let answer = await relay('/break', { playback_id: playbackId, cue_seconds: at });
    let ad = null;
    while (answer?.ad_tag_url && !ad) {
      ad = await fetchLinearAd(answer.ad_tag_url, { fetchImpl: fetch, Parser: DOMParser });
      if (!ad && answer.steps_left > 0) answer = await relay('/break/next', { playback_id: playbackId, opportunity_id: answer.opportunity_id, after_step: answer.step });
      else break;
    }
    if (!ad) return;
    sdk.breakStarted(at);
    avplay.close();
    avplay.open(ad.mediaUrl);
    avplay.setDisplayRect(0, 0, 1920, 1080);
    await new Promise((resolve, reject) => avplay.prepareAsync(resolve, reject));
    avplay.setListener({ onstreamcompleted: async () => {
      sdk.clearBreakAd();
      avplay.close();
      await openContent(listener);
      await new Promise((resolve, reject) => avplay.seekTo(resumeAt, resolve, reject));
      sdk.breakEnded();
      avplay.play();
    } });
    avplay.play();
    // The ad on screen, with what identifies it: the tag requested and the VAST ids the app read.
    sdk.setBreakAd({ tagUrl: answer.ad_tag_url, adId: ad.adId, creativeId: ad.creativeId });
  }, 500);
}

(config.mode === 'host' ? hostMode() : loadMode()).catch((error) => log('error: ' + error.message));

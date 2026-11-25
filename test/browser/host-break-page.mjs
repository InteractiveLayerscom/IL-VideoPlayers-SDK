// A page whose own ad player plays the breaks it got from IL's per-break API (host plan, cuts: []): it reports the
// break and the ad to the SDK, which asks IL's break card with cut=at-<ms> and draws Buy itself.
import { attachHtmlVideo } from '/web/index.mjs';
import { attachAds } from '/web/ads.mjs';

// The shared fixtures name IL's test console http://localhost:8000; the SDK only takes HTTPS, so the page serves the
// same bodies as if they came from an HTTPS console.
const CONSOLE = 'https://console.test';
const load = async (name) => JSON.parse((await (await fetch(`/test/fixtures/native/${name}`)).text()).replaceAll('http://localhost:8000', CONSOLE));
const plan = await load('host-plan.json');
const card = await load('break-product-card.json');
const stable = await load('break-request-stable.json');
// The plan's expiry is frozen at the fixtures' clock; the page keeps it valid for the run.
plan.expires_at = new Date(Date.now() + 600000).toISOString();

const requests = [];
const fetchImpl = async (url) => {
  const target = new URL(String(url));
  requests.push(target.href);
  if (target.origin === CONSOLE && target.pathname === '/il-player/break-product') return { ok: true, status: 200, json: async () => card };
  if (target.origin === CONSOLE) return { ok: true, status: 204, json: async () => null };
  return { ok: true, status: 200, text: async () => '<VAST version="3.0"/>' };
};
const stage = document.querySelector('#stage');
const video = document.querySelector('#video');
const session = attachHtmlVideo({ video, stage, timeline: 'media', commerce: { locale: 'es' } });
const ads = attachAds({ session, video, stage, plan, fetchImpl, planOrigin: CONSOLE });
const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' &&
  el.getBoundingClientRect().width > 0;

window.harness = {
  requests,
  cuts: () => ads.cuts.length,
  breakStarted: (at) => ads.breakStarted(at),
  adStarted: () => ads.setBreakAd({ tagUrl: stable.ad_tag_url, adId: `il-shop-midroll-${card.id}`, creativeId: card.linearCreativeId }),
  adEnded: () => ads.clearBreakAd(),
  breakEnded: () => ads.breakEnded(),
  buy: () => [...stage.querySelectorAll('.il-commerce > button')].some(shown),
  playing: () => stage.classList.contains('il-ad-playing'),
};
window.harnessReady = true;

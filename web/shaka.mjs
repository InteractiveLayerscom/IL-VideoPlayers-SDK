import { createSession } from './session.mjs';
import { imageVisible, listenToVideo, nativeProgramTime } from './video.mjs';

function rect(x, y, width, height) {
  return { viewport: { x: 1920, y: 1080 }, topLeft: { x, y }, size: { x: width, y: height } };
}

export function asInterstitial(cue, programTime, mediaSeconds) {
  const l = cue.format === 'l';
  return {
    id: 'il/' + cue.id,
    groupId: null,
    startTime: mediaSeconds + (cue.start - programTime) / 1000,
    endTime: mediaSeconds + (cue.end - programTime) / 1000,
    uri: cue.imageUrl,
    mimeType: cue.mimeType,
    overlay: l ? rect(0, 0, 1920, 1080) : rect(240, 756, 1440, 216),
    currentVideo: l ? rect(0, 0, 1440, 810) : null,
    displayOnBackground: l,
    timelineRange: true,
    isSkippable: false,
    skipOffset: null,
    skipFor: null,
    canJump: true,
    resumeOffset: null,
    playoutLimit: null,
    once: false,
    pre: false,
    post: false,
    loop: false,
    background: null,
    clickThroughUrl: null,
    tracking: null,
  };
}

// Install after player.attach(video) and before player.load(). Unload the asset before teardown.
export function attachShaka({ player, clientContainer, serverContainer, programTime, ...source }) {
  const manager = player.getAdManager();
  if (
    typeof manager?.addCustomInterstitial !== 'function' ||
    !clientContainer ||
    !serverContainer
  ) {
    throw new Error('Shaka with interstitial ads and both ad containers is required');
  }
  const video = player.getMediaElement();
  const network = player.getNetworkingEngine();
  manager.setContainers(clientContainer, serverContainer);
  const submitted = new Set();
  let datedPlaylist = false;
  let desired = null;
  let muted = null;
  function ownsCurrent(cue) {
    return manager.getCurrentAd()?.getAdId() === 'il/' + cue.id;
  }
  function matchImage(url) {
    return Array.from(clientContainer.querySelectorAll('img')).find((el) => el.src === url);
  }
  // Shaka owns timing, placement, image teardown and the L transform. The CSS gate
  // suppresses just our graphic while paused, seeking, or in a stitched linear break.
  function mute(cue) {
    if (!cue || !ownsCurrent(cue)) return;
    const img = matchImage(cue.imageUrl);
    if (img) img.setAttribute('data-il-hold', '');
    if (cue.format === 'l') video.setAttribute('data-il-unsqueeze', '');
    muted = img || null;
  }
  function unmute() {
    muted?.removeAttribute('data-il-hold');
    video.removeAttribute('data-il-unsqueeze');
    muted = null;
  }
  let last;
  const renderer = {
    show(cue, time) {
      unmute();
      desired = last = cue;
      const ad = asInterstitial(cue, time, video.currentTime);
      if (!submitted.has(ad.id)) {
        submitted.add(ad.id);
        manager.addCustomInterstitial(ad);
      }
    },
    hide() {
      desired = null;
      mute(last);
    },
    visible(cue) {
      return ownsCurrent(cue) && imageVisible(matchImage(cue.imageUrl));
    },
    destroy() {
      unmute();
    },
  };
  const clock =
    programTime ??
    (() => {
      if (video.readyState < 2) return null;
      if (datedPlaylist) return player.getPlayheadTimeAsDate()?.getTime();
      return nativeProgramTime(video);
    });
  const session = createSession({
    ...source,
    clock,
    renderer,
    playing: () =>
      !video.paused &&
      !video.seeking &&
      !video.ended &&
      video.readyState >= 2 &&
      !video.ownerDocument.hidden &&
      !manager.getCurrentAd()?.isLinear(),
  });
  const filter = (type, response) => {
    // Shaka NetworkingEngine.RequestType.MANIFEST is 0.
    if (type !== 0 || !response.data) return;
    const bytes = new Uint8Array(response.data);
    if (bytes[0] !== 35) return;
    const playlist = new TextDecoder().decode(bytes);
    if (playlist.includes('#EXT-X-PROGRAM-DATE-TIME:')) datedPlaylist = true;
    session.updateManifest(playlist);
  };
  network.registerResponseFilter(filter);
  const sync = () => {
    session.tick();
    if (!desired) mute(last);
  };
  const onStarted = () => {
    queueMicrotask(sync);
  };
  manager.addEventListener('ad-started', onStarted);
  manager.addEventListener('ad-stopped', unmute);
  const unlisten = listenToVideo(video, sync);
  return {
    ...session,
    destroy() {
      unlisten();
      manager.removeEventListener('ad-started', onStarted);
      manager.removeEventListener('ad-stopped', unmute);
      network.unregisterResponseFilter(filter);
      session.destroy();
    },
  };
}

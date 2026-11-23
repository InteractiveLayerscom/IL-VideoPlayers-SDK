import { applySafeArea, commerceSurface, withinHold } from './commerce.mjs';
import { pauseOnOpen } from './dom.mjs';
import { sceneRenderer, sceneSupported, sceneFeatures } from './scene.mjs';
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
    overlay: l ? rect(0, 0, 1920, 1080) : cue.format === 'overlay'
      ? rect(1229, 108, 576, 346) : rect(240, 756, 1440, 216),
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
export function attachShaka({ player, clientContainer, serverContainer, programTime, stage = clientContainer?.parentElement, ...source }) {
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
  const sceneStage = stage ?? clientContainer;
  if (source.commerce) applySafeArea(sceneStage, source.insets, () => (video.controls ? 48 : 0));
  const pausing = source.commerce?.pauseOnOpen === true ? pauseOnOpen(video) : undefined;
  const commerce = commerceSurface(sceneStage, source.commerce, source.fetchImpl, pausing, () => clock());
  // timeline: 'media' is a video on demand, whose plan and cards are in the video's own time.
  const clock = programTime ?? (source.timeline === 'media' ? () => Math.round(video.currentTime * 1000) : () => {
    if (video.readyState < 2) return null;
    if (datedPlaylist) return player.getPlayheadTimeAsDate()?.getTime();
    return nativeProgramTime(video);
  });
  const presenting = () => !video.seeking && !video.ended && video.readyState >= 2 &&
    !video.ownerDocument.hidden && !manager.getCurrentAd()?.isLinear();
  const playing = () => presenting() && !video.paused;
  const properties = {
    position: 'absolute', left: '0', top: '0', right: 'auto', bottom: 'auto', width: '75%', height: '75%',
  };
  let original;
  const allowVideo = source.secondaryVideo ?? true;
  const allowAudio = allowVideo && source.secondaryVideoAudio === true;
  const window = sceneStage.ownerDocument.defaultView;
  const scenes = sceneRenderer(sceneStage, commerce, {
    clock, moving: playing, tv: Boolean(source.commerce?.tv),
    allowVideo, allowAudio, animate: source.interval !== false,
    squeeze(shrink) {
      if (shrink) {
        original ??= Object.keys(properties).map(key => [
          key, video.style.getPropertyValue(key), video.style.getPropertyPriority(key),
        ]);
        Object.assign(video.style, properties);
      } else if (original) {
        for (const [key, value, priority] of original) video.style.setProperty(key, value, priority);
        original = null;
      }
      return true;
    },
  });
  let last, isActive;
  const renderer = {
    show(cue, time, stillActive) {
      isActive = stillActive;
      unmute();
      desired = cue;
      if (cue.format === 'midroll') { commerce.show(cue, stillActive); return; }
      if (cue.scene) {
        scenes.show(cue, time, stillActive);
        return;
      }
      last = cue;
      const ad = asInterstitial(cue, time, video.currentTime);
      if (!submitted.has(ad.id)) {
        submitted.add(ad.id);
        manager.addCustomInterstitial(ad);
      }
    },
    hide() {
      scenes.hide();
      commerce.hide();
      if (!desired?.scene) mute(last);
      desired = null;
    },
    update: scenes.update,
    applyAudioPermissions: scenes.applyAudioPermissions,
    holding: cue => commerce.isOpen(cue) && withinHold(cue, clock(), commerce.lastAction(cue)),
    visible(cue) {
      if (cue.scene) return scenes.visible();
      const visible = ownsCurrent(cue) && imageVisible(matchImage(cue.imageUrl));
      if (visible) commerce.show(cue, isActive);
      return visible;
    },
    destroy() {
      scenes.hide();
      commerce.hide();
      unmute();
    },
  };
  const session = createSession({
    ...source, clock, renderer, playing, presenting,
    presentingCard: () => !video.ended && !video.seeking && video.readyState >= 2 && !manager.getCurrentAd()?.isLinear(),
    presentingSpot: () => !video.seeking && !video.ended && !video.ownerDocument.hidden,
    scenes: sceneSupported(window),
    sceneFeatures: sceneFeatures(window, allowVideo, allowAudio),
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
    // The ads module asks for scene products only when this session renders commerce.
    commerce: commerce.enabled ? source.commerce : undefined,
    destroy() {
      unlisten();
      pausing?.dispose();
      manager.removeEventListener('ad-started', onStarted);
      manager.removeEventListener('ad-stopped', unmute);
      network.unregisterResponseFilter(filter);
      session.destroy();
    },
  };
}

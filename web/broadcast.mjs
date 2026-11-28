import { bandRenderer } from './bands.mjs';
import { commerceSurface } from './commerce.mjs';
import { normalizeCue } from './cues.mjs';
import { sceneFeatures, sceneRenderer, sceneSupported } from './scene.mjs';
import { createSession } from './session.mjs';

// A page with no <video> (a vMix Browser Input, an OBS browser source): the program is always «playing» and the graphics
// are only ever overlaid, never squeezed. The host pushes the cues with setCues(); each call replaces the whole set.
// `hidden` defaults to «never»: some of those browsers report the page as hidden while it is on air.
export function attachBroadcast({ stage, clock = () => Date.now(), onVisible, hidden = () => false, interval }) {
  if (!stage?.ownerDocument) throw new Error('Provide the stage element that covers the broadcast frame');
  const win = stage.ownerDocument.defaultView;
  const commerce = commerceSurface(stage, undefined);
  const scenes = sceneRenderer(stage, commerce, {
    squeeze: () => false, clock, moving: () => true, tv: false, allowVideo: true, allowAudio: false, animate: true, hidden,
  });
  const bands = bandRenderer(stage, commerce, { squeeze: () => false, hidden });
  const always = () => true;
  const session = createSession({
    clock, playing: always, presenting: always, scenes: sceneSupported(win),
    sceneFeatures: sceneFeatures(win, true, false), interval, onVisible,
    renderer: {
      show(cue, time, stillActive, onClick) {
        if (cue.scene) scenes.show(cue, time, stillActive);
        else bands.show(cue, stillActive, onClick);
      },
      hide() {
        scenes.hide();
        bands.hide();
      },
      update: scenes.update,
      applyAudioPermissions: scenes.applyAudioPermissions,
      visible: cue => (cue.scene ? scenes.visible() : bands.visible()),
      detached: () => !stage.isConnected,
      destroy() {
        scenes.hide();
        bands.hide();
        commerce.retire();
      },
    },
  });
  return {
    // Replaces every cue (Unix ms times, the shape of normalizeCue). An `l` without a scene needs the video to be
    // squeezed, so it is ignored; an `l` scene is drawn as an overlay.
    setCues(list) {
      const usable = (Array.isArray(list) ? list : []).map(normalizeCue).filter(Boolean).flatMap(cue => {
        if (cue.format !== 'l') return [cue];
        return cue.scene ? [{ ...cue, layout: 'overlay' }] : [];
      });
      return session.setCues(usable);
    },
    destroy: session.destroy,
  };
}

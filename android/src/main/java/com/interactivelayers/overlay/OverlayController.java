package com.interactivelayers.overlay;

import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.hls.HlsManifest;
import androidx.media3.ui.PlayerView;
import java.io.IOException;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Presents IL graphics on the existing Media3 player. All public methods run on the main thread. */
@UnstableApi
public final class OverlayController implements AutoCloseable, Player.Listener, View.OnAttachStateChangeListener {
    /** Optional predicate for apps that expose stitched ad breaks on the program timeline. */
    public interface LinearAdDetector { boolean isLinearAd(long programTimeMs); }

    private final PlayerView view;
    private final Player player;
    private final String sidecar;
    private final String sessionId;
    private final String commerceLocale;
    private final String commerceCountry;
    private final Boolean television;
    private final OverlayNetwork network = new OverlayNetwork();
    private final ExecutorService workers = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable pulse = this::update;
    private final Timeline.Window window = new Timeline.Window();
    private final Rect visibleBounds = new Rect();
    private final Map<String, OverlayCue> cues = new LinkedHashMap<>();
    private final Set<String> measured = new HashSet<>();
    private final OverlayLayer layer;
    private final Set<String> viewed = new HashSet<>();
    private CommercePanel commercePanel;
    private SceneViews scene;
    private OverlayCue active;
    private Object lastManifest;
    private Future<?> polling;
    private Future<?> imageRequest;
    private long nextPoll;
    private long pollGeneration;
    private long imageGeneration;
    private boolean enabled = true;
    private boolean closed;
    private boolean linearAd;
    private String midrollCreativeId, midrollDeliveryId;
    private boolean secondaryVideo, secondaryVideoAudio;
    private LinearAdDetector adDetector;

    /** Reads overlay DATERANGEs from the HLS media playlist already loaded by the player. */
    public static OverlayController attach(PlayerView view) {
        return new OverlayController(view, null, null, null, null, null);
    }

    /** Uses the session JSON endpoint as the source of graphics. A null ID generates a session UUID. */
    public static OverlayController attach(PlayerView view, String sidecarUrl, String sessionId) {
        return new OverlayController(view, sidecarUrl, sessionId, null, null, null);
    }

    /** Enables Shopify product offers on the session feed. Null television uses device detection. */
    public static OverlayController attachCommerce(PlayerView view, String sidecarUrl, String sessionId,
                                                   String locale, String country, Boolean television) {
        if (!OverlayCue.isHttps(sidecarUrl)) throw new IllegalArgumentException("Expected an HTTPS sidecar URL");
        return new OverlayController(view, sidecarUrl, sessionId, locale == null ? "en" : locale,
                country, television);
    }

    private OverlayController(PlayerView view, String sidecarUrl, String sessionId, String commerceLocale,
                              String commerceCountry, Boolean television) {
        checkMainThread();
        this.view = view;
        this.player = view.getPlayer();
        if (player == null || player.getApplicationLooper() != Looper.getMainLooper()) {
            throw new IllegalArgumentException("Set a main-thread Media3 Player on the PlayerView before attaching");
        }
        if (sidecarUrl != null && !OverlayCue.isHttps(sidecarUrl)) {
            throw new IllegalArgumentException("Expected an absolute HTTPS sidecar URL");
        }
        if (view.getTag(R.id.il_overlay_controller) != null) {
            throw new IllegalStateException("Close the previous overlay controller before attaching again");
        }
        this.sidecar = sidecarUrl;
        this.commerceLocale = commerceLocale;
        this.commerceCountry = commerceCountry != null && commerceCountry.matches("[A-Z]{2}") ?
                commerceCountry : null;
        this.television = television;
        this.sessionId = sessionId == null ? UUID.randomUUID().toString() : sessionId;
        layer = new OverlayLayer(view, this::measure);
        view.setTag(R.id.il_overlay_controller, this);
        view.addOnAttachStateChangeListener(this);
        player.addListener(this);
        update();
    }

    /** Suspends graphics and restores the original layout. Media playback remains owned by the app. */
    public void stop() {
        checkMainThread();
        enabled = false;
        update();
    }

    public void start() {
        checkMainThread();
        if (!closed) {
            enabled = true;
            update();
        }
    }

    /** Call from the start/end callbacks of your stitched linear ad integration. */
    public void setLinearAdActive(boolean active) {
        setLinearAdActive(active, null, null);
    }

    /** Associates a playing VAST creative and its impression delivery with an opted-in shop. */
    public void setLinearAdActive(boolean active, String creativeId, String deliveryId) {
        checkMainThread();
        boolean shop = active && commerceLocale != null && OverlayCue.validIdentity(creativeId) && OverlayCue.validIdentity(deliveryId);
        String creative = shop ? creativeId : null, delivery = shop ? deliveryId : null;
        if (linearAd != active || !java.util.Objects.equals(creative, midrollCreativeId)
                || !java.util.Objects.equals(delivery, midrollDeliveryId)) {
            cancelPoll();
            if (sidecar != null) cues.clear();
            clearActive();
        }
        linearAd = active;
        midrollCreativeId = creative;
        midrollDeliveryId = delivery;
        update();
    }

    /** Enables scene videos on devices with a second available decoder. */
    public void setSceneSecondaryVideoEnabled(boolean enabled) {
        checkMainThread();
        if (closed || secondaryVideo == enabled) return;
        secondaryVideo = enabled;
        renewSceneCapabilities();
    }

    /** Enables sound for authorized scene videos. The host must also enable secondary video. */
    public void setSceneSecondaryVideoAudioEnabled(boolean enabled) {
        checkMainThread();
        if (closed || secondaryVideoAudio == enabled) return;
        secondaryVideoAudio = enabled;
        renewSceneCapabilities();
    }

    private void renewSceneCapabilities() {
        if (sidecar != null) {
            cancelPoll();
            cues.clear();
        }
        if (scene != null) clearActive();
        update();
    }

    public void setLinearAdDetector(LinearAdDetector detector) {
        checkMainThread();
        adDetector = detector;
        update();
    }

    /** Gives the product panel first refusal of Back while retaining the host's fallback. */
    public boolean closeCommercePanel() {
        checkMainThread();
        return commercePanel != null && commercePanel.closeDetails();
    }

    @Override public void close() {
        checkMainThread();
        if (closed) return;
        stop();
        closed = true;
        player.removeListener(this);
        view.removeOnAttachStateChangeListener(this);
        view.setTag(R.id.il_overlay_controller, null);
        layer.remove();
        cues.clear();
        measured.clear();
        viewed.clear();
        lastManifest = null;
        adDetector = null;
        workers.shutdownNow();
    }

    @Override public void onViewAttachedToWindow(View v) { update(); }
    @Override public void onViewDetachedFromWindow(View v) {
        main.removeCallbacks(pulse);
        suspendRendering();
    }

    @Override public void onEvents(Player player, Player.Events events) {
        if (events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION)) {
            cues.clear();
            lastManifest = null;
            clearActive();
            cancelPoll();
        } else if (sidecar != null && events.contains(Player.EVENT_POSITION_DISCONTINUITY)) {
            cues.clear();
            clearActive();
            cancelPoll();
        }
        update();
    }

    private static void checkMainThread() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            throw new IllegalStateException("Use OverlayController on the main thread");
        }
    }

    private long programTime() {
        if (!enabled || closed || view.getPlayer() != player || !view.isAttachedToWindow() || !view.hasWindowFocus()
                || !view.isShown() || view.getWindowVisibility() != View.VISIBLE
                || view.getAlpha() <= 0f || !view.getGlobalVisibleRect(visibleBounds)
                || ((linearAd || player.isPlayingAd()) && midrollCreativeId == null)
                || (!player.isPlaying() && (player.getPlayWhenReady() || player.getPlaybackState() != Player.STATE_READY))) return C.TIME_UNSET;
        Timeline timeline = player.getCurrentTimeline();
        if (timeline.isEmpty()) return C.TIME_UNSET;
        timeline.getWindow(player.getCurrentMediaItemIndex(), window);
        long position = player.getContentPosition();
        if (window.windowStartTimeMs == C.TIME_UNSET || position < 0) {
            return midrollCreativeId == null ? C.TIME_UNSET : System.currentTimeMillis();
        }
        long time = window.windowStartTimeMs + position;
        return midrollCreativeId == null && adDetector != null && adDetector.isLinearAd(time) ? C.TIME_UNSET : time;
    }

    private void update() {
        main.removeCallbacks(pulse);
        if (closed) return;
        long time = programTime();
        if (time == C.TIME_UNSET) {
            suspendRendering();
        } else {
            if (sidecar == null) readManifest();
            else if (player.isPlaying() && polling == null && SystemClock.elapsedRealtime() >= nextPoll) poll(time);
            OverlayCue cue = OverlayCue.at(cues.values(), time);
            if (!player.isPlaying() && (cue == null || (cue.scene == null && cue.linearCreativeId == null))) {
                suspendRendering();
            } else {
                present(cue, time);
            }
            measure();
        }
        if (enabled && view.isAttachedToWindow()) main.postDelayed(pulse, scene != null ? 32 : 200);
    }

    private void readManifest() {
        Object manifest = player.getCurrentManifest();
        if (manifest == lastManifest) return;
        lastManifest = manifest;
        if (!(manifest instanceof HlsManifest)) {
            cues.clear();
            return;
        }
        for (OverlayCue cue : OverlayCue.fromTags(((HlsManifest) manifest).mediaPlaylist.tags)) {
            cues.put(cue.id, cue);
        }
        // Keep playable DVR cues across playlist refreshes, including updates that omit a tag.
        Iterator<OverlayCue> history = cues.values().iterator();
        while (history.hasNext()) {
            if (history.next().end <= window.windowStartTimeMs) history.remove();
        }
    }

    private void poll(long timeMs) {
        long request = ++pollGeneration;
        boolean video = secondaryVideo, audio = secondaryVideoAudio;
        String creative = midrollCreativeId, delivery = midrollDeliveryId;
        polling = workers.submit(() -> {
            List<OverlayCue> result;
            try {
                result = network.windows(sidecar, sessionId, timeMs, commerceLocale, commerceCountry, video, audio, creative, delivery);
            } catch (IOException e) {
                result = Collections.emptyList();
            }
            List<OverlayCue> response = result;
            main.post(() -> {
                if (request != pollGeneration || closed) return;
                polling = null;
                nextPoll = SystemClock.elapsedRealtime() + 750;
                cues.clear();
                for (OverlayCue cue : response) {
                    if (creative != null && !(creative.equals(cue.linearCreativeId) && delivery.equals(cue.id))) continue;
                    if (creative == null && cue.linearCreativeId != null) continue;
                    if (commerceLocale != null || cue.commerce == null || cue.scene != null) cues.put(cue.id, cue);
                }
                update();
            });
        });
    }

    private void cancelPoll() {
        pollGeneration++;
        if (polling != null) polling.cancel(true);
        polling = null;
        nextPoll = 0;
    }

    private void suspendRendering() {
        if (sidecar != null) {
            if (polling != null || nextPoll != 0) cancelPoll();
            cues.clear();
        }
        clearActive();
    }

    private void present(OverlayCue cue, long time) {
        if (active != null && cue != null && active.id.equals(cue.id)
                && java.util.Objects.equals(active.imageUrl, cue.imageUrl) && active.format.equals(cue.format)
                && (active.scene == null) == (cue.scene == null)
                && java.util.Objects.equals(active.mimeType, cue.mimeType)) {
            if (active != cue && scene != null && secondaryVideoAudio) scene.applyAudioPermissions(cue.scene);
            active = cue;
            updateScene(time);
            return;
        }
        clearActive();
        if (cue == null) return;
        active = cue;
        if (cue.linearCreativeId != null) {
            commercePanel = new CommercePanel(layer.container(), cue, null, network, workers, television, () -> markOpened(cue));
            return;
        }
        if (cue.scene != null) {
            scene = new SceneViews(layer.container(), cue, network, workers, isTelevision(), secondaryVideo,
                    secondaryVideoAudio, this::measure,
                    commerceLocale != null ? (offer, focus) -> openOffer(cue, offer, focus) : null);
            updateScene(time);
            return;
        }
        long request = ++imageGeneration;
        imageRequest = workers.submit(() -> {
            Bitmap image = null;
            try {
                image = network.image(cue);
            } catch (IOException ignored) {
                // An unavailable image is never presented or measured.
            }
            Bitmap loaded = image;
            main.post(() -> {
                if (request != imageGeneration || closed) return;
                imageRequest = null;
                if (loaded != null && currentCueIsActive()) {
                    layer.show(active, loaded);
                    if (active.commerce != null) {
                        OverlayCue offer = active;
                        commercePanel = new CommercePanel(layer.container(), offer, loaded, network,
                                workers, television, () -> markOpened(offer));
                    }
                }
            });
        });
    }

    private void clearActive() {
        if (active == null) return;
        imageGeneration++;
        if (imageRequest != null) imageRequest.cancel(true);
        imageRequest = null;
        active = null;
        if (commercePanel != null) commercePanel.dispose();
        commercePanel = null;
        if (scene != null) scene.dispose();
        scene = null;
        layer.clear();
    }

    private boolean currentCueIsActive() {
        if (active == null) return false;
        long time = programTime();
        OverlayCue selected = time == C.TIME_UNSET ? null : OverlayCue.at(cues.values(), time);
        return selected != null && active.id.equals(selected.id);
    }

    private boolean isTelevision() {
        return television != null ? television :
                (view.getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_TYPE_MASK)
                    == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION
                || view.getContext().getPackageManager().hasSystemFeature("android.software.leanback")
                || view.getContext().getPackageManager().hasSystemFeature("android.hardware.type.television");
    }

    private void updateScene(long time) {
        if (scene == null) return;
        scene.update(time - active.start, player.isPlaying());
        layer.squeezeForScene(scene.ready() && "l".equals(active.format) && !"overlay".equals(active.layout));
    }

    private void openOffer(OverlayCue cue, OverlayScene.Offer offer, View focus) {
        if (!currentCueIsActive()) return;
        if (commercePanel != null) commercePanel.dispose();
        commercePanel = new CommercePanel(layer.container(), offer.commerce, null, offer.imageUrl, cue.brand,
                network, workers, television, () -> markOpened(cue.id, offer.id, offer.commerce.viewUrl), () -> {
                    commercePanel.dispose();
                    commercePanel = null;
                    if (focus.isShown()) focus.requestFocus();
                });
    }

    private void markOpened(OverlayCue cue) { markOpened(cue.id, "", cue.commerce.viewUrl); }

    private void markOpened(String cueId, String productId, String url) {
        if (url == null || !viewed.add(cueId + "\u0000" + productId)) return;
        workers.execute(() -> {
            try { network.impression(url); } catch (IOException ignored) {}
        });
    }

    private void measure() {
        if (active == null || active.impressionUrl == null || measured.contains(active.id)
                || !(scene != null ? scene.isDrawnAndVisible() : layer.isDrawnAndVisible()) || !currentCueIsActive()) return;
        String url = active.impressionUrl;
        measured.add(active.id);
        workers.execute(() -> {
            try { network.impression(url); } catch (IOException ignored) {}
        });
    }
}

package com.interactivelayers.overlay;

import android.app.ActivityManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Plays IL's ad plan on the app's Media3 player: ordered requests per break, graphics, Overlay and scene
 * products. Breaks use Google IMA on an ExoPlayer, and progressive MP4 on the same player when IMA cannot run.
 */
public final class AdPlanPlayer implements AutoCloseable, Player.Listener, AdPlanDriver.Host {
    /** Diagnostics. {@code id} is the break or the window. */
    public interface Events { void onAdEvent(String type, String format, String id); }

    private final OverlayController overlay;
    private final Player player;
    private final Events events;
    private final AdPlanIma ima;
    private final boolean ownsIma;
    private final AdPlanDisplay display;
    private final OverlayNetwork network = new OverlayNetwork();
    private final ExecutorService workers = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AdPlanDriver driver;
    private final List<MediaItem> content = new ArrayList<>();
    private int contentIndex;
    private boolean closed;

    /**
     * Null when the plan is unusable: the player then runs with no ads. Breaks use IMA when the app ships
     * {@code media3-exoplayer-ima} and the player is an ExoPlayer, with a plain {@code DefaultMediaSourceFactory}:
     * an app whose content needs headers or DRM passes its own {@link AdPlanIma} to the other {@code attach}.
     */
    public static AdPlanPlayer attach(OverlayController overlay, Player player, String planJson, String planOrigin,
                                      String sessionId, String locale, Events events) {
        AdPlan plan = read(overlay, planJson, planOrigin, sessionId);
        if (plan == null) return null;
        AdPlanIma ima = defaultIma(overlay.playerView(), player);
        return new AdPlanPlayer(overlay, player, plan, locale, ima, ima != null, null, events);
    }

    /** {@code ima} is the app's own engine, or null for MP4 only. {@code display} shows the Overlay, or null for none. */
    public static AdPlanPlayer attach(OverlayController overlay, Player player, String planJson, String planOrigin,
                                      String sessionId, String locale, AdPlanIma ima, AdPlanDisplay display, Events events) {
        AdPlan plan = read(overlay, planJson, planOrigin, sessionId);
        return plan == null ? null : new AdPlanPlayer(overlay, player, plan, locale, ima, false, display, events);
    }

    private static AdPlan read(OverlayController overlay, String planJson, String planOrigin, String sessionId) {
        // The IAB keys a consent platform writes to the app's default SharedPreferences.
        Context app = overlay.playerView().getContext().getApplicationContext();
        SharedPreferences stored = app.getSharedPreferences(app.getPackageName() + "_preferences", Context.MODE_PRIVATE);
        AdPlan.consent = stored::getAll;
        return AdPlan.read(planJson, System.currentTimeMillis(), planOrigin, sessionId);
    }

    private static AdPlanIma defaultIma(PlayerView view, Player player) {
        if (!(player instanceof ExoPlayer)) return null;
        try {
            Class.forName("androidx.media3.exoplayer.ima.ImaAdsLoader");
        } catch (ClassNotFoundException e) {
            Log.w("AdPlanPlayer", "media3-exoplayer-ima is not in the app: breaks play progressive MP4 only");
            return null;
        }
        try {
            return new AdPlanIma(view.getContext(), view);
        } catch (RuntimeException | LinkageError e) {
            return null;
        }
    }

    private AdPlanPlayer(OverlayController overlay, Player player, AdPlan plan, String locale, AdPlanIma ima,
                         boolean ownsIma, AdPlanDisplay display, Events events) {
        this.overlay = overlay;
        this.player = player;
        this.ima = ima;
        this.ownsIma = ownsIma;
        this.display = display;
        this.events = events;
        driver = new AdPlanDriver(this, plan, locale);
        overlay.useContentClock(driver::cueVisible);
        player.addListener(this);
    }

    /** Call before playing content. {@code ready} runs once the host may play it. */
    public void start(Runnable ready) { driver.start(ready); }

    @Override public void onIsPlayingChanged(boolean isPlaying) {
        if (isPlaying) driver.adPlaying();
    }

    @Override public void onPlaybackStateChanged(int state) {
        if (state == Player.STATE_ENDED) driver.adEnded();
    }

    @Override public void onPlayerError(PlaybackException error) { driver.adFailed(); }

    @Override public void close() {
        if (closed) return;
        driver.close();
        closed = true;
        main.removeCallbacksAndMessages(null);
        player.removeListener(this);
        overlay.useContentClock(null);
        if (ownsIma) ima.close();
        workers.shutdownNow();
    }

    @Override public long contentPositionMs() { return player.getContentPosition(); }
    @Override public boolean contentPlaying() { return player.isPlaying() && !player.isPlayingAd(); }
    @Override public boolean playWhenReady() { return player.getPlayWhenReady(); }
    @Override public void play() { player.play(); }
    @Override public void pause() { player.pause(); }

    // The app's whole playlist and where it was, each item without the ad tag of an earlier IMA break.
    @Override public void captureContent() {
        content.clear();
        for (int i = 0; i < player.getMediaItemCount(); i++) {
            content.add(player.getMediaItemAt(i).buildUpon().setAdsConfiguration(null).build());
        }
        contentIndex = Math.max(0, player.getCurrentMediaItemIndex());
    }

    @Override public void restoreContent(long positionMs) {
        if (content.isEmpty()) return;
        player.setMediaItems(content, Math.min(contentIndex, content.size() - 1), positionMs);
        player.prepare();
    }

    @Override public long clockMs() { return android.os.SystemClock.elapsedRealtime(); }

    // Foreground or visible: time spent in the background does not run down the break watchdog.
    @Override public boolean appActive() {
        ActivityManager.RunningAppProcessInfo state = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(state);
        return state.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE;
    }

    @Override public void playMp4(String url) {
        player.setMediaItem(MediaItem.fromUri(url));
        player.prepare();
        player.play();
    }

    @Override public long adPositionMs() { return player.getCurrentPosition(); }

    @Override public boolean playIma(String tag, String adsResponse, long positionMs, AdPlanDriver.ImaCallback callback) {
        if (ima == null || content.isEmpty() || !(player instanceof ExoPlayer)) return false;
        try {
            ima.play((ExoPlayer) player, content.get(Math.min(contentIndex, content.size() - 1)), tag, adsResponse, positionMs, callback);
            return true;
        } catch (RuntimeException | LinkageError e) {
            return false;
        }
    }

    @Override public void cancelIma() {
        if (ima != null) ima.cancel();
    }

    @Override public void later(Runnable task, long delayMs) { main.postDelayed(task, delayMs); }
    @Override public void cancel(Runnable task) { main.removeCallbacks(task); }
    @Override public void background(Runnable task) {
        if (!workers.isShutdown()) workers.execute(task);
    }
    @Override public void foreground(Runnable task) { main.post(task); }
    @Override public void setLinear(boolean active, String creativeId, String deliveryId) {
        overlay.setLinearAdActive(active, creativeId, deliveryId);
    }
    @Override public void setCues(List<OverlayCue> cues) { overlay.setPlanCues(cues); }
    @Override public String fetch(String url) throws IOException { return network.text(url); }
    @Override public void ping(String url) {
        try {
            network.impression(url);
        } catch (IOException ignored) {
            // A failed pixel never affects playback.
        }
    }
    @Override public void event(String type, String format, String id) {
        if (events != null) events.onAdEvent(type, format, id);
    }
    @Override public AdPlanDisplay display() { return display; }
    @Override public boolean displayFits() {
        if (display == null || !display.supported()) return false;
        PlayerView view = overlay.playerView();
        float density = view.getResources().getDisplayMetrics().density;
        return view.getWidth() / density >= 640 && view.getHeight() / density >= 360;
    }
}

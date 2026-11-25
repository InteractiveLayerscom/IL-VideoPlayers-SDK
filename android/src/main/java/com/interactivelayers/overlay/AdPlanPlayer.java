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
    private final String planOrigin, sessionId, locale;
    private AdPlanDriver driver;
    private final List<MediaItem> content = new ArrayList<>();
    private int contentIndex;
    private boolean closed;
    // load(): the plan is still on its way. start() waits for it, never longer than AdPlanLoader.LOAD_TIMEOUT_MS.
    private AdPlanLoader loader;
    private boolean loading, startCalled;
    private Runnable pendingReady;
    private final Runnable loadTimedOut = () -> loadFinished(null, 0, "timeout");
    // Host-driven state reported before the plan arrived, applied when it does.
    private long[] hostBreaks;
    private Long hostBreakAt;

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
        AdPlanPlayer out = new AdPlanPlayer(overlay, player, planOrigin, sessionId, locale, ima, ima != null, null, events);
        out.use(plan);
        return out;
    }

    /** {@code ima} is the app's own engine, or null for MP4 only. {@code display} shows the Overlay, or null for none. */
    public static AdPlanPlayer attach(OverlayController overlay, Player player, String planJson, String planOrigin,
                                      String sessionId, String locale, AdPlanIma ima, AdPlanDisplay display, Events events) {
        AdPlan plan = read(overlay, planJson, planOrigin, sessionId);
        if (plan == null) return null;
        AdPlanPlayer out = new AdPlanPlayer(overlay, player, planOrigin, sessionId, locale, ima, false, display, events);
        out.use(plan);
        return out;
    }

    /**
     * Requests the plan from IL ({@code GET <origin>/il-player/app-plan}) with {@code app=android:<package name>},
     * off the main thread. Never null: call {@link #start} as with {@code attach}; the content waits for the plan at
     * most 5 s. Without a plan the content plays without ads and {@code events} gets one {@code plan_unavailable}:
     * {@code format} is the reason ({@code http_<status>} such as {@code http_204} or {@code http_404}, {@code timeout},
     * {@code network}, {@code app_id}, {@code request}, {@code stitched} or {@code invalid}) and {@code id} is
     * {@code "app=<value sent> status=<HTTP status, 0 without one>"}. A version 2 plan is renewed by itself 20 s before
     * it expires, retried at - 12 s and - 5 s ({@code plan_renewed} with the version, or one {@code plan_renew_failed} with the last reason); it stops
     * at expiry with {@code plan_expired}. After {@link #close()} a late answer attaches nothing. Call on the main thread.
     */
    public static AdPlanPlayer load(OverlayController overlay, Player player, String origin, String project, String asset,
                                    String sessionId, String locale, Events events) {
        AdPlanIma ima = defaultIma(overlay.playerView(), player);
        return load(overlay, player, origin, project, asset, sessionId, locale, ima, ima != null, null, events);
    }

    /** {@link #load} with the app's own IMA engine (or null for MP4 only) and Overlay slot (or null). */
    public static AdPlanPlayer load(OverlayController overlay, Player player, String origin, String project, String asset,
                                    String sessionId, String locale, AdPlanIma ima, AdPlanDisplay display, Events events) {
        return load(overlay, player, origin, project, asset, sessionId, locale, ima, false, display, events);
    }

    private static AdPlanPlayer load(OverlayController overlay, Player player, String origin, String project, String asset,
                                     String sessionId, String locale, AdPlanIma ima, boolean ownsIma, AdPlanDisplay display,
                                     Events events) {
        Context context = overlay.playerView().getContext();
        String app = AdPlanLoader.appId(context.getPackageName());
        AdPlanLoader loader = null;
        String refused = null;
        if (!AdPlanLoader.appAccepted(app)) {
            refused = "app_id";
        } else {
            try {
                loader = new AdPlanLoader(AdPlanLoader.HTTPS, origin, project, asset, app);
            } catch (IllegalArgumentException e) {
                refused = "request";
            }
        }
        AdPlanPlayer out = new AdPlanPlayer(overlay, player, loader == null ? null : loader.origin, sessionId, locale, ima,
                ownsIma, display, events);
        out.app = app;
        if (loader == null) {
            // Nothing is sent: the content plays without ads, and the host learns why, after load() has returned.
            String reason = refused;
            out.main.post(() -> {
                if (!out.closed) out.unavailable(0, reason);
            });
            return out;
        }
        out.loader = loader;
        out.loading = true;
        out.main.postDelayed(out.loadTimedOut, AdPlanLoader.LOAD_TIMEOUT_MS);
        out.requestPlan(null);
        return out;
    }

    private void requestPlan(String renewGrant) {
        background(() -> loader.fetch(renewGrant, new AdPlanLoader.Listener() {
            @Override public void loaded(String json) { main.post(() -> answered(json, 200, null, renewGrant != null)); }
            @Override public void unavailable(int status, String reason) {
                main.post(() -> answered(null, status, reason, renewGrant != null));
            }
        }));
    }

    private String app;

    /** {@code plan_unavailable}: {@code format} is the reason, {@code id} the exact {@code app=} value and the status. */
    private void unavailable(int status, String reason) {
        if (status == 404) Log.w("AdPlanPlayer", "IL answered 404 for the plan: check that app=" + app + " is registered in the console");
        event("plan_unavailable", reason, "app=" + app + " status=" + status);
    }

    private void answered(String json, int status, String reason, boolean renewal) {
        if (closed) return;
        if (renewal) {
            // A late answer (after expiry or close) is dropped; the driver decides retries and plan_renew_failed.
            if (driver == null) return;
            AdPlan plan = json == null ? null : read(overlay, json, planOrigin, sessionId);
            if (plan != null) {
                if (!driver.renewalPending()) return;
                current = plan;
                driver.renewed(plan);
            } else {
                driver.renewFailed(json != null ? AdPlanLoader.refusal(json) : reason, "app=" + app + " status=" + status);
            }
            return;
        }
        if (loading) loadFinished(json, status, reason);
    }

    private void loadFinished(String json, int status, String reason) {
        if (!loading || closed) return;
        loading = false;
        main.removeCallbacks(loadTimedOut);
        AdPlan plan = json == null ? null : read(overlay, json, planOrigin, sessionId);
        if (plan != null) use(plan);
        else unavailable(status, json != null ? AdPlanLoader.refusal(json) : reason);
        if (!startCalled) return;
        Runnable ready = pendingReady;
        pendingReady = null;
        if (driver != null) driver.start(ready);
        else if (ready != null) ready.run();
    }

    private void use(AdPlan plan) {
        current = plan;
        driver = new AdPlanDriver(this, plan, locale);
        // The IAB keys a consent platform writes to the app's default SharedPreferences. This reader's own consent and app identity: a second reader in the process does not overwrite them.
        Context app = overlay.playerView().getContext().getApplicationContext();
        SharedPreferences stored = app.getSharedPreferences(app.getPackageName() + "_preferences", Context.MODE_PRIVATE);
        driver.consent = stored::getAll;
        driver.appId = app.getPackageName();
        CharSequence label = app.getApplicationInfo().loadLabel(app.getPackageManager());
        driver.appName = label == null ? null : label.toString();
        overlay.useContentClock(driver::cueVisible);
        if (hostBreaks != null) driver.setBreaks(hostBreaks);
        if (hostBreakAt != null) driver.breakStarted(hostBreakAt);
        // The ad the app reported before the plan arrived, if it is still the one on screen.
        if (hostBreakAt != null && pendingAd != null) {
            if (pendingAd[2] != null) driver.hostAdStarted(pendingAd[0], pendingAd[2]);
            else driver.hostAdStarted(pendingAd[0], pendingAd[1], pendingAd[3]);
        }
        pendingAd = null;
    }

    // {tag, adId, vastXml, creativeId} of an ad reported before the plan attached; cleared by adEnded/breakEnded.
    private String[] pendingAd;

    private AdPlan current;

    // The driver times it (expires_at - 20 s); only a plan this player loaded itself is renewed here.
    @Override public void renew(String grant) {
        if (closed || loader == null) return;
        requestPlan(grant == null ? "" : grant);
    }

    /**
     * Swaps in a renewed plan of the same view (for example a version 2 plan before its {@code expires_at}): what
     * was already shown, attempted and settled, the pacing counts and the commerce session carry over, so nothing is
     * replayed or counted twice. False, and the current plan stays, when {@code planJson} is unusable.
     */
    public boolean replacePlan(String planJson) {
        if (closed) return false;
        AdPlan plan = read(overlay, planJson, planOrigin, sessionId);
        if (plan == null) return false;
        if (driver == null) {
            if (loading) {
                loadFinished(planJson, 200, null);
                return true;
            }
            use(plan);
            if (startCalled) driver.start(takeReady());
            return true;
        }
        // A plan with cuts while the app drives its own breaks is refused (break_refused, plan_has_cuts).
        if (!driver.replace(plan)) return false;
        current = plan;
        return true;
    }

    private Runnable takeReady() {
        Runnable ready = pendingReady;
        pendingReady = null;
        return ready;
    }

    /**
     * Host-driven mode: the content positions, in milliseconds, of the breaks the app will play itself. Scene
     * graphics keep the plan's clearance around them.
     */
    public void setBreaks(long[] atMs) {
        if (closed || atMs == null) return;
        hostBreaks = atMs.clone();
        if (driver != null) driver.setBreaks(hostBreaks);
    }

    /** Host-driven mode: the app's own break starts at this content position (0 for a pre-roll). */
    public void breakStarted(long atMs) {
        if (closed) return;
        hostBreakAt = atMs;
        if (driver != null) driver.breakStarted(atMs);
    }

    /**
     * Host-driven mode: an ad of the break is on screen. {@code adTagUrl} is the iADServer ad tag the app requested;
     * {@code adId} and {@code creativeId} are its VAST {@code Ad@id} and {@code Creative@id} (IMA's
     * {@code Ad.getAdId()} and {@code Ad.getCreativeId()}).
     */
    public void adStarted(String adTagUrl, String adId, String creativeId) {
        if (closed) return;
        if (driver != null) driver.hostAdStarted(adTagUrl, adId, creativeId);
        else queueAd(new String[] {adTagUrl, adId, null, creativeId});
    }

    // Before the plan: kept until it attaches, as breakStarted is; without an open break it is refused at once.
    private void queueAd(String[] ad) {
        if (hostBreakAt == null) {
            event("break_refused", "no_break", null);
            return;
        }
        pendingAd = ad;
    }

    /** Host-driven mode: as {@link #adStarted(String, String, String)}, from the raw VAST the app's player received. */
    public void adStarted(String adTagUrl, String vastXml) {
        if (closed) return;
        if (driver != null) driver.hostAdStarted(adTagUrl, vastXml);
        else queueAd(new String[] {adTagUrl, null, vastXml, null});
    }

    /** Host-driven mode: the ad ended (complete, skip or error). Its Buy button goes; an open product stays. */
    public void adEnded() {
        pendingAd = null;
        if (!closed && driver != null) driver.hostAdEnded();
    }

    /** Host-driven mode: the app's break is over and IL's graphics may come back. */
    public void breakEnded() {
        if (closed) return;
        hostBreakAt = null;
        pendingAd = null;
        if (driver != null) driver.breakEnded();
    }

    private static AdPlan read(OverlayController overlay, String planJson, String planOrigin, String sessionId) {
        // Consent and app identity are set per reader in use(); reading a plan needs neither.
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

    private AdPlanPlayer(OverlayController overlay, Player player, String planOrigin, String sessionId, String locale,
                         AdPlanIma ima, boolean ownsIma, AdPlanDisplay display, Events events) {
        this.overlay = overlay;
        this.player = player;
        this.planOrigin = planOrigin;
        this.sessionId = sessionId;
        this.locale = locale;
        this.ima = ima;
        this.ownsIma = ownsIma;
        this.display = display;
        this.events = events;
        player.addListener(this);
        owner = activityOf(overlay.playerView().getContext());
        application = (android.app.Application) overlay.playerView().getContext().getApplicationContext();
        application.registerActivityLifecycleCallbacks(lifecycle);
    }

    private final android.app.Activity owner;
    private final android.app.Application application;
    // Framework callbacks, no extra dependency: the pulse resumes when an activity starts, and the Activity that holds
    // the PlayerView being destroyed closes this player, so a host that forgot close() does not keep it alive.
    private final android.app.Application.ActivityLifecycleCallbacks lifecycle = new android.app.Application.ActivityLifecycleCallbacks() {
        @Override public void onActivityCreated(android.app.Activity a, android.os.Bundle b) { }
        @Override public void onActivityStarted(android.app.Activity a) { resumePulse(); }
        @Override public void onActivityResumed(android.app.Activity a) { resumePulse(); }
        @Override public void onActivityPaused(android.app.Activity a) { }
        @Override public void onActivityStopped(android.app.Activity a) { }
        @Override public void onActivitySaveInstanceState(android.app.Activity a, android.os.Bundle b) { }
        @Override public void onActivityDestroyed(android.app.Activity a) {
            if (a != owner || closed) return;
            // Closing is right (the view is gone and must not be kept), but never silently: after a configuration
            // change the app has to load or attach again with its new PlayerView.
            event("plan_closed", a.isChangingConfigurations() ? "configuration_change" : "activity_destroyed", null);
            close();
        }
    };

    private void resumePulse() {
        // Posted: the process importance appActive() reads is updated after the lifecycle callback.
        main.post(() -> {
            if (!closed && driver != null) driver.resume();
        });
    }

    private static android.app.Activity activityOf(Context context) {
        for (Context c = context; c instanceof android.content.ContextWrapper; c = ((android.content.ContextWrapper) c).getBaseContext()) {
            if (c instanceof android.app.Activity) return (android.app.Activity) c;
        }
        return null;
    }

    /** Whether close() ran (also by itself, when the Activity holding the PlayerView was destroyed). */
    boolean isClosed() { return closed; }

    /** Call before playing content. {@code ready} runs once the host may play it. */
    public void start(Runnable ready) {
        if (closed || startCalled) return;
        startCalled = true;
        if (driver != null) driver.start(ready);
        else if (loading) pendingReady = ready;
        else if (ready != null) ready.run();
    }

    @Override public void onIsPlayingChanged(boolean isPlaying) {
        if (isPlaying && driver != null) driver.adPlaying();
    }

    @Override public void onPlaybackStateChanged(int state) {
        if (state == Player.STATE_ENDED && driver != null) driver.adEnded();
    }

    @Override public void onPlayerError(PlaybackException error) {
        if (driver != null) driver.adFailed();
    }

    // A seek is one of the moments web checks a short-lived plan's expiry.
    @Override public void onPositionDiscontinuity(Player.PositionInfo oldPosition, Player.PositionInfo newPosition, int reason) {
        if (driver != null && reason == Player.DISCONTINUITY_REASON_SEEK) driver.checkExpired();
    }

    @Override public void close() {
        if (closed) return;
        if (driver != null) driver.close();
        closed = true;
        loading = false;
        pendingReady = null;
        main.removeCallbacksAndMessages(null);
        player.removeListener(this);
        if (driver != null) overlay.useContentClock(null);
        if (ownsIma) ima.close();
        workers.shutdownNow();
        application.unregisterActivityLifecycleCallbacks(lifecycle);
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
    @Override public long nowMs() { return System.currentTimeMillis(); }
    @Override public void setBreakCard(String creativeId, String deliveryId, OverlayCue card) {
        overlay.setPlanBreakCard(creativeId, deliveryId, card);
    }
    @Override public AdPlanDisplay display() { return display; }
    @Override public boolean displayFits() {
        if (display == null || !display.supported()) return false;
        PlayerView view = overlay.playerView();
        float density = view.getResources().getDisplayMetrics().density;
        return view.getWidth() / density >= 640 && view.getHeight() / density >= 360;
    }
}

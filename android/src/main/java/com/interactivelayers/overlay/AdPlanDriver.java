package com.interactivelayers.overlay;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** What the ad plan decides and when. {@link AdPlanPlayer} connects it to Media3, tests to fakes. */
final class AdPlanDriver {
    interface ImaCallback {
        void loaded();
        /** {@code durationMs} is the ad's own length, or 0 when IMA does not give one. */
        void started(long durationMs);
        void empty();
        void failed();
        void completed();
    }

    interface Host {
        long contentPositionMs();
        boolean contentPlaying();
        boolean playWhenReady();
        void play();
        void pause();
        void captureContent();
        void restoreContent(long positionMs);
        void playMp4(String url);
        long adPositionMs();
        /**
         * False when IMA cannot run here: the break uses the MP4 path. {@code adsResponse} is the VAST already fetched
         * for {@code tag}, handed to IMA so the same URL is not requested again, or null.
         */
        boolean playIma(String tag, String adsResponse, long positionMs, ImaCallback callback);
        /** Whether the app is in the foreground: the break watchdog does not count background time. */
        boolean appActive();
        /** A monotonic clock in milliseconds. */
        long clockMs();
        void cancelIma();
        void later(Runnable task, long delayMs);
        void cancel(Runnable task);
        void background(Runnable task);
        void foreground(Runnable task);
        void setLinear(boolean active, String creativeId, String deliveryId);
        void setCues(List<OverlayCue> cues);
        String fetch(String url) throws IOException;
        void ping(String url);
        void event(String type, String format, String id);
        AdPlanDisplay display();
        boolean displayFits();
        /** Wall-clock milliseconds: a version 2 plan expires at {@code expires_at}. */
        long nowMs();
        /**
         * Buy during a break from {@code commerce.break_url}: the ad's identity once it starts ({@code card} null),
         * then its card. The same drawing path as the session feed's midroll card.
         */
        void setBreakCard(String creativeId, String deliveryId, OverlayCue card);
        /** Time to ask for a renewed version 2 plan, with the current plan's grant (null without one). */
        void renew(String grant);
    }

    /** A host break with no report for this long (foreground) is treated as over: the app's ad player may have died. */
    static final long HOST_BREAK_GUARD_MS = 180000;  // the longest any one ad may hold the reader's own break

    private static final long TICK_MS = 250;
    private static final long HOLD_MS = 8000;
    private static final long DISPLAY_TIMEOUT_MS = 4000;
    private static final long BREAK_WATCHDOG_MS = 120000;
    // No ad holds the content longer than this, whatever its VAST declares.
    private static final long AD_CAP_MS = 180000;
    private static final int MAX_WRAPPERS = 3;
    private static final String OVERLAY = "overlay_300x250";

    private static final class Measure {
        final List<String> urls;
        final String format, window;
        Measure(List<String> urls, String format, String window) { this.urls = urls; this.format = format; this.window = window; }
    }

    private final Host host;
    private AdPlan plan;
    private AdPlan.Schedule schedule;
    private final String locale;
    private final Runnable pulse = this::tick;
    private final Runnable holdExpired = () -> {
        if (this.walk != null) this.walk.holdExpired();
    };
    private final Runnable displayExpired = () -> displayAnswered(this.displayRequest, null);
    private final List<OverlayCue> planCues = new ArrayList<>();
    private final Map<String, Measure> measures = new HashMap<>();
    private final Set<String> firedQuartiles = new HashSet<>();

    private boolean closed, closing, started, inBreak, graphicBusy, productBusy, adPlaying, adCounted, swapped, imaStarted, scrubbed;
    private long adToken;
    // Foreground time of the break, its limit (120 s, then the ad's duration plus 30 s) and the MP4 position last seen.
    private long breakElapsedMs, breakLimitMs, lastAdPositionMs, lastClockMs;
    private AdBreakWalk walk;
    private AdPlan.Cut cut;
    private AdPlan.LinearAd ad;
    private String adTag;
    private long resumeAt;
    private boolean resumePlay;
    private Runnable afterPreroll;
    private Object displayRequest;
    private AdPlan.Window displayLive;
    // A version 2 plan past expires_at: nothing more of it is used until a renewal replaces it.
    private boolean expired;
    // A break the host plays itself (host-driven mode), at this content position.
    private boolean hostBreak;
    private long hostBreakAtMs;
    private List<Long> hostBreaks;
    // Buy during a break: a token that outdates a late card, and whether the current ad has a shop identity.
    private long shopToken;
    private boolean shopSpot;
    private long hostBreakElapsedMs;
    private final Runnable renewTask = this::renewNow;

    // Renewal attempts at expires_at - 20 s, - 12 s and - 5 s; the next one only once the previous answer is in.
    private static final long[] RENEW_AHEAD_MS = {20000, 12000, 5000};
    private int renewAttempt;
    private boolean renewInFlight, renewFailedSaid;

    private void renewNow() {
        if (closed || expired || plan.version != 2) return;
        renewInFlight = true;
        host.renew(plan.grant);
    }

    /** Whether an answer to a renewal is still wanted: one is in flight, and the plan is neither closed nor expired. */
    boolean renewalPending() {
        return renewInFlight && !closed && !expired && host.nowMs() < plan.expiresAtMs;
    }

    /** A renewal answered with a usable plan: it replaces this one and the cycle restarts for it. */
    void renewed(AdPlan next) {
        if (!renewalPending()) return;
        renewInFlight = false;
        replace(next);
        emit("plan_renewed", Integer.toString(next.version), null);
    }

    /**
     * A renewal attempt failed: the next slot, at once if it was missed but is still before expiry. After the last
     * attempt, or once expires_at is reached, plan_renew_failed once with the last reason; the plan runs to expiry.
     */
    void renewFailed(String reason, String detail) {
        if (closed || !renewInFlight) return;
        renewInFlight = false;
        long now = host.nowMs();
        renewAttempt++;
        if (renewAttempt < RENEW_AHEAD_MS.length && now < plan.expiresAtMs && !expired) {
            host.later(renewTask, Math.max(0, plan.expiresAtMs - RENEW_AHEAD_MS[renewAttempt] - now));
            return;
        }
        if (!renewFailedSaid) {
            renewFailedSaid = true;
            emit("plan_renew_failed", reason, detail);
        }
    }

    AdPlanDriver(Host host, AdPlan plan, String locale) {
        this.host = host;
        this.plan = plan;
        this.schedule = plan.schedule();
        this.locale = locale == null ? "en" : locale;
    }

    void start(Runnable ready) {
        if (closed || started) return;
        started = true;
        host.later(pulse, TICK_MS);
        scheduleRenewal();
        // Web's sid rule: a host with its own session id gets no Buy during breaks. Said once rather than silently.
        if (plan.breakSessionMismatch) emit("buy_unavailable", "session", null);
        if (checkExpired()) {
            if (ready != null) ready.run();
            return;
        }
        AdPlan.Cut preroll = schedule.join(Math.max(0, host.contentPositionMs()));
        if (preroll == null) {
            if (ready != null) ready.run();
            return;
        }
        afterPreroll = ready;
        beginBreak(preroll);
    }

    private void emit(String type, String format, String id) {
        try {
            host.event(type, format, id);
        } catch (RuntimeException ignored) {
            // Diagnostics must never break playback.
        }
    }

    void tick() {
        if (closed) return;
        host.later(pulse, TICK_MS);
        if (checkExpired()) return;
        if (inBreak) {
            if (host.appActive()) breakElapsedMs += TICK_MS;
            if (breakElapsedMs >= breakLimitMs) {
                endBreak(false);
                return;
            }
            trackQuartiles();
            return;
        }
        // The host's own break: nothing of IL's is asked for or shown but the Buy button of its ad.
        if (hostBreak) {
            if (displayLive != null) host.display().setVisible(false);
            if (host.appActive()) hostBreakElapsedMs += TICK_MS;
            // Safety net: a break the app never ended must not keep graphics away for the rest of the view.
            if (hostBreakElapsedMs >= HOST_BREAK_GUARD_MS) endHostBreak("break_error");
            return;
        }
        if (!host.contentPlaying()) {
            if (displayLive != null) host.display().setVisible(false);
            return;
        }
        long now = host.contentPositionMs();
        AdPlan.Cut due = schedule.dueCut(now);
        if (due != null) {
            beginBreak(due);
            return;
        }
        dropEnded(now);
        updateDisplay(now);
        if (!productBusy && !productShowing()) {
            AdPlan.Window window = schedule.nextProduct(now);
            if (window != null) askProduct(window);
        }
        schedule.overlayAvailable = host.display() != null && host.displayFits();
        if (!graphicBusy && displayLive == null) {
            AdPlan.Window window = schedule.nextGraphic(now);
            if (window != null) askGraphic(window, now);
        }
    }

    private boolean productShowing() {
        for (OverlayCue cue : planCues) if (cue.commerce != null) return true;
        return false;
    }

    private void dropEnded(long now) {
        boolean changed = false;
        for (int i = planCues.size() - 1; i >= 0; i--) {
            if (now >= planCues.get(i).end) {
                planCues.remove(i);
                changed = true;
            }
        }
        if (changed) host.setCues(planCues);
    }

    private void updateDisplay(long now) {
        if (displayLive == null) return;
        if (now >= displayLive.end) {
            host.display().clear();
            displayLive = null;
            return;
        }
        host.display().setVisible(now >= displayLive.start);
    }

    private void askGraphic(AdPlan.Window window, long now) {
        AdPlan.Graphic graphic = schedule.graphicFor();
        schedule.attempted.add(window.id);
        schedule.pending.add(window);
        graphicBusy = true;
        emit("request", graphic.format, window.id);
        if (OVERLAY.equals(graphic.format)) {
            askDisplay(window, graphic);
            return;
        }
        String url = AdPlan.graphicTag(graphic.tagUrl, graphic.format, window.targeting, plan.page);
        long available = window.end - Math.max(window.start, now);
        host.background(() -> {
            AdPlan.GraphicAd answer;
            try {
                answer = AdPlan.parseGraphic(host.fetch(url), graphic.format, available);
            } catch (IOException e) {
                answer = null;
            }
            AdPlan.GraphicAd result = answer;
            host.foreground(() -> graphicAnswered(window, graphic, result));
        });
    }

    private void askDisplay(AdPlan.Window window, AdPlan.Graphic graphic) {
        Object request = new Object();
        displayRequest = request;
        pendingDisplay = window;
        Map<String, String> targeting = new LinkedHashMap<>();
        if (window.targeting != null) {
            Iterator<String> keys = window.targeting.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = window.targeting.opt(key);
                if (value instanceof JSONArray) {
                    List<String> parts = new ArrayList<>();
                    for (int i = 0; i < ((JSONArray) value).length(); i++) parts.add(String.valueOf(((JSONArray) value).opt(i)));
                    targeting.put(key, String.join(",", parts));
                } else {
                    targeting.put(key, String.valueOf(value));
                }
            }
        }
        targeting.put("il_format", OVERLAY);
        host.later(displayExpired, DISPLAY_TIMEOUT_MS);
        host.display().request(graphic.tagUrl, targeting, new AdPlanDisplay.Callback() {
            @Override public void filled() { displayAnswered(request, Boolean.TRUE); }
            @Override public void empty() { displayAnswered(request, Boolean.FALSE); }
            @Override public void impression() {
                if (!closed && displayLive == window && viewedDisplays.add(window.id)) emit("impression", OVERLAY, window.id);
            }
        });
    }

    private AdPlan.Window pendingDisplay;
    private final Set<String> viewedDisplays = new HashSet<>();

    // TRUE filled, FALSE empty, null timed out.
    private void displayAnswered(Object request, Boolean answer) {
        if (closed || request == null || request != displayRequest) return;
        if (checkExpired()) answer = null;
        displayRequest = null;
        host.cancel(displayExpired);
        AdPlan.Window window = pendingDisplay;
        pendingDisplay = null;
        schedule.pending.remove(window);
        graphicBusy = false;
        if (Boolean.TRUE.equals(answer) && !breakOn() && host.contentPositionMs() < window.end) {
            schedule.shown.add(window);
            displayLive = window;
            emit("fill", OVERLAY, window.id);
            updateDisplay(host.contentPositionMs());
            return;
        }
        host.display().clear();
        emit(answer == null ? "error" : "no_fill", OVERLAY, window.id);
    }

    private void graphicAnswered(AdPlan.Window window, AdPlan.Graphic graphic, AdPlan.GraphicAd answer) {
        if (closed) return;
        schedule.pending.remove(window);
        graphicBusy = false;
        if (checkExpired()) return;
        if (answer == null || breakOn()) {
            emit("error", graphic.format, window.id);
        } else if (answer.imageUrl == null) {
            emit("no_fill", graphic.format, window.id);
        } else if (host.contentPositionMs() < window.end) {
            String format = "l_shape".equals(graphic.format) ? "l" : "super";
            OverlayCue cue = OverlayCue.planGraphic("il-ads-" + window.id, format, window.start, window.end, answer.imageUrl, answer.mimeType);
            if (cue == null) {
                emit("error", graphic.format, window.id);
                return;
            }
            schedule.shown.add(window);
            emit("fill", graphic.format, window.id);
            measures.put(cue.id, new Measure(answer.impressions, graphic.format, window.id));
            planCues.add(cue);
            host.setCues(planCues);
        }
    }

    private void askProduct(AdPlan.Window window) {
        schedule.products.put(window.id, "pending");
        schedule.pending.add(window);
        productBusy = true;
        emit("request", "scene_product", window.id);
        String url = plan.productUrl(window.id, locale);
        host.background(() -> {
            OverlayCue card = null;
            boolean empty = false;
            try {
                String body = host.fetch(url);
                empty = body.isEmpty();
                if (!empty) card = AdPlan.productCue(body, window);
            } catch (IOException e) {
                empty = true;
            }
            OverlayCue result = card;
            boolean none = empty;
            host.foreground(() -> productAnswered(window, result, none));
        });
    }

    private void productAnswered(AdPlan.Window window, OverlayCue card, boolean empty) {
        if (closed) return;
        schedule.pending.remove(window);
        productBusy = false;
        if (checkExpired()) return;
        if (card == null || breakOn()) {
            schedule.products.put(window.id, "empty");
            emit(empty ? "no_fill" : "error", "scene_product", window.id);
            return;
        }
        schedule.products.put(window.id, "filled");
        schedule.shown.add(window);
        emit("fill", "scene_product", window.id);
        measures.put(card.id, new Measure(new ArrayList<String>(), "scene_product", window.id));
        planCues.add(card);
        host.setCues(planCues);
    }

    // The overlay reports a cue drawn on screen once. Its own impressionUrl is sent by the overlay.
    void cueVisible(String cueId) {
        Measure measure = measures.remove(cueId);
        if (measure == null) return;
        beacon(measure.urls);
        emit("impression", measure.format, measure.window);
    }

    private void beacon(List<String> urls) {
        if (urls == null || closed) return;
        for (String url : urls) host.background(() -> host.ping(url));
    }

    private void beginBreak(AdPlan.Cut next) {
        schedule.settled.add(next.id);
        cut = next;
        inBreak = true;
        ad = null;
        adPlaying = false;
        adCounted = false;
        swapped = false;
        imaStarted = false;
        scrubbed = false;
        breakElapsedMs = 0;
        breakLimitMs = BREAK_WATCHDOG_MS;
        lastAdPositionMs = -1;
        firedQuartiles.clear();
        if (displayLive != null) host.display().setVisible(false);
        host.captureContent();
        resumeAt = Math.max(0, host.contentPositionMs());
        resumePlay = host.playWhenReady();
        host.pause();
        host.setLinear(true, null, null);
        emit("break_start", null, next.id);
        host.later(holdExpired, HOLD_MS);
        walk =new AdBreakWalk(next.requests, new AdBreakWalk.Engine() {
            @Override public void ask(AdPlan.Request request, long token) { askBreak(request, token); }
            @Override public void noFill(AdPlan.Request request) { emit("break_no_fill", request.provider, cut.id); }
            @Override public void finished(boolean complete) { endBreak(complete); }
        });
        walk.start();
    }

    private void askBreak(AdPlan.Request entry, long token) {
        shopAdEnded();
        ad = null;
        adPlaying = false;
        emit("break_request", entry.provider, cut.id);
        String tag = AdPlan.correlated(entry.tagUrl);
        AdBreakWalk current = walk;
        if (!"iadserver".equals(entry.provider)) {
            startIma(tag, null, token, current);
            return;
        }
        // iADServer's spot is read here for its Buy identity, and IMA is handed this same answer.
        host.background(() -> {
            Fetched spot = fetchLinear(tag);
            host.foreground(() -> {
                if (!closed && walk == current && inBreak) startIma(tag, spot, token, current);
            });
        });
    }

    private static final class Fetched {
        final AdPlan.LinearAd ad;
        final String vast;
        Fetched(AdPlan.LinearAd ad, String vast) { this.ad = ad; this.vast = vast; }
    }

    private void startIma(String tag, Fetched spot, long token, AdBreakWalk current) {
        AdPlan.LinearAd identity = spot != null && plan.breakShop ? spot.ad : null;
        boolean running = host.playIma(tag, spot == null ? null : spot.vast, resumeAt, new ImaCallback() {
            @Override public void loaded() {
                if (walk != current) return;
                current.loaded(token);
                host.play();
            }
            @Override public void started(long durationMs) {
                if (walk != current) return;
                imaStarted = true;
                watchAd(durationMs);
                current.started(token);
                if (plan.breakUrl != null) shopAdStarted(cut.id, cut.position, tag, spot == null ? null : spot.ad.adId,
                        spot == null ? null : spot.ad.linearCreativeId);
                else if (identity != null) host.setLinear(true, identity.creativeId, identity.deliveryId);
            }
            @Override public void empty() {
                if (walk == current) current.done(token, false);
            }
            @Override public void failed() {
                if (walk != current) return;
                if (imaStarted) current.done(token, false);
                else fallBackToMp4(tag, spot, token, current);
            }
            @Override public void completed() {
                if (walk != current) return;
                shopAdEnded();
                current.done(token, true);
            }
        });
        if (running) swapped = true;
        else fallBackToMp4(tag, spot, token, current);
    }

    // From the ad's start: its own duration plus 30 s of foreground time, 120 s when the length is unknown.
    private void watchAd(long durationMs) {
        breakLimitMs = breakElapsedMs + Math.min(durationMs > 0 ? durationMs + 30000 : BREAK_WATCHDOG_MS, AD_CAP_MS);
    }

    // IMA could not run this answer. An answer already fetched is played as it is; otherwise the same URL with its
    // correlator is the same request to the ad server.
    private void fallBackToMp4(String tag, Fetched spot, long token, AdBreakWalk current) {
        host.cancelIma();
        // IMA loaded the ad, the hold passed, then IMA failed (for example on its media timeout): nothing new starts,
        // neither an MP4 nor a second request for the same URL. The break ends.
        if (current.holdPassed()) {
            current.noFill(token);
            return;
        }
        if (spot != null) {
            if (spot.ad.mediaUrl == null) current.noFill(token);
            else playAd(spot.ad, tag, token);
            return;
        }
        host.background(() -> {
            Fetched found = fetchLinear(AdPlan.withApp(tag));
            host.foreground(() -> {
                if (closed || walk != current || !inBreak) return;
                if (found == null || found.ad.mediaUrl == null) current.noFill(token);
                else playAd(found.ad, tag, token);
            });
        });
    }

    private Fetched fetchLinear(String url) {
        AdPlan.LinearAd out = new AdPlan.LinearAd();
        String next = url, first = null;
        try {
            for (int hop = 0; hop <= MAX_WRAPPERS; hop++) {
                String body = host.fetch(next);
                if (first == null) first = body;
                if (!AdPlan.parseLinear(body, out)) return null;
                if (out.wrapperUrl == null) return new Fetched(out, first);
                next = out.wrapperUrl;
            }
        } catch (IOException ignored) {
            return null;
        }
        return null;
    }

    private void playAd(AdPlan.LinearAd found, String tag, long token) {
        ad = found;
        adTag = tag;
        adToken = token;
        swapped = true;
        host.playMp4(found.mediaUrl);
        adPlaying = true;
    }

    /** The MP4 ad shows its first frame. */
    void adPlaying() {
        if (!inBreak || !adPlaying || adCounted || ad == null) return;
        adCounted = true;
        watchAd(ad.durationMs);
        walk.started(adToken);
        beacon(ad.impressions);
        beacon(ad.tracking.get("start"));
        if (plan.breakUrl != null) shopAdStarted(cut.id, cut.position, adTag, ad.adId, ad.linearCreativeId);
        else if (plan.breakShop) host.setLinear(true, ad.creativeId, ad.deliveryId);
    }

    // An ad dragged to its end with the app's controls is not reported complete.
    void adEnded() {
        if (!inBreak || !adPlaying) return;
        shopAdEnded();
        walk.done(adToken, !scrubbed);
    }

    void adFailed() {
        if (!inBreak || !adPlaying) return;
        shopAdEnded();
        walk.done(adToken, false);
    }

    private void trackQuartiles() {
        if (!adPlaying || ad == null) return;
        long position = host.adPositionMs();
        long now = host.clockMs();
        // Ahead of the wall clock: a main-thread stall advances both and is not a scrub.
        if (adCounted && lastAdPositionMs >= 0 && position - lastAdPositionMs > now - lastClockMs + 1000) scrubbed = true;
        if (adCounted) {
            lastAdPositionMs = position;
            lastClockMs = now;
        }
        if (ad.durationMs <= 0 || scrubbed) return;
        for (String[] quartile : Arrays.asList(new String[] {"firstQuartile", "0.25"}, new String[] {"midpoint", "0.5"},
                new String[] {"thirdQuartile", "0.75"})) {
            if (position >= ad.durationMs * Double.parseDouble(quartile[1]) && firedQuartiles.add(quartile[0])) {
                beacon(ad.tracking.get(quartile[0]));
            }
        }
    }

    private void endBreak(boolean complete) {
        if (closed || !inBreak) return;
        walk = null;
        shopToken++;
        shopSpot = false;
        host.cancelIma();
        host.cancel(holdExpired);
        if (complete && ad != null) beacon(ad.tracking.get("complete"));
        ad = null;
        adPlaying = false;
        inBreak = false;
        // The ad leaves the player before graphics are allowed back. After IMA too: the app's own items, playlist and
        // media source factory (headers, DRM) come back instead of the item IMA played.
        if (swapped) host.restoreContent(resumeAt);
        host.setLinear(false, null, null);
        emit(complete ? "break_end" : "break_error", null, cut.id);
        Runnable ready = afterPreroll;
        afterPreroll = null;
        // A plan closed during a break gives the content back without starting it. The MP4 ad left playWhenReady on,
        // and restored items would start by themselves (seen on the emulator), so the player is paused here.
        if (closing) {
            host.pause();
            return;
        }
        if (ready != null) ready.run();
        else if (resumePlay) host.play();
    }

    private boolean breakOn() { return inBreak || hostBreak; }

    // Web: expired() checks the clock on every tick and seek; the plan stops and the content in a break comes back.
    boolean checkExpired() {
        if (expired) return true;
        if (closed || plan.version != 2 || host.nowMs() < plan.expiresAtMs) return false;
        expired = true;
        if (inBreak) endBreak(false);
        shopToken++;
        if (hostBreak && shopSpot) host.setLinear(true, null, null);
        shopSpot = false;
        host.cancel(displayExpired);
        displayRequest = null;
        if (displayLive != null) host.display().clear();
        displayLive = null;
        planCues.clear();
        host.setCues(planCues);
        emit("plan_expired", null, null);
        return true;
    }

    /**
     * A renewal of the same view: the new plan's URLs and expiry, and everything already settled, attempted and shown,
     * with the pacing it counts, carried over so nothing is replayed or counted twice (web: nativeViews).
     */
    void replace(AdPlan next) {
        if (closed) return;
        plan = next;
        schedule = next.schedule(schedule);
        if (hostBreaks != null) schedule.sceneWindows = next.windowsAround(hostBreaks);
        expired = false;
        // A version 1 answer stops the renewals; a version 2 answer (re)starts them.
        if (started) scheduleRenewal();
    }

    // About 20 s before expires_at (the server allows 120 s, so about 100 s after the plan was issued).
    private void scheduleRenewal() {
        host.cancel(renewTask);
        renewAttempt = 0;
        renewInFlight = false;
        renewFailedSaid = false;
        long delay = AdPlanLoader.renewDelay(plan, host.nowMs());
        if (delay >= 0) host.later(renewTask, delay);
    }

    /** The breaks the host will play, in content milliseconds: scene graphics keep the plan's clearance around them. */
    void setBreaks(long[] atMs) {
        if (closed || atMs == null) return;
        List<Long> breaks = new ArrayList<>();
        boolean refused = false;
        for (long at : atMs) {
            if (at >= 0) breaks.add(at);
            else refused = true;
        }
        if (refused) emit("break_refused", "position", null);
        hostBreaks = breaks;
        schedule.sceneWindows = plan.windowsAround(breaks);
    }

    void breakStarted(long atMs) {
        if (closed) return;
        if (atMs < 0) {
            emit("break_refused", "position", Long.toString(atMs));
            return;
        }
        // Host calls go with a host plan (cuts: []): two break drivers on one view are not mixed.
        if (!plan.cuts.isEmpty()) {
            emit("break_refused", "plan_has_cuts", Long.toString(atMs));
            return;
        }
        // The host plan's windows are not cleared around the app's breaks: the reported position gets the clearance.
        if (hostBreaks == null || !hostBreaks.contains(atMs)) {
            List<Long> breaks = hostBreaks == null ? new ArrayList<>() : new ArrayList<>(hostBreaks);
            breaks.add(atMs);
            hostBreaks = breaks;
            schedule.sceneWindows = plan.windowsAround(breaks);
        }
        hostBreak = true;
        hostBreakElapsedMs = 0;
        hostBreakAtMs = atMs;
        shopToken++;
        shopSpot = false;
        if (displayLive != null) host.display().setVisible(false);
        // Graphics leave the screen; a product held from the content closes (a new break, as web setBreakActive).
        host.setLinear(true, null, null);
        emit("host_break_start", null, "at-" + hostBreakAtMs);
    }

    void hostAdStarted(String tagUrl, String adId, String creativeId) {
        if (closed || !hostBreak || checkExpired()) return;
        hostBreakElapsedMs = 0;
        shopAdStarted("at-" + hostBreakAtMs, hostBreakAtMs == 0 ? "preroll" : "midroll", tagUrl, adId, creativeId);
    }

    void hostAdStarted(String tagUrl, String vastXml) {
        String[] identity = AdPlan.vastIdentity(vastXml);
        hostAdStarted(tagUrl, identity == null ? null : identity[0], identity == null ? null : identity[1]);
    }

    void hostAdEnded() {
        if (closed || !hostBreak) return;
        hostBreakElapsedMs = 0;
        shopAdEnded();
    }

    void breakEnded() {
        if (!closed && hostBreak) endHostBreak("host_break_end");
    }

    // Only the reader's own state and the overlay: the host's player is never touched here.
    private void endHostBreak(String type) {
        hostBreak = false;
        shopToken++;
        shopSpot = false;
        host.setLinear(false, null, null);
        emit(type, null, "at-" + hostBreakAtMs);
    }

    /**
     * One ad of a break started, reader's or host's: with {@code commerce.break_url} the card of exactly this delivery
     * is asked for (web/ads.mjs shopAdStarted). {@code cutParam} is the plan cut id, or {@code at-<ms>} for a host break.
     */
    private void shopAdStarted(String cutParam, String position, String tagUrl, String adId, String creativeId) {
        long token = ++shopToken;
        String tag = null;
        java.util.regex.Matcher match = adId == null ? null : AdPlan.SHOP_AD.matcher(adId);
        // The tag comes only from an iADServer request, as web reads it from the iadserver provider's tag URL.
        String iad = tagUrl == null ? null : AdPlan.canonicalTag("iadserver", tagUrl);
        if (iad != null) tag = AdPlan.query(iad, "tag");
        boolean shop = plan.breakUrl != null && match != null && match.matches() && match.group(1).equals(position)
                && tag != null && !tag.isEmpty() && creativeId != null && OverlayCue.validIdentity(creativeId);
        if (!shop) {
            // A spot without a shop changes nothing unless the one before it had one.
            if (shopSpot) host.setLinear(true, null, null);
            shopSpot = false;
            return;
        }
        String delivery = match.group(2);
        shopSpot = true;
        host.setBreakCard(creativeId, delivery, null);
        String url = plan.breakProductUrl(cutParam, tag, creativeId, delivery, locale);
        emit("request", "break_product", cutParam);
        host.background(() -> {
            String body;
            try {
                body = host.fetch(url);
            } catch (IOException e) {
                body = null;
            }
            OverlayCue card = body == null || body.isEmpty() ? null : AdPlan.breakCue(body, creativeId, delivery);
            boolean none = body != null && body.isEmpty();
            host.foreground(() -> {
                if (closed || token != shopToken || !breakOn() || checkExpired()) return;
                if (card == null) {
                    emit(none ? "no_fill" : "error", "break_product", cutParam);
                    return;
                }
                emit("fill", "break_product", cutParam);
                host.setBreakCard(creativeId, delivery, card);
            });
        });
    }

    /** The ad ended (complete, skip or error): its card goes; a product the viewer opened stays (overlay hold). */
    private void shopAdEnded() {
        shopToken++;
        if (breakOn() && shopSpot) host.setLinear(true, null, null);
        shopSpot = false;
    }

    void close() {
        if (closed) return;
        closing = true;
        if (inBreak) endBreak(false);
        if (hostBreak) {
            hostBreak = false;
            host.setLinear(false, null, null);
        }
        closed = true;
        host.cancel(renewTask);
        host.cancel(pulse);
        host.cancel(holdExpired);
        host.cancel(displayExpired);
        if (host.display() != null) host.display().clear();
        planCues.clear();
        host.setCues(planCues);
    }
}

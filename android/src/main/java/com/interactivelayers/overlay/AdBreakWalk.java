package com.interactivelayers.overlay;

import java.util.List;

/** One break: its requests in plan order until one plays. Late answers carry an old token and are ignored. */
final class AdBreakWalk {
    interface Engine {
        void ask(AdPlan.Request request, long token);
        void noFill(AdPlan.Request request);
        void finished(boolean complete);
    }

    private final List<AdPlan.Request> requests;
    private final Engine engine;
    private int index = -1;
    private long token;
    private boolean started, over, loaded, holdPassed;

    AdBreakWalk(List<AdPlan.Request> requests, Engine engine) {
        this.requests = requests;
        this.engine = engine;
    }

    void start() { next(); }

    private void next() {
        index++;
        if (index >= requests.size()) {
            finish(false);
            return;
        }
        engine.ask(requests.get(index), ++token);
    }

    private void finish(boolean complete) {
        if (over) return;
        over = true;
        token++;
        engine.finished(complete);
    }

    /** The request answered with no ad, or its ad failed before its first frame. */
    void noFill(long answer) {
        if (over || answer != token || started) return;
        engine.noFill(requests.get(index));
        loaded = false;
        // Past the hold no further request is started.
        if (holdPassed) finish(false);
        else next();
    }

    void started(long answer) {
        if (!over && answer == token) started = true;
    }

    /**
     * IMA has this request's ad loaded and is starting it. The hold no longer ends the break: IMA's own media timeout
     * and the ad watchdog bound what follows. (On the emulator, iADServer's real answer plus IMA's start took 7.7 s
     * and 8.1 s, so the 8 s hold cut an ad that was already on its way.)
     */
    void loaded(long answer) {
        if (!over && answer == token) loaded = true;
    }

    void done(long answer, boolean complete) {
        if (over || answer != token) return;
        if (!started && !complete) noFill(answer);
        else finish(complete);
    }

    /** Content may wait this long for an ad. An ad already playing is not interrupted. */
    /** Whether the hold has passed: from then on nothing new may start in this break. */
    boolean holdPassed() { return holdPassed; }

    void holdExpired() {
        holdPassed = true;
        if (!started && !loaded) finish(false);
    }
}

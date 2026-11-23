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
    private boolean started, over;

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
        next();
    }

    void started(long answer) {
        if (!over && answer == token) started = true;
    }

    void done(long answer, boolean complete) {
        if (over || answer != token) return;
        if (!started && !complete) noFill(answer);
        else finish(complete);
    }

    /** Content may wait this long for an ad. An ad already playing is not interrupted. */
    void holdExpired() {
        if (!started) finish(false);
    }
}

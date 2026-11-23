package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class AdBreakWalkTest {
    private final List<String> log = new ArrayList<>();
    private long token;
    private final AdBreakWalk walk = new AdBreakWalk(Arrays.asList(
            new AdPlan.Request("iadserver", "https://a"), new AdPlan.Request("gam", "https://b")), new AdBreakWalk.Engine() {
        @Override public void ask(AdPlan.Request request, long next) { token = next; log.add("ask " + request.provider); }
        @Override public void noFill(AdPlan.Request request) { log.add("empty " + request.provider); }
        @Override public void finished(boolean complete) { log.add("end " + complete); }
    });

    @Test public void fallsThroughInOrderAndEndsWithoutAnAd() {
        walk.start();
        walk.noFill(token);
        walk.noFill(token);
        assertEquals(Arrays.asList("ask iadserver", "empty iadserver", "ask gam", "empty gam", "end false"), log);
    }

    @Test public void theHoldDoesNotCutAnAdImaHasLoaded() {
        walk.start();
        walk.loaded(token);
        walk.holdExpired();
        assertFalse(log.contains("end false"));
        walk.started(token);
        walk.done(token, true);
        assertEquals("end true", log.get(log.size() - 1));
    }

    @Test public void afterTheHoldALoadedAdThatFailsAsksNoMore() {
        walk.start();
        walk.loaded(token);
        walk.holdExpired();
        walk.done(token, false);
        assertEquals(Arrays.asList("ask iadserver", "empty iadserver", "end false"), log);
    }

    @Test public void theHoldStillEndsABreakWithNothingLoaded() {
        walk.start();
        walk.holdExpired();
        assertEquals("end false", log.get(log.size() - 1));
    }

    @Test public void anAdThatFailsBeforeItsFirstFrameFallsThrough() {
        walk.start();
        walk.done(token, false);
        assertEquals("ask gam", log.get(2));
    }

    @Test public void aLateAnswerIsIgnored() {
        walk.start();
        long old = token;
        walk.noFill(token);
        walk.noFill(old);
        walk.started(old);
        walk.done(old, true);
        assertEquals(Arrays.asList("ask iadserver", "empty iadserver", "ask gam"), log);
    }

    @Test public void aStartedAdEndsTheBreakAndIsNotCutByTheHold() {
        walk.start();
        walk.started(token);
        walk.holdExpired();
        assertEquals(1, log.size());
        walk.done(token, true);
        walk.done(token, true);
        assertEquals("end true", log.get(1));
        assertEquals(2, log.size());
    }

    @Test public void aStartedAdThatFailsDoesNotAskAgain() {
        walk.start();
        walk.started(token);
        walk.done(token, false);
        assertEquals(Arrays.asList("ask iadserver", "end false"), log);
    }

    @Test public void theHoldEndsABreakWithNoAd() {
        walk.start();
        walk.holdExpired();
        walk.noFill(token);
        assertEquals(Arrays.asList("ask iadserver", "end false"), log);
    }

    @Test public void aProductCardIsClippedToItsWindowAndNeedsBuy() throws Exception {
        AdPlan.Window window = new AdPlan.Window("w1", 10000, 25000, null);
        JSONObject commerce = new JSONObject().put("title", "Botines").put("price", "50").put("currency", "USD").put("locale", "es")
                .put("handoffUrl", "https://il.example/h").put("variants", new JSONArray().put(new JSONObject().put("id", "42").put("label", "42")));
        JSONObject card = new JSONObject().put("id", "card").put("window", "w1").put("format", "overlay").put("start", 0).put("end", 99000)
                .put("imageUrl", "https://c.example/p.jpg").put("commerce", commerce);
        OverlayCue cue = AdPlan.productCue(card.toString(), window);
        assertNotNull(cue);
        assertEquals(10000, cue.start);
        assertEquals(25000, cue.end);
        assertNull(AdPlan.productCue(new JSONObject(card.toString()).put("window", "w2").toString(), window));
        JSONObject plain = new JSONObject(card.toString());
        plain.remove("commerce");
        assertNull(AdPlan.productCue(plain.toString(), window));
    }
}

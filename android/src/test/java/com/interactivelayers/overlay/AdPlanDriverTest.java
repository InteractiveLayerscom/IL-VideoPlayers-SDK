package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class AdPlanDriverTest {
    private static final String GAM = "https://pubads.g.doubleclick.net/gampad/ads?iu=/1/a";
    private static final String IAD = "https://ads.iadserver.com/gampad/ads?tag=t";
    private static final String LINEAR = "<VAST><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><Linear>"
            + "<Duration>00:00:20</Duration><TrackingEvents><Tracking event=\"start\">https://t.example/s</Tracking>"
            + "<Tracking event=\"midpoint\">https://t.example/m</Tracking><Tracking event=\"complete\">https://t.example/c</Tracking></TrackingEvents>"
            + "<MediaFiles><MediaFile delivery=\"progressive\" type=\"video/mp4\" width=\"1280\">https://c.example/ad.mp4</MediaFile></MediaFiles>"
            + "</Linear></Creative></Creatives><Extensions><Extension type=\"iADServerShop\"><Shop deliveryId=\"d1\" creativeId=\"c1\"/></Extension></Extensions></InLine></Ad></VAST>";
    private static final String SUPER = "<VAST><Ad><InLine><Impression>https://t.example/g</Impression><Creatives><Creative><NonLinearAds>"
            + "<NonLinear width=\"600\" height=\"90\"><StaticResource creativeType=\"image/png\">https://c.example/s.png</StaticResource></NonLinear>"
            + "</NonLinearAds></Creative></Creatives></InLine></Ad></VAST>";

    private static final class FakeDisplay implements AdPlanDisplay {
        String unit;
        Map<String, String> targeting;
        Callback callback;
        Boolean visible;
        int cleared;
        @Override public void request(String adUnit, Map<String, String> values, Callback next) {
            unit = adUnit; targeting = values; callback = next;
        }
        @Override public void setVisible(boolean value) { visible = value; }
        @Override public void clear() { cleared++; visible = false; }
    }

    private static final class FakeHost implements AdPlanDriver.Host {
        long position;
        boolean playing = true, playWhen = true, imaAvailable = true;
        final List<String> calls = new ArrayList<>();
        final List<String> fetched = new ArrayList<>();
        final List<String> pings = new ArrayList<>();
        final List<String> events = new ArrayList<>();
        final List<String> tags = new ArrayList<>();
        final List<String> responses = new ArrayList<>();
        boolean active = true;
        final Map<Runnable, Long> timers = new LinkedHashMap<>();
        final Map<String, String> replies = new HashMap<>();
        List<OverlayCue> cues = new ArrayList<>();
        AdPlanDriver.ImaCallback ima;
        String creative, delivery;
        boolean linear;
        FakeDisplay slot;
        long adPosition;
        boolean fits = true;

        @Override public long contentPositionMs() { return position; }
        @Override public boolean contentPlaying() { return playing; }
        @Override public boolean playWhenReady() { return playWhen; }
        @Override public void play() { playing = true; calls.add("play"); }
        @Override public void pause() { playing = false; calls.add("pause"); }
        @Override public void captureContent() { calls.add("capture"); }
        @Override public void restoreContent(long ms) { calls.add("restore " + ms); }
        @Override public void playMp4(String url) { calls.add("mp4 " + url); }
        @Override public long adPositionMs() { return adPosition; }
        @Override public boolean playIma(String tag, String response, long ms, AdPlanDriver.ImaCallback callback) {
            if (!imaAvailable) return false;
            tags.add(tag); responses.add(response); ima = callback; calls.add("ima");
            return true;
        }
        @Override public void cancelIma() { ima = null; }
        @Override public boolean appActive() { return active; }
        long clock;
        @Override public long clockMs() { return clock; }
        @Override public void later(Runnable task, long delay) { timers.put(task, delay); }
        @Override public void cancel(Runnable task) { timers.remove(task); }
        @Override public void background(Runnable task) { task.run(); }
        @Override public void foreground(Runnable task) { task.run(); }
        @Override public void setLinear(boolean active, String c, String d) { linear = active; creative = c; delivery = d; calls.add("linear " + active); }
        @Override public void setCues(List<OverlayCue> next) { cues = new ArrayList<>(next); }
        @Override public String fetch(String url) throws IOException {
            fetched.add(url);
            for (Map.Entry<String, String> reply : replies.entrySet()) if (url.startsWith(reply.getKey())) return reply.getValue();
            throw new IOException("no reply");
        }
        @Override public void ping(String url) { pings.add(url); }
        @Override public void event(String type, String format, String id) { events.add(type); }
        @Override public AdPlanDisplay display() { return slot; }
        @Override public boolean displayFits() { return fits; }

        void fire(long delay) {
            for (Runnable task : new ArrayList<>(timers.keySet())) {
                if (timers.get(task) != null && timers.get(task) == delay) { timers.remove(task); task.run(); return; }
            }
            fail("no timer of " + delay);
        }
    }

    private static JSONObject base() throws Exception {
        return new JSONObject().put("version", 1).put("expires_at", "2099-01-01T00:00:00Z");
    }

    private static JSONObject cut(String id, int at, String... tags) throws Exception {
        JSONArray requests = new JSONArray();
        for (String tag : tags) requests.put(new JSONObject().put("provider", tag.contains("iadserver") ? "iadserver" : "gam").put("tag_url", tag));
        return new JSONObject().put("id", id).put("at", at).put("requests", requests);
    }

    private static JSONObject window() throws Exception {
        return new JSONObject().put("id", "w1").put("start_ms", 10000).put("end_ms", 25000);
    }

    private final FakeHost host = new FakeHost();
    private boolean ready;

    private AdPlanDriver driver(JSONObject plan) {
        AdPlan read = AdPlan.read(plan.toString(), 1700000000000L, "https://il.example", "s1");
        assertNotNull(read);
        return new AdPlanDriver(host, read, "es");
    }

    private AdPlanDriver started(JSONObject plan) {
        AdPlanDriver driver = driver(plan);
        driver.start(() -> ready = true);
        return driver;
    }

    @Test public void imaIsTheDefaultAndACompleteBreakGivesBackTheAppsItems() throws Exception {
        started(base().put("cuts", new JSONArray().put(cut("pre", 0, GAM))));
        assertFalse(ready);
        assertTrue(host.linear);
        assertNull("a GAM tag is IMA's own request", host.responses.get(0));
        host.ima.loaded();
        assertTrue(host.calls.contains("play"));
        host.ima.started(0);
        host.ima.completed();
        assertTrue(ready);
        assertFalse(host.linear);
        // The playlist and the app's media source factory come back instead of the item IMA played.
        assertTrue(host.calls.contains("restore 0"));
        assertFalse(host.calls.stream().anyMatch(call -> call.startsWith("mp4")));
        assertEquals("break_end", host.events.get(host.events.size() - 1));
    }

    @Test public void theWatchdogCountsForegroundTimeAndFollowsTheAdsLength() throws Exception {
        AdPlanDriver driver = started(base().put("cuts", new JSONArray().put(cut("pre", 0, GAM))));
        host.ima.started(140000);
        host.active = false;
        for (int i = 0; i < 2000; i++) driver.tick();
        assertFalse("500 s in the background do not end the break", ready);
        host.active = true;
        for (int i = 0; i < 670; i++) driver.tick();
        assertFalse("a 140 s ad is not cut at 120 s", ready);
        for (int i = 0; i < 20; i++) driver.tick();
        assertTrue(ready);
        assertEquals("break_error", host.events.get(host.events.size() - 1));
    }

    @Test public void anMp4AdDraggedToItsEndIsNotComplete() throws Exception {
        host.imaAvailable = false;
        host.replies.put(GAM, LINEAR);
        AdPlanDriver driver = started(base().put("cuts", new JSONArray().put(cut("pre", 0, GAM))));
        driver.adPlaying();
        host.adPosition = 250;
        driver.tick();
        host.adPosition = 19500;
        driver.tick();
        driver.adEnded();
        assertFalse(host.pings.contains("https://t.example/c"));
        assertFalse(host.pings.contains("https://t.example/m"));
        assertEquals("break_error", host.events.get(host.events.size() - 1));
    }

    @Test public void aMainThreadStallIsNotAScrub() throws Exception {
        host.imaAvailable = false;
        host.replies.put(GAM, LINEAR);
        AdPlanDriver driver = started(base().put("cuts", new JSONArray().put(cut("pre", 0, GAM))));
        driver.adPlaying();
        host.adPosition = 250;
        host.clock = 250;
        driver.tick();
        host.adPosition = 6250;
        host.clock = 6250;
        driver.tick();
        driver.adEnded();
        assertTrue(host.pings.contains("https://t.example/c"));
        assertEquals("break_end", host.events.get(host.events.size() - 1));
    }

    @Test public void noAdHoldsTheContentPast180Seconds() throws Exception {
        AdPlanDriver driver = started(base().put("cuts", new JSONArray().put(cut("pre", 0, GAM))));
        host.ima.started(3600000);
        for (int i = 0; i < 719; i++) driver.tick();
        assertFalse(ready);
        driver.tick();
        assertTrue("an ad declaring an hour is cut at 180 s", ready);
    }

    @Test public void theLibraryTellsR8ThatImaAndGmaAreOptional() throws Exception {
        String rules = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("consumer-rules.pro")), "UTF-8");
        for (String pkg : new String[] {"androidx.media3.exoplayer.ima.**", "com.google.ads.interactivemedia.**", "com.google.android.gms.ads.**"}) {
            assertTrue(pkg, rules.contains("-dontwarn " + pkg));
        }
        String gradle = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("build.gradle")), "UTF-8");
        assertTrue(gradle.contains("consumerProguardFiles 'consumer-rules.pro'"));
    }

    @Test public void closingDuringABreakGivesTheContentBackWithoutPlayingIt() throws Exception {
        host.imaAvailable = false;
        host.replies.put(GAM, LINEAR);
        AdPlanDriver driver = started(base().put("cuts", new JSONArray().put(cut("mid", 30, GAM))));
        host.position = 30400;
        driver.tick();
        driver.adPlaying();
        host.calls.clear();
        driver.close();
        assertTrue(host.calls.contains("restore 30400"));
        assertFalse(host.calls.contains("play"));
    }

    @Test public void theFetchedIadServerVastIsWhatImaAndMp4Play() throws Exception {
        host.replies.put(IAD, LINEAR);
        started(base().put("cuts", new JSONArray().put(cut("pre", 0, IAD))));
        assertEquals(LINEAR, host.responses.get(0));
        host.ima.failed();
        assertEquals("iADServer is asked once", 1, host.fetched.size());
        assertTrue(host.calls.contains("mp4 https://c.example/ad.mp4"));
    }

    @Test public void noBuyIdentityWhenTheSidIsNotThePlansSession() throws Exception {
        host.replies.put(IAD, LINEAR);
        AdPlan read = AdPlan.read(base().put("cuts", new JSONArray().put(cut("pre", 0, IAD))).put("commerce", shop("plan-s")).toString(),
                1700000000000L, "https://il.example", "host-s");
        new AdPlanDriver(host, read, "es").start(() -> ready = true);
        assertTrue(host.tags.get(0).contains("sid=host-s"));
        host.ima.started(0);
        assertNull(host.creative);
        assertTrue(host.linear);
    }

    private static JSONObject shop(String session) throws Exception {
        return new JSONObject().put("kind", "scene_product").put("url", "https://il.example/p").put("lead_ms", 1000)
                .put("session", session).put("pacing", new JSONObject().put("min_seconds", 5)).put("windows", new JSONArray());
    }

    @Test public void anEmptyImaAnswerGoesToTheNextRequestWithoutMp4() throws Exception {
        started(base().put("cuts", new JSONArray().put(cut("pre", 0, GAM, GAM + "&b=2"))));
        host.ima.empty();
        assertEquals(2, host.tags.size());
        assertTrue(host.tags.get(1).contains("b=2"));
        assertTrue(host.fetched.isEmpty());
    }

    @Test public void anImaFailureFallsBackToMp4OnTheSameTag() throws Exception {
        host.replies.put(GAM, LINEAR);
        AdPlanDriver driver = started(base().put("cuts", new JSONArray().put(cut("pre", 0, GAM))).put("commerce", shop("s1")));
        String tag = host.tags.get(0);
        host.ima.failed();
        assertEquals(tag, host.fetched.get(0));
        assertTrue(host.calls.contains("mp4 https://c.example/ad.mp4"));
        driver.adPlaying();
        driver.adPlaying();
        assertEquals(1, host.pings.stream().filter("https://t.example/i"::equals).count());
        assertEquals("c1", host.creative);
        driver.adEnded();
        assertTrue(host.pings.contains("https://t.example/c"));
        assertTrue(host.calls.contains("restore 0"));
        assertTrue(ready);
    }

    @Test public void withoutImaAMidrollPlaysMp4AndResumes() throws Exception {
        host.imaAvailable = false;
        host.replies.put(GAM, LINEAR);
        AdPlanDriver driver = started(base().put("cuts", new JSONArray().put(cut("mid", 30, GAM))));
        host.position = 30400;
        driver.tick();
        assertTrue(host.linear);
        driver.adPlaying();
        host.adPosition = 11000;
        driver.tick();
        assertTrue(host.pings.contains("https://t.example/m"));
        driver.adEnded();
        int restore = host.calls.indexOf("restore 30400");
        assertTrue(restore >= 0);
        assertTrue("graphics return only after the ad left the player", restore < host.calls.lastIndexOf("linear false"));
        assertEquals("play", host.calls.get(host.calls.size() - 1));
    }

    @Test public void aFailureAfterTheAdStartedDoesNotAskAgain() throws Exception {
        started(base().put("cuts", new JSONArray().put(cut("pre", 0, GAM, GAM + "&b=2"))));
        host.ima.started(0);
        host.ima.failed();
        assertEquals(1, host.tags.size());
        assertEquals("break_error", host.events.get(host.events.size() - 1));
        assertTrue(ready);
    }

    @Test public void theHoldReleasesContentWhenNoAdStarts() throws Exception {
        started(base().put("cuts", new JSONArray().put(cut("pre", 0, GAM))));
        host.fire(8000);
        assertTrue(ready);
        assertFalse(host.linear);
    }

    @Test public void iadServerIdentityReachesBuyUnderIma() throws Exception {
        host.replies.put(IAD, LINEAR);
        started(base().put("cuts", new JSONArray().put(cut("pre", 0, IAD))).put("commerce", shop("s1")));
        assertEquals(host.tags.get(0), host.fetched.get(0));
        host.ima.started(0);
        assertEquals("c1", host.creative);
        assertEquals("d1", host.delivery);
    }

    private static JSONObject scenes(String... formats) throws Exception {
        JSONArray names = new JSONArray();
        for (String format : formats) names.put(format);
        return new JSONObject().put("formats", names)
                .put("graphics", new JSONArray().put(new JSONObject().put("format", "super").put("tag_url", GAM)))
                .put("overlay", new JSONObject().put("ad_unit", "/123/site/overlay"))
                .put("pacing", new JSONObject().put("min_seconds", 5))
                .put("windows", new JSONArray().put(window().put("targeting", new JSONObject().put("topic", new JSONArray().put("a").put("b")))));
    }

    @Test public void aGraphicIsAskedDrawnAndCountedOnce() throws Exception {
        host.replies.put(GAM, SUPER);
        AdPlanDriver driver = started(base().put("scenes", scenes("super")));
        host.position = 7000;
        driver.tick();
        assertEquals(1, host.cues.size());
        driver.cueVisible("il-ads-w1");
        driver.cueVisible("il-ads-w1");
        assertEquals(1, host.pings.stream().filter("https://t.example/g"::equals).count());
        host.position = 26000;
        driver.tick();
        assertTrue(host.cues.isEmpty());
    }

    private JSONObject productPlan() throws Exception {
        return base().put("scenes", scenes("super")).put("commerce", new JSONObject().put("kind", "scene_product")
                .put("url", "https://il.example/p?g=1").put("lead_ms", 1000).put("pacing", new JSONObject().put("min_seconds", 5))
                .put("windows", new JSONArray().put(window())));
    }

    @Test public void theProductIsRequestedFromThePlanAndWinsItsWindow() throws Exception {
        JSONObject commerce = new JSONObject().put("title", "Botines").put("price", "50").put("currency", "USD").put("locale", "es")
                .put("handoffUrl", "https://il.example/h").put("variants", new JSONArray().put(new JSONObject().put("id", "42").put("label", "42")));
        host.replies.put("https://il.example/p", new JSONObject().put("id", "card").put("window", "w1").put("format", "overlay")
                .put("start", 0).put("end", 99000).put("imageUrl", "https://c.example/p.jpg").put("commerce", commerce).toString());
        AdPlanDriver driver = started(productPlan());
        host.position = 9500;
        driver.tick();
        assertEquals("https://il.example/p?g=1&window=w1&locale=es", host.fetched.get(0));
        assertEquals(1, host.cues.size());
        assertNotNull(host.cues.get(0).commerce);
        assertEquals(10000, host.cues.get(0).start);
        assertFalse(host.fetched.stream().anyMatch(url -> url.contains("doubleclick")));
    }

    @Test public void aWindowWithoutAProductGoesToAGraphic() throws Exception {
        host.replies.put("https://il.example/p", "");
        host.replies.put(GAM, SUPER);
        AdPlanDriver driver = started(productPlan());
        host.position = 9500;
        driver.tick();
        driver.tick();
        assertEquals("il-ads-w1", host.cues.get(0).id);
    }

    @Test public void theOverlayFollowsItsWindowAndHidesDuringABreak() throws Exception {
        host.slot = new FakeDisplay();
        AdPlanDriver driver = started(base().put("scenes", scenes("overlay_300x250"))
                .put("cuts", new JSONArray().put(cut("mid", 15, GAM))));
        host.position = 7000;
        driver.tick();
        assertEquals("/123/site/overlay", host.slot.unit);
        assertEquals("a,b", host.slot.targeting.get("topic"));
        assertEquals("overlay_300x250", host.slot.targeting.get("il_format"));
        host.slot.callback.filled();
        assertEquals(Boolean.FALSE, host.slot.visible);
        host.position = 11000;
        driver.tick();
        assertEquals(Boolean.TRUE, host.slot.visible);
        host.slot.callback.impression();
        host.slot.callback.impression();
        assertEquals(1, host.events.stream().filter("impression"::equals).count());
        host.position = 15100;
        driver.tick();
        assertEquals(Boolean.FALSE, host.slot.visible);
    }

    @Test public void anOverlayWithoutASlotIsNotAsked() throws Exception {
        AdPlanDriver driver = started(base().put("scenes", scenes("overlay_300x250")));
        host.position = 7000;
        driver.tick();
        assertTrue(host.events.isEmpty());
    }

    @Test public void aSlotThatCannotServeHereIsNotAsked() throws Exception {
        host.slot = new FakeDisplay();
        host.fits = false;
        AdPlanDriver driver = started(base().put("scenes", scenes("overlay_300x250")));
        host.position = 7000;
        driver.tick();
        assertNull(host.slot.unit);
    }

    @Test public void anOverlayThatNeverAnswersTimesOut() throws Exception {
        host.slot = new FakeDisplay();
        AdPlanDriver driver = started(base().put("scenes", scenes("overlay_300x250")));
        host.position = 7000;
        driver.tick();
        host.fire(4000);
        assertEquals("error", host.events.get(host.events.size() - 1));
        assertEquals(1, host.slot.cleared);
        host.slot.callback.filled();
        assertEquals("error", host.events.get(host.events.size() - 1));
    }
}

package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** The native ad plan against IL's real responses in test/fixtures/native (clock frozen at 2026-11-02T16:00:00Z). */
public final class NativePlanTest {
    private static final long NOW = 1793635200000L;
    // The fixtures come from IL's test environment on http://localhost:8000; the reader only takes HTTPS, so the
    // tests serve the same bodies from an HTTPS origin. Nothing else in them changes.
    private static final String ORIGIN = "https://console.example";
    private static final String DELIVERY = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    private static final String SUPER = "<VAST><Ad><InLine><Impression>https://t.example/g</Impression><Creatives><Creative><NonLinearAds>"
            + "<NonLinear width=\"600\" height=\"90\"><StaticResource creativeType=\"image/png\">https://c.example/s.png</StaticResource></NonLinear>"
            + "</NonLinearAds></Creative></Creatives></InLine></Ad></VAST>";

    static String fixture(String name) throws IOException {
        try (InputStream in = NativePlanTest.class.getClassLoader().getResourceAsStream("native/" + name)) {
            assertNotNull(name, in);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            return new String(out.toByteArray(), StandardCharsets.UTF_8).replace("http://localhost:8000", ORIGIN);
        }
    }

    private static String vast(String adId, String creativeId) {
        return "<VAST version=\"4.0\"><Ad id=\"" + adId + "\"><InLine><Impression>https://ads.iadserver.com/events/i</Impression>"
                + "<Creatives><Creative id=\"" + creativeId + "\"><Linear><Duration>00:00:15</Duration><MediaFiles>"
                + "<MediaFile delivery=\"progressive\" type=\"video/mp4\" width=\"1280\">https://c.example/ad.mp4</MediaFile>"
                + "</MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>";
    }

    private final AdPlanDriverTest.FakeHost host = new AdPlanDriverTest.FakeHost();
    private boolean ready;

    private static AdPlan read(String json) { return AdPlan.read(json, NOW, ORIGIN, null); }

    private AdPlanDriver started(String json) {
        AdPlan plan = read(json);
        assertNotNull(plan);
        AdPlanDriver driver = new AdPlanDriver(host, plan, "es");
        driver.start(() -> ready = true);
        return driver;
    }

    private static String grantOf(String url) { return AdPlan.query(url, "grant"); }

    // --- B. Plan versions -------------------------------------------------------------------------------------------

    @Test public void theAppPlanVersion1IsReadWithItsBreakRoute() throws Exception {
        String json = fixture("app-plan-v1.json");
        AdPlan plan = read(json);
        assertNotNull(plan);
        assertEquals(1, plan.version);
        JSONObject commerce = new JSONObject(json).getJSONObject("commerce");
        assertEquals(commerce.getString("break_url"), plan.breakUrl);
        assertEquals(grantOf(commerce.getString("url")), plan.grant);
        assertEquals("178311e8ffa4791646c0d0f6c728aa73", plan.sid);
        assertEquals("preroll", plan.cuts.get(0).position);
    }

    @Test public void aVersion2PlanIsAcceptedOnlyAsTheWebAcceptsIt() throws Exception {
        String json = fixture("app-plan-v2.json");
        AdPlan plan = read(json);
        assertNotNull(plan);
        assertEquals(2, plan.version);
        assertEquals(NOW + 120000, plan.expiresAtMs);
        JSONObject wrong = new JSONObject(json);
        wrong.getJSONObject("native_gam").put("contract", "native-gam-plan-v2");
        assertNull("another contract", read(wrong.toString()));
        JSONObject missing = new JSONObject(json);
        missing.remove("native_gam");
        assertNull("no native_gam", read(missing.toString()));
        assertNull("more than 120 s ahead", AdPlan.read(json, NOW - 1, ORIGIN, null));
        assertNull("expired", AdPlan.read(json, NOW + 120000, ORIGIN, null));
        assertNotNull("120 s ahead exactly", AdPlan.read(json, NOW, ORIGIN, null));
        JSONObject v3 = new JSONObject(json).put("version", 3);
        assertNull(read(v3.toString()));
        assertNull("version 1 with a far expiry stays fine, version 2 does not",
                read(new JSONObject(json).put("expires_at", "2026-11-02T17:00:00Z").toString()));
        assertNotNull(read(new JSONObject(fixture("app-plan-v1.json")).put("expires_at", "2026-11-02T17:00:00Z").toString()));
    }

    @Test public void theHostPlanHasNoCutsAndKeepsHostOne() throws Exception {
        AdPlan plan = read(fixture("host-plan.json"));
        assertNotNull(plan);
        assertTrue(plan.cuts.isEmpty());
        assertTrue(plan.breakUrl.contains("&host=1"));
        assertEquals("ed4c7d84521a3bc4faba519c687146f0", plan.sid);
    }

    @Test public void theBreakRouteNeedsThePlansSessionAndOrigin() throws Exception {
        String json = fixture("app-plan-v1.json");
        assertNull("a host view id gets the ad without the card", AdPlan.read(json, NOW, ORIGIN, "host-view").breakUrl);
        JSONObject foreign = new JSONObject(json);
        foreign.getJSONObject("commerce").put("break_url", "https://elsewhere.example/il-player/break-product?grant=x");
        assertNull(read(foreign.toString()).breakUrl);
    }

    // --- B. Expiry and renewal --------------------------------------------------------------------------------------

    @Test public void anExpiredVersion2PlanStopsOnTheTickAndSaysSo() throws Exception {
        host.replies.put("https://pubads.g.doubleclick.net", SUPER);
        host.replies.put(ORIGIN + "/il-player/scene-product", "");
        AdPlanDriver driver = started(fixture("app-plan-v2.json"));
        host.ima.started(0);
        host.ima.completed();
        host.playing = true;
        host.position = 15500;
        driver.tick();
        assertFalse(host.cues.isEmpty());
        host.now = NOW + 120000;
        host.position = 16000;
        int asked = host.fetched.size();
        driver.tick();
        assertEquals("plan_expired", host.events.get(host.events.size() - 1));
        assertTrue("nothing of the plan stays on screen", host.cues.isEmpty());
        host.position = 50000;
        driver.tick();
        assertEquals("nothing more is asked", asked, host.fetched.size());
        assertEquals(1, host.events.stream().filter("plan_expired"::equals).count());
    }

    @Test public void aSeekPastExpiryStopsThePlan() throws Exception {
        AdPlanDriver driver = started(fixture("app-plan-v2.json"));
        host.ima.started(0);
        host.ima.completed();
        host.playing = true;
        host.now = NOW + 121000;
        assertTrue(driver.checkExpired());
        assertEquals("plan_expired", host.events.get(host.events.size() - 1));
    }

    @Test public void expiryDuringABreakGivesTheContentBack() throws Exception {
        started(fixture("app-plan-v2.json"));
        assertFalse(ready);
        host.now = NOW + 120000;
        host.fire(250);
        assertTrue("the pre-roll's content comes back", ready);
        assertFalse(host.linear);
        assertTrue(host.events.contains("plan_expired"));
    }

    @Test public void aRenewalKeepsTheViewSessionAndPacing() throws Exception {
        host.replies.put("https://pubads.g.doubleclick.net", SUPER);
        host.replies.put(ORIGIN + "/il-player/scene-product", "");
        String v1 = fixture("app-plan-v1.json");
        // A short-lived copy of the first view: version 2, expiring in 120 s.
        JSONObject first = new JSONObject(v1).put("version", 2).put("expires_at", "2026-11-02T16:02:00Z")
                .put("native_gam", new JSONObject().put("contract", "native-gam-plan-v1"));
        AdPlanDriver driver = started(first.toString());
        host.ima.started(0);
        host.ima.completed();
        host.playing = true;
        assertEquals(1, host.events.stream().filter("break_start"::equals).count());
        host.position = 15500;
        driver.tick();
        driver.tick();
        int shownBefore = host.cues.size();
        assertEquals(1, shownBefore);
        long askedP2 = host.fetched.stream().filter(url -> url.contains("window=p2")).count();

        // The renewal arrives 100 s in: same session, new grant, new expiry.
        JSONObject renewed = new JSONObject(fixture("app-plan-renewed.json")).put("version", 2).put("expires_at", "2026-11-02T16:03:40Z")
                .put("native_gam", new JSONObject().put("contract", "native-gam-plan-v1"));
        host.now = NOW + 100000;
        AdPlan next = AdPlan.read(renewed.toString(), host.now, ORIGIN, null);
        assertNotNull(next);
        assertEquals("the server kept the commerce session", AdPlan.read(first.toString(), NOW, ORIGIN, null).sid, next.sid);
        // With the fixtures' frozen clock the renewed grant is byte-identical to the first one.
        assertNotNull(next.grant);
        driver.replace(next);

        host.position = 16000;
        driver.tick();
        assertEquals("p2 is not asked again", askedP2, host.fetched.stream().filter(url -> url.contains("window=p2")).count());
        assertEquals(shownBefore, host.cues.size());
        // The pre-roll was settled under the old plan: the renewed plan does not replay it.
        host.position = 500;
        driver.tick();
        assertEquals(1, host.events.stream().filter("break_start"::equals).count());
        // Past the old expiry the renewed plan is still in use.
        host.now = NOW + 130000;
        driver.tick();
        assertFalse(host.events.contains("plan_expired"));
    }

    @Test public void anExpiredPlanComesBackWithItsRenewal() throws Exception {
        host.replies.put("https://pubads.g.doubleclick.net", SUPER);
        host.replies.put(ORIGIN + "/il-player/scene-product", "");
        AdPlanDriver driver = started(fixture("app-plan-v2.json"));
        host.ima.started(0);
        host.ima.completed();
        host.playing = true;
        host.now = NOW + 120000;
        driver.tick();
        JSONObject renewed = new JSONObject(fixture("app-plan-v2.json")).put("expires_at", "2026-11-02T16:03:00Z");
        driver.replace(AdPlan.read(renewed.toString(), host.now, ORIGIN, null));
        host.position = 15500;
        driver.tick();
        driver.tick();
        assertEquals(1, host.cues.size());
    }

    // --- C. Buy during a break through commerce.break_url ---------------------------------------------------------

    @Test public void theBreakCardOfAPlanCutIsAskedExactlyAsTheReadmeSays() throws Exception {
        String json = fixture("app-plan-v1.json");
        String breakUrl = new JSONObject(json).getJSONObject("commerce").getString("break_url");
        host.replies.put("https://ads.iadserver.com/gampad/ads?tag=T_pre", vast("il-shop-preroll-" + DELIVERY, "cr1"));
        host.replies.put(breakUrl, fixture("break-product-card-page.json"));
        started(json);
        host.ima.started(0);
        String card = breakUrl + "&cut=pre&tag=T_pre&creative=cr1&delivery=" + DELIVERY + "&locale=es";
        assertEquals(card, host.fetched.get(host.fetched.size() - 1));
        assertEquals("cr1", host.cardCreative);
        assertEquals(DELIVERY, host.cardDelivery);
        assertNotNull(host.card);
        assertEquals("cr1", host.card.linearCreativeId);
        assertNotNull(host.card.commerce);
        assertNull("the feed identity is not used when the plan has break_url", host.creative);
        host.ima.completed();
        assertFalse(host.linear);
    }

    @Test public void noBreakCardWithoutAShopAdId() throws Exception {
        String json = fixture("app-plan-v1.json");
        host.replies.put("https://ads.iadserver.com/gampad/ads?tag=T_pre", vast("gam-123", "cr1"));
        started(json);
        host.ima.started(0);
        assertFalse(host.fetched.stream().anyMatch(url -> url.contains("break-product")));
        assertNull(host.card);
        assertNull(host.cardDelivery);
    }

    @Test public void aMidrollAdIdInAPrerollGetsNoCard() throws Exception {
        host.replies.put("https://ads.iadserver.com/gampad/ads?tag=T_pre", vast("il-shop-midroll-" + DELIVERY, "cr1"));
        started(fixture("app-plan-v1.json"));
        host.ima.started(0);
        assertFalse(host.fetched.stream().anyMatch(url -> url.contains("break-product")));
    }

    @Test public void aCardOfAnotherDeliveryIsNotDrawn() throws Exception {
        String json = fixture("app-plan-v1.json");
        String breakUrl = new JSONObject(json).getJSONObject("commerce").getString("break_url");
        String other = DELIVERY.replace('D', 'E');
        host.replies.put("https://ads.iadserver.com/gampad/ads?tag=T_pre", vast("il-shop-preroll-" + other, "cr1"));
        host.replies.put(breakUrl, fixture("break-product-card-page.json"));
        started(json);
        host.ima.started(0);
        assertTrue(host.fetched.get(host.fetched.size() - 1).contains("delivery=" + other));
        assertNull(host.card);
        assertEquals("error", host.events.get(host.events.size() - 1));
    }

    @Test public void withoutBreakUrlTheSessionFeedPathStays() throws Exception {
        JSONObject json = new JSONObject(fixture("app-plan-v1.json"));
        json.getJSONObject("commerce").remove("break_url");
        String spot = vast("il-shop-preroll-" + DELIVERY, "cr1").replace("</InLine>",
                "<Extensions><Extension type=\"iADServerShop\"><Shop deliveryId=\"d1\" creativeId=\"c1\"/></Extension></Extensions></InLine>");
        host.replies.put("https://ads.iadserver.com/gampad/ads?tag=T_pre", spot);
        started(json.toString());
        host.ima.started(0);
        assertEquals("c1", host.creative);
        assertEquals("d1", host.delivery);
        assertNull(host.cardDelivery);
    }

    // --- D. Host-driven breaks -------------------------------------------------------------------------------------

    @Test public void aReportedBreakDrawsOnlyTheBuyButtonOfItsAd() throws Exception {
        String json = fixture("host-plan.json");
        String breakUrl = new JSONObject(json).getJSONObject("commerce").getString("break_url");
        String tag = new JSONObject(fixture("break-request-stable.json")).getString("ad_tag_url");
        host.replies.put("https://pubads.g.doubleclick.net", SUPER);
        host.replies.put(ORIGIN + "/il-player/scene-product", "");
        host.replies.put(breakUrl, fixture("break-product-card.json"));
        AdPlanDriver driver = started(json);
        assertTrue("no video ad of IL's own: the content starts at once", ready);
        assertTrue(host.tags.isEmpty());
        host.position = 50500;
        driver.tick();
        driver.tick();
        assertEquals(1, host.cues.size());

        host.position = 58000;
        driver.breakStarted(58000);
        assertTrue(host.linear);
        int asked = host.fetched.size();
        for (int i = 0; i < 4; i++) driver.tick();
        assertEquals("nothing is asked during the app's break", asked, host.fetched.size());

        driver.hostAdStarted(tag, "il-shop-midroll-" + DELIVERY, "cr1");
        String card = breakUrl + "&cut=at-58000&tag=T_mid&creative=cr1&delivery=" + DELIVERY + "&locale=es";
        assertEquals(card, host.fetched.get(host.fetched.size() - 1));
        assertNotNull(host.card);
        assertEquals(DELIVERY, host.card.id);
        assertTrue(host.tags.isEmpty());

        driver.hostAdEnded();
        assertTrue("still in the break", host.linear);
        assertNull("the card goes with its ad", host.creative);
        driver.breakEnded();
        assertFalse(host.linear);
        // t1 (175-178 s): m2 at 60 s is too close to m1 for the 30 s spacing of the pacing.
        host.position = 175100;
        driver.tick();
        driver.tick();
        assertTrue("graphics come back after the break", host.fetched.stream().anyMatch(url -> url.contains("viajes")));
        assertTrue(host.events.contains("host_break_start"));
        assertTrue(host.events.contains("host_break_end"));
    }

    @Test public void aGraphicAnsweredDuringAReportedBreakIsDiscarded() throws Exception {
        String json = fixture("host-plan.json");
        AdPlanDriverTest.FakeHost slow = new AdPlanDriverTest.FakeHost() {
            final List<Runnable> held = new ArrayList<>();
            @Override public void foreground(Runnable task) { held.add(task); }
            { pendingAnswers = held; }
        };
        slow.replies.put("https://pubads.g.doubleclick.net", SUPER);
        slow.replies.put(ORIGIN + "/il-player/scene-product", "");
        AdPlanDriver driver = new AdPlanDriver(slow, read(json), "es");
        driver.start(null);
        slow.position = 50500;
        driver.tick();
        driver.breakStarted(51000);
        for (Runnable task : new ArrayList<>(slow.pendingAnswers)) task.run();
        assertTrue("an answer that arrives during the break is not drawn", slow.cues.isEmpty());
    }

    @Test public void thePrerollOfTheAppIsAtZeroAndTakesARawVast() throws Exception {
        String json = fixture("host-plan.json");
        String breakUrl = new JSONObject(json).getJSONObject("commerce").getString("break_url");
        host.replies.put(breakUrl, fixture("break-product-card.json"));
        AdPlanDriver driver = started(json);
        driver.breakStarted(0);
        driver.hostAdStarted("https://ads.iadserver.com/gampad/ads?tag=T_pre&sid=x", vast("il-shop-preroll-" + DELIVERY, "cr1"));
        assertEquals(breakUrl + "&cut=at-0&tag=T_pre&creative=cr1&delivery=" + DELIVERY + "&locale=es",
                host.fetched.get(host.fetched.size() - 1));
    }

    @Test public void aGamAdOrAnAdWithoutTheShopIdAsksNothing() throws Exception {
        AdPlanDriver driver = started(fixture("host-plan.json"));
        driver.breakStarted(178000);
        driver.hostAdStarted(new JSONObject(fixture("break-request-gam.json")).getString("ad_tag_url"), "il-shop-midroll-" + DELIVERY, "cr1");
        driver.hostAdStarted("https://ads.iadserver.com/gampad/ads?tag=T_mid", "123456", "cr1");
        driver.hostAdStarted("https://ads.iadserver.com/gampad/ads?tag=T_mid", "<VAST version=\"4.0\"/>");
        assertFalse(host.fetched.stream().anyMatch(url -> url.contains("break-product")));
        assertNull(host.card);
    }

    @Test public void setBreaksKeepsTheClearanceAroundTheAppsBreaks() throws Exception {
        JSONObject json = new JSONObject(fixture("host-plan.json"));
        json.getJSONObject("scenes").getJSONObject("pacing").put("cut_clearance_seconds", 5);
        host.replies.put("https://pubads.g.doubleclick.net", SUPER);
        host.replies.put(ORIGIN + "/il-player/scene-product", "");
        AdPlanDriver driver = started(json.toString());
        driver.setBreaks(new long[] {52000});
        host.position = 47000;
        driver.tick();
        driver.tick();
        assertFalse("m1 (50-58 s) is too close to the break at 52 s", host.fetched.stream().anyMatch(url -> url.contains("doubleclick")));
        driver.setBreaks(new long[0]);
        driver.tick();
        driver.tick();
        assertTrue(host.fetched.stream().anyMatch(url -> url.contains("doubleclick")));
    }

    @Test public void aHostThatReportsNothingGetsGraphicsByContentTimeAndNoBuy() throws Exception {
        host.replies.put("https://pubads.g.doubleclick.net", SUPER);
        host.replies.put(ORIGIN + "/il-player/scene-product", "");
        AdPlanDriver driver = started(fixture("host-plan.json"));
        host.position = 1000;
        driver.tick();
        driver.tick();
        assertEquals(1, host.cues.size());
        driver.hostAdStarted(new JSONObject(fixture("break-request-stable.json")).getString("ad_tag_url"), "il-shop-midroll-" + DELIVERY, "cr1");
        assertFalse("no break was reported: no Buy", host.fetched.stream().anyMatch(url -> url.contains("break-product")));
    }

    // --- A. Loading the plan ---------------------------------------------------------------------------------------

    private static final String PROJECT = "proj_8e4cb338d66e4ec6bc6b99fd21f651f6";
    private static final String ASSET = "asset-40edc822d6f24974a9af51695a88184b";

    private static final class Answer implements AdPlanLoader.Listener {
        String json, type, detail;
        int calls;
        @Override public void loaded(String body) { json = body; calls++; }
        @Override public void unavailable(String kind, String why) { type = kind; detail = why; calls++; }
    }

    private static AdPlanLoader loader(AdPlanLoader.Http http) {
        return new AdPlanLoader(http, ORIGIN, PROJECT, ASSET, AdPlanLoader.appId("com.example.tv"));
    }

    @Test public void theLoaderBuildsTheExactAppPlanUrl() throws Exception {
        List<String> asked = new ArrayList<>();
        AdPlanLoader loader = loader((url, body) -> { asked.add(url); return 204; });
        assertEquals(ORIGIN + "/il-player/app-plan?project=" + PROJECT + "&asset=" + ASSET + "&app=android%3Acom.example.tv", loader.url(null));
        String grant = read(fixture("app-plan-v1.json")).grant;
        loader.fetch(grant, new Answer());
        assertEquals(loader.url(null) + "&renew=" + grant, asked.get(0));
        assertEquals("android:com.example.tv", AdPlanLoader.appId("com.example.tv"));
        assertEquals(ORIGIN, new AdPlanLoader(AdPlanLoader.HTTPS, ORIGIN + "/", PROJECT, ASSET, "android:a.b").origin);
    }

    @Test public void theLoaderRefusesAnythingButAnHttpsOrigin() {
        for (String origin : new String[] {"http://console.example", ORIGIN + "/il-player", "https://user@console.example", "nope"}) {
            try {
                new AdPlanLoader(AdPlanLoader.HTTPS, origin, PROJECT, ASSET, "android:a.b");
                fail(origin);
            } catch (IllegalArgumentException expected) {
                // The library's HTTPS-only rule.
            }
        }
    }

    @Test public void theLoaderHandles200204404AndTimeouts() throws Exception {
        String plan = fixture("app-plan-v1.json");
        Answer ok = new Answer();
        loader((url, body) -> { body.append(plan); return 200; }).fetch(null, ok);
        assertEquals(plan, ok.json);
        Answer none = new Answer();
        loader((url, body) -> 204).fetch(null, none);
        assertEquals("plan_unavailable", none.type);
        Answer missing = new Answer();
        loader((url, body) -> 404).fetch(null, missing);
        assertEquals("plan_not_found", missing.type);
        assertEquals("the app= value sent, to check its registration", "app=android:com.example.tv", missing.detail);
        Answer slow = new Answer();
        loader((url, body) -> { throw new SocketTimeoutException("read timed out"); }).fetch(null, slow);
        assertEquals("plan_error", slow.type);
        Answer broken = new Answer();
        loader((url, body) -> 500).fetch(null, broken);
        assertEquals("plan_error", broken.type);
        for (Answer answer : new Answer[] {ok, none, missing, slow, broken}) assertEquals(1, answer.calls);
        assertTrue("bounded like the reader's other requests", AdPlanLoader.TIMEOUT_MS <= 2500 && AdPlanLoader.LOAD_TIMEOUT_MS <= 8000);
    }

    @Test public void aVersion2PlanIsRenewed20SecondsBeforeItExpires() throws Exception {
        assertEquals(100000, AdPlanLoader.renewDelay(read(fixture("app-plan-v2.json")), NOW));
        assertEquals(-1, AdPlanLoader.renewDelay(read(fixture("app-plan-v1.json")), NOW));
        assertEquals(0, AdPlanLoader.renewDelay(read(fixture("app-plan-v2.json")), NOW + 110000));
    }

    @Test public void theFixturesAreTheSharedCopies() throws Exception {
        for (String name : new String[] {"app-plan-v1.json", "app-plan-v2.json", "app-plan-renewed.json", "host-plan.json",
                "break-product-card.json", "break-product-card-page.json", "scene-product-card.json",
                "break-request-stable.json", "break-request-gam.json", "playback-created.json"}) {
            new JSONObject(fixture(name));
        }
        assertEquals(0, new JSONArray(new JSONObject(fixture("host-plan.json")).getJSONArray("cuts").toString()).length());
    }
}

package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class AdPlanTest {
    private static final String GAM = "https://pubads.g.doubleclick.net/gampad/ads?iu=/1/a&cust_params=x%3D1";
    private static final String IAD = "https://ads.iadserver.com/gampad/ads?tag=t&output=vast";
    private static final long NOW = 1700000000000L;

    private static JSONObject window(String id, long start, long end) throws Exception {
        return new JSONObject().put("id", id).put("start_ms", start).put("end_ms", end);
    }

    private static JSONObject plan() throws Exception {
        JSONObject scenes = new JSONObject()
                .put("formats", new JSONArray().put("l_shape").put("super").put("overlay_300x250"))
                .put("graphics", new JSONArray()
                        .put(new JSONObject().put("format", "super").put("tag_url", GAM))
                        .put(new JSONObject().put("format", "l_shape").put("tag_url", GAM))
                        .put(new JSONObject().put("format", "super").put("tag_url", "https://evil.example/ads")))
                .put("pacing", new JSONObject().put("min_seconds", 5).put("max_seconds", 12).put("gap_after_seconds", 2)
                        .put("cut_clearance_seconds", 3).put("max_per_video", 2))
                .put("windows", new JSONArray().put(window("w3", 55000, 75000)).put(window("w2", 20000, 35000))
                        .put(window("w1", 10000, 25000).put("targeting", new JSONObject().put("topic", new JSONArray().put("a").put("b")))));
        return new JSONObject().put("version", 1).put("expires_at", "2099-01-01T00:00:00Z").put("page_url", "https://site.example/v")
                .put("cuts", new JSONArray()
                        .put(new JSONObject().put("id", "mid").put("at", 60).put("requests", new JSONArray()
                                .put(new JSONObject().put("provider", "iadserver").put("tag_url", IAD))
                                .put(new JSONObject().put("provider", "gam").put("tag_url", GAM))
                                .put(new JSONObject().put("provider", "evil").put("tag_url", "https://evil.example/"))))
                        .put(new JSONObject().put("id", "pre").put("at", 0).put("tag_url", GAM))
                        .put(new JSONObject().put("id", "bad").put("at", 5).put("requests", new JSONArray()
                                .put(new JSONObject().put("provider", "gam").put("tag_url", "http://pubads.g.doubleclick.net/gampad/ads")))))
                .put("scenes", scenes);
    }

    private static AdPlan read(JSONObject plan) { return AdPlan.read(plan.toString(), NOW, "https://il.example", "sid1"); }

    private static String graphicVast(String width, String height, String image) {
        return "<VAST version=\"4.0\"><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><NonLinearAds>"
                + "<TrackingEvents><Tracking event=\"creativeView\">https://t.example/v</Tracking></TrackingEvents>"
                + "<NonLinear width=\"" + width + "\" height=\"" + height + "\" minSuggestedDuration=\"00:00:05\">"
                + "<StaticResource creativeType=\"image/png\"><![CDATA[" + image + "]]></StaticResource></NonLinear>"
                + "</NonLinearAds></Creative></Creatives></InLine></Ad></VAST>";
    }

    @Test public void readsCutsInOrderWithOnlyAllowedRequests() throws Exception {
        AdPlan read = read(plan());
        assertEquals(2, read.cuts.size());
        assertEquals("pre", read.cuts.get(0).id);
        assertEquals(2, read.cuts.get(1).requests.size());
        assertTrue(read.cuts.get(1).requests.get(0).tagUrl.contains("sid=sid1"));
        assertFalse(read.cuts.get(1).requests.get(1).tagUrl.contains("sid="));
        assertTrue(read.cuts.get(1).requests.get(1).tagUrl.contains("description_url="));
    }

    @Test public void appliesWindowCapsClearanceAndGraphicOrder() throws Exception {
        AdPlan read = read(plan());
        assertEquals("l_shape", read.graphics.get(0).format);
        assertEquals(2, read.graphics.size());
        assertEquals(2, read.windows.size());
        assertEquals("w1", read.windows.get(0).id);
        assertEquals(22000, read.windows.get(0).end);
    }

    @Test public void refusesExpiredStitchedAndUnknownPlans() throws Exception {
        assertNull(read(plan().put("expires_at", "2001-01-01T00:00:00Z")));
        assertNull(read(plan().put("version", 2)));
        assertNull(read(plan().put("timeline", new JSONObject().put("kind", "stitched"))));
        assertNull(AdPlan.read("not json", NOW, null, "s"));
    }

    @Test public void takesAProductOnlyFromThePlanOrigin() throws Exception {
        JSONObject commerce = new JSONObject().put("kind", "scene_product").put("url", "https://other.example/p").put("lead_ms", 1000)
                .put("pacing", new JSONObject().put("min_seconds", 5)).put("windows", new JSONArray().put(window("w1", 10000, 25000)));
        assertNull(read(plan().put("commerce", commerce)).shop);
        commerce.put("url", "https://il.example/p?g=1");
        AdPlan read = read(plan().put("commerce", commerce));
        assertNotNull(read.shop);
        assertEquals("https://il.example/p?g=1&window=w%201&locale=es", read.productUrl("w 1", "es-AR"));
    }

    @Test public void schedulesBreaksWithoutABacklog() throws Exception {
        AdPlan.Schedule schedule = read(plan()).schedule();
        assertEquals("pre", schedule.join(0).id);
        schedule.settled.add("pre");
        assertNull(schedule.dueCut(59000));
        assertEquals("mid", schedule.dueCut(60500).id);
        AdPlan.Schedule late = read(plan()).schedule();
        assertNull(late.join(5000));
        assertTrue(late.settled.contains("pre"));
        assertNull(late.dueCut(90000));
        assertTrue(late.settled.contains("mid"));
    }

    @Test public void pacingSpacesGraphics() throws Exception {
        AdPlan read = read(plan());
        AdPlan.Schedule schedule = read.schedule();
        assertNull(schedule.nextGraphic(5000));
        AdPlan.Window first = schedule.nextGraphic(7000);
        assertEquals("w1", first.id);
        schedule.attempted.add(first.id);
        schedule.shown.add(first);
        assertNull("the next window starts under 30 s later", schedule.nextGraphic(21000));
    }

    @Test public void aWindowWaitsForItsProduct() throws Exception {
        JSONObject commerce = new JSONObject().put("kind", "scene_product").put("url", "https://il.example/p").put("lead_ms", 1000)
                .put("pacing", new JSONObject().put("min_seconds", 5)).put("windows", new JSONArray().put(window("w1", 10000, 25000)));
        AdPlan.Schedule schedule = read(plan().put("commerce", commerce)).schedule();
        assertNull(schedule.nextGraphic(7000));
        schedule.products.put("w1", "empty");
        assertEquals("w1", schedule.nextGraphic(7000).id);
    }

    @Test public void buildsTheGraphicTag() throws Exception {
        String tag = AdPlan.graphicTag(GAM, "super", new JSONObject().put("topic", new JSONArray().put("a").put("b")), "https://p.example/");
        String params = AdPlan.query(tag, "cust_params");
        assertTrue(params, params.contains("x=1") && params.contains("il_format=super") && params.contains("topic=a%2Cb"));
        assertFalse(AdPlan.query(tag, "correlator").isEmpty());
        assertEquals("https://p.example/", AdPlan.query(tag, "description_url"));
    }

    @Test public void readsOnlyGraphicsItCanDraw() {
        AdPlan.GraphicAd ad = AdPlan.parseGraphic(graphicVast("600", "90", "https://c.example/a.png"), "super", 9000);
        assertEquals("https://c.example/a.png", ad.imageUrl);
        assertEquals(2, ad.impressions.size());
        assertNull(AdPlan.parseGraphic("<VAST version=\"4.0\"></VAST>", "super", 9000).imageUrl);
        assertNull(AdPlan.parseGraphic(graphicVast("600", "90", "https://c.example/a.png"), "l_shape", 9000));
        assertNull(AdPlan.parseGraphic(graphicVast("600", "90", "http://c.example/a.png"), "super", 9000));
        assertNull(AdPlan.parseGraphic(graphicVast("600", "90", "https://c.example/a.png"), "super", 3000));
        assertNull(AdPlan.parseGraphic("<!DOCTYPE x><VAST/>", "super", 9000));
        assertNull(AdPlan.parseGraphic("<VAST><Ad><Wrapper/></Ad></VAST>", "super", 9000));
    }

    @Test public void readsLinearAdsThroughWrappers() {
        AdPlan.LinearAd out = new AdPlan.LinearAd();
        assertTrue(AdPlan.parseLinear("<VAST><Ad><Wrapper><Impression>https://t.example/w</Impression>"
                + "<VASTAdTagURI><![CDATA[https://next.example/v]]></VASTAdTagURI></Wrapper></Ad></VAST>", out));
        assertEquals("https://next.example/v", out.wrapperUrl);
        assertTrue(AdPlan.parseLinear("<VAST><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><Linear>"
                + "<Duration>00:00:20</Duration><TrackingEvents><Tracking event=\"midpoint\">https://t.example/m</Tracking></TrackingEvents>"
                + "<MediaFiles><MediaFile delivery=\"progressive\" type=\"video/mp4\" width=\"3840\">https://c.example/4k.mp4</MediaFile>"
                + "<MediaFile delivery=\"progressive\" type=\"video/mp4\" width=\"1280\">https://c.example/ad.mp4</MediaFile></MediaFiles>"
                + "</Linear></Creative></Creatives><Extensions><Extension type=\"iADServerShop\"><Shop deliveryId=\"d1\" creativeId=\"c1\"/></Extension></Extensions>"
                + "</InLine></Ad></VAST>", out));
        assertNull(out.wrapperUrl);
        assertEquals("https://c.example/ad.mp4", out.mediaUrl);
        assertEquals(20000, out.durationMs);
        assertEquals(2, out.impressions.size());
        assertEquals("c1", out.creativeId);
        assertEquals("d1", out.deliveryId);
        assertFalse(AdPlan.parseLinear("<VAST version=\"4.0\"></VAST>", new AdPlan.LinearAd()));
    }

    private static JSONObject shop() throws Exception {
        return new JSONObject().put("kind", "scene_product").put("url", "https://il.example/p").put("lead_ms", 1000)
                .put("session", "plan-s").put("pacing", new JSONObject().put("min_seconds", 5))
                .put("windows", new JSONArray().put(window("w1", 10000, 25000)));
    }

    @Test public void theSidIsTheHostsThenThePlansThenAFreshOne() throws Exception {
        AdPlan host = AdPlan.read(plan().put("commerce", shop()).toString(), NOW, "https://il.example", "host-s");
        assertEquals("host-s", host.sid);
        assertFalse(host.breakShop);
        assertTrue(host.cuts.get(1).requests.get(0).tagUrl.contains("sid=host-s"));
        AdPlan planned = AdPlan.read(plan().put("commerce", shop()).toString(), NOW, "https://il.example", "");
        assertEquals("plan-s", planned.sid);
        assertTrue(planned.breakShop);
        AdPlan fresh = AdPlan.read(plan().toString(), NOW, "https://il.example", null);
        assertEquals(32, fresh.sid.length());
        assertFalse(fresh.breakShop);
        assertTrue(fresh.cuts.get(1).requests.get(0).tagUrl.contains("sid=" + fresh.sid));
    }

    @Test public void readsWhatTheWebReaderReads() throws Exception {
        assertNull("scenes without pacing void the plan",
                read(plan().put("scenes", new JSONObject().put("formats", new JSONArray()).put("windows", new JSONArray()))));
        assertNull("nothing to play", read(new JSONObject().put("version", 1).put("expires_at", "2099-01-01T00:00:00Z")));
        JSONObject half = plan();
        half.getJSONObject("scenes").put("windows", new JSONArray().put(window("w1", 10000, 25000))
                .put(new JSONObject().put("id", "half").put("start_ms", 10000.5).put("end_ms", 25000)));
        assertEquals(1, read(half).windows.size());
        JSONObject fraction = plan();
        fraction.getJSONObject("scenes").getJSONObject("pacing").put("max_per_video", 1.5);
        assertNull(read(fraction));
        assertNull(read(plan().put("commerce", shop().put("lead_ms", 10.5))).shop);
        assertEquals("https://pubads.g.doubleclick.net/gampad/ads?iu=/1#f",
                AdPlan.canonicalTag("gam", "https://PUBADS.g.doubleclick.net:443/gampad/./ads?iu=/1#f"));
        assertEquals("https://ads.iadserver.com/gampad/ads", AdPlan.canonicalTag("iadserver", "https://ads.iadserver.com/x/../gampad/ads"));
        assertNull(AdPlan.canonicalTag("gam", "https://pubads.g.doubleclick.net:8443/gampad/ads"));
        assertNull(AdPlan.canonicalTag("gam", "https://u:p@pubads.g.doubleclick.net/gampad/ads"));
        assertNull(AdPlan.canonicalTag("iadserver", "https://ads.iadserver.com.evil.example/gampad/ads"));
    }

    @Test public void passesTheConsentTheAppStored() {
        java.util.Map<String, Object> stored = new java.util.HashMap<>();
        AdPlan.consent = () -> stored;
        try {
            assertFalse(AdPlan.correlated(GAM).contains("gdpr"));
            stored.put("IABTCF_gdprApplies", 1);
            stored.put("IABTCF_TCString", "CPtc");
            stored.put("IABUSPrivacy_String", "1YNN");
            stored.put("IABGPP_HDR_GppString", "DBABMA~x");
            stored.put("IABGPP_GppSID", "2_7");
            String tag = AdPlan.correlated(GAM);
            for (String part : new String[] {"gdpr=1", "gdpr_consent=CPtc", "us_privacy=1YNN", "gpp=DBABMA~x", "gpp_sid=2%2C7", "correlator="}) {
                assertTrue(part + " in " + tag, tag.contains(part));
            }
            assertTrue(AdPlan.graphicTag(GAM, "super", null, null).contains("gdpr_consent=CPtc"));
        } finally {
            AdPlan.consent = java.util.Collections::emptyMap;
        }
    }
}

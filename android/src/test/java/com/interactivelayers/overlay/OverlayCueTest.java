package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public final class OverlayCueTest {
    private static final long START = 1795046400000L;
    private static final String RANGE = "#EXT-X-DATERANGE:ID=\"break,1\","
            + "CLASS=\"com.interactivelayers.overlay\",START-DATE=\"2026-11-18T21:00:00-03:00\","
            + "DURATION=2.250,X-IL-FORMAT=\"super\",X-ASSET-URI=\"https://media.example/card,a?b=c\","
            + "X-ASSET-MIMETYPE=\"image/png\",X-IL-IMPRESSION-URI=\"https://events.example/i\"";

    @Test public void parsesQuotedCommasAndExplicitTimezoneAtMillisecondPrecision() {
        OverlayCue cue = OverlayCue.fromTag(RANGE);
        assertNotNull(cue);
        assertEquals("break,1", cue.id);
        assertEquals("super", cue.format);
        assertEquals(START, cue.start);
        assertEquals(START + 2250, cue.end);
        assertEquals("https://media.example/card,a?b=c", cue.imageUrl);
        assertEquals("image/png", cue.mimeType);
        assertEquals("https://events.example/i", cue.impressionUrl);
    }

    @Test public void supportsExplicitEndWithOrWithoutMatchingDuration() {
        String end = "END-DATE=\"2026-11-19T00:00:02.250Z\"";
        assertEquals(START + 2250, OverlayCue.fromTag(RANGE.replace("DURATION=2.250", end)).end);
        assertEquals(START + 2250, OverlayCue.fromTag(RANGE + "," + end).end);
    }

    @Test public void ignoresOtherClassesAndRejectsMalformedOverlays() {
        for (String bad : Arrays.asList(
                RANGE.replace("com.interactivelayers.overlay", "com.apple.hls.interstitial"),
                RANGE.replace("com.interactivelayers.overlay", "com.teinformas.program"),
                RANGE.replace("super", "linear"),
                RANGE.replace("image/png", "image/svg+xml"),
                RANGE.replace("2026-11-18T21:00:00-03:00", "2026-11-18T21:00:00"),
                RANGE.replace("2026-11-18", "2026-11-31"),
                RANGE.replace("2.250", "0"),
                RANGE.replace("2.250", "-4"),
                RANGE.replace("2.250", "2.250e0"),
                RANGE + ",END-DATE=\"2026-11-19T00:01:00Z\"",
                RANGE.replace("break,1", "  "),
                RANGE.replace("https://media.example", "/relative"),
                RANGE.replace("https://media.example", "http://media.example"),
                RANGE.replace("https://events.example", "javascript:"),
                RANGE + ",ID=\"duplicate\"",
                RANGE.substring(0, RANGE.length() - 1))) {
            assertNull(bad, OverlayCue.fromTag(bad));
        }
    }

    @Test public void parsesSidecarAsStrictAbsoluteWindows() {
        String valid = "{\"id\":\"v1\",\"format\":\"l\",\"start\":1795046400000,"
                + "\"end\":1795046402250,\"imageUrl\":\"https://media.example/art\"}";
        String json = "[" + valid.replace("1795046400000", "\"1795046400000\"") + ","
                + valid.replace("1795046400000", "1795046400000.5") + ","
                + valid.replace("1795046402250", "1795046400000") + ","
                + valid.replace("https://media.example", "file:///") + ","
                + valid.replace("\"v1\"", "123") + "," + valid + "]";
        List<OverlayCue> cues = OverlayCue.fromSidecar(json);
        assertEquals(1, cues.size());
        assertEquals("v1", cues.get(0).id);
        assertEquals("l", cues.get(0).format);
        assertNull(cues.get(0).impressionUrl);
        assertTrue(OverlayCue.fromSidecar("{oops").isEmpty());
    }

    @Test public void decodesOffersWithoutPassingUnsafeCheckoutUrls() {
        String offer = "[{\"id\":\"shop\",\"format\":\"overlay\",\"start\":1,\"end\":10001,"
                + "\"imageUrl\":\"https://merchant.example/boot.jpg\",\"commerce\":{"
                + "\"title\":\"Botas\",\"currency\":\"BRL\",\"locale\":\"pt-BR\",\"price\":\"27.00\","
                + "\"handoffUrl\":\"https://ads.example/cart\","
                + "\"variants\":[{\"id\":\"var-2\",\"label\":\"Tam. 40\"}]}}]";
        OverlayCue cue = OverlayCue.fromSidecar(offer).get(0);
        assertEquals("Tam. 40", cue.commerce.variants.get(0).label);
        assertEquals("27.00", cue.commerce.variants.get(0).price.toPlainString());
        assertEquals("pt-BR", cue.commerce.locale);
        assertTrue(OverlayCue.fromSidecar(offer.replace("https://ads.example", "http://ads.example")).isEmpty());
        assertNull(OverlayCue.fromTag(RANGE.replace("super", "overlay")));
    }

    @Test public void parsesSceneOnlyCueAndResolvesTheSelectedProduct() throws Exception {
        String source;
        try (java.io.InputStream data = getClass().getResourceAsStream("/creative-scene.json")) {
            source = new String(data.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
        OverlayCue cue = OverlayCue.fromSidecar("[" + source + "]").get(0);
        assertEquals("runtime-creative", cue.id);
        assertNull(cue.imageUrl);
        assertEquals("overlay", cue.layout);
        assertEquals("cap", cue.scene.offerAt(1).id);
        assertEquals("green", cue.scene.offerAt(1).commerce.variants.get(1).id);
        OverlayScene.Layer headline = cue.scene.layers.get(2);
        OverlayScene.Frame frame = headline.frame(500);
        assertEquals(1520f, frame.x, 0.001f);
        assertEquals(420f, frame.y, 0.001f);
        assertEquals(.875f, frame.opacity, 0.001f);
        assertFalse(headline.frame(3100).visible);
    }

    @Test public void invalidFallbackDoesNotDiscardAnOtherwiseValidScene() throws Exception {
        org.json.JSONObject row;
        try (java.io.InputStream data = getClass().getResourceAsStream("/creative-scene.json")) {
            row = new org.json.JSONObject(new String(data.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
        }
        row.put("imageUrl", "https://assets.example/optional-art");
        for (Object mime : Arrays.asList("video/mp4", "image/gif", 42)) {
            row.put("mimeType", mime);
            List<OverlayCue> cues = OverlayCue.fromSidecar(new org.json.JSONArray().put(row).toString());
            assertEquals(1, cues.size());
            assertNotNull(cues.get(0).scene);
            assertNull(cues.get(0).imageUrl);
            assertNull(cues.get(0).mimeType);
        }
        row.remove("scene");
        assertTrue(OverlayCue.fromSidecar(new org.json.JSONArray().put(row).toString()).isEmpty());
    }

    private static org.json.JSONObject sceneRow() throws Exception {
        try (java.io.InputStream data = OverlayCueTest.class.getResourceAsStream("/creative-scene.json")) {
            return new org.json.JSONObject(new String(data.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
        }
    }

    private static List<OverlayCue> parse(org.json.JSONObject row) throws Exception {
        return OverlayCue.fromSidecar(new org.json.JSONArray().put(row).toString());
    }

    @Test public void dropsASceneLayerWhoseGeometryExceedsTheSupportedRange() throws Exception {
        org.json.JSONObject row = sceneRow();
        row.getJSONObject("scene").getJSONArray("layers").getJSONObject(0).put("width", 3e38);
        List<OverlayScene.Layer> layers = parse(row).get(0).scene.layers;
        assertEquals(6, layers.size());
        for (OverlayScene.Layer layer : layers) assertNotEquals("background", layer.id);
    }

    @Test public void ignoresKeyframeValuesThatWouldOverflowInterpolation() throws Exception {
        org.json.JSONObject row = sceneRow();
        row.getJSONObject("scene").getJSONArray("layers").getJSONObject(2).put("keyframes", new org.json.JSONArray(
                "[{\"timeMs\":1000,\"scale\":-3e38},{\"timeMs\":2000,\"scale\":3e38}]"));
        OverlayScene.Frame frame = parse(row).get(0).scene.layers.get(2).frame(1500);
        assertEquals(1f, frame.scale, 0f);
    }

    @Test public void rejectsASceneWhoseCanvasIsSmallerThanOnePixel() throws Exception {
        org.json.JSONObject row = sceneRow();
        row.getJSONObject("scene").put("width", 1e-30);
        assertTrue(parse(row).isEmpty());
    }

    @Test public void aSceneOnlyTakesTouchesOnItsOwnArea() {
        // In a 1000×500 player the super spans x 125–875, y 350–450 and the overlay x 640–940, y 50–210.
        assertTrue(SceneViews.takesTouch("super", 500, 400, 1000, 500));
        assertFalse(SceneViews.takesTouch("super", 500, 100, 1000, 500));
        assertFalse(SceneViews.takesTouch("super", 50, 400, 1000, 500));
        assertTrue(SceneViews.takesTouch("overlay", 700, 100, 1000, 500));
        assertFalse(SceneViews.takesTouch("overlay", 300, 300, 1000, 500));
        // The L keeps the right and bottom bands and leaves the program in the upper-left corner.
        assertTrue(SceneViews.takesTouch("l", 900, 100, 1000, 500));
        assertTrue(SceneViews.takesTouch("l", 100, 450, 1000, 500));
        assertFalse(SceneViews.takesTouch("l", 100, 100, 1000, 500));
    }

    @Test public void selectsUsingTheLivePositionIncludingStartAndExcludingEnd() {
        List<OverlayCue> cues = OverlayCue.fromTags(Arrays.asList("#EXTINF:6,", RANGE, RANGE));
        assertEquals(1, cues.size());
        assertNull(OverlayCue.at(cues, START - 1));
        assertEquals("break,1", OverlayCue.at(cues, START).id);
        assertEquals("break,1", OverlayCue.at(cues, START + 2249).id);
        assertNull(OverlayCue.at(cues, START + 2250));
        assertEquals("break,1", OverlayCue.at(cues, START + 50).id);
    }
}

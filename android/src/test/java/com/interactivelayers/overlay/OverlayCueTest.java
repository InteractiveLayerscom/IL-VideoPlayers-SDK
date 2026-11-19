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

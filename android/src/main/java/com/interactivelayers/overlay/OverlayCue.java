package com.interactivelayers.overlay;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.URISyntaxException;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class OverlayCue {
    private static final String PREFIX = "#EXT-X-DATERANGE:";
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final Pattern ATTRIBUTE = Pattern.compile(
            "([A-Z0-9-]+)=(?:\"([^\"\\r\\n]*)\"|([^,\\s\"]+))(,|$)");
    private static final Pattern TIMESTAMP = Pattern.compile(
            "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d+))?(Z|[+-]\\d{2}:\\d{2})");
    private static final Pattern DECIMAL = Pattern.compile("\\d+(?:\\.\\d+)?");

    final String id;
    final String format;
    final long start;
    final long end;
    final String imageUrl;
    final String mimeType;
    final String impressionUrl;
    final OverlayCommerce commerce;

    private OverlayCue(String id, String format, long start, long end, String imageUrl,
                       String mimeType, String impressionUrl, OverlayCommerce commerce) {
        this.id = id;
        this.format = format;
        this.start = start;
        this.end = end;
        this.imageUrl = imageUrl;
        this.mimeType = mimeType;
        this.impressionUrl = impressionUrl;
        this.commerce = commerce;
    }

    private static OverlayCue validate(String id, String format, long start, long end,
                                       String imageUrl, String mimeType, String impressionUrl, OverlayCommerce commerce) {
        if (id == null || id.trim().isEmpty() || id.length() > 256 || start < 0 || end <= start
                || end > MAX_SAFE_INTEGER || !("super".equals(format) || "l".equals(format)
                        || ("overlay".equals(format) && commerce != null))
                || !isHttps(imageUrl) || (impressionUrl != null && !isHttps(impressionUrl))
                || (mimeType != null && !isStaticImage(mimeType))) return null;
        return new OverlayCue(id, format, start, end, imageUrl, mimeType, impressionUrl, commerce);
    }

    static boolean isHttps(String value) {
        if (value == null) return false;
        try {
            URI uri = new URI(value);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
                    && uri.getRawUserInfo() == null;
        } catch (URISyntaxException e) {
            return false;
        }
    }

    static boolean isStaticImage(String type) {
        return "image/png".equals(type) || "image/jpeg".equals(type);
    }

    static List<OverlayCue> fromTags(List<String> tags) {
        List<OverlayCue> cues = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (String tag : tags) {
            OverlayCue cue = fromTag(tag);
            if (cue != null && ids.add(cue.id)) cues.add(cue);
        }
        return cues;
    }

    static OverlayCue fromTag(String tag) {
        if (!tag.startsWith(PREFIX)) return null;
        Map<String, String> fields = new HashMap<>();
        Matcher attributes = ATTRIBUTE.matcher(tag);
        int index = PREFIX.length();
        while (index < tag.length()) {
            attributes.region(index, tag.length());
            if (!attributes.lookingAt()) return null;
            String value = attributes.group(2) != null ? attributes.group(2) : attributes.group(3);
            if (fields.put(attributes.group(1), value) != null) return null;
            index = attributes.end();
            if (index == tag.length() && !attributes.group(4).isEmpty()) return null;
        }
        if (!"com.interactivelayers.overlay".equals(fields.get("CLASS"))) return null;
        try {
            long start = timestamp(fields.get("START-DATE"));
            long end = -1;
            if (fields.containsKey("DURATION")) {
                String seconds = fields.get("DURATION");
                if (!DECIMAL.matcher(seconds).matches()) return null;
                long duration = new BigDecimal(seconds).movePointRight(3)
                        .setScale(0, RoundingMode.HALF_UP).longValueExact();
                if (duration <= 0 || duration > MAX_SAFE_INTEGER - start) return null;
                end = start + duration;
            }
            if (fields.containsKey("END-DATE")) {
                long absoluteEnd = timestamp(fields.get("END-DATE"));
                if (end >= 0 && absoluteEnd != end) return null;
                end = absoluteEnd;
            }
            return validate(fields.get("ID"), fields.get("X-IL-FORMAT"), start, end,
                    fields.get("X-ASSET-URI"), fields.get("X-ASSET-MIMETYPE"),
                    fields.get("X-IL-IMPRESSION-URI"), null);
        } catch (ParseException | ArithmeticException e) {
            return null;
        }
    }

    // SimpleDateFormat is available on Fire OS and API 23 without core-library desugaring.
    private static long timestamp(String value) throws ParseException {
        Matcher date = TIMESTAMP.matcher(value == null ? "" : value);
        if (!date.matches()) throw new ParseException("Expected ISO date with offset", 0);
        String fraction = date.group(2);
        String milliseconds = ((fraction == null ? "" : fraction) + "000").substring(0, 3);
        String zone = "Z".equals(date.group(3)) ? "+0000" : date.group(3).replace(":", "");
        SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US);
        parser.setLenient(false);
        return parser.parse(date.group(1) + "." + milliseconds + zone).getTime();
    }

    static List<OverlayCue> fromSidecar(String json) {
        JSONArray entries;
        try {
            entries = new JSONArray(json);
        } catch (JSONException e) {
            return Collections.emptyList();
        }
        List<OverlayCue> cues = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject item = entries.optJSONObject(i);
            if (item == null) continue;
            Object mime = item.opt("mimeType");
            Object impression = item.opt("impressionUrl");
            if ((!item.isNull("mimeType") && !(mime instanceof String))
                    || (!item.isNull("impressionUrl") && !(impression instanceof String))) continue;
            OverlayCue cue = validate(string(item.opt("id")), string(item.opt("format")),
                    integer(item.opt("start")), integer(item.opt("end")), string(item.opt("imageUrl")),
                    string(mime), string(impression), OverlayCommerce.parse(item.optJSONObject("commerce")));
            if (cue != null && ids.add(cue.id)) cues.add(cue);
        }
        return cues;
    }

    private static String string(Object value) {
        return value instanceof String ? (String) value : null;
    }

    private static long integer(Object value) {
        if (!(value instanceof Number)) return -1;
        try {
            return new BigDecimal(value.toString()).longValueExact();
        } catch (ArithmeticException | NumberFormatException e) {
            return -1;
        }
    }

    static OverlayCue at(Iterable<OverlayCue> cues, long timeMs) {
        for (OverlayCue cue : cues) {
            if (cue.start <= timeMs && timeMs < cue.end) return cue;
        }
        return null;
    }
}

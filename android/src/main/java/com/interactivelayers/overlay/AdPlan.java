package com.interactivelayers.overlay;

import java.io.ByteArrayInputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.parsers.DocumentBuilderFactory;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

/** IL's ad plan, read with the rules of web/ads.mjs. No Android or network access here. */
final class AdPlan {
    private static final long MIN_START_SPACING_MS = 30000;
    private static final long LATE_MS = 2000;
    static final long PREPARE_MS = 4000;
    private static final int MAX_REQUESTS = 3;
    private static final Pattern OVERLAY_UNIT = Pattern.compile("^/\\d+(/[^\\s/]+)*$");
    private static final Pattern SID = Pattern.compile("^[A-Za-z0-9_.:-]{1,128}$");
    private static final Pattern DURATION = Pattern.compile("^(\\d{2}):([0-5]\\d):([0-5]\\d(?:\\.\\d{1,3})?)$");
    private static final Set<String> UNSUPPORTED = new HashSet<>(java.util.Arrays.asList("Wrapper", "AdVerifications",
            "ViewableImpression", "InteractiveCreativeFile", "AdParameters", "Icon", "CompanionAds", "Linear",
            "HTMLResource", "IFrameResource"));
    private static final Random RANDOM = new Random();

    static final class Request {
        final String provider, tagUrl;
        Request(String provider, String tagUrl) { this.provider = provider; this.tagUrl = tagUrl; }
    }

    static final class Cut {
        final String id;
        final long atMs;
        final List<Request> requests;
        /** {@code preroll} or {@code midroll}: it must match the position in a shop-linked ad's {@code Ad@id}. */
        final String position;
        Cut(String id, long atMs, List<Request> requests, String position) {
            this.id = id; this.atMs = atMs; this.requests = requests; this.position = position;
        }
    }

    static final class Window {
        final String id;
        final long start, end;
        final JSONObject targeting;
        Window(String id, long start, long end, JSONObject targeting) {
            this.id = id; this.start = start; this.end = end; this.targeting = targeting;
        }
    }

    static final class Pacing {
        final long minMs, gapMs, clearanceMs;
        final Long maxMs;
        final Integer maxPerVideo;
        Pacing(long minMs, Long maxMs, long gapMs, long clearanceMs, Integer maxPerVideo) {
            this.minMs = minMs; this.maxMs = maxMs; this.gapMs = gapMs; this.clearanceMs = clearanceMs; this.maxPerVideo = maxPerVideo;
        }
    }

    static final class Graphic {
        final String format, tagUrl;
        Graphic(String format, String tagUrl) { this.format = format; this.tagUrl = tagUrl; }
    }

    static final class Shop {
        final String url;
        final long leadMs;
        final Pacing pacing;
        final List<Window> windows;
        Shop(String url, long leadMs, Pacing pacing, List<Window> windows) {
            this.url = url; this.leadMs = leadMs; this.pacing = pacing; this.windows = windows;
        }
    }

    /** A static graphic, or an answer with no fill when {@code imageUrl} is null. */
    static final class GraphicAd {
        final String imageUrl, mimeType;
        final List<String> impressions;
        GraphicAd(String imageUrl, String mimeType, List<String> impressions) {
            this.imageUrl = imageUrl; this.mimeType = mimeType; this.impressions = impressions;
        }
    }

    /** One step of a linear answer: a wrapper to follow, a playable ad, or nothing. */
    static final class LinearAd {
        String wrapperUrl, mediaUrl, creativeId, deliveryId;
        /** VAST {@code Ad@id} of the first answer and {@code Creative@id} of the playing linear, as IMA exposes them. */
        String adId, linearCreativeId;
        long durationMs;
        final List<String> impressions = new ArrayList<>();
        final Map<String, List<String>> tracking = new HashMap<>();
    }

    final List<Cut> cuts;
    final List<Window> windows;
    final List<Graphic> graphics;
    final Pacing pacing;
    final Shop shop;
    final String page;
    final int version;
    final long expiresAtMs;
    /** {@code commerce.break_url}, only when Buy during a break may use it (as web/ads.mjs {@code breakUrl}). */
    final String breakUrl;
    /** The {@code grant} of {@code commerce.url}: what a renewal sends as {@code renew}. Null without one. */
    final String grant;
    private final JSONArray sceneWindows;
    /** The {@code sid} on every iADServer request, chosen as web/ads.mjs does. */
    final String sid;
    /** Buy during a break: IL's grant names the plan's session, so only when the sid is that session. */
    final boolean breakShop;

    private AdPlan(List<Cut> cuts, List<Window> windows, List<Graphic> graphics, Pacing pacing, Shop shop, String page,
                   String sid, boolean breakShop, int version, long expiresAtMs, String breakUrl, String grant, JSONArray sceneWindows) {
        this.cuts = cuts; this.windows = windows; this.graphics = graphics; this.pacing = pacing; this.shop = shop; this.page = page;
        this.sid = sid; this.breakShop = breakShop; this.version = version; this.expiresAtMs = expiresAtMs;
        this.breakUrl = breakUrl; this.grant = grant; this.sceneWindows = sceneWindows;
    }

    /** A version 2 plan is a short-lived native GAM approval: at most this far ahead (web/ads.mjs readPlan). */
    static final long NATIVE_MAX_AHEAD_MS = 120000;

    /** Where the app's consent platform keeps the IAB strings (the default SharedPreferences). */
    interface ConsentStore { Map<String, ?> read(); }

    static volatile ConsentStore consent = Collections::emptyMap;

    /**
     * Adds the consent the app's CMP stored under the IAB keys (TCF v2, US Privacy, GPP) as the standard ad
     * request parameters. Nothing stored, nothing added.
     */
    static String withConsent(String url) {
        Map<String, ?> stored;
        try {
            stored = consent.read();
        } catch (RuntimeException e) {
            return url;
        }
        if (stored == null) return url;
        String out = url;
        Object applies = stored.get("IABTCF_gdprApplies");
        if (applies instanceof Number) out = setQuery(out, "gdpr", ((Number) applies).intValue() == 1 ? "1" : "0");
        out = putText(out, "gdpr_consent", stored.get("IABTCF_TCString"));
        out = putText(out, "us_privacy", stored.get("IABUSPrivacy_String"));
        out = putText(out, "gpp", stored.get("IABGPP_HDR_GppString"));
        Object sections = stored.get("IABGPP_GppSID");
        if (sections instanceof String && !((String) sections).isEmpty()) out = setQuery(out, "gpp_sid", ((String) sections).replace('_', ','));
        return out;
    }

    private static String putText(String url, String key, Object value) {
        return value instanceof String && !((String) value).isEmpty() ? setQuery(url, key, (String) value) : url;
    }

    /** A JSON integer that fits a safe integer, as {@code Number.isSafeInteger}. */
    static Long integer(Object value) {
        if (!(value instanceof Number)) return null;
        double number = ((Number) value).doubleValue();
        if (Double.isNaN(number) || Double.isInfinite(number) || Math.rint(number) != number || Math.abs(number) > 9007199254740991d) return null;
        return value instanceof Integer || value instanceof Long ? ((Number) value).longValue() : (long) number;
    }

    private static String randomId() {
        StringBuilder out = new StringBuilder();
        java.security.SecureRandom bytes = new java.security.SecureRandom();
        for (int i = 0; i < 16; i++) out.append(String.format(Locale.US, "%02x", bytes.nextInt(256)));
        return out.toString();
    }

    /** {@code https://host[:port]} with the host lowercased and the default port dropped, as a WHATWG URL origin. */
    static String origin(String text) {
        try {
            java.net.URI uri = new java.net.URI(text);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getHost() == null || uri.getHost().isEmpty()) return null;
            int port = uri.getPort();
            return "https://" + uri.getHost().toLowerCase(Locale.ROOT) + (port == -1 || port == 443 ? "" : ":" + port);
        } catch (java.net.URISyntaxException e) {
            return null;
        }
    }

    /** What web/ads.mjs accepts: the exact origin and the path {@code /gampad/ads} once parsed and normalised. Null otherwise. */
    static String canonicalTag(String provider, String url) {
        String expected = "gam".equals(provider) ? "https://pubads.g.doubleclick.net"
                : "iadserver".equals(provider) ? "https://ads.iadserver.com" : null;
        if (expected == null || url == null || url.matches("(?s).*\\s.*") || !expected.equals(origin(url))) return null;
        try {
            java.net.URI uri = new java.net.URI(url);
            String path = uri.getRawPath() == null ? "" : uri.getRawPath().replaceAll("(?i)%2e", ".");
            if (!"/gampad/ads".equals(new java.net.URI(null, null, path, null).normalize().getRawPath())) return null;
            return expected + "/gampad/ads" + (uri.getRawQuery() != null ? "?" + uri.getRawQuery() : "")
                    + (uri.getRawFragment() != null ? "#" + uri.getRawFragment() : "");
        } catch (java.net.URISyntaxException e) {
            return null;
        }
    }

    /**
     * Null for anything but a current plan on a timeline this player can follow: version 1, or version 2 with the
     * native GAM contract and an expiry no more than 120 s ahead, as web/ads.mjs readPlan.
     */
    static AdPlan read(String json, long nowMs, String origin, String sessionId) {
        try {
            JSONObject plan = new JSONObject(json);
            Long version = integer(plan.opt("version"));
            if (version == null || (version != 1 && version != 2) || !(plan.opt("expires_at") instanceof String)) return null;
            long expires = OverlayCue.timestamp(plan.getString("expires_at"));
            if (expires <= nowMs) return null;
            if (version == 2) {
                JSONObject nativeGam = plan.optJSONObject("native_gam");
                if (nativeGam == null || !"native-gam-plan-v1".equals(nativeGam.opt("contract")) || expires - nowMs > NATIVE_MAX_AHEAD_MS) return null;
            }
            // Stitched windows are content time and need a clock that knows when an ad is in the stream.
            if (!plan.isNull("timeline")) return null;
            String page = plan.opt("page_url") instanceof String ? plan.getString("page_url") : null;
            JSONObject commerce = plan.optJSONObject("commerce");
            // As on the web, `scenes` that are present but unusable void the whole plan.
            JSONObject scenes = null;
            Pacing pacing = null;
            if (!plan.isNull("scenes")) {
                scenes = plan.optJSONObject("scenes");
                pacing = scenes == null ? null : readPacing(scenes.optJSONObject("pacing"));
                if (pacing == null || scenes.optJSONArray("formats") == null || scenes.optJSONArray("windows") == null) return null;
            } else if (plan.optJSONArray("cuts") == null && !shopUsable(commerce)) {
                return null;
            }
            boolean shopValid = readShop(commerce, origin, Collections.<Long>emptyList()) != null;
            String shopSession = shopValid && commerce.opt("session") instanceof String
                    && SID.matcher(commerce.getString("session")).matches() ? commerce.getString("session") : null;
            // The host's own view id first, then the plan's session, then a fresh id for this playback.
            String session = sessionId != null && !sessionId.isEmpty() ? sessionId : shopSession != null ? shopSession : randomId();
            List<Cut> cuts = readCuts(plan.optJSONArray("cuts"), page, session);
            List<Long> breaks = new ArrayList<>();
            for (Cut cut : cuts) breaks.add(cut.atMs);
            List<Window> windows = Collections.emptyList();
            List<Graphic> graphics = Collections.emptyList();
            if (scenes != null) {
                windows = readWindows(scenes.getJSONArray("windows"), pacing, breaks);
                graphics = readGraphics(scenes);
            }
            boolean breakShop = shopSession != null && shopSession.equals(session);
            // As web/ads.mjs: the break product route on the scene product's own origin, for the plan's session only.
            String breakUrl = null;
            if (breakShop && commerce.opt("break_url") instanceof String) {
                String candidate = commerce.getString("break_url");
                String own = origin(candidate);
                if (own != null && own.equals(origin(commerce.getString("url")))) breakUrl = candidate;
            }
            String grant = commerce != null && commerce.opt("url") instanceof String ? query(commerce.getString("url"), "grant") : "";
            return new AdPlan(cuts, windows, graphics, pacing, readShop(commerce, origin, breaks), page, session, breakShop,
                    version.intValue(), expires, breakUrl, grant.isEmpty() ? null : grant,
                    scenes == null ? null : scenes.getJSONArray("windows"));
        } catch (JSONException | ParseException e) {
            return null;
        }
    }

    private static Pacing readPacing(JSONObject pacing) {
        if (pacing == null || !(pacing.opt("min_seconds") instanceof Number)) return null;
        for (String key : new String[] {"max_seconds", "gap_after_seconds", "cut_clearance_seconds", "max_per_video"}) {
            if (!pacing.isNull(key) && !(pacing.opt(key) instanceof Number)) return null;
        }
        if (!pacing.isNull("max_per_video") && integer(pacing.opt("max_per_video")) == null) return null;
        return new Pacing(ms(pacing.optDouble("min_seconds")), pacing.isNull("max_seconds") ? null : ms(pacing.optDouble("max_seconds")),
                pacing.isNull("gap_after_seconds") ? 0 : ms(pacing.optDouble("gap_after_seconds")),
                pacing.isNull("cut_clearance_seconds") ? 0 : ms(pacing.optDouble("cut_clearance_seconds")),
                pacing.isNull("max_per_video") ? null : pacing.optInt("max_per_video"));
    }

    private static boolean shopUsable(JSONObject commerce) {
        if (commerce == null || !"scene_product".equals(commerce.opt("kind")) || !(commerce.opt("url") instanceof String)) return false;
        Long lead = integer(commerce.opt("lead_ms"));
        return lead != null && lead >= 0 && readPacing(commerce.optJSONObject("pacing")) != null
                && commerce.optJSONArray("windows") != null && OverlayCue.isHttps(commerce.optString("url"));
    }

    private static Shop readShop(JSONObject commerce, String origin, List<Long> breaks) throws JSONException {
        if (origin == null || !origin.startsWith("https://") || !shopUsable(commerce)) return null;
        String url = commerce.getString("url");
        String own = origin(url);
        if (own == null || !own.equals(origin(origin))) return null;
        Pacing pacing = readPacing(commerce.optJSONObject("pacing"));
        return new Shop(url, integer(commerce.opt("lead_ms")), pacing, readWindows(commerce.getJSONArray("windows"), pacing, breaks));
    }

    private static List<Cut> readCuts(JSONArray source, String page, String session) throws JSONException {
        List<Cut> cuts = new ArrayList<>();
        if (source == null) return cuts;
        for (int i = 0; i < source.length(); i++) {
            JSONObject cut = source.optJSONObject(i);
            if (cut == null || !(cut.opt("id") instanceof String) || !(cut.opt("at") instanceof Number) || cut.optDouble("at") < 0) continue;
            JSONArray entries = cut.optJSONArray("requests");
            if (entries == null) entries = new JSONArray().put(new JSONObject().put("provider", "gam").put("tag_url", cut.opt("tag_url")));
            List<Request> requests = new ArrayList<>();
            for (int j = 0; j < entries.length() && requests.size() < MAX_REQUESTS; j++) {
                JSONObject entry = entries.optJSONObject(j);
                if (entry == null || !(entry.opt("tag_url") instanceof String) || !(entry.opt("provider") instanceof String)) continue;
                String provider = entry.getString("provider"), url = canonicalTag(provider, entry.getString("tag_url"));
                if (url == null) continue;
                if ("gam".equals(provider) && page != null) url = setQuery(setQuery(url, "url", page), "description_url", page);
                if ("iadserver".equals(provider) && session != null && !session.isEmpty()) url = setQuery(url, "sid", session);
                requests.add(new Request(provider, url));
            }
            String position = cut.opt("position") instanceof String ? cut.getString("position") : null;
            if (!requests.isEmpty()) cuts.add(new Cut(cut.getString("id"), ms(cut.optDouble("at")), requests, position));
        }
        Collections.sort(cuts, Comparator.comparingLong(cut -> cut.atMs));
        return cuts;
    }

    private static List<Graphic> readGraphics(JSONObject scenes) throws JSONException {
        Map<String, String> tags = new LinkedHashMap<>();
        JSONArray graphics = scenes.optJSONArray("graphics");
        for (int i = 0; graphics != null && i < graphics.length(); i++) {
            JSONObject graphic = graphics.optJSONObject(i);
            if (graphic == null || !(graphic.opt("format") instanceof String) || !(graphic.opt("tag_url") instanceof String)) continue;
            String format = graphic.getString("format");
            String tag = canonicalTag("gam", graphic.getString("tag_url"));
            if (("super".equals(format) || "l_shape".equals(format)) && !tags.containsKey(format) && tag != null) {
                tags.put(format, tag);
            }
        }
        List<Graphic> result = new ArrayList<>();
        JSONArray formats = scenes.getJSONArray("formats");
        JSONObject overlay = scenes.optJSONObject("overlay");
        if (overlay != null && overlay.opt("ad_unit") instanceof String && OVERLAY_UNIT.matcher(overlay.getString("ad_unit")).matches()) {
            tags.put("overlay_300x250", overlay.getString("ad_unit"));
        }
        for (int i = 0; i < formats.length(); i++) {
            String tag = tags.remove(formats.optString(i));
            if (tag != null) result.add(new Graphic(formats.getString(i), tag));
        }
        return result;
    }

    private static List<Window> readWindows(JSONArray source, Pacing pacing, List<Long> breaks) {
        List<Window> result = new ArrayList<>();
        for (int i = 0; i < source.length(); i++) {
            JSONObject window = source.optJSONObject(i);
            if (window == null || !(window.opt("id") instanceof String) || integer(window.opt("start_ms")) == null
                    || integer(window.opt("end_ms")) == null) continue;
            long start = integer(window.opt("start_ms")), end = integer(window.opt("end_ms"));
            if (pacing.maxMs != null) end = Math.min(end, start + pacing.maxMs);
            if (pacing.clearanceMs > 0) {
                for (long cut : breaks) {
                    if (cut <= start && start < cut + pacing.clearanceMs) start = cut + pacing.clearanceMs;
                    else if (start < cut && cut < end + pacing.clearanceMs) end = Math.min(end, cut - pacing.clearanceMs);
                }
            }
            if (end - start >= pacing.minMs) result.add(new Window(window.optString("id"), start, end, window.optJSONObject("targeting")));
        }
        Collections.sort(result, Comparator.comparingLong(entry -> entry.start));
        return result;
    }

    private static long ms(double seconds) { return Math.round(seconds * 1000); }

    static boolean pacingAllows(Window window, List<Window> shown, Pacing pacing) {
        if (pacing.maxPerVideo != null && shown.size() >= pacing.maxPerVideo) return false;
        for (Window other : shown) {
            boolean clear = other.start <= window.start
                    ? window.start - other.start >= MIN_START_SPACING_MS && window.start >= other.end + pacing.gapMs
                    : other.start - window.start >= MIN_START_SPACING_MS && other.start >= window.end + pacing.gapMs;
            if (!clear) return false;
        }
        return true;
    }

    /** What has been asked and shown in one playback. */
    final class Schedule {
        final Set<String> settled;
        final Set<String> attempted;
        final Map<String, String> products;
        final List<Window> shown;
        final List<Window> pending;
        boolean overlayAvailable;
        /** The scene windows, cleared around the plan's cuts or around the breaks the host reported. */
        List<Window> sceneWindows = windows;

        Schedule() {
            settled = new HashSet<>(); attempted = new HashSet<>(); products = new HashMap<>();
            shown = new ArrayList<>(); pending = new ArrayList<>();
        }

        /** A renewed plan continues the same view: what was settled, attempted and shown stays (web: nativeViews). */
        Schedule(Schedule view) {
            settled = view.settled; attempted = view.attempted; products = view.products;
            shown = view.shown; pending = view.pending; overlayAvailable = view.overlayAvailable;
        }

        private List<Graphic> servable() {
            if (overlayAvailable) return graphics;
            List<Graphic> images = new ArrayList<>();
            for (Graphic graphic : graphics) if (!"overlay_300x250".equals(graphic.format)) images.add(graphic);
            return images;
        }

        /** Marks breaks behind a late start and returns the pre-roll if it is still due. */
        Cut join(long positionMs) {
            Cut preroll = null;
            for (Cut cut : cuts) {
                if (cut.atMs == 0 && positionMs <= 1000) preroll = cut;
                else if (cut.atMs <= positionMs) settled.add(cut.id);
            }
            return preroll;
        }

        /** The break due now. A seek past several breaks plays none of the backlog. */
        Cut dueCut(long nowMs) {
            Cut due = null;
            for (Cut cut : cuts) {
                if (settled.contains(cut.id) || cut.atMs > nowMs) continue;
                if (due != null) settled.add(due.id);
                due = cut;
            }
            if (due == null) return null;
            settled.add(due.id);
            return due.atMs > 0 && nowMs - due.atMs > LATE_MS ? null : due;
        }

        List<Window> committed() {
            List<Window> all = new ArrayList<>(shown);
            all.addAll(pending);
            return all;
        }

        private boolean eligible(Window window, Pacing rules, long leadMs, long nowMs) {
            return window.start - leadMs <= nowMs && nowMs < window.end
                    && window.end - Math.max(window.start, nowMs) >= rules.minMs && pacingAllows(window, committed(), rules);
        }

        Window nextProduct(long nowMs) {
            if (shop == null) return null;
            for (Window window : shop.windows) {
                if (!products.containsKey(window.id) && eligible(window, shop.pacing, shop.leadMs, nowMs)) return window;
            }
            return null;
        }

        private boolean productAwaited(Window window, long nowMs) {
            if (shop == null) return false;
            if (products.containsKey(window.id)) return !"empty".equals(products.get(window.id));
            for (Window entry : shop.windows) {
                if (entry.id.equals(window.id)) return eligible(entry, shop.pacing, 0, Math.max(nowMs, entry.start));
            }
            return false;
        }

        Window nextGraphic(long nowMs) {
            if (pacing == null || servable().isEmpty()) return null;
            for (Window window : sceneWindows) {
                if (!attempted.contains(window.id) && eligible(window, pacing, PREPARE_MS, nowMs) && !productAwaited(window, nowMs)) return window;
            }
            return null;
        }

        Graphic graphicFor() {
            List<Graphic> list = servable();
            return list.get(shown.size() % list.size());
        }
    }

    Schedule schedule() { return new Schedule(); }

    /** This plan's schedule carrying on the view of {@code view}, the schedule of the plan it renews. */
    Schedule schedule(Schedule view) { return new Schedule(view); }

    /** The scene windows with the clearance kept around {@code breaks} instead of the plan's cuts (web: setBreaks). */
    List<Window> windowsAround(List<Long> breaks) {
        return sceneWindows == null ? windows : readWindows(sceneWindows, pacing, breaks);
    }

    /** iADServer names a shop-linked ad {@code il-shop-<position>-<delivery>} (web/ads.mjs SHOP_AD). */
    static final Pattern SHOP_AD = Pattern.compile("^il-shop-(preroll|midroll)-([A-Za-z0-9_-]{43})$");

    /** The break product URL: {@code commerce.break_url} verbatim with the five parameters appended. */
    String breakProductUrl(String cut, String tag, String creative, String delivery, String locale) {
        int hash = breakUrl.indexOf('#');
        String base = hash >= 0 ? breakUrl.substring(0, hash) : breakUrl;
        String fragment = hash >= 0 ? breakUrl.substring(hash) : "";
        String joiner = base.indexOf('?') < 0 ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
        return base + joiner + "cut=" + form(cut) + "&tag=" + form(tag) + "&creative=" + form(creative)
                + "&delivery=" + form(delivery) + "&locale=" + form(OverlayCommerce.language(locale)) + fragment;
    }

    // As URLSearchParams serialises: application/x-www-form-urlencoded, a space as `+`.
    private static String form(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8").replace("%7E", "~");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * The break card for exactly this ad, or null: web/ads.mjs accepts only a {@code midroll} card whose id is the
     * delivery and whose creative is the playing one. It follows the ad, not the content clock.
     */
    static OverlayCue breakCue(String json, String creativeId, String deliveryId) {
        try {
            JSONObject card = new JSONObject(json);
            if (!deliveryId.equals(card.opt("id")) || !creativeId.equals(card.opt("linearCreativeId")) || !"midroll".equals(card.opt("format"))) return null;
            card.put("start", 0).put("end", 9007199254740991L);
            List<OverlayCue> cues = OverlayCue.fromSidecar(new JSONArray().put(card).toString());
            return cues.size() == 1 && cues.get(0).commerce != null ? cues.get(0) : null;
        } catch (JSONException e) {
            return null;
        }
    }

    /** {@code [Ad@id, Creative@id]} of the first ad's linear creative in a VAST the host's player received. */
    static String[] vastIdentity(String xml) {
        Element root = document(xml);
        if (root == null) return null;
        List<Element> ads = children(root, "Ad");
        if (ads.isEmpty()) return null;
        org.w3c.dom.NodeList linears = ads.get(0).getElementsByTagName("Linear");
        if (linears.getLength() == 0) return null;
        Node creative = linears.item(0).getParentNode();
        String creativeId = creative instanceof Element && "Creative".equals(((Element) creative).getTagName())
                ? ((Element) creative).getAttribute("id") : "";
        return new String[] {ads.get(0).getAttribute("id"), creativeId};
    }

    static String setQuery(String url, String key, String value) {
        int hash = url.indexOf('#');
        String fragment = hash >= 0 ? url.substring(hash) : "";
        String base = hash >= 0 ? url.substring(0, hash) : url;
        int mark = base.indexOf('?');
        StringBuilder out = new StringBuilder(mark >= 0 ? base.substring(0, mark) : base).append('?');
        if (mark >= 0) {
            for (String pair : base.substring(mark + 1).split("&")) {
                if (!pair.isEmpty() && !pair.split("=", 2)[0].equals(key)) out.append(pair).append('&');
            }
        }
        return out.append(key).append('=').append(encode(value)).append(fragment).toString();
    }

    static String query(String url, String key) {
        int mark = url.indexOf('?');
        if (mark < 0) return "";
        String tail = url.substring(mark + 1);
        int hash = tail.indexOf('#');
        if (hash >= 0) tail = tail.substring(0, hash);
        for (String pair : tail.split("&")) {
            String[] parts = pair.split("=", 2);
            if (parts[0].equals(key) && parts.length == 2) {
                try {
                    return URLDecoder.decode(parts[1], "UTF-8");
                } catch (UnsupportedEncodingException | IllegalArgumentException e) {
                    return "";
                }
            }
        }
        return "";
    }

    private static String encode(String value) {
        try {
            // As encodeURIComponent: `~` stays literal (GPP strings use it as a separator).
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20").replace("%7E", "~");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    static String correlated(String url) {
        return withConsent(setQuery(url, "correlator", System.currentTimeMillis() + String.format(Locale.US, "%06d", RANDOM.nextInt(1000000))));
    }

    static String graphicTag(String tagUrl, String format, JSONObject targeting, String page) {
        Map<String, String> params = new LinkedHashMap<>();
        for (String pair : query(tagUrl, "cust_params").split("&")) {
            String[] parts = pair.split("=", 2);
            if (!parts[0].isEmpty()) params.put(parts[0], parts.length == 2 ? parts[1] : "");
        }
        if (targeting != null) {
            java.util.Iterator<String> keys = targeting.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = targeting.opt(key);
                if (value instanceof JSONArray) {
                    List<String> parts = new ArrayList<>();
                    for (int i = 0; i < ((JSONArray) value).length(); i++) parts.add(String.valueOf(((JSONArray) value).opt(i)));
                    value = joinValues(parts);
                }
                params.put(key, encode(String.valueOf(value)));
            }
        }
        params.put("il_format", format);
        StringBuilder joined = new StringBuilder();
        for (Map.Entry<String, String> entry : params.entrySet()) {
            if (joined.length() > 0) joined.append('&');
            joined.append(entry.getKey()).append('=').append(entry.getValue());
        }
        String url = setQuery(tagUrl, "cust_params", joined.toString());
        if (page != null) url = setQuery(setQuery(url, "url", page), "description_url", page);
        return correlated(url);
    }

    private static String joinValues(List<String> parts) {
        StringBuilder out = new StringBuilder();
        for (String part : parts) {
            if (out.length() > 0) out.append(',');
            out.append(part);
        }
        return out.toString();
    }

    private static Element document(String xml) {
        if (xml == null || xml.length() > 262144 || xml.toLowerCase(Locale.US).contains("<!doctype")) return null;
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setExpandEntityReferences(false);
            Document doc = factory.newDocumentBuilder().parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
            Element root = doc.getDocumentElement();
            return "VAST".equals(root.getTagName()) ? root : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static List<Element> children(Element parent, String name) {
        List<Element> found = new ArrayList<>();
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element && name.equals(((Element) node).getTagName())) found.add((Element) node);
        }
        return found;
    }

    private static Element one(Element parent, String name) {
        if (parent == null) return null;
        List<Element> found = children(parent, name);
        return found.size() == 1 ? found.get(0) : null;
    }

    private static boolean hasUnsupported(Element node) {
        if (UNSUPPORTED.contains(node.getTagName())) return true;
        for (Node child = node.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child instanceof Element && hasUnsupported((Element) child)) return true;
        }
        return false;
    }

    private static String text(Element node) { return node.getTextContent().trim(); }

    private static double seconds(String value) {
        Matcher match = DURATION.matcher(value == null ? "" : value.trim());
        if (!match.matches()) return -1;
        return Integer.parseInt(match.group(1)) * 3600 + Integer.parseInt(match.group(2)) * 60 + Double.parseDouble(match.group(3));
    }

    /** Null for anything this static image renderer cannot draw; an empty VAST has a null imageUrl. */
    static GraphicAd parseGraphic(String xml, String format, long availableMs) {
        Element root = document(xml);
        if (root == null) return null;
        List<Element> ads = children(root, "Ad");
        if (ads.isEmpty()) return new GraphicAd(null, null, Collections.<String>emptyList());
        if (ads.size() != 1 || hasUnsupported(ads.get(0))) return null;
        Element inline = one(ads.get(0), "InLine");
        Element container = one(one(one(inline, "Creatives"), "Creative"), "NonLinearAds");
        Element nonLinear = one(container, "NonLinear");
        Element resource = one(nonLinear, "StaticResource");
        if (resource == null || nonLinear.hasAttribute("apiFramework")) return null;
        String mime = resource.getAttribute("creativeType").toLowerCase(Locale.US);
        if (!OverlayCue.isStaticImage(mime)) return null;
        double width, height;
        try {
            width = Double.parseDouble(nonLinear.getAttribute("width"));
            height = Double.parseDouble(nonLinear.getAttribute("height"));
        } catch (NumberFormatException e) {
            return null;
        }
        double shape = "super".equals(format) ? 20d / 3 : 16d / 9;
        if (width <= 0 || height <= 0 || Math.abs(width / height / shape - 1) > 0.02) return null;
        if (nonLinear.hasAttribute("minSuggestedDuration")) {
            double minimum = seconds(nonLinear.getAttribute("minSuggestedDuration"));
            if (minimum < 0 || minimum * 1000 > availableMs) return null;
        }
        String image = text(resource);
        if (!OverlayCue.isHttps(image)) return null;
        List<String> urls = new ArrayList<>();
        for (Element node : children(inline, "Impression")) {
            if (!OverlayCue.isHttps(text(node))) return null;
            urls.add(text(node));
        }
        for (Element list : children(container, "TrackingEvents")) {
            for (Element tracking : children(list, "Tracking")) {
                if (!"creativeView".equals(tracking.getAttribute("event"))) continue;
                if (!OverlayCue.isHttps(text(tracking))) return null;
                urls.add(text(tracking));
            }
        }
        return new GraphicAd(image, mime, urls);
    }

    private static void collect(Element ad, LinearAd out) {
        org.w3c.dom.NodeList impressions = ad.getElementsByTagName("Impression");
        for (int i = 0; i < impressions.getLength(); i++) {
            String url = impressions.item(i).getTextContent().trim();
            if (OverlayCue.isHttps(url)) out.impressions.add(url);
        }
        org.w3c.dom.NodeList events = ad.getElementsByTagName("Tracking");
        for (int i = 0; i < events.getLength(); i++) {
            Element tracking = (Element) events.item(i);
            String url = text(tracking);
            if (!OverlayCue.isHttps(url)) continue;
            List<String> list = out.tracking.get(tracking.getAttribute("event"));
            if (list == null) out.tracking.put(tracking.getAttribute("event"), list = new ArrayList<>());
            list.add(url);
        }
    }

    /** Adds this answer to {@code out}. False means no playable ad. */
    static boolean parseLinear(String xml, LinearAd out) {
        out.wrapperUrl = null;
        Element root = document(xml);
        if (root == null) return false;
        List<Element> ads = children(root, "Ad");
        if (ads.isEmpty()) return false;
        Element ad = ads.get(0);
        if (out.adId == null) out.adId = ad.getAttribute("id");
        collect(ad, out);
        Element wrapper = one(ad, "Wrapper");
        if (wrapper != null) {
            Element next = one(wrapper, "VASTAdTagURI");
            if (next == null || !OverlayCue.isHttps(text(next))) return false;
            out.wrapperUrl = text(next);
            return true;
        }
        org.w3c.dom.NodeList linears = ad.getElementsByTagName("Linear");
        if (linears.getLength() == 0) return false;
        Element linear = (Element) linears.item(0);
        if (linear.getParentNode() instanceof Element && "Creative".equals(((Element) linear.getParentNode()).getTagName())) {
            out.linearCreativeId = ((Element) linear.getParentNode()).getAttribute("id");
        }
        org.w3c.dom.NodeList files = linear.getElementsByTagName("MediaFile");
        int widest = -1;
        for (int i = 0; i < files.getLength(); i++) {
            Element file = (Element) files.item(i);
            int width;
            try {
                width = Integer.parseInt(file.getAttribute("width"));
            } catch (NumberFormatException e) {
                width = 0;
            }
            if ("progressive".equals(file.getAttribute("delivery")) && "video/mp4".equalsIgnoreCase(file.getAttribute("type"))
                    && OverlayCue.isHttps(text(file)) && width <= 1920 && width > widest) {
                widest = width;
                out.mediaUrl = text(file);
            }
        }
        if (out.mediaUrl == null) return false;
        org.w3c.dom.NodeList durations = linear.getElementsByTagName("Duration");
        if (durations.getLength() > 0) out.durationMs = Math.max(0, Math.round(seconds(durations.item(0).getTextContent()) * 1000));
        org.w3c.dom.NodeList extensions = ad.getElementsByTagName("Extension");
        for (int i = 0; i < extensions.getLength(); i++) {
            Element extension = (Element) extensions.item(i);
            if (!"iADServerShop".equals(extension.getAttribute("type"))) continue;
            org.w3c.dom.NodeList shops = extension.getElementsByTagName("Shop");
            if (shops.getLength() > 0) {
                out.creativeId = ((Element) shops.item(0)).getAttribute("creativeId");
                out.deliveryId = ((Element) shops.item(0)).getAttribute("deliveryId");
            }
        }
        return true;
    }

    /** The URL of a scene product request: only {@code window} and {@code locale} are appended. */
    String productUrl(String windowId, String locale) {
        int hash = shop.url.indexOf('#');
        String base = hash >= 0 ? shop.url.substring(0, hash) : shop.url;
        String fragment = hash >= 0 ? shop.url.substring(hash) : "";
        String joiner = base.indexOf('?') < 0 ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
        return base + joiner + "window=" + encode(windowId) + "&locale=" + encode(OverlayCommerce.language(locale)) + fragment;
    }

    /** The product card clipped to its window, or null if it cannot be drawn with a Buy action. */
    static OverlayCue productCue(String json, Window window) {
        try {
            JSONObject card = new JSONObject(json);
            if (!card.isNull("window") && !window.id.equals(card.opt("window"))) return null;
            if (!(card.opt("start") instanceof Number) || !(card.opt("end") instanceof Number)) return null;
            card.put("start", Math.max(window.start, card.getLong("start")));
            card.put("end", Math.min(window.end, card.getLong("end")));
            List<OverlayCue> cues = OverlayCue.fromSidecar(new JSONArray().put(card).toString());
            if (cues.size() != 1 || cues.get(0).commerce == null || "midroll".equals(cues.get(0).format)) return null;
            return cues.get(0);
        } catch (JSONException e) {
            return null;
        }
    }
}

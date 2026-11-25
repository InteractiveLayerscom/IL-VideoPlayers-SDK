package com.interactivelayers.overlay;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Requests IL's ad plan for a native app: {@code GET <origin>/il-player/app-plan?project&asset&app}. No Android
 * classes here, so the URL and the handling of each answer are tested on the JVM.
 */
final class AdPlanLoader {
    /** Connect and read limits of one request, as the reader's other requests (OverlayNetwork). */
    static final int TIMEOUT_MS = 2500;
    /** The content is never held longer than this waiting for a plan: past it, it plays without ads. */
    static final long LOAD_TIMEOUT_MS = 5000;
    /** A version 2 plan is asked for again this long before its {@code expires_at}. */
    static final long RENEW_AHEAD_MS = 20000;
    private static final int MAX_BODY = 512 * 1024;

    interface Http {
        /** The status of an HTTPS GET; the body goes into {@code body}. Throws on network failure or timeout. */
        int get(String url, StringBuilder body) throws IOException;
    }

    interface Listener {
        void loaded(String json);
        /**
         * No plan. {@code status} is the HTTP status, 0 without an answer; {@code reason} is {@code http_<status>},
         * {@code timeout} or {@code network}.
         */
        void unavailable(int status, String reason);
    }

    /** What an Android package name may be on the plan route (IL's pattern for {@code android:} ids). */
    static final java.util.regex.Pattern PACKAGE = java.util.regex.Pattern.compile(
            "[A-Za-z][A-Za-z0-9_]{0,63}(\\.[A-Za-z][A-Za-z0-9_]{0,63}){1,9}");

    /** Whether IL would accept this {@code app=} value at all (at most 155 characters, the package pattern). */
    static boolean appAccepted(String app) {
        return app != null && app.length() <= 155 && app.startsWith("android:") && PACKAGE.matcher(app.substring(8)).matches();
    }

    final String origin, project, asset, app;
    private final Http http;

    AdPlanLoader(Http http, String origin, String project, String asset, String app) {
        String own = AdPlan.origin(origin);
        // An origin, as web/ads.mjs planUrl requires: no path, query or credentials.
        if (own == null || !(own.equals(origin) || (own + "/").equals(origin))) {
            throw new IllegalArgumentException("origin must be an https origin");
        }
        if (project == null || project.isEmpty()) throw new IllegalArgumentException("project must be a non-empty string");
        if (asset == null || asset.isEmpty()) throw new IllegalArgumentException("asset must be a non-empty string");
        this.http = http;
        this.origin = own;
        this.project = project;
        this.asset = asset;
        this.app = app;
    }

    /** {@code android:<package name>}: the console must have this app registered for the project. */
    static String appId(String packageName) { return "android:" + packageName; }

    /** The plan URL; with {@code renew} (the current plan's grant) the server keeps the same commerce session. */
    String url(String renew) {
        return origin + "/il-player/app-plan?project=" + encode(project) + "&asset=" + encode(asset) + "&app=" + encode(app)
                + (renew != null && !renew.isEmpty() ? "&renew=" + encode(renew) : "");
    }

    /** Runs on a worker thread and answers {@code listener} exactly once. */
    void fetch(String renew, Listener listener) {
        String url = url(renew);
        int status;
        StringBuilder body = new StringBuilder();
        try {
            status = http.get(url, body);
        } catch (java.net.SocketTimeoutException e) {
            listener.unavailable(0, "timeout");
            return;
        } catch (IOException | RuntimeException e) {
            listener.unavailable(0, "network");
            return;
        }
        if (status == 200) listener.loaded(body.toString());
        else listener.unavailable(status, "http_" + status);
    }

    /** Why a 200 body was refused: a server-insertion plan (a {@code timeline}) is {@code stitched}, anything else {@code invalid}. */
    static String refusal(String json) {
        try {
            return !new org.json.JSONObject(json).isNull("timeline") ? "stitched" : "invalid";
        } catch (org.json.JSONException e) {
            return "invalid";
        }
    }

    /** When to renew {@code plan}, in ms from {@code nowMs}; -1 for a plan that does not need it. */
    static long renewDelay(AdPlan plan, long nowMs) {
        if (plan == null || plan.version != 2) return -1;
        return Math.max(0, plan.expiresAtMs - RENEW_AHEAD_MS - nowMs);
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20").replace("%7E", "~");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** HTTPS only, no redirects, no cookies or credentials: the route is for native clients and has no CORS. */
    static final Http HTTPS = (address, body) -> {
        if (!OverlayCue.isHttps(address)) throw new IOException("Expected an HTTPS plan URL");
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        try {
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            if (status != 200) return status;
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = in.read(buffer)) != -1) {
                    if (out.size() + count > MAX_BODY) throw new IOException("Plan too large");
                    out.write(buffer, 0, count);
                }
                body.append(new String(out.toByteArray(), StandardCharsets.UTF_8));
            }
            return status;
        } finally {
            connection.disconnect();
        }
    };
}

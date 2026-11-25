package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import android.content.res.AssetManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.SystemClock;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import androidx.media3.common.MediaItem;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.tls.HandshakeCertificates;
import okhttp3.tls.HeldCertificate;
import okio.Buffer;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * load() and host-driven breaks on a real ExoPlayer, PlayerView and OverlayController, with IL's recorded answers
 * (test/fixtures/native) served over HTTPS from inside the device. No IMA or Google Mobile Ads is involved.
 */
@RunWith(AndroidJUnit4.class)
public final class NativePlanPlaybackTest {
    private static final String DELIVERY = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    private final MockWebServer server = new MockWebServer();
    private final SSLSocketFactory originalTrust = HttpsURLConnection.getDefaultSSLSocketFactory();
    private final List<String> requests = Collections.synchronizedList(new ArrayList<>());
    private final List<String> events = Collections.synchronizedList(new ArrayList<>());
    private volatile int planStatus = 200;
    private volatile long planDelayMs;
    private String origin;
    private AssetManager assets;
    private ActivityScenario<FixtureActivity> activity;
    private PlayerView view;
    private ExoPlayer player;
    private OverlayController overlays;
    private AdPlanPlayer plan;
    private final AtomicBoolean ready = new AtomicBoolean();

    @Before public void open() throws Exception {
        assets = InstrumentationRegistry.getInstrumentation().getContext().getAssets();
        byte[] segment = read("green.ts");
        String vod = new String(read("vod.m3u8"), StandardCharsets.UTF_8)
                .replaceAll("(?m)^#EXT-X-DATERANGE:.*\\n", "");
        Bitmap image = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888);
        image.eraseColor(Color.BLUE);
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        image.compress(Bitmap.CompressFormat.PNG, 100, png);
        HeldCertificate cert = new HeldCertificate.Builder().commonName("IL test").addSubjectAlternativeName("127.0.0.1").build();
        server.useHttps(new HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false);
        server.setDispatcher(new Dispatcher() {
            @Override public MockResponse dispatch(RecordedRequest request) {
                String path = request.getRequestUrl().encodedPath();
                requests.add(request.getPath());
                try {
                    if (path.equals("/vod.m3u8")) return new MockResponse().setBody(vod);
                    if (path.equals("/green.ts")) return new MockResponse().setBody(new Buffer().write(segment));
                    if (path.startsWith("/img/")) return new MockResponse().setHeader("Content-Type", "image/png").setBody(new Buffer().write(png.toByteArray()));
                    if (path.equals("/il-player/app-plan")) {
                        MockResponse answer = new MockResponse().setResponseCode(planStatus);
                        if (planDelayMs > 0) answer.setHeadersDelay(planDelayMs, TimeUnit.MILLISECONDS);
                        return planStatus == 200 ? answer.setBody(current(fixture("host-plan.json"))) : answer;
                    }
                    if (path.equals("/il-player/break-product")) return new MockResponse().setBody(fixture("break-product-card.json"));
                    if (path.equals("/il-player/scene-product")) return new MockResponse().setResponseCode(204);
                } catch (IOException e) {
                    return new MockResponse().setResponseCode(500);
                }
                return new MockResponse().setResponseCode(404);
            }
        });
        server.start(InetAddress.getByName("127.0.0.1"), 0);
        origin = "https://127.0.0.1:" + server.getPort();
        HttpsURLConnection.setDefaultSSLSocketFactory(new HandshakeCertificates.Builder()
                .addTrustedCertificate(cert.certificate()).build().sslSocketFactory());
        activity = ActivityScenario.launch(FixtureActivity.class);
        activity.onActivity(a -> {
            view = new PlayerView(a);
            view.setUseController(false);
            FrameLayout root = new FrameLayout(a);
            root.addView(view, new FrameLayout.LayoutParams(-1, -1));
            a.setContentView(root);
            player = new ExoPlayer.Builder(a).build();
            view.setPlayer(player);
            player.setMediaItem(MediaItem.fromUri(origin + "/vod.m3u8"));
            player.prepare();
            overlays = OverlayController.attach(view);
        });
    }

    @After public void close() throws Exception {
        activity.onActivity(a -> {
            if (plan != null) plan.close();
            overlays.close();
            view.setPlayer(null);
            player.release();
        });
        activity.close();
        HttpsURLConnection.setDefaultSSLSocketFactory(originalTrust);
        server.shutdown();
    }

    private byte[] read(String name) throws IOException {
        try (InputStream in = assets.open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] block = new byte[8192];
            int n;
            while ((n = in.read(block)) != -1) out.write(block, 0, n);
            return out.toByteArray();
        }
    }

    // The recorded answers name IL's test console (http://localhost:8000); here the same bodies come from this server.
    private String fixture(String name) throws IOException {
        return new String(read("native/" + name), StandardCharsets.UTF_8).replace("http://localhost:8000", origin)
                .replace("https://cdn.shopify.test/", origin + "/img/");
    }

    // The recorded plan expired on the fixtures' frozen clock; this device runs on the real one.
    private static String current(String plan) throws IOException {
        try {
            java.text.SimpleDateFormat iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US);
            iso.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            return new JSONObject(plan).put("expires_at", iso.format(new java.util.Date(System.currentTimeMillis() + 600000))).toString();
        } catch (org.json.JSONException e) {
            throw new IOException(e);
        }
    }

    private void load() {
        activity.onActivity(a -> {
            plan = AdPlanPlayer.load(overlays, player, origin, "proj_8e4cb338d66e4ec6bc6b99fd21f651f6",
                    "asset-40edc822d6f24974a9af51695a88184b", null, "es", (type, format, id) -> events.add(type + " " + id));
            plan.start(() -> ready.set(true));
        });
    }

    private interface Condition { boolean fulfilled(); }

    private void await(Condition condition) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        AtomicBoolean met = new AtomicBoolean();
        while (!met.get() && SystemClock.elapsedRealtime() < deadline) {
            activity.onActivity(a -> met.set(condition.fulfilled()));
            if (!met.get()) Thread.sleep(25);
        }
        assertTrue("Expected condition before timeout", met.get());
    }

    private List<View> buttons(String title) {
        ArrayList<View> matched = new ArrayList<>();
        view.findViewsWithText(matched, title, View.FIND_VIEWS_WITH_TEXT);
        matched.removeIf(item -> !(item instanceof Button) || !((Button) item).getText().toString().equals(title) || !item.isShown());
        return matched;
    }

    private String planRequest() {
        synchronized (requests) {
            for (String request : requests) if (request.startsWith("/il-player/app-plan")) return request;
        }
        return null;
    }

    @Test public void loadSendsThisAppsPackageAndAttachesThePlan() throws Exception {
        load();
        await(ready::get);
        String sent = planRequest();
        String app = InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName();
        assertEquals("/il-player/app-plan?project=proj_8e4cb338d66e4ec6bc6b99fd21f651f6&asset=asset-40edc822d6f24974a9af51695a88184b"
                + "&app=android%3A" + app, sent);
        assertTrue(events.isEmpty());
    }

    @Test public void noPlanPlaysTheContentAndSaysWhy() throws Exception {
        planStatus = 204;
        load();
        await(ready::get);
        assertTrue(events.contains("plan_unavailable null"));
    }

    @Test public void a404NamesTheAppValueSent() throws Exception {
        planStatus = 404;
        load();
        await(ready::get);
        String app = InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName();
        assertTrue(events.toString(), events.contains("plan_not_found app=android:" + app));
    }

    @Test public void aSlowPlanNeverHoldsTheContentPastTheLimit() throws Exception {
        planDelayMs = 8000;
        long started = SystemClock.elapsedRealtime();
        load();
        await(ready::get);
        long waited = SystemClock.elapsedRealtime() - started;
        assertTrue("released after " + waited + " ms", waited < AdPlanLoader.LOAD_TIMEOUT_MS + 1500);
        assertTrue(events.toString(), events.stream().anyMatch(event -> event.startsWith("plan_error")));
        // Let the late answer finish so the server shuts down cleanly; the plan that arrives late is not used.
        Thread.sleep(Math.max(0, planDelayMs + 1000 - (SystemClock.elapsedRealtime() - started)));
        assertFalse(events.toString(), events.stream().anyMatch(event -> event.startsWith("host_break")));
    }

    @Test public void aReportedAdDrawsBuyAndNothingElse() throws Exception {
        load();
        await(ready::get);
        String tag = new JSONObject(fixture("break-request-stable.json")).getString("ad_tag_url");
        activity.onActivity(a -> {
            plan.setBreaks(new long[] {58000});
            plan.breakStarted(58000);
            plan.adStarted(tag, "il-shop-midroll-" + DELIVERY, "cr1");
        });
        await(() -> !buttons("Comprar").isEmpty());
        String card;
        synchronized (requests) {
            card = requests.stream().filter(path -> path.startsWith("/il-player/break-product")).findFirst().orElse(null);
        }
        assertNotNull(card);
        assertTrue(card, card.endsWith("&host=1&cut=at-58000&tag=T_mid&creative=cr1&delivery=" + DELIVERY + "&locale=es"));
        boolean tv = (view.getResources().getConfiguration().uiMode & Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_TELEVISION
                || view.getContext().getPackageManager().hasSystemFeature("android.software.leanback");
        if (tv) {
            // Buy takes the remote's focus when it appears, as for the reader's own breaks.
            await(() -> {
                View focus = view.getRootView().findFocus();
                return focus instanceof Button && "Comprar".equals(((Button) focus).getText().toString());
            });
        }
        activity.onActivity(a -> {
            plan.adEnded();
            assertTrue("Buy goes with its ad", buttons("Comprar").isEmpty());
            plan.breakEnded();
        });
        assertFalse("no video ad of IL's own", requests.stream().anyMatch(path -> path.contains("gampad")));
    }
}

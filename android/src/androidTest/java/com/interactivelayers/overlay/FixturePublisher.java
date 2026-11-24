package com.interactivelayers.overlay;

import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;
import okhttp3.HttpUrl;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.tls.HandshakeCertificates;
import okhttp3.tls.HeldCertificate;
import okio.Buffer;

/** An HTTPS publisher and measurement endpoint bound only to the emulator's loopback interface. */
final class FixturePublisher implements Closeable {
    final List<String> images = Collections.synchronizedList(new ArrayList<>());
    final List<String> impressions = Collections.synchronizedList(new ArrayList<>());
    final List<HttpUrl> sidecarRequests = Collections.synchronizedList(new ArrayList<>());
    final List<String> checkoutDestinations = Collections.synchronizedList(new ArrayList<>());
    final List<String> checkoutSelections = Collections.synchronizedList(new ArrayList<>());
    final CountDownLatch requestStarted = new CountDownLatch(1);
    final CountDownLatch releaseImage = new CountDownLatch(1);
    final CountDownLatch responseSent = new CountDownLatch(1);
    volatile boolean hold;
    volatile boolean invalidImage;
    private final MockWebServer server = new MockWebServer();
    private final SSLSocketFactory originalTrust = HttpsURLConnection.getDefaultSSLSocketFactory();
    private final String live;
    private final String vod;
    private final String scene;
    private final byte[] segment;
    private final byte[] jpeg;
    private final byte[] png;
    private final byte[] scenePoster;
    private final String origin;

    FixturePublisher(AssetManager assets) throws IOException {
        live = new String(read(assets, "live.m3u8"), StandardCharsets.UTF_8);
        vod = new String(read(assets, "vod.m3u8"), StandardCharsets.UTF_8);
        scene = new String(read(assets, "creative-scene.json"), StandardCharsets.UTF_8);
        segment = read(assets, "green.ts");
        Bitmap image = Bitmap.createBitmap(32, 18, Bitmap.Config.ARGB_8888);
        image.eraseColor(Color.RED);
        png = encode(image, Bitmap.CompressFormat.PNG);
        jpeg = encode(image, Bitmap.CompressFormat.JPEG);
        image.eraseColor(Color.MAGENTA);
        scenePoster = encode(image, Bitmap.CompressFormat.PNG);
        image.recycle();

        HeldCertificate cert = new HeldCertificate.Builder().commonName("IL test")
                .addSubjectAlternativeName("localhost").addSubjectAlternativeName("127.0.0.1").build();
        HandshakeCertificates publisher = new HandshakeCertificates.Builder().heldCertificate(cert).build();
        HandshakeCertificates trust = new HandshakeCertificates.Builder()
                .addTrustedCertificate(cert.certificate()).build();
        server.useHttps(publisher.sslSocketFactory(), false);
        server.setDispatcher(new Dispatcher() {
            @Override public MockResponse dispatch(RecordedRequest request) throws InterruptedException {
                if (request.getPath().endsWith("/cart") && request.getMethod().equals("POST")) {
                    checkoutDestinations.add(request.getPath());
                    checkoutSelections.add(request.getBody().readUtf8());
                    return new MockResponse().setHeader("Content-Type", "application/json")
                            .setBody("{\"continueUrl\":\"" + url("/continue") + "\",\"qrImageUrl\":\"" + url("/qr.png") + "\"}");
                }
                return respond(request.getRequestUrl());
            }
        });
        server.start(InetAddress.getByName("127.0.0.1"), 0);
        origin = "https://127.0.0.1:" + server.getPort();
        HttpsURLConnection.setDefaultSSLSocketFactory(trust.sslSocketFactory());
    }

    String url(String path) { return origin + path; }

    private MockResponse respond(HttpUrl request) throws InterruptedException {
        String path = request.encodedPath();
        if (path.endsWith(".m3u8")) {
            String content = path.equals("/live.m3u8") ? live : vod;
            if (path.equals("/no-clock.m3u8")) content = content.replaceAll("(?m)^#EXT-X-PROGRAM-DATE-TIME:.*\\n", "");
            return new MockResponse().setHeader("Content-Type", "application/vnd.apple.mpegurl")
                    .setBody(content.replace("https://assets.invalid/", url("/assets/"))
                            .replace("https://measure.invalid/", url("/measure/")));
        }
        if (path.equals("/green.ts")) return bytes(segment, "video/mp2t");
        if (path.startsWith("/assets/")) {
            images.add(path);
            requestStarted.countDown();
            if (hold) releaseImage.await(6, TimeUnit.SECONDS);
            responseSent.countDown();
            if (invalidImage) return new MockResponse().setBody("<html/>");
            if (path.equals("/assets/poster.png")) return bytes(scenePoster, "image/png");
            return path.endsWith("/l") ? bytes(jpeg, "image/jpeg") : bytes(png, "image/png");
        }
        if (path.startsWith("/measure/")) {
            impressions.add(path);
            return new MockResponse().setResponseCode(204);
        }
        if (path.equals("/animated.gif")) return bytes(android.util.Base64.decode(
                "R0lGODlhAQABAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAAAAAACwAAAAAAQABAAACAkQBACH5BAAAAAAALAAAAAABAAEAgAAA/wAAAAICRAEAOw==",
                android.util.Base64.DEFAULT), "image/gif");
        if (path.equals("/qr.png")) return bytes(png, "image/png");
        if (path.equals("/scene")) {
            sidecarRequests.add(request);
            if (!"1".equals(request.queryParameter("scene"))) return new MockResponse().setBody("[]");
            try {
                org.json.JSONObject cue = new org.json.JSONObject(
                        scene.replace("https://ads.example/", url("/"))
                                .replace(url("/poster.png"), url("/assets/poster.png"))
                                .replace(url("/cap.png"), url("/assets/cap.png"))
                                .replace(url("/logo.png"), url("/assets/logo.png"))
                                .replace(url("/cap/view"), url("/measure/cap")));
                org.json.JSONObject cap = cue.getJSONArray("products").getJSONObject(1);
                cap.put("description", "Gorra ajustable").put("images", new org.json.JSONArray().put(url("/assets/back.png")));
                org.json.JSONArray skus = cap.getJSONArray("variants");
                for (int i = 0; i < skus.length(); i++) {
                    org.json.JSONObject sku = skus.getJSONObject(i);
                    sku.put("selectedOptions", new org.json.JSONArray()
                            .put(new org.json.JSONObject().put("name", "Color").put("value", sku.getString("label")))
                            .put(new org.json.JSONObject().put("name", "Talle").put("value", i == 0 ? "S" : "M")));
                    if (i == 1) sku.put("imageUrl", url("/assets/green.png"));
                }
                cue.put("start", 1795046400000L);
                cue.put("end", 1795046418000L);
                cue.put("impressionUrl", url("/measure/scene"));
                org.json.JSONArray cues = new org.json.JSONArray().put(cue);
                // A second ad with the same layout right after the first, both inside the fixture's stream: the first
                // from 0 s to 14 s, the second from 14 s past the end of the stream (so a pause always lands inside it).
                if ("1".equals(request.queryParameter("second"))) {
                    cue.put("end", 1795046414000L);
                    cues.put(new org.json.JSONObject(cue.toString()).put("id", "scene-second").put("start", 1795046414000L)
                            .put("end", 1795046436000L).put("impressionUrl", url("/measure/scene2")));
                }
                return new MockResponse().setHeader("Content-Type", "application/json").setBody(cues.toString());
            } catch (org.json.JSONException e) {
                return new MockResponse().setResponseCode(500);
            }
        }
        if (path.equals("/midroll")) {
            sidecarRequests.add(request);
            try {
                org.json.JSONObject offer = new org.json.JSONObject().put("title", "Spot boots")
                        .put("currency", "USD").put("locale", "es").put("price", 20).put("imageUrl", url("/assets/boots.png"))
                        .put("handoffUrl", url("/cart")).put("viewUrl", url("/measure/shop-view"))
                        .put("variants", new org.json.JSONArray().put(new org.json.JSONObject().put("id", "v").put("label", "M")));
                org.json.JSONObject cue = new org.json.JSONObject().put("format", "midroll").put("id", "delivery-a")
                        .put("linearCreativeId", "creative-a").put("start", 1795046400000L).put("end", 1795046418000L)
                        .put("imageUrl", url("/assets/spot.mp4")).put("mimeType", "video/mp4")
                        .put("impressionUrl", url("/measure/vast")).put("commerce", offer);
                return new MockResponse().setBody(new org.json.JSONArray().put(cue).toString());
            } catch (org.json.JSONException e) { throw new AssertionError(e); }
        }
        if (path.equals("/commerce")) {
            sidecarRequests.add(request);
            return new MockResponse().setHeader("Content-Type", "application/json")
                    .setBody("[{\"id\":\"sale\",\"format\":\"overlay\",\"start\":1795046400000,\"end\":1795046418000,"
                            + "\"imageUrl\":\"" + url("/assets/sidecar") + "\",\"impressionUrl\":\"" + url("/measure/commerce")
                            + "\",\"commerce\":{\"title\":\"Botines\",\"price\":\"25.00\",\"locale\":\"es\",\"currency\":\"USD\","
                            + "\"variants\":[{\"id\":\"42\",\"label\":\"Talle 42\"},{\"id\":\"43\",\"label\":\"Talle 43\"}],"
                            + "\"viewUrl\":\"" + url("/measure/product-view") + "\",\"handoffUrl\":\"" + url("/cart") + "\"}}]");
        }
        if (path.equals("/session")) {
            sidecarRequests.add(request);
            return new MockResponse().setHeader("Content-Type", "application/json")
                    .setBody("[{\"id\":\"session-cue\",\"format\":\"super\",\"start\":1795046400000,"
                            + "\"end\":1795046418000,\"imageUrl\":\"" + url("/assets/sidecar")
                            + "\",\"impressionUrl\":\"" + url("/measure/sidecar") + "\"}]");
        }
        return new MockResponse().setResponseCode(404);
    }

    private static byte[] read(AssetManager assets, String name) throws IOException {
        try (InputStream in = assets.open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] block = new byte[8192];
            int n;
            while ((n = in.read(block)) != -1) out.write(block, 0, n);
            return out.toByteArray();
        }
    }

    private static byte[] encode(Bitmap image, Bitmap.CompressFormat format) {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        image.compress(format, 100, data);
        return data.toByteArray();
    }

    private static MockResponse bytes(byte[] data, String type) {
        return new MockResponse().setHeader("Content-Type", type).setBody(new Buffer().write(data));
    }

    @Override public void close() throws IOException {
        HttpsURLConnection.setDefaultSSLSocketFactory(originalTrust);
        releaseImage.countDown();
        server.shutdown();
    }
}

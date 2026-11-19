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
    private final byte[] segment;
    private final byte[] jpeg;
    private final byte[] png;
    private final String origin;

    FixturePublisher(AssetManager assets) throws IOException {
        live = new String(read(assets, "live.m3u8"), StandardCharsets.UTF_8);
        vod = new String(read(assets, "vod.m3u8"), StandardCharsets.UTF_8);
        segment = read(assets, "green.ts");
        Bitmap image = Bitmap.createBitmap(32, 18, Bitmap.Config.ARGB_8888);
        image.eraseColor(Color.RED);
        png = encode(image, Bitmap.CompressFormat.PNG);
        jpeg = encode(image, Bitmap.CompressFormat.JPEG);
        image.recycle();

        HeldCertificate cert = new HeldCertificate.Builder().commonName("IL test")
                .addSubjectAlternativeName("localhost").addSubjectAlternativeName("127.0.0.1").build();
        HandshakeCertificates publisher = new HandshakeCertificates.Builder().heldCertificate(cert).build();
        HandshakeCertificates trust = new HandshakeCertificates.Builder()
                .addTrustedCertificate(cert.certificate()).build();
        server.useHttps(publisher.sslSocketFactory(), false);
        server.setDispatcher(new Dispatcher() {
            @Override public MockResponse dispatch(RecordedRequest request) throws InterruptedException {
                if (request.getPath().equals("/cart") && request.getMethod().equals("POST")) {
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
            return path.endsWith("/l") ? bytes(jpeg, "image/jpeg") : bytes(png, "image/png");
        }
        if (path.startsWith("/measure/")) {
            impressions.add(path);
            return new MockResponse().setResponseCode(204);
        }
        if (path.equals("/qr.png")) return bytes(png, "image/png");
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

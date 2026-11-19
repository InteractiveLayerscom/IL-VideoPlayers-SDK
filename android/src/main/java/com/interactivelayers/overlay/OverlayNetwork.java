package com.interactivelayers.overlay;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

final class OverlayNetwork {
    List<OverlayCue> windows(String endpoint, String session, long timeMs, String locale, String country,
                            boolean video, boolean audio, String creativeId, String deliveryId) throws IOException {
        Uri uri = Uri.parse(endpoint);
        Uri.Builder builder = uri.buildUpon().clearQuery();
        for (String key : uri.getQueryParameterNames()) {
            if (key.equals("sid") || key.equals("time") || key.equals("commerce") || key.equals("scene")
                    || key.equals("scene_features") || key.equals("shop_midroll") || key.equals("midroll_creative_id")
                    || key.equals("midroll_delivery_id")
                    || (locale != null && key.equals("locale")) || (country != null && key.equals("country"))) continue;
            for (String value : uri.getQueryParameters(key)) builder.appendQueryParameter(key, value);
        }
        if (locale != null) builder.appendQueryParameter("commerce", "1")
                .appendQueryParameter("locale", OverlayCommerce.language(locale));
        if (creativeId != null && deliveryId != null) builder.appendQueryParameter("shop_midroll", "1")
                .appendQueryParameter("midroll_creative_id", creativeId).appendQueryParameter("midroll_delivery_id", deliveryId);
        if (country != null) builder.appendQueryParameter("country", country);
        String features = "media-mask,media-crop";
        if (video) features += audio ? ",video,audio" : ",video";
        String url = builder.appendQueryParameter("scene", "1").appendQueryParameter("scene_features", features)
                .appendQueryParameter("time", Long.toString(timeMs))
                .appendQueryParameter("sid", session).build().toString();
        return OverlayCue.fromSidecar(new String(read(url, (locale == null ? 1 : 8) * 1024 * 1024), StandardCharsets.UTF_8));
    }

    Bitmap image(OverlayCue cue) throws IOException {
        return staticImage(cue.imageUrl, cue.mimeType, 4 * 1024 * 1024, false);
    }

    Bitmap sceneImage(String url) throws IOException {
        return staticImage(url, null, 4 * 1024 * 1024, true);
    }

    Bitmap shopImage(String url, int size) throws IOException {
        return staticImage(url, null, 4 * 1024 * 1024, true, size);
    }

    Bitmap qrImage(String url) throws IOException {
        return staticImage(url, "image/png", 256 * 1024, false);
    }

    private Bitmap staticImage(String url, String mimeType, int limit, boolean allowGIF) throws IOException {
        return staticImage(url, mimeType, limit, allowGIF, 0);
    }

    private Bitmap staticImage(String url, String mimeType, int limit, boolean allowGIF, int size) throws IOException {
        byte[] bytes = read(url, limit);
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        boolean supported = OverlayCue.isStaticImage(bounds.outMimeType)
                || (allowGIF && "image/gif".equals(bounds.outMimeType)) || (size > 0 && "image/webp".equals(bounds.outMimeType));
        if (!supported
                || (mimeType != null && !mimeType.equals(bounds.outMimeType))
                || bounds.outWidth <= 0 || bounds.outHeight <= 0
                || bounds.outWidth > 4096 || bounds.outHeight > 4096
                || (long) bounds.outWidth * bounds.outHeight > 4096L * 2160) return null;
        bounds.inJustDecodeBounds = false;
        bounds.inSampleSize = 1;
        while (size > 0 && Math.max(bounds.outWidth, bounds.outHeight) / bounds.inSampleSize > 2 * size) bounds.inSampleSize *= 2;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
    }

    static final class Handoff {
        final String continueUrl;
        final String qrImageUrl;

        Handoff(String continueUrl, String qrImageUrl) {
            this.continueUrl = continueUrl;
            this.qrImageUrl = qrImageUrl;
        }
    }

    Handoff prepareCart(String handoffUrl, String variantId) throws IOException {
        if (!OverlayCue.isHttps(handoffUrl)) throw new IOException("Expected an HTTPS checkout endpoint");
        HttpURLConnection connection = connection(new URL(handoffUrl));
        try {
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] payload = new JSONObject().put("variantId", variantId).toString()
                    .getBytes(StandardCharsets.UTF_8);
            try (java.io.OutputStream out = connection.getOutputStream()) {
                out.write(payload);
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("Cart unavailable");
            JSONObject reply = new JSONObject(new String(read(connection, 16384), StandardCharsets.UTF_8));
            String continuation = reply.optString("continueUrl");
            String qr = reply.optString("qrImageUrl");
            if (!OverlayCue.isHttps(continuation)) throw new IOException("Invalid checkout URL");
            return new Handoff(continuation, OverlayCue.isHttps(qr) ? qr : null);
        } catch (JSONException e) {
            throw new IOException("Invalid cart response", e);
        } finally {
            connection.disconnect();
        }
    }

    void impression(String url) throws IOException {
        HttpURLConnection connection = open(url);
        connection.disconnect();
    }

    private static byte[] read(String address, int limit) throws IOException {
        return read(open(address), limit);
    }

    private static byte[] read(HttpURLConnection connection, int limit) throws IOException {
        try (InputStream in = connection.getInputStream();
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted() || out.size() + count > limit) {
                    throw new IOException("Graphic request cancelled or too large");
                }
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        } finally {
            connection.disconnect();
        }
    }

    private static HttpURLConnection open(String address) throws IOException {
        String next = address;
        for (int redirects = 0; redirects <= 4; redirects++) {
            if (!OverlayCue.isHttps(next) || Thread.currentThread().isInterrupted()) {
                throw new IOException("Expected an HTTPS resource");
            }
            URL url = new URL(next);
            HttpURLConnection connection = connection(url);
            try {
                int code = connection.getResponseCode();
                if (code >= 200 && code < 300) return connection;
                String location = connection.getHeaderField("Location");
                if ((code != 301 && code != 302 && code != 303 && code != 307 && code != 308)
                        || location == null) throw new IOException("Resource unavailable");
                next = new URL(url, location).toString();
            } catch (IOException e) {
                connection.disconnect();
                throw e;
            }
            connection.disconnect();
        }
        throw new IOException("Too many redirects");
    }
    private static HttpURLConnection connection(URL url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(2500);
        connection.setReadTimeout(2500);
        connection.setUseCaches(false);
        connection.setInstanceFollowRedirects(false);
        return connection;
    }
}

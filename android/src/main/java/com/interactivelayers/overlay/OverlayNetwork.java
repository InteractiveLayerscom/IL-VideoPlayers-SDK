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

final class OverlayNetwork {
    List<OverlayCue> windows(String endpoint, String session, long timeMs) throws IOException {
        Uri uri = Uri.parse(endpoint);
        Uri.Builder builder = uri.buildUpon().clearQuery();
        for (String key : uri.getQueryParameterNames()) {
            if (key.equals("sid") || key.equals("time")) continue;
            for (String value : uri.getQueryParameters(key)) builder.appendQueryParameter(key, value);
        }
        String url = builder.appendQueryParameter("time", Long.toString(timeMs))
                .appendQueryParameter("sid", session).build().toString();
        return OverlayCue.fromSidecar(new String(read(url, 128 * 1024), StandardCharsets.UTF_8));
    }

    Bitmap image(OverlayCue cue) throws IOException {
        byte[] bytes = read(cue.imageUrl, 4 * 1024 * 1024);
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (!OverlayCue.isStaticImage(bounds.outMimeType)
                || (cue.mimeType != null && !cue.mimeType.equals(bounds.outMimeType))
                || bounds.outWidth <= 0 || bounds.outHeight <= 0
                || bounds.outWidth > 4096 || bounds.outHeight > 4096
                || (long) bounds.outWidth * bounds.outHeight > 4096L * 2160) return null;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
    }

    void impression(String url) throws IOException {
        HttpURLConnection connection = open(url);
        connection.disconnect();
    }

    private static byte[] read(String address, int limit) throws IOException {
        HttpURLConnection connection = open(address);
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
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(2500);
            connection.setReadTimeout(2500);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
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
}

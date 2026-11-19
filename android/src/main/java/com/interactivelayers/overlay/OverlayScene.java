package com.interactivelayers.overlay;

import java.text.NumberFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Currency;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

final class OverlayScene {
    final float width;
    final float height;
    final long duration;
    final List<Layer> layers;
    private final List<Offer> offers;

    private OverlayScene(float width, float height, long duration, List<Layer> layers, List<Offer> offers) {
        this.width = width;
        this.height = height;
        this.duration = duration;
        this.layers = Collections.unmodifiableList(layers);
        this.offers = Collections.unmodifiableList(offers);
    }

    static OverlayScene parse(JSONObject scene, String format, JSONArray products) {
        if (scene == null || !scene.optString("format").equals(format)) return null;
        float width = number(scene, "width", 0), height = number(scene, "height", 0);
        long duration = scene.optLong("durationMs");
        JSONArray items = scene.optJSONArray("layers");
        if (width <= 0 || height <= 0 || duration <= 0 || items == null || items.length() > 512) return null;
        List<Layer> layers = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null || item.optBoolean("hidden") || !(item.opt("id") instanceof String)) continue;
            Layer layer = new Layer(item);
            if (finite(layer.x) && finite(layer.y) && layer.width >= 0 && layer.height >= 0)
                layers.add(layer);
        }
        if (layers.isEmpty()) return null;
        List<Offer> offers = new ArrayList<>();
        if (products != null) {
            for (int i = 0; i < Math.min(products.length(), 64); i++) {
                JSONObject product = products.optJSONObject(i);
                OverlayCommerce offer = OverlayCommerce.parse(product);
                String imageUrl = address(product, "imageUrl");
                if (imageUrl == null && offer != null && !offer.images.isEmpty()) imageUrl = offer.images.get(0);
                String id = product == null ? "" : product.optString("id");
                offers.add(offer != null && imageUrl != null && !id.isEmpty() ? new Offer(id, imageUrl, offer) : null);
            }
        }
        return new OverlayScene(width, height, duration, layers, offers);
    }

    Offer offerAt(int index) { return index >= 0 && index < offers.size() ? offers.get(index) : null; }

    private static boolean finite(float value) {
        return !Float.isNaN(value) && !Float.isInfinite(value);
    }

    private static float number(JSONObject row, String key, float fallback) {
        Object value = row.opt(key);
        if (!(value instanceof Number)) return fallback;
        float amount = ((Number) value).floatValue();
        return finite(amount) ? amount : fallback;
    }

    private static String address(JSONObject row, String field) {
        String candidate = row == null ? null : row.optString(field, null);
        return OverlayCue.isHttps(candidate) ? candidate : null;
    }

    static final class Offer {
        final String id, imageUrl;
        final OverlayCommerce commerce;
        Offer(String id, String imageUrl, OverlayCommerce commerce) {
            this.id = id;
            this.imageUrl = imageUrl;
            this.commerce = commerce;
        }

        String price() {
            NumberFormat format = NumberFormat.getCurrencyInstance(Locale.forLanguageTag(commerce.locale));
            try { format.setCurrency(Currency.getInstance(commerce.currency)); }
            catch (IllegalArgumentException ignored) { format.setCurrency(Currency.getInstance("XXX")); }
            return format.format(commerce.price);
        }
    }

    static final class Layer {
        private static final String[] PROPERTIES = {"x", "y", "scale", "rotation", "opacity"};
        final String id, type, fill, stroke, text, fontFamily, fontWeight, textAlign, imageUrl, videoUrl, fit, binding, action, link;
        final float x, y, width, height, rotation, opacity, fontSize, radius, strokeWidth;
        final int productIndex;
        final long start;
        private final double end;
        final int trimStart, trimEnd;
        final boolean loop, arrow;
        final String fontStyle, alt, mask;
        final float cropX, cropY, cropZoom;
        final boolean audio;
        final float lineHeight, letterSpacing;
        final int maxLines;
        final JSONObject gradient, shadow;
        private final List<Keyframe> frames = new ArrayList<>();

        Layer(JSONObject row) {
            id = row.optString("id");
            type = row.optString("type");
            x = number(row, "x", Float.NaN);
            y = number(row, "y", Float.NaN);
            width = number(row, "width", -1);
            height = number(row, "height", -1);
            rotation = number(row, "rotation", 0);
            opacity = number(row, "opacity", 1);
            start = Math.max(0, row.optLong("startMs", 0));
            trimStart = Math.max(0, row.optInt("trimStartMs", 0));
            trimEnd = row.optInt("trimEndMs", -1);
            loop = row.optBoolean("loop");
            arrow = row.optBoolean("arrow");
            fontStyle = row.optString("fontStyle");
            alt = row.optString("alt");
            mask = row.optString("mask");
            JSONObject crop = row.optJSONObject("mediaCrop");
            cropX = crop == null ? 0 : Math.max(-1, Math.min(1, number(crop, "x", 0)));
            cropY = crop == null ? 0 : Math.max(-1, Math.min(1, number(crop, "y", 0)));
            cropZoom = crop == null ? 1 : Math.max(1, Math.min(4, number(crop, "zoom", 1)));
            audio = Boolean.TRUE.equals(row.opt("audio"));
            lineHeight = number(row, "lineHeight", 1.1f);
            letterSpacing = number(row, "letterSpacing", 0);
            maxLines = row.optInt("maxLines", 0);
            gradient = row.optJSONObject("gradient");
            shadow = row.optJSONObject("shadow");
            end = number(row, "endMs", Float.POSITIVE_INFINITY);
            fontSize = number(row, "fontSize", 24);
            radius = number(row, "radius", "rounded".equals(mask) ? 12 : 0);
            strokeWidth = number(row, "strokeWidth", 0);
            fill = row.optString("fill");
            stroke = row.optString("stroke");
            text = row.optString("text");
            fontFamily = row.optString("fontFamily");
            fontWeight = row.optString("fontWeight");
            textAlign = row.optString("textAlign");
            fit = row.optString("fit");
            binding = row.optString("binding");
            action = row.optString("action");
            productIndex = row.optInt("productIndex", -1);
            imageUrl = address(row, "video".equals(type) ? "poster" : "src");
            videoUrl = "video".equals(type) ? address(row, "src") : null;
            link = address(row, "url");
            JSONArray entries = row.optJSONArray("keyframes");
            if (entries == null) return;
            for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.optJSONObject(i);
                if (entry == null) continue;
                double time = number(entry, "timeMs", -1);
                if (time >= 0) frames.add(new Keyframe(time, entry));
            }
            frames.sort((a, b) -> Double.compare(a.time, b.time));
        }

        Frame frame(double time) {
            float[] values = {x, y, 1, rotation, opacity};
            if (!frames.isEmpty()) {
                for (int i = 0; i < values.length; i++) {
                    double previous = 0;
                    for (Keyframe point : frames) {
                        float next = point.values[i];
                        if (!finite(next)) continue;
                        if (time < point.time) {
                            float progress = (float) ((time - previous) / (point.time - previous));
                            values[i] += (next - values[i]) * point.ease(progress);
                            break;
                        }
                        values[i] = next;
                        previous = point.time;
                    }
                }
            }
            return new Frame(values, time >= start && time < end && values[2] > 0 && values[4] > 0);
        }

        private static final class Keyframe {
            final double time;
            final float[] values = new float[PROPERTIES.length];
            final String easing;
            Keyframe(double time, JSONObject row) {
                this.time = time;
                easing = row.optString("easing");
                for (int i = 0; i < values.length; i++) values[i] = number(row, PROPERTIES[i], Float.NaN);
            }

            float ease(float p) {
                switch (easing) {
                    case "ease-in": return p * p;
                    case "ease-out": return 1 - (1 - p) * (1 - p);
                    case "ease-in-out": return p < .5f ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
                    default: return p;
                }
            }
        }
    }

    static final class Frame {
        final float x, y, scale, rotation, opacity;
        final boolean visible;
        Frame(float[] values, boolean visible) {
            x = values[0];
            y = values[1];
            scale = values[2];
            rotation = values[3];
            opacity = values[4];
            this.visible = visible;
        }
    }

    static final class Brand {
        final String logoUrl, accent, background, foreground;
        Brand(JSONObject value) {
            logoUrl = address(value, "logoUrl");
            accent = color(value, "accent");
            background = color(value, "background");
            foreground = color(value, "foreground");
        }

        private static String color(JSONObject value, String field) {
            String result = value.optString(field);
            return result.matches("#[0-9a-fA-F]{6}") ? result : null;
        }
    }
}

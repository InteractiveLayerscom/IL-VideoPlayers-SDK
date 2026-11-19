package com.interactivelayers.overlay;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

final class OverlayCommerce {
    final String title, description, vendor;
    final List<String> images, dimensions;
    final String currency;
    final String locale;
    final String handoffUrl;
    final String viewUrl;
    final List<Variant> variants;
    final BigDecimal price, previousPrice, minimumPrice, maximumPrice;
    final int availableCount;
    private final OptionGroup stock = new OptionGroup();

    // Each prefix keeps catalog order and the available SKUs that share it.
    private static final class OptionGroup {
        final Map<String, OptionGroup> values = new LinkedHashMap<>();
        final List<Integer> skus = new ArrayList<>();
    }

    static final class Variant {
        final String id;
        final String label;
        final BigDecimal price, previousPrice;

        final String imageUrl;
        final Map<String, String> options;
        final boolean available;

        Variant(String id, String label, BigDecimal price, JSONObject row) {
            imageUrl = https(row, "imageUrl");
            previousPrice = amount(row.opt("previousPrice"));
            options = options(row.optJSONArray("selectedOptions"));
            available = row.isNull("availableForSale") || Boolean.TRUE.equals(row.opt("availableForSale"));
            this.id = id;
            this.label = label;
            this.price = price;
        }
    }

    private OverlayCommerce(JSONObject row, String title, String currency, String locale, String handoffUrl,
                            String viewUrl, BigDecimal price, List<Variant> variants) {
        this.title = title;
        description = text(row, "description", 8192);
        vendor = text(row, "vendor", 512);
        previousPrice = amount(row.opt("previousPrice"));
        LinkedHashSet<String> gallery = new LinkedHashSet<>();
        String main = https(row, "imageUrl");
        if (main != null) gallery.add(main);
        JSONArray photos = row.optJSONArray("images");
        if (photos != null) for (int i = 0; i < photos.length() && gallery.size() < 32; i++) {
            Object url = photos.opt(i);
            if (url instanceof String && ((String) url).length() <= 4096 && OverlayCue.isHttps((String) url))
                gallery.add((String) url);
        }
        images = Collections.unmodifiableList(new ArrayList<>(gallery));
        dimensions = dimensions(variants);
        for (int i = 0; i < variants.size() && !dimensions.isEmpty(); i++) {
            Variant variant = variants.get(i);
            if (!variant.available) continue;
            OptionGroup prefix = stock;
            for (String name : dimensions) {
                String value = variant.options.get(name);
                OptionGroup child = prefix.values.get(value);
                if (child == null) {
                    child = new OptionGroup();
                    prefix.values.put(value, child);
                }
                child.skus.add(i);
                prefix = child;
            }
        }
        BigDecimal min = null, max = null;
        int count = 0;
        for (Variant variant : variants) {
            if (!variant.available) continue;
            count++;
            min = min == null ? variant.price : min.min(variant.price);
            max = max == null ? variant.price : max.max(variant.price);
        }
        availableCount = count;
        minimumPrice = min == null ? price : min;
        maximumPrice = max == null ? price : max;
        this.currency = currency;
        this.locale = locale;
        this.handoffUrl = handoffUrl;
        this.viewUrl = viewUrl;
        this.price = price;
        this.variants = Collections.unmodifiableList(variants);
    }

    private static String https(JSONObject row, String field) {
        String url = text(row, field, 4096);
        return OverlayCue.isHttps(url) ? url : null;
    }

    private static Map<String, String> options(JSONArray entries) {
        Map<String, String> options = new LinkedHashMap<>();
        if (entries == null || entries.length() > 3) return options;
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry == null) return Collections.emptyMap();
            String name = text(entry, "name", 512), value = text(entry, "value", 512);
            if (name == null || value == null || options.put(name, value) != null) return Collections.emptyMap();
        }
        return Collections.unmodifiableMap(options);
    }

    private static List<String> dimensions(List<Variant> variants) {
        Set<Map<String, String>> seen = new HashSet<>();
        Set<String> names = variants.get(0).options.keySet();
        for (Variant variant : variants) {
            if (!names.equals(variant.options.keySet()) || !seen.add(variant.options)) return Collections.emptyList();
        }
        return Collections.unmodifiableList(new ArrayList<>(names));
    }

    int firstAvailable() {
        for (int i = 0; i < variants.size(); i++) if (variants.get(i).available) return i;
        return -1;
    }

    BigDecimal previousPrice(int selected) {
        Variant variant = variants.get(selected);
        BigDecimal previous = variant.previousPrice;
        if (previous == null && selected == firstAvailable() && variant.price.compareTo(price) == 0) previous = previousPrice;
        return previous != null && previous.compareTo(variant.price) > 0 ? previous : null;
    }

    String productPhoto(int selected, String fallback) {
        String sku = variants.get(selected).imageUrl;
        if (sku != null) return sku;
        if (!images.isEmpty()) return images.get(0);
        return OverlayCue.isHttps(fallback) ? fallback : null;
    }

    List<String> photos(int selected, String fallback) {
        Set<String> photos = new LinkedHashSet<>();
        String primary = productPhoto(selected, fallback);
        if (primary != null) photos.add(primary);
        photos.addAll(images);
        if (OverlayCue.isHttps(fallback)) photos.add(fallback);
        return new ArrayList<>(photos);
    }

    private OptionGroup prefix(Variant current, int depth) {
        OptionGroup group = stock;
        for (int i = 0; group != null && i < depth; i++) group = group.values.get(current.options.get(dimensions.get(i)));
        return group;
    }

    List<String> values(int selected, int depth) {
        OptionGroup group = prefix(variants.get(selected), depth);
        return group == null ? Collections.emptyList() : new ArrayList<>(group.values.keySet());
    }

    int choose(int selected, int depth, String value) {
        Variant current = variants.get(selected);
        OptionGroup parent = prefix(current, depth);
        OptionGroup choice = parent == null ? null : parent.values.get(value);
        if (choice == null) return -1;
        int best = -1, bestScore = -1;
        for (int i : choice.skus) {
            Variant candidate = variants.get(i);
            int score = 0;
            for (String name : dimensions) if (candidate.options.get(name).equals(current.options.get(name))) score++;
            if (score > bestScore) {
                best = i;
                bestScore = score;
            }
        }
        return best;
    }

    static String language(String locale) {
        String base = locale == null ? "" : locale.toLowerCase(Locale.ROOT).split("-", 2)[0];
        if ("pt".equals(base)) return "pt-BR";
        return "es".equals(base) ? "es" : "en";
    }

    private static String text(JSONObject row, String field, int limit) {
        Object value = row.opt(field);
        if (!(value instanceof String)) return null;
        String text = (String) value;
        return !text.trim().isEmpty() && text.length() <= limit ? text : null;
    }

    private static BigDecimal amount(Object raw) {
        if (!(raw instanceof Number) && !(raw instanceof String)) return null;
        String string = raw.toString();
        return string.matches("\\d{1,12}(?:\\.\\d{1,6})?") ? new BigDecimal(string) : null;
    }

    static OverlayCommerce parse(JSONObject row) {
        if (row == null) return null;
        String title = text(row, "title", 256);
        String currency = text(row, "currency", 3);
        String handoff = text(row, "handoffUrl", 4096);
        String view = text(row, "viewUrl", 4096);
        BigDecimal basePrice = amount(row.opt("price"));
        JSONArray items = row.optJSONArray("variants");
        if (title == null || currency == null || !currency.matches("[A-Z]{3}")
                || !OverlayCue.isHttps(handoff) || basePrice == null || items == null
                || items.length() < 1 || items.length() > 2048) return null;
        Set<String> ids = new HashSet<>();
        List<Variant> variants = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) return null;
            String id = text(item, "id", 128);
            String label = text(item, "label", 2048);
            BigDecimal price = item.isNull("price") ? basePrice : amount(item.opt("price"));
            if (id == null || label == null || price == null || !ids.add(id)) return null;
            variants.add(new Variant(id, label, price, item));
        }
        return new OverlayCommerce(row, title, currency, language(text(row, "locale", 35)), handoff,
                OverlayCue.isHttps(view) ? view : null, basePrice, variants);
    }
}

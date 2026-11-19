package com.interactivelayers.overlay;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

final class OverlayCommerce {
    final String title;
    final String currency;
    final String locale;
    final String handoffUrl;
    final String viewUrl;
    final List<Variant> variants;
    final BigDecimal price;

    static final class Variant {
        final String id;
        final String label;
        final BigDecimal price;

        Variant(String id, String label, BigDecimal price) {
            this.id = id;
            this.label = label;
            this.price = price;
        }
    }

    private OverlayCommerce(String title, String currency, String locale, String handoffUrl,
                            String viewUrl, BigDecimal price, List<Variant> variants) {
        this.title = title;
        this.currency = currency;
        this.locale = locale;
        this.handoffUrl = handoffUrl;
        this.viewUrl = viewUrl;
        this.price = price;
        this.variants = Collections.unmodifiableList(variants);
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
                || items.length() < 1 || items.length() > 100) return null;
        Set<String> ids = new HashSet<>();
        List<Variant> variants = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) return null;
            String id = text(item, "id", 128);
            String label = text(item, "label", 160);
            BigDecimal price = item.isNull("price") ? basePrice : amount(item.opt("price"));
            if (id == null || label == null || price == null || !ids.add(id)) return null;
            variants.add(new Variant(id, label, price));
        }
        return new OverlayCommerce(title, currency, language(text(row, "locale", 35)), handoff,
                OverlayCue.isHttps(view) ? view : null, basePrice, variants);
    }
}

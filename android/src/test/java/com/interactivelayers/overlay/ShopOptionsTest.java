package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class ShopOptionsTest {
    private static JSONObject variant(String id, String color, String size, boolean available) throws Exception {
        return new JSONObject().put("id", id).put("label", color + " / " + size).put("availableForSale", available)
                .put("selectedOptions", new JSONArray().put(new JSONObject().put("name", "Color").put("value", color))
                        .put(new JSONObject().put("name", "Size").put("value", size)));
    }

    private static OverlayCommerce offer(JSONArray variants) throws Exception {
        return OverlayCommerce.parse(new JSONObject().put("title", "Jersey").put("price", "24").put("currency", "USD")
                .put("handoffUrl", "https://ads.example/cart").put("description", "Cotton").put("variants", variants)
                .put("images", new JSONArray(Arrays.asList("https://shop.example/a", "file:///bad", "https://shop.example/a", "https://shop.example/b"))));
    }

    @Test public void optionsSelectAnAvailableSkuThatPreservesTheOtherValuesWhenPossible() throws Exception {
        OverlayCommerce offer = offer(new JSONArray().put(variant("sold", "Blue", "S", false))
                .put(variant("blueM", "Blue", "M", true))
                .put(variant("redL", "Red", "L", true))
                .put(variant("redM", "Red", "M", true).put("imageUrl", "https://shop.example/red")));
        assertEquals(Arrays.asList("Color", "Size"), offer.dimensions);
        assertEquals(Arrays.asList("Blue", "Red"), offer.values(1, 0));
        assertEquals(Arrays.asList("M"), offer.values(1, 1));
        assertEquals(3, offer.choose(1, 0, "Red"));
        assertEquals(2, offer.choose(3, 1, "L"));
        assertEquals(1, offer.choose(2, 0, "Blue"));
        assertEquals(-1, offer.choose(1, 1, "S"));
        assertEquals(Arrays.asList("https://shop.example/red", "https://shop.example/a", "https://shop.example/b"),
                offer.photos(3, "https://shop.example/a"));
        assertEquals("Cotton", offer.description);
    }

    @Test public void coverPriceRangeIgnoresUnavailableVariantsAndKeepsMarkdownsWithTheirSku() throws Exception {
        JSONObject catalog = new JSONObject().put("title", "Bag").put("vendor", "Andén").put("price", 12)
                .put("currency", "USD").put("previousPrice", 16).put("handoffUrl", "https://shop.example/cart");
        JSONObject sold = variant("sold", "Grey", "XS", false).put("price", 4);
        JSONObject low = variant("low", "Blue", "S", true).put("price", 10);
        JSONObject high = variant("high", "Red", "M", true).put("price", 14).put("previousPrice", 18);
        OverlayCommerce product = OverlayCommerce.parse(catalog.put("variants", new JSONArray().put(sold).put(low).put(high)));
        assertEquals("Andén", product.vendor);
        assertEquals("10", product.minimumPrice.toPlainString());
        assertEquals("14", product.maximumPrice.toPlainString());
        assertNull(product.previousPrice(1));
        assertEquals("18", product.previousPrice(2).toPlainString());
        product = OverlayCommerce.parse(catalog.put("variants", new JSONArray().put(sold).put(low.put("price", 12))));
        assertEquals(product.minimumPrice, product.maximumPrice);
        assertEquals(1, product.availableCount);
        assertEquals("16", product.previousPrice(1).toPlainString());
        JSONObject samePrice = variant("same-price", "Green", "M", true).put("price", 12);
        product = OverlayCommerce.parse(catalog.put("variants", new JSONArray().put(low).put(samePrice)));
        assertNull(product.previousPrice(1));
    }

    @Test public void longOptionLabelsKeepTheWholeSkuSelectable() throws Exception {
        String value = String.join("", java.util.Collections.nCopies(220, "ñ"));
        OverlayCommerce catalog = offer(new JSONArray().put(variant("sku", value, "M", true)));
        assertEquals(Arrays.asList("Color", "Size"), catalog.dimensions);
        assertEquals(0, catalog.choose(0, 0, value));
    }

    @Test public void reachesShopifysLastVariantAndExcludesSoldOutStock() throws Exception {
        JSONArray variants = new JSONArray();
        for (int i = 0; i < 2048; i++) variants.put(variant("sku" + i, "C" + (i / 64), "S" + (i % 64), i > 0));
        OverlayCommerce catalog = offer(variants);
        assertEquals(1, catalog.firstAvailable());
        assertEquals(2047, catalog.choose(catalog.choose(1, 0, "C31"), 1, "S63"));
        assertEquals(-1, catalog.choose(1, 1, "S0"));
        variants.put(variant("overflow", "X", "Y", true));
        assertNull(offer(variants));
        assertEquals(-1, offer(new JSONArray().put(variant("sold", "Blue", "M", false))).firstAvailable());
    }

    @Test public void incompleteOptionsAndDuplicateCombinationsCanStillSelectIndividualSkus() throws Exception {
        OverlayCommerce duplicate = offer(new JSONArray().put(variant("one", "Blue", "M", true))
                .put(variant("two", "Blue", "M", true)));
        assertTrue(duplicate.dimensions.isEmpty());
        JSONObject without = variant("two", "Blue", "L", true);
        without.remove("selectedOptions");
        assertTrue(offer(new JSONArray().put(variant("one", "Blue", "M", true)).put(without)).dimensions.isEmpty());
    }
}

package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

// The rules of the web TV shop (web/tv-shop.mjs), which the native panels follow.
public final class ShopParityTest {
    private static JSONObject variant(String id, String label, String price, String image) throws Exception {
        JSONObject row = new JSONObject().put("id", id).put("label", label).put("price", price).put("availableForSale", true);
        return image == null ? row : row.put("imageUrl", image);
    }

    private static OverlayCommerce offer(JSONArray variants, JSONArray images) throws Exception {
        JSONObject row = new JSONObject().put("title", "Botella térmica").put("price", "29.00").put("currency", "USD").put("locale", "es")
                .put("handoffUrl", "https://ads.example/cart").put("imageUrl", "https://shop.example/bottle.jpg").put("variants", variants);
        return OverlayCommerce.parse(images == null ? row : row.put("images", images));
    }

    @Test public void shopifysDefaultTitleIsHiddenOnlyForASingleVariant() throws Exception {
        assertTrue(offer(new JSONArray().put(variant("d", "Default Title", "12.00", null)), null).defaultVariantOnly());
        assertFalse(offer(new JSONArray().put(variant("a", "500 ml", "29.00", null)), null).defaultVariantOnly());
        assertFalse(offer(new JSONArray().put(variant("d", "Default Title", "12.00", null)).put(variant("b", "Grande", "14.00", null)), null)
                .defaultVariantOnly());
    }

    @Test public void fromIsShownWhenAvailableVariantsCostDifferentAmounts() throws Exception {
        assertTrue(offer(new JSONArray().put(variant("a", "500 ml", "29.00", null)).put(variant("b", "750 ml", "35.00", null)), null).hasPriceRange());
        assertFalse(offer(new JSONArray().put(variant("a", "Negro", "15.00", null)).put(variant("b", "Blanco", "15.00", null)), null).hasPriceRange());
        // A sold-out variant does not make a range, as web counts available variants only.
        JSONArray sold = new JSONArray().put(variant("a", "500 ml", "29.00", null)).put(variant("b", "750 ml", "35.00", null).put("availableForSale", false));
        assertFalse(offer(sold, null).hasPriceRange());
    }

    // The photo button's label counts this list, the one the viewer shows (TvShopView.galleryLabel, TvPhotoGallery).
    @Test public void theViewerListHoldsEachPhotoOnce() throws Exception {
        assertEquals(1, offer(new JSONArray().put(variant("d", "Default Title", "12.00", "https://shop.example/bottle.jpg")), null)
                .photos(0, "https://shop.example/bottle.jpg").size());
        assertEquals(2, offer(new JSONArray().put(variant("a", "Negro", "15.00", "https://shop.example/black.jpg"))
                .put(variant("b", "Blanco", "16.00", "https://shop.example/bottle.jpg")), null).photos(0, null).size());
        assertEquals(3, offer(new JSONArray().put(variant("a", "500 ml", "29.00", null)),
                new JSONArray().put("https://shop.example/side.jpg").put("https://shop.example/top.jpg")).photos(0, null).size());
    }
}

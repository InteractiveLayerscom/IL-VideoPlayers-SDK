package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import android.content.Context;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

// What the native TV and phone panels draw for the web TV shop's rules: "Desde", "Ampliar foto"/"Ver fotos",
// no "Default Title" row.
@RunWith(AndroidJUnit4.class)
public final class ShopPanelParityTest {
    private static OverlayCommerce bottle() throws Exception {
        return OverlayCommerce.parse(new JSONObject().put("title", "Botella térmica").put("price", "29.00").put("currency", "USD")
                .put("locale", "es").put("vendor", "Andén").put("handoffUrl", "https://ads.example/cart")
                .put("imageUrl", "https://shop.example/bottle.jpg").put("images", new JSONArray().put("https://shop.example/bottle-side.jpg"))
                .put("variants", new JSONArray()
                        .put(new JSONObject().put("id", "500").put("label", "500 ml").put("price", "29.00"))
                        .put(new JSONObject().put("id", "750").put("label", "750 ml").put("price", "35.00"))));
    }

    private static OverlayCommerce pouch() throws Exception {
        return OverlayCommerce.parse(new JSONObject().put("title", "Estuche de viaje").put("price", "12.00").put("currency", "USD")
                .put("locale", "es").put("handoffUrl", "https://ads.example/cart").put("imageUrl", "https://shop.example/pouch.jpg")
                .put("variants", new JSONArray().put(new JSONObject().put("id", "d").put("label", "Default Title").put("price", "12.00")
                        .put("selectedOptions", new JSONArray().put(new JSONObject().put("name", "Title").put("value", "Default Title"))))));
    }

    private interface Check { void run(FrameLayout screen, CommercePanel shop) throws Exception; }

    private static void panel(OverlayCommerce offer, boolean tv, Check check) {
        ExecutorService workers = Executors.newSingleThreadExecutor();
        Throwable[] failure = new Throwable[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            FrameLayout screen = new FrameLayout(context);
            // Not attached to a window: a manual layout pass is enough for these checks.
            CommercePanel shop = new CommercePanel(screen, offer, null, null, null, new OverlayNetwork(), workers, tv, () -> {}, () -> {});
            screen.measure(View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY));
            screen.layout(0, 0, 1920, 1080);
            try {
                check.run(screen, shop);
            } catch (Throwable e) {
                failure[0] = e;
            }
        });
        workers.shutdownNow();
        if (failure[0] instanceof AssertionError) throw (AssertionError) failure[0];
        if (failure[0] != null) throw new AssertionError(failure[0]);
    }

    @Test public void theTvCoverSaysFromAndViewPhotosForSeveralPricesAndPhotos() {
        panel(unchecked(ShopPanelParityTest::bottle), true, (screen, shop) -> {
            List<String> shown = visibleTexts(screen);
            assertTrue(shown.toString(), shown.stream().anyMatch(t -> t.startsWith("Desde ") && t.contains("29")));
            assertFalse(shown.toString(), shown.stream().anyMatch(t -> t.contains("35")));
            assertTrue(shown.contains("Ver fotos"));
            assertTrue(shown.contains("Elegir opciones"));
        });
    }

    @Test public void aSingleVariantProductWithOnePhotoHasNoDefaultTitleRow() {
        panel(unchecked(ShopPanelParityTest::pouch), true, (screen, shop) -> {
            List<String> cover = visibleTexts(screen);
            assertTrue(cover.contains("Ampliar foto"));
            assertFalse(cover.stream().anyMatch(t -> t.startsWith("Desde")));
            Button details = buttonIn(screen, "Ver detalles");
            assertNotNull(cover.toString(), details);
            details.performClick();
            List<String> detail = visibleTexts(screen);
            assertFalse(detail.toString(), detail.contains("Default Title"));
            assertFalse(detail.toString(), detail.contains("Title"));
            assertTrue(detail.contains("Agregar al carrito"));
        });
    }

    @Test public void thePhonePanelHasNoVariantRowForASingleVariantProduct() {
        panel(unchecked(ShopPanelParityTest::pouch), false, (screen, shop) -> {
            List<String> shown = visibleTexts(screen);
            assertFalse(shown.toString(), shown.contains("Default Title"));
            assertFalse(shown.toString(), shown.contains("Variante"));
            assertTrue(shown.contains("Comprar"));
        });
    }

    // The focused control at each TV stage (web/tv-shop.mjs:358): the selected option on details when there is an
    // option row, otherwise the action; Back from the cart returns to the same control.
    @Test public void tvFocusAtEachStageWithAndWithoutOptions() {
        String[][] cases = {
                {"bottle", "Elegir opciones", "500 ml", "Continuar con el QR"},
                {"pouch", "Ver detalles", "Agregar al carrito", "Continuar con el QR"},
        };
        for (String[] expected : cases) {
            OverlayCommerce offer = unchecked(expected[0].equals("bottle") ? ShopPanelParityTest::bottle : ShopPanelParityTest::pouch);
            panel(offer, true, (screen, shop) -> {
                assertEquals(expected[0] + " cover", expected[1], focused(screen));
                buttonIn(screen, expected[1]).performClick();
                assertEquals(expected[0] + " details", expected[2], focused(screen));
                buttonIn(screen, "Agregar al carrito").performClick();
                assertEquals(expected[0] + " cart", expected[3], focused(screen));
                assertTrue(shop.closeDetails());
                assertEquals(expected[0] + " Back from the cart", expected[2], focused(screen));
            });
        }
    }

    private static String focused(View screen) {
        View focus = screen.findFocus();
        return focus instanceof TextView ? ((TextView) focus).getText().toString() : String.valueOf(focus);
    }

    // isShown() needs a window; here a view counts as visible when it and its ancestors are VISIBLE.
    private static List<String> visibleTexts(View view) {
        List<String> out = new ArrayList<>();
        if (view.getVisibility() != View.VISIBLE) return out;
        if (view instanceof TextView) out.add(((TextView) view).getText().toString());
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) out.addAll(visibleTexts(((ViewGroup) view).getChildAt(i)));
        return out;
    }

    private static Button buttonIn(View view, String text) {
        if (view.getVisibility() != View.VISIBLE) return null;
        if (view instanceof Button && text.equals(((Button) view).getText().toString())) return (Button) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            Button found = buttonIn(((ViewGroup) view).getChildAt(i), text);
            if (found != null) return found;
        }
        return null;
    }

    private interface Source { OverlayCommerce get() throws Exception; }

    private static OverlayCommerce unchecked(Source source) {
        try {
            return source.get();
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}

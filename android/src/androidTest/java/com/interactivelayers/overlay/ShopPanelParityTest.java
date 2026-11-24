package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import android.content.Context;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
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
            // As web: a small «Desde» followed by the lowest amount, as two texts.
            int from = shown.indexOf("Desde");
            assertTrue(shown.toString(), from >= 0 && shown.get(from + 1).startsWith("29"));
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

    // The web TV shop's structure (web/tv-shop.mjs, tv-shop.css): Back and the left-aligned heading in one row, the
    // caption pill inside the photo box, and the cover's two actions side by side, the primary one first and wider.
    @Test public void theTvCoverHasTheWebLayout() {
        panel(unchecked(ShopPanelParityTest::bottle), true, (screen, shop) -> {
            TextView heading = textIn(screen, "Producto");
            Button back = buttonIn(screen, "‹");
            assertNotNull(heading);
            assertNotNull(back);
            assertSame(back.getParent(), heading.getParent());
            // Not attached to a window, so positions are read from the layout, relative to the shared row.
            View row = (View) back.getParent();
            assertTrue("heading right of Back", heading.getLeft() >= back.getRight());
            assertTrue("heading text left of the row's centre",
                    heading.getLeft() + heading.getPaint().measureText("Producto") < row.getWidth() / 2f);

            TextView chip = textIn(screen, "Ampliar foto");
            assertNotNull(chip);
            assertFalse(chip instanceof Button);
            View box = (View) chip.getParent();
            assertTrue(box instanceof FrameLayout && box.isFocusable() && "Ampliar foto".contentEquals(box.getContentDescription()));
            assertTrue("pill at the bottom-right corner", chip.getRight() <= box.getWidth() && chip.getRight() > box.getWidth() * .7f
                    && chip.getBottom() <= box.getHeight() && chip.getBottom() > box.getHeight() * .7f);

            Button primary = buttonIn(screen, "Elegir opciones"), secondary = buttonIn(screen, "Ver fotos");
            assertNotNull(primary);
            assertNotNull(secondary);
            assertSame(primary.getParent(), secondary.getParent());
            assertEquals(LinearLayout.HORIZONTAL, ((LinearLayout) primary.getParent()).getOrientation());
            assertTrue(primary.getRight() <= secondary.getLeft());
            assertTrue(primary.getWidth() > secondary.getWidth());
        });
    }

    // A cover taller than its space on a 1280x720 player: UP and DOWN scroll the body before focus leaves it, so the
    // remote reaches every line under the photo and comes back.
    @Test public void aLongCoverCanBeReadToTheEndWithTheRemote() {
        String words = "Botella térmica de acero inoxidable con doble pared, tapa a rosca, asa de silicona y acabado mate ";
        ExecutorService workers = Executors.newSingleThreadExecutor();
        Throwable[] failure = new Throwable[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try {
                JSONArray variants = new JSONArray();
                String[] colors = {"Negro", "Blanco", "Rojo", "Verde"}, sizes = {"350 ml", "500 ml", "750 ml", "1 l"};
                String[] finishes = {"Acero cepillado", "Pintura mate texturada", "Esmalte brillante"};
                for (String color : colors) for (String size : sizes) for (String finish : finishes) variants.put(new JSONObject()
                        .put("id", color + size + finish).put("label", color + " / " + size + " / " + finish)
                        .put("price", size.equals("1 l") ? "39.00" : "29.00")
                        .put("selectedOptions", new JSONArray().put(new JSONObject().put("name", "Color").put("value", color))
                                .put(new JSONObject().put("name", "Capacidad").put("value", size))
                                .put(new JSONObject().put("name", "Acabado").put("value", finish))));
                for (boolean photo : new boolean[]{true, false}) {
                    // Without the photo's third of the height, a longer title is needed to overflow (web clamps no title).
                    String title = photo ? words + words : (words + words + words).substring(0, 256);
                    JSONObject row = new JSONObject().put("title", title).put("price", "29.00")
                            .put("currency", "USD").put("locale", "es").put("vendor", "Andén Tienda Oficial de Viaje y Cocina")
                            .put("description", words + words + words + words).put("handoffUrl", "https://ads.example/cart")
                            .put("variants", variants);
                    if (photo) row.put("imageUrl", "https://shop.example/bottle.jpg");
                    OverlayCommerce offer = OverlayCommerce.parse(row);
                    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
                    FrameLayout player = new FrameLayout(context);
                    layout(player, 1280, 720);
                    CommercePanel shop = new CommercePanel(player, offer, null, null, null, new OverlayNetwork(), workers, true, () -> {}, () -> {});
                    layout(player, 1280, 720);
                    String what = photo ? "with a photo: " : "without an image: ";
                    ScrollView scroll = scrollIn(shop);
                    assertNotNull(scroll);
                    assertTrue(what + "the long cover overflows its space", scroll.canScrollVertically(1));
                    assertEquals(what + "initial focus", "Elegir opciones", focused(shop));
                    int maximum = scroll.getChildAt(0).getHeight() - scroll.getHeight();
                    // DOWN alone, from the initial focus in the footer, reaches the last line.
                    for (int i = 0; i < 20 && scroll.getScrollY() < maximum; i++) key(shop, KeyEvent.KEYCODE_DPAD_DOWN, player);
                    assertEquals(what + "DOWN reached the last line", maximum, scroll.getScrollY());
                    assertEquals(what + "focus stays on the action", "Elegir opciones", focused(shop));
                    // A DOWN at the end changes nothing and is not taken from a page that cannot scroll further.
                    key(shop, KeyEvent.KEYCODE_DPAD_DOWN, player);
                    assertEquals(what + "focus at the end", "Elegir opciones", focused(shop));
                    if (!photo) {
                        // No control in the body: UP returns to the top while focus stays on the action.
                        for (int i = 0; i < 20 && scroll.getScrollY() > 0; i++) key(shop, KeyEvent.KEYCODE_DPAD_UP, player);
                        assertEquals(what + "UP scrolled back to the top", 0, scroll.getScrollY());
                        assertEquals(what + "focus after UP", "Elegir opciones", focused(shop));
                    } else {
                        // UP scrolls while the photo box is out of view, then focus moves into it once it shows.
                        for (int i = 0; i < 20 && !(shop.findFocus() instanceof FrameLayout); i++) key(shop, KeyEvent.KEYCODE_DPAD_UP, player);
                        assertTrue("the photo box takes focus", shop.findFocus() instanceof FrameLayout);
                        // DOWN from the photo box scrolls to the last line before leaving it.
                        int reached = 0;
                        for (int i = 0; i < 20 && !"Elegir opciones".equals(focused(shop)); i++) {
                            key(shop, KeyEvent.KEYCODE_DPAD_DOWN, player);
                            reached = Math.max(reached, scroll.getScrollY());
                        }
                        assertEquals("DOWN from the photo box scrolled to the last line before leaving", maximum, reached);
                    }
                }
            } catch (Throwable e) {
                failure[0] = e;
            }
        });
        workers.shutdownNow();
        if (failure[0] instanceof AssertionError) throw (AssertionError) failure[0];
        if (failure[0] != null) throw new AssertionError(failure[0]);
    }

    // Details that overflow on a 1280x720 player: from «Agregar al carrito», one UP lands on the last option group in
    // view, without the body jumping to the top. (The catalog parser keeps at most three option groups per product.)
    @Test public void upFromTheActionReachesTheLastVisibleOptionGroup() {
        String words = "Botella térmica de acero inoxidable con doble pared, tapa a rosca, asa de silicona y acabado mate ";
        String[] colors = {"Negro", "Blanco", "Rojo", "Verde"}, sizes = {"350 ml", "500 ml", "750 ml", "1 l"};
        String[] finishes = {"Acero cepillado", "Pintura mate texturada", "Esmalte brillante"};
        ExecutorService workers = Executors.newSingleThreadExecutor();
        Throwable[] failure = new Throwable[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try {
                JSONArray variants = new JSONArray();
                for (String color : colors) for (String size : sizes) for (String finish : finishes) variants.put(new JSONObject()
                        .put("id", color + size + finish).put("label", color + " / " + size + " / " + finish).put("price", "29.00")
                        .put("selectedOptions", new JSONArray().put(new JSONObject().put("name", "Color").put("value", color))
                                .put(new JSONObject().put("name", "Capacidad").put("value", size))
                                .put(new JSONObject().put("name", "Acabado").put("value", finish))));
                OverlayCommerce offer = OverlayCommerce.parse(new JSONObject().put("title", (words + words + words).substring(0, 256))
                        .put("price", "29.00").put("currency", "USD").put("locale", "es").put("handoffUrl", "https://ads.example/cart")
                        .put("imageUrl", "https://shop.example/bottle.jpg").put("variants", variants));
                Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
                FrameLayout player = new FrameLayout(context);
                layout(player, 1280, 720);
                CommercePanel shop = new CommercePanel(player, offer, null, null, null, new OverlayNetwork(), workers, true, () -> {}, () -> {});
                layout(player, 1280, 720);
                buttonIn(shop, "Elegir opciones").performClick();
                layout(player, 1280, 720);
                ScrollView scroll = scrollIn(shop);
                assertTrue("the details overflow their space", scroll.canScrollVertically(1) || scroll.canScrollVertically(-1));
                for (int i = 0; i < 30 && !"Agregar al carrito".equals(focused(shop)); i++) key(shop, KeyEvent.KEYCODE_DPAD_DOWN, player);
                assertEquals("Agregar al carrito", focused(shop));
                int before = scroll.getScrollY();
                assertTrue("the body is scrolled down", before > 0);
                key(shop, KeyEvent.KEYCODE_DPAD_UP, player);
                assertTrue("one UP lands on the last group: " + focused(shop), java.util.Arrays.asList(finishes).contains(focused(shop)));
                assertTrue("the body did not jump to the top", scroll.getScrollY() > 0 && scroll.getScrollY() >= before - scroll.getHeight() / 2);
            } catch (Throwable e) {
                failure[0] = e;
            }
        });
        workers.shutdownNow();
        if (failure[0] instanceof AssertionError) throw (AssertionError) failure[0];
        if (failure[0] != null) throw new AssertionError(failure[0]);
    }

    private static void layout(View view, int width, int height) {
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        view.layout(0, 0, width, height);
    }

    private static void key(View panel, int code, View player) {
        View focused = panel.findFocus();
        assertNotNull(focused);
        boolean handled = panel.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, code));
        panel.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, code));
        if (!handled) {
            // Not attached to a window: move focus the way the framework would after an unhandled D-pad key.
            View next = focused.focusSearch(code == KeyEvent.KEYCODE_DPAD_DOWN ? View.FOCUS_DOWN : View.FOCUS_UP);
            if (next != null) next.requestFocus();
        }
        layout(player, 1280, 720);
    }

    private static ScrollView scrollIn(View view) {
        if (view instanceof ScrollView) return (ScrollView) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            ScrollView found = scrollIn(((ViewGroup) view).getChildAt(i));
            if (found != null) return found;
        }
        return null;
    }

    private static TextView textIn(View view, String text) {
        if (view.getVisibility() != View.VISIBLE) return null;
        if (view instanceof TextView && text.equals(((TextView) view).getText().toString())) return (TextView) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            TextView found = textIn(((ViewGroup) view).getChildAt(i), text);
            if (found != null) return found;
        }
        return null;
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

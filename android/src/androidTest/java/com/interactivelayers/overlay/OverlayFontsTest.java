package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

// The bundled Montserrat on the product panels, at the web shop's weights, and the system font below API 26.
@RunWith(AndroidJUnit4.class)
public final class OverlayFontsTest {
    @After public void restore() { OverlayFonts.reset(); }

    private static Context context() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }

    private static OverlayCommerce bottle() throws Exception {
        return OverlayCommerce.parse(new JSONObject().put("title", "Botella térmica").put("price", "29.00").put("currency", "USD")
                .put("locale", "es").put("vendor", "Andén").put("handoffUrl", "https://ads.example/cart")
                .put("imageUrl", "https://shop.example/bottle.jpg")
                .put("variants", new JSONArray()
                        .put(new JSONObject().put("id", "500").put("label", "500 ml").put("price", "29.00"))
                        .put(new JSONObject().put("id", "750").put("label", "750 ml").put("price", "35.00"))));
    }

    private static TextView find(View view, String text) {
        if (view instanceof TextView && text.equals(((TextView) view).getText().toString())) return (TextView) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            TextView found = find(((ViewGroup) view).getChildAt(i), text);
            if (found != null) return found;
        }
        return null;
    }

    private interface Check { void run(FrameLayout screen) throws Exception; }

    private static void panel(boolean tv, Check check) {
        ExecutorService workers = Executors.newSingleThreadExecutor();
        Throwable[] failure = new Throwable[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try {
                FrameLayout screen = new FrameLayout(context());
                new CommercePanel(screen, bottle(), null, null, null, new OverlayNetwork(), workers, tv, () -> {}, () -> {});
                check.run(screen);
            } catch (Throwable e) {
                failure[0] = e;
            }
        });
        workers.shutdownNow();
        if (failure[0] instanceof AssertionError) throw (AssertionError) failure[0];
        if (failure[0] != null) throw new AssertionError(failure[0]);
    }

    /** Montserrat's glyphs are wider than the system font's: the width of a sample tells the two apart. */
    private static float width(Typeface face) {
        Paint paint = new Paint();
        paint.setTextSize(100);
        paint.setTypeface(face);
        return paint.measureText("Botella térmica 29,00");
    }

    @Test public void theBundledFontLoadsAtEachWebWeight() {
        long start = System.nanoTime();
        Typeface first = OverlayFonts.montserrat(context(), 500);
        long firstMicros = (System.nanoTime() - start) / 1000;
        start = System.nanoTime();
        for (int weight : new int[]{600, 650, 700}) assertNotNull(OverlayFonts.montserrat(context(), weight));
        long moreMicros = (System.nanoTime() - start) / 1000;
        start = System.nanoTime();
        assertSame(first, OverlayFonts.montserrat(context(), 500));
        long cachedMicros = (System.nanoTime() - start) / 1000;
        Log.i("ILFONT", "first weight " + firstMicros + " us, three more " + moreMicros + " us, cached " + cachedMicros + " us");
        assertNotNull(first);
        assertNotEquals(width(Typeface.DEFAULT), width(first), 1f);
        assertTrue("700 is wider than 500", width(OverlayFonts.montserrat(context(), 700)) > width(first));
    }

    @Test public void theTvAndPhonePanelsUseItAtTheWebWeights() {
        panel(true, screen -> {
            assertSame(OverlayFonts.montserrat(context(), 700), find(screen, "Botella térmica").getTypeface());
            assertSame(OverlayFonts.montserrat(context(), 650), find(screen, "Andén").getTypeface());
            assertSame(OverlayFonts.montserrat(context(), 500), find(screen, "Desde").getTypeface());
            assertSame(OverlayFonts.montserrat(context(), 600), find(screen, "Elegir opciones").getTypeface());
            assertSame(OverlayFonts.montserrat(context(), 700), find(screen, "Producto").getTypeface());
        });
        panel(false, screen -> {
            assertSame(OverlayFonts.montserrat(context(), 700), find(screen, "Botella térmica").getTypeface());
            Button buy = (Button) find(screen, "Comprar");
            assertSame(OverlayFonts.montserrat(context(), 600), buy.getTypeface());
        });
    }

    @Test public void belowApi26ThePanelsDrawInTheSystemFont() {
        java.util.List<Typeface> bundled = new java.util.ArrayList<>();
        for (int weight : new int[]{500, 600, 650, 700}) bundled.add(OverlayFonts.montserrat(context(), weight));
        OverlayFonts.reset();
        OverlayFonts.sdk = 25;
        Check systemOnly = screen -> {
            for (String text : new String[]{"Botella térmica", "Andén", "Desde", "Elegir opciones", "Producto", "Comprar"}) {
                TextView view = find(screen, text);
                if (view == null) continue;
                assertFalse(text + " is not in Montserrat", bundled.contains(view.getTypeface()));
                assertNotNull(text + " has a typeface", view.getTypeface());
            }
        };
        panel(true, screen -> {
            systemOnly.run(screen);
            // The API 23-25 branch: regular and bold system faces, as the TV panel drew on main.
            assertSame(Typeface.DEFAULT_BOLD, find(screen, "Botella térmica").getTypeface());
            assertSame(Typeface.DEFAULT_BOLD, find(screen, "Andén").getTypeface());
            assertSame(Typeface.DEFAULT, find(screen, "Desde").getTypeface());
            assertSame(Typeface.DEFAULT_BOLD, find(screen, "Elegir opciones").getTypeface());
            assertSame(Typeface.DEFAULT_BOLD, find(screen, "Producto").getTypeface());
        });
        panel(false, screen -> { systemOnly.run(screen); phoneAsOnMain(screen); });
        assertNull("nothing loaded below 26", OverlayFonts.montserrat(context(), 500));
    }

    /** Without Montserrat the phone panel is exactly main's: bold labels in DEFAULT BOLD, others and Buy untouched. */
    private static void phoneAsOnMain(FrameLayout screen) {
        assertSame(Typeface.create(Typeface.DEFAULT, Typeface.BOLD), find(screen, "Botella térmica").getTypeface());
        assertSame(new TextView(context()).getTypeface(), find(screen, "Producto").getTypeface());
        assertSame(new Button(context()).getTypeface(), find(screen, "Comprar").getTypeface());
    }

    // A device that ignores the variation settings would draw the font's default instance, Thin. The loader checks
    // once that 700 measures wider than 500; when it does not, nothing is handed out and the panels use the system font.
    @Test public void ignoredWeightsFallBackToTheSystemFont() {
        OverlayFonts.reset();
        OverlayFonts.measure = typeface -> 100f;
        for (int weight : new int[]{500, 600, 650, 700}) assertNull(OverlayFonts.montserrat(context(), weight));
        Typeface regular = OverlayFonts.at(context(), 500), bold = OverlayFonts.at(context(), 700);
        assertEquals(Typeface.create(Typeface.DEFAULT, 500, false), regular);
        assertEquals(Typeface.create(Typeface.DEFAULT, 700, false), bold);
        panel(false, OverlayFontsTest::phoneAsOnMain);
    }

    // A context that cannot reach its assets does not switch the font off for the process.
    @Test public void aMissingContextDoesNotDisableTheFont() {
        OverlayFonts.reset();
        assertNull(OverlayFonts.montserrat(null, 500));
        assertNotNull(OverlayFonts.montserrat(context(), 500));
    }
}

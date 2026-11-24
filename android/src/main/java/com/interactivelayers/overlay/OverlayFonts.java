package com.interactivelayers.overlay;

import android.content.Context;
import android.content.res.AssetManager;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.os.Build;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The bundled Montserrat (Google Fonts, SIL OFL 1.1; licence next to the file) at the CSS weights the web shop uses.
 * One typeface per weight, built once per process from the variable font. Weights need API 26
 * (Typeface.Builder with font variation settings); below that, or if the font cannot be used, callers get the
 * system font, so a panel is always drawn in one typeface.
 */
final class OverlayFonts {
    static final String PATH = "interactivelayers/fonts/Montserrat[wght].ttf";
    private static final Map<Integer, Typeface> weights = new ConcurrentHashMap<>();
    private static volatile boolean unavailable, axisChecked;
    /** The API level the loader acts on; tests lower it to take the fallback path. */
    static volatile int sdk = Build.VERSION.SDK_INT;

    /** Width of a sample in a typeface; tests replace it to simulate a device that ignores the weight axis. */
    interface Measure { float width(Typeface typeface); }
    static volatile Measure measure = OverlayFonts::sampleWidth;

    private OverlayFonts() {}

    private static float sampleWidth(Typeface typeface) {
        Paint paint = new Paint();
        paint.setTextSize(100);
        paint.setTypeface(typeface);
        return paint.measureText("Botella térmica 29,00");
    }

    /** Montserrat at a CSS weight (100-900), or null when it cannot be used on this device. */
    static Typeface montserrat(Context context, int weight) {
        if (Build.VERSION.SDK_INT < 26 || sdk < 26 || unavailable) return null;
        Context app = context == null ? null : context.getApplicationContext();
        AssetManager assets = app == null ? null : app.getAssets();
        // No context to read from is not a property of the font: no latch, a later call may succeed.
        if (assets == null) return null;
        int clamped = Math.max(100, Math.min(900, weight));
        Typeface cached = weights.get(clamped);
        if (cached != null) return cached;
        // The font's default instance is Thin (wght 100). A device that ignores the variation settings would draw
        // every text in Thin, so check once that 700 comes out wider than 500 before handing anything out.
        if (!axisChecked) {
            Typeface regular = build(assets, 500), bold = build(assets, 700);
            if (regular == null || bold == null || !(measure.width(bold) > measure.width(regular))) {
                unavailable = true;
                return null;
            }
            weights.putIfAbsent(500, regular);
            weights.putIfAbsent(700, bold);
            axisChecked = true;
            cached = weights.get(clamped);
            if (cached != null) return cached;
        }
        Typeface built = build(assets, clamped);
        if (built == null) {
            unavailable = true;
            return null;
        }
        Typeface stored = weights.putIfAbsent(clamped, built);
        return stored != null ? stored : built;
    }

    private static Typeface build(AssetManager assets, int weight) {
        // The real level, next to the `sdk` hook in montserrat(), so lint sees the API 26 guard.
        if (Build.VERSION.SDK_INT < 26) return null;
        try {
            Typeface built = new Typeface.Builder(assets, PATH).setFontVariationSettings("'wght' " + weight).build();
            return built == null || built == Typeface.DEFAULT ? null : built;
        } catch (RuntimeException failure) {
            return null;
        }
    }

    /** Builds the weights the panels use (web/tv-shop.css: 500 text, 600 buttons, 650 headings, 700 titles). */
    static void warm(Context context) {
        for (int weight : new int[]{500, 600, 650, 700}) if (montserrat(context, weight) == null) return;
    }

    /** Montserrat at the weight, else the system font at the nearest of regular and bold. */
    static Typeface at(Context context, int weight) {
        Typeface font = montserrat(context, weight);
        if (font != null) return font;
        if (Build.VERSION.SDK_INT >= 28 && sdk >= 28) return Typeface.create(Typeface.DEFAULT, Math.max(1, Math.min(1000, weight)), false);
        return weight >= 600 ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT;
    }

    /** True when a CSS font-family list asks for Montserrat first ("Montserrat, sans-serif", "'Montserrat'"). */
    static boolean asksForMontserrat(String family) {
        if (family == null) return false;
        String first = family.split(",", 2)[0].trim();
        if (first.length() >= 2 && (first.charAt(0) == '"' || first.charAt(0) == '\'')) first = first.substring(1, first.length() - 1);
        return first.trim().equalsIgnoreCase("Montserrat");
    }

    /** Test hook: forget built typefaces, failures and replaced seams. */
    static void reset() {
        weights.clear();
        unavailable = false;
        axisChecked = false;
        sdk = Build.VERSION.SDK_INT;
        measure = OverlayFonts::sampleWidth;
    }
}

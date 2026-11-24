package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import org.junit.Test;

public final class OverlayFontsTest {
    @Test public void aSceneLayerGetsTheBundledFontOnlyWhenItAsksForMontserratFirst() {
        assertTrue(OverlayFonts.asksForMontserrat("Montserrat"));
        assertTrue(OverlayFonts.asksForMontserrat("montserrat, Inter, system-ui, sans-serif"));
        assertTrue(OverlayFonts.asksForMontserrat("'Montserrat', sans-serif"));
        assertTrue(OverlayFonts.asksForMontserrat(" \"Montserrat\" "));
        assertFalse(OverlayFonts.asksForMontserrat("Inter, Montserrat"));
        assertFalse(OverlayFonts.asksForMontserrat("Montserrat Alternates"));
        assertFalse(OverlayFonts.asksForMontserrat(""));
        assertFalse(OverlayFonts.asksForMontserrat(null));
    }

    @Test public void belowApi26TheLoaderNeverReadsTheFile() {
        try {
            OverlayFonts.sdk = 25;
            // A null context would throw if the loader tried to open the asset.
            assertNull(OverlayFonts.montserrat(null, 700));
        } finally {
            OverlayFonts.reset();
        }
    }
}

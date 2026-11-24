package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import org.junit.Test;

// iADServer answers 404 once a delivery has expired: the panel then says the offer is no longer available (as web's
// `gone`) instead of offering a retry that would fail again. Any other failure keeps the retry.
public final class CartFailureTest {
    @Test public void a404MeansTheOfferIsGone() {
        assertTrue(OverlayNetwork.cartFailure(404) instanceof OverlayNetwork.OfferGone);
    }

    // Every language of the panel carries web's message at the same place (web/commerce.mjs copy, index 9).
    @Test public void eachLanguageHasTheOfferGoneMessage() {
        assertEquals("Esta oferta ya no está disponible.", CommercePanel.labels("es")[8]);
        assertEquals("Esta oferta não está mais disponível.", CommercePanel.labels("pt-BR")[8]);
        assertEquals("This offer is no longer available.", CommercePanel.labels("en")[8]);
        assertEquals("This offer is no longer available.", CommercePanel.labels("fr")[8]);
        for (String locale : new String[]{"es", "pt-BR", "en"}) assertEquals(locale, 9, CommercePanel.labels(locale).length);
    }

    @Test public void otherFailuresCanBeRetried() {
        for (int status : new int[]{400, 401, 403, 409, 410, 429, 500, 502, 503})
            assertFalse(String.valueOf(status), OverlayNetwork.cartFailure(status) instanceof OverlayNetwork.OfferGone);
    }
}

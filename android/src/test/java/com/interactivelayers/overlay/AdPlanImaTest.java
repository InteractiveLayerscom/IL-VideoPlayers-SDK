package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import com.google.ads.interactivemedia.v3.api.AdError;
import org.junit.Test;

public final class AdPlanImaTest {
    // Seen on the Android emulator: IMA's VAST timeout on a stalled first request was treated as an answer IMA could
    // not play, the MP4 path asked the same stalled URL again, and the hold ended before the second request.
    @Test public void aTimeoutOrARefusedRequestGoesToTheNextRequest() {
        for (AdError.AdErrorCode code : new AdError.AdErrorCode[] {AdError.AdErrorCode.VAST_EMPTY_RESPONSE,
                AdError.AdErrorCode.VAST_LOAD_TIMEOUT, AdError.AdErrorCode.FAILED_TO_REQUEST_ADS,
                AdError.AdErrorCode.VAST_TOO_MANY_REDIRECTS}) {
            assertTrue(code.name(), AdPlanIma.noAnswer(code));
        }
    }

    @Test public void anAnswerImaCannotPlayStillTriesTheMp4Path() {
        for (AdError.AdErrorCode code : new AdError.AdErrorCode[] {AdError.AdErrorCode.VAST_LINEAR_ASSET_MISMATCH,
                AdError.AdErrorCode.VAST_MEDIA_LOAD_TIMEOUT, AdError.AdErrorCode.VIDEO_PLAY_ERROR}) {
            assertFalse(code.name(), AdPlanIma.noAnswer(code));
        }
    }
}

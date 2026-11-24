package com.interactivelayers.overlay;

import android.view.KeyEvent;

/** Media keys from the ad's views while the SDK holds the host's controller (OverlayController.mediaKey). */
interface MediaKeys {
    boolean handle(KeyEvent event);
}

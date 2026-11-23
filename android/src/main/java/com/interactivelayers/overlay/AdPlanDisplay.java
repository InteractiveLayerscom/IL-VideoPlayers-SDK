package com.interactivelayers.overlay;

import java.util.Map;

/** A 300x250 display slot for the plan's Overlay. {@link AdPlanGma} is the Google Mobile Ads one. */
public interface AdPlanDisplay {
    interface Callback {
        void filled();
        void empty();
        void impression();
    }

    /** False where this slot cannot serve, such as a TV. The plan then uses its other formats. */
    default boolean supported() { return true; }

    void request(String adUnit, Map<String, String> targeting, Callback callback);
    void setVisible(boolean visible);
    void clear();
}

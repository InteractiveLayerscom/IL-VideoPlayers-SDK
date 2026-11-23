package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import android.content.Context;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

// On the Android TV emulator, DPAD_DOWN from the variant left the product panel for the PlayerView's time bar,
// which sat just below it on the host's side of the screen.
@RunWith(AndroidJUnit4.class)
public final class TvShopFocusTest {
    @Test public void theRemoteStaysInsideTheOpenPanel() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            FrameLayout screen = new FrameLayout(context);
            Button timeBar = button(context, "time bar");
            FrameLayout.LayoutParams bar = new FrameLayout.LayoutParams(1100, 40);
            bar.topMargin = 900;
            screen.addView(timeBar, bar);
            LinearLayout panel = new LinearLayout(context);
            panel.setOrientation(LinearLayout.VERTICAL);
            Button variant = button(context, "variant");
            Button add = button(context, "add to cart");
            panel.addView(variant, new LinearLayout.LayoutParams(750, 80));
            LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(750, 80);
            gap.topMargin = 300;
            panel.addView(add, gap);
            FrameLayout.LayoutParams right = new FrameLayout.LayoutParams(800, 1080);
            right.leftMargin = 1100;
            right.topMargin = 500;
            screen.addView(panel, right);
            screen.measure(View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY));
            screen.layout(0, 0, 1920, 1080);

            assertSame(add, TvShopView.keepInside(panel, variant, View.FOCUS_DOWN));
            assertSame("nothing further down in the panel: focus stays", add, TvShopView.keepInside(panel, add, View.FOCUS_DOWN));
            assertSame(variant, TvShopView.keepInside(panel, add, View.FOCUS_UP));
            assertSame("nothing to the left inside the panel", variant, TvShopView.keepInside(panel, variant, View.FOCUS_LEFT));

            // A collapsed panel (GONE) or one inside a hidden container no longer holds the remote.
            panel.setVisibility(View.GONE);
            assertNull(TvShopView.keepInside(panel, variant, View.FOCUS_DOWN));
            panel.setVisibility(View.VISIBLE);
            screen.setVisibility(View.INVISIBLE);
            assertNull(TvShopView.keepInside(panel, variant, View.FOCUS_DOWN));
        });
    }

    private static Button button(Context context, String text) {
        Button button = new Button(context);
        button.setText(text);
        button.setFocusable(true);
        // A phone emulator runs the test in touch mode, where a plain button takes no focus; TV is never in it.
        button.setFocusableInTouchMode(true);
        button.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return button;
    }
}

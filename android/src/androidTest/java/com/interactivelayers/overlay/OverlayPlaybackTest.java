package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import android.app.Dialog;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.Button;
import android.widget.ImageView;
import androidx.media3.common.MediaItem;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.platform.io.PlatformTestStorageRegistry;
import okhttp3.HttpUrl;
import java.io.OutputStream;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class OverlayPlaybackTest {
    private ActivityScenario<FixtureActivity> activity;
    private PlayerView view;
    private ExoPlayer player;
    private View content;
    private ViewGroup.LayoutParams original;
    private OverlayController overlays;
    private FixturePublisher network;

    @Before public void open() throws Exception {
        network = new FixturePublisher(InstrumentationRegistry.getInstrumentation().getContext().getAssets());
        activity = ActivityScenario.launch(FixtureActivity.class);
        activity.onActivity(a -> {
            view = new PlayerView(a);
            view.setUseController(false);
            FrameLayout root = new FrameLayout(a);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                root.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                return insets;
            });
            AspectRatioFrameLayout tv = new AspectRatioFrameLayout(a);
            tv.setAspectRatio(16f / 9f);
            root.addView(tv, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
            tv.addView(view, new FrameLayout.LayoutParams(-1, -1));
            a.setContentView(root);
            content = view.findViewById(androidx.media3.ui.R.id.exo_content_frame);
            original = content.getLayoutParams();
            player = new ExoPlayer.Builder(a).build();
            view.setPlayer(player);
            player.setMediaItem(MediaItem.fromUri(network.url("/live.m3u8")));
            player.setPlaybackSpeed(.5f);
            player.prepare();
        });
    }

    @After public void close() throws Exception {
        activity.onActivity(a -> {
            if (overlays != null) overlays.close();
            view.setPlayer(null);
            player.release();
        });
        activity.close();
        network.close();
    }

    @Test public void loadedHlsFollowsTheExistingPlayerAndRestoresItsExactLayout() throws Exception {
        activity.onActivity(a -> {
            overlays = OverlayController.attach(view);
            overlays.setLinearAdActive(true);
            player.seekTo(1000);
            player.play();
        });
        await(() -> player.isPlaying());
        assertTrue(network.images.isEmpty());
        activity.onActivity(a -> overlays.setLinearAdActive(false));
        await(() -> network.impressions.contains("/measure/l"));
        assertVisibleFrame("l");
        activity.onActivity(a -> {
            assertSame(player, view.getPlayer());
            assertEquals(Math.round(view.getWidth() * .75f), content.getLayoutParams().width);
            assertEquals(Math.round(view.getHeight() * .75f), content.getLayoutParams().height);
            assertArtworkPixel(.8f, .1f, true);
            assertArtworkPixel(.1f, .8f, true);
            assertArtworkPixel(.1f, .1f, false);
            overlays.setLinearAdActive(true);
            assertSame(original, content.getLayoutParams());
            assertArtworkPixel(.8f, .1f, false);
            overlays.setLinearAdActive(false);
            player.seekTo(9000);
        });
        await(() -> network.impressions.contains("/measure/s"));
        assertVisibleFrame("super");
        activity.onActivity(a -> {
            assertSame(original, content.getLayoutParams());
            assertArtworkPixel(.5f, .8f, true);
            assertArtworkPixel(.5f, .69f, false);
            assertArtworkPixel(.12f, .8f, false);
            assertArtworkPixel(.88f, .8f, false);
            assertArtworkPixel(.5f, .91f, false);
            player.seekTo(1000);
        });
        await(() -> content.getLayoutParams() != original);
        activity.onActivity(a -> {
            overlays.stop();
            assertSame(original, content.getLayoutParams());
            overlays.start();
        });
        await(() -> content.getLayoutParams() != original);
        activity.onActivity(a -> {
            overlays.close();
            assertSame(original, content.getLayoutParams());
            assertSame(player, view.getPlayer());
            assertTrue(player.getPlayWhenReady());
        });
        assertEquals(2, network.impressions.size());
    }

    @Test public void vodWithProgramDateTimeUsesTheMediaPlayhead() throws Exception {
        activity.onActivity(a -> {
            player.setMediaItem(MediaItem.fromUri(network.url("/vod.m3u8")));
            overlays = OverlayController.attach(view);
            player.prepare();
            player.play();
        });
        await(() -> network.impressions.contains("/measure/vod"));
        activity.onActivity(a -> assertFalse(player.isCurrentMediaItemLive()));
    }

    @Test public void oneViewCannotRegisterTwoMeasurementOwners() {
        activity.onActivity(a -> {
            overlays = OverlayController.attach(view);
            try {
                OverlayController duplicate = OverlayController.attach(view);
                duplicate.close();
                fail("Two controllers attached to the same video");
            } catch (IllegalStateException expected) {
                assertSame(player, view.getPlayer());
            }
            overlays.close();
            overlays = OverlayController.attach(view);
        });
    }

    @Test public void sidecarReceivesSessionAndActualPlayheadAndSuppliesTheOnlyCreative() throws Exception {
        activity.onActivity(a -> {
            overlays = OverlayController.attach(view, network.url("/session?keep=pilot&sid=old&time=0"), "tv-session");
            player.seekTo(1000);
            player.play();
        });
        await(() -> network.impressions.contains("/measure/sidecar"));
        HttpUrl request = network.sidecarRequests.get(0);
        assertEquals("pilot", request.queryParameter("keep"));
        assertEquals(java.util.Collections.singletonList("tv-session"), request.queryParameterValues("sid"));
        assertEquals(1, request.queryParameterValues("time").size());
        long position = Long.parseLong(request.queryParameter("time"));
        assertTrue(position >= 1795046401000L && position < 1795046418000L);
        assertEquals(java.util.Collections.singletonList("/assets/sidecar"), network.images);
        assertEquals(java.util.Collections.singletonList("/measure/sidecar"), network.impressions);
    }

    @Test public void sceneClipsTheLAndHandsOffTheSecondProduct() throws Exception {
        activity.onActivity(a -> {
            overlays = OverlayController.attachCommerce(view, network.url("/scene?scene=0"), "scene-session",
                    "es", "AR", true);
            overlays.setSceneSecondaryVideoEnabled(true);
            player.seekTo(1000);
            player.play();
        });
        await(() -> network.impressions.contains("/measure/scene") && network.images.contains("/assets/poster.png"));
        assertEquals(java.util.Collections.singletonList("1"), network.sidecarRequests.get(0).queryParameterValues("scene"));
        assertEquals("media-mask,media-crop,video", network.sidecarRequests.get(0).queryParameter("scene_features"));
        assertVisibleFrame("scene");
        activity.onActivity(a -> {
            assertSame(original, content.getLayoutParams());
            assertArtworkPixel(.1f, .1f, false);
            View first = view.findFocus();
            assertNotNull(first);
            assertEquals("Botines", first.getContentDescription());
            assertTrue(first.dispatchKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN,
                    android.view.KeyEvent.KEYCODE_DPAD_RIGHT)));
            View next = view.findFocus();
            assertNotNull(next);
            assertEquals("Gorra", next.getContentDescription());
            assertTrue(next.performClick());
            player.pause();
            clickButton("Roja");
            clickButton("Mostrar código QR");
        });
        await(() -> network.checkoutSelections.size() == 1 && network.impressions.contains("/measure/cap"));
        assertEquals(java.util.Collections.singletonList("/cap/cart"), network.checkoutDestinations);
        assertEquals(java.util.Collections.singletonList("{\"variantId\":\"green\"}"), network.checkoutSelections);
        activity.onActivity(a -> {
            assertTrue(overlays.closeCommercePanel());
            assertEquals("Gorra", view.findFocus().getContentDescription());
            overlays.setLinearAdActive(true);
            assertSame(original, content.getLayoutParams());
            java.util.ArrayList<View> targets = new java.util.ArrayList<>();
            view.findViewsWithText(targets, "Gorra", View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION);
            assertTrue(targets.isEmpty());
        });
        assertEquals(1, java.util.Collections.frequency(network.impressions, "/measure/scene"));
    }

    @Test public void sceneArtworkDecodesTheFirstGifFrame() throws Exception {
        String url = network.url("/animated.gif");
        OverlayNetwork loader = new OverlayNetwork();
        Bitmap artwork = loader.sceneImage(url);
        assertNotNull(artwork);
        assertEquals(Color.RED, artwork.getPixel(0, 0));
        artwork.recycle();

        String row = "[{\"id\":\"legacy\",\"format\":\"super\",\"start\":1,\"end\":2,\"imageUrl\":\"" + url + "\"}]";
        assertNull(loader.image(OverlayCue.fromSidecar(row).get(0)));
    }

    @Test public void commerceSelectsATvVariantAndShowsTheQrDuringPlayback() throws Exception {
        activity.onActivity(a -> {
            overlays = OverlayController.attachCommerce(view, network.url("/commerce"), "tv-session",
                    "es", "AR", true);
            player.seekTo(1000);
            player.play();
        });
        await(() -> network.impressions.contains("/measure/commerce"));
        HttpUrl request = network.sidecarRequests.get(0);
        assertEquals("1", request.queryParameter("commerce"));
        assertEquals("es", request.queryParameter("locale"));
        assertEquals("AR", request.queryParameter("country"));
        activity.onActivity(a -> {
            clickButton("Ver producto");
            clickButton("Talle 42");
            clickButton("Mostrar código QR");
        });
        await(() -> network.impressions.contains("/measure/product-view") && qrShown());
        assertEquals(java.util.Collections.singletonList("{\"variantId\":\"43\"}"), network.checkoutSelections);
        activity.onActivity(a -> {
            assertTrue(player.isPlaying());
            assertTrue(overlays.closeCommercePanel());
            assertFalse(qrShown());
            overlays.setLinearAdActive(true);
            assertTrue(buttons("Ver producto").isEmpty());
        });
        assertEquals(1, java.util.Collections.frequency(network.impressions, "/measure/commerce"));
    }

    private java.util.List<View> buttons(String title) {
        java.util.ArrayList<View> matched = new java.util.ArrayList<>();
        view.findViewsWithText(matched, title, View.FIND_VIEWS_WITH_TEXT);
        matched.removeIf(item -> !(item instanceof Button) || !item.isShown());
        return matched;
    }

    private void clickButton(String title) {
        java.util.List<View> matched = buttons(title);
        assertEquals(title, 1, matched.size());
        matched.get(0).performClick();
    }

    private boolean qrShown() {
        java.util.ArrayList<View> matched = new java.util.ArrayList<>();
        view.findViewsWithText(matched, "Escaneá el código con tu celular", View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION);
        return matched.stream().anyMatch(item -> item instanceof ImageView && item.isShown());
    }

    @Test public void missingProgramClockSkipsBothSchedulingAndMeasurement() throws Exception {
        activity.onActivity(a -> {
            player.setMediaItem(MediaItem.fromUri(network.url("/no-clock.m3u8")));
            overlays = OverlayController.attach(view, network.url("/session"), "tv-session");
            player.prepare();
            player.play();
        });
        await(() -> player.isPlaying());
        Thread.sleep(400);
        assertTrue(network.sidecarRequests.isEmpty());
        assertTrue(network.images.isEmpty());
        assertTrue(network.impressions.isEmpty());
    }

    @Test public void aModalWindowSuspendsGraphicsUntilTheVideoIsVisibleAgain() throws Exception {
        Dialog[] dialog = new Dialog[1];
        activity.onActivity(a -> {
            dialog[0] = new Dialog(a);
            dialog[0].setContentView(new View(a));
            dialog[0].show();
        });
        await(() -> !view.hasWindowFocus());
        activity.onActivity(a -> {
            overlays = OverlayController.attach(view);
            player.seekTo(1000);
            player.play();
        });
        await(() -> player.isPlaying());
        assertFalse(network.requestStarted.await(450, TimeUnit.MILLISECONDS));
        activity.onActivity(a -> dialog[0].dismiss());
        await(() -> network.impressions.contains("/measure/l"));
    }

    @Test public void failedImageDecodeLeavesTheVideoAndImpressionsAlone() throws Exception {
        network.invalidImage = true;
        activity.onActivity(a -> {
            overlays = OverlayController.attach(view);
            player.seekTo(1000);
            player.play();
        });
        assertTrue(network.responseSent.await(8, TimeUnit.SECONDS));
        Thread.sleep(400);
        assertTrue(network.impressions.isEmpty());
        activity.onActivity(a -> assertSame(original, content.getLayoutParams()));
    }

    @Test public void expiredOrClosedImageLoadCannotChangeTheLayoutOrSendAnImpression() throws Exception {
        network.hold = true;
        activity.onActivity(a -> {
            overlays = OverlayController.attach(view);
            player.seekTo(1000);
            player.play();
        });
        assertTrue(network.requestStarted.await(8, TimeUnit.SECONDS));
        activity.onActivity(a -> {
            player.seekTo(7000);
            overlays.close();
            assertSame(original, content.getLayoutParams());
        });
        network.releaseImage.countDown();
        assertTrue(network.responseSent.await(4, TimeUnit.SECONDS));
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        assertTrue(network.impressions.isEmpty());
        activity.onActivity(a -> assertSame(original, content.getLayoutParams()));
    }

    // Captures the actual Android view tree. The green SurfaceView is composited separately.
    private void assertArtworkPixel(float x, float y, boolean red) {
        Bitmap frame = Bitmap.createBitmap(view.getWidth(), view.getHeight(), Bitmap.Config.ARGB_8888);
        view.draw(new Canvas(frame));
        int pixel = frame.getPixel((int) (x * frame.getWidth()), (int) (y * frame.getHeight()));
        frame.recycle();
        assertEquals("art at " + x + ", " + y, red,
                Color.red(pixel) > 240 && Color.green(pixel) < 15 && Color.blue(pixel) < 15);
    }

    private void assertVisibleFrame(String format) throws Exception {
        int[] origin = new int[2];
        int[] size = new int[2];
        activity.onActivity(a -> {
            view.getLocationOnScreen(origin);
            size[0] = view.getWidth();
            size[1] = view.getHeight();
        });
        // SurfaceFlinger can still be presenting the preceding frame when the HTTPS receipt arrives.
        long deadline = SystemClock.elapsedRealtime() + 2500;
        do {
            Bitmap screenshot = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
            assertNotNull(screenshot);
            Bitmap frame = Bitmap.createBitmap(screenshot, origin[0], origin[1], size[0], size[1]);
            int video = frame.getPixel(size[0] / 4, size[1] / 4);
            int art = frame.getPixel(size[0] / 2, size[1] * 4 / 5);
            int right = frame.getPixel(size[0] * 7 / 8, size[1] / 4);
            boolean visible = Color.green(video) > 75 && Color.red(video) < 35 && Color.blue(video) < 35;
            if ("scene".equals(format)) {
                int corner = frame.getPixel(size[0] * 77 / 100, size[1] / 100);
                visible = visible && right == Color.MAGENTA && corner == 0xff103050;
            } else {
                boolean correctFormat = "l".equals(format)
                        ? Color.red(right) > 240 && Color.green(right) < 15
                        : Color.green(right) > 75 && Color.red(right) < 35;
                visible = visible && Color.red(art) > 240 && Color.green(art) < 15 && correctFormat;
            }
            if (visible) {
                try (OutputStream out = PlatformTestStorageRegistry.getInstance().openOutputFile(format + ".png")) {
                    assertTrue(frame.compress(Bitmap.CompressFormat.PNG, 100, out));
                }
            }
            frame.recycle();
            screenshot.recycle();
            if (visible) return;
            Thread.sleep(35);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("Expected the video and " + format + " in the same composited frame");
    }

    private interface Condition { boolean fulfilled(); }

    private void await(Condition condition) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        AtomicBoolean ready = new AtomicBoolean();
        while (!ready.get() && SystemClock.elapsedRealtime() < deadline) {
            activity.onActivity(a -> ready.set(condition.fulfilled()));
            if (!ready.get()) Thread.sleep(25);
        }
        assertTrue("Expected playback condition before timeout", ready.get());
    }

}

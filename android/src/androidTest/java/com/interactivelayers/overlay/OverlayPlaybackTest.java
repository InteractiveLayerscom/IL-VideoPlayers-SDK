package com.interactivelayers.overlay;

import static org.junit.Assert.*;

import android.app.Dialog;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Rect;
import android.net.Uri;
import android.os.PatternMatcher;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.KeyEvent;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
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
            clickButton("Elegir opciones");
            opener("Ver fotos").performClick();
            clickButton("›");
            assertTrue(overlays.closeCommercePanel());
            assertTrue(buttons("Roja").get(0).isSelected());
            clickButton("Verde");
            assertTrue(buttons("Verde").get(0).isSelected());
            assertFalse(buttons("Roja").get(0).isSelected());
            assertTrue(buttons("M").get(0).isSelected());
            assertTrue(buttons("S").isEmpty());
            clickButton("Agregar al carrito");
            assertTrue(network.checkoutSelections.isEmpty());
            clickButton("Continuar con el QR");
        });
        await(() -> network.checkoutSelections.size() == 1 && network.impressions.contains("/measure/cap"));
        assertEquals(java.util.Collections.singletonList("/cap/cart"), network.checkoutDestinations);
        assertEquals(java.util.Collections.singletonList("{\"variantId\":\"green\"}"), network.checkoutSelections);
        activity.onActivity(a -> {
            for (int stage = 0; stage < 4; stage++) assertTrue(overlays.closeCommercePanel());
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
            assertEquals(buttons("Elegir opciones").get(0), view.findFocus());
        });
        assertCommerceFrame();
        Instrumentation remote = InstrumentationRegistry.getInstrumentation();
        remote.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_CENTER);
        activity.onActivity(a -> assertEquals(buttons("Talle 42").get(0), view.findFocus()));
        remote.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_RIGHT);
        activity.onActivity(a -> assertEquals(buttons("Talle 43").get(0), view.findFocus()));
        remote.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_CENTER);
        activity.onActivity(a -> {
            assertTrue(buttons("Talle 43").get(0).isSelected());
            clickButton("Agregar al carrito");
            assertTrue(network.checkoutSelections.isEmpty());
        });
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        activity.onActivity(a -> assertEquals(buttons("Continuar con el QR").get(0), view.findFocus()));
        remote.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_CENTER);
        await(() -> !network.checkoutSelections.isEmpty());
        await(() -> qrShown());
        assertTrue(network.impressions.contains("/measure/product-view"));
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

    @Test public void galleryBrowsingDoesNotReplaceTheSelectedSkuPhoto() throws Exception {
        String skuPhoto = network.url("/assets/poster.png");
        String cover = network.url("/assets/cover.png");
        JSONArray variants = new JSONArray();
        for (String id : new String[]{"Small", "Large", "No photo"}) {
            JSONObject variant = new JSONObject().put("id", id).put("label", id);
            if (!id.equals("No photo")) variant.put("imageUrl", skuPhoto);
            variants.put(variant);
        }
        OverlayCommerce offer = OverlayCommerce.parse(new JSONObject().put("title", "Bag").put("currency", "USD")
                .put("price", "2").put("imageUrl", cover).put("variants", variants).put("handoffUrl", network.url("/cart")));
        ExecutorService worker = Executors.newSingleThreadExecutor();
        CommercePanel[] panel = new CommercePanel[1];
        try {
            activity.onActivity(a -> panel[0] = new CommercePanel(view, offer, null, null, null, new OverlayNetwork(), worker,
                    true, () -> {}, () -> {}));
            await(() -> shopImageHasColor(panel[0], Color.MAGENTA));
            activity.onActivity(a -> {
                clickButton("Choose options");
                clickButton("Large");
                opener("View photos").performClick();
            });
            await(() -> panel[0].getWidth() == view.getWidth() && shopImageHasColor(panel[0], Color.MAGENTA));
            Instrumentation remote = InstrumentationRegistry.getInstrumentation();
            remote.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_RIGHT);
            await(() -> shopImageHasColor(panel[0], Color.RED));
            remote.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_LEFT);
            await(() -> shopImageHasColor(panel[0], Color.MAGENTA));
            remote.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            await(() -> panel[0].getWidth() == Math.round(view.getWidth() * .42f));
            activity.onActivity(a -> {
                assertEquals(opener("View photos"), view.findFocus());
                assertTrue(buttons("Large").get(0).isSelected());
            });
            await(() -> shopImageHasColor(panel[0], Color.MAGENTA));
            activity.onActivity(a -> clickButton("Large"));
            await(() -> shopImageHasColor(panel[0], Color.MAGENTA));
            activity.onActivity(a -> clickButton("No photo"));
            await(() -> shopImageHasColor(panel[0], Color.RED));
            activity.onActivity(a -> { clickButton("Small"); clickButton("Add to cart"); });
            await(() -> shopImageHasColor(panel[0], Color.MAGENTA));
            activity.onActivity(a -> clickButton("Continue to QR"));
            await(() -> qrVisible("Scan to pay on Shopify") && shopImageHasColor(panel[0], Color.MAGENTA));
        } finally {
            activity.onActivity(a -> panel[0].dispose());
            worker.shutdownNow();
        }
    }

    @Test public void singlePhotoOpensFromCoverAndDetailsAndReturnsFocusToItsLink() throws Exception {
        String title = "Backpack";
        OverlayCommerce offer = OverlayCommerce.parse(new JSONObject().put("title", title).put("currency", "USD")
                .put("price", 10).put("imageUrl", network.url("/assets/poster.png")).put("handoffUrl", network.url("/cart"))
                .put("variants", new JSONArray().put(new JSONObject().put("id", "one").put("label", "One"))));
        ExecutorService worker = Executors.newSingleThreadExecutor();
        CommercePanel[] panel = new CommercePanel[1];
        try {
            activity.onActivity(a -> panel[0] = new CommercePanel(view, offer, null, null, null, new OverlayNetwork(), worker,
                    true, () -> {}, () -> {}));
            Instrumentation remote = InstrumentationRegistry.getInstrumentation();
            for (String stageAction : new String[]{"View details", "Add to cart"}) {
                activity.onActivity(a -> {
                    // The cover opens the viewer from its secondary action, the details step from the photo box.
                    if (stageAction.equals("Add to cart")) { clickButton("View details"); opener("Enlarge photo").performClick(); }
                    else clickButton("Enlarge photo");
                });
                await(() -> panel[0].getWidth() == view.getWidth() && shopImageHasColor(panel[0], Color.MAGENTA));
                activity.onActivity(a -> {
                    assertEquals(view.getHeight(), panel[0].getHeight());
                    java.util.ArrayList<View> photos = new java.util.ArrayList<>();
                    view.findViewsWithText(photos, title, View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION);
                    ImageView photo = (ImageView) photos.get(0);
                    assertEquals(ImageView.ScaleType.FIT_CENTER, photo.getScaleType());
                    assertTrue(photo.getWidth() >= view.getWidth() * .90f && photo.getHeight() >= view.getHeight() * .80f);
                    // No arrows for one photo (Back is also a "‹", as on web, so the arrows are found by name).
                    java.util.ArrayList<View> arrows = new java.util.ArrayList<>();
                    view.findViewsWithText(arrows, "Previous photo", View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION);
                    view.findViewsWithText(arrows, "Next photo", View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION);
                    assertTrue(arrows.isEmpty() && buttons("›").isEmpty());
                });
                remote.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_RIGHT);
                remote.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
                await(() -> panel[0].getWidth() == Math.round(view.getWidth() * .42f));
                activity.onActivity(a -> {
                    assertEquals(stageAction.equals("Add to cart") ? opener("Enlarge photo") : buttons("Enlarge photo").get(0),
                            view.findFocus());
                    assertEquals(1, buttons(stageAction).size());
                });
            }
        } finally {
            activity.onActivity(a -> panel[0].dispose());
            worker.shutdownNow();
        }
    }

    private boolean shopImageHasColor(View root, int color) {
        if (root instanceof ImageView) {
            android.graphics.drawable.Drawable image = ((ImageView) root).getDrawable();
            if (image instanceof android.graphics.drawable.BitmapDrawable) {
                Bitmap bitmap = ((android.graphics.drawable.BitmapDrawable) image).getBitmap();
                return bitmap != null && bitmap.getPixel(0, 0) == color;
            }
        }
        if (root instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) root;
            for (int i = 0; i < group.getChildCount(); i++)
                if (shopImageHasColor(group.getChildAt(i), color)) return true;
        }
        return false;
    }

    @Test public void shortPlayerReachesTheHundredthVariantByRemoteAndClearsItsQrOnChange() throws Exception {
        JSONArray variants = new JSONArray();
        for (int i = 1; i <= 100; i++) {
            variants.put(new JSONObject().put("id", "sku-" + i).put("label", "Size " + i).put("price", i));
        }
        OverlayCommerce offer = OverlayCommerce.parse(new JSONObject().put("title", "Boots").put("currency", "USD")
                .put("price", "1").put("variants", variants).put("handoffUrl", network.url("/cart")));
        OverlayScene.Brand brand = new OverlayScene.Brand(new JSONObject()
                .put("accent", "#ff0000").put("background", "#202020").put("foreground", "#ffffff"));
        ExecutorService worker = Executors.newSingleThreadExecutor();
        CommercePanel[] panel = new CommercePanel[1];
        try {
            activity.onActivity(a -> {
                FrameLayout stage = new FrameLayout(a);
                int height = Math.round(180 * a.getResources().getDisplayMetrics().density);
                view.addView(stage, new FrameLayout.LayoutParams(-1, height));
                panel[0] = new CommercePanel(stage, offer, null, null, brand, new OverlayNetwork(), worker,
                        true, () -> {}, () -> {});
            });
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            activity.onActivity(a -> {
                assertTrue(panel[0].getHeight() <= ((View) panel[0].getParent()).getHeight());
                clickButton("Choose options");
                View focus = buttons("Size 1").get(0);
                assertEquals(focus, view.findFocus());
                // web: the selected value is filled with the text colour and written in the panel's background.
                assertEquals(0xff202020, ((Button) focus).getCurrentTextColor());
                Button buy = (Button) buttons("Add to cart").get(0);
                assertWhiteTvAction(buy);
                buy.setPressed(true);
                assertWhiteTvAction(buy);
                buy.setPressed(false);
                for (int page = 0; page < 8; page++) clickButton("›");
                clickButton("Size 100");
                assertTrue(buttons("Size 100").get(0).isSelected());
                java.util.ArrayList<View> prices = new java.util.ArrayList<>();
                panel[0].findViewsWithText(prices, "$100.00", View.FIND_VIEWS_WITH_TEXT);
                assertEquals(1, prices.size());
            });
            await(() -> buttons("Add to cart").get(0).getGlobalVisibleRect(new Rect()));
            activity.onActivity(a -> { clickButton("Add to cart"); clickButton("Continue to QR"); });
            await(() -> !network.checkoutSelections.isEmpty() && qrVisible("Scan to pay on Shopify"));
            assertEquals(java.util.Collections.singletonList("{\"variantId\":\"sku-100\"}"), network.checkoutSelections);
            activity.onActivity(a -> {
                assertTrue(panel[0].closeDetails());
                assertTrue(panel[0].closeDetails());
                clickButton("Size 99");
                assertFalse(qrVisible("Scan to pay on Shopify"));
                clickButton("Add to cart");
                clickButton("Continue to QR");
                // Let the worker queue its completed reply, then change variant before the UI receives it.
                try { worker.submit(() -> {}).get(5, TimeUnit.SECONDS); }
                catch (Exception e) { throw new AssertionError(e); }
                assertTrue(panel[0].closeDetails());
                assertTrue(panel[0].closeDetails());
                clickButton("Size 98");
            });
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            activity.onActivity(a -> assertFalse(qrVisible("Scan to pay on Shopify")));
            assertEquals("{\"variantId\":\"sku-99\"}", network.checkoutSelections.get(1));
        } finally {
            activity.onActivity(a -> { if (panel[0] != null) panel[0].dispose(); });
            worker.shutdownNow();
        }
    }

    @Test public void onlyAnExplicitMatchedMidrollDeliveryCanOpenTheShop() throws Exception {
        activity.onActivity(a -> {
            overlays = OverlayController.attachCommerce(view, network.url("/midroll?shop_midroll=1&midroll_creative_id=bad&midroll_delivery_id=bad"),
                    "spot-session", "es", "AR", true);
            player.seekTo(1000);
            player.play();
        });
        await(() -> !network.sidecarRequests.isEmpty());
        assertNull(network.sidecarRequests.get(0).queryParameter("shop_midroll"));
        activity.onActivity(a -> {
            assertTrue(buttons("Comprar").isEmpty());
            overlays.setLinearAdActive(true, "creative-a", "delivery-a");
        });
        await(() -> !buttons("Comprar").isEmpty());
        HttpUrl bound = network.sidecarRequests.get(network.sidecarRequests.size() - 1);
        assertEquals("1", bound.queryParameter("shop_midroll"));
        assertEquals("creative-a", bound.queryParameter("midroll_creative_id"));
        assertEquals("delivery-a", bound.queryParameter("midroll_delivery_id"));
        activity.onActivity(a -> clickButton("Comprar"));
        await(() -> network.images.contains("/assets/boots.png") && network.impressions.contains("/measure/shop-view"));
        activity.onActivity(a -> overlays.setLinearAdActive(true, "creative-a", "delivery-b"));
        await(() -> "delivery-b".equals(network.sidecarRequests.get(network.sidecarRequests.size() - 1).queryParameter("midroll_delivery_id")));
        activity.onActivity(a -> {
            assertTrue(buttons("Comprar").isEmpty());
            assertTrue(buttons("Elegir opciones").isEmpty());
            overlays.setLinearAdActive(true);
            assertTrue(buttons("Comprar").isEmpty());
            overlays.setLinearAdActive(false);
        });
        assertFalse(network.images.contains("/assets/spot.mp4"));
        assertFalse(network.impressions.contains("/measure/vast"));
    }

    @Test public void handheldBuyLaunchesTheContinuationOfTheSelectedVariant() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        IntentFilter filter = new IntentFilter(Intent.ACTION_VIEW);
        Uri continuation = Uri.parse(network.url("/continue"));
        filter.addDataScheme("https");
        filter.addDataAuthority(continuation.getHost(), Integer.toString(continuation.getPort()));
        filter.addDataPath(continuation.getPath(), PatternMatcher.PATTERN_LITERAL);
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(filter, null, true);
        try {
            activity.onActivity(a -> {
                overlays = OverlayController.attachCommerce(view, network.url("/commerce"), "phone-session",
                        "es", "AR", false);
                player.seekTo(1000);
                player.play();
            });
            await(() -> !buttons("Ver producto").isEmpty());
            activity.onActivity(a -> {
                clickButton("Ver producto");
                clickButton("Talle 43");
                clickButton("Comprar");
            });
            await(() -> monitor.getHits() == 1);
            assertEquals(java.util.Collections.singletonList("{\"variantId\":\"43\"}"), network.checkoutSelections);
            activity.onActivity(a -> assertFalse(qrShown()));
        } finally {
            instrumentation.removeMonitor(monitor);
        }
    }

    private java.util.List<View> buttons(String title) {
        java.util.ArrayList<View> matched = new java.util.ArrayList<>();
        view.findViewsWithText(matched, title, View.FIND_VIEWS_WITH_TEXT);
        matched.removeIf(item -> !(item instanceof Button) || !((Button) item).getText().toString().equals(title) || !item.isShown());
        return matched;
    }

    /** The photo box that opens the viewer (web .il-tv-gallery-open), named by its caption. */
    private View opener(String caption) {
        java.util.ArrayList<View> matched = new java.util.ArrayList<>();
        view.findViewsWithText(matched, caption, View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION);
        matched.removeIf(item -> !(item instanceof FrameLayout) || !item.isShown() || !item.isFocusable());
        assertEquals(caption, 1, matched.size());
        return matched.get(0);
    }

    private void clickButton(String title) {
        java.util.List<View> matched = buttons(title);
        assertEquals(title, 1, matched.size());
        matched.get(0).performClick();
    }

    private boolean qrShown() {
        return qrVisible("Escaneá para pagar en Shopify");
    }

    private boolean qrVisible(String description) {
        java.util.ArrayList<View> matched = new java.util.ArrayList<>();
        view.findViewsWithText(matched, description, View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION);
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

    private void assertWhiteTvAction(Button button) {
        android.graphics.drawable.Drawable background = button.getBackground();
        Rect originalBounds = background.copyBounds();
        Bitmap sample = Bitmap.createBitmap(100, 48, Bitmap.Config.ARGB_8888);
        try {
            background.setBounds(0, 0, 100, 48);
            background.draw(new Canvas(sample));
            assertEquals(Color.WHITE, sample.getPixel(50, 24));
            assertEquals(0xff171717, button.getCurrentTextColor());
        } finally {
            background.setBounds(originalBounds);
            sample.recycle();
        }
    }

    private void assertCommerceFrame() throws Exception {
        Rect stage = new Rect(), action = new Rect();
        await(() -> view.getGlobalVisibleRect(stage) && buttons("Elegir opciones").get(0).getGlobalVisibleRect(action));
        long deadline = SystemClock.elapsedRealtime() + 2500;
        do {
            Bitmap screenshot = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
            int fill = screenshot.getPixel(action.left + action.width() / 5, action.centerY());
            if (fill == Color.WHITE) {
                Bitmap card = Bitmap.createBitmap(screenshot, stage.left, stage.top, stage.width(), stage.height());
                try (OutputStream out = PlatformTestStorageRegistry.getInstance().openOutputFile("commerce.png")) {
                    assertTrue(card.compress(Bitmap.CompressFormat.PNG, 100, out));
                } finally {
                    card.recycle();
                    screenshot.recycle();
                }
                return;
            }
            screenshot.recycle();
            Thread.sleep(35);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("Expected the purchase action in the composited player frame");
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

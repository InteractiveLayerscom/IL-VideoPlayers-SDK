package com.interactivelayers.example;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;
import com.interactivelayers.overlay.AdPlanPlayer;
import com.interactivelayers.overlay.OverlayController;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The smallest app that shows both ways to run IL's ad plan on Android. Every address comes from the launch intent:
 * nothing here names a host, and no API key ever reaches the app (it lives in the relay's environment).
 *
 * <ul>
 *   <li>{@code mode=load}: the SDK requests the plan from the console ({@code origin}) for {@code project} and {@code asset}.</li>
 *   <li>{@code mode=host}: the app plays its own breaks. A relay (examples/api-relay.mjs) plays the customer's backend:
 *       {@code POST /playback} gives the plan, {@code POST /break} the ad tag of each break. The ad itself is simulated
 *       here (the content pauses for {@code adSeconds}); a real app plays it with its own ad SDK and reports the same calls.</li>
 * </ul>
 */
@OptIn(markerClass = UnstableApi.class)
public final class MainActivity extends Activity {
    private static final String TAG = "ILExample";
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private PlayerView view;
    private ExoPlayer player;
    private OverlayController overlays;
    private AdPlanPlayer plan;
    private TextView label;
    // Host mode: the break positions this app will play, the next one due, and the playback the relay created.
    private final List<Long> breaks = new ArrayList<>();
    private int nextBreak;
    private boolean inBreak;
    private String playbackId;
    private final Runnable watch = this::watchBreaks;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        view = new PlayerView(this);
        view.setUseController(false);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));
        label = new TextView(this);
        label.setTextColor(Color.WHITE);
        label.setBackgroundColor(0xAA000000);
        label.setPadding(24, 12, 24, 12);
        label.setVisibility(View.GONE);
        root.addView(label, new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START));
        setContentView(root);

        Intent intent = getIntent();
        String mode = extra(intent, "mode", "load");
        String video = intent.getStringExtra("video");
        if (video == null) {
            say("Falta el extra «video» (URL HTTPS del contenido)");
            return;
        }
        player = new ExoPlayer.Builder(this).build();
        view.setPlayer(player);
        player.setMediaItem(MediaItem.fromUri(video), (long) (Double.parseDouble(extra(intent, "start", "0")) * 1000));
        player.prepare();
        overlays = OverlayController.attach(view);
        if ("host".equals(mode)) startHostDriven(intent);
        else startLoad(intent);
    }

    private static String extra(Intent intent, String key, String fallback) {
        String value = intent.getStringExtra(key);
        return value == null || value.isEmpty() ? fallback : value;
    }

    private void event(String type, String format, String id) {
        Log.i(TAG, "event " + type + " format=" + format + " id=" + id);
    }

    // (1) The SDK requests the plan: GET <origin>/il-player/app-plan?project&asset&app=android:<package>.
    private void startLoad(Intent intent) {
        String origin = intent.getStringExtra("origin");
        if (origin == null) {
            say("Falta el extra «origin» (origen HTTPS de la consola)");
            return;
        }
        plan = AdPlanPlayer.load(overlays, player, origin, intent.getStringExtra("project"), intent.getStringExtra("asset"),
                null, "es", this::event);
        Log.i(TAG, "load requested for app=android:" + getPackageName());
        plan.start(() -> {
            Log.i(TAG, "content may play");
            player.play();
        });
    }

    // (2) The app plays its own breaks and tells the SDK what is on screen.
    private void startHostDriven(Intent intent) {
        String relay = intent.getStringExtra("relay");
        String origin = intent.getStringExtra("origin");
        if (relay == null || origin == null) {
            say("Faltan los extras «relay» y «origin»");
            return;
        }
        for (String part : extra(intent, "breaks", "").split(",")) {
            if (!part.trim().isEmpty()) breaks.add(Math.round(Double.parseDouble(part.trim()) * 1000));
        }
        String asset = intent.getStringExtra("asset");
        adMs = Math.round(Double.parseDouble(extra(intent, "adSeconds", "10")) * 1000);
        network.execute(() -> {
            try {
                JSONObject created = post(relay + "/playback", new JSONObject().put("asset", asset));
                String planJson = created.getJSONObject("plan").toString();
                String id = created.getString("playback_id");
                main.post(() -> {
                    playbackId = id;
                    // planOrigin is the console that issued the plan's commerce URLs.
                    plan = AdPlanPlayer.attach(overlays, player, planJson, origin, null, "es", this::event);
                    if (plan == null) Log.w(TAG, "the plan is unusable: content without IL");
                    long[] at = new long[breaks.size()];
                    for (int i = 0; i < at.length; i++) at[i] = breaks.get(i);
                    if (plan != null) plan.setBreaks(at);
                    Runnable play = () -> {
                        player.play();
                        main.post(watch);
                    };
                    if (plan != null) plan.start(play);
                    else play.run();
                });
            } catch (IOException | JSONException e) {
                Log.w(TAG, "relay /playback failed: " + e);
                main.post(() -> player.play());
            }
        });
    }

    private long adMs = 10000;

    private void watchBreaks() {
        if (player == null || isFinishing()) return;
        if (!inBreak && nextBreak < breaks.size() && player.getContentPosition() >= breaks.get(nextBreak)) playBreak(breaks.get(nextBreak++));
        main.postDelayed(watch, 250);
    }

    private void playBreak(long atMs) {
        inBreak = true;
        player.pause();
        if (plan != null) plan.breakStarted(atMs);
        Log.i(TAG, "break started at " + atMs);
        say("Corte de la app (anuncio simulado)");
        String relay = getIntent().getStringExtra("relay");
        network.execute(() -> {
            String tag = null;
            try {
                JSONObject answer = post(relay + "/break", new JSONObject().put("playback_id", playbackId).put("cue_seconds", atMs / 1000.0));
                tag = answer.optString("ad_tag_url", null);
                if (tag == null && answer.has("step")) {
                    answer = post(relay + "/break/next", new JSONObject().put("playback_id", playbackId)
                            .put("cue_seconds", atMs / 1000.0).put("after_step", answer.getInt("step")));
                    tag = answer.optString("ad_tag_url", null);
                }
            } catch (IOException | JSONException e) {
                Log.w(TAG, "relay /break failed: " + e);
            }
            String adTag = tag;
            main.post(() -> {
                if (plan != null && adTag != null) {
                    // A real app reports what its ad SDK says is playing (IMA: Ad.getAdId(), Ad.getCreativeId()).
                    plan.adStarted(adTag, extra(getIntent(), "adId", ""), extra(getIntent(), "creative", ""));
                    Log.i(TAG, "ad started tag=" + adTag);
                }
                main.postDelayed(() -> endBreak(atMs), adMs);
            });
        });
    }

    private void endBreak(long atMs) {
        if (plan != null) {
            plan.adEnded();
            plan.breakEnded();
        }
        Log.i(TAG, "break ended at " + atMs);
        label.setVisibility(View.GONE);
        inBreak = false;
        player.play();
    }

    private void say(String text) {
        Log.i(TAG, text);
        label.setText(text);
        label.setVisibility(View.VISIBLE);
    }

    private static JSONObject post(String address, JSONObject body) throws IOException, JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        try {
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(10000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (connection.getResponseCode() / 100 != 2) throw new IOException("HTTP " + connection.getResponseCode());
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream data = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int n;
                while ((n = in.read(buffer)) != -1) data.write(buffer, 0, n);
                return new JSONObject(new String(data.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally {
            connection.disconnect();
        }
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        // Back closes the product panel step by step before it leaves the app.
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP
                && overlays != null && overlays.closeCommercePanel()) return true;
        return super.dispatchKeyEvent(event);
    }

    @Override protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (plan != null) plan.close();
        if (overlays != null) overlays.close();
        if (player != null) player.release();
        network.shutdownNow();
        super.onDestroy();
    }
}

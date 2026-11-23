package com.interactivelayers.overlay;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import androidx.media3.common.AdViewProvider;
import androidx.media3.common.MediaItem;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.ima.ImaAdsLoader;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import com.google.ads.interactivemedia.v3.api.AdError;
import com.google.ads.interactivemedia.v3.api.AdEvent;

/**
 * Google IMA engine of {@link AdPlanPlayer}, used by default on an ExoPlayer. An app whose content needs
 * its own headers or DRM passes the {@link DefaultMediaSourceFactory} it plays that content with.
 */
public final class AdPlanIma implements AutoCloseable {
    static final int VAST_LOAD_TIMEOUT_MS = 4000;
    private final DefaultMediaSourceFactory sources;
    private final AdViewProvider adViews;
    private final ImaAdsLoader loader;
    private AdPlanDriver.ImaCallback attempt;
    private ExoPlayer bound;

    public AdPlanIma(Context context, AdViewProvider adViews) {
        this(context, adViews, new DefaultMediaSourceFactory(context.getApplicationContext()));
    }

    public AdPlanIma(Context context, AdViewProvider adViews, DefaultMediaSourceFactory sources) {
        this.adViews = adViews;
        this.sources = sources;
        loader = new ImaAdsLoader.Builder(context.getApplicationContext())
                // Shorter than IMA's default, so an ad server that stalls leaves time for the next request in the break.
                .setVastLoadTimeoutMs(VAST_LOAD_TIMEOUT_MS)
                .setAdEventListener(this::onAdEvent)
                .setAdErrorListener(event -> {
                    AdPlanDriver.ImaCallback current = attempt;
                    if (current == null) return;
                    if (event.getError().getErrorCode() == AdError.AdErrorCode.VAST_EMPTY_RESPONSE) current.empty();
                    else current.failed();
                })
                .build();
    }

    private void onAdEvent(AdEvent event) {
        AdPlanDriver.ImaCallback current = attempt;
        if (current == null) return;
        switch (event.getType()) {
            case LOADED: current.loaded(); break;
            case STARTED:
                current.started(event.getAd() == null ? 0 : Math.round(event.getAd().getDuration() * 1000));
                break;
            case ALL_ADS_COMPLETED: current.completed(); break;
            default: break;
        }
    }

    /** A tag without ad rules is a pre-roll of the item, which IMA plays before the start position. */
    void play(ExoPlayer player, MediaItem content, String tag, String adsResponse, long positionMs, AdPlanDriver.ImaCallback next) {
        if (bound != player) {
            loader.setPlayer(player);
            bound = player;
        }
        attempt = next;
        MediaItem item = content.buildUpon().setAdsConfiguration(
                new MediaItem.AdsConfiguration.Builder(adTag(tag, adsResponse)).setAdsId(tag).build()).build();
        sources.setLocalAdInsertionComponents(configuration -> loader, adViews);
        player.setPlayWhenReady(false);
        player.setMediaSource(sources.createMediaSource(item), positionMs);
        player.prepare();
    }

    /** Media3 hands a {@code data:} ad tag to IMA as the ads response, so a VAST already fetched is not asked for again. */
    static Uri adTag(String tag, String adsResponse) {
        if (adsResponse == null) return Uri.parse(tag);
        return Uri.parse("data:text/xml;base64," + Base64.encodeToString(adsResponse.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
    }

    void cancel() { attempt = null; }

    @Override public void close() {
        attempt = null;
        loader.setPlayer(null);
        bound = null;
        loader.release();
    }
}

package com.interactivelayers.overlay;

import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import androidx.media3.ui.PlayerView;
import com.google.android.gms.ads.AdListener;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.admanager.AdManagerAdRequest;
import com.google.android.gms.ads.admanager.AdManagerAdView;
import java.util.Map;

/**
 * The plan's Overlay through Google Mobile Ads. The app adds {@code play-services-ads:23.6.0} and its
 * {@code APPLICATION_ID} manifest entry. Google does not support this SDK on Android TV, so it stays off on TVs.
 */
public final class AdPlanGma implements AdPlanDisplay {
    private final PlayerView view;
    private AdManagerAdView banner;

    public AdPlanGma(PlayerView view) { this.view = view; }

    @Override public boolean supported() {
        return (view.getResources().getConfiguration().uiMode & Configuration.UI_MODE_TYPE_MASK) != Configuration.UI_MODE_TYPE_TELEVISION
                && !view.getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                && !view.getContext().getPackageManager().hasSystemFeature("android.hardware.type.television");
    }

    @Override public void request(String adUnit, Map<String, String> targeting, Callback callback) {
        clear();
        FrameLayout frame = view.getOverlayFrameLayout();
        if (frame == null) {
            callback.empty();
            return;
        }
        AdManagerAdView next = new AdManagerAdView(view.getContext());
        banner = next;
        next.setAdSize(AdSize.MEDIUM_RECTANGLE);
        next.setAdUnitId(adUnit);
        next.setVisibility(View.GONE);
        next.setAdListener(new AdListener() {
            @Override public void onAdLoaded() {
                if (banner == next) callback.filled();
            }
            @Override public void onAdFailedToLoad(LoadAdError error) {
                if (banner == next) callback.empty();
            }
            @Override public void onAdImpression() {
                if (banner == next) callback.impression();
            }
        });
        float density = view.getResources().getDisplayMetrics().density;
        FrameLayout.LayoutParams place = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        place.setMargins(0, 0, Math.round(12 * density), Math.round(58 * density));
        frame.addView(next, place);
        AdManagerAdRequest.Builder request = new AdManagerAdRequest.Builder();
        for (Map.Entry<String, String> entry : targeting.entrySet()) request.addCustomTargeting(entry.getKey(), entry.getValue());
        next.loadAd(request.build());
    }

    @Override public void setVisible(boolean visible) {
        if (banner != null) banner.setVisibility(visible ? View.VISIBLE : View.GONE);
    }

    @Override public void clear() {
        if (banner == null) return;
        AdManagerAdView old = banner;
        banner = null;
        if (old.getParent() instanceof FrameLayout) ((FrameLayout) old.getParent()).removeView(old);
        old.destroy();
    }
}

package com.interactivelayers.overlay;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.FrameLayout;
import androidx.media3.ui.PlayerView;

@SuppressLint("ViewConstructor") // Only created programmatically for a bound PlayerView.
final class OverlayLayer extends View {
    private final View content;
    private final FrameLayout container;
    private final Runnable afterDraw;
    private final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG);
    private final RectF destination = new RectF();
    private final Rect visibleArea = new Rect();
    private ViewGroup.LayoutParams originalParams;
    private Bitmap image;
    private boolean corner;
    private boolean floating;
    private boolean drawn;

    OverlayLayer(PlayerView playerView, Runnable afterDraw) {
        super(playerView.getContext());
        content = playerView.findViewById(androidx.media3.ui.R.id.exo_content_frame);
        if (content == null || !(content.getParent() instanceof FrameLayout)) {
            throw new IllegalArgumentException("PlayerView requires exo_content_frame inside a FrameLayout");
        }
        container = (FrameLayout) content.getParent();
        this.afterDraw = afterDraw;
        setFocusable(false);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        setVisibility(INVISIBLE);
        // Insert beside the video. Host controls, subtitles inside the video, and focus retain their owners.
        container.addView(this, container.indexOfChild(content) + 1,
                new FrameLayout.LayoutParams(-1, -1));
    }

    void show(OverlayCue cue, Bitmap bitmap) {
        image = bitmap;
        corner = "l".equals(cue.format);
        floating = "overlay".equals(cue.format);
        drawn = false;
        if (corner && originalParams == null) originalParams = content.getLayoutParams();
        updateBounds();
        setVisibility(VISIBLE);
        invalidate();
    }

    void clear() {
        if (originalParams != null) {
            content.setLayoutParams(originalParams);
            originalParams = null;
        }
        image = null;
        drawn = false;
        corner = false;
        floating = false;
        setVisibility(INVISIBLE);
    }

    FrameLayout container() { return container; }

    void remove() {
        clear();
        removeCallbacks(afterDraw);
        container.removeView(this);
    }

    @Override protected void onSizeChanged(int w, int h, int oldW, int oldH) {
        super.onSizeChanged(w, h, oldW, oldH);
        updateBounds();
    }

    private void updateBounds() {
        int w = getWidth(), h = getHeight();
        if (corner && w > 0 && h > 0) {
            content.setLayoutParams(new FrameLayout.LayoutParams(Math.round(.75f * w),
                    Math.round(.75f * h), Gravity.TOP | Gravity.LEFT));
            destination.set(0, 0, w, h);
        } else if (floating) {
            destination.set(.64f * w, .10f * h, .94f * w, .42f * h);
        } else {
            destination.set(.125f * w, .70f * h, .875f * w, .90f * h);
        }
    }

    @Override protected void onDraw(Canvas canvas) {
        if (image == null || destination.isEmpty()) return;
        if (corner) {
            // Even an opaque JPEG L cannot cover the upper-left video.
            float right = Math.round(getWidth() * .75f);
            float bottom = Math.round(getHeight() * .75f);
            canvas.save();
            canvas.clipRect(right, 0, getWidth(), getHeight());
            canvas.drawBitmap(image, null, destination, paint);
            canvas.restore();
            canvas.save();
            canvas.clipRect(0, bottom, right, getHeight());
            canvas.drawBitmap(image, null, destination, paint);
            canvas.restore();
        } else {
            canvas.drawBitmap(image, null, destination, paint);
        }
        if (!drawn && artworkVisible()) {
            drawn = true;
            post(afterDraw);
        }
    }

    boolean isDrawnAndVisible() { return drawn && artworkVisible(); }

    private boolean artworkVisible() {
        if (!isAttachedToWindow() || !hasWindowFocus() || !isShown() || getWindowVisibility() != VISIBLE
                || !getLocalVisibleRect(visibleArea)) return false;
        for (ViewParent p = getParent(); p instanceof View; p = p.getParent()) {
            if (((View) p).getAlpha() <= 0f) return false;
        }
        if (corner) return visibleArea.right > Math.round(.75f * getWidth())
                || visibleArea.bottom > Math.round(.75f * getHeight());
        return destination.intersects(visibleArea.left, visibleArea.top, visibleArea.right, visibleArea.bottom);
    }
}

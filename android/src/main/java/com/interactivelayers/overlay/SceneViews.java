package com.interactivelayers.overlay;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Path;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.KeyEvent;
import android.text.TextUtils;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;

final class SceneViews extends FrameLayout {
    interface OpenOffer { void open(OverlayScene.Offer offer, View focus); }

    private final OverlayCue cue;
    private final List<Entry> entries = new ArrayList<>();
    private final List<Future<?>> jobs = new ArrayList<>();
    private final Path clip = new Path();
    private final Rect visibleArea = new Rect();
    private final Runnable afterDraw;
    private final View previousFocus;
    private final boolean television;
    private long elapsed;
    private boolean moving;
    private boolean ready, drawn, disposed, focused;

    SceneViews(FrameLayout parent, OverlayCue cue, OverlayNetwork network, ExecutorService workers,
               boolean television, boolean secondaryVideo, boolean secondaryVideoAudio, Runnable afterDraw, OpenOffer open) {
        super(parent.getContext());
        this.cue = cue;
        this.afterDraw = afterDraw;
        this.television = television;
        previousFocus = parent.getRootView().findFocus();
        setVisibility(INVISIBLE);
        setClipChildren(true);
        for (OverlayScene.Layer layer : cue.scene.layers) {
            OverlayScene.Offer offer = cue.scene.offerAt(layer.productIndex);
            FrameLayout wrapper = new FrameLayout(getContext());
            Entry entry = new Entry(wrapper, layer);
            addView(wrapper, new LayoutParams(1, 1));
            entries.add(entry);

            if ("image".equals(layer.type) || "video".equals(layer.type) || "image".equals(layer.binding)) {
                String url = "image".equals(layer.binding) && offer != null ? offer.imageUrl : layer.imageUrl;
                if (url != null || secondaryVideo && layer.videoUrl != null) {
                    entry.media = new MediaViewport(getContext(), layer);
                    wrapper.addView(entry.media, new LayoutParams(-1, -1));
                    ImageView image = new ImageView(getContext());
                    if (!layer.alt.isEmpty()) image.setContentDescription(layer.alt);
                    if (secondaryVideo && layer.videoUrl != null) {
                        entry.video = new SceneVideo(getContext(), layer, image, secondaryVideoAudio);
                        entry.media.addView(entry.video, new LayoutParams(-1, -1));
                    }
                    image.setScaleType("contain".equals(layer.fit) ? ImageView.ScaleType.FIT_CENTER :
                            "fill".equals(layer.fit) ? ImageView.ScaleType.FIT_XY : ImageView.ScaleType.CENTER_CROP);
                    entry.media.addView(image, new LayoutParams(-1, -1));
                    if (url != null) jobs.add(workers.submit(() -> {
                        try {
                            android.graphics.Bitmap bitmap = network.sceneImage(url);
                            post(() -> {
                                if (disposed || bitmap == null) return;
                                image.setImageBitmap(bitmap);
                                entry.artwork = true;
                                update(elapsed, moving);
                            });
                        } catch (IOException ignored) {}
                    }));
                }
            } else if ("text".equals(layer.type)) {
                TextView text = new TextView(getContext());
                text.setIncludeFontPadding(false);
                String label = layer.text;
                if ("title".equals(layer.binding)) label = offer != null ? offer.commerce.title : "";
                if ("price".equals(layer.binding)) label = offer != null ? offer.price() : "";
                text.setText(label);
                text.setTextColor(color(layer.fill, Color.WHITE));
                int weight;
                try { weight = Integer.parseInt(layer.fontWeight); }
                catch (NumberFormatException ignored) { weight = 400; }
                int typeface = weight >= 600 ? Typeface.BOLD : Typeface.NORMAL;
                if ("italic".equals(layer.fontStyle)) typeface |= Typeface.ITALIC;
                // A layer that asks for Montserrat gets the bundled font at its weight; other families as before.
                Typeface bundled = OverlayFonts.asksForMontserrat(layer.fontFamily) ? OverlayFonts.montserrat(getContext(), weight) : null;
                if (bundled != null) text.setTypeface(bundled, (typeface & Typeface.ITALIC) != 0 ? Typeface.ITALIC : Typeface.NORMAL);
                else text.setTypeface(Typeface.create(layer.fontFamily, typeface));
                text.setLineSpacing(0, layer.lineHeight);
                text.setLetterSpacing(layer.letterSpacing / Math.max(1, layer.fontSize));
                if (layer.maxLines > 0) {
                    text.setMaxLines(layer.maxLines);
                    text.setEllipsize(TextUtils.TruncateAt.END);
                }
                text.setGravity("center".equals(layer.textAlign) ? Gravity.TOP | Gravity.CENTER_HORIZONTAL :
                        "right".equals(layer.textAlign) ? Gravity.TOP | Gravity.RIGHT : Gravity.TOP | Gravity.LEFT);
                wrapper.addView(text, new LayoutParams(-1, -1));
                entry.text = text;
                entry.artwork = !label.isEmpty();
            } else if ("line".equals(layer.type)) {
                entry.line = new SceneLine(getContext(), layer);
                wrapper.addView(entry.line, new LayoutParams(-1, -1));
                entry.artwork = Color.alpha(entry.line.paint.getColor()) > 0;
            } else {
                int fill = color(layer.fill, Color.TRANSPARENT);
                int stroke = color(layer.stroke, Color.TRANSPARENT);
                entry.artwork = Color.alpha(fill) > 0 || layer.gradient != null ||
                        (layer.strokeWidth > 0 && Color.alpha(stroke) > 0);
                if (entry.artwork) {
                    entry.background = new GradientDrawable();
                    entry.background.setShape("ellipse".equals(layer.type) ? GradientDrawable.OVAL : GradientDrawable.RECTANGLE);
                    entry.background.setColor(fill);
                    if (layer.gradient != null) {
                        int first = color(layer.gradient.optString("from"), fill);
                        int last = color(layer.gradient.optString("to"), fill);
                        GradientDrawable.Orientation[] directions = {
                            GradientDrawable.Orientation.BOTTOM_TOP, GradientDrawable.Orientation.BL_TR,
                            GradientDrawable.Orientation.LEFT_RIGHT, GradientDrawable.Orientation.TL_BR,
                            GradientDrawable.Orientation.TOP_BOTTOM, GradientDrawable.Orientation.TR_BL,
                            GradientDrawable.Orientation.RIGHT_LEFT, GradientDrawable.Orientation.BR_TL};
                        int angle = Math.round((float) layer.gradient.optDouble("angle", 0) / 45);
                        entry.background.setOrientation(directions[((angle % 8) + 8) % 8]);
                        entry.background.setColors(new int[]{first, last});
                    }
                    wrapper.setBackground(entry.background);
                }
            }

            boolean canBuy = open != null && offer != null && ("product".equals(layer.action) || "product".equals(layer.type));
            boolean link = "link".equals(layer.action) && layer.link != null;
            if (canBuy || link) {
                View button = new View(getContext());
                button.setId(View.generateViewId());
                button.setFocusable(true);
                button.setFocusableInTouchMode(television);
                button.setOnKeyListener((view, key, event) ->
                        event.getAction() == KeyEvent.ACTION_DOWN && moveFocus(entry, key));
                button.setContentDescription(canBuy ? offer.commerce.title : layer.text.isEmpty() ? layer.link : layer.text);
                StateListDrawable outline = new StateListDrawable();
                GradientDrawable focused = new GradientDrawable();
                focused.setColor(Color.TRANSPARENT);
                focused.setStroke(Math.max(2, Math.round(getResources().getDisplayMetrics().density * 2)), 0xff78e4fd);
                outline.addState(new int[]{android.R.attr.state_focused}, focused);
                button.setBackground(outline);
                button.setOnClickListener(v -> {
                    if (canBuy) open.open(offer, v);
                    else {
                        try { getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(layer.link))); }
                        catch (ActivityNotFoundException ignored) {}
                    }
                });
                wrapper.addView(button, new LayoutParams(-1, -1));
                entry.action = button;
            }
        }
        parent.addView(this, new LayoutParams(-1, -1));
    }

    static int color(String value, int fallback) {
        if (value == null || value.isEmpty()) return fallback;
        if (value.matches("#[0-9a-fA-F]{8}")) value = "#" + value.substring(7) + value.substring(1, 7);
        if (value.matches("#[0-9a-fA-F]{3}")) value = "#" + value.substring(1, 2).repeat(2)
                + value.substring(2, 3).repeat(2) + value.substring(3).repeat(2);
        try { return Color.parseColor(value); }
        catch (IllegalArgumentException ignored) { return fallback; }
    }

    void applyAudioPermissions(OverlayScene incoming) {
        Set<String> audible = new HashSet<>();
        for (OverlayScene.Layer layer : incoming.layers) {
            if (layer.audio) audible.add(layer.id);
        }
        for (Entry entry : entries) {
            if (entry.video != null && !audible.contains(entry.layer.id)) entry.video.mute();
        }
    }

    void update(long time, boolean moving) {
        this.moving = moving;
        elapsed = Math.min(time, cue.scene.duration);
        float w = getWidth(), h = getHeight();
        if (w <= 0 || h <= 0) return;
        boolean corner = "l".equals(cue.format);
        float[] canvas = canvas(cue.format, w, h);
        float canvasLeft = canvas[0], canvasTop = canvas[1];
        float sx = canvas[2] / cue.scene.width, sy = canvas[3] / cue.scene.height;
        clip.reset();
        if (corner) {
            clip.addRect(w * .75f, 0, w, h, Path.Direction.CW);
            clip.addRect(0, h * .75f, w * .75f, h, Path.Direction.CW);
        } else clip.addRect(canvasLeft, canvasTop, canvasLeft + sx * cue.scene.width,
                canvasTop + sy * cue.scene.height, Path.Direction.CW);

        ready = false;
        View initial = null;
        for (Entry entry : entries) {
            OverlayScene.Layer layer = entry.layer;
            OverlayScene.Frame frame = layer.frame(elapsed);
            float width = layer.width * sx, height = layer.height * sy;
            float left = canvasLeft + frame.x * sx, top = canvasTop + frame.y * sy;
            float rotation = frame.rotation;
            double angle = Math.toRadians(rotation);
            float radiusX = (float) (Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle))) * frame.scale / 2;
            float radiusY = (float) (Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle))) * frame.scale / 2;
            float cx = left + width / 2, cy = top + height / 2;
            boolean inBands = !corner || cx + radiusX > w * .75f || cy + radiusY > h * .75f;
            boolean visible = frame.visible && inBands && cx + radiusX > canvasLeft && cy + radiusY > canvasTop &&
                    cx - radiusX < canvasLeft + sx * cue.scene.width && cy - radiusY < canvasTop + sy * cue.scene.height;
            entry.centerX = cx;
            entry.centerY = cy;
            entry.wrapper.setVisibility(visible ? VISIBLE : INVISIBLE);
            if (entry.video != null) entry.video.update(elapsed, visible, moving);
            if (!visible) continue;
            ready |= entry.artwork || entry.video != null && entry.video.rendered();
            if (initial == null) initial = entry.action;
            LayoutParams params = (LayoutParams) entry.wrapper.getLayoutParams();
            int targetW = Math.max(1, Math.round(width)), targetH = Math.max(1, Math.round(height));
            if (params.width != targetW || params.height != targetH) {
                params.width = targetW;
                params.height = targetH;
                entry.wrapper.setLayoutParams(params);
            }
            entry.wrapper.setTranslationX(left);
            entry.wrapper.setTranslationY(top);
            entry.wrapper.setAlpha(Math.min(1, frame.opacity));
            entry.wrapper.setScaleX(frame.scale);
            entry.wrapper.setScaleY(frame.scale);
            entry.wrapper.setRotation(rotation);
            if (entry.styleScale != sx) {
                entry.styleScale = sx;
                if (entry.media != null) entry.media.setRadius("rect".equals(layer.mask) ? 0 : layer.radius * sx);
                if (entry.text != null) {
                    entry.text.setTextSize(TypedValue.COMPLEX_UNIT_PX, Math.max(1, layer.fontSize * sx));
                    if (layer.shadow != null) entry.text.setShadowLayer(
                            (float) layer.shadow.optDouble("blur", 0) * sx,
                            (float) layer.shadow.optDouble("x", 0) * sx,
                            (float) layer.shadow.optDouble("y", 0) * sx,
                            color(layer.shadow.optString("color"), Color.TRANSPARENT));
                }
                if (entry.line != null) entry.line.paint.setStrokeWidth(Math.max(1, layer.strokeWidth * sx));
                if (entry.background != null) entry.background.setCornerRadius(layer.radius * sx);
                if (layer.strokeWidth > 0 && !layer.stroke.isEmpty() && entry.background != null) {
                    entry.background.setStroke(Math.max(1, Math.round(layer.strokeWidth * sx)),
                            color(layer.stroke, Color.TRANSPARENT));
                }
            }
        }
        if (!ready) drawn = false;
        setVisibility(ready ? VISIBLE : INVISIBLE);
        if (ready && television && !focused && initial != null) {
            focused = initial.requestFocus();
        }
        invalidate();
    }

    private boolean moveFocus(Entry current, int key) {
        int x = 0, y = 0;
        switch (key) {
            case KeyEvent.KEYCODE_DPAD_LEFT: x = -1; break;
            case KeyEvent.KEYCODE_DPAD_RIGHT: x = 1; break;
            case KeyEvent.KEYCODE_DPAD_UP: y = -1; break;
            case KeyEvent.KEYCODE_DPAD_DOWN: y = 1; break;
            default: return false;
        }
        Entry closest = null;
        float best = Float.POSITIVE_INFINITY;
        for (Entry candidate : entries) {
            if (candidate == current || candidate.action == null || !candidate.action.isShown()) continue;
            float dx = (candidate.centerX - current.centerX) / getWidth();
            float dy = (candidate.centerY - current.centerY) / getHeight();
            float forward = x * dx + y * dy;
            float distance = forward + 2 * Math.abs(x * dy + y * dx);
            if (forward > 0 && distance < best) {
                closest = candidate;
                best = distance;
            }
        }
        return closest != null && closest.action.requestFocus();
    }

    boolean ready() { return ready; }

    boolean isDrawnAndVisible() { return drawn && isShown() && getLocalVisibleRect(visibleArea); }

    @Override protected void onSizeChanged(int w, int h, int oldW, int oldH) {
        super.onSizeChanged(w, h, oldW, oldH);
        update(elapsed, moving);
    }

    @Override protected void dispatchDraw(Canvas canvas) {
        int save = canvas.save();
        canvas.clipPath(clip);
        super.dispatchDraw(canvas);
        canvas.restoreToCount(save);
        if (ready && !drawn && getLocalVisibleRect(visibleArea)) {
            drawn = true;
            post(afterDraw);
        }
    }

    /** Left, top, width and height of the scene canvas in a w×h player. The L spans the whole frame. */
    static float[] canvas(String format, float w, float h) {
        if ("l".equals(format)) return new float[]{0, 0, w, h};
        boolean floating = "overlay".equals(format);
        return new float[]{w * (floating ? .64f : .125f), h * (floating ? .10f : .7f),
                w * (floating ? .3f : .75f), h * (floating ? .32f : .2f)};
    }

    /**
     * Whether a touch at (x, y) in a w×h player belongs to the creative rather than to the program.
     * Drawing is clipped to this area, but a layer's bounds, and so its touch target, can extend past it.
     */
    static boolean takesTouch(String format, float x, float y, float w, float h) {
        if ("l".equals(format)) return x >= w * .75f || y >= h * .75f;
        float[] area = canvas(format, w, h);
        return x >= area[0] && x < area[0] + area[2] && y >= area[1] && y < area[1] + area[3];
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        // Each further finger is delivered to the child under it as a new gesture, so it is checked too.
        if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN) {
            int pointer = event.getActionIndex();
            if (!takesTouch(cue.format, event.getX(pointer), event.getY(pointer), getWidth(), getHeight())) return false;
        }
        return super.dispatchTouchEvent(event);
    }

    void dispose() {
        disposed = true;
        for (Future<?> job : jobs) job.cancel(true);
        for (Entry entry : entries) if (entry.video != null) entry.video.dispose();
        boolean hadFocus = hasFocus();
        ((FrameLayout) getParent()).removeView(this);
        if (hadFocus && previousFocus != null && previousFocus.isAttachedToWindow()) previousFocus.requestFocus();
    }

    private static final class SceneLine extends View {
        final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path arrow = new Path();
        private final boolean hasArrow;

        SceneLine(android.content.Context context, OverlayScene.Layer layer) {
            super(context);
            paint.setColor(color(layer.stroke, color(layer.fill, Color.WHITE)));
            hasArrow = layer.arrow;
        }

        @Override protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight();
            canvas.drawLine(0, h / 2, w, h / 2, paint);
            if (!hasArrow) return;
            arrow.reset();
            arrow.moveTo(w * .9f, 0);
            arrow.lineTo(w, h / 2);
            arrow.lineTo(w * .9f, h);
            arrow.close();
            canvas.drawPath(arrow, paint);
        }
    }

    private static final class MediaViewport extends FrameLayout {
        private final OverlayScene.Layer layer;
        private final Path clip = new Path();
        private float radius;

        MediaViewport(android.content.Context context, OverlayScene.Layer layer) {
            super(context);
            this.layer = layer;
            setClipChildren(false);
        }

        void setRadius(float radius) {
            this.radius = Math.max(0, radius);
            invalidate();
        }

        @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
            super.onSizeChanged(width, height, oldWidth, oldHeight);
            float overflow = (layer.cropZoom - 1) / 2;
            for (int i = 0; i < getChildCount(); i++) {
                View media = getChildAt(i);
                media.setScaleX(layer.cropZoom);
                media.setScaleY(layer.cropZoom);
                media.setTranslationX(layer.cropX * overflow * width);
                media.setTranslationY(layer.cropY * overflow * height);
            }
        }

        @Override protected void dispatchDraw(Canvas canvas) {
            int save = canvas.save();
            float width = getWidth(), height = getHeight();
            sizeClip(canvas, width, height);
            super.dispatchDraw(canvas);
            canvas.restoreToCount(save);
        }

        private void sizeClip(Canvas canvas, float width, float height) {
            clip.reset();
            if ("ellipse".equals(layer.mask)) clip.addOval(0, 0, width, height, Path.Direction.CW);
            else if (radius > 0) {
                float corner = Math.min(radius, Math.min(width, height) / 2);
                clip.addRoundRect(0, 0, width, height, corner, corner, Path.Direction.CW);
            } else clip.addRect(0, 0, width, height, Path.Direction.CW);
            canvas.clipPath(clip);
        }
    }

    private static final class Entry {
        final FrameLayout wrapper;
        final OverlayScene.Layer layer;
        GradientDrawable background;
        TextView text;
        SceneVideo video;
        MediaViewport media;
        SceneLine line;
        View action;
        boolean artwork;
        float centerX, centerY, styleScale;

        Entry(FrameLayout wrapper, OverlayScene.Layer layer) {
            this.wrapper = wrapper;
            this.layer = layer;
        }
    }
}

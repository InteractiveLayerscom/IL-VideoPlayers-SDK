package com.interactivelayers.overlay;

import android.graphics.Color;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.List;

/**
 * Full-player photo viewer. Browsing here only changes the displayed photo. The look follows web's .il-tv-viewer:
 * a toolbar with the round back button, the title and the counter, the photo below, and round arrows at the sides.
 */
final class TvPhotoGallery extends FrameLayout {
    final Button closeButton;
    /** The control focused on opening: «next» with several photos, else Close (web/tv-shop.mjs:193). */
    Button initialFocus;
    private final CommercePanel host;
    private final List<String> photos;
    private final ImageView image;
    private final TextView position;
    private int index;

    TvPhotoGallery(CommercePanel host, TvShopView style) {
        super(host.getContext());
        this.host = host;
        photos = host.gallery();
        setBackgroundColor(0xff141414);
        View parent = (View) host.getParent();
        int width = parent != null && parent.getWidth() > 0 ? parent.getWidth() : host.dp(640);
        float em = Math.max(12, Math.min(36, width * .0165f));
        int ring = style.ring();
        LinearLayout column = new LinearLayout(getContext());
        column.setOrientation(LinearLayout.VERTICAL);
        int vertical = Math.round(width * .015f), horizontal = Math.round(width * .025f);
        column.setPadding(horizontal - 2 * ring, vertical - 2 * ring, horizontal, vertical);
        addView(column, new LayoutParams(-1, -1));

        LinearLayout toolbar = host.row();
        column.addView(toolbar, new LinearLayout.LayoutParams(-1, -2));
        closeButton = style.button("‹", host::closeDetails, TvShopView.Kind.BACK, em);
        closeButton.setContentDescription(host.l("Close photos", "Cerrar fotos", "Fechar fotos"));
        toolbar.addView(closeButton);
        initialFocus = closeButton;
        TextView title = style.text(host.offer.title, 1.15f, 700, 1.2f, 1, em);
        title.setTextColor(0xfffafafa);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, -2, 1);
        titleParams.leftMargin = Math.round(.8f * em) - 2 * ring;
        toolbar.addView(title, titleParams);
        position = style.text("", 1, 500, 1.2f, 1, em);
        position.setTextColor(0xfffafafa);

        image = new ImageView(getContext());
        image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        image.setContentDescription(host.offer.title);
        LinearLayout.LayoutParams photo = new LinearLayout.LayoutParams(-1, 0, 1);
        photo.topMargin = Math.round(.65f * em);
        photo.leftMargin = 2 * ring;
        column.addView(image, photo);

        if (photos.size() > 1) {
            position.setBackground(roundFill(0xff303030));
            position.setPadding(Math.round(.75f * em), Math.round(.3f * em), Math.round(.75f * em), Math.round(.3f * em));
            LinearLayout.LayoutParams count = new LinearLayout.LayoutParams(-2, -2);
            count.leftMargin = Math.round(.8f * em);
            toolbar.addView(position, count);
            addArrow(style, false, em, horizontal - 2 * ring);
            addArrow(style, true, em, horizontal - 2 * ring);
        }
        displayPhoto();
    }

    private static android.graphics.drawable.GradientDrawable roundFill(int color) {
        android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(999);
        return shape;
    }

    /** .il-tv-viewer .il-tv-gallery-arrow: 2em round at 1.3em type, #262626eb, 2.5% from the side. */
    private void addArrow(TvShopView style, boolean forward, float em, int inset) {
        Button arrow = style.button(forward ? "›" : "‹", () -> move(forward ? 1 : -1), TvShopView.Kind.BACK, em);
        arrow.setTextColor(Color.WHITE);
        int side = Math.round(2f * 1.3f * em) + 4 * style.ring();
        arrow.setMinWidth(side);
        arrow.setMinimumWidth(side);
        arrow.setMinHeight(side);
        arrow.setMinimumHeight(side);
        android.graphics.drawable.StateListDrawable states = new android.graphics.drawable.StateListDrawable();
        int ring = style.ring();
        states.addState(new int[]{android.R.attr.state_focused},
                TvShopView.ringed(roundFill(0xeb262626), true, ring, Color.WHITE, 0xff141414, 999));
        states.addState(new int[]{}, TvShopView.ringed(roundFill(0xeb262626), false, ring, 0, 0, 999));
        arrow.setBackground(states);
        arrow.setContentDescription(forward ? host.l("Next photo", "Foto siguiente", "Próxima foto")
                : host.l("Previous photo", "Foto anterior", "Foto anterior"));
        LayoutParams params = new LayoutParams(-2, -2, Gravity.CENTER_VERTICAL | (forward ? Gravity.RIGHT : Gravity.LEFT));
        params.setMargins(inset, 0, inset, 0);
        addView(arrow, params);
        if (forward) initialFocus = arrow;
    }

    private void displayPhoto() {
        if (photos.isEmpty()) {
            image.setImageBitmap(host.fallback);
            return;
        }
        image.setImageDrawable(null);
        host.image(image, photos.get(index), 1920);
        position.setText((index + 1) + " / " + photos.size());
    }

    private void move(int delta) {
        if (photos.size() < 2) return;
        host.clearPhotos();
        index = (index + delta + photos.size()) % photos.size();
        displayPhoto();
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        int key = event.getKeyCode();
        if (key == KeyEvent.KEYCODE_DPAD_LEFT || key == KeyEvent.KEYCODE_DPAD_RIGHT) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) move(key == KeyEvent.KEYCODE_DPAD_RIGHT ? 1 : -1);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}

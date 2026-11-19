package com.interactivelayers.overlay;

import android.graphics.Color;
import android.view.Gravity;
import android.view.KeyEvent;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import java.util.List;

/** Full-player photo viewer. Browsing here only changes the displayed photo. */
final class TvPhotoGallery extends FrameLayout {
    final Button closeButton;
    private final CommercePanel host;
    private final List<String> photos;
    private final ImageView image;
    private final TextView position;
    private int index;

    TvPhotoGallery(CommercePanel host) {
        super(host.getContext());
        this.host = host;
        photos = host.gallery();
        setBackgroundColor(0xff101010);
        image = new ImageView(getContext());
        image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        image.setContentDescription(host.offer.title);
        addView(image, new LayoutParams(-1, -1));

        closeButton = host.button("←", host::closeDetails, false);
        closeButton.setContentDescription(host.l("Close photos", "Cerrar fotos", "Fechar fotos"));
        addControl(closeButton, Gravity.TOP | Gravity.LEFT);
        position = host.label("", 14, true);
        if (photos.size() > 1) {
            addArrow(false);
            addArrow(true);
            position.setGravity(Gravity.CENTER);
            position.setTextColor(Color.WHITE);
            position.setBackground(host.shape(0xd9202020, Color.TRANSPARENT, 0, 8));
            position.setPadding(host.dp(10), host.dp(4), host.dp(10), host.dp(4));
            LayoutParams count = new LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
            count.bottomMargin = host.dp(12);
            addView(position, count);
        }
        displayPhoto();
    }

    private void addControl(Button control, int gravity) {
        LayoutParams params = new LayoutParams(host.dp(48), host.dp(44), gravity);
        int inset = host.dp(12);
        params.setMargins(inset, inset, inset, inset);
        addView(control, params);
    }

    private void addArrow(boolean forward) {
        Button arrow = host.button(forward ? "›" : "‹", () -> move(forward ? 1 : -1), false);
        arrow.setContentDescription(forward ? host.l("Next photo", "Foto siguiente", "Próxima foto")
                : host.l("Previous photo", "Foto anterior", "Foto anterior"));
        addControl(arrow, Gravity.CENTER_VERTICAL | (forward ? Gravity.RIGHT : Gravity.LEFT));
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

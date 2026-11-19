package com.interactivelayers.overlay;

import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.net.Uri;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.IOException;
import java.text.NumberFormat;
import java.util.Currency;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;

final class CommercePanel extends LinearLayout {
    private final OverlayCommerce offer;
    private final View previousFocus;
    private final boolean tv;
    private final OverlayNetwork network;
    private final ExecutorService workers;
    private final String[] copy;
    private final NumberFormat money;
    private final LinearLayout details;
    private final Button open;
    private final Button change;
    private final Button checkout;
    private final TextView status;
    private final ImageView qr;
    private final TextView price;
    private Future<?> pending;
    private int generation;
    private int selection;
    private boolean disposed;
    private Future<?> photoRequest, logoRequest;
    private final Runnable onClose;
    private final int foreground;
    private final Integer accent;

    CommercePanel(FrameLayout parent, OverlayCue cue, Bitmap photo, OverlayNetwork network,
                  ExecutorService workers, Boolean television, Runnable onOpen) {
        this(parent, cue.commerce, photo, null, cue.brand, network, workers, television, onOpen, null);
    }

    CommercePanel(FrameLayout parent, OverlayCommerce offer, Bitmap photo, String photoUrl, OverlayScene.Brand brand,
                  OverlayNetwork network, ExecutorService workers, Boolean television, Runnable onOpen, Runnable onClose) {
        super(parent.getContext());
        this.onClose = onClose;
        this.foreground = SceneViews.color(brand == null ? null : brand.foreground, -1);
        this.accent = brand != null && brand.accent != null ? SceneViews.color(brand.accent, 0xff202c42) : null;
        setOrientation(VERTICAL);
        setPadding(dp(8), dp(4), dp(8), dp(4));
        setBackgroundColor(SceneViews.color(brand == null ? null : brand.background, 0xee101929));
        this.offer = offer;
        previousFocus = parent.findFocus();
        Context context = getContext();
        UiModeManager ui = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
        tv = television != null ? television :
                (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || context.getPackageManager().hasSystemFeature("android.software.leanback")
                || context.getPackageManager().hasSystemFeature("android.hardware.type.television");
        this.network = network;
        this.workers = workers;
        copy = labels(offer.locale);
        money = NumberFormat.getCurrencyInstance(Locale.forLanguageTag(offer.locale));
        try {
            money.setCurrency(Currency.getInstance(offer.currency));
        } catch (IllegalArgumentException ignored) {
            money.setCurrency(Currency.getInstance("XXX"));
        }

        details = new LinearLayout(context);
        details.setOrientation(VERTICAL);
        details.setVisibility(GONE);
        open = button(copy[0], () -> {
            onOpen.run();
            openDetails();
        });
        if (onClose == null) addView(open);
        addView(details);

        if (brand != null && brand.logoUrl != null) {
            ImageView logo = new ImageView(context);
            details.addView(logo, new LinearLayout.LayoutParams(dp(92), dp(35)));
            logoRequest = loadPhoto(logo, brand.logoUrl);
        }
        TextView name = label();
        name.setText(offer.title);
        details.addView(name);
        ImageView product = new ImageView(context);
        product.setImageBitmap(photo);
        if (photoUrl != null) photoRequest = loadPhoto(product, photoUrl);
        product.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        details.addView(product, new LinearLayout.LayoutParams(dp(60), dp(60)));

        price = label();
        details.addView(price);
        change = button("", () -> select((selection + 1) % offer.variants.size()));
        details.addView(change);
        change.setVisibility(offer.variants.size() > 1 ? VISIBLE : GONE);
        checkout = button(tv ? copy[1] : copy[2], this::buy);
        details.addView(checkout);
        details.addView(button(copy[4], this::closeDetails));

        status = label();
        status.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        details.addView(status);
        qr = new ImageView(context);
        qr.setContentDescription(copy[3]);
        details.addView(qr, new LinearLayout.LayoutParams(dp(115), dp(115)));
        qr.setVisibility(GONE);

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.RIGHT);
        params.bottomMargin = dp(12);
        params.rightMargin = dp(20);
        parent.addView(this, params);
        select(0);
        if (onClose != null) {
            onOpen.run();
            openDetails();
        } else if (tv) open.requestFocus();
    }

    private Future<?> loadPhoto(ImageView view, String url) {
        return workers.submit(() -> {
            try {
                Bitmap image = network.sceneImage(url);
                post(() -> { if (!disposed && image != null) view.setImageBitmap(image); });
            } catch (IOException ignored) {}
        });
    }

    private void openDetails() {
        details.setVisibility(VISIBLE);
        open.setVisibility(GONE);
        if (change.getVisibility() == VISIBLE) change.requestFocus();
        else checkout.requestFocus();
    }

    boolean closeDetails() {
        if (details.getVisibility() != VISIBLE) return false;
        if (onClose != null) {
            onClose.run();
            return true;
        }
        cancel();
        resetResult();
        details.setVisibility(GONE);
        open.setVisibility(VISIBLE);
        open.requestFocus();
        return true;
    }

    void dispose() {
        disposed = true;
        if (photoRequest != null) photoRequest.cancel(true);
        if (logoRequest != null) logoRequest.cancel(true);
        cancel();
        boolean hadFocus = hasFocus();
        ((ViewGroup) getParent()).removeView(this);
        if (hadFocus && previousFocus != null && previousFocus.isAttachedToWindow())
            previousFocus.requestFocus();
    }

    private void select(int index) {
        cancel();
        resetResult();
        selection = index;
        OverlayCommerce.Variant variant = offer.variants.get(index);
        change.setText(variant.label + "  ›");
        change.setContentDescription(copy[7] + " " + variant.label);
        price.setText(variant.label + " · " + money.format(variant.price));
    }

    private void cancel() {
        generation++;
        if (pending != null) pending.cancel(true);
        pending = null;
    }

    private void resetResult() {
        status.setText("");
        qr.setImageDrawable(null);
        qr.setVisibility(GONE);
        checkout.setEnabled(true);
    }

    private void buy() {
        if (pending != null || disposed) return;
        int attempt = ++generation;
        String variantId = offer.variants.get(selection).id;
        status.setText(copy[5]);
        checkout.setEnabled(false);
        pending = workers.submit(() -> {
            OverlayNetwork.Handoff reply = null;
            Bitmap image = null;
            try {
                reply = network.prepareCart(offer.handoffUrl, variantId);
                if (tv && reply.qrImageUrl != null) image = network.qrImage(reply.qrImageUrl);
            } catch (IOException ignored) {
                // The panel exposes a retry without blocking the video.
            }
            OverlayNetwork.Handoff handoff = reply;
            Bitmap bitmap = image;
            post(() -> completePurchase(attempt, handoff, bitmap));
        });
    }

    private void completePurchase(int attempt, OverlayNetwork.Handoff handoff, Bitmap bitmap) {
        if (generation != attempt || disposed || !isShown()) return;
        pending = null;
        checkout.setEnabled(true);
        if (handoff == null || (tv && bitmap == null)) {
            status.setText(copy[6]);
            return;
        }
        if (tv) {
            qr.setImageBitmap(bitmap);
            qr.setVisibility(VISIBLE);
            status.setText(copy[3]);
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(handoff.continueUrl));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            status.setText("");
        } catch (ActivityNotFoundException e) {
            status.setText(copy[6]);
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView label() {
        TextView text = new TextView(getContext());
        text.setTextColor(foreground);
        text.setMaxWidth(dp(260));
        return text;
    }

    private Button button(String label, Runnable action) {
        Button button = new Button(getContext());
        button.setText(label);
        button.setAllCaps(false);
        if (accent != null) {
            button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(accent));
            button.setTextColor(foreground);
        }
        button.setMaxWidth(dp(260));
        button.setOnClickListener(view -> action.run());
        button.setOnKeyListener((view, key, event) ->
                key == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP && closeDetails());
        return button;
    }

    private static String[] labels(String locale) {
        switch (locale) {
            case "es":
                return new String[]{"Ver producto", "Mostrar código QR", "Comprar",
                        "Escaneá el código con tu celular", "Cerrar", "Preparando tu carrito…",
                        "No se pudo preparar el carrito. Intentá de nuevo.", "Cambiar variante"};
            case "pt-BR":
                return new String[]{"Ver produto", "Mostrar código QR", "Comprar",
                        "Escaneie com seu celular", "Fechar", "Preparando seu carrinho…",
                        "Não foi possível preparar o carrinho. Tente novamente.", "Alterar variante"};
            default:
                return new String[]{"View product", "Show QR code", "Buy", "Scan with your phone",
                        "Close", "Preparing your cart…", "Could not prepare the cart. Try again.", "Change variant"};
        }
    }
}

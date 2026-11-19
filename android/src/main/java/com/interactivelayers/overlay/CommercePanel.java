package com.interactivelayers.overlay;

import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
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
    private final ScrollView scroll;
    private final Button back;
    private final Button[] choices;
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
    private final int background, foreground;
    private final Integer accent;
    private static final int NEUTRAL = 0xff303030, SELECTED = 0xff515151, PRIMARY = 0xfff0f0f0;
    private static final int EDGE = 0xff646464;

    CommercePanel(FrameLayout parent, OverlayCue cue, Bitmap photo, OverlayNetwork network,
                  ExecutorService workers, Boolean television, Runnable onOpen) {
        this(parent, cue.commerce, photo, null, cue.brand, network, workers, television, onOpen, null);
    }

    CommercePanel(FrameLayout parent, OverlayCommerce offer, Bitmap photo, String photoUrl, OverlayScene.Brand brand,
                  OverlayNetwork network, ExecutorService workers, Boolean television, Runnable onOpen, Runnable onClose) {
        super(parent.getContext());
        this.onClose = onClose;
        background = SceneViews.color(brand == null ? null : brand.background, 0xff202020);
        foreground = readable(SceneViews.color(brand == null ? null : brand.foreground, 0xfff5f5f5), background);
        accent = brand != null && brand.accent != null ? SceneViews.color(brand.accent, SELECTED) : null;
        setOrientation(VERTICAL);
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

        open = button(copy[0], () -> {
            onOpen.run();
            openDetails();
        }, false);
        if (onClose == null) addView(open);

        details = new LinearLayout(context);
        details.setOrientation(VERTICAL);
        details.setPadding(dp(14), dp(12), dp(14), dp(12));
        details.setBackground(shape(background, EDGE, 1, 14));
        details.setClickable(true);
        details.setFocusable(false);
        details.setVisibility(GONE);
        addView(details, new LayoutParams(-1, -2));

        scroll = new ScrollView(context);
        scroll.setFocusable(false);
        scroll.setSmoothScrollingEnabled(false);
        details.addView(scroll, new LayoutParams(-1, -2, 1));
        LinearLayout body = new LinearLayout(context);
        body.setOrientation(VERTICAL);
        scroll.addView(body);
        LinearLayout bar = row();
        body.addView(bar);
        if (brand != null && brand.logoUrl != null) {
            ImageView logo = new ImageView(context);
            logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
            LayoutParams logoParams = new LayoutParams(dp(52), dp(28));
            logoParams.rightMargin = dp(8);
            bar.addView(logo, logoParams);
            logoRequest = loadPhoto(logo, brand.logoUrl);
        }
        bar.addView(label(copy[1], 13, false), new LayoutParams(0, -2, 1));
        back = button("←", this::closeDetails, false);
        back.setContentDescription(copy[4]);
        bar.addView(back, new LayoutParams(dp(44), -2));

        status = label("", 13, false);
        status.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        body.addView(status, spaced(6));
        qr = new ImageView(context);
        qr.setId(View.generateViewId());
        qr.setScaleType(ImageView.ScaleType.FIT_CENTER);
        qr.setContentDescription(copy[3]);
        qr.setFocusable(tv);
        qr.setFocusableInTouchMode(tv);
        LayoutParams qrParams = new LayoutParams(dp(136), dp(136));
        qrParams.gravity = Gravity.CENTER_HORIZONTAL;
        body.addView(qr, qrParams);

        body.addView(label(offer.title, 20, true), spaced(6));
        LinearLayout hero = row();
        body.addView(hero, spaced(8));
        if (photo != null || photoUrl != null) {
            ImageView product = new ImageView(context);
            product.setBackground(shape(0xfff5f1ed, 0, 0, 8));
            product.setClipToOutline(true);
            product.setScaleType(ImageView.ScaleType.FIT_CENTER);
            product.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
            product.setImageBitmap(photo);
            if (photoUrl != null) photoRequest = loadPhoto(product, photoUrl);
            LayoutParams thumb = new LayoutParams(dp(62), dp(62));
            thumb.rightMargin = dp(12);
            hero.addView(product, thumb);
        }
        price = label("", 18, true);
        hero.addView(price, new LayoutParams(0, -2, 1));
        body.addView(label(copy[7], 13, false), spaced(8));

        checkout = button(copy[2], this::buy, true);
        details.addView(checkout, spaced(8));
        choices = new Button[offer.variants.size()];
        LinearLayout pair = null;
        for (int i = 0; i < choices.length; i++) {
            if (i % 2 == 0) {
                pair = row();
                body.addView(pair, spaced(5));
            }
            final int index = i;
            Button choice = button(offer.variants.get(i).label, () -> {
                select(index);
                if (tv) checkout.requestFocus();
                scroll.scrollTo(0, 0);
            }, false);
            choices[i] = choice;
            LayoutParams chip = new LayoutParams(0, -2, 1);
            if (i % 2 == 1) chip.leftMargin = dp(6);
            pair.addView(choice, chip);
        }
        wireFocus();

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.RIGHT);
        params.setMargins(dp(8), dp(8), dp(10), dp(8));
        parent.addView(this, params);
        select(0);
        if (onClose != null) {
            onOpen.run();
            openDetails();
        } else if (tv) open.requestFocus();
    }

    private void wireFocus() {
        back.setNextFocusLeftId(back.getId());
        back.setNextFocusRightId(back.getId());
        back.setNextFocusUpId(back.getId());
        qr.setNextFocusUpId(back.getId());
        checkout.setNextFocusDownId(checkout.getId());
        checkout.setNextFocusLeftId(checkout.getId());
        checkout.setNextFocusRightId(checkout.getId());
        for (int i = 0; i < choices.length; i++) {
            Button choice = choices[i];
            choice.setNextFocusLeftId(i % 2 == 1 ? choices[i - 1].getId() : choice.getId());
            choice.setNextFocusRightId(i % 2 == 0 && i + 1 < choices.length ? choices[i + 1].getId() : choice.getId());
            choice.setNextFocusUpId(i >= 2 ? choices[i - 2].getId() : back.getId());
            choice.setNextFocusDownId(i + 2 < choices.length ? choices[i + 2].getId() : checkout.getId());
        }
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        if (details.getVisibility() == VISIBLE) {
            int available = MeasureSpec.getSize(widthSpec);
            int desired = Math.round(available * (tv ? .44f : .39f));
            int width = Math.max(dp(tv ? 286 : 258), Math.min(dp(tv ? 470 : 390), desired));
            widthSpec = MeasureSpec.makeMeasureSpec(Math.min(available, width), MeasureSpec.EXACTLY);
            int qrSize = Math.min(dp(136), Math.max(dp(36), MeasureSpec.getSize(heightSpec) - dp(80)));
            qr.getLayoutParams().width = qr.getLayoutParams().height = qrSize;
        }
        super.onMeasure(widthSpec, heightSpec);
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
        position(Gravity.CENTER_VERTICAL | Gravity.RIGHT);
        if (tv) choices[selection].requestFocus();
        else scroll.scrollTo(0, 0);
    }

    private void position(int gravity) {
        FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) getLayoutParams();
        params.gravity = gravity;
        setLayoutParams(params);
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
        position(Gravity.BOTTOM | Gravity.RIGHT);
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
        choices[selection].setSelected(false);
        selection = index;
        Button selected = choices[index];
        selected.setSelected(true);
        resetResult();
        qr.setNextFocusDownId(selected.getId());
        price.setText(money.format(offer.variants.get(index).price));
    }

    private void cancel() {
        generation++;
        if (pending != null) pending.cancel(true);
        pending = null;
    }

    private void resetResult() {
        checkout.setNextFocusUpId(choices[selection].getId());
        back.setNextFocusDownId(choices[selection].getId());
        status.setVisibility(GONE);
        status.setText("");
        qr.setImageDrawable(null);
        qr.setVisibility(GONE);
        checkout.setClickable(true);
    }

    private void buy() {
        if (pending != null || disposed) return;
        int attempt = ++generation;
        String variantId = offer.variants.get(selection).id;
        resetResult();
        status.setVisibility(VISIBLE);
        status.setText(copy[5]);
        checkout.setClickable(false);
        reveal(status);
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
        checkout.setClickable(true);
        if (handoff == null || (tv && bitmap == null)) {
            status.setText(copy[6]);
            reveal(status);
            return;
        }
        if (tv) {
            qr.setImageBitmap(bitmap);
            qr.setVisibility(VISIBLE);
            status.setText(copy[3]);
            back.setNextFocusDownId(qr.getId());
            checkout.setNextFocusUpId(qr.getId());
            qr.requestFocus();
            reveal(qr);
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(handoff.continueUrl));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            status.setVisibility(GONE);
        } catch (ActivityNotFoundException e) {
            status.setText(copy[6]);
            reveal(status);
        }
    }

    private void reveal(View target) {
        target.post(() -> {
            if (target.isShown()) target.requestRectangleOnScreen(new Rect(0, 0, target.getWidth(), target.getHeight()), true);
        });
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private LayoutParams spaced(int marginTop) {
        LayoutParams params = new LayoutParams(-1, -2);
        params.topMargin = dp(marginTop);
        return params;
    }

    private LinearLayout row() {
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        return row;
    }

    private TextView label(String value, int size, boolean bold) {
        TextView text = new TextView(getContext());
        text.setText(value);
        text.setTextColor(foreground);
        text.setTextSize(size);
        if (bold) text.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return text;
    }

    private GradientDrawable shape(int fill, int border, int stroke, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radius));
        if (stroke > 0) drawable.setStroke(dp(stroke), border);
        return drawable;
    }

    private static int readable(int preferred, int fill) {
        double ink = luminance(preferred) + .05, surface = luminance(fill) + .05;
        if (Math.max(ink, surface) / Math.min(ink, surface) >= 4.5) return preferred;
        return 1.05 / surface > surface / .05 ? Color.WHITE : Color.BLACK;
    }

    private static double luminance(int color) {
        return .2126 * linear(Color.red(color)) + .7152 * linear(Color.green(color)) + .0722 * linear(Color.blue(color));
    }

    private static double linear(int channel) {
        double s = channel / 255.0;
        return s <= .04045 ? s / 12.92 : Math.pow((s + .055) / 1.055, 2.4);
    }

    private Button button(String label, Runnable action, boolean primary) {
        Button button = new Button(getContext());
        button.setId(View.generateViewId());
        button.setFocusableInTouchMode(tv);
        button.setText(label);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setMinWidth(0);
        button.setMinHeight(dp(40));
        button.setMinimumHeight(dp(40));
        button.setPadding(dp(10), dp(6), dp(10), dp(6));
        button.setSingleLine(false);
        int base = primary ? (accent != null ? accent : PRIMARY) : NEUTRAL;
        int selected = accent != null ? accent : SELECTED;
        int ink = primary && accent == null ? 0xff171717 : foreground;
        int focus = readable(0xffffffff, base);
        int selectedFocus = readable(0xffffffff, selected);
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_focused, android.R.attr.state_selected}, shape(selected, selectedFocus, 3, 7));
        states.addState(new int[]{android.R.attr.state_focused}, shape(base, focus, 3, 7));
        states.addState(new int[]{android.R.attr.state_pressed}, shape(selected, 0xffffffff, 2, 7));
        states.addState(new int[]{android.R.attr.state_selected}, shape(selected, 0xffaaaaaa, 1, 7));
        states.addState(new int[]{}, shape(base, primary ? base : EDGE, 1, 7));
        button.setBackgroundTintList(null);
        button.setStateListAnimator(null);
        button.setBackground(states);
        button.setTextColor(new ColorStateList(new int[][] {
                {android.R.attr.state_selected}, {android.R.attr.state_pressed}, {}
        }, new int[] {readable(ink, selected), readable(ink, selected), readable(ink, base)}));
        button.setOnClickListener(view -> action.run());
        return button;
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK && details.getVisibility() == VISIBLE) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) closeDetails();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private static String[] labels(String locale) {
        switch (locale) {
            case "es":
                return new String[]{"Ver producto", "Producto", "Comprar",
                        "Escaneá el código con tu celular", "Cerrar", "Preparando tu carrito…",
                        "No se pudo preparar el carrito. Intentá de nuevo.", "Variante"};
            case "pt-BR":
                return new String[]{"Ver produto", "Produto", "Comprar",
                        "Escaneie com seu celular", "Fechar", "Preparando seu carrinho…",
                        "Não foi possível preparar o carrinho. Tente novamente.", "Variante"};
            default:
                return new String[]{"View product", "Product", "Buy", "Scan with your phone",
                        "Close", "Preparing your cart…", "Could not prepare the cart. Try again.", "Variant"};
        }
    }
}

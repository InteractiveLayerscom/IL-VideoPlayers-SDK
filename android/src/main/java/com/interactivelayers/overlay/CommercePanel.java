package com.interactivelayers.overlay;

import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.util.LruCache;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
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
import java.util.ArrayList;
import java.util.List;
import java.util.Currency;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;

final class CommercePanel extends LinearLayout {
    final OverlayCommerce offer;
    final OverlayScene.Brand brand;
    final Bitmap fallback;
    final String photoUrl;
    final boolean tv;
    final int background, foreground;
    final Integer accent;
    final NumberFormat money;
    final String[] copy;
    final OverlayNetwork network;
    final ExecutorService workers;
    private final View previousFocus;
    private final Button open;
    private final Runnable onClose;
    private final TvShopView shop;
    private final LinearLayout phone;
    private final List<Future<?>> photos = new ArrayList<>();
    private final LruCache<String, Bitmap> cache = new LruCache<String, Bitmap>(6 * 1024 * 1024) {
        @Override protected int sizeOf(String key, Bitmap image) { return image.getByteCount(); }
    };
    private Future<?> pending;
    private int generation, photoGeneration, phonePage;
    int selection;
    private boolean expanded, disposed;
    private TextView status;
    private static final int NEUTRAL = 0xff303030, SELECTED = 0xff515151, PRIMARY = 0xfff0f0f0;
    private static final int EDGE = 0xff646464;

    CommercePanel(FrameLayout parent, OverlayCue cue, Bitmap photo, OverlayNetwork network,
                  ExecutorService workers, Boolean television, Runnable onOpen) {
        this(parent, cue.commerce, photo, null, cue.brand, network, workers, television, onOpen, null, cue.linearCreativeId != null);
    }

    CommercePanel(FrameLayout parent, OverlayCommerce offer, Bitmap photo, String photoUrl, OverlayScene.Brand brand,
                  OverlayNetwork network, ExecutorService workers, Boolean television, Runnable onOpen, Runnable onClose) {
        this(parent, offer, photo, photoUrl, brand, network, workers, television, onOpen, onClose, false);
    }

    private CommercePanel(FrameLayout parent, OverlayCommerce offer, Bitmap photo, String photoUrl, OverlayScene.Brand brand,
                  OverlayNetwork network, ExecutorService workers, Boolean television, Runnable onOpen, Runnable onClose, boolean midroll) {
        super(parent.getContext());
        this.offer = offer;
        this.brand = brand;
        this.fallback = photo;
        this.photoUrl = photoUrl;
        this.network = network;
        this.workers = workers;
        this.onClose = onClose;
        previousFocus = parent.findFocus();
        Context context = getContext();
        UiModeManager ui = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
        tv = television != null ? television :
                (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || context.getPackageManager().hasSystemFeature("android.software.leanback")
                || context.getPackageManager().hasSystemFeature("android.hardware.type.television");
        background = SceneViews.color(brand == null ? null : brand.background, 0xff202020);
        foreground = readable(SceneViews.color(brand == null ? null : brand.foreground, 0xfff5f5f5), background);
        accent = brand != null && brand.accent != null ? SceneViews.color(brand.accent, SELECTED) : null;
        copy = labels(offer.locale);
        money = NumberFormat.getCurrencyInstance(Locale.forLanguageTag(offer.locale));
        try { money.setCurrency(Currency.getInstance(offer.currency)); }
        catch (IllegalArgumentException ignored) { money.setCurrency(Currency.getInstance("XXX")); }
        selection = Math.max(0, offer.firstAvailable());
        phonePage = selection / 20;
        setOrientation(VERTICAL);
        open = button(midroll ? copy[2] : copy[0], () -> { onOpen.run(); expand(); }, false);
        if (onClose == null) addView(open);
        shop = tv ? new TvShopView(this) : null;
        phone = tv ? null : new LinearLayout(context);
        if (phone != null) {
            phone.setOrientation(VERTICAL);
            phone.setPadding(dp(14), dp(12), dp(14), dp(12));
            phone.setBackground(shape(background, EDGE, 1, 14));
            phone.setClickable(true);
        }
        View surface = tv ? shop : phone;
        surface.setVisibility(GONE);
        addView(surface, new LayoutParams(-1, tv ? -1 : -2));
        parent.addView(this, frame(false));
        if (onClose != null) { onOpen.run(); expand(); }
        else if (tv) open.requestFocus();
    }

    String l(String en, String es, String pt) {
        return "es".equals(offer.locale) ? es : "pt-BR".equals(offer.locale) ? pt : en;
    }

    private FrameLayout.LayoutParams frame(boolean active) {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-2, active && tv ? -1 : -2,
                Gravity.RIGHT | (active ? Gravity.CENTER_VERTICAL : Gravity.BOTTOM));
        if (!(active && tv)) params.setMargins(dp(8), dp(8), dp(10), dp(8));
        return params;
    }

    private void expand() {
        expanded = true;
        open.setVisibility(GONE);
        setLayoutParams(frame(true));
        if (tv) {
            shop.setVisibility(VISIBLE);
            shop.cover();
        } else {
            phone.setVisibility(VISIBLE);
            renderPhone();
        }
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        if (expanded) {
            int available = MeasureSpec.getSize(widthSpec);
            int width;
            if (tv) width = shop.galleryOpen() ? available : Math.round(available * .42f);
            else width = Math.min(dp(390), Math.max(dp(258), Math.round(available * .39f)));
            widthSpec = MeasureSpec.makeMeasureSpec(Math.min(available, width), MeasureSpec.EXACTLY);
        }
        super.onMeasure(widthSpec, heightSpec);
    }

    boolean closeDetails() {
        if (!expanded) return false;
        if (tv && shop.back()) return true;
        if (onClose != null) onClose.run();
        else {
            cancelCheckout();
            clearPhotos();
            expanded = false;
            (tv ? shop : phone).setVisibility(GONE);
            open.setVisibility(VISIBLE);
            setLayoutParams(frame(false));
            open.requestFocus();
        }
        return true;
    }

    void dispose() {
        disposed = true;
        cancelCheckout();
        clearPhotos();
        cache.evictAll();
        boolean hadFocus = hasFocus();
        ((ViewGroup) getParent()).removeView(this);
        if (hadFocus && previousFocus != null && previousFocus.isAttachedToWindow()) previousFocus.requestFocus();
    }

    List<String> gallery() { return offer.photos(selection, photoUrl); }

    void clearPhotos() {
        photoGeneration++;
        for (Future<?> photo : photos) photo.cancel(true);
        photos.clear();
    }

    void image(ImageView target, String url, int size) {
        if (url == null) return;
        String key = size + " " + url;
        Bitmap hit = cache.get(key);
        if (hit != null) { target.setImageBitmap(hit); return; }
        int token = photoGeneration;
        photos.add(workers.submit(() -> {
            try {
                Bitmap image = network.shopImage(url, size);
                if (image != null) post(() -> {
                    if (disposed || token != photoGeneration) return;
                    cache.put(key, image);
                    target.setImageBitmap(image);
                });
            } catch (IOException ignored) {}
        }));
    }

    ImageView photo(String url, int size, boolean fallbackImage) {
        ImageView image = new ImageView(getContext());
        image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        image.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        if (fallbackImage) image.setImageBitmap(fallback);
        image(image, url, size);
        return image;
    }

    void select(int index) {
        if (index < 0 || !offer.variants.get(index).available) return;
        cancelCheckout();
        selection = index;
    }

    void cancelCheckout() {
        generation++;
        if (pending != null) pending.cancel(true);
        pending = null;
    }

    void buy() {
        if (pending != null || disposed || !offer.variants.get(selection).available) return;
        int attempt = ++generation;
        String variantId = offer.variants.get(selection).id;
        if (tv) shop.handoff(null, copy[5], false);
        else status.setText(copy[5]);
        pending = workers.submit(() -> {
            OverlayNetwork.Handoff reply = null;
            Bitmap image = null;
            try {
                reply = network.prepareCart(offer.handoffUrl, variantId);
                if (tv && reply.qrImageUrl != null) image = network.qrImage(reply.qrImageUrl);
            } catch (IOException ignored) {}
            OverlayNetwork.Handoff handoff = reply;
            Bitmap bitmap = image;
            post(() -> {
                if (attempt != generation || disposed || !expanded || !isShown()) return;
                pending = null;
                if (tv) {
                    shop.handoff(bitmap, bitmap != null ? copy[3] : copy[6], bitmap == null);
                    return;
                }
                if (handoff != null) {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(handoff.continueUrl));
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        getContext().startActivity(intent);
                        status.setText("");
                        return;
                    } catch (ActivityNotFoundException ignored) {}
                }
                status.setText(copy[6]);
            });
        });
    }

    private void renderPhone() {
        clearPhotos();
        phone.removeAllViews();
        ScrollView scroll = new ScrollView(getContext());
        phone.addView(scroll, new LayoutParams(-1, -2, 1));
        LinearLayout body = new LinearLayout(getContext());
        body.setOrientation(VERTICAL);
        scroll.addView(body);
        LinearLayout header = row();
        body.addView(header);
        if (brand != null && brand.logoUrl != null) header.addView(photo(brand.logoUrl, 128, false), new LayoutParams(dp(54), dp(32)));
        header.addView(label(copy[1], 13, false), new LayoutParams(0, -2, 1));
        Button back = button("←", this::closeDetails, false);
        back.setContentDescription(copy[4]);
        header.addView(back, new LayoutParams(dp(44), -2));
        body.addView(label(offer.title, 20, true), spaced(6));
        LinearLayout hero = row();
        body.addView(hero, spaced(8));
        String photoUrl = offer.productPhoto(selection, this.photoUrl);
        if (photoUrl != null || fallback != null) {
            ImageView shot = photo(photoUrl, 160, true);
            LayoutParams thumb = new LayoutParams(dp(62), dp(62));
            thumb.rightMargin = dp(12);
            hero.addView(shot, thumb);
        }
        hero.addView(label(money.format(offer.variants.get(selection).price), 18, true));
        // A product without options shows no variant row: the panel goes straight to Buy (web/tv-shop.mjs:196).
        int count = offer.defaultVariantOnly() ? 0 : offer.variants.size();
        if (count > 0) body.addView(label(copy[7], 13, false), spaced(8));
        LinearLayout pair = null;
        for (int i = phonePage * 20; i < Math.min(count, (phonePage + 1) * 20); i++) {
            if (i % 2 == 0) { pair = row(); body.addView(pair, spaced(5)); }
            final int index = i;
            OverlayCommerce.Variant variant = offer.variants.get(i);
            Button choice = button(variant.label, () -> { select(index); renderPhone(); }, false);
            choice.setSelected(i == selection);
            choice.setEnabled(variant.available);
            LayoutParams chip = new LayoutParams(0, -2, 1);
            if (i % 2 == 1) chip.leftMargin = dp(6);
            pair.addView(choice, chip);
        }
        if (count > 20) pager(body, phonePage, (count + 19) / 20,
                () -> { phonePage--; renderPhone(); }, () -> { phonePage++; renderPhone(); });
        status = label("", 13, false);
        status.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        body.addView(status);
        Button buy = button(copy[2], this::buy, true);
        buy.setEnabled(offer.variants.get(selection).available);
        phone.addView(buy, spaced(8));
    }

    void pager(LinearLayout body, int page, int pages, Runnable previous, Runnable next) {
        LinearLayout line = row();
        body.addView(line, spaced(4));
        Button prev = button("‹", previous, false);
        prev.setContentDescription(l("Previous page", "Página anterior", "Página anterior"));
        prev.setEnabled(page > 0);
        line.addView(prev, new LayoutParams(dp(48), -2));
        TextView index = label((page + 1) + " / " + pages, 14, false);
        index.setGravity(Gravity.CENTER);
        line.addView(index, new LayoutParams(0, -2, 1));
        Button more = button("›", next, false);
        more.setContentDescription(l("Next page", "Página siguiente", "Próxima página"));
        more.setEnabled(page + 1 < pages);
        line.addView(more, new LayoutParams(dp(48), -2));
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK && expanded) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) closeDetails();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    LayoutParams spaced(int marginTop) {
        LayoutParams params = new LayoutParams(-1, -2);
        params.topMargin = dp(marginTop);
        return params;
    }

    LinearLayout row() {
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        return row;
    }

    TextView label(String value, int size, boolean bold) {
        TextView text = new TextView(getContext());
        text.setText(value);
        text.setTextColor(foreground);
        text.setTextSize(size);
        // Web's shop type: Montserrat 500, bold texts 700 (web/tv-shop.css). Without it, exactly the panel as before.
        Typeface montserrat = OverlayFonts.montserrat(getContext(), bold ? 700 : 500);
        if (montserrat != null) text.setTypeface(montserrat);
        else if (bold) text.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return text;
    }

    GradientDrawable shape(int fill, int border, int stroke, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radius));
        if (stroke > 0) drawable.setStroke(dp(stroke), border);
        return drawable;
    }

    static int readable(int preferred, int fill) {
        double ink = luminance(preferred) + .05, surface = luminance(fill) + .05;
        if (Math.max(ink, surface) / Math.min(ink, surface) >= 4.5) return preferred;
        return 1.05 / surface > surface / .05 ? Color.WHITE : Color.BLACK;
    }

    static double luminance(int color) {
        return .2126 * linear(Color.red(color)) + .7152 * linear(Color.green(color)) + .0722 * linear(Color.blue(color));
    }

    static double linear(int channel) {
        double s = channel / 255.0;
        return s <= .04045 ? s / 12.92 : Math.pow((s + .055) / 1.055, 2.4);
    }

    Button button(String label, Runnable action, boolean primary) {
        Button button = new Button(getContext());
        button.setId(View.generateViewId());
        button.setFocusableInTouchMode(tv);
        button.setText(label);
        button.setTextSize(14);
        Typeface montserrat = OverlayFonts.montserrat(getContext(), 600);
        if (montserrat != null) button.setTypeface(montserrat);
        button.setAllCaps(false);
        button.setMinWidth(0);
        button.setMinHeight(dp(40));
        button.setMinimumHeight(dp(40));
        button.setPadding(dp(10), dp(6), dp(10), dp(6));
        button.setSingleLine(false);
        int base = primary ? (accent != null ? accent : PRIMARY) : NEUTRAL;
        int selected = accent != null ? accent : SELECTED;
        if (tv && primary) {
            base = Color.WHITE;
            selected = Color.WHITE;
        }
        int ink = primary && (tv || accent == null) ? 0xff171717 : foreground;
        int ring = tv ? (accent != null ? accent : 0xffb4c6ff) : Color.WHITE;
        int focus = readable(ring, base);
        int selectedFocus = readable(ring, selected);
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_focused, android.R.attr.state_selected}, shape(selected, selectedFocus, 3, 7));
        if (tv && primary) {
            int halo = readable(ring, background);
            LayerDrawable highlighted = new LayerDrawable(new android.graphics.drawable.Drawable[]{
                    shape(halo, halo, 0, 9), shape(base, background, 2, 7)
            });
            int inset = dp(3);
            highlighted.setLayerInset(1, inset, inset, inset, inset);
            states.addState(new int[]{android.R.attr.state_focused}, highlighted);
        } else {
            states.addState(new int[]{android.R.attr.state_focused}, shape(base, focus, 3, 7));
        }
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

    private static String[] labels(String locale) {
        switch (locale) {
            case "es":
                return new String[]{"Ver producto", "Producto", "Comprar",
                        "Escaneá para pagar en Shopify", "Cerrar", "Preparando tu carrito…",
                        "No se pudo preparar el carrito. Intentá de nuevo.", "Variante"};
            case "pt-BR":
                return new String[]{"Ver produto", "Produto", "Comprar",
                        "Escaneie para pagar na Shopify", "Fechar", "Preparando seu carrinho…",
                        "Não foi possível preparar o carrinho. Tente novamente.", "Variante"};
            default:
                return new String[]{"View product", "Product", "Buy", "Scan to pay on Shopify",
                        "Close", "Preparing your cart…", "Could not prepare the cart. Try again.", "Variant"};
        }
    }
}

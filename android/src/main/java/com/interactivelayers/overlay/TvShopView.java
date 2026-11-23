package com.interactivelayers.overlay;

import android.graphics.Bitmap;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Remote-operated product and one-item cart layered over the host's video. */
final class TvShopView extends LinearLayout {
    private enum Stage { COVER, DETAIL, GALLERY, CART, HANDOFF }
    private final CommercePanel host;
    private final Map<Integer, Integer> pages = new HashMap<>();
    private static final int PAGE_SIZE = 12;
    private Stage stage = Stage.COVER, galleryOrigin = Stage.COVER;
    private int focusDimension;
    private Button photosButton;
    private LinearLayout body;
    private View focus;
    private Bitmap code;
    private String handoffMessage;
    private boolean retry;

    TvShopView(CommercePanel host) {
        super(host.getContext());
        this.host = host;
        setOrientation(VERTICAL);
        setClickable(true);
    }

    private String l(String en, String es, String pt) { return host.l(en, es, pt); }
    private int dp(int value) { return host.dp(value); }
    private String price() { return host.money.format(host.offer.variants.get(host.selection).price); }
    /** Null for a product without options: the cart shows no variant line, as web does. */
    private String selection() {
        if (host.offer.defaultVariantOnly()) return null;
        OverlayCommerce.Variant variant = host.offer.variants.get(host.selection);
        if (variant.options.isEmpty()) return variant.label;
        return android.text.TextUtils.join(" · ", variant.options.values());
    }

    void cover() { focusDimension = host.offer.dimensions.isEmpty() ? -1 : 0; pages.clear(); show(Stage.COVER); }

    // The remote stays inside the open panel. Without this, a D-pad move with no target in the panel went to the
    // nearest focusable view of the host, such as the PlayerView's time bar (seen on the Android TV emulator).
    @Override public View focusSearch(View focused, int direction) {
        View inside = keepInside(this, focused, direction);
        return inside != null ? inside : super.focusSearch(focused, direction);
    }

    /** Null when the panel is hidden or collapsed: the normal focus search applies then. */
    static View keepInside(android.view.ViewGroup root, View focused, int direction) {
        for (View view = root; view != null; view = view.getParent() instanceof View ? (View) view.getParent() : null) {
            if (view.getVisibility() != VISIBLE) return null;
        }
        View next = android.view.FocusFinder.getInstance().findNextFocus(root, focused, direction);
        return next != null ? next : focused;
    }

    boolean galleryOpen() { return stage == Stage.GALLERY; }

    private void show(Stage next) {
        stage = next;
        render();
    }

    boolean back() {
        switch (stage) {
            case DETAIL: show(Stage.COVER); return true;
            case GALLERY:
                show(galleryOrigin);
                if (photosButton != null) photosButton.requestFocus();
                return true;
            case CART: show(Stage.DETAIL); return true;
            case HANDOFF:
                host.cancelCheckout();
                code = null;
                show(Stage.CART);
                return true;
            default: return false;
        }
    }

    void handoff(Bitmap code, String message, boolean retry) {
        this.code = code;
        handoffMessage = message;
        this.retry = retry;
        show(Stage.HANDOFF);
    }

    private void render() {
        host.clearPhotos();
        removeAllViews();
        focus = null;
        photosButton = null;
        if (galleryOpen()) {
            setPadding(0, 0, 0, 0);
            TvPhotoGallery gallery = new TvPhotoGallery(host);
            addView(gallery, new LayoutParams(-1, -1));
            focus = gallery.closeButton;
        } else {
            setPadding(dp(14), dp(9), dp(14), dp(10));
            setBackgroundColor((host.background & 0xffffff) | 0xf5000000);
            header();
            ScrollView scroll = new ScrollView(getContext());
            scroll.setFocusable(false);
            scroll.setSmoothScrollingEnabled(false);
            addView(scroll, new LayoutParams(-1, 0, 1));
            body = new LinearLayout(getContext());
            body.setOrientation(VERTICAL);
            body.setGravity(Gravity.CENTER_VERTICAL);
            scroll.setFillViewport(stage == Stage.COVER);
            scroll.addView(body);
            switch (stage) {
                case COVER:
                    hero(true);
                    if (host.offer.vendor != null) text(body, host.offer.vendor, 13, false);
                    text(body, host.offer.title, 20, true);
                    // As web: "Desde" and the lowest price when the available variants cost different amounts.
                    boolean range = host.offer.hasPriceRange();
                    String coverPrice = host.money.format(host.offer.minimumPrice);
                    if (range) coverPrice = l("From", "Desde", "A partir de") + " " + coverPrice;
                    text(body, coverPrice, 22, true);
                    if (!range) previousPrice();
                    if (host.offer.description != null) {
                        TextView description = host.label(host.offer.description, 14, false);
                        description.setMaxLines(3);
                        description.setEllipsize(android.text.TextUtils.TruncateAt.END);
                        body.addView(description, host.spaced(5));
                    }
                    if (host.offer.dimensions.size() > 1 && host.offer.availableCount > 1)
                        text(body, android.text.TextUtils.join(" · ", host.offer.dimensions), 13, false);
                    String action = host.offer.availableCount > 1 ? l("Choose options", "Elegir opciones", "Escolher opções")
                            : l("View details", "Ver detalles", "Ver detalhes");
                    primary(action, () -> show(Stage.DETAIL), true);
                    break;
                case DETAIL:
                    hero(true);
                    text(body, host.offer.title, 18, true);
                    text(body, price(), 17, true);
                    previousPrice();
                    if (host.offer.description != null) text(body, host.offer.description, 13, false);
                    options();
                    primary(l("Add to cart", "Agregar al carrito", "Adicionar ao carrinho"), () -> show(Stage.CART), available());
                    break;
                case CART:
                    cart();
                    break;
                case HANDOFF:
                    handoffBody();
                    break;
                default: break;
            }
        }
        host.requestLayout();
        if (focus != null) focus.requestFocus();
    }

    private boolean available() { return host.offer.variants.get(host.selection).available; }

    private void header() {
        LinearLayout bar = host.row();
        addView(bar);
        Button back = host.button("←", host::closeDetails, false);
        back.setContentDescription(l("Back", "Atrás", "Voltar"));
        bar.addView(back, new LayoutParams(dp(42), dp(32)));
        String heading = stage == Stage.CART || stage == Stage.HANDOFF
                ? l("Shopping cart", "Carrito de compras", "Carrinho de compras") : host.copy[1];
        TextView title = host.label(heading, 14, true);
        title.setGravity(Gravity.CENTER);
        bar.addView(title, new LayoutParams(0, -2, 1));
        if (host.brand != null && host.brand.logoUrl != null)
            bar.addView(host.photo(host.brand.logoUrl, 160, false), new LayoutParams(dp(48), dp(28)));
        focus = back;
    }

    private void previousPrice() {
        java.math.BigDecimal price = host.offer.previousPrice(host.selection);
        if (price == null) return;
        TextView before = host.label(host.money.format(price), 13, false);
        before.setPaintFlags(before.getPaintFlags() | android.graphics.Paint.STRIKE_THRU_TEXT_FLAG);
        body.addView(before, host.spaced(2));
    }

    private void text(LinearLayout section, String value, int size, boolean bold) {
        section.addView(host.label(value, size, bold), host.spaced(4));
    }

    private String productPhoto() { return host.offer.productPhoto(host.selection, host.photoUrl); }

    private int playerHeight() {
        View parent = (View) host.getParent();
        return parent != null && parent.getHeight() > 0 ? parent.getHeight() : dp(320);
    }

    private void hero(boolean galleryLink) {
        String url = productPhoto();
        if (url == null && host.fallback == null) return;
        FrameLayout art = new FrameLayout(getContext());
        // web/tv-shop.css:47, :53: 33% of the player's height on the cover, 26% on details. Web's QR step has no hero
        // (only a thumbnail), so that step keeps its earlier 25%; the cart step draws no hero.
        int height = Math.round(playerHeight() * (stage == Stage.COVER ? .33f : stage == Stage.DETAIL ? .26f : .25f));
        art.addView(host.photo(url, 720, true), new FrameLayout.LayoutParams(-1, -1));
        body.addView(art, new LayoutParams(-1, height));
        if (galleryLink) {
            photosButton = host.button(galleryLabel(), () -> {
                galleryOrigin = stage;
                show(Stage.GALLERY);
            }, false);
            photosButton.setTextSize(12);
            art.addView(photosButton, new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.RIGHT));
        }
    }

    /** "Ampliar foto" when the viewer it opens shows one photo, "Ver fotos" for several (web/tv-shop.mjs:100). */
    String galleryLabel() {
        return host.gallery().size() > 1 ? l("View photos", "Ver fotos", "Ver fotos")
                : l("Enlarge photo", "Ampliar foto", "Ampliar foto");
    }

    private void options() {
        OverlayCommerce offer = host.offer;
        if (offer.defaultVariantOnly()) return;
        if (offer.dimensions.isEmpty()) {
            List<String> labels = new ArrayList<>();
            for (OverlayCommerce.Variant variant : offer.variants) labels.add(variant.label);
            choices(-1, host.copy[7], labels);
        } else {
            for (int d = 0; d < offer.dimensions.size(); d++)
                choices(d, offer.dimensions.get(d), offer.values(host.selection, d));
        }
    }

    private void choices(int dimension, String name, List<String> values) {
        text(body, name, 13, true);
        int lastPage = Math.max(0, (values.size() - 1) / PAGE_SIZE);
        int page = Math.min(lastPage, pages.containsKey(dimension) ? pages.get(dimension) : 0);
        String selected = host.offer.variants.get(host.selection).options.get(name);
        LinearLayout row = null;
        for (int i = page * PAGE_SIZE; i < Math.min(values.size(), (page + 1) * PAGE_SIZE); i++) {
            if (i % 2 == 0) { row = host.row(); body.addView(row, host.spaced(3)); }
            final int index = i;
            String value = values.get(i);
            Button choice = host.button(value, () -> {
                int next = dimension < 0 ? index : host.offer.choose(host.selection, dimension, value);
                if (next < 0) return;
                host.select(next);
                focusDimension = dimension;
                for (int d = dimension + 1; d < host.offer.dimensions.size(); d++) pages.remove(d);
                render();
            }, false);
            boolean active = dimension < 0 ? index == host.selection : value.equals(selected);
            choice.setSelected(active);
            choice.setEnabled(dimension >= 0 || host.offer.variants.get(i).available);
            LayoutParams width = new LayoutParams(0, -2, 1);
            if (i % 2 == 1) width.leftMargin = dp(4);
            row.addView(choice, width);
            if (dimension == focusDimension && choice.isEnabled() && (active || i == page * PAGE_SIZE)) focus = choice;
        }
        if (lastPage > 0) host.pager(body, page, lastPage + 1,
                () -> { focusDimension = dimension; pages.put(dimension, page - 1); render(); },
                () -> { focusDimension = dimension; pages.put(dimension, page + 1); render(); });
    }

    private void primary(String value, Runnable action, boolean enabled) {
        Button button = host.button(enabled ? value : l("Sold out", "Agotado", "Esgotado"), action, true);
        button.setEnabled(enabled);
        LayoutParams params = host.spaced(6);
        addView(button, params);
        // On the details step the selected option keeps focus; without an option row the action takes it, as web's
        // fallback to 'cart' (web/tv-shop.mjs:358), so one OK press never leaves through the back arrow.
        if (enabled && (stage != Stage.DETAIL || host.offer.defaultVariantOnly())) focus = button;
    }

    private void cart() {
        LinearLayout item = host.row();
        body.addView(item, host.spaced(10));
        item.addView(host.photo(productPhoto(), 240, true), new LayoutParams(dp(60), dp(56)));
        LinearLayout detail = new LinearLayout(getContext());
        detail.setOrientation(VERTICAL);
        item.addView(detail, new LayoutParams(0, -2, 1));
        text(detail, host.offer.title, 15, true);
        if (selection() != null) text(detail, selection(), 13, false);
        text(detail, l("1 item", "1 unidad", "1 unidade"), 13, false);
        LinearLayout total = host.row();
        addView(total, host.spaced(6));
        total.addView(host.label("Total", 17, true), new LayoutParams(0, -2, 1));
        total.addView(host.label(price(), 18, true));
        primary(l("Continue to QR", "Continuar con el QR", "Continuar com o QR"), host::buy, available());
    }

    private void handoffBody() {
        hero(false);
        text(body, host.offer.title, 16, true);
        text(body, selection() == null ? price() : price() + "   " + selection(), 15, true);
        if (code != null) {
            ImageView qr = new ImageView(getContext());
            qr.setContentDescription(host.copy[3]);
            qr.setImageBitmap(code);
            qr.setScaleType(ImageView.ScaleType.FIT_CENTER);
            int size = Math.max(dp(76), Math.min(dp(146), Math.round(playerHeight() * .40f)));
            LayoutParams qrParams = new LayoutParams(size, size);
            qrParams.gravity = Gravity.CENTER_HORIZONTAL;
            qrParams.topMargin = dp(8);
            body.addView(qr, qrParams);
            qr.setFocusableInTouchMode(true);
            focus = qr;
        }
        TextView message = host.label(code == null ? handoffMessage :
                host.copy[3], 14, false);
        message.setGravity(Gravity.CENTER);
        message.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        body.addView(message, host.spaced(6));
        if (retry) primary(l("Try again", "Reintentar", "Tentar novamente"), host::buy, true);
    }

}

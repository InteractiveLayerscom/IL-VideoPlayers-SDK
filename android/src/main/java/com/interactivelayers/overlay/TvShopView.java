package com.interactivelayers.overlay;

import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Remote-operated product and one-item cart layered over the host's video. The look follows the web TV shop
 * (web/tv-shop.css): sizes are fractions of the player, as the stylesheet's em (1.55% of the player's width) and
 * cqh units are, so the panel scales from 720p to 1080p.
 */
final class TvShopView extends LinearLayout {
    private enum Stage { COVER, DETAIL, GALLERY, CART, HANDOFF }
    enum Kind { PRIMARY, SECONDARY, BACK, CHIP }
    private final CommercePanel host;
    private final Map<Integer, Integer> pages = new HashMap<>();
    private static final int PAGE_SIZE = 12;
    private Stage stage = Stage.COVER, galleryOrigin = Stage.COVER;
    private boolean openedFromAction;
    private int focusDimension;
    private View heroOpener, actionOpener;
    private LinearLayout body, footer;
    private ScrollView scroll;
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
    private String price() { return host.money.format(host.offer.variants.get(host.selection).price); }

    /** Null for a product without options: the cart shows no variant line, as web does. */
    private String selection() {
        if (host.offer.defaultVariantOnly()) return null;
        OverlayCommerce.Variant variant = host.offer.variants.get(host.selection);
        if (variant.options.isEmpty()) return variant.label;
        return TextUtils.join(" · ", variant.options.values());
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

    /**
     * A body taller than its space (a long title, description or facts on a small player) holds text no control sits
     * on. DOWN scrolls it from the footer (nothing below) or from the body's last control, UP scrolls it back from
     * the footer, so the remote reaches all of it. A page that fits never has its keys taken.
     */
    @Override public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        int key = event.getKeyCode();
        boolean down = key == android.view.KeyEvent.KEYCODE_DPAD_DOWN, up = key == android.view.KeyEvent.KEYCODE_DPAD_UP;
        if ((down || up) && !galleryOpen() && scroll != null && scroll.canScrollVertically(down ? 1 : -1)) {
            View focused = findFocus();
            boolean inFooter = focused != null && footer != null && isInside(focused, footer);
            View next = focused == null ? null : android.view.FocusFinder.getInstance()
                    .findNextFocus(this, focused, down ? View.FOCUS_DOWN : View.FOCUS_UP);
            // DOWN: from the footer with nothing focusable below it, or from the body's last control. UP: from the
            // footer while the body is scrolled; at the top focus moves into the body as usual.
            boolean leavesBody = down ? (inFooter ? next == null || !isInside(next, footer) : next == null || !isInside(next, body))
                    : inFooter;
            if (up && inFooter) {
                // A control already in view takes focus (the lowest one), so the viewer does not scroll to the top
                // and walk back down; with none in view, UP scrolls the body.
                View visible = lowestVisibleControl();
                if (visible != null) {
                    if (event.getAction() == android.view.KeyEvent.ACTION_DOWN) visible.requestFocus();
                    return true;
                }
            }
            if (leavesBody) {
                if (event.getAction() == android.view.KeyEvent.ACTION_DOWN)
                    scroll.scrollBy(0, (down ? 1 : -1) * Math.round(scroll.getHeight() * .6f));
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    /** The lowest enabled focusable body control at least partly inside the scroll viewport, or null. */
    private View lowestVisibleControl() {
        View lowest = null;
        int bottom = Integer.MIN_VALUE, top = scroll.getScrollY(), end = top + scroll.getHeight();
        android.graphics.Rect rect = new android.graphics.Rect();
        for (View control : body.getFocusables(View.FOCUS_UP)) {
            if (!control.isEnabled()) continue;
            control.getDrawingRect(rect);
            body.offsetDescendantRectToMyCoords(control, rect);
            if (rect.bottom > top && rect.top < end && rect.bottom > bottom) {
                bottom = rect.bottom;
                lowest = control;
            }
        }
        return lowest;
    }

    private static boolean isInside(View view, View ancestor) {
        for (View v = view; v != null; v = v.getParent() instanceof View ? (View) v.getParent() : null) if (v == ancestor) return true;
        return false;
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
                // Focus returns to the control that opened the viewer (web/tv-shop.mjs:153).
                View opener = openedFromAction && actionOpener != null ? actionOpener : heroOpener;
                if (opener != null) opener.requestFocus();
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

    // --- Proportions of web/tv-shop.css -------------------------------------------------------------------------

    private int playerWidth() {
        View parent = (View) host.getParent();
        return parent != null && parent.getWidth() > 0 ? parent.getWidth() : host.dp(640);
    }

    private int playerHeight() {
        View parent = (View) host.getParent();
        return parent != null && parent.getHeight() > 0 ? parent.getHeight() : host.dp(360);
    }

    /** The sheet's font size: clamp(12px, 1.55cqw, 36px), in pixels. */
    float em() { return Math.max(12, Math.min(36, playerWidth() * .0155f)); }

    /** The focus outline and the gap under it: 2px each at 1080 lines, never under 2px. */
    int ring() { return Math.max(2, Math.round(playerHeight() / 540f)); }

    private int px(float ems) { return Math.round(ems * em()); }

    static Typeface weight(int weight) {
        if (Build.VERSION.SDK_INT >= 28) return Typeface.create(Typeface.DEFAULT, weight, false);
        return weight >= 600 ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT;
    }

    /** A text in the sheet's type scale: size in em, CSS weight and line height, opacity. */
    TextView text(String value, float size, int weight, float lineHeight, float alpha, float em) {
        TextView text = host.label(value, 14, false);
        text.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * em);
        text.setTypeface(weight(weight));
        text.setIncludeFontPadding(false);
        if (Build.VERSION.SDK_INT >= 28) text.setLineHeight(Math.round(size * em * lineHeight));
        else text.setLineSpacing(0, lineHeight / 1.17f);
        text.setAlpha(alpha);
        return text;
    }

    private TextView text(String value, float size, int weight) { return text(value, size, weight, 1.35f, 1, em()); }

    private static GradientDrawable round(int fill, int strokeWidth, int stroke, float radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(radius);
        if (strokeWidth > 0) shape.setStroke(strokeWidth, stroke);
        return shape;
    }

    /** The fill inset by the ring's room; focused, the outline and its dark gap (web: outline 2px + shadow 2px). */
    static Drawable ringed(Drawable fill, boolean focused, int ring, int outline, int gap, float radius) {
        if (!focused) {
            LayerDrawable plain = new LayerDrawable(new Drawable[]{fill});
            plain.setLayerInset(0, 2 * ring, 2 * ring, 2 * ring, 2 * ring);
            return plain;
        }
        LayerDrawable layers = new LayerDrawable(new Drawable[]{
                round(Color.TRANSPARENT, ring, outline, radius + 2 * ring), round(gap, 0, 0, radius + ring), fill});
        layers.setLayerInset(1, ring, ring, ring, ring);
        layers.setLayerInset(2, 2 * ring, 2 * ring, 2 * ring, 2 * ring);
        return layers;
    }

    /** A pill-shaped control (web: button, .il-tv-primary, .il-tv-secondary, .il-tv-back, chips). */
    Button button(String value, Runnable action, Kind kind, float em) {
        Button button = host.button(value, action, kind == Kind.PRIMARY);
        int ring = ring(), fg = host.foreground, bg = host.background;
        float radius = 999;
        int fill, selectedFill = fg, border = 0, ink = fg;
        switch (kind) {
            case PRIMARY: fill = Color.WHITE; ink = 0xff171717; break;
            case CHIP: fill = Color.TRANSPARENT; border = 0x997f7f7f; break;
            default: fill = 0x42808080; break;
        }
        int edge = Math.max(1, ring / 2);
        int outline = kind == Kind.PRIMARY ? Color.WHITE : fg, gap = kind == Kind.PRIMARY ? 0xff141414 : bg;
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_focused, android.R.attr.state_selected},
                ringed(round(selectedFill, 0, 0, radius), true, ring, outline, gap, radius));
        states.addState(new int[]{android.R.attr.state_selected}, ringed(round(selectedFill, 0, 0, radius), false, ring, 0, 0, radius));
        states.addState(new int[]{android.R.attr.state_focused}, ringed(round(fill, edge, border, radius), true, ring, outline, gap, radius));
        states.addState(new int[]{}, ringed(round(fill, border == 0 ? 0 : edge, border, radius), false, ring, 0, 0, radius));
        button.setBackground(states);
        button.setTextColor(new ColorStateList(new int[][]{{android.R.attr.state_selected}, {}}, new int[]{bg, ink}));
        button.setTypeface(weight(600));
        button.setIncludeFontPadding(false);
        int r2 = 2 * ring;
        if (kind == Kind.BACK) {
            int side = Math.round(1.7f * 1.3f * em) + 2 * r2;
            button.setTextSize(TypedValue.COMPLEX_UNIT_PX, 1.3f * em);
            button.setPadding(r2, r2, r2, r2);
            button.setMinWidth(side);
            button.setMinimumWidth(side);
            button.setMinHeight(side);
            button.setMinimumHeight(side);
        } else {
            button.setTextSize(TypedValue.COMPLEX_UNIT_PX, .96f * em);
            int minimum = Math.round((kind == Kind.PRIMARY ? 2.8f : 2.35f) * em) + 2 * r2;
            button.setMinHeight(minimum);
            button.setMinimumHeight(minimum);
            button.setPadding(Math.round(em) + r2, Math.round(.45f * em) + r2, Math.round(em) + r2, Math.round(.45f * em) + r2);
        }
        return button;
    }

    private Button button(String value, Runnable action, Kind kind) { return button(value, action, kind, em()); }

    private LayoutParams gapped(int width, int height, float topEms) {
        LayoutParams params = new LayoutParams(width, height);
        params.topMargin = px(topEms);
        return params;
    }

    // --- Pages --------------------------------------------------------------------------------------------------

    private void render() {
        host.clearPhotos();
        removeAllViews();
        focus = null;
        heroOpener = actionOpener = null;
        if (galleryOpen()) {
            setPadding(0, 0, 0, 0);
            TvPhotoGallery gallery = new TvPhotoGallery(host, this);
            addView(gallery, new LayoutParams(-1, -1));
            focus = gallery.initialFocus;
        } else {
            // .il-tv-sheet: padding 3.4cqh 2.25cqw, gap .7em between header, body and footer.
            int vertical = Math.round(playerHeight() * .034f), horizontal = Math.round(playerWidth() * .0225f);
            setPadding(horizontal - 2 * ring(), vertical, horizontal - 2 * ring(), vertical);
            setBackgroundColor(host.background);
            header();
            scroll = new ScrollView(getContext());
            scroll.setFocusable(false);
            scroll.setSmoothScrollingEnabled(false);
            scroll.setClipToPadding(false);
            addView(scroll, gapped(-1, 0, .7f));
            ((LayoutParams) scroll.getLayoutParams()).weight = 1;
            body = new LinearLayout(getContext());
            body.setOrientation(VERTICAL);
            scroll.addView(body);
            footer = new LinearLayout(getContext());
            footer.setOrientation(VERTICAL);
            switch (stage) {
                case COVER: coverPage(); break;
                case DETAIL: detailPage(); break;
                case CART: cartPage(); break;
                case HANDOFF: handoffPage(); break;
                default: break;
            }
            if (footer.getChildCount() > 0) addView(footer, gapped(-1, -2, .7f - 2 * ring() / em()));
        }
        host.requestLayout();
        if (focus != null) focus.requestFocus();
    }

    private boolean available() { return host.offer.variants.get(host.selection).available; }

    private void header() {
        LinearLayout bar = host.row();
        bar.setMinimumHeight(px(2));
        addView(bar);
        Button back = button("‹", host::closeDetails, Kind.BACK);
        back.setContentDescription(l("Back", "Atrás", "Voltar"));
        bar.addView(back, new LayoutParams(-2, -2));
        // web/tv-shop.mjs:260: Producto, Detalles, Tu carrito, Pago con Shopify.
        String heading;
        switch (stage) {
            case DETAIL: heading = l("Details", "Detalles", "Detalhes"); break;
            case CART: heading = l("Your cart", "Tu carrito", "Seu carrinho"); break;
            case HANDOFF: heading = l("Shopify checkout", "Pago con Shopify", "Pagamento na Shopify"); break;
            default: heading = host.copy[1]; break;
        }
        TextView title = text(heading, 1, 700, 1.2f, 1, em());
        title.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        LayoutParams titleParams = new LayoutParams(0, -2, 1);
        titleParams.leftMargin = px(.65f) - 2 * ring();
        bar.addView(title, titleParams);
        if (host.brand != null && host.brand.logoUrl != null) {
            ImageView logo = host.photo(host.brand.logoUrl, 160, false);
            LayoutParams logoParams = new LayoutParams(Math.round(.23f * playerWidth() * .42f), px(1.65f));
            logoParams.leftMargin = px(.65f);
            bar.addView(logo, logoParams);
        }
        focus = back;
    }

    private void coverPage() {
        OverlayCommerce offer = host.offer;
        hero(.33f, false, l("Enlarge photo", "Ampliar foto", "Ampliar foto"));
        LinearLayout info = new LinearLayout(getContext());
        info.setOrientation(VERTICAL);
        body.addView(info, gapped(-1, -2, body.getChildCount() > 0 ? .65f : 0));
        if (offer.vendor != null) {
            TextView vendor = text(offer.vendor, .8f, 650, 1.35f, .78f, em());
            vendor.setLetterSpacing(.055f);
            info.addView(vendor, new LayoutParams(-1, -2));
        }
        info.addView(text(offer.title, 1.5f, 700, 1.1f, 1, em()), gapped(-1, -2, info.getChildCount() > 0 ? .5f : 0));
        info.addView(prices(true), gapped(-1, -2, .5f));
        if (offer.description != null) {
            TextView description = text(offer.description, 1, 500, 1.4f, 1, em());
            description.setMaxLines(3);
            description.setEllipsize(TextUtils.TruncateAt.END);
            info.addView(description, gapped(-1, -2, .5f));
        }
        facts(info);
        // .il-tv-actions: the primary action takes the remaining width, the photo button its own.
        LinearLayout actions = host.row();
        actions.setGravity(Gravity.CENTER_VERTICAL);
        boolean ok = available();
        String next = offer.availableCount > 1 ? l("Choose options", "Elegir opciones", "Escolher opções")
                : l("View details", "Ver detalles", "Ver detalhes");
        Button primary = button(ok ? next : soldOut(), () -> show(Stage.DETAIL), Kind.PRIMARY);
        primary.setEnabled(ok);
        if (!ok) primary.setAlpha(.42f);
        actions.addView(primary, new LayoutParams(0, -2, 1));
        if (!host.gallery().isEmpty()) {
            Button photos = button(galleryLabel(), () -> openGallery(true), Kind.SECONDARY);
            LayoutParams side = new LayoutParams(-2, -2);
            side.leftMargin = px(.5f) - 4 * ring();
            actions.addView(photos, side);
            actionOpener = photos;
        }
        footer.addView(actions, new LayoutParams(-1, -2));
        if (ok) focus = primary;
    }

    /** web: dl.il-tv-facts, the option axes with more than one available value. */
    private void facts(LinearLayout info) {
        OverlayCommerce offer = host.offer;
        for (String name : offer.dimensions) {
            Set<String> values = new LinkedHashSet<>();
            for (OverlayCommerce.Variant variant : offer.variants) if (variant.available) values.add(variant.options.get(name));
            if (values.size() < 2) continue;
            List<String> list = new ArrayList<>(values);
            String shown = TextUtils.join(" · ", list.subList(0, Math.min(3, list.size())))
                    + (list.size() > 3 ? "  +" + (list.size() - 3) : "");
            LinearLayout fact = host.row();
            fact.setGravity(Gravity.TOP);
            fact.addView(text(name, .9f, 500, 1.35f, .78f, em()), new LayoutParams(-2, -2));
            LayoutParams value = new LayoutParams(0, -2, 1);
            value.leftMargin = px(.8f);
            fact.addView(text(shown, .9f, 500), value);
            info.addView(fact, gapped(-1, -2, info.getChildCount() > 0 ? .5f : 0));
        }
    }

    private String soldOut() { return l("Out of stock", "Sin stock", "Sem estoque"); }

    /** web .il-tv-prices: "Desde" and the lowest price on the cover when prices differ, else price and before. */
    private LinearLayout prices(boolean cover) {
        LinearLayout row = host.row();
        row.setGravity(Gravity.BOTTOM);
        if (cover && host.offer.hasPriceRange()) {
            // As web: "Desde" and the lowest price when the available variants cost different amounts.
            row.addView(text(l("From", "Desde", "A partir de"), 1, 500));
            TextView amount = text(host.money.format(host.offer.minimumPrice), 1.38f, 700, 1.2f, 1, em());
            LayoutParams after = new LayoutParams(-2, -2);
            after.leftMargin = px(.65f);
            row.addView(amount, after);
            return row;
        }
        row.addView(text(price(), 1.38f, 700, 1.2f, 1, em()));
        java.math.BigDecimal before = host.offer.previousPrice(host.selection);
        if (before != null) {
            TextView old = text(host.money.format(before), 1, 500, 1.35f, .78f, em());
            old.setPaintFlags(old.getPaintFlags() | android.graphics.Paint.STRIKE_THRU_TEXT_FLAG);
            LayoutParams after = new LayoutParams(-2, -2);
            after.leftMargin = px(.65f);
            row.addView(old, after);
        }
        return row;
    }

    private void detailPage() {
        String label = galleryLabel();
        if (productPhoto() != null || host.fallback != null) hero(.26f, true, label);
        else if (!host.gallery().isEmpty()) {
            Button photos = button(label, () -> openGallery(true), Kind.SECONDARY);
            body.addView(photos, new LayoutParams(-2, -2));
            actionOpener = photos;
        }
        body.addView(text(host.offer.title, 1.5f, 700, 1.1f, 1, em()), gapped(-1, -2, body.getChildCount() > 0 ? .65f : 0));
        body.addView(prices(false), gapped(-1, -2, .65f));
        options();
        boolean ok = available();
        Button add = button(ok ? l("Add to cart", "Agregar al carrito", "Adicionar ao carrinho") : soldOut(),
                () -> show(Stage.CART), Kind.PRIMARY);
        add.setEnabled(ok);
        if (!ok) add.setAlpha(.42f);
        footer.addView(add, new LayoutParams(-1, -2));
        // On the details step the selected option keeps focus; without an option row the action takes it, as web's
        // fallback to 'cart' (web/tv-shop.mjs:358), so one OK press never leaves through the back arrow.
        if (ok && host.offer.defaultVariantOnly()) focus = add;
    }

    private String productPhoto() { return host.offer.productPhoto(host.selection, host.photoUrl); }

    /** "Ampliar foto" when the viewer it opens shows one photo, "Ver fotos" for several (web/tv-shop.mjs:100). */
    String galleryLabel() {
        return host.gallery().size() > 1 ? l("View photos", "Ver fotos", "Ver fotos")
                : l("Enlarge photo", "Ampliar foto", "Ampliar foto");
    }

    private void openGallery(boolean fromAction) {
        galleryOrigin = stage;
        openedFromAction = fromAction && stage == Stage.COVER;
        show(Stage.GALLERY);
    }

    /**
     * web .il-tv-gallery-open: a rounded box across the panel, the photo contained over a blurred, dimmed copy of
     * itself, and the caption as a dark pill at the bottom right. The whole box opens the viewer.
     */
    private void hero(float share, boolean detail, String caption) {
        String url = productPhoto();
        if (url == null && host.fallback == null) return;
        float em = em(), radius = .7f * em;
        int ring = ring();
        FrameLayout art = new FrameLayout(getContext());
        art.setBackground(round(0x1f808080, 0, 0, radius));
        art.setClipToOutline(true);
        // One load for both: the photo hands each bitmap it receives to the blurred copy behind it.
        ImageView backdrop = new ImageView(getContext());
        backdrop.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        backdrop.setScaleType(ImageView.ScaleType.CENTER_CROP);
        backdrop.setScaleX(1.14f);
        backdrop.setScaleY(1.14f);
        backdrop.setAlpha(.6f);
        if (Build.VERSION.SDK_INT >= 31)
            backdrop.setRenderEffect(android.graphics.RenderEffect.createBlurEffect(em, em, android.graphics.Shader.TileMode.CLAMP));
        art.addView(backdrop, new FrameLayout.LayoutParams(-1, -1));
        ImageView front = new ImageView(getContext()) {
            @Override public void setImageBitmap(Bitmap bitmap) {
                super.setImageBitmap(bitmap);
                backdrop.setImageBitmap(bitmap);
            }
        };
        front.setScaleType(ImageView.ScaleType.FIT_CENTER);
        front.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        front.setImageBitmap(host.fallback);
        host.image(front, url, 720);
        art.addView(front, new FrameLayout.LayoutParams(-1, -1));
        TextView chip = text(caption, .96f, 600, 1.2f, 1, em);
        chip.setTextColor(Color.WHITE);
        chip.setBackground(round(0xed232323, 0, 0, 999));
        chip.setPadding(px(.75f), px(.3f), px(.75f), px(.3f));
        FrameLayout.LayoutParams corner = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.RIGHT);
        corner.setMargins(0, 0, px(.45f), px(.45f));
        art.addView(chip, corner);
        art.setFocusable(true);
        art.setFocusableInTouchMode(true);
        art.setClickable(true);
        art.setContentDescription(caption);
        art.setOnClickListener(view -> openGallery(false));
        StateListDrawable rings = new StateListDrawable();
        LayerDrawable focused = new LayerDrawable(new Drawable[]{
                round(Color.TRANSPARENT, ring, host.foreground, radius), round(Color.TRANSPARENT, ring, host.background, radius - ring)});
        focused.setLayerInset(1, ring, ring, ring, ring);
        rings.addState(new int[]{android.R.attr.state_focused}, focused);
        art.setForeground(rings);
        LayoutParams box = new LayoutParams(-1, Math.round(playerHeight() * share));
        box.leftMargin = box.rightMargin = 2 * ring;
        body.addView(art, box);
        heroOpener = art;
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

    /** web: h4 and an .il-tv-row of pills; the selected value is filled with the text colour. */
    private void choices(int dimension, String name, List<String> values) {
        body.addView(text(name, 1, 650, 1.2f, 1, em()), gapped(-1, -2, .65f));
        int lastPage = Math.max(0, (values.size() - 1) / PAGE_SIZE);
        int page = Math.min(lastPage, pages.containsKey(dimension) ? pages.get(dimension) : 0);
        String selected = host.offer.variants.get(host.selection).options.get(name);
        HorizontalScrollView strip = new HorizontalScrollView(getContext());
        strip.setHorizontalScrollBarEnabled(false);
        strip.setFocusable(false);
        LinearLayout row = host.row();
        strip.addView(row);
        body.addView(strip, gapped(-1, -2, .65f - 2 * ring() / em()));
        for (int i = page * PAGE_SIZE; i < Math.min(values.size(), (page + 1) * PAGE_SIZE); i++) {
            final int index = i;
            String value = values.get(i);
            Button choice = button(value, () -> {
                int next = dimension < 0 ? index : host.offer.choose(host.selection, dimension, value);
                if (next < 0) return;
                host.select(next);
                focusDimension = dimension;
                for (int d = dimension + 1; d < host.offer.dimensions.size(); d++) pages.remove(d);
                render();
            }, Kind.CHIP);
            boolean active = dimension < 0 ? index == host.selection : value.equals(selected);
            choice.setSelected(active);
            choice.setEnabled(dimension >= 0 || host.offer.variants.get(i).available);
            if (!choice.isEnabled()) choice.setAlpha(.42f);
            LayoutParams pill = new LayoutParams(-2, -2);
            if (i > page * PAGE_SIZE) pill.leftMargin = px(.5f) - 4 * ring();
            row.addView(choice, pill);
            if (dimension == focusDimension && choice.isEnabled() && (active || i == page * PAGE_SIZE)) focus = choice;
        }
        if (lastPage > 0) {
            LinearLayout line = host.row();
            body.addView(line, gapped(-1, -2, .3f));
            Button prev = button("‹", () -> { focusDimension = dimension; pages.put(dimension, page - 1); render(); }, Kind.BACK);
            prev.setContentDescription(l("Previous page", "Página anterior", "Página anterior"));
            prev.setEnabled(page > 0);
            if (page == 0) prev.setAlpha(.42f);
            line.addView(prev);
            TextView index = text((page + 1) + " / " + (lastPage + 1), .96f, 600);
            index.setGravity(Gravity.CENTER);
            line.addView(index, new LayoutParams(0, -2, 1));
            Button next = button("›", () -> { focusDimension = dimension; pages.put(dimension, page + 1); render(); }, Kind.BACK);
            next.setContentDescription(l("Next page", "Página siguiente", "Próxima página"));
            next.setEnabled(page < lastPage);
            if (page == lastPage) next.setAlpha(.42f);
            line.addView(next);
        }
    }

    /** web .il-tv-line: a rounded card with the thumbnail, the title, the variant and "1 unidad". */
    private void line() {
        float em = em();
        LinearLayout card = host.row();
        int pad = px(.9f);
        card.setPadding(pad, pad, pad, pad);
        card.setBackground(round(0x1f808080, 0, 0, .7f * em));
        int width = Math.round(playerWidth() * .42f) - 2 * Math.round(playerWidth() * .0225f);
        int thumb = Math.round((width - 2 * pad) * .26f);
        String url = productPhoto();
        if (url != null || host.fallback != null) {
            ImageView picture = host.photo(url, 240, true);
            picture.setBackground(round(0x00000000, 0, 0, .45f * em));
            picture.setClipToOutline(true);
            LayoutParams square = new LayoutParams(thumb, thumb);
            square.rightMargin = px(.8f);
            card.addView(picture, square);
        }
        LinearLayout detail = new LinearLayout(getContext());
        detail.setOrientation(VERTICAL);
        detail.addView(text(host.offer.title, 1, 700));
        if (selection() != null) detail.addView(text(selection(), 1, 500), gapped(-1, -2, .25f));
        detail.addView(text(l("1 item", "1 unidad", "1 unidade"), .83f, 500, 1.35f, .78f, em), gapped(-1, -2, .25f));
        card.addView(detail, new LayoutParams(0, -2, 1));
        LayoutParams params = new LayoutParams(-1, -2);
        params.leftMargin = params.rightMargin = 2 * ring();
        body.addView(card, params);
    }

    /** web .il-tv-total: a hairline, "Total" and the amount at 1.2em. */
    private LinearLayout total() {
        LinearLayout box = new LinearLayout(getContext());
        box.setOrientation(VERTICAL);
        View rule = new View(getContext());
        rule.setBackgroundColor(0x737f7f7f);
        box.addView(rule, new LayoutParams(-1, Math.max(1, ring() / 2)));
        LinearLayout row = host.row();
        row.setGravity(Gravity.BOTTOM);
        row.addView(text("Total", 1, 700), new LayoutParams(0, -2, 1));
        row.addView(text(price(), 1.2f, 700, 1.2f, 1, em()));
        box.addView(row, gapped(-1, -2, .75f));
        return box;
    }

    private void cartPage() {
        line();
        LinearLayout sum = total();
        LayoutParams inset = new LayoutParams(-1, -2);
        inset.leftMargin = inset.rightMargin = 2 * ring();
        footer.addView(sum, inset);
        Button finish = button(l("Continue to QR", "Continuar con el QR", "Continuar com o QR"), host::buy, Kind.PRIMARY);
        finish.setEnabled(available());
        if (!available()) finish.setAlpha(.42f);
        footer.addView(finish, gapped(-1, -2, .65f - 2 * ring() / em()));
        if (available()) focus = finish;
    }

    private void handoffPage() {
        line();
        LinearLayout sum = total();
        LayoutParams inset = gapped(-1, -2, .65f);
        inset.leftMargin = inset.rightMargin = 2 * ring();
        body.addView(sum, inset);
        // .il-tv-status: the QR (white, min(max(154px, 28cqh), 82%), at most 36cqh) and the line under it.
        LinearLayout status = new LinearLayout(getContext());
        status.setOrientation(VERTICAL);
        status.setGravity(Gravity.CENTER_HORIZONTAL);
        int height = playerHeight();
        int width = Math.round(playerWidth() * .42f) - 2 * Math.round(playerWidth() * .0225f);
        if (code != null) {
            ImageView qr = new ImageView(getContext());
            qr.setContentDescription(host.copy[3]);
            qr.setImageBitmap(code);
            qr.setScaleType(ImageView.ScaleType.FIT_CENTER);
            qr.setBackgroundColor(Color.WHITE);
            int size = Math.min(Math.round(height * .36f), Math.min(Math.round(width * .82f), Math.max(154, Math.round(height * .28f))));
            status.addView(qr, new LayoutParams(size, size));
            qr.setFocusableInTouchMode(true);
            focus = qr;
        }
        TextView message = text(code == null ? handoffMessage : host.copy[3], 1, 500);
        message.setGravity(Gravity.CENTER);
        message.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        status.addView(message, gapped(-1, -2, code == null ? 0 : .6f));
        // margin: auto 0 in web: the status sits in the middle of the space left under the total.
        status.setGravity(Gravity.CENTER);
        LayoutParams middle = gapped(-1, 0, .65f);
        middle.weight = 1;
        body.addView(status, middle);
        ((ScrollView) body.getParent()).setFillViewport(true);
        if (retry) {
            Button again = button(l("Retry", "Reintentar", "Tentar novamente"), host::buy, Kind.PRIMARY);
            footer.addView(again, new LayoutParams(-1, -2));
            focus = again;
        }
    }
}

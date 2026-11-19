#if canImport(UIKit)
import UIKit

@MainActor
final class CommercePanel: UIView {
    private let offer: OverlayCommerce
    private let handoff: OverlayCheckout
    private let labels: Copy
    private let didOpen: () -> Void
    private let onCheckoutURL: ((URL) -> Void)?
    private let onClose: (() -> Void)?
    private let money = NumberFormatter()
    private let open = UIButton(type: .system)
    private let header = UIStackView()
    private let scroll = UIScrollView()
    private let body = UIStackView()
    private let choices = UIView()
    private let checkout = UIButton(type: .system)
    private let price = UILabel()
    private let status = UILabel()
    private let qr = UIImageView()
    private var chips: [UIButton] = []
    private static let pageSize = 100
    private var pageStart = 0
    private let previousPage = UIButton(type: .system)
    private let nextPage = UIButton(type: .system)
    private var choicesHeight: NSLayoutConstraint!
    private var qrHeight: NSLayoutConstraint!
    private var measuredWidth: CGFloat?
    private var selection = 0
    private var task: Task<Void, Never>?
    private var expanded = false
    private var mediaTasks: [Task<Void, Never>] = []
    private let foreground: UIColor
    private let accent: UIColor?

    // Keep native text legible at television viewing distance.
    #if os(tvOS)
    private let unit: CGFloat = 1.7
    #else
    private let unit: CGFloat = 1
    #endif

    init(_ offer: OverlayCommerce, photo: CGImage?, photoURL: URL? = nil, brand: SceneBrand? = nil,
         midroll: Bool = false, handoff: OverlayCheckout = .shared, checkoutURL: ((URL) -> Void)?, closed: (() -> Void)? = nil, opened: @escaping () -> Void) {
        self.offer = offer
        self.handoff = handoff
        onClose = closed
        let background = UIColor.sceneColor(brand?.background) ?? Self.gray(0x20)
        foreground = Self.readable(UIColor.sceneColor(brand?.foreground) ?? .white, on: background, backdrop: nil)
        accent = UIColor.sceneColor(brand?.accent)
        labels = Copy(offer.locale)
        didOpen = opened
        onCheckoutURL = checkoutURL
        super.init(frame: .zero)
        backgroundColor = background
        layer.cornerRadius = 12 * unit
        layer.borderColor = Self.gray(0x64).cgColor
        layer.borderWidth = unit
        layer.zPosition = 2
        money.numberStyle = .currency
        money.locale = Locale(identifier: offer.locale)
        money.currencyCode = offer.currency

        addSubview(open)
        configure(open, title: midroll ? labels.buy : labels.open, fill: accent ?? Self.gray(0x30)) { [weak self] in self?.openDetails() }

        header.alignment = .center
        header.spacing = 6 * unit
        let close = UIButton(type: .system)
        configure(close, title: "", fill: Self.gray(0x30)) { [weak self] in self?.closeDetails() }
        close.configuration?.image = UIImage(systemName: "chevron.left")
        close.accessibilityLabel = labels.close
        let heading = label(labels.product, size: 14, weight: .medium)
        heading.accessibilityTraits.insert(.header)
        if let url = brand?.logoURL {
            let logo = UIImageView()
            logo.contentMode = .scaleAspectFit
            logo.widthAnchor.constraint(equalToConstant: 45 * unit).isActive = true
            header.addArrangedSubview(logo)
            loadPhoto(url, into: logo)
        }
        header.addArrangedSubview(heading)
        header.addArrangedSubview(close)
        close.widthAnchor.constraint(equalToConstant: 34 * unit).isActive = true
        addSubview(header)

        addSubview(scroll)
        scroll.addSubview(body)
        body.axis = .vertical
        body.spacing = 7 * unit
        let name = label(offer.title, size: 19, weight: .bold)
        name.numberOfLines = 2
        body.addArrangedSubview(name)
        let product = UIImageView(image: photo.map { UIImage(cgImage: $0) })
        if let photoURL { loadPhoto(photoURL, into: product) }
        product.contentMode = .scaleAspectFit
        product.clipsToBounds = true
        product.backgroundColor = UIColor(red: 0.96, green: 0.95, blue: 0.93, alpha: 1)
        product.layer.cornerRadius = 5 * unit
        product.widthAnchor.constraint(equalToConstant: 55 * unit).isActive = true
        product.heightAnchor.constraint(equalTo: product.widthAnchor).isActive = true
        price.textColor = foreground
        price.font = .systemFont(ofSize: 17 * unit, weight: .semibold)
        price.adjustsFontSizeToFitWidth = true
        price.minimumScaleFactor = 0.65
        let summary = UIStackView()
        if photo != nil || photoURL != nil { summary.addArrangedSubview(product) }
        summary.addArrangedSubview(price)
        summary.alignment = .center
        summary.spacing = 10 * unit
        body.addArrangedSubview(summary)

        status.numberOfLines = 0
        status.textColor = foreground
        status.font = .systemFont(ofSize: 14 * unit)
        body.addArrangedSubview(status)
        qr.contentMode = .scaleAspectFit
        qr.layer.magnificationFilter = .nearest
        qrHeight = qr.heightAnchor.constraint(equalToConstant: 144 * unit)
        qrHeight.priority = .defaultHigh
        qrHeight.isActive = true
        qr.accessibilityLabel = labels.scan
        qr.isAccessibilityElement = true
        body.addArrangedSubview(qr)

        body.addArrangedSubview(label(labels.variant, size: 14, weight: .medium))
        body.addArrangedSubview(choices)
        choicesHeight = choices.heightAnchor.constraint(equalToConstant: 0)
        choicesHeight.isActive = true
        selection = offer.variants.firstIndex(where: \.available) ?? 0
        pageStart = selection / Self.pageSize * Self.pageSize
        if offer.variants.count > Self.pageSize {
            let pages = UIStackView(arrangedSubviews: [previousPage, nextPage])
            pages.spacing = 6 * unit
            pages.distribution = .fillEqually
            configure(previousPage, title: "‹", fill: Self.gray(0x30)) { [weak self] in self?.page(by: -1) }
            configure(nextPage, title: "›", fill: Self.gray(0x30)) { [weak self] in self?.page(by: 1) }
            previousPage.accessibilityLabel = offer.locale == "es" ? "Variantes anteriores" : offer.locale == "pt-BR" ? "Variantes anteriores" : "Previous variants"
            nextPage.accessibilityLabel = offer.locale == "es" ? "Variantes siguientes" : offer.locale == "pt-BR" ? "Próximas variantes" : "Next variants"
            body.addArrangedSubview(pages)
        }
        showChips()
        configure(checkout, title: labels.buy, fill: accent ?? Self.gray(0xf0),
                  ink: accent == nil ? Self.gray(0x20) : foreground) { [weak self] in self?.buy() }
        addSubview(checkout)
        select(selection)
        setExpanded(closed != nil)
        if expanded { didOpen() }
    }

    private static func gray(_ channel: Int) -> UIColor {
        UIColor(white: CGFloat(channel) / 255, alpha: 1)
    }

    private func label(_ text: String, size: CGFloat, weight: UIFont.Weight) -> UILabel {
        let result = UILabel()
        result.text = text
        result.textColor = foreground
        result.font = .systemFont(ofSize: size * unit, weight: weight)
        return result
    }

    private func loadPhoto(_ url: URL, into image: UIImageView) {
        mediaTasks.append(Task { [weak image] in
            guard let photo = try? await OverlayArtwork.loadSceneImage(url), !Task.isCancelled else { return }
            image?.image = UIImage(cgImage: photo)
        })
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var preferredFocusEnvironments: [UIFocusEnvironment] {
        [expanded ? (chips.first(where: \.isSelected) ?? checkout) : open]
    }

    #if os(tvOS)
    override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
        super.didUpdateFocus(in: context, with: coordinator)
        if let control = context.nextFocusedView, control.isDescendant(of: choices) {
            scroll.scrollRectToVisible(control.convert(control.bounds, to: scroll), animated: false)
        }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if presses.contains(where: { $0.type == .menu }), closeDetails() { return }
        super.pressesEnded(presses, with: event)
    }
    #endif

    private func configure(_ button: UIButton, title: String, fill: UIColor, ink: UIColor? = nil,
                           selected: UIColor? = nil, action: @escaping () -> Void) {
        var config = UIButton.Configuration.plain()
        config.title = title
        config.cornerStyle = .fixed
        config.background.cornerRadius = 7 * unit
        config.background.backgroundColor = fill
        let preferredInk = ink ?? foreground
        let normalInk = Self.readable(preferredInk, on: fill, backdrop: backgroundColor)
        let selectedInk = Self.readable(preferredInk, on: selected ?? fill, backdrop: backgroundColor)
        let focusRing = Self.readable(.white, on: fill, backdrop: backgroundColor)
        let selectedRing = Self.readable(.white, on: selected ?? fill, backdrop: backgroundColor)
        config.baseForegroundColor = normalInk
        config.titleLineBreakMode = .byTruncatingTail
        config.contentInsets = .init(top: 6 * unit, leading: 9 * unit, bottom: 6 * unit, trailing: 9 * unit)
        let font = UIFont.systemFont(ofSize: 15 * unit, weight: .semibold)
        config.titleTextAttributesTransformer = .init { attributes in
            var result = attributes
            result.font = font
            return result
        }
        button.configuration = config
        // Modify the current configuration so header imagery and the full variant label survive focus changes.
        button.configurationUpdateHandler = { [unit] control in
            guard var appearance = control.configuration else { return }
            appearance.baseForegroundColor = control.isSelected ? selectedInk : normalInk
            appearance.background.backgroundColor = control.isSelected ? selected ?? fill : fill
            let ring = control.isSelected ? selectedRing : focusRing
            appearance.background.strokeColor = control.isFocused ? ring : Self.gray(0x64)
            appearance.background.strokeWidth = control.isFocused ? 3 * unit : (selected == nil ? 0 : unit)
            control.configuration = appearance
        }
        button.addAction(UIAction { _ in action() }, for: .primaryActionTriggered)
    }

    // Compare the composited button colors, including translucent brand tokens.
    static func readable(_ preferred: UIColor, on fill: UIColor, backdrop: UIColor?) -> UIColor {
        func components(_ color: UIColor) -> (SIMD3<Double>, Double) {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 1
            color.getRed(&r, green: &g, blue: &b, alpha: &a)
            return (.init(Double(r), Double(g), Double(b)), Double(a))
        }
        func composite(_ color: UIColor, over base: SIMD3<Double>) -> SIMD3<Double> {
            let (rgb, alpha) = components(color)
            return rgb * alpha + base * (1 - alpha)
        }
        func luminance(_ rgb: SIMD3<Double>) -> Double {
            func linear(_ x: Double) -> Double { x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4) }
            return 0.2126 * linear(rgb.x) + 0.7152 * linear(rgb.y) + 0.0722 * linear(rgb.z)
        }
        let background = composite(fill, over: composite(backdrop ?? gray(0x20), over: .zero))
        let base = luminance(background)
        let ink = luminance(composite(preferred, over: background))
        if (max(base, ink) + 0.05) / (min(base, ink) + 0.05) >= 4.5 { return preferred }
        return (base + 0.05) / 0.05 > 1.05 / (base + 0.05) ? .black : .white
    }

    private func page(by offset: Int) {
        let start = pageStart + offset * Self.pageSize
        guard offer.variants.indices.contains(start) else { return }
        pageStart = start
        showChips()
        updateLayout()
        layoutIfNeeded()
        scroll.scrollRectToVisible(choices.convert(CGRect(x: 0, y: 0, width: 1, height: 40), to: scroll), animated: false)
    }

    private func showChips() {
        chips.forEach { $0.removeFromSuperview() }
        chips.removeAll()
        measuredWidth = nil
        let end = min(pageStart + Self.pageSize, offer.variants.count)
        for index in pageStart..<end {
            let variant = offer.variants[index]
            let chip = UIButton(type: .system)
            configure(chip, title: variant.label, fill: Self.gray(0x30), selected: accent ?? Self.gray(0x51)) {
                [weak self] in self?.select(index)
            }
            chip.tag = index
            chip.isSelected = index == selection
            chip.isEnabled = variant.available
            choices.addSubview(chip)
            chips.append(chip)
        }
        previousPage.isEnabled = pageStart > 0
        nextPage.isEnabled = end < offer.variants.count
    }

    private func select(_ index: Int) {
        cancel()
        selection = index
        for chip in chips { chip.isSelected = chip.tag == selection }
        checkout.isEnabled = offer.variants[selection].available
        let value = offer.variants[index].price
        price.text = money.string(from: NSDecimalNumber(decimal: value)) ?? value.description
        updateLayout()
        #if os(tvOS)
        if expanded, let system = UIFocusSystem.focusSystem(for: self) {
            system.requestFocusUpdate(to: checkout)
            system.updateFocusIfNeeded()
        }
        #endif
    }

    private func setExpanded(_ value: Bool) {
        expanded = value
        accessibilityViewIsModal = value
        open.isHidden = value
        header.isHidden = !value
        scroll.isHidden = !value
        checkout.isHidden = !value
        updateLayout()
        setNeedsFocusUpdate()
    }

    private func openDetails() {
        setExpanded(true)
        didOpen()
    }

    @discardableResult
    func closeDetails() -> Bool {
        guard expanded else { return false }
        if let onClose {
            onClose()
            return true
        }
        cancel()
        setExpanded(false)
        return true
    }

    func dispose() {
        for task in mediaTasks { task.cancel() }
        cancel()
        removeFromSuperview()
    }

    private func cancel() {
        task?.cancel()
        task = nil
        checkout.isEnabled = offer.variants[selection].available
        status.isHidden = true
        qr.isHidden = true
        qr.image = nil
    }

    private func buy() {
        guard task == nil, offer.variants[selection].available else { return }
        let variant = offer.variants[selection].id
        checkout.isEnabled = false
        showStatus(labels.preparing)
        task = Task { [weak self, offer, handoff] in
            do {
                let destination = try await handoff.prepare(offer, variant: variant)
                #if os(tvOS)
                guard let qrURL = destination.qr else { throw URLError(.badURL) }
                let image = try await handoff.qr(qrURL)
                try Task.checkCancellation()
                self?.qr.image = UIImage(cgImage: image)
                self?.qr.isHidden = false
                if let self { self.showStatus(self.labels.scan) }
                #else
                try Task.checkCancellation()
                guard let self else { return }
                if let open = self.onCheckoutURL {
                    open(destination.url)
                } else {
                    guard await UIApplication.shared.open(destination.url) else { throw URLError(.cannotOpenFile) }
                }
                self.status.isHidden = true
                self.updateLayout()
                #endif
            } catch {
                guard !Task.isCancelled, let self else { return }
                self.showStatus(self.labels.failure)
            }
            guard !Task.isCancelled else { return }
            self?.checkout.isEnabled = true
            self?.task = nil
        }
    }

    private func showStatus(_ value: String) {
        status.text = value
        status.isHidden = false
        updateLayout()
        superview?.layoutIfNeeded()
        layoutIfNeeded()
        let result: UIView = qr.isHidden ? status : qr
        scroll.scrollRectToVisible(result.convert(result.bounds, to: scroll), animated: false)
        UIAccessibility.post(notification: .announcement, argument: value)
    }

    private func updateLayout() {
        setNeedsLayout()
        superview?.setNeedsLayout()
    }

    func presentationFrame(in bounds: CGRect) -> CGRect {
        let bottom = bounds.maxY - bounds.height * 0.11
        let right = bounds.maxX - bounds.width * 0.06
        let size = sizeThatFits(CGSize(width: bounds.width, height: bounds.height * 0.86))
        return CGRect(x: max(bounds.minX, right - size.width), y: bottom - size.height,
                      width: min(size.width, right - bounds.minX), height: size.height)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        guard expanded else {
            let trigger = open.sizeThatFits(size)
            return CGSize(width: min(size.width, trigger.width + 8 * unit),
                          height: min(size.height, trigger.height + 4 * unit))
        }
        let width = min(size.width, max(200 * unit, size.width * 0.39))
        let innerWidth = max(1, width - 24 * unit)
        qrHeight.constant = min(144 * unit, innerWidth)
        let bodyHeight = measureBody(width: innerWidth)
        let height = bodyHeight + headerHeight + buyHeight + 36 * unit
        return CGSize(width: width, height: min(size.height, ceil(height)))
    }

    private var headerHeight: CGFloat { 34 * unit }
    private var buyHeight: CGFloat { 40 * unit }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard expanded else { open.frame = bounds; return }
        let inset = min(12 * unit, bounds.height * 0.055)
        let width = max(1, bounds.width - 24 * unit)
        let x = (bounds.width - width) / 2
        let gap = min(6 * unit, bounds.height * 0.025)
        let top = min(headerHeight, bounds.height * 0.24)
        let bottom = min(buyHeight, bounds.height * 0.26)
        header.frame = CGRect(x: x, y: inset, width: width, height: top)
        checkout.frame = CGRect(x: x, y: bounds.height - inset - bottom, width: width, height: bottom)
        let y = header.frame.maxY + gap
        scroll.frame = CGRect(x: x, y: y, width: width, height: max(0, checkout.frame.minY - gap - y))
        qrHeight.constant = min(144 * unit, width, scroll.bounds.height)
        body.frame = CGRect(x: 0, y: 0, width: width, height: measureBody(width: width))
        scroll.contentSize = body.bounds.size
    }

    private func measureBody(width: CGFloat) -> CGFloat {
        if measuredWidth != width {
            let gap = 6 * unit
            var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0
            for chip in chips {
                let size = chip.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
                let w = min(width, ceil(size.width))
                let h = max(32 * unit, ceil(size.height))
                if x > 0, x + w > width {
                    x = 0
                    y += lineHeight + gap
                    lineHeight = 0
                }
                chip.frame = CGRect(x: x, y: y, width: w, height: h)
                x += w + gap
                lineHeight = max(lineHeight, h)
            }
            choicesHeight.constant = y + lineHeight
            measuredWidth = width
        }
        return ceil(body.systemLayoutSizeFitting(CGSize(width: width, height: 0), withHorizontalFittingPriority: .required,
                                                 verticalFittingPriority: .fittingSizeLevel).height)
    }

    private struct Copy {
        let open, product, variant, buy, close, scan, preparing, failure: String
        init(_ locale: String) {
            switch locale {
            case "es":
                (open, product, variant, buy, close) = ("Ver producto", "Producto", "Variante", "Comprar", "Cerrar")
                (scan, preparing, failure) = ("Escaneá el código con tu celular", "Preparando tu carrito…",
                                              "No se pudo preparar el carrito. Intentá de nuevo.")
            case "pt-BR":
                (open, product, variant, buy, close) = ("Ver produto", "Produto", "Variante", "Comprar", "Fechar")
                (scan, preparing, failure) = ("Escaneie com seu celular", "Preparando seu carrinho…",
                                              "Não foi possível preparar o carrinho. Tente novamente.")
            default:
                (open, product, variant, buy, close) = ("View product", "Product", "Variant", "Buy", "Close")
                (scan, preparing, failure) = ("Scan with your phone", "Preparing your cart…",
                                              "Could not prepare the cart. Try again.")
            }
        }
    }
}
#endif

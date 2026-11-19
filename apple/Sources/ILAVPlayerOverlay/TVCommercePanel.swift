#if canImport(UIKit)
import UIKit

/// Used by tvOS. Each presentation stage stays in the host's video surface.
@MainActor
final class TVCommercePanel: UIView {
    private enum Stage { case entry, cover, details, cart, qr }
    private let offer: OverlayCommerce
    private let brand: SceneBrand?
    private let fallback: UIImage?
    private let productPhoto: SelectedProductPhoto
    private var mainPhoto: URL? { productPhoto.coverURL }
    private let imageLoader: (URL) async throws -> CGImage
    private let handoff: OverlayCheckout
    private let midroll: Bool
    private let onOpen: () -> Void
    private let onClose: (() -> Void)?
    private let background: UIColor
    private let ink: UIColor
    private let focusAccent: UIColor
    private let money = NumberFormatter()
    private var stage: Stage
    private var selection: Int
    private var viewer: TVProductPhotoViewer?
    private weak var photoButton: UIButton?
    private weak var sheetPhoto: UIImageView?
    private var galleryLoad: Task<Void, Never>?
    private var media: [Task<Void, Never>] = []
    private var checkout: Task<Void, Never>?
    private var qr: UIImage?
    private var failed = false
    private var focus: UIView?
    private var scroll = UIScrollView()
    private var body = UIStackView()
    private var footer = UIStackView()
    private var header = UIStackView()
    private var scale: CGFloat = 1
    private var rails: [TVOptionRail] = []
    private let cache = NSCache<NSURL, UIImage>()

    init(_ offer: OverlayCommerce, photo: CGImage?, photoURL: URL? = nil, brand: SceneBrand? = nil,
         midroll: Bool = false, imageLoader: @escaping (URL) async throws -> CGImage = OverlayArtwork.loadSceneImage,
         handoff: OverlayCheckout = .shared, checkoutURL: ((URL) -> Void)?,
         closed: (() -> Void)? = nil, opened: @escaping () -> Void) {
        self.offer = offer
        self.brand = brand
        self.midroll = midroll
        self.handoff = handoff
        self.imageLoader = imageLoader
        productPhoto = SelectedProductPhoto(coverURL: offer.imageURL ?? photoURL, bitmap: photo, load: imageLoader)
        fallback = photo.map(UIImage.init(cgImage:))
        onClose = closed
        onOpen = opened
        stage = closed == nil ? .entry : .cover
        selection = offer.variants.firstIndex(where: \.available) ?? 0
        background = UIColor(white: 0.085, alpha: 0.98)
        ink = .white
        focusAccent = CommercePanel.readable(UIColor.sceneColor(brand?.accent) ?? UIColor(red: 0.71, green: 0.78, blue: 1, alpha: 1),
                                             on: UIColor(white: 0.085, alpha: 1), backdrop: .black)
        super.init(frame: .zero)
        cache.totalCostLimit = 32 * 1024 * 1024
        cache.countLimit = 8
        layer.zPosition = 2
        money.numberStyle = .currency
        money.locale = Locale(identifier: offer.locale)
        money.currencyCode = offer.currency
        render()
        if stage == .cover { onOpen() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private func text(_ en: String, _ es: String, _ pt: String) -> String {
        offer.locale == "es" ? es : offer.locale == "pt-BR" ? pt : en
    }
    private var variant: OverlayCommerce.Variant { offer.variants[selection] }
    private var price: String { money.string(from: NSDecimalNumber(decimal: variant.price)) ?? variant.price.description }
    private var selectionSummary: String {
        variant.options.isEmpty ? variant.label : variant.options.map(\.value).joined(separator: " · ")
    }
    private var selectedPhoto: URL? { variant.imageURL ?? mainPhoto }
    private var gallery: [URL?] {
        var seen = Set<URL>()
        let urls = ([mainPhoto].compactMap { $0 } + offer.images + [variant.imageURL].compactMap { $0 })
            .filter { seen.insert($0).inserted }
        return fallback != nil && mainPhoto == nil ? [nil] + urls.map(Optional.some) : urls.map(Optional.some)
    }

    func presentationFrame(in bounds: CGRect) -> CGRect {
        if viewer != nil { return bounds }
        let unit = max(0.55, min(2.5, bounds.height / 640))
        if scale != unit {
            let refocusPhoto = photoButton != nil && focus === photoButton
            scale = unit
            render()
            if refocusPhoto { focus = photoButton }
        }
        switch stage {
        case .entry:
            let width = min(bounds.width * 0.85, 155 * unit), height = min(bounds.height, 48 * unit)
            return CGRect(x: bounds.maxX - width - bounds.width * 0.025, y: bounds.maxY - height - bounds.height * 0.07,
                          width: width, height: height)
        default:
            let width = min(bounds.width, max(205 * unit, bounds.width * 0.42))
            return CGRect(x: bounds.maxX - width, y: bounds.minY, width: width, height: bounds.height)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if let viewer { viewer.frame = bounds; return }
        if stage == .entry { focus?.frame = bounds; return }
        let inset = min(bounds.width * 0.07, 30 * scale)
        let top = min(bounds.height * 0.05, 27 * scale)
        let width = max(1, bounds.width - 2 * inset)
        let head = min(44 * scale, bounds.height * 0.12)
        header.frame = CGRect(x: inset, y: top, width: width, height: head)
        let foot = footer.arrangedSubviews.isEmpty ? 0 : footer.systemLayoutSizeFitting(
            CGSize(width: width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel).height
        footer.frame = CGRect(x: inset, y: max(header.frame.maxY, bounds.height - top - foot), width: width, height: foot)
        let y = header.frame.maxY + 5 * scale
        scroll.frame = CGRect(x: inset, y: y, width: width, height: max(0, footer.frame.minY - y - 8 * scale))
        let height = body.systemLayoutSizeFitting(CGSize(width: width, height: 0), withHorizontalFittingPriority: .required,
                                                   verticalFittingPriority: .fittingSizeLevel).height
        body.frame = CGRect(x: 0, y: 0, width: width, height: height)
        scroll.contentSize = body.bounds.size
    }

    override var preferredFocusEnvironments: [UIFocusEnvironment] {
        if let viewer { return [viewer] }
        return focus.map { [$0] } ?? super.preferredFocusEnvironments
    }

    #if os(tvOS)
    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if presses.contains(where: { $0.type == .menu }), closeDetails() { return }
        super.pressesEnded(presses, with: event)
    }
    #endif

    @discardableResult
    func closeDetails() -> Bool {
        if let viewer {
            galleryLoad?.cancel()
            galleryLoad = nil
            viewer.removeFromSuperview()
            self.viewer = nil
            subviews.forEach { $0.isHidden = false }
            if let sheetPhoto { productPhoto.display(variant, in: sheetPhoto) }
            focus = photoButton
            updatePresentation()
            return true
        }
        switch stage {
        case .entry: return false
        case .cover: if let onClose { onClose() } else { go(.entry) }
        case .details: go(.cover)
        case .cart: go(.details)
        case .qr: go(.cart)
        }
        return true
    }

    func dispose() {
        galleryLoad?.cancel()
        productPhoto.cancel()
        checkout?.cancel()
        media.forEach { $0.cancel() }
        removeFromSuperview()
    }

    private func go(_ next: Stage) {
        checkout?.cancel()
        checkout = nil
        qr = nil
        failed = false
        stage = next
        render()
        updatePresentation()
    }

    private func updatePresentation() {
        setNeedsLayout()
        setNeedsFocusUpdate()
        superview?.setNeedsLayout()
        superview?.layoutIfNeeded()
        if let target = preferredFocusEnvironments.first, let system = UIFocusSystem.focusSystem(for: self) {
            system.requestFocusUpdate(to: target)
            system.updateFocusIfNeeded()
        }
    }

    private func label(_ value: String, _ size: CGFloat, bold: Bool = false) -> UILabel {
        let result = UILabel()
        result.text = value
        result.textColor = ink
        result.font = .systemFont(ofSize: size * scale, weight: bold ? .bold : .regular)
        result.numberOfLines = 0
        return result
    }

    private func button(_ value: String, fill: UIColor = UIColor(white: 0.23, alpha: 1), outlined: Bool = false, symbol: String? = nil, action: (() -> Void)? = nil) -> UIButton {
        let button = UIButton(type: .system)
        var config = UIButton.Configuration.plain()
        config.title = value
        if let symbol {
            config.image = UIImage(systemName: symbol)
            config.preferredSymbolConfigurationForImage = .init(pointSize: 21 * scale, weight: .semibold)
        }
        config.baseForegroundColor = CommercePanel.readable(ink, on: fill, backdrop: background)
        config.background.backgroundColor = fill
        config.background.strokeColor = UIColor(white: 0.46, alpha: 1)
        config.background.strokeWidth = outlined ? scale : 0
        config.cornerStyle = .capsule
        let font = UIFont.systemFont(ofSize: 16 * scale, weight: .semibold)
        config.titleTextAttributesTransformer = .init { var a = $0; a.font = font; return a }
        config.contentInsets = .init(top: 7*scale, leading: 10*scale, bottom: 7*scale, trailing: 10*scale)
        button.configuration = config
        button.configurationUpdateHandler = { [focusAccent, scale] control in
            var appearance = config
            if control.isFocused {
                appearance.background.strokeColor = focusAccent
                appearance.background.strokeWidth = 3 * scale
                appearance.background.strokeOutset = 2 * scale
            }
            control.alpha = control.isEnabled ? 1 : 0.45
            control.configuration = appearance
        }
        if let action { button.addAction(UIAction { _ in action() }, for: .primaryActionTriggered) }
        return button
    }

    private func photo(_ url: URL?) -> UIImageView {
        let view = UIImageView()
        view.contentMode = .scaleAspectFit
        view.clipsToBounds = true
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if let url, let task = loadPhoto(url, in: view) { media.append(task) }
        return view
    }

    private func loadPhoto(_ url: URL, in view: UIImageView) -> Task<Void, Never>? {
        if let existing = cache.object(forKey: url as NSURL) { view.image = existing; return nil }
        return Task { [weak self, weak view, imageLoader] in
            guard let cg = try? await imageLoader(url), !Task.isCancelled else { return }
            let loaded = UIImage(cgImage: cg)
            self?.cache.setObject(loaded, forKey: url as NSURL, cost: cg.bytesPerRow * cg.height)
            view?.image = loaded
        }
    }

    private func selectedImageView() -> UIImageView {
        let image = UIImageView()
        image.contentMode = .scaleAspectFit
        image.clipsToBounds = true
        image.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        productPhoto.display(variant, in: image)
        return image
    }

    private func hero(_ height: CGFloat, opensViewer: Bool = false) {
        let photos = opensViewer ? gallery : []
        let title = text("View full size", "Ver en grande", "Ver em tela cheia")
        guard productPhoto.hasPhoto(for: variant) else {
            if !photos.isEmpty {
                let action = button(title) { [weak self] in self?.openViewer(photos) }
                action.accessibilityLabel = title
                photoButton = action
                body.addArrangedSubview(action)
            }
            return
        }
        let image = selectedImageView()
        image.backgroundColor = UIColor(white: 0.14, alpha: 1)
        image.layer.cornerRadius = 10 * scale
        image.heightAnchor.constraint(equalToConstant: height * scale).isActive = true
        body.addArrangedSubview(image)
        guard !photos.isEmpty else { return }
        sheetPhoto = image
        let action = button("", fill: .clear) { [weak self] in self?.openViewer(photos) }
        action.accessibilityLabel = title
        photoButton = action
        image.isUserInteractionEnabled = true
        image.addSubview(action)
        action.translatesAutoresizingMaskIntoConstraints = false
        let badge = UIStackView(arrangedSubviews: [label(title, 15, bold: true)])
        badge.isUserInteractionEnabled = false
        badge.isLayoutMarginsRelativeArrangement = true
        badge.directionalLayoutMargins = .init(top: 5 * scale, leading: 12 * scale, bottom: 5 * scale, trailing: 12 * scale)
        badge.backgroundColor = UIColor(white: 0.12, alpha: 0.94)
        badge.layer.cornerRadius = 10 * scale
        badge.translatesAutoresizingMaskIntoConstraints = false
        action.addSubview(badge)
        // Leave the focused button's outer stroke inside the rounded image.
        let focusInset = 4 * scale
        NSLayoutConstraint.activate([
            action.leadingAnchor.constraint(equalTo: image.leadingAnchor, constant: focusInset),
            action.trailingAnchor.constraint(equalTo: image.trailingAnchor, constant: -focusInset),
            action.topAnchor.constraint(equalTo: image.topAnchor, constant: focusInset),
            action.bottomAnchor.constraint(equalTo: image.bottomAnchor, constant: -focusInset),
            badge.trailingAnchor.constraint(equalTo: action.trailingAnchor, constant: -8 * scale),
            badge.bottomAnchor.constraint(equalTo: action.bottomAnchor, constant: -8 * scale)
        ])
    }

    private func openViewer(_ photos: [URL?]) {
        guard viewer == nil, !photos.isEmpty else { return }
        subviews.forEach { $0.isHidden = true }
        let viewer = TVProductPhotoViewer(count: photos.count, initialIndex: photos.firstIndex(of: selectedPhoto) ?? 0,
                                          title: offer.title, price: price, scale: scale, localize: text,
                                          makeButton: { self.button($0, fill: UIColor(white: 0.19, alpha: 1), symbol: $1) },
                                          showImage: { [weak self] index in
            guard let self else { return UIImageView() }
            self.galleryLoad?.cancel()
            let url = photos[index]
            if url == self.selectedPhoto { return self.selectedImageView() }
            let image = UIImageView()
            if let url { self.galleryLoad = self.loadPhoto(url, in: image) }
            else { image.image = self.fallback }
            return image
        }, close: { [weak self] in self?.closeDetails() })
        self.viewer = viewer
        addSubview(viewer)
        updatePresentation()
    }

    private func render() {
        media.forEach { $0.cancel() }
        media.removeAll()
        rails.removeAll()
        subviews.forEach { $0.removeFromSuperview() }
        focus = nil
        accessibilityViewIsModal = stage != .entry
        backgroundColor = stage == .entry ? .clear : background
        if stage == .entry {
            let trigger = button(midroll ? text("Buy", "Comprar", "Comprar") : text("View product", "Ver producto", "Ver produto"),
                                 fill: .white) { [weak self] in
                self?.go(.cover)
                self?.onOpen()
            }
            addSubview(trigger)
            focus = trigger
            return
        }
        scroll = UIScrollView()
        body = UIStackView()
        header = UIStackView()
        footer = UIStackView()
        body.axis = .vertical
        body.spacing = 11 * scale
        footer.axis = .vertical
        footer.spacing = 8 * scale
        header.spacing = 10 * scale
        header.alignment = .center
        addSubview(header)
        scroll.addSubview(body)
        addSubview(scroll)
        addSubview(footer)
        let heading: String
        switch stage {
        case .cart: heading = text("Shopping cart", "Carrito de compras", "Carrinho de compras")
        case .qr: heading = "Shopify"
        case .details: heading = offer.title
        default: heading = ""
        }
        if !heading.isEmpty {
            let title = label(heading, 19, bold: true)
            title.numberOfLines = 1
            header.addArrangedSubview(title)
        }
        if let logo = brand?.logoURL {
            let view = photo(logo)
            view.widthAnchor.constraint(equalToConstant: 54 * scale).isActive = true
            view.heightAnchor.constraint(equalToConstant: 30 * scale).isActive = true
            header.addArrangedSubview(view)
        }
        header.addArrangedSubview(UIView())
        let back = button("‹", fill: .clear, outlined: true) { [weak self] in self?.closeDetails() }
        back.accessibilityLabel = text("Back", "Atrás", "Voltar")
        header.addArrangedSubview(back)
        focus = back
        switch stage {
        case .cover:
            hero(196, opensViewer: true)
            if let vendor = offer.vendor, !vendor.isEmpty {
                let label = label(vendor, 15, bold: true)
                label.textColor = UIColor(white: 0.73, alpha: 1)
                body.addArrangedSubview(label)
            }
            let title = label(offer.title, 30, bold: true)
            title.numberOfLines = 2
            body.addArrangedSubview(title)
            let available = offer.variants.filter(\.available)
            let minimum = available.map(\.price).min() ?? variant.price
            let from = available.contains { $0.price > minimum }
            let previous = offer.previousPrice(for: variant)
            let sameDiscount = !from && available.allSatisfy { offer.previousPrice(for: $0) == previous }
            addPrice(minimum, from: from, previous: sameDiscount ? previous : nil)
            if let description = offer.description {
                let caption = label(description, 16)
                caption.numberOfLines = 3
                body.addArrangedSubview(caption)
            }
            if available.count > 1 {
                let dimensions = offer.optionNames.compactMap { name -> String? in
                    let values = Set(available.compactMap { $0.options.first { $0.name == name }?.value })
                    return values.count > 1 ? "\(name) (\(values.count))" : nil
                }
                let summary = dimensions.isEmpty ? "\(available.count) " + text("variants", "variantes", "variantes") : dimensions.joined(separator: " · ")
                let caption = label(summary, 14)
                caption.numberOfLines = 2
                caption.textColor = UIColor(white: 0.73, alpha: 1)
                body.addArrangedSubview(caption)
            }
            let titleCTA = available.count > 1 ? text("Choose options", "Elegir opciones", "Escolher opções")
                : text("View details", "Ver detalles", "Ver detalhes")
            primary(titleCTA) { [weak self] in self?.go(.details) }
        case .details:
            hero(134, opensViewer: true)
            addPrice(variant.price, previous: offer.previousPrice(for: variant))
            if let description = offer.description {
                let caption = label(description, 15)
                caption.numberOfLines = 3
                body.addArrangedSubview(caption)
            }
            let names: [String?] = offer.optionNames.isEmpty ? [nil] : offer.optionNames.map(Optional.some)
            for name in names {
                body.addArrangedSubview(label(name ?? text("Variant", "Variante", "Variante"), 16, bold: true))
                let rail = TVOptionRail(choices: offer.choices(for: name, selected: selection), ink: ink, accent: focusAccent, scale: scale) { [weak self] index in
                    guard let self else { return }
                    self.selection = index
                    self.render()
                    self.focus = self.rails[names.firstIndex(of: name) ?? 0]
                    if let target = self.focus, let system = UIFocusSystem.focusSystem(for: self) {
                        system.requestFocusUpdate(to: target)
                        system.updateFocusIfNeeded()
                    }
                }
                rails.append(rail)
                body.addArrangedSubview(rail)
            }
            primary(text("Add to cart", "Agregar al carrito", "Adicionar ao carrinho"), enabled: variant.available) { [weak self] in self?.go(.cart) }
            if let rail = rails.first { focus = rail }
        case .cart:
            let row = UIStackView()
            row.spacing = 10 * scale
            row.alignment = .center
            if productPhoto.hasPhoto(for: variant) {
                let thumb = selectedImageView()
                thumb.widthAnchor.constraint(equalToConstant: 65 * scale).isActive = true
                thumb.heightAnchor.constraint(equalToConstant: 60 * scale).isActive = true
                row.addArrangedSubview(thumb)
            }
            let lines = UIStackView(arrangedSubviews: [label(offer.title, 17, bold: true), label(selectionSummary, 15)])
            lines.axis = .vertical
            row.addArrangedSubview(lines)
            row.addArrangedSubview(label(text("1 unit", "1 unidad", "1 unidade"), 13))
            body.addArrangedSubview(rule())
            body.addArrangedSubview(row)
            body.addArrangedSubview(rule())
            let total = UIStackView(arrangedSubviews: [label("Total", 21, bold: true), UIView(), label(price, 21, bold: true)])
            footer.addArrangedSubview(rule())
            footer.addArrangedSubview(total)
            primary(text("Continue to QR", "Continuar con el QR", "Continuar para o QR")) { [weak self] in self?.startCheckout() }
        case .qr:
            hero(135)
            body.addArrangedSubview(label(offer.title, 18, bold: true))
            body.addArrangedSubview(label(price + "   " + selectionSummary, 16))
            if let qr {
                let image = UIImageView(image: qr)
                image.contentMode = .scaleAspectFit
                image.layer.magnificationFilter = .nearest
                image.heightAnchor.constraint(equalToConstant: 176 * scale).isActive = true
                image.isAccessibilityElement = true
                image.accessibilityLabel = text("Checkout QR code", "Código QR de compra", "Código QR de compra")
                footer.addArrangedSubview(image)
                footer.addArrangedSubview(label(text("Scan to pay on Shopify", "Escaneá para pagar en Shopify", "Escaneie para pagar na Shopify"), 16))
            } else if failed {
                body.addArrangedSubview(label(text("Could not prepare your cart", "No se pudo preparar el carrito", "Não foi possível preparar o carrinho"), 16))
                primary(text("Retry", "Reintentar", "Tentar novamente")) { [weak self] in self?.startCheckout() }
            } else {
                body.addArrangedSubview(label(text("Preparing your cart…", "Preparando tu carrito…", "Preparando seu carrinho…"), 16))
            }
        case .entry: break
        }
        setNeedsLayout()
        setNeedsFocusUpdate()
    }

    private func addPrice(_ value: Decimal, from: Bool = false, previous: Decimal?) {
        let amount = money.string(from: NSDecimalNumber(decimal: value)) ?? value.description
        let prefix = from ? text("From", "Desde", "A partir de") + " " : ""
        let row = UIStackView(arrangedSubviews: [label(prefix + amount, 23, bold: true)])
        row.alignment = .firstBaseline
        row.spacing = 10 * scale
        if let previous, let formatted = money.string(from: NSDecimalNumber(decimal: previous)) {
            let old = label(formatted, 15)
            old.attributedText = NSAttributedString(string: formatted, attributes: [.strikethroughStyle: NSUnderlineStyle.single.rawValue])
            old.textColor = UIColor(white: 0.71, alpha: 1)
            row.addArrangedSubview(old)
        }
        row.addArrangedSubview(UIView())
        body.addArrangedSubview(row)
    }

    private func rule() -> UIView {
        let line = UIView()
        line.backgroundColor = ink.withAlphaComponent(0.65)
        line.heightAnchor.constraint(equalToConstant: scale).isActive = true
        return line
    }

    private func primary(_ title: String, enabled: Bool = true, _ handler: @escaping () -> Void) {
        let control = button(title, fill: .white, action: handler)
        control.isEnabled = enabled
        control.heightAnchor.constraint(equalToConstant: 48 * scale).isActive = true
        footer.addArrangedSubview(control)
        if enabled { focus = control }
    }

    private func startCheckout() {
        guard variant.available else { return }
        go(.qr)
        let id = variant.id
        checkout = Task { [weak self, offer, handoff] in
            do {
                let destination = try await handoff.prepare(offer, variant: id)
                guard let address = destination.qr else { throw URLError(.badURL) }
                let image = try await handoff.qr(address)
                try Task.checkCancellation()
                self?.qr = UIImage(cgImage: image)
            } catch {
                guard !Task.isCancelled else { return }
                self?.failed = true
            }
            self?.checkout = nil
            self?.render()
        }
    }
}

@MainActor
private final class TVOptionRail: UICollectionView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
    private let choices: [OverlayCommerce.Choice]
    private let ink: UIColor
    private let accent: UIColor
    private let scale: CGFloat
    private let choose: (Int) -> Void
    private var initialScroll = true

    init(choices: [OverlayCommerce.Choice], ink: UIColor, accent: UIColor, scale: CGFloat, choose: @escaping (Int) -> Void) {
        self.choices = choices
        self.ink = ink
        self.accent = accent
        self.scale = scale
        self.choose = choose
        let layout = UICollectionViewFlowLayout()
        layout.scrollDirection = .horizontal
        layout.minimumLineSpacing = 6 * scale
        super.init(frame: .zero, collectionViewLayout: layout)
        dataSource = self
        delegate = self
        backgroundColor = .clear
        showsHorizontalScrollIndicator = true
        register(UICollectionViewCell.self, forCellWithReuseIdentifier: "option")
        heightAnchor.constraint(equalToConstant: 50 * scale).isActive = true
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        if initialScroll, bounds.width > 0, let selected = choices.firstIndex(where: \.selected) {
            initialScroll = false
            scrollToItem(at: IndexPath(item: selected, section: 0), at: .centeredHorizontally, animated: false)
        }
    }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { choices.count }
    func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, sizeForItemAt path: IndexPath) -> CGSize {
        let estimated = (choices[path.item].label as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: 15 * scale)]).width
        return CGSize(width: min(max(1, bounds.width), max(42 * scale, ceil(estimated) + 23 * scale)), height: 38 * scale)
    }
    func collectionView(_ collectionView: UICollectionView, cellForItemAt path: IndexPath) -> UICollectionViewCell {
        let cell = dequeueReusableCell(withReuseIdentifier: "option", for: path)
        let choice = choices[path.item]
        let label = cell.contentView.subviews.first as? UILabel ?? UILabel()
        label.frame = cell.contentView.bounds
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        label.textAlignment = .center
        label.font = .systemFont(ofSize: 15 * scale, weight: .medium)
        label.text = choice.label
        if label.superview == nil { cell.contentView.addSubview(label) }
        cell.isAccessibilityElement = true
        cell.accessibilityLabel = choice.label
        cell.accessibilityTraits = [.button]
        if choice.selected { cell.accessibilityTraits.insert(.selected) }
        if choice.index == nil { cell.accessibilityTraits.insert(.notEnabled) }
        cell.configurationUpdateHandler = { [ink, accent, scale] view, state in
            view.contentView.backgroundColor = state.isFocused ? ink : (choice.selected ? ink.withAlphaComponent(0.28) : .clear)
            label.textColor = state.isFocused ? CommercePanel.readable(.black, on: ink, backdrop: .black) : ink
            view.layer.borderWidth = (state.isFocused ? 3 : 1) * scale
            view.clipsToBounds = true
            view.layer.cornerRadius = 10 * scale
            view.layer.borderColor = state.isFocused ? accent.cgColor : ink.withAlphaComponent(0.45).cgColor
            view.alpha = choice.index == nil ? 0.42 : 1
        }
        cell.setNeedsUpdateConfiguration()
        return cell
    }
    func collectionView(_ collectionView: UICollectionView, canFocusItemAt path: IndexPath) -> Bool { choices[path.item].index != nil }
    func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt path: IndexPath) -> Bool { choices[path.item].index != nil }
    func collectionView(_ collectionView: UICollectionView, didSelectItemAt path: IndexPath) {
        if let value = choices[path.item].index { choose(value) }
    }
    func indexPathForPreferredFocusedView(in collectionView: UICollectionView) -> IndexPath? {
        choices.firstIndex { $0.selected && $0.index != nil }.map { IndexPath(item: $0, section: 0) }
    }
}
#endif

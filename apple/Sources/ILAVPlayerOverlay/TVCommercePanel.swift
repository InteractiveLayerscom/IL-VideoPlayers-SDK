#if canImport(UIKit)
import UIKit

/// Used by tvOS. Each presentation stage stays in the host's video surface.
@MainActor
final class TVCommercePanel: UIView {
    private enum Stage { case entry, cover, details, gallery, cart, qr }
    private let offer: OverlayCommerce
    private let brand: SceneBrand?
    private let fallback: UIImage?
    private let mainPhoto: URL?
    private let imageLoader: (URL) async throws -> CGImage
    private let handoff: OverlayCheckout
    private let midroll: Bool
    private let onOpen: () -> Void
    private let onClose: (() -> Void)?
    private let background: UIColor
    private let ink: UIColor
    private let money = NumberFormatter()
    private var stage: Stage
    private var selection: Int
    private var galleryIndex = 0
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
    private var galleryBorder: UIView?
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
        mainPhoto = offer.imageURL ?? photoURL
        fallback = photo.map(UIImage.init(cgImage:))
        onClose = closed
        onOpen = opened
        stage = closed == nil ? .entry : .cover
        selection = offer.variants.firstIndex(where: \.available) ?? 0
        let base = UIColor.sceneColor(brand?.background) ?? UIColor(white: 0.12, alpha: 1)
        background = base.withAlphaComponent(min(0.92, base.cgColor.alpha))
        ink = CommercePanel.readable(UIColor.sceneColor(brand?.foreground) ?? .white, on: base, backdrop: .black)
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
    private var selectedPhoto: URL? { variant.imageURL ?? mainPhoto ?? offer.images.first }
    private var gallery: [URL?] {
        var seen = Set<URL>()
        let urls = ([mainPhoto].compactMap { $0 } + offer.images + [variant.imageURL].compactMap { $0 })
            .filter { seen.insert($0).inserted }
        return fallback != nil && mainPhoto == nil ? [nil] + urls.map(Optional.some) : urls.map(Optional.some)
    }

    func presentationFrame(in bounds: CGRect) -> CGRect {
        let unit = max(0.55, min(2.5, bounds.height / 640))
        if scale != unit { scale = unit; render() }
        switch stage {
        case .entry:
            let width = min(bounds.width * 0.85, 155 * unit), height = min(bounds.height, 48 * unit)
            return CGRect(x: bounds.maxX - width - bounds.width * 0.025, y: bounds.maxY - height - bounds.height * 0.07,
                          width: width, height: height)
        case .gallery: return bounds
        default:
            let ratio: CGFloat = stage == .details || stage == .qr ? 0.34 : 0.41
            let width = min(bounds.width, max(205 * unit, bounds.width * ratio))
            return CGRect(x: bounds.maxX - width, y: bounds.minY, width: width, height: bounds.height)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if stage == .entry { focus?.frame = bounds; return }
        let gallery = stage == .gallery
        galleryBorder?.frame = bounds.insetBy(dx: bounds.width * 0.04, dy: bounds.height * 0.04)
        let inset: CGFloat
        switch stage {
        case .cover, .cart: inset = bounds.width * 0.14
        case .gallery: inset = bounds.width * 0.065
        default: inset = min(bounds.width * 0.065, 26 * scale)
        }
        let top = gallery ? bounds.height * 0.065 : min(bounds.height * 0.045, 22 * scale)
        let width = max(1, bounds.width - 2 * inset)
        let head = min(44 * scale, bounds.height * 0.12)
        header.frame = CGRect(x: inset, y: top, width: width, height: head)
        let foot = footer.arrangedSubviews.isEmpty ? 0 : footer.systemLayoutSizeFitting(
            CGSize(width: width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel).height
        let bottom = stage == .cover ? bounds.height * 0.075 : top
        footer.frame = CGRect(x: inset, y: max(header.frame.maxY, bounds.height - bottom - foot), width: width, height: foot)
        let y = header.frame.maxY + 5 * scale
        scroll.frame = CGRect(x: inset, y: y, width: width, height: max(0, footer.frame.minY - y - 8 * scale))
        let height = body.systemLayoutSizeFitting(CGSize(width: width, height: 0), withHorizontalFittingPriority: .required,
                                                   verticalFittingPriority: .fittingSizeLevel).height
        let bodyTop = gallery ? max(0, (scroll.bounds.height - height) / 2) : 0
        body.frame = CGRect(x: 0, y: bodyTop, width: width, height: height)
        scroll.contentSize = CGSize(width: width, height: bodyTop + height)
    }

    override var preferredFocusEnvironments: [UIFocusEnvironment] { focus.map { [$0] } ?? super.preferredFocusEnvironments }

    #if os(tvOS)
    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if presses.contains(where: { $0.type == .menu }), closeDetails() { return }
        super.pressesEnded(presses, with: event)
    }
    #endif

    @discardableResult
    func closeDetails() -> Bool {
        switch stage {
        case .entry: return false
        case .cover: if let onClose { onClose() } else { go(.entry) }
        case .details: go(.cover)
        case .gallery, .cart: go(.details)
        case .qr: go(.cart)
        }
        return true
    }

    func dispose() {
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
        superview?.setNeedsLayout()
        superview?.layoutIfNeeded()
        if let focus, let system = UIFocusSystem.focusSystem(for: self) {
            system.requestFocusUpdate(to: focus)
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

    private func button(_ value: String, fill: UIColor = UIColor.black.withAlphaComponent(0.16), action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        var config = UIButton.Configuration.plain()
        config.title = value
        config.baseForegroundColor = CommercePanel.readable(ink, on: fill, backdrop: background)
        config.background.backgroundColor = fill
        config.background.strokeColor = ink.withAlphaComponent(0.82)
        config.background.strokeWidth = scale
        config.cornerStyle = .fixed
        config.background.cornerRadius = 5 * scale
        let font = UIFont.systemFont(ofSize: 16 * scale, weight: .semibold)
        config.titleTextAttributesTransformer = .init { var a = $0; a.font = font; return a }
        config.contentInsets = .init(top: 7*scale, leading: 10*scale, bottom: 7*scale, trailing: 10*scale)
        button.configuration = config
        let selected = UIColor.sceneColor(brand?.accent) ?? ink
        let selectedInk = CommercePanel.readable(background, on: selected, backdrop: .black)
        button.configurationUpdateHandler = { control in
            var appearance = config
            if control.isFocused {
                appearance.baseForegroundColor = selectedInk
                appearance.background.backgroundColor = selected
                appearance.background.strokeWidth = 3
            }
            control.alpha = control.isEnabled ? 1 : 0.45
            control.configuration = appearance
        }
        button.addAction(UIAction { _ in action() }, for: .primaryActionTriggered)
        return button
    }

    private func photo(_ url: URL?, fallback: UIImage? = nil) -> UIImageView {
        let view = UIImageView()
        view.contentMode = .scaleAspectFit
        view.clipsToBounds = true
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.image = fallback
        guard let url else { return view }
        if let existing = cache.object(forKey: url as NSURL) { view.image = existing; return view }
        media.append(Task { [weak self, weak view, imageLoader] in
            guard let cg = try? await imageLoader(url), !Task.isCancelled else { return }
            let loaded = UIImage(cgImage: cg)
            self?.cache.setObject(loaded, forKey: url as NSURL, cost: cg.bytesPerRow * cg.height)
            view?.image = loaded
        })
        return view
    }

    private func hero(_ height: CGFloat) {
        guard selectedPhoto != nil || fallback != nil else { return }
        let view = photo(selectedPhoto, fallback: fallback)
        view.heightAnchor.constraint(equalToConstant: height * scale).isActive = true
        body.addArrangedSubview(view)
    }

    private func render() {
        media.forEach { $0.cancel() }
        media.removeAll()
        rails.removeAll()
        subviews.forEach { $0.removeFromSuperview() }
        focus = nil
        accessibilityViewIsModal = stage != .entry
        backgroundColor = stage == .entry ? .clear : background
        galleryBorder = nil
        if stage == .gallery {
            let border = UIView()
            border.isUserInteractionEnabled = false
            border.layer.borderWidth = scale
            border.layer.cornerRadius = 14 * scale
            border.layer.borderColor = ink.cgColor
            addSubview(border)
            galleryBorder = border
        }
        if stage == .entry {
            let trigger = button(midroll ? text("Buy", "Comprar", "Comprar") : text("View product", "Ver producto", "Ver produto"),
                                 fill: UIColor.black.withAlphaComponent(0.8)) { [weak self] in
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
        let heading: String = stage == .cart || stage == .qr ? text("Shopping cart", "Carrito de compras", "Carrinho de compras") :
            (stage == .details ? offer.title : "")
        if !heading.isEmpty { header.addArrangedSubview(label(heading, 17, bold: true)) }
        if stage != .cover, let logo = brand?.logoURL {
            let view = photo(logo)
            view.widthAnchor.constraint(equalToConstant: 56 * scale).isActive = true
            view.heightAnchor.constraint(equalToConstant: 32 * scale).isActive = true
            header.addArrangedSubview(view)
        }
        header.addArrangedSubview(UIView())
        let back = button(stage == .gallery ? text("Exit", "Salir", "Sair") : "‹") { [weak self] in self?.closeDetails() }
        back.accessibilityLabel = stage == .gallery ? text("Exit", "Salir", "Sair") : text("Back", "Atrás", "Voltar")
        if stage == .gallery { header.insertArrangedSubview(back, at: 0) }
        else { header.addArrangedSubview(back) }
        focus = back
        switch stage {
        case .cover:
            if selectedPhoto != nil || fallback != nil {
                let space = UIView()
                let image = photo(selectedPhoto, fallback: fallback)
                image.translatesAutoresizingMaskIntoConstraints = false
                space.addSubview(image)
                NSLayoutConstraint.activate([space.heightAnchor.constraint(equalToConstant: 199 * scale),
                    image.widthAnchor.constraint(equalTo: space.widthAnchor),
                    image.heightAnchor.constraint(equalTo: space.heightAnchor, multiplier: 0.64),
                    image.centerXAnchor.constraint(equalTo: space.centerXAnchor), image.centerYAnchor.constraint(equalTo: space.centerYAnchor)])
                body.addArrangedSubview(space)
            }
            let title = UIStackView(arrangedSubviews: [label(offer.title, 23, bold: true)])
            title.alignment = .center
            if let logo = brand?.logoURL {
                let image = photo(logo)
                image.widthAnchor.constraint(equalToConstant: 54 * scale).isActive = true
                image.heightAnchor.constraint(equalToConstant: 35 * scale).isActive = true
                title.addArrangedSubview(image)
            }
            body.addArrangedSubview(title)
            body.addArrangedSubview(label(price, 25, bold: true))
            primary(text("Add product", "Añadir producto", "Adicionar produto")) { [weak self] in self?.go(.details) }
        case .details:
            if !gallery.isEmpty {
                let preview = UIView()
                preview.layer.borderWidth = scale
                preview.layer.borderColor = ink.withAlphaComponent(0.8).cgColor
                let image = photo(selectedPhoto, fallback: fallback)
                image.translatesAutoresizingMaskIntoConstraints = false
                preview.addSubview(image)
                let showPhotos = button(text("View photo gallery", "Ver galería de fotos", "Ver galeria de fotos")) { [weak self] in
                    guard let self else { return }
                    self.galleryIndex = self.gallery.firstIndex(of: self.selectedPhoto) ?? 0
                    self.go(.gallery)
                }
                showPhotos.translatesAutoresizingMaskIntoConstraints = false
                preview.addSubview(showPhotos)
                NSLayoutConstraint.activate([preview.heightAnchor.constraint(equalToConstant: 142 * scale),
                    image.centerXAnchor.constraint(equalTo: preview.centerXAnchor), image.centerYAnchor.constraint(equalTo: preview.centerYAnchor),
                    image.widthAnchor.constraint(equalTo: preview.widthAnchor, multiplier: 0.72),
                    image.heightAnchor.constraint(equalTo: preview.heightAnchor, multiplier: 0.8),
                    showPhotos.trailingAnchor.constraint(equalTo: preview.trailingAnchor), showPhotos.bottomAnchor.constraint(equalTo: preview.bottomAnchor),
                    showPhotos.widthAnchor.constraint(lessThanOrEqualTo: preview.widthAnchor)])
                body.addArrangedSubview(preview)
            }
            body.addArrangedSubview(label(price, 20, bold: true))
            if let description = offer.description { body.addArrangedSubview(label(description, 14)) }
            let names: [String?] = offer.optionNames.isEmpty ? [nil] : offer.optionNames.map(Optional.some)
            for name in names {
                body.addArrangedSubview(label(name ?? text("Variant", "Variante", "Variante"), 16, bold: true))
                let rail = TVOptionRail(choices: offer.choices(for: name, selected: selection), ink: ink, scale: scale) { [weak self] index in
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
            primary(text("Add to cart", "Añadir al carrito", "Adicionar ao carrinho"), enabled: variant.available) { [weak self] in self?.go(.cart) }
            if let rail = rails.first { focus = rail }
        case .gallery: renderGallery()
        case .cart:
            let row = UIStackView()
            row.spacing = 10 * scale
            row.alignment = .center
            let thumb = photo(selectedPhoto, fallback: fallback)
            thumb.widthAnchor.constraint(equalToConstant: 65 * scale).isActive = true
            thumb.heightAnchor.constraint(equalToConstant: 60 * scale).isActive = true
            row.addArrangedSubview(thumb)
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
            primary(text("Finish purchase", "Finalizar compra", "Finalizar compra")) { [weak self] in self?.startCheckout() }
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
                footer.addArrangedSubview(label(text("Scan to complete your purchase", "Escaneá y finalizá la compra", "Escaneie e finalize a compra"), 16))
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

    private func rule() -> UIView {
        let line = UIView()
        line.backgroundColor = ink.withAlphaComponent(0.65)
        line.heightAnchor.constraint(equalToConstant: scale).isActive = true
        return line
    }

    private func primary(_ title: String, enabled: Bool = true, _ handler: @escaping () -> Void) {
        let control = button(title, action: handler)
        control.isEnabled = enabled
        let row = UIView()
        control.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(control)
        NSLayoutConstraint.activate([control.heightAnchor.constraint(equalToConstant: 46 * scale),
            control.widthAnchor.constraint(equalTo: row.widthAnchor, multiplier: 0.8),
            control.centerXAnchor.constraint(equalTo: row.centerXAnchor), control.topAnchor.constraint(equalTo: row.topAnchor),
            control.bottomAnchor.constraint(equalTo: row.bottomAnchor)])
        footer.addArrangedSubview(row)
        if enabled { focus = control }
    }

    private func renderGallery() {
        let images = gallery
        guard images.indices.contains(galleryIndex) else { return }
        let strip = UIStackView()
        strip.spacing = 14 * scale
        strip.alignment = .center
        func arrow(_ direction: Int) -> UIButton {
            let move = button(direction < 0 ? "‹" : "›") { [weak self] in
                guard let self else { return }
                self.galleryIndex = (self.galleryIndex + direction + images.count) % images.count
                self.render()
                if let system = UIFocusSystem.focusSystem(for: self), let focus = self.focus {
                    system.requestFocusUpdate(to: focus)
                    system.updateFocusIfNeeded()
                }
            }
            move.accessibilityLabel = direction < 0 ? text("Previous photo", "Foto anterior", "Foto anterior") : text("Next photo", "Foto siguiente", "Próxima foto")
            move.widthAnchor.constraint(equalToConstant: 44 * scale).isActive = true
            return move
        }
        if images.count > 1 { strip.addArrangedSubview(arrow(-1)) }
        let center = photo(images[galleryIndex], fallback: images[galleryIndex] == nil ? fallback : nil)
        center.isAccessibilityElement = true
        center.accessibilityLabel = text("Photo", "Foto", "Foto") + " \(galleryIndex + 1)/\(images.count)"
        center.heightAnchor.constraint(equalToConstant: 305 * scale).isActive = true
        strip.addArrangedSubview(center)
        if images.count > 1 {
            let left = (galleryIndex - 1 + images.count) % images.count
            let right = (galleryIndex + 1) % images.count
            let previous = photo(images[left], fallback: images[left] == nil ? fallback : nil)
            let following = photo(images[right], fallback: images[right] == nil ? fallback : nil)
            strip.insertArrangedSubview(previous, at: 1)
            strip.addArrangedSubview(following)
            for view in [previous, following] {
                view.widthAnchor.constraint(equalTo: center.widthAnchor, multiplier: 0.65).isActive = true
                view.heightAnchor.constraint(equalTo: center.heightAnchor, multiplier: 0.7).isActive = true
            }
            let next = arrow(1)
            strip.addArrangedSubview(next)
            focus = next
        }
        body.addArrangedSubview(strip)
        footer.addArrangedSubview(label(offer.title, 22, bold: true))
        footer.addArrangedSubview(label(price, 18, bold: true))
        if let description = offer.description {
            let caption = label(description, 14)
            caption.numberOfLines = 2
            footer.addArrangedSubview(caption)
        }
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
    private let scale: CGFloat
    private let choose: (Int) -> Void
    private var initialScroll = true

    init(choices: [OverlayCommerce.Choice], ink: UIColor, scale: CGFloat, choose: @escaping (Int) -> Void) {
        self.choices = choices
        self.ink = ink
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
        cell.configurationUpdateHandler = { [ink, scale] view, state in
            view.contentView.backgroundColor = state.isFocused ? ink : (choice.selected ? ink.withAlphaComponent(0.28) : .clear)
            label.textColor = state.isFocused ? CommercePanel.readable(.black, on: ink, backdrop: .black) : ink
            view.layer.borderWidth = (state.isFocused ? 3 : 1) * scale
            view.layer.borderColor = ink.cgColor
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

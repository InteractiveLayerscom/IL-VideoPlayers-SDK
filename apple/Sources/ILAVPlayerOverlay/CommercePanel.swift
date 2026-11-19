#if canImport(UIKit)
import UIKit

@MainActor
final class CommercePanel: UIView {
    private let offer: OverlayCommerce
    private let labels: [String]
    private let didOpen: () -> Void
    private let onCheckoutURL: ((URL) -> Void)?
    private let money = NumberFormatter()
    private let stack = UIStackView()
    private let details = UIStackView()
    private let open = UIButton(type: .system)
    private let change = UIButton(type: .system)
    private let checkout = UIButton(type: .system)
    private let price = UILabel()
    private let status = UILabel()
    private let qr = UIImageView()
    private var selection = 0
    private var task: Task<Void, Never>?
    private var expanded = false

    init(_ offer: OverlayCommerce, photo: CGImage, checkoutURL: ((URL) -> Void)?, opened: @escaping () -> Void) {
        self.offer = offer
        labels = Self.copy(offer.locale)
        didOpen = opened
        onCheckoutURL = checkoutURL
        super.init(frame: .zero)
        backgroundColor = UIColor(red: 0.063, green: 0.098, blue: 0.161, alpha: 0.95)
        layer.cornerRadius = 10
        layer.zPosition = 2
        money.numberStyle = .currency
        money.locale = Locale(identifier: offer.locale)
        money.currencyCode = offer.currency
        stack.axis = .vertical
        stack.alignment = .trailing
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
        ])
        configure(open, text: labels[0]) { [weak self] in self?.openDetails() }
        stack.addArrangedSubview(open)

        details.axis = .vertical
        details.alignment = .trailing
        details.spacing = 3
        details.isHidden = true
        stack.addArrangedSubview(details)
        let name = UILabel()
        name.text = offer.title
        name.textColor = .white
        name.numberOfLines = 2
        let product = UIImageView(image: UIImage(cgImage: photo))
        product.contentMode = .scaleAspectFit
        product.widthAnchor.constraint(equalToConstant: 65).isActive = true
        product.heightAnchor.constraint(equalToConstant: 65).isActive = true
        let summary = UIStackView(arrangedSubviews: [product, name])
        summary.alignment = .center
        summary.spacing = 8
        details.addArrangedSubview(summary)
        details.addArrangedSubview(price)
        price.textColor = .white

        configure(change, text: "") { [weak self] in
            guard let self else { return }
            self.select((self.selection + 1) % self.offer.variants.count)
        }
        change.isHidden = offer.variants.count < 2
        details.addArrangedSubview(change)
        #if os(tvOS)
        let buy = labels[1]
        #else
        let buy = labels[2]
        #endif
        configure(checkout, text: buy) { [weak self] in self?.buy() }
        details.addArrangedSubview(checkout)
        let close = UIButton(type: .system)
        configure(close, text: labels[4]) { [weak self] in _ = self?.closeDetails() }
        details.addArrangedSubview(close)
        status.numberOfLines = 2
        status.textColor = .white
        status.isHidden = true
        details.addArrangedSubview(status)
        qr.widthAnchor.constraint(equalToConstant: 135).isActive = true
        // A lowered priority avoids a conflict with UIStackView's zero height while hidden.
        let qrHeight = qr.heightAnchor.constraint(equalToConstant: 135)
        qrHeight.priority = .defaultHigh
        qrHeight.isActive = true
        qr.contentMode = .scaleAspectFit
        qr.accessibilityLabel = labels[3]
        qr.isAccessibilityElement = true
        qr.isHidden = true
        details.addArrangedSubview(qr)
        select(0)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var preferredFocusEnvironments: [UIFocusEnvironment] {
        [expanded ? (change.isHidden ? checkout : change) : open]
    }

    #if os(tvOS)
    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if presses.contains(where: { $0.type == .menu }), closeDetails() { return }
        super.pressesEnded(presses, with: event)
    }
    #endif

    private func configure(_ button: UIButton, text: String, action: @escaping () -> Void) {
        var config = UIButton.Configuration.filled()
        config.title = text
        config.baseBackgroundColor = UIColor(red: 0.125, green: 0.173, blue: 0.259, alpha: 1)
        config.baseForegroundColor = .white
        button.configuration = config
        button.addAction(UIAction { _ in action() }, for: .primaryActionTriggered)
    }

    private func select(_ index: Int) {
        cancel()
        selection = index
        let variant = offer.variants[index]
        change.configuration?.title = variant.label + "  ›"
        change.accessibilityLabel = labels[7] + " " + variant.label
        let amount = money.string(from: NSDecimalNumber(decimal: variant.price)) ?? variant.price.description
        price.text = "\(variant.label) · \(amount)"
        updateLayout()
    }

    private func openDetails() {
        expanded = true
        details.isHidden = false
        open.isHidden = true
        didOpen()
        updateLayout()
        setNeedsFocusUpdate()
    }

    @discardableResult
    func closeDetails() -> Bool {
        guard expanded else { return false }
        cancel()
        expanded = false
        details.isHidden = true
        open.isHidden = false
        updateLayout()
        setNeedsFocusUpdate()
        return true
    }

    func dispose() {
        cancel()
        removeFromSuperview()
    }

    private func cancel() {
        task?.cancel()
        task = nil
        checkout.isEnabled = true
        status.isHidden = true
        qr.isHidden = true
        qr.image = nil
    }

    private func buy() {
        guard task == nil else { return }
        let variant = offer.variants[selection].id
        checkout.isEnabled = false
        showStatus(labels[5])
        task = Task { [weak self, offer] in
            do {
                let handoff = try await OverlayCheckout.prepare(offer, variant: variant)
                #if os(tvOS)
                guard let qrURL = handoff.qr else { throw URLError(.badURL) }
                let image = try await OverlayCheckout.qr(qrURL)
                try Task.checkCancellation()
                self?.qr.image = UIImage(cgImage: image)
                self?.qr.isHidden = false
                if let self { self.showStatus(self.labels[3]) }
                #else
                try Task.checkCancellation()
                guard let self else { return }
                if let open = self.onCheckoutURL {
                    open(handoff.url)
                } else {
                    guard await UIApplication.shared.open(handoff.url) else { throw URLError(.cannotOpenFile) }
                }
                self.status.isHidden = true
                self.updateLayout()
                #endif
            } catch {
                guard !Task.isCancelled, let self else { return }
                self.showStatus(self.labels[6])
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
    }

    private func updateLayout() { superview?.setNeedsLayout() }

    private static func copy(_ locale: String) -> [String] {
        switch locale {
        case "es":
            return ["Ver producto", "Mostrar código QR", "Comprar", "Escaneá el código con tu celular",
                    "Cerrar", "Preparando tu carrito…", "No se pudo preparar el carrito. Intentá de nuevo.", "Cambiar variante"]
        case "pt-BR":
            return ["Ver produto", "Mostrar código QR", "Comprar", "Escaneie com seu celular",
                    "Fechar", "Preparando seu carrinho…", "Não foi possível preparar o carrinho. Tente novamente.", "Alterar variante"]
        default:
            return ["View product", "Show QR code", "Buy", "Scan with your phone", "Close",
                    "Preparing your cart…", "Could not prepare the cart. Try again.", "Change variant"]
        }
    }
}
#endif

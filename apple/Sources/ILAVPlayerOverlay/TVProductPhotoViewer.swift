#if canImport(UIKit)
import UIKit

@MainActor
final class TVProductPhotoViewer: UIView {
    private let count: Int
    private let photoLabel: String
    private let showImage: (Int) -> UIImageView
    private var index: Int
    private var image: UIImageView?
    private let back: UIButton
    private let previousButton: UIButton
    private let nextButton: UIButton
    private let caption = UIStackView()
    private let position = UILabel()

    init(count: Int, initialIndex: Int, title: String, price: String, scale: CGFloat,
         localize: (String, String, String) -> String, makeButton: (String, String?) -> UIButton,
         showImage: @escaping (Int) -> UIImageView, close: @escaping () -> Void) {
        self.count = count
        index = initialIndex
        photoLabel = localize("Photo", "Foto", "Foto")
        self.showImage = showImage
        back = makeButton(localize("Back", "Atrás", "Voltar"), nil)
        previousButton = makeButton("", "chevron.left")
        nextButton = makeButton("", "chevron.right")
        super.init(frame: .zero)
        backgroundColor = UIColor(white: 0.045, alpha: 1)
        accessibilityViewIsModal = true
        let surface = UIColor(white: 0.13, alpha: 1)
        let name = UILabel()
        name.text = title + "  ·  " + price
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.font = .systemFont(ofSize: 18 * scale, weight: .semibold)
        name.textColor = .white
        position.font = .monospacedDigitSystemFont(ofSize: 17 * scale, weight: .semibold)
        position.textColor = .white
        caption.backgroundColor = surface
        caption.layer.cornerRadius = 14 * scale
        caption.alignment = .center
        caption.isLayoutMarginsRelativeArrangement = true
        caption.directionalLayoutMargins = .init(top: 8 * scale, leading: 15 * scale, bottom: 8 * scale, trailing: 15 * scale)
        caption.spacing = 18 * scale
        caption.addArrangedSubview(name)
        caption.addArrangedSubview(position)
        addSubview(caption)
        addSubview(back)
        back.addAction(UIAction { _ in close() }, for: .primaryActionTriggered)
        if count > 1 {
            previousButton.accessibilityLabel = localize("Previous photo", "Foto anterior", "Foto anterior")
            nextButton.accessibilityLabel = localize("Next photo", "Foto siguiente", "Próxima foto")
            for (control, step) in [(previousButton, -1), (nextButton, 1)] {
                addSubview(control)
                control.addAction(UIAction { [weak self] _ in self?.move(step) }, for: .primaryActionTriggered)
            }
            #if os(tvOS)
            for (direction, press, action) in [(UISwipeGestureRecognizer.Direction.left, UIPress.PressType.rightArrow, #selector(advance)),
                                               (.right, .leftArrow, #selector(rewind))] {
                let swipe = UISwipeGestureRecognizer(target: self, action: action)
                swipe.direction = direction
                addGestureRecognizer(swipe)
                let arrow = UITapGestureRecognizer(target: self, action: action)
                arrow.allowedPressTypes = [NSNumber(value: press.rawValue)]
                arrow.allowedTouchTypes = []
                addGestureRecognizer(arrow)
            }
            #endif
        }
        display()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var preferredFocusEnvironments: [UIFocusEnvironment] { [count > 1 ? nextButton : back] }

    override func layoutSubviews() {
        super.layoutSubviews()
        let insetX = bounds.width * 0.045, insetY = bounds.height * 0.04
        image?.frame = bounds.insetBy(dx: insetX, dy: insetY)
        let scale = max(0.55, min(2.5, bounds.height / 640))
        let safe = bounds.inset(by: safeAreaInsets).intersection(bounds.insetBy(dx: insetX, dy: insetY))
        let h = min(46 * scale, safe.height / 5)
        let backWidth = min(safe.width, max(84 * scale, back.sizeThatFits(safe.size).width + 16 * scale))
        back.frame = CGRect(x: safe.maxX - backWidth, y: safe.minY, width: backWidth, height: h)
        previousButton.frame = CGRect(x: safe.minX, y: safe.midY - h / 2, width: h, height: h)
        nextButton.frame = CGRect(x: safe.maxX - h, y: safe.midY - h / 2, width: h, height: h)
        let measured = caption.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
        let w = min(safe.width, measured.width)
        caption.frame = CGRect(x: safe.midX - w / 2, y: safe.maxY - measured.height, width: w, height: measured.height)
    }

    @objc private func advance() { move(1) }
    @objc private func rewind() { move(-1) }

    private func move(_ step: Int) {
        index = (index + step + count) % count
        display()
    }

    private func display() {
        image?.removeFromSuperview()
        let view = showImage(index)
        view.contentMode = .scaleAspectFit
        view.isAccessibilityElement = true
        view.accessibilityLabel = "\(photoLabel) \(index + 1)/\(count)"
        image = view
        insertSubview(view, at: 0)
        position.text = "\(index + 1) / \(count)"
        setNeedsLayout()
    }
}
#endif

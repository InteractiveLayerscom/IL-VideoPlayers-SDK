#if canImport(UIKit)
import AVFoundation
import UIKit

@MainActor
final class SceneSurface: UIView {
    private let cue: OverlayCue
    private let scene: OverlayScene
    private let maskLayer = CAShapeLayer()
    private var entries: [Entry] = []
    private var jobs: [Task<Void, Never>] = []
    private(set) var artworkVisible = false

    init(cue: OverlayCue, scene: OverlayScene, allowsVideo: Bool, allowsAudio: Bool,
         buy: ((SceneOffer, UIButton) -> Void)?, link: ((URL) -> Void)?) {
        self.cue = cue
        self.scene = scene
        super.init(frame: .zero)
        clipsToBounds = true
        if cue.format == .l { layer.mask = maskLayer }

        for design in scene.layers {
            let offer = cue.offer(at: design.productIndex)
            let entry = Entry(design)
            entries.append(entry)
            addSubview(entry.view)
            if ["image", "video"].contains(design.type) || design.binding == "image" {
                let media = UIView()
                media.clipsToBounds = true
                entry.media = media
                entry.view.addSubview(media)
                let image = UIImageView()
                image.contentMode = design.fit == "contain" ? .scaleAspectFit :
                    design.fit == "fill" ? .scaleToFill : .scaleAspectFill
                image.clipsToBounds = true
                if let alt = design.alt, !alt.isEmpty {
                    image.isAccessibilityElement = true
                    image.accessibilityLabel = alt
                }
                entry.image = image
                media.addSubview(image)
                let url = design.binding == "image" ? offer?.imageURL : design.mediaURL
                if let url {
                    jobs.append(Task { [weak image] in
                        guard let bitmap = try? await OverlayArtwork.loadSceneImage(url), !Task.isCancelled else { return }
                        image?.image = UIImage(cgImage: bitmap)
                    })
                }
                if design.type == "video", allowsVideo, let src = OverlayCue.httpsURL(design.src) {
                    entry.video = SceneVideo(src, fit: design.fit, audio: allowsAudio && design.audio == true)
                    if let layer = entry.video?.layer { media.layer.addSublayer(layer) }
                }
            } else if design.type == "text" {
                let label = UILabel()
                label.text = design.binding == "title" ? offer?.commerce.title :
                    design.binding == "price" ? offer?.price : design.text
                label.textColor = UIColor.sceneColor(design.fill) ?? .white
                label.numberOfLines = max(0, design.maxLines ?? 0)
                label.lineBreakMode = label.numberOfLines > 0 ? .byTruncatingTail : .byClipping
                switch design.textAlign {
                case "center": label.textAlignment = .center
                case "right": label.textAlignment = .right
                default: label.textAlignment = .left
                }
                entry.text = label
                entry.drawn = label.text?.isEmpty == false
                entry.view.addSubview(label)
            } else if design.type == "line" {
                let line = CAShapeLayer()
                let color = UIColor.sceneColor(design.stroke ?? design.fill) ?? .white
                line.strokeColor = color.cgColor
                line.fillColor = color.cgColor
                entry.view.layer.addSublayer(line)
                entry.line = line
                entry.drawn = color.cgColor.alpha > 0
            } else {
                let fill = UIColor.sceneColor(design.fill)
                entry.view.backgroundColor = fill ?? .clear
                if let gradient = design.gradient, let start = UIColor.sceneColor(gradient.from),
                   let end = UIColor.sceneColor(gradient.to) {
                    let layer = CAGradientLayer()
                    layer.colors = [start.cgColor, end.cgColor]
                    entry.view.layer.insertSublayer(layer, at: 0)
                    entry.gradient = layer
                }
                entry.drawn = (fill?.cgColor.alpha ?? 0) > 0 || entry.gradient != nil
            }
            entry.view.layer.borderColor = UIColor.sceneColor(design.stroke)?.cgColor
            entry.drawn = entry.drawn || ((design.strokeWidth ?? 0) > 0 &&
                (entry.view.layer.borderColor?.alpha ?? 0) > 0)

            if let offer, let buy, design.action == "product" || design.type == "product" {
                entry.button = action(label: offer.commerce.title) { button in buy(offer, button) }
            } else if design.action == "link", let link, let url = OverlayCue.httpsURL(design.url) {
                entry.button = action(label: design.alt ?? design.name ?? url.host ?? url.absoluteString) { _ in link(url) }
            }
            if let button = entry.button { entry.view.addSubview(button) }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private func action(label: String, activate: @escaping (UIButton) -> Void) -> UIButton {
        let button = UIButton(type: .custom)
        button.accessibilityLabel = label
        button.configuration = .plain()
        button.configurationUpdateHandler = { button in
            button.layer.borderColor = UIColor.cyan.cgColor
            button.layer.borderWidth = button.isFocused ? 2 : 0
        }
        button.addAction(UIAction { [weak button] _ in
            if let button { activate(button) }
        }, for: .primaryActionTriggered)
        return button
    }

    override var preferredFocusEnvironments: [UIFocusEnvironment] {
        if let first = entries.compactMap(\.button).first(where: { !$0.isHidden }) { return [first] }
        return super.preferredFocusEnvironments
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if cue.format == .l && point.x < bounds.width * 0.75 && point.y < bounds.height * 0.75 {
            return nil
        }
        return super.hitTest(point, with: event) as? UIButton
    }

    func update(at elapsed: Double, moving: Bool, visible: CGRect) {
        let time = min(scene.durationMs, max(0, elapsed))
        let sx = bounds.width / scene.width
        let sy = bounds.height / scene.height
        let corner = cue.format == .l
        let right = bounds.width * 0.75
        let bottom = bounds.height * 0.75
        let rightBand = CGRect(x: right, y: 0, width: bounds.width - right, height: bounds.height)
        let bottomBand = CGRect(x: 0, y: bottom, width: right, height: bounds.height - bottom)
        if corner {
            let path = CGMutablePath()
            path.addRect(rightBand)
            path.addRect(bottomBand)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            maskLayer.frame = bounds
            maskLayer.path = path
            CATransaction.commit()
        }
        artworkVisible = false
        for entry in entries {
            let item = entry.design
            let value = item.frame(at: time)
            let x = value.x * sx
            let y = value.y * sy
            let w = item.width * sx
            let h = item.height * sy
            let angle = value.rotation * .pi / 180
            entry.view.bounds = CGRect(x: 0, y: 0, width: w, height: h)
            entry.view.center = CGPoint(x: x + w / 2, y: y + h / 2)
            entry.view.transform = CGAffineTransform(rotationAngle: angle).scaledBy(x: value.scale, y: value.scale)
            entry.view.alpha = min(1, max(0, value.opacity))
            if entry.metricScale != sx || entry.metricHeight != sy {
                entry.metricScale = sx
                entry.metricHeight = sy
                setStyle(entry, width: w, height: h, scale: sx)
            }
            let frame = entry.view.frame.intersection(bounds)
            let inBand = !corner || frame.intersects(rightBand) || frame.intersects(bottomBand)
            let active = value.visible && inBand && !frame.isNull && !frame.isEmpty
            entry.view.isHidden = !active
            entry.button?.isHidden = !active
            entry.button?.frame = entry.view.bounds
            let mediaBounds = item.mediaFrame(in: entry.view.bounds)
            entry.image?.frame = mediaBounds
            if let media = entry.video {
                media.update(item, time: time, active: active, moving: moving, bounds: mediaBounds)
                entry.image?.isHidden = media.ready
            }
            let onScreen = frame.intersection(visible)
            let visibleBand = !corner || onScreen.intersects(rightBand) || onScreen.intersects(bottomBand)
            if active && visibleBand && !onScreen.isEmpty &&
                (entry.drawn || entry.image?.image != nil || entry.video?.ready == true) {
                artworkVisible = true
            }
        }
    }

    private func setStyle(_ entry: Entry, width w: CGFloat, height h: CGFloat, scale: CGFloat) {
        let item = entry.design
        let layer = entry.view.layer
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.borderWidth = item.type == "line" ? 0 : max(0, (item.strokeWidth ?? 0) * scale)
        let radius = item.mask == "rect" ? 0 : (item.radius ?? (item.mask == "rounded" ? 12 : 0))
        layer.cornerRadius = item.type == "ellipse" ? min(w, h) / 2 : min(w / 2, h / 2, radius * scale)
        entry.view.clipsToBounds = item.shadow == nil
        if let media = entry.media {
            media.frame = entry.view.bounds
            if item.mask == "ellipse" {
                let mask = CAShapeLayer()
                mask.frame = media.bounds
                mask.path = UIBezierPath(ovalIn: media.bounds).cgPath
                media.layer.mask = mask
            } else {
                media.layer.cornerRadius = layer.cornerRadius
            }
        }
        if let shadow = item.shadow, let color = UIColor.sceneColor(shadow.color) {
            layer.shadowColor = color.cgColor
            layer.shadowOpacity = 1
            layer.shadowOffset = CGSize(width: shadow.x * scale, height: shadow.y * scale)
            layer.shadowRadius = shadow.blur * scale
            layer.shadowPath = UIBezierPath(roundedRect: entry.view.bounds, cornerRadius: layer.cornerRadius).cgPath
        }
        if let gradient = entry.gradient, let angle = item.gradient?.angle, w > 0, h > 0 {
            let radians = (angle - 90) * .pi / 180
            let x = cos(radians), y = sin(radians)
            let distance = abs(x) * w / 2 + abs(y) * h / 2
            gradient.frame = entry.view.bounds
            gradient.cornerRadius = layer.cornerRadius
            gradient.startPoint = CGPoint(x: 0.5 - x * distance / w, y: 0.5 - y * distance / h)
            gradient.endPoint = CGPoint(x: 0.5 + x * distance / w, y: 0.5 + y * distance / h)
        }
        if let line = entry.line {
            let path = CGMutablePath()
            path.move(to: CGPoint(x: 0, y: h / 2))
            path.addLine(to: CGPoint(x: w, y: h / 2))
            if item.arrow == true {
                path.move(to: CGPoint(x: w * 0.9, y: 0))
                path.addLine(to: CGPoint(x: w, y: h / 2))
                path.addLine(to: CGPoint(x: w * 0.9, y: h))
                path.closeSubpath()
            }
            line.frame = entry.view.bounds
            line.lineWidth = max(1, (item.strokeWidth ?? 1) * scale)
            line.path = path
        }
        CATransaction.commit()
        if let text = entry.text, let title = text.text {
            let size = max(1, (item.fontSize ?? 24) * scale)
            let bold = (item.fontWeight ?? 400) >= 600
            var font = item.fontFamily.flatMap { UIFont(name: $0, size: size) } ??
                UIFont.systemFont(ofSize: size, weight: bold ? .bold : .regular)
            if item.fontStyle == "italic", let face = font.fontDescriptor.withSymbolicTraits(
                font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
                font = UIFont(descriptor: face, size: size)
            }
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = text.textAlignment
            paragraph.lineHeightMultiple = item.lineHeight ?? 1.1
            paragraph.lineBreakMode = text.lineBreakMode
            text.attributedText = NSAttributedString(string: title, attributes: [
                .font: font, .foregroundColor: text.textColor as Any,
                .paragraphStyle: paragraph, .kern: (item.letterSpacing ?? 0) * scale,
            ])
            let measured = text.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude))
            text.frame = CGRect(x: 0, y: 0, width: w, height: min(h, measured.height))
        }
    }

    func dispose() {
        for task in jobs { task.cancel() }
        for entry in entries { entry.video?.dispose() }
        removeFromSuperview()
    }

    @MainActor
    private final class Entry {
        let design: OverlayScene.Layer
        let view = UIView()
        var media: UIView?
        var text: UILabel?
        var image: UIImageView?
        var video: SceneVideo?
        var button: UIButton?
        var gradient: CAGradientLayer?
        var line: CAShapeLayer?
        var metricScale: CGFloat?
        var metricHeight: CGFloat?
        var drawn = false
        init(_ design: OverlayScene.Layer) { self.design = design }
    }

    @MainActor
    private final class SceneVideo {
        let layer: AVPlayerLayer
        private let player: AVPlayer
        private var seeking = false
        private var failed = false

        init(_ url: URL, fit: String?, audio: Bool) {
            player = AVPlayer(url: url)
            player.isMuted = !audio
            player.allowsExternalPlayback = false
            player.actionAtItemEnd = .pause
            layer = AVPlayerLayer(player: player)
            layer.videoGravity = fit == "contain" ? .resizeAspect : fit == "fill" ? .resize : .resizeAspectFill
            layer.isHidden = true
        }

        var ready: Bool { !failed && layer.isReadyForDisplay }

        func update(_ item: OverlayScene.Layer, time: Double, active: Bool, moving: Bool, bounds: CGRect) {
            if player.currentItem?.status == .failed {
                dispose()
                failed = true
            }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.frame = bounds
            layer.isHidden = !ready
            CATransaction.commit()
            guard !failed, active else { player.pause(); return }
            let start = (item.trimStartMs ?? 0) / 1000
            let end = item.trimEndMs.map { $0 / 1000 } ?? player.currentItem?.duration.seconds ?? .nan
            let elapsed = max(0, time - (item.startMs ?? 0)) / 1000
            let length = end - start
            let looping = item.loop == true
            let ended = length > 0 && !looping && elapsed >= length
            let offset = length > 0 ? looping ? elapsed.truncatingRemainder(dividingBy: length) : min(elapsed, length) : elapsed
            let target = start + offset
            if !seeking && abs(player.currentTime().seconds - target) > 0.22 && player.currentItem?.status == .readyToPlay {
                seeking = true
                player.seek(to: CMTime(seconds: target, preferredTimescale: 1000),
                            toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                    Task { @MainActor in self?.seeking = false }
                }
            }
            if moving && !ended { if player.rate == 0 { player.play() } }
            else if player.rate != 0 { player.pause() }
        }

        func dispose() {
            player.pause()
            player.replaceCurrentItem(with: nil)
            layer.removeFromSuperlayer()
        }
    }
}

extension UIColor {
    static func sceneColor(_ value: String?) -> UIColor? {
        guard let value else { return nil }
        if value == "transparent" { return .clear }
        guard value.hasPrefix("#") else { return nil }
        let hex = value.dropFirst()
        let characters = hex.count == 3 || hex.count == 4 ? hex.flatMap { [$0, $0] } : Array(hex)
        guard characters.count == 6 || characters.count == 8,
              let number = UInt32(String(characters), radix: 16) else { return nil }
        let rgba = characters.count == 6 ? (number << 8) | 255 : number
        return UIColor(red: CGFloat((rgba >> 24) & 255) / 255,
                       green: CGFloat((rgba >> 16) & 255) / 255,
                       blue: CGFloat((rgba >> 8) & 255) / 255, alpha: CGFloat(rgba & 255) / 255)
    }
}
#endif

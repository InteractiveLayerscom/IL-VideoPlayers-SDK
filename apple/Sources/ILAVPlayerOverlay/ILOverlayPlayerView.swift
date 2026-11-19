#if canImport(UIKit)
import AVFoundation
import UIKit

public enum ILOverlaySource { case hlsDateRanges, sidecar }
public enum ILOverlayInputError: Error { case stopped, wrongSource, staleItem }

/// Video surface for an existing primary AVPlayer. Put the host's controls above this view.
@MainActor
public final class ILOverlayPlayerView: UIView {
    public let playerLayer: AVPlayerLayer
    private let player: AVPlayer
    private let source: ILOverlaySource
    private var nativeBreaks: AVPlayerInterstitialEventMonitor?
    private let artwork = CALayer()
    private var item: AVPlayerItem?
    private var feed: HLSDateRangeFeed?
    private var jumpObserver: NSObjectProtocol?
    private var playbackObservation: NSKeyValueObservation?
    private var frames: CADisplayLink?
    private var timeline = OverlayTimeline()
    private var impressions = VisibleImpressions()
    private var requested: OverlayCue?
    private var bitmap: CGImage?
    private var loading: Task<Void, Never>?
    private var displayed: OverlayCue?
    private var stopped = false
    private var commercePanel: CommercePanel?
    private var viewed = Set<String>()

    /// Enable when the app requests the individualized commerce feed.
    public var commerceEnabled = false {
        didSet { if oldValue != commerceEnabled { clearArtwork() } }
    }

    /// Optional route for apps that present Shopify checkout from their own browser flow.
    public var openCheckoutURL: ((URL) -> Void)?

    /// Adds the session capability to the existing sidecar request.
    public static func commerceFeed(_ endpoint: URL, locale: String, country: String? = nil) -> URL? {
        guard OverlayCue.httpsURL(endpoint.absoluteString) != nil,
              var url = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        var query = (url.queryItems ?? []).filter { !["commerce", "locale", "country"].contains($0.name) }
        query += [URLQueryItem(name: "commerce", value: "1"),
                  URLQueryItem(name: "locale", value: OverlayCommerce.language(locale))]
        if let country, country.range(of: "^[A-Z]{2}$", options: .regularExpression) != nil {
            query.append(URLQueryItem(name: "country", value: country))
        }
        url.queryItems = query
        return url.url
    }

    /// Call before the host handles Back when the product panel is open.
    public func closeCommercePanel() -> Bool { commercePanel?.closeDetails() ?? false }

    public override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if let panel = commercePanel {
            return panel.hitTest(panel.convert(point, from: self), with: event)
        }
        return nil
    }

    public override var preferredFocusEnvironments: [UIFocusEnvironment] {
        if let commercePanel { return [commercePanel] }
        return super.preferredFocusEnvironments
    }

    /// Set from the host's SSAI/ad SDK callbacks for stitched linear breaks.
    public var isInLinearAdBreak = false {
        didSet { if isInLinearAdBreak { clearArtwork() } }
    }

    /// Set while the app covers the surface, scrubs, or presents Picture in Picture.
    public var isPresentationSuspended = false {
        didSet { if isPresentationSuspended { clearArtwork() } }
    }

    public convenience init(player: AVPlayer, source: ILOverlaySource = .hlsDateRanges) {
        self.init(player: player, playerLayer: AVPlayerLayer(player: player), source: source)
    }

    /// Reuses a detached, standalone player layer. A UIView backing layer belongs to its original view.
    public convenience init?(adopting playerLayer: AVPlayerLayer, source: ILOverlaySource = .hlsDateRanges) {
        guard let player = playerLayer.player, playerLayer.superlayer == nil,
              !(playerLayer.delegate is UIView) else { return nil }
        self.init(player: player, playerLayer: playerLayer, source: source)
    }

    private init(player: AVPlayer, playerLayer: AVPlayerLayer, source: ILOverlaySource) {
        self.player = player
        self.source = source
        self.playerLayer = playerLayer
        nativeBreaks = AVPlayerInterstitialEventMonitor(primaryPlayer: player)
        super.init(frame: .zero)
        backgroundColor = .black
        isUserInteractionEnabled = false
        clipsToBounds = true
        artwork.isHidden = true
        artwork.actions = ["hidden": NSNull(), "contents": NSNull(), "contentsGravity": NSNull()]
        playerLayer.backgroundColor = UIColor.black.cgColor
        layer.addSublayer(artwork)
        layer.addSublayer(playerLayer)
        playbackObservation = player.observe(\.timeControlStatus) { [weak self] _, _ in
            DispatchQueue.main.async {
                guard let self, self.player.timeControlStatus != .playing else { return }
                self.clearArtwork()
            }
        }
        bindCurrentItem()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    /// Replaces the whole individualized schedule, including an empty array to revoke all cues.
    public func replaceSidecar(_ json: Data, for item: AVPlayerItem) throws {
        guard !stopped else { throw ILOverlayInputError.stopped }
        guard source == .sidecar else { throw ILOverlayInputError.wrongSource }
        guard player.currentItem === item else { throw ILOverlayInputError.staleItem }
        bindCurrentItem()
        replaceSchedule(try OverlayCue.decodeSidecar(json))
    }

    /// Stops metadata collection and tracking. The existing player keeps rendering at full size.
    public func stop() {
        stopped = true
        playbackObservation?.invalidate()
        playbackObservation = nil
        nativeBreaks = nil
        frames?.invalidate()
        frames = nil
        unbind()
        clearArtwork()
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        frames?.invalidate()
        frames = nil
        guard window != nil, !stopped else { clearArtwork(); return }
        bindCurrentItem()
        let target = FrameTarget(view: self)
        let link = CADisplayLink(target: target, selector: #selector(FrameTarget.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 10, maximum: 30, preferred: 15)
        link.add(to: .main, forMode: .common)
        frames = link
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        layoutLayers()
        if let panel = commercePanel {
            let size = panel.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
            let bottom = bounds.height * 0.89
            let width = min(size.width, bounds.width * 0.85)
            panel.frame = CGRect(x: bounds.width * 0.94 - width, y: max(0, bottom - size.height),
                                 width: width, height: min(size.height, bottom))
        }
    }

    private func bindCurrentItem() {
        guard item !== player.currentItem else { return }
        unbind()
        clearArtwork()
        impressions = VisibleImpressions()
        viewed.removeAll()
        timeline = OverlayTimeline()
        guard let next = player.currentItem else { return }
        item = next
        if source == .hlsDateRanges {
            feed = HLSDateRangeFeed(item: next) { [weak self, weak next] cues in
                guard let self, let next, self.item === next, self.player.currentItem === next else { return }
                self.replaceSchedule(cues)
            }
        }
        jumpObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.timeJumpedNotification, object: next, queue: .main
        ) { [weak self, weak next] _ in
            MainActor.assumeIsolated {
                guard let self, self.item === next else { return }
                self.clearArtwork()
            }
        }
    }

    private func unbind() {
        if let jumpObserver { NotificationCenter.default.removeObserver(jumpObserver) }
        jumpObserver = nil
        feed?.stop()
        feed = nil
        item = nil
    }

    private func replaceSchedule(_ cues: [OverlayCue]) {
        timeline = OverlayTimeline(commerceEnabled ? cues : cues.filter { $0.commerce == nil })
        // A revised or withdrawn cue immediately releases the L geometry.
        if let displayed, timeline.active(at: item?.currentDate()) != displayed { clearArtwork() }
    }

    private func frame(_ timestamp: TimeInterval) {
        bindCurrentItem()
        guard let item, !timeline.isEmpty, player.timeControlStatus == .playing, player.rate > 0,
              !isInLinearAdBreak, !isPresentationSuspended, !player.isExternalPlaybackActive,
              nativeBreaks?.currentEvent == nil, playerLayer.isReadyForDisplay,
              let date = item.currentDate(), let visible = visibleBounds else { clearArtwork(); return }

        let active = timeline.active(at: date)
        prepare(active ?? timeline.upcoming(after: date))
        guard let cue = active, let bitmap, requested == cue else { hide(); return }
        show(cue, image: bitmap)
        guard let url = cue.impressionURL else { return }
        // Only the two bands of an L can be seen behind the program.
        let hasVisibleArt: Bool
        if cue.format == .l {
            hasVisibleArt = !playerLayer.frame.contains(visible)
        } else {
            let fitted = AVMakeRect(aspectRatio: CGSize(width: bitmap.width, height: bitmap.height),
                                    insideRect: artwork.frame)
            hasVisibleArt = fitted.intersects(visible)
        }
        guard hasVisibleArt else { impressions.hidden(); return }
        if impressions.presented(cue.id, at: timestamp) {
            Task { await OverlayArtwork.sendImpression(to: url) }
        }
    }

    func show(_ cue: OverlayCue, image: CGImage) {
        guard displayed != cue else { return }
        displayed = cue
        artwork.contents = image
        artwork.isHidden = false
        removeCommercePanel()
        if let offer = cue.commerce, commerceEnabled {
            let panel = CommercePanel(offer, photo: image, checkoutURL: openCheckoutURL) { [weak self] in
                guard let self, let url = offer.viewURL, self.viewed.insert(cue.id).inserted else { return }
                Task { await OverlayArtwork.sendImpression(to: url) }
            }
            commercePanel = panel
            isUserInteractionEnabled = true
            addSubview(panel)
            setNeedsLayout()
            setNeedsFocusUpdate()
        }
        layoutLayers()
    }

    private var visibleBounds: CGRect? {
        guard let window, window.windowScene?.activationState == .foregroundActive, !bounds.isEmpty else { return nil }
        var visible = convert(bounds, to: window).intersection(window.bounds)
        var ancestor: UIView? = self
        while let view = ancestor {
            if view.isHidden || view.alpha <= 0.01 { return nil }
            if view.clipsToBounds { visible = visible.intersection(view.convert(view.bounds, to: window)) }
            ancestor = view.superview
        }
        guard !visible.isEmpty, !visible.isNull else { return nil }
        return convert(visible, from: window).intersection(bounds)
    }

    private func prepare(_ cue: OverlayCue?) {
        guard requested != cue else { return }
        loading?.cancel()
        requested = cue
        bitmap = nil
        guard let cue else { loading = nil; return }
        loading = Task { [weak self] in
            let image = try? await OverlayArtwork.load(cue)
            guard !Task.isCancelled, self?.requested == cue else { return }
            self?.bitmap = image
        }
    }

    private func clearArtwork() {
        prepare(nil)
        hide()
    }

    private func hide() {
        impressions.hidden()
        guard displayed != nil else { return }
        displayed = nil
        removeCommercePanel()
        artwork.contents = nil
        artwork.isHidden = true
        layoutLayers()
    }

    private func removeCommercePanel() {
        guard let commercePanel else { return }
        commercePanel.dispose()
        self.commercePanel = nil
        isUserInteractionEnabled = false
        setNeedsFocusUpdate()
    }

    private func layoutLayers() {
        let layout = OverlayLayout(canvas: bounds, format: displayed?.format)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        playerLayer.frame = layout.video
        artwork.frame = layout.artwork
        artwork.contentsGravity = displayed?.format == .l ? .resize : .resizeAspect
        playerLayer.zPosition = displayed?.format == .l ? 1 : 0
        artwork.zPosition = displayed?.format == .l ? 0 : 1
        CATransaction.commit()
    }

    deinit {
        frames?.invalidate()
        loading?.cancel()
        if let jumpObserver { NotificationCenter.default.removeObserver(jumpObserver) }
    }

    @MainActor
    private final class FrameTarget: NSObject {
        weak var view: ILOverlayPlayerView?
        init(view: ILOverlayPlayerView) { self.view = view }

        @objc func tick(_ link: CADisplayLink) {
            guard let view else { link.invalidate(); return }
            view.frame(link.timestamp)
        }
    }
}
#endif

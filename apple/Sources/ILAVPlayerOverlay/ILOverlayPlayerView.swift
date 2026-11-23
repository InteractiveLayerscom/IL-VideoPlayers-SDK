#if canImport(UIKit)
import AVFoundation
import UIKit

#if os(tvOS)
typealias PlayerCommercePanel = TVCommercePanel
#else
typealias PlayerCommercePanel = CommercePanel
#endif

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
    private var commercePanel: PlayerCommercePanel?
    private(set) var midrollIdentity: (creative: String, delivery: String)?
    private var sceneSurface: SceneSurface?
    private weak var lastProductFocus: UIButton?
    private var sceneArtworkVisible = false
    private var feedCues: [OverlayCue] = []
    private var planCues: [OverlayCue] = []
    private var planVisibility: ((String) -> Void)?
    private var adContainerVisible = false

    /// Where an ad SDK renders a break: over the video and under the Buy panel.
    public lazy var adContainer: UIView = {
        let view = UIView(frame: bounds)
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.layer.zPosition = 2
        view.isHidden = true
        addSubview(view)
        return view
    }()

    public func setAdContainerVisible(_ visible: Bool) {
        adContainerVisible = visible
        adContainer.isHidden = !visible
        isUserInteractionEnabled = visible || commercePanel != nil || sceneSurface != nil
    }

    /// Leave disabled on devices that cannot sustain two concurrent decoders.
    public var allowsSecondaryVideo = false {
        didSet { if oldValue != allowsSecondaryVideo { clearArtwork() } }
    }
    /// Enable only when the host permits an audible clip. Secondary video must also be enabled.
    public var allowsSecondaryVideoAudio = false {
        didSet { if oldValue != allowsSecondaryVideoAudio { clearArtwork() } }
    }
    private var viewed = Set<String>()

    /// Enable when the app requests the individualized commerce feed.
    public var commerceEnabled = false {
        didSet { if oldValue != commerceEnabled { clearArtwork() } }
    }

    /// Optional route for apps that present Shopify checkout from their own browser flow.
    public var openCheckoutURL: ((URL) -> Void)?
    public var openSceneLink: ((URL) -> Void)?

    /// Adds scene negotiation to the existing sidecar request.
    public static func scenesFeed(_ endpoint: URL) -> URL? {
        scenesFeed(endpoint, secondaryVideo: false)
    }

    public static func scenesFeed(_ endpoint: URL, secondaryVideo: Bool, audio: Bool = false) -> URL? {
        SceneFeed.url(endpoint, video: secondaryVideo, audio: audio)
    }

    /// Adds scene and commerce negotiation to the existing sidecar request.
    public static func commerceFeed(_ endpoint: URL, locale: String, country: String? = nil,
                                    midrollCreativeID: String? = nil, midrollDeliveryID: String? = nil) -> URL? {
        commerceFeed(endpoint, locale: locale, country: country, secondaryVideo: false,
                     midrollCreativeID: midrollCreativeID, midrollDeliveryID: midrollDeliveryID)
    }

    public static func commerceFeed(_ endpoint: URL, locale: String, country: String? = nil,
                                    secondaryVideo: Bool, audio: Bool = false,
                                    midrollCreativeID: String? = nil, midrollDeliveryID: String? = nil) -> URL? {
        guard let scenes = scenesFeed(endpoint, secondaryVideo: secondaryVideo, audio: audio),
              var url = URLComponents(url: scenes, resolvingAgainstBaseURL: false) else { return nil }
        var query = (url.queryItems ?? []).filter { !["commerce", "locale", "country", "shop_midroll", "midroll_creative_id", "midroll_delivery_id"].contains($0.name) }
        query += [URLQueryItem(name: "commerce", value: "1"),
                  URLQueryItem(name: "locale", value: OverlayCommerce.language(locale))]
        if let country, country.range(of: "^[A-Z]{2}$", options: .regularExpression) != nil {
            query.append(URLQueryItem(name: "country", value: country))
        }
        if OverlayCue.validIdentifier(midrollCreativeID), OverlayCue.validIdentifier(midrollDeliveryID) {
            query += [URLQueryItem(name: "shop_midroll", value: "1"),
                      URLQueryItem(name: "midroll_creative_id", value: midrollCreativeID),
                      URLQueryItem(name: "midroll_delivery_id", value: midrollDeliveryID)]
        }
        url.queryItems = query
        return url.url
    }

    /// Call before the host handles Back when the product panel is open.
    public func closeCommercePanel() -> Bool { commercePanel?.closeDetails() ?? false }

    public override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if let panel = commercePanel {
            if let control = panel.hitTest(panel.convert(point, from: self), with: event) { return control }
        }
        if adContainerVisible { return adContainer.hitTest(adContainer.convert(point, from: self), with: event) }
        if let sceneSurface { return sceneSurface.hitTest(sceneSurface.convert(point, from: self), with: event) }
        return nil
    }

    public override var preferredFocusEnvironments: [UIFocusEnvironment] {
        if let commercePanel { return [commercePanel] }
        if let button = lastProductFocus, !button.isHidden { return [button] }
        if let sceneSurface { return [sceneSurface] }
        return super.preferredFocusEnvironments
    }

    /// Set from the host's SSAI/ad SDK callbacks for stitched linear breaks.
    public var isInLinearAdBreak = false {
        didSet {
            midrollIdentity = nil
            if isInLinearAdBreak || oldValue { clearArtwork() }
        }
    }

    /// Pass the identifiers from the VAST creative and its impression URL when the host starts that delivery.
    public func setLinearAdBreak(_ active: Bool, creativeID: String? = nil, deliveryID: String? = nil) {
        if active, isInLinearAdBreak, let current = midrollIdentity,
           current.creative == creativeID, current.delivery == deliveryID { return }
        isInLinearAdBreak = active
        if active, let creativeID, let deliveryID, OverlayCue.validIdentifier(creativeID), OverlayCue.validIdentifier(deliveryID) {
            midrollIdentity = (creativeID, deliveryID)
        }
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
                guard let self, self.player.timeControlStatus != .playing,
                      self.displayed?.format != .midroll,
                      self.displayed?.scene == nil || self.player.timeControlStatus != .paused else { return }
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

    /// With a listener, cues run on content time, the timeline of IL's ad plan. Nil restores program time.
    func useContentClock(_ visibility: ((String) -> Void)?) {
        planVisibility = visibility
        clearArtwork()
    }

    func setPlanCues(_ cues: [OverlayCue]) {
        planCues = cues
        replaceSchedule(feedCues)
    }

    private func clockDate(_ item: AVPlayerItem) -> Date? {
        guard planVisibility != nil else { return item.currentDate() }
        let seconds = player.currentTime().seconds
        return seconds.isFinite && seconds >= 0 ? Date(timeIntervalSince1970: seconds) : nil
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
            panel.frame = panel.presentationFrame(in: bounds)
        }
    }

    private func bindCurrentItem() {
        guard item !== player.currentItem else { return }
        unbind()
        clearArtwork()
        // An ad break swaps the item under a plan: what was already counted stays counted.
        if planVisibility == nil {
            impressions = VisibleImpressions()
            viewed.removeAll()
        }
        feedCues = []
        timeline = OverlayTimeline(planCues)
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
        feedCues = cues
        let all = cues + planCues
        timeline = OverlayTimeline(commerceEnabled ? all : all.filter { $0.commerce == nil || $0.scene != nil })
        // A revised or withdrawn cue immediately releases the L geometry.
        if let displayed {
            let active = midrollIdentity.map { timeline.midroll(at: item?.currentDate() ?? Date(), creativeID: $0.creative, deliveryID: $0.delivery) }
                ?? timeline.active(at: item.flatMap(clockDate))
            if active != displayed { clearArtwork() }
        }
    }

    private func frame(_ timestamp: TimeInterval) {
        bindCurrentItem()
        if isInLinearAdBreak {
            guard !isPresentationSuspended, !player.isExternalPlaybackActive,
                  item != nil, visibleBounds != nil else { clearArtwork(); return }
            showMidroll(at: item?.currentDate() ?? Date())
            return
        }
        let moving = player.timeControlStatus == .playing && player.rate > 0
        guard let item, !timeline.isEmpty, moving || player.timeControlStatus == .paused,
              !isPresentationSuspended, !player.isExternalPlaybackActive,
              nativeBreaks?.currentEvent == nil, playerLayer.isReadyForDisplay,
              let date = clockDate(item), let visible = visibleBounds else { clearArtwork(); return }

        let active = timeline.active(at: date)
        if let cue = active, let scene = cue.scene {
            prepare(nil)
            showScene(cue, scene: scene, at: date, moving: moving, visible: visible)
            measureScene(cue, at: timestamp)
            return
        }
        if !moving { clearArtwork(); return }
        prepare(active ?? timeline.upcoming(after: date))
        guard let cue = active, let bitmap, requested == cue else { hide(); return }
        show(cue, image: bitmap)
        guard cue.impressionURL != nil || planVisibility != nil else { return }
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
        if impressions.presented(cue.id, at: timestamp) { reportVisible(cue) }
    }

    private func reportVisible(_ cue: OverlayCue) {
        planVisibility?(cue.id)
        if let url = cue.impressionURL { Task { await OverlayArtwork.sendImpression(to: url) } }
    }

    func showMidroll(at date: Date) {
        guard isInLinearAdBreak, commerceEnabled, let midrollIdentity,
              let cue = timeline.midroll(at: date, creativeID: midrollIdentity.creative, deliveryID: midrollIdentity.delivery),
              let offer = cue.commerce else { clearArtwork(); return }
        if displayed != cue {
            hide()
            displayed = cue
            installCommerce(cue, offer: offer, image: nil)
            layoutLayers()
        }
    }

    private func showScene(_ cue: OverlayCue, scene: OverlayScene, at date: Date, moving: Bool, visible: CGRect) {
        if displayed != cue {
            hide()
            displayed = cue
            let onBuy: ((SceneOffer, UIButton) -> Void)? = commerceEnabled ? { [weak self] offer, button in
                self?.openOffer(cue, offer: offer, button: button)
            } : nil
            var onLink = openSceneLink
            #if os(iOS)
            if onLink == nil { onLink = { url in UIApplication.shared.open(url) } }
            #endif
            let surface = SceneSurface(cue: cue, scene: scene, allowsVideo: allowsSecondaryVideo,
                                       allowsAudio: allowsSecondaryVideoAudio,
                                       buy: onBuy, link: onLink)
            sceneSurface = surface
            insertSubview(surface, at: 0)
            isUserInteractionEnabled = true
            setNeedsFocusUpdate()
            layoutLayers()
        }
        guard let surface = sceneSurface else { return }
        let viewport = surface.convert(visible, from: self)
        surface.update(at: date.timeIntervalSince(cue.start) * 1000, moving: moving, visible: viewport)
        if sceneArtworkVisible != surface.artworkVisible {
            sceneArtworkVisible = surface.artworkVisible
            surface.isHidden = !sceneArtworkVisible
            layoutLayers()
        }
    }

    private func measureScene(_ cue: OverlayCue, at timestamp: TimeInterval) {
        guard sceneArtworkVisible, cue.impressionURL != nil || planVisibility != nil else { impressions.hidden(); return }
        if impressions.presented(cue.id, at: timestamp) { reportVisible(cue) }
    }

    private func openOffer(_ cue: OverlayCue, offer: SceneOffer, button: UIButton) {
        guard displayed == cue, sceneArtworkVisible else { return }
        removeCommercePanel()
        lastProductFocus = button
        let panel = PlayerCommercePanel(offer.commerce, photo: nil, photoURL: offer.imageURL, brand: cue.brand,
                                  checkoutURL: openCheckoutURL, closed: { [weak self] in
            self?.removeCommercePanel()
        }) { [weak self] in
            guard let self, let url = offer.commerce.viewURL,
                  self.viewed.insert(cue.id + "\u{0}" + offer.id).inserted else { return }
            Task { await OverlayArtwork.sendImpression(to: url) }
        }
        commercePanel = panel
        panel.layer.zPosition = 3
        addSubview(panel)
        setNeedsLayout()
        setNeedsFocusUpdate()
    }

    func show(_ cue: OverlayCue, image: CGImage) {
        guard displayed != cue else { return }
        hide()
        displayed = cue
        artwork.contents = image
        artwork.isHidden = false
        removeCommercePanel()
        if let offer = cue.commerce, commerceEnabled {
            installCommerce(cue, offer: offer, image: image)
        }
        layoutLayers()
    }

    private func installCommerce(_ cue: OverlayCue, offer: OverlayCommerce, image: CGImage?) {
        let panel = PlayerCommercePanel(offer, photo: image, photoURL: offer.imageURL,
                                        brand: cue.brand, midroll: cue.format == .midroll, checkoutURL: openCheckoutURL) { [weak self] in
            guard let self, let url = offer.viewURL, self.viewed.insert(cue.id).inserted else { return }
            Task { await OverlayArtwork.sendImpression(to: url) }
        }
        commercePanel = panel
        panel.layer.zPosition = 3
        isUserInteractionEnabled = true
        addSubview(panel)
        setNeedsLayout()
        setNeedsFocusUpdate()
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
        sceneSurface?.dispose()
        sceneSurface = nil
        sceneArtworkVisible = false
        lastProductFocus = nil
        isUserInteractionEnabled = adContainerVisible
        artwork.contents = nil
        artwork.isHidden = true
        layoutLayers()
    }

    private func removeCommercePanel() {
        guard let commercePanel else { return }
        commercePanel.dispose()
        self.commercePanel = nil
        isUserInteractionEnabled = sceneSurface != nil || adContainerVisible
        setNeedsFocusUpdate()
    }

    private func layoutLayers() {
        let layout = OverlayLayout(canvas: bounds, format: displayed?.format)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let sceneL = displayed?.scene != nil && displayed?.format == .l
        playerLayer.frame = sceneL && (!sceneArtworkVisible || displayed?.layout == "overlay") ? bounds : layout.video
        sceneSurface?.frame = layout.artwork
        artwork.frame = layout.artwork
        artwork.contentsGravity = displayed?.format == .l ? .resize : .resizeAspect
        playerLayer.zPosition = displayed?.format == .l && !sceneL ? 1 : 0
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

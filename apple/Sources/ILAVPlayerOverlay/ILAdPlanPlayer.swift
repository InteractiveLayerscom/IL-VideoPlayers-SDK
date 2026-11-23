#if canImport(UIKit)
import AVFoundation
import UIKit

/// How one linear ad request ended. `unavailable` means the engine could not run this answer: the MP4 path tries it.
public enum ILLinearAdOutcome: Equatable, Sendable { case noFill, completed, failed, unavailable }

/// Plays a linear ad outside the content player. `ILAdPlanIMA` is the Google IMA engine.
@MainActor
public protocol ILLinearAdEngine: AnyObject {
    /// `adsResponse` is the VAST this player already fetched for `tagURL`, so the engine need not ask again.
    func playAd(tagURL: String, adsResponse: String?, deadline: Date, onStart: @escaping () -> Void) async -> ILLinearAdOutcome
    func cancel()
}

/// A 300x250 display slot for the plan's Overlay. `ILAdPlanGMA` is the Google Mobile Ads one (iOS).
@MainActor
public protocol ILDisplayAdSlot: AnyObject {
    func request(adUnit: String, targeting: [String: String], answered: @escaping (Bool) -> Void, onImpression: @escaping () -> Void)
    func setVisible(_ visible: Bool)
    func clear()
}

/// Plays IL's ad plan on the app's AVPlayer: ordered requests per break, graphics, Overlay and scene products.
/// Breaks use the linear engine when the host passes one (`ILAdPlanIMA`), and progressive MP4 on the same player
/// without one or when it cannot run an answer.
@MainActor
public final class ILAdPlanPlayer {
    /// Diagnostics. `id` is the break or the window.
    public typealias Events = (_ type: String, _ format: String?, _ id: String) -> Void

    private static let displayTimeoutSeconds: UInt64 = 4
    private static let maxWrappers = 3
    private static let overlayFormat = "overlay_300x250"

    private let overlay: ILOverlayPlayerView
    private let player: AVPlayer
    private let plan: AdPlan
    private var schedule: AdPlan.Schedule
    private let locale: String
    private let events: Events?
    private let engine: ILLinearAdEngine?
    private let display: ILDisplayAdSlot?
    private let session: URLSession
    private var observer: Any?
    private var planCues: [OverlayCue] = []
    private var measures: [String: (urls: [String], format: String, window: String)] = [:]
    private var started = false
    private var closed = false
    private var inBreak = false
    private var graphicBusy = false
    private var productBusy = false
    private var currentAd: AdPlan.LinearAd?
    private var firedQuartiles = Set<String>()
    private var displayLive: AdPlan.Window?
    private var displayRequest = 0
    private var viewedDisplays = Set<String>()
    private var watch = AdPlan.AdWatch(durationMs: 0)
    private var breakContent: (item: AVPlayerItem?, at: CMTime)?
    /// How long a break may hold the content before its ad starts. Shortened in tests.
    var holdSeconds: TimeInterval = 8
    /// Whether the app is in the foreground: the MP4 watchdog does not count background time.
    var appActive: () -> Bool = { UIApplication.shared.applicationState == .active }
    /// Replaces MP4 playback in tests.
    var playMedia: ((AdPlan.LinearAd, URL) async -> Bool)?

    /// Nil when the plan is unusable: the player then runs with no ads. `displaySlot` shows the Overlay.
    public convenience init?(overlay: ILOverlayPlayerView, player: AVPlayer, planJSON: Data, planOrigin: String?,
                             sessionID: String, locale: String = "en", linearEngine: ILLinearAdEngine? = nil,
                             displaySlot: ILDisplayAdSlot? = nil, events: Events? = nil) {
        self.init(overlay: overlay, player: player, planJSON: planJSON, planOrigin: planOrigin, sessionID: sessionID,
                  locale: locale, engine: linearEngine, displaySlot: displaySlot, sessionConfiguration: .ephemeral, events: events)
    }

    init?(overlay: ILOverlayPlayerView, player: AVPlayer, planJSON: Data, planOrigin: String?, sessionID: String,
          locale: String, engine: ILLinearAdEngine?, displaySlot: ILDisplayAdSlot?,
          sessionConfiguration: URLSessionConfiguration, events: Events?) {
        guard let plan = AdPlan.read(planJSON, now: Date(), origin: planOrigin, sessionID: sessionID) else { return nil }
        self.overlay = overlay
        self.player = player
        self.plan = plan
        schedule = AdPlan.Schedule(plan: plan)
        self.locale = locale
        self.events = events
        self.engine = engine
        display = displaySlot
        sessionConfiguration.timeoutIntervalForRequest = 5
        // The whole transfer, not just idle time: a slow trickle cannot hold a break either.
        sessionConfiguration.timeoutIntervalForResource = 5
        session = URLSession(configuration: sessionConfiguration)
        overlay.useContentClock { [weak self] id in self?.cueVisible(id) }
    }

    /// Call before playing content. Returns once the host may play it.
    public func start() async {
        guard !closed, !started else { return }
        started = true
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        if let preroll = schedule.join(positionMs: positionMs) { await runBreak(preroll) }
    }

    public func stop() {
        guard !closed else { return }
        closed = true
        if let observer { player.removeTimeObserver(observer) }
        observer = nil
        session.invalidateAndCancel()
        engine?.cancel()
        display?.clear()
        if inBreak {
            // The ad stops with the plan and the content is back where it was, paused for the host.
            player.pause()
            if let saved = breakContent {
                if player.currentItem !== saved.item { player.replaceCurrentItem(with: saved.item) }
                if saved.at.seconds > 0 { player.seek(to: saved.at, toleranceBefore: .zero, toleranceAfter: .zero) }
            }
            breakContent = nil
            currentAd = nil
            overlay.setLinearAdBreak(false)
        }
        overlay.setPlanCues([])
        overlay.useContentClock(nil)
    }

    private var positionMs: Int64 {
        let seconds = player.currentTime().seconds
        return seconds.isFinite && seconds > 0 ? Int64(seconds * 1000) : 0
    }

    private func emit(_ type: String, _ format: String?, _ id: String) { events?(type, format, id) }

    private func tick() {
        guard !closed else { return }
        if inBreak { trackQuartiles(); return }
        guard player.timeControlStatus == .playing else {
            if displayLive != nil { display?.setVisible(false) }
            return
        }
        advance(nowMs: positionMs)
    }

    func advance(nowMs now: Int64) {
        guard !closed, !inBreak else { return }
        if let due = schedule.dueCut(nowMs: now) {
            Task { await runBreak(due) }
            return
        }
        let kept = planCues.filter { Int64($0.end.timeIntervalSince1970 * 1000) > now }
        if kept.count != planCues.count {
            planCues = kept
            overlay.setPlanCues(kept)
        }
        updateDisplay(now)
        if !productBusy, !planCues.contains(where: { $0.commerce != nil }), let window = schedule.nextProduct(nowMs: now) {
            askProduct(window)
        }
        schedule.overlayAvailable = display != nil && overlay.bounds.width >= 640 && overlay.bounds.height >= 360
        if !graphicBusy, displayLive == nil, let window = schedule.nextGraphic(nowMs: now) { askGraphic(window, now: now) }
    }

    private func updateDisplay(_ now: Int64) {
        guard let live = displayLive else { return }
        if now >= live.end {
            display?.clear()
            displayLive = nil
        } else {
            display?.setVisible(now >= live.start)
        }
    }

    private func body(_ url: URL) async -> (Int, Data)? {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse else { return nil }
        return (http.statusCode, data)
    }

    private func beacon(_ urls: [String]?) {
        for url in urls ?? [] {
            guard let target = OverlayCue.httpsURL(url) else { continue }
            Task { await OverlayArtwork.sendImpression(to: target) }
        }
    }

    private func askGraphic(_ window: AdPlan.Window, now: Int64) {
        let graphic = schedule.nextFormat
        schedule.attempted.insert(window.id)
        schedule.pending.append(window)
        graphicBusy = true
        emit("request", graphic.format, window.id)
        if graphic.format == Self.overlayFormat {
            askDisplay(window, unit: graphic.tagURL)
            return
        }
        let tag = AdPlan.graphicTag(graphic.tagURL, format: graphic.format, targeting: window.targeting, page: plan.page)
        let available = window.end - max(window.start, now)
        Task {
            var answer = AdPlan.GraphicAnswer.unusable
            if let url = URL(string: tag), let (status, data) = await body(url), (200..<300).contains(status) {
                answer = AdPlan.parseGraphic(String(decoding: data, as: UTF8.self), format: graphic.format, availableMs: available)
            }
            guard !closed else { return }
            schedule.pending.removeAll { $0 == window }
            graphicBusy = false
            switch answer {
            case .noFill: emit("no_fill", graphic.format, window.id)
            case .ad(let ad) where !inBreak && positionMs < window.end:
                let id = "il-ads-" + window.id
                guard let cue = AdPlan.graphicCue(id: id, format: graphic.format, window: window, ad: ad) else {
                    emit("error", graphic.format, window.id)
                    return
                }
                schedule.shown.append(window)
                emit("fill", graphic.format, window.id)
                measures[id] = (ad.impressions, graphic.format, window.id)
                planCues.append(cue)
                overlay.setPlanCues(planCues)
            case .ad: break
            case .unusable: emit("error", graphic.format, window.id)
            }
        }
    }

    private func askDisplay(_ window: AdPlan.Window, unit: String) {
        displayRequest += 1
        let request = displayRequest
        var targeting = window.targeting
        targeting["il_format"] = Self.overlayFormat
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.displayTimeoutSeconds * 1_000_000_000)
            self?.displayAnswered(request, window, nil)
        }
        display?.request(adUnit: unit, targeting: targeting, answered: { [weak self] filled in
            self?.displayAnswered(request, window, filled)
        }, onImpression: { [weak self] in
            guard let self, !self.closed, self.displayLive == window, self.viewedDisplays.insert(window.id).inserted else { return }
            self.emit("impression", Self.overlayFormat, window.id)
        })
    }

    private func displayAnswered(_ request: Int, _ window: AdPlan.Window, _ filled: Bool?) {
        guard !closed, request == displayRequest, schedule.pending.contains(window) else { return }
        displayRequest += 1
        schedule.pending.removeAll { $0 == window }
        graphicBusy = false
        if filled == true, !inBreak, positionMs < window.end {
            schedule.shown.append(window)
            displayLive = window
            emit("fill", Self.overlayFormat, window.id)
            updateDisplay(positionMs)
        } else {
            display?.clear()
            emit(filled == nil ? "error" : "no_fill", Self.overlayFormat, window.id)
        }
    }

    private func askProduct(_ window: AdPlan.Window) {
        schedule.products[window.id] = "pending"
        schedule.pending.append(window)
        productBusy = true
        emit("request", "scene_product", window.id)
        let target = plan.productURL(windowID: window.id, locale: locale)
        Task {
            var card: OverlayCue?
            var empty = true
            if let target, let (status, data) = await body(target), status == 200 {
                empty = false
                card = AdPlan.productCue(data, window: window)
            }
            guard !closed else { return }
            schedule.pending.removeAll { $0 == window }
            productBusy = false
            guard let card, !inBreak else {
                schedule.products[window.id] = "empty"
                emit(empty ? "no_fill" : "error", "scene_product", window.id)
                return
            }
            schedule.products[window.id] = "filled"
            schedule.shown.append(window)
            emit("fill", "scene_product", window.id)
            measures[card.id] = ([], "scene_product", window.id)
            planCues.append(card)
            overlay.setPlanCues(planCues)
        }
    }

    // The overlay reports a cue drawn on screen once. Its own impression URL is sent by the overlay.
    private func cueVisible(_ id: String) {
        guard let measure = measures.removeValue(forKey: id) else { return }
        beacon(measure.urls)
        emit("impression", measure.format, measure.window)
    }

    /// The ad behind `tag`, wrappers followed, and the first VAST as received. Nil once the deadline passes.
    private func linearAd(_ tag: String, deadline: Date) async -> (ad: AdPlan.LinearAd, vast: String)? {
        let wait = deadline.timeIntervalSinceNow
        guard wait > 0 else { return nil }
        return await withTaskGroup(of: (ad: AdPlan.LinearAd, vast: String)?.self) { group in
            group.addTask { @MainActor [weak self] in await self?.followWrappers(tag) }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    private func followWrappers(_ tag: String) async -> (ad: AdPlan.LinearAd, vast: String)? {
        var ad = AdPlan.LinearAd()
        var next = tag
        var first: String?
        for _ in 0...Self.maxWrappers {
            guard let url = URL(string: next), let (status, data) = await body(url), (200..<300).contains(status) else { return nil }
            let text = String(decoding: data, as: UTF8.self)
            if first == nil { first = text }
            guard AdPlan.parseLinear(text, into: &ad) else { return nil }
            guard let wrapper = ad.wrapperURL else { return (ad, first ?? text) }
            next = wrapper
        }
        return nil
    }

    private func runBreak(_ cut: AdPlan.Cut) async {
        schedule.settled.insert(cut.id)
        inBreak = true
        firedQuartiles.removeAll()
        if displayLive != nil { display?.setVisible(false) }
        let content = player.currentItem
        let resumeAt = player.currentTime()
        let resumeRate = player.rate
        breakContent = (content, resumeAt)
        player.pause()
        overlay.setLinearAdBreak(true)
        emit("break_start", nil, cut.id)
        let deadline = Date().addingTimeInterval(holdSeconds)
        var found: AdPlan.LinearAd?
        var complete = false
        var engineDone = false
        for request in cut.requests where found == nil && !engineDone && !closed && Date() < deadline {
            emit("break_request", request.provider, cut.id)
            let tag = AdPlan.correlated(request.tagURL)
            var outcome = ILLinearAdOutcome.unavailable
            // iADServer's spot is read here for its Buy identity, and the engine is handed this same answer.
            let fetched = request.provider == "iadserver" || engine == nil ? await linearAd(tag, deadline: deadline) : nil
            guard !closed else { return }
            if let engine, Date() < deadline {
                let spot = plan.breakShop ? fetched?.ad : nil
                outcome = await engine.playAd(tagURL: tag, adsResponse: fetched?.vast, deadline: deadline) { [weak self] in
                    guard let self, !self.closed else { return }
                    self.overlay.setLinearAdBreak(true, creativeID: spot?.creativeID, deliveryID: spot?.deliveryID)
                }
                guard !closed else { return }
            }
            switch outcome {
            case .completed: complete = true; engineDone = true
            case .failed: engineDone = true
            case .noFill: emit("break_no_fill", request.provider, cut.id)
            case .unavailable:
                found = engine == nil || fetched != nil ? fetched?.ad : await linearAd(tag, deadline: deadline)?.ad
                if found == nil, !closed { emit("break_no_fill", request.provider, cut.id) }
            }
        }
        guard !closed else { return }
        // Nothing starts once the hold deadline has passed.
        if let found, let media = found.mediaURL.flatMap(OverlayCue.httpsURL), AdPlan.AdWatch.mayStart(now: Date(), deadline: deadline) {
            if let playMedia {
                complete = await playMedia(found, media)
            } else {
                complete = await play(found, media: media, deadline: deadline)
            }
            guard !closed else { return }
            // The ad leaves the player before graphics are allowed back.
            player.replaceCurrentItem(with: content)
            if resumeAt.seconds > 0 { _ = await player.seek(to: resumeAt, toleranceBefore: .zero, toleranceAfter: .zero) }
            guard !closed else { return }
        }
        currentAd = nil
        breakContent = nil
        inBreak = false
        overlay.setLinearAdBreak(false)
        emit(complete ? "break_end" : "break_error", nil, cut.id)
        if resumeRate > 0 { player.rate = resumeRate }
    }

    private func play(_ ad: AdPlan.LinearAd, media: URL, deadline: Date) async -> Bool {
        let item = AVPlayerItem(url: media)
        currentAd = ad
        // An MP4 that shows no first frame by the hold deadline releases the break.
        watch = AdPlan.AdWatch(durationMs: ad.durationMs, startBy: deadline)
        player.replaceCurrentItem(with: item)
        player.play()
        let center = NotificationCenter.default
        let complete = await withTaskGroup(of: Bool?.self) { group in
            group.addTask {
                for await _ in center.notifications(named: AVPlayerItem.didPlayToEndTimeNotification, object: item) { return true }
                return false
            }
            group.addTask {
                for await _ in center.notifications(named: AVPlayerItem.failedToPlayToEndTimeNotification, object: item) { return false }
                return false
            }
            // A media file that cannot load fails on the item and posts no notification. The same loop is the
            // watchdog: it counts foreground time only, up to the VAST duration plus 30 s.
            group.addTask { @MainActor [weak self] in
                var counted = false
                var last = Date()
                while !Task.isCancelled {
                    guard let self else { return false }
                    if item.status == .failed { return false }
                    if !counted, item.status == .readyToPlay, self.player.timeControlStatus == .playing {
                        counted = true
                        self.beacon(ad.impressions)
                        self.beacon(ad.tracking["start"])
                        self.overlay.setLinearAdBreak(true, creativeID: self.plan.breakShop ? ad.creativeID : nil,
                                                      deliveryID: self.plan.breakShop ? ad.deliveryID : nil)
                    }
                    let now = Date()
                    let seconds = item.currentTime().seconds
                    if self.watch.tick(positionMs: seconds.isFinite ? Int64(seconds * 1000) : 0,
                                       stepMs: Int64(now.timeIntervalSince(last) * 1000), active: self.appActive(),
                                       started: counted, now: now) { return false }
                    last = now
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
                return nil
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first ?? false
        }
        // An ad dragged to its end with the app's controls is not reported complete.
        let finished = complete && !watch.scrubbed
        if finished { beacon(ad.tracking["complete"]) }
        return finished
    }

    private func trackQuartiles() {
        guard let ad = currentAd, ad.durationMs > 0 else { return }
        let position = positionMs
        for (event, share) in [("firstQuartile", 0.25), ("midpoint", 0.5), ("thirdQuartile", 0.75)]
        where Double(position) >= Double(ad.durationMs) * share && firedQuartiles.insert(event).inserted {
            beacon(ad.tracking[event])
        }
    }
}
#endif

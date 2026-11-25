#if canImport(UIKit)
import AVFoundation
import UIKit

/// How one linear ad request ended. `unavailable` means the engine could not run this answer: the MP4 path tries it.
public enum ILLinearAdOutcome: Equatable, Sendable { case noFill, completed, failed, unavailable }

/// Plays a linear ad outside the content player. `ILAdPlanIMA` is the Google IMA engine.
@MainActor
public protocol ILLinearAdEngine: AnyObject {
    /// `adsResponse` is the VAST this player already fetched for `tagURL`, so the engine need not ask again.
    /// Call `onStart` when the ad's first frame shows: an engine that has not called it
    /// `ILAdPlanPlayer.loadedStartLimitSeconds` after `deadline` is cancelled and the content comes back.
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

/// Whether the engine reported the ad's start, shared with the break's backstop.
@MainActor
private final class StartFlag { var value = false }

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
    private var plan: AdPlan
    private(set) var schedule: AdPlan.Schedule
    private var planJSON: Data
    private let planOrigin: String?
    private let sessionID: String
    private var hostBreaks: [Int64] = []
    /// Set once a version 2 plan expired: nothing of it is used until `replacePlan` brings a current one.
    private var expired = false
    /// Where `load` asked for the plan, for the renewal of a version 2 plan.
    private var loadURL: URL?
    private var renewal: Task<Void, Never>?
    /// Waits until the renewal is due. Replaced in tests to observe the delay.
    var renewalSleep: (TimeInterval) async -> Void = { seconds in try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
    /// The break the host reports it is playing (`breakStarted`), as the break-card `cut`: `at-<ms>`.
    private var hostCut: AdPlan.Cut?
    /// Bumped by every ad start and end: a card that answers late for an ad already gone is dropped.
    private var spotToken = 0
    /// The app's identity on the GAM requests this reader sends itself (`msid`, `an`). Replaced in tests.
    var appIdentity = AdPlan.bundleIdentity
    /// Waits until a version 2 plan expires. Replaced in tests; setting it reschedules the wait.
    var expirySleep: (TimeInterval) async -> Void = { seconds in try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) } {
        didSet { scheduleExpiry() }
    }
    private var expiryTask: Task<Void, Never>?
    /// The wall clock. Replaced in tests, which run on the fixtures' frozen time.
    let now: () -> Date
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
    /// Past the hold, an engine's ad that was loaded but has not started is given up after this long: IMA's media
    /// timeout (5 s) plus a margin. Any engine is cancelled then, so a silent one cannot hold the content.
    public static let loadedStartLimitSeconds: TimeInterval = 10
    var startLimitSeconds: TimeInterval = ILAdPlanPlayer.loadedStartLimitSeconds
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
          sessionConfiguration: URLSessionConfiguration, events: Events?, now: @escaping () -> Date = Date.init) {
        guard let plan = AdPlan.read(planJSON, now: now(), origin: planOrigin, sessionID: sessionID) else { return nil }
        self.overlay = overlay
        self.player = player
        self.plan = plan
        self.planJSON = planJSON
        self.planOrigin = planOrigin
        self.sessionID = sessionID
        self.now = now
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
        announceSessionMismatch()
        scheduleExpiry()
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

    /// When `load` gets no plan it reports `plan_unavailable` through `events`, once: the format is the reason and the
    /// id is the exact `app` value sent (or that would have been sent). Reasons: `http_<status>` — `http_204` (no plan
    /// right now; ask again on the next view), `http_404` (unknown project, video or app: check that this `app` value is
    /// registered in the Console) or any other status —, `app_id` (a bundle id the server would refuse; nothing is sent),
    /// `request` (the URL cannot be built, e.g. an origin without HTTPS), `timeout`, `network`, `stitched` (a plan with a
    /// server-insertion `timeline`) and `invalid` (any other unreadable answer). A cancelled caller gets nil and no event.
    public static let planTimeoutSeconds: TimeInterval = 5

    /// Requests the plan of `asset` from IL (`GET <origin>/il-player/app-plan?project=…&asset=…&app=apple:<bundle id>`)
    /// and attaches it. Nil means play without ads: no plan right now, an unknown project/video/app, a network failure,
    /// or more than `planTimeoutSeconds` without an answer. Then call `start()` as with the other initialiser.
    public static func load(overlay: ILOverlayPlayerView, player: AVPlayer, origin: String, project: String, asset: String,
                            sessionID: String = "", locale: String = "en", linearEngine: ILLinearAdEngine? = nil,
                            displaySlot: ILDisplayAdSlot? = nil, events: Events? = nil) async -> ILAdPlanPlayer? {
        await load(overlay: overlay, player: player, origin: origin, project: project, asset: asset, sessionID: sessionID,
                   locale: locale, engine: linearEngine, displaySlot: displaySlot, appID: Bundle.main.bundleIdentifier ?? "",
                   sessionConfiguration: .ephemeral, events: events)
    }

    static func load(overlay: ILOverlayPlayerView, player: AVPlayer, origin: String, project: String, asset: String,
                     sessionID: String, locale: String, engine: ILLinearAdEngine?, displaySlot: ILDisplayAdSlot?, appID: String,
                     sessionConfiguration: URLSessionConfiguration, events: Events?,
                     now: @escaping () -> Date = Date.init) async -> ILAdPlanPlayer? {
        let app = "apple:" + appID
        let unavailable = { (reason: String) -> ILAdPlanPlayer? in
            events?("plan_unavailable", reason, app)
            return nil
        }
        // The server's own rule for an Apple bundle id: a refused id is not sent at all.
        guard appID.count <= 149, appID.range(of: "^[A-Za-z0-9-]{1,63}(\\.[A-Za-z0-9-]{1,63}){1,9}$", options: .regularExpression) != nil else {
            return unavailable("app_id")
        }
        guard let url = planURL(origin: origin, project: project, asset: asset, app: app) else { return unavailable("request") }
        let answer = await fetchPlan(url, configuration: sessionConfiguration)
        // The caller gave up (its view went away): nothing is built, installed or scheduled.
        if Task.isCancelled { return nil }
        guard case .success(let (status, data)) = answer else { return unavailable(failureReason(answer)) }
        switch status {
        case 200: break
        // No plan right now: play without ads and ask again on the next view, never in a loop.
        case 204: return unavailable("http_204")
        // Unknown project, video or app give the same 404: the `app` value sent is what to check first.
        case 404: return unavailable("http_404")
        default: return unavailable("http_\(status)")
        }
        guard let reader = ILAdPlanPlayer(overlay: overlay, player: player, planJSON: data, planOrigin: AdPlan.origin(url.absoluteString),
                                          sessionID: sessionID, locale: locale, engine: engine, displaySlot: displaySlot,
                                          sessionConfiguration: sessionConfiguration, events: events, now: now) else {
            // A server-insertion project (`timeline`) is refused by this reader on purpose.
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if let timeline = body?["timeline"], !(timeline is NSNull) { return unavailable("stitched") }
            return unavailable("invalid")
        }
        reader.loadURL = url
        reader.scheduleRenewal()
        return reader
    }

    static func failureReason(_ answer: Result<(Int, Data), Error>) -> String {
        switch answer {
        case .success(let (status, _)): return "http_\(status)"
        case .failure(let error): return (error as? URLError)?.code == .timedOut ? "timeout" : "network"
        }
    }

    /// The app-plan URL, HTTPS only, as every plan and product URL of this SDK.
    static func planURL(origin: String, project: String, asset: String, app: String) -> URL? {
        guard var parts = URLComponents(string: origin), parts.scheme?.lowercased() == "https", parts.host?.isEmpty == false,
              parts.user == nil, parts.password == nil else { return nil }
        parts.path = "/il-player/app-plan"
        parts.fragment = nil
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~:")
        let encode = { (value: String) in value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
        parts.percentEncodedQuery = "project=" + encode(project) + "&asset=" + encode(asset) + "&app=" + encode(app)
        return parts.url
    }

    private static func fetchPlan(_ url: URL, configuration: URLSessionConfiguration) async -> Result<(Int, Data), Error> {
        configuration.timeoutIntervalForRequest = planTimeoutSeconds
        // The whole transfer: a slow plan never holds the content longer than this.
        configuration.timeoutIntervalForResource = planTimeoutSeconds
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failure(URLError(.badServerResponse)) }
            return .success((http.statusCode, data))
        } catch {
            return .failure(error)
        }
    }

    /// A version 2 plan from `load` is asked again about 20 s before it expires, with `renew` so IL keeps the
    /// same commerce session. A renewal that fails lets the plan expire: playback goes on without ads.
    /// Seconds before `expires_at` at which a version 2 plan is asked again: a single 204, timeout or network blip
    /// must not end the view, so up to three attempts, stopping at the first success.
    static let renewalOffsets: [TimeInterval] = [20, 12, 5]

    private func scheduleRenewal() {
        renewal?.cancel()
        guard plan.native, let base = loadURL else { return }
        let expiresAt = plan.expiresAt
        let target = plan.renewGrant.map { URL(string: AdPlan.setQuery(base.absoluteString, "renew", $0)) ?? base } ?? base
        renewal = Task { [weak self] in
            var reason = "network"
            for offset in Self.renewalOffsets {
                guard let self, !Task.isCancelled, !self.closed else { return }
                let sleep = self.renewalSleep
                let wait = expiresAt.timeIntervalSince(self.now()) - offset
                await sleep(max(0, wait))
                guard !Task.isCancelled, !self.closed else { return }
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = self.session.configuration.protocolClasses
                let answer = await Self.fetchPlan(target, configuration: configuration)
                guard !Task.isCancelled, !self.closed else { return }
                if case .success(let (status, data)) = answer, status == 200 {
                    if self.replacePlan(data) {
                        self.emit("plan_renewed", nil, self.plan.native ? "2" : "1")
                        return
                    }
                    reason = "invalid"
                } else {
                    reason = Self.failureReason(answer)
                }
            }
            // Once, after the last attempt; never the URL: it carries the grant.
            guard let self, !Task.isCancelled, !self.closed else { return }
            self.emit("plan_renew_failed", reason, "")
        }
    }

    /// Swaps in a fresh plan for the same video — a renewed version 2 plan, or any plan the host obtained again —
    /// and keeps this view's state: breaks played, windows attempted and shown, products asked, pacing and the session.
    /// False when the plan is unusable; the current one then stays (and still expires on its own).
    @discardableResult
    public func replacePlan(_ json: Data) -> Bool {
        guard !closed, let next = AdPlan.read(json, now: now(), origin: planOrigin, sessionID: sessionID, breaks: hostBreaks) else { return false }
        planJSON = json
        adopt(next)
        if loadURL != nil { scheduleRenewal() }
        return true
    }

    private func adopt(_ next: AdPlan) {
        var kept = AdPlan.Schedule(plan: next)
        kept.settled = schedule.settled
        kept.attempted = schedule.attempted
        kept.products = schedule.products
        kept.shown = schedule.shown
        kept.pending = schedule.pending
        kept.overlayAvailable = schedule.overlayAvailable
        plan = next
        schedule = kept
        expired = false
        // What was drawn from the old plan is rebuilt from the new one; only a running ad's card stays.
        let kept2 = planCues.filter { $0.format == .midroll }
        if kept2.count != planCues.count {
            planCues = kept2
            overlay.setPlanCues(kept2)
        }
        measures = measures.filter { id, _ in kept2.contains { $0.id == id } }
        if displayLive != nil { display?.clear(); displayLive = nil }
        announceSessionMismatch()
        scheduleExpiry()
    }

    private var mismatchAnnounced = false
    /// Buy during a break needs the plan's `commerce.session` as the sid: a host with its own view id is told once.
    private func announceSessionMismatch() {
        guard !mismatchAnnounced, plan.breakURLOffered, plan.breakURL == nil, !plan.breakShop, !sessionID.isEmpty else { return }
        mismatchAnnounced = true
        emit("buy_unavailable", "session", "")
    }

    /// As the web's timer: a paused player or a host break moves no playhead, yet the approval still ends on time.
    private func scheduleExpiry() {
        expiryTask?.cancel()
        expiryTask = nil
        guard plan.native, !closed, !expired else { return }
        let wait = max(0, plan.expiresAt.timeIntervalSince(now()))
        let sleep = expirySleep
        expiryTask = Task { @MainActor [weak self] in
            await sleep(wait)
            guard !Task.isCancelled, let self, !self.closed else { return }
            _ = self.checkExpiry()
        }
    }

    /// The version 2 approval is over: what it drew goes, pending answers are dropped, nothing new starts.
    private func checkExpiry() -> Bool {
        if expired { return true }
        // In milliseconds, like the acceptance rule.
        guard plan.native, Int64((now().timeIntervalSince1970 * 1000).rounded(.down))
                >= Int64((plan.expiresAt.timeIntervalSince1970 * 1000).rounded(.down)) else { return false }
        expired = true
        engine?.cancel()
        display?.clear()
        displayLive = nil
        planCues = []
        overlay.setPlanCues([])
        // A Buy card asked or shown in a host break goes too; the break itself, and the host's player, are the app's.
        spotToken += 1
        if inBreak, overlay.midrollIdentity != nil { overlay.setLinearAdBreak(true) }
        emit("plan_expired", nil, "")
        return true
    }

    // MARK: Host-driven breaks

    /// The positions (content seconds) of the breaks the app itself plays, so graphics keep the plan's clearance.
    public func setBreaks(_ positions: [TimeInterval]) {
        guard !closed else { return }
        hostBreaks = positions.filter { $0.isFinite && $0 >= 0 }.map { Int64(($0 * 1000).rounded()) }
        rebuildForBreaks()
    }

    private func rebuildForBreaks() {
        if let next = AdPlan.read(planJSON, now: now(), origin: planOrigin, sessionID: sessionID, breaks: hostBreaks) {
            adopt(next)
        }
    }

    /// The app started one of its own breaks at `position` (content seconds; 0 for a pre-roll). Until `breakEnded()`
    /// nothing of IL's is drawn except Buy for a reported ad, and answers still pending are dropped.
    public func breakStarted(at position: TimeInterval) {
        guard !closed, !inBreak else { return }
        // One break driver per plan: host calls go with a host plan (`cuts: []`), never with the reader's own breaks.
        guard plan.cuts.isEmpty else {
            emit("break_refused", "plan_has_cuts", "")
            return
        }
        guard position.isFinite, position >= 0 else {
            emit("break_refused", "position", "")
            return
        }
        let ms = Int64((position * 1000).rounded())
        let cut = AdPlan.Cut(id: "at-\(ms)", atMs: ms, requests: [])
        hostCut = cut
        // A break the app did not announce with setBreaks still gets the plan's clearance from now on.
        if !hostBreaks.contains(ms) {
            hostBreaks.append(ms)
            rebuildForBreaks()
        }
        beginBreak(cut.id)
        let token = hostBreakToken
        let limit = hostBreakLimitOverride ?? Self.hostBreakLimitSeconds
        hostGuard = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000))
            guard !Task.isCancelled, let self, !self.closed, self.hostBreakToken == token, self.hostCut != nil else { return }
            // Safety net: the app's ad player never reported the end. Graphics come back for the rest of the view.
            self.hostCut = nil
            self.finishBreak(cut.id, complete: false)
        }
    }

    /// A host break with no `breakEnded()` after this long is treated as over (`break_error`), as no ad of the
    /// reader's own may hold the content past its 180 s cap; this allows a pod of several.
    public static let hostBreakLimitSeconds: TimeInterval = 300
    private var hostGuard: Task<Void, Never>?
    /// Shortened in tests.
    var hostBreakLimitOverride: TimeInterval?
    private var hostBreakToken = 0

    /// An ad of the app's break started, identified by the tag it requested and the VAST `Ad@id` and `Creative@id`
    /// (with IMA: `IMAAd.adId` and `IMAAd.creativeID`). An `il-shop-` ad gets its Buy card.
    public func adStarted(tagURL: String?, adID: String?, creativeID: String?) {
        guard !closed, inBreak, let cut = hostCut else { return }
        spotStarted(cut: cut, tagURL: tagURL, adID: adID, creativeID: creativeID)
    }

    /// The same, from the raw VAST XML of the ad that started.
    public func adStarted(tagURL: String?, vastXML: String) {
        let identity = AdPlan.adIdentity(vastXML)
        adStarted(tagURL: tagURL, adID: identity.adID, creativeID: identity.creativeID)
    }

    /// The ad reported by `adStarted` completed, was skipped or failed: its card goes.
    public func adEnded() {
        guard !closed, inBreak, hostCut != nil else { return }
        spotEnded()
    }

    public func breakEnded() {
        guard !closed, inBreak, let cut = hostCut else { return }
        hostCut = nil
        finishBreak(cut.id, complete: true)
    }

    private func beginBreak(_ id: String) {
        inBreak = true
        firedQuartiles.removeAll()
        if displayLive != nil { display?.setVisible(false) }
        overlay.setLinearAdBreak(true)
        emit("break_start", nil, id)
    }

    private func finishBreak(_ id: String, complete: Bool) {
        hostBreakToken += 1
        hostGuard?.cancel()
        hostGuard = nil
        spotEnded()
        currentAd = nil
        inBreak = false
        overlay.setLinearAdBreak(false)
        emit(complete ? "break_end" : "break_error", nil, id)
    }

    /// One ad of a break started, from the reader's own break or the app's: with `commerce.break_url` and an
    /// `il-shop-` ad of this break's position, its card is asked and Buy drawn while it plays (web/ads.mjs shopAdStarted).
    private func spotStarted(cut: AdPlan.Cut, tagURL: String?, adID: String?, creativeID: String?) {
        spotEnded()
        let tag = tagURL.map { AdPlan.query($0, "tag") } ?? ""
        guard overlay.commerceEnabled, let delivery = AdPlan.shopDelivery(adID: adID, position: cut.position), !tag.isEmpty,
              let creativeID, OverlayCue.validIdentifier(creativeID),
              let target = plan.breakCardURL(cut: cut.id, tag: tag, creative: creativeID, delivery: delivery, locale: locale) else { return }
        overlay.setLinearAdBreak(true, creativeID: creativeID, deliveryID: delivery)
        let token = spotToken
        emit("request", "break_product", cut.id)
        Task { [weak self] in
            guard let self, let (status, data) = await self.body(target), !self.closed, token == self.spotToken, self.inBreak else { return }
            guard status == 200, let card = AdPlan.breakCue(data, creative: creativeID, delivery: delivery) else {
                emit("no_fill", "break_product", cut.id)
                return
            }
            emit("fill", "break_product", cut.id)
            planCues.append(card)
            overlay.setPlanCues(planCues)
        }
    }

    private func spotEnded() {
        spotToken += 1
        let kept = planCues.filter { $0.format != .midroll }
        if kept.count != planCues.count {
            planCues = kept
            overlay.setPlanCues(kept)
        }
        if inBreak, overlay.midrollIdentity != nil { overlay.setLinearAdBreak(true) }
    }

    public func stop() {
        guard !closed else { return }
        closed = true
        renewal?.cancel()
        expiryTask?.cancel()
        if let observer { player.removeTimeObserver(observer) }
        observer = nil
        session.invalidateAndCancel()
        engine?.cancel()
        display?.clear()
        hostGuard?.cancel()
        if inBreak, hostCut != nil {
            // The app owns its break and its player: only the reader's own state and overlay are cleared.
            hostCut = nil
            overlay.setLinearAdBreak(false)
        } else if inBreak {
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
        // The periodic observer also fires when time jumps, so a seek checks the expiry too.
        guard !closed, !checkExpiry() else { return }
        if inBreak { trackQuartiles(); return }
        guard player.timeControlStatus == .playing else {
            if displayLive != nil { display?.setVisible(false) }
            return
        }
        advance(nowMs: positionMs)
    }

    func advance(nowMs now: Int64) {
        guard !closed, !checkExpiry(), !inBreak else { return }
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
        // A task queued before stop() must not use the invalidated session.
        guard !closed else { return nil }
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
        let tag = AdPlan.graphicTag(graphic.tagURL, format: graphic.format, targeting: window.targeting, page: plan.page, app: appIdentity)
        let available = window.end - max(window.start, now)
        Task {
            var answer = AdPlan.GraphicAnswer.unusable
            if let url = URL(string: tag), let (status, data) = await body(url), (200..<300).contains(status) {
                answer = AdPlan.parseGraphic(String(decoding: data, as: UTF8.self), format: graphic.format, availableMs: available)
            }
            guard !closed else { return }
            schedule.pending.removeAll { $0 == window }
            graphicBusy = false
            guard !checkExpiry() else { return }
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
        if filled == true, !inBreak, !checkExpiry(), positionMs < window.end {
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
            guard !checkExpiry() else { return }
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
        // A GAM VAST this reader fetches itself (no engine, or the MP4 fallback) carries the app's identity.
        var next = AdPlan.withAppIdentity(tag, app: appIdentity)
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
        let content = player.currentItem
        let resumeAt = player.currentTime()
        let resumeRate = player.rate
        breakContent = (content, resumeAt)
        player.pause()
        beginBreak(cut.id)
        let deadline = Date().addingTimeInterval(holdSeconds)
        var found: AdPlan.LinearAd?
        var complete = false
        var engineDone = false
        var foundRequest: AdPlan.Request?
        for request in cut.requests where found == nil && !engineDone && !closed && !expired && Date() < deadline {
            emit("break_request", request.provider, cut.id)
            let tag = AdPlan.correlated(request.tagURL)
            var outcome = ILLinearAdOutcome.unavailable
            // iADServer's spot is read here for its Buy identity, and the engine is handed this same answer.
            let fetched = request.provider == "iadserver" || engine == nil ? await linearAd(tag, deadline: deadline) : nil
            guard !closed else { return }
            if let engine, Date() < deadline {
                let spot = plan.breakShop ? fetched?.ad : nil
                let started = StartFlag()
                let limit = deadline.addingTimeInterval(startLimitSeconds)
                let backstop = Task { @MainActor [weak engine] in
                    let wait = limit.timeIntervalSinceNow
                    if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
                    if !Task.isCancelled, !started.value { engine?.cancel() }
                }
                outcome = await engine.playAd(tagURL: tag, adsResponse: fetched?.vast, deadline: deadline) { [weak self] in
                    started.value = true
                    guard let self, !self.closed else { return }
                    self.adBegan(spot, request: request, cut: cut)
                }
                backstop.cancel()
                guard !closed else { return }
            }
            switch outcome {
            case .completed: complete = true; engineDone = true
            case .failed: engineDone = true
            case .noFill: emit("break_no_fill", request.provider, cut.id)
            case .unavailable:
                found = engine == nil || fetched != nil ? fetched?.ad : await linearAd(tag, deadline: deadline)?.ad
                foundRequest = request
                if found == nil, !closed { emit("break_no_fill", request.provider, cut.id) }
            }
        }
        guard !closed else { return }
        // Nothing starts once the hold deadline has passed.
        if let found, let media = found.mediaURL.flatMap(OverlayCue.httpsURL), AdPlan.AdWatch.mayStart(now: Date(), deadline: deadline) {
            let playMedia = self.playMedia
            // As on the web, an approval that expires during the ad ends the break and the content comes back.
            complete = await withTaskGroup(of: Bool?.self) { group in
                group.addTask { @MainActor [weak self] in
                    guard let self else { return false }
                    if let playMedia { return await playMedia(found, media) }
                    return await self.play(found, media: media, deadline: deadline, request: foundRequest, cut: cut)
                }
                group.addTask { @MainActor [weak self] in
                    while !Task.isCancelled {
                        guard let self, !self.closed else { return nil }
                        if self.checkExpiry() { return false }
                        try? await Task.sleep(nanoseconds: 100_000_000)
                    }
                    return nil
                }
                var result = false
                for await value in group {
                    if let value { result = value; break }
                }
                group.cancelAll()
                return result
            }
            guard !closed else { return }
            // The ad leaves the player before graphics are allowed back.
            player.replaceCurrentItem(with: content)
            if resumeAt.seconds > 0 { _ = await player.seek(to: resumeAt, toleranceBefore: .zero, toleranceAfter: .zero) }
            guard !closed else { return }
        }
        breakContent = nil
        finishBreak(cut.id, complete: complete)
        if resumeRate > 0 { player.rate = resumeRate }
    }

    /// The reader's own ad started: Buy through `commerce.break_url` when the plan has it, otherwise the identity of
    /// the VAST `iADServerShop` extension for a host that attached the session feed.
    private func adBegan(_ spot: AdPlan.LinearAd?, request: AdPlan.Request?, cut: AdPlan.Cut) {
        if plan.breakURL != nil {
            spotStarted(cut: cut, tagURL: request?.provider == "iadserver" ? request?.tagURL : nil,
                        adID: spot?.adID, creativeID: spot?.linearCreativeID)
        } else {
            overlay.setLinearAdBreak(true, creativeID: spot?.creativeID, deliveryID: spot?.deliveryID)
        }
    }

    private func play(_ ad: AdPlan.LinearAd, media: URL, deadline: Date, request: AdPlan.Request?, cut: AdPlan.Cut) async -> Bool {
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
                        self.adBegan(self.plan.breakShop ? ad : nil, request: request, cut: cut)
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

#if canImport(UIKit)
import AVFoundation
import UIKit
import XCTest
@testable import ILAVPlayerOverlay

/// Answers by host; `delay` holds an answer, a negative status never answers.
private final class FixtureNetwork: URLProtocol {
    struct Reply { var status: Int; var body: String; var delay: TimeInterval = 0 }
    nonisolated(unsafe) static var replies: [String: Reply] = [:]
    nonisolated(unsafe) static var asked: [String] = []
    private static let lock = NSLock()

    static func reset(_ values: [String: Reply]) {
        lock.lock(); replies = values; asked = []; lock.unlock()
    }
    static var seen: [String] {
        lock.lock(); defer { lock.unlock() }
        return asked
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let url = request.url!
        Self.lock.lock()
        Self.asked.append(url.absoluteString)
        let reply = Self.replies[url.host ?? ""] ?? Reply(status: 204, body: "")
        Self.lock.unlock()
        if reply.status < 0 { return }
        let answer = { [weak self] in
            guard let self else { return }
            self.client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: nil, headerFields: nil)!,
                                     cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
            self.client?.urlProtocolDidFinishLoading(self)
        }
        if reply.delay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + reply.delay, execute: answer) } else { answer() }
    }
}

@MainActor
private final class Engine: ILLinearAdEngine {
    var duringAd: (() async -> Void)?
    func playAd(tagURL: String, adsResponse: String?, deadline: Date, onStart: @escaping () -> Void) async -> ILLinearAdOutcome {
        onStart()
        await duringAd?()
        return .completed
    }
    func cancel() {}
}

@MainActor
final class NativePlayerTests: XCTestCase {
    private var events: [(type: String, format: String?, id: String)] = []
    private var clock = NativeFixtures.frozenNow
    private let consoleHost = "console.example"
    /// The fixture's stable iADServer tag, exactly as the per-break API returns it (with its own `correlator`).
    private var stableTag: String {
        ((try? NativeFixtures.object("break-request-stable"))?["ad_tag_url"] as? String) ?? ""
    }
    private let gamTag = "https://pubads.g.doubleclick.net/gampad/ads?iu=%2F123%2Fpilot&env=vp&gdfp_req=1&output=vast&sz=640x360&cust_params=&correlator=971569889123729"

    private var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureNetwork.self]
        return configuration
    }

    private func record(_ type: String, _ format: String?, _ id: String) { events.append((type, format, id)) }

    private func overlay() -> ILOverlayPlayerView {
        let view = ILOverlayPlayerView(player: AVPlayer())
        view.frame = CGRect(x: 0, y: 0, width: 1280, height: 720)
        view.commerceEnabled = true
        return view
    }

    private func attach(_ json: Data, overlay: ILOverlayPlayerView, engine: ILLinearAdEngine? = nil,
                        sessionID: String = "") throws -> ILAdPlanPlayer {
        try XCTUnwrap(ILAdPlanPlayer(overlay: overlay, player: AVPlayer(), planJSON: json, planOrigin: NativeFixtures.console,
                                     sessionID: sessionID, locale: "es", engine: engine, displaySlot: nil,
                                     sessionConfiguration: configuration,
                                     events: { [weak self] in self?.record($0, $1, $2) }, now: { [weak self] in self?.clock ?? Date() }))
    }

    private func load(_ origin: String = NativeFixtures.console, appID: String = "com.example.app", overlay: ILOverlayPlayerView) async -> ILAdPlanPlayer? {
        await ILAdPlanPlayer.load(overlay: overlay, player: AVPlayer(), origin: origin, project: "proj_8e4cb338d66e4ec6bc6b99fd21f651f6",
                                  asset: "asset-40edc822d6f24974a9af51695a88184b", sessionID: "", locale: "es", engine: nil,
                                  displaySlot: nil, appID: appID, sessionConfiguration: configuration,
                                  events: { [weak self] in self?.record($0, $1, $2) }, now: { [weak self] in self?.clock ?? Date() })
    }

    private let planURL = "https://console.example/il-player/app-plan?project=proj_8e4cb338d66e4ec6bc6b99fd21f651f6&asset=asset-40edc822d6f24974a9af51695a88184b&app=apple:com.example.app"

    private func waitFor(_ check: () -> Bool, _ what: String) async throws {
        for _ in 0..<300 {
            if check() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(what); events \(events.map(\.type)), requests \(FixtureNetwork.seen)")
    }

    private func panel(_ view: ILOverlayPlayerView) -> PlayerCommercePanel? {
        view.subviews.compactMap { $0 as? PlayerCommercePanel }.first
    }

    // MARK: load

    func testLoadAsksTheExactURLAndAttachesThePlan() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v1"))])
        let reader = await load(overlay: overlay())
        XCTAssertNotNil(reader)
        XCTAssertEqual(FixtureNetwork.seen, [planURL])
        XCTAssertEqual(reader?.schedule.plan.cuts.count, 4)
        reader?.stop()
    }

    func testLoadGets204AndPlaysWithoutAdsWithoutRetrying() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 204, body: "")])
        let reader = await load(overlay: overlay())
        XCTAssertNil(reader)
        XCTAssertEqual(FixtureNetwork.seen.count, 1)
        XCTAssertEqual(events.map(\.type), ["plan_unavailable"])
        XCTAssertEqual(events.first?.format, "http_204")
        XCTAssertEqual(events.first?.id, "apple:com.example.app")
    }

    func testLoadGets404AndReportsTheAppValueSent() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 404, body: "")])
        let reader = await load(overlay: overlay())
        XCTAssertNil(reader)
        XCTAssertEqual(events.first?.type, "plan_unavailable")
        XCTAssertEqual(events.first?.format, "http_404")
        XCTAssertEqual(events.first?.id, "apple:com.example.app")
    }

    func testLoadThatNeverAnswersGivesUpWithinTheTimeout() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: -1, body: "")])
        let begun = Date()
        let reader = await load(overlay: overlay())
        XCTAssertNil(reader)
        XCTAssertLessThan(Date().timeIntervalSince(begun), ILAdPlanPlayer.planTimeoutSeconds + 2)
        XCTAssertEqual(events.map(\.type), ["plan_unavailable"])
        XCTAssertEqual(events.first?.format, "timeout")
        XCTAssertEqual(events.first?.id, "apple:com.example.app")
    }

    func testLoadRefusesAPlainHTTPOrigin() async throws {
        FixtureNetwork.reset([:])
        let reader = await load("http://console.example", overlay: overlay())
        XCTAssertNil(reader)
        XCTAssertTrue(FixtureNetwork.seen.isEmpty)
        XCTAssertEqual(events.map(\.type), ["plan_unavailable"])
        XCTAssertEqual(events.first?.format, "request")
    }

    // MARK: version 2: renewal and expiry

    func testAVersion2PlanIsRenewedWithItsGrantAndKeepsTheView() async throws {
        // 15 s before expiry: inside the 20 s margin, so the renewal goes out at once.
        clock = NativeFixtures.frozenNow.addingTimeInterval(105)
        let renewed = try NativeFixtures.text("app-plan-renewed")
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v2"))])
        let loaded = await load(overlay: overlay())
        let reader = try XCTUnwrap(loaded)
        XCTAssertTrue(reader.schedule.plan.native)
        reader.advance(nowMs: 60500)  // mid-1 is just behind; window m2 gets its product asked
        let attempted = reader.schedule.attempted
        let products = reader.schedule.products
        XCTAssertFalse(products.isEmpty)
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: renewed)])
        try await waitFor({ !reader.schedule.plan.native }, "the renewed plan")
        let grant = try XCTUnwrap(AdPlan.query(try NativeFixtures.commerce("app-plan-v2", "url"), "grant").removingPercentEncoding)
        XCTAssertTrue(FixtureNetwork.seen.contains(planURL + "&renew=" + grant), "\(FixtureNetwork.seen)")
        XCTAssertEqual(reader.schedule.attempted, attempted)
        XCTAssertEqual(Set(reader.schedule.products.keys), Set(products.keys))
        XCTAssertEqual(reader.schedule.plan.sid, "178311e8ffa4791646c0d0f6c728aa73")
        reader.stop()
    }

    func testReplacePlanKeepsWhatWasAlreadySettledAndShown() throws {
        let reader = try attach(NativeFixtures.data("app-plan-v1"), overlay: overlay())
        reader.advance(nowMs: 60500)  // mid-1 (58 s) is now behind: settled without playing
        XCTAssertTrue(reader.schedule.settled.contains("mid-1"))
        XCTAssertTrue(reader.replacePlan(try NativeFixtures.data("app-plan-renewed")))
        XCTAssertTrue(reader.schedule.settled.contains("mid-1"))
        XCTAssertFalse(reader.replacePlan(Data("{}".utf8)), "an unusable plan leaves the current one")
        XCTAssertEqual(reader.schedule.plan.cuts.count, 4)
        reader.stop()
    }

    func testAVersion2PlanStopsAtExpiryUntilAFreshOneArrives() throws {
        FixtureNetwork.reset([:])
        let view = overlay()
        let reader = try attach(NativeFixtures.data("app-plan-v2"), overlay: view)
        clock = NativeFixtures.frozenNow.addingTimeInterval(121)
        reader.advance(nowMs: 1000)
        XCTAssertEqual(events.map(\.type), ["plan_expired"])
        XCTAssertTrue(FixtureNetwork.seen.isEmpty, "nothing asked under an expired approval")
        reader.advance(nowMs: 2000)
        XCTAssertEqual(events.count, 1, "said once")
        // A fresh approval resumes the same view.
        clock = NativeFixtures.frozenNow
        XCTAssertTrue(reader.replacePlan(try NativeFixtures.data("app-plan-v2")))
        reader.advance(nowMs: 60500)
        XCTAssertTrue(events.contains { $0.type == "request" })
        reader.stop()
    }

    // MARK: Buy during the reader's own break through commerce.break_url

    func testTheReadersOwnBreakAsksTheBreakCardWithThePlanCut() async throws {
        let vast = """
        <VAST version="4.0"><Ad id="il-shop-preroll-\(NativeFixtures.delivery)"><InLine><Creatives><Creative id="cr1"><Linear>\
        <Duration>00:00:10</Duration><MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="640">https://c.example/a.mp4</MediaFile>\
        </MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>
        """
        var card = try NativeFixtures.object("break-product-card-page")
        card["id"] = NativeFixtures.delivery
        FixtureNetwork.reset(["ads.iadserver.com": .init(status: 200, body: vast),
                              consoleHost: .init(status: 200, body: String(decoding: try NativeFixtures.data(card), as: UTF8.self))])
        let view = overlay()
        let engine = Engine()
        let reader = try attach(NativeFixtures.data("app-plan-v1"), overlay: view, engine: engine)
        var drawn = false
        engine.duringAd = { [weak self] in
            try? await self?.waitFor({ self?.events.contains { $0.type == "fill" && $0.format == "break_product" } == true }, "break card")
            view.showMidroll(at: Date())
            drawn = self?.panel(view) != nil
        }
        await reader.start()
        let breakURL = try NativeFixtures.commerce("app-plan-v1", "break_url")
        XCTAssertTrue(FixtureNetwork.seen.contains(breakURL + "&cut=pre&tag=T_pre&creative=cr1&delivery=" + NativeFixtures.delivery + "&locale=es"),
                      "\(FixtureNetwork.seen)")
        XCTAssertTrue(drawn)
        XCTAssertFalse(view.isInLinearAdBreak)
        XCTAssertNil(panel(view))
        reader.stop()
    }

    // MARK: Host-driven breaks

    func testAReportedBreakDrawsNothingButBuyForAReportedAd() async throws {
        let card = try NativeFixtures.text("break-product-card")
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: card)])
        let view = overlay()
        let reader = try attach(NativeFixtures.data("host-plan"), overlay: view)
        await reader.start()
        XCTAssertTrue(FixtureNetwork.seen.isEmpty, "a host plan requests and plays no video ad")
        reader.breakStarted(at: 58)
        XCTAssertTrue(view.isInLinearAdBreak)
        XCTAssertEqual(events.last?.type, "break_start")
        XCTAssertEqual(events.last?.id, "at-58000")
        // Content time inside a window: nothing is asked or drawn while the break is on.
        reader.advance(nowMs: 59000)
        XCTAssertTrue(FixtureNetwork.seen.isEmpty)
        reader.adStarted(tagURL: stableTag, adID: "il-shop-midroll-" + NativeFixtures.delivery, creativeID: "cr1")
        try await waitFor({ self.events.contains { $0.type == "fill" && $0.format == "break_product" } }, "break card")
        XCTAssertTrue(stableTag.contains("&correlator="), "the fixture tag carries the backend's correlator")
        let breakURL = try NativeFixtures.commerce("host-plan", "break_url")
        XCTAssertEqual(FixtureNetwork.seen, [breakURL + "&cut=at-58000&tag=T_mid&creative=cr1&delivery=" + NativeFixtures.delivery + "&locale=es"])
        XCTAssertEqual(view.midrollIdentity?.creative, "cr1")
        XCTAssertEqual(view.midrollIdentity?.delivery, NativeFixtures.delivery)
        view.showMidroll(at: Date())
        XCTAssertNotNil(panel(view), "Buy is drawn during the reported ad")
        reader.adEnded()
        view.showMidroll(at: Date())
        XCTAssertNil(panel(view), "the card goes with its ad")
        XCTAssertTrue(view.isInLinearAdBreak)
        reader.breakEnded()
        XCTAssertFalse(view.isInLinearAdBreak)
        XCTAssertEqual(events.last?.type, "break_end")
        reader.stop()
    }

    func testTheVASTVariantAndTheIdentityRules() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("break-product-card"))])
        let reader = try attach(NativeFixtures.data("host-plan"), overlay: overlay())
        await reader.start()
        reader.breakStarted(at: 178)
        // A GAM ad (no il-shop id), a wrong position and an ad with no tag: no product, no call.
        reader.adStarted(tagURL: gamTag, adID: "123456", creativeID: "c9")
        reader.adStarted(tagURL: stableTag, adID: "il-shop-preroll-" + NativeFixtures.delivery, creativeID: "cr1")
        reader.adStarted(tagURL: nil, adID: "il-shop-midroll-" + NativeFixtures.delivery, creativeID: "cr1")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(FixtureNetwork.seen.isEmpty)
        let vast = """
        <VAST version="4.0"><Ad id="il-shop-midroll-\(NativeFixtures.delivery)"><InLine><Creatives><Creative id="cr1"><Linear>\
        <Duration>00:00:10</Duration></Linear></Creative></Creatives></InLine></Ad></VAST>
        """
        reader.adStarted(tagURL: stableTag, vastXML: vast)
        try await waitFor({ !FixtureNetwork.seen.isEmpty }, "break card request")
        XCTAssertTrue(FixtureNetwork.seen[0].contains("&cut=at-178000&tag=T_mid&creative=cr1&delivery=" + NativeFixtures.delivery))
        reader.breakEnded()
        reader.stop()
    }

    func testAPrerollReportIsAt0() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 204, body: "")])
        let reader = try attach(NativeFixtures.data("host-plan"), overlay: overlay())
        await reader.start()
        reader.breakStarted(at: 0)
        reader.adStarted(tagURL: stableTag, adID: "il-shop-preroll-" + NativeFixtures.delivery, creativeID: "cr1")
        try await waitFor({ self.events.contains { $0.type == "no_fill" } }, "a 204 card")
        XCTAssertTrue(FixtureNetwork.seen[0].contains("&cut=at-0&"))
        reader.stop()
    }

    func testAGraphicAnswerPendingWhenTheBreakStartsIsDroppedAndGraphicsResumeAfter() async throws {
        let graphic = """
        <VAST version="4.0"><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><NonLinearAds>\
        <NonLinear width="600" height="90"><StaticResource creativeType="image/png">https://c.example/s.png</StaticResource></NonLinear>\
        </NonLinearAds></Creative></Creatives></InLine></Ad></VAST>
        """
        var plan = try NativeFixtures.object("host-plan")
        plan["commerce"] = nil   // graphics only, so the first window goes to a graphic
        FixtureNetwork.reset(["pubads.g.doubleclick.net": .init(status: 200, body: graphic, delay: 0.3)])
        let reader = try attach(NativeFixtures.data(plan), overlay: overlay())
        await reader.start()
        reader.advance(nowMs: 15000)
        XCTAssertEqual(events.last?.type, "request")
        reader.breakStarted(at: 15)
        try await waitFor({ reader.schedule.pending.isEmpty }, "the graphic answer")
        XCTAssertFalse(events.contains { $0.type == "fill" }, "nothing drawn over the app's break")
        XCTAssertTrue(reader.schedule.shown.isEmpty)
        reader.breakEnded()
        reader.advance(nowMs: 50000)
        XCTAssertEqual(events.last?.type, "request")
        XCTAssertEqual(events.last?.id, "m1")
        try await waitFor({ self.events.contains { $0.type == "fill" } }, "a graphic after the break")
        reader.stop()
    }

    func testAHostThatReportsNothingGetsGraphicsByContentTimeAndNoBuy() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("scene-product-card"))])
        let view = overlay()
        let reader = try attach(NativeFixtures.data("host-plan"), overlay: view)
        await reader.start()
        reader.advance(nowMs: 1000)
        try await waitFor({ self.events.contains { $0.type == "fill" } }, "scene product")
        XCTAssertEqual(events.first { $0.type == "fill" }?.format, "scene_product")
        XCTAssertTrue(FixtureNetwork.seen.allSatisfy { $0.contains("/il-player/scene-product?") && $0.contains("&host=1&window=p1&locale=es") })
        XCTAssertFalse(events.contains { $0.format == "break_product" })
        XCTAssertNil(view.midrollIdentity)
        reader.stop()
    }

    func testReportsOutsideABreakAreIgnored() throws {
        FixtureNetwork.reset([:])
        let reader = try attach(NativeFixtures.data("host-plan"), overlay: overlay())
        reader.adStarted(tagURL: stableTag, adID: "il-shop-midroll-" + NativeFixtures.delivery, creativeID: "cr1")
        reader.adEnded()
        reader.breakEnded()
        XCTAssertTrue(events.isEmpty)
        XCTAssertTrue(FixtureNetwork.seen.isEmpty)
        reader.stop()
    }

    func testSetBreaksAppliesTheClearanceToTheRunningReader() throws {
        var plan = try NativeFixtures.object("host-plan")
        var scenes = try XCTUnwrap(plan["scenes"] as? [String: Any])
        scenes["pacing"] = ["min_seconds": 1.5, "cut_clearance_seconds": 10]
        plan["scenes"] = scenes
        let reader = try attach(NativeFixtures.data(plan), overlay: overlay())
        XCTAssertTrue(reader.schedule.plan.windows.contains { $0.id == "m1" })
        reader.setBreaks([58, 178])
        XCTAssertEqual(reader.schedule.plan.windows.map(\.id), ["p1", "p2", "m3"])
        reader.stop()
    }
    // MARK: review rules

    /// Every string the host can observe: event types, formats and ids.
    private var observed: String { events.map { "\($0.type)|\($0.format ?? "")|\($0.id)" }.joined(separator: "\n") }

    func testTheGrantNeverReachesTheHost() async throws {
        let grants = try ["app-plan-v1", "app-plan-v2", "host-plan"].map { AdPlan.query(try NativeFixtures.commerce($0, "url"), "grant") }
        // load + renewal (v2, inside the renewal margin) + scene card
        clock = NativeFixtures.frozenNow.addingTimeInterval(105)
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v2"))])
        let loaded = await load(overlay: overlay())
        let reader = try XCTUnwrap(loaded)
        reader.renewalSleep = { _ in }   // the retries at −12 s and −5 s run at once
        FixtureNetwork.reset([consoleHost: .init(status: 500, body: "")])
        reader.advance(nowMs: 60500)
        try await waitFor({ self.events.contains { $0.type == "plan_renew_failed" } }, "failed renewal")
        reader.stop()
        // break card in host mode
        clock = NativeFixtures.frozenNow
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("break-product-card"))])
        let host = try attach(NativeFixtures.data("host-plan"), overlay: overlay())
        host.breakStarted(at: 58)
        host.adStarted(tagURL: stableTag, adID: "il-shop-midroll-" + NativeFixtures.delivery, creativeID: "cr1")
        try await waitFor({ self.events.contains { $0.format == "break_product" && $0.type == "fill" } }, "break card")
        host.stop()
        for grant in grants { XCTAssertFalse(observed.contains(grant)) }
        XCTAssertFalse(observed.contains("renew="))
        XCTAssertFalse(observed.contains("/il-player/"))
    }

    func testABundleIDTheServerWouldRefuseIsNotSent() async throws {
        FixtureNetwork.reset([:])
        let reader = await load(appID: "not a bundle", overlay: overlay())
        XCTAssertNil(reader)
        XCTAssertTrue(FixtureNetwork.seen.isEmpty)
        XCTAssertEqual(events.first?.type, "plan_unavailable")
        XCTAssertEqual(events.first?.format, "app_id")
        XCTAssertEqual(events.first?.id, "apple:not a bundle")
    }

    func testAHostBreakNeverEndedIsReleasedByTheSafetyNet() async throws {
        FixtureNetwork.reset([:])
        let view = overlay()
        let reader = try attach(NativeFixtures.data("host-plan"), overlay: view)
        reader.hostBreakLimitOverride = 0.2
        reader.breakStarted(at: 30)
        try await waitFor({ self.events.last?.type == "break_error" }, "the safety net")
        XCTAssertEqual(events.last?.id, "at-30000")
        XCTAssertFalse(view.isInLinearAdBreak)
        reader.advance(nowMs: 50000)
        XCTAssertEqual(events.last?.type, "request", "graphics resume")
        reader.stop()
    }

    func testStopExpiryAndReplaceDuringAHostBreakLeaveTheHostsPlayerAlone() async throws {
        FixtureNetwork.reset([:])
        let avPlayer = AVPlayer()
        let content = AVPlayerItem(url: URL(fileURLWithPath: "/dev/null"))
        avPlayer.replaceCurrentItem(with: content)
        avPlayer.rate = 1
        let view = overlay()
        let reader = try XCTUnwrap(ILAdPlanPlayer(overlay: view, player: avPlayer, planJSON: hostPlanV2(),
                                                  planOrigin: NativeFixtures.console, sessionID: "", locale: "es", engine: nil,
                                                  displaySlot: nil, sessionConfiguration: configuration,
                                                  events: { [weak self] in self?.record($0, $1, $2) }, now: { [weak self] in self?.clock ?? Date() }))
        reader.breakStarted(at: 30)
        XCTAssertTrue(reader.replacePlan(try hostPlanV2()))
        clock = NativeFixtures.frozenNow.addingTimeInterval(121)
        reader.advance(nowMs: 31000)
        XCTAssertTrue(events.contains { $0.type == "plan_expired" })
        reader.stop()
        XCTAssertTrue(avPlayer.currentItem === content)
        XCTAssertEqual(avPlayer.rate, 1, "never paused or played by the reader")
        XCTAssertFalse(view.isInLinearAdBreak)
    }

    func testAtMsRoundsToTheNearestMillisecondAndRefusesBadPositions() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 204, body: "")])
        let reader = try attach(NativeFixtures.data("host-plan"), overlay: overlay())
        reader.breakStarted(at: -1)
        reader.breakStarted(at: .nan)
        XCTAssertEqual(events.filter { $0.type == "break_refused" && $0.format == "position" }.count, 2)
        XCTAssertFalse(events.contains { $0.type == "break_start" })
        reader.breakStarted(at: 57.9996)
        XCTAssertEqual(events.last?.id, "at-58000")
        reader.breakEnded()
        reader.stop()
    }

    func testAV1RenewalAnswerStopsRenewingAndRebuildsTheCues() async throws {
        clock = NativeFixtures.frozenNow.addingTimeInterval(105)
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v2"))])
        let loaded = await load(overlay: overlay())
        let reader = try XCTUnwrap(loaded)
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-renewed"))])
        try await waitFor({ !reader.schedule.plan.native }, "the v1 answer")
        let asked = FixtureNetwork.seen.count
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(FixtureNetwork.seen.filter { $0.contains("app-plan") }.count, FixtureNetwork.seen.prefix(asked).filter { $0.contains("app-plan") }.count,
                       "no further renewals for a v1 plan")
        XCTAssertEqual(reader.schedule.plan.cuts.map(\.id), ["pre", "mid-1", "mid-3", "mid-4"], "cuts rebuilt from the new plan")
        reader.stop()
    }

    func testAV2AnswerToAV1PlanStartsRenewals() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v1"))])
        let loaded = await load(overlay: overlay())
        let reader = try XCTUnwrap(loaded)
        clock = NativeFixtures.frozenNow.addingTimeInterval(105)
        var v2 = try NativeFixtures.object("app-plan-v2")
        v2["expires_at"] = "2026-11-02T16:02:00.000Z"
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try String(decoding: NativeFixtures.data(v2), as: UTF8.self))])
        XCTAssertTrue(reader.replacePlan(try NativeFixtures.data(v2)))
        try await waitFor({ FixtureNetwork.seen.contains { $0.contains("&renew=") } }, "a renewal")
        reader.stop()
    }

    func testExpiryIsComparedInMilliseconds() throws {
        let reader = try attach(NativeFixtures.data("app-plan-v2"), overlay: overlay())
        clock = NativeFixtures.frozenNow.addingTimeInterval(119.9994)
        reader.advance(nowMs: 60500)
        XCTAssertFalse(events.contains { $0.type == "plan_expired" })
        clock = NativeFixtures.frozenNow.addingTimeInterval(120)
        reader.advance(nowMs: 60600)
        XCTAssertTrue(events.contains { $0.type == "plan_expired" })
        reader.stop()
    }

    func testAHostWithItsOwnSessionIsToldOnceThatBuyDuringBreaksIsOff() throws {
        let reader = try attach(NativeFixtures.data("host-plan"), overlay: overlay(), sessionID: "app-view-1")
        XCTAssertTrue(reader.replacePlan(try NativeFixtures.data("host-plan")))
        XCTAssertEqual(events.filter { $0.type == "buy_unavailable" }.count, 1)
        XCTAssertEqual(events.first?.format, "session")
        reader.stop()
    }

    func testAHostPlanWithoutBreakURLHasNoBuyAndSaysNothing() async throws {
        var plan = try NativeFixtures.object("host-plan")
        var commerce = try XCTUnwrap(plan["commerce"] as? [String: Any])
        commerce["break_url"] = nil
        plan["commerce"] = commerce
        FixtureNetwork.reset([:])
        let reader = try attach(NativeFixtures.data(plan), overlay: overlay(), sessionID: "app-view-1")
        reader.breakStarted(at: 58)
        reader.adStarted(tagURL: stableTag, adID: "il-shop-midroll-" + NativeFixtures.delivery, creativeID: "cr1")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(FixtureNetwork.seen.isEmpty)
        XCTAssertEqual(events.map(\.type), ["break_start"])
        reader.stop()
    }

    func testClearanceAppliesOnlyAroundReportedBreaks() throws {
        var plan = try NativeFixtures.object("host-plan")
        var scenes = try XCTUnwrap(plan["scenes"] as? [String: Any])
        scenes["pacing"] = ["min_seconds": 1.5, "cut_clearance_seconds": 10]
        plan["scenes"] = scenes
        let reader = try attach(NativeFixtures.data(plan), overlay: overlay())
        XCTAssertEqual(reader.schedule.plan.windows.count, 6, "nothing reported, no clearance")
        reader.breakStarted(at: 178)   // not announced with setBreaks
        reader.breakEnded()
        XCTAssertFalse(reader.schedule.plan.windows.contains { $0.id == "t1" }, "a reported break gets its clearance")
        reader.stop()
    }

    func testGAMRequestsTheReaderSendsCarryTheAppIdentity() async throws {
        let app = (id: "com.example.app", name: "Example App")
        let tag = AdPlan.graphicTag("https://pubads.g.doubleclick.net/gampad/ads?iu=/1/a", format: "super", targeting: [:], page: nil, app: app)
        XCTAssertEqual(AdPlan.query(tag, "msid"), "com.example.app")
        XCTAssertEqual(AdPlan.query(tag, "an"), "Example App")
        XCTAssertEqual(AdPlan.query(tag, "url"), "")
        XCTAssertEqual(AdPlan.query(tag, "description_url"), "")
        // A tag that already names the app keeps its values; other hosts are untouched.
        let own = AdPlan.withAppIdentity("https://pubads.g.doubleclick.net/gampad/ads?msid=x.y&an=Mine", app: app)
        XCTAssertEqual(AdPlan.query(own, "msid"), "x.y")
        XCTAssertEqual(AdPlan.query(own, "an"), "Mine")
        XCTAssertEqual(AdPlan.withAppIdentity("https://ads.iadserver.com/gampad/ads?tag=t", app: app), "https://ads.iadserver.com/gampad/ads?tag=t")
        // The MP4 path (no engine) fetches the GAM VAST with the identity.
        FixtureNetwork.reset([:])
        let reader = try attach(try NativeFixtures.data([
            "version": 1, "expires_at": "2099-01-01T00:00:00Z",
            "cuts": [["id": "pre", "at": 0, "tag_url": "https://pubads.g.doubleclick.net/gampad/ads?iu=/1/a"]]]), overlay: overlay())
        reader.appIdentity = app
        await reader.start()
        let asked = try XCTUnwrap(FixtureNetwork.seen.first { $0.contains("doubleclick") })
        XCTAssertTrue(asked.contains("msid=com.example.app") && asked.contains("an=Example%20App"), asked)
        reader.stop()
    }
    func testAStitchedOrUnreadablePlanIsReportedWithItsReason() async throws {
        var stitched = try NativeFixtures.object("app-plan-v1")
        stitched["timeline"] = ["kind": "stitched", "pdt_origin": "2026-11-02T16:00:00Z"]
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: String(decoding: try NativeFixtures.data(stitched), as: UTF8.self))])
        let first = await load(overlay: overlay())
        XCTAssertNil(first)
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: "not json")])
        let second = await load(overlay: overlay())
        XCTAssertNil(second)
        XCTAssertEqual(events.map { "\($0.type) \($0.format ?? "")" }, ["plan_unavailable stitched", "plan_unavailable invalid"])
    }

    func testThreeFailedRenewalsAt20_12And5SecondsSayFailedOnceThenThePlanExpires() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v1"))])
        let loaded = await load(overlay: overlay())
        let reader = try XCTUnwrap(loaded)
        var waits: [TimeInterval] = []
        // The injected sleep moves the clock by what it was asked to wait.
        reader.renewalSleep = { [weak self] seconds in
            waits.append(seconds)
            self?.clock.addTimeInterval(seconds)
        }
        FixtureNetwork.reset([consoleHost: .init(status: 500, body: "")])
        XCTAssertTrue(reader.replacePlan(try NativeFixtures.data("app-plan-v2")))   // expires at now + 120 s
        try await waitFor({ self.events.contains { $0.type == "plan_renew_failed" } }, "the last attempt")
        XCTAssertEqual(waits.count, 3)
        XCTAssertEqual(waits[0], 100, accuracy: 0.001)   // expires_at − 20 s
        XCTAssertEqual(waits[1], 8, accuracy: 0.001)     // − 12 s
        XCTAssertEqual(waits[2], 7, accuracy: 0.001)     // − 5 s
        XCTAssertEqual(FixtureNetwork.seen.filter { $0.contains("&renew=") }.count, 3)
        XCTAssertEqual(events.filter { $0.type == "plan_renew_failed" }.count, 1)
        XCTAssertEqual(events.last?.format, "http_500")
        // The current approval stays until it expires, then stops.
        XCTAssertTrue(reader.schedule.plan.native)
        reader.advance(nowMs: 60500)
        XCTAssertFalse(events.contains { $0.type == "plan_expired" })
        clock = NativeFixtures.frozenNow.addingTimeInterval(120)
        reader.advance(nowMs: 60600)
        XCTAssertEqual(events.filter { $0.type == "plan_expired" }.count, 1)
        reader.stop()
    }

    func testARenewalThatFailsOnceSucceedsOnTheSecondAttempt() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v1"))])
        let loaded = await load(overlay: overlay())
        let reader = try XCTUnwrap(loaded)
        let renewed = try NativeFixtures.text("app-plan-renewed")
        var calls = 0
        reader.renewalSleep = { [weak self] seconds in
            calls += 1
            self?.clock.addTimeInterval(seconds)
            // The first attempt gets a 204; the second gets the renewed plan.
            FixtureNetwork.reset([self?.consoleHost ?? "": calls == 1 ? .init(status: 204, body: "") : .init(status: 200, body: renewed)])
        }
        XCTAssertTrue(reader.replacePlan(try NativeFixtures.data("app-plan-v2")))
        try await waitFor({ self.events.contains { $0.type == "plan_renewed" } }, "the renewal")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(calls, 2, "stops at the first success")
        XCTAssertEqual(events.filter { $0.type == "plan_renewed" }.count, 1)
        XCTAssertFalse(events.contains { $0.type == "plan_renew_failed" })
        XCTAssertFalse(reader.schedule.plan.native)
        reader.stop()
    }

    func testASuccessfulRenewalSaysSoWithTheNewVersion() async throws {
        clock = NativeFixtures.frozenNow.addingTimeInterval(105)
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v2"))])
        let loaded = await load(overlay: overlay())
        let reader = try XCTUnwrap(loaded)
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-renewed"))])
        try await waitFor({ self.events.contains { $0.type == "plan_renewed" } }, "plan_renewed")
        XCTAssertEqual(events.first { $0.type == "plan_renewed" }?.id, "1")
        reader.stop()
    }

    func testExpiryDuringTheReadersMP4AdEndsTheBreakAndBringsTheContentBack() async throws {
        let vast = """
        <VAST><Ad><InLine><Creatives><Creative><Linear><Duration>00:00:30</Duration><MediaFiles>\
        <MediaFile delivery="progressive" type="video/mp4" width="640">https://c.example/a.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>
        """
        FixtureNetwork.reset(["ads.iadserver.com": .init(status: 200, body: vast)])
        let avPlayer = AVPlayer()
        // A content item that does not fail on its own (a /dev/null item fails and the simulator's player drops it).
        let composition = AVMutableComposition()
        composition.insertEmptyTimeRange(CMTimeRange(start: .zero, duration: CMTime(seconds: 60, preferredTimescale: 600)))
        let content = AVPlayerItem(asset: composition)
        avPlayer.replaceCurrentItem(with: content)
        avPlayer.rate = 1
        let reader = try XCTUnwrap(ILAdPlanPlayer(overlay: overlay(), player: avPlayer, planJSON: NativeFixtures.data("app-plan-v2"),
                                                  planOrigin: NativeFixtures.console, sessionID: "", locale: "es", engine: nil,
                                                  displaySlot: nil, sessionConfiguration: configuration,
                                                  events: { [weak self] in self?.record($0, $1, $2) }, now: { [weak self] in self?.clock ?? Date() }))
        reader.playMedia = { [weak self] _, url in
            avPlayer.replaceCurrentItem(with: AVPlayerItem(url: url))
            self?.clock = NativeFixtures.frozenNow.addingTimeInterval(121)
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            return true
        }
        let begun = Date()
        await reader.start()
        XCTAssertLessThan(Date().timeIntervalSince(begun), 5, "the ad does not run to its end")
        XCTAssertTrue(events.contains { $0.type == "plan_expired" })
        XCTAssertEqual(events.last?.type, "break_error")
        XCTAssertTrue(avPlayer.currentItem === content)
        XCTAssertEqual(avPlayer.rate, 1, "playing as it was")
        reader.stop()
    }
    /// The host plan as a version 2 approval (the backend sends one when the GAM campaign has a native approval).
    private func hostPlanV2() throws -> Data {
        var plan = try NativeFixtures.object("host-plan")
        plan["version"] = 2
        plan["native_gam"] = ["contract": "native-gam-plan-v1"]
        plan["expires_at"] = "2026-11-02T16:02:00.000Z"
        return try NativeFixtures.data(plan)
    }

    func testAVersion2PlanExpiresOnTimeWhileThePlayerIsPaused() async throws {
        FixtureNetwork.reset([:])
        let reader = try attach(NativeFixtures.data("app-plan-v2"), overlay: overlay())
        var waits: [TimeInterval] = []
        var release: CheckedContinuation<Void, Never>?
        reader.expirySleep = { seconds in
            waits.append(seconds)
            await withCheckedContinuation { release = $0 }
        }
        try await waitFor({ release != nil }, "the expiry wait")
        XCTAssertEqual(waits, [120], "slept until expires_at")
        // No tick, no advance: the playhead does not move.
        clock = NativeFixtures.frozenNow.addingTimeInterval(120)
        release?.resume()
        try await waitFor({ self.events.contains { $0.type == "plan_expired" } }, "plan_expired")
        XCTAssertEqual(events.filter { $0.type == "plan_expired" }.count, 1)
        reader.stop()
    }

    func testAVersion2PlanExpiringDuringAHostBreakRemovesBuyAndLeavesThePlayer() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("break-product-card"))])
        let avPlayer = AVPlayer()
        let content = AVPlayerItem(url: URL(fileURLWithPath: "/dev/null"))
        avPlayer.replaceCurrentItem(with: content)
        avPlayer.rate = 1
        let view = overlay()
        let reader = try XCTUnwrap(ILAdPlanPlayer(overlay: view, player: avPlayer, planJSON: hostPlanV2(),
                                                  planOrigin: NativeFixtures.console, sessionID: "", locale: "es", engine: nil,
                                                  displaySlot: nil, sessionConfiguration: configuration,
                                                  events: { [weak self] in self?.record($0, $1, $2) }, now: { [weak self] in self?.clock ?? Date() }))
        var release: CheckedContinuation<Void, Never>?
        reader.expirySleep = { _ in await withCheckedContinuation { release = $0 } }
        reader.breakStarted(at: 58)
        reader.adStarted(tagURL: stableTag, adID: "il-shop-midroll-" + NativeFixtures.delivery, creativeID: "cr1")
        try await waitFor({ self.events.contains { $0.type == "fill" && $0.format == "break_product" } }, "Buy")
        view.showMidroll(at: Date())
        XCTAssertNotNil(panel(view))
        clock = NativeFixtures.frozenNow.addingTimeInterval(121)
        try await waitFor({ release != nil }, "the expiry wait")
        release?.resume()
        try await waitFor({ self.events.contains { $0.type == "plan_expired" } }, "plan_expired")
        view.showMidroll(at: Date())
        XCTAssertNil(panel(view), "Buy removed at expiry")
        XCTAssertEqual(events.filter { $0.type == "plan_expired" }.count, 1)
        XCTAssertTrue(avPlayer.currentItem === content)
        XCTAssertEqual(avPlayer.rate, 1)
        reader.stop()
        XCTAssertTrue(avPlayer.currentItem === content)
        XCTAssertEqual(avPlayer.rate, 1)
    }

    func testACancelledLoadBuildsNothing() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v2"), delay: 0.3)])
        let view = overlay()
        let task = Task { await self.load(overlay: view) }
        try await Task.sleep(nanoseconds: 50_000_000)
        task.cancel()
        let reader = await task.value
        XCTAssertNil(reader)
        XCTAssertTrue(events.isEmpty, "no event for a caller that gave up")
    }

    func testHostCallsOnAPlanWithItsOwnCutsAreRefused() throws {
        FixtureNetwork.reset([:])
        let view = overlay()
        let reader = try attach(NativeFixtures.data("app-plan-v1"), overlay: view)
        reader.breakStarted(at: 58)
        XCTAssertEqual(events.map { "\($0.type) \($0.format ?? "")" }, ["break_refused plan_has_cuts"])
        XCTAssertFalse(view.isInLinearAdBreak)
        reader.stop()
    }

    func testARenewalThatTimesOutSaysTimeout() {
        XCTAssertEqual(ILAdPlanPlayer.failureReason(.failure(URLError(.timedOut))), "timeout")
        XCTAssertEqual(ILAdPlanPlayer.failureReason(.failure(URLError(.notConnectedToInternet))), "network")
        XCTAssertEqual(ILAdPlanPlayer.failureReason(.success((503, Data()))), "http_503")
    }
    func testARenewalFailingAtTheLastMomentSendsNothingPastExpiry() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v1"))])
        let loaded = await load(overlay: overlay())
        let reader = try XCTUnwrap(loaded)
        var calls = 0
        reader.renewalSleep = { [weak self] seconds in
            calls += 1
            self?.clock.addTimeInterval(seconds)
            // The first attempt answers at expires_at − 2 s: the −12 s slot is missed (goes at once), then the clock
            // reaches expiry before the −5 s slot.
            if calls == 2 { self?.clock = NativeFixtures.frozenNow.addingTimeInterval(118) }
            // The second attempt's answer takes until expiry: the −5 s slot is past it.
            if calls == 3 { self?.clock = NativeFixtures.frozenNow.addingTimeInterval(120) }
        }
        FixtureNetwork.reset([consoleHost: .init(status: 204, body: "")])
        XCTAssertTrue(reader.replacePlan(try NativeFixtures.data("app-plan-v2")))
        try await waitFor({ self.events.contains { $0.type == "plan_renew_failed" } }, "plan_renew_failed")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(FixtureNetwork.seen.filter { $0.contains("&renew=") }.count, 2, "no request at or past expiry")
        XCTAssertEqual(events.filter { $0.type == "plan_renew_failed" }.count, 1)
        XCTAssertEqual(events.first { $0.type == "plan_renew_failed" }?.format, "http_204")
        reader.stop()
    }

    func testALateRenewalAnswerAfterStopIsIgnored() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v1"))])
        let loaded = await load(overlay: overlay())
        let reader = try XCTUnwrap(loaded)
        reader.renewalSleep = { _ in }
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-renewed"), delay: 0.3)])
        XCTAssertTrue(reader.replacePlan(try NativeFixtures.data("app-plan-v2")))
        try await waitFor({ FixtureNetwork.seen.contains { $0.contains("&renew=") } }, "the attempt")
        reader.stop()
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertFalse(events.contains { $0.type == "plan_renewed" || $0.type == "plan_renew_failed" })
        XCTAssertTrue(reader.schedule.plan.native, "the late plan was not adopted")
    }
    func testAPlanThatExpiresBeforeAnyRenewalAttemptSaysOnlyExpired() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 200, body: try NativeFixtures.text("app-plan-v1"))])
        let loaded = await load(overlay: overlay())
        let reader = try XCTUnwrap(loaded)
        var release: CheckedContinuation<Void, Never>?
        // The first wait outlasts the plan (an app suspended past expiry, for example).
        reader.renewalSleep = { [weak self] _ in
            self?.clock = NativeFixtures.frozenNow.addingTimeInterval(130)
            await withCheckedContinuation { release = $0 }
        }
        FixtureNetwork.reset([:])
        XCTAssertTrue(reader.replacePlan(try NativeFixtures.data("app-plan-v2")))
        try await waitFor({ release != nil }, "the first wait")
        reader.advance(nowMs: 60500)
        XCTAssertEqual(events.map(\.type), ["plan_expired"])
        release?.resume()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(events.map(\.type), ["plan_expired"], "no plan_renew_failed without an attempt")
        XCTAssertFalse(FixtureNetwork.seen.contains { $0.contains("&renew=") })
        reader.stop()
    }
}
#endif

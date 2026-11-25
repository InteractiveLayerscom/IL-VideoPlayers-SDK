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
    private let stableTag = "https://ads.iadserver.com/gampad/ads?tag=T_mid&output=vast&vid=asset-40edc822d6f24974a9af51695a88184b&cue_seconds=58&sid=ed4c7d84521a3bc4faba519c687146f0"
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

    private func load(_ origin: String = NativeFixtures.console, overlay: ILOverlayPlayerView) async -> ILAdPlanPlayer? {
        await ILAdPlanPlayer.load(overlay: overlay, player: AVPlayer(), origin: origin, project: "proj_8e4cb338d66e4ec6bc6b99fd21f651f6",
                                  asset: "asset-40edc822d6f24974a9af51695a88184b", sessionID: "", locale: "es", engine: nil,
                                  displaySlot: nil, appID: "com.example.app", sessionConfiguration: configuration,
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
        XCTAssertEqual(events.map(\.type), ["plan_no_content"])
    }

    func testLoadGets404AndReportsTheAppValueSent() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: 404, body: "")])
        let reader = await load(overlay: overlay())
        XCTAssertNil(reader)
        XCTAssertEqual(events.first?.type, "plan_not_found")
        XCTAssertEqual(events.first?.id, "apple:com.example.app")
    }

    func testLoadThatNeverAnswersGivesUpWithinTheTimeout() async throws {
        FixtureNetwork.reset([consoleHost: .init(status: -1, body: "")])
        let begun = Date()
        let reader = await load(overlay: overlay())
        XCTAssertNil(reader)
        XCTAssertLessThan(Date().timeIntervalSince(begun), ILAdPlanPlayer.planTimeoutSeconds + 2)
        XCTAssertEqual(events.map(\.type), ["plan_error"])
    }

    func testLoadRefusesAPlainHTTPOrigin() async throws {
        FixtureNetwork.reset([:])
        let reader = await load("http://console.example", overlay: overlay())
        XCTAssertNil(reader)
        XCTAssertTrue(FixtureNetwork.seen.isEmpty)
        XCTAssertEqual(events.map(\.type), ["plan_error"])
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
}
#endif

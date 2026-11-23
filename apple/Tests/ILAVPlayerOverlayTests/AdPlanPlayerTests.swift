#if canImport(UIKit)
import AVFoundation
import UIKit
import XCTest
@testable import ILAVPlayerOverlay

private final class StubNetwork: URLProtocol {
    nonisolated(unsafe) static var replies: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var asked: [String] = []
    private static let lock = NSLock()

    static func reset(_ values: [String: (Int, String)]) {
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
        let (status, body) = Self.replies[url.host ?? ""] ?? (204, "")
        Self.lock.unlock()
        // A server that never answers.
        if status < 0 { return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
private final class FakeEngine: ILLinearAdEngine {
    var outcomes: [ILLinearAdOutcome]
    var tags: [String] = []
    var responses: [String?] = []
    var duringAd: (() -> Void)?
    init(_ outcomes: [ILLinearAdOutcome]) { self.outcomes = outcomes }

    func playAd(tagURL: String, adsResponse: String?, deadline: Date, onStart: @escaping () -> Void) async -> ILLinearAdOutcome {
        tags.append(tagURL)
        responses.append(adsResponse)
        let outcome = outcomes.removeFirst()
        if outcome != .noFill {
            onStart()
            duringAd?()
        }
        return outcome
    }
    func cancel() {}
}

@MainActor
private final class FakeSlot: ILDisplayAdSlot {
    var unit: String?
    var targeting: [String: String] = [:]
    var answered: ((Bool) -> Void)?
    var impression: (() -> Void)?
    var visible: Bool?
    var cleared = 0
    func request(adUnit: String, targeting: [String: String], answered: @escaping (Bool) -> Void, onImpression: @escaping () -> Void) {
        unit = adUnit
        self.targeting = targeting
        self.answered = answered
        impression = onImpression
    }
    func setVisible(_ visible: Bool) { self.visible = visible }
    func clear() { cleared += 1; visible = false }
}

@MainActor
final class AdPlanPlayerTests: XCTestCase {
    private let gam = "https://pubads.g.doubleclick.net/gampad/ads?iu=/1/a"
    private let iad = "https://ads.iadserver.com/gampad/ads?tag=t"
    private var events: [(type: String, format: String?, id: String)] = []

    private func make(_ plan: [String: Any], engine: ILLinearAdEngine?, slot: ILDisplayAdSlot? = nil, sessionID: String = "s1",
                      avPlayer: AVPlayer = AVPlayer()) throws -> (ILAdPlanPlayer, ILOverlayPlayerView) {
        var full = plan
        full["version"] = 1
        full["expires_at"] = "2099-01-01T00:00:00Z"
        let overlay = ILOverlayPlayerView(player: AVPlayer())
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubNetwork.self]
        let player = try XCTUnwrap(ILAdPlanPlayer(
            overlay: overlay, player: avPlayer, planJSON: JSONSerialization.data(withJSONObject: full),
            planOrigin: "https://il.example", sessionID: sessionID, locale: "es", engine: engine, displaySlot: slot,
            sessionConfiguration: configuration, events:  { [weak self] type, format, id in self?.events.append((type, format, id)) }))
        overlay.frame = CGRect(x: 0, y: 0, width: 1280, height: 720)
        return (player, overlay)
    }

    private func waitFor(_ type: String) async throws {
        for _ in 0..<200 {
            if events.contains(where: { $0.type == type }) { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("no \(type) event, saw \(events.map(\.type))")
    }

    func testAPrerollFallsThroughToTheNextRequest() async throws {
        StubNetwork.reset([:])
        let engine = FakeEngine([.noFill, .completed])
        let (player, overlay) = try make(["cuts": [["id": "pre", "at": 0, "requests": [
            ["provider": "gam", "tag_url": gam], ["provider": "gam", "tag_url": gam + "&b=2"]]]]], engine: engine)
        await player.start()
        XCTAssertEqual(engine.tags.count, 2)
        XCTAssertTrue(engine.tags[1].contains("b=2") && engine.tags[1].contains("correlator="))
        XCTAssertEqual(events.map(\.type), ["break_start", "break_request", "break_no_fill", "break_request", "break_end"])
        XCTAssertFalse(overlay.isInLinearAdBreak)
        player.stop()
    }

    func testAnEmptyBreakEndsWithContentFree() async throws {
        StubNetwork.reset([:])
        let (player, overlay) = try make(["cuts": [["id": "pre", "at": 0, "tag_url": gam]]], engine: FakeEngine([.noFill]))
        await player.start()
        XCTAssertEqual(events.last?.type, "break_error")
        XCTAssertFalse(overlay.isInLinearAdBreak)
        player.stop()
    }

    func testTheSpotIdentityReachesTheOverlayForBuy() async throws {
        let vast = """
        <VAST><Ad><InLine><Creatives><Creative><Linear><Duration>00:00:10</Duration><MediaFiles>\
        <MediaFile delivery="progressive" type="video/mp4" width="640">https://c.example/a.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives>\
        <Extensions><Extension type="iADServerShop"><Shop deliveryId="d1" creativeId="c1"/></Extension></Extensions></InLine></Ad></VAST>
        """
        StubNetwork.reset(["ads.iadserver.com": (200, vast)])
        let engine = FakeEngine([.completed])
        let (player, overlay) = try make(["cuts": [["id": "pre", "at": 0, "requests": [["provider": "iadserver", "tag_url": iad]]]],
                                          "commerce": shop(session: "s1")], engine: engine)
        var during: (creative: String, delivery: String)?
        engine.duringAd = { during = overlay.midrollIdentity }
        await player.start()
        XCTAssertEqual(during?.creative, "c1")
        XCTAssertEqual(during?.delivery, "d1")
        XCTAssertNil(overlay.midrollIdentity)
        // The VAST read for the identity is the one IMA plays: iADServer is asked once.
        XCTAssertEqual(engine.responses.first ?? nil, vast)
        XCTAssertEqual(StubNetwork.seen.filter { $0.contains("iadserver") }.count, 1)
        player.stop()
    }

    private func shop(session: String) -> [String: Any] {
        ["kind": "scene_product", "url": "https://il.example/p", "lead_ms": 1000, "session": session,
         "pacing": ["min_seconds": 5], "windows": [] as [Any]]
    }

    func testNoBuyDuringABreakWhenTheSidIsNotThePlansSession() async throws {
        let vast = """
        <VAST><Ad><InLine><Creatives><Creative><Linear><Duration>00:00:10</Duration><MediaFiles>\
        <MediaFile delivery="progressive" type="video/mp4" width="640">https://c.example/a.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives>\
        <Extensions><Extension type="iADServerShop"><Shop deliveryId="d1" creativeId="c1"/></Extension></Extensions></InLine></Ad></VAST>
        """
        StubNetwork.reset(["ads.iadserver.com": (200, vast)])
        let engine = FakeEngine([.completed])
        let (player, overlay) = try make(["cuts": [["id": "pre", "at": 0, "requests": [["provider": "iadserver", "tag_url": iad]]]],
                                          "commerce": shop(session: "plan-s")], engine: engine, sessionID: "host-s")
        var during: (creative: String, delivery: String)? = ("x", "x")
        engine.duringAd = { during = overlay.midrollIdentity }
        await player.start()
        XCTAssertNil(during)
        XCTAssertTrue(engine.tags.first?.contains("sid=host-s") == true)
        player.stop()
    }

    func testAnAdServerThatNeverAnswersCannotHoldTheBreak() async throws {
        StubNetwork.reset(["ads.iadserver.com": (-1, "")])
        let engine = FakeEngine([.completed])
        let (player, overlay) = try make(["cuts": [["id": "pre", "at": 0, "requests": [["provider": "iadserver", "tag_url": iad]]]]], engine: engine)
        player.holdSeconds = 0.3
        let begun = Date()
        await player.start()
        XCTAssertLessThan(Date().timeIntervalSince(begun), 2)
        XCTAssertTrue(engine.tags.isEmpty, "no engine once the deadline has passed")
        XCTAssertEqual(events.last?.type, "break_error")
        XCTAssertFalse(overlay.isInLinearAdBreak)
        player.stop()
    }

    func testStopDuringAnMP4AdBringsTheContentBackPaused() async throws {
        StubNetwork.reset(["pubads.g.doubleclick.net": (200, linearVast)])
        let avPlayer = AVPlayer()
        let content = AVPlayerItem(url: URL(fileURLWithPath: "/dev/null"))
        avPlayer.replaceCurrentItem(with: content)
        let (player, overlay) = try make(["cuts": [["id": "pre", "at": 0, "tag_url": gam]]], engine: nil, avPlayer: avPlayer)
        player.playMedia = { [weak player] _, url in
            avPlayer.replaceCurrentItem(with: AVPlayerItem(url: url))
            avPlayer.rate = 1
            player?.stop()
            return true
        }
        await player.start()
        XCTAssertTrue(avPlayer.currentItem === content)
        XCTAssertEqual(avPlayer.rate, 0)
        XCTAssertFalse(overlay.isInLinearAdBreak)
        XCTAssertFalse(events.contains { $0.type == "break_end" })
    }

    func testAGraphicIsAskedAndFills() async throws {
        let vast = """
        <VAST version="4.0"><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><NonLinearAds>\
        <NonLinear width="600" height="90"><StaticResource creativeType="image/png">https://c.example/s.png</StaticResource></NonLinear>\
        </NonLinearAds></Creative></Creatives></InLine></Ad></VAST>
        """
        StubNetwork.reset(["pubads.g.doubleclick.net": (200, vast)])
        let (player, _) = try make(["scenes": ["formats": ["super"], "graphics": [["format": "super", "tag_url": gam]],
                                               "pacing": ["min_seconds": 5], "windows": [["id": "w1", "start_ms": 10000, "end_ms": 25000]]] as [String: Any]],
                                   engine: nil)
        await player.start()
        player.advance(nowMs: 7000)
        try await waitFor("fill")
        XCTAssertEqual(events.first?.type, "request")
        XCTAssertEqual(events.last?.id, "w1")
        player.stop()
    }

    func testAProductWinsItsWindow() async throws {
        let card: [String: Any] = ["id": "card", "window": "w1", "format": "overlay", "start": 0, "end": 99000,
                                   "imageUrl": "https://c.example/p.jpg",
                                   "commerce": ["title": "Botines", "price": "50", "currency": "USD", "locale": "es",
                                                "handoffUrl": "https://il.example/h", "variants": [["id": "42", "label": "42"]]] as [String: Any]]
        let body = String(decoding: try JSONSerialization.data(withJSONObject: card), as: UTF8.self)
        StubNetwork.reset(["il.example": (200, body)])
        let window: [String: Any] = ["id": "w1", "start_ms": 10000, "end_ms": 25000]
        let (player, _) = try make(["scenes": ["formats": ["super"], "graphics": [["format": "super", "tag_url": gam]],
                                               "pacing": ["min_seconds": 5], "windows": [window]] as [String: Any],
                                    "commerce": ["kind": "scene_product", "url": "https://il.example/p?g=1", "lead_ms": 1000,
                                                 "pacing": ["min_seconds": 5], "windows": [window]] as [String: Any]], engine: nil)
        await player.start()
        player.advance(nowMs: 9500)
        try await waitFor("fill")
        XCTAssertEqual(events.last?.format, "scene_product")
        XCTAssertTrue(StubNetwork.seen.first?.hasPrefix("https://il.example/p?g=1&window=w1&locale=es") == true)
        XCTAssertFalse(StubNetwork.seen.contains { $0.contains("doubleclick") })
        player.stop()
    }

    private let linearVast = """
    <VAST><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><Linear><Duration>00:00:10</Duration><MediaFiles>\
    <MediaFile delivery="progressive" type="video/mp4" width="640">https://c.example/a.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>
    """

    func testAnAnswerIMACannotRunFallsBackToMP4() async throws {
        StubNetwork.reset(["pubads.g.doubleclick.net": (200, linearVast)])
        let engine = FakeEngine([.unavailable])
        let (player, _) = try make(["cuts": [["id": "pre", "at": 0, "tag_url": gam]]], engine: engine)
        var played: URL?
        player.playMedia = { _, url in played = url; return true }
        await player.start()
        XCTAssertEqual(played?.absoluteString, "https://c.example/a.mp4")
        XCTAssertEqual(StubNetwork.seen.first, engine.tags.first)
        XCTAssertEqual(events.last?.type, "break_end")
        player.stop()
    }

    func testAnEmptyIMAAnswerDoesNotTryMP4() async throws {
        StubNetwork.reset(["pubads.g.doubleclick.net": (200, linearVast)])
        let (player, _) = try make(["cuts": [["id": "pre", "at": 0, "tag_url": gam]]], engine: FakeEngine([.noFill]))
        player.playMedia = { _, _ in XCTFail("no MP4 after an empty answer"); return true }
        await player.start()
        XCTAssertTrue(StubNetwork.seen.isEmpty)
        player.stop()
    }

    func testAnAdThatFailedAfterStartingAsksNoMore() async throws {
        StubNetwork.reset([:])
        let engine = FakeEngine([.failed, .completed])
        let (player, _) = try make(["cuts": [["id": "pre", "at": 0, "requests": [
            ["provider": "gam", "tag_url": gam], ["provider": "gam", "tag_url": gam + "&b=2"]]]]], engine: engine)
        await player.start()
        XCTAssertEqual(engine.tags.count, 1)
        XCTAssertEqual(events.last?.type, "break_error")
        player.stop()
    }

    private func overlayScenes() -> [String: Any] {
        ["scenes": ["formats": ["overlay_300x250"], "overlay": ["ad_unit": "/123/site/overlay"], "pacing": ["min_seconds": 5],
                    "windows": [["id": "w1", "start_ms": 0, "end_ms": 25000, "targeting": ["topic": ["a", "b"]]]]] as [String: Any]]
    }

    func testTheOverlayIsAskedShownAndCountedOnce() async throws {
        StubNetwork.reset([:])
        let slot = FakeSlot()
        let (player, _) = try make(overlayScenes(), engine: nil, slot: slot)
        await player.start()
        player.advance(nowMs: 1000)
        XCTAssertEqual(slot.unit, "/123/site/overlay")
        XCTAssertEqual(slot.targeting["topic"], "a,b")
        XCTAssertEqual(slot.targeting["il_format"], "overlay_300x250")
        slot.answered?(true)
        XCTAssertEqual(slot.visible, true)
        slot.impression?()
        slot.impression?()
        XCTAssertEqual(events.filter { $0.type == "impression" }.count, 1)
        player.advance(nowMs: 26000)
        XCTAssertEqual(slot.cleared, 1)
        player.stop()
    }

    func testAnOverlayWithoutASlotIsNotAsked() async throws {
        StubNetwork.reset([:])
        let (player, _) = try make(overlayScenes(), engine: nil)
        await player.start()
        player.advance(nowMs: 1000)
        XCTAssertTrue(events.isEmpty)
        player.stop()
    }

    func testAnEmptyOverlayClearsItsSlot() async throws {
        StubNetwork.reset([:])
        let slot = FakeSlot()
        let (player, _) = try make(overlayScenes(), engine: nil, slot: slot)
        await player.start()
        player.advance(nowMs: 1000)
        slot.answered?(false)
        XCTAssertEqual(events.last?.type, "no_fill")
        XCTAssertEqual(slot.cleared, 1)
        player.stop()
    }
}
#endif

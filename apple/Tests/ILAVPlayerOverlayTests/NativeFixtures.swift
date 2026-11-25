import Foundation
import XCTest
@testable import ILAVPlayerOverlay

/// The shared fixtures in test/fixtures/native: real IL answers, frozen at 2026-11-02T16:00:00Z.
enum NativeFixtures {
    /// The fixtures' console is `http://localhost:8000`; the SDK only follows HTTPS, so tests serve them from here.
    static let console = "https://console.example"
    static let frozenNow = Date(timeIntervalSince1970: 1_793_635_200)
    static let delivery = String(repeating: "D", count: 43)

    static func text(_ name: String) throws -> String {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../test/fixtures/native").standardized
        let raw = try String(contentsOf: folder.appendingPathComponent(name + ".json"), encoding: .utf8)
        return raw.replacingOccurrences(of: "http://localhost:8000", with: console)
    }

    static func data(_ name: String) throws -> Data { Data(try text(name).utf8) }

    static func object(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data(name)) as? [String: Any])
    }

    static func data(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object) }

    static func commerce(_ name: String, _ key: String) throws -> String {
        try XCTUnwrap((object(name)["commerce"] as? [String: Any])?[key] as? String)
    }
}

final class NativePlanTests: XCTestCase {
    private let now = NativeFixtures.frozenNow

    private func read(_ data: Data, at time: Date? = nil, sessionID: String = "", breaks: [Int64] = []) -> AdPlan? {
        AdPlan.read(data, now: time ?? now, origin: NativeFixtures.console, sessionID: sessionID, breaks: breaks)
    }

    func testTheVersion1AppPlanIsAcceptedUntilItExpires() throws {
        let plan = try XCTUnwrap(read(NativeFixtures.data("app-plan-v1")))
        XCTAssertFalse(plan.native)
        XCTAssertEqual(plan.cuts.map(\.id), ["pre", "mid-1", "mid-3", "mid-4"])
        XCTAssertEqual(plan.cuts.map(\.position), ["preroll", "midroll", "midroll", "midroll"])
        XCTAssertEqual(plan.sid, "178311e8ffa4791646c0d0f6c728aa73")
        XCTAssertNotNil(plan.shop)
        XCTAssertNil(read(try NativeFixtures.data("app-plan-v1"), at: now.addingTimeInterval(900)), "expired at 16:15")
    }

    func testTheVersion2PlanIsAcceptedOnlyUnderTheNativeContractAndTwoMinutes() throws {
        let v2 = try NativeFixtures.object("app-plan-v2")
        let plan = try XCTUnwrap(read(NativeFixtures.data(v2)))
        XCTAssertTrue(plan.native)
        XCTAssertEqual(plan.expiresAt, now.addingTimeInterval(120))
        // 121 s ahead of the clock: refused, as web/ads.mjs readPlan.
        XCTAssertNil(read(try NativeFixtures.data(v2), at: now.addingTimeInterval(-1)))
        XCTAssertNil(read(try NativeFixtures.data(v2), at: now.addingTimeInterval(120)), "expired")
        var wrong = v2
        wrong["native_gam"] = ["contract": "native-gam-plan-v2"]
        XCTAssertNil(read(try NativeFixtures.data(wrong)))
        wrong["native_gam"] = nil
        XCTAssertNil(read(try NativeFixtures.data(wrong)))
        var v3 = v2
        v3["version"] = 3
        XCTAssertNil(read(try NativeFixtures.data(v3)))
        var fractional = try NativeFixtures.object("app-plan-v1")
        fractional["version"] = 1.5
        XCTAssertNil(read(try NativeFixtures.data(fractional)))
        // Version 1 does not need the contract and may last longer.
        XCTAssertNotNil(read(try NativeFixtures.data("app-plan-v1")))
    }

    func testTheRenewGrantIsTheGrantOfCommerceURL() throws {
        let plan = try XCTUnwrap(read(NativeFixtures.data("app-plan-v1")))
        let url = try NativeFixtures.commerce("app-plan-v1", "url")
        XCTAssertEqual(plan.renewGrant, AdPlan.query(url, "grant"))
        XCTAssertEqual(plan.renewGrant, "1793639100.178311e8ffa4791646c0d0f6c728aa73.600687f5743c48db.4dcba3919b8dc03db03d06fdf95fb8f489b26a9ff2e86ae03cd9a1019f36777a")
    }

    func testTheBreakCardURLForAPlanCut() throws {
        let plan = try XCTUnwrap(read(NativeFixtures.data("app-plan-v1")))
        let breakURL = try NativeFixtures.commerce("app-plan-v1", "break_url")
        let url = plan.breakCardURL(cut: "pre", tag: "T_pre", creative: "cr1", delivery: NativeFixtures.delivery, locale: "es-AR")
        XCTAssertEqual(url?.absoluteString, breakURL + "&cut=pre&tag=T_pre&creative=cr1&delivery=" + NativeFixtures.delivery + "&locale=es")
    }

    func testTheBreakCardURLForAHostBreak() throws {
        let plan = try XCTUnwrap(read(NativeFixtures.data("host-plan")))
        XCTAssertTrue(plan.cuts.isEmpty)
        let breakURL = try NativeFixtures.commerce("host-plan", "break_url")
        XCTAssertTrue(breakURL.hasSuffix("&host=1"))
        let url = plan.breakCardURL(cut: "at-58000", tag: "T_mid", creative: "cr1", delivery: NativeFixtures.delivery, locale: "es")
        XCTAssertEqual(url?.absoluteString, breakURL + "&cut=at-58000&tag=T_mid&creative=cr1&delivery=" + NativeFixtures.delivery + "&locale=es")
    }

    func testNoBreakURLWhenTheSidIsNotThePlansSessionOrTheOriginDiffers() throws {
        XCTAssertNil(read(try NativeFixtures.data("app-plan-v1"), sessionID: "host-own-view")?.breakURL)
        var plan = try NativeFixtures.object("app-plan-v1")
        var commerce = try XCTUnwrap(plan["commerce"] as? [String: Any])
        commerce["break_url"] = "https://elsewhere.example/il-player/break-product?grant=x"
        plan["commerce"] = commerce
        XCTAssertNil(read(try NativeFixtures.data(plan))?.breakURL)
        commerce["break_url"] = nil
        plan["commerce"] = commerce
        XCTAssertNil(read(try NativeFixtures.data(plan))?.breakURL)
    }

    func testOnlyAnIlShopAdOfTheBreaksPositionHasADelivery() {
        let id = NativeFixtures.delivery
        XCTAssertEqual(AdPlan.shopDelivery(adID: "il-shop-midroll-" + id, position: "midroll"), id)
        XCTAssertEqual(AdPlan.shopDelivery(adID: "il-shop-preroll-" + id, position: "preroll"), id)
        XCTAssertNil(AdPlan.shopDelivery(adID: "il-shop-preroll-" + id, position: "midroll"))
        XCTAssertNil(AdPlan.shopDelivery(adID: "il-shop-midroll-" + id.dropLast(), position: "midroll"))
        XCTAssertNil(AdPlan.shopDelivery(adID: "1234567", position: "midroll"))
        XCTAssertNil(AdPlan.shopDelivery(adID: nil, position: "midroll"))
    }

    func testTheBreakCardIsTheAdsOwnAndFollowsTheAd() throws {
        let data = try NativeFixtures.data("break-product-card")
        let cue = try XCTUnwrap(AdPlan.breakCue(data, creative: "cr1", delivery: NativeFixtures.delivery))
        XCTAssertEqual(cue.format, .midroll)
        XCTAssertNotNil(cue.commerce?.viewURL)
        XCTAssertTrue(cue.start <= Date() && Date() < cue.end)
        XCTAssertNil(AdPlan.breakCue(data, creative: "cr2", delivery: NativeFixtures.delivery))
        XCTAssertNil(AdPlan.breakCue(data, creative: "cr1", delivery: String(repeating: "E", count: 43)))
        XCTAssertNil(AdPlan.breakCue(try NativeFixtures.data("scene-product-card"), creative: "cr1", delivery: "dlv_fixture_0001"))
        XCTAssertNotNil(AdPlan.breakCue(try NativeFixtures.data("break-product-card-page"), creative: "cr1", delivery: NativeFixtures.delivery))
    }

    func testTheAdIdentityIsReadFromRawVAST() {
        let xml = """
        <VAST version="4.0"><Ad id="il-shop-midroll-\(NativeFixtures.delivery)"><InLine><Creatives>\
        <Creative id="cr1"><Linear><Duration>00:00:10</Duration></Linear></Creative></Creatives></InLine></Ad></VAST>
        """
        let identity = AdPlan.adIdentity(xml)
        XCTAssertEqual(identity.adID, "il-shop-midroll-" + NativeFixtures.delivery)
        XCTAssertEqual(identity.creativeID, "cr1")
        XCTAssertNil(AdPlan.adIdentity("not xml").adID)
    }

    func testReportedBreaksKeepTheClearance() throws {
        var plan = try NativeFixtures.object("host-plan")
        var scenes = try XCTUnwrap(plan["scenes"] as? [String: Any])
        var pacing = try XCTUnwrap(scenes["pacing"] as? [String: Any])
        pacing["cut_clearance_seconds"] = 10
        scenes["pacing"] = pacing
        plan["scenes"] = scenes
        let data = try NativeFixtures.data(plan)
        XCTAssertEqual(read(data)?.windows.map(\.id), ["p1", "p2", "m1", "m2", "t1", "m3"], "no break reported")
        // m1 (50-58 s) and m2 (60-63 s) are within 10 s of a break at 58 s.
        let clipped = try XCTUnwrap(read(data, breaks: [58000]))
        XCTAssertEqual(clipped.windows.map(\.id), ["p1", "p2", "t1", "m3"])
    }
}

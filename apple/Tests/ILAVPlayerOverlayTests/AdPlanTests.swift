import XCTest
@testable import ILAVPlayerOverlay

final class AdPlanTests: XCTestCase {
    private let gam = "https://pubads.g.doubleclick.net/gampad/ads?iu=/1/a&cust_params=x%3D1"
    private let iad = "https://ads.iadserver.com/gampad/ads?tag=t&output=vast"
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func fixture(_ extra: [String: Any] = [:]) -> [String: Any] {
        var plan: [String: Any] = [
            "version": 1, "expires_at": "2099-01-01T00:00:00Z", "page_url": "https://site.example/v",
            "cuts": [
                ["id": "mid", "at": 60, "requests": [["provider": "iadserver", "tag_url": iad], ["provider": "gam", "tag_url": gam],
                                                     ["provider": "evil", "tag_url": "https://evil.example/"]]],
                ["id": "pre", "at": 0, "tag_url": gam],
                ["id": "bad", "at": 5, "requests": [["provider": "gam", "tag_url": "http://pubads.g.doubleclick.net/gampad/ads"]]]
            ],
            "scenes": [
                "formats": ["l_shape", "super", "overlay_300x250"],
                "graphics": [["format": "super", "tag_url": gam], ["format": "l_shape", "tag_url": gam],
                             ["format": "super", "tag_url": "https://evil.example/ads"]],
                "pacing": ["min_seconds": 5, "max_seconds": 12, "gap_after_seconds": 2, "cut_clearance_seconds": 3, "max_per_video": 2],
                "windows": [["id": "w3", "start_ms": 55000, "end_ms": 75000], ["id": "w2", "start_ms": 20000, "end_ms": 35000],
                            ["id": "w1", "start_ms": 10000, "end_ms": 25000, "targeting": ["topic": ["a", "b"]]]]
            ] as [String: Any]
        ]
        plan.merge(extra) { _, new in new }
        return plan
    }

    private func read(_ plan: [String: Any]) throws -> AdPlan? {
        AdPlan.read(try JSONSerialization.data(withJSONObject: plan), now: now, origin: "https://il.example", sessionID: "sid1")
    }

    private func graphicVast(_ width: Int = 600, _ height: Int = 90, image: String = "https://c.example/a.png") -> String {
        """
        <VAST version="4.0"><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><NonLinearAds>\
        <TrackingEvents><Tracking event="creativeView">https://t.example/v</Tracking></TrackingEvents>\
        <NonLinear width="\(width)" height="\(height)" minSuggestedDuration="00:00:05">\
        <StaticResource creativeType="image/png"><![CDATA[\(image)]]></StaticResource></NonLinear>\
        </NonLinearAds></Creative></Creatives></InLine></Ad></VAST>
        """
    }

    func testReadsCutsInOrderWithOnlyAllowedRequests() throws {
        let plan = try XCTUnwrap(read(fixture()))
        XCTAssertEqual(plan.cuts.map(\.id), ["pre", "mid"])
        XCTAssertEqual(plan.cuts[1].requests.map(\.provider), ["iadserver", "gam"])
        XCTAssertTrue(plan.cuts[1].requests[0].tagURL.contains("sid=sid1"))
        XCTAssertFalse(plan.cuts[1].requests[1].tagURL.contains("sid="))
        XCTAssertTrue(plan.cuts[1].requests[1].tagURL.contains("description_url="))
    }

    func testAppliesWindowCapsClearanceAndGraphicOrder() throws {
        let plan = try XCTUnwrap(read(fixture()))
        XCTAssertEqual(plan.graphics.map(\.format), ["l_shape", "super"])
        XCTAssertEqual(plan.windows.map(\.id), ["w1", "w2"])
        XCTAssertEqual(plan.windows[0].end, 22000)
        XCTAssertEqual(plan.windows[0].targeting["topic"], "a,b")
    }

    func testRefusesExpiredStitchedAndUnknownPlans() throws {
        XCTAssertNil(try read(fixture(["expires_at": "2001-01-01T00:00:00Z"])))
        XCTAssertNil(try read(fixture(["version": 2])))
        XCTAssertNil(try read(fixture(["timeline": ["kind": "stitched"]])))
        XCTAssertNil(AdPlan.read(Data("nope".utf8), now: now, origin: nil, sessionID: "s"))
    }

    func testTakesAProductOnlyFromThePlanOrigin() throws {
        var commerce: [String: Any] = ["kind": "scene_product", "url": "https://other.example/p", "lead_ms": 1000,
                                       "pacing": ["min_seconds": 5], "windows": [["id": "w1", "start_ms": 10000, "end_ms": 25000]]]
        XCTAssertNil(try XCTUnwrap(read(fixture(["commerce": commerce]))).shop)
        commerce["url"] = "https://il.example/p?g=1"
        let plan = try XCTUnwrap(read(fixture(["commerce": commerce])))
        XCTAssertEqual(plan.productURL(windowID: "w 1", locale: "es-AR")?.absoluteString, "https://il.example/p?g=1&window=w%201&locale=es")
    }

    func testSchedulesBreaksWithoutABacklog() throws {
        let plan = try XCTUnwrap(read(fixture()))
        var schedule = AdPlan.Schedule(plan: plan)
        XCTAssertEqual(schedule.join(positionMs: 0)?.id, "pre")
        schedule.settled.insert("pre")
        XCTAssertNil(schedule.dueCut(nowMs: 59000))
        XCTAssertEqual(schedule.dueCut(nowMs: 60500)?.id, "mid")
        var late = AdPlan.Schedule(plan: plan)
        XCTAssertNil(late.join(positionMs: 5000))
        XCTAssertNil(late.dueCut(nowMs: 90000))
        XCTAssertTrue(late.settled.isSuperset(of: ["pre", "mid"]))
    }

    func testPacingSpacesGraphicsAndAWindowWaitsForItsProduct() throws {
        var schedule = AdPlan.Schedule(plan: try XCTUnwrap(read(fixture())))
        XCTAssertNil(schedule.nextGraphic(nowMs: 5000))
        let first = try XCTUnwrap(schedule.nextGraphic(nowMs: 7000))
        XCTAssertEqual(first.id, "w1")
        schedule.attempted.insert(first.id)
        schedule.shown.append(first)
        XCTAssertNil(schedule.nextGraphic(nowMs: 21000))
        let commerce: [String: Any] = ["kind": "scene_product", "url": "https://il.example/p", "lead_ms": 1000,
                                       "pacing": ["min_seconds": 5], "windows": [["id": "w1", "start_ms": 10000, "end_ms": 25000]]]
        var waiting = AdPlan.Schedule(plan: try XCTUnwrap(read(fixture(["commerce": commerce]))))
        XCTAssertNil(waiting.nextGraphic(nowMs: 7000))
        waiting.products["w1"] = "empty"
        XCTAssertEqual(waiting.nextGraphic(nowMs: 7000)?.id, "w1")
    }

    func testBuildsTheGraphicTag() {
        let tag = AdPlan.graphicTag(gam, format: "super", targeting: ["topic": "a,b"], page: "https://p.example/")
        let params = AdPlan.query(tag, "cust_params")
        XCTAssertTrue(params.contains("x=1") && params.contains("il_format=super") && params.contains("topic=a%2Cb"), params)
        XCTAssertFalse(AdPlan.query(tag, "correlator").isEmpty)
        XCTAssertEqual(AdPlan.query(tag, "description_url"), "https://p.example/")
    }

    func testReadsOnlyGraphicsItCanDraw() {
        guard case .ad(let ad) = AdPlan.parseGraphic(graphicVast(), format: "super", availableMs: 9000) else { return XCTFail("no ad") }
        XCTAssertEqual(ad.imageURL, "https://c.example/a.png")
        XCTAssertEqual(ad.impressions.count, 2)
        XCTAssertEqual(AdPlan.parseGraphic("<VAST version=\"4.0\"></VAST>", format: "super", availableMs: 9000), .noFill)
        for (xml, format, available) in [(graphicVast(), "l_shape", Int64(9000)), (graphicVast(image: "http://c.example/a.png"), "super", 9000),
                                         (graphicVast(), "super", 3000), ("<!DOCTYPE x><VAST/>", "super", 9000),
                                         ("<VAST><Ad><Wrapper/></Ad></VAST>", "super", 9000)] {
            XCTAssertEqual(AdPlan.parseGraphic(xml, format: format, availableMs: available), .unusable)
        }
    }

    func testReadsLinearAdsThroughWrappers() {
        var ad = AdPlan.LinearAd()
        XCTAssertTrue(AdPlan.parseLinear("<VAST><Ad><Wrapper><Impression>https://t.example/w</Impression><VASTAdTagURI><![CDATA[https://next.example/v]]></VASTAdTagURI></Wrapper></Ad></VAST>", into: &ad))
        XCTAssertEqual(ad.wrapperURL, "https://next.example/v")
        XCTAssertTrue(AdPlan.parseLinear("""
        <VAST><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><Linear><Duration>00:00:20</Duration>\
        <TrackingEvents><Tracking event="midpoint">https://t.example/m</Tracking></TrackingEvents><MediaFiles>\
        <MediaFile delivery="progressive" type="video/mp4" width="3840">https://c.example/4k.mp4</MediaFile>\
        <MediaFile delivery="progressive" type="video/mp4" width="1280">https://c.example/ad.mp4</MediaFile></MediaFiles>\
        </Linear></Creative></Creatives><Extensions><Extension type="iADServerShop"><Shop deliveryId="d1" creativeId="c1"/></Extension></Extensions></InLine></Ad></VAST>
        """, into: &ad))
        XCTAssertNil(ad.wrapperURL)
        XCTAssertEqual(ad.mediaURL, "https://c.example/ad.mp4")
        XCTAssertEqual(ad.durationMs, 20000)
        XCTAssertEqual(ad.impressions.count, 2)
        XCTAssertEqual(ad.creativeID, "c1")
        XCTAssertEqual(ad.deliveryID, "d1")
        var empty = AdPlan.LinearAd()
        XCTAssertFalse(AdPlan.parseLinear("<VAST version=\"4.0\"></VAST>", into: &empty))
    }

    private let shop: [String: Any] = ["kind": "scene_product", "url": "https://il.example/p", "lead_ms": 1000, "session": "plan-s",
                                       "pacing": ["min_seconds": 5], "windows": [["id": "w1", "start_ms": 10000, "end_ms": 25000]]]

    private func read(_ plan: [String: Any], session: String) throws -> AdPlan? {
        AdPlan.read(try JSONSerialization.data(withJSONObject: plan), now: now, origin: "https://il.example", sessionID: session)
    }

    func testTheSidIsTheHostsThenThePlansThenAFreshOne() throws {
        let host = try XCTUnwrap(read(fixture(["commerce": shop]), session: "host-s"))
        XCTAssertEqual(host.sid, "host-s")
        XCTAssertFalse(host.breakShop)
        XCTAssertTrue(host.cuts[1].requests[0].tagURL.contains("sid=host-s"))
        let planned = try XCTUnwrap(read(fixture(["commerce": shop]), session: ""))
        XCTAssertEqual(planned.sid, "plan-s")
        XCTAssertTrue(planned.breakShop)
        let same = try XCTUnwrap(read(fixture(["commerce": shop]), session: "plan-s"))
        XCTAssertTrue(same.breakShop)
        let fresh = try XCTUnwrap(read(fixture(), session: ""))
        XCTAssertEqual(fresh.sid.count, 32)
        XCTAssertFalse(fresh.breakShop)
        XCTAssertTrue(fresh.cuts[1].requests[0].tagURL.contains("sid=" + fresh.sid))
    }

    func testReadsWhatTheWebReaderReads() throws {
        XCTAssertNil(try read(fixture(["scenes": ["formats": ["super"], "windows": []]])), "scenes without pacing void the plan")
        XCTAssertNil(try read(["version": 1, "expires_at": "2099-01-01T00:00:00Z"]), "nothing to play")
        var scenes = try XCTUnwrap(fixture()["scenes"] as? [String: Any])
        scenes["windows"] = [["id": "half", "start_ms": 10000.5, "end_ms": 25000], ["id": "w1", "start_ms": 10000, "end_ms": 25000]]
        XCTAssertEqual(try XCTUnwrap(read(fixture(["scenes": scenes]))).windows.map(\.id), ["w1"])
        var pacing = try XCTUnwrap(scenes["pacing"] as? [String: Any])
        pacing["max_per_video"] = 1.5
        scenes["pacing"] = pacing
        XCTAssertNil(try read(fixture(["scenes": scenes])))
        var commerce = shop
        commerce["lead_ms"] = 10.5
        XCTAssertNil(try XCTUnwrap(read(fixture(["commerce": commerce]))).shop)
        XCTAssertEqual(AdPlan.allowed("gam", "https://PUBADS.g.doubleclick.net:443/gampad/./ads?iu=/1#f"),
                       "https://pubads.g.doubleclick.net/gampad/ads?iu=/1#f")
        XCTAssertEqual(AdPlan.allowed("iadserver", "https://ads.iadserver.com/x/../gampad/ads"), "https://ads.iadserver.com/gampad/ads")
        XCTAssertNil(AdPlan.allowed("gam", "https://pubads.g.doubleclick.net:8443/gampad/ads"))
        XCTAssertNil(AdPlan.allowed("gam", "https://u:p@pubads.g.doubleclick.net/gampad/ads"))
        XCTAssertNil(AdPlan.allowed("iadserver", "https://ads.iadserver.com.evil.example/gampad/ads"))
    }

    func testPassesTheConsentTheAppStored() throws {
        let store = try XCTUnwrap(UserDefaults(suiteName: "il-consent-test"))
        store.removePersistentDomain(forName: "il-consent-test")
        AdPlan.consentStore = store
        defer { AdPlan.consentStore = .standard; store.removePersistentDomain(forName: "il-consent-test") }
        XCTAssertFalse(AdPlan.correlated(gam).contains("gdpr"))
        store.set(1, forKey: "IABTCF_gdprApplies")
        store.set("CPtc", forKey: "IABTCF_TCString")
        store.set("1YNN", forKey: "IABUSPrivacy_String")
        store.set("DBABMA~x", forKey: "IABGPP_HDR_GppString")
        store.set("2_7", forKey: "IABGPP_GppSID")
        let tag = AdPlan.correlated(gam)
        for part in ["gdpr=1", "gdpr_consent=CPtc", "us_privacy=1YNN", "gpp=DBABMA~x", "gpp_sid=2%2C7", "correlator="] {
            XCTAssertTrue(tag.contains(part), part + " in " + tag)
        }
        XCTAssertTrue(AdPlan.graphicTag(gam, format: "super", targeting: [:], page: nil).contains("gdpr_consent=CPtc"))
    }

    func testTheAdWatchCountsForegroundTimeAndSeesAScrub() {
        XCTAssertEqual(AdPlan.AdWatch(durationMs: 3_600_000).limitMs, 180_000, "a VAST declaring an hour holds at most 180 s")
        var watch = AdPlan.AdWatch(durationMs: 140_000)
        XCTAssertEqual(watch.limitMs, 170_000, "an ad longer than 120 s keeps its own length")
        XCTAssertFalse(watch.tick(positionMs: 0, stepMs: 0, active: true))
        XCTAssertFalse(watch.tick(positionMs: 100, stepMs: 600_000, active: false), "ten minutes in the background do not count")
        XCTAssertFalse(watch.scrubbed)
        XCTAssertFalse(watch.tick(positionMs: 300, stepMs: 200, active: true))
        XCTAssertFalse(watch.scrubbed)
        _ = watch.tick(positionMs: 150_000, stepMs: 100, active: true)
        XCTAssertTrue(watch.scrubbed)
        let deadline = Date(timeIntervalSince1970: 1000)
        var silent = AdPlan.AdWatch(durationMs: 20_000, startBy: deadline)
        XCTAssertFalse(silent.tick(positionMs: 0, stepMs: 100, active: true, started: false, now: deadline.addingTimeInterval(-0.1)))
        XCTAssertTrue(silent.tick(positionMs: 0, stepMs: 100, active: true, started: false, now: deadline),
                      "an MP4 with no first frame by the hold deadline releases the break")
        var playing = AdPlan.AdWatch(durationMs: 20_000, startBy: deadline)
        XCTAssertFalse(playing.tick(positionMs: 0, stepMs: 100, active: true, started: true, now: deadline.addingTimeInterval(5)))
        XCTAssertTrue(AdPlan.AdWatch.mayStart(now: deadline.addingTimeInterval(-1), deadline: deadline))
        XCTAssertFalse(AdPlan.AdWatch.mayStart(now: deadline, deadline: deadline), "nothing starts after the deadline")
        var unknown = AdPlan.AdWatch(durationMs: 0)
        XCTAssertEqual(unknown.limitMs, 120_000)
        XCTAssertTrue(unknown.tick(positionMs: 0, stepMs: 120_000, active: true))
    }
}

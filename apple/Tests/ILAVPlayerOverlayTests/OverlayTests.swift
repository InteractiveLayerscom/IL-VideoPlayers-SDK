import AVFoundation
import XCTest
@testable import ILAVPlayerOverlay

final class OverlayTests: XCTestCase {
    let rows = Data("""
    [
      {"id":"super-1","format":"super","start":1000,"end":5000,"imageUrl":"https://media.example/s.png","mimeType":"image/png","impressionUrl":"https://measure.example/i"},
      {"id":"l-2","format":"l","start":5000,"end":7000,"imageUrl":"https://media.example/l.jpg"},
      {"id":"bad-time","format":"super","start":2000,"end":1999,"imageUrl":"https://media.example/s.png"},
      {"id":"bad-asset","format":"super","start":2000,"end":9999,"imageUrl":"http://media.example/s.png"},
      {"id":"bad-format","format":"unknown","start":2000,"end":3000,"imageUrl":"https://media.example/s.png"},
      {"id":"bad-type","format":"l","start":"2000","end":9999,"imageUrl":"https://media.example/s.png"}
    ]
    """.utf8)

    func testSidecarUsesMillisecondsAndHalfOpenIntervalsAcrossSeeks() throws {
        let cues = try OverlayCue.decodeSidecar(rows)
        XCTAssertEqual(cues.map(\.id), ["super-1", "l-2"])
        XCTAssertEqual(cues.first?.imageMIME, "image/png")
        let timeline = OverlayTimeline(cues)
        XCTAssertNil(timeline.active(at: nil))
        XCTAssertNil(timeline.active(at: Date(timeIntervalSince1970: 0.999)))
        XCTAssertEqual(timeline.active(at: Date(timeIntervalSince1970: 1))?.id, "super-1")
        XCTAssertEqual(timeline.active(at: Date(timeIntervalSince1970: 5))?.id, "l-2")
        XCTAssertNil(timeline.active(at: Date(timeIntervalSince1970: 7)))
        XCTAssertEqual(timeline.active(at: Date(timeIntervalSince1970: 3))?.impressionURL?.host, "measure.example")
        XCTAssertThrowsError(try OverlayCue.decodeSidecar(Data("{}".utf8)))
    }

    func testCommerceSidecarAndLegacyFallback() throws {
        let source = """
        [{"id":"offer","format":"overlay","start":1000,"end":8000,"imageUrl":"https://store.example/photo.jpg",
          "commerce":{"title":"Chimpunes","locale":"es","price":"45.50","currency":"USD",
                      "variants":[{"id":"sku-42","label":"42"}],"handoffUrl":"https://store.example/cart"}}]
        """
        let offer = try XCTUnwrap(try OverlayCue.decodeSidecar(Data(source.utf8)).first?.commerce)
        XCTAssertEqual(offer.variants.first?.id, "sku-42")
        XCTAssertEqual(offer.locale, "es")
        XCTAssertEqual(offer.variants.first?.price, Decimal(string: "45.50"))
        let unsafe = source.replacingOccurrences(of: "https://store.example/cart", with: "https://other@store.example/cart")
        XCTAssertEqual(try OverlayCue.decodeSidecar(Data(unsafe.utf8)), [])
        let legacy = unsafe.replacingOccurrences(of: "overlay", with: "super")
        XCTAssertEqual(try OverlayCue.decodeSidecar(Data(legacy.utf8)).first?.format, .super)
    }

    #if os(macOS)
    func testSceneOnlyCuePreservesOfferAndInterpolatesIndependentTracks() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let fixture = try String(contentsOf: root.appendingPathComponent("test/fixtures/creative-scene.json"),
                                 encoding: .utf8)
        let cue = try XCTUnwrap(try OverlayCue.decodeSidecar(Data(("[" + fixture + "]").utf8)).first)
        let scene = try XCTUnwrap(cue.scene)
        XCTAssertNil(cue.imageURL)
        XCTAssertEqual(cue.layout, "overlay")
        XCTAssertEqual(cue.products[1]?.id, "cap")
        XCTAssertEqual(cue.products[1]?.commerce.variants[1].id, "green")
        let layer = scene.layers[2]
        let frame = layer.frame(at: 500)
        XCTAssertEqual(frame.x, 1520, accuracy: 0.001)
        XCTAssertEqual(frame.y, 420, accuracy: 0.001)
        XCTAssertEqual(frame.opacity, 0.875, accuracy: 0.001)
        XCTAssertFalse(layer.frame(at: 3100).visible)
        let video = scene.layers[1]
        XCTAssertEqual(video.mask, "ellipse")
        XCTAssertEqual(video.audio, true)
        XCTAssertEqual(video.mediaFrame(in: CGRect(x: 0, y: 0, width: 240, height: 200)),
                       CGRect(x: 0, y: -150, width: 480, height: 400))
    }
    func testInvalidOptionalFallbackPreservesAValidScene() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let fixture = try Data(contentsOf: root.appendingPathComponent("test/fixtures/creative-scene.json"))
        var row = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture) as? [String: Any])
        row["imageUrl"] = "https://assets.example/optional-art"
        for mime: Any in ["video/mp4", "image/gif", 42] {
            row["mimeType"] = mime
            let cue = try XCTUnwrap(try OverlayCue.decodeSidecar(JSONSerialization.data(withJSONObject: [row])).first)
            XCTAssertNotNil(cue.scene)
            XCTAssertNil(cue.imageURL)
            XCTAssertNil(cue.imageMIME)
        }
        row.removeValue(forKey: "scene")
        XCTAssertEqual(try OverlayCue.decodeSidecar(JSONSerialization.data(withJSONObject: [row])), [])
    }
    #endif

    func testSceneFeedOnlyAnnouncesAudioWithSecondaryVideo() throws {
        let endpoint = try XCTUnwrap(URL(string: "https://ads.example/feed?scene=0&scene_features=audio&keep=yes"))
        func query(video: Bool, audio: Bool) throws -> [String: String] {
            let url = try XCTUnwrap(SceneFeed.url(endpoint, video: video, audio: audio))
            let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
            return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        }
        XCTAssertEqual(try query(video: false, audio: true), [
            "keep": "yes", "scene": "1", "scene_features": "media-mask,media-crop",
        ])
        XCTAssertEqual(try query(video: true, audio: true)["scene_features"], "media-mask,media-crop,video,audio")
    }

    func testLAndSuperUseStandardCanvasAtTwoSizes() {
        let canvas = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        var layout = OverlayLayout(canvas: canvas, format: .l)
        XCTAssertEqual(layout.video, CGRect(x: 0, y: 0, width: 1440, height: 810))
        XCTAssertEqual(layout.artwork, canvas)
        layout = OverlayLayout(canvas: canvas, format: .super)
        XCTAssertEqual(layout.video, canvas)
        XCTAssertEqual(layout.artwork, CGRect(x: 240, y: 756, width: 1440, height: 216))
        layout = OverlayLayout(canvas: CGRect(x: 5, y: 10, width: 800, height: 400), format: .l)
        XCTAssertEqual(layout.video, CGRect(x: 5, y: 10, width: 600, height: 300))
        layout = OverlayLayout(canvas: canvas, format: nil)
        XCTAssertEqual(layout.video, canvas)
        XCTAssertEqual(layout.artwork, .zero)
    }

    func testVisibleImpressionCountsOnceAfterAnotherDisplayFrame() {
        var seen = VisibleImpressions()
        XCTAssertFalse(seen.presented("a", at: 10))
        XCTAssertFalse(seen.presented("a", at: 10))
        seen.hidden()
        XCTAssertFalse(seen.presented("a", at: 12))
        XCTAssertTrue(seen.presented("a", at: 13))
        seen.hidden()
        XCTAssertFalse(seen.presented("a", at: 16))
        XCTAssertFalse(seen.presented("a", at: 17))
        XCTAssertFalse(seen.presented("b", at: 18))
        XCTAssertTrue(seen.presented("b", at: 19))
    }
}

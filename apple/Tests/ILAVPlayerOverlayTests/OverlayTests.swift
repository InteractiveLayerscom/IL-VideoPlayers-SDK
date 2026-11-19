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

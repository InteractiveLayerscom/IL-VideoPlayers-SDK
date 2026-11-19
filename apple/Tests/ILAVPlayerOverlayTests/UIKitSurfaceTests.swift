#if canImport(UIKit)
import AVFoundation
import UIKit
import XCTest
@testable import ILAVPlayerOverlay

final class UIKitSurfaceTests: XCTestCase {
    @MainActor
    func testUsesSameLayerAndRestoresItOnLinearBreakSeekAndStop() throws {
        let item = AVPlayerItem(asset: AVMutableComposition())
        let player = AVPlayer(playerItem: item)
        let layer = AVPlayerLayer(player: player)
        let surface = try XCTUnwrap(ILOverlayPlayerView(adopting: layer, source: .sidecar))
        surface.frame = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        surface.layoutIfNeeded()
        let cue = try XCTUnwrap(OverlayCue(id: "l", format: "l", start: .distantPast, end: .distantFuture,
                                           image: "https://media.example/art.png", impression: nil))
        let bitmap = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4))
            .image { ctx in UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) }.cgImage)
        surface.show(cue, image: bitmap)
        let art = try XCTUnwrap(surface.layer.sublayers?.first { $0 !== layer })
        XCTAssertTrue(surface.playerLayer === layer)
        XCTAssertTrue(surface.playerLayer.player === player)
        XCTAssertEqual(layer.frame, CGRect(x: 0, y: 0, width: 1440, height: 810))
        XCTAssertEqual(art.frame, surface.bounds)
        XCTAssertLessThan(art.zPosition, layer.zPosition)
        XCTAssertNotNil(art.contents)
        surface.isInLinearAdBreak = true
        XCTAssertTrue(art.isHidden)
        XCTAssertEqual(layer.frame, surface.bounds)
        surface.isInLinearAdBreak = false
        surface.show(cue, image: bitmap)
        NotificationCenter.default.post(name: AVPlayerItem.timeJumpedNotification, object: item)
        XCTAssertTrue(art.isHidden)
        XCTAssertEqual(layer.frame, surface.bounds)
        let banner = try XCTUnwrap(OverlayCue(id: "s", format: "super", start: .distantPast, end: .distantFuture,
                                              image: "https://media.example/s.png", impression: nil))
        surface.show(banner, image: bitmap)
        XCTAssertEqual(art.frame, CGRect(x: 240, y: 756, width: 1440, height: 216))
        XCTAssertGreaterThan(art.zPosition, layer.zPosition)
        surface.stop()
        XCTAssertTrue(art.isHidden)
        XCTAssertNil(art.contents)
        XCTAssertEqual(layer.frame, surface.bounds)
        XCTAssertTrue(surface.playerLayer.player === player)
    }

    @MainActor
    func testSidecarForPriorItemCannotReplaceCurrentViewerSchedule() throws {
        let old = AVPlayerItem(asset: AVMutableComposition())
        let player = AVPlayer(playerItem: old)
        let surface = ILOverlayPlayerView(player: player, source: .sidecar)
        let data = Data("[]".utf8)
        try surface.replaceSidecar(data, for: old)
        let next = AVPlayerItem(asset: AVMutableComposition())
        player.replaceCurrentItem(with: next)
        XCTAssertThrowsError(try surface.replaceSidecar(data, for: old)) { error in
            XCTAssertEqual(error as? ILOverlayInputError, .staleItem)
        }
        try surface.replaceSidecar(data, for: next)
        surface.stop()
        XCTAssertThrowsError(try surface.replaceSidecar(data, for: next)) { error in
            XCTAssertEqual(error as? ILOverlayInputError, .stopped)
        }
    }
}
#endif

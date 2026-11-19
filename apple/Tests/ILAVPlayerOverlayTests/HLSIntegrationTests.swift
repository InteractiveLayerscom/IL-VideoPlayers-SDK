#if os(macOS)
import AVFoundation
import XCTest
@testable import ILAVPlayerOverlay

final class HLSIntegrationTests: XCTestCase {
    @MainActor
    func testCollectsRealDateRangesAndMappedClockFromHLS() async throws {
        let server = Process()
        let pipe = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        let script = try XCTUnwrap(Bundle.module.url(forResource: "hls_server", withExtension: "py",
                                                     subdirectory: "Fixtures"))
        server.arguments = ["python3", "-I", "-u", script.path]
        server.standardOutput = pipe
        try server.run()
        defer {
            if server.isRunning {
                server.terminate()
                server.waitUntilExit()
            }
        }
        let address = String(decoding: pipe.fileHandleForReading.availableData, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let loopback = URL(string: address).flatMap { $0.host == "127.0.0.1" ? $0 : nil }
        let url = try XCTUnwrap(loopback, "El fixture local requiere Python 3 y FFmpeg con libx264.")
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        player.isMuted = true
        let received = expectation(description: "AVPlayer emitted the two custom date ranges")
        var timeline = OverlayTimeline()
        let feed = HLSDateRangeFeed(item: item) { cues in
            guard cues.count == 2, timeline.isEmpty else { return }
            let ordered = cues.sorted { $0.start < $1.start }
            XCTAssertEqual(ordered.map(\.id), ["super-1", "l-2"])
            XCTAssertEqual(ordered.map(\.format), [.super, .l])
            XCTAssertEqual(ordered[0].end.timeIntervalSince(ordered[0].start), 3.25, accuracy: 0.001)
            XCTAssertEqual(ordered[1].end.timeIntervalSince(ordered[1].start), 2, accuracy: 0.001)
            XCTAssertEqual(ordered[0].imageURL.absoluteString, "https://media.example/s.png")
            XCTAssertEqual(ordered[0].imageMIME, "image/png")
            XCTAssertEqual(ordered[0].impressionURL?.absoluteString, "https://measure.example/i")
            timeline = OverlayTimeline(cues)
            received.fulfill()
        }
        defer { feed.stop(); player.pause(); player.replaceCurrentItem(with: nil) }
        player.play()
        await fulfillment(of: [received], timeout: 12)
        for _ in 0..<100 {
            if player.timeControlStatus == .playing && item.currentTime().seconds > 0.1 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(player.timeControlStatus, .playing)
        XCTAssertGreaterThan(item.currentTime().seconds, 0.1)
        let position = try XCTUnwrap(item.currentDate())
        let pdt = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-01-15T12:00:00Z"))
        XCTAssertTrue((0...10).contains(position.timeIntervalSince(pdt)))
        player.pause()
        for (seconds, expected) in [(6.5, "l-2" as String?), (3.0, "super-1"), (8.5, nil)] {
            let finished = expectation(description: "seek to \(seconds)")
            player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600),
                        toleranceBefore: .zero, toleranceAfter: .zero) { moved in
                XCTAssertTrue(moved)
                finished.fulfill()
            }
            await fulfillment(of: [finished], timeout: 5)
            let date = try XCTUnwrap(item.currentDate())
            XCTAssertEqual(date.timeIntervalSince(pdt), seconds, accuracy: 0.1)
            XCTAssertEqual(timeline.active(at: date)?.id, expected)
        }
    }
}
#endif

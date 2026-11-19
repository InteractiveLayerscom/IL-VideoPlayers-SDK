import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import ILAVPlayerOverlay

final class ArtworkTests: XCTestCase {
    func testSceneArtworkDecodesTheFirstGifFrame() throws {
        let gif = try XCTUnwrap(Data(base64Encoded:
            "R0lGODlhAQABAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAAAAAACwAAAAAAQABAAACAkQBACH5BAAAAAAALAAAAAABAAEAgAAA/wAAAAICRAEAOw=="))
        let image = try OverlayArtwork.decode(gif, expectedMIME: "image/gif", allowGIF: true)
        let context = try XCTUnwrap(CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8,
                                              bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        let pixel = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
        XCTAssertEqual(Array(UnsafeBufferPointer(start: pixel, count: 4)), [255, 0, 0, 255])
        XCTAssertThrowsError(try OverlayArtwork.decode(gif, expectedMIME: nil))
    }

    func testOnlyDecodedPNGOrJPEGMayBeShown() throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 2, height: 3, bitsPerComponent: 8,
                                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let bitmap = try XCTUnwrap(context.makeImage())
        let bytes = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(bytes, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, bitmap, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let image = try OverlayArtwork.decode(bytes as Data, expectedMIME: "image/png")
        XCTAssertEqual(image.width, 2)
        XCTAssertEqual(image.height, 3)
        XCTAssertThrowsError(try OverlayArtwork.decode(bytes as Data, expectedMIME: "image/jpeg"))
        XCTAssertThrowsError(try OverlayArtwork.decode(Data("<html/>".utf8), expectedMIME: nil))
    }
}

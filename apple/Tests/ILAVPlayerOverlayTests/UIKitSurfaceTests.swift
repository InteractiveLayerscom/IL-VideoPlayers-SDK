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
    func testCommercePanelUsesTheVideoLifecycle() throws {
        let player = AVPlayer(playerItem: AVPlayerItem(asset: AVMutableComposition()))
        let surface = ILOverlayPlayerView(player: player, source: .sidecar)
        surface.frame = CGRect(x: 0, y: 0, width: 960, height: 540)
        surface.commerceEnabled = true
        let source = """
        [{"id":"shop","format":"overlay","start":1000,"end":30000,"imageUrl":"https://media.example/art.png",
          "commerce":{"title":"Botines","locale":"es","price":"45.50","currency":"USD",
                      "variants":[{"id":"42","label":"42"}],"handoffUrl":"https://ads.example/handoff"}}]
        """
        let cue = try XCTUnwrap(try OverlayCue.decodeSidecar(Data(source.utf8)).first)
        let bitmap = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4))
            .image { context in UIColor.red.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
            }.cgImage)
        surface.show(cue, image: bitmap)
        surface.layoutIfNeeded()
        let panel = try XCTUnwrap(surface.subviews.compactMap { $0 as? CommercePanel }.first)
        XCTAssertFalse(panel.frame.isEmpty)
        XCTAssertTrue(surface.isUserInteractionEnabled)
        let trigger = try XCTUnwrap(descendants(of: panel, type: UIButton.self).first {
            $0.configuration?.title == "Ver producto"
        })
        trigger.sendActions(for: .primaryActionTriggered)
        XCTAssertTrue(surface.closeCommercePanel())
        surface.isInLinearAdBreak = true
        XCTAssertTrue(surface.subviews.isEmpty)
        XCTAssertFalse(surface.isUserInteractionEnabled)
        XCTAssertTrue(surface.playerLayer.player === player)
        XCTAssertEqual(surface.playerLayer.frame, surface.bounds)
        surface.stop()
    }

    @MainActor
    func testCompactProductCardCanSelectItsHundredthVariantAndKeepBuyVisible() throws {
        let variants = (1...100).map { ["id": "v\($0)", "label": "Talle \($0)", "price": "\($0).00"] }
        let offer: [String: Any] = ["title": "Botines", "locale": "es", "price": "1", "currency": "USD",
                                    "variants": variants, "handoffUrl": "https://ads.example/handoff"]
        let data = try JSONSerialization.data(withJSONObject: [
            ["id": "shop", "format": "overlay", "start": 1000, "end": 30000,
             "imageUrl": "https://media.example/art.png", "commerce": offer] as [String: Any]
        ])
        let cue = try XCTUnwrap(try OverlayCue.decodeSidecar(data).first)
        let surface = ILOverlayPlayerView(player: AVPlayer(), source: .sidecar)
        defer { surface.stop() }
        surface.frame = CGRect(x: 0, y: 0, width: 375, height: 211)
        surface.commerceEnabled = true
        let photo = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { _ in }.cgImage)
        surface.show(cue, image: photo)
        surface.layoutIfNeeded()
        let panel = try XCTUnwrap(surface.subviews.compactMap { $0 as? CommercePanel }.first)
        let trigger = try XCTUnwrap(descendants(of: panel, type: UIButton.self).first {
            $0.configuration?.title == "Ver producto"
        })
        trigger.sendActions(for: .primaryActionTriggered)
        surface.layoutIfNeeded()
        panel.layoutIfNeeded()

        let buttons = descendants(of: panel, type: UIButton.self)
        let first = try XCTUnwrap(buttons.first { $0.configuration?.title == "Talle 1" })
        let last = try XCTUnwrap(buttons.first { $0.configuration?.title == "Talle 100" })
        let buy = try XCTUnwrap(buttons.first { $0.configuration?.title == "Comprar" })
        XCTAssertTrue(first.isSelected)
        let labels = descendants(of: panel, type: UILabel.self)
        XCTAssertTrue(labels.contains { $0.text == "Producto" })
        XCTAssertTrue(labels.contains { $0.text == "Variante" })
        let scroll = try XCTUnwrap(descendants(of: panel, type: UIScrollView.self).first {
            last.isDescendant(of: $0) && $0.contentSize.height > $0.bounds.height
        })
        scroll.scrollRectToVisible(last.convert(last.bounds, to: scroll), animated: false)
        XCTAssertTrue(scroll.bounds.intersects(last.convert(last.bounds, to: scroll)))
        last.sendActions(for: .primaryActionTriggered)
        XCTAssertTrue(last.isSelected)
        XCTAssertFalse(first.isSelected)
        XCTAssertTrue(labels.contains { $0.text?.contains("100,00") == true })
        XCTAssertTrue(panel.bounds.contains(buy.convert(buy.bounds, to: panel)))
        XCTAssertTrue(surface.bounds.contains(panel.frame))
        XCTAssertGreaterThan(panel.frame.minX, 0)
        XCTAssertTrue(surface.closeCommercePanel())
    }

    @MainActor
    func testBrandedSceneCardOpensInPortugueseWithReadableActionsAndClosesFromHeader() throws {
        let json = """
        {"title":"Chuteiras","locale":"pt-BR","price":"50","currency":"BRL",
         "variants":[{"id":"42","label":"42"}],"handoffUrl":"https://ads.example/handoff"}
        """
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        let brand = SceneBrand(logoUrl: nil, accent: "#ffffff", foreground: "#ffffff", background: "#171717")
        var opened = 0, closed = 0
        let panel = CommercePanel(offer, photo: nil, brand: brand, checkoutURL: nil, closed: { closed += 1 }) {
            opened += 1
        }
        panel.frame.size = panel.sizeThatFits(CGSize(width: 960, height: 540))
        panel.layoutIfNeeded()
        let buttons = descendants(of: panel, type: UIButton.self)
        let back = try XCTUnwrap(buttons.first { $0.accessibilityLabel == "Fechar" })
        let buy = try XCTUnwrap(buttons.first { $0.configuration?.title == "Comprar" })
        let chip = try XCTUnwrap(buttons.first { $0.configuration?.title == "42" })
        let header = try XCTUnwrap(descendants(of: panel, type: UILabel.self).first { $0.text == "Produto" })
        XCTAssertEqual(opened, 1)
        XCTAssertGreaterThanOrEqual(back.convert(back.bounds, to: panel).minX, header.convert(header.bounds, to: panel).maxX)
        for action in [buy, chip] {
            action.updateConfiguration()
            let ink = try XCTUnwrap(action.configuration?.baseForegroundColor)
            var brightness: CGFloat = 1
            XCTAssertTrue(ink.getWhite(&brightness, alpha: nil))
            XCTAssertLessThan(brightness, 0.25)
        }
        back.sendActions(for: .primaryActionTriggered)
        XCTAssertEqual(closed, 1)
    }

    #if !os(tvOS)
    @MainActor
    func testBuyHandsTheHostTheCheckoutLinkForItsSelectedVariant() async throws {
        let json = """
        {"title":"Shoes","locale":"en","price":"45","currency":"USD",
         "variants":[{"id":"v42","label":"42"},{"id":"v44","label":"44"}],
         "handoffUrl":"https://checkout-fixture.invalid/handoff"}
        """
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        let received = expectation(description: "Host received the selected variant's checkout link")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ShopifyFixture.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let panel = CommercePanel(offer, photo: nil, handoff: OverlayCheckout(session: session), checkoutURL: { url in
            XCTAssertEqual(url.absoluteString, "https://store.example/cart/v44")
            received.fulfill()
        }, closed: {}) {}
        let buttons = descendants(of: panel, type: UIButton.self)
        try XCTUnwrap(buttons.first { $0.configuration?.title == "44" }).sendActions(for: .primaryActionTriggered)
        try XCTUnwrap(buttons.first { $0.configuration?.title == "Buy" }).sendActions(for: .primaryActionTriggered)
        await fulfillment(of: [received], timeout: 3)
        panel.dispose()
    }
    #endif

    @MainActor
    private func descendants<T: UIView>(of view: UIView, type: T.Type) -> [T] {
        view.subviews.flatMap { child in
            [child as? T].compactMap { $0 } + descendants(of: child, type: type)
        }
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

private final class ShopifyFixture: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "checkout-fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 256)
            while true {
                let count = stream.read(&bytes, maxLength: bytes.count)
                guard count > 0 else { break }
                body.append(contentsOf: bytes.prefix(count))
            }
        }
        guard request.httpMethod == "POST", let url = request.url,
              let selection = try? JSONDecoder().decode([String: String].self, from: body),
              let id = selection["variantId"] else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"continueUrl\":\"https://store.example/cart/\(id)\"}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
#endif

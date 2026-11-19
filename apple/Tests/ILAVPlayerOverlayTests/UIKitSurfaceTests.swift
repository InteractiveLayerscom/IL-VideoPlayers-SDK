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
        let panel = try XCTUnwrap(surface.subviews.compactMap { $0 as? PlayerCommercePanel }.first)
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

    #if !os(tvOS)
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
        let panel = try XCTUnwrap(surface.subviews.compactMap { $0 as? PlayerCommercePanel }.first)
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

    #endif

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

    @MainActor
    func testLastOf2048SKUsCanBeSelectedOnTelevisionAndMobile() throws {
        let variants = (1...2048).map { ["id": "v\($0)", "label": "SKU \($0)", "price": $0 == 2048 ? "77" : "1"] }
        let json: [String: Any] = ["title": "Shoes", "currency": "USD", "price": "1", "variants": variants,
                                   "handoffUrl": "https://checkout-fixture.invalid/tv"]
        let product = try JSONDecoder().decode(OverlayCommerce.self, from: JSONSerialization.data(withJSONObject: json))
        let screen = CGRect(x: 0, y: 0, width: 960, height: 540)
        let tv = TVCommercePanel(product, photo: nil, checkoutURL: nil, closed: {}) {}
        defer { tv.dispose() }
        tv.frame = tv.presentationFrame(in: screen)
        tv.layoutIfNeeded()
        try XCTUnwrap(descendants(of: tv, type: UIButton.self).first { $0.configuration?.title == "Add product" })
            .sendActions(for: .primaryActionTriggered)
        tv.frame = tv.presentationFrame(in: screen)
        tv.layoutIfNeeded()
        let rail = try XCTUnwrap(descendants(of: tv, type: UICollectionView.self).first)
        let last = IndexPath(item: 2047, section: 0)
        XCTAssertEqual(rail.numberOfItems(inSection: 0), 2048)
        rail.scrollToItem(at: last, at: .centeredHorizontally, animated: false)
        rail.layoutIfNeeded()
        XCTAssertTrue(rail.indexPathsForVisibleItems.contains(last))
        rail.delegate?.collectionView?(rail, didSelectItemAt: last)
        XCTAssertTrue(descendants(of: tv, type: UILabel.self).contains { $0.text?.contains("77.00") == true })

        let mobile = CommercePanel(product, photo: nil, checkoutURL: nil, closed: {}) {}
        defer { mobile.dispose() }
        let next = try XCTUnwrap(descendants(of: mobile, type: UIButton.self).first { $0.accessibilityLabel == "Next variants" })
        for _ in 0..<20 { next.sendActions(for: .primaryActionTriggered) }
        let finalSKU = try XCTUnwrap(descendants(of: mobile, type: UIButton.self).first { $0.configuration?.title == "SKU 2048" })
        finalSKU.sendActions(for: .primaryActionTriggered)
        XCTAssertFalse(next.isEnabled)
        XCTAssertTrue(finalSKU.isSelected)
        XCTAssertTrue(descendants(of: mobile, type: UILabel.self).contains { $0.text?.contains("77.00") == true })
    }

    @MainActor
    func testLinearShopRequiresBothHostIdentifiersAndNeverUsesTheSpotAsArtwork() throws {
        let json = """
        [{"id":"delivery-8","format":"midroll","linearCreativeId":"creative-4","start":1000,"end":8000,
          "imageUrl":"https://ads.example/video.mp4","mimeType":"video/mp4","impressionUrl":"https://ads.example/vast",
          "commerce":{"title":"Shoes","price":"25","currency":"USD","variants":[{"id":"v42","label":"42"}],"handoffUrl":"https://ads.example/cart"}}]
        """
        let data = Data(json.utf8), at = Date(timeIntervalSince1970: 2)
        let cue = try XCTUnwrap(try OverlayCue.decodeSidecar(data).first)
        XCTAssertNil(cue.imageURL)
        XCTAssertNil(OverlayTimeline([cue]).active(at: at))
        let item = AVPlayerItem(asset: AVMutableComposition())
        let surface = ILOverlayPlayerView(player: AVPlayer(playerItem: item), source: .sidecar)
        defer { surface.stop() }
        surface.commerceEnabled = true
        try surface.replaceSidecar(data, for: item)
        surface.isInLinearAdBreak = true
        surface.showMidroll(at: at)
        XCTAssertTrue(surface.subviews.isEmpty)
        surface.setLinearAdBreak(true, creativeID: "creative-4", deliveryID: "different")
        surface.showMidroll(at: at)
        XCTAssertTrue(surface.subviews.isEmpty)
        surface.setLinearAdBreak(true, creativeID: "different", deliveryID: "delivery-8")
        surface.showMidroll(at: at)
        XCTAssertTrue(surface.subviews.isEmpty)
        surface.setLinearAdBreak(true, creativeID: "creative-4", deliveryID: "delivery-8")
        surface.showMidroll(at: at)
        XCTAssertTrue(descendants(of: surface, type: UIButton.self).contains { $0.configuration?.title == "Buy" })
        XCTAssertTrue(surface.playerLayer.player?.currentItem === item)
        surface.setLinearAdBreak(false)
        XCTAssertTrue(surface.subviews.isEmpty)
        let base = try XCTUnwrap(URL(string: "https://ads.example/feed?sid=s-1&tag=t-2&start=1000&end=8000"))
        let endpoint = try XCTUnwrap(ILOverlayPlayerView.commerceFeed(base, locale: "en", midrollCreativeID: "creative-4", midrollDeliveryID: "delivery-8"))
        let query = try XCTUnwrap(URLComponents(url: endpoint, resolvingAgainstBaseURL: false)?.queryItems)
        for item in [URLQueryItem(name: "shop_midroll", value: "1"), URLQueryItem(name: "midroll_creative_id", value: "creative-4"),
                     URLQueryItem(name: "midroll_delivery_id", value: "delivery-8"), URLQueryItem(name: "sid", value: "s-1"),
                     URLQueryItem(name: "tag", value: "t-2"), URLQueryItem(name: "scene", value: "1")] { XCTAssertTrue(query.contains(item)) }
    }

    @MainActor
    func testTelevisionGalleryOptionsCartAndQRUseTheSelectedSKU() async throws {
        let json = """
        {"title":"Shoes","price":"45","currency":"USD","description":"Canvas shoes",
         "imageUrl":"https://images.example/first.png","images":["https://images.example/other.png"],
         "variants":[{"id":"42","label":"42","selectedOptions":[{"name":"Size","value":"42"}]},
                     {"id":"v44","label":"44","price":"52","selectedOptions":[{"name":"Size","value":"44"}]}],
         "handoffUrl":"https://checkout-fixture.invalid/tv"}
        """
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        let requestsBefore = ShopifyFixture.tvCheckoutCount
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ShopifyFixture.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let bitmap = try XCTUnwrap(UIGraphicsImageRenderer(size: .init(width: 6, height: 6)).image { _ in }.cgImage)
        var opened = 0, closed = 0
        let panel = TVCommercePanel(offer, photo: nil, imageLoader: { _ in bitmap }, handoff: OverlayCheckout(session: session), checkoutURL: { _ in
            XCTFail("TV must show the QR")
        }, closed: { closed += 1 }) { opened += 1 }
        defer { panel.dispose() }
        let screen = CGRect(x: 0, y: 0, width: 1024, height: 576)
        func tap(_ name: String) throws {
            panel.frame = panel.presentationFrame(in: screen)
            panel.layoutIfNeeded()
            try XCTUnwrap(descendants(of: panel, type: UIButton.self).first { $0.configuration?.title == name }).sendActions(for: .primaryActionTriggered)
        }
        try tap("Add product")
        try tap("View photo gallery")
        XCTAssertEqual(panel.presentationFrame(in: screen), screen)
        XCTAssertTrue(descendants(of: panel, type: UIImageView.self).contains { $0.accessibilityLabel == "Photo 1/2" })
        try tap("›")
        XCTAssertTrue(descendants(of: panel, type: UIImageView.self).contains { $0.accessibilityLabel == "Photo 2/2" })
        try tap("Exit")
        let rail = try XCTUnwrap(descendants(of: panel, type: UICollectionView.self).first)
        rail.delegate?.collectionView?(rail, didSelectItemAt: IndexPath(item: 1, section: 0))
        try tap("Add to cart")
        XCTAssertTrue(descendants(of: panel, type: UILabel.self).contains { $0.text?.contains("52.00") == true })
        XCTAssertEqual(ShopifyFixture.tvCheckoutCount, requestsBefore)
        try tap("Finish purchase")
        let loaded = expectation(for: NSPredicate { _, _ in
            MainActor.assumeIsolated {
                self.descendants(of: panel, type: UIImageView.self).contains { $0.accessibilityLabel == "Checkout QR code" && $0.image != nil }
            }
        }, evaluatedWith: nil)
        await fulfillment(of: [loaded], timeout: 5)
        XCTAssertEqual(ShopifyFixture.tvCheckoutCount, requestsBefore + 1)
        XCTAssertTrue(panel.closeDetails())
        XCTAssertTrue(descendants(of: panel, type: UIButton.self).contains { $0.configuration?.title == "Finish purchase" })
        XCTAssertTrue(panel.closeDetails())
        XCTAssertTrue(panel.closeDetails())
        XCTAssertTrue(panel.closeDetails())
        XCTAssertEqual(opened, 1)
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
    private static let lock = NSLock()
    private static var checkouts = 0
    static var tvCheckoutCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return checkouts
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "checkout-fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if let url = request.url, request.httpMethod == "GET", url.path == "/qr/v44" {
            let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAGMAAABjAQMAAAC19SzWAAAABlBMVEUAAAD///+l2Z/dAAAAAnRSTlP//8i138cAAAAJcEhZcwAACxIAAAsSAdLdfvwAAADuSURBVDiNzdSxDQMhDAVQIwq6sAASa9DdSrBAIhZIVqJjDaRbADoKhOMoUZLm4isSKa7uNZxt/h3ge8EfqwKcOugEglPD4d3QmR44JRPSCBnCDh2d0fvknYx7hHR8eetsUzRfyNTOc9pNUbVs42uDm6q0hl50MpoTJjsX2x69fFJdisa1KoycWsIzgOgWOWE2pyQrrJHTVLfJJpTAqSXwzoRuWE1lp6MF2wunqorIAyiJnKiqMwJl40R36xXlRUZOlJejGgKfX8C2KK1QPEjcIb9I7PeuGdEbDs4EVpRrpOtakdNjvo6R0+//Pd/QFRjYqxDsyzUFAAAAAElFTkSuQmCC")!
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: png)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
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
        if url.path == "/tv" {
            Self.lock.lock()
            Self.checkouts += 1
            Self.lock.unlock()
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"continueUrl\":\"https://store.example/cart/\(id)\",\"qrImageUrl\":\"https://checkout-fixture.invalid/qr/\(id)\"}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
#endif

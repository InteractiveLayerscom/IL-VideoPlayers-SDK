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
        try XCTUnwrap(descendants(of: tv, type: UIButton.self).first { $0.configuration?.title == "Choose options" })
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
    func testMissingVariantImageKeepsTheProductCoverOnTVEvenWithAGallery() async throws {
        let json = """
        {"title":"Shoes","price":"10","currency":"USD","images":["https://photos.example/other-color"],
         "variants":[{"id":"v44","label":"44"}],"handoffUrl":"https://checkout-fixture.invalid/tv"}
        """
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        let cover = try bitmap(.white), gallery = try bitmap(.red)
        var requests = 0
        let panel = TVCommercePanel(offer, photo: cover, imageLoader: { _ in requests += 1; return gallery },
                                    checkoutURL: nil, closed: {}) {}
        defer { panel.dispose() }
        let anotherTurn = expectation(description: "Pending image work has started")
        Task { @MainActor in anotherTurn.fulfill() }
        await fulfillment(of: [anotherTurn], timeout: 2)
        XCTAssertEqual(requests, 0)
        XCTAssertTrue(descendants(of: panel, type: UIImageView.self).contains { $0.image?.cgImage === cover })
    }

    @MainActor
    func testSpanishCoverUsesTheCheapestAvailableSKUAndSingleChoiceKeepsItsOwnDiscount() throws {
        let json = """
        {"title":"Prenda","locale":"es","price":"90","previousPrice":"110","currency":"USD",
         "variants":[{"id":"m","label":"M"},{"id":"s","label":"S","price":"40","availableForSale":true},
                     {"id":"x","label":"XS","price":"5","availableForSale":false}],"handoffUrl":"https://shop.example/cart"}
        """
        for multiple in [true, false] {
            let data = Data((multiple ? json : json.replacingOccurrences(of: "true", with: "false")).utf8)
            let offer = try JSONDecoder().decode(OverlayCommerce.self, from: data)
            let panel = TVCommercePanel(offer, photo: nil, checkoutURL: nil, closed: {}) {}
            let labels = descendants(of: panel, type: UILabel.self).compactMap(\.text)
            let action = multiple ? "Elegir opciones" : "Ver detalles"
            XCTAssertTrue(descendants(of: panel, type: UIButton.self).contains { $0.configuration?.title == action })
            XCTAssertEqual(labels.contains { $0.hasPrefix("Desde ") && $0.contains("40,00") }, multiple)
            XCTAssertEqual(labels.contains { $0.contains("110,00") }, !multiple)
            panel.dispose()
        }
    }

    @MainActor
    private func waitForPhoto(_ image: CGImage, in panel: UIView) async {
        let appears = expectation(for: NSPredicate { _, _ in
            MainActor.assumeIsolated {
                self.descendants(of: panel, type: UIImageView.self).contains { $0.image?.cgImage === image }
            }
        }, evaluatedWith: nil)
        await fulfillment(of: [appears], timeout: 3)
    }

    @MainActor
    func testMobileUsesSKUPhotosPreservesSharedSizesAndDropsLateResponses() async throws {
        let json = """
        {"title":"Shoes","price":"10","currency":"USD","imageUrl":"https://photos.example/cover",
         "images":["https://photos.example/gallery"],
         "variants":[{"id":"r1","label":"Red S","imageUrl":"https://photos.example/red"},
                     {"id":"r2","label":"Red M","imageUrl":"https://photos.example/red"},
                     {"id":"b","label":"Blue","imageUrl":"https://photos.example/blue"},
                     {"id":"w","label":"White"}],"handoffUrl":"https://checkout-fixture.invalid/tv"}
        """
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        let red = try bitmap(.red), blue = try bitmap(.blue), cover = try bitmap(.white)
        let blueStarted = expectation(description: "Blue image is loading")
        let blueFinished = expectation(description: "Late blue response was delivered")
        var releaseBlue: CheckedContinuation<Void, Never>?
        var requests: [String] = []
        let panel = CommercePanel(offer, photo: nil, imageLoader: { url in
            requests.append(url.lastPathComponent)
            if url.lastPathComponent == "blue" {
                await withCheckedContinuation { releaseBlue = $0; blueStarted.fulfill() }
                blueFinished.fulfill()
                return blue
            }
            return url.lastPathComponent == "red" ? red : cover
        }, checkoutURL: nil, closed: {}) {}
        defer { panel.dispose() }
        func select(_ title: String) throws {
            try XCTUnwrap(descendants(of: panel, type: UIButton.self).first { $0.configuration?.title == title })
                .sendActions(for: .primaryActionTriggered)
        }
        await waitForPhoto(red, in: panel)
        try select("Red M")
        XCTAssertEqual(requests, ["red"])
        XCTAssertTrue(descendants(of: panel, type: UIImageView.self).contains { $0.image?.cgImage === red })
        try select("Blue")
        await fulfillment(of: [blueStarted], timeout: 3)
        XCTAssertFalse(descendants(of: panel, type: UIImageView.self).contains { $0.image?.cgImage === red })
        try select("White")
        await waitForPhoto(cover, in: panel)
        releaseBlue?.resume()
        await fulfillment(of: [blueFinished], timeout: 3)
        XCTAssertTrue(descendants(of: panel, type: UIImageView.self).contains { $0.image?.cgImage === cover })
        XCTAssertEqual(requests, ["red", "blue", "cover"])
    }

    @MainActor
    private func bitmap(_ color: UIColor) throws -> CGImage {
        try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 6, height: 6)).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 6, height: 6))
        }.cgImage)
    }

    @MainActor
    func testRedBrandKeepsTVShoppingPrimariesWhiteWithDarkText() throws {
        let data = Data("""
        {"title":"Bag","price":"80","currency":"USD","variants":[{"id":"one","label":"One size"}],
         "handoffUrl":"https://checkout-fixture.invalid/tv"}
        """.utf8)
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: data)
        let brand = SceneBrand(logoUrl: nil, accent: "#e00020", foreground: "#ffffff", background: "#ff0000")
        let panel = TVCommercePanel(offer, photo: nil, brand: brand, midroll: true, checkoutURL: nil) {}
        defer { panel.dispose() }
        for stage in ["Buy", "View details", "Add to cart", "Continue to QR"] {
            let action = try XCTUnwrap(descendants(of: panel, type: UIButton.self).first { $0.configuration?.title == stage })
            var white: CGFloat = 0, alpha: CGFloat = 0
            XCTAssertTrue(action.configuration?.background.backgroundColor?.getWhite(&white, alpha: &alpha) == true)
            XCTAssertEqual(white, 1, accuracy: 0.001)
            XCTAssertEqual(alpha, 1, accuracy: 0.001)
            XCTAssertTrue(action.configuration?.baseForegroundColor?.getWhite(&white, alpha: &alpha) == true)
            XCTAssertLessThan(white, 0.2)
            if stage != "Continue to QR" { action.sendActions(for: .primaryActionTriggered) }
        }
    }

    @MainActor
    func testSinglePhotoOpensAcrossTheTVViewportAndBackRestoresTheOpeningControl() throws {
        let json = """
        {"title":"Bag","price":"80","currency":"USD","variants":[{"id":"one","label":"One size"}],
         "handoffUrl":"https://checkout-fixture.invalid/tv"}
        """
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        let bitmap = try bitmap(.blue)
        let panel = TVCommercePanel(offer, photo: bitmap, checkoutURL: nil, closed: { XCTFail("Closed the shop") }) {}
        defer { panel.dispose() }
        let viewport = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        panel.frame = panel.presentationFrame(in: viewport)
        let sheet = panel.frame
        XCTAssertEqual(sheet.width, 806.4, accuracy: 0.01)

        for stage in ["cover", "details"] {
            if stage == "details" {
                try XCTUnwrap(descendants(of: panel, type: UIButton.self).first { $0.configuration?.title == "View details" })
                    .sendActions(for: .primaryActionTriggered)
            }
            let opener = try XCTUnwrap(descendants(of: panel, type: UIButton.self).first { $0.accessibilityLabel == "Enlarge photo" })
            opener.sendActions(for: .primaryActionTriggered)
            panel.frame = panel.presentationFrame(in: viewport)
            XCTAssertEqual(panel.frame, viewport)
            panel.layoutIfNeeded()
            let photo = try XCTUnwrap(descendants(of: panel, type: UIImageView.self).first { $0.accessibilityLabel == "Photo 1/1" })
            XCTAssertTrue(photo.image?.cgImage === bitmap)
            XCTAssertEqual(photo.contentMode, .scaleAspectFit)
            XCTAssertGreaterThan(photo.bounds.width, viewport.width * 0.85)
            XCTAssertGreaterThan(photo.bounds.height, viewport.height * 0.85)
            XCTAssertFalse(descendants(of: panel, type: UIButton.self).contains { $0.accessibilityLabel == "Next photo" })
            XCTAssertTrue(panel.closeDetails())
            XCTAssertEqual(panel.presentationFrame(in: viewport), sheet)
            XCTAssertTrue(panel.preferredFocusEnvironments.first === opener)
        }
    }

    // web/tv-shop.mjs:196, :304: Shopify's lone "Default Title" variant is never shown.
    @MainActor
    func testProductWithoutOptionsShowsNoDefaultTitle() throws {
        let json = """
        {"title":"Pouch","price":"12","currency":"USD","variants":[{"id":"d","label":"Default Title",
         "selectedOptions":[{"name":"Title","value":"Default Title"}]}],"handoffUrl":"https://checkout-fixture.invalid/tv"}
        """
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        func shown(_ root: UIView) -> [String] {
            descendants(of: root, type: UILabel.self).filter { label in
                var view: UIView? = label
                while let current = view { if current.isHidden { return false }; view = current.superview }
                return true
            }.compactMap(\.text)
        }
        let tv = TVCommercePanel(offer, photo: try bitmap(.blue), checkoutURL: nil, closed: {}) {}
        defer { tv.dispose() }
        tv.frame = tv.presentationFrame(in: CGRect(x: 0, y: 0, width: 1920, height: 1080))
        tv.layoutIfNeeded()
        XCTAssertTrue(shown(tv).contains("Enlarge photo"))
        try XCTUnwrap(descendants(of: tv, type: UIButton.self).first { $0.configuration?.title == "View details" })
            .sendActions(for: .primaryActionTriggered)
        XCTAssertFalse(shown(tv).contains("Default Title"), "\(shown(tv))")
        XCTAssertFalse(shown(tv).contains("Variant"))
        try XCTUnwrap(descendants(of: tv, type: UIButton.self).first { $0.configuration?.title == "Add to cart" })
            .sendActions(for: .primaryActionTriggered)
        XCTAssertFalse(shown(tv).contains("Default Title"), "\(shown(tv))")
        try XCTUnwrap(descendants(of: tv, type: UIButton.self).first { $0.configuration?.title == "Continue to QR" })
            .sendActions(for: .primaryActionTriggered)
        let qrStep = shown(tv)
        XCTAssertTrue(qrStep.contains("$12.00"), "\(qrStep)")
        XCTAssertFalse(qrStep.contains { $0.contains("Default Title") || $0.hasSuffix(" ") }, "\(qrStep)")

        let phone = CommercePanel(offer, photo: nil, checkoutURL: nil, closed: {}) {}
        XCTAssertFalse(shown(phone).contains("Default Title"))
        XCTAssertFalse(shown(phone).contains("Variant"))
    }

    @MainActor
    func testTelevisionGalleryOptionsCartAndQRUseTheSelectedSKU() async throws {
        let json = """
        {"title":"Shoes","vendor":"Maker","previousPrice":"60","price":"45","currency":"USD","description":"Canvas shoes",
         "imageUrl":"https://images.example/first.png","images":["https://images.example/other.png"],
         "variants":[{"id":"42","label":"42","selectedOptions":[{"name":"Size","value":"42"}]},
                     {"id":"v44","label":"44","price":"52","imageUrl":"https://images.example/blue.png","selectedOptions":[{"name":"Size","value":"44"}]}],
         "handoffUrl":"https://checkout-fixture.invalid/tv"}
        """
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        let requestsBefore = ShopifyFixture.tvCheckoutCount
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ShopifyFixture.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let cover = try bitmap(.white), blue = try bitmap(.blue), gallery = try bitmap(.red)
        var opened = 0, closed = 0
        let panel = TVCommercePanel(offer, photo: nil, imageLoader: { url in
            switch url.lastPathComponent { case "blue.png": return blue; case "other.png": return gallery; default: return cover }
        }, handoff: OverlayCheckout(session: session), checkoutURL: { _ in
            XCTFail("TV must show the QR")
        }, closed: { closed += 1 }) { opened += 1 }
        defer { panel.dispose() }
        let screen = CGRect(x: 0, y: 0, width: 1024, height: 576)
        let sidebar = CGRect(x: screen.width * 0.58, y: 0, width: screen.width * 0.42, height: screen.height)
        func tap(_ name: String, inGallery: Bool = false) throws {
            panel.frame = panel.presentationFrame(in: screen)
            let expected = inGallery ? screen : sidebar
            XCTAssertEqual(panel.frame.minX, expected.minX, accuracy: 0.001)
            XCTAssertEqual(panel.frame.width, expected.width, accuracy: 0.001)
            panel.layoutIfNeeded()
            try XCTUnwrap(descendants(of: panel, type: UIButton.self).first { $0.configuration?.title == name || $0.accessibilityLabel == name }).sendActions(for: .primaryActionTriggered)
        }
        let coverLabels = descendants(of: panel, type: UILabel.self)
        XCTAssertTrue(coverLabels.contains { $0.text == "Maker" })
        XCTAssertTrue(coverLabels.contains { $0.text == "Canvas shoes" })
        XCTAssertTrue(coverLabels.contains { $0.text?.hasPrefix("From ") == true && $0.text?.contains("45.00") == true })
        XCTAssertFalse(coverLabels.contains { $0.text?.contains("60.00") == true })
        try tap("Choose options")
        XCTAssertTrue(descendants(of: panel, type: UILabel.self).contains { $0.text?.contains("60.00") == true })
        try tap("View photos")
        XCTAssertEqual(panel.presentationFrame(in: screen), screen)
        XCTAssertTrue(descendants(of: panel, type: UIImageView.self).contains { $0.accessibilityLabel == "Photo 1/2" })
        try tap("Next photo", inGallery: true)
        XCTAssertTrue(descendants(of: panel, type: UIImageView.self).contains { $0.accessibilityLabel == "Photo 2/2" })
        XCTAssertTrue(panel.closeDetails())
        let rail = try XCTUnwrap(descendants(of: panel, type: UICollectionView.self).first)
        rail.delegate?.collectionView?(rail, didSelectItemAt: IndexPath(item: 1, section: 0))
        await waitForPhoto(blue, in: panel)
        XCTAssertFalse(descendants(of: panel, type: UILabel.self).contains { $0.text?.contains("60.00") == true })
        try tap("View photos")
        let selected = try XCTUnwrap(descendants(of: panel, type: UIImageView.self).first { $0.accessibilityLabel == "Photo 3/3" })
        XCTAssertTrue(selected.image?.cgImage === blue)
        try tap("Previous photo", inGallery: true)
        await waitForPhoto(gallery, in: panel)
        try tap("Next photo", inGallery: true)
        try tap("Next photo", inGallery: true)
        await waitForPhoto(cover, in: panel)
        XCTAssertTrue(panel.closeDetails())
        await waitForPhoto(blue, in: panel)
        try tap("Add to cart")
        XCTAssertTrue(descendants(of: panel, type: UIImageView.self).contains { $0.image?.cgImage === blue })
        XCTAssertTrue(descendants(of: panel, type: UILabel.self).contains { $0.text?.contains("52.00") == true })
        XCTAssertEqual(ShopifyFixture.tvCheckoutCount, requestsBefore)
        try tap("Continue to QR")
        let loaded = expectation(for: NSPredicate { _, _ in
            MainActor.assumeIsolated {
                self.descendants(of: panel, type: UIImageView.self).contains { $0.accessibilityLabel == "Checkout QR code" && $0.image != nil }
            }
        }, evaluatedWith: nil)
        await fulfillment(of: [loaded], timeout: 5)
        XCTAssertTrue(descendants(of: panel, type: UIImageView.self).contains { $0.image?.cgImage === blue })
        XCTAssertTrue(descendants(of: panel, type: UILabel.self).contains { $0.text == "Scan to pay on Shopify" })
        XCTAssertEqual(ShopifyFixture.tvCheckoutCount, requestsBefore + 1)
        XCTAssertTrue(panel.closeDetails())
        XCTAssertTrue(descendants(of: panel, type: UIButton.self).contains { $0.configuration?.title == "Continue to QR" })
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

    // With the variant row hidden, the lone "Default Title" variant is still the selection that Buy sends.
    @MainActor
    func testPhoneBuySendsTheHiddenDefaultVariant() async throws {
        let json = """
        {"title":"Pouch","locale":"en","price":"12","currency":"USD","variants":[{"id":"d","label":"Default Title"}],
         "handoffUrl":"https://checkout-fixture.invalid/handoff"}
        """
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        let received = expectation(description: "Buy sent the hidden default variant")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ShopifyFixture.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let panel = CommercePanel(offer, photo: nil, handoff: OverlayCheckout(session: session), checkoutURL: { url in
            XCTAssertEqual(url.absoluteString, "https://store.example/cart/d")
            received.fulfill()
        }, closed: {}) {}
        try XCTUnwrap(descendants(of: panel, type: UIButton.self).first { $0.configuration?.title == "Buy" })
            .sendActions(for: .primaryActionTriggered)
        await fulfillment(of: [received], timeout: 3)
        panel.dispose()

        // The panel never receives a product without variants: the decoder rejects it.
        let empty = #"{"title":"Pouch","price":"12","currency":"USD","variants":[],"handoffUrl":"https://checkout-fixture.invalid/handoff"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(OverlayCommerce.self, from: Data(empty.utf8)))
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

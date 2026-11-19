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

    func testAvailabilityUpdatesChangeTheProductSnapshot() throws {
        let product = """
        {"title":"Shoes","price":"59","currency":"USD","handoffUrl":"https://store.example/cart",
         "images":["https://store.example/blue.jpg","http://invalid.example/red.jpg"],
         "description":"Canvas shoes",
         "variants":[{"id":"blueS","label":"Blue / S","availableForSale":true,"imageUrl":"https://store.example/blue.jpg",
                      "selectedOptions":[{"name":"Color","value":"Blue"},{"name":"Size","value":"S"}]}]}
        """
        let inStock = try JSONDecoder().decode(OverlayCommerce.self, from: Data(product.utf8))
        let soldOut = try JSONDecoder().decode(OverlayCommerce.self, from: Data(product.replacingOccurrences(of: "true", with: "false").utf8))
        XCTAssertNotEqual(inStock, soldOut)
        XCTAssertFalse(soldOut.variants[0].available)
        XCTAssertEqual(inStock.description, "Canvas shoes")
        XCTAssertEqual(inStock.images.map(\.absoluteString), ["https://store.example/blue.jpg"])
        XCTAssertEqual(inStock.variants[0].imageURL, inStock.images.first)
        XCTAssertEqual(inStock.optionNames, ["Color", "Size"])
    }

    func testOptionChangesPreserveCompatibleDimensionsAndNeverReturnUnavailableSKUs() throws {
        let json = """
        {"title":"Shoes","price":"1","currency":"USD","handoffUrl":"https://shop.example/cart",
         "variants":[{"id":"rs","label":"Red S","selectedOptions":[{"name":"Color","value":"Red"},{"name":"Size","value":"S"}]},
                     {"id":"bs","label":"Blue S","availableForSale":false,"selectedOptions":[{"name":"Color","value":"Blue"},{"name":"Size","value":"S"}]},
                     {"id":"bm","label":"Blue M","selectedOptions":[{"name":"Color","value":"Blue"},{"name":"Size","value":"M"}]}]}
        """
        let product = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        let colors = product.choices(for: "Color", selected: 0)
        XCTAssertEqual(colors.map(\.index), [0, 2])
        let sizes = product.choices(for: "Size", selected: 2)
        XCTAssertEqual(sizes.map(\.index), [nil, 2])
        XCTAssertTrue(sizes[1].selected)
    }

    func testPreviousPriceBelongsToTheSelectedSKUOrAnEqualBasePrice() throws {
        let json = """
        {"title":"Shoes","price":"10","previousPrice":"15","currency":"USD",
         "variants":[{"id":"a","label":"Base"},{"id":"b","label":"Other","price":"12"},
                     {"id":"c","label":"Specific","price":"12","previousPrice":"18"},
                     {"id":"d","label":"No discount","previousPrice":"9"}],
         "handoffUrl":"https://shop.example/cart"}
        """
        let offer = try JSONDecoder().decode(OverlayCommerce.self, from: Data(json.utf8))
        XCTAssertEqual(offer.variants.map { offer.previousPrice(for: $0) }, [15, nil, 18, nil])
    }

    func testLongUnicodeShopifyOptionsPreserveTheProductAndItsThreeAxes() throws {
        let axis = String(repeating: "色", count: 512)
        let values = ["緑", "綿", "藍"].map { String(repeating: $0, count: 512) }
        let names = [axis, "Tamaño", "Tejido"]
        let combined = values.joined(separator: " / ")
        func decode(label: String, firstName: String = axis, firstValue: String = values[0]) throws -> OverlayCommerce {
            let options = [["name": firstName, "value": firstValue], ["name": names[1], "value": values[1]],
                           ["name": names[2], "value": values[2]]]
            let variant: [String: Any] = ["id": "sku-1", "label": label, "selectedOptions": options]
            let json: [String: Any] = ["title": "Camisa", "price": "10", "currency": "USD",
                                       "handoffUrl": "https://shop.example/cart", "variants": [variant]]
            return try JSONDecoder().decode(OverlayCommerce.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let product = try decode(label: combined)
        XCTAssertEqual(product.variants[0].label, combined)
        XCTAssertEqual(product.optionNames, names)
        XCTAssertEqual(product.variants[0].options.map(\.value), values)
        XCTAssertEqual(try decode(label: String(repeating: "界", count: 2048)).variants[0].id, "sku-1")
        XCTAssertThrowsError(try decode(label: String(repeating: "界", count: 2049)))
        XCTAssertTrue(try decode(label: combined, firstName: axis + "色").optionNames.isEmpty)
        XCTAssertTrue(try decode(label: combined, firstValue: values[0] + "緑").optionNames.isEmpty)
    }

    func testCatalogSupports2048VariantsAtTheHandoffBoundary() throws {
        let variants = (1...2048).map { ["id": "v\($0)", "label": "Size \($0)"] }
        let json: [String: Any] = ["title": "Shirt", "currency": "USD", "price": "4", "handoffUrl": "https://shop.example/cart", "variants": variants]
        let product = try JSONDecoder().decode(OverlayCommerce.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(product.variants.last?.id, "v2048")
        XCTAssertEqual(product.choices(for: nil, selected: 2047).last?.index, 2047)
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

    private func sceneRow() throws -> [String: Any] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let fixture = try Data(contentsOf: root.appendingPathComponent("test/fixtures/creative-scene.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: fixture) as? [String: Any])
    }

    func testSceneDropsALayerWhoseNumbersExceedTheSupportedRange() throws {
        let extremes: [(layer: Int, field: String, value: Any)] = [
            (0, "width", 1e300),
            (2, "keyframes", [["timeMs": 1000, "scale": -1e300], ["timeMs": 2000, "scale": 1e300]]),
        ]
        for extreme in extremes {
            var row = try sceneRow()
            var scene = try XCTUnwrap(row["scene"] as? [String: Any])
            var layers = try XCTUnwrap(scene["layers"] as? [[String: Any]])
            let id = try XCTUnwrap(layers[extreme.layer]["id"] as? String)
            layers[extreme.layer][extreme.field] = extreme.value
            scene["layers"] = layers
            row["scene"] = scene
            let cue = try XCTUnwrap(try OverlayCue.decodeSidecar(JSONSerialization.data(withJSONObject: [row])).first)
            let ids = try XCTUnwrap(cue.scene).layers.map(\.id)
            XCTAssertEqual(ids.count, 6, extreme.field)
            XCTAssertFalse(ids.contains(id), extreme.field)
        }
    }

    func testSceneKeepsALayerWhoseEndIsFarBeyondTheScene() throws {
        var row = try sceneRow()
        var scene = try XCTUnwrap(row["scene"] as? [String: Any])
        var layers = try XCTUnwrap(scene["layers"] as? [[String: Any]])
        layers[0]["endMs"] = 9_007_199_254_740_991
        scene["layers"] = layers
        row["scene"] = scene
        let cue = try XCTUnwrap(try OverlayCue.decodeSidecar(JSONSerialization.data(withJSONObject: [row])).first)
        let background = try XCTUnwrap(try XCTUnwrap(cue.scene).layers.first { $0.id == "background" })
        XCTAssertTrue(background.frame(at: 4000).visible)
    }

    func testSceneWhoseCanvasIsSmallerThanOnePixelIsRejected() throws {
        var row = try sceneRow()
        var scene = try XCTUnwrap(row["scene"] as? [String: Any])
        scene["width"] = 1e-30
        row["scene"] = scene
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

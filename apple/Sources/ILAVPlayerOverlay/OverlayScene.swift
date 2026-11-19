import CoreGraphics
import Foundation

struct OverlayScene: Decodable, Equatable {
    let format: String
    let width, height, durationMs: Double
    let layers: [Layer]

    enum Field: String, CodingKey { case format, width, height, durationMs, layers }

    init(from decoder: Decoder) throws {
        let row = try decoder.container(keyedBy: Field.self)
        format = try row.decode(String.self, forKey: .format)
        width = try row.decode(Double.self, forKey: .width)
        height = try row.decode(Double.self, forKey: .height)
        durationMs = try row.decode(Double.self, forKey: .durationMs)
        let items = try row.decode([FailableLayer].self, forKey: .layers)
        layers = items.compactMap(\.value).filter {
            $0.hidden != true && $0.width >= 0 && $0.height >= 0 && $0.isBounded
        }
        guard width >= 1, height >= 1, durationMs > 0, !layers.isEmpty, items.count <= 512 else {
            throw URLError(.cannotParseResponse)
        }
    }

    private struct FailableLayer: Decodable {
        let value: Layer?
        init(from decoder: Decoder) throws { value = try? Layer(from: decoder) }
    }

    struct Layer: Decodable, Equatable {
        let id, type: String
        let x, y, width, height: Double
        let opacity, rotation, radius, strokeWidth, fontSize, startMs, endMs: Double?
        let trimStartMs, trimEndMs: Double?
        let hidden, loop, audio: Bool?
        let name, fill, stroke, text, fontFamily, textAlign, fit: String?
        let fontWeight, maxLines: Int?
        let fontStyle, alt: String?
        let mask: String?
        let mediaCrop: MediaCrop?
        let lineHeight, letterSpacing: Double?
        let arrow: Bool?
        let gradient: Gradient?
        let shadow: Shadow?
        let src, poster, binding, action, url: String?
        let productIndex: Int?
        let keyframes: [Keyframe]?

        var mediaURL: URL? { OverlayCue.httpsURL(type == "video" ? poster : src) }

        /// Core Animation raises on NaN geometry. Within this magnitude, and with a canvas of at
        /// least one pixel, no interpolation or scaling of these numbers can produce one.
        /// `endMs` is only ever compared, so a layer may use a large value to never end.
        var isBounded: Bool {
            let frames = (keyframes ?? []).flatMap { [$0.timeMs, $0.x, $0.y, $0.scale, $0.rotation, $0.opacity] }
            let values: [Double?] = [x, y, width, height, opacity, rotation, radius, strokeWidth, fontSize,
                                     startMs, trimStartMs, trimEndMs, lineHeight, letterSpacing,
                                     gradient?.angle, shadow?.x, shadow?.y, shadow?.blur]
            return (values + frames).allSatisfy { ($0 ?? 0).magnitude <= 1e9 }
        }

        func mediaFrame(in bounds: CGRect) -> CGRect {
            let zoom = min(4, max(1, mediaCrop?.zoom ?? 1))
            let x = min(1, max(-1, mediaCrop?.x ?? 0))
            let y = min(1, max(-1, mediaCrop?.y ?? 0))
            let overflow = (zoom - 1) / 2
            return CGRect(x: bounds.minX + (x - 1) * overflow * bounds.width,
                          y: bounds.minY + (y - 1) * overflow * bounds.height,
                          width: bounds.width * zoom, height: bounds.height * zoom)
        }

        func frame(at time: Double) -> Frame {
            let points = keyframes?.sorted { $0.timeMs < $1.timeMs } ?? []
            func track(_ field: KeyPath<Keyframe, Double?>, initial: Double) -> Double {
                var value = initial
                var previous = 0.0
                for point in points {
                    guard point.timeMs >= 0, let next = point[keyPath: field] else { continue }
                    if time < point.timeMs {
                        let progress = (time - previous) / (point.timeMs - previous)
                        return value + (next - value) * point.ease(progress)
                    }
                    value = next
                    previous = point.timeMs
                }
                return value
            }
            let scale = track(\.scale, initial: 1)
            let opacity = track(\.opacity, initial: opacity ?? 1)
            return Frame(x: track(\.x, initial: x), y: track(\.y, initial: y), scale: scale,
                         rotation: track(\.rotation, initial: rotation ?? 0), opacity: opacity,
                         visible: time >= (startMs ?? 0) && time < (endMs ?? .infinity) && scale > 0 && opacity > 0)
        }
    }

    struct Gradient: Decodable, Equatable {
        let angle: Double
        let from, to: String
    }

    struct Shadow: Decodable, Equatable {
        let x, y, blur: Double
        let color: String
    }

    struct MediaCrop: Decodable, Equatable {
        let x, y, zoom: Double
    }

    struct Keyframe: Decodable, Equatable {
        let timeMs: Double
        let x, y, scale, rotation, opacity: Double?
        let easing: String?

        func ease(_ progress: Double) -> Double {
            let remaining = 1 - progress
            switch easing {
            case "ease-in": return progress * progress
            case "ease-out": return 1 - remaining * remaining
            case "ease-in-out": return progress < 0.5 ? 2 * progress * progress : 1 - 2 * remaining * remaining
            default: return progress
            }
        }
    }

    struct Frame {
        let x, y, scale, rotation, opacity: Double
        let visible: Bool
    }
}

enum SceneFeed {
    static func url(_ endpoint: URL, video: Bool, audio: Bool) -> URL? {
        guard OverlayCue.httpsURL(endpoint.absoluteString) != nil,
              var url = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        var features = ["media-mask", "media-crop"]
        if video {
            features.append("video")
            if audio { features.append("audio") }
        }
        url.queryItems = (url.queryItems ?? []).filter { !["scene", "scene_features"].contains($0.name) } + [
            URLQueryItem(name: "scene", value: "1"),
            URLQueryItem(name: "scene_features", value: features.joined(separator: ",")),
        ]
        return url.url
    }
}

struct SceneOffer: Decodable, Equatable {
    let id: String
    let imageURL: URL
    let commerce: OverlayCommerce

    enum Field: String, CodingKey { case id, imageUrl }

    init(from decoder: Decoder) throws {
        let row = try decoder.container(keyedBy: Field.self)
        id = try row.decode(String.self, forKey: .id)
        guard !id.isEmpty, let imageURL = OverlayCue.httpsURL(try row.decode(String.self, forKey: .imageUrl))
        else { throw URLError(.cannotParseResponse) }
        self.imageURL = imageURL
        commerce = try OverlayCommerce(from: decoder)
    }

    var price: String {
        let format = NumberFormatter()
        format.numberStyle = .currency
        format.locale = Locale(identifier: commerce.locale)
        format.currencyCode = commerce.currency
        return format.string(from: NSDecimalNumber(decimal: commerce.price)) ?? commerce.price.description
    }
}

struct SceneBrand: Decodable, Equatable {
    let logoUrl, accent, foreground, background: String?
    var logoURL: URL? { OverlayCue.httpsURL(logoUrl) }
}

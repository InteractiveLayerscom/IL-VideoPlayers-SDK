import CoreGraphics
import Foundation

enum OverlayFormat: String { case `super`, l, overlay }

struct OverlayCue: Equatable {
    static let hlsClass = "com.interactivelayers.overlay"
    let id: String
    let format: OverlayFormat
    let start: Date
    let end: Date
    let imageURL: URL
    let imageMIME: String?
    let impressionURL: URL?
    let commerce: OverlayCommerce?

    init?(id: String?, format: String?, start: Date, end: Date?,
          image: String?, mime: String? = nil, impression: String?, commerce: OverlayCommerce? = nil) {
        guard let id, !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let format = format.flatMap(OverlayFormat.init(rawValue:)), format != .overlay || commerce != nil,
              let end, start < end, let imageURL = Self.httpsURL(image),
              mime == nil || mime == "image/png" || mime == "image/jpeg"
        else { return nil }
        self.id = id
        self.format = format
        self.start = start
        self.end = end
        self.imageURL = imageURL
        self.imageMIME = mime
        self.impressionURL = Self.httpsURL(impression)
        self.commerce = commerce
    }

    static func httpsURL(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty,
              raw.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              let parts = URLComponents(string: raw), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil
        else { return nil }
        return parts.url
    }

    static func decodeSidecar(_ data: Data) throws -> [OverlayCue] {
        try JSONDecoder().decode([SidecarRow].self, from: data).compactMap(\.cue)
    }

    private struct SidecarRow: Decodable {
        let cue: OverlayCue?
        enum Field: String, CodingKey { case id, format, start, end, imageUrl, mimeType, impressionUrl, commerce }

        init(from decoder: Decoder) {
            do {
                let row = try decoder.container(keyedBy: Field.self)
                let start = try row.decode(Int64.self, forKey: .start)
                let end = try row.decode(Int64.self, forKey: .end)
                cue = try OverlayCue(id: row.decode(String.self, forKey: .id),
                                     format: row.decode(String.self, forKey: .format),
                                     start: Date(timeIntervalSince1970: Double(start) / 1000),
                                     end: Date(timeIntervalSince1970: Double(end) / 1000),
                                     image: row.decode(String.self, forKey: .imageUrl),
                                     mime: row.decodeIfPresent(String.self, forKey: .mimeType),
                                     impression: row.decodeIfPresent(String.self, forKey: .impressionUrl),
                                     commerce: try? row.decode(OverlayCommerce.self, forKey: .commerce))
            } catch {
                cue = nil
            }
        }
    }
}

struct OverlayTimeline {
    private let cues: [OverlayCue]
    var isEmpty: Bool { cues.isEmpty }

    init(_ snapshot: [OverlayCue] = []) {
        // A session publishes one active overlay. Malformed overlaps get one stable winner.
        let byID = Dictionary(snapshot.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        cues = byID.values.sorted { ($0.start, $0.id) < ($1.start, $1.id) }
    }

    func upcoming(after date: Date) -> OverlayCue? {
        let horizon = date.addingTimeInterval(5)
        return cues.first { date < $0.start && $0.start <= horizon }
    }

    func active(at date: Date?) -> OverlayCue? {
        guard let date else { return nil }
        return cues.first { $0.start <= date && date < $0.end }
    }
}

struct OverlayLayout {
    let video: CGRect
    let artwork: CGRect

    init(canvas: CGRect, format: OverlayFormat?) {
        switch format {
        case .l:
            video = CGRect(origin: canvas.origin, size: CGSize(width: canvas.width * 0.75,
                                                               height: canvas.height * 0.75))
            artwork = canvas
        case .super:
            video = canvas
            artwork = CGRect(x: canvas.minX + canvas.width * 0.125, y: canvas.minY + canvas.height * 0.70,
                             width: canvas.width * 0.75, height: canvas.height * 0.20)
        case .overlay:
            video = canvas
            artwork = CGRect(x: canvas.minX + canvas.width * 0.64, y: canvas.minY + canvas.height * 0.10,
                             width: canvas.width * 0.30, height: canvas.height * 0.32)
        case nil:
            video = canvas
            artwork = .zero
        }
    }
}

struct VisibleImpressions {
    private var seen = Set<String>()
    private var candidate: (id: String, frame: TimeInterval)?

    mutating func hidden() { candidate = nil }

    mutating func presented(_ id: String, at frame: TimeInterval) -> Bool {
        guard let candidate, candidate.id == id else {
            self.candidate = (id, frame)
            return false
        }
        guard frame > candidate.frame else { return false }
        return seen.insert(id).inserted
    }
}

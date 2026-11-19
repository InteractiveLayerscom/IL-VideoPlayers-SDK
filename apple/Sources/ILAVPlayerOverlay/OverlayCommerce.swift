import Foundation
import CoreGraphics

struct OverlayCommerce: Equatable, Decodable {
    struct Variant: Equatable {
        let id: String
        let label: String
        let price: Decimal
    }

    let title: String
    let currency: String
    let locale: String
    let handoffURL: URL
    let viewURL: URL?
    let variants: [Variant]

    enum Field: String, CodingKey { case title, currency, locale, handoffUrl, viewUrl, variants, price }
    enum VariantField: String, CodingKey { case id, label, price }

    init(from decoder: Decoder) throws {
        let row = try decoder.container(keyedBy: Field.self)
        let title = try row.decode(String.self, forKey: .title)
        let currency = try row.decode(String.self, forKey: .currency)
        let address = try row.decode(String.self, forKey: .handoffUrl)
        guard Self.valid(title, max: 256),
              currency.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil,
              address.count <= 4096, let handoff = OverlayCue.httpsURL(address),
              let price = Self.amount(row, field: .price) else { throw URLError(.cannotParseResponse) }
        var items = try row.nestedUnkeyedContainer(forKey: .variants)
        guard let count = items.count, (1...100).contains(count) else { throw URLError(.cannotParseResponse) }
        var variants: [Variant] = []
        var seen = Set<String>()
        while !items.isAtEnd {
            let item = try items.nestedContainer(keyedBy: VariantField.self)
            let id = try item.decode(String.self, forKey: .id)
            let label = try item.decode(String.self, forKey: .label)
            let override = item.contains(.price) && (try? item.decodeNil(forKey: .price)) != true
            let amount = override ? Self.amount(item, field: .price) : price
            guard Self.valid(id, max: 128), Self.valid(label, max: 160), seen.insert(id).inserted,
                  let amount else { throw URLError(.cannotParseResponse) }
            variants.append(.init(id: id, label: label, price: amount))
        }
        self.title = title
        self.currency = currency
        locale = Self.language(try? row.decode(String.self, forKey: .locale))
        handoffURL = handoff
        viewURL = OverlayCue.httpsURL(try? row.decode(String.self, forKey: .viewUrl))
        self.variants = variants
    }

    static func language(_ locale: String?) -> String {
        switch locale?.lowercased().split(separator: "-").first {
        case "pt": return "pt-BR"
        case "es": return "es"
        default: return "en"
        }
    }

    private static func valid(_ text: String, max: Int) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.count <= max
    }

    private static func amount<Key: CodingKey>(_ row: KeyedDecodingContainer<Key>, field: Key) -> Decimal? {
        let locale = Locale(identifier: "en_US_POSIX")
        let value = (try? row.decode(String.self, forKey: field)) ??
            (try? row.decode(Decimal.self, forKey: field)).map { NSDecimalNumber(decimal: $0).stringValue }
        guard let value, value.range(of: #"^\d{1,12}(?:\.\d{1,6})?$"#, options: .regularExpression) != nil
        else { return nil }
        return Decimal(string: value, locale: locale)
    }
}

enum OverlayCheckout {
    struct Handoff: Decodable {
        let continueUrl: String
        let qrImageUrl: String?
    }
    struct Selection: Encodable { let variantId: String }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse, newRequest: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 10
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }()

    static func prepare(_ offer: OverlayCommerce, variant: String) async throws -> (url: URL, qr: URL?) {
        var request = URLRequest(url: offer.handoffURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Selection(variantId: variant))
        let reply = try JSONDecoder().decode(Handoff.self, from: try await read(request, limit: 16 * 1024))
        guard let url = OverlayCue.httpsURL(reply.continueUrl) else { throw URLError(.badURL) }
        return (url, OverlayCue.httpsURL(reply.qrImageUrl))
    }

    static func qr(_ url: URL) async throws -> CGImage {
        try OverlayArtwork.decode(try await read(URLRequest(url: url), limit: 256 * 1024), expectedMIME: "image/png")
    }

    private static func read(_ request: URLRequest, limit: Int) async throws -> Data {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              response.expectedContentLength <= Int64(limit) else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes {
            guard data.count < limit else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        try Task.checkCancellation()
        return data
    }
}

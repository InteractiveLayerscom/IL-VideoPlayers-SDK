import Foundation
import CoreGraphics

struct OverlayCommerce: Equatable, Decodable {
    struct Option: Decodable, Equatable, Hashable {
        let name, value: String
    }
    struct Variant: Equatable {
        let id: String
        let label: String
        let price: Decimal
        let previousPrice: Decimal?
        let options: [Option]
        let available: Bool
        let imageURL: URL?
    }

    let vendor: String?
    let title: String
    let description: String?
    let images: [URL]
    let imageURL: URL?
    let optionNames: [String]
    let currency: String
    let locale: String
    let handoffURL: URL
    let viewURL: URL?
    let variants: [Variant]
    let price: Decimal
    let previousPrice: Decimal?

    enum Field: String, CodingKey { case vendor, title, description, images, imageUrl, currency, locale, handoffUrl, viewUrl, variants, price, previousPrice }
    enum VariantField: String, CodingKey { case id, label, price, previousPrice, selectedOptions, availableForSale, imageUrl }

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
        guard let count = items.count, (1...2048).contains(count) else { throw URLError(.cannotParseResponse) }
        var variants: [Variant] = []
        var seen = Set<String>()
        while !items.isAtEnd {
            let item = try items.nestedContainer(keyedBy: VariantField.self)
            let id = try item.decode(String.self, forKey: .id)
            let label = try item.decode(String.self, forKey: .label)
            let override = item.contains(.price) && (try? item.decodeNil(forKey: .price)) != true
            let amount = override ? Self.amount(item, field: .price) : price
            guard Self.valid(id, max: 128), Self.valid(label, max: 2048), seen.insert(id).inserted,
                  let amount else { throw URLError(.cannotParseResponse) }
            let options = (try? item.decode([Option].self, forKey: .selectedOptions)) ?? []
            let validOptions = options.allSatisfy { Self.valid($0.name, max: 512) && Self.valid($0.value, max: 512) }
                && Set(options.map(\.name)).count == options.count
            variants.append(.init(id: id, label: label, price: amount, previousPrice: Self.amount(item, field: .previousPrice), options: validOptions ? options : [],
                                  available: (try? item.decodeIfPresent(Bool.self, forKey: .availableForSale)) ?? true,
                                  imageURL: OverlayCue.httpsURL(try? item.decode(String.self, forKey: .imageUrl))))
        }
        self.title = title
        vendor = (try? row.decode(String.self, forKey: .vendor))?.trimmingCharacters(in: .whitespacesAndNewlines)
        previousPrice = Self.amount(row, field: .previousPrice)
        description = (try? row.decode(String.self, forKey: .description)).flatMap { $0.isEmpty ? nil : $0 }
        let addresses = (try? row.decode([String].self, forKey: .images)) ?? []
        var unique = Set<URL>()
        images = addresses.compactMap(OverlayCue.httpsURL).filter { unique.insert($0).inserted }
        self.currency = currency
        locale = Self.language(try? row.decode(String.self, forKey: .locale))
        handoffURL = handoff
        viewURL = OverlayCue.httpsURL(try? row.decode(String.self, forKey: .viewUrl))
        imageURL = OverlayCue.httpsURL(try? row.decode(String.self, forKey: .imageUrl))
        let names = variants[0].options.map(\.name)
        let keys = Set(names)
        optionNames = !names.isEmpty && variants.allSatisfy { Set($0.options.map(\.name)) == keys }
            && Set(variants.map { Set($0.options) }).count == variants.count ? names : []
        self.variants = variants
        self.price = price
    }

    /// Shopify's lone "Default Title" variant of a product without options, which the panels never show (web/tv-shop.mjs:196, :304).
    var defaultVariantOnly: Bool { variants.count == 1 && variants[0].label == "Default Title" }

    func previousPrice(for variant: Variant) -> Decimal? {
        guard let previous = variant.previousPrice ?? (variant.price == price ? previousPrice : nil),
              previous > variant.price else { return nil }
        return previous
    }

    struct Choice {
        let label: String
        let index: Int?
        let selected: Bool
    }

    // Resolve each displayed value to a real available SKU, preserving earlier options first.
    func choices(for name: String?, selected: Int) -> [Choice] {
        guard let name, let dimension = optionNames.firstIndex(of: name) else {
            return variants.indices.map { Choice(label: variants[$0].label, index: variants[$0].available ? $0 : nil,
                                                  selected: selected == $0) }
        }
        let current = Set(variants[selected].options)
        let required = current.filter { optionNames.prefix(dimension).contains($0.name) }
        var values: [String] = [], seen = Set<String>()
        var best: [String: (index: Int, matches: Int)] = [:]
        for (index, variant) in variants.enumerated() {
            guard let value = variant.options.first(where: { $0.name == name })?.value else { continue }
            if seen.insert(value).inserted { values.append(value) }
            let options = Set(variant.options)
            guard variant.available, required.isSubset(of: options) else { continue }
            let matches = options.intersection(current).count
            if matches > (best[value]?.matches ?? -1) { best[value] = (index, matches) }
        }
        return values.map { value in
            Choice(label: value, index: best[value]?.index, selected: current.contains(Option(name: name, value: value)))
        }
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

struct OverlayCheckout {
    let session: URLSession

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

    static let shared: Self = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 10
        return Self(session: URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil))
    }()

    func prepare(_ offer: OverlayCommerce, variant: String) async throws -> (url: URL, qr: URL?) {
        var request = URLRequest(url: offer.handoffURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Selection(variantId: variant))
        let reply = try JSONDecoder().decode(Handoff.self, from: try await read(request, limit: 16 * 1024))
        guard let url = OverlayCue.httpsURL(reply.continueUrl) else { throw URLError(.badURL) }
        return (url, OverlayCue.httpsURL(reply.qrImageUrl))
    }

    func qr(_ url: URL) async throws -> CGImage {
        try OverlayArtwork.decode(try await read(URLRequest(url: url), limit: 256 * 1024), expectedMIME: "image/png")
    }

    private func read(_ request: URLRequest, limit: Int) async throws -> Data {
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

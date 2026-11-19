import Foundation
import ImageIO
import UniformTypeIdentifiers

enum OverlayArtwork {
    private static let maxBytes = 8 * 1024 * 1024
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 15
        return URLSession(configuration: config, delegate: RedirectPolicy(), delegateQueue: nil)
    }()

    private final class RedirectPolicy: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            let url = OverlayCue.httpsURL(request.url?.absoluteString)
            completionHandler(url == nil ? nil : request)
        }
    }

    static func load(_ cue: OverlayCue) async throws -> CGImage {
        guard let url = cue.imageURL else { throw URLError(.badURL) }
        return try await load(url, expectedMIME: cue.imageMIME, allowGIF: false)
    }

    static func loadSceneImage(_ url: URL) async throws -> CGImage {
        try await load(url, expectedMIME: nil, allowGIF: true)
    }

    private static func load(_ url: URL, expectedMIME: String?, allowGIF: Bool) async throws -> CGImage {
        let (bytes, response) = try await session.bytes(from: url)
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              response.expectedContentLength <= Int64(maxBytes) else { throw URLError(.badServerResponse) }
        let type = response.mimeType?.lowercased()
        if let type, !["image/png", "image/jpeg", "application/octet-stream"].contains(type),
           !(allowGIF && type == "image/gif") {
            throw URLError(.cannotDecodeContentData)
        }
        var data = Data()
        return try await withTaskCancellationHandler {
            for try await byte in bytes {
                guard data.count < maxBytes else { throw URLError(.dataLengthExceedsMaximum) }
                data.append(byte)
            }
            try Task.checkCancellation()
            let declaredMIME = type == "application/octet-stream" ? nil : type
            if let expected = expectedMIME, let declaredMIME, expected != declaredMIME {
                throw URLError(.cannotDecodeContentData)
            }
            return try decode(data, expectedMIME: expectedMIME ?? declaredMIME, allowGIF: allowGIF)
        } onCancel: {
            bytes.task.cancel()
        }
    }

    static func decode(_ data: Data, expectedMIME: String?, allowGIF: Bool = false) throws -> CGImage {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard data.count <= maxBytes, let source = CGImageSourceCreateWithData(data as CFData, options),
              let identifier = CGImageSourceGetType(source) as String?,
              let type = UTType(identifier), type == .png || type == .jpeg || (allowGIF && type == .gif),
              expectedMIME == nil || type.preferredMIMEType == expectedMIME,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 16_777_216 / height
        else { throw URLError(.cannotDecodeContentData) }
        let thumbnail = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                         kCGImageSourceCreateThumbnailWithTransform: true,
                         kCGImageSourceShouldCacheImmediately: true,
                         kCGImageSourceThumbnailMaxPixelSize: min(max(width, height), 4096)] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnail) else {
            throw URLError(.cannotDecodeContentData)
        }
        return image
    }

    static func sendImpression(to url: URL) async {
        // The GET has reached its endpoint when response headers arrive. No response body is needed.
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let (bytes, _) = try? await session.bytes(for: request) { bytes.task.cancel() }
    }
}

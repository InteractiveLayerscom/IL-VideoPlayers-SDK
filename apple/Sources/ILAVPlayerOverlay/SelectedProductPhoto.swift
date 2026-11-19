#if canImport(UIKit)
import UIKit

/// Keeps the selected SKU's image through size, view and stage changes. Gallery paging uses separate views.
@MainActor
final class SelectedProductPhoto {
    let coverURL: URL?
    private let fallback: UIImage?
    private let load: (URL) async throws -> CGImage
    private var loadedCover: UIImage?
    private var requested: URL?
    private var current: UIImage?
    private weak var target: UIImageView?
    private var task: Task<Void, Never>?

    init(coverURL: URL?, bitmap: CGImage?, load: @escaping (URL) async throws -> CGImage) {
        self.coverURL = coverURL
        fallback = bitmap.map(UIImage.init(cgImage:))
        current = fallback
        self.load = load
    }

    func hasPhoto(for variant: OverlayCommerce.Variant) -> Bool {
        variant.imageURL != nil || coverURL != nil || fallback != nil
    }

    func display(_ variant: OverlayCommerce.Variant, in view: UIImageView) {
        target = view
        let url = variant.imageURL ?? coverURL
        guard url != requested else { view.image = current; return }
        task?.cancel()
        requested = url
        current = url == coverURL ? loadedCover ?? fallback : nil
        view.image = current
        guard let url, url != coverURL || loadedCover == nil else { return }
        task = Task { [weak self, load, coverURL, loadedCover, fallback] in
            let bitmap = try? await load(url)
            guard !Task.isCancelled else { return }
            var image = bitmap.map(UIImage.init(cgImage:))
            if let image, url == coverURL { self?.loadedCover = image }
            if image == nil {
                image = loadedCover ?? fallback
                if let coverURL, url != coverURL, loadedCover == nil, let cover = try? await load(coverURL) {
                    guard !Task.isCancelled else { return }
                    image = UIImage(cgImage: cover)
                    self?.loadedCover = image
                }
            }
            guard !Task.isCancelled else { return }
            self?.current = image
            self?.target?.image = image
        }
    }

    func cancel() { task?.cancel() }
}
#endif

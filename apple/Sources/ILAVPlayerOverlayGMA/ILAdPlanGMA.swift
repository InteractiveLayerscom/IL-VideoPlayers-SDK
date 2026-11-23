#if os(iOS) && !targetEnvironment(macCatalyst) && canImport(GoogleMobileAds)
import GoogleMobileAds
import ILAVPlayerOverlay
import UIKit

/// The plan's Overlay through Google Mobile Ads on iOS. The app adds this product and `GADApplicationIdentifier`.
@MainActor
public final class ILAdPlanGMA: NSObject, ILDisplayAdSlot, BannerViewDelegate {
    private let container: UIView
    private weak var rootViewController: UIViewController?
    private var banner: AdManagerBannerView?
    private var answered: ((Bool) -> Void)?
    private var onImpression: (() -> Void)?

    public init(container: UIView, rootViewController: UIViewController) {
        self.container = container
        self.rootViewController = rootViewController
    }

    public func request(adUnit: String, targeting: [String: String], answered: @escaping (Bool) -> Void,
                        onImpression: @escaping () -> Void) {
        clear()
        let view = AdManagerBannerView(adSize: AdSizeMediumRectangle)
        view.adUnitID = adUnit
        view.rootViewController = rootViewController
        view.delegate = self
        view.isHidden = true
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -58),
            view.widthAnchor.constraint(equalToConstant: 300),
            view.heightAnchor.constraint(equalToConstant: 250)
        ])
        banner = view
        self.answered = answered
        self.onImpression = onImpression
        let request = AdManagerRequest()
        request.customTargeting = targeting
        view.load(request)
    }

    public func setVisible(_ visible: Bool) { banner?.isHidden = !visible }

    public func clear() {
        banner?.delegate = nil
        banner?.removeFromSuperview()
        banner = nil
        answered = nil
        onImpression = nil
    }

    public func bannerViewDidReceiveAd(_ bannerView: BannerView) {
        guard bannerView === banner else { return }
        answered?(true)
    }

    public func bannerView(_ bannerView: BannerView, didFailToReceiveAdWithError error: Error) {
        guard bannerView === banner else { return }
        answered?(false)
    }

    public func bannerViewDidRecordImpression(_ bannerView: BannerView) {
        guard bannerView === banner else { return }
        onImpression?()
    }
}
#endif

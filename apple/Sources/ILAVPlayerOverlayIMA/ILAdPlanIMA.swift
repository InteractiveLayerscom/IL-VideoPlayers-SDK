#if canImport(UIKit) && (os(iOS) || os(tvOS)) && !targetEnvironment(macCatalyst)
import GoogleInteractiveMediaAds
import ILAVPlayerOverlay
import UIKit

/// Google IMA engine for `ILAdPlanPlayer`. The ad renders in `adContainer`, which the host places over the video.
@MainActor
public final class ILAdPlanIMA: NSObject, ILLinearAdEngine {
    private static let watchdogSeconds: UInt64 = 120

    private let adContainer: UIView
    private weak var viewController: UIViewController?
    private var showContainer: ((Bool) -> Void)?
    private let loader = IMAAdsLoader(settings: nil)
    private var manager: IMAAdsManager?
    private var continuation: CheckedContinuation<ILLinearAdOutcome, Never>?
    private var onStart: (() -> Void)?
    private var didStart = false
    private var guardTask: Task<Void, Never>?

    public init(adContainer: UIView, viewController: UIViewController?) {
        self.adContainer = adContainer
        self.viewController = viewController
        super.init()
        loader.delegate = self
    }

    /// The ad renders in a view inside the overlay, under the Buy panel.
    public convenience init(overlay: ILOverlayPlayerView) {
        self.init(adContainer: overlay.adContainer, viewController: nil)
        showContainer = { [weak overlay] visible in overlay?.setAdContainerVisible(visible) }
    }

    private var hostController: UIViewController? {
        if let viewController { return viewController }
        var responder: UIResponder? = adContainer
        while let next = responder {
            if let controller = next as? UIViewController { return controller }
            responder = next.next
        }
        return nil
    }

    public func playAd(tagURL: String, adsResponse: String?, deadline: Date, onStart: @escaping () -> Void) async -> ILLinearAdOutcome {
        cancel()
        didStart = false
        self.onStart = onStart
        return await withCheckedContinuation { waiting in
            continuation = waiting
            showContainer?(true)
            let display = IMAAdDisplayContainer(adContainer: adContainer, viewController: hostController)
            // The VAST the player already holds is handed over, so the same URL is not requested twice.
            let request = adsResponse.map { IMAAdsRequest(adsResponse: $0, adDisplayContainer: display, contentPlayhead: nil, userContext: nil) }
                ?? IMAAdsRequest(adTagUrl: tagURL, adDisplayContainer: display, contentPlayhead: nil, userContext: nil)
            let wait = max(0, deadline.timeIntervalSinceNow)
            guardTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                guard !Task.isCancelled, let self, !self.didStart else { return }
                self.finish(.noFill)
            }
            loader.requestAds(with: request)
        }
    }

    /// After the start: the ad's own duration plus 30 s of foreground time (120 s if IMA gives none).
    private func watchStarted(durationSeconds: Double) {
        guardTask?.cancel()
        // Never past 180 s, whatever the VAST declares.
        let limit = min(durationSeconds > 0 ? durationSeconds + 30 : Double(Self.watchdogSeconds), 180)
        guardTask = Task { [weak self] in
            var used = 0.0
            while used < limit {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled else { return }
                if UIApplication.shared.applicationState == .active { used += 0.5 }
            }
            self?.finish(.failed)
        }
    }

    public func cancel() {
        if continuation != nil { finish(.failed) }
    }

    private func finish(_ outcome: ILLinearAdOutcome) {
        guardTask?.cancel()
        guardTask = nil
        showContainer?(false)
        manager?.destroy()
        manager = nil
        onStart = nil
        let waiting = continuation
        continuation = nil
        waiting?.resume(returning: outcome)
    }
}

extension ILAdPlanIMA: IMAAdsLoaderDelegate {
    public func adsLoader(_ loader: IMAAdsLoader, adsLoadedWith adsLoadedData: IMAAdsLoadedData) {
        guard continuation != nil, let loaded = adsLoadedData.adsManager else { return }
        manager = loaded
        loaded.delegate = self
        loaded.initialize(with: nil)
    }

    public func adsLoader(_ loader: IMAAdsLoader, failedWith adErrorData: IMAAdLoadingErrorData) {
        finish(adErrorData.adError.code == .VAST_EMPTY_RESPONSE ? .noFill : .unavailable)
    }
}

extension ILAdPlanIMA: IMAAdsManagerDelegate {
    public func adsManager(_ adsManager: IMAAdsManager, didReceive event: IMAAdEvent) {
        guard adsManager === manager else { return }
        switch event.type {
        case .LOADED: adsManager.start()
        case .STARTED:
            didStart = true
            watchStarted(durationSeconds: event.ad?.duration ?? 0)
            onStart?()
        case .ALL_ADS_COMPLETED: finish(.completed)
        default: break
        }
    }

    public func adsManager(_ adsManager: IMAAdsManager, didReceive error: IMAAdError) {
        guard adsManager === manager else { return }
        finish(didStart ? .failed : error.code == .VAST_EMPTY_RESPONSE ? .noFill : .unavailable)
    }

    public func adsManagerDidRequestContentPause(_ adsManager: IMAAdsManager) {}
    public func adsManagerDidRequestContentResume(_ adsManager: IMAAdsManager) {}
}
#endif

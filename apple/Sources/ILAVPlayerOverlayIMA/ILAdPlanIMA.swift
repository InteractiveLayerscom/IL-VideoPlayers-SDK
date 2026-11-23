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
    private var loaded = false
    /// After LOADED, an ad whose media does not start fails after this many seconds.
    static let mediaLoadTimeoutSeconds: TimeInterval = 5
    /// After the hold, a loaded ad that has not started is given up after this long, even if IMA stays silent.
    static let loadedStartLimitSeconds: TimeInterval = ILAdPlanPlayer.loadedStartLimitSeconds
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
        loaded = false
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
                guard self.loaded else {
                    self.finish(.noFill)
                    return
                }
                // As on Android, an ad IMA has loaded is not cut by the hold. It still has to start within IMA's media
                // timeout plus a margin; STARTED cancels this task and the started-ad watchdog takes over.
                try? await Task.sleep(nanoseconds: UInt64(Self.loadedStartLimitSeconds * 1_000_000_000))
                guard !Task.isCancelled, !self.didStart else { return }
                self.finish(.failed)
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
        let settings = IMAAdsRenderingSettings()
        settings.loadVideoTimeout = Self.mediaLoadTimeoutSeconds
        loaded.initialize(with: settings)
    }

    public func adsLoader(_ loader: IMAAdsLoader, failedWith adErrorData: IMAAdLoadingErrorData) {
        finish(Self.noAnswer(adErrorData.adError.code) ? .noFill : .unavailable)
    }
}

extension ILAdPlanIMA: IMAAdsManagerDelegate {
    public func adsManager(_ adsManager: IMAAdsManager, didReceive event: IMAAdEvent) {
        guard adsManager === manager else { return }
        switch event.type {
        case .LOADED:
            loaded = true
            adsManager.start()
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
        finish(didStart ? .failed : Self.noAnswer(error.code) ? .noFill : .unavailable)
    }

    /// No usable answer from the ad server: the break goes to its next request instead of asking the same URL again
    /// for the MP4 path (seen on the Android emulator: a stalled first request spent the whole hold).
    static func noAnswer(_ code: IMAErrorCode) -> Bool {
        [.VAST_EMPTY_RESPONSE, .VAST_LOAD_TIMEOUT, .FAILED_TO_REQUEST_ADS, .VAST_TOO_MANY_REDIRECTS].contains(code)
    }

    public func adsManagerDidRequestContentPause(_ adsManager: IMAAdsManager) {}
    public func adsManagerDidRequestContentResume(_ adsManager: IMAAdsManager) {}
}
#endif

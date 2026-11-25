import AVFoundation
import ILAVPlayerOverlay
import UIKit

// The smallest app that shows both ways of using IL's ad plan on AVPlayer (iOS and tvOS, one target):
//   load: the SDK asks IL for the plan (`ILAdPlanPlayer.load`) and plays the breaks itself.
//   host: the app plays its own breaks through the customer's relay (IL's per-break API) and reports them.
// Everything comes from launch arguments, never from hosts written here (see README.md):
//   -ILMode load|host|bare (bare: plays -ILVideo on a plain AVPlayerLayer, for diagnostics)  -ILOrigin <IL console origin>  -ILRelay <relay origin>  -ILProject <id>  -ILAsset <id>
//   -ILVideo <content URL>  -ILStartAt <s>  -ILBreakAt <s>  -ILAdServer <origin that answers the ad tag, for local runs>

private func setting(_ key: String) -> String? { UserDefaults.standard.string(forKey: key) }

private func log(_ line: String) { NSLog("[ILExample] %@", line) }

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = PlayerController()
        window?.makeKeyAndVisible()
        return true
    }
}

@MainActor
final class PlayerController: UIViewController {
    private let player = AVPlayer()
    private lazy var surface = ILOverlayPlayerView(player: player, source: .sidecar)
    private var reader: ILAdPlanPlayer?
    private let label = UILabel()
    private var breakObserver: Any?
    private var breakDone = false

    override var preferredFocusEnvironments: [UIFocusEnvironment] { [surface] }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        surface.frame = view.bounds
        surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // Buy (scene product and during a break) is drawn only with commerce on.
        surface.commerceEnabled = true
        view.addSubview(surface)
        label.textColor = .white
        label.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        label.frame = CGRect(x: 16, y: 40, width: 900, height: 24)
        view.addSubview(label)
        Task { await run() }
    }

    private func status(_ text: String) {
        label.text = text
        log(text)
    }

    private func run() async {
        guard let video = setting("ILVideo").flatMap(URL.init(string:)) else { return status("missing -ILVideo") }
        if setting("ILMode") == "bare" {
            // Diagnostics: the same URL on a plain AVPlayerLayer, with no IL surface at all.
            surface.removeFromSuperview()
            let layer = AVPlayerLayer(player: player)
            layer.frame = view.bounds
            view.layer.insertSublayer(layer, at: 0)
            player.replaceCurrentItem(with: AVPlayerItem(url: video))
            player.play()
            return status("bare: \(video.lastPathComponent)")
        }
        player.replaceCurrentItem(with: AVPlayerItem(url: video))
        if let start = setting("ILStartAt").flatMap(Double.init) {
            await player.seek(to: CMTime(seconds: start, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        }
        let events: ILAdPlanPlayer.Events = { type, format, id in log("event \(type) \(format ?? "-") \(id)") }
        switch setting("ILMode") ?? "load" {
        case "host": await runHostDriven(events: events)
        default: await runLoad(events: events)
        }
        player.play()
    }

    // MARK: Mode 1 — the SDK requests the plan

    private func runLoad(events: @escaping ILAdPlanPlayer.Events) async {
        guard let origin = setting("ILOrigin"), let project = setting("ILProject"), let asset = setting("ILAsset") else {
            return status("missing -ILOrigin/-ILProject/-ILAsset")
        }
        // Sends app=apple:<bundle id>; that id must be registered in the Console. Nil: play without ads.
        reader = await ILAdPlanPlayer.load(overlay: surface, player: player, origin: origin, project: project, asset: asset,
                                           locale: "es", events: events)
        status(reader == nil ? "load: no plan, playing without ads" : "load: plan attached")
        await reader?.start()
    }

    // MARK: Mode 2 — the app plays its own breaks (IL per-break API through the customer's relay)

    private func runHostDriven(events: @escaping ILAdPlanPlayer.Events) async {
        guard let relay = setting("ILRelay"), let origin = setting("ILOrigin"), let asset = setting("ILAsset") else {
            return status("missing -ILRelay/-ILOrigin/-ILAsset")
        }
        guard let created = await post(relay + "/playback", ["asset_id": asset]),
              let playbackID = created["playback_id"] as? String, let plan = created["plan"] as? [String: Any],
              let json = try? JSONSerialization.data(withJSONObject: plan) else { return status("host: no plan, playing without ads") }
        // The relay answers with the plan of IL's console: planOrigin is that console's origin.
        reader = ILAdPlanPlayer(overlay: surface, player: player, planJSON: json, planOrigin: origin, sessionID: "", locale: "es",
                                events: events)
        guard let reader else { return status("host: plan refused, playing without ads") }
        let breakAt = setting("ILBreakAt").flatMap(Double.init) ?? 58
        // Tell the reader where the app's breaks are, so graphics keep their clearance.
        reader.setBreaks([breakAt])
        await reader.start()
        status("host: plan attached, break at \(breakAt) s")
        let boundary = NSValue(time: CMTime(seconds: breakAt, preferredTimescale: 600))
        breakObserver = player.addBoundaryTimeObserver(forTimes: [boundary], queue: .main) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.breakDone else { return }
                self.breakDone = true
                Task { await self.playOwnBreak(at: breakAt, relay: relay, playbackID: playbackID) }
            }
        }
    }

    private func playOwnBreak(at position: Double, relay: String, playbackID: String) async {
        guard let reader, let content = player.currentItem else { return }
        let resumeAt = player.currentTime()
        player.pause()
        reader.breakStarted(at: position)
        status("host: break at \(position) s")
        defer { finishBreak(content: content, at: resumeAt) }
        guard let answer = await post(relay + "/break", ["playback_id": playbackID, "cue_seconds": position]),
              let tag = answer["ad_tag_url"] as? String else { return status("host: no ad for this break") }
        // The app's own VAST player: fetch the tag, play the MP4, report the ad with its VAST.
        guard let vast = await get(adServerURL(tag)), let media = mediaFile(vast) else { return status("host: no playable ad") }
        let ad = AVPlayerItem(url: media)
        player.replaceCurrentItem(with: ad)
        player.play()
        reader.adStarted(tagURL: tag, vastXML: vast)
        status("host: ad playing")
        for await _ in NotificationCenter.default.notifications(named: AVPlayerItem.didPlayToEndTimeNotification, object: ad) { break }
        reader.adEnded()
    }

    private func finishBreak(content: AVPlayerItem, at time: CMTime) {
        reader?.breakEnded()
        player.replaceCurrentItem(with: content)
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
        player.play()
        status("host: break ended")
    }

    /// For local runs only: `-ILAdServer` answers the ad tag instead of the real ad server, same path and query.
    private func adServerURL(_ tag: String) -> String {
        guard let local = setting("ILAdServer"), var parts = URLComponents(string: tag),
              let target = URLComponents(string: local) else { return tag }
        parts.scheme = target.scheme
        parts.host = target.host
        parts.port = target.port
        return parts.string ?? tag
    }

    private func mediaFile(_ vast: String) -> URL? {
        // "<MediaFile " with the space: "<MediaFiles>" comes first and is the container, not the file.
        guard let start = vast.range(of: "<MediaFile "), let open = vast.range(of: ">", range: start.upperBound..<vast.endIndex),
              let close = vast.range(of: "</MediaFile>", range: open.upperBound..<vast.endIndex) else { return nil }
        let text = vast[open.upperBound..<close.lowerBound].replacingOccurrences(of: "<![CDATA[", with: "")
            .replacingOccurrences(of: "]]>", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        return URL(string: text)
    }

    private func get(_ url: String) async -> String? {
        guard let target = URL(string: url), let (data, response) = try? await URLSession.shared.data(from: target),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private func post(_ url: String, _ body: [String: Any]) async -> [String: Any]? {
        guard let target = URL(string: url) else { return nil }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

import AVFoundation

@MainActor
final class HLSDateRangeFeed: NSObject, AVPlayerItemMetadataCollectorPushDelegate {
    private let item: AVPlayerItem
    private let collector = AVPlayerItemMetadataCollector(identifiers: nil, classifyingLabels: [OverlayCue.hlsClass])
    private var receive: (([OverlayCue]) -> Void)?
    private var reading: Task<Void, Never>?

    init(item: AVPlayerItem, receive: @escaping ([OverlayCue]) -> Void) {
        self.item = item
        self.receive = receive
        super.init()
        collector.setDelegate(self, queue: .main)
        item.add(collector)
    }

    func stop() {
        guard receive != nil else { return }
        receive = nil
        reading?.cancel()
        collector.setDelegate(nil, queue: nil)
        item.remove(collector)
    }

    deinit {
        reading?.cancel()
        if receive != nil {
            collector.setDelegate(nil, queue: nil)
            item.remove(collector)
        }
    }

    nonisolated func metadataCollector(_ metadataCollector: AVPlayerItemMetadataCollector,
                                       didCollect groups: [AVDateRangeMetadataGroup],
                                       indexesOfNewGroups: IndexSet, indexesOfModifiedGroups: IndexSet) {
        // This collector delivers on the main queue. Each callback is a complete seekable snapshot.
        MainActor.assumeIsolated {
            guard receive != nil else { return }
            reading?.cancel()
            reading = Task { [weak self] in
                var cues = [OverlayCue]()
                for group in groups {
                    if Task.isCancelled { return }
                    if let cue = await Self.cue(from: group) { cues.append(cue) }
                }
                if !Task.isCancelled { self?.receive?(cues) }
            }
        }
    }

    private static func cue(from group: AVDateRangeMetadataGroup) async -> OverlayCue? {
        guard group.classifyingLabel == OverlayCue.hlsClass else { return nil }
        var fields = [String: String]()
        for item in group.items where item.keySpace == .hlsDateRange {
            guard let key = item.key as? String else { continue }
            switch key {
            case "X-IL-FORMAT", "X-ASSET-URI", "X-ASSET-MIMETYPE", "X-IL-IMPRESSION-URI":
                fields[key] = try? await item.load(.stringValue)
            default:
                continue
            }
        }
        // AVFoundation derives endDate from either END-DATE or DURATION.
        return OverlayCue(id: group.uniqueID, format: fields["X-IL-FORMAT"],
                          start: group.startDate, end: group.endDate, image: fields["X-ASSET-URI"],
                          mime: fields["X-ASSET-MIMETYPE"], impression: fields["X-IL-IMPRESSION-URI"])
    }
}

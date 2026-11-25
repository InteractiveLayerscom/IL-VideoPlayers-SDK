import Foundation

/// IL's ad plan, read with the rules of web/ads.mjs. No player or network access here.
struct AdPlan {
    struct Request: Equatable { let provider: String; let tagURL: String }
    struct Cut: Equatable {
        let id: String
        let atMs: Int64
        let requests: [Request]
        /// `preroll` or `midroll`: an `il-shop-<position>-` ad only has a product in a break of that position.
        var position: String { atMs == 0 ? "preroll" : "midroll" }
    }
    struct Window: Equatable {
        let id: String
        let start: Int64
        let end: Int64
        let targeting: [String: String]
    }
    struct Pacing {
        let minMs: Int64
        let maxMs: Int64?
        let gapMs: Int64
        let clearanceMs: Int64
        let maxPerVideo: Int?
    }
    struct Graphic: Equatable { let format: String; let tagURL: String }
    struct Shop { let url: String; let leadMs: Int64; let pacing: Pacing; let windows: [Window] }
    struct GraphicAd: Equatable { let imageURL: String; let mime: String; let impressions: [String] }
    enum GraphicAnswer: Equatable { case ad(GraphicAd), noFill, unusable }
    struct LinearAd {
        var wrapperURL: String?
        var mediaURL: String?
        var durationMs: Int64 = 0
        var creativeID: String?
        var deliveryID: String?
        /// VAST `Ad@id` and the linear `Creative@id`, as IMA exposes them (`adId`, `creativeID`).
        var adID: String?
        var linearCreativeID: String?
        var impressions: [String] = []
        var tracking: [String: [String]] = [:]
    }

    static let prepareMs: Int64 = 4000
    private static let lateMs: Int64 = 2000
    private static let minStartSpacingMs: Int64 = 30000
    private static let unsupported: Set<String> = ["Wrapper", "AdVerifications", "ViewableImpression", "InteractiveCreativeFile",
                                                   "AdParameters", "Icon", "CompanionAds", "Linear", "HTMLResource", "IFrameResource"]

    let cuts: [Cut]
    let windows: [Window]
    let graphics: [Graphic]
    let pacing: Pacing?
    let shop: Shop?
    let page: String?
    /// The `sid` on every iADServer request, chosen as web/ads.mjs does.
    let sid: String
    /// Buy during a break: IL's grant names the plan's session, so only when the sid is that session.
    let breakShop: Bool
    /// `commerce.break_url`, when Buy during a break may use it (same rules as web/ads.mjs `breakUrl`).
    let breakURL: String?
    let expiresAt: Date
    /// A version 2 plan: a short-lived native GAM approval that stops being used the moment it expires.
    let native: Bool
    /// The plan offers `commerce.break_url`, usable or not for this session.
    let breakURLOffered: Bool
    /// The `grant` of `commerce.url`, sent as `renew` so a renewed plan keeps the same commerce session.
    let renewGrant: String?

    /// Nil for anything but a current version 1 or 2 plan on a timeline this player can follow.
    /// `breaks` are break positions the host reported (`setBreaks`): windows keep their clearance around them too.
    static func read(_ data: Data, now: Date, origin: String?, sessionID: String, breaks hostBreaks: [Int64] = []) -> AdPlan? {
        guard let plan = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let version = (plan["version"] as? NSNumber)?.intValue, version == 1 || version == 2,
              (plan["version"] as? NSNumber)?.doubleValue == Double(version), !isBool(plan["version"]),
              let expiry = (plan["expires_at"] as? String).flatMap(date), expiry > now else { return nil }
        // As web/ads.mjs readPlan: version 2 only under the native GAM contract and never more than 120 s ahead.
        if version == 2 {
            guard (plan["native_gam"] as? [String: Any])?["contract"] as? String == "native-gam-plan-v1",
                  expiry.timeIntervalSince(now) <= 120 else { return nil }
        }
        // Stitched windows are content time and need a clock that knows when an ad is in the stream.
        if let timeline = plan["timeline"], !(timeline is NSNull) { return nil }
        let page = plan["page_url"] as? String
        let commerce = plan["commerce"] as? [String: Any]
        // As on the web, `scenes` that are present but unusable void the whole plan.
        var scenesRow: (formats: [Any], rows: [Any], rules: Pacing, row: [String: Any])?
        if present(plan["scenes"]) {
            guard let scenes = plan["scenes"] as? [String: Any], let formats = scenes["formats"] as? [Any],
                  let rows = scenes["windows"] as? [Any], let rules = readPacing(scenes["pacing"]) else { return nil }
            scenesRow = (formats, rows, rules, scenes)
        } else if !(plan["cuts"] is [Any]) && !shopUsable(commerce) {
            return nil
        }
        let shopValid = readShop(commerce, origin: origin, breaks: []) != nil
        let shopSession = shopValid ? (commerce?["session"] as? String).flatMap {
            $0.range(of: "^[A-Za-z0-9_.:-]{1,128}$", options: .regularExpression) != nil ? $0 : nil
        } : nil
        // The host's own view id first, then the plan's session, then a fresh id for this playback.
        let session = !sessionID.isEmpty ? sessionID : shopSession ?? randomID()
        let cuts = readCuts(plan["cuts"] as? [Any], page: page, session: session)
        let breaks = (cuts.map(\.atMs) + hostBreaks).sorted()
        var windows: [Window] = []
        var graphics: [Graphic] = []
        var pacing: Pacing?
        if let scenes = scenesRow {
            pacing = scenes.rules
            windows = readWindows(scenes.rows, pacing: scenes.rules, breaks: breaks)
            graphics = readGraphics(scenes.row["graphics"] as? [Any], formats: scenes.formats, overlay: scenes.row["overlay"] as? [String: Any])
        }
        let shop = readShop(commerce, origin: origin, breaks: breaks)
        let breakShop = shopSession != nil && shopSession == session
        // The card of an ad comes from the plan's own origin, under the grant that names this session.
        var breakURL: String?
        if breakShop, let shop, let raw = commerce?["break_url"] as? String, OverlayCue.httpsURL(raw) != nil,
           Self.origin(raw) != nil, Self.origin(raw) == Self.origin(shop.url) { breakURL = raw }
        let grant = shop.map { query($0.url, "grant") }.flatMap { $0.isEmpty ? nil : $0 }
        return AdPlan(cuts: cuts, windows: windows, graphics: graphics, pacing: pacing, shop: shop, page: page,
                      sid: session, breakShop: breakShop, breakURL: breakURL, expiresAt: expiry, native: version == 2,
                      breakURLOffered: commerce?["break_url"] is String,
                      renewGrant: grant)
    }

    /// iADServer names a shop-linked ad `il-shop-<preroll|midroll>-<43-char delivery id>` (VAST `Ad@id`).
    static func shopDelivery(adID: String?, position: String) -> String? {
        guard let adID, adID.range(of: "^il-shop-(preroll|midroll)-[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              adID.hasPrefix("il-shop-" + position + "-") else { return nil }
        return String(adID.dropFirst(("il-shop-" + position + "-").count))
    }

    /// `commerce.break_url` taken verbatim, with `cut`, `tag`, `creative`, `delivery` and `locale` appended.
    func breakCardURL(cut: String, tag: String, creative: String, delivery: String, locale: String) -> URL? {
        guard let breakURL else { return nil }
        let pairs = [("cut", cut), ("tag", tag), ("creative", creative), ("delivery", delivery),
                     ("locale", OverlayCommerce.language(locale))]
        return URL(string: Self.withParams(breakURL, pairs.map { $0.0 + "=" + Self.encode($0.1) }.joined(separator: "&")))
    }

    /// web/ads.mjs `withParams`: appends to the query, before any fragment, without touching what is there.
    static func withParams(_ href: String, _ extra: String) -> String {
        let pieces = href.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let base = pieces[0]
        let joiner = !base.contains("?") ? "?" : base.hasSuffix("?") || base.hasSuffix("&") ? "" : "&"
        return base + joiner + extra + (pieces.count > 1 ? "#" + pieces[1] : "")
    }

    /// The break card of exactly this ad, drawn for as long as the ad plays, or nil.
    static func breakCue(_ data: Data, creative: String, delivery: String) -> OverlayCue? {
        guard var card = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              card["id"] as? String == delivery, card["linearCreativeId"] as? String == creative,
              card["format"] as? String == "midroll" else { return nil }
        // The ad decides how long it lasts, whatever the clock says: the card follows it.
        card["start"] = 0
        card["end"] = 9_000_000_000_000_000
        guard let rows = try? JSONSerialization.data(withJSONObject: [card]),
              let cues = try? OverlayCue.decodeSidecar(rows), cues.count == 1 else { return nil }
        return cues[0]
    }

    /// `Ad@id` and the linear `Creative@id` of the first ad of a VAST document.
    static func adIdentity(_ xml: String) -> (adID: String?, creativeID: String?) {
        guard let root = document(xml), let ad = root.named("Ad").first else { return (nil, nil) }
        let creative = ad.all("Creative").first { !$0.all("Linear").isEmpty }
        return (ad.attributes["id"], creative?.attributes["id"])
    }

    private static func randomID() -> String {
        (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    private static func shopUsable(_ row: [String: Any]?) -> Bool {
        guard let row, row["kind"] as? String == "scene_product", let lead = integer(row["lead_ms"]), lead >= 0,
              readPacing(row["pacing"]) != nil, row["windows"] is [Any], let url = row["url"] as? String else { return false }
        return OverlayCue.httpsURL(url) != nil
    }

    /// A JSON integer that fits a safe integer, as `Number.isSafeInteger`.
    private static func integer(_ value: Any?) -> Int64? {
        guard let value = number(value), value.rounded() == value, abs(value) <= 9_007_199_254_740_991 else { return nil }
        return Int64(value)
    }

    private static func isBool(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, !isBool(value), value.doubleValue.isFinite else { return nil }
        return value.doubleValue
    }

    private static func ms(_ seconds: Double) -> Int64 { Int64((seconds * 1000).rounded()) }

    private static func date(_ text: String) -> Date? {
        let plain = ISO8601DateFormatter()
        if let value = plain.date(from: text) { return value }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text)
    }

    private static func present(_ value: Any?) -> Bool { value != nil && !(value is NSNull) }

    private static func readPacing(_ value: Any?) -> Pacing? {
        guard let row = value as? [String: Any], let minimum = number(row["min_seconds"]) else { return nil }
        for key in ["max_seconds", "gap_after_seconds", "cut_clearance_seconds", "max_per_video"]
        where present(row[key]) && number(row[key]) == nil { return nil }
        if present(row["max_per_video"]), integer(row["max_per_video"]) == nil { return nil }
        return Pacing(minMs: ms(minimum), maxMs: number(row["max_seconds"]).map(ms),
                      gapMs: number(row["gap_after_seconds"]).map(ms) ?? 0,
                      clearanceMs: number(row["cut_clearance_seconds"]).map(ms) ?? 0,
                      maxPerVideo: integer(row["max_per_video"]).map { Int($0) })
    }

    private static func readShop(_ row: [String: Any]?, origin: String?, breaks: [Int64]) -> Shop? {
        guard let row, let origin, origin.hasPrefix("https://"), shopUsable(row),
              let url = row["url"] as? String, URLComponents(string: url).flatMap(Self.origin) == Self.origin(origin),
              let lead = integer(row["lead_ms"]), let pacing = readPacing(row["pacing"]),
              let rows = row["windows"] as? [Any] else { return nil }
        return Shop(url: url, leadMs: lead, pacing: pacing, windows: readWindows(rows, pacing: pacing, breaks: breaks))
    }

    /// `https://host[:port]` with the host lowercased and the default port dropped, as a WHATWG URL origin.
    private static func origin(_ parts: URLComponents) -> String? {
        guard parts.scheme?.lowercased() == "https", let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil else { return nil }
        return "https://" + host + (parts.port.map { $0 == 443 ? "" : ":\($0)" } ?? "")
    }

    static func origin(_ text: String) -> String? { URLComponents(string: text).flatMap(origin) }

    /// The path with `.` and `..` segments resolved, as a WHATWG URL does.
    private static func normalizedPath(_ path: String) -> String {
        var out: [Substring] = []
        let segments = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        for (index, segment) in segments.enumerated() {
            let last = index == segments.count - 1
            if segment == "." || segment.lowercased() == "%2e" {
                if last { out.append("") }
            } else if segment == ".." || ["%2e%2e", ".%2e", "%2e."].contains(segment.lowercased()) {
                if !out.isEmpty { out.removeLast() }
                if last { out.append("") }
            } else {
                out.append(segment)
            }
        }
        return "/" + out.joined(separator: "/")
    }

    /// What web/ads.mjs accepts: the exact origin and the path `/gampad/ads` once parsed and normalised.
    /// Returns the tag rewritten to that canonical origin and path, or nil.
    static func allowed(_ provider: String, _ url: String) -> String? {
        let expected: String
        switch provider {
        case "gam": expected = "https://pubads.g.doubleclick.net"
        case "iadserver": expected = "https://ads.iadserver.com"
        default: return nil
        }
        guard url.range(of: "[\\s]", options: .regularExpression) == nil, let parts = URLComponents(string: url),
              origin(parts) == expected, normalizedPath(parts.percentEncodedPath) == "/gampad/ads" else { return nil }
        return expected + "/gampad/ads" + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
            + (parts.percentEncodedFragment.map { "#" + $0 } ?? "")
    }

    private static func readCuts(_ rows: [Any]?, page: String?, session: String) -> [Cut] {
        var cuts: [Cut] = []
        for case let row as [String: Any] in rows ?? [] {
            guard let id = row["id"] as? String, let at = number(row["at"]), at >= 0 else { continue }
            let source = row["requests"] as? [Any] ?? [["provider": "gam", "tag_url": row["tag_url"] ?? NSNull()]]
            var requests: [Request] = []
            for case let entry as [String: Any] in source where requests.count < 3 {
                guard let provider = entry["provider"] as? String, let raw = entry["tag_url"] as? String,
                      var url = allowed(provider, raw) else { continue }
                if provider == "gam", let page { url = setQuery(setQuery(url, "url", page), "description_url", page) }
                if provider == "iadserver", !session.isEmpty { url = setQuery(url, "sid", session) }
                requests.append(Request(provider: provider, tagURL: url))
            }
            if !requests.isEmpty { cuts.append(Cut(id: id, atMs: ms(at), requests: requests)) }
        }
        return cuts.enumerated().sorted { ($0.element.atMs, $0.offset) < ($1.element.atMs, $1.offset) }.map(\.element)
    }

    private static func readGraphics(_ rows: [Any]?, formats: [Any], overlay: [String: Any]?) -> [Graphic] {
        var tags: [String: String] = [:]
        if let unit = overlay?["ad_unit"] as? String, unit.range(of: "^/\\d+(/[^\\s/]+)*$", options: .regularExpression) != nil {
            tags["overlay_300x250"] = unit
        }
        for case let row as [String: Any] in rows ?? [] {
            guard let format = row["format"] as? String, format == "super" || format == "l_shape", tags[format] == nil,
                  let raw = row["tag_url"] as? String, let url = allowed("gam", raw) else { continue }
            tags[format] = url
        }
        return formats.compactMap { value in
            guard let format = value as? String, let url = tags.removeValue(forKey: format) else { return nil }
            return Graphic(format: format, tagURL: url)
        }
    }

    private static func text(_ value: Any) -> String {
        if isBool(value) { return (value as? NSNumber)?.boolValue == true ? "true" : "false" }
        if let number = value as? NSNumber { return number.stringValue }
        return value as? String ?? ""
    }

    private static func readWindows(_ rows: [Any], pacing: Pacing, breaks: [Int64]) -> [Window] {
        var result: [Window] = []
        for case let row as [String: Any] in rows {
            guard let id = row["id"] as? String, let first = integer(row["start_ms"]), let last = integer(row["end_ms"]) else { continue }
            var start = first, end = last
            if let cap = pacing.maxMs { end = min(end, start + cap) }
            if pacing.clearanceMs > 0 {
                for cut in breaks {
                    if cut <= start, start < cut + pacing.clearanceMs { start = cut + pacing.clearanceMs }
                    else if start < cut, cut < end + pacing.clearanceMs { end = min(end, cut - pacing.clearanceMs) }
                }
            }
            guard end - start >= pacing.minMs else { continue }
            var targeting: [String: String] = [:]
            for (key, value) in row["targeting"] as? [String: Any] ?? [:] {
                targeting[key] = (value as? [Any]).map { $0.map(text).joined(separator: ",") } ?? text(value)
            }
            result.append(Window(id: id, start: start, end: end, targeting: targeting))
        }
        return result.sorted { $0.start < $1.start }
    }

    static func pacingAllows(_ window: Window, shown: [Window], pacing: Pacing) -> Bool {
        if let cap = pacing.maxPerVideo, shown.count >= cap { return false }
        return shown.allSatisfy { other in
            other.start <= window.start
                ? window.start - other.start >= minStartSpacingMs && window.start >= other.end + pacing.gapMs
                : other.start - window.start >= minStartSpacingMs && other.start >= window.end + pacing.gapMs
        }
    }

    /// What has been asked and shown in one playback.
    struct Schedule {
        let plan: AdPlan
        var settled = Set<String>()
        var attempted = Set<String>()
        var products: [String: String] = [:]
        var shown: [Window] = []
        var pending: [Window] = []
        var overlayAvailable = false

        private var servable: [Graphic] {
            overlayAvailable ? plan.graphics : plan.graphics.filter { $0.format != "overlay_300x250" }
        }

        init(plan: AdPlan) { self.plan = plan }

        var committed: [Window] { shown + pending }

        /// Marks breaks behind a late start and returns the pre-roll if it is still due.
        mutating func join(positionMs: Int64) -> Cut? {
            var preroll: Cut?
            for cut in plan.cuts {
                if cut.atMs == 0, positionMs <= 1000 { preroll = cut }
                else if cut.atMs <= positionMs { settled.insert(cut.id) }
            }
            return preroll
        }

        /// The break due now. A seek past several breaks plays none of the backlog.
        mutating func dueCut(nowMs: Int64) -> Cut? {
            var due: Cut?
            for cut in plan.cuts where !settled.contains(cut.id) && cut.atMs <= nowMs {
                if let earlier = due { settled.insert(earlier.id) }
                due = cut
            }
            guard let due else { return nil }
            settled.insert(due.id)
            return due.atMs > 0 && nowMs - due.atMs > AdPlan.lateMs ? nil : due
        }

        private func eligible(_ window: Window, _ rules: Pacing, leadMs: Int64, nowMs: Int64) -> Bool {
            window.start - leadMs <= nowMs && nowMs < window.end
                && window.end - max(window.start, nowMs) >= rules.minMs
                && AdPlan.pacingAllows(window, shown: committed, pacing: rules)
        }

        func nextProduct(nowMs: Int64) -> Window? {
            guard let shop = plan.shop else { return nil }
            return shop.windows.first { products[$0.id] == nil && eligible($0, shop.pacing, leadMs: shop.leadMs, nowMs: nowMs) }
        }

        private func productAwaited(_ window: Window, nowMs: Int64) -> Bool {
            guard let shop = plan.shop else { return false }
            if let state = products[window.id] { return state != "empty" }
            guard let entry = shop.windows.first(where: { $0.id == window.id }) else { return false }
            return eligible(entry, shop.pacing, leadMs: 0, nowMs: max(nowMs, entry.start))
        }

        func nextGraphic(nowMs: Int64) -> Window? {
            guard let pacing = plan.pacing, !servable.isEmpty else { return nil }
            return plan.windows.first {
                !attempted.contains($0.id) && eligible($0, pacing, leadMs: AdPlan.prepareMs, nowMs: nowMs)
                    && !productAwaited($0, nowMs: nowMs)
            }
        }

        var nextFormat: Graphic { servable[shown.count % servable.count] }
    }

    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")
    private static func encode(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "" }

    static func setQuery(_ url: String, _ key: String, _ value: String) -> String {
        let pieces = url.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let parts = pieces[0].split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        var pairs = parts.count > 1 ? parts[1].split(separator: "&").map(String.init) : []
        pairs.removeAll { $0.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) == key }
        pairs.append(key + "=" + encode(value))
        return parts[0] + "?" + pairs.joined(separator: "&") + (pieces.count > 1 ? "#" + pieces[1] : "")
    }

    static func query(_ url: String, _ key: String) -> String {
        let head = url.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
        let parts = head.split(separator: "?", maxSplits: 1)
        guard parts.count > 1 else { return "" }
        for pair in parts[1].split(separator: "&") {
            let field = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            if field[0] == key, field.count == 2 { return String(field[1]).removingPercentEncoding ?? "" }
        }
        return ""
    }

    /// The app's identity for Google Ad Manager (`msid` = bundle id, `an` = app name), as Google's "VAST ad tag URL
    /// parameters" asks for in-app requests. Replaced in tests.
    nonisolated(unsafe) static var appIdentity: (id: String, name: String)? = {
        guard let id = Bundle.main.bundleIdentifier, !id.isEmpty else { return nil }
        let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? id
        return (id, name)
    }()

    /// Adds `msid`/`an` to a GAM request this SDK sends itself, unless the tag already carries them. IMA adds the
    /// app's identity to the requests it makes, so tags handed to IMA are left alone. Never page parameters for an app.
    static func withAppIdentity(_ url: String) -> String {
        guard let app = appIdentity, URLComponents(string: url)?.host?.lowercased() == "pubads.g.doubleclick.net" else { return url }
        var out = url
        if query(out, "msid").isEmpty { out = setQuery(out, "msid", app.id) }
        if query(out, "an").isEmpty { out = setQuery(out, "an", app.name) }
        return out
    }

    static func correlated(_ url: String) -> String {
        let stamp = String(Int64(Date().timeIntervalSince1970 * 1000)) + String(format: "%06d", Int.random(in: 0..<1_000_000))
        return withConsent(setQuery(url, "correlator", stamp))
    }

    /// Where the app's consent platform stores the IAB strings. Replaced in tests.
    nonisolated(unsafe) static var consentStore: UserDefaults = .standard

    /// Adds the consent the app's CMP stored under the IAB keys (TCF v2, US Privacy, GPP) as the standard
    /// ad request parameters. Nothing stored, nothing added.
    static func withConsent(_ url: String) -> String {
        let store = consentStore
        var out = url
        if let applies = store.object(forKey: "IABTCF_gdprApplies") as? NSNumber { out = setQuery(out, "gdpr", applies.intValue == 1 ? "1" : "0") }
        if let tc = store.string(forKey: "IABTCF_TCString"), !tc.isEmpty { out = setQuery(out, "gdpr_consent", tc) }
        if let usp = store.string(forKey: "IABUSPrivacy_String"), !usp.isEmpty { out = setQuery(out, "us_privacy", usp) }
        if let gpp = store.string(forKey: "IABGPP_HDR_GppString"), !gpp.isEmpty { out = setQuery(out, "gpp", gpp) }
        if let sections = store.string(forKey: "IABGPP_GppSID"), !sections.isEmpty {
            out = setQuery(out, "gpp_sid", sections.replacingOccurrences(of: "_", with: ","))
        }
        return out
    }

    /// The wall-clock guard of one MP4 ad. Time counts only while the app is active, the limit follows the
    /// VAST duration, and a jump ahead faster than playback marks the ad as scrubbed: no `complete` then.
    struct AdWatch {
        /// No ad holds the content longer than this, whatever its VAST declares.
        static let capMs: Int64 = 180_000
        let limitMs: Int64
        /// The first frame must show by then (the break's hold deadline), or the ad is given up.
        let startBy: Date?
        private(set) var elapsedMs: Int64 = 0
        private(set) var scrubbed = false
        private var lastPositionMs: Int64?

        init(durationMs: Int64, startBy: Date? = nil) {
            limitMs = min(durationMs > 0 ? durationMs + 30000 : 120000, Self.capMs)
            self.startBy = startBy
        }

        /// Whether an ad may still be started at `now`.
        static func mayStart(now: Date, deadline: Date) -> Bool { now < deadline }

        /// Returns true once the ad has used its whole limit, or showed no frame by `startBy`.
        mutating func tick(positionMs: Int64, stepMs: Int64, active: Bool, started: Bool = true, now: Date = Date()) -> Bool {
            if !started, let startBy, now >= startBy { return true }
            if active { elapsedMs += stepMs }
            if let last = lastPositionMs, positionMs - last > stepMs + 1000 { scrubbed = true }
            lastPositionMs = positionMs
            return elapsedMs >= limitMs
        }
    }

    static func graphicTag(_ tagURL: String, format: String, targeting: [String: String], page: String?) -> String {
        var pairs = query(tagURL, "cust_params").split(separator: "&").map(String.init)
        let replaced = Set(targeting.keys).union(["il_format"])
        pairs.removeAll { replaced.contains(String($0.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)[0])) }
        pairs += targeting.keys.sorted().map { $0 + "=" + encode(targeting[$0] ?? "") }
        pairs.append("il_format=" + encode(format))
        var url = setQuery(tagURL, "cust_params", pairs.joined(separator: "&"))
        if let page { url = setQuery(setQuery(url, "url", page), "description_url", page) }
        return withAppIdentity(correlated(url))
    }

    func productURL(windowID: String, locale: String) -> URL? {
        guard let shop else { return nil }
        return URL(string: Self.withParams(shop.url, "window=" + Self.encode(windowID) + "&locale=" + Self.encode(OverlayCommerce.language(locale))))
    }

    /// The product card clipped to its window, or nil if it cannot be drawn with a Buy action.
    static func productCue(_ data: Data, window: Window) -> OverlayCue? {
        guard var card = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let start = number(card["start"]), let end = number(card["end"]) else { return nil }
        if present(card["window"]), card["window"] as? String != window.id { return nil }
        card["start"] = max(window.start, Int64(start))
        card["end"] = min(window.end, Int64(end))
        guard let rows = try? JSONSerialization.data(withJSONObject: [card]),
              let cues = try? OverlayCue.decodeSidecar(rows), cues.count == 1, let cue = cues.first,
              cue.commerce != nil, cue.format != .midroll else { return nil }
        return cue
    }

    static func graphicCue(id: String, format: String, window: Window, ad: GraphicAd) -> OverlayCue? {
        OverlayCue(id: id, format: format == "l_shape" ? "l" : "super",
                   start: Date(timeIntervalSince1970: Double(window.start) / 1000),
                   end: Date(timeIntervalSince1970: Double(window.end) / 1000),
                   image: ad.imageURL, mime: ad.mime, impression: nil)
    }

    // MARK: VAST

    final class Node {
        let name: String
        let attributes: [String: String]
        var children: [Node] = []
        var text = ""
        init(name: String, attributes: [String: String]) { self.name = name; self.attributes = attributes }
        func named(_ name: String) -> [Node] { children.filter { $0.name == name } }
        func one(_ name: String) -> Node? {
            let found = named(name)
            return found.count == 1 ? found[0] : nil
        }
        func all(_ name: String) -> [Node] { (self.name == name ? [self] : []) + children.flatMap { $0.all(name) } }
        var value: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private final class TreeBuilder: NSObject, XMLParserDelegate {
        var root: Node?
        private var stack: [Node] = []

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?,
                    attributes: [String: String] = [:]) {
            let node = Node(name: name, attributes: attributes)
            if let parent = stack.last { parent.children.append(node) } else { root = node }
            stack.append(node)
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            _ = stack.popLast()
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) { stack.last?.text += string }

        func parser(_ parser: XMLParser, foundCDATA block: Data) {
            stack.last?.text += String(decoding: block, as: UTF8.self)
        }
    }

    private static func document(_ xml: String) -> Node? {
        guard xml.utf8.count <= 262_144, xml.range(of: "<!doctype", options: .caseInsensitive) == nil else { return nil }
        let parser = XMLParser(data: Data(xml.utf8))
        parser.shouldResolveExternalEntities = false
        let builder = TreeBuilder()
        parser.delegate = builder
        guard parser.parse(), let root = builder.root, root.name == "VAST" else { return nil }
        return root
    }

    private static func hasUnsupported(_ node: Node) -> Bool {
        unsupported.contains(node.name) || node.children.contains(where: hasUnsupported)
    }

    private static func seconds(_ value: String?) -> Double? {
        let parts = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ":", omittingEmptySubsequences: false)
        guard (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                .range(of: "^\\d{2}:[0-5]\\d:[0-5]\\d(\\.\\d{1,3})?$", options: .regularExpression) != nil,
              let hours = Double(parts[0]), let minutes = Double(parts[1]), let rest = Double(parts[2]) else { return nil }
        return hours * 3600 + minutes * 60 + rest
    }

    static func parseGraphic(_ xml: String, format: String, availableMs: Int64) -> GraphicAnswer {
        guard let root = document(xml) else { return .unusable }
        let ads = root.named("Ad")
        if ads.isEmpty { return .noFill }
        guard ads.count == 1, !hasUnsupported(ads[0]), let inline = ads[0].one("InLine"),
              let container = inline.one("Creatives")?.one("Creative")?.one("NonLinearAds"),
              let nonLinear = container.one("NonLinear"), let resource = nonLinear.one("StaticResource"),
              nonLinear.attributes["apiFramework"] == nil,
              let mime = resource.attributes["creativeType"]?.lowercased(), mime == "image/png" || mime == "image/jpeg",
              let width = nonLinear.attributes["width"].flatMap(Double.init),
              let height = nonLinear.attributes["height"].flatMap(Double.init), width > 0, height > 0 else { return .unusable }
        let shape: Double = format == "super" ? 20.0 / 3 : 16.0 / 9
        guard abs(width / height / shape - 1) <= 0.02 else { return .unusable }
        if let minimum = nonLinear.attributes["minSuggestedDuration"] {
            guard let needed = seconds(minimum), needed * 1000 <= Double(availableMs) else { return .unusable }
        }
        guard OverlayCue.httpsURL(resource.value) != nil else { return .unusable }
        var urls = inline.named("Impression").map(\.value)
        for list in container.named("TrackingEvents") {
            urls += list.named("Tracking").filter { $0.attributes["event"] == "creativeView" }.map(\.value)
        }
        guard urls.allSatisfy({ OverlayCue.httpsURL($0) != nil }) else { return .unusable }
        return .ad(GraphicAd(imageURL: resource.value, mime: mime, impressions: urls))
    }

    /// Adds this answer to `ad`. False means no playable ad.
    static func parseLinear(_ xml: String, into ad: inout LinearAd) -> Bool {
        ad.wrapperURL = nil
        guard let root = document(xml), let node = root.named("Ad").first else { return false }
        ad.impressions += node.all("Impression").map(\.value).filter { OverlayCue.httpsURL($0) != nil }
        for tracking in node.all("Tracking") {
            guard let event = tracking.attributes["event"], OverlayCue.httpsURL(tracking.value) != nil else { continue }
            ad.tracking[event, default: []].append(tracking.value)
        }
        if let wrapper = node.one("Wrapper") {
            guard let next = wrapper.one("VASTAdTagURI")?.value, OverlayCue.httpsURL(next) != nil else { return false }
            ad.wrapperURL = next
            return true
        }
        guard let linear = node.all("Linear").first else { return false }
        if ad.adID == nil {
            ad.adID = node.attributes["id"]
            ad.linearCreativeID = node.all("Creative").first { !$0.all("Linear").isEmpty }?.attributes["id"]
        }
        let files = linear.all("MediaFile").filter {
            $0.attributes["delivery"] == "progressive" && $0.attributes["type"]?.lowercased() == "video/mp4"
                && OverlayCue.httpsURL($0.value) != nil && (Int($0.attributes["width"] ?? "") ?? 0) <= 1920
        }
        guard let file = files.max(by: { (Int($0.attributes["width"] ?? "") ?? 0) < (Int($1.attributes["width"] ?? "") ?? 0) }) else { return false }
        ad.mediaURL = file.value
        ad.durationMs = Int64((seconds(linear.all("Duration").first?.value) ?? 0) * 1000)
        if let shop = node.all("Extension").first(where: { $0.attributes["type"] == "iADServerShop" })?.all("Shop").first {
            ad.creativeID = shop.attributes["creativeId"]
            ad.deliveryID = shop.attributes["deliveryId"]
        }
        return true
    }
}

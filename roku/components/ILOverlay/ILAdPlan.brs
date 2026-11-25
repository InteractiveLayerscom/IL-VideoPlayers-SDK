' Reads IL's ad plan with the rules of web/ads.mjs. No node or network access here.

' `hostSid` is the app's own view id. Roku has no standard consent storage: `consent` is what the host passes
' ({ gdpr, gdpr_consent, us_privacy, gpp, gpp_sid }), added to every request this SDK makes itself.
function adPlanRead(plan as Dynamic, nowSeconds as LongInteger, origin as Dynamic, hostSid as String, consent = invalid as Dynamic) as Dynamic
    if type(plan) <> "roAssociativeArray" then return invalid
    if not adPlanIsNumber(plan.version) then return invalid
    if (plan.version <> 1 and plan.version <> 2) or not adPlanIsText(plan.expires_at) then return invalid
    expires = adPlanIsoSeconds(plan.expires_at)
    if expires = invalid then return invalid
    if expires <= nowSeconds then return invalid
    ' Version 2 is a short-lived native-format approval from Google Ad Manager: only its contract, and never more
    ' than 120 s ahead, as web/ads.mjs readPlan requires.
    if plan.version = 2
        if type(plan.native_gam) <> "roAssociativeArray" then return invalid
        if not adPlanIsText(plan.native_gam.contract) then return invalid
        if plan.native_gam.contract <> "native-gam-plan-v1" or expires - nowSeconds > 120 then return invalid
    end if
    ' Stitched windows are content time and this player has no content clock under SSAI.
    if plan.timeline <> invalid then return invalid
    ' As on the web, `scenes` that are present but unusable void the whole plan.
    if plan.scenes <> invalid
        if type(plan.scenes) <> "roAssociativeArray" then return invalid
        if type(plan.scenes.formats) <> "roArray" or type(plan.scenes.windows) <> "roArray" or not adPlanPacing(plan.scenes.pacing) then return invalid
    else if type(plan.cuts) <> "roArray" and not adPlanShopUsable(plan.commerce)
        return invalid
    end if
    page = invalid
    if adPlanIsText(plan.page_url) then page = plan.page_url
    shop = adPlanShop(plan.commerce, origin)
    shopSid = invalid
    if shop <> invalid
        if adPlanIsText(shop.session)
            if createObject("roRegex", "^[A-Za-z0-9_.:-]{1,128}$", "").isMatch(shop.session) then shopSid = shop.session
        end if
    end if
    ' The host's own view id first, then the plan's session, then a fresh id for this playback.
    sid = hostSid
    if sid = ""
        if shopSid <> invalid then sid = shopSid else sid = adPlanRandomId()
    end if
    breakShop = false
    if shopSid <> invalid then breakShop = shopSid = sid
    if type(consent) <> "roAssociativeArray" then consent = {}
    result = { cuts: adPlanCuts(plan.cuts, page, sid), windows: [], graphics: [], pacing: invalid, shop: invalid, shopWindows: [], page: page, sid: sid, breakShop: breakShop, consent: consent }
    result.version = plan.version
    result.expires = expires
    result.scenes = plan.scenes
    ' The renewal grant travels in commerce.url, whatever origin the plan was read with.
    result.grant = ""
    if type(plan.commerce) = "roAssociativeArray"
        if adPlanIsText(plan.commerce.url) then result.grant = adPlanQuery(plan.commerce.url, "grant")
    end if
    ' Buy during an ad: IL's grant names the view's session, so only when the sid is that session (as on the web).
    result.breakUrl = invalid
    if shop <> invalid and breakShop
        if adPlanIsText(shop.break_url)
            if adPlanOrigin(shop.break_url) <> invalid and adPlanOrigin(shop.break_url) = adPlanOrigin(shop.url) then result.breakUrl = shop.break_url
        end if
    end if
    if shop <> invalid then result.shop = shop
    adPlanSetBreaks(result, [])
    if plan.scenes <> invalid
        result.pacing = plan.scenes.pacing
        result.graphics = adPlanGraphics(plan.scenes)
    end if
    return result
end function

' Windows keep the plan's clearance around its own cuts and around the breaks the host says it will play.
sub adPlanSetBreaks(read as Object, hostSeconds as Object)
    breaks = []
    for each cut in read.cuts
        breaks.push(cut.at)
    end for
    breaks.append(hostSeconds)
    if read.scenes <> invalid then read.windows = adPlanWindows(read.scenes.windows, read.scenes.pacing, breaks)
    if read.shop <> invalid then read.shopWindows = adPlanWindows(read.shop.windows, read.shop.pacing, breaks)
end sub

' `url` with each [key, value] pair appended, keeping a fragment last.
function adPlanAppend(url as String, pairs as Object) as String
    pieces = url.split("#")
    base = pieces[0]
    joiner = "&"
    if instr(1, base, "?") = 0
        joiner = "?"
    else if right(base, 1) = "?" or right(base, 1) = "&"
        joiner = ""
    end if
    for each pair in pairs
        base = base + joiner + pair[0] + "=" + pair[1].encodeUriComponent()
        joiner = "&"
    end for
    if pieces.count() > 1 then base = base + "#" + pieces[1]
    return base
end function

' `roku:dev` for a sideloaded channel, else `roku:<channel id>`; invalid when the id is not what IL registers.
function adPlanAppId(channelId as Dynamic, sideloaded as Boolean) as Dynamic
    if sideloaded then return "roku:dev"
    if not adPlanIsText(channelId) then return invalid
    if not createObject("roRegex", "^(dev|[0-9]{1,10}(_[0-9a-f]{1,8})?)$", "").isMatch(channelId) then return invalid
    return "roku:" + channelId
end function

' GET <origin>/il-player/app-plan for this video and app. HTTPS only, as every plan and product URL.
function adPlanAppPlanUrl(origin as Dynamic, project as Dynamic, asset as Dynamic, app as Dynamic, renew = "" as String) as Dynamic
    if not adPlanIsText(origin) or not adPlanIsText(project) or not adPlanIsText(asset) or not adPlanIsText(app) then return invalid
    base = adPlanOrigin(origin)
    if base = invalid or project = "" or asset = "" then return invalid
    pairs = [["project", project], ["asset", asset], ["app", app]]
    if renew <> "" then pairs.push(["renew", renew])
    return adPlanAppend(base + "/il-player/app-plan", pairs)
end function

' iADServer names a shop-linked ad `il-shop-<position>-<delivery id>` in VAST Ad@id.
function adPlanShopAd(adId as Dynamic) as Dynamic
    if not adPlanIsText(adId) then return invalid
    match = createObject("roRegex", "^il-shop-(preroll|midroll)-([A-Za-z0-9_-]{43})$", "").match(adId)
    if match.count() = 0 then return invalid
    return { position: match[1], delivery: match[2] }
end function

' commerce.break_url taken verbatim, plus the identity of the ad on screen.
function adPlanBreakCardUrl(breakUrl as String, cutId as String, tag as String, creativeId as String, delivery as String, locale as String) as String
    return adPlanAppend(breakUrl, [["cut", cutId], ["tag", tag], ["creative", creativeId], ["delivery", delivery], ["locale", locale]])
end function

' The card of exactly this delivery and creative, timed by the ad rather than by the paused content's clock.
function adPlanBreakCard(body as Dynamic, creativeId as String, delivery as String) as Dynamic
    if not adPlanIsText(body) then return invalid
    card = parseJson(body)
    if type(card) <> "roAssociativeArray" then return invalid
    if not adPlanIsText(card.id) or not adPlanIsText(card.linearCreativeId) or not adPlanIsText(card.format) then return invalid
    if card.id <> delivery or card.linearCreativeId <> creativeId or card.format <> "midroll" then return invalid
    cue = {}
    cue.append(card)
    cue.start = 0
    cue["end"] = 9007199254740991#
    return cue
end function

' What an ad's own player reports: RAF's ad (Ad@id, Creative@id) and the iADServer tag that produced it.
function adPlanRafShop(ad as Dynamic, tagUrl as Dynamic) as Dynamic
    if type(ad) <> "roAssociativeArray" then return invalid
    if not adPlanIsText(ad.adId) or not adPlanIsText(ad.creativeId) then return invalid
    if ad.creativeId = "" then return invalid
    tag = ""
    if adPlanCanonical("iadserver", tagUrl) <> invalid then tag = adPlanQuery(tagUrl, "tag")
    return { adId: ad.adId, creativeId: ad.creativeId, tag: tag }
end function

' Seconds since the epoch for an ISO 8601 date with `Z` or a `+hh:mm` / `-hh:mm` offset, or invalid.
function adPlanIsoSeconds(text as String) as Dynamic
    match = createObject("roRegex", "^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|z|([+-])(\d\d):(\d\d))$", "").match(text)
    if match.count() = 0 then return invalid
    clock = createObject("roDateTime")
    clock.fromISO8601String(match[1] + "Z")
    seconds& = clock.asSeconds()
    if match[4] <> ""
        offset& = (val(match[5]) * 60 + val(match[6])) * 60
        if match[4] = "+" then seconds& = seconds& - offset& else seconds& = seconds& + offset&
    end if
    return seconds&
end function

function adPlanRandomId() as String
    digits = "0123456789abcdef"
    out = ""
    for index = 1 to 32
        out = out + mid(digits, rnd(16), 1)
    end for
    return out
end function

function adPlanPacing(pacing as Dynamic) as Boolean
    if type(pacing) <> "roAssociativeArray" then return false
    if not adPlanIsNumber(pacing.min_seconds) then return false
    for each key in ["max_seconds", "gap_after_seconds", "cut_clearance_seconds", "max_per_video"]
        if pacing[key] <> invalid
            if not adPlanIsNumber(pacing[key]) then return false
        end if
    end for
    if pacing.max_per_video <> invalid
        if not adPlanWhole(pacing.max_per_video) then return false
    end if
    return true
end function

function adPlanShopUsable(commerce as Dynamic) as Boolean
    if type(commerce) <> "roAssociativeArray" then return false
    if not adPlanIsText(commerce.kind) or not adPlanIsText(commerce.url) then return false
    if commerce.kind <> "scene_product" or not adPlanWhole(commerce.lead_ms) then return false
    return adPlanPacing(commerce.pacing) and type(commerce.windows) = "roArray" and adPlanOrigin(commerce.url) <> invalid
end function

function adPlanShop(commerce as Dynamic, origin as Dynamic) as Dynamic
    if not adPlanIsText(origin) or not adPlanShopUsable(commerce) then return invalid
    own = adPlanOrigin(commerce.url)
    if own = invalid or own <> adPlanOrigin(origin) then return invalid
    return commerce
end function

' `https://host[:port]` with the host lowercased and the default port dropped, as a WHATWG URL origin.
function adPlanOrigin(url as String) as Dynamic
    match = createObject("roRegex", "^https://([a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:([0-9]+))?([/?#][^\s]*)?$", "i").match(url)
    if match.count() = 0 then return invalid
    port = ""
    if match.count() > 4
        if match[4] <> "" and match[4] <> "443" then port = ":" + match[4]
    end if
    return "https://" + lcase(match[1]) + port
end function

' What web/ads.mjs accepts, rewritten to the canonical origin, or invalid. The host's case and `:443` are
' normalised as a browser does; dot segments in the path (`/gampad/./ads`) are refused here.
function adPlanCanonical(provider as Dynamic, url as Dynamic) as Dynamic
    if not adPlanIsText(provider) or not adPlanIsText(url) then return invalid
    expected = ""
    if provider = "gam" then expected = "https://pubads.g.doubleclick.net"
    if provider = "iadserver" then expected = "https://ads.iadserver.com"
    if expected = "" or adPlanOrigin(url) <> expected then return invalid
    rest = createObject("roRegex", "^https://[^/?#]+(.*)$", "i").match(url)
    if rest.count() = 0 then return invalid
    if not createObject("roRegex", "^/gampad/ads([?#]\S*)?$", "").isMatch(rest[1]) then return invalid
    return expected + rest[1]
end function

function adPlanAllowed(provider as Dynamic, url as Dynamic) as Boolean
    return adPlanCanonical(provider, url) <> invalid
end function

function adPlanCuts(cuts as Dynamic, page as Dynamic, sid as String) as Object
    result = []
    if type(cuts) <> "roArray" then return result
    for each cut in cuts
        entry = adPlanCut(cut, page, sid)
        if entry <> invalid
            position = result.count()
            while position > 0 and result[position - 1].at > entry.at
                position = position - 1
            end while
            adPlanInsert(result, position, entry)
        end if
    end for
    return result
end function

sub adPlanInsert(list as Object, position as Integer, value as Object)
    list.push(value)
    index = list.count() - 1
    while index > position
        list[index] = list[index - 1]
        index = index - 1
    end while
    list[position] = value
end sub

function adPlanCut(cut as Dynamic, page as Dynamic, sid as String) as Dynamic
    if type(cut) <> "roAssociativeArray" then return invalid
    if not adPlanIsText(cut.id) or not adPlanIsNumber(cut.at) then return invalid
    if cut.at < 0 then return invalid
    source = cut.requests
    if type(source) <> "roArray" then source = [{ provider: "gam", tag_url: cut.tag_url }]
    requests = []
    for each item in source
        if requests.count() < 3 and type(item) = "roAssociativeArray"
            url = adPlanCanonical(item.provider, item.tag_url)
            if url <> invalid
                if item.provider = "gam" and page <> invalid
                    url = adPlanSetQuery(url, "url", page)
                    url = adPlanSetQuery(url, "description_url", page)
                end if
                if item.provider = "iadserver" and sid <> "" then url = adPlanSetQuery(url, "sid", sid)
                requests.push({ provider: item.provider, tagUrl: url })
            end if
        end if
    end for
    if requests.count() = 0 then return invalid
    position = ""
    if adPlanIsText(cut.position) then position = cut.position
    return { id: cut.id, at: cut.at, position: position, requests: requests }
end function

function adPlanSetQuery(url as String, key as String, value as String) as String
    pieces = url.split("#")
    base = pieces[0]
    marker = instr(1, base, "?")
    pairs = []
    path = base
    if marker > 0
        path = left(base, marker - 1)
        for each pair in mid(base, marker + 1).split("&")
            if pair <> "" and pair.split("=")[0] <> key then pairs.push(pair)
        end for
    end if
    pairs.push(key + "=" + value.encodeUriComponent())
    result = path + "?" + pairs.join("&")
    if pieces.count() > 1 then result = result + "#" + pieces[1]
    return result
end function

function adPlanQuery(url as String, key as String) as String
    marker = instr(1, url, "?")
    if marker = 0 then return ""
    for each pair in mid(url.split("#")[0], marker + 1).split("&")
        if pair.split("=")[0] = key then return mid(pair, len(key) + 2).decodeUriComponent()
    end for
    return ""
end function

function adPlanCorrelated(url as String, consent = invalid as Dynamic) as String
    clock = createObject("roDateTime")
    stamp = clock.asSeconds().toStr() + right("000" + clock.getMilliseconds().toStr(), 3) + rnd(999999).toStr()
    url = adPlanSetQuery(url, "correlator", stamp)
    if type(consent) = "roAssociativeArray"
        for each key in ["gdpr", "gdpr_consent", "us_privacy", "gpp", "gpp_sid"]
            value = consent[key]
            if adPlanIsNumber(value) then value = value.toStr()
            if adPlanIsText(value)
                if value <> "" then url = adPlanSetQuery(url, key, value)
            end if
        end for
    end if
    return url
end function

function adPlanGraphics(scenes as Object) as Object
    tags = {}
    tags.setModeCaseSensitive()
    if type(scenes.graphics) = "roArray"
        for each graphic in scenes.graphics
            if type(graphic) = "roAssociativeArray"
                if adPlanIsText(graphic.format) and adPlanAllowed("gam", graphic.tag_url)
                    if (graphic.format = "super" or graphic.format = "l_shape") and not tags.doesExist(graphic.format)
                        tags[graphic.format] = adPlanCanonical("gam", graphic.tag_url)
                    end if
                end if
            end if
        end for
    end if
    result = []
    for each format in scenes.formats
        if adPlanIsText(format)
            if tags.doesExist(format)
                result.push({ format: format, tagUrl: tags[format] })
                tags.delete(format)
            end if
        end if
    end for
    return result
end function

function adPlanMs(seconds as Dynamic) as Double
    return int(seconds * 1000# + 0.5)
end function

function adPlanOptional(value as Dynamic, fallback as Double) as Double
    if value = invalid then return fallback
    return value
end function

function adPlanWindows(windows as Object, pacing as Object, breaks as Object) as Object
    clearance = adPlanMs(adPlanOptional(pacing.cut_clearance_seconds, 0))
    result = []
    for each window in windows
        if type(window) = "roAssociativeArray"
            if adPlanIsText(window.id) and adPlanWhole(window.start_ms) and adPlanWhole(window.end_ms)
                first# = window.start_ms
                last# = window.end_ms
                if pacing.max_seconds <> invalid
                    limit# = first# + adPlanMs(pacing.max_seconds)
                    if limit# < last# then last# = limit#
                end if
                if clearance > 0
                    for each at in breaks
                        cut# = adPlanMs(at)
                        if cut# <= first# and first# < cut# + clearance
                            first# = cut# + clearance
                        else if first# < cut# and cut# < last# + clearance
                            if cut# - clearance < last# then last# = cut# - clearance
                        end if
                    end for
                end if
                if last# - first# >= adPlanMs(pacing.min_seconds)
                    item = { id: window.id, start: first#, targeting: window.targeting }
                    item["end"] = last#
                    position = result.count()
                    while position > 0 and result[position - 1].start > first#
                        position = position - 1
                    end while
                    adPlanInsert(result, position, item)
                end if
            end if
        end if
    end for
    return result
end function

function adPlanPacingAllows(window as Object, shown as Object, pacing as Object) as Boolean
    if pacing.max_per_video <> invalid
        if shown.count() >= pacing.max_per_video then return false
    end if
    gap = adPlanMs(adPlanOptional(pacing.gap_after_seconds, 0))
    for each other in shown
        if other.start <= window.start
            if window.start - other.start < 30000 or window.start < other["end"] + gap then return false
        else
            if other.start - window.start < 30000 or other.start < window["end"] + gap then return false
        end if
    end for
    return true
end function

' The break due at this content time. Older unsettled cuts are skipped: a seek must not play a backlog.
function adPlanDueCut(cuts as Object, settled as Object, nowMs as Double) as Dynamic
    due = invalid
    for each cut in cuts
        if not settled.doesExist(cut.id) and adPlanMs(cut.at) <= nowMs
            if due <> invalid then settled[due.id] = true
            due = cut
        end if
    end for
    if due = invalid then return invalid
    if due.at > 0 and nowMs - adPlanMs(due.at) > 2000
        settled[due.id] = true
        return invalid
    end if
    return due
end function

function adPlanNextWindow(windows as Object, attempted as Object, shown as Object, pacing as Object, leadMs as Double, nowMs as Double) as Dynamic
    minimum = adPlanMs(pacing.min_seconds)
    for each window in windows
        if not attempted.doesExist(window.id) and window.start - leadMs <= nowMs and nowMs < window["end"]
            from# = window.start
            if nowMs > from# then from# = nowMs
            if window["end"] - from# >= minimum and adPlanPacingAllows(window, shown, pacing) then return window
        end if
    end for
    return invalid
end function

function adPlanGraphicTag(tagUrl as String, format as String, targeting as Dynamic, page as Dynamic, consent = invalid as Dynamic) as String
    params = adPlanQuery(tagUrl, "cust_params")
    if type(targeting) = "roAssociativeArray"
        for each key in targeting
            value = targeting[key]
            if type(value) = "roArray"
                parts = []
                for each piece in value
                    parts.push(adPlanText(piece))
                end for
                value = parts.join(",")
            end if
            params = adPlanParam(params, key, adPlanText(value))
        end for
    end if
    params = adPlanParam(params, "il_format", format)
    url = adPlanSetQuery(tagUrl, "cust_params", params)
    if page <> invalid
        url = adPlanSetQuery(url, "url", page)
        url = adPlanSetQuery(url, "description_url", page)
    end if
    return adPlanCorrelated(url, consent)
end function

function adPlanText(value as Dynamic) as String
    if adPlanIsText(value) then return value
    if adPlanIsNumber(value) then return value.toStr()
    if type(value) = "Boolean" or type(value) = "roBoolean"
        if value then return "true"
        return "false"
    end if
    return ""
end function

function adPlanParam(params as String, key as String, value as String) as String
    kept = []
    for each pair in params.split("&")
        if pair <> "" and pair.split("=")[0] <> key then kept.push(pair)
    end for
    kept.push(key + "=" + value.encodeUriComponent())
    return kept.join("&")
end function

' Returns { noFill } for an empty VAST, { failed } for anything this static image renderer cannot draw.
function adPlanParseVast(xmlText as Dynamic, format as String, availableMs as Double) as Dynamic
    failed = { failed: true }
    if not adPlanIsText(xmlText) then return failed
    if len(xmlText) > 262144 or instr(1, lcase(xmlText), "<!doctype") > 0 then return failed
    root = adPlanXml(xmlText)
    if root = invalid then return failed
    if root.name <> "VAST" then return failed
    ads = adPlanNamed(root, "Ad")
    if ads.count() = 0 then return { noFill: true }
    if ads.count() <> 1 then return failed
    if adPlanHasUnsupported(ads[0]) then return failed
    inline = adPlanOne(ads[0], "InLine")
    creatives = adPlanOne(inline, "Creatives")
    creative = adPlanOne(creatives, "Creative")
    container = adPlanOne(creative, "NonLinearAds")
    nonLinear = adPlanOne(container, "NonLinear")
    resource = adPlanOne(nonLinear, "StaticResource")
    if resource = invalid then return failed
    if nonLinear.attrs.doesExist("apiFramework") then return failed
    mime = lcase(adPlanAttribute(resource.attrs, "creativeType"))
    if mime <> "image/png" and mime <> "image/jpeg" then return failed
    width = val(adPlanAttribute(nonLinear.attrs, "width"))
    height = val(adPlanAttribute(nonLinear.attrs, "height"))
    if width <= 0 or height <= 0 then return failed
    shape = 16 / 9
    if format = "super" then shape = 20 / 3
    if abs(width / height / shape - 1) > 0.02 then return failed
    duration = adPlanAttribute(nonLinear.attrs, "minSuggestedDuration")
    if duration <> ""
        match = createObject("roRegex", "^(\d{2}):([0-5]\d):([0-5]\d(\.\d{1,3})?)$", "").match(duration)
        if match.count() = 0 then return failed
        if (val(match[1]) * 3600 + val(match[2]) * 60 + val(match[3])) * 1000 > availableMs then return failed
    end if
    image = resource.text.trim()
    if not adPlanHttps(image) then return failed
    urls = []
    for each node in adPlanNamed(inline, "Impression")
        if not adPlanHttps(node.text.trim()) then return failed
        urls.push(node.text.trim())
    end for
    for each list in adPlanNamed(container, "TrackingEvents")
        for each tracking in adPlanNamed(list, "Tracking")
            if adPlanAttribute(tracking.attrs, "event") = "creativeView"
                if not adPlanHttps(tracking.text.trim()) then return failed
                urls.push(tracking.text.trim())
            end if
        end for
    end for
    return { imageUrl: image, mimeType: mime, impressions: urls }
end function

function adPlanAttribute(attributes as Object, name as String) as String
    value = attributes[name]
    if value = invalid then return ""
    return value
end function

function adPlanOne(parent as Dynamic, name as String) as Dynamic
    if parent = invalid then return invalid
    matches = adPlanNamed(parent, name)
    if matches.count() <> 1 then return invalid
    return matches[0]
end function

function adPlanNamed(node as Object, name as String) as Object
    found = []
    for each child in node.kids
        if child.name = name then found.push(child)
    end for
    return found
end function

function adPlanHttps(url as String) as Boolean
    return createObject("roRegex", "^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?([/?#][^\s\[\]{}<>" + chr(34) + "]*)?$", "i").isMatch(url)
end function

function adPlanHasUnsupported(node as Object) as Boolean
    for each blocked in ["Wrapper", "AdVerifications", "ViewableImpression", "InteractiveCreativeFile", "AdParameters", "Icon", "CompanionAds", "Linear", "HTMLResource", "IFrameResource"]
        if node.name = blocked then return true
    end for
    for each child in node.kids
        if adPlanHasUnsupported(child) then return true
    end for
    return false
end function

' A strict reader for the XML subset of VAST. Malformed input returns invalid.
function adPlanXml(text as String) as Dynamic
    stack = []
    root = invalid
    index = 1
    size = len(text)
    while index <= size
        open = instr(index, text, "<")
        if open = 0
            if stack.count() > 0 or mid(text, index).trim() <> "" then return invalid
            exit while
        end if
        if open > index
            piece = mid(text, index, open - index)
            if stack.count() > 0
                top = stack[stack.count() - 1]
                top.text = top.text + adPlanEntities(piece)
            else if piece.trim() <> ""
                return invalid
            end if
        end if
        if mid(text, open, 4) = "<!--"
            close = instr(open, text, "-->")
            if close = 0 then return invalid
            index = close + 3
        else if mid(text, open, 9) = "<![CDATA["
            close = instr(open, text, "]]>")
            if close = 0 or stack.count() = 0 then return invalid
            top = stack[stack.count() - 1]
            top.text = top.text + mid(text, open + 9, close - open - 9)
            index = close + 3
        else if mid(text, open, 2) = "<?"
            close = instr(open, text, "?>")
            if close = 0 then return invalid
            index = close + 2
        else if mid(text, open, 2) = "<!"
            return invalid
        else if mid(text, open, 2) = "</"
            close = instr(open, text, ">")
            if close = 0 or stack.count() = 0 then return invalid
            top = stack.pop()
            if top.name <> mid(text, open + 2, close - open - 2).trim() then return invalid
            index = close + 1
        else
            close = adPlanTagEnd(text, open + 1, size)
            if close = 0 then return invalid
            body = mid(text, open + 1, close - open - 1)
            selfClosed = right(body, 1) = "/"
            if selfClosed then body = left(body, len(body) - 1)
            node = adPlanTag(body)
            if node = invalid then return invalid
            if stack.count() > 0
                stack[stack.count() - 1].kids.push(node)
            else if root <> invalid
                return invalid
            else
                root = node
            end if
            if not selfClosed then stack.push(node)
            index = close + 1
        end if
    end while
    if stack.count() > 0 then return invalid
    return root
end function

function adPlanTagEnd(text as String, from as Integer, size as Integer) as Integer
    quote = ""
    index = from
    while index <= size
        letter = mid(text, index, 1)
        if quote <> ""
            if letter = quote then quote = ""
        else if letter = chr(34) or letter = "'"
            quote = letter
        else if letter = ">"
            return index
        else if letter = "<"
            return 0
        end if
        index = index + 1
    end while
    return 0
end function

function adPlanTag(body as String) as Dynamic
    size = len(body)
    index = 1
    while index <= size and not adPlanSpace(mid(body, index, 1))
        index = index + 1
    end while
    name = left(body, index - 1)
    if name = "" then return invalid
    attrs = {}
    attrs.setModeCaseSensitive()
    while true
        while index <= size and adPlanSpace(mid(body, index, 1))
            index = index + 1
        end while
        if index > size then exit while
        equals = instr(index, body, "=")
        if equals = 0 then return invalid
        key = mid(body, index, equals - index).trim()
        index = equals + 1
        while index <= size and adPlanSpace(mid(body, index, 1))
            index = index + 1
        end while
        quote = mid(body, index, 1)
        if key = "" or (quote <> chr(34) and quote <> "'") then return invalid
        close = instr(index + 1, body, quote)
        if close = 0 then return invalid
        attrs[key] = adPlanEntities(mid(body, index + 1, close - index - 1))
        index = close + 1
    end while
    return { name: name, attrs: attrs, kids: [], text: "" }
end function

function adPlanSpace(letter as String) as Boolean
    return letter = " " or letter = chr(9) or letter = chr(10) or letter = chr(13)
end function

function adPlanEntities(value as String) as String
    if instr(1, value, "&") = 0 then return value
    value = value.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", chr(34)).replace("&apos;", "'")
    return value.replace("&amp;", "&")
end function

function adPlanIsText(value as Dynamic) as Boolean
    return type(value) = "String" or type(value) = "roString"
end function

function adPlanIsNumber(value as Dynamic) as Boolean
    name = lcase(type(value))
    if left(name, 2) = "ro" then name = mid(name, 3)
    return name = "int" or name = "integer" or name = "longinteger" or name = "float" or name = "double"
end function

function adPlanWhole(value as Dynamic) as Boolean
    if not adPlanIsNumber(value) then return false
    if not (value >= 0 and value <= 9007199254740991#) then return false
    whole& = value
    return whole& = value
end function

' RAF hands each ad's creativeId and its tracking URLs. iADServer's impression URL names the delivery.
function adPlanRafSpot(ad as Dynamic) as Dynamic
    if type(ad) <> "roAssociativeArray" then return invalid
    if not adPlanIsText(ad.creativeId) or type(ad.tracking) <> "roArray" then return invalid
    if ad.creativeId = "" then return invalid
    delivery = createObject("roRegex", "^https://ads\.iadserver\.com/events/([^/?#]+)/impression([?#].*)?$", "")
    for each entry in ad.tracking
        if type(entry) = "roAssociativeArray"
            if adPlanIsText(entry.url)
                match = delivery.match(entry.url)
                if match.count() > 1 then return { creativeId: ad.creativeId, deliveryId: match[1].decodeUriComponent() }
            end if
        end if
    end for
    return invalid
end function

' RAF's tracking callback: each ad that starts sets the identity, or clears it for an ad without a shop.
sub adPlanTrack(top as Object, eventType = "" as Dynamic, ctx = invalid as Dynamic)
    if top.cancelled = true then return
    ' The card follows the ad: it leaves on complete, skip, close or error.
    if eventType = "Complete" or eventType = "Skip" or eventType = "Close" or eventType = "Error"
        top.spot = {}
        return
    end if
    if eventType <> "Impression" or type(ctx) <> "roAssociativeArray" then return
    spot = adPlanRafSpot(ctx.ad)
    if spot = invalid then spot = {}
    shop = adPlanRafShop(ctx.ad, top.adTag)
    if shop <> invalid then spot.shop = shop
    top.spot = spot
end sub

' Asks each request in plan order. The first that returns ads is the break.
function adPlanRunBreak(requests as Object, ads as Object, view as Dynamic, top as Object) as String
    ads.setTrackingCallback(adPlanTrack, top)
    ' `top.cancelled` is set by the render-thread guard once it gave the content back: a getAds() that answers
    ' late must not ask again, draw an ad over the content or fire impressions.
    for each request in requests
        if top.cancelled = true then return "break_error"
        ' Only an iADServer tag names the `tag` the break card is asked with.
        top.adTag = ""
        if request.provider = "iadserver" then top.adTag = request.tagUrl
        ads.setAdUrl(request.tagUrl)
        pods = ads.getAds()
        if top.cancelled = true then return "break_error"
        if pods <> invalid
            if pods.count() > 0
                ' showAds is false when the viewer left the ads with Back: that is not a complete break.
                if ads.showAds(pods, invalid, view) = true then return "break_end"
                return "break_error"
            end if
        end if
    end for
    return "break_error"
end function

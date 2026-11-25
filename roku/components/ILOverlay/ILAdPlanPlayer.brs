sub init()
    m.clock = m.top.findNode("ilPlanClock")
    m.clock.observeFieldScoped("fire", "planTick")
    m.guard = m.top.findNode("ilBreakGuard")
    m.guard.observeFieldScoped("fire", "breakGuard")
    m.renewTimer = m.top.findNode("ilPlanRenew")
    m.renewTimer.observeFieldScoped("fire", "renewPlan")
    m.plan = invalid
    m.fixedNow = invalid
    m.loader = invalid
    m.loadRevision = 0
    m.load = invalid
end sub

' Tests freeze "now" (seconds since the epoch); invalid returns to the device clock.
sub setClock(seconds as Dynamic)
    m.fixedNow = seconds
end sub

function planNow() as LongInteger
    if m.fixedNow <> invalid then return m.fixedNow
    clock = createObject("roDateTime")
    return clock.asSeconds()
end function

' Requests IL's plan for this video and app, then attaches and starts it. Without a plan (204, 404, a network
' failure or the timeout) `contentReady` turns true and the content plays without ads.
function loadPlan(overlay as Object, video as Object, sessionId as String, origin as Dynamic, project as Dynamic, asset as Dynamic, locale = "en" as String, consent = invalid as Dynamic) as Boolean
    stopPlan()
    info = createObject("roAppInfo")
    app = adPlanAppId(info.getID(), info.isDev())
    url = invalid
    if app <> invalid then url = adPlanAppPlanUrl(origin, project, asset, app)
    m.load = { overlay: overlay, video: video, sessionId: sessionId, origin: origin, project: project, asset: asset, locale: locale, consent: consent, app: app, renewing: false }
    if url = invalid
        m.load = invalid
        m.top.event = { type: "plan_unavailable", status: 0, app: app }
        m.top.contentReady = true
        return false
    end if
    requestPlan(url)
    return true
end function

sub requestPlan(url as String)
    cancelLoad(false)
    m.loadRevision = m.loadRevision + 1
    m.top.planUrl = url
    m.loader = createObject("roSGNode", "ILOverlayFeedRequest")
    m.loader.observeFieldScoped("result", "onPlanResult")
    ' Bounded like the reader's other requests: a slow console never holds the content for long.
    m.loader.request = { sessionId: m.load.sessionId, revision: m.loadRevision, kind: "plan", url: url, timeoutMs: 5000 }
    m.loader.control = "run"
end sub

sub cancelLoad(forget = true as Boolean)
    if m.loader <> invalid
        m.loader.unobserveFieldScoped("result")
        m.loader.control = "stop"
        m.loader = invalid
    end if
    m.renewTimer.control = "stop"
    if forget then m.load = invalid
end sub

sub onPlanResult(event as Object)
    receivePlan(event.getData())
end sub

' The answer to loadPlan or to a renewal. A renewal that fails changes nothing: the plan simply expires.
sub receivePlan(result as Dynamic)
    if m.load = invalid or type(result) <> "roAssociativeArray" then return
    if result.sessionId <> m.load.sessionId or result.revision <> m.loadRevision then return
    if m.loader <> invalid
        m.loader.unobserveFieldScoped("result")
        m.loader = invalid
    end if
    load = m.load
    plan = invalid
    if result.status = 200 and adPlanIsText(result.body) then plan = parseJson(result.body)
    if load.renewing
        if plan <> invalid then replacePlan(plan)
        return
    end if
    if plan <> invalid
        ' A plan IL issued for this view carries the view's session: it is the sid, whatever key the overlay uses.
        if adoptPlan(load.overlay, load.video, load.sessionId, "", plan, load.origin, load.locale, load.consent)
            m.load = load
            scheduleRenewal()
            startPlan()
            return
        end if
    end if
    ' 404 is the same answer for an unknown project, video or app: the app id sent is what to check first.
    m.top.event = { type: "plan_unavailable", status: result.status, app: load.app }
    m.load = invalid
    m.top.contentReady = true
end sub

' About 20 s before a version 2 plan expires, ask again with the current grant to keep the commerce session.
sub scheduleRenewal()
    m.renewTimer.control = "stop"
    if m.load = invalid or m.plan = invalid then return
    if m.plan.version <> 2 then return
    delay = m.plan.expires - planNow() - 20
    if delay < 1 then delay = 1
    m.renewTimer.duration = delay
    m.renewTimer.control = "start"
end sub

sub renewPlan()
    if m.load = invalid or m.plan = invalid then return
    url = adPlanAppPlanUrl(m.load.origin, m.load.project, m.load.asset, m.load.app, m.plan.grant)
    if url = invalid then return
    m.load.renewing = true
    requestPlan(url)
end sub

' Swaps in a newer plan for the same view. What was shown, attempted and settled, pacing and the commerce
' session stay, so nothing replays or counts twice.
function replacePlan(plan as Dynamic) as Boolean
    if m.plan = invalid then return false
    read = adPlanRead(plan, planNow(), m.origin, m.hostSid, m.consent)
    if read = invalid then return false
    if m.hostBreaks <> invalid then adPlanSetBreaks(read, m.hostBreaks)
    m.plan = read
    m.top.event = { type: "plan_renewed" }
    scheduleRenewal()
    return true
end function

' A version 2 plan is not used past `expires_at`, as `plan_expired` on the web.
function planExpired() as Boolean
    if m.plan = invalid then return false
    if m.plan.version <> 2 or planNow() < m.plan.expires then return false
    if m.inBreak
        if m.hostBreak then breakEnded() else finishBreak("break_error")
    end if
    stopPlan()
    m.top.event = { type: "plan_expired" }
    return true
end function

' `consent` is the host's consent: Roku has no standard storage for TCF, US Privacy or GPP strings.
function attachPlan(overlay as Object, video as Object, sessionId as String, plan as Dynamic, origin as Dynamic, locale = "en" as String, consent = invalid as Dynamic) as Boolean
    return adoptPlan(overlay, video, sessionId, sessionId, plan, origin, locale, consent)
end function

' `sessionId` keys the overlay and the answers; `hostSid` is the view id sent to iADServer ("" = the plan's session).
function adoptPlan(overlay as Object, video as Object, sessionId as String, hostSid as String, plan as Dynamic, origin as Dynamic, locale as String, consent as Dynamic) as Boolean
    stopPlan()
    read = adPlanRead(plan, planNow(), origin, hostSid, consent)
    if read = invalid then return false
    m.plan = read
    m.hostSid = hostSid
    m.origin = origin
    m.consent = consent
    m.hostBreaks = invalid
    m.hostBreak = false
    m.breakCard = invalid
    m.breakToken = 0
    m.overlay = overlay
    m.video = video
    m.sessionId = sessionId
    m.locale = locale
    m.settled = {}
    m.attempted = {}
    m.products = {}
    m.shown = []
    m.pendingWindows = {}
    m.planCues = []
    m.measure = {}
    m.calls = {}
    m.revision = 0
    m.busy = false
    m.productBusy = false
    m.inBreak = false
    m.preroll = false
    m.started = false
    m.clipId = invalid
    overlay.observeFieldScoped("impression", "onImpression")
    return true
end function

sub startPlan()
    if m.plan = invalid or m.started then return
    m.started = true
    position = contentMs()
    if position = invalid then position = 0
    first = invalid
    for each cut in m.plan.cuts
        if cut.at = 0 and position <= 1000
            first = cut
        else if adPlanMs(cut.at) <= position
            m.settled[cut.id] = true
        end if
    end for
    m.clock.control = "start"
    if first <> invalid
        m.preroll = true
        beginBreak(first)
    else
        m.top.contentReady = true
    end if
end sub

sub stopPlan()
    cancelLoad()
    if m.plan = invalid then return
    m.clock.control = "stop"
    m.guard.control = "stop"
    m.overlay.unobserveFieldScoped("impression")
    m.overlay.callFunc("setPlanCues", m.sessionId, [])
    if m.inBreak
        m.breakCard = invalid
        m.overlay.planBreak = false
        m.overlay.callFunc("setLinearAd", false, invalid)
        m.video.visible = true
    end if
    if m.breakTask <> invalid
        m.breakTask.unobserveFieldScoped("spot")
        m.breakTask.unobserveFieldScoped("result")
        m.breakTask.control = "stop"
        m.breakTask = invalid
    end if
    for each key in m.calls
        m.calls[key].node.unobserveFieldScoped("result")
        m.calls[key].node.control = "stop"
    end for
    m.calls = {}
    m.plan = invalid
end sub

function contentMs() as Dynamic
    sample = m.video.positionInfo
    if type(sample) <> "roAssociativeArray" then return invalid
    if not adPlanIsNumber(sample.video) or not adPlanIsNumber(sample.epoch) then return invalid
    ' Plan windows are content time. A wall-clock position cannot be mapped to them.
    if sample.epoch <> 0 or sample.video < 0 then return invalid
    if m.clipId = invalid or m.clipId <> sample.clip_id
        m.clipId = sample.clip_id
        m.overlay.callFunc("setClockAnchor", m.sessionId, { positionSeconds: 0, programTimeMs: 0, clipId: sample.clip_id })
    end if
    return sample.video * 1000#
end function

sub planTick()
    if m.plan = invalid or not m.started then return
    if planExpired() or m.inBreak then return
    now = contentMs()
    if now = invalid or m.video.state <> "playing" then return
    cut = adPlanDueCut(m.plan.cuts, m.settled, now)
    if cut <> invalid
        beginBreak(cut)
        return
    end if
    dropEnded(now)
    if m.plan.shop <> invalid and not m.productBusy and not productShowing()
        window = adPlanNextWindow(m.plan.shopWindows, m.products, committed(), m.plan.shop.pacing, m.plan.shop.lead_ms, now)
        if window <> invalid then askProduct(window)
    end if
    if m.busy or m.plan.pacing = invalid or m.plan.graphics.count() = 0 then return
    window = adPlanNextWindow(m.plan.windows, m.attempted, committed(), m.plan.pacing, 4000, now)
    if window = invalid then return
    if productAwaited(window, now) then return
    askGraphic(window)
end sub

function committed() as Object
    list = []
    list.append(m.shown)
    for each key in m.pendingWindows
        list.push(m.pendingWindows[key])
    end for
    return list
end function

function productAwaited(window as Object, now as Double) as Boolean
    if m.plan.shop = invalid then return false
    if m.products.doesExist(window.id) then return m.products[window.id] <> "empty"
    for each entry in m.plan.shopWindows
        if entry.id = window.id
            from# = entry.start
            if now > from# then from# = now
            return now < entry["end"] and entry["end"] - from# >= adPlanMs(m.plan.shop.pacing.min_seconds) and adPlanPacingAllows(entry, committed(), m.plan.shop.pacing)
        end if
    end for
    return false
end function

function productShowing() as Boolean
    for each cue in m.planCues
        if cue.commerce <> invalid then return true
    end for
    return false
end function

sub dropEnded(now as Double)
    kept = []
    for each cue in m.planCues
        if now < cue["end"] then kept.push(cue)
    end for
    if kept.count() <> m.planCues.count()
        m.planCues = kept
        m.overlay.callFunc("setPlanCues", m.sessionId, kept)
    end if
end sub

sub askGraphic(window as Object)
    choice = m.plan.graphics[m.shown.count() mod m.plan.graphics.count()]
    m.attempted[window.id] = true
    m.pendingWindows[window.id] = window
    m.busy = true
    emit("request", choice.format, window.id)
    planCall("graphic", adPlanGraphicTag(choice.tagUrl, choice.format, window.targeting, m.plan.page, m.plan.consent), 4000, { window: window, format: choice.format })
end sub

sub askProduct(window as Object)
    m.products[window.id] = "pending"
    m.pendingWindows[window.id] = window
    m.productBusy = true
    emit("request", "scene_product", window.id)
    url = adPlanAppend(m.plan.shop.url, [["window", window.id], ["locale", planLocale()]])
    planCall("product", url, 6000, { window: window, format: "scene_product" })
end sub

function planLocale() as String
    language = lcase(m.locale).split("-")[0]
    if language = "es" then return "es"
    if language = "pt" then return "pt-BR"
    return "en"
end function

sub planCall(kind as String, url as String, timeoutMs as Integer, context as Object)
    m.revision = m.revision + 1
    node = createObject("roSGNode", "ILOverlayFeedRequest")
    context.kind = kind
    context.node = node
    m.calls[m.revision.toStr()] = context
    node.observeFieldScoped("result", "onResult")
    node.request = { sessionId: m.sessionId, revision: m.revision, kind: "plan", url: url, timeoutMs: timeoutMs }
    node.control = "run"
end sub

sub onResult(event as Object)
    receive(event.getData())
end sub

sub receive(result as Object)
    if m.plan = invalid or type(result) <> "roAssociativeArray" then return
    if result.sessionId <> m.sessionId or result.revision = invalid then return
    key = result.revision.toStr()
    if not m.calls.doesExist(key) then return
    context = m.calls[key]
    m.calls.delete(key)
    context.node.unobserveFieldScoped("result")
    if context.kind = "graphic"
        receiveGraphic(context, result)
    else if context.kind = "product"
        receiveProduct(context, result)
    else if context.kind = "breakCard"
        receiveBreakCard(context, result)
    end if
end sub

sub receiveGraphic(context as Object, result as Object)
    window = context.window
    m.pendingWindows.delete(window.id)
    m.busy = false
    if result.status < 200 or result.status >= 300 or m.inBreak
        emit("error", context.format, window.id)
        return
    end if
    now = contentMs()
    if now = invalid then now = window.start
    from# = window.start
    if now > from# then from# = now
    ad = adPlanParseVast(result.body, context.format, window["end"] - from#)
    if ad.failed = true
        emit("error", context.format, window.id)
    else if ad.noFill = true
        emit("no_fill", context.format, window.id)
    else if now < window["end"]
        m.shown.push(window)
        emit("fill", context.format, window.id)
        format = "super"
        if context.format = "l_shape" then format = "l"
        cue = { id: "il-ads-" + window.id, format: format, start: window.start, imageUrl: ad.imageUrl, mimeType: ad.mimeType }
        cue["end"] = window["end"]
        m.measure[cue.id] = { urls: ad.impressions, format: context.format, window: window.id }
        m.planCues.push(cue)
        m.overlay.callFunc("setPlanCues", m.sessionId, m.planCues)
    end if
end sub

sub receiveProduct(context as Object, result as Object)
    window = context.window
    m.pendingWindows.delete(window.id)
    m.productBusy = false
    m.products[window.id] = "empty"
    if result.status <> 200
        emit("no_fill", "scene_product", window.id)
        planTick()
        return
    end if
    card = invalid
    if adPlanIsText(result.body) then card = parseJson(result.body)
    item = productItem(card, window)
    if item = invalid or m.inBreak
        emit("error", "scene_product", window.id)
        planTick()
        return
    end if
    m.products[window.id] = "filled"
    m.shown.push(window)
    emit("fill", "scene_product", window.id)
    urls = []
    if adPlanIsText(item.impressionUrl)
        urls.push(item.impressionUrl)
        item.delete("impressionUrl")
    end if
    m.measure[item.id] = { urls: urls, format: "scene_product", window: window.id }
    m.planCues.push(item)
    m.overlay.callFunc("setPlanCues", m.sessionId, m.planCues)
end sub

function productItem(card as Dynamic, window as Object) as Dynamic
    if type(card) <> "roAssociativeArray" then return invalid
    if card.window <> invalid
        if not adPlanIsText(card.window) then return invalid
        if card.window <> window.id then return invalid
    end if
    if not adPlanIsNumber(card.start) or not adPlanIsNumber(card["end"]) then return invalid
    first# = card.start
    last# = card["end"]
    if first# < window.start then first# = window.start
    if last# > window["end"] then last# = window["end"]
    item = {}
    item.append(card)
    item.start = first#
    item["end"] = last#
    if not m.overlay.callFunc("acceptsPlanProduct", item) then return invalid
    return item
end function

sub onImpression(event as Object)
    data = event.getData()
    if type(data) <> "roAssociativeArray" or m.plan = invalid then return
    if data.sessionId <> m.sessionId or not m.measure.doesExist(data.id) then return
    entry = m.measure[data.id]
    m.measure.delete(data.id)
    for each url in entry.urls
        planCall("beacon", url, 4000, {})
    end for
    emit("impression", entry.format, entry.window)
end sub

sub beginBreak(cut as Object)
    if planExpired() then return
    m.settled[cut.id] = true
    m.inBreak = true
    m.cut = cut
    m.overlay.planBreak = true
    m.overlay.callFunc("setLinearAd", true, invalid)
    m.resumeAt = invalid
    if not m.preroll
        sample = m.video.positionInfo
        m.resumeAt = sample.video
        m.video.control = "stop"
    end if
    m.video.visible = false
    emitBreak("break_start", cut)
    requests = []
    for each request in cut.requests
        requests.push({ provider: request.provider, tagUrl: adPlanCorrelated(request.tagUrl, m.plan.consent) })
    end for
    m.breakTask = createObject("roSGNode", "ILAdBreakTask")
    m.breakTask.requests = requests
    m.breakTask.view = m.top.getParent()
    m.breakTask.observeFieldScoped("spot", "onBreakSpot")
    m.breakTask.observeFieldScoped("result", "onBreakResult")
    m.breakTask.control = "run"
    ' RAF's getAds() and showAds() cannot be interrupted from inside the task: this render-thread guard gives
    ' the content back if no ad starts within 10 s or the break outlasts 130 s.
    m.spotSeen = false
    m.breakClock = createObject("roTimespan")
    m.guard.control = "start"
end sub

sub breakGuard()
    if m.plan = invalid or not m.inBreak or m.breakClock = invalid then return
    breakGuardAt(m.breakClock.totalMilliseconds())
end sub

' True when the guard ended the break.
function breakGuardAt(elapsedMs as Integer) as Boolean
    if m.plan = invalid or not m.inBreak then return false
    if elapsedMs < 130000 and (m.spotSeen or elapsedMs < 10000) then return false
    if m.breakTask <> invalid
        m.breakTask.cancelled = true
        m.breakTask.unobserveFieldScoped("spot")
        m.breakTask.unobserveFieldScoped("result")
        m.breakTask.control = "stop"
        m.breakTask = invalid
    end if
    finishBreak("break_error")
    return true
end function

sub onBreakSpot(event as Object)
    applySpot(event.getData())
end sub

' The host reads the session feed with this identity, as for any VAST spot with a shop. Buy during a break only
' when the sid is the plan's session: IL's grant names that session.
' With `commerce.break_url` in the plan the card is asked here, for the ad of `spot.shop`, in both kinds of break.
sub applySpot(spot as Dynamic)
    if m.plan = invalid or not m.inBreak or type(spot) <> "roAssociativeArray" then return
    m.spotSeen = true
    feed = {}
    if m.plan.breakShop and adPlanIsText(spot.creativeId) and adPlanIsText(spot.deliveryId)
        feed = { creativeId: spot.creativeId, deliveryId: spot.deliveryId }
    end if
    identity = invalid
    if feed.count() > 0 then identity = feed
    shop = breakShopIdentity(spot.shop)
    if shop <> invalid then identity = { creativeId: shop.creativeId, deliveryId: shop.delivery }
    dropBreakCard()
    m.overlay.callFunc("setLinearAd", true, identity)
    m.top.linearSpot = feed
    if shop <> invalid then askBreakCard(shop)
end sub

' The ad on screen qualifies for a card only with an `il-shop-` Ad@id for this break's position, an iADServer tag
' and a creative, as on the web. Anything else plays without a card and without a call.
function breakShopIdentity(ad as Dynamic) as Dynamic
    if m.plan.breakUrl = invalid or type(ad) <> "roAssociativeArray" then return invalid
    match = adPlanShopAd(ad.adId)
    if match = invalid or m.cut = invalid then return invalid
    if match.position <> m.cut.position or not adPlanIsText(ad.tag) or not adPlanIsText(ad.creativeId) then return invalid
    if ad.tag = "" or ad.creativeId = "" then return invalid
    return { creativeId: ad.creativeId, delivery: match.delivery, tag: ad.tag }
end function

sub askBreakCard(shop as Object)
    m.breakToken = m.breakToken + 1
    url = adPlanBreakCardUrl(m.plan.breakUrl, m.cut.id, shop.tag, shop.creativeId, shop.delivery, planLocale())
    m.top.event = { type: "request", format: "break_product", window: m.cut.id, url: url }
    planCall("breakCard", url, 6000, { shop: shop, token: m.breakToken })
end sub

sub receiveBreakCard(context as Object, result as Object)
    if not m.inBreak or context.token <> m.breakToken then return
    card = invalid
    if result.status = 200 then card = adPlanBreakCard(result.body, context.shop.creativeId, context.shop.delivery)
    if card = invalid
        emit("no_fill", "break_product", m.cut.id)
        return
    end if
    m.breakCard = card
    emit("fill", "break_product", m.cut.id)
    cues = []
    cues.append(m.planCues)
    cues.push(card)
    m.overlay.callFunc("setPlanCues", m.sessionId, cues)
end sub

' A card belongs to one ad: a new ad, its end or the end of the break removes it, and a late answer is dropped.
sub dropBreakCard()
    m.breakToken = m.breakToken + 1
    if m.breakCard = invalid then return
    m.breakCard = invalid
    m.overlay.callFunc("setPlanCues", m.sessionId, m.planCues)
end sub

' Host-driven breaks: the app plays its own ads (its RAF, through IL's per-break API) and reports them here.
' Positions in content milliseconds. Scene windows keep the plan's clearance around them.
sub setBreaks(positionsMs as Dynamic)
    if m.plan = invalid or type(positionsMs) <> "roArray" then return
    seconds = []
    for each at in positionsMs
        if adPlanIsNumber(at)
            if at >= 0 then seconds.push(at / 1000#)
        end if
    end for
    m.hostBreaks = seconds
    adPlanSetBreaks(m.plan, seconds)
end sub

' While the app's break is on, IL draws nothing but Buy, and pending graphic answers are discarded.
sub breakStarted(atMs as Dynamic)
    if m.plan = invalid or m.inBreak or not adPlanIsNumber(atMs) then return
    if atMs < 0 or planExpired() then return
    ms& = int(atMs + 0.5)
    position = "midroll"
    if ms& = 0 then position = "preroll"
    m.cut = { id: "at-" + ms&.toStr(), at: ms& / 1000#, position: position }
    m.hostBreak = true
    m.inBreak = true
    m.spotSeen = false
    m.overlay.planBreak = true
    m.overlay.callFunc("setLinearAd", true, invalid)
    emitBreak("break_start", m.cut)
end sub

' `ad` is the ad object of the app's own RAF tracking callback (ctx.ad), `adTagUrl` the tag it was requested with.
sub adStarted(adTagUrl as Dynamic, ad as Dynamic)
    if m.plan = invalid or not m.hostBreak then return
    spot = adPlanRafSpot(ad)
    if spot = invalid then spot = {}
    shop = adPlanRafShop(ad, adTagUrl)
    if shop <> invalid then spot.shop = shop
    applySpot(spot)
end sub

sub adEnded()
    if m.plan = invalid or not m.hostBreak then return
    applySpot({})
end sub

sub breakEnded()
    if m.plan = invalid or not m.hostBreak then return
    dropBreakCard()
    m.hostBreak = false
    m.inBreak = false
    m.overlay.planBreak = false
    m.overlay.callFunc("setLinearAd", false, invalid)
    m.top.linearSpot = {}
    emitBreak("break_end", m.cut)
end sub

sub onBreakResult(event as Object)
    finishBreak(event.getData().type)
end sub

sub finishBreak(outcome as String)
    if m.plan = invalid or not m.inBreak or m.hostBreak then return
    m.guard.control = "stop"
    m.breakClock = invalid
    if m.breakTask <> invalid
        m.breakTask.unobserveFieldScoped("spot")
        m.breakTask.unobserveFieldScoped("result")
        m.breakTask = invalid
    end if
    dropBreakCard()
    m.inBreak = false
    m.overlay.planBreak = false
    m.overlay.callFunc("setLinearAd", false, invalid)
    m.video.visible = true
    emitBreak(outcome, m.cut)
    if m.preroll
        m.preroll = false
        m.top.contentReady = true
    else
        m.video.seek = m.resumeAt
        m.video.control = "play"
    end if
end sub

sub emit(kind as String, format as String, window as String)
    m.top.event = { type: kind, format: format, window: window }
end sub

sub emitBreak(kind as String, cut as Object)
    m.top.event = { type: kind, cut: cut.id }
end sub

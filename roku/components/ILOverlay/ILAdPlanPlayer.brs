sub init()
    m.clock = m.top.findNode("ilPlanClock")
    m.clock.observeFieldScoped("fire", "planTick")
    m.guard = m.top.findNode("ilBreakGuard")
    m.guard.observeFieldScoped("fire", "breakGuard")
    m.plan = invalid
end sub

' `consent` is the host's consent: Roku has no standard storage for TCF, US Privacy or GPP strings.
function attachPlan(overlay as Object, video as Object, sessionId as String, plan as Dynamic, origin as Dynamic, locale = "en" as String, consent = invalid as Dynamic) as Boolean
    stopPlan()
    clock = createObject("roDateTime")
    read = adPlanRead(plan, clock.asSeconds(), origin, sessionId, consent)
    if read = invalid then return false
    m.plan = read
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
    if m.plan = invalid then return
    m.clock.control = "stop"
    m.guard.control = "stop"
    m.overlay.unobserveFieldScoped("impression")
    m.overlay.callFunc("setPlanCues", m.sessionId, [])
    if m.inBreak
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
    if m.plan = invalid or not m.started or m.inBreak then return
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
    pieces = m.plan.shop.url.split("#")
    base = pieces[0]
    joiner = "&"
    if instr(1, base, "?") = 0
        joiner = "?"
    else if right(base, 1) = "?" or right(base, 1) = "&"
        joiner = ""
    end if
    url = base + joiner + "window=" + window.id.encodeUriComponent() + "&locale=" + planLocale().encodeUriComponent()
    if pieces.count() > 1 then url = url + "#" + pieces[1]
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
sub applySpot(spot as Dynamic)
    if m.plan = invalid or not m.inBreak or type(spot) <> "roAssociativeArray" then return
    m.spotSeen = true
    if not m.plan.breakShop then spot = {}
    identity = invalid
    if spot.count() > 0 then identity = spot
    m.overlay.callFunc("setLinearAd", true, identity)
    m.top.linearSpot = spot
end sub

sub onBreakResult(event as Object)
    finishBreak(event.getData().type)
end sub

sub finishBreak(outcome as String)
    if m.plan = invalid or not m.inBreak then return
    m.guard.control = "stop"
    m.breakClock = invalid
    if m.breakTask <> invalid
        m.breakTask.unobserveFieldScoped("spot")
        m.breakTask.unobserveFieldScoped("result")
        m.breakTask = invalid
    end if
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

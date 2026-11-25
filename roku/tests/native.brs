' Native app plan: loading, version 2, renewal, Buy through commerce.break_url and host-driven breaks.
' Uses the shared fixtures in test/fixtures/native with their frozen clock.
sub main()
    m.checks = 0
    m.failures = 0
    m.now = 1793635200&
    m.origin = "https://localhost:8000"
    m.project = "proj_8e4cb338d66e4ec6bc6b99fd21f651f6"
    m.asset = "asset-40edc822d6f24974a9af51695a88184b"
    m.delivery = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
    testVersions()
    testUrls()
    testLoad()
    testRenewal()
    testExpiry()
    testBreakCard()
    testHostBreaks()
    testHostClearance()
    testRafShop()
    testNoBreakUrl()
    testNoPageForChannel()
    testRafFallback()
    testExactWindow()
    testSessionWarning()
    testNoLeak()
    testHostGuard()
    testHostOwnsVideo()
    testPositions()
    testVersionSwap()
    testExpiryMs()
    testRenewRetries()
    testUnreadable()
    testRenewTooLate()
    testDriversDontMix()
    if m.failures = 0 then print "ROKU_NATIVE_OK " + m.checks.toStr()
end sub

sub check(ok as Boolean, label as String)
    m.checks = m.checks + 1
    if not ok
        m.failures = m.failures + 1
        print "FAIL: " + label
    end if
end sub

' The fixtures come from the test console on http://localhost:8000. Production is HTTPS, which the reader
' requires: the same bodies are served from https://localhost:8000 here instead of weakening that rule.
function fixtureText(name as String) as String
    return readAsciiFile("pkg:/tests/native/" + name).replace("http://localhost:8000", m.origin)
end function

function lastUrl() as String
    return createObject("roSGScreen").getGlobalNode().lastPlanUrl
end function

' No grant, renew value or plan URL may leave the component through its events or fields.
sub noGrant(s as Object, label as String)
    published = formatJson(s.log.events) + s.player.planUrl
    for each name in ["app-plan-v1.json", "app-plan-v2.json", "app-plan-renewed.json", "host-plan.json"]
        grant = adPlanQuery(fixture(name).commerce.url, "grant")
        if instr(1, published, grant) > 0 or instr(1, published, grant.encodeUriComponent()) > 0
            check(false, label)
            return
        end if
    end for
    check(instr(1, published, "grant=") = 0 and instr(1, published, "renew=") = 0, label)
end sub

function fixture(name as String) as Object
    return parseJson(fixtureText(name))
end function

function stage(key = "view-1" as String) as Object
    scene = createObject("roSGNode", "Scene")
    video = scene.createChild("Group")
    video.addFields({ width: 960.0, height: 540.0, state: "playing", control: "", seek: 0.0,
        positionInfo: { epoch: 0, video: 0.0, clip_id: 7 } })
    video.addField("content", "node", false)
    video.content = createObject("roSGNode", "ContentNode")
    video.translation = [0, 0]
    overlay = scene.createChild("ILOverlay")
    player = scene.createChild("ILAdPlanPlayer")
    overlay.callFunc("attach", video, key)
    overlay.commerceAutoFocus = false
    overlay.commerceEnabled = true
    player.callFunc("setClock", m.now)
    log = scene.createChild("EventLog")
    log.callFunc("watch", player)
    m.key = key
    return { video: video, overlay: overlay, player: player, log: log }
end function

sub at(s as Object, seconds as Double)
    s.video.positionInfo = { epoch: 0, video: seconds, clip_id: 7 }
end sub

sub testVersions()
    v1 = adPlanRead(fixture("app-plan-v1.json"), m.now, m.origin, "")
    check(v1 <> invalid and v1.version = 1, "the v1 app plan is read")
    check(v1.sid = "178311e8ffa4791646c0d0f6c728aa73" and v1.breakUrl <> invalid, "without a host id the plan's session is the sid and break_url is used")
    check(v1.cuts[0].id = "pre" and v1.cuts[0].position = "preroll", "a cut keeps its position")
    check(adPlanRead(fixture("app-plan-v1.json"), m.now, m.origin, "my-view").breakUrl = invalid, "a host view id gets no break card, as on the web")
    check(adPlanRead(fixture("app-plan-v1.json"), m.now, "https://other.example", "").breakUrl = invalid, "no break card without the plan's origin")
    v2 = adPlanRead(fixture("app-plan-v2.json"), m.now, m.origin, "")
    check(v2 <> invalid and v2.version = 2 and v2.expires = m.now + 120, "a v2 plan 120 s ahead is read")
    wrong = fixture("app-plan-v2.json")
    wrong.native_gam.contract = "native-gam-plan-v2"
    check(adPlanRead(wrong, m.now, m.origin, "") = invalid, "a v2 plan with another contract is refused")
    bare = fixture("app-plan-v2.json")
    bare.delete("native_gam")
    check(adPlanRead(bare, m.now, m.origin, "") = invalid, "a v2 plan without native_gam is refused")
    check(adPlanRead(fixture("app-plan-v2.json"), m.now - 1, m.origin, "") = invalid, "a v2 plan more than 120 s ahead is refused")
    check(adPlanRead(fixture("app-plan-v2.json"), m.now + 120, m.origin, "") = invalid, "an expired v2 plan is refused")
    v3 = fixture("app-plan-v1.json")
    v3.version = 3
    check(adPlanRead(v3, m.now, m.origin, "") = invalid, "another version is refused")
    renewed = adPlanRead(fixture("app-plan-renewed.json"), m.now, m.origin, "")
    check(renewed.sid = v1.sid and renewed.grant <> "", "renewal keeps the session and carries a grant")
end sub

sub testUrls()
    check(adPlanAppPlanUrl(m.origin, m.project, m.asset, "roku:dev") = m.origin + "/il-player/app-plan?project=" + m.project + "&asset=" + m.asset + "&app=roku%3Adev", "the app plan URL is built exactly")
    check(adPlanAppPlanUrl(m.origin + "/", m.project, m.asset, "roku:12345", "g.1") = m.origin + "/il-player/app-plan?project=" + m.project + "&asset=" + m.asset + "&app=roku%3A12345&renew=g.1", "a renewal adds the grant")
    check(adPlanAppPlanUrl("http://localhost:8000", m.project, m.asset, "roku:dev") = invalid, "a plan is only asked over HTTPS")
    check(adPlanAppPlanUrl(m.origin, "", m.asset, "roku:dev") = invalid, "a project is required")
    check(adPlanAppId("12345", false) = "roku:12345" and adPlanAppId("12345_3a2f", false) = "roku:12345_3a2f", "a channel id is sent as roku:<id>")
    check(adPlanAppId("12345", true) = "roku:dev" and adPlanAppId("dev", false) = "roku:dev", "a sideloaded channel is roku:dev")
    check(adPlanAppId("my.channel", false) = invalid, "an id IL cannot register is not sent")
    check(adPlanShopAd("il-shop-midroll-" + m.delivery).delivery = m.delivery and adPlanShopAd("il-shop-preroll-" + m.delivery).position = "preroll", "the delivery follows the second hyphen")
    check(adPlanShopAd("il-shop-midroll-" + mid(m.delivery, 2)) = invalid and adPlanShopAd("ad-" + m.delivery) = invalid, "anything else names no delivery")
    v1 = fixture("app-plan-v1.json")
    page = adPlanBreakCardUrl(v1.commerce.break_url, "pre", "T_pre", "cr1", m.delivery, "es")
    check(page = v1.commerce.break_url + "&cut=pre&tag=T_pre&creative=cr1&delivery=" + m.delivery + "&locale=es", "the break card URL for a plan cut")
    host = fixture("host-plan.json")
    hosted = adPlanBreakCardUrl(host.commerce.break_url, "at-58000", "T_mid", "cr1", m.delivery, "es")
    check(hosted = host.commerce.break_url + "&cut=at-58000&tag=T_mid&creative=cr1&delivery=" + m.delivery + "&locale=es", "the break card URL for a host break keeps host=1")
    card = adPlanBreakCard(fixtureText("break-product-card.json"), "cr1", m.delivery)
    check(card <> invalid and card.start = 0 and card["end"] > 1.0e15, "the card lasts as long as its ad")
    check(adPlanBreakCard(fixtureText("break-product-card.json"), "cr2", m.delivery) = invalid, "a card for another creative is refused")
    check(adPlanBreakCard(fixtureText("scene-product-card.json"), "cr1", m.delivery) = invalid, "a scene card is not a break card")
    shop = adPlanRafShop({ adId: "il-shop-midroll-" + m.delivery, creativeId: "cr1", tracking: [] }, "https://ads.iadserver.com/gampad/ads?tag=T_mid&sid=x")
    check(shop.tag = "T_mid" and shop.creativeId = "cr1", "the tag comes from the iADServer tag of the ad")
    check(adPlanRafShop({ adId: "x", creativeId: "cr1" }, "https://pubads.g.doubleclick.net/gampad/ads?tag=T").tag = "", "a GAM tag names no tag")
end sub

sub testLoad()
    s = stage()
    check(s.player.callFunc("loadPlan", s.overlay, s.video, "view-1", m.origin, m.project, m.asset, "es"), "loadPlan asks")
    check(s.player.planUrl = m.origin + "/il-player/app-plan?project=" + m.project + "&asset=" + m.asset + "&app=roku%3Adev", "the sideloaded channel asks with app=roku:dev")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 99, status: 200, body: fixtureText("app-plan-v1.json") })
    check(not s.overlay.linearBreak, "an answer to another request is ignored")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v1.json") })
    check(s.overlay.linearBreak and not s.video.visible, "a loaded plan attaches and starts with its pre-roll")
    s.player.callFunc("finishBreak", "break_end")
    check(s.player.contentReady, "content starts after the pre-roll")
    s.player.callFunc("stopPlan")

    for each status in [204, 404, 0, 500]
        e = stage()
        e.player.callFunc("loadPlan", e.overlay, e.video, "view-1", m.origin, m.project, m.asset, "es")
        e.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: status })
        check(e.player.contentReady and not e.overlay.linearBreak, "status " + status.toStr() + " plays without ads")
        check(e.player.event.type = "plan_unavailable" and e.player.event.status = status and e.player.event.app = "roku:dev", "status " + status.toStr() + " reports the app id sent")
    end for
    bad = stage()
    bad.player.callFunc("loadPlan", bad.overlay, bad.video, "view-1", m.origin, m.project, m.asset, "es")
    bad.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: "{" })
    check(bad.player.contentReady, "an unreadable plan plays without ads")
    plain = stage()
    check(not plain.player.callFunc("loadPlan", plain.overlay, plain.video, "view-1", "http://localhost:8000", m.project, m.asset, "es") and plain.player.contentReady, "a non-HTTPS console is not asked")
end sub

sub testRenewal()
    s = stage()
    s.player.callFunc("loadPlan", s.overlay, s.video, "view-1", m.origin, m.project, m.asset, "es")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v1.json") })
    s.player.callFunc("finishBreak", "break_end")
    at(s, 0.5)
    s.player.callFunc("planTick")
    check(s.player.event.type = "request" and s.player.event.format = "scene_product" and s.player.event.window = "p1", "the first product is asked")
    s.player.callFunc("receive", { sessionId: "view-1", revision: 1, status: 204 })
    check(s.player.event.type = "request" and s.player.event.format = "super" and s.player.event.window = "p1", "the window goes to a graphic")
    s.player.callFunc("renewPlan")
    v1 = fixture("app-plan-v1.json")
    check(lastUrl() = m.origin + "/il-player/app-plan?project=" + m.project + "&asset=" + m.asset + "&app=roku%3Adev&renew=" + adPlanQuery(v1.commerce.url, "grant").encodeUriComponent(), "renewal sends the current grant")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 2, status: 200, body: fixtureText("app-plan-renewed.json") })
    check(s.player.event.type = "plan_renewed", "the renewed plan is swapped in")
    at(s, 0.75)
    s.player.callFunc("planTick")
    check(s.player.event.type = "plan_renewed" and not s.overlay.linearBreak, "nothing is asked or played again after renewal")
    s.player.callFunc("stopPlan")

    v2 = stage()
    v2.player.callFunc("loadPlan", v2.overlay, v2.video, "view-1", m.origin, m.project, m.asset, "es")
    v2.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v2.json") })
    check(v2.player.findNode("ilPlanRenew").duration = 100, "a v2 plan is renewed 20 s before it expires")
    v2.player.callFunc("renewPlan")
    check(adPlanQuery(lastUrl(), "renew") = adPlanQuery(fixture("app-plan-v2.json").commerce.url, "grant"), "the v2 renewal sends its grant")
    v2.player.callFunc("receivePlan", { sessionId: "view-1", revision: 2, status: 204 })
    check(v2.overlay.linearBreak, "a failed renewal keeps the current plan")
    v2.player.callFunc("stopPlan")

    host = stage("178311e8ffa4791646c0d0f6c728aa73")
    host.player.callFunc("attachPlan", host.overlay, host.video, "178311e8ffa4791646c0d0f6c728aa73", fixture("app-plan-v1.json"), m.origin, "es")
    check(host.player.callFunc("replacePlan", fixture("app-plan-renewed.json")), "a host replaces its own plan")
    v3 = fixture("app-plan-renewed.json")
    v3.version = 3
    check(not host.player.callFunc("replacePlan", v3), "an unreadable replacement is refused")
    host.player.callFunc("stopPlan")
end sub

sub testExpiry()
    s = stage("5990561fda4bd75154be4c4465d8d2b6")
    check(s.player.callFunc("attachPlan", s.overlay, s.video, "5990561fda4bd75154be4c4465d8d2b6", fixture("app-plan-v2.json"), m.origin, "es"), "a v2 plan attaches")
    s.player.callFunc("startPlan")
    check(s.overlay.linearBreak, "its pre-roll starts")
    s.player.callFunc("setClock", m.now + 119)
    s.player.callFunc("planTick")
    check(s.overlay.linearBreak, "the plan holds until expires_at")
    s.player.callFunc("setClock", m.now + 120)
    s.player.callFunc("planTick")
    check(s.player.event.type = "plan_expired" and s.player.contentReady and not s.overlay.linearBreak and s.video.visible, "at expiry the plan stops and the content plays")
    v1 = stage("178311e8ffa4791646c0d0f6c728aa73")
    v1.player.callFunc("attachPlan", v1.overlay, v1.video, "178311e8ffa4791646c0d0f6c728aa73", fixture("app-plan-v1.json"), m.origin, "es")
    v1.player.callFunc("startPlan")
    v1.player.callFunc("setClock", m.now + 200)
    v1.player.callFunc("planTick")
    check(v1.player.event.type <> "plan_expired", "a v1 plan is not cut short")
    v1.player.callFunc("stopPlan")
end sub

function shopSpot(position as String, tag as String) as Object
    return { creativeId: "cr1", shop: { adId: "il-shop-" + position + "-" + m.delivery, creativeId: "cr1", tag: tag } }
end function

sub testBreakCard()
    s = stage("178311e8ffa4791646c0d0f6c728aa73")
    v1 = fixture("app-plan-v1.json")
    s.player.callFunc("attachPlan", s.overlay, s.video, "178311e8ffa4791646c0d0f6c728aa73", v1, m.origin, "es")
    s.player.callFunc("startPlan")
    s.player.callFunc("applySpot", shopSpot("midroll", "T_pre"))
    check(s.player.event.type = "break_start", "an ad for another position asks nothing")
    s.player.callFunc("applySpot", { creativeId: "cr1", shop: { adId: "plain-ad", creativeId: "cr1", tag: "T_pre" } })
    check(s.player.event.type = "break_start", "an ad without the il-shop- id asks nothing")
    s.player.callFunc("applySpot", shopSpot("preroll", ""))
    check(s.player.event.type = "break_start", "an ad from a GAM tag asks nothing")
    s.player.callFunc("applySpot", shopSpot("preroll", "T_pre"))
    check(s.player.event.format = "break_product" and lastUrl() = v1.commerce.break_url + "&cut=pre&tag=T_pre&creative=cr1&delivery=" + m.delivery + "&locale=es", "the reader's own break asks the card of the playing ad")
    s.player.callFunc("receive", { sessionId: m.key, revision: 1, status: 200, body: fixtureText("break-product-card-page.json") })
    check(s.player.event.type = "fill" and s.overlay.findNode("ilCommerce").visible, "Buy is drawn during the ad")
    s.player.callFunc("applySpot", {})
    check(not s.overlay.findNode("ilCommerce").visible, "Buy leaves when the ad ends")
    s.player.callFunc("applySpot", shopSpot("preroll", "T_pre"))
    s.player.callFunc("applySpot", {})
    s.player.callFunc("receive", { sessionId: m.key, revision: 2, status: 200, body: fixtureText("break-product-card-page.json") })
    check(not s.overlay.findNode("ilCommerce").visible and s.player.event.format = "break_product" and s.player.event.type = "request", "a card that arrives after its ad is dropped")
    s.player.callFunc("applySpot", shopSpot("preroll", "T_pre"))
    s.player.callFunc("receive", { sessionId: m.key, revision: 3, status: 204 })
    check(s.player.event.type = "no_fill" and not s.overlay.findNode("ilCommerce").visible, "204 draws nothing")
    s.player.callFunc("stopPlan")
end sub

function hostStage(plan as Object) as Object
    ' The host plan's session is the sid inside every stable ad_tag_url: the host keys the view with it.
    key = "view-1"
    if plan.commerce <> invalid then key = plan.commerce.session
    s = stage(key)
    s.player.callFunc("attachPlan", s.overlay, s.video, key, plan, m.origin, "es")
    s.player.callFunc("startPlan")
    return s
end function

sub testHostBreaks()
    host = fixture("host-plan.json")
    s = hostStage(host)
    check(s.player.contentReady and not s.overlay.linearBreak, "a host plan plays no break of its own")
    at(s, 1.0)
    s.player.callFunc("planTick")
    check(s.player.event.format = "scene_product", "graphics and products run by content time")
    s.player.callFunc("breakStarted", 58000)
    check(s.overlay.linearBreak and s.player.event.type = "break_start" and s.player.event.cut = "at-58000", "the host's break is on")
    s.player.callFunc("receive", { sessionId: m.key, revision: 1, status: 200, body: fixtureText("scene-product-card.json") })
    check(s.player.event.type = "error" and s.overlay.findNode("ilPrimary").getChildCount() = 0, "a pending answer is discarded during the host's break")
    s.player.callFunc("planTick")
    check(s.player.event.type = "error", "nothing is asked during the host's break")
    s.player.callFunc("adStarted", "https://pubads.g.doubleclick.net/gampad/ads?iu=/1", { adId: "il-shop-midroll-" + m.delivery, creativeId: "cr1", tracking: [] })
    check(s.player.event.type = "error", "a GAM ad asks no card")
    tag = "https://ads.iadserver.com/gampad/ads?tag=T_mid&output=vast&cue_seconds=58&sid=ed4c7d84521a3bc4faba519c687146f0"
    s.player.callFunc("adStarted", tag, { adId: "il-shop-midroll-" + m.delivery, creativeId: "cr1", tracking: [] })
    check(s.player.event.format = "break_product" and lastUrl() = host.commerce.break_url + "&cut=at-58000&tag=T_mid&creative=cr1&delivery=" + m.delivery + "&locale=es", "the reported ad asks its card with cut=at-<ms>")
    s.player.callFunc("receive", { sessionId: m.key, revision: 2, status: 200, body: fixtureText("break-product-card.json") })
    check(s.overlay.findNode("ilCommerce").visible and s.overlay.findNode("ilArt").visible = false, "Buy is drawn for the reported ad and nothing else")
    s.player.callFunc("adEnded")
    check(not s.overlay.findNode("ilCommerce").visible and s.overlay.linearBreak, "Buy leaves with the ad, the break goes on")
    s.player.callFunc("breakEnded")
    check(not s.overlay.linearBreak and s.player.event.type = "break_end" and s.player.event.cut = "at-58000", "the host's break ends")
    at(s, 15.5)
    s.player.callFunc("planTick")
    check(s.player.event.type = "request" and s.player.event.window = "p2", "graphics resume after breakEnded")
    s.player.callFunc("stopPlan")

    pre = hostStage(fixture("host-plan.json"))
    pre.player.callFunc("breakStarted", 0)
    pre.player.callFunc("adStarted", tag, { adId: "il-shop-preroll-" + m.delivery, creativeId: "cr1", tracking: [] })
    check(adPlanQuery(lastUrl(), "cut") = "at-0", "a host pre-roll is at-0")
    pre.player.callFunc("breakEnded")
    pre.player.callFunc("stopPlan")

    silent = hostStage(fixture("host-plan.json"))
    silent.player.callFunc("adStarted", tag, { adId: "il-shop-midroll-" + m.delivery, creativeId: "cr1", tracking: [] })
    at(silent, 1.0)
    silent.player.callFunc("planTick")
    check(silent.player.event.format = "scene_product" and not silent.overlay.linearBreak, "a host that reports nothing gets content-time graphics and no Buy")
    silent.player.callFunc("stopPlan")
end sub

sub testHostClearance()
    plan = fixture("host-plan.json")
    plan.delete("commerce")
    plan.scenes.pacing.cut_clearance_seconds = 3
    open = hostStage(plan)
    at(open, 55.5)
    open.player.callFunc("planTick")
    check(open.player.event.type = "request" and open.player.event.window = "m1", "without reported breaks a window runs to its end")
    open.player.callFunc("stopPlan")
    clear = hostStage(plan)
    clear.player.callFunc("setBreaks", [58000])
    at(clear, 55.5)
    clear.player.callFunc("planTick")
    check(clear.player.event = invalid or clear.player.event.window <> "m1", "a reported break keeps its clearance")
    at(clear, 57.5)
    clear.player.callFunc("planTick")
    check(clear.player.event.type = "request" and clear.player.event.window = "m2", "the window after the break starts past the clearance")
    clear.player.callFunc("stopPlan")
    late = hostStage(plan)
    late.player.callFunc("breakStarted", 58000)
    late.player.callFunc("breakEnded")
    at(late, 55.5)
    late.player.callFunc("planTick")
    check(late.player.event.type = "break_end", "a break reported only by breakStarted gets the same clearance")
    late.player.callFunc("stopPlan")
end sub

sub testNoBreakUrl()
    plan = fixture("host-plan.json")
    plan.commerce.delete("break_url")
    s = hostStage(plan)
    s.player.callFunc("breakStarted", 58000)
    s.player.callFunc("adStarted", "https://ads.iadserver.com/gampad/ads?tag=T_mid", { adId: "il-shop-midroll-" + m.delivery, creativeId: "cr1", tracking: [] })
    check(s.player.event.type = "break_start" and not s.overlay.findNode("ilCommerce").visible, "a host plan without break_url has no Buy and asks nothing")
    s.player.callFunc("breakEnded")
    check(s.player.event.type = "break_end", "the break still ends normally")
    s.player.callFunc("stopPlan")
end sub

sub testRafShop()
    ad = { adId: "il-shop-preroll-" + m.delivery, creativeId: "cr1", tracking: [] }
    raf = {
        setTrackingCallback: sub(callback, target)
            m.callback = callback
            m.target = target
        end sub
        setAdUrl: sub(url)
            m.url = url
        end sub
        getAds: function()
            return [{ ads: [m.ad] }]
        end function
        showAds: function(pods, context, view)
            m.callback(m.target, "Impression", { ad: m.ad })
            m.during = m.target.spot
            m.callback(m.target, "Complete", { ad: m.ad })
            return true
        end function
    }
    raf.ad = ad
    top = { spot: invalid, cancelled: false }
    requests = [{ provider: "iadserver", tagUrl: "https://ads.iadserver.com/gampad/ads?tag=T_pre&sid=x" }]
    check(adPlanRunBreak(requests, raf, invalid, top) = "break_end", "the RAF break plays")
    check(raf.during.shop.adId = ad.adId and raf.during.shop.tag = "T_pre", "RAF's ad carries its Ad@id and the iADServer tag")
    check(top.spot.count() = 0, "the identity clears when the ad completes")
    gam = { spot: invalid, cancelled: false }
    adPlanRunBreak([{ provider: "gam", tagUrl: "https://pubads.g.doubleclick.net/gampad/ads?tag=T" }], raf, invalid, gam)
    check(raf.during.shop.tag = "", "a GAM request names no tag")
end sub

sub testNoPageForChannel()
    read = adPlanRead(fixture("app-plan-v1.json"), m.now, m.origin, "")
    gam = read.cuts[1].requests[0].tagUrl
    graphic = adPlanGraphicTag(read.graphics[0].tagUrl, "super", invalid, read.page)
    check(read.page = invalid and adPlanQuery(gam, "url") = "" and adPlanQuery(gam, "description_url") = "" and adPlanQuery(graphic, "url") = "", "an app plan sends no page parameters to GAM")
end sub

function hostAtBreak() as Object
    s = hostStage(fixture("host-plan.json"))
    s.player.callFunc("breakStarted", 58000)
    return s
end function

sub testRafFallback()
    tag = "https://ads.iadserver.com/gampad/ads?tag=T_mid"
    impression = [{ event: "Impression", url: "https://ads.iadserver.com/events/" + m.delivery + "/impression" }]
    a = hostAtBreak()
    a.player.callFunc("adStarted", tag, { adId: "il-shop-midroll-" + m.delivery, creativeId: "cr1", tracking: [] })
    check(a.player.event.format = "break_product" and adPlanQuery(lastUrl(), "delivery") = m.delivery, "RAF's adId with il-shop- asks the card")
    a.player.callFunc("stopPlan")
    b = hostAtBreak()
    b.player.callFunc("adStarted", tag, { creativeId: "cr1", tracking: impression })
    check(b.player.event.format = "break_product" and adPlanQuery(lastUrl(), "delivery") = m.delivery and adPlanQuery(lastUrl(), "cut") = "at-58000", "without adId the iADServer impression names the delivery")
    b.player.callFunc("receive", { sessionId: m.key, revision: 1, status: 200, body: fixtureText("break-product-card.json") })
    check(b.overlay.findNode("ilCommerce").visible, "the fallback card is drawn")
    b.player.callFunc("stopPlan")
    c = hostAtBreak()
    c.player.callFunc("adStarted", tag, { creativeId: "cr1", tracking: [{ event: "Impression", url: "https://ads.other.example/events/" + m.delivery + "/impression" }] })
    check(c.player.event.type = "break_start", "another ad server's ad asks nothing")
    c.player.callFunc("adStarted", tag, { creativeId: "cr1", tracking: [{ event: "Impression", url: "https://ads.iadserver.com/events/short/impression" }] })
    check(c.player.event.type = "break_start", "a delivery that is not 43 characters asks nothing")
    c.player.callFunc("stopPlan")
    r = stage("178311e8ffa4791646c0d0f6c728aa73")
    r.player.callFunc("attachPlan", r.overlay, r.video, "178311e8ffa4791646c0d0f6c728aa73", fixture("app-plan-v1.json"), m.origin, "es")
    r.player.callFunc("startPlan")
    r.player.callFunc("applySpot", { creativeId: "cr1", deliveryId: m.delivery, shop: { adId: "", creativeId: "cr1", tag: "T_pre", impressionDelivery: m.delivery } })
    check(adPlanQuery(lastUrl(), "cut") = "pre", "the reader's own break uses the fallback with its cut id")
    r.player.callFunc("stopPlan")
end sub

sub testExactWindow()
    plan = fixture("app-plan-v2.json")
    plan.expires_at = "2026-11-02T16:02:00.000Z"
    check(adPlanRead(plan, m.now, m.origin, "") <> invalid, "120.0 s ahead is accepted")
    plan.expires_at = "2026-11-02T16:02:00.5Z"
    check(adPlanRead(plan, m.now, m.origin, "") = invalid, "120.5 s ahead is refused")
    plan.expires_at = "2026-11-02T13:02:00.001-03:00"
    check(adPlanRead(plan, m.now, m.origin, "") = invalid, "120.001 s ahead with an offset is refused")
end sub

sub testSessionWarning()
    s = stage("my-view")
    s.player.callFunc("attachPlan", s.overlay, s.video, "my-view", fixture("host-plan.json"), m.origin, "es")
    check(s.player.event.type = "buy_unavailable" and s.player.event.reason = "session", "a host plan attached with another session says Buy is unavailable")
    s.player.callFunc("stopPlan")
    ok = hostStage(fixture("host-plan.json"))
    check(ok.player.event = invalid or ok.player.event.type <> "buy_unavailable", "with the plan's session there is no warning")
    ok.player.callFunc("stopPlan")
end sub

sub testNoLeak()
    s = stage()
    s.player.callFunc("loadPlan", s.overlay, s.video, "view-1", m.origin, m.project, m.asset, "es")
    noGrant(s, "no grant after the load request")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v1.json") })
    s.player.callFunc("applySpot", shopSpot("preroll", "T_pre"))
    check(adPlanQuery(lastUrl(), "grant") <> "", "the break card is still asked with its grant")
    noGrant(s, "no grant in the break card request event")
    s.player.callFunc("receive", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("break-product-card-page.json") })
    noGrant(s, "no grant in the break card fill event")
    s.player.callFunc("finishBreak", "break_end")
    at(s, 0.5)
    s.player.callFunc("planTick")
    check(s.player.event.format = "scene_product" and adPlanQuery(lastUrl(), "window") = "p1", "the scene card is asked")
    noGrant(s, "no grant in the scene card request event")
    s.player.callFunc("renewPlan")
    check(adPlanQuery(lastUrl(), "renew") <> "", "the renewal is sent with its grant")
    noGrant(s, "no grant in planUrl after renewal")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 2, status: 200, body: fixtureText("app-plan-renewed.json") })
    noGrant(s, "no grant in the renewal event")
    s.player.callFunc("stopPlan")
    e = stage()
    e.player.callFunc("loadPlan", e.overlay, e.video, "view-1", m.origin, m.project, m.asset, "es")
    e.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 404 })
    noGrant(e, "no grant in plan_unavailable")
    check(e.player.event.reason = "http_404" and e.player.event.status = 404 and e.player.event.app = "roku:dev", "plan_unavailable carries the status as reason and the raw app id")
    for each answer in [{ status: 204, reason: "http_204" }, { status: 0, reason: "network" }, { status: 0, timedOut: true, reason: "timeout" }]
        n = stage()
        n.player.callFunc("loadPlan", n.overlay, n.video, "view-1", m.origin, m.project, m.asset, "es")
        n.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: answer.status, timedOut: answer.timedOut })
        check(n.player.event.reason = answer.reason and n.player.event.status = answer.status, "plan_unavailable says " + answer.reason)
    end for
    check(s.log.events.count() = 6 and s.log.events[1].format = "break_product", "every event of the load flow was collected")
    l = stage()
    l.player.callFunc("loadPlan", l.overlay, l.video, "view-1", "http://localhost:8000", m.project, m.asset, "es")
    check(l.player.event.reason = "request" and l.player.event.app = "roku:dev", "a request refused locally says so with the app id")
end sub

sub testHostGuard()
    s = hostStage(fixture("host-plan.json"))
    s.player.callFunc("breakStarted", 58000)
    check(not s.player.callFunc("breakGuardAt", 129000) and s.overlay.linearBreak, "a host break may run up to 130 s")
    check(s.player.callFunc("breakGuardAt", 130000), "a host break that never ends is closed at 130 s")
    check(s.player.event.type = "break_error" and s.player.event.cut = "at-58000" and not s.overlay.linearBreak, "the guard says so and leaves the break")
    at(s, 15.5)
    s.player.callFunc("planTick")
    check(s.player.event.type = "request", "graphics resume after the guard")
    s.player.callFunc("stopPlan")
end sub

sub testHostOwnsVideo()
    s = hostStage(fixture("host-plan.json"))
    s.video.visible = false
    s.video.control = "stop"
    s.player.callFunc("breakStarted", 58000)
    s.player.callFunc("stopPlan")
    check(not s.video.visible and s.video.control = "stop" and not s.overlay.linearBreak, "stopPlan in a host break leaves the host's video alone")
    s.player.callFunc("attachPlan", s.overlay, s.video, m.key, fixture("host-plan.json"), m.origin, "es")
    s.player.callFunc("startPlan")
    s.player.callFunc("breakStarted", 178000)
    check(s.player.event.type = "break_start" and s.player.event.cut = "at-178000", "a reused node is not left in a stale break")
    s.player.callFunc("loadPlan", s.overlay, s.video, m.key, m.origin, m.project, m.asset, "es")
    check(not s.video.visible, "a second loadPlan during a host break leaves the host's video alone")
end sub

sub testPositions()
    s = hostStage(fixture("host-plan.json"))
    s.player.callFunc("breakStarted", -1)
    check(s.player.event.type = "break_refused" and not s.overlay.linearBreak, "a negative position is refused")
    inf = 1.0e308 * 10
    s.player.callFunc("breakStarted", inf)
    check(s.player.event.type = "break_refused" and not s.overlay.linearBreak, "an infinite position is refused")
    s.player.callFunc("breakStarted", 58000.6)
    check(s.player.event.cut = "at-58001", "a fractional position rounds to the nearest millisecond")
    s.player.callFunc("stopPlan")
end sub

sub testVersionSwap()
    s = stage()
    s.player.callFunc("loadPlan", s.overlay, s.video, "view-1", m.origin, m.project, m.asset, "es")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v2.json") })
    timer = s.player.findNode("ilPlanRenew")
    check(timer.control = "start", "a loaded v2 plan schedules its renewal")
    s.player.callFunc("renewPlan")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 2, status: 200, body: fixtureText("app-plan-renewed.json") })
    check(s.player.event.type = "plan_renewed" and s.player.event.version = 1 and timer.control = "stop", "a v1 answer ends the approval and stops renewing")
    s.player.callFunc("stopPlan")
    t = stage()
    t.player.callFunc("loadPlan", t.overlay, t.video, "view-1", m.origin, m.project, m.asset, "es")
    t.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v1.json") })
    timer = t.player.findNode("ilPlanRenew")
    check(timer.control = "stop", "a v1 plan is not renewed")
    t.player.callFunc("renewPlan")
    t.player.callFunc("receivePlan", { sessionId: "view-1", revision: 2, status: 200, body: fixtureText("app-plan-v2.json") })
    check(t.player.event.version = 2 and timer.control = "start" and timer.duration = 100, "a v2 answer to a v1 plan schedules renewal")
    t.player.callFunc("stopPlan")

    g = stage()
    g.player.callFunc("loadPlan", g.overlay, g.video, "view-1", m.origin, m.project, m.asset, "es")
    g.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v1.json") })
    g.player.callFunc("finishBreak", "break_end")
    at(g, 0.5)
    g.player.callFunc("planTick")
    g.player.callFunc("receive", { sessionId: "view-1", revision: 1, status: 204 })
    g.player.callFunc("receive", { sessionId: "view-1", revision: 2, status: 200, body: vastSuper() })
    at(g, 1.0)
    g.overlay.callFunc("setClockAnchor", "view-1", { positionSeconds: 0, programTimeMs: 0, clipId: 7 })
    check(g.overlay.findNode("ilPrimary").getChildCount() = 1, "the graphic of p1 is on screen")
    other = fixture("app-plan-renewed.json")
    other.scenes.windows = [{ id: "z9", start_ms: 200000, end_ms: 210000 }]
    other.commerce.windows = []
    g.player.callFunc("replacePlan", other)
    check(g.overlay.findNode("ilPrimary").getChildCount() = 0, "a cue whose window left the new plan is removed at the swap")
    g.player.callFunc("stopPlan")
end sub

function vastSuper() as String
    image = "https://c.example/s.png"
    return "<VAST version=""4.0""><Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><NonLinearAds><NonLinear width=""600"" height=""90""><StaticResource creativeType=""image/png"">" + image + "</StaticResource></NonLinear></NonLinearAds></Creative></Creatives></InLine></Ad></VAST>"
end function

sub testExpiryMs()
    plan = fixture("app-plan-v2.json")
    plan.expires_at = "2026-11-02T16:01:59.500Z"
    s = stage("5990561fda4bd75154be4c4465d8d2b6")
    s.player.callFunc("attachPlan", s.overlay, s.video, "5990561fda4bd75154be4c4465d8d2b6", plan, m.origin, "es")
    s.player.callFunc("startPlan")
    s.player.callFunc("setClock", m.now + 119.4#)
    s.player.callFunc("planTick")
    check(s.overlay.linearBreak, "the plan holds until expires_at")
    s.player.callFunc("setClock", m.now + 119.6#)
    s.player.callFunc("planTick")
    check(s.player.event.type = "plan_expired", "expiry is compared in milliseconds")
end sub

function countType(s as Object, kind as String) as Integer
    total = 0
    for each event in s.log.events
        if event.type = kind then total = total + 1
    end for
    return total
end function

sub testRenewRetries()
    s = stage()
    s.player.callFunc("loadPlan", s.overlay, s.video, "view-1", m.origin, m.project, m.asset, "es")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v2.json") })
    timer = s.player.findNode("ilPlanRenew")
    check(timer.duration = 100, "the first renewal is 20 s before expiry")
    s.player.callFunc("renewPlan")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 2, status: 0, timedOut: true })
    check(timer.duration = 108 and timer.control = "start" and countType(s, "plan_renew_failed") = 0, "a failed renewal retries 12 s before expiry without reporting")
    s.player.callFunc("renewPlan")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 3, status: 200, body: fixtureText("app-plan-v2.json") })
    check(countType(s, "plan_renewed") = 1 and countType(s, "plan_renew_failed") = 0, "the second attempt succeeds: renewed once, no failure")
    check(timer.duration = 100, "the next cycle starts again at 20 s")
    s.player.callFunc("stopPlan")

    f = stage()
    f.player.callFunc("loadPlan", f.overlay, f.video, "view-1", m.origin, m.project, m.asset, "es")
    f.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v2.json") })
    timer = f.player.findNode("ilPlanRenew")
    f.player.callFunc("renewPlan")
    f.player.callFunc("receivePlan", { sessionId: "view-1", revision: 2, status: 204 })
    f.player.callFunc("renewPlan")
    f.player.callFunc("receivePlan", { sessionId: "view-1", revision: 3, status: 0 })
    check(timer.duration = 115 and countType(f, "plan_renew_failed") = 0, "the third attempt is 5 s before expiry")
    f.player.callFunc("renewPlan")
    f.player.callFunc("receivePlan", { sessionId: "view-1", revision: 4, status: 404 })
    check(countType(f, "plan_renew_failed") = 1 and f.player.event.reason = "http_404", "after the third failure plan_renew_failed comes once with the last reason")
    f.player.callFunc("setClock", m.now + 120)
    f.player.callFunc("planTick")
    check(f.player.event.type = "plan_expired" and countType(f, "plan_renew_failed") = 1, "then the plan expires")
end sub

sub testUnreadable()
    stitched = fixture("app-plan-v1.json")
    stitched.timeline = { kind: "stitched", pdt_origin: "2026-11-02T15:00:00Z" }
    s = stage()
    s.player.callFunc("loadPlan", s.overlay, s.video, "view-1", m.origin, m.project, m.asset, "es")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: formatJson(stitched) })
    check(s.player.event.type = "plan_unavailable" and s.player.event.status = 200 and s.player.event.reason = "stitched" and s.player.contentReady, "a stitched plan is unavailable with reason stitched")
    for each body in ["{", formatJson({ version: 9 })]
        b = stage()
        b.player.callFunc("loadPlan", b.overlay, b.video, "view-1", m.origin, m.project, m.asset, "es")
        b.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: body })
        check(b.player.event.status = 200 and b.player.event.reason = "invalid", "an unreadable 200 is unavailable with reason invalid")
    end for
end sub

sub testRenewTooLate()
    s = stage()
    s.player.callFunc("loadPlan", s.overlay, s.video, "view-1", m.origin, m.project, m.asset, "es")
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v2.json") })
    timer = s.player.findNode("ilPlanRenew")
    s.player.callFunc("renewPlan")
    sent = lastUrl()
    ' The first attempt times out so late that its answer lands within the plan's final 0.1 s.
    s.player.callFunc("setClock", m.now + 119.95#)
    s.player.callFunc("receivePlan", { sessionId: "view-1", revision: 2, status: 0, timedOut: true })
    check(timer.control = "stop" and lastUrl() = sent, "no request goes out once only expiry is left")
    check(countType(s, "plan_renew_failed") = 1 and s.player.event.reason = "timeout", "plan_renew_failed comes once with the last reason")
    s.player.callFunc("setClock", m.now + 120)
    s.player.callFunc("planTick")
    check(s.player.event.type = "plan_expired" and countType(s, "plan_renew_failed") = 1, "then the plan expires")
    m2 = stage()
    m2.player.callFunc("loadPlan", m2.overlay, m2.video, "view-1", m.origin, m.project, m.asset, "es")
    m2.player.callFunc("receivePlan", { sessionId: "view-1", revision: 1, status: 200, body: fixtureText("app-plan-v2.json") })
    m2.player.callFunc("renewPlan")
    m2.player.callFunc("setClock", m.now + 117)
    m2.player.callFunc("receivePlan", { sessionId: "view-1", revision: 2, status: 0 })
    check(m2.player.findNode("ilPlanRenew").control = "start" and m2.player.findNode("ilPlanRenew").duration < 0.2 and countType(m2, "plan_renew_failed") = 0, "a missed slot before expiry goes out at once")
end sub

sub testDriversDontMix()
    v1 = fixture("app-plan-v1.json")
    s = stage(v1.commerce.session)
    s.player.callFunc("attachPlan", s.overlay, s.video, v1.commerce.session, v1, m.origin, "es")
    s.player.callFunc("startPlan")
    s.player.callFunc("finishBreak", "break_end")
    s.player.callFunc("breakStarted", 58000)
    check(s.player.event.type = "break_refused" and s.player.event.reason = "plan_has_cuts" and not s.overlay.linearBreak, "breakStarted on a plan with cuts is refused")
    s.player.callFunc("setBreaks", [58000])
    check(s.player.event.type = "break_refused" and s.player.event.reason = "plan_has_cuts", "setBreaks on a plan with cuts is refused")
    s.player.callFunc("stopPlan")

    h = hostStage(fixture("host-plan.json"))
    h.player.callFunc("setBreaks", [58000])
    check(not h.player.callFunc("replacePlan", fixture("app-plan-v1.json")) and h.player.event.reason = "plan_has_cuts", "a host-driven view refuses a replacement with cuts")
    h.player.callFunc("breakStarted", 58000)
    check(h.player.event.type = "break_start" and h.player.event.cut = "at-58000", "the host plan stays in place")
    h.player.callFunc("stopPlan")

    o = hostStage(fixture("host-plan.json"))
    o.player.callFunc("breakStarted", 178000)
    check(not o.player.callFunc("replacePlan", fixture("app-plan-v1.json")) and o.player.event.reason = "plan_has_cuts" and o.overlay.linearBreak, "an open host break refuses a replacement with cuts")
    o.player.callFunc("stopPlan")

    q = hostStage(fixture("host-plan.json"))
    check(q.player.callFunc("replacePlan", fixture("app-plan-v1.json")), "before any host call a replacement with cuts is still taken")
    q.player.callFunc("stopPlan")
end sub

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
    m.key = key
    return { video: video, overlay: overlay, player: player }
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
    check(s.player.planUrl = m.origin + "/il-player/app-plan?project=" + m.project + "&asset=" + m.asset + "&app=roku%3Adev&renew=" + adPlanQuery(v1.commerce.url, "grant").encodeUriComponent(), "renewal sends the current grant")
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
    check(adPlanQuery(v2.player.planUrl, "renew") = adPlanQuery(fixture("app-plan-v2.json").commerce.url, "grant"), "the v2 renewal sends its grant")
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
    check(s.player.event.format = "break_product" and s.player.event.url = v1.commerce.break_url + "&cut=pre&tag=T_pre&creative=cr1&delivery=" + m.delivery + "&locale=es", "the reader's own break asks the card of the playing ad")
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
    check(s.player.event.format = "break_product" and s.player.event.url = host.commerce.break_url + "&cut=at-58000&tag=T_mid&creative=cr1&delivery=" + m.delivery + "&locale=es", "the reported ad asks its card with cut=at-<ms>")
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
    check(adPlanQuery(pre.player.event.url, "cut") = "at-0", "a host pre-roll is at-0")
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

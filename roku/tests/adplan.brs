sub main()
    m.checks = 0
    m.failures = 0
    testReader()
    testScheduling()
    testVast()
    testPlayer()
    testProduct()
    testBreakBuy()
    testRafWalk()
    if m.failures = 0 then print "ROKU_ADPLAN_OK " + m.checks.toStr()
end sub

sub check(ok as Boolean, label as String)
    m.checks = m.checks + 1
    if not ok
        m.failures = m.failures + 1
        print "FAIL: " + label
    end if
end sub

function planFixture() as Object
    gam = "https://pubads.g.doubleclick.net/gampad/ads?iu=/1/a&cust_params=x%3D1"
    iad = "https://ads.iadserver.com/gampad/ads?tag=t&output=vast"
    plan = { version: 1, expires_at: "2099-01-01T00:00:00Z", page_url: "https://site.example/v" }
    plan.cuts = [
        { id: "mid", at: 60, requests: [{ provider: "iadserver", tag_url: iad }, { provider: "gam", tag_url: gam }, { provider: "evil", tag_url: "https://evil.example/" }] }
        { id: "pre", at: 0, tag_url: gam }
        { id: "bad", at: 5, requests: [{ provider: "gam", tag_url: "http://pubads.g.doubleclick.net/gampad/ads" }] }
    ]
    first = { id: "w1", start_ms: 10000, end_ms: 25000, targeting: { topic: ["a", "b"] } }
    second = { id: "w2", start_ms: 20000, end_ms: 35000 }
    third = { id: "w3", start_ms: 55000, end_ms: 75000 }
    plan.scenes = { formats: ["l_shape", "super", "overlay_300x250"],
        graphics: [{ format: "super", tag_url: gam }, { format: "l_shape", tag_url: gam }, { format: "super", tag_url: "https://evil.example/ads" }],
        pacing: { min_seconds: 5, max_seconds: 12, gap_after_seconds: 2, cut_clearance_seconds: 3, max_per_video: 2 },
        windows: [third, second, first] }
    return plan
end function

sub testReader()
    plan = planFixture()
    read = adPlanRead(plan, 1000&, invalid, "sid1")
    check(read <> invalid, "a valid plan is read")
    if read = invalid then return
    check(read.cuts.count() = 2 and read.cuts[0].id = "pre" and read.cuts[1].id = "mid", "cuts sort by time and an unusable cut is dropped")
    check(read.cuts[1].requests.count() = 2, "a provider outside the contract is dropped")
    check(instr(1, read.cuts[1].requests[0].tagUrl, "sid=sid1") > 0, "iADServer receives the session")
    check(instr(1, read.cuts[1].requests[1].tagUrl, "sid=") = 0 and instr(1, read.cuts[1].requests[1].tagUrl, "description_url=") > 0, "GAM receives the page and not the session")
    check(read.graphics.count() = 2 and read.graphics[0].format = "l_shape", "graphics follow plan order")
    check(read.windows[0].id = "w1" and read.windows[0]["end"] = 22000, "windows sort and max_seconds caps them")
    check(read.windows.count() = 2, "cut clearance drops a window left too short")
    expired = planFixture()
    expired.expires_at = "2001-01-01T00:00:00Z"
    check(adPlanRead(expired, 1700000000&, invalid, "s") = invalid, "an expired plan is refused")
    stitched = planFixture()
    stitched.timeline = { kind: "stitched", pdt_origin: "2026-01-01T00:00:00Z" }
    check(adPlanRead(stitched, 1000&, invalid, "s") = invalid, "a stitched plan draws nothing")
    wrong = planFixture()
    wrong.version = 2
    check(adPlanRead(wrong, 1000&, invalid, "s") = invalid, "an unknown version is refused")
    shop = planFixture()
    shop.commerce = { kind: "scene_product", url: "https://other.example/p", lead_ms: 1000, pacing: { min_seconds: 5 }, windows: [] }
    check(adPlanRead(shop, 1000&, "https://il.example", "s").shop = invalid, "a product URL on another origin is ignored")
    shop.commerce.url = "https://il.example/p?g=1"
    check(adPlanRead(shop, 1000&, "https://il.example", "s").shop <> invalid, "a product URL on the plan origin is read")
end sub

sub testScheduling()
    cuts = [{ id: "a", at: 10 }, { id: "b", at: 20 }]
    settled = {}
    check(adPlanDueCut(cuts, settled, 9000#) = invalid, "no break before its time")
    due = adPlanDueCut(cuts, settled, 10500#)
    check(due <> invalid and due.id = "a", "the due break is chosen")
    settled = {}
    check(adPlanDueCut(cuts, settled, 40000#) = invalid and settled.a = true and settled.b = true, "a seek past breaks plays no backlog")
    one = { id: "x", start: 10000# }
    one["end"] = 20000#
    near = { id: "y", start: 35000# }
    near["end"] = 45000#
    far = { id: "z", start: 45000# }
    far["end"] = 55000#
    pacing = { min_seconds: 5, gap_after_seconds: 2, max_per_video: 2 }
    check(not adPlanPacingAllows(near, [one], pacing), "starts closer than 30 s are refused")
    check(adPlanPacingAllows(far, [one], pacing), "a distant window is allowed")
    check(not adPlanPacingAllows(far, [one, near], pacing), "max_per_video is honoured")
    tag = adPlanGraphicTag("https://pubads.g.doubleclick.net/gampad/ads?cust_params=x%3D1", "super", { topic: ["a", "b"] }, "https://p.example/")
    params = adPlanQuery(tag, "cust_params")
    check(instr(1, params, "x=1") > 0 and instr(1, params, "il_format=super") > 0 and instr(1, params, "topic=a%2Cb") > 0, "targeting joins the tag")
    check(adPlanQuery(tag, "correlator") <> "", "each request has a correlator")
end sub

function vast(body as String) as String
    return "<VAST version=" + chr(34) + "4.0" + chr(34) + ">" + body + "</VAST>"
end function

function inlineAd(width as String, height as String, image as String) as String
    q = chr(34)
    return "<Ad><InLine><Impression>https://t.example/i</Impression><Creatives><Creative><NonLinearAds><TrackingEvents><Tracking event=" + q + "creativeView" + q + ">https://t.example/v</Tracking></TrackingEvents><NonLinear width=" + q + width + q + " height=" + q + height + q + " minSuggestedDuration=" + q + "00:00:05" + q + "><StaticResource creativeType=" + q + "image/png" + q + ">" + image + "</StaticResource></NonLinear></NonLinearAds></Creative></Creatives></InLine></Ad>"
end function

sub testVast()
    check(adPlanParseVast(vast(""), "super", 9000#).noFill = true, "an empty VAST is no fill")
    ad = adPlanParseVast(vast(inlineAd("600", "90", "https://c.example/a.png")), "super", 9000#)
    check(ad.imageUrl = "https://c.example/a.png" and ad.impressions.count() = 2, "a static graphic is read with both pixels")
    check(adPlanParseVast(vast(inlineAd("600", "90", "https://c.example/a.png")), "l_shape", 9000#).failed = true, "the wrong shape is refused")
    check(adPlanParseVast(vast(inlineAd("600", "90", "http://c.example/a.png")), "super", 9000#).failed = true, "a non-HTTPS image is refused")
    check(adPlanParseVast(vast(inlineAd("600", "90", "https://c.example/a.png")), "super", 3000#).failed = true, "a graphic longer than the window is refused")
    check(adPlanParseVast(vast("<Ad><Wrapper/></Ad>"), "super", 9000#).failed = true, "a wrapper is refused")
    check(adPlanParseVast("<!DOCTYPE x><VAST/>", "super", 9000#).failed = true, "a DOCTYPE is refused")
end sub

sub testPlayer()
    scene = createObject("roSGNode", "Scene")
    video = scene.createChild("Group")
    video.addFields({ width: 960.0, height: 540.0, state: "playing", control: "", seek: 0.0,
        positionInfo: { epoch: 0, video: 0.0, clip_id: 7 } })
    video.addField("content", "node", false)
    video.content = createObject("roSGNode", "ContentNode")
    overlay = scene.createChild("ILOverlay")
    player = scene.createChild("ILAdPlanPlayer")
    check(overlay.callFunc("attach", video, "s1"), "overlay attaches")
    check(player.callFunc("attachPlan", overlay, video, "s1", planFixture(), invalid, "es"), "the plan attaches")
    player.callFunc("startPlan")
    check(overlay.linearBreak and not video.visible, "the pre-roll opens a break before content")
    player.callFunc("finishBreak", "break_end")
    check(player.contentReady and not overlay.linearBreak and video.visible, "the host may start content after the pre-roll")
    video.positionInfo = { epoch: 0, video: 7.0, clip_id: 7 }
    player.callFunc("planTick")
    check(player.event.type = "request" and player.event.window = "w1", "a graphic is asked ahead of its window")
    player.callFunc("receive", { sessionId: "other", revision: 1, status: 200, body: "" })
    check(player.event.type = "request", "another session's answer is ignored")
    player.callFunc("receive", { sessionId: "s1", revision: 1, status: 200, body: vast(inlineAd("1600", "900", "https://c.example/l.png")) })
    check(player.event.type = "fill", "the graphic fills")
    video.positionInfo = { epoch: 0, video: 10.0, clip_id: 7 }
    overlay.callFunc("setClockAnchor", "s1", { positionSeconds: 0, programTimeMs: 0, clipId: 7 })
    check(overlay.findNode("ilPrimary").getChildCount() = 1, "the plan's cue reaches the overlay")
    check(overlay.callFunc("setTimeline", "s1", []) and overlay.findNode("ilPrimary").getChildCount() = 1, "a session feed update keeps the plan's cue")
    overlay.impression = { sessionId: "s1", id: "il-ads-w1", format: "l" }
    check(player.event.type = "impression", "the impression is reported")
    video.positionInfo = { epoch: 0, video: 60.5, clip_id: 7 }
    player.callFunc("planTick")
    check(overlay.linearBreak and video.control = "stop", "a mid-roll stops content")
    check(overlay.findNode("ilArt").visible = false, "nothing is drawn over the ad")
    player.callFunc("finishBreak", "break_error")
    check(not overlay.linearBreak and video.control = "play" and video.seek = 60.5, "a failed break resumes content at its position")
    player.callFunc("stopPlan")
    check(overlay.findNode("ilPrimary").getChildCount() = 0, "stopping removes the plan's graphics")
end sub

function planStage() as Object
    scene = createObject("roSGNode", "Scene")
    video = scene.createChild("Group")
    video.addFields({ width: 960.0, height: 540.0, state: "playing", control: "", seek: 0.0,
        positionInfo: { epoch: 0, video: 0.0, clip_id: 7 } })
    video.addField("content", "node", false)
    video.content = createObject("roSGNode", "ContentNode")
    video.translation = [32, 18]
    overlay = scene.createChild("ILOverlay")
    player = scene.createChild("ILAdPlanPlayer")
    overlay.callFunc("attach", video, "s1")
    overlay.commerceAutoFocus = false
    overlay.commerceEnabled = true
    return { video: video, overlay: overlay, player: player }
end function

function offerFields() as Object
    return { title: "Botines", price: "50", currency: "USD", locale: "es",
        handoffUrl: "https://ads.example/handoff", variants: [{ id: "42", label: "Talle 42" }] }
end function

sub testProduct()
    stage = planStage()
    plan = planFixture()
    plan.cuts = []
    plan.commerce = { kind: "scene_product", url: "https://il.example/p?g=1", lead_ms: 1000,
        pacing: { min_seconds: 5 }, windows: [{ id: "w1", start_ms: 10000, end_ms: 25000 }] }
    check(stage.player.callFunc("attachPlan", stage.overlay, stage.video, "s1", plan, "https://il.example", "es"), "a plan with a product attaches")
    stage.player.callFunc("startPlan")
    stage.video.positionInfo = { epoch: 0, video: 9.5, clip_id: 7 }
    stage.player.callFunc("planTick")
    check(stage.player.event.type = "request" and stage.player.event.format = "scene_product", "the product is asked first, ahead of its window")
    card = { id: "card-1", window: "w1", format: "overlay", start: 0, imageUrl: "https://cdn.example/shoe.jpg",
        impressionUrl: "https://events.example/i", commerce: offerFields() }
    card["end"] = 99000
    stage.player.callFunc("receive", { sessionId: "s1", revision: 1, status: 200, body: formatJson(card) })
    check(stage.player.event.type = "fill" and stage.player.event.format = "scene_product", "a valid card fills the window")
    stage.video.positionInfo = { epoch: 0, video: 11.0, clip_id: 7 }
    stage.overlay.callFunc("setClockAnchor", "s1", { positionSeconds: 0, programTimeMs: 0, clipId: 7 })
    check(stage.overlay.findNode("ilPrimary").getChildCount() = 1, "the product card reaches the overlay")
    stage.overlay.impression = { sessionId: "s1", id: "card-1", format: "overlay" }
    check(stage.player.event.type = "impression" and stage.player.event.format = "scene_product", "the product impression is reported")
    stage.player.callFunc("stopPlan")

    empty = planStage()
    check(empty.player.callFunc("attachPlan", empty.overlay, empty.video, "s1", plan, "https://il.example", "es"), "the plan attaches again")
    empty.player.callFunc("startPlan")
    empty.video.positionInfo = { epoch: 0, video: 9.5, clip_id: 7 }
    empty.player.callFunc("planTick")
    empty.player.callFunc("receive", { sessionId: "s1", revision: 1, status: 204 })
    check(empty.player.event.type = "request" and empty.player.event.format = "l_shape" and empty.player.event.window = "w1", "with no product the window goes to a graphic")
    empty.player.callFunc("stopPlan")
end sub

sub testBreakBuy()
    shopAd = { creativeId: "c1", tracking: [{ event: "Start", url: "https://t.example/s" },
        { event: "Impression", url: "https://ads.iadserver.com/events/d1/impression?x=1" }] }
    spot = adPlanRafSpot(shopAd)
    check(spot <> invalid and spot.creativeId = "c1" and spot.deliveryId = "d1", "the spot identity is read from RAF's ad")
    check(adPlanRafSpot({ creativeId: "c1", tracking: [{ url: "https://t.example/i" }] }) = invalid, "an ad without a delivery has no identity")
    stage = planStage()
    plan = planFixture()
    plan.scenes = invalid
    plan.cuts = [{ id: "pre", at: 0, requests: [{ provider: "iadserver", tag_url: "https://ads.iadserver.com/gampad/ads?tag=t" }] }]
    plan.commerce = { kind: "scene_product", url: "https://il.example/p", lead_ms: 1000, session: "s1", pacing: { min_seconds: 5 }, windows: [] }
    stage.player.callFunc("attachPlan", stage.overlay, stage.video, "s1", plan, "https://il.example", "es")
    stage.player.callFunc("startPlan")
    clock = createObject("roDateTime")
    nowMs = clock.asSeconds() * 1000#
    midroll = { id: "d1", format: "midroll", linearCreativeId: "c1", start: nowMs - 5000#, commerce: offerFields() }
    midroll["end"] = nowMs + 60000#
    stage.player.callFunc("applySpot", spot)
    check(stage.player.linearSpot.deliveryId = "d1", "the host learns the spot to read its shop")
    stage.overlay.callFunc("setTimeline", "s1", [midroll])
    check(stage.overlay.findNode("ilCommerce").visible, "Buy shows during the break while the content is hidden")
    stage.player.callFunc("finishBreak", "break_end")
    check(not stage.overlay.findNode("ilCommerce").visible and not stage.overlay.linearBreak, "Buy leaves with the break")
    stage.player.callFunc("stopPlan")
end sub

function fakeRaf(answers as Object) as Object
    return {
        answers: answers, urls: [], shown: 0, playAd: invalid
        setTrackingCallback: sub(callback, target)
            m.callback = callback
            m.target = target
        end sub
        setAdUrl: sub(url)
            m.urls.push(url)
        end sub
        getAds: function()
            return m.answers[m.urls.count() - 1]
        end function
        showAds: function(pods, context, view)
            m.shown = m.shown + 1
            for each ad in pods[0].ads
                m.callback(m.target, "Start", { ad: ad })
                m.callback(m.target, "Impression", { ad: ad })
                m.seen = m.target.spot
            end for
            return true
        end function
    }
end function

sub testRafWalk()
    requests = [{ provider: "iadserver", tagUrl: "https://a.example/1" }, { provider: "gam", tagUrl: "https://b.example/2" }]
    shop = { creativeId: "c9", tracking: [{ url: "https://ads.iadserver.com/events/d9/impression" }] }
    top = { spot: invalid }
    raf = fakeRaf([[], [{ ads: [shop] }]])
    check(adPlanRunBreak(requests, raf, invalid, top) = "break_end", "the second request fills the break")
    check(raf.urls.count() = 2 and raf.urls[1] = "https://b.example/2" and raf.shown = 1, "requests are asked in plan order and one pod plays")
    check(top.spot.deliveryId = "d9", "RAF's playing ad sets the identity")
    plain = { spot: invalid }
    raf = fakeRaf([[{ ads: [shop, { creativeId: "c2", tracking: [] }] }]])
    adPlanRunBreak(requests, raf, invalid, plain)
    check(plain.spot.count() = 0, "the next ad without a shop clears the identity")
    none = { spot: invalid }
    raf = fakeRaf([invalid, []])
    check(adPlanRunBreak(requests, raf, invalid, none) = "break_error" and raf.shown = 0, "a break with no ads plays nothing")
    stage = planStage()
    plan = planFixture()
    plan.scenes = invalid
    plan.cuts = [{ id: "pre", at: 0, tag_url: "https://pubads.g.doubleclick.net/gampad/ads?iu=/1/a" }]
    stage.player.callFunc("attachPlan", stage.overlay, stage.video, "s1", plan, invalid, "es")
    stage.player.callFunc("startPlan")
    stage.player.callFunc("applySpot", { creativeId: "c9", deliveryId: "d9" })
    stage.player.callFunc("applySpot", {})
    check(stage.player.linearSpot.count() = 0 and stage.overlay.linearBreak, "a spot without a shop keeps the break and drops Buy")
    stage.player.callFunc("stopPlan")
    back = { spot: invalid }
    raf = fakeRaf([[{ ads: [shop] }]])
    raf.exitWithBack = true
    raf.showAds = function(pods, context, view)
        m.shown = m.shown + 1
        return false
    end function
    check(adPlanRunBreak(requests, raf, invalid, back) = "break_error", "Back out of the ads is not a complete break")
    check(adPlanRafSpot({ creativeId: "c1", tracking: [{ url: "https://evil.example/events/d1/impression" }] }) = invalid, "only iADServer's impression names a delivery")
    late = { spot: invalid, cancelled: false }
    raf = fakeRaf([[{ ads: [shop] }], [{ ads: [shop] }]])
    raf.late = late
    raf.getAds = function()
        ' The guard gives the content back while this getAds() is still waiting.
        m.late.cancelled = true
        return m.answers[m.urls.count() - 1]
    end function
    check(adPlanRunBreak(requests, raf, invalid, late) = "break_error" and raf.shown = 0 and raf.urls.count() = 1, "a late getAds() after the guard draws nothing and asks no more")
    adPlanTrack(late, "Impression", { ad: shop })
    check(late.spot = invalid, "a cancelled break reports no identity")
    testBreakGuard()
    testSessionAndConsent()
    testReaderParity()
end sub

sub testBreakGuard()
    stage = planStage()
    plan = planFixture()
    plan.scenes = invalid
    plan.cuts = [{ id: "mid", at: 30, tag_url: "https://pubads.g.doubleclick.net/gampad/ads?iu=/1/a" }]
    stage.player.callFunc("attachPlan", stage.overlay, stage.video, "s1", plan, invalid, "es")
    stage.player.callFunc("startPlan")
    stage.video.positionInfo = { epoch: 0, video: 30.2, clip_id: 7 }
    stage.player.callFunc("planTick")
    check(stage.overlay.linearBreak and not stage.video.visible, "a mid-roll hides the content")
    check(not stage.player.callFunc("breakGuardAt", 9000), "the guard waits up to 10 s for an ad")
    check(stage.player.callFunc("breakGuardAt", 10000), "an ad server that never answers releases the content after 10 s")
    check(not stage.overlay.linearBreak and stage.video.visible and stage.video.control = "play" and stage.player.event.type = "break_error", "the content is back and playing")
    stage.player.callFunc("applySpot", { creativeId: "late", deliveryId: "late" })
    check(stage.player.linearSpot = invalid or stage.player.linearSpot.count() = 0, "a late spot after the guard changes nothing")
    stage.video.positionInfo = { epoch: 0, video: 30.2, clip_id: 7 }
    stage.player.callFunc("stopPlan")

    long = planStage()
    long.player.callFunc("attachPlan", long.overlay, long.video, "s1", plan, invalid, "es")
    long.player.callFunc("startPlan")
    long.video.positionInfo = { epoch: 0, video: 30.2, clip_id: 7 }
    long.player.callFunc("planTick")
    long.player.callFunc("applySpot", {})
    check(not long.player.callFunc("breakGuardAt", 60000), "an ad that started may play past 10 s")
    check(long.player.callFunc("breakGuardAt", 130000), "no break holds the content past 130 s")
    long.player.callFunc("stopPlan")
end sub

sub testSessionAndConsent()
    plan = planFixture()
    plan.commerce = { kind: "scene_product", url: "https://il.example/p", lead_ms: 1000, session: "plan-s", pacing: { min_seconds: 5 }, windows: [] }
    host = adPlanRead(plan, 1000&, "https://il.example", "host-s")
    check(host.sid = "host-s" and not host.breakShop and instr(1, host.cuts[1].requests[0].tagUrl, "sid=host-s") > 0, "the host's view id is the sid, without Buy during a break")
    planned = adPlanRead(plan, 1000&, "https://il.example", "")
    check(planned.sid = "plan-s" and planned.breakShop, "without a host id the plan's session is the sid, with Buy during a break")
    fresh = adPlanRead(planFixture(), 1000&, invalid, "")
    check(len(fresh.sid) = 32 and instr(1, fresh.cuts[1].requests[0].tagUrl, "sid=" + fresh.sid) > 0, "otherwise a fresh id is sent")
    consent = { gdpr: 1, gdpr_consent: "CPtc", us_privacy: "1YNN", gpp: "DBABMA~x", gpp_sid: "2,7" }
    tag = adPlanCorrelated("https://pubads.g.doubleclick.net/gampad/ads?iu=/1", consent)
    check(adPlanQuery(tag, "gdpr") = "1" and adPlanQuery(tag, "gdpr_consent") = "CPtc" and adPlanQuery(tag, "us_privacy") = "1YNN" and adPlanQuery(tag, "gpp") = "DBABMA~x" and adPlanQuery(tag, "gpp_sid") = "2,7", "the host's consent reaches the ad request")
    graphic = adPlanGraphicTag("https://pubads.g.doubleclick.net/gampad/ads", "super", invalid, invalid, consent)
    check(adPlanQuery(graphic, "gdpr_consent") = "CPtc", "graphics carry the consent too")
    check(adPlanQuery(adPlanCorrelated("https://pubads.g.doubleclick.net/gampad/ads"), "gdpr") = "", "no consent, no parameters")
end sub

sub testReaderParity()
    noPacing = planFixture()
    noPacing.scenes = { formats: ["super"], windows: [] }
    check(adPlanRead(noPacing, 1000&, invalid, "s") = invalid, "scenes without pacing void the plan")
    check(adPlanRead({ version: 1, expires_at: "2099-01-01T00:00:00Z" }, 1000&, invalid, "s") = invalid, "a plan with nothing to play is refused")
    fraction = planFixture()
    fraction.scenes.pacing.max_per_video = 1.5
    check(adPlanRead(fraction, 1000&, invalid, "s") = invalid, "a fractional max_per_video is refused")
    lead = planFixture()
    lead.commerce = { kind: "scene_product", url: "https://il.example/p", lead_ms: 10.5, pacing: { min_seconds: 5 }, windows: [] }
    check(adPlanRead(lead, 1000&, "https://il.example", "s").shop = invalid, "a fractional lead_ms is refused")
    check(adPlanCanonical("gam", "https://PUBADS.g.doubleclick.net:443/gampad/ads?iu=/1") = "https://pubads.g.doubleclick.net/gampad/ads?iu=/1", "the host's case and :443 are normalised")
    check(adPlanCanonical("gam", "https://pubads.g.doubleclick.net:8443/gampad/ads") = invalid, "another port is refused")
    check(adPlanCanonical("iadserver", "https://ads.iadserver.com.evil.example/gampad/ads") = invalid, "a look-alike host is refused")
    check(adPlanCanonical("gam", "https://pubads.g.doubleclick.net/GAMPAD/ads") = invalid, "the path stays case-sensitive")
    check(adPlanIsoSeconds("2026-01-01T03:00:00+03:00") = adPlanIsoSeconds("2026-01-01T00:00:00Z"), "an offset is honoured")
    check(adPlanIsoSeconds("2026-01-01T00:00:00.250-02:30") = adPlanIsoSeconds("2026-01-01T02:30:00Z"), "a negative offset with fractions is honoured")
    offset = planFixture()
    offset.expires_at = "2001-01-01T00:00:00+01:00"
    check(adPlanRead(offset, 1700000000&, invalid, "s") = invalid, "an expired plan with an offset is refused")
    check(adPlanRead({ version: 1, expires_at: "soon", cuts: [] }, 1000&, invalid, "s") = invalid, "an unreadable date is refused")
end sub

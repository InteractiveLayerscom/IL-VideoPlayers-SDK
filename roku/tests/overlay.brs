' @rokucommunity/brs implements Group, Poster and Timer. Supply the native
' decoder and compositor fields that only a physical Roku can generate.
sub main()
    m.checks = 0
    m.failures = 0
    scene = createObject("roSGNode", "Scene")
    video = scene.createChild("Group")
    video.addFields({
        width: 960.0
        height: 540.0
        state: "playing"
        positionInfo: { epoch: 1, video: 1700000000.25#, clip_id: 17 }
    })
    video.addField("content", "node", false)
    video.content = createObject("roSGNode", "ContentNode")
    video.translation = [32, 18]
    overlay = scene.createChild("ILOverlay")
    check(overlay <> invalid, "the app can construct ILOverlay")
    if overlay = invalid then return

    offer = { id: "commerce", format: "overlay", start: 1700000000000#, imageUrl: "https://cdn.example/shoe.jpg" }
    offer["end"] = 1700000040000#
    offer.commerce = { title: "Botines", price: "50", currency: "USD", locale: "es",
        handoffUrl: "https://ads.example/handoff", variants: [{ id: "42", label: "Talle 42" }] }
    check(overlay.callFunc("attach", video, "session-a"), "attach to the existing video")
    check(overlay.callFunc("getProgramTimeMs") = 1700000000250#, "query the sidecar using the last rendered frame even before cues arrive")
    overlay.commerceAutoFocus = false
    overlay.commerceEnabled = true
    check(overlay.callFunc("setTimeline", "session-a", [offer]), "accept commerce snapshot")
    card = overlay.findNode("ilPrimary").getChild(0)
    check(card <> invalid, "normalize a product card from the session")
    if card <> invalid
        card.loadStatus = "ready"
        pulse(overlay, offer)
        check(overlay.findNode("ilCommerce").visible, "the interactive control appears with the artwork")
        check(overlay.callFunc("handleCommerceKey", "OK", true), "the remote opens the product")
        check(overlay.findNode("ilCommerceName").text = "Botines", "the product description is shown")
        check(overlay.callFunc("handleCommerceKey", "back", true), "the remote closes the product panel")
    end if
    offer.commerce.handoffUrl = "http://ads.example/handoff"
    check(overlay.callFunc("setTimeline", "session-a", [offer]), "accept subsequent snapshot")
    check(overlay.findNode("ilPrimary").getChild(0) = invalid, "reject non-HTTPS checkout")
    overlay.commerceEnabled = false

    cue = { id: "A", format: "l", start: 1700000000000#, imageUrl: "https://cdn.example/ad.jpg" }
    cue["end"] = 1700000001000#
    cue.impressionUrl = "https://events.example/i?a=1"
    check(not overlay.callFunc("setTimeline", "previous-session", [cue]), "a late sidecar cannot enter another session")
    invalidCue = { id: "bad", format: "l", start: 1700000000000#, imageUrl: "file:///ad.jpg" }
    invalidCue["end"] = 1700000001000#
    check(overlay.callFunc("setTimeline", "session-a", [invalidCue, cue]), "accept the current snapshot")
    art = overlay.findNode("ilArt")
    rail = overlay.findNode("ilPrimary")
    foot = overlay.findNode("ilSecondary")
    first = rail.getChild(0)
    second = foot.getChild(0)
    check(first <> invalid and second <> invalid, "both visible pieces of an opaque L are loaded")
    if first = invalid or second = invalid then return
    check(first.uri = cue.imageUrl, "invalid URLs are ignored and the selected creative is loaded")
    check(not art.visible and video.width = 960, "video stays full size during image loading")
    first.loadStatus = "ready"
    pulse(overlay, cue)
    check(not art.visible and not reported(overlay), "a half-loaded L cannot count")
    second.loadStatus = "ready"
    pulse(overlay, cue)
    check(art.visible and video.width = 720 and video.height = 405, "both surfaces are ready before the video squeezes")
    check(art.translation[0] = 32 and art.translation[1] = 18, "the graphic follows a translated video")
    check(rail.clippingRect[0] = 720 and rail.clippingRect[2] = 240, "the right strip leaves the image's upper-left corner clear")
    check(foot.clippingRect[1] = 405 and foot.clippingRect[2] = 720, "the bottom strip does not double-blend the corner")
    check(not reported(overlay), "a decoded image still needs render evidence")
    first.renderTracking = "partial"
    pulse(overlay, cue)
    check(not reported(overlay), "both rendered L strips are required")
    second.renderTracking = "partial"
    pulse(overlay, cue)
    check(reported(overlay), "a rendered L signals its impression")
    if not reported(overlay) then return
    check(overlay.impression.id = "A" and overlay.impression.impressionUrl = cue.impressionUrl, "report the selected cue")
    firstTime = overlay.impression.programTimeMs
    overlay.linearBreak = true
    check(not art.visible and video.width = 960 and video.height = 540, "a linear break restores exact video size")
    overlay.linearBreak = false
    markRendered(overlay, cue)
    video.positionInfo = { epoch: 1, video: 1700000000.75#, clip_id: 17 }
    pulse(overlay, cue)
    check(overlay.impression.programTimeMs = firstTime, "resuming the same cue cannot send another impression")
    overlay.seeking = true
    check(not art.visible and video.width = 960, "the host seek immediately restores the video")
    video.positionInfo = { epoch: 1, video: 1700000001#, clip_id: 17 }
    overlay.seeking = false
    check(not art.visible and rail.getChildCount() = 0, "the end of a cue is exclusive")
    video.positionInfo = { epoch: 0, video: 20.25#, clip_id: 17 }
    pulse(overlay, cue)
    check(rail.getChildCount() = 0, "a relative clock without a PDT anchor remains silent")
    anchor = { positionSeconds: 20#, programTimeMs: 1700000000000#, clipId: 18 }
    overlay.callFunc("setClockAnchor", "session-a", anchor)
    check(rail.getChildCount() = 0, "a clock anchor from another clip cannot select a cue")
    anchor.clipId = 17
    overlay.callFunc("setClockAnchor", "session-a", anchor)
    check(rail.getChildCount() = 1, "a matching PDT maps to the playing clip")
    markRendered(overlay, cue)
    video.state = "paused"
    check(not art.visible and video.height = 540, "pause restores the original height")
    video.state = "playing"
    markRendered(overlay, cue)
    overlay.callFunc("detach")
    check(not art.visible and video.width = 960 and video.translation[0] = 32, "detach restores the video and its placement")
    check(not overlay.callFunc("setTimeline", "session-a", [cue]), "detach ignores pending callbacks")

    overlay.callFunc("attach", video, "session-b")
    cue.format = "super"
    cue.id = "B"
    video.positionInfo = { epoch: 1, video: 1700000000#, clip_id: 17 }
    pulse(overlay, cue, "session-b")
    banner = rail.getChild(0)
    check(banner <> invalid and foot.getChildCount() = 0, "a super opens exactly at the start")
    if banner = invalid then return
    check(banner.width = 720 and banner.height = 108, "super uses 75% width and 20% height")
    check(banner.translation[0] = 120 and banner.translation[1] = 378, "super begins at 12.5% and 70%")
    video.content = createObject("roSGNode", "ContentNode")
    check(not art.visible and rail.getChildCount() = 0, "changing the source removes the old session")
    overlay.callFunc("attach", video, "hls")
    q = chr(34)
    prefix = "#EXT-X-DATERANGE:ID=" + q + "hls-17" + q + ",CLASS=" + q
    timing = ",START-DATE=" + q + "2023-11-14T19:13:20.125-03:00" + q + ",DURATION=0.500"
    uri = "https://cdn.example/s.jpg?names=A,B&token=x=y"
    attrs = ",X-IL-FORMAT=" + q + "super" + q + ",X-ASSET-URI=" + q + uri + q
    attrs = attrs + ",X-ASSET-MIMETYPE=" + q + "image/jpeg" + q
    header = "#EXTM3U" + chr(10) + "#EXT-X-TARGETDURATION:4" + chr(10) + "#EXT-X-PROGRAM-DATE-TIME:2023-11-14T22:13:20Z" + chr(10)
    media = chr(10) + "#EXTINF:4," + chr(10) + "s.ts" + chr(10)
    foreign = prefix + "scte35" + q + timing + attrs
    il = prefix + "com.interactivelayers.overlay" + q + timing + attrs
    playlist = header + foreign + chr(10) + il + media
    video.positionInfo = { epoch: 1, video: 1700000000.124#, clip_id: 17 }
    check(overlay.callFunc("setManifest", "hls", playlist), "accept the session's media playlist")
    check(rail.getChildCount() = 0, "UTC offset and milliseconds keep the graphic out before the first frame")
    video.positionInfo = { epoch: 1, video: 1700000000.125#, clip_id: 17 }
    overlay.callFunc("setManifest", "hls", playlist)
    hlsBanner = rail.getChild(0)
    check(hlsBanner <> invalid, "recognize the exact start of a DATERANGE with an offset")
    if hlsBanner = invalid then return
    check(hlsBanner.uri = uri, "retain quoted query commas and equals signs")
    hlsBanner.loadStatus = "ready"
    overlay.callFunc("setManifest", "hls", playlist)
    hlsBanner.renderTracking = "full"
    overlay.callFunc("setManifest", "hls", playlist)
    check(overlay.impression.id = "hls-17", "report the DATERANGE ID")
    video.positionInfo = { epoch: 1, video: 1700000000.625#, clip_id: 17 }
    overlay.callFunc("setManifest", "hls", playlist)
    check(rail.getChildCount() = 0, "duration in seconds ends the range at exactly 625 ms")
    video.positionInfo = { epoch: 1, video: 1700000000.3#, clip_id: 17 }
    overlay.callFunc("setManifest", "hls", header + foreign + media)
    check(rail.getChildCount() = 0, "ignore another DATERANGE class")
    endDate = ",END-DATE=" + q + "2023-11-14T22:13:20.625Z" + q
    endOnly = "#EXT-X-DATERANGE:ID=" + q + "clock" + q + ",CLASS=" + q + "com.interactivelayers.overlay" + q
    endOnly = endOnly + ",START-DATE=" + q + "2023-11-14T22:13:20Z" + q + endDate + attrs
    overlay.callFunc("setManifest", "hls", header + endOnly + media)
    check(rail.getChildCount() = 1, "an END-DATE alone defines a complete cue")
    overlay.callFunc("setManifest", "hls", header + endOnly + ",DURATION=1" + media)
    check(rail.getChildCount() = 0, "conflicting END-DATE and DURATION are discarded")
    check(not overlay.callFunc("setManifest", "hls", header + "#EXT-X-STREAM-INF:BANDWIDTH=200000" + chr(10) + "video.m3u8"), "a master cannot substitute for the selected variant")
    if m.failures = 0 then print "ROKU_OK"; m.checks
end sub

function reported(overlay) as Boolean
    if overlay.impression = invalid then return false
    return overlay.impression.id <> invalid
end function

sub markRendered(overlay, cue)
    first = overlay.findNode("ilPrimary").getChild(0)
    second = overlay.findNode("ilSecondary").getChild(0)
    first.loadStatus = "ready"
    second.loadStatus = "ready"
    pulse(overlay, cue)
    first.renderTracking = "partial"
    second.renderTracking = "partial"
    pulse(overlay, cue)
end sub

sub pulse(overlay, cue, sessionId = "session-a")
    ' A normal sidecar refresh re-evaluates the same playback sample as a timer tick.
    overlay.callFunc("setTimeline", sessionId, [cue])
end sub

sub check(ok as Boolean, label as String)
    m.checks = m.checks + 1
    if not ok
        m.failures = m.failures + 1
        print "FAIL "; label
    end if
end sub

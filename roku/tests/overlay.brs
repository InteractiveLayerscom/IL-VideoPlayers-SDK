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
    for i = 2 to 100
        offer.commerce.variants.push({ id: "sku-" + i.toStr(), label: "Talle " + i.toStr(), price: i.toStr() + ".50" })
    end for
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
        testShopping(overlay)
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
    testScene(overlay, video, rail, foot)
    testUntypedScene(overlay, rail)
    testMidroll(overlay, video)
    if m.failures = 0 then print "ROKU_OK"; m.checks
end sub

sub testShopping(overlay)
    check(overlay.findNode("ilCommerceBuy").text = "Elegir opciones", "intro offers product details before checkout")
    check(overlay.findNode("ilCommerceGallery").visible, "the cover offers enlargement for even a single product photo")
    key(overlay, "up")
    key(overlay, "ok")
    enlarged = overlay.findNode("ilCommerceGalleryPhoto")
    check(enlarged <> invalid, "shop provides an enlarged photo surface")
    if enlarged = invalid then return
    check(enlarged.visible and enlarged.uri = "https://cdn.example/shoe.jpg", "cover opens the single legacy photo")
    check(not overlay.findNode("ilCommerceGalleryPrev").visible and not overlay.findNode("ilCommerceGalleryNext").visible, "single-photo enlargement omits navigation arrows")
    key(overlay, "right")
    check(enlarged.uri = "https://cdn.example/shoe.jpg", "Right keeps the only photo visible")
    key(overlay, "back")
    check(overlay.findNode("ilCommerceBuy").visible and overlay.findNode("ilCommerceBuy").text = "Elegir opciones", "Back from a cover image restores the cover")
    key(overlay, "ok")
    check(enlarged.visible, "the cover's enlargement control regains focus")
    key(overlay, "back")
    key(overlay, "down")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceBuyBackground").color = "0xFFFFFFFF" and overlay.findNode("ilCommerceBuy").color = "0x202020FF", "unbranded Add to cart is white with dark text")
    price = overlay.findNode("ilCommercePrice")
    check(overlay.findNode("ilCommerceBuy").text = "Agregar al carrito", "details add the selected SKU to the local cart")
    key(overlay, "left")
    key(overlay, "ok")
    check(price.text = "USD 100,50", "the last real variant can be selected from a long variant list")
    key(overlay, "down")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceBuy").text = "Continuar con el QR", "cart has a separate checkout action")
    qr = overlay.findNode("ilCommerceQr")
    check(not qr.visible and qr.uri = "", "adding the item does not request checkout")
    key(overlay, "ok")
    check(qr.visible and qr.uri = "https://ads.example/handoff/qr/sku-100.png", "checkout sends the selected SKU")
    key(overlay, "back")
    check(not qr.visible and overlay.findNode("ilCommerceBuy").text = "Continuar con el QR", "Back clears QR and returns to cart")
    key(overlay, "back")
    check(overlay.findNode("ilCommerceBuy").text = "Agregar al carrito", "cart returns to details")
    key(overlay, "back")
    check(overlay.findNode("ilCommerceBuy").text = "Elegir opciones", "details return to intro")
end sub

sub key(overlay, action)
    overlay.callFunc("handleCommerceKey", action, true)
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

sub testScene(overlay, video, rail, foot)
    cue = parseJson(readAsciiFile("pkg:/tests/creative-scene.json"))
    check(cue <> invalid, "the shared scene fixture loads")
    if cue = invalid then return
    cue.products[0].locale = "en-US"
    cue.products[1].locale = "pt-BR"
    overlay.commerceEnabled = true
    video.positionInfo = { epoch: 1, video: 1.5#, clip_id: 17 }
    pulse(overlay, cue, "hls")
    background = rail.findNode("background")
    poster = rail.findNode("brand-video")
    text = rail.findNode("headline")
    check(background <> invalid and poster <> invalid and text <> invalid, "the L mounts normalized scene graphics")
    if text = invalid or poster = invalid then return
    check(overlay.impression.id <> cue.id, "a scene needs compositor evidence before measurement")
    background.getChild(0).renderTracking = "partial"
    pulse(overlay, cue, "hls")
    check(overlay.impression.id = cue.id, "measure the visible scene after compositor confirmation")
    check(video.width = 960 and video.height = 540, "an L overlay leaves program geometry untouched")
    check(rail.clippingRect[0] = 720 and foot.clippingRect[1] = 405, "scene clips to the approved bands")
    check(text.translation[0] = 760 and text.translation[1] = 210, "animates position independently at the current content time")
    check(abs(text.opacity - .875) < .0001, "interpolates opacity independently of position")
    clip = poster.getChild(0)
    check(clip.clippingRect <> invalid and clip.clippingRect[2] = 240, "poster crop is clipped to the authored width")
    image = clip.getChild(0)
    check(image <> invalid and image.uri = "https://ads.example/poster.png", "single decoder mode uses the declared poster")
    if image <> invalid then check(image.width = 480 and image.translation[0] = 0 and image.translation[1] = -150, "poster uses the authored pan and zoom")
    video.state = "paused"
    pulse(overlay, cue, "hls")
    check(overlay.findNode("ilArt").visible, "the scene holds its position while paused")
    video.state = "playing"
    check(overlay.callFunc("handleCommerceKey", "right", true), "the remote moves between authored product cards")
    check(overlay.callFunc("handleCommerceKey", "ok", true), "the remote opens the selected offer")
    check(overlay.findNode("ilCommerceName").text = "Gorra", "the second product retains its title")
    check(overlay.findNode("ilCommercePhoto").uri = "https://ads.example/cap.png", "the second product retains its true photo")
    check(overlay.productView.viewUrl = "https://ads.example/cap/view", "the view beacon keeps its offer identity")
    check(overlay.findNode("ilCommerceBuy").text = "Escolher opções", "the scene product has its own Portuguese controls")
    check(overlay.findNode("ilCommerceLogo").uri = cue.brand.logoUrl, "the open product retains the brand logo")
    key(overlay, "ok")
    key(overlay, "right")
    key(overlay, "ok")
    key(overlay, "down")
    key(overlay, "ok")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceQr").uri = "https://ads.example/cap/cart/qr/green.png", "scene checkout uses the selected product's handoff and SKU")
    for i = 1 to 4
        key(overlay, "back")
    end for
    check(not overlay.findNode("ilCommerce").visible and not overlay.findNode("ilCommerceQr").visible, "leaving intro returns to scene navigation")
    key(overlay, "left")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceBuy").text = "View details", "switching products localizes the control set")
    key(overlay, "back")
    overlay.linearBreak = true
    check(rail.getChildCount() = 0 and foot.getChildCount() = 0 and video.width = 960, "linear ads remove graphics and restore the program")
    overlay.linearBreak = false
    cue.id = "bright-accent"
    cue.brand.accent = "#FF0000"
    pulse(overlay, cue, "hls")
    overlay.callFunc("handleCommerceKey", "ok", true)
    check(overlay.findNode("ilCommerceBuyBackground").color = "0xFFFFFFFF" and overlay.findNode("ilCommerceBuy").color = "0x202020FF", "a red brand retains a white primary action")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceChip0-0").getParent().color = "0x515151FF", "a selected secondary choice stays neutral for a red brand")
    check(overlay.findNode("ilCommerceBuy").text = "Add to cart" and overlay.findNode("ilCommerceBuyLeft").blendColor = "0xFFFFFFFF" and overlay.findNode("ilCommerceBuyRight").blendColor = "0xFFFFFFFF", "the complete Add to cart button is white for the red brand")
    key(overlay, "back")
    overlay.callFunc("handleCommerceKey", "back", true)
    cue.imageUrl = "https://ads.example/optional-art"
    for each mime in ["video/mp4", "image/gif", 42]
        cue.mimeType = mime
        pulse(overlay, cue, "hls")
        check(rail.findNode("background") <> invalid, "an invalid fallback MIME does not discard the scene")
    end for
    cue.scene = invalid
    pulse(overlay, cue, "hls")
    check(rail.getChildCount() = 0, "an invalid image-only cue is still rejected")
end sub

sub testMidroll(overlay, video)
    video.width = 720
    overlay.callFunc("attach", video, "game")
    overlay.commerceEnabled = true
    video.positionInfo = { epoch: 1, video: 1.5#, clip_id: 17 }
    cue = { id: "delivery-2", linearCreativeId: "creative-1", format: "midroll", start: 1000 }
    cue["end"] = 6000
    url = "https://shop.example/"
    cue.commerce = { title: "Tote", imageUrl: url + "tote.png", images: [url + "side.png", url + "ad.mp4", "file:///invalid"],
        vendor: "Tote Works", description: "Canvas carryall", previousPrice: "30.00", price: "18.00", currency: "USD", locale: "en",
        handoffUrl: url + "handoff", viewUrl: url + "view", variants: [
          {id: "black-s", label: "Black / S", availableForSale: false, selectedOptions: [{name:"Color", value:"Black"}, {name:"Size", value:"S"}]},
          {id: "black-l", label: "Black / L", selectedOptions: [{name:"Color", value:"Black"}, {name:"Size", value:"L"}]},
          {id: "brown-s", label: "Brown / S", imageUrl: url + "brown.png", price:"20.00", previousPrice:"25.00", selectedOptions: [{name:"Size", value:"S"}, {name:"Color", value:"Brown"}]},
          {id: "brown-xs", label: "Brown / XS", imageUrl: url + "brown.png", price:"20.00", selectedOptions: [{name:"Size", value:"XS"}, {name:"Color", value:"Brown"}]}] }
    program = { id: "other", format: "super", start: 1000, imageUrl: url + "overlay.png" }
    program["end"] = 6000
    overlay.callFunc("setTimeline", "game", [cue, program])
    check(overlay.findNode("ilPrimary").getChildCount() = 1 and not overlay.findNode("ilCommerce").visible, "midroll metadata cannot start a CTA during content")
    overlay.callFunc("setLinearAd", true, {creativeId:"creative-1", deliveryId:"delivery-1"})
    overlay.callFunc("setTimeline", "game", [program, cue])
    check(overlay.findNode("ilPrimary").getChildCount() = 0 and not overlay.findNode("ilCommerce").visible, "a different delivery of the same creative suppresses both companions and normal overlays")
    overlay.callFunc("setLinearAd", true, {creativeId:"wrong", deliveryId:"delivery-2"})
    overlay.callFunc("setTimeline", "game", [cue])
    check(not overlay.findNode("ilCommerce").visible, "the same delivery cannot bind to another creative")
    overlay.callFunc("setLinearAd", true, {creativeId:"creative-1", deliveryId:"delivery-2"})
    overlay.callFunc("setTimeline", "game", [program, cue])
    check(overlay.findNode("ilCommerce").visible and overlay.findNode("ilCommerceTrigger").text = "Buy", "the bound VAST delivery shows Buy with no cue image or MIME")
    check(overlay.findNode("ilPrimary").getChildCount() = 0 and video.width = 720, "midroll preserves the actual spot video")
    key(overlay, "ok")
    bg = overlay.findNode("ilCommerceBackground")
    layer = overlay.findNode("ilCommerce")
    check(bg.height * layer.scale[1] = video.height and abs(bg.width * layer.scale[0] / video.width - 0.42) < 0.001, "branded panel uses the full height and right forty percent of the video")
    check(overlay.findNode("ilCommerceDescription").visible and overlay.findNode("ilCommerceDescription").text = "Canvas carryall", "cover has actual catalog description")
    check(overlay.findNode("ilCommerceHeading").text = "Tote Works", "cover identifies the catalog vendor")
    check(not overlay.findNode("ilCommercePrevious").visible and overlay.findNode("ilCommercePrice").text = "USD 18.00 – USD 20.00", "the cover gives the available price range without an unrelated markdown")
    check(overlay.findNode("ilCommercePhoto").uri = url + "tote.png", "intro uses the catalog image")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceDescription").text = "Canvas carryall", "details display the product description")
    check(overlay.findNode("ilCommerceOption0").text = "Color" and overlay.findNode("ilCommerceOption1").text = "Size", "details display both real Shopify axes")
    key(overlay, "up")
    key(overlay, "ok")
    full = overlay.findNode("ilCommerceGalleryPhoto")
    check(bg.width * layer.scale[0] = video.width and bg.height * layer.scale[1] = video.height, "gallery fills the entire video viewport")
    check(layer.scale[0] = layer.scale[1] and layer.translation[0] = video.translation[0], "gallery uses uniform scaling on a translated 4:3 video")
    if full = invalid then return
    check(full.width * layer.scale[0] = video.width and full.height * layer.scale[1] = video.height and full.loadDisplayMode = "scaleToFit", "full-viewport product image preserves its aspect ratio")
    check(full.loadWidth >= video.width and full.loadHeight >= video.height, "enlargement requests a viewport-sized texture")
    key(overlay, "right")
    check(full.uri = url + "side.png", "gallery shows the next catalog photo")
    key(overlay, "ok")
    check(full.uri = url + "brown.png", "gallery skips video and unsafe URLs")
    key(overlay, "back")
    check(overlay.findNode("ilCommercePhoto").uri = url + "tote.png", "returning from gallery restores the selected product cover")
    key(overlay, "down")
    key(overlay, "right")
    key(overlay, "ok")
    check(overlay.findNode("ilCommercePhoto").uri = url + "brown.png" and overlay.findNode("ilCommercePrevious").text = "Was USD 25.00", "the selected SKU supplies its photo and original price")
    key(overlay, "left")
    key(overlay, "ok")
    check(overlay.findNode("ilCommercePhoto").uri = url + "tote.png", "an imageless SKU resets to the product cover")
    key(overlay, "right")
    key(overlay, "ok")
    check(overlay.findNode("ilCommercePrice").text = "USD 20.00", "choosing Brown resolves to the available Brown/S SKU")
    key(overlay, "up")
    key(overlay, "ok")
    check(full.uri = url + "brown.png", "enlargement starts on the chosen SKU photo")
    key(overlay, "right")
    key(overlay, "back")
    check(overlay.findNode("ilCommercePrice").text = "USD 20.00" and overlay.findNode("ilCommercePhoto").uri = url + "brown.png", "browsing photos preserves the chosen SKU")
    key(overlay, "ok")
    check(full.visible and full.uri = url + "brown.png", "Back returns focus to the detail opener and reopening uses its selected photo")
    key(overlay, "back")
    key(overlay, "down")
    key(overlay, "down")
    key(overlay, "left")
    key(overlay, "ok")
    check(overlay.findNode("ilCommercePhoto").uri = url + "brown.png", "another size that shares the image keeps the SKU photo")
    key(overlay, "right")
    key(overlay, "ok")
    key(overlay, "right")
    key(overlay, "ok")
    key(overlay, "down")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceSummary").text = "Brown / S · 1 item", "the unavailable Brown/L choice cannot fabricate a SKU")
    check(overlay.findNode("ilCommercePhoto").uri = url + "brown.png" and not overlay.findNode("ilCommerceQr").visible, "cart shows the selected photo before requesting a QR")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceQr").uri = url + "handoff/qr/brown-s.png", "midroll checkout preserves the actual selected SKU")
    check(overlay.findNode("ilCommercePhoto").uri = url + "brown.png" and overlay.findNode("ilCommerceStatus").text = "Scan to pay on Shopify", "QR summary shows the SKU and destination")
    check(overlay.impression.id <> cue.id, "VAST owns impressions throughout shopping")
    overlay.callFunc("setLinearAd", true, {creativeId:"creative-1", deliveryId:"delivery-3"})
    check(not overlay.findNode("ilCommerce").visible and overlay.findNode("ilCommerceQr").uri = "", "switching spots immediately clears an open QR")
    overlay.callFunc("setTimeline", "game", [cue])
    check(not overlay.findNode("ilCommerce").visible, "a delayed response for the previous spot cannot reopen it")
    overlay.callFunc("setLinearAd", false, invalid)
    check(not overlay.findNode("ilCommerce").visible, "ending a break releases the shopping flow")

    longName = string(512, "N")
    values = [string(512, "A"), string(512, "B"), string(512, "C")]
    label = string(506, "X") + values.join(" / ")
    cue.commerce.variants = [{ id: "long-options", label: label, selectedOptions: [
        {name: longName, value: values[0]}, {name: "Finish", value: values[1]}, {name: "Cut", value: values[2]}] }]
    overlay.callFunc("setLinearAd", true, {creativeId:"creative-1", deliveryId:"delivery-2"})
    overlay.callFunc("setTimeline", "game", [cue])
    key(overlay, "ok")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceOption0").text = longName and overlay.findNode("ilCommerceChip2-0").text = values[2], "three option axes retain 512-character names and values")
    key(overlay, "down")
    key(overlay, "down")
    key(overlay, "down")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceSummary").text = label + " · 1 item", "a 2048-character combined label remains available in the cart")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceQr").uri = url + "handoff/qr/long-options.png", "long option values retain their real checkout SKU")
    overlay.callFunc("setLinearAd", false, invalid)

    large = cue.commerce
    large.variants = []
    for i = 1 to 2048
        large.variants.push({id: "sku" + i.toStr(), label: "Label " + i.toStr()})
    end for
    overlay.callFunc("setLinearAd", true, {creativeId:"creative-1", deliveryId:"delivery-2"})
    cue.commerce = large
    overlay.callFunc("setTimeline", "game", [cue])
    key(overlay, "ok")
    key(overlay, "ok")
    key(overlay, "left")
    key(overlay, "ok")
    key(overlay, "down")
    key(overlay, "ok")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceQr").uri = url + "handoff/qr/sku2048.png", "the legacy list retains every one of 2048 real SKUs")
    overlay.linearBreak = false
    check(not overlay.findNode("ilCommerce").visible, "legacy break end also closes the shop")
    cue.imageUrl = url + "spot.mp4"
    cue.mimeType = "video/mp4"
    cue.commerce.imageUrl = url + "other.mp4"
    cue.commerce.images = []
    cue.commerce.variants = [{id: "no-stock", label: "Unavailable", availableForSale: false}]
    overlay.callFunc("setLinearAd", true, {creativeId:"creative-1", deliveryId:"delivery-2"})
    overlay.callFunc("setTimeline", "game", [cue])
    key(overlay, "ok")
    check(not overlay.findNode("ilCommercePhoto").visible, "neither a VAST MP4 nor a video catalog URL can become a product photo")
    key(overlay, "ok")
    key(overlay, "ok")
    check(overlay.findNode("ilCommerceBuy").text = "Out of stock" and not overlay.findNode("ilCommerceQr").visible, "an unavailable catalog has no checkout transition")
    video.positionInfo = { epoch: 1, video: 6#, clip_id: 17 }
    overlay.callFunc("setTimeline", "game", [cue])
    check(not overlay.findNode("ilCommerce").visible, "the midpoint shop expires with its exclusive cue end")
    overlay.callFunc("setLinearAd", false, invalid)
end sub

sub testUntypedScene(overlay, rail)
    cue = parseJson(readAsciiFile("pkg:/tests/creative-scene.json"))
    if cue = invalid then return
    ' JSON carries no schema. A field of the wrong type is ignored like any other unusable value.
    ' A device raises Type Mismatch on a mixed comparison and this interpreter does not, so these
    ' checks cover the rendered result and cannot show that failure.
    cue.layout = 3
    background = cue.scene.layers[0]
    background.action = 7
    background.binding = 7
    background.fit = false
    background.arrow = "yes"
    background.hidden = "no"
    headline = cue.scene.layers[2]
    headline["textAlign"] = 4
    headline.keyframes[0].easing = 9
    pulse(overlay, cue, "hls")
    check(rail.findNode("background") <> invalid and rail.findNode("headline") <> invalid, "fields of the wrong type do not discard the scene")
    cue.scene.format = 5
    pulse(overlay, cue, "hls")
    check(rail.getChildCount() = 0, "a scene whose format is not text is rejected")
end sub

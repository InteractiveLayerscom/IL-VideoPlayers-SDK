sub main()
    transfer = { escape: function(value)
        return value.replace(" ", "%20")
    end function }
    request = { url: "https://ads.example/shop?tag=channel&sid=old&commerce=1&shop_midroll=1&midroll_creative_id=wrong&midroll_delivery_id=old#unused",
        sessionId: "same sid", programTimeMs: 1500, commerce: true, locale: "es",
        linearSpot: { creativeId: "live creative", deliveryId: "delivery" } }
    base = "https://ads.example/shop?tag=channel&time=1500&sid=same%20sid&scene=1&scene_features=media-crop"
    expected = base + "&commerce=1&locale=es&shop_midroll=1&midroll_creative_id=live%20creative&midroll_delivery_id=delivery"
    if jsonFeedUrl(request, transfer) <> expected then return
    request.linearSpot.deliveryId = ""
    if jsonFeedUrl(request, transfer) <> base + "&commerce=1&locale=es" then return
    request.linearSpot.deliveryId = "delivery"
    request.commerce = false
    if jsonFeedUrl(request, transfer) <> base then return
    print "ROKU_FEED_OK 3"
end sub

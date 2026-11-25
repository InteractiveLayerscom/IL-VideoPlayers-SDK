Library "Roku_Ads.brs"

' The channel's own RAF break. Its tracking callback hands each ad to the render thread for adStarted/adEnded.
sub init()
    m.top.functionName = "play"
end sub

sub play()
    ads = Roku_Ads()
    ads.setTrackingCallback(track, m.top)
    ads.setAdUrl(m.top.tagUrl)
    pods = ads.getAds()
    if pods <> invalid
        if pods.count() > 0
            m.top.filled = true
            ads.showAds(pods, invalid, m.top.view)
        end if
    end if
    m.top.done = true
end sub

sub track(top as Object, eventType = "" as Dynamic, ctx = invalid as Dynamic)
    if eventType = "Impression" and type(ctx) = "roAssociativeArray"
        if type(ctx.ad) = "roAssociativeArray" then top.adStart = ctx.ad
    else if eventType = "Complete" or eventType = "Skip" or eventType = "Close" or eventType = "Error"
        top.adEnd = true
    end if
end sub

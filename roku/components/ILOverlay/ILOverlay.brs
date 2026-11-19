sub init()
    m.clock = m.top.findNode("ilClock")
    m.art = m.top.findNode("ilArt")
    m.primary = m.top.findNode("ilPrimary")
    m.secondary = m.top.findNode("ilSecondary")
    m.clock.observeFieldScoped("fire", "refresh")
    m.top.observeFieldScoped("visible", "refresh")
    m.top.observeFieldScoped("opacity", "refresh")
    initializeCommerce()
    m.polling = false
    m.cues = []
end sub

function attach(video as Dynamic, sessionId as String) as Boolean
    if getInterface(video, "ifSGNodeField") = invalid or sessionId = "" then return false
    if not video.hasField("positionInfo") or not video.hasField("state") then return false
    parent = m.top.getParent()
    videoParent = video.getParent()
    if parent = invalid or videoParent = invalid then return false
    if not parent.isSameNode(videoParent) then return false
    detach()
    if m.sessionId <> sessionId
        m.sessionId = sessionId
        m.seen = {}
        m.seen.setModeCaseSensitive()
        m.commerceViewed.clear()
    end if
    m.video = video
    m.content = video.content
    video.observeFieldScoped("state", "refresh")
    video.observeFieldScoped("visible", "refresh")
    video.observeFieldScoped("opacity", "refresh")
    video.observeFieldScoped("content", "onContentChanged")
    return true
end function

sub detach()
    if m.video <> invalid
        m.video.unobserveFieldScoped("state")
        m.video.unobserveFieldScoped("visible")
        m.video.unobserveFieldScoped("opacity")
        m.video.unobserveFieldScoped("content")
    end if
    setPolling(false)
    clearCreative()
    m.cues = []
    m.anchor = invalid
    m.video = invalid
    m.content = invalid
end sub

sub onContentChanged()
    if m.video = invalid then return
    current = m.video.content
    if m.content <> invalid
        if current = invalid
            detach()
            return
        end if
        if not current.isSameNode(m.content)
            detach()
            return
        end if
    end if
    m.content = current
end sub

function setTimeline(sessionId as String, items as Dynamic) as Boolean
    if m.video = invalid or m.sessionId <> sessionId or type(items) <> "roArray" then return false
    m.cues = normalizeTimeline(items)
    refresh()
    return true
end function

function setManifest(sessionId as String, playlist as String) as Boolean
    if m.video = invalid or m.sessionId <> sessionId then return false
    items = readMediaPlaylist(playlist)
    if items = invalid then return false
    return setTimeline(sessionId, items)
end function

function setClockAnchor(sessionId as String, anchor as Dynamic) as Boolean
    if m.video = invalid or m.sessionId <> sessionId then return false
    if anchor <> invalid and not isClockAnchor(anchor) then return false
    m.anchor = anchor
    refresh()
    return true
end function

function getProgramTimeMs() as Dynamic
    if m.video = invalid then return invalid
    return programTimeMs(m.video.positionInfo, m.anchor)
end function

sub setPolling(enabled as Boolean)
    if m.polling = enabled then return
    m.polling = enabled
    if enabled
        m.clock.control = "start"
    else
        m.clock.control = "stop"
    end if
end sub

sub onCommerceChanged()
    if m.panel = invalid then return
    clearCreative()
    refresh()
end sub

sub refresh()
    if m.video = invalid then return
    playing = m.video.state = "playing"
    presenting = (playing or m.video.state = "paused") and m.video.visible and m.top.visible and m.video.opacity > 0 and m.top.opacity > 0
    enabled = presenting and not m.top.linearBreak and not m.top.seeking and m.cues.count() > 0
    setPolling(enabled)
    if not enabled
        clearCreative()
        return
    end if

    nowMs = getProgramTimeMs()
    cue = activeCue(m.cues, nowMs)
    if cue = invalid
        clearCreative()
        return
    end if
    if cue.scene = invalid and ((cue.commerce <> invalid and not m.top.commerceEnabled) or not playing)
        clearCreative()
        return
    end if
    if m.active <> invalid
        if m.active.id <> cue.id or m.active.format <> cue.format or m.active.imageUrl <> cue.imageUrl or (m.active.scene = invalid) <> (cue.scene = invalid) then clearCreative()
    end if
    if m.active = invalid
        if not prepareCreative(cue) then return
    end if

    if cue.scene <> invalid
        presentScene(nowMs)
        return
    end if

    if m.first.loadStatus <> "ready"
        hideArtwork()
        return
    end if
    if m.second <> invalid
        if m.second.loadStatus <> "ready"
            hideArtwork()
            return
        end if
    end if
    applyArtworkTransform()
    if not m.art.visible
        if cue.format = "l"
            m.originalSize = [m.video.width, m.video.height]
            m.video.width = m.first.width * 0.75
            m.video.height = m.first.height * 0.75
        end if
        m.art.visible = true
        showCommerce()
        return
    end if
    if m.seen.doesExist(cue.id) or not rendered(m.first) then return
    if m.second <> invalid
        if not rendered(m.second) then return
    end if
    reportImpression(cue, nowMs)
end sub

sub reportImpression(cue as Object, nowMs as Double)
    if m.seen.doesExist(cue.id) then return
    event = { sessionId: m.sessionId, id: cue.id, format: cue.format, programTimeMs: nowMs }
    if cue.impressionUrl <> invalid then event.impressionUrl = cue.impressionUrl
    m.seen[cue.id] = true
    m.top.impression = event
end sub

function prepareCreative(cue as Object) as Boolean
    width = m.video.width
    height = m.video.height
    if width = 0 or height = 0
        scene = m.top.getScene()
        if scene = invalid then return false
        resolution = scene.currentDesignResolution
        if resolution = invalid then return false
        if width = 0 then width = resolution.width
        if height = 0 then height = resolution.height
    end if
    if width <= 0 or height <= 0 then return false
    m.active = cue
    m.commerceVideoWidth = width
    m.commerceVideoHeight = height
    if cue.scene <> invalid
        prepareScene(width, height)
        return true
    end if
    if cue.format = "overlay"
        m.primary.clippingRect = [0, 0, 0, 0]
        m.first = createPoster(m.primary, width * 0.30, height * 0.32, cue.imageUrl)
        m.first.translation = [width * 0.64, height * 0.10]
    else if cue.format = "super"
        m.primary.clippingRect = [0, 0, 0, 0]
        m.first = createPoster(m.primary, width * 0.75, height * 0.2, cue.imageUrl)
        m.first.translation = [width * 0.125, height * 0.7]
    else
        ' Clip the two visible pieces of the same full-canvas image. Even an
        ' opaque JPEG must leave the upper-left video plane unobstructed.
        m.primary.clippingRect = [width * 0.75, 0, width * 0.25, height]
        m.secondary.clippingRect = [0, height * 0.75, width * 0.75, height * 0.25]
        m.first = createPoster(m.primary, width, height, cue.imageUrl)
        m.second = createPoster(m.secondary, width, height, cue.imageUrl)
    end if
    return true
end function

function createPoster(parent as Object, width as Float, height as Float, uri as String, fit = "scaleToFill" as String, decodeScale = 1.0 as Float) as Object
    poster = parent.createChild("Poster")
    poster.width = width
    poster.height = height
    poster.loadWidth = width * decodeScale
    poster.loadHeight = height * decodeScale
    poster.loadDisplayMode = fit
    poster.enableRenderTracking = true
    poster.uri = uri
    return poster
end function

function rendered(poster as Object) as Boolean
    return poster.renderTracking = "partial" or poster.renderTracking = "full"
end function

sub hideArtwork()
    hideCommerce()
    m.art.visible = false
    if m.originalSize <> invalid
        m.video.width = m.originalSize[0]
        m.video.height = m.originalSize[1]
        m.originalSize = invalid
    end if
end sub

sub clearCreative()
    hideArtwork()
    clearScene()
    if m.first <> invalid then m.primary.removeChild(m.first)
    if m.second <> invalid then m.secondary.removeChild(m.second)
    m.first = invalid
    m.second = invalid
    m.active = invalid
end sub

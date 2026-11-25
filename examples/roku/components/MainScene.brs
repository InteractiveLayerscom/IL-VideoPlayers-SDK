' Two ways to use ILAdPlanPlayer:
'   mode "load": the component asks the console for the plan and plays its breaks with RAF.
'   mode "host": this channel plays its own breaks through the relay (IL's per-break API) and reports them.
sub init()
    m.video = m.top.findNode("video")
    m.status = m.top.findNode("status")
    m.overlay = m.top.createChild("ILOverlay")
    m.overlay.commerceEnabled = true
    m.player = m.top.createChild("ILAdPlanPlayer")
    m.player.observeFieldScoped("event", "onPlanEvent")
    m.player.observeFieldScoped("contentReady", "onContentReady")
    m.breaks = []
    m.played = {}
end sub

sub start()
    config = m.top.config
    content = createObject("roSGNode", "ContentNode")
    content.url = config.contentUrl
    content.streamFormat = "hls"
    m.video.content = content
    m.viewId = "view-" + createObject("roDeviceInfo").getRandomUUID()
    if config.mode = "host"
        startHost(config)
    else
        m.overlay.callFunc("attach", m.video, m.viewId)
        m.player.callFunc("loadPlan", m.overlay, m.video, m.viewId, config.consoleOrigin, config.project, config.asset, "es")
    end if
end sub

sub onContentReady()
    if m.player.contentReady then m.video.control = "play"
end sub

sub onPlanEvent()
    event = m.player.event
    ' plan_unavailable carries the exact app= value sent: a 404 usually means it is not registered in the Console.
    m.status.text = formatJson(event)
end sub

' --- Host-driven mode -------------------------------------------------------------------------------------------

sub startHost(config as Object)
    m.relay = createObject("roSGNode", "RelayTask")
    m.relay.observeFieldScoped("response", "onRelay")
    relay("playback", "/playback", { asset: config.asset })
end sub

sub relay(kind as String, path as String, body as Object)
    m.relay.request = { kind: kind, url: m.top.config.relayUrl + path, body: body }
    m.relay.control = "run"
end sub

sub onRelay()
    answer = m.relay.response
    if answer.kind = "playback"
        startHostPlayback(answer.body)
    else if answer.kind = "break" or answer.kind = "next"
        playHostBreak(answer.body)
    end if
end sub

sub startHostPlayback(body as Dynamic)
    if type(body) <> "roAssociativeArray" then body = {}
    m.playbackId = body.playback_id
    plan = body.plan
    ' The plan's commerce.session is the sid inside every stable ad_tag_url: keying the view with it enables Buy.
    key = m.viewId
    if type(plan) = "roAssociativeArray"
        if type(plan.commerce) = "roAssociativeArray" and plan.commerce.session <> invalid then key = plan.commerce.session
    end if
    m.overlay.callFunc("attach", m.video, key)
    if plan <> invalid and m.player.callFunc("attachPlan", m.overlay, m.video, key, plan, m.top.config.consoleOrigin, "es")
        cues = []
        for each seconds in m.top.config.breaks
            m.breaks.push(seconds)
            cues.push(seconds * 1000)
        end for
        m.player.callFunc("setBreaks", cues)
        m.player.callFunc("startPlan")
    else
        m.video.control = "play"
    end if
    m.video.observeFieldScoped("position", "onPosition")
end sub

sub onPosition()
    if m.inBreak = true then return
    for each seconds in m.breaks
        if not m.played.doesExist(seconds.toStr()) and m.video.position >= seconds
            m.played[seconds.toStr()] = true
            m.inBreak = true
            m.resumeAt = m.video.position
            m.breakMs = seconds * 1000
            m.video.control = "stop"
            m.player.callFunc("breakStarted", m.breakMs)
            relay("break", "/break", { playback_id: m.playbackId, cue_seconds: seconds })
            return
        end if
    end for
end sub

sub playHostBreak(body as Dynamic)
    tag = invalid
    if type(body) = "roAssociativeArray" then tag = body.ad_tag_url
    if tag = invalid
        endHostBreak()
        return
    end if
    m.step = body
    m.ads = createObject("roSGNode", "HostAdTask")
    m.ads.tagUrl = tag
    m.ads.view = m.top
    m.ads.observeFieldScoped("adStart", "onHostAdStart")
    m.ads.observeFieldScoped("adEnd", "onHostAdEnd")
    m.ads.observeFieldScoped("done", "onHostAdsDone")
    m.ads.control = "run"
end sub

sub onHostAdStart()
    ' The RAF ad object straight from this channel's own tracking callback.
    m.player.callFunc("adStarted", m.ads.tagUrl, m.ads.adStart)
end sub

sub onHostAdEnd()
    m.player.callFunc("adEnded")
end sub

' A stable tag without an ad: ask the next step of this break, exactly as the per-break API says.
sub onHostAdsDone()
    if not m.ads.filled and m.step.steps_left <> invalid and m.step.steps_left > 0
        relay("next", "/break/next", { playback_id: m.playbackId, cue_seconds: m.breakMs / 1000, after_step: m.step.step })
        return
    end if
    endHostBreak()
end sub

sub endHostBreak()
    m.player.callFunc("breakEnded")
    m.inBreak = false
    m.video.seek = m.resumeAt
    m.video.control = "play"
end sub

Library "Roku_Ads.brs"

sub init()
    m.top.functionName = "playBreak"
end sub

sub playBreak()
    m.top.result = { type: adPlanRunBreak(m.top.requests, Roku_Ads(), m.top.view, m.top) }
end sub

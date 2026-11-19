sub init()
    m.top.functionName = "readFeed"
end sub

sub readFeed()
    request = m.top.request
    if request = invalid then return
    if type(request.url) <> "String" and type(request.url) <> "roString" then return
    if lcase(left(request.url, 8)) <> "https://" then return

    transfer = createObject("roUrlTransfer")
    port = createObject("roMessagePort")
    transfer.setMessagePort(port)
    transfer.setCertificatesFile("common:/certs/ca-bundle.crt")
    url = request.url
    if request.kind = "json"
        if request.programTimeMs = invalid then return
        mediaTime& = request.programTimeMs
        url = url.split("#")[0]
        separator = "?"
        if instr(1, url, "?") > 0 then separator = "&"
        url = url + separator + "time=" + mediaTime&.toStr() + "&sid=" + transfer.escape(request.sessionId)
    end if
    transfer.setUrl(url)
    response = { sessionId: request.sessionId, revision: request.revision, status: 0, kind: request.kind }
    if transfer.asyncGetToString()
        message = wait(8000, port)
        if type(message) = "roUrlEvent"
            response.status = message.getResponseCode()
            if response.status >= 200 and response.status < 300
                response.body = message.getString()
            end if
        else
            transfer.asyncCancel()
        end if
    end if
    m.top.result = response
end sub

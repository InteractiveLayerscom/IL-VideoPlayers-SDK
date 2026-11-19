sub init()
    m.top.functionName = "readFeed"
end sub

sub readFeed()
    request = m.top.request
    if request = invalid then return
    if type(request.url) <> "String" and type(request.url) <> "roString" then return
    https = createObject("roRegex", "^https://([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(:[0-9]+)?([/?#][^\s]*)?$", "i")
    if not https.isMatch(request.url) then return

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
        if request.commerce = true
            locale = "en"
            if type(request.locale) = "String" or type(request.locale) = "roString"
                language = lcase(request.locale).split("-")[0]
                if language = "es" then locale = "es"
                if language = "pt" then locale = "pt-BR"
            end if
            url = url + "&commerce=1&locale=" + transfer.escape(locale)
            country = createObject("roRegex", "^[A-Z]{2}$", "")
            if type(request.country) = "String" or type(request.country) = "roString"
                if country.isMatch(request.country) then url = url + "&country=" + request.country
            end if
        end if
    end if
    transfer.setUrl(url)
    response = { sessionId: request.sessionId, revision: request.revision, status: 0, kind: request.kind }
    started = false
    if request.kind = "commerce"
        transfer.addHeader("Content-Type", "application/json")
        started = transfer.asyncPostFromString(formatJson({ variantId: request.variantId }))
    else
        started = transfer.asyncGetToString()
    end if
    if started
        message = wait(8000, port)
        if type(message) = "roUrlEvent"
            response.status = message.getResponseCode()
            if response.status >= 200 and response.status < 300
                body = message.getString()
                if request.kind <> "commerce" or len(body) <= 16384 then response.body = body
            end if
        else
            transfer.asyncCancel()
        end if
    end if
    m.top.result = response
end sub

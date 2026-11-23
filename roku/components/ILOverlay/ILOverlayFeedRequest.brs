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
        url = jsonFeedUrl(request, transfer)
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
        limit = 8000
        if type(request.timeoutMs) = "Integer" or type(request.timeoutMs) = "roInt" or type(request.timeoutMs) = "roInteger" then limit = request.timeoutMs
        message = wait(limit, port)
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

function jsonFeedUrl(request as Object, transfer as Object) as String
    mediaTime& = request.programTimeMs
    url = withoutSessionParameters(request.url)
    separator = "?"
    if instr(1, url, "?") > 0 then separator = "&"
    url = url + separator + "time=" + mediaTime&.toStr() + "&sid=" + transfer.escape(request.sessionId) + "&scene=1&scene_features=media-crop"
    if request.commerce = true
        locale = "en"
        if type(request.locale) = "String" or type(request.locale) = "roString"
            language = lcase(request.locale).split("-")[0]
            if language = "es" then locale = "es"
            if language = "pt" then locale = "pt-BR"
        end if
        url = url + "&commerce=1&locale=" + transfer.escape(locale)
        spot = request.linearSpot
        if type(spot) = "roAssociativeArray"
            if feedSpotId(spot.creativeId) and feedSpotId(spot.deliveryId)
                url += "&shop_midroll=1&midroll_creative_id=" + transfer.escape(spot.creativeId)
                url += "&midroll_delivery_id=" + transfer.escape(spot.deliveryId)
            end if
        end if
        country = createObject("roRegex", "^[A-Z]{2}$", "")
        if type(request.country) = "String" or type(request.country) = "roString"
            if country.isMatch(request.country) then url = url + "&country=" + request.country
        end if
    end if
    return url
end function

function feedSpotId(id as Dynamic) as Boolean
    if type(id) <> "String" and type(id) <> "roString" then return false
    return id.trim() <> "" and len(id) <= 256
end function

function withoutSessionParameters(url as String) as String
    url = url.split("#")[0]
    marker = instr(1, url, "?")
    if marker = 0 then return url
    parameters = []
    owned = { time: true, sid: true, scene: true, scene_features: true, commerce: true, locale: true, country: true, shop_midroll: true, midroll_creative_id: true, midroll_delivery_id: true }
    for each pair in mid(url, marker + 1).split("&")
        key = pair.split("=")[0]
        if pair <> "" and not owned.doesExist(key)
            parameters.push(pair)
        end if
    end for
    url = left(url, marker - 1)
    if parameters.count() > 0 then url = url + "?" + parameters.join("&")
    return url
end function

' POSTs JSON to the example relay. The API key lives only in the relay's environment, never in the channel.
sub init()
    m.top.functionName = "post"
end sub

sub post()
    request = m.top.request
    transfer = createObject("roUrlTransfer")
    port = createObject("roMessagePort")
    transfer.setMessagePort(port)
    transfer.setCertificatesFile("common:/certs/ca-bundle.crt")
    transfer.setUrl(request.url)
    transfer.addHeader("Content-Type", "application/json")
    body = invalid
    if transfer.asyncPostFromString(formatJson(request.body))
        message = wait(8000, port)
        if type(message) = "roUrlEvent"
            if message.getResponseCode() = 200 or message.getResponseCode() = 201 then body = parseJson(message.getString())
        else
            transfer.asyncCancel()
        end if
    end if
    m.top.response = { kind: request.kind, body: body }
end sub

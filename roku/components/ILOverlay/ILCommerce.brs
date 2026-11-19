function commerceText(value as Dynamic, limit as Integer) as Boolean
    if not isText(value) then return false
    return len(value) <= limit and value.trim() <> ""
end function

function commercePrice(value as Dynamic) as Dynamic
    if isNumber(value) then value = value.toStr()
    if not isText(value) then return invalid
    decimal = createObject("roRegex", "^\d{1,12}(\.\d{1,6})?$", "")
    if decimal.isMatch(value) then return value
    return invalid
end function

function commerceLocale(value as Dynamic) as String
    if isText(value)
        base = lcase(value).split("-")[0]
        if base = "es" then return "es"
        if base = "pt" then return "pt-BR"
    end if
    return "en"
end function

function normalizeCommerce(item as Dynamic, https as Object) as Dynamic
    if type(item) <> "roAssociativeArray" then return invalid
    if not commerceText(item.title, 256) or not commerceText(item.currency, 3) then return invalid
    currency = createObject("roRegex", "^[A-Z]{3}$", "")
    if not currency.isMatch(item.currency) then return invalid
    if not commerceText(item.handoffUrl, 4096) then return invalid
    if not https.isMatch(item.handoffUrl) then return invalid
    price = commercePrice(item.price)
    if price = invalid or type(item.variants) <> "roArray" then return invalid
    if item.variants.count() < 1 or item.variants.count() > 100 then return invalid
    result = { title: item.title, currency: item.currency, locale: commerceLocale(item.locale),
               handoffUrl: item.handoffUrl, price: price, variants: [] }
    ids = {}
    ids.setModeCaseSensitive()
    for each variant in item.variants
        if type(variant) <> "roAssociativeArray" then return invalid
        if not commerceText(variant.id, 128) or not commerceText(variant.label, 160) then return invalid
        if ids.doesExist(variant.id) then return invalid
        variantPrice = price
        if variant.price <> invalid then variantPrice = commercePrice(variant.price)
        if variantPrice = invalid then return invalid
        ids[variant.id] = true
        result.variants.push({ id: variant.id, label: variant.label, price: variantPrice })
    end for
    if commerceText(item.viewUrl, 4096)
        if https.isMatch(item.viewUrl) then result.viewUrl = item.viewUrl
    end if
    return result
end function

function commerceCopy(locale as String) as Object
    if locale = "es"
        return ["OK · Ver producto", "Mostrar código QR", "Cerrar", "Escaneá el código con tu celular",
                "Preparando tu carrito…", "No se pudo preparar el carrito. Intentá de nuevo."]
    else if locale = "pt-BR"
        return ["OK · Ver produto", "Mostrar código QR", "Fechar", "Escaneie com seu celular",
                "Preparando seu carrinho…", "Não foi possível preparar o carrinho. Tente novamente."]
    end if
    return ["OK · View product", "Show QR code", "Close", "Scan with your phone", "Preparing your cart…",
            "Could not prepare the cart. Try again."]
end function

sub initializeCommerce()
    m.panel = m.top.findNode("ilCommerce")
    m.panelBackground = m.top.findNode("ilCommerceBackground")
    m.panelName = m.top.findNode("ilCommerceName")
    m.panelBuy = m.top.findNode("ilCommerceBuy")
    m.panelClose = m.top.findNode("ilCommerceClose")
    m.panelVariant = m.top.findNode("ilCommerceVariant")
    m.panelStatus = m.top.findNode("ilCommerceStatus")
    m.panelQr = m.top.findNode("ilCommerceQr")
    m.panelLogo = m.top.findNode("ilCommerceLogo")
    m.panelPhoto = m.top.findNode("ilCommercePhoto")
    m.panelQr.observeFieldScoped("loadStatus", "onQrLoad")
    m.commerceHTTPS = createObject("roRegex", "^https://([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(:[0-9]+)?([/?#][^\s]*)?$", "i")
    m.commerceViewed = {}
    m.commerceViewed.setModeCaseSensitive()
    m.cartRevision = 0
end sub

function previousFocusedNode() as Dynamic
    node = m.top.getParent()
    if node = invalid then return invalid
    while node.focusedChild <> invalid
        child = node.focusedChild
        if child.isSameNode(node) then exit while
        node = child
    end while
    return node
end function

function currentOffer() as Dynamic
    if m.active = invalid then return invalid
    if m.active.scene <> invalid then return m.scenePanelOffer
    return m.active.commerce
end function

sub showCommerce()
    offer = currentOffer()
    if offer = invalid or m.panel.visible then return
    m.commerceOpen = false
    m.commerceChoice = 0
    m.commerceRow = 0
    m.commerceLabels = commerceCopy(offer.locale)
    m.commerceMessage = ""
    m.panel.visible = true
    renderCommerce()
    if m.top.commerceAutoFocus and not m.top.hasFocus()
        m.previousCommerceFocus = previousFocusedNode()
        m.top.setFocus(true)
    end if
end sub

sub hideCommerce()
    if m.panel.visible
        cancelCart()
        m.panel.visible = false
        m.panelPhoto.uri = ""
        m.panelLogo.uri = ""
        m.panelLogo.visible = false
    end if
    m.scenePanelOffer = invalid
    if m.top.commerceAutoFocus and m.top.hasFocus()
        if m.previousCommerceFocus <> invalid
            m.previousCommerceFocus.setFocus(true)
        else if m.video <> invalid
            m.video.setFocus(true)
        end if
    end if
    m.previousCommerceFocus = invalid
end sub

sub cancelCart()
    m.cartRevision += 1
    if m.cartTask <> invalid
        m.cartTask.unobserveFieldScoped("result")
        m.cartTask.control = "stop"
        m.cartTask = invalid
    end if
    m.panelQr.visible = false
    m.panelQr.uri = ""
    m.commerceMessage = ""
end sub

sub renderCommerce()
    offer = currentOffer()
    if offer = invalid or not m.panel.visible then return
    width = m.commerceVideoWidth * 0.48
    row = m.commerceVideoHeight * 0.071
    margin = m.commerceVideoWidth * 0.016
    qrSize = m.commerceVideoHeight * 0.30
    offset = row * 1.2
    panelHeight = row * 1.1
    if m.commerceOpen
        panelHeight = row * 5.2
        if m.panelQr.visible then panelHeight += qrSize
    end if
    x = m.commerceVideoWidth * 0.94 - width
    y = m.commerceVideoHeight * 0.94 - panelHeight
    m.panel.translation = [m.video.translation[0] + x, m.video.translation[1] + y]
    m.panelBackground.width = width
    m.panelBackground.height = panelHeight
    foreground = "#ffffff"
    accent = "#7de4ff"
    background = "#101929"
    logoUrl = ""
    if m.active.brand <> invalid
        foreground = sceneColor(m.active.brand.foreground, foreground)
        accent = sceneColor(m.active.brand.accent, accent)
        background = sceneColor(m.active.brand.background, background)
        if isText(m.active.brand.logoUrl)
            if m.commerceHTTPS.isMatch(m.active.brand.logoUrl) then logoUrl = m.active.brand.logoUrl
        end if
    end if
    m.panelBackground.color = background
    m.panelLogo.width = row * 1.3
    m.panelLogo.height = row
    m.panelLogo.translation = [width - margin - m.panelLogo.width, row * 0.1]
    if m.panelLogo.uri <> logoUrl then m.panelLogo.uri = logoUrl
    m.panelLogo.visible = m.commerceOpen and logoUrl <> ""
    m.panelName.translation = [margin, row * 0.1]
    m.panelName.width = width - margin * 2
    m.panelName.text = m.commerceLabels[0]
    m.panelName.color = foreground
    m.panelBuy.visible = m.commerceOpen
    m.panelVariant.visible = m.commerceOpen
    m.panelClose.visible = m.commerceOpen
    m.panelPhoto.visible = m.commerceOpen
    m.panelStatus.visible = m.commerceOpen and m.commerceMessage <> ""
    if not m.commerceOpen then return

    m.panelPhoto.width = row
    m.panelPhoto.height = row
    m.panelPhoto.translation = [margin, row * 0.1]
    url = m.active.imageUrl
    if offer.imageUrl <> invalid then url = offer.imageUrl
    if m.panelPhoto.uri <> url then m.panelPhoto.uri = url
    m.panelName.translation = [margin + row * 1.2, row * 0.1]
    m.panelName.width = width - margin * 2 - row * 1.2
    if m.panelLogo.visible then m.panelName.width -= m.panelLogo.width + margin
    m.panelName.text = offer.title
    variant = offer.variants[m.commerceChoice]
    indicator = ""
    if offer.variants.count() > 1 then indicator = "‹ "
    amount = variant.price
    if offer.locale <> "en" then amount = amount.replace(".", ",")
    m.panelVariant.text = indicator + variant.label + " · " + offer.currency + " " + amount
    m.panelBuy.text = m.commerceLabels[1]
    m.panelClose.text = m.commerceLabels[2]
    m.panelStatus.text = m.commerceMessage
    m.panelStatus.color = foreground
    m.panelStatus.width = width - margin * 2
    controls = [m.panelVariant, m.panelBuy, m.panelClose]
    for i = 0 to controls.count() - 1
        controls[i].translation = [margin, offset + row * i]
        controls[i].width = width - margin * 2
        controls[i].color = foreground
        if i = m.commerceRow then controls[i].color = accent
    end for
    m.panelStatus.translation = [margin, offset + row * 3]
    m.panelQr.translation = [margin, offset + row * 3.8]
    m.panelQr.width = qrSize
    m.panelQr.height = qrSize
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    return handleCommerceKey(key, press)
end function

function handleCommerceKey(key as String, press as Boolean) as Boolean
    if not press then return false
    key = lcase(key)
    if not m.panel.visible
        if m.active = invalid or not m.art.visible then return false
        if m.active.scene <> invalid then return handleSceneKey(key)
        return false
    end if
    if not m.commerceOpen
        if key <> "ok" then return false
        m.commerceOpen = true
        m.commerceRow = 0
        trackProductView()
        renderCommerce()
        return true
    end if
    if key = "back" or (key = "ok" and m.commerceRow = 2)
        cancelCart()
        m.commerceOpen = false
        if m.scenePanelOffer <> invalid
            m.scenePanelOffer = invalid
            m.panel.visible = false
            m.panelPhoto.uri = ""
            m.panelLogo.uri = ""
            updateSceneFocus()
            return true
        end if
    else if key = "up" or key = "down"
        increment = 1
        if key = "up" then increment = 2
        m.commerceRow = (m.commerceRow + increment) mod 3
    else if (key = "left" or key = "right" or key = "ok") and m.commerceRow = 0
        total = currentOffer().variants.count()
        increment = 1
        if key = "left" then increment = total - 1
        m.commerceChoice = (m.commerceChoice + increment) mod total
        cancelCart()
    else if key = "ok" and m.commerceRow = 1
        prepareCart()
    else
        return false
    end if
    renderCommerce()
    return true
end function

sub trackProductView()
    cue = m.active
    offer = currentOffer()
    url = offer.viewUrl
    key = cue.id
    if offer.id <> invalid then key += chr(0) + offer.id
    if url = invalid or m.commerceViewed.doesExist(key) then return
    m.commerceViewed[key] = true
    ' The host posts this beacon alongside its existing impression handler.
    m.top.productView = { id: cue.id, sessionId: m.sessionId, viewUrl: url }
end sub

sub prepareCart()
    if m.cartTask <> invalid then return
    cancelCart()
    variant = currentOffer().variants[m.commerceChoice]
    task = createObject("roSGNode", "ILOverlayFeedRequest")
    if task = invalid
        m.commerceMessage = m.commerceLabels[5]
        return
    end if
    m.commerceMessage = m.commerceLabels[4]
    m.cartTask = task
    task.observeFieldScoped("result", "receiveCart")
    task.request = { sessionId: m.sessionId, revision: m.cartRevision, kind: "commerce",
                     url: currentOffer().handoffUrl, variantId: variant.id }
    task.control = "run"
end sub

sub receiveCart()
    if m.cartTask = invalid then return
    result = m.cartTask.result
    if result = invalid or result.sessionId <> m.sessionId or result.revision <> m.cartRevision then return
    m.cartTask.unobserveFieldScoped("result")
    m.cartTask = invalid
    m.commerceMessage = m.commerceLabels[5]
    if result.status >= 200 and result.status < 300 and isText(result.body)
        answer = parseJson(result.body)
        if type(answer) = "roAssociativeArray"
            if isText(answer.continueUrl) and isText(answer.qrImageUrl)
                if m.commerceHTTPS.isMatch(answer.continueUrl) and m.commerceHTTPS.isMatch(answer.qrImageUrl)
                    m.panelQr.uri = answer.qrImageUrl
                    m.panelQr.visible = true
                    m.commerceMessage = m.commerceLabels[3]
                end if
            end if
        end if
    end if
    renderCommerce()
end sub

sub onQrLoad()
    if m.panelQr.visible and m.panelQr.loadStatus = "failed"
        m.panelQr.visible = false
        m.commerceMessage = m.commerceLabels[5]
        renderCommerce()
    end if
end sub

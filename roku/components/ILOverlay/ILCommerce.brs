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
        return { trigger: "OK · Ver producto", heading: "Producto", variant: "Variante", buy: "Comprar", close: "Cerrar",
            scan: "Escaneá el código con tu celular", preparing: "Preparando tu carrito…", failed: "No se pudo preparar el carrito. Intentá de nuevo." }
    else if locale = "pt-BR"
        return { trigger: "OK · Ver produto", heading: "Produto", variant: "Variante", buy: "Comprar", close: "Fechar",
            scan: "Escaneie com seu celular", preparing: "Preparando seu carrinho…", failed: "Não foi possível preparar o carrinho. Tente novamente." }
    end if
    return { trigger: "OK · View product", heading: "Product", variant: "Variant", buy: "Buy", close: "Close",
        scan: "Scan with your phone", preparing: "Preparing your cart…", failed: "Could not prepare the cart. Try again." }
end function

sub initializeCommerce()
    m.panel = m.top.findNode("ilCommerce")
    m.panelBackground = m.top.findNode("ilCommerceBackground")
    m.panelDetail = m.top.findNode("ilCommerceDetail")
    m.panelTrigger = m.top.findNode("ilCommerceTrigger")
    m.panelHeading = m.top.findNode("ilCommerceHeading")
    m.panelName = m.top.findNode("ilCommerceName")
    m.panelPrice = m.top.findNode("ilCommercePrice")
    m.panelBuy = m.top.findNode("ilCommerceBuy")
    m.panelBuyBackground = m.top.findNode("ilCommerceBuyBackground")
    m.panelClose = m.top.findNode("ilCommerceClose")
    m.panelVariant = m.top.findNode("ilCommerceVariant")
    m.panelRange = m.top.findNode("ilCommerceRange")
    m.panelStatus = m.top.findNode("ilCommerceStatus")
    m.panelQr = m.top.findNode("ilCommerceQr")
    m.panelLogo = m.top.findNode("ilCommerceLogo")
    m.panelPhoto = m.top.findNode("ilCommercePhoto")
    m.closeFocus = sceneOutline(m.panelClose, 116, 38, 3, "0xFFFFFFFF")
    m.buyFocus = sceneOutline(m.panelDetail, 428, 66, 3, "0xFFFFFFFF")
    m.buyFocus.translation = [16, 328]

    chipRow = m.top.findNode("ilCommerceChips")
    chipFont = createObject("roSGNode", "Font")
    chipFont.uri = "font:SystemFontFile"
    chipFont.size = 20
    m.panelChips = []
    for slot = 0 to 2
        tile = chipRow.createChild("Rectangle")
        tile.translation = [slot * 142, 0]
        tile.width = 132
        tile.height = 54
        label = tile.createChild("Label")
        label.id = "ilCommerceChipLabel" + slot.toStr()
        label.translation = [6, 0]
        label.width = 120
        label.height = 54
        label.font = chipFont
        label.horizAlign = "center"
        label.vertAlign = "center"
        label.wrap = true
        label.maxLines = 2
        label.ellipsizeOnBoundary = true
        outline = sceneOutline(tile, 132, 54, 3, "0xFFFFFFFF")
        m.panelChips.push({ tile: tile, label: label, outline: outline })
    end for
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
    m.commerceFocus = 0
    m.commerceWindow = 0
    ' Rows follow the remote's vertical cycle: variants, Buy, Close.
    m.commerceRow = 0
    m.commerceLabels = commerceCopy(offer.locale)
    m.commerceMessage = ""
    m.panelTrigger.text = m.commerceLabels.trigger
    m.panelHeading.text = m.commerceLabels.heading
    m.panelVariant.text = m.commerceLabels.variant
    m.panelBuy.text = m.commerceLabels.buy
    m.panelClose.text = m.commerceLabels.close
    m.panelName.text = offer.title
    applyCommerceBrand()
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

function commerceColor(value as Dynamic, fallback as String) as String
    hex = mid(sceneColor(value, fallback), 2)
    if hex = "" then return ""
    if len(hex) = 6 then hex += "FF"
    return "0x" + hex
end function

function linearCommerceChannel(hex as String) as Float
    value = val(hex, 16) / 255.0
    if value <= 0.04045 then return value / 12.92
    return ((value + 0.055) / 1.055) ^ 2.4
end function

sub applyCommerceBrand()
    brand = m.active.brand
    if brand = invalid then brand = {}
    m.panelBackground.color = commerceColor(brand.background, "#202020")
    foreground = commerceColor(brand.foreground, "#FFFFFF")
    for each label in [m.panelTrigger, m.panelHeading, m.panelClose, m.panelName, m.panelPrice, m.panelVariant, m.panelRange, m.panelStatus]
        label.color = foreground
    end for
    m.panelBuyBackground.color = "0xF0F0F0FF"
    m.panelBuy.color = "0x202020FF"
    m.chipSelectedColor = "0x515151FF"
    m.chipSelectedText = "0xFFFFFFFF"
    accent = commerceColor(brand.accent, "")
    if accent <> ""
        red = linearCommerceChannel(mid(accent, 3, 2))
        green = linearCommerceChannel(mid(accent, 5, 2))
        blue = linearCommerceChannel(mid(accent, 7, 2))
        luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        if luminance > 0.179 then m.chipSelectedText = "0x000000FF"
        m.chipSelectedColor = accent
        m.panelBuyBackground.color = accent
        m.panelBuy.color = m.chipSelectedText
    end if
    logoUrl = ""
    if isText(brand.logoUrl)
        if m.commerceHTTPS.isMatch(brand.logoUrl) then logoUrl = brand.logoUrl
    end if
    m.panelLogo.uri = logoUrl
    m.panelLogo.visible = logoUrl <> ""
end sub

sub renderCommerce()
    offer = currentOffer()
    if offer = invalid or not m.panel.visible then return
    m.panelTrigger.visible = not m.commerceOpen
    m.panelDetail.visible = m.commerceOpen
    ' Layout uses a 720p reference surface, including the QR image and its quiet zone.
    scale = m.commerceVideoHeight / 720
    if scale * 460 > m.commerceVideoWidth * 0.88 then scale = m.commerceVideoWidth * 0.88 / 460
    width = m.panelTrigger.width
    height = m.panelTrigger.height
    y = m.commerceVideoHeight * 0.94 - height * scale
    if m.commerceOpen
        width = 460
        height = 410
        if m.commerceMessage <> "" then height = 494
        if m.panelQr.visible then height = 612
        y = (m.commerceVideoHeight - height * scale) / 2
    end if
    x = m.commerceVideoWidth * 0.94 - width * scale
    m.panel.translation = [m.video.translation[0] + x, m.video.translation[1] + y]
    m.panel.scale = [scale, scale]
    m.panelBackground.width = width
    m.panelBackground.height = height
    if not m.commerceOpen then return

    url = m.active.imageUrl
    if offer.imageUrl <> invalid then url = offer.imageUrl
    if m.panelPhoto.uri <> url then m.panelPhoto.uri = url
    amount = offer.variants[m.commerceChoice].price
    if offer.locale <> "en" then amount = amount.replace(".", ",")
    m.panelPrice.text = offer.currency + " " + amount
    m.closeFocus.visible = m.commerceRow = 2
    m.buyFocus.visible = m.commerceRow = 1
    renderCommerceChips(offer.variants)
    m.panelStatus.visible = m.commerceMessage <> ""
    m.panelStatus.text = m.commerceMessage
    if m.panelQr.visible
        m.panelQr.translation = [22, 406]
        m.panelStatus.translation = [224, 406]
        m.panelStatus.width = 214
        m.panelStatus.height = 184
    else
        m.panelStatus.translation = [22, 400]
        m.panelStatus.width = 416
        m.panelStatus.height = 78
    end if
end sub

sub renderCommerceChips(variants as Object)
    slots = m.panelChips.count()
    if m.commerceFocus < m.commerceWindow then m.commerceWindow = m.commerceFocus
    if m.commerceFocus >= m.commerceWindow + slots then m.commerceWindow = m.commerceFocus - slots + 1
    for slot = 0 to slots - 1
        index = m.commerceWindow + slot
        chip = m.panelChips[slot]
        chip.tile.visible = index < variants.count()
        if chip.tile.visible
            chip.label.text = variants[index].label
            chip.tile.color = "0x303030FF"
            chip.label.color = "0xFFFFFFFF"
            if index = m.commerceChoice
                chip.tile.color = m.chipSelectedColor
                chip.label.color = m.chipSelectedText
            end if
            chip.outline.visible = m.commerceRow = 0 and index = m.commerceFocus
        end if
    end for
    m.panelRange.visible = variants.count() > slots
    if m.panelRange.visible
        first = m.commerceWindow + 1
        last = m.commerceWindow + slots
        m.panelRange.text = first.toStr() + "–" + last.toStr() + " / " + variants.count().toStr()
    end if
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
        m.commerceFocus = m.commerceChoice
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
    else if (key = "left" or key = "right") and m.commerceRow = 0
        total = currentOffer().variants.count()
        increment = 1
        if key = "left" then increment = total - 1
        m.commerceFocus = (m.commerceFocus + increment) mod total
    else if key = "ok" and m.commerceRow = 0
        if m.commerceChoice <> m.commerceFocus
            m.commerceChoice = m.commerceFocus
            cancelCart()
        end if
        m.commerceRow = 1
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
        m.commerceMessage = m.commerceLabels.failed
        return
    end if
    m.commerceMessage = m.commerceLabels.preparing
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
    m.commerceMessage = m.commerceLabels.failed
    if result.status >= 200 and result.status < 300 and isText(result.body)
        answer = parseJson(result.body)
        if type(answer) = "roAssociativeArray"
            if isText(answer.continueUrl) and isText(answer.qrImageUrl)
                if m.commerceHTTPS.isMatch(answer.continueUrl) and m.commerceHTTPS.isMatch(answer.qrImageUrl)
                    m.panelQr.uri = answer.qrImageUrl
                    m.panelQr.visible = true
                    m.commerceMessage = m.commerceLabels.scan
                end if
            end if
        end if
    end if
    renderCommerce()
end sub

sub onQrLoad()
    if m.panelQr.visible and m.panelQr.loadStatus = "failed"
        m.panelQr.visible = false
        m.commerceMessage = m.commerceLabels.failed
        renderCommerce()
    end if
end sub

function commerceText(value as Dynamic, limit as Integer) as Boolean
    if not isText(value) then return false
    return len(value) <= limit and value.trim() <> ""
end function

function commercePrice(value as Dynamic, decimal = invalid as Dynamic) as Dynamic
    if isNumber(value) then value = value.toStr()
    if not isText(value) then return invalid
    if decimal = invalid then decimal = createObject("roRegex", "^\d{1,12}(\.\d{1,6})?$", "")
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
    decimal = createObject("roRegex", "^\d{1,12}(\.\d{1,6})?$", "")
    price = commercePrice(item.price, decimal)
    if price = invalid or type(item.variants) <> "roArray" then return invalid
    if item.variants.count() < 1 or item.variants.count() > 2048 then return invalid
    result = { title: item.title, currency: item.currency, locale: commerceLocale(item.locale),
               handoffUrl: item.handoffUrl, price: price, variants: [] }
    if commerceText(item.vendor, 512) then result.vendor = item.vendor
    if commerceText(item.description, 5000) then result.description = item.description
    result.previousPrice = commercePrice(item.previousPrice, decimal)
    videoPath = createObject("roRegex", "\.(mp4|m3u8|mov|webm)([?#]|$)", "i")
    if shopImage(item.imageUrl, https, videoPath) then result.imageUrl = item.imageUrl
    result.images = []
    if type(item.images) = "roArray"
        for each url in item.images
            if shopImage(url, https, videoPath) then result.images.push(url)
        end for
    end if
    ids = {}
    ids.setModeCaseSensitive()
    for each variant in item.variants
        if type(variant) <> "roAssociativeArray" then return invalid
        if not commerceText(variant.id, 128) or not commerceText(variant.label, 2048) then return invalid
        if ids.doesExist(variant.id) then return invalid
        variantPrice = price
        if variant.price <> invalid then variantPrice = commercePrice(variant.price, decimal)
        if variantPrice = invalid then return invalid
        ids[variant.id] = true
        row = { id: variant.id, label: variant.label, price: variantPrice, available: true }
        if type(variant.availableForSale) = "roBoolean" or type(variant.availableForSale) = "Boolean"
            row.available = variant.availableForSale
        end if
        row.previousPrice = commercePrice(variant.previousPrice, decimal)
        if shopImage(variant.imageUrl, https, videoPath) then row.imageUrl = variant.imageUrl
        row.options = []
        if type(variant.selectedOptions) = "roArray"
            if variant.selectedOptions.count() <= 3
                for each pair in variant.selectedOptions
                    if type(pair) <> "roAssociativeArray" or not commerceText(pair.name, 512) or not commerceText(pair.value, 512)
                        row.options = []
                        exit for
                    end if
                    row.options.push({ name: pair.name, value: pair.value })
                end for
            end if
        end if
        result.variants.push(row)
    end for
    if commerceText(item.viewUrl, 4096)
        if https.isMatch(item.viewUrl) then result.viewUrl = item.viewUrl
    end if
    return result
end function

function shopImage(url as Dynamic, https as Object, videoPath as Object) as Boolean
    if not commerceText(url, 4096) then return false
    return https.isMatch(url) and not videoPath.isMatch(url)
end function

function commerceCopy(locale as String) as Object
    if locale = "es"
        return { trigger: "OK · Ver producto", heading: "Producto", variant: "Variante", buy: "Comprar", close: "Cerrar",
            options: "Elegir opciones", details: "Ver detalles", addCart: "Agregar al carrito", cart: "Carrito de compras", finish: "Continuar con el QR", gallery: "Ver galería de fotos", back: "Volver", total: "Total", unit: "1 unidad", was: "Antes", unavailable: "Sin stock", retry: "Reintentar",
            scan: "Escaneá para pagar en Shopify", preparing: "Preparando tu carrito…", failed: "No se pudo preparar el carrito. Intentá de nuevo." }
    else if locale = "pt-BR"
        return { trigger: "OK · Ver produto", heading: "Produto", variant: "Variante", buy: "Comprar", close: "Fechar",
            options: "Escolher opções", details: "Ver detalhes", addCart: "Adicionar ao carrinho", cart: "Carrinho de compras", finish: "Continuar com o QR", gallery: "Ver galeria de fotos", back: "Voltar", total: "Total", unit: "1 unidade", was: "Antes", unavailable: "Sem estoque", retry: "Tentar novamente",
            scan: "Escaneie para pagar na Shopify", preparing: "Preparando seu carrinho…", failed: "Não foi possível preparar o carrinho. Tente novamente." }
    end if
    return { trigger: "OK · View product", heading: "Product", variant: "Variant", buy: "Buy", close: "Close",
        options: "Choose options", details: "View details", addCart: "Add to cart", cart: "Shopping cart", finish: "Continue to QR", gallery: "View photo gallery", back: "Back", total: "Total", unit: "1 item", was: "Was", unavailable: "Out of stock", retry: "Retry",
        scan: "Scan to pay on Shopify", preparing: "Preparing your cart…", failed: "Could not prepare the cart. Try again." }
end function

sub initializeCommerce()
    m.top.focusable = true
    m.panel = m.top.findNode("ilCommerce")
    m.panelBackground = m.top.findNode("ilCommerceBackground")
    m.panelDetail = m.top.findNode("ilCommerceDetail")
    m.panelTrigger = m.top.findNode("ilCommerceTrigger")
    m.panelHeading = m.top.findNode("ilCommerceHeading")
    m.panelName = m.top.findNode("ilCommerceName")
    m.panelPrice = m.top.findNode("ilCommercePrice")
    m.panelBuy = m.top.findNode("ilCommerceBuy")
    m.panelBuyBackground = m.top.findNode("ilCommerceBuyBackground")
    m.buyLeft = m.top.findNode("ilCommerceBuyLeft")
    m.buyRight = m.top.findNode("ilCommerceBuyRight")
    m.panelClose = m.top.findNode("ilCommerceClose")
    m.panelStatus = m.top.findNode("ilCommerceStatus")
    m.panelQr = m.top.findNode("ilCommerceQr")
    m.panelLogo = m.top.findNode("ilCommerceLogo")
    m.panelPhoto = m.top.findNode("ilCommercePhoto")
    m.panelPrevious = m.top.findNode("ilCommercePrevious")
    m.panelDescription = m.top.findNode("ilCommerceDescription")
    m.panelSummary = m.top.findNode("ilCommerceSummary")
    m.panelTotal = m.top.findNode("ilCommerceTotal")
    m.panelAmount = m.top.findNode("ilCommerceAmount")
    m.galleryPrev = m.top.findNode("ilCommerceGalleryPrev")
    m.galleryNext = m.top.findNode("ilCommerceGalleryNext")
    m.galleryBackground = m.top.findNode("ilCommerceGalleryBackground")
    m.panelGallery = m.top.findNode("ilCommerceGallery")
    m.panelArrows = m.top.findNode("ilCommerceArrows")
    m.optionGroup = m.top.findNode("ilCommerceChips")
    m.closeFocus = sceneOutline(m.panelClose, 100, 36, 2, "0xFFFFFFFF")
    m.galleryFocus = sceneOutline(m.panelGallery, 282, 36, 2, "0xFFFFFFFF")
    m.buyFocus = sceneOutline(m.panelDetail, 486, 62, 3, "0xFFFFFFFF")
    m.shopWidgets = []
    for axis = 0 to 2
        m.shopWidgets.push(createShopOptionRow(axis))
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
    m.commerceLabels = commerceCopy(offer.locale)
    m.commerceMessage = ""
    m.shopPage = "intro"
    m.shopFocusKey = "action"
    m.panelTrigger.text = m.commerceLabels.trigger
    if m.active.format = "midroll" then m.panelTrigger.text = m.commerceLabels.buy
    m.shopRows = invalid
    applyCommerceBrand()
    m.panel.visible = true
    renderCommerce()
    if m.top.commerceAutoFocus and not m.top.hasFocus()
        m.previousCommerceFocus = previousFocusedNode()
        m.top.setFocus(true)
    end if
end sub

sub releaseShop()
    cancelCart()
    m.panel.visible = false
    for each photo in [m.panelPhoto, m.panelLogo]
        photo.uri = ""
    end for
    m.shopRows = invalid
    m.shopAxes = invalid
    m.shopPhotos = invalid
    m.shopPhotoIds = invalid
    m.shopCoverPhoto = invalid
    m.scenePanelOffer = invalid
end sub

sub hideCommerce()
    if m.panel.visible then releaseShop()
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
    m.shopQrUrl = ""
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
    for each label in [m.panelTrigger, m.panelHeading, m.panelClose, m.panelName, m.panelPrice, m.panelPrevious, m.panelDescription, m.panelSummary, m.panelTotal, m.panelAmount, m.panelGallery, m.panelArrows, m.galleryPrev, m.galleryNext, m.panelStatus]
        label.color = foreground
    end for
    m.panelBuyBackground.color = "0xF0F0F0FF"
    m.panelBuy.color = "0x202020FF"
    focusColor = "0xB4C6FFFF"
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
        if luminance > 0.18 then focusColor = accent
    end if
    m.buyLeft.blendColor = m.panelBuyBackground.color
    m.buyRight.blendColor = m.panelBuyBackground.color
    outlines = [m.buyFocus, m.closeFocus, m.galleryFocus]
    for each widget in m.shopWidgets
        for each chip in widget.chips
            outlines.push(chip.outline)
        end for
    end for
    for each outline in outlines
        for each edge in outline.getChildren(-1, 0)
            edge.color = focusColor
        end for
    end for
    logoUrl = ""
    if isText(brand.logoUrl)
        if m.commerceHTTPS.isMatch(brand.logoUrl) then logoUrl = brand.logoUrl
    end if
    m.panelGallery.color = "0xFFFFFFFF"
    m.shopInk = foreground
    m.shopLogoUrl = logoUrl
    m.panelLogo.uri = logoUrl
    m.panelLogo.visible = logoUrl <> ""
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
        trackProductView()
        enterShopPage("intro", "action")
        return true
    end if
    if key = "back"
        shopBack()
        return true
    end if
    if key = "up" or key = "down"
        stepBy = 1
        if key = "up" then stepBy = -1
        index = 0
        for i = 0 to m.shopControls.count() - 1
            if m.shopControls[i] = m.shopFocusKey then index = i
        end for
        n = m.shopControls.count()
        m.shopFocusKey = m.shopControls[(index + n + stepBy) mod n]
    else if key = "left" or key = "right"
        stepBy = 1
        if key = "left" then stepBy = -1
        if m.shopPage = "gallery"
            n = m.shopPhotos.count()
            if n > 0 then m.shopPhotoIndex = (m.shopPhotoIndex + n + stepBy) mod n
        else if left(m.shopFocusKey, 3) = "row"
            row = m.shopRows[val(mid(m.shopFocusKey, 4))]
            n = row.values.count()
            row.focus = (row.focus + n + stepBy) mod n
        end if
    else if key = "ok"
        if m.shopFocusKey = "back"
            shopBack()
            return true
        else if m.shopFocusKey = "gallery"
            enterShopPage("gallery", "back")
        else if left(m.shopFocusKey, 3) = "row"
            row = m.shopRows[val(mid(m.shopFocusKey, 4))]
            index = row.candidates[row.focus]
            if index >= 0 then selectShopVariant(index)
        else if m.shopPage = "intro"
            enterShopPage("detail", "row0")
        else if m.shopPage = "detail" and currentOffer().variants[m.commerceChoice].available
            enterShopPage("cart", "action")
        else if m.shopPage = "cart" or (m.shopPage = "qr" and m.commerceMessage = m.commerceLabels.failed)
            enterShopPage("qr", "back")
            prepareCart()
        end if
    else
        return false
    end if
    renderCommerce()
    return true
end function

sub enterShopPage(page as String, focusKey as String)
    cancelCart()
    if page = "gallery"
        m.shopPhotoIndex = 0
        photo = shopProductPhoto(currentOffer().variants[m.commerceChoice])
        if isText(photo) then m.shopPhotoIndex = m.shopPhotoIds[photo]
    end if
    m.shopPage = page
    m.shopFocusKey = focusKey
    renderCommerce()
end sub

sub shopBack()
    if m.shopPage = "qr"
        enterShopPage("cart", "action")
    else if m.shopPage = "gallery"
        enterShopPage("detail", "gallery")
    else if m.shopPage = "cart"
        enterShopPage("detail", "action")
    else if m.shopPage = "detail"
        enterShopPage("intro", "action")
    else
        cancelCart()
        m.commerceOpen = false
        if m.scenePanelOffer <> invalid
            releaseShop()
            updateSceneFocus()
        else
            renderCommerce()
        end if
    end if
end sub

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
        m.shopFocusKey = "action"
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
    m.shopFocusKey = "action"
    if result.status >= 200 and result.status < 300 and isText(result.body)
        answer = parseJson(result.body)
        if type(answer) = "roAssociativeArray"
            if isText(answer.continueUrl) and isText(answer.qrImageUrl)
                if m.commerceHTTPS.isMatch(answer.continueUrl) and m.commerceHTTPS.isMatch(answer.qrImageUrl)
                    m.shopQrUrl = answer.qrImageUrl
                    m.shopFocusKey = "back"
                    m.commerceMessage = m.commerceLabels.scan
                end if
            end if
        end if
    end if
    renderCommerce()
end sub

sub onQrLoad()
    if m.panelQr.visible and m.panelQr.loadStatus = "failed"
        m.shopQrUrl = ""
        m.panelQr.visible = false
        m.shopFocusKey = "action"
        m.commerceMessage = m.commerceLabels.failed
        renderCommerce()
    end if
end sub

' 1280 x 720 reference layout. The side sheet occupies the right 40% of the existing video.
sub shopPlace(node as Object, x as Float, y as Float, w as Float, h as Float)
    node.translation = [x, y]
    node.width = w
    node.height = h
    node.visible = true
end sub

sub shopLabel(node as Object, value as Dynamic, x as Float, y as Float, w as Float, h as Float)
    if not isText(value) or value = "" then return
    node.text = value
    shopPlace(node, x, y, w, h)
end sub

sub shopPoster(node as Object, url as Dynamic, x as Float, y as Float, w as Float, h as Float)
    if not isText(url) or url = ""
        node.uri = ""
        return
    end if
    ' Bound decoded gallery textures on memory-constrained boxes.
    if node.width <> w or node.height <> h
        node.loadWidth = int(w * m.shopDecodeScale)
        node.loadHeight = int(h * m.shopDecodeScale)
    end if
    if node.uri <> url then node.uri = url
    shopPlace(node, x, y, w, h)
end sub

function createShopOptionRow(axis as Integer) as Object
    group = m.optionGroup.createChild("Group")
    group.translation = [32, 328 + axis * 85]
    heading = group.createChild("Label")
    heading.id = "ilCommerceOption" + axis.toStr()
    heading.width = 448
    heading.height = 31
    font = createObject("roSGNode", "Font")
    font.uri = "font:BoldSystemFontFile"
    font.size = 19
    heading.font = font
    chips = []
    font = createObject("roSGNode", "Font")
    font.uri = "font:SystemFontFile"
    font.size = 18
    for i = 0 to 2
        tile = group.createChild("Rectangle")
        tile.translation = [i * 148, 32]
        tile.width = 140
        tile.height = 46
        label = tile.createChild("Label")
        label.id = "ilCommerceChip" + axis.toStr() + "-" + i.toStr()
        label.translation = [5, 0]
        label.width = 130
        label.height = 46
        label.font = font
        label.horizAlign = "center"
        label.vertAlign = "center"
        label.wrap = true
        label.maxLines = 2
        label.ellipsizeOnBoundary = true
        outline = sceneOutline(tile, 140, 46, 3, "0xFFFFFFFF")
        chips.push({ tile: tile, label: label, outline: outline })
    end for
    return { group: group, heading: heading, chips: chips }
end function

function shopMoney(offer as Object, amount as Dynamic) as String
    if not isText(amount) then return ""
    if offer.locale <> "en" then amount = amount.replace(".", ",")
    return offer.currency + " " + amount
end function

function shopPriceKey(amount as String) as String
    parts = amount.split(".")
    fraction = ""
    if parts.count() > 1 then fraction = parts[1]
    return right("000000000000" + parts[0], 12) + left(fraction + "000000", 6)
end function

sub shopAction(caption as String)
    focused = m.shopFocusKey = "action"
    m.panelBuyBackground.opacity = 1
    shopPlace(m.buyLeft, 32, 626, 50, 50)
    shopPlace(m.buyRight, 456, 626, 50, 50)
    shopPlace(m.panelBuyBackground, 57, 626, 424, 50)
    shopLabel(m.panelBuy, caption, 32, 626, 474, 50)
    m.buyFocus.translation = [26, 620]
    m.buyFocus.visible = focused
end sub

sub renderCommerce()
    offer = currentOffer()
    if offer = invalid or not m.panel.visible then return
    m.panelTrigger.visible = not m.commerceOpen
    m.panelDetail.visible = m.commerceOpen
    sx = m.commerceVideoWidth / 1280
    sy = m.commerceVideoHeight / 720
    m.panel.scale = [sx, sy]
    m.shopDecodeScale = sy
    if m.shopDecodeScale > 2 then m.shopDecodeScale = 2
    w = 538
    x = 1280 - w
    y = 0
    h = 720
    if not m.commerceOpen
        w = m.panelTrigger.width
        h = m.panelTrigger.height
        x = 1220 - w
        y = 680 - h
        if m.active.format = "midroll" then y = 550
    end if
    m.panel.translation = [m.video.translation[0] + x * sx, m.video.translation[1] + y * sy]
    m.panelBackground.width = w
    m.panelBackground.height = h
    m.panelBackground.opacity = 0.96
    if not m.commerceOpen then return

    for each node in m.panelDetail.getChildren(-1, 0)
        node.visible = false
    end for
    if m.shopRows = invalid then setupShop(offer)
    page = m.shopPage
    selected = offer.variants[m.commerceChoice]
    photo = shopProductPhoto(selected)
    if page = "gallery" and m.shopPhotos.count() > 0 then photo = m.shopPhotos[m.shopPhotoIndex]
    price = shopMoney(offer, selected.price)
    previous = selected.previousPrice
    if previous = invalid and m.shopAvailableCount > 0 and m.commerceChoice = m.shopDefaultChoice and shopPriceKey(selected.price) = shopPriceKey(offer.price)
        previous = offer.previousPrice
    end if
    before = invalid
    if isText(previous)
        if shopPriceKey(previous) > shopPriceKey(selected.price) then before = m.commerceLabels.was + " " + shopMoney(offer, previous)
    end if
    copy = m.commerceLabels
    m.shopControls = ["back"]
    if page = "intro"
        shopPoster(m.panelPhoto, photo, 32, 84, 474, 234)
        shopLabel(m.panelHeading, offer.vendor, 32, 327, 474, 34)
        shopLabel(m.panelName, offer.title, 32, 363, 474, 64)
        range = shopPriceKey(m.shopLowPrice) <> shopPriceKey(m.shopHighPrice)
        coverPrice = shopMoney(offer, m.shopLowPrice)
        if range then coverPrice += " – " + shopMoney(offer, m.shopHighPrice)
        shopLabel(m.panelPrice, coverPrice, 32, 431, 474, 44)
        if not range then shopLabel(m.panelPrevious, before, 32, 477, 474, 30)
        shopLabel(m.panelDescription, offer.description, 32, 510, 474, 64)
        if m.shopAxes.count() > 1 and m.shopAvailableCount > 1
            axes = []
            for each axis in m.shopAxes
                axes.push(axis.name)
            end for
            shopLabel(m.panelSummary, axes.join(" · "), 32, 574, 474, 38)
        end if
        caption = copy.details
        if m.shopAvailableCount > 1 then caption = copy.options
        shopAction(caption)
        m.shopControls.push("action")
    else if page = "detail"
        shopLabel(m.panelName, offer.title, 32, 66, 400, 60)
        shopPoster(m.panelPhoto, photo, 32, 127, 436, 112)
        if m.shopPhotos.count() > 0
            shopPlace(m.galleryBackground, 178, 202, 282, 36)
            shopLabel(m.panelGallery, copy.gallery, 178, 202, 282, 36)
            m.galleryFocus.visible = m.shopFocusKey = "gallery"
            m.shopControls.push("gallery")
        end if
        shopLabel(m.panelPrice, price, 32, 240, 236, 38)
        shopLabel(m.panelPrevious, before, 270, 240, 232, 38)
        shopLabel(m.panelDescription, offer.description, 32, 277, 445, 48)
        renderShopOptions()
        caption = copy.unavailable
        if selected.available
            caption = copy.addCart
            m.shopControls.push("action")
        end if
        shopAction(caption)
        m.panelBuyBackground.opacity = 0.55
        if selected.available then m.panelBuyBackground.opacity = 1
    else if page = "cart"
        shopLabel(m.panelHeading, copy.cart, 44, 70, 420, 49)
        shopPoster(m.panelPhoto, photo, 42, 149, 98, 100)
        shopLabel(m.panelName, offer.title, 157, 146, 318, 66)
        shopLabel(m.panelSummary, selected.label + " · " + copy.unit, 157, 218, 314, 68)
        shopLabel(m.panelTotal, copy.total, 44, 524, 111, 77)
        shopLabel(m.panelAmount, price, 152, 524, 310, 77)
        shopAction(copy.finish)
        m.shopControls.push("action")
    else if page = "qr"
        shopLabel(m.panelHeading, copy.cart, 43, 64, 420, 42)
        shopPoster(m.panelPhoto, photo, 57, 113, 398, 170)
        shopLabel(m.panelName, offer.title, 42, 287, 425, 65)
        shopLabel(m.panelSummary, price + " · " + selected.label, 42, 353, 428, 50)
        if m.shopQrUrl <> ""
            shopPoster(m.panelQr, m.shopQrUrl, 151, 408, 208, 208)
            shopLabel(m.panelStatus, copy.scan, 32, 623, 446, 60)
        else
            shopLabel(m.panelStatus, m.commerceMessage, 38, 437, 435, 95)
            if m.commerceMessage = copy.failed
                m.shopControls.push("action")
                shopAction(copy.retry)
            end if
        end if
    else if page = "gallery"
        n = m.shopPhotos.count()
        shopPoster(m.panelPhoto, photo, 32, 110, 474, 338)
        if n > 1
            shopLabel(m.galleryPrev, "‹", 41, 455, 68, 64)
            shopLabel(m.galleryNext, "›", 429, 455, 68, 64)
        end if
        position = m.shopPhotoIndex + 1
        shopLabel(m.panelArrows, position.toStr() + " / " + n.toStr(), 109, 460, 320, 54)
        shopLabel(m.panelName, offer.title, 32, 540, 474, 68)
        shopLabel(m.panelPrice, price, 32, 613, 474, 53)
    end if
    shopPoster(m.panelLogo, m.shopLogoUrl, 367, 18, 140, 40)
    shopLabel(m.panelClose, "‹ " + copy.back, 27, 20, 100, 36)
    m.closeFocus.visible = m.shopFocusKey = "back"
end sub

sub renderShopOptions()
    m.optionGroup.visible = true
    for axis = 0 to 2
        widget = m.shopWidgets[axis]
        widget.group.visible = axis < m.shopRows.count()
        if widget.group.visible
            row = m.shopRows[axis]
            control = "row" + axis.toStr()
            m.shopControls.push(control)
            count = row.values.count()
            first = row.focus - 1
            if first > count - 3 then first = count - 3
            if first < 0 then first = 0
            widget.heading.text = row.name
            if count > 3
                marker = row.focus + 1
                widget.heading.text = row.name + "   " + marker.toStr() + "/" + count.toStr()
            end if
            widget.heading.color = m.shopInk
            for i = 0 to widget.chips.count() - 1
                chip = widget.chips[i]
                k = first + i
                chip.tile.visible = k < count
                if chip.tile.visible
                    chip.label.text = row.values[k]
                    chip.tile.color = "0x303030FF"
                    chip.label.color = "0xFFFFFFFF"
                    if k = row.selected
                        chip.tile.color = m.chipSelectedColor
                        chip.label.color = m.chipSelectedText
                    end if
                    chip.label.opacity = 1
                    if row.candidates[k] < 0 then chip.label.opacity = 0.52
                    chip.outline.visible = m.shopFocusKey = control and k = row.focus
                end if
            end for
        end if
    end for
end sub

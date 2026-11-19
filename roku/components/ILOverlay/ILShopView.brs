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
    if not isText(url) or url = "" then return
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
    shopPlace(m.panelBuyBackground, 52, 626, 400, 50)
    shopLabel(m.panelBuy, caption, 52, 626, 400, 50)
    m.buyFocus.translation = [46, 620]
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
    x = 768
    y = 0
    w = 512
    h = 720
    if not m.commerceOpen
        w = m.panelTrigger.width
        h = m.panelTrigger.height
        x = 1220 - w
        y = 680 - h
        if m.active.format = "midroll" then y = 550
    else if m.shopPage = "gallery"
        x = 0
        w = 1280
    end if
    m.panel.translation = [m.video.translation[0] + x * sx, m.video.translation[1] + y * sy]
    m.panelBackground.width = w
    m.panelBackground.height = h
    m.panelBackground.opacity = 0.91
    if not m.commerceOpen then return

    for each node in m.panelDetail.getChildren(-1, 0)
        node.visible = false
    end for
    if m.shopRows = invalid then setupShop(offer)
    page = m.shopPage
    selected = offer.variants[m.commerceChoice]
    photo = invalid
    if m.shopPhotos.count() > 0 then photo = m.shopPhotos[m.shopPhotoIndex]
    if page = "intro" or page = "cart" or page = "qr"
        if selected.imageUrl <> invalid
            photo = selected.imageUrl
        else if m.shopPhotos.count() > 0
            photo = m.shopPhotos[0]
        end if
    end if
    price = shopMoney(offer, selected.price)
    copy = m.commerceLabels
    m.shopControls = ["back"]
    if page = "intro"
        shopPoster(m.panelPhoto, photo, 48, 64, 416, 237)
        shopLabel(m.panelHeading, copy.heading, 44, 319, 302, 38)
        shopLabel(m.panelName, offer.title, 44, 360, 424, 65)
        if offer.previousPrice <> invalid
            if shopPriceKey(offer.previousPrice) > shopPriceKey(selected.price)
                shopLabel(m.panelPrevious, copy.was + " " + shopMoney(offer, offer.previousPrice), 44, 433, 420, 25)
            end if
        end if
        shopLabel(m.panelPrice, price, 44, 464, 420, 50)
        shopPoster(m.panelLogo, m.shopLogoUrl, 150, 534, 205, 54)
        shopAction(copy.addProduct)
        m.shopControls.push("action")
    else if page = "detail"
        shopLabel(m.panelName, offer.title, 32, 66, 400, 60)
        shopPoster(m.panelLogo, m.shopLogoUrl, 350, 17, 104, 43)
        shopPoster(m.panelPhoto, photo, 32, 127, 436, 112)
        if photo <> invalid
            shopPlace(m.galleryBackground, 178, 202, 282, 36)
            shopLabel(m.panelGallery, copy.gallery, 178, 202, 282, 36)
            m.galleryFocus.visible = m.shopFocusKey = "gallery"
            m.shopControls.push("gallery")
        end if
        shopLabel(m.panelPrice, price, 32, 240, 438, 38)
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
        shopPoster(m.panelLogo, m.shopLogoUrl, 144, 336, 220, 78)
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
        m.galleryFrame.visible = true
        if n > 1
            shopLabel(m.galleryPrev, "‹", 31, 318, 45, 64)
            shopLabel(m.galleryNext, "›", 1204, 318, 45, 64)
            shopPoster(m.galleryLeft, m.shopPhotos[(m.shopPhotoIndex + n - 1) mod n], 60, 160, 264, 310)
            shopPoster(m.galleryRight, m.shopPhotos[(m.shopPhotoIndex + 1) mod n], 956, 160, 264, 310)
            m.galleryLeft.opacity = 0.6
            m.galleryRight.opacity = 0.6
        end if
        shopPoster(m.panelPhoto, photo, 342, 94, 596, 419)
        position = m.shopPhotoIndex + 1
        shopLabel(m.panelArrows, position.toStr() + " / " + n.toStr(), 425, 498, 430, 45)
        shopLabel(m.panelName, offer.title, 58, 546, 730, 61)
        shopLabel(m.panelPrice, price, 58, 609, 505, 60)
        shopLabel(m.panelDescription, offer.description, 590, 553, 545, 100)
        shopPoster(m.panelLogo, m.shopLogoUrl, 1002, 31, 185, 60)
    end if
    if page = "gallery"
        shopLabel(m.panelClose, "‹ " + copy.back, 60, 49, 100, 36)
    else
        shopLabel(m.panelClose, "‹ " + copy.back, 27, 20, 100, 36)
    end if
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

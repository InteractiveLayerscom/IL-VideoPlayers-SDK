function normalizeScene(value as Dynamic, format as String) as Dynamic
    if type(value) <> "roAssociativeArray" then return invalid
    if not isText(value.format) or type(value.layers) <> "roArray" then return invalid
    if value.format <> format then return invalid
    if not isNumber(value.width) or not isNumber(value.height) or not isNumber(value.durationMs) then return invalid
    if value.width <= 0 or value.height <= 0 or value.durationMs <= 0 then return invalid
    if value.layers.count() < 1 or value.layers.count() > 512 then return invalid
    layers = []
    for each layer in value.layers
        if type(layer) = "roAssociativeArray"
            dropMistypedFields(layer)
            if isText(layer.id) and isText(layer.type) and layer.hidden <> true
                if isNumber(layer.x) and isNumber(layer.y) and isNumber(layer.width) and isNumber(layer.height)
                    if layer.width >= 0 and layer.height >= 0
                        if type(layer.keyframes) = "roArray" then layer.keyframes.sortBy("timeMs")
                        layers.push(layer)
                    end if
                end if
            end if
        end if
    end for
    if layers.count() = 0 then return invalid
    return { width: value.width, height: value.height, durationMs: value.durationMs, layers: layers }
end function

' A device raises Type Mismatch when a comparison mixes types. Fields the renderer compares
' with text or a boolean are removed unless they have that type, and then read as invalid.
sub dropMistypedFields(layer as Object)
    for each field in ["action", "binding", "fit", "textAlign"]
        if not isText(layer[field]) then layer.delete(field)
    end for
    for each field in ["hidden", "arrow"]
        if type(layer[field]) <> "Boolean" and type(layer[field]) <> "roBoolean" then layer.delete(field)
    end for
    if type(layer.keyframes) <> "roArray" then return
    for each point in layer.keyframes
        if type(point) = "roAssociativeArray"
            if not isText(point.easing) then point.delete("easing")
        end if
    end for
end sub

function normalizeSceneProducts(value as Dynamic, https as Object) as Object
    products = []
    if type(value) <> "roArray" then return products
    for each row in value
        offer = normalizeCommerce(row, https)
        if offer <> invalid
            if isText(row.id) and isText(row.imageUrl)
                if row.id <> "" and offer.imageUrl <> invalid
                    offer.id = row.id
                    offer.imageUrl = row.imageUrl
                end if
            end if
        end if
        if offer <> invalid
            if offer.id = invalid then offer = invalid
        end if
        products.push(offer)
        if products.count() >= 64 then exit for
    end for
    return products
end function

function sceneOffer(layer as Object) as Dynamic
    index = layer.productIndex
    if not isNumber(index) then return invalid
    if index < 0 or index >= m.active.products.count() or int(index) <> index then return invalid
    return m.active.products[index]
end function

function sceneNumber(row as Object, field as String, fallback as Float) as Float
    if isNumber(row[field]) then return row[field]
    return fallback
end function

function sceneColor(value as Dynamic, fallback as String) as String
    if not isText(value) then return fallback
    color = createObject("roRegex", "^#[0-9a-f]{6}([0-9a-f]{2})?$", "i")
    if color.isMatch(value) then return value
    return fallback
end function

function sceneStyle(row as Object, field as String, time as Double, fallback as Float) as Float
    value = sceneNumber(row, field, fallback)
    if type(row.keyframes) <> "roArray" then return value
    previous = 0#
    for each point in row.keyframes
        if type(point) = "roAssociativeArray"
            if isNumber(point.timeMs) and isNumber(point[field])
                if point.timeMs >= 0
                    if time < point.timeMs
                        progress = (time - previous) / (point.timeMs - previous)
                        remaining = 1 - progress
                        if point.easing = "ease-in"
                            progress = progress * progress
                        else if point.easing = "ease-out"
                            progress = 1 - remaining * remaining
                        else if point.easing = "ease-in-out"
                            if progress < 0.5
                                progress = 2 * progress * progress
                            else
                                progress = 1 - 2 * remaining * remaining
                            end if
                        end if
                        return value + (point[field] - value) * progress
                    end if
                    value = point[field]
                    previous = point.timeMs
                end if
            end if
        end if
    end for
    return value
end function

sub prepareScene(width as Float, height as Float)
    cue = m.active
    m.sceneEntries = []
    m.sceneActions = []
    m.sceneFocus = invalid
    m.scenePanelOffer = invalid
    m.sceneShown = false
    sceneWidth = width
    sceneHeight = height
    offsetX = 0
    offsetY = 0
    parents = [m.primary]
    if cue.format = "l"
        m.primary.clippingRect = [width * 0.75, 0, width * 0.25, height]
        m.secondary.clippingRect = [0, height * 0.75, width * 0.75, height * 0.25]
        parents.push(m.secondary)
    else
        if cue.format = "super"
            sceneWidth = width * 0.75
            sceneHeight = height * 0.20
            offsetX = width * 0.125
            offsetY = height * 0.70
        else
            sceneWidth = width * 0.30
            sceneHeight = height * 0.32
            offsetX = width * 0.64
            offsetY = height * 0.10
        end if
        m.primary.clippingRect = [offsetX, offsetY, sceneWidth, sceneHeight]
    end if
    m.sceneBox = { x: offsetX, y: offsetY, width: sceneWidth, height: sceneHeight,
        sx: sceneWidth / cue.scene.width, sy: sceneHeight / cue.scene.height }

    for each design in cue.scene.layers
        item = { design: design, copies: [], focus: [], visible: false }
        offer = sceneOffer(design)
        if offer <> invalid and m.top.commerceEnabled and (design.action = "product" or design.type = "product")
            item.offer = offer
        end if
        if design.action = "link" and isText(design.url)
            if m.commerceHTTPS.isMatch(design.url) then item.link = design.url
        end if
        for each parent in parents
            item.copies.push(createSceneLayer(parent, item, offer, m.sceneBox))
        end for
        m.sceneEntries.push(item)
        if item.offer <> invalid or item.link <> invalid then m.sceneActions.push(item)
    end for
end sub

function sceneOutline(parent as Object, width as Float, height as Float, stroke as Float, color as String) as Object
    border = parent.createChild("Group")
    segments = [[0, 0, width, stroke], [0, height - stroke, width, stroke],
        [0, stroke, stroke, height - stroke * 2], [width - stroke, stroke, stroke, height - stroke * 2]]
    for each segment in segments
        if segment[2] > 0 and segment[3] > 0
            rect = border.createChild("Rectangle")
            rect.translation = [segment[0], segment[1]]
            rect.width = segment[2]
            rect.height = segment[3]
            rect.color = color
        end if
    end for
    return border
end function

function createSceneLayer(parent as Object, item as Object, offer as Dynamic, viewport as Object) as Object
    design = item.design
    layer = parent.createChild("Group")
    layer.id = design.id
    width = design.width * viewport.sx
    height = design.height * viewport.sy
    layer.scaleRotateCenter = [width / 2, height / 2]
    content = invalid
    media = false
    if design.type = "image" or design.type = "video" or design.binding = "image"
        url = design.src
        if design.type = "video" then url = design.poster
        if design.binding = "image"
            url = invalid
            if offer <> invalid then url = offer.imageUrl
        end if
        if isText(url)
            if m.commerceHTTPS.isMatch(url)
                fit = "scaleToZoom"
                if design.fit = "contain" then fit = "scaleToFit"
                if design.fit = "fill" then fit = "scaleToFill"
                content = sceneMedia(layer, design, width, height, url, fit)
                media = true
            end if
        end if
    else if design.type = "text"
        label = design.text
        if design.binding = "title" or design.binding = "price"
            label = invalid
            if offer <> invalid
                label = offer.title
                if design.binding = "price"
                    amount = offer.price
                    if offer.locale <> "en" then amount = amount.replace(".", ",")
                    label = offer.currency + " " + amount
                end if
            end if
        end if
        if isText(label) and label <> ""
            content = layer.createChild("Label")
            content.width = width
            content.height = height
            content.text = label
            content.wrap = true
            content.vertAlign = "top"
            if design.textAlign = "center" or design.textAlign = "right" then content.horizAlign = design.textAlign
            content.color = sceneColor(design.fill, "#ffffff")
            font = createObject("roSGNode", "Font")
            if font <> invalid
                font.uri = "font:MediumSystemFont"
                if sceneNumber(design, "fontWeight", 400) >= 600 then font.uri = "font:MediumBoldSystemFont"
                font.size = sceneNumber(design, "fontSize", 24) * viewport.sx
                content.font = font
                lineHeight = sceneNumber(design, "lineHeight", 1.1)
                if content.hasField("lineSpacing") then content.lineSpacing = font.size * (lineHeight - 1)
                lines = sceneNumber(design, "maxLines", 0)
                if lines > 0 and height > lines * lineHeight * font.size
                    content.height = lines * lineHeight * font.size
                end if
            end if
        end if
    else if design.type = "line"
        content = layer.createChild("Rectangle")
        content.width = width
        content.height = sceneNumber(design, "strokeWidth", 1) * viewport.sx
        content.translation = [0, (height - content.height) / 2]
        content.color = sceneColor(design.stroke, sceneColor(design.fill, "#ffffff"))
        if design.arrow = true
            arrow = createPoster(layer, width * 0.10, height, "pkg:/components/ILOverlay/arrow.png")
            arrow.blendColor = content.color
            arrow.translation = [width * 0.90, 0]
        end if
    else
        fill = sceneColor(design.fill, "")
        if fill <> "" and design.type = "ellipse"
            content = createPoster(layer, width, height, "pkg:/components/ILOverlay/ellipse.png")
            content.blendColor = fill
            media = true
        else if fill <> "" or type(design.gradient) = "roAssociativeArray"
            content = layer.createChild("Rectangle")
            content.width = width
            content.height = height
            if fill = "" then fill = sceneColor(design.gradient.from, "#00000000")
            content.color = fill
        end if
        stroke = sceneColor(design.stroke, "")
        strokeWidth = sceneNumber(design, "strokeWidth", 0) * viewport.sx
        hasEffect = false
        if content <> invalid
            if not media and (design.radius <> invalid or design.gradient <> invalid)
                hasEffect = applySceneEffect(content, design, viewport.sx, stroke, strokeWidth)
            end if
        end if
        if not hasEffect and stroke <> "" and strokeWidth > 0 and design.type <> "ellipse"
            border = sceneOutline(layer, width, height, strokeWidth, stroke)
            if content = invalid then content = border
        end if
    end if
    if content <> invalid then content.enableRenderTracking = true
    if item.link <> invalid or item.offer <> invalid
        indicator = sceneOutline(layer, width, height, 3, "#78e4fd")
        indicator.visible = false
        item.focus.push(indicator)
    end if
    return { layer: layer, content: content, media: media }
end function

function sceneMedia(layer as Object, design as Object, width as Float, height as Float, url as String, fit as String) as Object
    crop = design.mediaCrop
    if type(crop) <> "roAssociativeArray" then return createPoster(layer, width, height, url, fit)
    zoom = sceneNumber(crop, "zoom", 1)
    if zoom <= 1 then return createPoster(layer, width, height, url, fit)
    if zoom > 4 then zoom = 4
    x = sceneNumber(crop, "x", 0)
    y = sceneNumber(crop, "y", 0)
    if x < -1 then x = -1
    if x > 1 then x = 1
    if y < -1 then y = -1
    if y > 1 then y = 1
    viewport = layer.createChild("Group")
    viewport.clippingRect = [0, 0, width, height]
    decodeScale = 1.0
    longest = width
    if height > width then longest = height
    if longest * zoom > 2048 then decodeScale = 2048 / (longest * zoom)
    media = createPoster(viewport, width * zoom, height * zoom, url, fit, decodeScale)
    overflow = (zoom - 1) / 2
    media.translation = [(x - 1) * overflow * width, (y - 1) * overflow * height]
    return media
end function

function applySceneEffect(content as Object, design as Object, scale as Float, stroke as String, strokeWidth as Float) as Boolean
    if not content.hasField("effect") then return false
    ' The device field guards access on versions before Roku OS 16.0.
    effectClass = "Effect"
    effect = createObject("roSGNode", effectClass)
    if effect = invalid then return false
    if not effect.supported then return false
    radius = sceneNumber(design, "radius", 0)
    if radius > 0 then effect.borderRadius = [radius * scale]
    if stroke <> "" and strokeWidth > 0
        effect.borderColor = stroke
        effect.borderWidth = strokeWidth
    end if
    if type(design.gradient) = "roAssociativeArray"
        first = sceneColor(design.gradient.from, "")
        last = sceneColor(design.gradient.to, "")
        if first <> "" and last <> ""
            effect.gradientStyle = "linear"
            effect.gradientColors = [first, last]
            effect.gradientAngle = sceneNumber(design.gradient, "angle", 0)
        end if
    end if
    content.effect = effect
    return true
end function

sub applyArtworkTransform()
    m.art.translation = m.video.translation
    m.art.scale = m.video.scale
    m.art.scaleRotateCenter = m.video.scaleRotateCenter
    m.art.rotation = m.video.rotation
    m.art.opacity = m.video.opacity
end sub

sub presentScene(time as Double)
    cue = m.active
    elapsed = time - cue.start
    if elapsed > cue.scene.durationMs then elapsed = cue.scene.durationMs
    viewport = m.sceneBox
    artwork = false
    onScreen = false
    for each item in m.sceneEntries
        design = item.design
        scale = sceneStyle(design, "scale", elapsed, 1)
        alpha = sceneStyle(design, "opacity", elapsed, 1)
        x = sceneStyle(design, "x", elapsed, design.x) * viewport.sx + viewport.x
        y = sceneStyle(design, "y", elapsed, design.y) * viewport.sy + viewport.y
        angle = sceneStyle(design, "rotation", elapsed, 0) * 0.01745329252
        width = design.width * viewport.sx
        height = design.height * viewport.sy
        rx = (abs(width * cos(angle)) + abs(height * sin(angle))) * scale / 2
        ry = (abs(width * sin(angle)) + abs(height * cos(angle))) * scale / 2
        item.cx = x + width / 2
        item.cy = y + height / 2
        inFrame = item.cx + rx > viewport.x and item.cy + ry > viewport.y and item.cx - rx < viewport.x + viewport.width and item.cy - ry < viewport.y + viewport.height
        inBands = cue.format <> "l" or item.cx + rx > viewport.width * 0.75 or item.cy + ry > viewport.height * 0.75
        item.visible = alpha > 0 and scale > 0 and inFrame and inBands
        if isNumber(design.startMs)
            if elapsed < design.startMs then item.visible = false
        end if
        if isNumber(design.endMs)
            if elapsed >= design.endMs then item.visible = false
        end if
        for each copy in item.copies
            copy.layer.visible = item.visible
            if item.visible
                copy.layer.translation = [x, y]
                copy.layer.rotation = -angle
                copy.layer.scale = [scale, scale]
                if alpha > 1 then alpha = 1
                copy.layer.opacity = alpha
                if copy.content <> invalid
                    if not copy.media or copy.content.loadStatus = "ready"
                        artwork = true
                        if rendered(copy.content) then onScreen = true
                    end if
                end if
            end if
        end for
    end for

    if not artwork
        hideArtwork()
        m.sceneShown = false
        return
    end if
    applyArtworkTransform()
    if not m.art.visible
        if cue.format = "l" and cue.layout <> "overlay"
            m.originalSize = [m.video.width, m.video.height]
            m.video.width = viewport.width * 0.75
            m.video.height = viewport.height * 0.75
        end if
        m.art.visible = true
    end if
    updateSceneFocus()
    if onScreen and m.sceneShown then reportImpression(cue, time)
    m.sceneShown = true
end sub

sub updateSceneFocus()
    if m.sceneFocus <> invalid
        if not m.sceneFocus.visible then m.sceneFocus = invalid
    end if
    if m.sceneFocus = invalid
        for each item in m.sceneActions
            if item.visible
                m.sceneFocus = item
                if m.top.commerceAutoFocus and not m.top.hasFocus()
                    m.previousCommerceFocus = previousFocusedNode()
                    m.top.setFocus(true)
                end if
                exit for
            end if
        end for
    end if
    for each item in m.sceneActions
        for each outline in item.focus
            outline.visible = false
        end for
    end for
    if m.sceneFocus <> invalid and not m.panel.visible
        for each outline in m.sceneFocus.focus
            outline.visible = true
        end for
    end if
end sub

function handleSceneKey(key as String) as Boolean
    if m.sceneFocus = invalid then return false
    if key = "ok"
        if m.sceneFocus.offer <> invalid
            m.scenePanelOffer = m.sceneFocus.offer
            showCommerce()
            m.commerceOpen = true
            trackProductView()
            renderCommerce()
            updateSceneFocus()
        else if m.sceneFocus.link <> invalid
            m.top.sceneLink = { id: m.active.id, sessionId: m.sessionId, url: m.sceneFocus.link }
        end if
        return true
    end if
    dx = 0
    dy = 0
    if key = "left" then dx = -1
    if key = "right" then dx = 1
    if key = "up" then dy = -1
    if key = "down" then dy = 1
    if dx = 0 and dy = 0 then return false
    target = invalid
    nearest = 1000000000
    for each item in m.sceneActions
        if item.visible
            x = (item.cx - m.sceneFocus.cx) / m.sceneBox.width
            y = (item.cy - m.sceneFocus.cy) / m.sceneBox.height
            forward = dx * x + dy * y
            across = abs(dx * y + dy * x)
            cost = forward + across * 2
            if forward > 0 and cost < nearest
                nearest = cost
                target = item
            end if
        end if
    end for
    if target <> invalid then m.sceneFocus = target
    updateSceneFocus()
    return true
end function

sub clearScene()
    if m.sceneEntries = invalid then return
    for each item in m.sceneEntries
        m.primary.removeChild(item.copies[0].layer)
        if item.copies.count() = 2 then m.secondary.removeChild(item.copies[1].layer)
    end for
    m.sceneEntries = invalid
    m.sceneActions = []
    m.sceneFocus = invalid
    m.scenePanelOffer = invalid
    m.sceneShown = false
end sub

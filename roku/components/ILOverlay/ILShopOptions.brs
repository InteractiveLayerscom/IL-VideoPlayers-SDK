function shopMap() as Object
    values = {}
    values.setModeCaseSensitive()
    return values
end function

' Missing, mixed, or ambiguous option grids fall back to the published SKU list.
function shopAxes(variants as Object) as Object
    axes = []
    tuples = shopMap()
    for each pair in variants[0].options
        axes.push({ name: pair.name, values: [], positions: shopMap() })
    end for
    if axes.count() = 0 then return []
    for each variant in variants
        if variant.options.count() <> axes.count() then return []
        options = shopMap()
        for each pair in variant.options
            if options.doesExist(pair.name) then return []
            options[pair.name] = pair.value
        end for
        variant.axisPositions = []
        tuple = []
        for each axis in axes
            if not options.doesExist(axis.name) then return []
            value = options[axis.name]
            if not axis.positions.doesExist(value)
                axis.positions[value] = axis.values.count()
                axis.values.push(value)
            end if
            slot = axis.positions[value]
            variant.axisPositions.push(slot)
            tuple.push(slot.toStr())
        end for
        signature = tuple.join("/")
        if tuples.doesExist(signature) then return []
        tuples[signature] = true
    end for
    return axes
end function

sub setupShop(offer as Object)
    m.shopAxes = shopAxes(offer.variants)
    m.shopPhotos = []
    m.shopPhotoIds = shopMap()
    addShopPhoto(offer.imageUrl)
    for each url in offer.images
        addShopPhoto(url)
    end for
    if m.shopPhotos.count() = 0 and m.active.format <> "midroll"
        videoPath = createObject("roRegex", "\.(mp4|m3u8|mov|webm)([?#]|$)", "i")
        if shopImage(m.active.imageUrl, m.commerceHTTPS, videoPath) then addShopPhoto(m.active.imageUrl)
    end if
    m.shopCoverPhoto = invalid
    if m.shopPhotos.count() > 0 then m.shopCoverPhoto = m.shopPhotos[0]
    m.shopAvailableCount = 0
    m.shopLowPrice = offer.price
    m.shopHighPrice = offer.price
    m.commerceChoice = 0
    found = false
    for i = 0 to offer.variants.count() - 1
        variant = offer.variants[i]
        addShopPhoto(variant.imageUrl)
        if variant.available
            price = shopPriceKey(variant.price)
            if m.shopAvailableCount = 0 or price < shopPriceKey(m.shopLowPrice) then m.shopLowPrice = variant.price
            if m.shopAvailableCount = 0 or price > shopPriceKey(m.shopHighPrice) then m.shopHighPrice = variant.price
            m.shopAvailableCount += 1
        end if
        if variant.available and not found
            found = true
            m.commerceChoice = i
        end if
    end for
    m.shopDefaultChoice = m.commerceChoice
    m.shopPhotoIndex = 0
    selectShopVariant(m.commerceChoice)
end sub

sub addShopPhoto(url as Dynamic)
    if not isText(url) then return
    if m.shopPhotoIds.doesExist(url) then return
    m.shopPhotoIds[url] = m.shopPhotos.count()
    m.shopPhotos.push(url)
end sub

function shopProductPhoto(variant as Object) as Dynamic
    if isText(variant.imageUrl) then return variant.imageUrl
    return m.shopCoverPhoto
end function

sub selectShopVariant(index as Integer)
    variants = currentOffer().variants
    selected = variants[index]
    m.commerceChoice = index
    m.shopRows = []
    if m.shopAxes.count() = 0
        row = { name: m.commerceLabels.variant, values: [], candidates: [], focus: index, selected: index }
        for i = 0 to variants.count() - 1
            row.values.push(variants[i].label)
            candidate = -1
            if variants[i].available then candidate = i
            row.candidates.push(candidate)
        end for
        m.shopRows.push(row)
        return
    end if
    ' Respect preceding option values; prefer a real SKU preserving later selections.
    for axisIndex = 0 to m.shopAxes.count() - 1
        axis = m.shopAxes[axisIndex]
        picked = selected.axisPositions[axisIndex]
        row = { name: axis.name, values: axis.values, candidates: [], focus: picked, selected: picked }
        scores = []
        for each value in axis.values
            row.candidates.push(-1)
            scores.push(-1)
        end for
        for i = 0 to variants.count() - 1
            variant = variants[i]
            if variant.available
                eligible = true
                score = 0
                for j = 0 to m.shopAxes.count() - 1
                    if variant.axisPositions[j] = selected.axisPositions[j]
                        score += 1
                    else if j < axisIndex
                        eligible = false
                    end if
                end for
                valueIndex = variant.axisPositions[axisIndex]
                if eligible and score > scores[valueIndex]
                    scores[valueIndex] = score
                    row.candidates[valueIndex] = i
                end if
            end if
        end for
        m.shopRows.push(row)
    end for
end sub

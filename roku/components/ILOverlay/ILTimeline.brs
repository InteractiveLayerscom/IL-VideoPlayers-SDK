function normalizeTimeline(items as Object) as Object
    result = []
    https = createObject("roRegex", "^https://([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(:[0-9]+)?([/?#][^\s]*)?$", "i")
    for each item in items
        cue = normalizeCue(item, https)
        if cue <> invalid then result.push(cue)
    end for
    return result
end function

function normalizeCue(item as Dynamic, https as Object) as Dynamic
    if type(item) <> "roAssociativeArray" then return invalid
    if not isText(item.id) or not isText(item.imageUrl) or not isText(item.format) then return invalid
    if item.id.trim() = "" or len(item.id) > 256 or not https.isMatch(item.imageUrl) then return invalid
    if item.format <> "super" and item.format <> "l" then return invalid
    if not validUnixMs(item.start) or not validUnixMs(item["end"]) then return invalid
    if item["end"] <= item.start then return invalid
    if item.mimeType <> invalid
        if not isText(item.mimeType) then return invalid
        if item.mimeType <> "image/png" and item.mimeType <> "image/jpeg" then return invalid
    end if
    cue = { id: item.id, format: item.format, imageUrl: item.imageUrl, start: item.start }
    cue["end"] = item["end"]
    if item.impressionUrl <> invalid
        if not isText(item.impressionUrl) then return invalid
        if not https.isMatch(item.impressionUrl) then return invalid
        cue.impressionUrl = item.impressionUrl
    end if
    return cue
end function

function isText(value as Dynamic) as Boolean
    return type(value) = "String" or type(value) = "roString"
end function

function isNumber(value as Dynamic) as Boolean
    name = lcase(type(value))
    if left(name, 2) = "ro" then name = mid(name, 3)
    return name = "int" or name = "integer" or name = "longinteger" or name = "float" or name = "double"
end function

function validUnixMs(value as Dynamic) as Boolean
    if not isNumber(value) then return false
    if not (value >= 0 and value <= 9007199254740991#) then return false
    whole& = value
    return whole& = value
end function

function isClockAnchor(anchor as Dynamic) as Boolean
    if type(anchor) <> "roAssociativeArray" then return false
    return isNumber(anchor.positionSeconds) and validUnixMs(anchor.programTimeMs) and isNumber(anchor.clipId)
end function

function programTimeMs(sample as Dynamic, anchor as Dynamic) as Dynamic
    if type(sample) <> "roAssociativeArray" then return invalid
    if not isNumber(sample.video) or not isNumber(sample.epoch) then return invalid
    if sample.video < 0 then return invalid
    if sample.epoch = 1 then return sample.video * 1000#
    if sample.epoch <> 0 or anchor = invalid then return invalid
    if sample.clip_id <> anchor.clipId then return invalid
    return anchor.programTimeMs + (sample.video - anchor.positionSeconds) * 1000#
end function

function activeCue(cues as Object, nowMs as Dynamic) as Dynamic
    if nowMs = invalid then return invalid
    for each cue in cues
        if nowMs >= cue.start and nowMs < cue["end"] then return cue
    end for
    return invalid
end function

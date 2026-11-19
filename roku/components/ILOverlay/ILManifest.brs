' Accept a complete snapshot of the active media rendition for this session.
' A master or a delta update lacks the full cue inventory for the playback window.
function readMediaPlaylist(text as String) as Dynamic
    lines = text.split(chr(10))
    if lines.count() = 0 or lines[0].trim() <> "#EXTM3U" then return invalid
    prefix = "#EXT-X-DATERANGE:"
    patterns = {
        attribute: createObject("roRegex", "^([A-Z0-9-]+)=(?:""([^""]*)""|([^,""\s]+))(,|$)", "")
        timestamp: createObject("roRegex", "^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]+))?(Z|([+-])([0-9]{2}):([0-9]{2}))$", "")
        duration: createObject("roRegex", "^([0-9]{1,13})(?:\.([0-9]+))?$", "")
    }
    media = false
    items = []
    for each raw in lines
        line = raw.trim()
        if line.inStr("#EXT-X-STREAM-INF:") = 0 or line.inStr("#EXT-X-I-FRAME-STREAM-INF:") = 0 or line.inStr("#EXT-X-SKIP:") = 0 then return invalid
        if line.inStr("#EXTINF:") = 0 or line.inStr("#EXT-X-PART:") = 0 then media = true
        if left(line, len(prefix)) = prefix
            attrs = parseAttributes(mid(line, len(prefix) + 1), patterns.attribute)
            if attrs <> invalid
                cue = cueFromAttributes(attrs, patterns)
                if cue <> invalid then items.push(cue)
            end if
        end if
    end for
    if not media then return invalid
    return items
end function

function parseAttributes(remaining as String, pattern as Object) as Dynamic
    attrs = {}
    attrs.setModeCaseSensitive()
    while remaining <> ""
        part = pattern.match(remaining)
        if part.count() = 0 then return invalid
        if attrs.doesExist(part[1]) then return invalid
        value = part[2]
        if not isText(value) or value = "" then value = part[3]
        if not isText(value) then value = ""
        attrs[part[1]] = value
        remaining = mid(remaining, len(part[0]) + 1)
        if remaining = "" and right(part[0], 1) = "," then return invalid
    end while
    return attrs
end function

function cueFromAttributes(attrs as Object, patterns as Object) as Dynamic
    if attrs["CLASS"] <> "com.interactivelayers.overlay" then return invalid
    startMs = parseUtcMs(attrs["START-DATE"], patterns.timestamp)
    if startMs = invalid then return invalid
    endMs = invalid
    if attrs.doesExist("END-DATE")
        endMs = parseUtcMs(attrs["END-DATE"], patterns.timestamp)
        if endMs = invalid then return invalid
    end if
    if attrs.doesExist("DURATION")
        duration = patterns.duration.match(attrs["DURATION"])
        if duration.count() = 0 then return invalid
        seconds = 0#
        for digitIndex = 1 to len(duration[1])
            seconds = seconds * 10# + val(mid(duration[1], digitIndex, 1))
        end for
        fraction = "0000"
        if isText(duration[2]) then fraction = left(duration[2] + "0000", 4)
        delta = seconds * 1000# + val(left(fraction, 3))
        if right(fraction, 1) >= "5" then delta = delta + 1#
        if endMs <> invalid and endMs <> startMs + delta then return invalid
        endMs = startMs + delta
    end if
    if endMs = invalid then return invalid
    cue = { id: attrs["ID"], format: attrs["X-IL-FORMAT"], imageUrl: attrs["X-ASSET-URI"], start: startMs }
    cue["end"] = endMs
    cue.mimeType = attrs["X-ASSET-MIMETYPE"]
    cue.impressionUrl = attrs["X-IL-IMPRESSION-URI"]
    return cue
end function

function parseUtcMs(value as Dynamic, pattern as Object) as Dynamic
    if not isText(value) then return invalid
    parts = pattern.match(value)
    if parts.count() = 0 then return invalid
    date = createObject("roDateTime")
    ' Roku parses the unzoned calendar portion as UTC. Apply the stated offset explicitly.
    date.fromISO8601String(parts[1])
    if left(date.toISOString(), 19) <> parts[1] then return invalid
    offset = 0
    if parts[3] <> "Z"
        hours = val(parts[5])
        minutes = val(parts[6])
        if hours > 23 or minutes > 59 then return invalid
        offset = (hours * 60 + minutes) * 60
        if parts[4] = "-" then offset = -offset
    end if
    fraction = 0
    if isText(parts[2]) then fraction = val(left(parts[2] + "000", 3))
    return (date.asSecondsLong() - offset) * 1000# + fraction
end function

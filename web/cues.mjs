// Publisher-facing cue profile. All times outside the player adapters are Unix milliseconds.
export const cueClass = 'com.interactivelayers.overlay';
const types = new Set(['image/png', 'image/jpeg']);
const prefix = '#EXT-X-DATERANGE:';

function https(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function normalizeCue(item) {
  if (
    !item ||
    typeof item.id !== 'string' ||
    !item.id.trim() ||
    item.id.length > 256 ||
    !['super', 'l'].includes(item.format) ||
    !Number.isSafeInteger(item.start) ||
    !Number.isSafeInteger(item.end) ||
    item.start < 0 ||
    item.end <= item.start ||
    !https(item.imageUrl) ||
    (item.impressionUrl != null && !https(item.impressionUrl))
  )
    return null;
  const mimeType =
    item.mimeType ??
    (/\.jpe?g$/i.test(new URL(item.imageUrl).pathname) ? 'image/jpeg' : 'image/png');
  if (!types.has(mimeType)) return null;
  return {
    id: item.id,
    format: item.format,
    start: item.start,
    end: item.end,
    imageUrl: item.imageUrl,
    mimeType,
    impressionUrl: item.impressionUrl ?? null,
  };
}

// HLS quoted attribute values may themselves contain commas and equals signs.
function attributes(line) {
  const fields = Object.create(null);
  const pattern = /([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,"\s]+))(,|$)/gy;
  while (pattern.lastIndex < line.length) {
    const match = pattern.exec(line);
    if (!match || Object.prototype.hasOwnProperty.call(fields, match[1])) return null;
    fields[match[1]] = match[2] ?? match[3];
    if (!match[4]) break;
    if (pattern.lastIndex === line.length) return null;
  }
  return fields;
}

function timestamp(text) {
  return typeof text === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(text)
    ? Date.parse(text)
    : NaN;
}

export function readDateRanges(playlist) {
  const result = [];
  for (const line of playlist.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const a = attributes(line.slice(prefix.length));
    if (!a || a.CLASS !== cueClass) continue;
    const start = timestamp(a['START-DATE']);
    const duration = /^\d+(?:\.\d+)?$/.test(a.DURATION)
      ? Math.round(Number(a.DURATION) * 1000)
      : NaN;
    const end = a['END-DATE'] === undefined ? start + duration : timestamp(a['END-DATE']);
    if (a.DURATION !== undefined && end !== start + duration) continue;
    const cue = normalizeCue({
      id: a.ID,
      format: a['X-IL-FORMAT'],
      start,
      end,
      imageUrl: a['X-ASSET-URI'],
      mimeType: a['X-ASSET-MIMETYPE'],
      impressionUrl: a['X-IL-IMPRESSION-URI'],
    });
    if (cue) result.push(cue);
  }
  return result;
}

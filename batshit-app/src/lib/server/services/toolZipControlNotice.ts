/**
 * Keeps a `batshitZipControl` marker out of a stored tool result.
 *
 * Batshit itself no longer writes one. The managed CLI helper bridge used to mint a zip id
 * per result and hand it to the model here, but `send-routed` writes the zip under the id
 * it reserved when the tool CALL arrived, so the announced id named a zip that was never
 * saved (F-P4-9). Current-response tool results are addressed with `tool_result_N` aliases
 * on every lane; older zips keep their real ids.
 *
 * The strip stays because the marker is Batshit-shaped and a tool result is untrusted input:
 * a user-installed MCP server can put one in its own output, and that must never reach
 * compiled history or a zip where it could read as Batshit's own control data.
 */
const ZIP_CONTROL_KEYS = new Set([
  'batshitZipControl',
  'batshit_zip_control',
  '_batshitZipControl',
  '_batshit_zip_control'
])

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function hasMarkerText(value: string): boolean {
  return value.includes('batshitZipControl') || value.includes('batshit_zip_control')
}

function hasZipControlMarker(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (depth > 8 || value == null) return false

  if (typeof value === 'string') return hasMarkerText(value)

  if (Array.isArray(value)) {
    return value.some((item) => hasZipControlMarker(item, depth + 1, seen))
  }

  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)

  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (ZIP_CONTROL_KEYS.has(key)) return true
    if (hasZipControlMarker(record[key], depth + 1, seen)) return true
  }
  return false
}

function stripZipControlMarkers(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8 || value == null) return value

  if (typeof value === 'string') {
    if (!hasMarkerText(value)) return value
    const parsed = tryParseJson(value)
    if (parsed === undefined) return value
    const stripped = stripZipControlMarkers(parsed, depth + 1, seen)
    return JSON.stringify(stripped, null, 2)
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripZipControlMarkers(item, depth + 1, seen))
  }

  if (typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)

  const record = value as Record<string, unknown>
  const stripped: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(record)) {
    if (ZIP_CONTROL_KEYS.has(key)) continue
    stripped[key] = stripZipControlMarkers(nested, depth + 1, seen)
  }
  return stripped
}

/**
 * Returns the tool result with any `batshitZipControl` marker removed, at any depth and
 * inside JSON strings.
 *
 * A result with no marker is returned BY IDENTITY and is never rebuilt: the rebuild turns
 * every object into a plain object, which would flatten a Buffer or a class instance in an
 * ordinary tool result. Only a result that actually carries a marker pays that cost.
 */
export function stripToolZipControl<T>(value: T): T {
  if (!hasZipControlMarker(value)) return value
  return stripZipControlMarkers(value) as T
}

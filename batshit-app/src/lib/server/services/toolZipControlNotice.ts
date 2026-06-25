const ZIP_CONTROL_KEYS = new Set([
  'batshitZipControl',
  'batshit_zip_control',
  '_batshitZipControl',
  '_batshit_zip_control'
])

const RESERVED_ZIP_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*_\d{10,17}_[a-z0-9]{5,12}$/

export function isReservedToolZipId(value: unknown): value is string {
  return typeof value === 'string' && RESERVED_ZIP_ID_PATTERN.test(value.trim())
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function extractZipIdFromControl(value: unknown): string | undefined {
  if (isReservedToolZipId(value)) return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const record = value as Record<string, unknown>
  const zipId = record.zipId ?? record.zip_id
  return isReservedToolZipId(zipId) ? zipId.trim() : undefined
}

export function extractReservedZipIdFromToolResult(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): string | undefined {
  if (depth > 8 || value == null) return undefined

  if (typeof value === 'string') {
    if (!value.includes('batshitZipControl') && !value.includes('batshit_zip_control')) {
      return undefined
    }
    const parsed = tryParseJson(value)
    return parsed === undefined
      ? undefined
      : extractReservedZipIdFromToolResult(parsed, depth + 1, seen)
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const zipId = extractReservedZipIdFromToolResult(item, depth + 1, seen)
      if (zipId) return zipId
    }
    return undefined
  }

  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return undefined
  seen.add(value)

  const record = value as Record<string, unknown>
  for (const key of ZIP_CONTROL_KEYS) {
    if (!(key in record)) continue
    const zipId = extractZipIdFromControl(record[key])
    if (zipId) return zipId
  }

  for (const nested of Object.values(record)) {
    const zipId = extractReservedZipIdFromToolResult(nested, depth + 1, seen)
    if (zipId) return zipId
  }

  return undefined
}

function stripZipControlMarkers(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8 || value == null) return value

  if (typeof value === 'string') {
    if (!value.includes('batshitZipControl') && !value.includes('batshit_zip_control')) {
      return value
    }
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

export function extractAndStripToolZipControl<T>(value: T): {
  zipId?: string
  value: T
} {
  const zipId = extractReservedZipIdFromToolResult(value)
  if (!zipId) return { value }
  return {
    zipId,
    value: stripZipControlMarkers(value) as T
  }
}

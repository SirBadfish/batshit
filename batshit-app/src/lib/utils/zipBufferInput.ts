export const DEFAULT_MAX_ZIP_BUFFER = 50
export const MAX_ZIP_THRESHOLD = 100000

export function normalizeZipBufferInputValue(
  value: string,
  min: number,
  max = DEFAULT_MAX_ZIP_BUFFER
): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''

  const numeric = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(numeric)) {
    return String(min)
  }

  return String(Math.min(Math.max(numeric, min), max))
}

export function normalizeZipThresholdInputValue(
  value: string,
  max = MAX_ZIP_THRESHOLD
): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''

  const numeric = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(numeric)) {
    return '0'
  }

  return String(Math.min(Math.max(numeric, 0), max))
}

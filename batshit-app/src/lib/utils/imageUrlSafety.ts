const DISPLAY_PROTOCOLS = new Set(['http:', 'https:', 'data:', 'blob:'])
const OPEN_URL_PROTOCOLS = new Set(['http:', 'https:', 'blob:'])

function isLikelyFilesystemPath(value: string): boolean {
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()

  if (!trimmed) return false
  if (/^[a-z]:[\\/]/i.test(trimmed)) return true
  if (lower.startsWith('\\\\')) return true
  if (lower.startsWith('file://')) return true
  if (
    lower.startsWith('/var/') ||
    lower.startsWith('/private/') ||
    lower.startsWith('/tmp/') ||
    lower.startsWith('/users/') ||
    lower.startsWith('/volumes/') ||
    lower.startsWith('/home/') ||
    lower.startsWith('/root/')
  ) {
    return true
  }
  return false
}

function parsedProtocol(value: string, baseUrl: string): string | null {
  try {
    return new URL(value.trim(), baseUrl).protocol
  } catch {
    return null
  }
}

/** Keep display support for data images while rejecting browser-normalized script schemes. */
export function isUnsupportedImageScheme(value: string | null | undefined, baseUrl: string): boolean {
  if (!value || typeof value !== 'string') return false
  if (isLikelyFilesystemPath(value)) return true
  const protocol = parsedProtocol(value, baseUrl)
  return protocol === null || !DISPLAY_PROTOCOLS.has(protocol)
}

/** A failed image may navigate only to a normal web or blob URL. */
export function isOpenableFailedImageUrl(value: string | null | undefined, baseUrl: string): boolean {
  if (!value || typeof value !== 'string' || isLikelyFilesystemPath(value)) return false
  const protocol = parsedProtocol(value, baseUrl)
  return protocol !== null && OPEN_URL_PROTOCOLS.has(protocol)
}

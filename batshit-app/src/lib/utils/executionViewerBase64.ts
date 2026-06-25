export interface ExecutionViewerBase64TruncationOptions {
  enabled?: boolean
  visibleChars?: number
  minBase64Chars?: number
  maxDepth?: number
}

const DEFAULT_VISIBLE_CHARS = 15
const DEFAULT_MIN_BASE64_CHARS = 96
const DEFAULT_MAX_DEPTH = 20
const DATA_URL_BASE64_PATTERN =
  /\b(data:[^,\s"'`<>]{0,160};base64,)([A-Za-z0-9+/_-]+={0,2})/gi
const RAW_BASE64_TOKEN_PATTERN =
  /(^|[^A-Za-z0-9+/_=-])([A-Za-z0-9+/_-]{32,}={0,2})(?=$|[^A-Za-z0-9+/_=-])/g

function resolveVisibleChars(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_VISIBLE_CHARS
  return Math.max(4, Math.min(64, Math.trunc(value)))
}

function resolveMinBase64Chars(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MIN_BASE64_CHARS
  return Math.max(32, Math.trunc(value))
}

function formatTruncatedToken(token: string, visibleChars: number): string {
  return `${token.slice(0, visibleChars)}... [base64 truncated, ${token.length.toLocaleString(
    'en-US'
  )} chars]`
}

function looksLikeLongBase64Token(token: string, minBase64Chars: number): boolean {
  if (token.length < minBase64Chars) return false

  const paddingLength = token.length - token.replace(/=+$/, '').length
  if (paddingLength > 2) return false

  const withoutPadding = token.replace(/=+$/, '')
  if (withoutPadding.length % 4 === 1) return false

  const hasBase64Symbol = /[+/_-]/.test(withoutPadding)
  const hasUppercase = /[A-Z]/.test(withoutPadding)

  return hasBase64Symbol || hasUppercase
}

export function truncateExecutionViewerBase64(
  input: string,
  options: ExecutionViewerBase64TruncationOptions = {}
): string {
  if (options.enabled === false || input.length === 0) return input

  const visibleChars = resolveVisibleChars(options.visibleChars)
  const minBase64Chars = resolveMinBase64Chars(options.minBase64Chars)

  const withDataUrlsTruncated = input.replace(
    DATA_URL_BASE64_PATTERN,
    (match, prefix: string, token: string) => {
      if (token.length < minBase64Chars) return match
      return `${prefix}${formatTruncatedToken(token, visibleChars)}`
    }
  )

  return withDataUrlsTruncated.replace(
    RAW_BASE64_TOKEN_PATTERN,
    (match, prefix: string, token: string) => {
      if (!looksLikeLongBase64Token(token, minBase64Chars)) return match
      return `${prefix}${formatTruncatedToken(token, visibleChars)}`
    }
  )
}

export function truncateExecutionViewerBase64InValue<T>(
  value: T,
  options: ExecutionViewerBase64TruncationOptions = {}
): T {
  if (options.enabled === false) return value

  const maxDepth =
    typeof options.maxDepth === 'number' && Number.isFinite(options.maxDepth)
      ? Math.max(1, Math.trunc(options.maxDepth))
      : DEFAULT_MAX_DEPTH
  const seen = new WeakMap<object, unknown>()

  const visit = (entry: unknown, depth: number): unknown => {
    if (typeof entry === 'string') {
      return truncateExecutionViewerBase64(entry, options)
    }

    if (!entry || typeof entry !== 'object') return entry
    if (depth >= maxDepth) return entry
    if (seen.has(entry)) return seen.get(entry)

    if (Array.isArray(entry)) {
      const next: unknown[] = []
      let changed = false
      seen.set(entry, next)

      for (const item of entry) {
        const visited = visit(item, depth + 1)
        next.push(visited)
        if (visited !== item) changed = true
      }

      return changed ? next : entry
    }

    const prototype = Object.getPrototypeOf(entry)
    if (prototype !== Object.prototype && prototype !== null) return entry

    const source = entry as Record<string, unknown>
    const next: Record<string, unknown> = {}
    let changed = false
    seen.set(entry, next)

    for (const [key, item] of Object.entries(source)) {
      const visited = visit(item, depth + 1)
      next[key] = visited
      if (visited !== item) changed = true
    }

    return changed ? next : entry
  }

  return visit(value, 0) as T
}

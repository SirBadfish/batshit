const BASE_SUSPICIOUS_INPUT_PATTERNS = [
  /[;<>]/,
  /\$\{.*\}/,
  /\{\{.*\}\}/,
  /javascript:/i,
  /\.\.\//,
  /<script/i
]

const SQL_KEYWORD_PATTERNS = [
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
  /UPDATE\s+SET/i,
  /INSERT\s+INTO/i
]

interface SuspiciousInputOptions {
  sqlKeywords?: boolean
}

interface NormalizeHttpBaseUrlOptions {
  label?: string
  fallback?: string
}

export function containsSuspiciousInput(
  value: string,
  options: SuspiciousInputOptions = {}
): boolean {
  const patterns = options.sqlKeywords
    ? [...BASE_SUSPICIOUS_INPUT_PATTERNS, ...SQL_KEYWORD_PATTERNS]
    : BASE_SUSPICIOUS_INPUT_PATTERNS

  return patterns.some((pattern) => pattern.test(value))
}

export function normalizeHttpBaseUrl(
  value: string,
  options: NormalizeHttpBaseUrlOptions = {}
): string {
  const label = options.label ?? 'Base URL'
  const trimmed = value.trim()
  if (!trimmed) {
    if (options.fallback !== undefined) return options.fallback
    throw new Error(`${label} is required`)
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`${label} must start with http or https`)
  }
  if (containsSuspiciousInput(trimmed)) {
    throw new Error(`${label} contains invalid characters`)
  }
  return trimmed.replace(/\/+$/, '')
}

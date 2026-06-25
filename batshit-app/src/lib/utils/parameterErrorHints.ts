import type { CompatibilityConstraint, MatrixConnectionId } from '$lib/types/compatibilityMatrix'

export interface ParsedParameterError {
  message: string
  parameter?: string
  constraint?: CompatibilityConstraint
  detail?: string
}

type ToastContext = {
  provider?: string | null
  connection?: MatrixConnectionId | null
  model?: string | null
}

const PARAMETER_PATTERNS: RegExp[] = [
  /parameter\s+['"`]([a-zA-Z0-9_.-]+)['"`]/i,
  /\bparam(?:eter)?\b\s*[:=]\s*['"`]?([a-zA-Z0-9_.-]+)['"`]?/i,
  /\bfield\s+['"`]?([a-zA-Z0-9_.-]+)['"`]?/i,
  /['"`]([a-zA-Z0-9_.-]+)['"`]\s+(?:is|was)?\s*(?:invalid|unsupported|not allowed)/i
]

const MIN_PATTERNS: RegExp[] = [
  /(?:must be|needs to be|should be|has to be)\s*(?:>=|at least|min(?:imum)?(?: value)?(?: of)?)[\s:]*([0-9]+(?:\.[0-9]+)?)/i,
  /minimum(?: value)?(?: of)?\s*([0-9]+(?:\.[0-9]+)?)/i,
  /min(?:imum)?\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)/i
]

const MAX_PATTERNS: RegExp[] = [
  /(?:must be|needs to be|should be|has to be)\s*(?:<=|at most|max(?:imum)?(?: value)?(?: of)?)[\s:]*([0-9]+(?:\.[0-9]+)?)/i,
  /maximum(?: value)?(?: of)?\s*([0-9]+(?:\.[0-9]+)?)/i,
  /max(?:imum)?\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)/i
]

const ALLOWED_PATTERNS: RegExp[] = [
  /(?:must be one of|allowed values?|supported values?)[:\s]+([A-Za-z0-9_.,\s-]+)/i,
  /(?:expected one of|valid options?)[:\s]+([A-Za-z0-9_.,\s-]+)/i
]

function extractFirstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return match[1].trim()
    }
  }
  return null
}

function parseNumber(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseAllowedList(value: string | null): string[] | null {
  if (!value) return null
  const cleaned = value.replace(/[()[\]{}]/g, '')
  const items = cleaned
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length ? items : null
}

function fallbackParameterGuess(message: string): string | null {
  const quoted = message.match(/['"`]([a-zA-Z0-9_.-]+)['"`]/)
  if (quoted?.[1]) return quoted[1]
  return null
}

export function parseParameterError(message: string): ParsedParameterError | null {
  if (!message) return null
  const cleaned = message.replace(/\s+/g, ' ').trim()
  if (!cleaned) return null

  const hasParameterSignal =
    /\bparam(?:eter)?\b/i.test(cleaned) ||
    /\bfield\b/i.test(cleaned) ||
    /\b(?:unsupported|invalid|not allowed|rejected)\b/i.test(cleaned)
  if (!hasParameterSignal) return null

  const parameter =
    extractFirstMatch(cleaned, PARAMETER_PATTERNS) ||
    fallbackParameterGuess(cleaned) ||
    undefined

  const min = parseNumber(extractFirstMatch(cleaned, MIN_PATTERNS))
  const max = parseNumber(extractFirstMatch(cleaned, MAX_PATTERNS))
  const allowed = parseAllowedList(extractFirstMatch(cleaned, ALLOWED_PATTERNS))

  const constraint: CompatibilityConstraint = {}
  if (min !== null) constraint.min = min
  if (max !== null) constraint.max = max
  if (allowed) constraint.allowed = allowed

  if (
    !parameter &&
    Object.keys(constraint).length === 0 &&
    !/\bparam(?:eter)?\b/i.test(cleaned)
  ) {
    return null
  }

  return {
    message: cleaned,
    parameter,
    constraint: Object.keys(constraint).length ? constraint : undefined
  }
}

export function buildParameterErrorToast(
  parsed: ParsedParameterError,
  context?: ToastContext
): { title: string; description: string } {
  const parameterLabel = parsed.parameter ? `\`${parsed.parameter}\`` : 'This parameter'
  const providerLabel = context?.provider ? ` for ${context.provider}` : ''
  const modelLabel = context?.model ? ` (${context.model})` : ''

  if (parsed.constraint?.allowed?.length) {
    return {
      title: 'Parameter rejected',
      description: `${parameterLabel} must be one of ${parsed.constraint.allowed.join(', ')}${providerLabel}${modelLabel}.`
    }
  }

  if (typeof parsed.constraint?.min === 'number' || typeof parsed.constraint?.max === 'number') {
    const minPart =
      typeof parsed.constraint?.min === 'number' ? `≥ ${parsed.constraint.min}` : null
    const maxPart =
      typeof parsed.constraint?.max === 'number' ? `≤ ${parsed.constraint.max}` : null
    const range = [minPart, maxPart].filter(Boolean).join(' and ')
    return {
      title: 'Parameter rejected',
      description: `${parameterLabel} must be ${range}${providerLabel}${modelLabel}.`
    }
  }

  return {
    title: 'Parameter rejected',
    description: `${parameterLabel} was rejected${providerLabel}${modelLabel}.`
  }
}

export interface SchemaHintCaps {
  requiredLimit: number
  optionalLimit: number
  maxChars: number
}

export interface SchemaSummary {
  required: string[]
  optional: string[]
  requiredCount: number
  optionalCount: number
  truncated: boolean
  note?: string
  text?: string
}

function normalizeType(prop: any): string {
  if (!prop || typeof prop !== 'object') return 'any'
  const rawType = prop.type
  if (Array.isArray(rawType) && rawType.length) {
    return rawType.map((entry) => String(entry)).join('|')
  }
  if (typeof rawType === 'string' && rawType.trim().length > 0) {
    return rawType
  }
  if (prop.anyOf) return 'any'
  if (prop.oneOf) return 'oneOf'
  if (prop.allOf) return 'allOf'
  return 'any'
}

function buildEntries(schema: any): { required: string[]; optional: string[] } {
  if (!schema || typeof schema !== 'object') {
    return { required: [], optional: [] }
  }

  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {}
  const requiredList = Array.isArray(schema.required)
    ? schema.required.map((value: unknown) => String(value))
    : []

  const requiredEntries: string[] = []
  const optionalEntries: string[] = []

  for (const [key, raw] of Object.entries(properties)) {
    const type = normalizeType(raw)
    const entry = `${key}:${type}`
    if (requiredList.includes(key)) {
      requiredEntries.push(entry)
    } else {
      optionalEntries.push(entry)
    }
  }

  return { required: requiredEntries, optional: optionalEntries }
}

export function formatSchemaSummary(summary: SchemaSummary): string {
  if (summary.note && summary.required.length === 0 && summary.optional.length === 0) {
    return summary.note
  }

  const parts: string[] = []
  if (summary.required.length > 0) {
    const remaining = summary.requiredCount - summary.required.length
    const suffix = remaining > 0 ? ` (+${remaining} more)` : ''
    parts.push(`required: ${summary.required.join(', ')}${suffix}`)
  }
  if (summary.optional.length > 0) {
    const remaining = summary.optionalCount - summary.optional.length
    const suffix = remaining > 0 ? ` (+${remaining} more)` : ''
    parts.push(`optional: ${summary.optional.join(', ')}${suffix}`)
  }

  const base = parts.join(' · ')
  if (summary.note) {
    return base ? `${base} · ${summary.note}` : summary.note
  }
  return base
}

export function buildSchemaSummary(
  schema: any,
  caps: SchemaHintCaps
): SchemaSummary | null {
  if (!schema || typeof schema !== 'object') {
    return null
  }

  const { required, optional } = buildEntries(schema)
  const requiredCount = required.length
  const optionalCount = optional.length

  if (requiredCount === 0 && optionalCount === 0) {
    return null
  }

  let requiredEntries = required.slice(0, caps.requiredLimit)
  let optionalEntries = optional.slice(0, caps.optionalLimit)

  let summary: SchemaSummary = {
    required: requiredEntries,
    optional: optionalEntries,
    requiredCount,
    optionalCount,
    truncated: optionalEntries.length < optionalCount
  }

  let text = formatSchemaSummary(summary)

  if (caps.maxChars > 0 && text.length > caps.maxChars) {
    while (optionalEntries.length > 0 && text.length > caps.maxChars) {
      optionalEntries = optionalEntries.slice(0, -1)
      summary = {
        required: requiredEntries,
        optional: optionalEntries,
        requiredCount,
        optionalCount,
        truncated: true
      }
      text = formatSchemaSummary(summary)
    }
  }

  if (caps.maxChars > 0 && text.length > caps.maxChars) {
    return null
  }

  summary.text = text
  return summary
}

export function getSchemaHintText(summary: SchemaSummary | null): string | null {
  if (!summary) return null
  if (summary.text) return summary.text
  return formatSchemaSummary(summary)
}

export function getDefaultSchemaHintCaps(): SchemaHintCaps {
  return {
    requiredLimit: 6,
    optionalLimit: 6,
    maxChars: 240
  }
}

export function normalizeSchemaHintCaps(raw?: Partial<SchemaHintCaps> | null): SchemaHintCaps {
  const defaults = getDefaultSchemaHintCaps()
  if (!raw) return defaults

  const toNumber = (value: any, fallback: number) => {
    const parsed = typeof value === 'number' ? value : parseInt(String(value), 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

  return {
    requiredLimit: clamp(toNumber(raw.requiredLimit, defaults.requiredLimit), 1, 20),
    optionalLimit: clamp(toNumber(raw.optionalLimit, defaults.optionalLimit), 0, 20),
    maxChars: clamp(toNumber(raw.maxChars, defaults.maxChars), 80, 1000)
  }
}

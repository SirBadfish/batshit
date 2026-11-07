import {
  DEFAULT_DCM_SCHEMA_HINT_REQUIRED_LIMIT,
  DEFAULT_DCM_SCHEMA_HINT_OPTIONAL_LIMIT,
  DEFAULT_DCM_SCHEMA_HINT_MAX_CHARS
} from '$lib/utils/dynamicSchemaHintSettings'
import { setupMetadata } from './agentSetupCache'

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

export interface SchemaHintFields {
  required: readonly string[]
  optional: readonly string[]
  note?: string
}

function normalizeType(prop: any): string {
  if (!prop || typeof prop !== 'object') return 'any'
  let type = 'any'
  if (Object.hasOwn(prop, 'const')) type = setupMetadata(JSON.stringify(prop.const))
  else if (Array.isArray(prop.enum) && prop.enum.length > 0 &&
    prop.enum.every((value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value))) {
    const values = prop.enum.map((value: unknown) =>
      typeof value === 'string' && /^[a-zA-Z0-9_.-]+$/.test(value) ? value : JSON.stringify(value)).join('|')
    type = setupMetadata(values)
  } else if (Array.isArray(prop.type) && prop.type.length) type = prop.type.map(setupMetadata).join('|')
  else if (typeof prop.type === 'string' && prop.type.trim()) {
    type = prop.type === 'array' && prop.items ? `array<${normalizeType(prop.items)}>` : setupMetadata(prop.type)
  }
  const incomplete = prop.$ref || prop.anyOf || prop.oneOf || prop.allOf || prop.if ||
    prop.properties || prop.required?.length || prop.additionalProperties && typeof prop.additionalProperties === 'object'
  return `${type}${incomplete ? ' (full schema)' : ''}`
}

function buildEntries(schema: any): { required: string[]; optional: string[] } {
  if (!schema || typeof schema !== 'object') {
    return { required: [], optional: [] }
  }

  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {}
  const requiredList: string[] = Array.isArray(schema.required)
    ? schema.required.filter((value: unknown): value is string => typeof value === 'string')
    : []

  const requiredEntries: string[] = []
  const optionalEntries: string[] = []

  for (const [key, raw] of Object.entries(properties)) {
    const type = normalizeType(raw)
    const facts: string[] = []
    for (const [keyword, label] of [['minimum', 'min'], ['maximum', 'max'], ['minLength', 'min chars'],
      ['maxLength', 'max chars'], ['minItems', 'min items'], ['maxItems', 'max items']] as const) {
      if (typeof (raw as any)?.[keyword] === 'number') facts.push(`${label} ${(raw as any)[keyword]}`)
    }
    if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'default')) facts.push(`default ${setupMetadata(JSON.stringify((raw as any).default))}`)
    const entry = `${setupMetadata(key)}:${type}${facts.length ? ` (${facts.join('; ')})` : ''}`
    if (requiredList.includes(key)) {
      requiredEntries.push(entry)
    } else {
      optionalEntries.push(entry)
    }
  }

  for (const key of new Set(requiredList)) {
    if (typeof key === 'string' && !Object.hasOwn(properties, key)) requiredEntries.push(`${setupMetadata(key)}:unknown (full schema)`)
  }

  return { required: requiredEntries, optional: optionalEntries }
}

export function formatSchemaSummary(summary: SchemaSummary): string {
  if (summary.note && summary.requiredCount === 0 && summary.optionalCount === 0) {
    return summary.note
  }

  const parts: string[] = []
  if (summary.required.length > 0) {
    const remaining = summary.requiredCount - summary.required.length
    const suffix = remaining > 0 ? ` (+${remaining} more; full schema)` : ''
    parts.push(`required: ${summary.required.join(', ')}${suffix}`)
  } else if (summary.requiredCount > 0) parts.push(`required: ${summary.requiredCount} fields (full schema)`)
  if (summary.optional.length > 0) {
    const remaining = summary.optionalCount - summary.optional.length
    const suffix = remaining > 0 ? ` (+${remaining} more; full schema)` : ''
    parts.push(`optional: ${summary.optional.join(', ')}${suffix}`)
  } else if (summary.optionalCount > 0) parts.push(`optional: ${summary.optionalCount} fields (full schema)`)

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

  const malformedRequired = schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((value: unknown) => typeof value !== 'string'))
  const conditional = schema.anyOf || schema.oneOf || schema.allOf || schema.dependentRequired || schema.if || schema.$ref
  if (requiredCount === 0 && optionalCount === 0 && !conditional && !malformedRequired) return null

  return buildSchemaHintSummary({ required, optional,
    ...(malformedRequired ? { note: 'required metadata unavailable: full schema' } : conditional ? { note: 'conditional requirements: full schema' } : {}) }, caps)
}

/** Authored field facts use the same field and character caps as generated schemas. */
export function buildSchemaHintSummary(fields: SchemaHintFields, caps: SchemaHintCaps): SchemaSummary {
  const { required, optional } = fields
  const requiredCount = required.length, optionalCount = optional.length

  let requiredEntries = required.slice(0, caps.requiredLimit)
  let optionalEntries = optional.slice(0, caps.optionalLimit)

  let summary: SchemaSummary = {
    required: requiredEntries,
    optional: optionalEntries,
    requiredCount,
    optionalCount,
    truncated: requiredEntries.length < requiredCount || optionalEntries.length < optionalCount,
    ...(fields.note ? { note: fields.note } : {})
  }

  let text = formatSchemaSummary(summary)

  if (caps.maxChars > 0 && text.length > caps.maxChars) {
    while (optionalEntries.length > 0 && text.length > caps.maxChars) {
      optionalEntries = optionalEntries.slice(0, -1)
      summary = { ...summary, optional: optionalEntries, truncated: true }
      text = formatSchemaSummary(summary)
    }
  }

  while (caps.maxChars > 0 && text.length > caps.maxChars && requiredEntries.length > 0) {
    requiredEntries = requiredEntries.slice(0, -1)
    summary = { ...summary, required: requiredEntries, truncated: true }
    text = formatSchemaSummary(summary)
  }
  if (caps.maxChars > 0 && text.length > caps.maxChars) {
    summary = { ...summary, note: 'full schema required', truncated: true }
    text = summary.note!
  }

  summary.text = text
  return summary
}

export function getSchemaHintText(summary: SchemaSummary | null): string | null {
  if (!summary) return null
  if (summary.text) return summary.text
  return formatSchemaSummary(summary)
}

/** CLI manifests also permit required:true on an individual field. */
export function formatCliSchemaHint(schema: any, caps: SchemaHintCaps = getDefaultSchemaHintCaps()): string {
  if (!schema || typeof schema !== 'object') return ''
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : [])
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    if ((field as any)?.required === true) required.add(key)
  }
  return getSchemaHintText(buildSchemaSummary({ ...schema, required: [...required] }, caps)) ?? ''
}

export function getDefaultSchemaHintCaps(): SchemaHintCaps {
  return {
    requiredLimit: DEFAULT_DCM_SCHEMA_HINT_REQUIRED_LIMIT,
    optionalLimit: DEFAULT_DCM_SCHEMA_HINT_OPTIONAL_LIMIT,
    maxChars: DEFAULT_DCM_SCHEMA_HINT_MAX_CHARS
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

const MAX_SCHEMA_SUMMARY_LENGTH = 220

type ControlPropertyDescriptor = {
  type?: string | string[]
  enum?: Array<string | number>
}

export function summarizeControlInputSchema(schema?: Record<string, any> | null): string | null {
  if (!schema || typeof schema !== 'object') return null
  const properties = schema.properties
  if (!properties || typeof properties !== 'object') return null

  const entries: string[] = []
  for (const [key, descriptor] of Object.entries(properties)) {
    if (!key) continue
    const desc = (descriptor as ControlPropertyDescriptor) ?? {}
    const typeDescriptor = Array.isArray(desc.type)
      ? desc.type.filter(Boolean).join('|')
      : typeof desc.type === 'string'
        ? desc.type
        : 'any'
    const enumValues = Array.isArray(desc.enum) && desc.enum.length > 0
      ? desc.enum.map((value) => String(value)).join('/')
      : null
    const parts: string[] = []
    if (typeDescriptor) parts.push(typeDescriptor)
    if (enumValues) parts.push(`enum=${enumValues}`)
    const entry = parts.length ? `${key}: ${parts.join(' ')}` : key
    entries.push(entry)
  }

  if (entries.length === 0) return null
  const summary = entries.join('; ')
  return summary.length > MAX_SCHEMA_SUMMARY_LENGTH ? `${summary.slice(0, MAX_SCHEMA_SUMMARY_LENGTH)}…` : summary
}

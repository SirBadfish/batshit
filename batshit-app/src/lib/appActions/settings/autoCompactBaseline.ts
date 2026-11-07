import { AUTO_COMPACT_COMMON_FIELDS, validAutoCompactField } from './autoCompactPreferences'
export { AUTO_COMPACT_COMMON_FIELDS } from './autoCompactPreferences'

/** Request precondition only, never a stored field or an authority grant. */
export const AUTO_COMPACT_REVISION_HEADER = 'X-Batshit-Auto-Compact-Revision'
export type AutoCompactBaseline = Readonly<{
  id: string
  type: 'api'
  token: string
  group: Readonly<{ parent: 'absent' | 'null' | 'object'; mode?: unknown; triggerMode?: unknown; remainingTokens?: unknown }>
}>

export function isAutoCompactRevision(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

/** Fixed common raw facts only; advanced/model/prompt values never enter this snapshot. */
export function captureAutoCompactBaseline(row: Record<string, unknown>, header: unknown): AutoCompactBaseline | null {
  if (!isAutoCompactRevision(header) || typeof row.id !== 'string' || !row.id || row.agentType !== 'api') return null
  const block = row.auto_compact_settings
  if (Object.hasOwn(row, 'auto_compact_settings') && block !== null && (!block || typeof block !== 'object' || Array.isArray(block))) return null
  const raw = block as Record<string, unknown> | null | undefined
  if (raw && AUTO_COMPACT_COMMON_FIELDS.some(field => Object.hasOwn(raw, field) && !validAutoCompactField(field, raw[field]))) return null
  const group = Object.freeze({
    parent: !Object.hasOwn(row, 'auto_compact_settings') ? 'absent' as const : block === null ? 'null' as const : 'object' as const,
    ...Object.fromEntries(AUTO_COMPACT_COMMON_FIELDS.filter(field => raw && Object.hasOwn(raw, field)).map(field => [field, raw![field]]))
  })
  return Object.freeze({ id: row.id, type: row.agentType, token: header, group })
}

export const AUTO_COMPACT_SEMANTIC_ID = 'agent.context.auto-compact' as const
export const AUTO_COMPACT_COMMON_FIELDS = ['mode', 'triggerMode', 'remainingTokens'] as const
export type AutoCompactField = typeof AUTO_COMPACT_COMMON_FIELDS[number]
export type AutoCompactChanges = Readonly<Partial<{ mode: 'inherit' | 'off' | 'ask' | 'auto'; triggerMode: 'inherit' | 'smart' | 'remaining_tokens'; remainingTokens: number | null }>>
export function validAutoCompactField(field: AutoCompactField, value: unknown, global = false): boolean {
  if (field === 'mode') return ['off', 'ask', 'auto', ...(!global ? ['inherit'] : [])].includes(value as string)
  if (field === 'triggerMode') return ['smart', 'remaining_tokens', ...(!global ? ['inherit'] : [])].includes(value as string)
  return value === null || typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 1000000
}
/** Input authorization is strict; the runtime's permissive normalizer is not a validator. */
export function validateAutoCompactChanges(value: unknown): AutoCompactChanges {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Choose only common Auto Compact preferences.')
  const keys = Reflect.ownKeys(value)
  if (!keys.length || keys.some(key => !(AUTO_COMPACT_COMMON_FIELDS as readonly PropertyKey[]).includes(key) ||
    !validAutoCompactField(key as AutoCompactField, (value as Record<string, unknown>)[key as string]))) throw new Error('Invalid common Auto Compact preference.')
  return Object.freeze({ ...value }) as AutoCompactChanges
}

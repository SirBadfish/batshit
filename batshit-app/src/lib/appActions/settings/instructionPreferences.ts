export const INSTRUCTIONS_SEMANTIC_ID = 'agent.instructions' as const
export const INSTRUCTION_LIMITS = Object.freeze({ replacementBytes: 16 * 1024, previewBytes: 64 * 1024, readSnapshotBytes: 256 * 1024 })
export type InstructionOwnerKind = 'primary' | 'subagent'
export type InstructionsChanges = Readonly<Partial<{ customPrompt: string | null; includeGlobalPrompt: boolean | null }>>
export type InstructionTextDescriptor = Readonly<{
  stored: 'unset'; representation: 'absent' | 'null'; codeUnits: 0; utf8Bytes: 0; read: 'available'
} | {
  stored: 'set'; codeUnits: number; utf8Bytes: number | null; read: 'available' | 'too_large'
} | { stored: 'invalid'; codeUnits: null; utf8Bytes: null; read: 'unavailable' }>

const bytes = (value: string) => new TextEncoder().encode(value).byteLength

/** No raw fields, coercion or silent text truncation. Check requested bytes before trimming. */
export function validateInstructionsChanges(value: unknown): InstructionsChanges {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Choose only the adopted instruction fields.')
  const keys = Reflect.ownKeys(value)
  if (!keys.length || keys.some(key => key !== 'customPrompt' && key !== 'includeGlobalPrompt')) throw new Error('Choose only the adopted instruction fields.')
  const input = value as Record<string, unknown>
  if (Object.hasOwn(input, 'customPrompt') && input.customPrompt !== null) {
    if (typeof input.customPrompt !== 'string' || !input.customPrompt.isWellFormed()) throw new Error('Custom instructions must be well-formed text or null.')
    if (input.customPrompt.length > INSTRUCTION_LIMITS.replacementBytes || bytes(input.customPrompt) > INSTRUCTION_LIMITS.replacementBytes) {
      throw new Error('Custom instructions exceed the 16 KiB replacement limit. No text was truncated.')
    }
  }
  if (Object.hasOwn(input, 'includeGlobalPrompt') && input.includeGlobalPrompt !== null && typeof input.includeGlobalPrompt !== 'boolean') {
    throw new Error('Global prompt inclusion must be true, false or null to use the target default.')
  }
  return Object.freeze({
    ...(Object.hasOwn(input, 'customPrompt') ? { customPrompt: input.customPrompt as string | null } : {}),
    ...(Object.hasOwn(input, 'includeGlobalPrompt') ? { includeGlobalPrompt: input.includeGlobalPrompt as boolean | null } : {})
  })
}

export function normalizeInstructionsChanges(kind: InstructionOwnerKind, value: unknown): InstructionsChanges {
  const input = validateInstructionsChanges(value)
  return Object.freeze({ ...input, ...(Object.hasOwn(input, 'customPrompt') && kind === 'subagent'
    ? { customPrompt: input.customPrompt === null ? null : input.customPrompt!.trim() || null } : {}) })
}

export function resolveInstructionGlobalInclusion(kind: InstructionOwnerKind, raw: unknown): boolean {
  if (raw == null) return kind === 'primary'
  if (typeof raw !== 'boolean') throw new Error('Invalid saved global prompt inclusion.')
  return raw
}

/** Default reports carry metadata only. Character offsets must name UTF-16 code units explicitly. */
export function describeInstructionText(raw: unknown): InstructionTextDescriptor {
  if (raw == null) return Object.freeze({ stored: 'unset', representation: raw === null ? 'null' : 'absent', codeUnits: 0, utf8Bytes: 0, read: 'available' })
  if (typeof raw !== 'string' || !raw.isWellFormed()) return Object.freeze({ stored: 'invalid', codeUnits: null, utf8Bytes: null, read: 'unavailable' })
  if (raw.length > INSTRUCTION_LIMITS.readSnapshotBytes) return Object.freeze({ stored: 'set', codeUnits: raw.length, utf8Bytes: null, read: 'too_large' })
  const utf8Bytes = bytes(raw)
  return Object.freeze({ stored: 'set', codeUnits: raw.length, utf8Bytes, read: utf8Bytes <= INSTRUCTION_LIMITS.readSnapshotBytes ? 'available' : 'too_large' })
}

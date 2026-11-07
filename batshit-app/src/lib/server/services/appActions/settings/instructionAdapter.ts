import {
  describeInstructionText, INSTRUCTIONS_SEMANTIC_ID, normalizeInstructionsChanges, resolveInstructionGlobalInclusion, validateInstructionsChanges,
  type InstructionOwnerKind, type InstructionTextDescriptor
} from '$lib/appActions/settings/instructionPreferences'
import type { SettingsReportValue } from '$lib/appActions/settings/reportContract'
import { NULLABLE_AGENT_FIELDS, planRecordFieldOps } from '$lib/server/agentRecordUpdate'
import { SUBAGENT_REMOVES_ON_NULL } from '$lib/server/subagentRecordUpdate'
import type { SettingsSubjectEntry } from './subjects'
import { valueState } from './scalarProjection'

type InstructionField = 'system_prompt' | 'include_global_prompt'
type InstructionWrite = Readonly<{ op: 'set'; field: InstructionField; value: string | boolean | null } | { op: 'delete'; field: 'system_prompt' }>
export type InstructionsProjection = Readonly<{
  id: typeof INSTRUCTIONS_SEMANTIC_ID; status: 'available'
  customPrompt: InstructionTextDescriptor; includeGlobalPrompt: SettingsReportValue
} | { id: typeof INSTRUCTIONS_SEMANTIC_ID; status: 'unavailable'; reason: 'stored_agent_instructions_only' }>
export type InstructionsPlan = Readonly<{
  updates: Readonly<Partial<{ system_prompt: string | null; include_global_prompt: boolean | null }>>
  writes: readonly InstructionWrite[]
  effects: Readonly<{ customPromptChanged: boolean; globalInclusionChanged: boolean; includeGlobalBefore: boolean | 'unknown'; includeGlobalAfter: boolean | 'unknown' }>
}>
function ownerKind(entry: SettingsSubjectEntry): InstructionOwnerKind | null {
  if (entry.status !== 'available') return null
  if (entry.subject.kind === 'primary' && entry.type === 'api') return 'primary'
  if (entry.subject.kind === 'subagent' && entry.type === 'api') return 'subagent'
  return null
}
function inclusion(kind: InstructionOwnerKind, raw: unknown): boolean | 'unknown' {
  try { return resolveInstructionGlobalInclusion(kind, raw) } catch { return 'unknown' }
}
export function projectInstructions(entry: SettingsSubjectEntry, record: Record<string, unknown>): InstructionsProjection {
  const kind = ownerKind(entry)
  if (!kind) return Object.freeze({ id: INSTRUCTIONS_SEMANTIC_ID, status: 'unavailable', reason: 'stored_agent_instructions_only' })
  return Object.freeze({ id: INSTRUCTIONS_SEMANTIC_ID, status: 'available', customPrompt: describeInstructionText(record.system_prompt),
    includeGlobalPrompt: valueState(record.include_global_prompt, inclusion(kind, record.include_global_prompt) === true, value => typeof value === 'boolean') })
}

/** Pure, unexposed plan. Shared admission/CAS must bind requested raw leaves and actual identity.
 * Text here is server-held intent for exact review, never a default report projection. */
export function planInstructionsChanges(entry: SettingsSubjectEntry, record: Record<string, unknown>, value: unknown): InstructionsPlan {
  const kind = ownerKind(entry)
  if (!kind) throw new Error('stored_agent_instructions_only')
  const changes = normalizeInstructionsChanges(kind, value)
  const requested: Partial<{ system_prompt: string | null; include_global_prompt: boolean | null }> = {}
  if (Object.hasOwn(changes, 'customPrompt')) requested.system_prompt = changes.customPrompt as string | null
  if (Object.hasOwn(changes, 'includeGlobalPrompt')) requested.include_global_prompt = changes.includeGlobalPrompt as boolean | null
  const writes: InstructionWrite[] = []
  const updates: Partial<{ system_prompt: string | null; include_global_prompt: boolean | null }> = {}
  for (const field of ['system_prompt', 'include_global_prompt'] as const) {
    if (!Object.hasOwn(requested, field)) continue
    const [op] = planRecordFieldOps(field, requested[field], kind === 'primary' ? NULLABLE_AGENT_FIELDS : SUBAGENT_REMOVES_ON_NULL)
    if (op.op === 'delete') {
      if (record[field] === undefined) continue
      writes.push(Object.freeze({ op: 'delete', field: 'system_prompt' })); updates.system_prompt = null
    } else if (op.op === 'set') {
      if (field === 'system_prompt') validateInstructionsChanges({ customPrompt: op.value })
      if (op.value === record[field]) continue
      const actual = op.value as string | boolean | null
      writes.push(Object.freeze({ op: 'set', field, value: actual }))
      if (field === 'system_prompt') updates.system_prompt = actual as string | null
      else updates.include_global_prompt = actual as boolean | null
    } else throw new Error('Unsupported instruction field plan.')
  }
  const before = inclusion(kind, record.include_global_prompt)
  return Object.freeze({ updates: Object.freeze(updates), writes: Object.freeze(writes), effects: Object.freeze({
    customPromptChanged: Object.hasOwn(updates, 'system_prompt'), globalInclusionChanged: Object.hasOwn(updates, 'include_global_prompt'),
    includeGlobalBefore: before, includeGlobalAfter: Object.hasOwn(updates, 'include_global_prompt') ? inclusion(kind, updates.include_global_prompt) : before
  }) })
}

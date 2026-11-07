import { isCanonicalAgentId } from '$lib/utils/agentId'
import { INSTRUCTION_LIMITS } from './instructionPreferences'
import type { SettingsSubjectRef } from './subjectTypes'

export type InstructionTextFact = Readonly<{ state: 'absent' | 'null' | 'delete' } | { state: 'set'; textId: string }>
export type InstructionInclusionFact = Readonly<{ state: 'absent' | 'null' } | { state: 'set'; value: boolean }>
export type InstructionsReviewTarget = Readonly<{
  subject: SettingsSubjectRef
  customPrompt?: Readonly<{ before: InstructionTextFact; after: InstructionTextFact }>
  includeGlobalPrompt?: Readonly<{ before: InstructionInclusionFact; after: InstructionInclusionFact; effectiveBefore: boolean | 'unknown'; effectiveAfter: boolean | 'unknown' }>
}>
export type InstructionsReview = Readonly<{ version: 1; texts: readonly Readonly<{ id: string; text: string }>[]; targets: readonly InstructionsReviewTarget[] }>
export type InstructionsGenericReviewTarget = Readonly<{ subject: SettingsSubjectRef; changes: readonly Readonly<{ field: string; before: unknown; after: unknown }>[] }>

export const instructionTextFactReference = (fact: InstructionTextFact): string => fact.state === 'set' ? fact.textId : fact.state
export const instructionInclusionFactReference = (fact: InstructionInclusionFact): boolean | 'absent' | 'null' => fact.state === 'set' ? fact.value : fact.state
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
}
function subjectKey(value: unknown): string | null {
  if (!object(value, ['kind', 'id']) || !['primary', 'subagent'].includes(String(value.kind)) || !isCanonicalAgentId(value.id)) return null
  return `${value.kind}:${value.id}`
}
function textFact(value: unknown, after: boolean): value is InstructionTextFact {
  return object(value, ['state', 'textId']) && (value.state === 'set'
    ? Reflect.ownKeys(value).length === 2 && typeof value.textId === 'string' && /^text_(0|[1-9][0-9]*)$/.test(value.textId)
    : Reflect.ownKeys(value).length === 1 && (after ? ['null', 'delete'] : ['absent', 'null']).includes(String(value.state)))
}
function inclusionFact(value: unknown, after: boolean): value is InstructionInclusionFact {
  return object(value, ['state', 'value']) && (value.state === 'set'
    ? Reflect.ownKeys(value).length === 2 && typeof value.value === 'boolean'
    : Reflect.ownKeys(value).length === 1 && (after ? value.state === 'null' : value.state === 'absent' || value.state === 'null'))
}
function effective(value: unknown): value is boolean | 'unknown' { return typeof value === 'boolean' || value === 'unknown' }

/** Presentation binding only. This does not grant disclosure, consent or write authority. */
export function isInstructionsReview(value: unknown, genericTargets: readonly InstructionsGenericReviewTarget[]): value is InstructionsReview {
  try {
    if (!object(value, ['version', 'texts', 'targets']) || value.version !== 1 || !Array.isArray(value.texts) || !Array.isArray(value.targets) ||
      !Array.isArray(genericTargets) || genericTargets.length > 256 || value.targets.length !== genericTargets.length ||
      value.texts.length > genericTargets.length * 2 || bytes(value) > INSTRUCTION_LIMITS.previewBytes) return false
    const table = new Map<string, string>(), literals = new Set<string>()
    for (const [index, row] of value.texts.entries()) {
      if (!object(row, ['id', 'text']) || row.id !== `text_${index}` || typeof row.text !== 'string' || !row.text.isWellFormed() || literals.has(row.text)) return false
      table.set(row.id, row.text); literals.add(row.text)
    }
    const generic = new Map<string, InstructionsGenericReviewTarget>()
    for (const target of genericTargets) {
      const key = subjectKey(target.subject)
      if (!key || generic.has(key) || !Array.isArray(target.changes) || !target.changes.length || target.changes.length > 2 ||
        new Set(target.changes.map((change: InstructionsGenericReviewTarget['changes'][number]) => change.field)).size !== target.changes.length || target.changes.some((change: InstructionsGenericReviewTarget['changes'][number]) => !['customPrompt', 'includeGlobalPrompt'].includes(change.field))) return false
      generic.set(key, target)
    }
    const seen = new Set<string>(), used = new Set<string>()
    for (const row of value.targets) {
      if (!object(row, ['subject', 'customPrompt', 'includeGlobalPrompt'])) return false
      const key = subjectKey(row.subject), target = key ? generic.get(key) : undefined
      if (!key || !target || seen.has(key)) return false
      seen.add(key)
      const fields = ['customPrompt', 'includeGlobalPrompt'].filter(field => Object.hasOwn(row, field))
      if (fields.length !== target.changes.length) return false
      for (const field of fields) {
        const change = target.changes.find(change => change.field === field), leaf = row[field]
        if (!change) return false
        if (field === 'customPrompt') {
          if (!object(leaf, ['before', 'after']) || !textFact(leaf.before, false) || !textFact(leaf.after, true) ||
            instructionTextFactReference(leaf.before) !== change.before || instructionTextFactReference(leaf.after) !== change.after || change.before === change.after ||
            (row.subject as SettingsSubjectRef).kind === 'primary' && leaf.after.state === 'delete' ||
            (row.subject as SettingsSubjectRef).kind === 'subagent' && leaf.after.state === 'null') return false
          for (const fact of [leaf.before, leaf.after]) if (fact.state === 'set') {
            if (!table.has(fact.textId)) return false
            if (!used.has(fact.textId) && fact.textId !== `text_${used.size}`) return false
            used.add(fact.textId)
          }
          if (leaf.after.state === 'set' && new TextEncoder().encode(table.get(leaf.after.textId)!).byteLength > INSTRUCTION_LIMITS.replacementBytes) return false
        } else {
          if (!object(leaf, ['before', 'after', 'effectiveBefore', 'effectiveAfter']) || !inclusionFact(leaf.before, false) || !inclusionFact(leaf.after, true) ||
            !effective(leaf.effectiveBefore) || !effective(leaf.effectiveAfter) || instructionInclusionFactReference(leaf.before) !== change.before ||
            instructionInclusionFactReference(leaf.after) !== change.after || change.before === change.after) return false
          const defaultValue = (row.subject as SettingsSubjectRef).kind === 'primary'
          if (leaf.effectiveBefore !== 'unknown' && leaf.effectiveBefore !== (leaf.before.state === 'set' ? leaf.before.value : defaultValue) ||
            leaf.effectiveAfter !== 'unknown' && leaf.effectiveAfter !== (leaf.after.state === 'set' ? leaf.after.value : defaultValue)) return false
        }
      }
    }
    return used.size === table.size
  } catch { return false }
}

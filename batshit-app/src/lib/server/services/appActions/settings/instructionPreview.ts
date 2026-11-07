import type { AppActionsOperationPreview } from '$lib/appActions/settings/managementContract'
import { INSTRUCTION_LIMITS, INSTRUCTIONS_SEMANTIC_ID } from '$lib/appActions/settings/instructionPreferences'
import {
  instructionInclusionFactReference, instructionTextFactReference, isInstructionsReview,
  type InstructionInclusionFact, type InstructionsReview, type InstructionsReviewTarget, type InstructionTextFact
} from '$lib/appActions/settings/instructionReview'
import type { SettingsSubjectRef } from '$lib/appActions/settings/subjectTypes'
import type { InstructionsPlan } from './instructionAdapter'

export class InstructionsPreviewRefusal extends Error {
  readonly code = 'INSTRUCTIONS_PREVIEW_UNAVAILABLE'
  constructor(readonly reason: 'invalid_saved_instructions' | 'invalid_instruction_plan' | 'preview_limit_exceeded') {
    super(reason === 'preview_limit_exceeded' ? 'The complete instructions preview exceeds 64 KiB. Choose fewer targets or shorter text. No text was truncated.' :
      'The complete instructions preview is unavailable. Read valid current instructions before continuing.')
    this.name = 'InstructionsPreviewRefusal'
  }
}
type PreviewRow = Readonly<{ subject: SettingsSubjectRef; label: string; before: Record<string, unknown>; plan: InstructionsPlan }>
const fail = (reason: ConstructorParameters<typeof InstructionsPreviewRefusal>[0]): never => { throw new InstructionsPreviewRefusal(reason) }

/** Exact user-only disclosure. Generic scalar fields contain table references, never prose. */
export function buildInstructionsPreview(rows: readonly PreviewRow[], excluded: readonly SettingsSubjectRef[], effects: readonly string[]): AppActionsOperationPreview & { instructions: InstructionsReview } {
  const texts: Array<Readonly<{ id: string; text: string }>> = [], byText = new Map<string, string>()
  function textFact(text: unknown): InstructionTextFact {
    if (typeof text !== 'string' || !text.isWellFormed()) return fail('invalid_saved_instructions')
    let textId = byText.get(text)
    if (textId === undefined) { textId = `text_${texts.length}`; byText.set(text, textId); texts.push(Object.freeze({ id: textId, text })) }
    return Object.freeze({ state: 'set', textId })
  }
  function beforeText(record: Record<string, unknown>): InstructionTextFact {
    return !Object.hasOwn(record, 'system_prompt') ? Object.freeze({ state: 'absent' }) : record.system_prompt === null ? Object.freeze({ state: 'null' }) : textFact(record.system_prompt)
  }
  function beforeInclusion(record: Record<string, unknown>): InstructionInclusionFact {
    if (!Object.hasOwn(record, 'include_global_prompt')) return Object.freeze({ state: 'absent' })
    if (record.include_global_prompt === null) return Object.freeze({ state: 'null' })
    if (typeof record.include_global_prompt !== 'boolean') return fail('invalid_saved_instructions')
    return Object.freeze({ state: 'set', value: record.include_global_prompt })
  }
  const reviewTargets: InstructionsReviewTarget[] = []
  const targets = rows.map(row => {
    if (!row.plan.writes.length || row.plan.writes.length > 2 || new Set(row.plan.writes.map(write => write.field)).size !== row.plan.writes.length) return fail('invalid_instruction_plan')
    const review: { subject: SettingsSubjectRef; customPrompt?: InstructionsReviewTarget['customPrompt']; includeGlobalPrompt?: InstructionsReviewTarget['includeGlobalPrompt'] } = { subject: Object.freeze({ ...row.subject }) }
    const changes = row.plan.writes.map(write => {
      if (write.field === 'system_prompt') {
        const before = beforeText(row.before)
        const after: InstructionTextFact = write.op === 'delete' ? Object.freeze({ state: 'delete' }) : write.value === null ? Object.freeze({ state: 'null' }) : textFact(write.value)
        if (write.op === 'delete' && row.subject.kind !== 'subagent') return fail('invalid_instruction_plan')
        review.customPrompt = Object.freeze({ before, after })
        return { field: 'customPrompt', label: 'Custom instructions', before: instructionTextFactReference(before), after: instructionTextFactReference(after) }
      }
      if (write.field !== 'include_global_prompt' || write.op !== 'set' || write.value !== null && typeof write.value !== 'boolean') return fail('invalid_instruction_plan')
      const before = beforeInclusion(row.before), after: InstructionInclusionFact = write.value === null ? Object.freeze({ state: 'null' }) : Object.freeze({ state: 'set', value: write.value })
      review.includeGlobalPrompt = Object.freeze({ before, after, effectiveBefore: row.plan.effects.includeGlobalBefore, effectiveAfter: row.plan.effects.includeGlobalAfter })
      return { field: 'includeGlobalPrompt', label: 'Include global instructions on later compilations', before: instructionInclusionFactReference(before), after: instructionInclusionFactReference(after) }
    })
    reviewTargets.push(Object.freeze(review))
    return { subject: review.subject, label: row.label, changes }
  })
  const instructions: InstructionsReview = Object.freeze({ version: 1, texts: Object.freeze(texts), targets: Object.freeze(reviewTargets) })
  const preview = { semanticId: INSTRUCTIONS_SEMANTIC_ID, targets, excluded: excluded.map(subject => ({ ...subject })), effects: [...effects], instructions }
  if (Buffer.byteLength(JSON.stringify(preview), 'utf8') > INSTRUCTION_LIMITS.previewBytes) return fail('preview_limit_exceeded')
  if (!isInstructionsReview(instructions, targets)) return fail('invalid_instruction_plan')
  return preview
}

import { describe, expect, it } from 'vitest'
import { isInstructionsReview, type InstructionsReview } from './instructionReview'

const subject = { kind: 'primary' as const, id: 'p' }
const targets = [{ subject, changes: [{ field: 'customPrompt', before: 'text_0', after: 'text_1' }, { field: 'includeGlobalPrompt', before: 'absent', after: false }] }]
function review(): InstructionsReview {
  return { version: 1, texts: [{ id: 'text_0', text: '<script>old</script>\n  exact ' }, { id: 'text_1', text: 'New instructions' }], targets: [{ subject,
    customPrompt: { before: { state: 'set', textId: 'text_0' }, after: { state: 'set', textId: 'text_1' } },
    includeGlobalPrompt: { before: { state: 'absent' }, after: { state: 'set', value: false }, effectiveBefore: true, effectiveAfter: false } }] }
}
describe('fixed instruction review disclosure binding', () => {
  it('admits the exact empty disclosure for an operation containing only initial outcomes', () => {
    expect(isInstructionsReview({ version: 1, texts: [], targets: [] }, [])).toBe(true)
    expect(isInstructionsReview({ version: 1, texts: [{ id: 'text_0', text: 'hidden' }], targets: [] }, [])).toBe(false)
  })
  it('admits exact complete text and bounded scalar references without interpreting prose', () => {
    expect(isInstructionsReview(review(), targets)).toBe(true)
    expect(isInstructionsReview({ version: 1, texts: [], targets: [{ subject, includeGlobalPrompt: review().targets[0].includeGlobalPrompt }] },
      [{ subject, changes: [targets[0].changes[1]] }])).toBe(true)
  })
  it('refuses missing, foreign, duplicate or dropped target/leaf disclosures', () => {
    for (const mutate of [
      (value: any) => value.targets.pop(), (value: any) => value.targets.push(value.targets[0]),
      (value: any) => value.targets[0].subject = { kind: 'subagent', id: 'p' },
      (value: any) => delete value.targets[0].customPrompt, (value: any) => delete value.targets[0].includeGlobalPrompt,
      (value: any) => value.targets[0].extra = 'hidden'
    ]) { const value = structuredClone(review()); mutate(value); expect(isInstructionsReview(value, targets)).toBe(false) }
    expect(isInstructionsReview(review(), [{ ...targets[0], changes: [...targets[0].changes, targets[0].changes[0]] }])).toBe(false)
    expect(isInstructionsReview(review(), [{ ...targets[0], changes: [{ field: 'system_prompt', before: 'text_0', after: 'text_1' }] }])).toBe(false)
  })
  it('refuses dangling, surplus, duplicate-literal, reordered or malformed text table facts', () => {
    for (const mutate of [
      (value: any) => value.texts.pop(), (value: any) => value.texts.push({ id: 'text_2', text: 'surplus' }),
      (value: any) => value.texts[1].text = value.texts[0].text, (value: any) => value.texts.reverse(),
      (value: any) => value.texts[1].id = 'text_01', (value: any) => value.texts[1].text = '\ud800',
      (value: any) => value.targets[0].customPrompt.after = { state: 'set', textId: 'text_1', extra: true },
      (value: any) => value.targets[0].customPrompt.before = { state: 'delete' },
      (value: any) => value.targets[0].customPrompt.after = { state: 'absent' },
      (value: any) => value.targets[0].includeGlobalPrompt.effectiveBefore = false
    ]) { const value = structuredClone(review()); mutate(value); expect(isInstructionsReview(value, targets)).toBe(false) }
    const raw = structuredClone(targets); raw[0].changes[0].after = 'New instructions'
    expect(isInstructionsReview(review(), raw)).toBe(false)
  })
  it('keeps absent/null/delete distinct and applies target-specific storage semantics', () => {
    const subagent = { kind: 'subagent' as const, id: 's' }
    const value = { version: 1, texts: [], targets: [{ subject: subagent, customPrompt: { before: { state: 'null' }, after: { state: 'delete' } } }] }
    expect(isInstructionsReview(value, [{ subject: subagent, changes: [{ field: 'customPrompt', before: 'null', after: 'delete' }] }])).toBe(true)
    expect(isInstructionsReview({ ...value, targets: [{ ...value.targets[0], subject }] }, [{ subject, changes: [{ field: 'customPrompt', before: 'null', after: 'delete' }] }])).toBe(false)
    expect(isInstructionsReview({ version: 1, texts: [], targets: [{ subject, customPrompt: { before: { state: 'absent' }, after: { state: 'null' } } }] },
      [{ subject, changes: [{ field: 'customPrompt', before: 'absent', after: 'null' }] }])).toBe(true)
  })
  it('refuses oversized replacements and complete disclosure budgets', () => {
    const value = structuredClone(review()) as any
    value.texts[1].text = 'x'.repeat(16 * 1024 + 1)
    expect(isInstructionsReview(value, targets)).toBe(false)
    value.texts[1].text = 'new'; value.texts[0].text = '\n'.repeat(40 * 1024)
    expect(isInstructionsReview(value, targets)).toBe(false)
  })
})

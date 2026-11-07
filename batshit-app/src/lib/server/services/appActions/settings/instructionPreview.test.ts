import { describe, expect, it } from 'vitest'
import { planInstructionsChanges } from './instructionAdapter'
import { buildInstructionsPreview, InstructionsPreviewRefusal } from './instructionPreview'
import type { SettingsSubjectEntry } from './subjects'

const primary: SettingsSubjectEntry = { subject: { kind: 'primary', id: 'p' }, type: 'api', status: 'available' }
const subagent: SettingsSubjectEntry = { subject: { kind: 'subagent', id: 's' }, type: 'api', status: 'available' }
const row = (entry: SettingsSubjectEntry, before: Record<string, unknown>, changes: unknown) => ({ subject: entry.subject, label: entry.subject.id, before, plan: planInstructionsChanges(entry, before, changes) })

describe('exact bounded user-only instructions previews', () => {
  it('keeps an empty admitted set and its exclusions/effects for terminal initial outcomes', () => {
    expect(buildInstructionsPreview([], [{ kind: 'subagent', id: 'excluded' }], ['No targets write.'])).toEqual({ semanticId: 'agent.instructions', targets: [],
      excluded: [{ kind: 'subagent', id: 'excluded' }], effects: ['No targets write.'], instructions: { version: 1, texts: [], targets: [] } })
  })
  it('deduplicates literal text only across every target and preserves the full manifest/effects', () => {
    const rows = [row(primary, { system_prompt: 'same' }, { customPrompt: 'replacement' }),
      row({ ...subagent, subject: { kind: 'subagent', id: 'second' } }, { system_prompt: 'same' }, { customPrompt: 'replacement' }),
      row(subagent, { system_prompt: 'diff' }, { customPrompt: 'replacement' })]
    const excluded = [{ kind: 'primary' as const, id: 'excluded' }], effects = ['Later compilations use the saved instructions.']
    const preview = buildInstructionsPreview(rows, excluded, effects)
    expect(preview.instructions.texts).toEqual([{ id: 'text_0', text: 'same' }, { id: 'text_1', text: 'replacement' }, { id: 'text_2', text: 'diff' }])
    expect(preview.targets).toHaveLength(3)
    expect(preview.instructions.targets).toHaveLength(3)
    expect(preview.excluded).toEqual(excluded); expect(preview.effects).toEqual(effects)
    expect(JSON.stringify(preview.targets)).not.toContain('replacement')
    excluded[0].id = 'changed'; effects[0] = 'changed'
    expect(preview.excluded[0].id).toBe('excluded'); expect(preview.effects[0]).not.toBe('changed')
  })
  it('discloses exact Primary planned storage and Subagent trim/delete, preserving null and absence', () => {
    const preview = buildInstructionsPreview([row(primary, {}, { customPrompt: '  exact\n ' }), row(subagent, { system_prompt: null }, { customPrompt: '  ' })], [], [])
    expect(preview.instructions.texts).toEqual([{ id: 'text_0', text: '  exact\n ' }])
    expect(preview.instructions.targets[0].customPrompt).toEqual({ before: { state: 'absent' }, after: { state: 'set', textId: 'text_0' } })
    expect(preview.instructions.targets[1].customPrompt).toEqual({ before: { state: 'null' }, after: { state: 'delete' } })
    const nullPreview = buildInstructionsPreview([row(primary, {}, { customPrompt: null })], [], [])
    expect(nullPreview.targets[0].changes[0]).toMatchObject({ before: 'absent', after: 'null' })
  })
  it('does not access custom text for inclusion-only changes and shows target defaults', () => {
    const before = Object.defineProperty({}, 'system_prompt', { get() { throw new Error('prompt was read') } })
    const preview = buildInstructionsPreview([row(primary, before, { includeGlobalPrompt: false }), row(subagent, {}, { includeGlobalPrompt: true })], [], [])
    expect(preview.instructions.texts).toEqual([])
    expect(preview.instructions.targets[0].includeGlobalPrompt).toMatchObject({ effectiveBefore: true, effectiveAfter: false })
    expect(preview.instructions.targets[1].includeGlobalPrompt).toMatchObject({ effectiveBefore: false, effectiveAfter: true })
  })
  it('explicitly refuses invalid requested saved leaves and zero-write plans', () => {
    for (const before of [{ system_prompt: 12 }, { system_prompt: false }, { system_prompt: '\ud800' }, { system_prompt: undefined }]) {
      expect(() => buildInstructionsPreview([row(primary, before, { customPrompt: 'new' })], [], [])).toThrow(InstructionsPreviewRefusal)
    }
    expect(() => buildInstructionsPreview([row(primary, { include_global_prompt: 'false' }, { includeGlobalPrompt: false })], [], [])).toThrow(InstructionsPreviewRefusal)
    expect(() => buildInstructionsPreview([row(primary, { system_prompt: 'same' }, { customPrompt: 'same' })], [], [])).toThrow('unavailable')
  })
  it('enforces the entire serialized preview budget including escaping, exclusions, labels and effects', () => {
    const prompt = '\n'.repeat(16 * 1024)
    expect(() => buildInstructionsPreview([row(primary, { system_prompt: prompt }, { customPrompt: 'new' })], [], ['x'.repeat(34 * 1024)])).toThrow('64 KiB')
    const rows = Array.from({ length: 256 }, (_, index) => row({ ...primary, subject: { kind: 'primary', id: `p_${index}` } }, { system_prompt: 'same' }, { customPrompt: 'new' }))
    expect(() => buildInstructionsPreview(rows, [], [])).toThrow('64 KiB')
  })
})

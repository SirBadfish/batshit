import { describe, expect, it } from 'vitest'
import { planAgentRecordUpdate } from '$lib/server/agentRecordUpdate'
import { buildSubagentWrites, planSubagentRecordUpdate } from '$lib/server/subagentRecordUpdate'
import type { SettingsSubjectEntry } from './subjects'
import { planInstructionsChanges, projectInstructions } from './instructionAdapter'

const primary: SettingsSubjectEntry = { subject: { kind: 'primary', id: 'p' }, status: 'available', type: 'api' }
const subagent: SettingsSubjectEntry = { subject: { kind: 'subagent', id: 's' }, status: 'available', type: 'api' }

describe('unexposed instruction projections and fixed field plans', () => {
  it('supports exactly the two current stored agent lanes (SA-139 R5: API Primary and API Subagent) with their inclusion defaults', () => {
    expect(projectInstructions(primary, {})).toMatchObject({ status: 'available', includeGlobalPrompt: { effective: { value: true }, source: 'factory' } })
    expect(projectInstructions(subagent, {})).toMatchObject({ status: 'available', includeGlobalPrompt: { effective: { value: false }, source: 'factory' } })
    // SA-139 R2: a removed n8n Workflow Subagent resolves to no type, so it is not an Instructions subject.
    // SA-139 R4/R5: a Primary or Subagent is API only; a leftover `cli` entry of either kind is not an Instructions subject.
    for (const entry of [{ ...primary, status: 'unavailable' as const }, { ...primary, type: undefined }, { ...primary, type: 'cli' as const }, { ...subagent, type: undefined },
      { ...subagent, type: 'cli' as const },
      { ...primary, subject: { kind: 'group' as const, id: 'g' } }, { ...primary, subject: { kind: 'worker' as const, id: 'w' } }]) {
      expect(projectInstructions(entry, {})).toMatchObject({ status: 'unavailable' })
      expect(() => planInstructionsChanges(entry, {}, { customPrompt: 'new' })).toThrow('stored_agent_instructions_only')
    }
  })
  it('returns only bounded prompt metadata and preserves invalid saved states', () => {
    const projection = projectInstructions(primary, { system_prompt: 'Private instruction text', include_global_prompt: false, secret: 'not-output' })
    expect(projection).toEqual({ id: 'agent.instructions', status: 'available', customPrompt: { stored: 'set', codeUnits: 24, utf8Bytes: 24, read: 'available' },
      includeGlobalPrompt: { stored: { state: 'set', value: false }, effective: { state: 'known', value: false }, source: 'agent' } })
    expect(projectInstructions(subagent, { system_prompt: 12, include_global_prompt: 'false' })).toMatchObject({ customPrompt: { stored: 'invalid' },
      includeGlobalPrompt: { stored: { state: 'invalid' }, effective: { state: 'unknown' }, source: 'none' } })
  })
  it('keeps Primary whitespace and null through the actual fixed field planner', () => {
    for (const customPrompt of ['  Instructions\n  ', '', '   ', null]) {
      const leaf = planInstructionsChanges(primary, {}, { customPrompt })
      const actual = planAgentRecordUpdate({ updates: { system_prompt: customPrompt }, now: 'fixture' }).ops.filter(op => op.field === 'system_prompt')
      expect(leaf.writes).toEqual(actual)
      expect(leaf.updates).toEqual({ system_prompt: customPrompt })
    }
  })
  it('uses Subagent trim/delete and preserves omission for every live Subagent kind', () => {
    // SA-139 R5: API is the one live Subagent type.
    for (const type of ['api'] as const) {
      const entry = { ...subagent, type }
      for (const customPrompt of ['', '  \n ', null]) {
        const leaf = planInstructionsChanges(entry, { system_prompt: 'old', include_global_prompt: true }, { customPrompt })
        const writes = buildSubagentWrites({ body: { system_prompt: customPrompt }, nextType: type })
        expect(leaf.writes).toEqual(planSubagentRecordUpdate({ writes, now: 'fixture' }).ops.filter(op => op.field === 'system_prompt'))
        expect(leaf.updates).toEqual({ system_prompt: null })
      }
      expect(planInstructionsChanges(entry, {}, { customPrompt: '  new\ntext  ' }).updates).toEqual({ system_prompt: 'new\ntext' })
      expect(planInstructionsChanges(entry, { system_prompt: 'kept' }, { includeGlobalPrompt: true }).updates).toEqual({ include_global_prompt: true })
    }
  })
  it('uses the actual stored value after sole-upload-URL normalization, without changing the owner', () => {
    const input = { customPrompt: 'https://example.invalid/uploads/clips/fixture.txt' }
    const leaf = planInstructionsChanges(primary, {}, input)
    const actual = planAgentRecordUpdate({ updates: { system_prompt: input.customPrompt }, now: 'fixture' }).ops.filter(op => op.field === 'system_prompt')
    expect(leaf.writes).toEqual(actual)
    expect(leaf.updates.system_prompt).toBe('/uploads/clips/fixture.txt')
    expect(input.customPrompt).toBe('https://example.invalid/uploads/clips/fixture.txt')
  })
  it('distinguishes stored null/no-op from the two inclusion default effects', () => {
    expect(planInstructionsChanges(primary, { include_global_prompt: false }, { includeGlobalPrompt: null })).toMatchObject({
      updates: { include_global_prompt: null }, writes: [{ op: 'set', field: 'include_global_prompt', value: null }],
      effects: { globalInclusionChanged: true, includeGlobalBefore: false, includeGlobalAfter: true }
    })
    expect(planInstructionsChanges(subagent, { include_global_prompt: true }, { includeGlobalPrompt: null })).toMatchObject({
      effects: { includeGlobalBefore: true, includeGlobalAfter: false }
    })
    expect(planInstructionsChanges(primary, { system_prompt: null, include_global_prompt: null }, { customPrompt: null, includeGlobalPrompt: null }).writes).toEqual([])
    expect(planInstructionsChanges(subagent, {}, { customPrompt: null }).writes).toEqual([])
    expect(planInstructionsChanges(subagent, { system_prompt: null }, { customPrompt: null }).writes).toEqual([{ op: 'delete', field: 'system_prompt' }])
  })
  it('plans an explicit repair without normalizing or copying unrelated malformed siblings', () => {
    const record = { system_prompt: ['malformed'], include_global_prompt: 'malformed', voice_profile: { kept: true } }
    expect(planInstructionsChanges(primary, record, { customPrompt: 'new' })).toMatchObject({ updates: { system_prompt: 'new' },
      effects: { customPromptChanged: true, globalInclusionChanged: false, includeGlobalBefore: 'unknown', includeGlobalAfter: 'unknown' } })
    expect(planInstructionsChanges(primary, record, { includeGlobalPrompt: false })).toMatchObject({ updates: { include_global_prompt: false },
      effects: { customPromptChanged: false, globalInclusionChanged: true, includeGlobalAfter: false } })
    expect(record).toEqual({ system_prompt: ['malformed'], include_global_prompt: 'malformed', voice_profile: { kept: true } })
  })
  it('validates at the server leaf and freezes the finite plan without adding write authority', () => {
    expect(() => planInstructionsChanges(primary, {}, { system_prompt: 'raw' })).toThrow('adopted instruction')
    const plan = planInstructionsChanges(primary, {}, { customPrompt: 'new', includeGlobalPrompt: false })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.updates)).toBe(true)
    expect(Object.isFrozen(plan.writes)).toBe(true)
    expect(plan.writes.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(plan.effects)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { captureInstructionsBaseline, instructionsExpectedForWrites, isInstructionsRevision, namesInstructions } from './instructionsBaseline'

const tokens = { customPrompt: `sha256:${'a'.repeat(64)}`, includeGlobalPrompt: `sha256:${'b'.repeat(64)}` }
const header = JSON.stringify(tokens)

describe('instructions browser baseline', () => {
  it.each([['agent', 'api'], ['subagent', 'api']] as const)('captures only actual fixed fields for %s %s', (kind, type) => {
    const row = { id: 'one', [kind === 'agent' ? 'agentType' : 'subagentType']: type, system_prompt: null, include_global_prompt: false, secret: 'excluded' }
    const baseline = captureInstructionsBaseline(kind, row, header)!
    expect(baseline).toEqual({ kind, id: 'one', type, tokens, group: { system_prompt: null, include_global_prompt: false } })
    expect(Object.isFrozen(baseline)).toBe(true)
    expect(Object.isFrozen(baseline.tokens)).toBe(true)
    expect(Object.isFrozen(baseline.group)).toBe(true)
  })

  it('preserves absence, explicit undefined and malformed stored values without sharing them', () => {
    const bad = { nested: ['invalid'] }
    const row = { id: 'one', agentType: 'api', system_prompt: bad }
    const baseline = captureInstructionsBaseline('agent', row, header)!
    bad.nested.push('later')
    expect(baseline.group).toEqual({ system_prompt: { nested: ['invalid'] } })
    expect(Object.hasOwn(baseline.group, 'include_global_prompt')).toBe(false)
    expect(Object.isFrozen((baseline.group.system_prompt as typeof bad).nested)).toBe(true)
    expect(Object.hasOwn(captureInstructionsBaseline('agent', { ...row, system_prompt: undefined }, header)!.group, 'system_prompt')).toBe(true)
  })

  it.each([null, tokens, '{}', JSON.stringify({ ...tokens, extra: tokens.customPrompt }), JSON.stringify({ ...tokens, customPrompt: 'a'.repeat(64) }), JSON.stringify({ ...tokens, includeGlobalPrompt: `sha256:${'B'.repeat(64)}` })])('refuses an absent or inexact header %s', invalid => {
    expect(captureInstructionsBaseline('agent', { id: 'one', agentType: 'api' }, invalid)).toBeNull()
  })

  it('refuses unsupported identity and never derives tokens from stored values', () => {
    expect(captureInstructionsBaseline('agent', { id: 'one', agentType: 'n8n-workflow' }, header)).toBeNull()
    // SA-139 R2: a removed n8n Subagent type is not an Instructions subject either.
    expect(captureInstructionsBaseline('subagent', { id: 'one', subagentType: 'n8n-workflow' }, header)).toBeNull()
    // SA-139 R4 and R5: a retired CLI Primary or CLI Subagent is not an Instructions subject.
    expect(captureInstructionsBaseline('agent', { id: 'one', agentType: 'cli' }, header)).toBeNull()
    expect(captureInstructionsBaseline('subagent', { id: 'one', subagentType: 'cli' }, header)).toBeNull()
    expect(captureInstructionsBaseline('subagent', { id: '', subagentType: 'api' }, header)).toBeNull()
    expect(isInstructionsRevision(tokens.customPrompt)).toBe(true)
    expect(isInstructionsRevision('sha256:unknown')).toBe(false)
  })

  it('names own physical leaves and returns only their independent tokens', () => {
    const baseline = captureInstructionsBaseline('agent', { id: 'one', agentType: 'api' }, header)
    expect(namesInstructions({ customPrompt: 'alias' })).toBe(false)
    expect(namesInstructions(Object.create({ system_prompt: 'inherited' }))).toBe(false)
    expect(instructionsExpectedForWrites(baseline, { include_global_prompt: false, displayName: 'one' })).toEqual({ includeGlobalPrompt: tokens.includeGlobalPrompt })
    expect(instructionsExpectedForWrites(baseline, { system_prompt: '' })).toEqual({ customPrompt: tokens.customPrompt })
    expect(instructionsExpectedForWrites(baseline, { system_prompt: null, include_global_prompt: null })).toEqual(tokens)
    expect(instructionsExpectedForWrites(baseline, { displayName: 'one' })).toBeNull()
    expect(instructionsExpectedForWrites(null, { system_prompt: '' })).toBeNull()
  })
})

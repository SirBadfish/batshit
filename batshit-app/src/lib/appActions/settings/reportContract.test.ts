import { describe, expect, it } from 'vitest'
import { ADOPTED_SETTINGS_DEFINITIONS, assertSettingsDefinitionCoverage } from './definitions'
import { parseSettingsReportRequest, parseSettingsSubjectSelector, settingsSubjectKey } from './reportContract'

describe('internal adopted Settings report contract', () => {
  it('keeps typed collisions separate and makes exclusion order deterministic', () => {
    const result = parseSettingsSubjectSelector({ allAgents: true, except: [
      { kind: 'subagent', id: 'same' }, { kind: 'primary', id: 'same' }, { kind: 'primary', id: 'same' }
    ] })
    expect('except' in result && result.except.map(settingsSubjectKey)).toEqual(['primary:same', 'subagent:same'])
    expect(Object.isFrozen(result)).toBe(true)
    expect('except' in result && Object.isFrozen(result.except[0])).toBe(true)
  })
  it.each([
    { subjects: [{ kind: 'primary', id: 'a' }], allAgents: true },
    { subjects: [] }, { allAgents: false }, { allAgents: true, path: '$.secret' },
    { subjects: [{ kind: 'primary', id: '../other' }] },
    { subjects: [{ kind: 'api', id: 'a' }] }, { subjects: [{ kind: ['primary'], id: 'a' }] }
  ])('refuses ambiguous or path-selected subjects: %j', input => {
    expect(() => parseSettingsSubjectSelector(input)).toThrow()
  })
  it('refuses unadopted settings and arbitrary detail expansion', () => {
    expect(() => parseSettingsReportRequest({ focus: ['system_prompt'] })).toThrow('unadopted_report_setting')
    expect(() => parseSettingsReportRequest({ detail: 'all' })).toThrow('invalid_report_detail')
    expect(() => parseSettingsReportRequest({ includeSecrets: true })).toThrow('invalid_report_arguments')
    expect(parseSettingsReportRequest({})).toEqual({ detail: 'summary', focus: ['agent.context.auto-compact', 'agent.identity', 'agent.instructions', 'agent.memory.preferences', 'agent.model.preset-copy', 'agent.model.selection', 'agent.reasoning.presentation', 'agent.reasoning.retention', 'agent.voice.tts-selection'] })
  })
  it('requires explicit adoption and complete owner declarations without registering writes', () => {
    expect(() => assertSettingsDefinitionCoverage()).not.toThrow()
    expect(ADOPTED_SETTINGS_DEFINITIONS.every(item => item.change === 'scoped-adapter')).toBe(true)
    expect(ADOPTED_SETTINGS_DEFINITIONS.find(item => item.id === 'agent.memory.preferences')!.fields.find(field => field.id === 'enabled')!.change).toBe('scoped-adapter')
    const [identity] = ADOPTED_SETTINGS_DEFINITIONS
    expect(() => assertSettingsDefinitionCoverage([{ ...identity, owner: { ...identity.owner, refresh: '' } }])).toThrow('Incomplete')
    expect(() => assertSettingsDefinitionCoverage([identity, identity])).toThrow('Incomplete')
  })
  it('requires the exact adopted ID set and rejects unrecognized IDs at runtime', () => {
    const [identity] = ADOPTED_SETTINGS_DEFINITIONS
    expect(() => assertSettingsDefinitionCoverage([])).toThrow('Incomplete adopted setting coverage')
    expect(() => assertSettingsDefinitionCoverage([identity])).toThrow('Incomplete adopted setting coverage')
    expect(() => assertSettingsDefinitionCoverage([
      ...ADOPTED_SETTINGS_DEFINITIONS, { ...identity, id: 'agent.unrecognized' } as typeof identity
    ])).toThrow('Unrecognized adopted setting id')
  })
  it('keeps account sv1 out of the generic sr1/si1 request parser', () => {
    expect(() => parseSettingsReportRequest({ cursor: `sv1:${'a'.repeat(64)}:1` })).toThrow('invalid_report_cursor')
    expect(parseSettingsReportRequest({ cursor: `sr1:${'a'.repeat(64)}:0` }).cursor).toBe(`sr1:${'a'.repeat(64)}:0`)
    expect(parseSettingsReportRequest({ cursor: `si1:${'a'.repeat(64)}:0` }).cursor).toBe(`si1:${'a'.repeat(64)}:0`)
  })
})

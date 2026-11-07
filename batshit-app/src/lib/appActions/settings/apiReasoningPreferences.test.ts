import { describe, expect, it } from 'vitest'
import { parseManagedSettingsChangeInput } from './managementInput'
import { SUBJECT_SETTINGS_BINDINGS } from '$lib/server/services/appActions/managementAdapters'
import type { SettingsSubjectEntry } from '$lib/server/services/appActions/settings/subjects'

const request = (semanticId: string, changes: unknown) => ({
  op: 'change', requestId: `${'0'.repeat(24)}:api-preferences`,
  reportId: `asr_${'0'.repeat(24)}_${'1'.repeat(32)}`, semanticId, changes
})

describe('adopted API presentation and retention inputs', () => {
  it('keeps the two display leaves independent and preserves false', () => {
    expect(parseManagedSettingsChangeInput(request('agent.reasoning.presentation', { displayReasoning: false })))
      .toMatchObject({ semanticId: 'agent.reasoning.presentation', changes: { displayReasoning: false } })
  })
  it('accepts the actual retention modes and lower budget bound', () => {
    expect(parseManagedSettingsChangeInput(request('agent.reasoning.retention', { mode: 'both', whiteboardBudgetTokens: 250 })))
      .toMatchObject({ changes: { mode: 'both', whiteboardBudgetTokens: 250 } })
  })
  it('preserves explicit null as a factory reset rather than an empty patch', () => {
    expect(parseManagedSettingsChangeInput(request('agent.reasoning.presentation', { displayWhiteboard: null })))
      .toMatchObject({ changes: { displayWhiteboard: null } })
  })
  it('refuses unknown fields, coercion and unsupported retention values', () => {
    for (const [id, changes] of [
      ['agent.reasoning.presentation', { displayReasoning: 'false' }],
      ['agent.reasoning.presentation', { system_prompt: 'unadopted' }],
      ['agent.reasoning.retention', { mode: 'default' }],
      ['agent.reasoning.retention', { whiteboardBudgetTokens: 249 }],
      ['agent.reasoning.retention', {}]
    ] as const) expect(() => parseManagedSettingsChangeInput(request(id, changes))).toThrow()
  })
})

const api: SettingsSubjectEntry = { subject: { kind: 'primary', id: 'a' }, status: 'available', type: 'api' }
describe('adopted API preference projections', () => {
  it('uses actual independent display defaults and preserves unset versus explicit false', () => {
    const binding = SUBJECT_SETTINGS_BINDINGS['agent.reasoning.presentation']
    expect(binding.project(api, { agentType: 'api' })).toMatchObject({ fields: {
      displayReasoning: { stored: { state: 'unset' }, effective: { state: 'known', value: true }, source: 'factory' },
      displayWhiteboard: { stored: { state: 'unset' }, effective: { state: 'known', value: true }, source: 'factory' }
    } })
    expect(binding.project(api, { agentType: 'api', show_reasoning: false, show_whiteboard: true })).toMatchObject({ fields: {
      displayReasoning: { stored: { state: 'set', value: false }, effective: { state: 'known', value: false }, source: 'agent' }
    } })
  })
  it('keeps malformed display values unknown without hiding a valid sibling', () => {
    expect(SUBJECT_SETTINGS_BINDINGS['agent.reasoning.presentation'].project(api, { agentType: 'api', show_reasoning: 'false', show_whiteboard: false }))
      .toMatchObject({ fields: { displayReasoning: { stored: { state: 'invalid' }, effective: { state: 'unknown' } },
        displayWhiteboard: { stored: { state: 'set', value: false }, effective: { state: 'known', value: false } } } })
  })
  it('uses actual factory retention with no legacy Preserve mapping or fabricated malformed values', () => {
    const binding = SUBJECT_SETTINGS_BINDINGS['agent.reasoning.retention']
    expect(binding.project(api, { agentType: 'api', preserve_reasoning: true })).toMatchObject({ fields: {
      mode: { stored: { state: 'unset' }, effective: { value: 'whiteboard' } }, whiteboardBudgetTokens: { effective: { value: 1500 } }
    } })
    expect(binding.project(api, { api_reasoning_retention: 'both', whiteboard_budget_tokens: 250 })).toMatchObject({ fields: {
      mode: { effective: { value: 'both' } }, whiteboardBudgetTokens: { effective: { value: 250 } }
    } })
    expect(binding.project(api, { api_reasoning_retention: 'broken' })).toMatchObject({ status: 'unavailable', reason: 'invalid_api_retention_preferences' })
  })
  it('does not imply CLI or stored-Subagent support for this API-only slice', () => {
    for (const id of ['agent.reasoning.presentation', 'agent.reasoning.retention'] as const) {
      expect(SUBJECT_SETTINGS_BINDINGS[id].project({ ...api, type: 'cli' }, {})).toMatchObject({ status: 'unavailable', reason: 'api_primary_only' })
      expect(SUBJECT_SETTINGS_BINDINGS[id].project({ ...api, subject: { kind: 'subagent', id: 'a' } }, {})).toMatchObject({ status: 'unavailable', reason: 'api_primary_only' })
    }
  })
})

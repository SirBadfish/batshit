import { describe, expect, it } from 'vitest'
import {
  assertClaudeReasoningCap, assertClaudeReasoningConfiguration, assertCliReasoningEffort, hasDefaultFirstPartyClaudeAliases, readCliReasoningSelection,
  resolveClaudeReasoningRouting, resolveCliReasoningContract, resolveCliReasoningEffort
} from './cli-reasoning-contracts'

const FIRST_PARTY_ROUTE = resolveClaudeReasoningRouting({ sourceEnv: {}, managedSettings: null })

describe('reviewed CLI reasoning admission', () => {
  it('refuses unqualified effort instead of changing it to a supported neighbor', () => {
    for (const [model, effort] of [['claude-opus-4-6', 'xhigh'], ['claude-opus-5-5', 'ultra'], ['custom-model', 'high']]) {
      expect(() => assertCliReasoningEffort({ runtime: 'claude', claudeRouting: FIRST_PARTY_ROUTE, model, version: '2.1.296', effort,
        selection: { mode: 'value', value: effort } })).toThrow(/saved choice was kept/)
    }
    expect(() => assertCliReasoningEffort({ runtime: 'claude', claudeRouting: FIRST_PARTY_ROUTE, model: 'claude-opus-5-5', version: '2.1.296', effort: 'max',
      selection: { mode: 'value', value: 'max' } })).not.toThrow()
  })

  it('does not introduce a new version gate for unchanged legacy low-through-xhigh runs', () => {
    expect(() => assertCliReasoningEffort({ runtime: 'claude', model: 'custom-model', version: '2.1.200', effort: 'xhigh' })).not.toThrow()
    expect(() => assertCliReasoningEffort({ runtime: 'claude', model: 'custom-model', version: '2.1.200', effort: 'xhigh',
      selection: { mode: 'value', value: 'xhigh' } })).toThrow(/not verified/)
  })

  it('qualifies Claude effort by model and version, including the missing xhigh step', () => {
    const opus46 = resolveCliReasoningContract({ runtime: 'claude', claudeRouting: FIRST_PARTY_ROUTE, model: 'claude-opus-4-6', version: '2.1.296 (Claude Code)' })
    expect(opus46.descriptor?.controls).toEqual([
      { id: 'effort', kind: 'effort', values: ['low', 'medium', 'high', 'max'], defaultValue: 'high' }
    ])
    expect(() => assertCliReasoningEffort({ runtime: 'claude', claudeRouting: FIRST_PARTY_ROUTE, model: 'claude-opus-4-6', version: '2.1.296', effort: 'xhigh',
      selection: { mode: 'value', value: 'xhigh' } })).toThrow(/not verified/)
    expect(resolveCliReasoningContract({ runtime: 'claude', claudeRouting: FIRST_PARTY_ROUTE, model: 'claude-haiku-5-5', version: '2.1.283' }).status).toBe('unverified')
    expect(resolveCliReasoningContract({ runtime: 'claude', claudeRouting: FIRST_PARTY_ROUTE, model: 'claude-haiku-5-5', version: '2.1.296' }).descriptor?.controls[0]).toMatchObject({ defaultValue: 'medium' })
  })

  it('never treats an unresolved/custom-provider alias as an exact model', () => {
    expect(resolveCliReasoningContract({ runtime: 'claude', model: 'sonnet', version: '2.1.296' }).status).toBe('unverified')
    expect(resolveCliReasoningContract({ runtime: 'claude', claudeRouting: FIRST_PARTY_ROUTE, model: 'sonnet', version: '2.1.296', firstPartyClaudeAliases: true }).effectiveModelId).toBe('claude-sonnet-5-5')
    expect(resolveCliReasoningContract({ runtime: 'claude', claudeRouting: FIRST_PARTY_ROUTE, model: 'best', version: '2.1.296', firstPartyClaudeAliases: true }).status).toBe('unverified')
    expect(hasDefaultFirstPartyClaudeAliases({})).toBe(true)
    expect(hasDefaultFirstPartyClaudeAliases({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-deployment' })).toBe(false)
    expect(hasDefaultFirstPartyClaudeAliases({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(false)
  })

  it('refuses the known thinking-off effort downgrade without changing legacy mode/budget', () => {
    expect(() => assertCliReasoningEffort({ runtime: 'claude', claudeRouting: FIRST_PARTY_ROUTE, model: 'claude-opus-5', version: '2.1.296', effort: 'max',
      selection: { mode: 'value', value: 'max' }, thinkingEnabled: false })).toThrow(/Thinking off/)
    expect(() => assertCliReasoningEffort({ runtime: 'claude', claudeRouting: FIRST_PARTY_ROUTE, model: 'claude-opus-5', version: '2.1.296', effort: 'max',
      selection: { mode: 'value', value: 'max' }, thinkingEnabled: true })).not.toThrow()
  })

  it('keeps inherit, provider default and invalid saved intent distinct', () => {
    expect(resolveCliReasoningEffort('xhigh')).toBe('xhigh')
    expect(resolveCliReasoningEffort('unqualified')).toBe('unqualified')
    expect(resolveCliReasoningEffort('xhigh', { mode: 'provider-default' })).toBeUndefined()
    expect(readCliReasoningSelection(undefined)).toBeUndefined()
    expect(() => readCliReasoningSelection({ mode: 'value', value: 'ultra' })).toThrow(/not verified/)
    expect(() => readCliReasoningSelection({ mode: 'value', value: 0 })).toThrow(/not verified/)
  })

  it('refuses an existing managed cap without deleting it or inventing an account cap', () => {
    const settings = { maxEffortLevel: 'high', modelSettings: { 'claude-opus-5-5': { maxEffortLevel: 'max' } } }
    expect(() => assertClaudeReasoningCap({ settings, model: 'claude-sonnet-5-5', selection: { mode: 'value', value: 'max' } })).toThrow(/cap effort at high/)
    expect(() => assertClaudeReasoningCap({ settings, model: 'claude-opus-5-5', selection: { mode: 'value', value: 'max' } })).not.toThrow()
    expect(settings.maxEffortLevel).toBe('high')
    expect(() => assertClaudeReasoningCap({ settings: {}, model: 'claude-opus-5-5', selection: { mode: 'value', value: 'max' } })).not.toThrow()
  })

  it('checks the canonical alias cap and preserves all manual effort entries', () => {
    const settings = { effortLevel: 'low', modelSettings: {
      'claude-sonnet-5-5': { effortLevel: 'low', maxEffortLevel: 'high' },
      'claude-opus-5-5': { effortLevel: 'xhigh' }
    } }
    const before = structuredClone(settings)
    const args = { model: 'sonnet', version: '2.1.296', firstPartyClaudeAliases: true, claudeRouting: FIRST_PARTY_ROUTE, settings,
      selection: { mode: 'value', value: 'max' } as const }
    expect(() => assertClaudeReasoningConfiguration(args)).toThrow(/cap effort at high/)
    expect(() => assertClaudeReasoningConfiguration({ ...args, firstPartyClaudeAliases: false })).toThrow(/model identity is not verified/)
    expect(() => assertClaudeReasoningConfiguration({ ...args, selection: { mode: 'value', value: 'high' } })).not.toThrow()
    expect(settings).toEqual(before)
  })

  it('refuses conflicting managed environment effort without erasing the manual source', () => {
    const settings = { effortLevel: 'low', env: { CLAUDE_CODE_EFFORT_LEVEL: 'low', OTHER: 'kept' } }
    expect(() => assertClaudeReasoningConfiguration({ model: 'claude-opus-5-5', version: '2.1.296', claudeRouting: FIRST_PARTY_ROUTE, settings,
      selection: { mode: 'value', value: 'max' } })).toThrow(/would override this effort/)
    expect(() => assertClaudeReasoningConfiguration({ model: 'claude-opus-5-5', version: '2.1.296', claudeRouting: FIRST_PARTY_ROUTE, settings,
      selection: { mode: 'provider-default' } })).not.toThrow()
    expect(settings.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('low')
  })

  it('does not import first-party support through managed or pending custom routing, even for exact IDs', () => {
    for (const settings of [
      { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet' } },
      { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' } },
      { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }
    ]) {
      const before = structuredClone(settings)
      const claudeRouting = resolveClaudeReasoningRouting({ sourceEnv: {}, managedSettings: settings })
      expect(claudeRouting.status).toBe('unverified')
      expect(resolveCliReasoningContract({ runtime: 'claude', model: 'claude-opus-5-5', version: '2.1.296', claudeRouting }).status).toBe('unverified')
      expect(() => assertClaudeReasoningConfiguration({ model: 'sonnet', version: '2.1.296', claudeRouting: FIRST_PARTY_ROUTE,
        settings, selection: { mode: 'value', value: 'high' } })).toThrow(/identity is not verified/)
      expect(settings).toEqual(before)
    }
    expect(resolveClaudeReasoningRouting({ sourceEnv: {}, managedSettings: null,
      configOverrides: [{ key: 'env.ANTHROPIC_BASE_URL', value: '"https://gateway.example.test"' }] }).status).toBe('unverified')
    expect(resolveClaudeReasoningRouting({ sourceEnv: {}, managedSettings: undefined }).status).toBe('unverified')
    expect(resolveClaudeReasoningRouting({ sourceEnv: {}, managedSettings: null }).status).toBe('verified')
    expect(resolveClaudeReasoningRouting({ sourceEnv: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' },
      managedSettings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }).status).toBe('unverified')
    const unrelatedEnv = Object.defineProperty({}, 'ANTHROPIC_API_KEY', { enumerable: true,
      get() { throw new Error('Routing must not inspect credential values') } })
    expect(resolveClaudeReasoningRouting({ sourceEnv: unrelatedEnv, managedSettings: { env: unrelatedEnv } }).status).toBe('verified')
  })

  it('offers no Off choice for verified always-thinking models and retains unknown route semantics', () => {
    for (const model of ['claude-fable-5', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(resolveCliReasoningContract({ runtime: 'claude', model, version: '2.1.296', claudeRouting: FIRST_PARTY_ROUTE }).thinkingPolicy).toBe('always-on')
      expect(resolveCliReasoningContract({ runtime: 'claude', model, version: '2.1.296' }).thinkingPolicy).toBe('unverified')
    }
    expect(resolveCliReasoningContract({ runtime: 'claude', model: 'claude-opus-4-6', version: '2.1.296', claudeRouting: FIRST_PARTY_ROUTE }).thinkingPolicy).toBe('switchable')
  })
})
